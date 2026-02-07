#!/usr/bin/env bash
set -euo pipefail

# One-command devnet smoke test for Clawosseum + x402 + Solana Devnet.
#
# What it does:
# 1) loads local secrets from ../.secrets/devnet.env (created by scripts/devnet_wallets.mjs)
# 2) starts local Faremeter facilitator (port 8788)
# 3) starts clawosseum-api container pointing to the local facilitator
# 4) runs a paid agent signup using Corbits/Faremeter tooling
#
# Requirements:
# - You must have devnet SOL in:
#   - fee payer wallet (FAREMETER_FEEPAYER_KEYPAIR_PATH)
#   - agent payer wallet (PAYER_KEYPAIR_PATH) (also needs devnet USDC)
# - Receiver wallet address is configured as X402_PAY_TO

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
SECRETS_ENV="$ROOT_DIR/../.secrets/devnet.env"

if [[ ! -f "$SECRETS_ENV" ]]; then
  echo "Missing $SECRETS_ENV" >&2
  echo "Create it with: node server/scripts/devnet_wallets.mjs <receiverPubkey>" >&2
  exit 2
fi

# shellcheck disable=SC1090
source "$SECRETS_ENV"

: "${FAREMETER_FEEPAYER_KEYPAIR_PATH:?missing}"
: "${PAYER_KEYPAIR_PATH:?missing}"

RECEIVER_PUBKEY="${X402_PAY_TO:-BkUtwoSwHrnQaL2mEf3Xs1a1wkdCYoGnpYYGeDeMb5h8}"
REGISTER_PRICE="${X402_REGISTER_PRICE:-$0.05}"

echo "Using receiver: $RECEIVER_PUBKEY"
echo "Using fee payer keypair: $FAREMETER_FEEPAYER_KEYPAIR_PATH"
echo "Using agent payer keypair: $PAYER_KEYPAIR_PATH"

echo "\nStarting local facilitator on :8788..."
FAC_PID=""
cleanup() {
  if [[ -n "${FAC_PID}" ]]; then
    kill "$FAC_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

(
  cd "$ROOT_DIR/server"
  export FAREMETER_SOLANA_CLUSTER=devnet
  export FAREMETER_FEEPAYER_KEYPAIR_PATH
  export FAREMETER_SOLANA_RPC_URL="${SOLANA_DEVNET_RPC:-}"
  export FAREMETER_FACILITATOR_PORT=8788
  node faremeter_facilitator.mjs
) &
FAC_PID=$!

sleep 1

echo "\nStarting clawosseum-api container on :5195..."
docker rm -f clawosseum-api >/dev/null 2>&1 || true

docker run -d --name clawosseum-api -p 5195:8080 \
  -e ARENA_JWT_SECRET=devsecret \
  -e X402_ENABLED=1 \
  -e X402_NETWORK=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1 \
  -e X402_FACILITATOR_URL=http://host.docker.internal:8788 \
  -e X402_REGISTER_PRICE="$REGISTER_PRICE" \
  -e X402_PAY_TO="$RECEIVER_PUBKEY" \
  clawosseum-api:local >/dev/null

# If host.docker.internal isn't available (Linux), also bind-mount /etc/hosts workaround by using gateway.
# For now, we just print a hint if register fails.

echo "\nRunning paid signup (Corbits/Faremeter rides)..."
(
  cd "$ROOT_DIR/server"
  export ARENA_URL="http://127.0.0.1:5195"
  export PAYER_KEYPAIR_PATH
  node "$ROOT_DIR/skills/clawosseum-arena/scripts/arena_signup_corbits.mjs" "DevnetTester" "claude"
) || {
  echo "\nSignup failed. If the API is in Docker and cannot reach the facilitator at host.docker.internal, we need to adjust networking." >&2
  echo "Try: docker logs clawosseum-api --tail 80" >&2
  exit 1
}

echo "\nDone. Check API logs:" 
echo "  docker logs --tail 120 clawosseum-api"
