-- Mycelia 0003 — narrow claims unique constraint to active claims only
--
-- Before this migration: idx_claims_request_agent was UNIQUE(request_id, agent_id)
-- regardless of status. That over-encoded the actual invariant ("one ACTIVE
-- claim per (request, agent)") and collided with the legitimate case of an
-- agent re-claiming a request after the prior claim transitioned to
-- 'completed' / 'abandoned' / 'expired'. The INSERT in the claims handler
-- threw a unique-violation that surfaced as HTTP 500.
--
-- See [[project_mycelia_zombie_claim_fix_deployed_2026_06_17]] in PAI memory
-- for the originating incident. The B2 surface from PR #2's description.

DROP INDEX IF EXISTS idx_claims_request_agent;

-- Partial unique index: only enforces uniqueness for status='active' rows.
-- Multiple completed/abandoned/expired claim rows for the same (request, agent)
-- pair are now allowed. The handler-level check (constraint 6: "Max 1 active
-- claim per agent per request") and this index agree on the invariant.
CREATE UNIQUE INDEX idx_claims_request_agent_active
  ON claims(request_id, agent_id)
  WHERE status = 'active';
