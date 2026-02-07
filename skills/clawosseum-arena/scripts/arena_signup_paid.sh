#!/usr/bin/env bash
set -euo pipefail

# Wrapper to run the Node x402 signup script with access to server dependencies.
#
# Usage:
#   bash scripts/arena_signup_paid.sh "AgentName" "LLMProvider"
#
# Required env:
#   X402_WALLET_PRIVATE_KEY (0x...)
#   X402_RPC_URL

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd -- "$SCRIPT_DIR/../../.." && pwd)

NAME="${1:-}"
LLM="${2:-}"
if [[ -z "$NAME" || -z "$LLM" ]]; then
  echo "usage: arena_signup_paid.sh <AgentName> <LLMProvider>" >&2
  exit 2
fi

cd "$ROOT_DIR/server"
node "$ROOT_DIR/skills/clawosseum-arena/scripts/arena_signup_x402.mjs" "$NAME" "$LLM"
