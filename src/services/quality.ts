/**
 * Channel capability notes for the first release. Limits are the publicly documented caption
 * limits at the time of writing; re-verify against each provider's current docs before publishing
 * is enabled (milestone 3), because providers change them.
 */
export const CHANNELS = {
  linkedin: { label: "LinkedIn", captionMax: 3000, hashtagSoftMax: 5 },
  facebook: { label: "Facebook", captionMax: 63206, hashtagSoftMax: 3 },
  instagram: { label: "Instagram", captionMax: 2200, hashtagHardMax: 30, hashtagSoftMax: 15 }
} as const;
export type Channel = keyof typeof CHANNELS;
export const CHANNEL_LIST = Object.keys(CHANNELS) as Channel[];

export interface QualityFlag { code: string; severity: "block" | "warn"; message: string }

const FILLER = ["in today's fast-paced world", "look no further", "game-changer", "game changer", "unlock the power", "elevate your", "we're thrilled", "we are thrilled",
  "take it to the next level", "revolutionise", "revolutionize", "synergy", "best-kept secret", "one-stop shop", "without further ado"];
const OFFER_WORDS = /(\d+\s?% off|\bdiscount\b|\bsale\b|\bfree (?:delivery|shipping|trial|consultation)\b|\blimited[- ]time\b|\boffer ends\b|\btoday only\b|\bpromo code\b|\bvoucher\b)/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%£$€.\s]/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => new Set(norm(s).split(" ").filter(w => w.length > 2));
export function similarity(a: string, b: string) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
export const hookOf = (caption: string) => caption.split(/[.!?\n]/)[0].split(/\s+/).slice(0, 8).join(" ");

function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export interface QualityInput {
  channel: Channel;
  caption: string;
  hashtags: string[];
  destinationUrl: string;
  brandName: string;
  evidenceText: string;           // confirmed claims + confirmed profile text
  hasConfirmedOffer: boolean;
  hasConfirmedTestimonial: boolean;
  knownUrls: string[];
  otherHooks: string[];
}

export function checkVariant(q: QualityInput): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const cap = q.caption;
  const ch = CHANNELS[q.channel];
  if (cap.length > ch.captionMax) flags.push({ code: "too_long", severity: "block", message: `${ch.label} captions can be at most ${ch.captionMax} characters (this is ${cap.length}).` });
  const maxTags = "hashtagHardMax" in ch ? ch.hashtagHardMax : Infinity;
  if (q.hashtags.length > maxTags) flags.push({ code: "hashtags_limit", severity: "block", message: `${ch.label} allows at most ${maxTags} hashtags.` });
  else if (q.hashtags.length > ch.hashtagSoftMax) flags.push({ code: "hashtags_excess", severity: "warn", message: `${q.hashtags.length} hashtags is a lot for ${ch.label}; ${ch.hashtagSoftMax} or fewer usually reads better.` });

  // Figures that aren't backed by verified evidence
  const evidence = norm(q.evidenceText);
  const figures = cap.match(/[£$€]\s?\d[\d,.]*|\d[\d,.]*\s?%|\b\d{2,}[\d,]*\+?\b/g) || [];
  const unsupported = [...new Set(figures)].filter(f => !evidence.includes(norm(f).replace(/\s/g, "")) && !evidence.includes(norm(f)));
  if (unsupported.length) flags.push({ code: "unsupported_figure", severity: "block", message: `Figures not found in verified claims: ${unsupported.join(", ")}. Confirm them in Brand or remove them.` });

  if (OFFER_WORDS.test(cap) && !q.hasConfirmedOffer) flags.push({ code: "unverified_offer", severity: "block", message: "Mentions an offer or discount, but no confirmed offer exists for this brand." });
  const quote = cap.match(/[“"]([^”"]{25,})[”"]/);
  if (quote && !q.hasConfirmedTestimonial) flags.push({ code: "unverified_quote", severity: "block", message: "Contains a quotation, but no confirmed testimonial exists for this brand." });
  if (/\[[^\]]{3,}\]/.test(cap)) flags.push({ code: "placeholder", severity: "block", message: "Contains a placeholder in square brackets that needs filling in." });

  const lc = cap.toLowerCase();
  const filler = FILLER.filter(f => lc.includes(f));
  if (filler.length) flags.push({ code: "filler", severity: "warn", message: `Generic phrasing: “${filler.join("”, “")}”.` });

  // Near-miss spellings of the brand name
  const bn = q.brandName.trim();
  if (bn.length >= 4) {
    const tokens = bn.split(/\s+/).length;
    const parts = cap.split(/\s+/);
    for (let i = 0; i + tokens <= parts.length; i++) {
      const cand = parts.slice(i, i + tokens).join(" ").replace(/[^\p{L}\p{N}&' ]/gu, "");
      if (cand && cand !== bn && cand.toLowerCase() !== bn.toLowerCase() && lev(cand.toLowerCase(), bn.toLowerCase()) <= Math.max(1, Math.floor(bn.length / 8))) {
        flags.push({ code: "brand_name", severity: "warn", message: `“${cand}” looks like a misspelling of ${bn}.` }); break;
      }
    }
  }

  if (q.destinationUrl) {
    let ok = true;
    try { const u = new URL(q.destinationUrl); ok = /^https?:$/.test(u.protocol); } catch { ok = false; }
    if (!ok) flags.push({ code: "bad_link", severity: "block", message: "The destination link isn't a valid web address." });
    else if (!q.knownUrls.some(k => k.replace(/\/$/, "") === q.destinationUrl.replace(/\/$/, "")))
      flags.push({ code: "unchecked_link", severity: "warn", message: "The destination link wasn't seen during research. Open it to check it works." });
  }

  const hook = hookOf(cap);
  if (q.otherHooks.some(h => similarity(h, hook) >= 0.6)) flags.push({ code: "repetitive_hook", severity: "warn", message: "Opens very similarly to another post for this brand." });
  return flags;
}

export function checkDuplicateIdea(title: string, others: string[]): QualityFlag | null {
  const hit = others.find(o => similarity(o, title) >= 0.6);
  return hit ? { code: "near_duplicate", severity: "warn", message: `Very similar idea to “${hit}”.` } : null;
}
