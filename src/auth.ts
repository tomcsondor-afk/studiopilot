import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { DB, one, run, tx } from "./db.js";
import { id, now, sha256, HttpError } from "./util.js";
import { config } from "./config.js";

const COOKIE = "sp_session";
const SESSION_DAYS = 14;

export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [, saltHex, hashHex] = stored.split("$");
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(hashHex, "hex");
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}

export function createUserWithWorkspace(db: DB, input: { email: string; name: string; password: string; workspaceName: string }) {
  if (one(db, "SELECT id FROM users WHERE email = ?", input.email)) throw new HttpError(409, "An account with that email already exists.");
  return tx(db, () => {
    const userId = id(), orgId = id(), wsId = id(), t = now();
    run(db, "INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)", userId, input.email, input.name, hashPassword(input.password), t);
    run(db, "INSERT INTO organisations (id, name, created_at) VALUES (?,?,?)", orgId, input.workspaceName, t);
    run(db, "INSERT INTO workspaces (id, organisation_id, name, created_at) VALUES (?,?,?,?)", wsId, orgId, input.workspaceName, t);
    run(db, "INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?,?,?,?,?)", id(), wsId, userId, "owner", t);
    run(db, "INSERT INTO audit_events (id, workspace_id, actor_id, action, entity, entity_id, created_at) VALUES (?,?,?,?,?,?,?)", id(), wsId, userId, "workspace.created", "workspace", wsId, t);
    return { userId, workspaceId: wsId };
  });
}

export function createSession(db: DB, userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run(db, "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?,?,?,?)", sha256(token), userId, expires, now());
  return { token, expires };
}

export function setSessionCookie(res: Response, token: string, expires: string) {
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, expires: new Date(expires), path: "/" });
}

function readCookie(req: Request, name: string) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionUser(db: DB, req: Request): { id: string; email: string; name: string } | null {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const row = one<any>(db, `SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, sha256(token));
  if (!row || row.expires_at < now()) return null;
  return { id: row.id, email: row.email, name: row.name };
}

export function destroySession(db: DB, req: Request, res: Response) {
  const token = readCookie(req, COOKIE);
  if (token) run(db, "DELETE FROM sessions WHERE id = ?", sha256(token));
  res.clearCookie(COOKIE, { path: "/" });
}

// Simple fixed-window limiter for login attempts (per process).
const attempts = new Map<string, { n: number; reset: number }>();
export function checkLoginRate(key: string) {
  const t = Date.now();
  const a = attempts.get(key);
  if (!a || a.reset < t) { attempts.set(key, { n: 1, reset: t + 15 * 60_000 }); return; }
  if (++a.n > 10) throw new HttpError(429, "Too many sign-in attempts. Try again in 15 minutes.");
}

/** Mutating requests must be JSON: a cross-site form cannot send that without a CORS preflight, which we never allow. */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.is("application/json")) {
    return next(new HttpError(415, "Requests must be sent as JSON."));
  }
  next();
}
