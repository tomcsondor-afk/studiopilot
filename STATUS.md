# Completion report: milestone 1 plus the core of milestone 2

**Not production-ready.** This hasn't been deployed or load-tested. It has never run with a real Anthropic key, and no publishing integrations exist yet.

## What works

### Accounts and workspaces
- Sign-up, sign-in and sign-out, with server-side sessions and a limit on repeated sign-in attempts.
- Organisations, separate client workspaces, and five roles (owner, admin, editor, approver, viewer). Roles are checked on the server for every request, and you can add or remove members.
- A labelled demo workspace with a fictional bakery and six sample posts. One of them is deliberately weak, so the quality checks have something to catch.

### Website research
- **Onboarding:** enter a website address, then watch real progress stages: reading pages, then analysing. Research runs on the server, so you can close the tab and it carries on. You can cancel it, retry it, or enter the details by hand instead.
- **Crawler:** follows robots.txt, stays on the same site, and caps pages, depth, response size and request rate. It never signs in to anything, and blocks private networks, localhost and cloud metadata addresses.
- **Brand profile:** every claim keeps its source page, capture date and the exact excerpt it came from. Each is labelled as found on the website, an AI suggestion (not found word for word), or added by your team. Sensitive kinds (prices, offers, testimonials and so on) wait for a person to confirm them.
- **Retries are cheap:** if the AI step fails, the crawled pages are kept, and a retry goes straight to the AI step.
- **Review screen:** you can edit everything in the profile, including the AI-suggested fields (marked as such):
  - business details, services, products, audiences and selling points
  - tone sliders and emoji preference
  - words to use and words to avoid
  - writing examples you like
  - hashtag and call-to-action rules
  - content themes, objectives and topics to avoid
  - colours and logo choice
  - adding, confirming, rejecting or correcting facts
- **Competitors:** you add the URLs. Their home page is read and shown as observed text, with no AI guesses about it. Two people editing at once are protected by version checks.

### Generating posts
- 50 post ideas, generated in 10 background batches of 5. Each idea has its own LinkedIn, Facebook and Instagram version.
- Results appear as each batch arrives. A failed batch keeps everything already made and can be resumed. You can cancel a run, and only one runs per workspace at a time.

### Quality checks
Posts are flagged automatically for:
- figures, offers or quotes that aren't backed by a confirmed fact
- leftover placeholders
- filler phrases
- near-misspellings of the brand name
- invalid links, or links that weren't seen during research
- too many hashtags, or captions over a channel's limit
- openings that repeat another post's, and near-duplicate ideas

Confirming a fact rechecks the existing posts. Blocking issues stop approval unless someone explicitly accepts them, and that acceptance is recorded.

### Reviewing posts
- **Card queue:** shows the brand, purpose, channel previews, facts used, suggested time slot and issues. You choose which channels to approve. Keyboard shortcuts are A to approve, S to skip, E to edit and the arrow keys to move. On a phone, swipe right to approve and left to skip.
- **Skip reasons:** optional when skipping a post.
- **Grid:** filter by status, theme, quality issues or search text. Bulk approval lists every selected post and channel before anything happens, then reports the result for each post.
- **Undo:** works for approve, skip and archive, for 10 minutes.
- **Approval history:** records who approved, when, which version and which channels. A material edit invalidates the approval and sends the post back for review.
- **Wrong-client guard:** an approval is refused if the post belongs to a different brand from the one you're reviewing.

### Content Studio
- Split screen: editable copy and details on one side, a platform preview with character counters on the other.
- Edits are saved against the version you opened, so a conflicting save is refused rather than overwriting someone else's.
- Plain-English refining (for example, "make this less salesy") creates a new version and records the instruction.
- Full version history with restore. Restoring creates a new version rather than deleting anything.
- Duplicate, archive and unarchive.

### Other
- **Create menu:** draft a post from a brief, research a new brand, or add a new client workspace.
- **Search:** finds posts in the current brand.
- **Activity:** a list of recent actions in the workspace.

## What was tested

There are 33 automated tests, all passing. They use a fake AI and a fake website, so they need no key or network.

| Risk | What the tests check |
|---|---|
| Cross-workspace access | Over HTTP: another account can't read, edit, approve, generate in, add members to or add brands to your workspace by changing IDs. Every attempt returns "not found". |
| Roles | Viewers can't edit or approve. Editors can't approve. Approvers can't edit. |
| Invalid source URLs | Localhost, metadata addresses, private IPs, non-standard ports, embedded passwords and non-web protocols are all rejected, and no job is queued. |
| Login security | Signed-out requests are refused, form posts are refused, sign-up input is validated and wrong passwords fail. |
| Crawler | Respects robots.txt and stays on the site. Correctly picks rules for a specific bot and the most specific matching path. Stops at the page limit. |
| Claim verification | Real excerpts are accepted. Made-up excerpts become "AI suggestion". Prices and qualifications always need confirming. |
| Failed AI jobs | Without a key, the crawled pages are kept and the error is clear. A retry reuses those pages. A failed batch leaves the run partly done and resumable. |
| Duplicate jobs | Re-running the same batch doesn't duplicate posts. The same job can't be queued twice. Only one worker can claim a job. |
| Crashed workers | A crashed worker's job is picked up again. If the old worker wakes up later, it can't overwrite the result. Retries back off and stop at a limit. |
| Cancellation | Cancelling a run stops any further batches. |
| Approvals and edits | Material edits invalidate approval; minor edits keep it. Out-of-date edits and approvals are refused. Wrong-brand approvals are refused. |
| Quality checks | Unresolved issues block approval, and accepting them is recorded. Confirming a fact clears the flag it caused. |
| Review actions | Undo works. Skip reasons are saved. Restoring an old version works. Refining records the instruction. Bulk approval reports each post separately. |
| Time zones | An invalid IANA time zone is rejected. |

On top of the automated tests, I ran a browser check in headless Chromium at desktop and phone sizes:
- sign-in
- keyboard approval
- the issues dialog, skip and undo
- grid bulk approval
- editing in the Studio (which sent an approved post back for review) and restoring an old version
- the Brand, Team, Calendar and Home pages
- the mobile menu
- the private-address error message
- a real crawl of github.com, which read the pages and then stopped with the "needs ANTHROPIC_API_KEY" message

## Not verified here
- **The real Anthropic API.** There was no key in the build environment. The prompts and response checks are written but have only been run against a fake.
- **Brand fonts.** The sandbox blocked Google Fonts, so pages fell back to system fonts.

## Needs external credentials or platform approval
- `ANTHROPIC_API_KEY`: needed for brand analysis, generation, refining and drafting from a brief.
- LinkedIn and Meta developer apps with approved permissions, for publishing (milestone 3).
- A Meta Marketing API app, for ads (milestone 5).
- Shopify, WooCommerce and Google Merchant Center credentials, plus a payment provider, for commerce and billing (milestone 5).

## Not built yet
These show as "Planned" in the app, with an explanation, and none of them pretend to work. The Studio's Schedule button is disabled and labelled.

**Milestone 2 (rest)**
- Asset library and uploads
- Image generation
- Crop and safe-zone previews
- Exports

**Milestone 3**
- Calendar, scheduling and the publishing worker
- Recording each platform's response after publishing (receipts)
- Checking whether a post went out before retrying, so nothing is published twice

**Milestone 4**
- Organic autopilot
- Advance email previews and notifications
- Analytics
- Comments and a client approval view
- Learning from your edits and rejections (with a way to inspect and reset what it learned)
- A monthly content plan view

**Milestone 5**
- Meta ads
- Product imports
- Billing and plan limits
- MCP server

**Infrastructure**
- PostgreSQL (currently SQLite)
- Managed sign-in
- Object storage
- Email invitations
- Data export and deletion
- AI cost tracking
- Shared rate limiting
