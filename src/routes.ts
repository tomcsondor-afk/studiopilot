import express, { Request, Response, NextFunction } from "express";
import { z, ZodError } from "zod";
import { getDb, one, all } from "./db.js";
import { HttpError, json } from "./util.js";
import { config } from "./config.js";
import { createUserWithWorkspace, createSession, setSessionCookie, sessionUser, verifyPassword, destroySession, checkLoginRate, csrfGuard } from "./auth.js";
import { requireBrand } from "./access.js";
import * as W from "./services/workspaces.js";
import * as B from "./services/brands.js";
import * as C from "./services/content.js";
import { seedDemoWorkspace } from "./services/demo.js";
import { featureStatus } from "./status.js";
import { aiAvailable } from "./ai/adapter.js";

type Handler = (req: Request & { user: { id: string; email: string; name: string } }, res: Response) => unknown;
const h = (fn: Handler, { auth = true } = {}) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (auth) {
      const u = sessionUser(getDb(), req);
      if (!u) throw new HttpError(401, "Please sign in.", "unauthenticated");
      (req as any).user = u;
    }
    const out = await fn(req as any, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) { next(e); }
};
const body = <T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> => schema.parse(req.body ?? {});

export function apiRouter() {
  const r = express.Router();
  r.use(express.json({ limit: "1mb" }));
  r.use(csrfGuard);

  /* ---------- auth ---------- */
  const SignUp = z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().email().max(200), password: z.string().min(10).max(200), workspaceName: z.string().trim().min(1).max(80) });
  r.post("/auth/signup", h((req, res) => {
    const input = body(SignUp, req);
    const db = getDb();
    const { userId, workspaceId } = createUserWithWorkspace(db, input);
    const s = createSession(db, userId); setSessionCookie(res, s.token, s.expires);
    return { workspaceId };
  }, { auth: false }));
  r.post("/auth/login", h((req, res) => {
    const { email, password } = body(z.object({ email: z.string().trim().max(200), password: z.string().max(200) }), req);
    checkLoginRate(`${req.ip}:${email.toLowerCase()}`);
    const db = getDb();
    const u = one<any>(db, "SELECT * FROM users WHERE email=?", email);
    if (!u || !verifyPassword(password, u.password_hash)) throw new HttpError(401, "That email and password don't match.", "bad_credentials");
    const s = createSession(db, u.id); setSessionCookie(res, s.token, s.expires);
    return { ok: true };
  }, { auth: false }));
  r.post("/auth/logout", h((req, res) => { destroySession(getDb(), req, res); return { ok: true }; }, { auth: false }));

  r.get("/me", h(req => ({ user: req.user, workspaces: W.listMyWorkspaces(getDb(), req.user.id), appName: config.appName, aiConfigured: aiAvailable() })));
  r.get("/status", h(() => featureStatus()));

  /* ---------- workspaces ---------- */
  r.post("/workspaces", h(req => W.createWorkspace(getDb(), req.user.id, body(z.object({ name: z.string().trim().min(1).max(80) }), req).name)));
  r.post("/workspaces/demo", h(req => seedDemoWorkspace(getDb(), req.user.id)));
  r.get("/workspaces/:ws/brands", h(req => B.listBrands(getDb(), req.user.id, req.params.ws)));
  r.get("/workspaces/:ws/members", h(req => W.listMembers(getDb(), req.user.id, req.params.ws)));
  r.post("/workspaces/:ws/members", h(req => W.addMember(getDb(), req.user.id, req.params.ws, body(W.MemberInput, req))));
  r.delete("/workspaces/:ws/members/:mid", h(req => W.removeMember(getDb(), req.user.id, req.params.ws, req.params.mid)));
  r.get("/workspaces/:ws/activity", h(req => W.recentActivity(getDb(), req.user.id, req.params.ws)));

  /* ---------- brands ---------- */
  r.post("/workspaces/:ws/brands", h(req => B.createBrandFromWebsite(getDb(), req.user.id, req.params.ws, body(z.object({ url: z.string().min(3).max(500) }), req).url)));
  r.post("/workspaces/:ws/brands/manual", h(req => B.createManualBrand(getDb(), req.user.id, req.params.ws, body(B.ManualBrandInput, req))));
  r.get("/brands/:id", h(req => B.getBrandBundle(getDb(), req.user.id, req.params.id)));
  r.patch("/brands/:id", h(req => B.updateBrand(getDb(), req.user.id, req.params.id, body(B.BrandUpdate, req))));
  r.post("/brands/:id/confirm", h(req => B.confirmBrand(getDb(), req.user.id, req.params.id)));
  r.post("/brands/:id/research/retry", h(req => B.retryResearch(getDb(), req.user.id, req.params.id)));
  r.post("/brands/:id/research/cancel", h(req => { B.cancelResearch(getDb(), req.user.id, req.params.id); return { ok: true }; }));
  r.post("/brands/:id/claims", h(req => { const out = B.addClaim(getDb(), req.user.id, req.params.id, body(B.ClaimInput, req)); C.recomputeBrandQuality(getDb(), req.params.id); return out; }));
  r.patch("/claims/:id", h(req => {
    const { status, text } = body(z.object({ status: z.enum(["confirmed", "rejected", "needs_confirmation"]), text: z.string().max(400).optional() }), req);
    const out: any = B.decideClaim(getDb(), req.user.id, req.params.id, status, text);
    C.recomputeBrandQuality(getDb(), out.brand_id);
    return out;
  }));
  r.post("/brands/:id/competitors", h(req => B.addCompetitor(getDb(), req.user.id, req.params.id, body(z.object({ url: z.string().min(3).max(500), name: z.string().max(120).optional(), notes: z.string().max(2000).optional() }), req))));
  r.delete("/competitors/:id", h(req => { B.removeCompetitor(getDb(), req.user.id, req.params.id); return { ok: true }; }));
  r.get("/brands/:id/sources/:sid", h(req => {
    requireBrand(getDb(), req.user.id, req.params.id, "read");
    const s = one<any>(getDb(), "SELECT id, url, title, kind, text, captured_at FROM sources WHERE id=? AND brand_id=?", req.params.sid, req.params.id);
    if (!s) throw new HttpError(404, "Source not found.");
    return s;
  }));

  /* ---------- generation ---------- */
  r.post("/brands/:id/generate", h(req => C.startGeneration(getDb(), req.user.id, req.params.id)));
  r.get("/brands/:id/generation", h(req => C.latestRun(getDb(), req.user.id, req.params.id)));
  r.post("/generations/:id/cancel", h(req => C.cancelRun(getDb(), req.user.id, req.params.id)));
  r.post("/generations/:id/resume", h(req => C.resumeRun(getDb(), req.user.id, req.params.id)));
  r.post("/brands/:id/concepts", h(req => C.createFromBrief(getDb(), req.user.id, req.params.id, body(C.CreateSingleInput, req).brief)));

  /* ---------- concepts ---------- */
  r.get("/brands/:id/concepts", h(req => C.listConcepts(getDb(), req.user.id, req.params.id, C.ListFilter.parse(req.query))));
  r.get("/concepts/:id", h(req => C.getConcept(getDb(), req.user.id, req.params.id)));
  r.patch("/concepts/:id", h(req => C.editConcept(getDb(), req.user.id, req.params.id, body(C.EditInput, req))));
  r.post("/concepts/:id/refine", h(req => { const b = body(z.object({ instruction: z.string().trim().min(3).max(800), expectedRevision: z.number().int() }), req); return C.refineConcept(getDb(), req.user.id, req.params.id, b.instruction, b.expectedRevision); }));
  r.post("/concepts/:id/restore", h(req => { const b = body(z.object({ revision: z.number().int(), expectedRevision: z.number().int() }), req); return C.restoreRevision(getDb(), req.user.id, req.params.id, b.revision, b.expectedRevision); }));
  r.post("/concepts/:id/approve", h(req => C.approveConcept(getDb(), req.user.id, req.params.id, body(C.ApproveInput, req))));
  r.post("/concepts/:id/skip", h(req => C.setStatus(getDb(), req.user.id, req.params.id, "skip", body(z.object({ reason: z.string().max(300).optional() }), req).reason)));
  r.post("/concepts/:id/archive", h(req => C.setStatus(getDb(), req.user.id, req.params.id, "archive")));
  r.post("/concepts/:id/unarchive", h(req => C.setStatus(getDb(), req.user.id, req.params.id, "unarchive")));
  r.post("/concepts/:id/duplicate", h(req => C.duplicateConcept(getDb(), req.user.id, req.params.id)));
  r.post("/undo/:id", h(req => C.undo(getDb(), req.user.id, req.params.id)));
  r.post("/concepts/bulk-approve", h(req => C.bulkApprove(getDb(), req.user.id, body(C.BulkApproveInput, req))));

  r.use((_req, _res, next) => next(new HttpError(404, "Not found.", "not_found")));
  r.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: "Some fields are missing or invalid.", code: "validation", issues: err.issues.map(i => ({ path: i.path.join("."), message: i.message })) });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, details: (err as any).details });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON.", code: "bad_json" });
    console.error("[api] unexpected error:", err?.message);
    res.status(500).json({ error: "Something went wrong on our side. Try again.", code: "internal" });
  });
  return r;
}
