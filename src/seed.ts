import { getDb, one } from "./db.js";
import { createUserWithWorkspace } from "./auth.js";
import { seedDemoWorkspace } from "./services/demo.js";

const db = getDb();
const email = "demo@studiopilot.local";
let u = one<any>(db, "SELECT id FROM users WHERE email=?", email);
if (!u) u = { id: createUserWithWorkspace(db, { email, name: "Demo User", password: "demo-password-123", workspaceName: "My business" }).userId };
seedDemoWorkspace(db, u.id);
console.log(`Demo ready. Sign in with ${email} / demo-password-123`);
