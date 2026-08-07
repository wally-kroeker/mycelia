-- Migration 0008: Add agent_tier column to agents table.
--
-- Phase 3 of fleet-coordination-v1. Adds the trust-tier axis for the
-- two-gate ops-bus enforcement model:
--   Gate 1 (Phase 2): mode check — fleet/company only.
--   Gate 2 (Phase 3): tier check — agent_tier = 'trusted' required.
--
-- AgentTier values:
--   'peer'    — default; newly registered agents. Cannot post ops-bus types.
--   'trusted' — node-operator promotion. Can post ops-bus types on fleet/company nodes.
--
-- ALTER COLUMN is not supported in SQLite. This uses ALTER TABLE ... ADD COLUMN,
-- which is valid for nullable columns and columns with a DEFAULT constraint.
-- The DEFAULT 'peer' means all existing agents get peer tier without a rebuild.
--
-- This is additive-only — no existing row is deleted, no FK constraint changes.
-- The agents table is the one table where data loss is not recoverable (each row
-- holds a hashed key that live Bobs authenticate against). An export of agents was
-- taken before this migration runs. See: /tmp/agents-backup-2026-08-07.sql

ALTER TABLE agents ADD COLUMN agent_tier TEXT NOT NULL DEFAULT 'peer'
  CHECK(agent_tier IN ('peer', 'trusted'));

-- Backfill: promote wallyk-owned agents to 'trusted'.
-- This runs immediately after the column is added so no agent is peer-gated
-- between the ALTER and any subsequent promotion step.
-- Adjust owner_id predicate if your deployment uses a different operator id.
UPDATE agents SET agent_tier = 'trusted' WHERE owner_id = 'wallyk';
