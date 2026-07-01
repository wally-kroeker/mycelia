# Mycelia schema-migration checklist

Learned by burning ourselves twice in the 2026-07-01 T-059 arc. Encode the gotchas
here so we don't hit them a third time.

## The two failure modes we hit

### 1. SQLite ALTER-CHECK dance leaves referring tables' FKs dangling

**What broke (migration 0003):** we widened `requests.request_type` CHECK constraint
via the standard SQLite "rename → create → copy → drop → rename" dance. The migration
completed successfully. `requests` had the new constraint. 300 rows preserved.

**What we missed:** the tables that reference `requests(id)` — `request_tags`, `claims`,
`responses` — kept their original FK definitions pointing at the **renamed-then-dropped**
intermediate table `requests_v11(id)`. SQLite does NOT propagate table renames into
FK definitions of referring tables. With `PRAGMA foreign_keys=ON` (D1 default), every
INSERT into those three tables now failed with `FOREIGN KEY constraint failed`.

The signature was subtle: POST `/v1/requests` returned `INTERNAL_ERROR` intermittently.
Requests table row got inserted (D1's batch commits it), then the tags-insert failed,
then the audit-log write failed, then the response builder threw. Rows persisted but
Worker returned 500.

**Fix (migration 0004):** rebuild each referring table with correct FK pointing at
`requests(id)`. Same rename → create → copy → drop pattern applied three more times.

**Checklist:**

- [ ] Before an ALTER-CHECK dance on any table `T`, list every FK reference to `T(id)`
      with: `SELECT sql FROM sqlite_master WHERE sql LIKE '%REFERENCES%<T>%'`.
- [ ] The migration MUST include a "rebuild referring tables" section that recreates
      each one with fresh FK definitions pointing at the post-dance `T`.
- [ ] After apply, verify with the same `sqlite_master` query — all FKs should now
      reference `T(id)`, none referencing `T_v<N>(id)` intermediate names.
- [ ] Smoke-test at least one INSERT into each referring table before declaring
      the migration done.

### 2. Migrations tracker out of sync with reality (D1 quirk)

**What broke:** `wrangler d1 migrations apply` tried to re-run `0002_targeted_mycelia.sql`
even though it had been applied. The `d1_migrations` table didn't record `0002` as
applied, but the schema effects (like `target_agent_id` column) were present.

**Symptoms:** `duplicate column name: target_agent_id: SQLITE_ERROR [code: 7500]`
when trying to apply subsequent migrations via the tracker.

**Fix:** bypass the tracker by applying with `wrangler d1 execute mycelia-db --remote
--file migrations/<name>.sql`. This runs the SQL directly without touching the tracker.

**Checklist:**

- [ ] Prefer `wrangler d1 execute --file` for `mycelia-db --remote` migrations until
      the tracker is reconciled.
- [ ] Note applied-but-untracked migrations in the migration file's header comment
      so future contributors know.
- [ ] Consider a `0000_reconcile_migrations_tracker.sql` at some future point that
      re-inserts the missing entries into `d1_migrations` — held for a coordinated
      pass, not urgent.

## Other patterns worth encoding

### Additive column adds are the easy path

`ALTER TABLE t ADD COLUMN new_col TEXT` is safe, non-blocking, non-locking. All
five v1.2 Tier-2 fields (`references_json`, `supersedes`, `artifacts_json`,
`action_required`, `blocking`) landed via `ALTER TABLE ADD COLUMN` — no dance
required, no FK worry. Prefer this shape whenever the field can be nullable.

### CHECK constraint additions are the hard path

Any change to a CHECK constraint requires the rename-create-copy-drop-rename
dance (SQLite has no `ALTER COLUMN`). Combine multiple CHECK changes into a
single migration to only pay the dance cost once.

### FK CASCADE was not used here

None of Mycelia's FKs declare ON DELETE / ON UPDATE behavior. If we ever add
CASCADE, verify the rebuild migration preserves it.

### JSON1 for arrays

D1 supports SQLite's JSON1 extension. Arrays stored as TEXT columns can be queried:

```sql
-- find all requests that reference a specific prior request
SELECT id FROM requests
WHERE references_json IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM json_each(references_json)
    WHERE json_each.value = ?
  );
```

Fine for Mycelia bus scale (~300-3000 rows in v1.2 timeframe). If we ever hit
100k+ rows and need fast array-containment queries, revisit junction tables.

## Migration receipts to date

| # | Name | Purpose | Applied |
|---|------|---------|---------|
| 0001 | initial | Schema bootstrap | (pre-tracker era) |
| 0002 | targeted_mycelia | v1.1 target_agent_id + scope_claim_json | applied, tracker out-of-sync |
| 0003 | widen_request_type_v1_2 | v1.2 CHECK widening for 6 ops-bus types | 2026-07-01 |
| 0004 | fix_fk_refs_to_requests | Rebuild request_tags/claims/responses FKs (fix 0003) | 2026-07-01 |
| 0005 | add_structured_coordination_fields | v1.2 Tier-2: references_json / supersedes / artifacts_json / action_required / blocking | 2026-07-01 |

## Composability

This checklist lives in the Mycelia repo. If Wally's upstream adopts these
migrations, port the checklist too — the gotchas are inherent to SQLite +
D1's tracker behavior, not fork-specific.

— Margin + CeeCee, T-059 debrief (2026-07-01)
