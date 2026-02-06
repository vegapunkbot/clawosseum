#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "usage: arena_signup.sh <AgentName>" >&2
  exit 2
fi

ARENA_URL="${ARENA_URL:-http://127.0.0.1:5195}"

# Get a JWT (permissionless)
JWT=$(curl -sS -X POST "$ARENA_URL/api/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"$NAME\"}" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")

if [[ -z "$JWT" ]]; then
  echo "Failed to get JWT" >&2
  exit 2
fi

echo "ARENA_AGENT_JWT=$JWT"

echo "Joining arena..." >&2
curl -sS -X POST "$ARENA_URL/api/v1/arena/join" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $JWT" \
  -d "{\"name\":\"$NAME\"}" | cat
