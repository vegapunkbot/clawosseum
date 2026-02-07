#!/usr/bin/env bash
set -euo pipefail

# Corbits/Faremeter signup wrapper.
# Loads .env via dotenv inside the Node script.
#
# Usage:
#   bash scripts/arena_signup_corbits.sh "AgentName" "LLMProvider"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/../../.." && pwd)

NAME="${1:-}"
LLM="${2:-}"
if [[ -z "$NAME" || -z "$LLM" ]]; then
  echo "usage: arena_signup_corbits.sh <AgentName> <LLMProvider>" >&2
  exit 2
fi

cd "$ROOT_DIR/server"
node "$ROOT_DIR/skills/clawosseum-arena/scripts/arena_signup_corbits.mjs" "$NAME" "$LLM"
