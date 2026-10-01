import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(here, "..", "migrations");

export type DB = DatabaseSync;
let db: DB | null = null;

export function openDb(file = config.databasePath): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(d);
  return d;
}

export function getDb(): DB {
  return (db ??= openDb());
}
export function setDb(d: DB) { db = d; }

export function migrate(d: DB) {
  d.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set((d.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map(r => r.name));
  const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
    tx(d, () => {
      d.exec(sql);
      d.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
    });
  }
}

/** Run fn inside a transaction (IMMEDIATE takes the write lock up front, so check-then-write is atomic). */
export function tx<T>(d: DB, fn: () => T): T {
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export const one = <T = any>(d: DB, sql: string, ...args: any[]) => d.prepare(sql).get(...args) as T | undefined;
export const all = <T = any>(d: DB, sql: string, ...args: any[]) => d.prepare(sql).all(...args) as T[];
export const run = (d: DB, sql: string, ...args: any[]) => d.prepare(sql).run(...args);
