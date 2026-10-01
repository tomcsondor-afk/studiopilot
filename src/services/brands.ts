import { z } from "zod";
import { DB, all, one, run, tx } from "../db.js";
import { id, now, json, sha256, HttpError } from "../util.js";
import { requireBrand, requireWorkspace } from "../access.js";
import { enqueue, registerHandler, requestCancel } from "../jobs.js";
import { crawlSite, CrawlOptions } from "../crawler.js";
import { parsePublicUrl } from "../ssrf.js";
import { getAI, aiAvailable, ClaimKinds } from "../ai/adapter.js";
import { audit } from "./audit.js";

const DEFAULT_PILLARS = ["Useful advice", "Product and service education", "Behind the scenes", "Verified proof", "Conversation starters", "Promotional"];
const AUTO_CONFIRM_KINDS = new Set(["fact", "service", "product", "location"]);
const SENSITIVE_KINDS = new Set(["price", "offer", "testimonial", "qualification", "statistic", "award"]);

export const emptyProfile = () => ({
  services: [] as string[], products: [] as string[], audiences: [] as string[], valueProps: [] as string[], ctas: [] as string[],
  links: [] as { label: string; url: string }[],
  tone: { summary: "", formality: 3, warmth: 3, humour: 2, emoji: "light" },
  pillars: DEFAULT_PILLARS, prohibitedTopics: [] as string[],
  vocabulary: { prefer: [] as string[], avoid: [] as string[] },
  writingExamples: [] as string[], hashtagPolicy: "", ctaPolicy: "", objectives: [] as string[],
  palette: {} as Record<string, string>, fonts: [] as string[], logoCandidates: [] as string[], selectedLogo: "", images: [] as string[], socialLinks: [] as string[],
  suggestedFields: [] as string[]
});

const normText = (s: string) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
const normUrl = (u: string) => u.replace(/#.*$/, "").replace(/\/$/, "");

/* ---------------- create ---------------- */
export function createBrandFromWebsite(db: DB, userId: string, workspaceId: string, rawUrl: string) {
  requireWorkspace(db, userId, workspaceId, "edit");
  const url = parsePublicUrl(rawUrl).href;
  const t = now(), brandId = id();
  const host = new URL(url).hostname.replace(/^www\./, "");
  tx(db, () => {
    run(db, `INSERT INTO brands (id, workspace_id, name, website_url, profile_json, onboarding_status, created_at, updated_at) VALUES (?,?,?,?,?, 'researching', ?, ?)`,
      brandId, workspaceId, host, url, JSON.stringify(emptyProfile()), t, t);
    audit(db, workspaceId, userId, "brand.created", "brand", brandId, { url });
  });
  const job = enqueue(db, { workspaceId, brandId, type: "research", key: `research:${brandId}:1`, payload: { url }, createdBy: userId, maxAttempts: 2 });
  return { brandId, jobId: job.id };
}

export const ManualBrandInput = z.object({
  name: z.string().trim().min(1).max(120),
  websiteUrl: z.string().trim().max(500).optional().default(""),
  description: z.string().trim().max(2000).default(""),
  industry: z.string().trim().max(120).default(""),
  location: z.string().trim().max(200).default(""),
  facts: z.array(z.string().trim().min(1).max(400)).max(40).default([])
});
export function createManualBrand(db: DB, userId: string, workspaceId: string, input: z.infer<typeof ManualBrandInput>) {
  requireWorkspace(db, userId, workspaceId, "edit");
  const website = input.websiteUrl ? parsePublicUrl(input.websiteUrl).href : null;
  const t = now(), brandId = id(), sourceId = id();
  tx(db, () => {
    run(db, `INSERT INTO brands (id, workspace_id, name, website_url, description, industry, location, profile_json, onboarding_status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?, 'review', ?, ?)`, brandId, workspaceId, input.name, website, input.description, input.industry, input.location, JSON.stringify(emptyProfile()), t, t);
    const text = [input.description, ...input.facts].join("\n");
    run(db, `INSERT INTO sources (id, workspace_id, brand_id, url, title, kind, text, content_hash, captured_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      sourceId, workspaceId, brandId, `manual:${brandId}`, "Details entered by a team member", "manual", text, sha256(text), t);
    for (const f of input.facts) run(db, `INSERT INTO claims (id, workspace_id, brand_id, kind, text, origin, source_id, excerpt, status, decided_by, decided_at, created_at)
      VALUES (?,?,?,?,?, 'user', ?, ?, 'confirmed', ?, ?, ?)`, id(), workspaceId, brandId, "fact", f, sourceId, f, userId, t, t);
    audit(db, workspaceId, userId, "brand.created_manual", "brand", brandId, {});
  });
  return { brandId };
}

export function retryResearch(db: DB, userId: string, brandId: string) {
  const { brand } = requireBrand(db, userId, brandId, "edit");
  if (!brand.website_url) throw new HttpError(400, "This brand has no website to research.");
  const n = (one<{ n: number }>(db, "SELECT COUNT(*) n FROM jobs WHERE brand_id=? AND type='research'", brandId)?.n || 0) + 1;
  run(db, "UPDATE brands SET onboarding_status='researching', updated_at=? WHERE id=?", now(), brandId);
  return enqueue(db, { workspaceId: brand.workspace_id, brandId, type: "research", key: `research:${brandId}:${n}`, payload: { url: brand.website_url }, createdBy: userId, maxAttempts: 2 });
}

/* ---------------- research job ---------------- */
let crawlOverrides: CrawlOptions = {};
export function setCrawlOptionsForTests(o: CrawlOptions) { crawlOverrides = o; }

registerHandler("research", async ctx => {
  const { db, job } = ctx;
  const brand = one<any>(db, "SELECT * FROM brands WHERE id=?", job.brand_id);
  if (!brand) return;
  let signals = job.progress.signals;

  // Stage 1: crawl (skipped on retry if a previous attempt already stored the pages)
  if (!job.progress.crawled) {
    ctx.progress({ stage: "crawling", pages: 0, skipped: [] });
    const result = await crawlSite(job.payload.url, {
      ...crawlOverrides,
      shouldStop: () => ctx.cancelled(),
      onPage: (p, n) => { ctx.heartbeat(); ctx.progress({ stage: "crawling", pages: n, lastUrl: p.url }); }
    });
    if (ctx.cancelled()) return;
    if (!result.pages.length) throw Object.assign(new Error("No readable pages were found. Add the business details manually instead."), { permanent: true });
    const t = now();
    tx(db, () => {
      for (const p of result.pages) {
        const text = [`TITLE: ${p.title}`, `DESCRIPTION: ${p.description}`, `HEADINGS: ${p.headings.join(" | ")}`, p.text].join("\n");
        run(db, `INSERT INTO sources (id, workspace_id, brand_id, url, title, kind, text, content_hash, captured_at) VALUES (?,?,?,?,?, 'page', ?,?,?)
                 ON CONFLICT(brand_id, url) DO UPDATE SET title=excluded.title, text=excluded.text, content_hash=excluded.content_hash, captured_at=excluded.captured_at`,
          id(), brand.workspace_id, brand.id, p.url, p.title, text, sha256(text), t);
      }
    });
    signals = result.signals;
    ctx.progress({ stage: "crawled", crawled: true, pages: result.pages.length, skipped: result.skipped.slice(0, 20), signals });
  }

  // Stage 2: AI analysis
  if (!aiAvailable()) throw Object.assign(new Error("Pages were read, but AI analysis needs ANTHROPIC_API_KEY on the server. Add it and retry, or fill in the brand details yourself."), { permanent: true });
  ctx.progress({ stage: "analysing" });
  ctx.heartbeat();
  const sources = all<any>(db, "SELECT id, url, title, text FROM sources WHERE brand_id=? AND kind='page'", brand.id);
  const pages = sources.map(s => {
    const lines = s.text.split("\n");
    return { url: s.url, title: s.title, description: (lines[1] || "").replace(/^DESCRIPTION: /, ""), headings: (lines[2] || "").replace(/^HEADINGS: /, "").split(" | "), text: lines.slice(3).join("\n") };
  });
  const ex = await getAI().extractBrand({ websiteUrl: job.payload.url, pages, structuredData: signals?.structuredData || [], colours: (signals?.colours || []).map((c: any) => c.hex), fonts: signals?.fonts || [] });
  if (ctx.cancelled()) return;

  // Stage 3: store, verifying every quoted excerpt against the page it claims to come from
  const t = now();
  tx(db, () => {
    const profile = { ...emptyProfile(), ...json(brand.profile_json, {}) };
    Object.assign(profile, {
      services: ex.services, products: ex.products, audiences: ex.audiences, valueProps: ex.valueProps, ctas: ex.ctas,
      links: ex.links.filter(l => { try { return new URL(l.url).hostname.replace(/^www\./, "") === new URL(job.payload.url).hostname.replace(/^www\./, ""); } catch { return false; } }),
      tone: ex.tone,
      pillars: ex.suggestions.contentPillars.length ? ex.suggestions.contentPillars : DEFAULT_PILLARS,
      prohibitedTopics: ex.suggestions.prohibitedTopics,
      palette: Object.fromEntries(Object.entries(ex.suggestions.palette || {}).filter(([, v]) => /^#[0-9a-f]{6}$/i.test(String(v)))),
      fonts: signals?.fonts || [], logoCandidates: signals?.logoCandidates || [], selectedLogo: signals?.logoCandidates?.[0] || "",
      images: signals?.images || [], socialLinks: signals?.socialLinks || [],
      suggestedFields: ["description", "industry", "services", "products", "audiences", "valueProps", "tone", "pillars", "prohibitedTopics", "palette"]
    });
    run(db, `UPDATE brands SET name=?, description=?, industry=?, location=?, profile_json=?, onboarding_status='review', version=version+1, updated_at=? WHERE id=?`,
      ex.name || brand.name, ex.description, ex.industry, ex.location, JSON.stringify(profile), t, brand.id);
    // Replace undecided machine claims; keep anything a person confirmed, rejected or wrote.
    run(db, "DELETE FROM claims WHERE brand_id=? AND origin IN ('extracted','suggested') AND decided_by IS NULL", brand.id);
    for (const c of ex.claims) {
      if (!c.text) continue;
      const src = sources.find(s => normUrl(s.url) === normUrl(c.sourceUrl));
      const verified = Boolean(src && c.excerpt && normText(src.text).includes(normText(c.excerpt)));
      const status = verified && AUTO_CONFIRM_KINDS.has(c.kind) ? "confirmed" : "needs_confirmation";
      run(db, `INSERT INTO claims (id, workspace_id, brand_id, kind, text, origin, source_id, excerpt, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id(), brand.workspace_id, brand.id, c.kind, c.text, verified ? "extracted" : "suggested", src?.id ?? null, c.excerpt, status, t);
    }
    audit(db, brand.workspace_id, job.created_by, "brand.researched", "brand", brand.id, { pages: sources.length, claims: ex.claims.length });
  });
  ctx.progress({ stage: "done" });
}, (db, job) => {
  run(db, "UPDATE brands SET onboarding_status = CASE WHEN onboarding_status='researching' THEN 'failed' ELSE onboarding_status END, updated_at=? WHERE id=?", now(), job.brand_id);
});

/* ---------------- competitor observation job (no AI, no inference) ---------------- */
registerHandler("competitor_fetch", async ctx => {
  const { db, job } = ctx;
  const comp = one<any>(db, "SELECT * FROM competitors WHERE id=?", job.payload.competitorId);
  if (!comp) return;
  const result = await crawlSite(comp.url, { ...crawlOverrides, maxPages: 1, maxDepth: 0 });
  const p = result.pages[0];
  if (!p) throw Object.assign(new Error("The competitor's page couldn't be read."), { permanent: true });
  const text = [`TITLE: ${p.title}`, `DESCRIPTION: ${p.description}`, `HEADINGS: ${p.headings.join(" | ")}`, p.text].join("\n");
  run(db, `INSERT INTO sources (id, workspace_id, brand_id, url, title, kind, text, content_hash, captured_at) VALUES (?,?,?,?,?, 'competitor', ?,?,?)
           ON CONFLICT(brand_id, url) DO UPDATE SET title=excluded.title, text=excluded.text, content_hash=excluded.content_hash, captured_at=excluded.captured_at`,
    id(), comp.workspace_id, comp.brand_id, p.url, p.title, text, sha256(text), now());
  if (!comp.name && p.title) run(db, "UPDATE competitors SET name=? WHERE id=?", p.title.slice(0, 120), comp.id);
});

/* ---------------- read ---------------- */
export function getBrandBundle(db: DB, userId: string, brandId: string) {
  const { brand, role } = requireBrand(db, userId, brandId, "read");
  const claims = all<any>(db, `SELECT c.*, s.url AS source_url, s.captured_at AS source_captured_at, u.name AS decided_by_name
    FROM claims c LEFT JOIN sources s ON s.id = c.source_id LEFT JOIN users u ON u.id = c.decided_by WHERE c.brand_id=? ORDER BY c.kind, c.created_at`, brandId);
  const sources = all<any>(db, "SELECT id, url, title, kind, captured_at, length(text) AS chars FROM sources WHERE brand_id=? ORDER BY kind, captured_at", brandId);
  const competitors = all<any>(db, `SELECT c.*, s.title AS observed_title, s.text AS observed_text, s.captured_at AS observed_at
    FROM competitors c LEFT JOIN sources s ON s.brand_id=c.brand_id AND s.kind='competitor' AND (s.url = c.url OR rtrim(s.url,'/') = rtrim(c.url,'/')) WHERE c.brand_id=? ORDER BY c.created_at`, brandId)
    .map(c => ({ ...c, observed_text: c.observed_text ? c.observed_text.slice(0, 1200) : null }));
  const jobs = all<any>(db, "SELECT id, type, status, progress_json, last_error, attempts, max_attempts, created_at, updated_at FROM jobs WHERE brand_id=? AND type IN ('research','competitor_fetch') ORDER BY created_at DESC LIMIT 5", brandId)
    .map(j => ({ ...j, progress: json(j.progress_json, {}), progress_json: undefined }));
  return { brand: { ...brand, profile: { ...emptyProfile(), ...json(brand.profile_json, {}) }, profile_json: undefined }, role, claims, sources, competitors, jobs };
}

export function listBrands(db: DB, userId: string, workspaceId: string) {
  requireWorkspace(db, userId, workspaceId, "read");
  return all<any>(db, `SELECT b.id, b.name, b.website_url, b.onboarding_status, b.updated_at,
    (SELECT COUNT(*) FROM concepts c WHERE c.brand_id=b.id AND c.status='suggested') AS pending,
    (SELECT COUNT(*) FROM concepts c WHERE c.brand_id=b.id AND c.status='approved') AS approved
    FROM brands b WHERE b.workspace_id=? ORDER BY b.created_at`, workspaceId);
}

/* ---------------- update ---------------- */
const str = (n: number) => z.string().trim().max(n);
const strList = (n = 40, len = 300) => z.array(z.string().trim().min(1).max(len)).max(n);
export const BrandUpdate = z.object({
  expectedVersion: z.number().int(),
  name: str(120).min(1).optional(), description: str(2000).optional(), industry: str(120).optional(), location: str(200).optional(),
  language: str(20).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  timezone: z.string().refine(tz => { try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; } }, "Unknown IANA time zone").optional(),
  profile: z.object({
    services: strList(), products: strList(), audiences: strList(15), valueProps: strList(15), ctas: strList(15, 160),
    links: z.array(z.object({ label: str(80), url: str(500) })).max(30),
    tone: z.object({ summary: str(400), formality: z.number().int().min(1).max(5), warmth: z.number().int().min(1).max(5), humour: z.number().int().min(1).max(5), emoji: z.enum(["none", "light", "frequent"]) }),
    pillars: strList(10, 120), prohibitedTopics: strList(20, 200),
    vocabulary: z.object({ prefer: strList(40, 80), avoid: strList(40, 80) }),
    writingExamples: strList(10, 3000), hashtagPolicy: str(400), ctaPolicy: str(400), objectives: strList(10, 200),
    palette: z.record(z.string().regex(/^#[0-9a-fA-F]{6}$/)), selectedLogo: str(1000)
  }).partial().optional()
});

export function updateBrand(db: DB, userId: string, brandId: string, input: z.infer<typeof BrandUpdate>) {
  const { brand } = requireBrand(db, userId, brandId, "edit");
  return tx(db, () => {
    const cur = one<any>(db, "SELECT version, profile_json FROM brands WHERE id=?", brandId);
    if (cur.version !== input.expectedVersion) throw new HttpError(409, "Someone else changed this brand while you were editing. Reload to see their changes.", "conflict");
    const profile = { ...emptyProfile(), ...json(cur.profile_json, {}) };
    if (input.profile) {
      Object.assign(profile, input.profile);
      profile.suggestedFields = profile.suggestedFields.filter((f: string) => !(f in input.profile!));
    }
    const fields: Record<string, any> = {};
    for (const k of ["name", "description", "industry", "location", "language", "currency", "timezone"] as const) if (input[k] !== undefined) fields[k] = input[k];
    for (const k of ["description", "industry"]) if (k in fields) profile.suggestedFields = profile.suggestedFields.filter((f: string) => f !== k);
    const sets = Object.keys(fields).map(k => `${k}=?`);
    run(db, `UPDATE brands SET ${[...sets, "profile_json=?", "version=version+1", "updated_at=?"].join(", ")} WHERE id=?`, ...Object.values(fields), JSON.stringify(profile), now(), brandId);
    audit(db, brand.workspace_id, userId, "brand.updated", "brand", brandId, { fields: [...Object.keys(fields), ...Object.keys(input.profile || {})] });
    return getBrandBundle(db, userId, brandId);
  });
}

export function confirmBrand(db: DB, userId: string, brandId: string) {
  const { brand } = requireBrand(db, userId, brandId, "edit");
  if (!["review", "ready", "failed"].includes(brand.onboarding_status)) throw new HttpError(400, "Wait for research to finish, or cancel it and enter the details yourself.");
  if (!brand.name?.trim()) throw new HttpError(400, "Add the business name first.");
  const profile = { ...emptyProfile(), ...json(brand.profile_json, {}) };
  profile.suggestedFields = [];
  run(db, "UPDATE brands SET onboarding_status='ready', confirmed_at=?, profile_json=?, version=version+1, updated_at=? WHERE id=?", now(), JSON.stringify(profile), now(), brandId);
  audit(db, brand.workspace_id, userId, "brand.confirmed", "brand", brandId, {});
  return getBrandBundle(db, userId, brandId);
}

/* ---------------- claims ---------------- */
export function decideClaim(db: DB, userId: string, claimId: string, decision: "confirmed" | "rejected" | "needs_confirmation", text?: string) {
  const c = one<any>(db, "SELECT * FROM claims WHERE id=?", claimId);
  if (!c) throw new HttpError(404, "Claim not found.", "not_found");
  requireBrand(db, userId, c.brand_id, "edit");
  const t = now();
  run(db, "UPDATE claims SET status=?, text=COALESCE(?, text), decided_by=?, decided_at=? WHERE id=?", decision, text?.trim() || null, userId, t, claimId);
  audit(db, c.workspace_id, userId, `claim.${decision}`, "claim", claimId, {});
  return one(db, "SELECT * FROM claims WHERE id=?", claimId);
}

export const ClaimInput = z.object({ kind: z.enum(ClaimKinds), text: z.string().trim().min(1).max(400), evidence: z.string().trim().max(600).default("") });
export function addClaim(db: DB, userId: string, brandId: string, input: z.infer<typeof ClaimInput>) {
  const { brand } = requireBrand(db, userId, brandId, "edit");
  const t = now(), cid = id();
  const status = SENSITIVE_KINDS.has(input.kind) && !input.evidence ? "needs_confirmation" : "confirmed";
  run(db, `INSERT INTO claims (id, workspace_id, brand_id, kind, text, origin, excerpt, status, decided_by, decided_at, created_at) VALUES (?,?,?,?,?, 'user', ?,?,?,?,?)`,
    cid, brand.workspace_id, brandId, input.kind, input.text, input.evidence, status, status === "confirmed" ? userId : null, status === "confirmed" ? t : null, t);
  audit(db, brand.workspace_id, userId, "claim.added", "claim", cid, {});
  return one(db, "SELECT * FROM claims WHERE id=?", cid);
}

/* ---------------- competitors ---------------- */
export function addCompetitor(db: DB, userId: string, brandId: string, input: { url: string; name?: string; notes?: string }) {
  const { brand } = requireBrand(db, userId, brandId, "edit");
  const url = parsePublicUrl(input.url).href;
  const cid = id();
  run(db, "INSERT INTO competitors (id, workspace_id, brand_id, url, name, notes, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(brand_id, url) DO NOTHING",
    cid, brand.workspace_id, brandId, url, (input.name || "").slice(0, 120), (input.notes || "").slice(0, 2000), now());
  const comp = one<any>(db, "SELECT * FROM competitors WHERE brand_id=? AND url=?", brandId, url);
  enqueue(db, { workspaceId: brand.workspace_id, brandId, type: "competitor_fetch", key: `competitor:${comp.id}:${Date.now()}`, payload: { competitorId: comp.id }, createdBy: userId, maxAttempts: 2 });
  return comp;
}
export function removeCompetitor(db: DB, userId: string, competitorId: string) {
  const c = one<any>(db, "SELECT * FROM competitors WHERE id=?", competitorId);
  if (!c) throw new HttpError(404, "Competitor not found.", "not_found");
  requireBrand(db, userId, c.brand_id, "edit");
  run(db, "DELETE FROM competitors WHERE id=?", competitorId);
  run(db, "DELETE FROM sources WHERE brand_id=? AND kind='competitor' AND rtrim(url,'/')=rtrim(?,'/')", c.brand_id, c.url);
}

export function cancelResearch(db: DB, userId: string, brandId: string) {
  requireBrand(db, userId, brandId, "edit");
  const ids = all<{ id: string }>(db, "SELECT id FROM jobs WHERE brand_id=? AND type='research' AND status IN ('queued','running')", brandId).map(r => r.id);
  requestCancel(db, ids);
  run(db, "UPDATE brands SET onboarding_status='failed', updated_at=? WHERE id=? AND onboarding_status='researching'", now(), brandId);
}
