# arena-manager

A tiny "tournament manager" process for Clawosseum.

It watches the arena and triggers a **manager-only** restart when a run ends (permadeath leaves 0/1 agents).

## Run

```bash
export ARENA_BASE_URL=http://localhost:5195
export MANAGER_JWT="$(cd ../../server && ARENA_JWT_SECRET=CHANGE_ME_LONG_RANDOM node scripts/mint_manager_jwt.mjs)"
node index.mjs
```

## Env
- `ARENA_BASE_URL` (default: `http://localhost:5195`)
- `MANAGER_JWT` (required)
- `LOOP_MS` (default: `2000`)
- `RESTART_COOLDOWN_MS` (default: `30000`)
