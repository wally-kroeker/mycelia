-- Migration 0003: Widen request_type CHECK constraint for v1.2 (2026-07-01)
-- Per T-059 (Mycelia request-schema redesign — widen types + add structured fields)
-- Adds six ops-bus types alongside the original eight eval-surface types.
-- Application-layer validation in src/routes/requests.ts is authoritative;
-- the DB-level CHECK is kept as defense-in-depth.
--
-- SQLite doesn't support ALTER COLUMN or DROP CONSTRAINT, so this uses the
-- standard "rename → create → copy → drop → rename" pattern.
-- Foreign keys referencing this table are NOT affected since primary key + all
-- other columns stay identical.

PRAGMA foreign_keys = OFF;

-- 1. Rename existing table
ALTER TABLE requests RENAME TO requests_v11;

-- 2. Create new table with widened CHECK. All other columns identical.
CREATE TABLE requests (
  id                    TEXT PRIMARY KEY,
  requester_id          TEXT NOT NULL REFERENCES agents(id),
  title                 TEXT NOT NULL,
  body                  TEXT NOT NULL,
  request_type          TEXT NOT NULL CHECK(request_type IN (
                          -- eval-surface (v1.0):
                          'review', 'validation', 'second-opinion', 'council',
                          'fact-check', 'summarize', 'translate', 'debug',
                          -- ops-bus (v1.2):
                          'handoff', 'collision-warn', 'status-sync',
                          'delegate', 'ack-close', 'blocker'
                        )),
  priority              TEXT DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high')),
  status                TEXT DEFAULT 'open' CHECK(status IN ('open', 'claimed', 'responded', 'rated', 'closed', 'expired', 'cancelled')),
  max_responses         INTEGER DEFAULT 1,
  response_count        INTEGER DEFAULT 0,
  context               TEXT,
  expires_at            TEXT,
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  closed_at             TEXT,
  target_agent_id       TEXT REFERENCES agents(id),
  scope_claim_json      TEXT
);

-- 3. Copy every row verbatim
INSERT INTO requests SELECT * FROM requests_v11;

-- 4. Drop the old table
DROP TABLE requests_v11;

-- 5. Rebuild indexes that lived on the original requests table
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
CREATE INDEX IF NOT EXISTS idx_requests_target_agent_id ON requests(target_agent_id);

PRAGMA foreign_keys = ON;
