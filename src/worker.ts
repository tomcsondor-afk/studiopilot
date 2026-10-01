import { getDb } from "./db.js";
import { startWorker } from "./jobs.js";
import "./services/brands.js";
import "./services/content.js";

const w = startWorker(getDb());
console.log(`Worker ${w.workerId} started.`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { w.stop(); process.exit(0); });
