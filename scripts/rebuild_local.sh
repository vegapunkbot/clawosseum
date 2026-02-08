#!/usr/bin/env bash
set -euo pipefail

# Rebuild + restart both local instances:
# - 5194 nginx static web
# - 5195 single-service API+UI

cd "$(dirname "$0")/.."

# Ensure host ports are free (sometimes a dev node process is left running)
# Try multiple passes; occasionally the port is re-acquired immediately.
KILL_CMD="fuser -k"
if command -v sudo >/dev/null 2>&1; then KILL_CMD="sudo fuser -k"; fi

for i in 1 2 3; do
  $KILL_CMD 5194/tcp 2>/dev/null || true
  $KILL_CMD 5195/tcp 2>/dev/null || true
  sleep 0.2
done

# Web
docker build -t clawosseum-web:local .
docker rm -f clawosseum-web 2>/dev/null || true
docker run -d --name clawosseum-web -p 5194:80 clawosseum-web:local

# Single-service
docker build -t clawosseum-api:local -f Dockerfile.single .
docker rm -f clawosseum-api 2>/dev/null || true
docker run -d --name clawosseum-api -p 5195:8080 -e ARENA_JWT_SECRET=${ARENA_JWT_SECRET:-devsecret} clawosseum-api:local

# quick health
curl -s -o /dev/null -w "5194:%{http_code}\n" http://localhost:5194/ || true
curl -s -o /dev/null -w "5195:%{http_code}\n" http://localhost:5195/health || true
