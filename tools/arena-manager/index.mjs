#!/usr/bin/env node

const ARENA_BASE_URL = (process.env.ARENA_BASE_URL || 'http://localhost:5195').replace(/\/$/, '')
const MANAGER_JWT = (process.env.MANAGER_JWT || '').trim()
const LOOP_MS = Number(process.env.LOOP_MS || 2000)
const RESTART_COOLDOWN_MS = Number(process.env.RESTART_COOLDOWN_MS || 30_000)

if (!MANAGER_JWT) {
  console.error('Missing MANAGER_JWT')
  process.exit(1)
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function getState() {
  const res = await fetch(`${ARENA_BASE_URL}/api/state`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`state fetch failed: ${res.status}`)
  return res.json()
}

async function restartArena(reason) {
  const res = await fetch(`${ARENA_BASE_URL}/api/arena/restart`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${MANAGER_JWT}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({}),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`restart failed: ${res.status} ${JSON.stringify(body)}`)
  console.log(`[arena-manager] restarted arena: ${reason} -> season ${body?.season?.number}`)
  return body
}

let lastRestartAt = 0

// Only restart after we've observed a "real" run start (>=2 agents or a match/tournament running).
// This prevents infinite restarts when the arena is empty.
let armed = false

console.log(`[arena-manager] watching ${ARENA_BASE_URL} (loop=${LOOP_MS}ms)`)

while (true) {
  try {
    const s = await getState()

    const agents = Array.isArray(s.agents) ? s.agents : []
    const currentMatch = s.currentMatch
    const tournamentRun = s.tournamentRun

    const matchRunning = currentMatch && currentMatch.status === 'running'
    const tournamentRunning = tournamentRun && tournamentRun.status === 'running'

    if (agents.length >= 2 || matchRunning || tournamentRunning) armed = true

    // "run ended" heuristic: no active match, not in tournament, and roster <= 1
    const runEnded = !matchRunning && !tournamentRunning && agents.length <= 1

    if (armed && runEnded) {
      const now = Date.now()
      if (now - lastRestartAt > RESTART_COOLDOWN_MS) {
        lastRestartAt = now
        armed = false
        const winner = agents[0]?.name || agents[0]?.id || null
        await restartArena(winner ? `winner=${winner}` : 'no agents remaining')
      }
    }
  } catch (e) {
    console.error('[arena-manager] loop error:', e?.message || e)
  }

  await sleep(Math.max(250, LOOP_MS))
}
