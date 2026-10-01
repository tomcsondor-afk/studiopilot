import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, makeUser } from "./helpers.js";
import { enqueue, claim, runJob, registerHandler } from "../src/jobs.js";
import { one, run } from "../src/db.js";

test("idempotency key prevents duplicate jobs", () => {
  const db = freshDb(); const { workspaceId } = makeUser(db, "h");
  const a = enqueue(db, { workspaceId, type: "noop", key: "same" });
  const b = enqueue(db, { workspaceId, type: "noop", key: "same" });
  assert.equal(a.id, b.id);
  assert.equal(one<any>(db, "SELECT COUNT(*) n FROM jobs").n, 1);
});

test("a job can only be claimed by one worker", () => {
  const db = freshDb(); const { workspaceId } = makeUser(db, "i");
  enqueue(db, { workspaceId, type: "noop", key: "k1" });
  const first = claim(db, "w1");
  const second = claim(db, "w2");
  assert.ok(first);
  assert.equal(second, null);
});

test("expired leases are reclaimed after a worker crash; the old worker can't complete it", async () => {
  const db = freshDb(); const { workspaceId } = makeUser(db, "j");
  let runs = 0;
  registerHandler("count", async () => { runs++; });
  enqueue(db, { workspaceId, type: "count", key: "k2" });
  const stale = claim(db, "crashed")!;
  run(db, "UPDATE jobs SET lease_expires_at=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), stale.id);
  const again = claim(db, "healthy")!;
  assert.equal(again.id, stale.id);
  await runJob(db, again, "healthy");
  assert.equal(one<any>(db, "SELECT status FROM jobs WHERE id=?", stale.id).status, "succeeded");
  // The crashed worker waking up must not overwrite the outcome.
  registerHandler("count", async () => { runs++; throw new Error("late failure from the crashed worker"); });
  await runJob(db, stale, "crashed");
  assert.equal(one<any>(db, "SELECT status FROM jobs WHERE id=?", stale.id).status, "succeeded");
});

test("failures retry with backoff up to the limit, then fail", async () => {
  const db = freshDb(); const { workspaceId } = makeUser(db, "k");
  registerHandler("flaky", async () => { throw new Error("temporary"); });
  const j = enqueue(db, { workspaceId, type: "flaky", key: "k3", maxAttempts: 2 });
  await runJob(db, claim(db, "w")!, "w");
  let row = one<any>(db, "SELECT * FROM jobs WHERE id=?", j.id);
  assert.equal(row.status, "queued");
  assert.ok(row.run_after > new Date().toISOString());
  run(db, "UPDATE jobs SET run_after=? WHERE id=?", new Date(0).toISOString(), j.id);
  await runJob(db, claim(db, "w")!, "w");
  row = one<any>(db, "SELECT * FROM jobs WHERE id=?", j.id);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 2);
});
