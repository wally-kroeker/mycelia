-- Rollback for migration 0006: restore requests.request_type to original eight eval-surface types.
--
-- USE: Apply this before rolling back to pre-Phase-2 application code.
-- Apply in order: 0007_rollback.sql FIRST (drop coordination columns), then this file.
--
-- SAFE TO APPLY ONLY IF: all existing requests have a request_type in the original
-- eight values. Ops-bus and lifecycle rows will FAIL the recreated CHECK constraint.
-- Verify first:
--   SELECT DISTINCT request_type FROM requests
--     WHERE request_type NOT IN (
--       'review','validation','second-opinion','council',
--       'fact-check','summarize','translate','debug'
--     );
-- If that returns any rows, remove or retype them before rolling back.
--
-- NOTE: Uses the same D1-compatible pattern as 0006 forward migration — no PRAGMA
-- foreign_keys = OFF (it does not persist across statement boundaries in D1's
-- migration executor). Instead: backup dependents → drop in FK-safe order →
-- rebuild requests → recreate dependents → restore data → drop backups.

-- ─── PHASE A: Save live data ─────────────────────────────────────────────────

CREATE TABLE ratings_bkp       AS SELECT * FROM ratings;
CREATE TABLE request_tags_bkp  AS SELECT * FROM request_tags;
CREATE TABLE responses_bkp     AS SELECT * FROM responses;
CREATE TABLE claims_bkp        AS SELECT * FROM claims;

-- ─── PHASE B: Drop in FK-safe order ──────────────────────────────────────────

DROP TABLE ratings;
DROP TABLE request_tags;
DROP TABLE responses;
DROP TABLE claims;

-- ─── PHASE C: Rebuild requests with original eight-type CHECK ─────────────────

CREATE TABLE requests_old (
  id              TEXT PRIMARY KEY,
  requester_id    TEXT NOT NULL REFERENCES agents(id),
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  request_type    TEXT NOT NULL CHECK(request_type IN (
                    'review', 'validation', 'second-opinion', 'council',
                    'fact-check', 'summarize', 'translate', 'debug'
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

-- Will fail if any ops-bus/lifecycle rows exist — verify header before applying.
INSERT INTO requests_old (id, requester_id, title, body, request_type, priority,
                          status, max_responses, response_count, context, expires_at,
                          created_at, updated_at, closed_at, target_agent_id, scope_claim_json)
  SELECT id, requester_id, title, body, request_type, priority,
         status, max_responses, response_count, context, expires_at,
         created_at, updated_at, closed_at, target_agent_id, scope_claim_json
  FROM requests;

DROP TABLE requests;
ALTER TABLE requests_old RENAME TO requests;

CREATE INDEX idx_requests_requester ON requests(requester_id);
CREATE INDEX idx_requests_status    ON requests(status);
CREATE INDEX idx_requests_created   ON requests(created_at DESC);
CREATE INDEX idx_requests_expires   ON requests(expires_at);
CREATE INDEX idx_requests_target    ON requests(target_agent_id);

-- ─── PHASE D: Recreate dependent tables ──────────────────────────────────────

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

CREATE INDEX        idx_ratings_direction          ON ratings(direction);
CREATE INDEX        idx_ratings_rater              ON ratings(rater_id);
CREATE UNIQUE INDEX idx_ratings_response_rater_dir ON ratings(response_id, rater_id, direction);

-- ─── PHASE E: Restore data ───────────────────────────────────────────────────

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

-- ─── PHASE G: Remove seeded capability tags ───────────────────────────────────

DELETE FROM capabilities WHERE tag IN (
  'ack-close', 'abandon',
  'handoff', 'collision-warn', 'status-sync', 'delegate', 'blocker'
);
