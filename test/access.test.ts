import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { freshDb, useFakeAI } from "./helpers.js";
import { createApp } from "../src/app.js";
import { getDb, one } from "../src/db.js";

let server: Server, base = "";
before(async () => {
  freshDb(); useFakeAI();
  server = createApp().listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

class Client {
  cookie = "";
  async call(method: string, path: string, body?: any) {
    const res = await fetch(base + "/api" + path, { method, headers: { "content-type": "application/json", cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get("set-cookie"); if (set) this.cookie = set.split(";")[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  }
}
async function signup(name: string) {
  const c = new Client();
  const r = await c.call("POST", "/auth/signup", { name, email: `${name}@t.test`, password: "long-enough-pw", workspaceName: `${name} WS` });
  assert.equal(r.status, 200);
  return { c, ws: r.data.workspaceId as string };
}

test("tenants cannot read or change each other's data by changing IDs", async () => {
  const a = await signup("amy"), b = await signup("ben");
  await a.c.call("POST", "/workspaces/demo");
  const me = await a.c.call("GET", "/me");
  const demoWs = me.data.workspaces.find((w: any) => w.is_demo).id;
  const brands = await a.c.call("GET", `/workspaces/${demoWs}/brands`);
  const brandId = brands.data[0].id;
  const list = await a.c.call("GET", `/brands/${brandId}/concepts?status=suggested`);
  const concept = list.data.items[0];

  for (const [m, p, body] of [
    ["GET", `/workspaces/${demoWs}/brands`], ["GET", `/brands/${brandId}`], ["GET", `/brands/${brandId}/concepts`], ["GET", `/concepts/${concept.id}`],
    ["PATCH", `/concepts/${concept.id}`, { expectedRevision: concept.revision, title: "hijacked" }],
    ["POST", `/concepts/${concept.id}/approve`, { expectedRevision: concept.revision, channels: ["linkedin"], brandId }],
    ["POST", `/brands/${brandId}/generate`], ["POST", `/workspaces/${demoWs}/members`, { email: "ben@t.test", role: "admin" }],
    ["POST", `/workspaces/${demoWs}/brands`, { url: "example.com" }]
  ] as const) {
    const r = await b.c.call(m, p, body);
    assert.equal(r.status, 404, `${m} ${p} should be hidden from another tenant (got ${r.status})`);
  }
  assert.equal(one<any>(getDb(), "SELECT title FROM concepts WHERE id=?", concept.id).title, concept.title);
});

test("roles are enforced on the server", async () => {
  const owner = await signup("olga"), viewer = await signup("vic"), editor = await signup("eve"), approver = await signup("abe");
  await owner.c.call("POST", "/workspaces/demo");
  const ws = (await owner.c.call("GET", "/me")).data.workspaces.find((w: any) => w.is_demo).id;
  for (const [u, role] of [["vic", "viewer"], ["eve", "editor"], ["abe", "approver"]]) {
    assert.equal((await owner.c.call("POST", `/workspaces/${ws}/members`, { email: `${u}@t.test`, role })).status, 200);
  }
  const brandId = (await owner.c.call("GET", `/workspaces/${ws}/brands`)).data[0].id;
  const c = (await owner.c.call("GET", `/brands/${brandId}/concepts`)).data.items.find((x: any) => x.title === "Why we wait 36 hours");
  const approve = { expectedRevision: c.revision, channels: ["linkedin"], brandId };

  assert.equal((await viewer.c.call("GET", `/concepts/${c.id}`)).status, 200);
  assert.equal((await viewer.c.call("PATCH", `/concepts/${c.id}`, { expectedRevision: c.revision, title: "x" })).status, 403);
  assert.equal((await viewer.c.call("POST", `/concepts/${c.id}/approve`, approve)).status, 403);
  assert.equal((await editor.c.call("POST", `/concepts/${c.id}/approve`, approve)).status, 403);
  assert.equal((await approver.c.call("PATCH", `/concepts/${c.id}`, { expectedRevision: c.revision, title: "x" })).status, 403);
  assert.equal((await approver.c.call("POST", `/concepts/${c.id}/approve`, approve)).status, 200);
  assert.equal((await editor.c.call("POST", `/workspaces/${ws}/members`, { email: "vic@t.test", role: "admin" })).status, 403);
});

test("unauthenticated and non-JSON mutating requests are refused", async () => {
  const anon = new Client();
  assert.equal((await anon.call("GET", "/me")).status, 401);
  const res = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "email=a&password=b" });
  assert.equal(res.status, 415);
});

test("signup validates input and login rejects wrong passwords", async () => {
  const c = new Client();
  assert.equal((await c.call("POST", "/auth/signup", { name: "x", email: "not-an-email", password: "short", workspaceName: "w" })).status, 400);
  await signup("zed");
  assert.equal((await c.call("POST", "/auth/login", { email: "zed@t.test", password: "wrong-password" })).status, 401);
  assert.equal((await c.call("POST", "/auth/login", { email: "zed@t.test", password: "long-enough-pw" })).status, 200);
});

test("invalid source URLs are rejected before any job is queued", async () => {
  const a = await signup("una");
  for (const url of ["http://localhost:3000", "http://169.254.169.254/", "not a url", "ftp://x.com"]) {
    const r = await a.c.call("POST", `/workspaces/${a.ws}/brands`, { url });
    assert.equal(r.status, 400, url);
  }
  assert.equal(one<any>(getDb(), "SELECT COUNT(*) n FROM jobs").n, 0);
});
