import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as ufetch } from "undici";
import { HttpError } from "./util.js";

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||   // carrier-grade NAT
      (a === 169 && b === 254) ||             // link-local incl. cloud metadata 169.254.169.254
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const l = ip.toLowerCase();
  if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
  return l === "::" || l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("ff");
}

/** Validate a user-supplied URL's shape. Network-level checks happen at connect time (see pinnedLookup). */
export function parsePublicUrl(raw: string): URL {
  let u: URL;
  const s = String(raw || "").trim();
  try { u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); }
  catch { throw new HttpError(400, "That doesn't look like a web address.", "invalid_url"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new HttpError(400, "Only http and https addresses are supported.", "invalid_url");
  if (u.username || u.password) throw new HttpError(400, "Addresses with embedded credentials aren't allowed.", "invalid_url");
  if (u.port && !["80", "443"].includes(u.port)) throw new HttpError(400, "Only standard web ports (80 and 443) are allowed.", "invalid_url");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local"))
    throw new HttpError(400, "That address points to a private or local network.", "blocked_url");
  if (net.isIP(host) && isPrivateIp(host)) throw new HttpError(400, "That address points to a private or local network.", "blocked_url");
  if (!net.isIP(host) && !host.includes(".")) throw new HttpError(400, "Enter a full domain, such as example.co.uk.", "invalid_url");
  u.hash = "";
  return u;
}

/**
 * DNS lookup used for every outbound connection. Rejecting private addresses here (rather than
 * only before the request) closes the DNS-rebinding gap: the IP we check is the IP we connect to.
 */
function pinnedLookup(hostname: string, options: any, cb: any) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses: any) => {
    if (err) return cb(err);
    const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: options?.family || 4 }]);
    if (!list.length || list.some((a: any) => isPrivateIp(a.address))) {
      return cb(Object.assign(new Error("Blocked private address"), { code: "EBLOCKED" }));
    }
    if (options?.all) cb(null, list); else cb(null, list[0].address, list[0].family);
  });
}

const agent = new Agent({ connect: { lookup: pinnedLookup as any, timeout: 10_000 }, headersTimeout: 15_000, bodyTimeout: 20_000 });

export interface FetchResult { url: string; status: number; type: string; body: Buffer; truncated: boolean }

export type Fetcher = (url: string, opts?: { maxBytes?: number; accept?: string; userAgent?: string }) => Promise<FetchResult>;

export const safeFetch: Fetcher = async (raw, opts = {}) => {
  let u = parsePublicUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    let res;
    try {
      res = await ufetch(u, {
        dispatcher: agent, redirect: "manual",
        headers: { "user-agent": opts.userAgent || "StudioPilotBot/0.1", accept: opts.accept || "*/*", "accept-language": "en-GB,en;q=0.8" },
        signal: AbortSignal.timeout(20_000)
      });
    } catch (e: any) {
      const code = e?.cause?.code || e?.code;
      if (code === "EBLOCKED") throw new HttpError(400, "That address points to a private or local network.", "blocked_url");
      if (code === "ENOTFOUND") throw new HttpError(400, `Couldn't find ${u.hostname}. Check the spelling.`, "dns_failed");
      throw new HttpError(502, `Couldn't reach ${u.hostname} (${code || e?.name || "network error"}).`, "unreachable");
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) { await res.body?.cancel(); u = parsePublicUrl(new URL(loc, u).href); continue; }
    const max = opts.maxBytes ?? 2_000_000;
    const chunks: Buffer[] = []; let n = 0; let truncated = false;
    if (res.body) {
      for await (const chunk of res.body as any) {
        n += chunk.length;
        if (n > max) { truncated = true; break; }
        chunks.push(Buffer.from(chunk));
      }
    }
    return { url: u.href, status: res.status, type: res.headers.get("content-type") || "", body: Buffer.concat(chunks), truncated };
  }
  throw new HttpError(400, "The address redirects too many times.", "redirect_loop");
};
