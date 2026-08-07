#!/usr/bin/env bash
# scripts/d1.sh — D1 wrapper that always includes --remote and --config.
#
# Usage:
#   ./scripts/d1.sh <env> <command|file> [sql...]
#
#   <env>    : dev | staging (maps to wrangler database name + env)
#   <command>: --command <SQL>
#             --file    <path>
#
# Examples:
#   ./scripts/d1.sh dev --command "SELECT COUNT(*) FROM agents;"
#   ./scripts/d1.sh staging --file migrations/0008_agent_tier.sql
#   ./scripts/d1.sh dev --command "SELECT name FROM d1_migrations ORDER BY id;"
#
# Why this wrapper exists:
#   wrangler d1 execute without --remote silently hits the local SQLite state
#   at .wrangler/state/v3/d1 — output is identical to remote, so the mistake
#   is invisible. Two live-node false reports resulted from this. This wrapper
#   makes --remote non-optional and prevents the class of mistake rather than
#   relying on habit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$PROJECT_DIR/wrangler.local.toml"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <env> <--command <SQL> | --file <path>>" >&2
  exit 1
fi

ENV="$1"
shift

case "$ENV" in
  dev)
    DB_NAME="mycelia-dev"
    WRANGLER_ENV="dev"
    ;;
  staging)
    DB_NAME="mycelia-staging"
    WRANGLER_ENV="staging"
    ;;
  *)
    echo "Unknown env: $ENV. Use 'dev' or 'staging'." >&2
    exit 1
    ;;
esac

exec "$PROJECT_DIR/node_modules/.bin/wrangler" d1 execute "$DB_NAME" \
  --env "$WRANGLER_ENV" \
  --config "$CONFIG" \
  --remote \
  "$@"
