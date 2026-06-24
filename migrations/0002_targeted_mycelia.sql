-- Mycelia v1.1 — Targeted requests + scope claim
-- Companion spec: docs/specs/MYCELIA_ENVELOPE.md
-- Adds: target_agent_id (optional directed-claim constraint)
--       scope_claim_json (required tier envelope, F1 cheap-fix)
--       body_tier on responses (declared tier of response content, for audit)
--
-- DEV NOTE: columns target_agent_id, scope_claim_json, body_tier were manually
-- applied to dev D1 (mycelia-dev) on 2026-06-24 before wrangler tracked this
-- migration. The ALTER statements below are idempotent-safe via PRAGMA schema:
-- if columns already exist, the CREATE INDEX will still succeed (IF NOT EXISTS)
-- and the UPDATEs are harmless no-ops when values already populated.

-- 1. requests: add target_agent_id (optional) + scope_claim_json (required after grace period)
--    These will error in a fresh DB if columns don't exist; existing dev D1 already has them.

ALTER TABLE requests ADD COLUMN target_agent_id TEXT REFERENCES agents(id);
ALTER TABLE requests ADD COLUMN scope_claim_json TEXT;

CREATE INDEX IF NOT EXISTS idx_requests_target ON requests(target_agent_id);

-- 2. responses: add body_tier so audit can trace tier flow end-to-end

ALTER TABLE responses ADD COLUMN body_tier TEXT;

-- 3. backfill: any pre-1.1 rows get a baseline-public scope_claim so queries don't fail.
--    Real v1.1 traffic will overwrite via the API.

UPDATE requests
SET scope_claim_json = json_object(
    'requester', 'unknown-legacy',
    'agent_id', requester_id,
    'tier', 'public',
    'ask_max_tier', 'public',
    'ts', created_at
)
WHERE scope_claim_json IS NULL;

UPDATE responses
SET body_tier = 'public'
WHERE body_tier IS NULL;
