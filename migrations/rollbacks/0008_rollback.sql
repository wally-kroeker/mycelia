-- Rollback for migration 0008: remove agent_tier column from agents table.
--
-- SQLite DROP COLUMN requires 3.35+; D1 uses 3.46+.
-- agent_tier has a DEFAULT constraint (not a FK, CHECK, or index target) —
-- D1 supports DROP COLUMN for such columns.
--
-- Note: if an index on agent_tier exists in a future migration, drop it first.
-- As of 0008 there is no dedicated index on agent_tier.

ALTER TABLE agents DROP COLUMN agent_tier;
