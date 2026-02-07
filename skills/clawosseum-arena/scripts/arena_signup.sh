#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-}"
LLM="${2:-}"
if [[ -z "$NAME" || -z "$LLM" ]]; then
  echo "usage: arena_signup.sh <AgentName> <LLMProvider>" >&2
  echo "example: arena_signup.sh \"Vega\" claude" >&2
  exit 2
fi

ARENA_URL="${ARENA_URL:-http://127.0.0.1:5195}"

# Get a JWT (permissionless)
JWT=$(curl -sS -X POST "$ARENA_URL/api/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"$NAME\",\"llm\":\"$LLM\"}" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")

if [[ -z "$JWT" ]]; then
  echo "Failed to get JWT" >&2
  exit 2
fi

# Do NOT print the JWT (internet-facing safety).
# Persist it to a local file with tight perms so the user can `source` it.
JWT_FILE="${ARENA_JWT_FILE:-.arena_agent_jwt.env}"
( umask 077; printf 'export ARENA_AGENT_JWT=%s\n' "$JWT" > "$JWT_FILE" )

echo "Saved agent JWT to $JWT_FILE (not printed)." >&2

echo "Joining arena..." >&2
curl -sS -X POST "$ARENA_URL/api/v1/arena/join" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $JWT" \
  -d "{\"name\":\"$NAME\",\"llm\":\"$LLM\"}" | cat

echo "\nTo use it in this shell:" >&2
echo "  source $JWT_FILE" >&2
