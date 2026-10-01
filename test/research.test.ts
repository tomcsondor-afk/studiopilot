import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb, makeUser, drain, useFakeAI, useFakeCrawl, fakeFetcher } from "./helpers.js";
import { crawlSite } from "../src/crawler.js";
import * as B from "../src/services/brands.js";
import { all, one } from "../src/db.js";
import { setAIAdapter } from "../src/ai/adapter.js";

beforeEach(() => { useFakeCrawl(); });

test("crawler respects robots.txt, stays on site and prioritises key pages", async () => {
  const res = await crawlSite("https://acme-plumbing.example", { fetcher: fakeFetcher(), delayMs: 0, maxPages: 10 });
  const urls = res.pages.map(p => p.url);
  assert.ok(urls.includes("https://acme-plumbing.example/about"));
  assert.ok(!urls.some(u => u.includes("/private")), "robots-disallowed page must not be fetched");
  assert.ok(!urls.some(u => u.includes("elsewhere.example")), "must not leave the site");
  assert.ok(res.skipped.some(s => s.reason.includes("robots")));
  assert.ok(res.signals.colours.some(c => c.hex === "#0b6e4f"));
  assert.equal(res.signals.logoCandidates[0], "https://acme-plumbing.example/logo.png");
});

test("crawler honours the page limit", async () => {
  const res = await crawlSite("https://acme-plumbing.example", { fetcher: fakeFetcher(), delayMs: 0, maxPages: 2 });
  assert.equal(res.pages.length, 2);
});

test("research stores sources and verifies every claim excerpt", async () => {
  const db = freshDb(); useFakeAI();
  const { userId, workspaceId } = makeUser(db, "alice");
  const { brandId } = B.createBrandFromWebsite(db, userId, workspaceId, "acme-plumbing.example");
  await drain(db);
  const bundle = B.getBrandBundle(db, userId, brandId);
  assert.equal(bundle.brand.onboarding_status, "review");
  assert.equal(bundle.brand.name, "Acme Plumbing");
  assert.ok(bundle.sources.length >= 3);
  const byText = Object.fromEntries(bundle.claims.map((c: any) => [c.text, c]));
  assert.equal(byText["Serving Leeds since 2009"].status, "confirmed");            // verified plain fact
  assert.equal(byText["Serving Leeds since 2009"].origin, "extracted");
  assert.equal(byText["Boiler servicing from £79"].status, "needs_confirmation");  // prices always need a person
  assert.equal(byText["Gas Safe registered"].status, "needs_confirmation");        // qualifications too
  assert.equal(byText["Best plumber in Yorkshire 2023"].origin, "suggested");      // excerpt not on the page
  assert.equal(byText["Best plumber in Yorkshire 2023"].status, "needs_confirmation");
  assert.ok(bundle.brand.profile.links.every((l: any) => l.url.includes("acme-plumbing.example")), "off-site links dropped");
  assert.ok(bundle.brand.profile.suggestedFields.includes("pillars"));
});

test("research without AI keeps the crawled pages and fails with a clear message", async () => {
  const db = freshDb(); setAIAdapter(null);
  const prev = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  const { userId, workspaceId } = makeUser(db, "bob");
  const { brandId } = B.createBrandFromWebsite(db, userId, workspaceId, "acme-plumbing.example");
  await drain(db);
  const job = one<any>(db, "SELECT * FROM jobs WHERE brand_id=?", brandId);
  assert.equal(job.status, "failed");
  assert.match(job.last_error, /ANTHROPIC_API_KEY/);
  assert.ok(all(db, "SELECT * FROM sources WHERE brand_id=?", brandId).length >= 3, "crawled pages retained for a later retry");
  assert.equal(one<any>(db, "SELECT onboarding_status s FROM brands WHERE id=?", brandId).s, "failed");
  if (prev) process.env.ANTHROPIC_API_KEY = prev;
});

test("retry after an AI failure reuses crawled pages instead of fetching again", async () => {
  const db = freshDb(); setAIAdapter(null);
  const { userId, workspaceId } = makeUser(db, "cara");
  const { brandId } = B.createBrandFromWebsite(db, userId, workspaceId, "acme-plumbing.example");
  await drain(db);
  const fake = useFakeAI();
  B.retryResearch(db, userId, brandId);
  await drain(db);
  assert.equal(fake.calls.extract, 1);
  assert.equal(B.getBrandBundle(db, userId, brandId).brand.onboarding_status, "review");
});

test("brand edits use optimistic versioning", async () => {
  const db = freshDb(); useFakeAI();
  const { userId, workspaceId } = makeUser(db, "dan");
  const { brandId } = B.createManualBrand(db, userId, workspaceId, { name: "Dan's Deli", websiteUrl: "", description: "A deli", industry: "Food", location: "York", facts: ["Open daily"] });
  const v = B.getBrandBundle(db, userId, brandId).brand.version;
  B.updateBrand(db, userId, brandId, { expectedVersion: v, description: "A small deli in York" });
  assert.throws(() => B.updateBrand(db, userId, brandId, { expectedVersion: v, description: "stale" }), /changed this brand/);
  assert.throws(() => B.BrandUpdate.parse({ expectedVersion: v + 1, timezone: "Mars/Olympus" }));
  assert.equal(B.BrandUpdate.parse({ expectedVersion: 1, timezone: "Europe/London" }).timezone, "Europe/London");
});
