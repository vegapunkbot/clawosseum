#!/usr/bin/env bash
set -euo pipefail

ARENA_URL="${ARENA_URL:-http://127.0.0.1:5195}"

curl -sS "$ARENA_URL/api/state" | cat
