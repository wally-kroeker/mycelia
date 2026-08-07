#!/usr/bin/env bash
# scripts/migration-preflight.sh — migration safety check before applying.
#
# Usage:
#   ./scripts/migration-preflight.sh <env>
#
#   <env>: dev | staging
#
# Reports:
#   1. Ledger contents (what D1 thinks has been applied)
#   2. Pending migrations (files not yet in the ledger)
#   3. Schema drift check — for each pending migration, whether the table/column
#      it would create already exists in the live schema (early indicator that
#      the migration ran outside the ledger, e.g. via --file without ledger update)
#
# Why this exists:
#   The live node's ledger was missing 0004 and 0005 after the rate-limiter work
#   (migrations applied with --file, not migrations apply). The drift went unnoticed
#   until 'migrations list' was run before Phase 2. This preflight makes that
#   class of drift visible before the next apply.
#
# Run before every migrations apply call.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
D1="$SCRIPT_DIR/d1.sh"
MIGRATIONS_DIR="$PROJECT_DIR/migrations"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <env>" >&2
  exit 1
fi

ENV="$1"

echo "═══ Migration preflight: $ENV ════════════════════════════════"
echo ""

# ─── 1. Ledger contents ───────────────────────────────────────────────────────
echo "▶ Ledger (d1_migrations — what the DB thinks is applied):"
"$D1" "$ENV" --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id;" 2>/dev/null \
  | grep -E '"id"|"name"|"applied_at"' | paste - - - || echo "  (ledger empty or table missing)"
echo ""

# ─── 2. Pending migrations ────────────────────────────────────────────────────
echo "▶ Pending migrations (files not in ledger):"
APPLIED=$("$D1" "$ENV" --command "SELECT name FROM d1_migrations;" 2>/dev/null \
  | grep '"name"' | sed 's/.*": "//;s/".*//')

PENDING=()
for f in "$MIGRATIONS_DIR"/[0-9]*.sql; do
  fname="$(basename "$f")"
  if ! echo "$APPLIED" | grep -qF "$fname"; then
    PENDING+=("$fname")
    echo "  PENDING: $fname"
  fi
done

if [[ ${#PENDING[@]} -eq 0 ]]; then
  echo "  (none — schema is up to date)"
fi
echo ""

# ─── 3. Schema drift check ────────────────────────────────────────────────────
echo "▶ Schema drift check (pending migrations vs. live schema):"
if [[ ${#PENDING[@]} -eq 0 ]]; then
  echo "  (no pending migrations to check)"
else
  for fname in "${PENDING[@]}"; do
    echo "  Checking $fname ..."
    fpath="$MIGRATIONS_DIR/$fname"

    # Extract CREATE TABLE names
    TABLES=$(grep -oiP "(?<=CREATE TABLE )(IF NOT EXISTS )?[\"'\`]?\K\w+" "$fpath" 2>/dev/null || true)
    for tbl in $TABLES; do
      EXISTS=$("$D1" "$ENV" --command "SELECT name FROM sqlite_master WHERE type='table' AND name='$tbl';" 2>/dev/null \
        | grep -c '"name"' || true)
      if [[ "${EXISTS:-0}" -gt 0 ]]; then
        echo "    ⚠ TABLE '$tbl' already exists in live schema (schema drift?)"
      else
        echo "    ✓ TABLE '$tbl' not yet in live schema (expected)"
      fi
    done

    # Extract ALTER TABLE ADD COLUMN patterns
    COLS=$(grep -oiP "(?<=ADD COLUMN )\w+" "$fpath" 2>/dev/null || true)
    ALTERTBLS=$(grep -oiP "(?<=ALTER TABLE )\w+" "$fpath" 2>/dev/null | head -5 || true)
    for col in $COLS; do
      for tbl2 in $ALTERTBLS; do
        COL_EXISTS=$("$D1" "$ENV" --command "SELECT name FROM pragma_table_info('$tbl2') WHERE name='$col';" 2>/dev/null \
          | grep -c '"name"' || true)
        if [[ "${COL_EXISTS:-0}" -gt 0 ]]; then
          echo "    ⚠ COLUMN '$tbl2.$col' already exists in live schema (schema drift?)"
        else
          echo "    ✓ COLUMN '$tbl2.$col' not yet in live schema (expected)"
        fi
      done
    done
  done
fi
echo ""
echo "═══════════════════════════════════════════════════════════════"
