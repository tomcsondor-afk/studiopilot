import { z } from "zod";
import { DB, all, one, run, tx } from "../db.js";
import { id, now, json, HttpError } from "../util.js";
import { requireBrand, requireConcept, requireWorkspace } from "../access.js";
import { enqueue, registerHandler, requestCancel } from "../jobs.js";
import { getAI, aiAvailable, ConceptDraft, BrandContext } from "../ai/adapter.js";
import { CHANNEL_LIST, Channel, checkVariant, checkDuplicateIdea, hookOf, QualityFlag } from "./quality.js";
import { emptyProfile } from "./brands.js";
import { config } from "../config.js";
import { audit } from "./audit.js";

const MATERIAL_FIELDS = ["title", "objective", "cta", "destination_url", "creative_brief", "alt_text"] as const;
const OTHER_FIELDS = ["pillar", "audience", "suggested_slot"] as const;
const UNDO_MS = 10 * 60_000;

/* ---------------- brand context & evidence ---------------- */
export function brandContext(db: DB, brand: any): BrandContext {
  const p = { ...emptyProfile(), ...json(brand.profile_json, {}) };
  const { logoCandidates, images, socialLinks, fonts, suggestedFields, selectedLogo, ...profile } = p;
  const claims = all<any>(db, "SELECT id, kind, text FROM claims WHERE brand_id=? AND status='confirmed' ORDER BY created_at", brand.id);
  return { name: brand.name, description: brand.description, industry: brand.industry, location: brand.location, language: brand.language, profile, confirmedClaims: claims, prohibited: p.prohibitedTopics };
}

function evidenceFor(db: DB, brand: any) {
  const claims = all<any>(db, "SELECT kind, text, excerpt FROM claims WHERE brand_id=? AND status='confirmed'", brand.id);
  const p = { ...emptyProfile(), ...json(brand.profile_json, {}) };
  const text = [brand.name, brand.description, brand.location, ...p.services, ...p.products, ...p.valueProps, ...claims.flatMap(c => [c.text, c.excerpt])].join("\n");
  const knownUrls = [brand.website_url, ...all<any>(db, "SELECT url FROM sources WHERE brand_id=? AND kind='page'", brand.id).map(s => s.url), ...p.links.map((l: any) => l.url)].filter(Boolean);
  return { text, knownUrls, hasOffer: claims.some(c => c.kind === "offer"), hasTestimonial: claims.some(c => c.kind === "testimonial") };
}

export function recomputeQuality(db: DB, conceptId: string) {
  const c = one<any>(db, "SELECT * FROM concepts WHERE id=?", conceptId);
  const brand = one<any>(db, "SELECT * FROM brands WHERE id=?", c.brand_id);
  const ev = evidenceFor(db, brand);
  const others = all<any>(db, "SELECT id, title FROM concepts WHERE brand_id=? AND id<>? AND status<>'archived'", c.brand_id, conceptId);
  const dup = checkDuplicateIdea(c.title, others.map(o => o.title));
  run(db, "UPDATE concepts SET quality_json=? WHERE id=?", JSON.stringify(dup ? [dup] : []), conceptId);
  for (const v of all<any>(db, "SELECT * FROM variants WHERE concept_id=?", conceptId)) {
    const otherHooks = all<any>(db, `SELECT v.caption FROM variants v JOIN concepts c ON c.id=v.concept_id WHERE c.brand_id=? AND v.channel=? AND v.concept_id<>? AND c.status<>'archived'`, c.brand_id, v.channel, conceptId).map(r => hookOf(r.caption));
    const flags = checkVariant({ channel: v.channel, caption: v.caption, hashtags: json(v.hashtags_json, []), destinationUrl: c.destination_url, brandName: brand.name,
      evidenceText: ev.text, hasConfirmedOffer: ev.hasOffer, hasConfirmedTestimonial: ev.hasTestimonial, knownUrls: ev.knownUrls, otherHooks });
    run(db, "UPDATE variants SET quality_json=? WHERE id=?", JSON.stringify(flags), v.id);
  }
}

export function recomputeBrandQuality(db: DB, brandId: string) {
  for (const c of all<any>(db, "SELECT id FROM concepts WHERE brand_id=? AND status IN ('suggested','approved')", brandId)) recomputeQuality(db, c.id);
}

/* ---------------- snapshots ---------------- */
function snapshot(db: DB, conceptId: string) {
  const c = one<any>(db, "SELECT * FROM concepts WHERE id=?", conceptId);
  const variants = Object.fromEntries(all<any>(db, "SELECT channel, caption, hashtags_json FROM variants WHERE concept_id=?", conceptId).map(v => [v.channel, { caption: v.caption, hashtags: json(v.hashtags_json, []) }]));
  const s: any = { variants };
  for (const f of [...MATERIAL_FIELDS, ...OTHER_FIELDS, "pillar"] as const) s[f] = c[f];
  s.source_claim_ids = json(c.source_claim_ids_json, []);
  return s;
}
function writeRevision(db: DB, conceptId: string, reason: string, authorId: string | null, instruction?: string) {
  const c = one<any>(db, "SELECT workspace_id, revision FROM concepts WHERE id=?", conceptId);
  run(db, "INSERT INTO revisions (id, workspace_id, concept_id, revision, snapshot_json, reason, instruction, author_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id(), c.workspace_id, conceptId, c.revision, JSON.stringify(snapshot(db, conceptId)), reason, instruction ?? null, authorId, now());
}

/* ---------------- insert concepts ---------------- */
export function insertConcept(db: DB, brand: any, d: ConceptDraft, meta: { runId?: string | null; batchIndex?: number | null; origin: "ai" | "person" | "demo"; createdBy: string | null; reason?: string }) {
  const cid = id(), t = now();
  const validClaimIds = new Set(all<any>(db, "SELECT id FROM claims WHERE brand_id=? AND status='confirmed'", brand.id).map(r => r.id));
  run(db, `INSERT INTO concepts (id, workspace_id, brand_id, run_id, batch_index, title, objective, pillar, audience, cta, destination_url, creative_brief, alt_text, suggested_slot,
            source_claim_ids_json, status, revision, origin, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'suggested', 1, ?,?,?,?)`,
    cid, brand.workspace_id, brand.id, meta.runId ?? null, meta.batchIndex ?? null, d.title, d.objective, d.pillar, d.audience, d.cta, d.destinationUrl, d.creativeBrief, d.altText, d.suggestedSlot,
    JSON.stringify(d.sourceClaimIds.filter(x => validClaimIds.has(x))), meta.origin, meta.createdBy, t, t);
  for (const ch of CHANNEL_LIST) {
    const v = d.variants[ch];
    const tags = [...new Set(v.hashtags.map(h => h.trim().replace(/^#?/, "#")).filter(h => h.length > 1))];
    run(db, "INSERT INTO variants (id, workspace_id, concept_id, channel, caption, hashtags_json, updated_at) VALUES (?,?,?,?,?,?,?)", id(), brand.workspace_id, cid, ch, v.caption, JSON.stringify(tags), t);
  }
  recomputeQuality(db, cid);
  writeRevision(db, cid, meta.reason || (meta.origin === "demo" ? "demo" : "generated"), meta.createdBy);
  return cid;
}

/* ---------------- generation runs ---------------- */
export function startGeneration(db: DB, userId: string, brandId: string, target = config.generation.initialConcepts) {
  const { brand } = requireBrand(db, userId, brandId, "edit");
  if (brand.onboarding_status !== "ready") throw new HttpError(400, "Confirm the brand profile before generating posts.", "brand_not_ready");
  if (!aiAvailable()) throw new HttpError(503, "AI generation needs ANTHROPIC_API_KEY on the server.", "ai_not_configured");
  const running = one<any>(db, "SELECT id FROM generation_runs WHERE workspace_id=? AND status='running'", brand.workspace_id);
  if (running) throw new HttpError(409, "A generation is already running in this workspace. Wait for it to finish or cancel it.", "busy");
  const runId = id(), t = now();
  const count = Math.max(1, Math.min(100, target));
  run(db, "INSERT INTO generation_runs (id, workspace_id, brand_id, target_count, batch_size, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?, 'running', ?,?,?)",
    runId, brand.workspace_id, brandId, count, config.generation.batchSize, userId, t, t);
  enqueue(db, { workspaceId: brand.workspace_id, brandId, type: "generate_batch", key: `${runId}:batch:0`, payload: { runId, batchIndex: 0 }, createdBy: userId, maxAttempts: 3 });
  audit(db, brand.workspace_id, userId, "generation.started", "brand", brandId, { runId, target: count });
  return getRun(db, userId, runId);
}

export function getRun(db: DB, userId: string, runId: string) {
  const r = one<any>(db, "SELECT * FROM generation_runs WHERE id=?", runId);
  if (!r) throw new HttpError(404, "Generation not found.", "not_found");
  requireWorkspace(db, userId, r.workspace_id, "read");
  const produced = one<any>(db, "SELECT COUNT(*) n FROM concepts WHERE run_id=?", runId).n;
  const jobs = all<any>(db, "SELECT status, last_error, payload_json FROM jobs WHERE type='generate_batch' AND idempotency_key LIKE ? ORDER BY created_at", `${runId}:%`);
  const lastError = [...jobs].reverse().find(j => j.last_error)?.last_error || null;
  return { ...r, produced, lastError, batchesQueued: jobs.filter(j => ["queued", "running"].includes(j.status)).length };
}

export function latestRun(db: DB, userId: string, brandId: string) {
  requireBrand(db, userId, brandId, "read");
  const r = one<any>(db, "SELECT id FROM generation_runs WHERE brand_id=? ORDER BY created_at DESC LIMIT 1", brandId);
  return r ? getRun(db, userId, r.id) : null;
}

export function cancelRun(db: DB, userId: string, runId: string) {
  const r = one<any>(db, "SELECT * FROM generation_runs WHERE id=?", runId);
  if (!r) throw new HttpError(404, "Generation not found.", "not_found");
  requireWorkspace(db, userId, r.workspace_id, "edit");
  const ids = all<any>(db, "SELECT id FROM jobs WHERE idempotency_key LIKE ? AND status IN ('queued','running')", `${runId}:%`).map(j => j.id);
  requestCancel(db, ids);
  run(db, "UPDATE generation_runs SET status='cancelled', updated_at=? WHERE id=? AND status='running'", now(), runId);
  return getRun(db, userId, runId);
}

export function resumeRun(db: DB, userId: string, runId: string) {
  const r = one<any>(db, "SELECT * FROM generation_runs WHERE id=?", runId);
  if (!r) throw new HttpError(404, "Generation not found.", "not_found");
  requireWorkspace(db, userId, r.workspace_id, "edit");
  if (r.status === "running") throw new HttpError(409, "This generation is still running.");
  if (!aiAvailable()) throw new HttpError(503, "AI generation needs ANTHROPIC_API_KEY on the server.", "ai_not_configured");
  const batches = Math.ceil(r.target_count / r.batch_size);
  const done = new Set(all<any>(db, "SELECT DISTINCT batch_index FROM concepts WHERE run_id=?", runId).map(x => x.batch_index));
  let next = -1; for (let i = 0; i < batches; i++) if (!done.has(i)) { next = i; break; }
  if (next < 0) { run(db, "UPDATE generation_runs SET status='completed', updated_at=? WHERE id=?", now(), runId); return getRun(db, userId, runId); }
  run(db, "UPDATE generation_runs SET status='running', updated_at=? WHERE id=?", now(), runId);
  enqueue(db, { workspaceId: r.workspace_id, brandId: r.brand_id, type: "generate_batch", key: `${runId}:batch:${next}:resume:${Date.now()}`, payload: { runId, batchIndex: next }, createdBy: userId });
  return getRun(db, userId, runId);
}

registerHandler("generate_batch", async ctx => {
  const { db, job } = ctx;
  const { runId, batchIndex } = job.payload;
  const r = one<any>(db, "SELECT * FROM generation_runs WHERE id=?", runId);
  if (!r || r.status === "cancelled") return;
  const brand = one<any>(db, "SELECT * FROM brands WHERE id=?", r.brand_id);
  const batches = Math.ceil(r.target_count / r.batch_size);

  // Idempotent: if this batch already landed (e.g. a retry after a crash post-commit), don't generate it again.
  const existing = one<any>(db, "SELECT COUNT(*) n FROM concepts WHERE run_id=? AND batch_index=?", runId, batchIndex).n;
  if (!existing) {
    const count = Math.min(r.batch_size, r.target_count - batchIndex * r.batch_size);
    const prior = all<any>(db, "SELECT id, title FROM concepts WHERE brand_id=? AND status<>'archived' ORDER BY created_at", brand.id);
    const hooks = all<any>(db, "SELECT v.caption FROM variants v JOIN concepts c ON c.id=v.concept_id WHERE c.brand_id=? AND v.channel='linkedin'", brand.id).map(v => hookOf(v.caption));
    const ev = evidenceFor(db, brand);
    const ctxBrand = brandContext(db, brand);
    ctx.heartbeat();
    const drafts = await getAI().generateConcepts({ brand: ctxBrand, count, pillars: ctxBrand.profile.pillars, existingTitles: prior.map(p => p.title), existingHooks: hooks, batchIndex, knownUrls: ev.knownUrls });
    if (ctx.cancelled() || one<any>(db, "SELECT status FROM generation_runs WHERE id=?", runId).status === "cancelled") return;
    tx(db, () => {
      if (one<any>(db, "SELECT COUNT(*) n FROM concepts WHERE run_id=? AND batch_index=?", runId, batchIndex).n) return;
      for (const d of drafts) insertConcept(db, brand, d, { runId, batchIndex, origin: "ai", createdBy: r.created_by });
    });
  }
  ctx.progress({ produced: one<any>(db, "SELECT COUNT(*) n FROM concepts WHERE run_id=?", runId).n });

  const doneBatches = new Set(all<any>(db, "SELECT DISTINCT batch_index FROM concepts WHERE run_id=?", runId).map(x => x.batch_index));
  let next = -1; for (let i = batchIndex + 1; i < batches; i++) if (!doneBatches.has(i)) { next = i; break; }
  if (next >= 0) enqueue(db, { workspaceId: r.workspace_id, brandId: r.brand_id, type: "generate_batch", key: `${runId}:batch:${next}`, payload: { runId, batchIndex: next }, createdBy: r.created_by });
  else run(db, "UPDATE generation_runs SET status=?, updated_at=? WHERE id=? AND status='running'", doneBatches.size >= batches ? "completed" : "partial", now(), runId);
}, (db, job) => {
  const { runId } = job.payload;
  const produced = one<any>(db, "SELECT COUNT(*) n FROM concepts WHERE run_id=?", runId).n;
  run(db, "UPDATE generation_runs SET status=?, updated_at=? WHERE id=? AND status='running'", produced ? "partial" : "failed", now(), runId);
});

/* ---------------- read ---------------- */
function hydrateConcept(db: DB, c: any) {
  const variants = all<any>(db, "SELECT channel, caption, hashtags_json, quality_json, updated_at FROM variants WHERE concept_id=? ORDER BY channel", c.id)
    .map(v => ({ channel: v.channel, caption: v.caption, hashtags: json(v.hashtags_json, []), flags: json<QualityFlag[]>(v.quality_json, []), updated_at: v.updated_at }));
  const approval = one<any>(db, `SELECT a.*, u.name AS approved_by_name FROM approvals a JOIN users u ON u.id=a.approved_by WHERE a.concept_id=? AND a.invalidated_at IS NULL ORDER BY a.approved_at DESC LIMIT 1`, c.id);
  return {
    id: c.id, brand_id: c.brand_id, workspace_id: c.workspace_id, title: c.title, objective: c.objective, pillar: c.pillar, audience: c.audience, cta: c.cta,
    destination_url: c.destination_url, creative_brief: c.creative_brief, alt_text: c.alt_text, suggested_slot: c.suggested_slot, status: c.status, skip_reason: c.skip_reason,
    revision: c.revision, origin: c.origin, created_at: c.created_at, updated_at: c.updated_at, source_claim_ids: json(c.source_claim_ids_json, []),
    flags: json<QualityFlag[]>(c.quality_json, []), variants,
    approval: approval ? { revision: approval.revision, channels: json<any>(approval.channels_json, {}).channels || [], by: approval.approved_by_name, at: approval.approved_at } : null
  };
}

export const ListFilter = z.object({
  status: z.enum(["suggested", "approved", "skipped", "archived", "all"]).default("suggested"),
  pillar: z.string().optional(), q: z.string().max(100).optional(), flagged: z.enum(["any", "blocking", "none"]).optional()
});
export function listConcepts(db: DB, userId: string, brandId: string, f: z.infer<typeof ListFilter>) {
  requireBrand(db, userId, brandId, "read");
  const where = ["brand_id=?"]; const args: any[] = [brandId];
  if (f.status !== "all") { where.push("status=?"); args.push(f.status); }
  if (f.pillar) { where.push("pillar=?"); args.push(f.pillar); }
  if (f.q) { where.push("(title LIKE ? OR id IN (SELECT concept_id FROM variants WHERE caption LIKE ?))"); args.push(`%${f.q}%`, `%${f.q}%`); }
  let items = all<any>(db, `SELECT * FROM concepts WHERE ${where.join(" AND ")} ORDER BY created_at LIMIT 500`, ...args).map(c => hydrateConcept(db, c));
  const blocking = (c: any) => c.variants.some((v: any) => v.flags.some((x: any) => x.severity === "block"));
  if (f.flagged === "blocking") items = items.filter(blocking);
  if (f.flagged === "none") items = items.filter(c => !c.flags.length && c.variants.every((v: any) => !v.flags.length));
  const counts = Object.fromEntries(all<any>(db, "SELECT status, COUNT(*) n FROM concepts WHERE brand_id=? GROUP BY status", brandId).map(r => [r.status, r.n]));
  return { items, counts };
}

export function getConcept(db: DB, userId: string, conceptId: string) {
  const { concept, role } = requireConcept(db, userId, conceptId, "read");
  const c = hydrateConcept(db, concept);
  const brand = one<any>(db, "SELECT id, name, workspace_id, timezone FROM brands WHERE id=?", concept.brand_id);
  const claims = c.source_claim_ids.length
    ? all<any>(db, `SELECT c.id, c.kind, c.text, c.excerpt, c.status, s.url AS source_url, s.captured_at FROM claims c LEFT JOIN sources s ON s.id=c.source_id WHERE c.id IN (${c.source_claim_ids.map(() => "?").join(",")})`, ...c.source_claim_ids)
    : [];
  const revisions = all<any>(db, "SELECT r.revision, r.reason, r.instruction, r.created_at, u.name AS author FROM revisions r LEFT JOIN users u ON u.id=r.author_id WHERE r.concept_id=? ORDER BY r.revision DESC", conceptId);
  const approvals = all<any>(db, "SELECT a.revision, a.channels_json, a.approved_at, a.invalidated_at, a.invalidated_reason, u.name AS by FROM approvals a JOIN users u ON u.id=a.approved_by WHERE a.concept_id=? ORDER BY a.approved_at DESC", conceptId)
    .map(a => ({ ...a, channels: json<any>(a.channels_json, {}).channels || [], acknowledged: json<any>(a.channels_json, {}).acknowledged || [], channels_json: undefined }));
  return { ...c, brand, role, claims, revisions, approvals };
}

/* ---------------- edit ---------------- */
export const EditInput = z.object({
  expectedRevision: z.number().int(),
  title: z.string().trim().min(1).max(160).optional(), objective: z.string().max(300).optional(), pillar: z.string().max(80).optional(), audience: z.string().max(200).optional(),
  cta: z.string().max(200).optional(), destination_url: z.string().max(500).optional(), creative_brief: z.string().max(800).optional(), alt_text: z.string().max(300).optional(),
  suggested_slot: z.string().max(40).optional(),
  variants: z.record(z.enum(["linkedin", "facebook", "instagram"]), z.object({ caption: z.string().min(1).max(5000), hashtags: z.array(z.string().max(60)).max(40) }).partial()).optional()
});

function applyEdit(db: DB, userId: string, conceptId: string, input: z.infer<typeof EditInput>, reason: "edit" | "refine" | "restore", instruction?: string) {
  return tx(db, () => {
    const c = one<any>(db, "SELECT * FROM concepts WHERE id=?", conceptId);
    if (c.revision !== input.expectedRevision) throw new HttpError(409, "This post changed since you opened it. Reload to see the latest version before editing.", "conflict");
    let material = false; const sets: string[] = []; const args: any[] = [];
    for (const f of [...MATERIAL_FIELDS, ...OTHER_FIELDS]) {
      const v = (input as any)[f];
      if (v !== undefined && v !== c[f]) { sets.push(`${f}=?`); args.push(v); if ((MATERIAL_FIELDS as readonly string[]).includes(f)) material = true; }
    }
    for (const [ch, v] of Object.entries(input.variants || {})) {
      const cur = one<any>(db, "SELECT * FROM variants WHERE concept_id=? AND channel=?", conceptId, ch);
      if (!cur || !v) continue;
      const tags = v.hashtags ? [...new Set(v.hashtags.map(h => h.trim().replace(/^#?/, "#")).filter(h => h.length > 1))] : json(cur.hashtags_json, []);
      const caption = v.caption ?? cur.caption;
      if (caption !== cur.caption || JSON.stringify(tags) !== cur.hashtags_json) {
        run(db, "UPDATE variants SET caption=?, hashtags_json=?, updated_at=? WHERE id=?", caption, JSON.stringify(tags), now(), cur.id);
        material = true;
      }
    }
    if (!sets.length && !material) return { changed: false, material: false };
    if (material) sets.push("revision=revision+1");
    sets.push("updated_at=?"); args.push(now());
    run(db, `UPDATE concepts SET ${sets.join(", ")} WHERE id=?`, ...args, conceptId);
    if (material) {
      const inv = run(db, "UPDATE approvals SET invalidated_at=?, invalidated_reason=? WHERE concept_id=? AND invalidated_at IS NULL", now(), `Content changed (${reason}) after approval`, conceptId);
      if (c.status === "approved") run(db, "UPDATE concepts SET status='suggested' WHERE id=?", conceptId);
      writeRevision(db, conceptId, reason, userId, instruction);
      audit(db, c.workspace_id, userId, `concept.${reason}`, "concept", conceptId, { approvalInvalidated: inv.changes > 0 });
    }
    recomputeQuality(db, conceptId);
    return { changed: true, material };
  });
}

export function editConcept(db: DB, userId: string, conceptId: string, input: z.infer<typeof EditInput>) {
  requireConcept(db, userId, conceptId, "edit");
  applyEdit(db, userId, conceptId, input, "edit");
  return getConcept(db, userId, conceptId);
}

export function restoreRevision(db: DB, userId: string, conceptId: string, revision: number, expectedRevision: number) {
  requireConcept(db, userId, conceptId, "edit");
  const r = one<any>(db, "SELECT snapshot_json FROM revisions WHERE concept_id=? AND revision=?", conceptId, revision);
  if (!r) throw new HttpError(404, "That version doesn't exist.", "not_found");
  const s = json<any>(r.snapshot_json, {});
  applyEdit(db, userId, conceptId, { expectedRevision, title: s.title, objective: s.objective, pillar: s.pillar, audience: s.audience, cta: s.cta, destination_url: s.destination_url,
    creative_brief: s.creative_brief, alt_text: s.alt_text, suggested_slot: s.suggested_slot, variants: s.variants }, "restore", `Restored version ${revision}`);
  return getConcept(db, userId, conceptId);
}

export async function refineConcept(db: DB, userId: string, conceptId: string, instruction: string, expectedRevision: number) {
  const { concept } = requireConcept(db, userId, conceptId, "edit");
  if (concept.revision !== expectedRevision) throw new HttpError(409, "This post changed since you opened it. Reload first.", "conflict");
  if (!aiAvailable()) throw new HttpError(503, "Refining needs ANTHROPIC_API_KEY on the server.", "ai_not_configured");
  const brand = one<any>(db, "SELECT * FROM brands WHERE id=?", concept.brand_id);
  const cur = getConcept(db, userId, conceptId);
  const draft: ConceptDraft = {
    title: cur.title, objective: cur.objective, pillar: cur.pillar, audience: cur.audience, cta: cur.cta, destinationUrl: cur.destination_url, creativeBrief: cur.creative_brief,
    altText: cur.alt_text, suggestedSlot: cur.suggested_slot, sourceClaimIds: cur.source_claim_ids,
    variants: Object.fromEntries(cur.variants.map(v => [v.channel, { caption: v.caption, hashtags: v.hashtags }])) as any
  };
  const out = await getAI().refineConcept({ brand: brandContext(db, brand), concept: draft, instruction });
  applyEdit(db, userId, conceptId, {
    expectedRevision, title: out.title, objective: out.objective, pillar: out.pillar, audience: out.audience, cta: out.cta, destination_url: out.destinationUrl,
    creative_brief: out.creativeBrief, alt_text: out.altText, suggested_slot: out.suggestedSlot, variants: out.variants
  }, "refine", instruction);
  return getConcept(db, userId, conceptId);
}

/* ---------------- review actions ---------------- */
function recordUndo(db: DB, userId: string, c: any, action: string, previous: object) {
  const uid = id();
  run(db, "INSERT INTO undo_actions (id, workspace_id, user_id, concept_id, action, previous_json, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)",
    uid, c.workspace_id, userId, c.id, action, JSON.stringify(previous), new Date(Date.now() + UNDO_MS).toISOString(), now());
  return uid;
}

export const ApproveInput = z.object({
  expectedRevision: z.number().int(),
  channels: z.array(z.enum(["linkedin", "facebook", "instagram"])).min(1),
  acknowledgeFlags: z.boolean().default(false),
  brandId: z.string()   // guards against approving into the wrong client
});
export function approveConcept(db: DB, userId: string, conceptId: string, input: z.infer<typeof ApproveInput>) {
  const { concept } = requireConcept(db, userId, conceptId, "approve");
  if (concept.brand_id !== input.brandId) throw new HttpError(409, "This post belongs to a different brand than the one you're reviewing. Nothing was approved.", "wrong_brand");
  const undoId = tx(db, () => {
    const c = one<any>(db, "SELECT * FROM concepts WHERE id=?", conceptId);
    if (c.revision !== input.expectedRevision) throw new HttpError(409, "This post changed since you reviewed it. Review the latest version before approving.", "conflict");
    if (c.status === "archived") throw new HttpError(400, "Archived posts can't be approved. Restore it first.");
    recomputeQuality(db, conceptId);   // evidence may have changed since the flags were stored
    const variants = all<any>(db, "SELECT channel, quality_json FROM variants WHERE concept_id=?", conceptId);
    const blocking = variants.filter(v => input.channels.includes(v.channel)).flatMap(v => json<QualityFlag[]>(v.quality_json, []).filter(f => f.severity === "block").map(f => `${v.channel}: ${f.message}`));
    if (blocking.length && !input.acknowledgeFlags) throw Object.assign(new HttpError(422, "Resolve or acknowledge these issues before approving.", "blocking_flags"), { details: blocking });
    const prevApproval = one<any>(db, "SELECT id FROM approvals WHERE concept_id=? AND invalidated_at IS NULL", conceptId);
    run(db, "UPDATE approvals SET invalidated_at=?, invalidated_reason='Superseded by a new approval' WHERE concept_id=? AND invalidated_at IS NULL", now(), conceptId);
    const aid = id();
    run(db, "INSERT INTO approvals (id, workspace_id, concept_id, revision, channels_json, approved_by, approved_at) VALUES (?,?,?,?,?,?,?)",
      aid, c.workspace_id, conceptId, c.revision, JSON.stringify({ channels: input.channels, acknowledged: input.acknowledgeFlags ? blocking : [] }), userId, now());
    run(db, "UPDATE concepts SET status='approved', skip_reason=NULL, updated_at=? WHERE id=?", now(), conceptId);
    audit(db, c.workspace_id, userId, "concept.approved", "concept", conceptId, { revision: c.revision, channels: input.channels, acknowledged: blocking.length && input.acknowledgeFlags ? blocking : undefined });
    return recordUndo(db, userId, c, "approve", { status: c.status, skip_reason: c.skip_reason, approvalId: aid, prevApprovalId: prevApproval?.id ?? null });
  });
  return { concept: getConcept(db, userId, conceptId), undoId };
}

export function setStatus(db: DB, userId: string, conceptId: string, action: "skip" | "archive" | "unarchive", reason?: string) {
  const { concept } = requireConcept(db, userId, conceptId, action === "skip" ? "approve" : "edit");
  const undoId = tx(db, () => {
    const c = one<any>(db, "SELECT * FROM concepts WHERE id=?", conceptId);
    const status = action === "skip" ? "skipped" : action === "archive" ? "archived" : "suggested";
    run(db, "UPDATE concepts SET status=?, skip_reason=?, updated_at=? WHERE id=?", status, action === "skip" ? (reason || null) : c.skip_reason, now(), conceptId);
    if (status !== "suggested") run(db, "UPDATE approvals SET invalidated_at=?, invalidated_reason=? WHERE concept_id=? AND invalidated_at IS NULL", now(), `Post ${status}`, conceptId);
    audit(db, concept.workspace_id, userId, `concept.${action}`, "concept", conceptId, { reason });
    return recordUndo(db, userId, c, action, { status: c.status, skip_reason: c.skip_reason });
  });
  return { concept: getConcept(db, userId, conceptId), undoId };
}

export function undo(db: DB, userId: string, undoId: string) {
  const u = one<any>(db, "SELECT * FROM undo_actions WHERE id=?", undoId);
  if (!u || u.user_id !== userId) throw new HttpError(404, "Nothing to undo.", "not_found");
  requireWorkspace(db, userId, u.workspace_id, "read");
  if (u.used_at) throw new HttpError(409, "That action was already undone.");
  if (u.expires_at < now()) throw new HttpError(410, "It's too late to undo that action.");
  tx(db, () => {
    const prev = json<any>(u.previous_json, {});
    const c = one<any>(db, "SELECT * FROM concepts WHERE id=?", u.concept_id);
    run(db, "UPDATE concepts SET status=?, skip_reason=?, updated_at=? WHERE id=?", prev.status, prev.skip_reason ?? null, now(), u.concept_id);
    if (u.action === "approve") {
      run(db, "UPDATE approvals SET invalidated_at=?, invalidated_reason='Approval undone' WHERE id=? AND invalidated_at IS NULL", now(), prev.approvalId);
      if (prev.prevApprovalId && prev.status === "approved") run(db, "UPDATE approvals SET invalidated_at=NULL, invalidated_reason=NULL WHERE id=? AND revision=?", prev.prevApprovalId, c.revision);
    }
    run(db, "UPDATE undo_actions SET used_at=? WHERE id=?", now(), undoId);
    audit(db, u.workspace_id, userId, `concept.undo_${u.action}`, "concept", u.concept_id, {});
  });
  return getConcept(db, userId, u.concept_id);
}

export function duplicateConcept(db: DB, userId: string, conceptId: string) {
  const { concept } = requireConcept(db, userId, conceptId, "edit");
  const c = getConcept(db, userId, conceptId);
  const brand = one<any>(db, "SELECT * FROM brands WHERE id=?", concept.brand_id);
  const newId = tx(db, () => insertConcept(db, brand, {
    title: `${c.title} (copy)`, objective: c.objective, pillar: c.pillar, audience: c.audience, cta: c.cta, destinationUrl: c.destination_url, creativeBrief: c.creative_brief,
    altText: c.alt_text, suggestedSlot: c.suggested_slot, sourceClaimIds: c.source_claim_ids,
    variants: Object.fromEntries(c.variants.map(v => [v.channel, { caption: v.caption, hashtags: v.hashtags }])) as any
  }, { origin: "person", createdBy: userId, reason: "duplicate" }));
  return getConcept(db, userId, newId);
}

export const BulkApproveInput = z.object({
  brandId: z.string(),
  items: z.array(z.object({ conceptId: z.string(), expectedRevision: z.number().int(), channels: z.array(z.enum(["linkedin", "facebook", "instagram"])).min(1) })).min(1).max(100)
});
export function bulkApprove(db: DB, userId: string, input: z.infer<typeof BulkApproveInput>) {
  requireBrand(db, userId, input.brandId, "approve");
  return input.items.map(item => {
    try {
      const r = approveConcept(db, userId, item.conceptId, { ...item, brandId: input.brandId, acknowledgeFlags: false });
      return { conceptId: item.conceptId, ok: true, undoId: r.undoId };
    } catch (e: any) {
      return { conceptId: item.conceptId, ok: false, error: e.message, details: e.details };
    }
  });
}

export const CreateSingleInput = z.object({ brief: z.string().trim().min(5).max(2000) });
export async function createFromBrief(db: DB, userId: string, brandId: string, brief: string) {
  const { brand } = requireBrand(db, userId, brandId, "edit");
  if (brand.onboarding_status !== "ready") throw new HttpError(400, "Confirm the brand profile first.");
  if (!aiAvailable()) throw new HttpError(503, "Creating from a brief needs ANTHROPIC_API_KEY on the server.", "ai_not_configured");
  const ctxBrand = brandContext(db, brand);
  const prior = all<any>(db, "SELECT title FROM concepts WHERE brand_id=? AND status<>'archived'", brandId).map(p => p.title);
  const drafts = await getAI().generateConcepts({ brand: ctxBrand, count: 1, pillars: [`Follow this brief from the team exactly: ${brief}`], existingTitles: prior, existingHooks: [], batchIndex: 0, knownUrls: evidenceFor(db, brand).knownUrls });
  const cid = tx(db, () => insertConcept(db, brand, drafts[0], { origin: "person", createdBy: userId }));
  audit(db, brand.workspace_id, userId, "concept.created_from_brief", "concept", cid, {});
  return getConcept(db, userId, cid);
}
