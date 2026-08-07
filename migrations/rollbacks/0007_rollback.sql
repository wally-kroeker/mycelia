-- Rollback for migration 0007: drop the five coordination fields added in Phase 2.
--
-- USE: Apply this BEFORE 0006_rollback.sql when rolling back Phase 2.
-- SQLite 3.35+ (D1 uses 3.46+) supports DROP COLUMN for columns with no
-- constraints other than NULL/NOT NULL. All five columns are nullable TEXT
-- with no FK or CHECK constraints, so DROP COLUMN is safe here.
--
-- No data loss concern: these columns are nullable and Phase 2 mechanics
-- write them only when callers supply the fields. On a fresh Phase 2 deploy
-- with no coordination traffic, all values will be NULL.

ALTER TABLE requests DROP COLUMN references_json;
ALTER TABLE requests DROP COLUMN supersedes;
ALTER TABLE requests DROP COLUMN artifacts_json;
ALTER TABLE requests DROP COLUMN action_required;
ALTER TABLE requests DROP COLUMN blocking;
