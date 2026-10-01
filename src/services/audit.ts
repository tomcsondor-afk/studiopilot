import { DB, run } from "../db.js";
import { id, now } from "../util.js";
export function audit(db: DB, workspaceId: string | null, actorId: string | null, action: string, entity: string, entityId: string | null, detail: object = {}) {
  run(db, "INSERT INTO audit_events (id, workspace_id, actor_id, action, entity, entity_id, detail_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
    id(), workspaceId, actorId, action, entity, entityId, JSON.stringify(detail), now());
}
