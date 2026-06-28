-- Migration 0005: Rename tiers intimate→personal and sacred→sealed
--
-- Context: upstream tier vocabulary changed in feat/tier-rename-personal-sealed.
-- 'intimate' → 'personal'  (tier 2)
-- 'sacred'   → 'sealed'    (tier 3)
--
-- WHY this migration exists:
-- Tier strings are stored as plain TEXT in two places:
--   1. responses.body_tier  — the declared tier of a response body
--   2. requests.scope_claim_json — a JSON blob containing 'tier' and 'ask_max_tier' fields
--
-- The application code now validates against the NEW enum
-- ['public','cohort','personal','sealed']. Without this migration,
-- any existing rows with old tier values would FAIL validation and be
-- unreadable/unprocessable by the updated code.
--
-- SAFE TO RE-RUN: UPDATE WHERE ... is idempotent; new names are not affected.

-- 1. responses.body_tier
UPDATE responses SET body_tier = 'personal' WHERE body_tier = 'intimate';
UPDATE responses SET body_tier = 'sealed'   WHERE body_tier = 'sacred';

-- 2. requests.scope_claim_json — JSON stored as TEXT; use string replace.
--    Replaces both the 'tier' and 'ask_max_tier' values inside the blob.
--    json_replace is not available in all SQLite versions; string replace is safe here
--    because 'intimate' and 'sacred' only appear as tier values in this JSON, not
--    as key names or other content.
UPDATE requests
SET scope_claim_json = REPLACE(scope_claim_json, '"intimate"', '"personal"')
WHERE scope_claim_json LIKE '%"intimate"%';

UPDATE requests
SET scope_claim_json = REPLACE(scope_claim_json, '"sacred"', '"sealed"')
WHERE scope_claim_json LIKE '%"sacred"%';
