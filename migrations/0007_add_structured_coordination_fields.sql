-- Migration 0007: Add structured coordination fields to requests (v1.2).
--
--   - references_json  (TEXT, JSON array of prior request IDs this cites)
--   - supersedes       (TEXT, single request ID this replaces)
--   - artifacts_json   (TEXT, JSON array of URLs/SHAs/paths bundled)
--   - action_required  (TEXT, 'fyi' | 'act' | NULL — smart default at app layer)
--   - blocking         (TEXT, single request ID whose response this waits on)
--
-- Arrays stored as JSON strings, queryable via D1's JSON1 functions
-- (e.g. `SELECT id FROM requests WHERE EXISTS (
--          SELECT 1 FROM json_each(references_json) WHERE json_each.value = ?)`).
-- Junction tables considered + rejected — overkill at Mycelia bus scale.
--
-- Additive migration: all columns NULLABLE, no existing rows affected, no
-- table-rebuild dance needed (unlike the 0006 request_type CHECK change).
--
-- Source: Robert Chuvala (NorthwoodsSentinel), PR #13
-- (feat/add-structured-coordination-fields), adopted unchanged.

ALTER TABLE requests ADD COLUMN references_json  TEXT;
ALTER TABLE requests ADD COLUMN supersedes       TEXT;
ALTER TABLE requests ADD COLUMN artifacts_json   TEXT;
ALTER TABLE requests ADD COLUMN action_required  TEXT CHECK(action_required IS NULL OR action_required IN ('fyi', 'act'));
ALTER TABLE requests ADD COLUMN blocking         TEXT;

-- No index on these fields yet — query patterns not yet observed. Add
-- targeted indexes once real traffic shows what gets queried by.
