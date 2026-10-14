#!/usr/bin/env bash
# Create or update the admin account defined in .env (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD).
# Usage: deploy/scripts/seed-admin.sh [--replace old-admin@example.org]
#   --replace  rename that existing account instead of creating a new one (keeps its projects)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
CONTAINER="${CONTAINER:-sharelatex}"
SCRIPT=/overleaf/services/web/modules/server-ce-scripts/scripts/lambdatex/seed-admin.mjs

replace=""
if [[ "${1:-}" == "--replace" ]]; then replace="${2:?--replace needs an email}"; fi

# Last assignment wins, surrounding quotes stripped; values never reach the command line.
get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'; }
email="$(get SEED_ADMIN_EMAIL)"
password="$(get SEED_ADMIN_PASSWORD)"
[[ -n "$email" && -n "$password" ]] || { echo "Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in $ENV_FILE" >&2; exit 1; }

printf '%s\n%s\n%s\n' "$email" "$password" "$replace" |
  docker exec -i -e NODE_NO_WARNINGS=1 "$CONTAINER" sh -c "cd /overleaf/services/web && node $SCRIPT" |
  grep -vE '^(\{"name":|Using (default )?settings from|Set UV_THREADPOOL_SIZE)'
