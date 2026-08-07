-- Migration 0010: shipper_events — journal event ingestion table.
--
-- Phase 5 of fleet-coordination-v1: Shipper Contract.
--
-- A controlling agent's shipper process forwards semantic events from the
-- local run journal (~/.bobs/<bob>/runs/<run-id>.jsonl) to Mycelia via
-- POST /v1/events/batch. This table stores those events.
--
-- Design principles (from AGENT-CONTRACT-v1.md §6):
--
-- 1. journal_event_id = "<run_id>:<seq>" — stable across retries. The UNIQUE
--    constraint on this column is the idempotency mechanism: INSERT OR IGNORE
--    skips already-present events, so replay is a safe no-op.
--
-- 2. event_type is stored opaque. Mycelia must not interpret it — the event
--    vocabulary is the agent contract's domain (§4.3), not Mycelia's. Mycelia
--    receives, stores, and indexes. Inference is the observer's job.
--
-- 3. tool.call events are NOT forwarded by the shipper (§4.3). Enforced
--    client-side; this table may hold any event_type received.
--
-- 4. agent_id is the authenticated sender from the API key, NOT from the
--    journal bob field. The bob field is metadata; the agent_id is the trust
--    anchor. A shipper claiming to be someone else cannot spoof trust scores.
--
-- 5. Additive only — no existing table is touched by this migration.

CREATE TABLE shipper_events (
  id               TEXT    PRIMARY KEY,   -- server-generated, returned to shipper
  journal_event_id TEXT    NOT NULL UNIQUE, -- "<run_id>:<seq>", idempotency key
  run_id           TEXT    NOT NULL,      -- extracted: part before the colon
  seq              INTEGER NOT NULL,      -- extracted: part after the colon
  bob              TEXT    NOT NULL,      -- agent name from the journal line
  planet           TEXT,                  -- planet field from journal, nullable
  event_type       TEXT    NOT NULL,      -- ev field — opaque string, not validated
  payload          TEXT,                  -- JSON blob of the v field, nullable
  t                TEXT    NOT NULL,      -- ISO 8601 UTC from the journal line
  received_at      TEXT    NOT NULL,      -- when Mycelia received this batch
  agent_id         TEXT    NOT NULL REFERENCES agents(id) -- authenticated sender
);

-- Queries expected:
--   - By run (timeline view of a specific run)
--   - By bob (all runs from one agent, newest first)
--   - By event_type (filter to task.claim, run.end, etc.)
--   - By agent + received (feed-style newest-first)

CREATE INDEX idx_se_run        ON shipper_events(run_id, seq);
CREATE INDEX idx_se_bob        ON shipper_events(bob, received_at DESC);
CREATE INDEX idx_se_event_type ON shipper_events(event_type);
CREATE INDEX idx_se_agent      ON shipper_events(agent_id, received_at DESC);
