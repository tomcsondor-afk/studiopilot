import { z } from "zod";
import { DB, all, one, run, tx } from "../db.js";
import { id, now, HttpError } from "../util.js";
import { requireWorkspace, Role } from "../access.js";
import { audit } from "./audit.js";

export function listMyWorkspaces(db: DB, userId: string) {
  return all<any>(db, `SELECT w.id, w.name, w.is_demo, w.organisation_id, m.role,
      (SELECT COUNT(*) FROM brands b WHERE b.workspace_id=w.id) AS brands
    FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.is_demo, w.created_at`, userId);
}

export function createWorkspace(db: DB, userId: string, name: string) {
  // New client workspaces go in an organisation the caller already administers, so agencies keep one organisation.
  const org = one<any>(db, `SELECT w.organisation_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
    WHERE m.user_id=? AND m.role IN ('owner','admin') AND w.is_demo=0 ORDER BY w.created_at LIMIT 1`, userId);
  return tx(db, () => {
    let orgId = org?.organisation_id;
    if (!orgId) { orgId = id(); run(db, "INSERT INTO organisations (id, name, created_at) VALUES (?,?,?)", orgId, name, now()); }
    const wsId = id();
    run(db, "INSERT INTO workspaces (id, organisation_id, name, created_at) VALUES (?,?,?,?)", wsId, orgId, name, now());
    run(db, "INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?,?,?,?,?)", id(), wsId, userId, "owner", now());
    audit(db, wsId, userId, "workspace.created", "workspace", wsId, {});
    return { id: wsId, name };
  });
}

export function listMembers(db: DB, userId: string, workspaceId: string) {
  requireWorkspace(db, userId, workspaceId, "read");
  return all<any>(db, "SELECT m.id, m.role, u.name, u.email, m.created_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.created_at", workspaceId);
}

export const MemberInput = z.object({ email: z.string().email(), role: z.enum(["admin", "editor", "approver", "viewer"]) });
export function addMember(db: DB, userId: string, workspaceId: string, input: z.infer<typeof MemberInput>) {
  requireWorkspace(db, userId, workspaceId, "manage");
  const u = one<any>(db, "SELECT id FROM users WHERE email=?", input.email);
  if (!u) throw new HttpError(404, "No account uses that email yet. Ask them to sign up first, then add them. (Email invitations arrive with milestone 4.)", "no_user");
  run(db, "INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET role=excluded.role",
    id(), workspaceId, u.id, input.role, now());
  audit(db, workspaceId, userId, "member.added", "user", u.id, { role: input.role });
  return listMembers(db, userId, workspaceId);
}

export function removeMember(db: DB, userId: string, workspaceId: string, membershipId: string) {
  requireWorkspace(db, userId, workspaceId, "manage");
  const m = one<any>(db, "SELECT * FROM memberships WHERE id=? AND workspace_id=?", membershipId, workspaceId);
  if (!m) throw new HttpError(404, "Member not found.");
  if (m.role === "owner" && (one<any>(db, "SELECT COUNT(*) n FROM memberships WHERE workspace_id=? AND role='owner'", workspaceId).n as number) <= 1)
    throw new HttpError(400, "A workspace needs at least one owner.");
  run(db, "DELETE FROM memberships WHERE id=?", membershipId);
  audit(db, workspaceId, userId, "member.removed", "membership", membershipId, {});
  return listMembers(db, userId, workspaceId);
}

export function recentActivity(db: DB, userId: string, workspaceId: string) {
  requireWorkspace(db, userId, workspaceId, "read");
  return all<any>(db, `SELECT a.action, a.entity, a.entity_id, a.created_at, u.name AS actor FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id
    WHERE a.workspace_id=? ORDER BY a.created_at DESC LIMIT 25`, workspaceId);
}

export type { Role };
