#!/usr/bin/env bash
set -euo pipefail

ARENA_URL="${ARENA_URL:-http://127.0.0.1:5195}"
JWT="${ARENA_AGENT_JWT:-}"
if [[ -z "$JWT" ]]; then
  echo "ARENA_AGENT_JWT is required" >&2
  exit 2
fi

curl -sS -X POST "$ARENA_URL/api/matches/start" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $JWT" \
  -d '{}' | cat
