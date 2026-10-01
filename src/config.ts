export const config = {
  appName: process.env.APP_NAME || "StudioPilot",
  port: Number(process.env.PORT || 3000),
  databasePath: process.env.DATABASE_PATH || "./data/studiopilot.db",
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  cookieSecure: process.env.COOKIE_SECURE === "true",
  runWorkerInProcess: process.env.RUN_WORKER_IN_PROCESS !== "false",
  crawl: {
    maxPages: Number(process.env.CRAWL_MAX_PAGES || 12),
    maxDepth: Number(process.env.CRAWL_MAX_DEPTH || 2),
    maxBytes: Number(process.env.CRAWL_MAX_BYTES || 2_000_000),
    delayMs: Number(process.env.CRAWL_DELAY_MS || 800),
    userAgent: "StudioPilotBot/0.1 (+brand research; respects robots.txt)"
  },
  generation: {
    initialConcepts: 50,
    batchSize: 5
  },
  limits: {
    maxRunningGenerationsPerWorkspace: 1
  }
};
export const aiConfigured = () => Boolean(config.anthropicKey);
