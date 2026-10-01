import { config } from "./config.js";
import { getDb } from "./db.js";
import { createApp } from "./app.js";
import { startWorker } from "./jobs.js";
import "./services/brands.js";     // registers job handlers
import "./services/content.js";

const db = getDb();
createApp().listen(config.port, () => {
  console.log(`${config.appName} running at http://localhost:${config.port}`);
  if (!config.anthropicKey) console.log("ANTHROPIC_API_KEY is not set: crawling works, AI analysis and generation will report that they need it.");
});
if (config.runWorkerInProcess) {
  const w = startWorker(db);
  console.log(`Background worker ${w.workerId} running in-process (set RUN_WORKER_IN_PROCESS=false and run "npm run worker" to separate it).`);
}
