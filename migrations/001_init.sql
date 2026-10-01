-- StudioPilot schema v1: identity, tenancy, brand knowledge, jobs, content and approvals.
-- All timestamps are ISO-8601 UTC strings. IDs are UUIDs.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- SHA-256 of the session token; the raw token only lives in the cookie
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE organisations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','editor','approver','viewer')),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  website_url TEXT,
  description TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en-GB',
  currency TEXT NOT NULL DEFAULT 'GBP',
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  profile_json TEXT NOT NULL DEFAULT '{}',
  onboarding_status TEXT NOT NULL DEFAULT 'new' CHECK (onboarding_status IN ('new','researching','review','ready','failed')),
  confirmed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX brands_workspace ON brands(workspace_id);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page','manual','competitor')),
  text TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  captured_at TEXT NOT NULL,
  UNIQUE (brand_id, url)
);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('fact','service','product','price','offer','testimonial','qualification','statistic','award','location','other')),
  text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('extracted','suggested','user')),
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('needs_confirmation','confirmed','rejected')),
  decided_by TEXT REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX claims_brand ON claims(brand_id);

CREATE TABLE competitors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (brand_id, url)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  progress_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  locked_by TEXT,
  lease_expires_at TEXT,
  run_after TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX jobs_claim ON jobs(status, run_after);

CREATE TABLE generation_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  target_count INTEGER NOT NULL,
  batch_size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','completed','partial','failed','cancelled')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE concepts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES generation_runs(id) ON DELETE SET NULL,
  batch_index INTEGER,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  pillar TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  cta TEXT NOT NULL DEFAULT '',
  destination_url TEXT NOT NULL DEFAULT '',
  creative_brief TEXT NOT NULL DEFAULT '',
  alt_text TEXT NOT NULL DEFAULT '',
  suggested_slot TEXT NOT NULL DEFAULT '',
  source_claim_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('suggested','approved','skipped','archived')),
  skip_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai','person','demo')),
  quality_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX concepts_brand ON concepts(brand_id, status);
CREATE UNIQUE INDEX concepts_batch_slot ON concepts(run_id, batch_index, title) WHERE run_id IS NOT NULL;

CREATE TABLE variants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('linkedin','facebook','instagram')),
  caption TEXT NOT NULL,
  hashtags_json TEXT NOT NULL DEFAULT '[]',
  quality_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE (concept_id, channel)
);

CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('generated','edit','refine','restore','duplicate','demo')),
  instruction TEXT,
  author_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (concept_id, revision)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  channels_json TEXT NOT NULL,
  approved_by TEXT NOT NULL REFERENCES users(id),
  approved_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidated_reason TEXT
);
CREATE INDEX approvals_concept ON approvals(concept_id);

CREATE TABLE undo_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  previous_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_workspace ON audit_events(workspace_id, created_at);
