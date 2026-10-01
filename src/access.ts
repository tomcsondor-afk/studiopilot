import { DB, one } from "./db.js";
import { HttpError } from "./util.js";

export type Role = "owner" | "admin" | "editor" | "approver" | "viewer";
export type Permission = "read" | "edit" | "approve" | "manage";

const GRANTS: Record<Role, Permission[]> = {
  owner: ["read", "edit", "approve", "manage"],
  admin: ["read", "edit", "approve", "manage"],
  editor: ["read", "edit"],
  approver: ["read", "approve"],
  viewer: ["read"]
};

export const can = (role: Role, perm: Permission) => GRANTS[role].includes(perm);

/**
 * Resolve the caller's role in a workspace. Anything the caller isn't a member of
 * is reported as "not found" so IDs from other tenants can't be probed.
 */
export function requireWorkspace(db: DB, userId: string, workspaceId: string, perm: Permission): Role {
  const m = one<{ role: Role }>(db, "SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?", workspaceId, userId);
  if (!m) throw new HttpError(404, "Workspace not found.", "not_found");
  if (!can(m.role, perm)) throw new HttpError(403, `Your role (${m.role}) can't do this. Ask a workspace admin.`, "forbidden");
  return m.role;
}

export function requireBrand(db: DB, userId: string, brandId: string, perm: Permission) {
  const b = one<any>(db, "SELECT * FROM brands WHERE id = ?", brandId);
  if (!b) throw new HttpError(404, "Brand not found.", "not_found");
  const role = requireWorkspace(db, userId, b.workspace_id, perm);
  return { brand: b, role };
}

export function requireConcept(db: DB, userId: string, conceptId: string, perm: Permission) {
  const c = one<any>(db, "SELECT * FROM concepts WHERE id = ?", conceptId);
  if (!c) throw new HttpError(404, "Post not found.", "not_found");
  const role = requireWorkspace(db, userId, c.workspace_id, perm);
  return { concept: c, role };
}
