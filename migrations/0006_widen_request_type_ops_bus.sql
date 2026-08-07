-- Migration 0006: Widen requests.request_type CHECK for v1.2 ops-bus + lifecycle types,
-- and seed the matching capability tags IN THE SAME MIGRATION.
--
-- Adds seven new types across two categories:
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
--   Migration design taken from PR #12 (Robert Chuvala / NorthwoodsSentinel,
--   feat/ops-bus-types-seeded). Robert's original migration used PRAGMA
--   foreign_keys = OFF which works in local SQLite but does NOT persist across
--   statement boundaries in D1's remote execution model. When applied to a live
--   DB with FK-referencing rows in claims/responses/ratings, DROP TABLE requests
--   fails with FOREIGN KEY constraint even with the PRAGMA preceding it.
--
--   Fix: save FK-dependent table data into backup tables first, drop in correct
--   dependency order (ratings → request_tags → responses → claims → requests),
--   rebuild requests with the widened CHECK, then recreate and restore the
--   dependent tables in the same order. This requires no PRAGMA and works in D1.
--
--   Why this order?
--   - ratings REFERENCES responses — drop ratings before responses
--   - request_tags REFERENCES requests — drop before requests
--   - responses REFERENCES requests, claims — drop before claims
--   - claims REFERENCES requests — drop before requests
--   After all four are dropped, requests has no inbound FK references and drops cleanly.
--
-- NOTE ON FK REWRITE (from Robert's original comment, still applies here):
--   The seemingly natural approach of renaming the existing requests table to a
--   temp name FIRST fails in SQLite because SQLite rewrites the FK clauses in
--   claims/responses/request_tags to point at the temp name. When you later drop
--   the temp name, those FK clauses become dangling references.
--   The order here — rename requests_new TO requests at the end — never renames
--   a table that other tables reference, so no FK clause is rewritten.
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
-- requires rebuilding the table. Dependent tables must be rebuilt with it.

-- ─── PHASE A: Save live data ─────────────────────────────────────────────────
-- CREATE TABLE ... AS SELECT captures all columns including those added by prior
-- ALTER TABLE ADD COLUMN statements (e.g. body_tier from 0005, target_agent_id
-- and scope_claim_json from 0002). No FK constraints are copied, so the backup
-- tables can be dropped without touching referencing tables.

CREATE TABLE ratings_bkp       AS SELECT * FROM ratings;
CREATE TABLE request_tags_bkp  AS SELECT * FROM request_tags;
CREATE TABLE responses_bkp     AS SELECT * FROM responses;
CREATE TABLE claims_bkp        AS SELECT * FROM claims;

-- ─── PHASE B: Drop in FK-safe order ──────────────────────────────────────────
-- Each table is dropped only after all tables that reference it are already gone.
-- No PRAGMA is required because at each drop step, nothing inbound points at the
-- table being dropped.
--
--   ratings        → references responses, agents (nothing references ratings)
--   request_tags   → references requests, capabilities (nothing left references it)
--   responses      → references requests, agents, claims, self (ratings gone)
--   claims         → references requests, agents (responses gone)
--   requests       → now has zero inbound FK references; drops cleanly

DROP TABLE ratings;
DROP TABLE request_tags;
DROP TABLE responses;
DROP TABLE claims;

-- ─── PHASE C: Rebuild requests with widened CHECK ────────────────────────────

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

INSERT INTO requests_new (id, requester_id, title, body, request_type, priority,
                          status, max_responses, response_count, context, expires_at,
                          created_at, updated_at, closed_at, target_agent_id, scope_claim_json)
  SELECT id, requester_id, title, body, request_type, priority,
         status, max_responses, response_count, context, expires_at,
         created_at, updated_at, closed_at, target_agent_id, scope_claim_json
  FROM requests;

DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;

CREATE INDEX idx_requests_requester ON requests(requester_id);
CREATE INDEX idx_requests_status    ON requests(status);
CREATE INDEX idx_requests_created   ON requests(created_at DESC);
CREATE INDEX idx_requests_expires   ON requests(expires_at);
CREATE INDEX idx_requests_target    ON requests(target_agent_id);

-- ─── PHASE D: Recreate dependent tables (exact schema as read from live) ─────

CREATE TABLE claims (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL REFERENCES requests(id),
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  status            TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'abandoned', 'expired')),
  estimated_minutes INTEGER DEFAULT 60,
  note              TEXT,
  claimed_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  completed_at      TEXT
);

CREATE INDEX        idx_claims_agent              ON claims(agent_id);
CREATE INDEX        idx_claims_expires            ON claims(expires_at);
CREATE UNIQUE INDEX idx_claims_request_agent_active ON claims(request_id, agent_id) WHERE status = 'active';

CREATE TABLE responses (
  id                 TEXT PRIMARY KEY,
  request_id         TEXT NOT NULL REFERENCES requests(id),
  responder_id       TEXT NOT NULL REFERENCES agents(id),
  claim_id           TEXT REFERENCES claims(id),
  parent_response_id TEXT REFERENCES responses(id),
  body               TEXT NOT NULL,
  confidence         REAL,
  created_at         TEXT NOT NULL,
  body_tier          TEXT
);

CREATE INDEX idx_responses_parent    ON responses(parent_response_id);
CREATE INDEX idx_responses_request   ON responses(request_id);
CREATE INDEX idx_responses_responder ON responses(responder_id);

CREATE TABLE request_tags (
  request_id    TEXT    NOT NULL REFERENCES requests(id),
  capability_id INTEGER NOT NULL REFERENCES capabilities(id),
  PRIMARY KEY (request_id, capability_id)
);

CREATE INDEX idx_rt_capability ON request_tags(capability_id);

CREATE TABLE ratings (
  id          TEXT    PRIMARY KEY,
  response_id TEXT    NOT NULL REFERENCES responses(id),
  rater_id    TEXT    NOT NULL REFERENCES agents(id),
  direction   TEXT    NOT NULL CHECK(direction IN ('requester_rates_helper', 'helper_rates_requester')),
  score       INTEGER NOT NULL CHECK(score >= 1 AND score <= 5),
  feedback    TEXT,
  created_at  TEXT    NOT NULL
);

CREATE INDEX        idx_ratings_direction         ON ratings(direction);
CREATE INDEX        idx_ratings_rater             ON ratings(rater_id);
CREATE UNIQUE INDEX idx_ratings_response_rater_dir ON ratings(response_id, rater_id, direction);

-- ─── PHASE E: Restore live data ──────────────────────────────────────────────
-- Explicit column lists guard against column-order differences between the backup
-- (AS SELECT *) and the recreated table.

INSERT INTO claims (id, request_id, agent_id, status, estimated_minutes, note,
                    claimed_at, expires_at, completed_at)
  SELECT id, request_id, agent_id, status, estimated_minutes, note,
         claimed_at, expires_at, completed_at
  FROM claims_bkp;

INSERT INTO responses (id, request_id, responder_id, claim_id, parent_response_id,
                       body, confidence, created_at, body_tier)
  SELECT id, request_id, responder_id, claim_id, parent_response_id,
         body, confidence, created_at, body_tier
  FROM responses_bkp;

INSERT INTO request_tags (request_id, capability_id)
  SELECT request_id, capability_id
  FROM request_tags_bkp;

INSERT INTO ratings (id, response_id, rater_id, direction, score, feedback, created_at)
  SELECT id, response_id, rater_id, direction, score, feedback, created_at
  FROM ratings_bkp;

-- ─── PHASE F: Drop backups ────────────────────────────────────────────────────

DROP TABLE ratings_bkp;
DROP TABLE request_tags_bkp;
DROP TABLE responses_bkp;
DROP TABLE claims_bkp;

-- ─── PHASE G: Seed capability tags ───────────────────────────────────────────
-- OR IGNORE: idempotent against the unique tag index.

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
