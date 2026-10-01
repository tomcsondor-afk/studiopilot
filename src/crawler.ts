import * as cheerio from "cheerio";
import { Fetcher, safeFetch, parsePublicUrl } from "./ssrf.js";
import { config } from "./config.js";
import { sleep } from "./util.js";

export interface CrawledPage {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
  depth: number;
}
export interface SiteSignals {
  siteName: string;
  colours: { hex: string; count: number }[];
  fonts: string[];
  logoCandidates: string[];
  images: string[];
  socialLinks: string[];
  structuredData: any[];   // schema.org Organization / LocalBusiness blocks
}
export interface CrawlResult {
  startUrl: string;
  pages: CrawledPage[];
  skipped: { url: string; reason: string }[];
  signals: SiteSignals;
}
export interface CrawlOptions {
  fetcher?: Fetcher;
  maxPages?: number;
  maxDepth?: number;
  delayMs?: number;
  onPage?: (p: CrawledPage, count: number) => void;
  shouldStop?: () => boolean;
}

/* ---------- robots.txt ---------- */
interface Robots { allow: string[]; disallow: string[]; delay: number }
export function parseRobots(txt: string, agentToken = "studiopilotbot"): Robots {
  const groups: { agents: string[]; rules: [string, string][] }[] = [];
  let cur: { agents: string[]; rules: [string, string][] } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":"); if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase(), val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else if (cur) { cur.rules.push([key, val]); lastWasAgent = false; }
  }
  const specific = groups.filter(g => g.agents.some(a => a !== "*" && agentToken.includes(a)));
  const chosen = specific.length ? specific : groups.filter(g => g.agents.includes("*"));
  const r: Robots = { allow: [], disallow: [], delay: 0 };
  for (const g of chosen) for (const [k, v] of g.rules) {
    if (k === "allow" && v) r.allow.push(v);
    if (k === "disallow" && v) r.disallow.push(v);
    if (k === "crawl-delay") r.delay = Math.min(10, Number(v) || 0);
  }
  return r;
}
function ruleMatches(rule: string, path: string) {
  const anchored = rule.endsWith("$");
  const pattern = "^" + rule.replace(/\$$/, "").split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : "");
  return new RegExp(pattern).test(path);
}
export function robotsAllows(r: Robots, path: string) {
  const longest = (rules: string[]) => rules.filter(x => ruleMatches(x, path)).reduce((m, x) => Math.max(m, x.length), -1);
  const a = longest(r.allow), d = longest(r.disallow);
  return d < 0 || a >= d;
}

/* ---------- extraction helpers ---------- */
const GENERIC_FONTS = new Set(["inherit", "initial", "unset", "sans-serif", "serif", "monospace", "system-ui", "-apple-system", "blinkmacsystemfont",
  "segoe ui", "roboto", "helvetica neue", "helvetica", "arial", "apple color emoji", "segoe ui emoji", "ui-sans-serif", "ui-serif", "times new roman"]);

function countColours(text: string, counts: Map<string, number>) {
  for (const m of text.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-f])/gi)) {
    let h = m[1].toLowerCase(); if (h.length === 3) h = h.split("").map(c => c + c).join("");
    counts.set("#" + h, (counts.get("#" + h) || 0) + 1);
  }
  for (const m of text.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) {
    const h = "#" + [m[1], m[2], m[3]].map(v => Math.min(255, +v).toString(16).padStart(2, "0")).join("");
    counts.set(h, (counts.get(h) || 0) + 1);
  }
}
function countFonts(text: string, counts: Map<string, number>) {
  for (const m of text.matchAll(/font-family\s*:\s*([^;}{]+)/gi)) {
    const f = m[1].split(",")[0].trim().replace(/^['"]|['"]$/g, "").trim();
    if (!f || f.startsWith("var(") || GENERIC_FONTS.has(f.toLowerCase()) || f.length > 40) continue;
    const clean = f.replace(/__.*$/, "").replace(/_Fallback.*$/i, "").replace(/[_]/g, " ").trim();
    if (clean) counts.set(clean, (counts.get(clean) || 0) + 1);
  }
}
const topN = <K>(m: Map<K, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const PRIORITY = /about|story|who-we-are|team|services|what-we-do|products|shop|pricing|menu|treatments|solutions|contact|faq|case-stud|work|portfolio/i;
const BLOG = /blog|news|insights|articles|journal/i;
const SKIP = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|docx?|xlsx?)$|\/(cart|checkout|account|login|signin|register|wp-admin|search)/i;

function sameSite(a: URL, b: URL) { return a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, ""); }

function pageText($: cheerio.CheerioAPI) {
  $("script,style,noscript,svg,iframe,template,form").remove();
  const headings: string[] = [];
  $("h1,h2,h3").each((_, el) => { const t = $(el).text().replace(/\s+/g, " ").trim(); if (t && !headings.includes(t)) headings.push(t); });
  const blocks: string[] = [];
  $("main p, main li, article p, p, li, blockquote, address, td").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t.length > 20 && !blocks.includes(t)) blocks.push(t);
  });
  return { headings: headings.slice(0, 40), text: blocks.join("\n").slice(0, 12_000) };
}

/* ---------- crawl ---------- */
export async function crawlSite(startRaw: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const fetcher = opts.fetcher || safeFetch;
  const maxPages = opts.maxPages ?? config.crawl.maxPages;
  const maxDepth = opts.maxDepth ?? config.crawl.maxDepth;
  const start = parsePublicUrl(startRaw);
  const ua = config.crawl.userAgent;

  let robots: Robots = { allow: [], disallow: [], delay: 0 };
  try {
    const r = await fetcher(new URL("/robots.txt", start).href, { maxBytes: 200_000, accept: "text/plain", userAgent: ua });
    if (r.status === 200) robots = parseRobots(r.body.toString("utf8"));
  } catch { /* no robots.txt: default allow */ }
  const delay = Math.max(opts.delayMs ?? config.crawl.delayMs, robots.delay * 1000);

  const queue: { url: string; depth: number; score: number }[] = [{ url: start.href, depth: 0, score: 100 }];
  const seen = new Set<string>([start.href]);
  const pages: CrawledPage[] = [];
  const skipped: { url: string; reason: string }[] = [];
  let blogCount = 0;
  const colours = new Map<string, number>(), fonts = new Map<string, number>();
  const signals: SiteSignals = { siteName: "", colours: [], fonts: [], logoCandidates: [], images: [], socialLinks: [], structuredData: [] };

  while (queue.length && pages.length < maxPages) {
    if (opts.shouldStop?.()) break;
    queue.sort((a, b) => b.score - a.score);
    const next = queue.shift()!;
    const u = new URL(next.url);
    if (!robotsAllows(robots, u.pathname + u.search)) { skipped.push({ url: next.url, reason: "Blocked by robots.txt" }); continue; }
    if (pages.length > 0) await sleep(delay);

    let res;
    try { res = await fetcher(next.url, { maxBytes: config.crawl.maxBytes, accept: "text/html,application/xhtml+xml", userAgent: ua }); }
    catch (e: any) {
      skipped.push({ url: next.url, reason: e.message });
      if (pages.length === 0) throw e;   // the home page itself failed: surface the real reason
      continue;
    }
    if (res.status === 401 || res.status === 403) { skipped.push({ url: next.url, reason: `Access denied (${res.status}); not bypassed` }); if (pages.length === 0) throw new Error(`The site refused access (${res.status}). Add the business details manually instead.`); continue; }
    if (res.status >= 400) { skipped.push({ url: next.url, reason: `HTTP ${res.status}` }); if (pages.length === 0) throw new Error(`The site returned an error (${res.status}).`); continue; }
    if (!/html|xml/i.test(res.type)) { skipped.push({ url: next.url, reason: "Not an HTML page" }); continue; }

    const html = res.body.toString("utf8");
    const $ = cheerio.load(html);
    const base = new URL(res.url);
    const meta = (n: string) => $(`meta[property="${n}"]`).attr("content") || $(`meta[name="${n}"]`).attr("content") || "";
    const abs = (s?: string) => { try { return s ? new URL(s, base).href : null; } catch { return null; } };

    if (pages.length === 0) {
      signals.siteName = meta("og:site_name") || "";
      const theme = meta("theme-color"); if (theme) countColours(`${theme} ${theme} ${theme}`, colours);
      $("style").each((_, el) => { const t = $(el).text(); countColours(t, colours); countFonts(t, fonts); });
      $('link[href*="fonts.googleapis.com"]').each((_, el) => {
        for (const m of ($(el).attr("href") || "").matchAll(/family=([^&:]+)/g)) {
          const f = decodeURIComponent(m[1]).replace(/\+/g, " "); fonts.set(f, (fonts.get(f) || 0) + 20);
        }
      });
      const sheets = $('link[rel~="stylesheet"]').map((_, el) => abs($(el).attr("href"))).get().filter(Boolean).slice(0, 3) as string[];
      for (const s of sheets) {
        try { const r = await fetcher(s, { maxBytes: 1_500_000, accept: "text/css", userAgent: ua }); const css = r.body.toString("utf8"); countColours(css, colours); countFonts(css, fonts); } catch { /* ignore */ }
      }
      const logos = new Set<string>();
      $("header img, nav img, [role='banner'] img").each((_, el) => {
        const e = $(el); const hay = [e.attr("src"), e.attr("alt"), e.attr("class")].join(" ").toLowerCase();
        if (hay.includes("logo")) { const a = abs(e.attr("src")); if (a) logos.add(a); }
      });
      const icon = abs($('link[rel="apple-touch-icon"]').attr("href") || $('link[rel="icon"]').attr("href"));
      if (icon) logos.add(icon);
      const og = abs(meta("og:image")); if (og) signals.images.push(og);
      signals.logoCandidates = [...logos].slice(0, 5);
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).text());
          const items = Array.isArray(data) ? data : data["@graph"] || [data];
          for (const it of items) if (/Organization|LocalBusiness|Store|Restaurant|ProfessionalService/i.test(String(it["@type"]))) signals.structuredData.push(it);
        } catch { /* ignore */ }
      });
    }
    $("img").each((_, el) => {
      const e = $(el); const w = parseInt(e.attr("width") || "0", 10); if (w && w < 300) return;
      const src = abs((e.attr("srcset")?.split(",").pop()?.trim().split(/\s+/)[0]) || e.attr("src") || e.attr("data-src"));
      if (src && !/logo|icon|sprite|pixel|\.svg/i.test(src) && !signals.images.includes(src) && signals.images.length < 20) signals.images.push(src);
    });
    $("a[href]").each((_, el) => {
      const h = $(el).attr("href") || "";
      if (/(instagram\.com|linkedin\.com|facebook\.com|tiktok\.com|x\.com|twitter\.com|youtube\.com)\//i.test(h) && !signals.socialLinks.includes(h) && signals.socialLinks.length < 10) signals.socialLinks.push(h);
    });

    const { headings, text } = pageText($);
    const page: CrawledPage = { url: res.url, title: $("title").first().text().trim(), description: meta("description") || meta("og:description"), headings, text, depth: next.depth };
    pages.push(page);
    opts.onPage?.(page, pages.length);

    if (next.depth < maxDepth) {
      $("a[href]").each((_, el) => {
        const href = abs($(el).attr("href")); if (!href) return;
        let lu: URL; try { lu = new URL(href); } catch { return; }
        lu.hash = "";
        if (!sameSite(lu, start) || !/^https?:$/.test(lu.protocol) || SKIP.test(lu.pathname)) return;
        const key = lu.href; if (seen.has(key)) return;
        seen.add(key);
        let score = 10 - next.depth * 3;
        if (PRIORITY.test(lu.pathname)) score += 40;
        if (BLOG.test(lu.pathname)) { if (blogCount >= 3) return; blogCount++; score += 5; }
        if (lu.search) score -= 8;
        queue.push({ url: key, depth: next.depth + 1, score });
      });
    }
  }

  signals.colours = topN(colours, 12).map(([hex, count]) => ({ hex, count }));
  signals.fonts = topN(fonts, 5).map(([f]) => f);
  return { startUrl: start.href, pages, skipped, signals };
}
