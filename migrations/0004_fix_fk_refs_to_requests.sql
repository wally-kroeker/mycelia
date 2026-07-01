-- Migration 0004: Fix foreign-key references after migration 0003.
--
-- Migration 0003 (widen request_type CHECK) rebuilt the `requests` table using
-- the SQLite ALTER-CHECK dance (rename → create → copy → drop → rename).
-- But `request_tags`, `claims`, and `responses` still hold their original
-- FK definitions pointing at "requests_v11"(id) — the renamed-then-dropped
-- table name. With PRAGMA foreign_keys=ON (D1 default), INSERT into those
-- tables now fails with "FOREIGN KEY constraint failed" because the referenced
-- table no longer exists.
--
-- Fix: rebuild each referring table with correct FK pointing at requests(id).
-- Data is preserved via SELECT INTO INSERT.
--
-- Verified failure signature (2026-07-01):
--   POST /v1/requests → INTERNAL_ERROR (request_tags INSERT in batch fails)
--   POST /v1/requests/:id/claims → INTERNAL_ERROR (claims INSERT fails)

PRAGMA foreign_keys = OFF;

-- ─── request_tags ─────────────────────────────────────────────────────
ALTER TABLE request_tags RENAME TO request_tags_broken;
CREATE TABLE request_tags (
  request_id      TEXT NOT NULL REFERENCES requests(id),
  capability_id   INTEGER NOT NULL REFERENCES capabilities(id),
  PRIMARY KEY (request_id, capability_id)
);
INSERT INTO request_tags SELECT * FROM request_tags_broken;
DROP TABLE request_tags_broken;
CREATE INDEX IF NOT EXISTS idx_request_tags_request ON request_tags(request_id);
CREATE INDEX IF NOT EXISTS idx_request_tags_capability ON request_tags(capability_id);

-- ─── claims ──────────────────────────────────────────────────────────
ALTER TABLE claims RENAME TO claims_broken;
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
INSERT INTO claims SELECT * FROM claims_broken;
DROP TABLE claims_broken;
CREATE INDEX IF NOT EXISTS idx_claims_request ON claims(request_id);
CREATE INDEX IF NOT EXISTS idx_claims_agent ON claims(agent_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);

-- ─── responses ───────────────────────────────────────────────────────
-- responses had ALTER TABLE additions after 0001 (body_tier column from v1.1
-- migration). Preserve column order matching current live table.
ALTER TABLE responses RENAME TO responses_broken;
CREATE TABLE responses (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL REFERENCES requests(id),
  responder_id        TEXT NOT NULL REFERENCES agents(id),
  claim_id            TEXT REFERENCES claims(id),
  parent_response_id  TEXT REFERENCES responses(id),
  body                TEXT NOT NULL,
  confidence          REAL,
  created_at          TEXT NOT NULL,
  body_tier           TEXT
);
INSERT INTO responses SELECT id, request_id, responder_id, claim_id, parent_response_id, body, confidence, created_at, body_tier FROM responses_broken;
DROP TABLE responses_broken;
CREATE INDEX IF NOT EXISTS idx_responses_request ON responses(request_id);
CREATE INDEX IF NOT EXISTS idx_responses_responder ON responses(responder_id);
CREATE INDEX IF NOT EXISTS idx_responses_parent ON responses(parent_response_id);

PRAGMA foreign_keys = ON;
