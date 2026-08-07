-- Rollback for migration 0009: lifecycle mechanics.
--
-- Reverses:
--   1. requests.status CHECK: removes 'ack-closed' (requires rebuild)
--   2. ratings: restores NOT NULL score, drops cross_owner + source_type (rebuild)
--   3. requests.outcome_json: dropped before rebuild (ALTER TABLE DROP COLUMN)
--
-- PRECONDITION: no rows in requests with status='ack-closed'.
-- Run:  SELECT COUNT(*) FROM requests WHERE status='ack-closed';
-- Must be 0 before applying this rollback. ack-closed rows have no valid status
-- in the 0008 schema — they would violate the CHECK constraint on restore.
--
-- Same D1-compatible pattern: backup → drop → rebuild → restore.

-- Phase A: remove additive outcome_json first (can DROP COLUMN here)
ALTER TABLE requests DROP COLUMN outcome_json;

-- Phase B: Backup dependent tables
CREATE TABLE ratings_bkp       AS SELECT * FROM ratings;
CREATE TABLE request_tags_bkp  AS SELECT * FROM request_tags;
CREATE TABLE responses_bkp     AS SELECT * FROM responses;
CREATE TABLE claims_bkp        AS SELECT * FROM claims;

-- Phase C: Drop in FK-safe order
DROP TABLE ratings;
DROP TABLE request_tags;
DROP TABLE responses;
DROP TABLE claims;

-- Phase D: Rebuild requests — remove 'ack-closed' from status CHECK
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
                     'closed', 'expired', 'cancelled'
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

INSERT INTO requests_new SELECT
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

-- Phase E: Recreate dependent tables (0008 schemas)
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
CREATE UNIQUE INDEX idx_claims_request_agent_active ON claims(request_id, agent_id) WHERE status = 'active';
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

-- Restore pre-0009 ratings schema (score NOT NULL, no cross_owner, no source_type)
CREATE TABLE ratings (
  id          TEXT    PRIMARY KEY,
  response_id TEXT    NOT NULL REFERENCES responses(id),
  rater_id    TEXT    NOT NULL REFERENCES agents(id),
  direction   TEXT    NOT NULL CHECK(direction IN ('requester_rates_helper', 'helper_rates_requester')),
  score       INTEGER NOT NULL CHECK(score >= 1 AND score <= 5),
  feedback    TEXT,
  created_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_ratings_response_rater_dir ON ratings(response_id, rater_id, direction);
CREATE INDEX idx_ratings_rater     ON ratings(rater_id);
CREATE INDEX idx_ratings_direction ON ratings(direction);

-- Phase F: Restore
INSERT INTO claims SELECT * FROM claims_bkp;
INSERT INTO responses SELECT * FROM responses_bkp;
INSERT INTO request_tags SELECT * FROM request_tags_bkp;
-- Restore only ratings with non-null scores (NULL scores did not exist pre-0009)
INSERT INTO ratings (id, response_id, rater_id, direction, score, feedback, created_at)
SELECT id, response_id, rater_id, direction, score, feedback, created_at
FROM ratings_bkp
WHERE score IS NOT NULL;

-- Phase G: Drop backups
DROP TABLE ratings_bkp;
DROP TABLE request_tags_bkp;
DROP TABLE responses_bkp;
DROP TABLE claims_bkp;
