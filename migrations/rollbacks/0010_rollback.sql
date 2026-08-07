-- Rollback for migration 0010: shipper_events.
--
-- Fully additive migration — just drop the table.
-- No preconditions; shipper_events has no inbound FK references.

DROP INDEX IF EXISTS idx_se_agent;
DROP INDEX IF EXISTS idx_se_event_type;
DROP INDEX IF EXISTS idx_se_bob;
DROP INDEX IF EXISTS idx_se_run;
DROP TABLE shipper_events;
