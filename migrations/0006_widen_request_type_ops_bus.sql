-- Migration 0006: Widen requests.request_type CHECK for v1.2 ops-bus + lifecycle types,
-- and seed the matching capability tags IN THE SAME MIGRATION.
--
-- Adds eleven new types across two categories:
--   lifecycle (universal — community, fleet, company):
--     ack-close, abandon
--   ops-bus (fleet/company only — community nodes reject at app layer):
--     handoff, collision-warn, status-sync, delegate, blocker
--
-- NOTE ON ABANDON:
--   'abandon' is a lifecycle type introduced in this spec (fleet-coordination-v1),
--   not present in Robert Chuvala's PR #12. Added here because enum and tag seeding
--   must ship together (see incident note below), and 'abandon' mechanics ship here
--   as a type definition — the route and state transition come in Phase 4.
--
-- NOTE ON SOURCE:
--   Migration design (create-new → copy → drop-old → rename) taken from PR #12
--   (Robert Chuvala / NorthwoodsSentinel, feat/ops-bus-types-seeded). That PR's
--   migration comment explains why renaming the OLD table first is wrong: SQLite
--   rewrites FK clauses in referring tables (request_tags, claims, responses) to
--   point at the temporary name, leaving dangling references after the drop.
--   The order here — rename requests_new to requests — never renames a table
--   that other tables reference. Adopted unchanged except for the type list.
--
-- Application-layer validation in src/routes/requests.ts is authoritative;
-- the DB-level CHECK is kept as defense-in-depth.
--
-- WHY the tag seeding lives in this migration and not a separate one:
-- request creation requires at least one tag that exists in `capabilities`.
-- If the type enum is widened without the matching tags, agents can select a
-- new request_type but have no honest tag to attach. PR #12's incident note:
-- "in a production fleet deployment this locked an agent out of the bus for hours."
-- Enum and tag taxonomy must never drift; a single migration makes drift impossible.
--
-- SQLite doesn't support ALTER COLUMN or DROP CONSTRAINT, so the CHECK change
-- rebuilds the table.

PRAGMA foreign_keys = OFF;

-- 1. New table with widened CHECK. All other columns identical to the current
--    schema (0001 + the two v1.1 columns from 0002).
CREATE TABLE requests_new (
  id              TEXT PRIMARY KEY,
  requester_id    TEXT NOT NULL REFERENCES agents(id),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  request_type    TEXT NOT NULL CHECK(request_type IN (
                    -- eval-surface (v1.0):
                    'review', 'validation', 'second-opinion', 'council',
                    'fact-check', 'summarize', 'translate', 'debug',
                    -- ops-bus (fleet/company only — enforced at app layer, not DB):
                    'handoff', 'collision-warn', 'status-sync',
                    'delegate', 'blocker',
                    -- lifecycle (universal):
                    'ack-close', 'abandon'
                  )),
  priority        TEXT DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high')),
  status          TEXT DEFAULT 'open' CHECK(status IN ('open', 'claimed', 'responded', 'rated', 'closed', 'expired', 'cancelled')),
  max_responses   INTEGER DEFAULT 3,
  response_count  INTEGER DEFAULT 0,
  context         TEXT,
  expires_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  closed_at       TEXT,
  target_agent_id TEXT REFERENCES agents(id),
  scope_claim_json TEXT
);

-- 2. Copy every row verbatim.
INSERT INTO requests_new (id, requester_id, title, body, request_type, priority,
                          status, max_responses, response_count, context, expires_at,
                          created_at, updated_at, closed_at, target_agent_id, scope_claim_json)
  SELECT id, requester_id, title, body, request_type, priority,
         status, max_responses, response_count, context, expires_at,
         created_at, updated_at, closed_at, target_agent_id, scope_claim_json
  FROM requests;

-- 3. Drop the old table, then take its name. No other table is ever renamed,
--    so no FK clause in request_tags/claims/responses is rewritten.
DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;

-- 4. Rebuild the indexes that lived on the original requests table
--    (0001: requester/status/created/expires; 0002: target).
CREATE INDEX idx_requests_requester ON requests(requester_id);
CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_created ON requests(created_at DESC);
CREATE INDEX idx_requests_expires ON requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_requests_target ON requests(target_agent_id);

PRAGMA foreign_keys = ON;

-- 5. Seed capability tags for all new types — same migration, on purpose (see
--    header). OR IGNORE keeps this idempotent against the unique tag index.
--    Two categories:
--      'lifecycle' — universal, no mode gate
--      'ops-bus'   — fleet/company only, enforced at application layer
INSERT OR IGNORE INTO capabilities (tag, category, description, created_at) VALUES
  -- lifecycle
  ('ack-close',      'lifecycle', 'Lifecycle: acknowledge and wrap up a coordination thread',          datetime('now')),
  ('abandon',        'lifecycle', 'Lifecycle: abandon a request this agent owns (cannot proceed)',     datetime('now')),
  -- ops-bus (fleet/company only)
  ('handoff',        'ops-bus',   'Ops-bus: hand work and its context to another agent',              datetime('now')),
  ('collision-warn', 'ops-bus',   'Ops-bus: warn that two agents are live in the same substrate',     datetime('now')),
  ('status-sync',    'ops-bus',   'Ops-bus: broadcast a state update, no action needed',              datetime('now')),
  ('delegate',       'ops-bus',   'Ops-bus: assign a task to another agent and track it',             datetime('now')),
  ('blocker',        'ops-bus',   'Ops-bus: signal that work is blocked pending another agent',       datetime('now'));
