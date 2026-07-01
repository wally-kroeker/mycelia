-- Migration 0005: Add structured coordination fields to requests (v1.2 Tier 2).
--
-- Per T-059 Tier 2, converged between Margin + CeeCee 2026-07-01:
--   - references_json  (TEXT, JSON array of prior request IDs this cites)
--   - supersedes       (TEXT, single request ID this replaces)
--   - artifacts_json   (TEXT, JSON array of URLs/SHAs/paths bundled)
--   - action_required  (TEXT, 'fyi' | 'act' | NULL — smart default at app layer)
--   - blocking         (TEXT, single request ID whose response this waits on)
--
-- Arrays stored as JSON strings, queryable via D1's JSON1 functions
-- (e.g. `WHERE json_extract(references_json, '$') LIKE '%<id>%'`).
-- Junction tables considered + rejected — overkill at Mycelia bus scale.
--
-- Additive migration: all columns NULLABLE, no existing rows affected, no
-- foreign-key dance needed (unlike 0003→0004 request_type CHECK dance).

ALTER TABLE requests ADD COLUMN references_json  TEXT;
ALTER TABLE requests ADD COLUMN supersedes       TEXT;
ALTER TABLE requests ADD COLUMN artifacts_json   TEXT;
ALTER TABLE requests ADD COLUMN action_required  TEXT CHECK(action_required IS NULL OR action_required IN ('fyi', 'act'));
ALTER TABLE requests ADD COLUMN blocking         TEXT;

-- No index on these fields in v1.2 — query patterns not yet observed. Add
-- targeted indexes once feed-analysis shows what the fleet actually queries by.
