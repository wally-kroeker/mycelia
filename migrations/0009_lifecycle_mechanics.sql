-- Migration 0009: Lifecycle mechanics — ack-closed status, outcome_json,
-- ratings cross_owner + source_type + nullable score.
--
-- Phase 4 of fleet-coordination-v1.
--
-- Changes in this migration:
--   1. requests.status CHECK: add 'ack-closed' (requires table rebuild)
--   2. ratings: score NULLABLE, add cross_owner INTEGER (0/1), source_type TEXT (rebuild)
--   3. requests.outcome_json: additive TEXT column (ALTER TABLE ADD COLUMN after rebuild)
--
-- D1 pattern: no PRAGMA (does not persist across statement boundaries).
-- Backup dependents → drop in FK-safe order → rebuild → restore.
-- See 0006 for prior art on this pattern and why PRAGMA fails.
--
-- FK dependency graph for this migration:
--   ratings        → responses(id)      ← ratings has no inbound FKs
--   request_tags   → requests(id)
--   responses      → requests(id), claims(id), responses(id)
--   claims         → requests(id), agents(id)
--   requests       → agents(id)
--
-- agents is NOT touched — it is the one table where loss is unrecoverable.
-- agents export taken at session start: /tmp/agents-backup-2026-08-07.sql

-- ─── Phase A: Backup all FK-dependent tables ─────────────────────────────────
CREATE TABLE ratings_bkp       AS SELECT * FROM ratings;
CREATE TABLE request_tags_bkp  AS SELECT * FROM request_tags;
CREATE TABLE responses_bkp     AS SELECT * FROM responses;
CREATE TABLE claims_bkp        AS SELECT * FROM claims;

-- ─── Phase B: Drop in FK-safe order ─────────────────────────────────────────
-- ratings first (FK to responses, no inbound FKs)
DROP TABLE ratings;
-- request_tags (FK to requests + capabilities, no inbound FKs)
DROP TABLE request_tags;
-- responses (FK to requests + claims + agents, no inbound FKs after ratings gone)
DROP TABLE responses;
-- claims (FK to requests + agents, no inbound FKs after responses gone)
DROP TABLE claims;
-- requests now has zero inbound FK references from the above tables

-- ─── Phase C: Rebuild requests — add 'ack-closed' to status CHECK ────────────
CREATE TABLE requests_new (
  id               TEXT PRIMARY KEY,
  requester_id     TEXT NOT NULL REFERENCES agents(id),
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  request_type     TEXT NOT NULL CHECK(request_type IN (
                     'review', 'validation', 'second-opinion', 'council',
                     'fact-check', 'summarize', 'translate', 'debug',
                     'handoff', 'collision-warn', 'status-sync',
                     'delegate', 'blocker',
                     'ack-close', 'abandon'
                   )),
  priority         TEXT DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high')),
  status           TEXT DEFAULT 'open' CHECK(status IN (
                     'open', 'claimed', 'responded', 'rated',
                     'closed', 'expired', 'cancelled',
                     'ack-closed'
                   )),
  max_responses    INTEGER DEFAULT 3,
  response_count   INTEGER DEFAULT 0,
  context          TEXT,
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  closed_at        TEXT,
  target_agent_id  TEXT REFERENCES agents(id),
  scope_claim_json TEXT,
  references_json  TEXT,
  supersedes       TEXT,
  artifacts_json   TEXT,
  action_required  TEXT CHECK(action_required IS NULL OR action_required IN ('fyi', 'act')),
  blocking         TEXT
);

INSERT INTO requests_new (
  id, requester_id, title, body, request_type, priority, status,
  max_responses, response_count, context, expires_at, created_at, updated_at,
  closed_at, target_agent_id, scope_claim_json,
  references_json, supersedes, artifacts_json, action_required, blocking
) SELECT
  id, requester_id, title, body, request_type, priority, status,
  max_responses, response_count, context, expires_at, created_at, updated_at,
  closed_at, target_agent_id, scope_claim_json,
  references_json, supersedes, artifacts_json, action_required, blocking
FROM requests;

DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;

CREATE INDEX idx_requests_requester ON requests(requester_id);
CREATE INDEX idx_requests_status    ON requests(status);
CREATE INDEX idx_requests_created   ON requests(created_at DESC);
CREATE INDEX idx_requests_expires   ON requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_requests_target ON requests(target_agent_id);

-- ─── Phase D: Recreate dependent tables (exact live schemas) ─────────────────

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

CREATE UNIQUE INDEX idx_claims_request_agent_active
  ON claims(request_id, agent_id) WHERE status = 'active';
CREATE INDEX idx_claims_agent   ON claims(agent_id);
CREATE INDEX idx_claims_expires ON claims(expires_at);

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

CREATE INDEX idx_responses_request   ON responses(request_id);
CREATE INDEX idx_responses_responder ON responses(responder_id);
CREATE INDEX idx_responses_parent    ON responses(parent_response_id);

CREATE TABLE request_tags (
  request_id    TEXT    NOT NULL REFERENCES requests(id),
  capability_id INTEGER NOT NULL REFERENCES capabilities(id),
  PRIMARY KEY (request_id, capability_id)
);

CREATE INDEX idx_rt_capability ON request_tags(capability_id);

-- ─── Phase E: New ratings schema — nullable score, cross_owner, source_type ──
--
-- cross_owner INTEGER NOT NULL DEFAULT 1:
--   1 = rater and rated agent have different owner_id (cross-owner, feeds trust)
--   0 = same owner_id (same-fleet, excluded from community trust aggregation)
--   Computed from DB join at insert time — never from AuthContext, which only
--   carries the requesting agent's owner_id, not both sides.
--   Default 1 for all pre-existing rows (existing route blocks same-owner inserts).
--
-- source_type TEXT NOT NULL DEFAULT 'standard':
--   'standard' = normal POST /v1/responses/:id/ratings
--   'ack-close' = auto-created by POST /v1/requests/:id/ack-close
--
-- score INTEGER (nullable):
--   Present (1-5) when rater supplies quality.
--   NULL when ack-close is performed without a quality score.
--   A deliberate 3 is NOT the same as NULL — NULL means "acknowledged, unscored".
--   Trust aggregation filters: WHERE cross_owner = 1 AND score IS NOT NULL.

CREATE TABLE ratings (
  id           TEXT    PRIMARY KEY,
  response_id  TEXT    NOT NULL REFERENCES responses(id),
  rater_id     TEXT    NOT NULL REFERENCES agents(id),
  direction    TEXT    NOT NULL CHECK(direction IN ('requester_rates_helper', 'helper_rates_requester')),
  score        INTEGER CHECK(score IS NULL OR (score >= 1 AND score <= 5)),
  feedback     TEXT,
  created_at   TEXT    NOT NULL,
  cross_owner  INTEGER NOT NULL DEFAULT 1 CHECK(cross_owner IN (0, 1)),
  source_type  TEXT    NOT NULL DEFAULT 'standard' CHECK(source_type IN ('standard', 'ack-close'))
);

CREATE UNIQUE INDEX idx_ratings_response_rater_dir ON ratings(response_id, rater_id, direction);
CREATE INDEX idx_ratings_rater       ON ratings(rater_id);
CREATE INDEX idx_ratings_direction   ON ratings(direction);
CREATE INDEX idx_ratings_cross_owner ON ratings(cross_owner) WHERE cross_owner = 1;

-- ─── Phase F: Restore data ────────────────────────────────────────────────────

INSERT INTO claims (
  id, request_id, agent_id, status, estimated_minutes, note,
  claimed_at, expires_at, completed_at
) SELECT
  id, request_id, agent_id, status, estimated_minutes, note,
  claimed_at, expires_at, completed_at
FROM claims_bkp;

INSERT INTO responses (
  id, request_id, responder_id, claim_id, parent_response_id,
  body, confidence, created_at, body_tier
) SELECT
  id, request_id, responder_id, claim_id, parent_response_id,
  body, confidence, created_at, body_tier
FROM responses_bkp;

INSERT INTO request_tags (request_id, capability_id)
SELECT request_id, capability_id FROM request_tags_bkp;

-- Restore ratings — backfill cross_owner=1 (all pre-existing ratings are cross-owner;
-- the route blocked same-owner inserts), source_type='standard'.
INSERT INTO ratings (
  id, response_id, rater_id, direction, score, feedback, created_at,
  cross_owner, source_type
) SELECT
  id, response_id, rater_id, direction, score, feedback, created_at,
  1, 'standard'
FROM ratings_bkp;

-- ─── Phase G: Drop backups ────────────────────────────────────────────────────
DROP TABLE ratings_bkp;
DROP TABLE request_tags_bkp;
DROP TABLE responses_bkp;
DROP TABLE claims_bkp;

-- ─── Phase H: outcome_json — additive after rebuild ───────────────────────────
-- JSON blob written on ack-close: { summary, quality, closed_by, closed_at }.
-- NULL until ack-close is performed.
ALTER TABLE requests ADD COLUMN outcome_json TEXT;
