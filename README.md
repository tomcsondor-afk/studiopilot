# StudioPilot

A marketing workspace for businesses and agencies: enter a website, check a sourced brand profile, generate 50 post ideas with LinkedIn, Facebook and Instagram versions, then edit, refine and approve them.

This is **milestone 1 plus the core of milestone 2**. It isn't production-ready. See [STATUS.md](STATUS.md) for exactly what works, what was tested and what's still to build.

## Run it locally

Needs **Node.js 22.13 or newer**. Nothing else needs installing: the database is built into Node.

```bash
npm install
npm run seed:demo          # optional: demo login and a fictional bakery with sample posts
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Open http://localhost:3000.

Demo login: `demo@studiopilot.local` / `demo-password-123`. Switch to "Demo workspace" in the sidebar.

Without `ANTHROPIC_API_KEY`, the app still runs. Crawling, editing, approvals and the demo all work. The AI steps (brand analysis, generation, refining, briefs) say clearly that they need the key, and never fake a result.

Other commands:

| Command | What it does |
|---|---|
| `npm test` | Runs the test suite (33 tests, using a fake AI and a fake website; no network or key needed). |
| `npm run typecheck` | Checks the TypeScript types. |
| `npm run worker` | Runs the background worker as its own process. Use with `RUN_WORKER_IN_PROCESS=false`. |
| `npm run migrate` | Applies database migrations (also happens automatically on start). |

Settings are listed in `.env.example`.

## How it's built

| Part | Choice |
|---|---|
| Server | TypeScript on Express, run with `tsx` (no build step). |
| Database | SQLite through Node's built-in `node:sqlite`, with numbered SQL migrations in `migrations/`. |
| Background jobs | A `jobs` table with leases, idempotency keys and bounded retries. A crashed worker's jobs are picked up again when its lease expires. |
| Sign-in | Email and password (scrypt hashes). Session tokens are stored hashed and sent in an httpOnly, SameSite=Lax cookie. All writes must be JSON, which blocks cross-site form posts. |
| Front end | Plain JavaScript modules in `public/`, with no build step. All user and website text is inserted as text, never as HTML. |

Each part of the server has its own file:

| File | Responsibility |
|---|---|
| `src/ssrf.ts` | URL checks, plus connection-time blocking of private addresses so DNS tricks can't bypass the check. |
| `src/crawler.ts` | Follows robots.txt. Limits pages, depth, size and request rate, and stays on the same site. |
| `src/services/brands.ts` | The research job, sourced claims, competitors and brand edits with version checks. |
| `src/services/content.ts` | Generation in batches, edits, revisions, approvals, undo and bulk approval. |
| `src/services/quality.ts` | Deterministic quality checks. |
| `src/ai/adapter.ts` | The one place the AI is called. Every reply is validated, and website text is marked as untrusted data. |
| `src/access.ts` | Role checks on every request. Anything outside your workspace returns "not found". |

### Rules the code enforces

- **Facts.** Facts the AI pulls from a website are only accepted if the quoted excerpt appears word for word on the page it cites. Prices, offers, testimonials, qualifications, awards and statistics always need a person to confirm them. Unconfirmed facts are never given to the AI when it writes posts.
- **Approvals.** An approval is tied to one version of a post. Changing the copy, link, CTA, creative brief or alt text creates a new version and sends the post back for review. Changing the theme, audience or slot doesn't.
- **Wrong client.** Approving checks that the post belongs to the brand you're reviewing.

## Deploying

1. **Host.** Use any host that runs a long-lived Node 22 process with a persistent disk for `DATABASE_PATH`, such as a small VM, Fly.io with a volume, or Render with a disk.
2. **HTTPS.** Put it behind HTTPS and set `COOKIE_SECURE=true`.
3. **Worker.** Run the web process with `RUN_WORKER_IN_PROCESS=false`, and run `npm run worker` as a second process. Several workers can run at once, because claiming a job is atomic.
4. **Backups.** Back up the database file. SQLite runs in WAL mode, so use `sqlite3 data/studiopilot.db ".backup backup.db"` rather than copying the file while it's running.
5. **Before real customers use it:**
   - Move to PostgreSQL. The schema avoids SQLite-only features.
   - Switch to a managed sign-in provider, with email verification and password reset.
   - Add a shared rate limiter. The current one is per process.
   - Set up monitoring and log shipping.

## Setting up integrations

| Integration | Status | What to do |
|---|---|---|
| Anthropic (Claude) | Working | Create a key at console.anthropic.com and set `ANTHROPIC_API_KEY`. Change the model with `CLAUDE_MODEL`. Usage is billed to that Anthropic account. |
| LinkedIn, Facebook and Instagram publishing | Not built (milestone 3) | You'll need developer apps on LinkedIn and Meta. Each platform has to review and approve its publishing permissions before posts can go to real accounts. Check each platform's current documentation for the exact permissions and caption limits before building. The limits in `src/services/quality.ts` are marked for re-checking. |
| Meta ads, Shopify, WooCommerce, Google Merchant Center, billing and MCP | Not built (milestone 5) | Nothing to set up yet. |
