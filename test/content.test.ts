import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, makeUser, drain, useFakeAI, useFakeCrawl, draft } from "./helpers.js";
import * as B from "../src/services/brands.js";
import * as C from "../src/services/content.js";
import { seedDemoWorkspace } from "../src/services/demo.js";
import { all, one, run } from "../src/db.js";
import { enqueue } from "../src/jobs.js";

async function readyBrand() {
  const db = freshDb(); useFakeCrawl(); const ai = useFakeAI();
  const { userId, workspaceId } = makeUser(db, "erin");
  const { brandId } = B.createBrandFromWebsite(db, userId, workspaceId, "acme-plumbing.example");
  await drain(db);
  B.confirmBrand(db, userId, brandId);
  return { db, ai, userId, workspaceId, brandId };
}

test("generates 50 concepts in batches of 5 with three channel variants each", async () => {
  const { db, userId, brandId, ai } = await readyBrand();
  const runInfo = C.startGeneration(db, userId, brandId);
  assert.equal(runInfo.target_count, 50);
  await drain(db);
  const r = C.getRun(db, userId, runInfo.id);
  assert.equal(r.status, "completed");
  assert.equal(r.produced, 50);
  assert.equal(ai.calls.generate, 10);
  const { items } = C.listConcepts(db, userId, brandId, { status: "all" });
  assert.equal(items.length, 50);
  assert.ok(items.every((c: any) => c.variants.length === 3));
});

test("a failing batch keeps earlier work, marks the run partial, and resume finishes it", async () => {
  const { db, userId, brandId, ai } = await readyBrand();
  ai.failBatches.add(4);
  const runInfo = C.startGeneration(db, userId, brandId);
  await drain(db);
  let r = C.getRun(db, userId, runInfo.id);
  assert.equal(r.status, "partial");
  assert.equal(r.produced, 20, "batches 0-3 survive");
  assert.match(r.lastError!, /batch 4/);
  ai.failBatches.clear();
  C.resumeRun(db, userId, runInfo.id);
  await drain(db);
  r = C.getRun(db, userId, runInfo.id);
  assert.equal(r.status, "completed");
  assert.equal(r.produced, 50);
});

test("running the same batch twice never duplicates concepts", async () => {
  const { db, userId, brandId, workspaceId } = await readyBrand();
  const runInfo = C.startGeneration(db, userId, brandId);
  await drain(db);
  enqueue(db, { workspaceId, brandId, type: "generate_batch", key: `${runInfo.id}:batch:2:again`, payload: { runId: runInfo.id, batchIndex: 2 } });
  await drain(db);
  assert.equal(one<any>(db, "SELECT COUNT(*) n FROM concepts WHERE run_id=?", runInfo.id).n, 50);
});

test("cancelling a run stops further batches", async () => {
  const { db, userId, brandId } = await readyBrand();
  const runInfo = C.startGeneration(db, userId, brandId);
  C.cancelRun(db, userId, runInfo.id);
  await drain(db);
  assert.equal(C.getRun(db, userId, runInfo.id).produced, 0);
  assert.equal(C.getRun(db, userId, runInfo.id).status, "cancelled");
});

test("only one generation runs per workspace at a time", async () => {
  const { db, userId, brandId } = await readyBrand();
  C.startGeneration(db, userId, brandId);
  assert.throws(() => C.startGeneration(db, userId, brandId), /already running/);
});

test("material edits invalidate approval; non-material edits keep it", async () => {
  const { db, userId, brandId } = await readyBrand();
  C.startGeneration(db, userId, brandId, 5); await drain(db);
  const c = C.listConcepts(db, userId, brandId, { status: "suggested" }).items[0];
  const approved = C.approveConcept(db, userId, c.id, { expectedRevision: c.revision, channels: ["linkedin", "facebook"], acknowledgeFlags: false, brandId });
  assert.equal(approved.concept.status, "approved");
  assert.equal(approved.concept.approval!.revision, c.revision);

  const kept = C.editConcept(db, userId, c.id, { expectedRevision: c.revision, pillar: "Meet the team" });
  assert.equal(kept.status, "approved");
  assert.equal(kept.revision, c.revision);

  const edited = C.editConcept(db, userId, c.id, { expectedRevision: c.revision, variants: { linkedin: { caption: "A rewritten LinkedIn post." } } });
  assert.equal(edited.status, "suggested");
  assert.equal(edited.revision, c.revision + 1);
  assert.equal(edited.approval, null);
  assert.match(edited.approvals[0].invalidated_reason, /changed/);
  assert.equal(edited.revisions.length, 2);
});

test("stale revisions are rejected for edits and approvals", async () => {
  const { db, userId, brandId } = await readyBrand();
  C.startGeneration(db, userId, brandId, 5); await drain(db);
  const c = C.listConcepts(db, userId, brandId, { status: "suggested" }).items[0];
  C.editConcept(db, userId, c.id, { expectedRevision: c.revision, title: "New title here" });
  assert.throws(() => C.editConcept(db, userId, c.id, { expectedRevision: c.revision, title: "Other" }), /changed since/);
  assert.throws(() => C.approveConcept(db, userId, c.id, { expectedRevision: c.revision, channels: ["linkedin"], acknowledgeFlags: false, brandId }), /changed since/);
});

test("approving under the wrong brand is refused", async () => {
  const { db, userId, brandId, workspaceId } = await readyBrand();
  C.startGeneration(db, userId, brandId, 5); await drain(db);
  const other = B.createManualBrand(db, userId, workspaceId, { name: "Other Client", websiteUrl: "", description: "", industry: "", location: "", facts: [] });
  const c = C.listConcepts(db, userId, brandId, { status: "suggested" }).items[0];
  assert.throws(() => C.approveConcept(db, userId, c.id, { expectedRevision: c.revision, channels: ["linkedin"], acknowledgeFlags: false, brandId: other.brandId }), /different brand/);
  assert.equal(C.getConcept(db, userId, c.id).status, "suggested");
});

test("blocking quality flags stop approval unless acknowledged, and the acknowledgement is recorded", async () => {
  const db = freshDb();
  const { userId } = makeUser(db, "fay");
  const { workspaceId } = seedDemoWorkspace(db, userId);
  const brand = one<any>(db, "SELECT id FROM brands WHERE workspace_id=?", workspaceId);
  const bad = C.listConcepts(db, userId, brand.id, { status: "suggested" }).items.find((c: any) => c.title.startsWith("The best new bakery"))!;
  const codes = bad.variants.flatMap((v: any) => v.flags.map((f: any) => f.code));
  for (const code of ["unsupported_figure", "unverified_offer", "filler"]) assert.ok(codes.includes(code), `expected ${code}`);
  assert.throws(() => C.approveConcept(db, userId, bad.id, { expectedRevision: bad.revision, channels: ["facebook"], acknowledgeFlags: false, brandId: brand.id }), /Resolve or acknowledge/);
  const ok = C.approveConcept(db, userId, bad.id, { expectedRevision: bad.revision, channels: ["facebook"], acknowledgeFlags: true, brandId: brand.id });
  assert.ok(ok.concept.approvals[0].acknowledged.length > 0);
  const good = C.listConcepts(db, userId, brand.id, { status: "suggested" }).items.find((c: any) => c.title === "Why we wait 36 hours")!;
  assert.ok(good.variants.every((v: any) => !v.flags.some((f: any) => f.severity === "block")), "verified figures (36 hours) are not flagged");
});

test("confirming a claim clears the unsupported-figure flag", async () => {
  const db = freshDb();
  const { userId } = makeUser(db, "gus");
  const { workspaceId } = seedDemoWorkspace(db, userId);
  const brand = one<any>(db, "SELECT * FROM brands WHERE workspace_id=?", workspaceId);
  const cid = C.insertConcept(db, brand, draft(1, { variants: { ...draft(1).variants, linkedin: { caption: "We've baked 12,000 loaves this year.", hashtags: [] } } }), { origin: "person", createdBy: userId });
  const flags = () => C.getConcept(db, userId, cid).variants.find((v: any) => v.channel === "linkedin")!.flags.map((f: any) => f.code);
  assert.ok(flags().includes("unsupported_figure"));
  B.addClaim(db, userId, brand.id, { kind: "statistic", text: "Baked 12,000 loaves this year", evidence: "Till records 2026" });
  C.recomputeBrandQuality(db, brand.id);
  assert.ok(!flags().includes("unsupported_figure"));
});

test("undo reverses an approval and restores review state", async () => {
  const { db, userId, brandId } = await readyBrand();
  C.startGeneration(db, userId, brandId, 5); await drain(db);
  const c = C.listConcepts(db, userId, brandId, { status: "suggested" }).items[0];
  const { undoId } = C.approveConcept(db, userId, c.id, { expectedRevision: c.revision, channels: ["instagram"], acknowledgeFlags: false, brandId });
  const back = C.undo(db, userId, undoId);
  assert.equal(back.status, "suggested");
  assert.equal(back.approval, null);
  assert.throws(() => C.undo(db, userId, undoId), /already undone/);
});

test("skip records a reason; restore brings back an older version as a new revision", async () => {
  const { db, userId, brandId } = await readyBrand();
  C.startGeneration(db, userId, brandId, 5); await drain(db);
  const c = C.listConcepts(db, userId, brandId, { status: "suggested" }).items[0];
  const original = c.variants.find((v: any) => v.channel === "facebook")!.caption;
  const e = C.editConcept(db, userId, c.id, { expectedRevision: c.revision, variants: { facebook: { caption: "Changed" } } });
  const restored = C.restoreRevision(db, userId, c.id, 1, e.revision);
  assert.equal(restored.variants.find((v: any) => v.channel === "facebook")!.caption, original);
  assert.equal(restored.revision, 3);
  const s = C.setStatus(db, userId, c.id, "skip", "Too salesy");
  assert.equal(s.concept.status, "skipped");
  assert.equal(s.concept.skip_reason, "Too salesy");
});

test("refine applies the AI change as a new revision with the instruction recorded", async () => {
  const { db, userId, brandId } = await readyBrand();
  C.startGeneration(db, userId, brandId, 5); await drain(db);
  const c = C.listConcepts(db, userId, brandId, { status: "suggested" }).items[0];
  const out = await C.refineConcept(db, userId, c.id, "Use a warmer tone", c.revision);
  assert.match(out.variants.find((v: any) => v.channel === "linkedin")!.caption, /\(warmer\)$/);
  assert.equal(out.variants.find((v: any) => v.channel === "facebook")!.caption, c.variants.find((v: any) => v.channel === "facebook")!.caption, "untouched channel preserved");
  assert.equal(out.revisions[0].instruction, "Use a warmer tone");
});

test("bulk approve reports each item individually", async () => {
  const { db, userId, brandId } = await readyBrand();
  C.startGeneration(db, userId, brandId, 5); await drain(db);
  const items = C.listConcepts(db, userId, brandId, { status: "suggested" }).items.slice(0, 3);
  const res = C.bulkApprove(db, userId, { brandId, items: [
    ...items.slice(0, 2).map((c: any) => ({ conceptId: c.id, expectedRevision: c.revision, channels: ["linkedin" as const] })),
    { conceptId: items[2].id, expectedRevision: 99, channels: ["linkedin" as const] }
  ] });
  assert.deepEqual(res.map(r => r.ok), [true, true, false]);
});
