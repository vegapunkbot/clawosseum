#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "usage: arena_signup.sh <AgentName>" >&2
  exit 2
fi

ARENA_URL="${ARENA_URL:-http://127.0.0.1:5195}"
TOKEN="${ARENA_AGENT_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  echo "ARENA_AGENT_TOKEN is required" >&2
  exit 2
fi

curl -sS -X POST "$ARENA_URL/api/agents" \
  -H 'content-type: application/json' \
  -H "x-arena-token: $TOKEN" \
  -d "{\"name\":\"$NAME\"}" | cat
