import { randomUUID, createHash } from "node:crypto";
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};
export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") { super(message); }
}
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
