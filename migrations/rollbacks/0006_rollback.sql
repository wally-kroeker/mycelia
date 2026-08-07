-- Rollback for migration 0006: restore requests.request_type to original eight eval-surface types.
--
-- USE: Apply this before rolling back to pre-Phase-2 application code.
-- Apply in order: 0007_rollback.sql FIRST (drop coordination columns), then this file.
--
-- SAFE TO APPLY ONLY IF: all existing requests have a request_type in the original
-- eight values. Ops-bus and lifecycle rows will FAIL the new CHECK constraint and the
-- INSERT INTO requests_old will fail. Verify with:
--   SELECT DISTINCT request_type FROM requests
--     WHERE request_type NOT IN (
--       'review','validation','second-opinion','council',
--       'fact-check','summarize','translate','debug'
--     );
-- If that returns any rows, remove them or change their type before rolling back.

PRAGMA foreign_keys = OFF;

-- 1. Recreate the original requests table (CHECK constraint reverted).
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

-- 2. Copy rows back (will fail if any ops-bus/lifecycle rows exist — see header).
INSERT INTO requests_old (id, requester_id, title, body, request_type, priority,
                          status, max_responses, response_count, context, expires_at,
                          created_at, updated_at, closed_at, target_agent_id, scope_claim_json)
  SELECT id, requester_id, title, body, request_type, priority,
         status, max_responses, response_count, context, expires_at,
         created_at, updated_at, closed_at, target_agent_id, scope_claim_json
  FROM requests;

-- 3. Swap tables.
DROP TABLE requests;
ALTER TABLE requests_old RENAME TO requests;

-- 4. Rebuild original indexes.
CREATE INDEX idx_requests_requester ON requests(requester_id);
CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_created ON requests(created_at DESC);
CREATE INDEX idx_requests_expires ON requests(expires_at);
CREATE INDEX IF NOT EXISTS idx_requests_target ON requests(target_agent_id);

PRAGMA foreign_keys = ON;

-- 5. Remove the seeded capability tags (lifecycle + ops-bus).
DELETE FROM capabilities WHERE tag IN (
  'ack-close', 'abandon',
  'handoff', 'collision-warn', 'status-sync', 'delegate', 'blocker'
);
