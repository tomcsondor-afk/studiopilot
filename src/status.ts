import { aiAvailable } from "./ai/adapter.js";

export type FeatureState = "working" | "requires_credentials" | "not_implemented";
export interface Feature { area: string; name: string; state: FeatureState; note: string; milestone: number }

export function featureStatus(): Feature[] {
  const ai = aiAvailable();
  const aiState: FeatureState = ai ? "working" : "requires_credentials";
  const aiNote = ai ? "" : "Set ANTHROPIC_API_KEY on the server.";
  return [
    { area: "Foundation", name: "Accounts, sessions and sign-in rate limiting", state: "working", note: "Local email and password. Swap for a managed auth provider before launch.", milestone: 1 },
    { area: "Foundation", name: "Organisations, client workspaces and roles", state: "working", note: "Owner, admin, editor, approver, viewer, enforced on the server for every request.", milestone: 1 },
    { area: "Foundation", name: "Durable background jobs", state: "working", note: "Leases, idempotency keys, bounded retries and crash recovery. Runs in-process or as a separate worker.", milestone: 1 },
    { area: "Foundation", name: "PostgreSQL", state: "not_implemented", note: "Currently SQLite with SQL migrations. The schema is portable; a Postgres driver is the next infrastructure step.", milestone: 1 },
    { area: "Research", name: "Website crawler", state: "working", note: "Respects robots.txt, page, depth, size and delay limits. Blocks private networks at connection time.", milestone: 1 },
    { area: "Research", name: "AI brand analysis with sourced claims", state: aiState, note: aiNote || "Every quoted excerpt is checked against the page it came from.", milestone: 1 },
    { area: "Research", name: "Manual brand details", state: "working", note: "For sites that can't be read.", milestone: 1 },
    { area: "Research", name: "Competitor pages", state: "working", note: "Reads the competitor URLs you add and shows what was observed. Automatic competitor discovery needs a search provider (not built).", milestone: 1 },
    { area: "Content", name: "Initial 50 concepts in batches of 5", state: aiState, note: aiNote || "Partial results appear as each batch lands; failed batches can be resumed.", milestone: 2 },
    { area: "Content", name: "Channel variants for LinkedIn, Facebook and Instagram", state: aiState, note: aiNote, milestone: 2 },
    { area: "Content", name: "Quality checks", state: "working", note: "Unverified figures, offers and quotes, placeholders, filler, hashtag limits, links, near-duplicates, brand spelling.", milestone: 2 },
    { area: "Content", name: "Review queue, grid, approve, skip, archive, undo, bulk approve", state: "working", note: "Approvals are tied to a revision; any material edit sends the post back for review.", milestone: 2 },
    { area: "Content", name: "Content Studio editing and version history", state: "working", note: "", milestone: 2 },
    { area: "Content", name: "Refine with plain-English instructions", state: aiState, note: aiNote, milestone: 2 },
    { area: "Content", name: "Create a post from a brief", state: aiState, note: aiNote, milestone: 2 },
    { area: "Content", name: "Asset library, uploads, crops and image generation", state: "not_implemented", note: "Needs object storage and an image provider.", milestone: 2 },
    { area: "Publishing", name: "Calendar, slots and drag-to-reschedule", state: "not_implemented", note: "", milestone: 3 },
    { area: "Publishing", name: "LinkedIn, Facebook and Instagram publishing", state: "not_implemented", note: "Needs provider developer apps, app review and OAuth credentials.", milestone: 3 },
    { area: "Automation", name: "Organic autopilot and advance email previews", state: "not_implemented", note: "", milestone: 4 },
    { area: "Automation", name: "Analytics from connected providers", state: "not_implemented", note: "", milestone: 4 },
    { area: "Ads", name: "Meta advertising", state: "not_implemented", note: "Needs a Meta app with Marketing API access.", milestone: 5 },
    { area: "Commerce", name: "Shopify, WooCommerce and Google Merchant Center imports", state: "not_implemented", note: "", milestone: 5 },
    { area: "Platform", name: "Billing and plan limits", state: "not_implemented", note: "", milestone: 5 },
    { area: "Platform", name: "MCP server for assistants", state: "not_implemented", note: "", milestone: 5 }
  ];
}
