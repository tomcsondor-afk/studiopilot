import { openDb, setDb, DB } from "../src/db.js";
import { setAIAdapter, AIAdapter, ConceptDraft } from "../src/ai/adapter.js";
import { claim, runJob } from "../src/jobs.js";
import { createUserWithWorkspace } from "../src/auth.js";
import "../src/services/brands.js";
import "../src/services/content.js";
import { setCrawlOptionsForTests } from "../src/services/brands.js";
import type { Fetcher } from "../src/ssrf.js";

export function freshDb(): DB {
  const db = openDb(":memory:");
  setDb(db);
  return db;
}

export function makeUser(db: DB, name: string) {
  return createUserWithWorkspace(db, { email: `${name}@example.test`, name, password: "correct-horse-battery", workspaceName: `${name} Co` });
}

/** Drain the queue synchronously, the way the worker would. */
export async function drain(db: DB, max = 200) {
  for (let i = 0; i < max; i++) {
    const job = claim(db, "test-worker");
    if (!job) return i;
    await runJob(db, job, "test-worker");
  }
  throw new Error("queue did not drain");
}

export const SITE: Record<string, string> = {
  "https://acme-plumbing.example/robots.txt": "User-agent: *\nDisallow: /private\n",
  "https://acme-plumbing.example/": `<html><head><title>Acme Plumbing | Leeds</title><meta name="description" content="Emergency plumbers in Leeds."><style>body{color:#1a1a1a;background:#ffffff}.btn{background:#0b6e4f}.x{color:#0b6e4f}</style></head>
    <body><header><img src="/logo.png" alt="Acme logo"></header><main><h1>Plumbers you can reach at 2am</h1>
    <p>Acme Plumbing has served Leeds households since 2009 with emergency and planned plumbing work.</p>
    <p>Boiler servicing starts from £79 including VAT for standard combi boilers.</p>
    <a href="/about">About us</a> <a href="/services">Services</a> <a href="/private/admin">Admin</a> <a href="https://elsewhere.example/">Partner</a></main></body></html>`,
  "https://acme-plumbing.example/about": `<html><head><title>About Acme</title></head><body><main><h1>About</h1><p>We are a family team of five Gas Safe registered engineers based in Headingley.</p></main></body></html>`,
  "https://acme-plumbing.example/services": `<html><head><title>Services</title></head><body><main><h1>Services</h1><p>We fix leaks, install bathrooms and service boilers across Leeds.</p></main></body></html>`,
  "https://acme-plumbing.example/private/admin": `<html><body>secret</body></html>`
};

export const fakeFetcher = (site = SITE): Fetcher => async (url) => {
  const key = url.replace(/\/$/, "") === "https://acme-plumbing.example" ? "https://acme-plumbing.example/" : url;
  const body = site[key];
  if (body === undefined) return { url, status: 404, type: "text/html", body: Buffer.from("not found"), truncated: false };
  return { url, status: 200, type: url.endsWith(".txt") ? "text/plain" : "text/html; charset=utf-8", body: Buffer.from(body), truncated: false };
};

export function useFakeCrawl() { setCrawlOptionsForTests({ fetcher: fakeFetcher(), delayMs: 0 }); }

export function draft(i: number, over: Partial<ConceptDraft> = {}): ConceptDraft {
  return {
    title: `Idea number ${i} about ${["leaks", "boilers", "bathrooms", "radiators", "taps", "pipes", "valves"][i % 7]} ${i}`,
    objective: "Educate", pillar: "Useful advice", audience: "Homeowners", cta: "Call us", destinationUrl: "", creativeBrief: "Own photo of an engineer at work",
    altText: "Engineer fixing a pipe", suggestedSlot: "Tue 09:30", sourceClaimIds: [],
    variants: {
      linkedin: { caption: `LinkedIn post ${i}: practical guidance for landlords number ${i}.`, hashtags: [] },
      facebook: { caption: `Facebook chat ${i}: have you checked your stopcock lately?`, hashtags: [] },
      instagram: { caption: `Instagram ${i}: a quick tip for your home.`, hashtags: ["#leeds", "#plumbing"] }
    },
    ...over
  };
}

export class FakeAI implements AIAdapter {
  calls = { extract: 0, generate: 0, refine: 0 };
  failBatches = new Set<number>();
  counter = 0;
  async extractBrand() {
    this.calls.extract++;
    return {
      name: "Acme Plumbing", description: "Family plumbing team in Leeds.", industry: "Plumbing", location: "Leeds",
      services: ["Emergency plumbing", "Boiler servicing"], products: [], audiences: ["Leeds homeowners"], valueProps: ["Available at 2am"], ctas: ["Call now"],
      tone: { summary: "Plain and reassuring", formality: 2, warmth: 4, humour: 2, emoji: "none" as const },
      links: [{ label: "About", url: "https://acme-plumbing.example/about" }, { label: "Elsewhere", url: "https://evil.example/" }],
      claims: [
        { kind: "fact" as const, text: "Serving Leeds since 2009", sourceUrl: "https://acme-plumbing.example/", excerpt: "has served Leeds households since 2009" },
        { kind: "price" as const, text: "Boiler servicing from £79", sourceUrl: "https://acme-plumbing.example/", excerpt: "Boiler servicing starts from £79 including VAT" },
        { kind: "qualification" as const, text: "Gas Safe registered", sourceUrl: "https://acme-plumbing.example/about", excerpt: "five Gas Safe registered engineers" },
        { kind: "award" as const, text: "Best plumber in Yorkshire 2023", sourceUrl: "https://acme-plumbing.example/", excerpt: "Voted best plumber in Yorkshire 2023" }
      ],
      suggestions: { contentPillars: ["Home maintenance tips", "Meet the team"], prohibitedTopics: ["Competitor criticism"], palette: { background: "#ffffff", text: "#1a1a1a", accent: "#0b6e4f" } }
    };
  }
  async generateConcepts(input: { count: number; batchIndex: number }) {
    this.calls.generate++;
    if (this.failBatches.has(input.batchIndex)) throw Object.assign(new Error(`AI provider error on batch ${input.batchIndex}`), { permanent: true });
    return Array.from({ length: input.count }, () => draft(this.counter++));
  }
  async refineConcept(input: { concept: ConceptDraft; instruction: string }) {
    this.calls.refine++;
    return { ...input.concept, variants: { ...input.concept.variants, linkedin: { ...input.concept.variants.linkedin, caption: input.concept.variants.linkedin.caption + " (warmer)" } } };
  }
}

export function useFakeAI() { const f = new FakeAI(); setAIAdapter(f); return f; }
