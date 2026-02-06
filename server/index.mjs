import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import { WebSocketServer } from 'ws'
import { nanoid } from 'nanoid'

// x402 (optional)
import { paymentMiddleware } from '@x402/express'
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
import { registerExactEvmScheme } from '@x402/evm/exact/server'
import { registerExactSvmScheme } from '@x402/svm/exact/server'

const PORT = Number(process.env.PORT || 5195)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const STATE_PATH = process.env.STATE_PATH || path.join(DATA_DIR, 'state.json')

// Fee configuration (display + payout logic later)
const FEE_WALLET = (process.env.FEE_WALLET || '').trim()
const PROJECT_FEE_BPS = Number(process.env.PROJECT_FEE_BPS || 400) // 4%

/** @typedef {{ id: string, name: string, createdAt: string }} Agent */
/** @typedef {{ t: string, type: string, message: string }} MatchEvent */
/** @typedef {{ id: string, status: 'idle'|'running'|'complete', agents: string[], winnerId?: string, startedAt?: string, endedAt?: string, events: MatchEvent[] }} Match */

function now() {
  return new Date().toISOString()
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw)

    const season = parsed.season && typeof parsed.season === 'object' ? parsed.season : {}
    const allTime = parsed.allTime && typeof parsed.allTime === 'object' ? parsed.allTime : {}

    return {
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      currentMatchId: typeof parsed.currentMatchId === 'string' ? parsed.currentMatchId : null,

      // x402 / tournament pools (very early WIP)
      tournaments: Array.isArray(parsed.tournaments) ? parsed.tournaments : [],
      credits: parsed.credits && typeof parsed.credits === 'object' ? parsed.credits : {},

      // Stats
      season: {
        number: Number.isFinite(season.number) ? season.number : (typeof season.number === 'number' ? season.number : 1),
        id: typeof season.id === 'string' ? season.id : `run-${nanoid(6)}`,
        startedAt: typeof season.startedAt === 'string' ? season.startedAt : now(),
        wins: season.wins && typeof season.wins === 'object' ? season.wins : {},
        played: season.played && typeof season.played === 'object' ? season.played : {},
      },
      allTime: {
        wins: allTime.wins && typeof allTime.wins === 'object' ? allTime.wins : {},
        played: allTime.played && typeof allTime.played === 'object' ? allTime.played : {},
      },
    }
  } catch {
    return {
      agents: [],
      matches: [],
      currentMatchId: null,

      tournaments: [],
      credits: {},

      season: { number: 1, id: `run-${nanoid(6)}`, startedAt: now(), wins: {}, played: {} },
      allTime: { wins: {}, played: {} },
    }
  }
}

let state = loadState()
let saveTimer = null
function saveStateSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      ensureDir(path.dirname(STATE_PATH))
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
    } catch (e) {
      console.error('Failed to save state:', e)
    }
  }, 250)
}

function getCurrentMatch() {
  if (!state.currentMatchId) return null
  return state.matches.find((m) => m.id === state.currentMatchId) || null
}

function snapshot() {
  const currentMatch = getCurrentMatch()
  return {
    agents: state.agents,
    tournaments: state.tournaments || [],
    credits: state.credits || {},
    fees: {
      projectFeeBps: Number.isFinite(PROJECT_FEE_BPS) ? PROJECT_FEE_BPS : 400,
      feeWallet: FEE_WALLET || null,
    },
    currentMatch,
    recentMatches: state.matches.slice(-10).reverse(),
    serverTime: now(),
    season: state.season,
    allTime: state.allTime,
  }
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '256kb' }))

// Serve skill files (moltbook-style)
app.use(express.static(new URL('./public/', import.meta.url).pathname))

// Serve the built web UI when running single-service.
// In Dockerfile.single we copy Vite output to /app/dist.
const DIST_DIR = process.env.DIST_DIR || path.join(process.cwd(), 'dist')
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
}

// ---- security defaults ----
const JWT_SECRET = (process.env.ARENA_JWT_SECRET || process.env.JWT_SECRET || '').trim()
const jwtRequired = (req, res, next) => {
  if (!JWT_SECRET) return res.status(500).json({ ok: false, error: 'server missing JWT secret' })
  const auth = (req.headers.authorization || '').toString()
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : ''
  if (!token) return res.status(401).json({ ok: false, error: 'jwt required' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    return next()
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid jwt' })
  }
}

// Rate limits (tighten later)
const authLimiter = rateLimit({ windowMs: 60_000, max: 30 })
const writeLimiter = rateLimit({ windowMs: 60_000, max: 120 })

// ---- x402 setup (optional) ----
// Enable by setting X402_ENABLED=1 and configuring:
// - X402_PAY_TO: your receiving wallet address (EVM)
// - X402_NETWORK: CAIP-2 network (default Base Sepolia: eip155:84532)
// - X402_ENTRY_PRICE: entry fee in dollars string (default "$5")
// - X402_FACILITATOR_URL: default https://x402.org/facilitator (testnet)
const X402_ENABLED = (process.env.X402_ENABLED || '').trim() === '1'
const X402_PAY_TO = (process.env.X402_PAY_TO || '').trim()
const X402_NETWORK = (process.env.X402_NETWORK || 'eip155:84532').trim()
const X402_ENTRY_PRICE = (process.env.X402_ENTRY_PRICE || '$5').trim()
const X402_FACILITATOR_URL = (process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator').trim()

let x402Server = null
if (X402_ENABLED) {
  if (!X402_PAY_TO) {
    console.warn('[x402] X402_ENABLED=1 but X402_PAY_TO is not set; x402 will be disabled')
  } else {
    const facilitatorClient = new HTTPFacilitatorClient({ url: X402_FACILITATOR_URL })
    x402Server = new x402ResourceServer(facilitatorClient)

    // Register schemes based on network family.
    // - EVM: eip155:<chainId>
    // - Solana (SVM): solana:<chainId> (mainnet: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)
    if (X402_NETWORK.startsWith('solana:')) {
      registerExactSvmScheme(x402Server)
    } else {
      registerExactEvmScheme(x402Server)
    }

    // Require payment to enter the tournament pool.
    // NOTE: This is currently a single fixed-price entry. We'll generalize to arena types next.
    app.use(
      paymentMiddleware(
        {
          'POST /api/tournament-enter': {
            accepts: [
              {
                scheme: 'exact',
                price: X402_ENTRY_PRICE,
                network: X402_NETWORK,
                payTo: X402_PAY_TO,
              },
            ],
            description: 'Enter a clawosseum tournament (one-time entry fee).',
            mimeType: 'application/json',
          },
        },
        x402Server,
      ),
    )

    console.log(`[x402] enabled: facilitator=${X402_FACILITATOR_URL} network=${X402_NETWORK} price=${X402_ENTRY_PRICE}`)
  }
}

app.get('/health', (_req, res) => res.json({ ok: true }))
app.get('/api/state', (_req, res) => res.json(snapshot()))

// SPA fallback (web UI)
app.get('/', (_req, res) => {
  const p = path.join(DIST_DIR, 'index.html')
  if (fs.existsSync(p)) return res.sendFile(p)
  return res.status(404).send('missing dist/index.html')
})

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/health' || req.path === '/ws') return next()
  const p = path.join(DIST_DIR, 'index.html')
  if (fs.existsSync(p)) return res.sendFile(p)
  return next()
})

// --- v1 API (stable-ish) ---
app.post('/api/v1/auth/register', authLimiter, (req, res) => {
  if (!JWT_SECRET) return res.status(500).json({ ok: false, error: 'server missing JWT secret' })
  const name = (req.body?.name || '').toString().trim()
  if (!name || name.length > 64) return res.status(400).json({ ok: false, error: 'name required (<=64 chars)' })

  // NOTE: for now, registration is permissionless. For production, add human-claim / allowlists.
  const token = jwt.sign({ sub: name, name }, JWT_SECRET, { expiresIn: '30d' })
  res.json({ ok: true, token, agent: { id: name.toLowerCase(), name } })
})

app.get('/api/agents', (_req, res) => {
  res.json({ ok: true, agents: state.agents })
})

// ---- tournaments (WIP) ----
app.get('/api/tournaments', (_req, res) => {
  res.json({ ok: true, tournaments: state.tournaments || [] })
})

app.post('/api/tournaments', writeLimiter, jwtRequired, (req, res) => {
  const name = (req.body?.name || '').toString().trim() || `Tournament ${nanoid(4)}`
  const maxParticipants = Number(req.body?.maxParticipants || 10)
  const entryPrice = (req.body?.entryPrice || X402_ENTRY_PRICE || '$5').toString().trim()
  const network = (req.body?.network || X402_NETWORK || 'eip155:84532').toString().trim()

  if (!Number.isFinite(maxParticipants) || maxParticipants < 2 || maxParticipants > 128) {
    return res.status(400).json({ ok: false, error: 'maxParticipants must be 2..128' })
  }

  const t = {
    id: nanoid(10),
    name,
    status: 'open', // open|locked|complete
    createdAt: now(),
    entryPrice,
    network,
    maxParticipants,
    participants: [],
    potCents: 0,
    winnerId: null,
  }

  state.tournaments.push(t)
  saveStateSoon()
  broadcast({ type: 'state', payload: snapshot() })
  res.json({ ok: true, tournament: t })
})

// Paid endpoint (x402 middleware enforces payment when enabled)
app.post('/api/tournament-enter', writeLimiter, jwtRequired, (req, res) => {
  const tournamentId = (req.body?.tournamentId || '').toString().trim()
  const agentId = (req.body?.agentId || '').toString().trim()
  if (!tournamentId) return res.status(400).json({ ok: false, error: 'tournamentId required' })
  if (!agentId) return res.status(400).json({ ok: false, error: 'agentId required' })

  const t = state.tournaments.find((x) => x.id === tournamentId)
  if (!t) return res.status(404).json({ ok: false, error: 'tournament not found' })
  if (t.status !== 'open') return res.status(409).json({ ok: false, error: 'tournament not open' })

  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return res.status(404).json({ ok: false, error: 'agent not found' })

  if (t.participants.includes(agentId)) {
    return res.json({ ok: true, tournament: t, joined: true, already: true })
  }
  if (t.participants.length >= t.maxParticipants) {
    return res.status(409).json({ ok: false, error: 'tournament is full' })
  }

  t.participants.push(agentId)

  // Very rough accounting: parse "$5" into cents, no decimals.
  const m = /^\$?(\d+)(?:\.(\d{1,2}))?$/.exec(String(t.entryPrice || ''))
  if (m) {
    const dollars = Number(m[1] || 0)
    const cents = Number((m[2] || '').padEnd(2, '0') || 0)
    t.potCents = Number(t.potCents || 0) + (dollars * 100 + cents)
  }

  // auto-lock when full
  if (t.participants.length >= t.maxParticipants) t.status = 'locked'

  saveStateSoon()
  broadcast({ type: 'state', payload: snapshot() })
  res.json({ ok: true, tournament: t, joined: true })
})

// JWT is required for POST endpoints (see jwtRequired middleware).

app.post('/api/agents', writeLimiter, jwtRequired, (req, res) => {
  const name = (req.body?.name || '').toString().trim()
  if (!name || name.length > 64) return res.status(400).json({ ok: false, error: 'name required (<=64 chars)' })

  const existing = state.agents.find((a) => a.name.toLowerCase() === name.toLowerCase())
  if (existing) return res.json({ ok: true, agent: existing, existed: true })

  /** @type {Agent} */
  const agent = { id: nanoid(10), name, createdAt: now() }
  state.agents.push(agent)
  saveStateSoon()
  broadcast({ type: 'agents', payload: state.agents })
  broadcast({ type: 'state', payload: snapshot() })
  res.json({ ok: true, agent })
})

// New stable endpoint: JWT-secured join
app.post('/api/v1/arena/join', writeLimiter, jwtRequired, (req, res) => {
  const name = (req.body?.name || req.user?.name || '').toString().trim()
  if (!name || name.length > 64) return res.status(400).json({ ok: false, error: 'name required (<=64 chars)' })

  const existing = state.agents.find((a) => a.name.toLowerCase() === name.toLowerCase())
  if (existing) return res.json({ ok: true, agent: existing, existed: true })

  const agent = { id: nanoid(10), name, createdAt: now() }
  state.agents.push(agent)
  saveStateSoon()
  broadcast({ type: 'agents', payload: state.agents })
  broadcast({ type: 'state', payload: snapshot() })
  res.json({ ok: true, agent })
})

app.post('/api/matches/start', writeLimiter, jwtRequired, (req, res) => {
  const aId = (req.body?.aId || '').toString().trim()
  const bId = (req.body?.bId || '').toString().trim()

  const ids = [aId, bId].filter(Boolean)
  let pickedIds = ids

  if (pickedIds.length === 0) {
    if (state.agents.length < 2) return res.status(400).json({ ok: false, error: 'need at least 2 agents' })
    // pick 2 random
    const shuffled = [...state.agents].sort(() => Math.random() - 0.5)
    pickedIds = [shuffled[0].id, shuffled[1].id]
  }

  if (pickedIds.length !== 2 || pickedIds[0] === pickedIds[1]) {
    return res.status(400).json({ ok: false, error: 'provide two different agent ids' })
  }

  const a = state.agents.find((x) => x.id === pickedIds[0])
  const b = state.agents.find((x) => x.id === pickedIds[1])
  if (!a || !b) return res.status(404).json({ ok: false, error: 'agent id not found' })

  const current = getCurrentMatch()
  if (current && current.status === 'running') {
    return res.status(409).json({ ok: false, error: 'a match is already running', currentMatch: current })
  }

  /** @type {Match} */
  const match = {
    id: nanoid(12),
    status: 'running',
    agents: [a.id, b.id],
    startedAt: now(),
    events: [
      { t: now(), type: 'start', message: `Match started: ${a.name} vs ${b.name}` },
      { t: now(), type: 'announce', message: 'The gates open. The crowd roars.' },
    ],
  }

  state.matches.push(match)
  state.currentMatchId = match.id
  saveStateSoon()

  broadcast({ type: 'match', payload: match })
  broadcast({ type: 'state', payload: snapshot() })

  // auto-resolve after a short delay (prototype)
  const resolveMs = Number(req.body?.resolveMs || 6500)
  setTimeout(() => resolveMatch(match.id), Math.max(1200, Math.min(resolveMs, 60000)))

  res.json({ ok: true, match })
})

app.post('/api/season/reset', writeLimiter, jwtRequired, (req, res) => {

  const old = state.season
  const nextNumber = (Number(old?.number) || 1) + 1
  state.season = {
    number: nextNumber,
    id: `run-${nanoid(6)}`,
    startedAt: now(),
    wins: {},
    played: {},
  }

  saveStateSoon()
  broadcast({ type: 'season', payload: state.season })
  broadcast({ type: 'state', payload: snapshot() })

  res.json({ ok: true, season: state.season, previous: old })
})

app.post('/api/matches/:id/resolve', writeLimiter, jwtRequired, (req, res) => {
  const id = req.params.id
  const winnerId = req.body?.winnerId ? String(req.body.winnerId) : undefined
  const out = resolveMatch(id, winnerId)
  if (!out.ok) return res.status(out.status).json(out)
  res.json(out)
})

function inc(obj, key, n = 1) {
  if (!key) return
  const k = String(key)
  obj[k] = (Number(obj[k]) || 0) + n
}

function resolveMatch(matchId, forcedWinnerId) {
  const match = state.matches.find((m) => m.id === matchId)
  if (!match) return { ok: false, status: 404, error: 'match not found' }
  if (match.status !== 'running') return { ok: true, match, already: true }

  const [aId, bId] = match.agents
  const a = state.agents.find((x) => x.id === aId)
  const b = state.agents.find((x) => x.id === bId)

  const winnerId = forcedWinnerId && match.agents.includes(forcedWinnerId)
    ? forcedWinnerId
    : (Math.random() < 0.5 ? aId : bId)

  const loserId = winnerId === aId ? bId : aId
  const winnerName = (winnerId === aId ? a?.name : b?.name) || winnerId
  const loserName = (loserId === aId ? a?.name : b?.name) || loserId

  match.status = 'complete'
  match.winnerId = winnerId
  match.endedAt = now()

  // Stats: played + wins (season + all-time)
  inc(state.season.played, aId)
  inc(state.season.played, bId)
  inc(state.allTime.played, aId)
  inc(state.allTime.played, bId)
  inc(state.season.wins, winnerId)
  inc(state.allTime.wins, winnerId)
  match.events.push({ t: now(), type: 'clash', message: 'Steel meets steel. Sand sprays.' })
  match.events.push({ t: now(), type: 'result', message: `${winnerName} defeats ${loserName}. The loser perishes.` })

  // narrative mechanic: remove losing agent from roster (optional)
  const permaDeath = String(process.env.ARENA_PERMADEATH || '1') !== '0'
  if (permaDeath) {
    state.agents = state.agents.filter((x) => x.id !== loserId)
    match.events.push({ t: now(), type: 'death', message: `${loserName} has been removed from the roster.` })
  }

  // clear current match
  if (state.currentMatchId === match.id) state.currentMatchId = null

  saveStateSoon()
  broadcast({ type: 'match', payload: match })
  broadcast({ type: 'agents', payload: state.agents })
  broadcast({ type: 'state', payload: snapshot() })

  return { ok: true, match }
}

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

/** @type {Set<import('ws').WebSocket>} */
const sockets = new Set()

function broadcast(msg) {
  const payload = JSON.stringify({ ...msg, t: now() })
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(payload)
  }
}

wss.on('connection', (ws) => {
  sockets.add(ws)
  ws.send(JSON.stringify({ type: 'state', payload: snapshot(), t: now() }))
  ws.on('close', () => sockets.delete(ws))
})

server.listen(PORT, '0.0.0.0', () => {
  ensureDir(DATA_DIR)
  console.log(`clawosseum-api listening on :${PORT}`)
})
