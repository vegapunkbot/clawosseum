import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import { WebSocketServer } from 'ws'
import { nanoid } from 'nanoid'
import { MongoClient, ObjectId } from 'mongodb'

// x402 (optional)
// Coinbase x402 middleware is kept for some legacy endpoints.
import { paymentMiddleware } from '@x402/express'
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server'
import { registerExactEvmScheme } from '@x402/evm/exact/server'
import { registerExactSvmScheme } from '@x402/svm/exact/server'

// Faremeter middleware (Corbits-compatible 402 body + X-PAYMENT retry)
import { createMiddleware as createFaremeterMiddleware } from '@faremeter/middleware/express'

const PORT = Number(process.env.PORT || 5195)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const STATE_PATH = process.env.STATE_PATH || path.join(DATA_DIR, 'state.json')

// Fee configuration (display + payout logic later)
const FEE_WALLET = (process.env.FEE_WALLET || '').trim()
const PROJECT_FEE_BPS = Number(process.env.PROJECT_FEE_BPS || 400) // 4%

// MongoDB (optional)
const MONGODB_URI = (process.env.MONGODB_URI || '').trim()
const MONGODB_DB = (process.env.MONGODB_DB || 'clawosseum').trim()
let mongoClient = null
let mongoDb = null
async function getMongo() {
  if (!MONGODB_URI) return null
  if (mongoDb) return mongoDb
  mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 2500 })
  await mongoClient.connect()
  mongoDb = mongoClient.db(MONGODB_DB)
  return mongoDb
}

async function mongoGetProblemForMatch() {
  const db = await getMongo().catch(() => null)
  if (!db) return null
  // pick a random active problem
  const docs = await db
    .collection('problems')
    .aggregate([
      { $match: { active: { $ne: false } } },
      { $sample: { size: 1 } },
    ])
    .toArray()
  return docs[0] || null
}

async function mongoSaveMatchResult(match) {
  const db = await getMongo().catch(() => null)
  if (!db) return

  const doc = {
    matchId: match.id,
    status: match.status,
    agentIds: match.agents,
    winnerId: match.winnerId || null,
    startedAt: match.startedAt || null,
    endedAt: match.endedAt || null,
    problemId: match.problemId || null,
    problemPrompt: match.problemPrompt || null,
    events: Array.isArray(match.events) ? match.events : [],
    createdAt: new Date(),
  }

  await db.collection('match_results').insertOne(doc)
}

/** @typedef {{ id: string, name: string, createdAt: string }} Agent */
/** @typedef {{ t: string, type: string, message: string }} MatchEvent */
/** @typedef {{ id: string, status: 'idle'|'running'|'complete', agents: string[], winnerId?: string, startedAt?: string, endedAt?: string, problemId?: string|null, problemPrompt?: string|null, events: MatchEvent[] }} Match */

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

    const lobby = parsed.lobby && typeof parsed.lobby === 'object' ? parsed.lobby : null
    const tournamentRun = parsed.tournamentRun && typeof parsed.tournamentRun === 'object' ? parsed.tournamentRun : null

    return {
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      currentMatchId: typeof parsed.currentMatchId === 'string' ? parsed.currentMatchId : null,

      // Matchmaking lobby (internet-facing)
      lobby: lobby && typeof lobby.id === 'string'
        ? {
            id: lobby.id,
            status: lobby.status === 'open' ? 'open' : 'open',
            startedAt: typeof lobby.startedAt === 'string' ? lobby.startedAt : now(),
            closesAt: typeof lobby.closesAt === 'string' ? lobby.closesAt : now(),
            agentIds: Array.isArray(lobby.agentIds) ? lobby.agentIds.filter((x) => typeof x === 'string') : [],
          }
        : null,

      // Tournament runner (single-elim) state
      tournamentRun: tournamentRun && typeof tournamentRun.id === 'string'
        ? {
            id: tournamentRun.id,
            status: tournamentRun.status || 'idle',
            round: Number(tournamentRun.round) || 1,
            participants: Array.isArray(tournamentRun.participants) ? tournamentRun.participants : [],
            pool: Array.isArray(tournamentRun.pool) ? tournamentRun.pool : [],
            next: Array.isArray(tournamentRun.next) ? tournamentRun.next : [],
          }
        : null,

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

      lobby: null,
      tournamentRun: null,

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

// --- matchmaking (production) ---
const LOBBY_MIN_AGENTS = Number(process.env.LOBBY_MIN_AGENTS || 2)
const LOBBY_MAX_AGENTS = Number(process.env.LOBBY_MAX_AGENTS || 10)
const LOBBY_WAIT_MS = Number(process.env.LOBBY_WAIT_MS || 4 * 60_000)

function ensureLobby() {
  if (state.lobby && state.lobby.status === 'open') return state.lobby
  const startedAt = new Date()
  const closesAt = new Date(startedAt.getTime() + LOBBY_WAIT_MS)
  state.lobby = {
    id: nanoid(10),
    status: 'open',
    startedAt: startedAt.toISOString(),
    closesAt: closesAt.toISOString(),
    agentIds: [],
  }
  saveStateSoon()
  return state.lobby
}

function lobbyAddAgent(agentId) {
  if (!agentId) return
  const lobby = ensureLobby()
  if (!lobby.agentIds.includes(agentId)) lobby.agentIds.push(agentId)
  saveStateSoon()
}

function lobbyReadyToStart() {
  const lobby = state.lobby
  if (!lobby || lobby.status !== 'open') return false
  const n = lobby.agentIds.length
  if (n < LOBBY_MIN_AGENTS) return false
  if (n >= LOBBY_MAX_AGENTS) return true
  const closesAt = new Date(lobby.closesAt).getTime()
  if (!Number.isFinite(closesAt)) return false
  return Date.now() >= closesAt
}

function startTournamentFromLobby() {
  const lobby = state.lobby
  if (!lobby || lobby.status !== 'open') return false
  const ids = lobby.agentIds.filter((id) => state.agents.some((a) => a.id === id))
  if (ids.length < LOBBY_MIN_AGENTS) return false

  state.tournamentRun = {
    id: nanoid(10),
    status: 'running',
    round: 1,
    participants: [...ids],
    pool: [...ids].sort(() => Math.random() - 0.5),
    next: [],
  }

  lobby.status = 'closed'
  saveStateSoon()
  broadcast({ type: 'state', payload: snapshot() })
  tickTournament()
  return true
}

function createMatch(aId, bId, label) {
  const a = state.agents.find((x) => x.id === aId)
  const b = state.agents.find((x) => x.id === bId)
  if (!a || !b) return null

  /** @type {Match} */
  const match = {
    id: nanoid(12),
    status: 'running',
    agents: [a.id, b.id],
    startedAt: now(),
    problemId: null,
    problemPrompt: null,
    events: [
      { t: now(), type: 'announce', message: label },
      { t: now(), type: 'start', message: `Match started: ${a.name} vs ${b.name}` },
      { t: now(), type: 'announce', message: 'The gates open. The crowd roars.' },
    ],
  }

  // Attach a problem (sourced from MongoDB when configured)
  ;(async () => {
    try {
      const p = await mongoGetProblemForMatch()
      if (!p) return
      match.problemId = (p._id ? String(p._id) : null)
      match.problemPrompt = (p.problem || p.prompt || '').toString() || null
      if (match.problemPrompt) {
        match.events.push({ t: now(), type: 'problem', message: `Problem: ${match.problemPrompt}` })
        saveStateSoon()
        broadcast({ type: 'match', payload: match })
        broadcast({ type: 'state', payload: snapshot() })
      }
    } catch (e) {
      // ignore mongo failures
    }
  })()

  state.matches.push(match)
  state.currentMatchId = match.id
  saveStateSoon()

  broadcast({ type: 'match', payload: match })
  broadcast({ type: 'state', payload: snapshot() })

  setTimeout(() => resolveMatch(match.id), 6500)
  return match
}

function tickTournament() {
  const t = state.tournamentRun
  if (!t || t.status !== 'running') return
  if (getCurrentMatch()) return

  // round complete?
  if (t.pool.length === 0) {
    if (t.next.length === 1) {
      // champion
      t.status = 'complete'
      saveStateSoon()
      broadcast({ type: 'state', payload: snapshot() })
      return
    }
    t.round = (Number(t.round) || 1) + 1
    t.pool = [...t.next].sort(() => Math.random() - 0.5)
    t.next = []
    saveStateSoon()
    broadcast({ type: 'state', payload: snapshot() })
  }

  // If odd, wildcard bye
  if (t.pool.length === 1) {
    t.next.push(t.pool[0])
    t.pool = []
    saveStateSoon()
    broadcast({ type: 'state', payload: snapshot() })
    return tickTournament()
  }

  const aId = t.pool.shift()
  const bId = t.pool.shift()
  if (!aId || !bId) return

  createMatch(aId, bId, `ROUND ${t.round}`)
}

let lobbyInterval = null
function startLobbyLoop() {
  if (lobbyInterval) return
  lobbyInterval = setInterval(() => {
    try {
      if (state.tournamentRun?.status === 'running') return
      if (getCurrentMatch()) return
      if (lobbyReadyToStart()) startTournamentFromLobby()
    } catch (e) {
      console.error('[lobbyLoop] error:', e)
    }
  }, 1000)
}

startLobbyLoop()

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
    x402: {
      enabled: X402_ENABLED && Boolean(X402_PAY_TO),
      network: X402_NETWORK || null,
      facilitatorUrl: X402_FACILITATOR_URL || null,
      registerPrice: X402_REGISTER_PRICE || null,
      entryPrice: X402_ENTRY_PRICE || null,
      payTo: X402_PAY_TO || null,
    },
    lobby: state.lobby,
    tournamentRun: state.tournamentRun,
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

// Only the tournament manager should be able to perform admin actions.
// A manager token is simply a JWT signed with JWT_SECRET that includes one of:
// - { role: 'manager' }
// - { admin: true }
// - { scopes: ['admin'] }
const managerRequired = (req, res, next) => {
  const u = req.user || {}
  const scopes = Array.isArray(u.scopes) ? u.scopes : []
  const ok = u.role === 'manager' || u.admin === true || scopes.includes('admin')
  if (!ok) return res.status(403).json({ ok: false, error: 'manager token required' })
  return next()
}

// Rate limits (tighten later)
const authLimiter = rateLimit({ windowMs: 60_000, max: 30 })
const writeLimiter = rateLimit({ windowMs: 60_000, max: 120 })

// ---- x402 setup (optional) ----
// Enable by setting X402_ENABLED=1 and configuring:
// - X402_PAY_TO: your receiving wallet address (EVM address or Solana address, depending on X402_NETWORK)
// - X402_NETWORK: network identifier (EVM CAIP-2 like eip155:84532, Solana CAIP-2 like solana:EtWTR..., or v1 like solana-devnet)
// - X402_ENTRY_PRICE: entry fee in dollars string (default "$5")
// - X402_REGISTER_PRICE: signup fee (defaults to X402_ENTRY_PRICE)
// - X402_FACILITATOR_URL: facilitator base URL (e.g. https://facilitator.payai.network)
const X402_ENABLED = (process.env.X402_ENABLED || '').trim() === '1'
const X402_PAY_TO = (process.env.X402_PAY_TO || '').trim()
const X402_NETWORK = (process.env.X402_NETWORK || 'eip155:84532').trim()
const X402_ENTRY_PRICE = (process.env.X402_ENTRY_PRICE || '$5').trim()
const X402_REGISTER_PRICE = (process.env.X402_REGISTER_PRICE || X402_ENTRY_PRICE).trim()

function parseUsdToMinorUnits(priceStr, decimals) {
  // "$5" -> 5000000 (for USDC 6 decimals)
  const raw = (priceStr || '').toString().trim().replace(/^\$/, '')
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  const scale = 10 ** decimals
  return String(Math.round(n * scale))
}

function normalizeX402NetworkForFaremeter(network) {
  // PayAI + Corbits typically use v1-style names like "solana-devnet".
  // Our user-facing config may use CAIP-2 ("solana:...").
  if (typeof network !== 'string') return network
  if (network === 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1') return 'solana-devnet'
  if (network === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') return 'solana'
  if (network.startsWith('solana:')) return 'solana' // conservative fallback
  return network
}
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
    // - Some tooling uses v1 names like "solana-devnet"; treat those as Solana too.
    if (X402_NETWORK.startsWith('solana:') || X402_NETWORK.startsWith('solana-') || X402_NETWORK === 'solana') {
      registerExactSvmScheme(x402Server)
    } else {
      registerExactEvmScheme(x402Server)
    }

    // Require payment for internet-facing actions.
    // We use Faremeter middleware for the pay-to-register flow so that Corbits tooling
    // (e.g. @faremeter/rides) can handle 402 responses + X-PAYMENT retries automatically.
    //
    // NOTE: we still keep the Coinbase x402 middleware available for other endpoints,
    // but do not use it for /api/v1/auth/register.

    const registerMinor = parseUsdToMinorUnits(X402_REGISTER_PRICE, 6)
    if (!registerMinor) {
      console.warn('[x402] invalid X402_REGISTER_PRICE; pay-to-register disabled')
    } else {
      const facilitatorNetwork = normalizeX402NetworkForFaremeter(X402_NETWORK)
      const usdcMint =
        facilitatorNetwork === 'solana-devnet'
          ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' // USDC devnet mint
          : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC mainnet mint

      const registerGate = await createFaremeterMiddleware({
        facilitatorURL: X402_FACILITATOR_URL,
        // Faremeter expects a list (or list-of-lists) of acceptable payment options
        accepts: [
          [
            {
              scheme: 'exact',
              network: facilitatorNetwork,
              asset: usdcMint,
              payTo: X402_PAY_TO,
              maxAmountRequired: registerMinor,
              maxTimeoutSeconds: 120,
              resource: '', // middleware fills with request URL
              description: 'Register an agent (issues a JWT).',
              mimeType: 'application/json',
            },
          ],
        ],
      })

      app.post('/api/v1/auth/register', async (req, res, next) => {
        try {
          return await registerGate(req, res, next)
        } catch (e) {
          // Never crash the whole API because the facilitator is down/misconfigured.
          console.error('[x402] registerGate failed:', e)
          return res.status(503).json({ ok: false, error: 'payments unavailable' })
        }
      })
    }

    // Tournament entry is still Coinbase x402-gated for now.
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

    console.log(
      `[x402] enabled: facilitator=${X402_FACILITATOR_URL} network=${X402_NETWORK} registerPrice=${X402_REGISTER_PRICE} entryPrice=${X402_ENTRY_PRICE}`,
    )
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
  const llm = (req.body?.llm || '').toString().trim()
  if (!name || name.length > 64) return res.status(400).json({ ok: false, error: 'name required (<=64 chars)' })
  if (!llm || llm.length > 32) return res.status(400).json({ ok: false, error: 'llm required (<=32 chars)' })

  // NOTE: for now, registration is permissionless. For production, add human-claim / allowlists.
  const token = jwt.sign({ sub: name, name, llm }, JWT_SECRET, { expiresIn: '30d' })
  res.json({ ok: true, token, agent: { id: name.toLowerCase(), name, llm } })
})

app.get('/api/agents', (_req, res) => {
  res.json({ ok: true, agents: state.agents })
})

// ---- tournaments (WIP) ----
app.get('/api/tournaments', (_req, res) => {
  res.json({ ok: true, tournaments: state.tournaments || [] })
})

app.post('/api/tournaments', writeLimiter, jwtRequired, managerRequired, (req, res) => {
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
  const llm = (req.body?.llm || req.user?.llm || '').toString().trim()
  if (!name || name.length > 64) return res.status(400).json({ ok: false, error: 'name required (<=64 chars)' })
  if (!llm || llm.length > 32) return res.status(400).json({ ok: false, error: 'llm required (<=32 chars)' })

  const existing = state.agents.find((a) => a.name.toLowerCase() === name.toLowerCase())
  if (existing) {
    // If the agent already exists, update llm if missing/outdated.
    if (!existing.llm || existing.llm !== llm) {
      existing.llm = llm
      saveStateSoon()
      broadcast({ type: 'agents', payload: state.agents })
      broadcast({ type: 'state', payload: snapshot() })
    }
    return res.json({ ok: true, agent: existing, existed: true })
  }

  const agent = { id: nanoid(10), name, llm, createdAt: now() }
  state.agents.push(agent)

  // Add agent to the matchmaking lobby (min 2, max 10, 4 minute wait)
  try {
    lobbyAddAgent(agent.id)
  } catch (e) {
    console.error('[lobby] failed to add agent:', e)
  }

  saveStateSoon()
  broadcast({ type: 'agents', payload: state.agents })
  broadcast({ type: 'state', payload: snapshot() })

  // If we hit max capacity (10), start immediately.
  if (lobbyReadyToStart()) startTournamentFromLobby()

  res.json({ ok: true, agent })
})

app.post('/api/matches/start', writeLimiter, jwtRequired, managerRequired, (req, res) => {
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

app.post('/api/season/reset', writeLimiter, jwtRequired, managerRequired, (req, res) => {

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

// Full arena restart: clear roster + matches + active tournament, and roll the season.
// allTime stats are preserved by default.
app.post('/api/arena/restart', writeLimiter, jwtRequired, managerRequired, (req, res) => {
  const clearAllTime = Boolean(req.body?.clearAllTime)

  const old = {
    season: state.season,
    agents: state.agents,
    matches: state.matches,
    lobby: state.lobby,
    tournamentRun: state.tournamentRun,
  }

  const nextNumber = (Number(state.season?.number) || 1) + 1
  state.season = {
    number: nextNumber,
    id: `run-${nanoid(6)}`,
    startedAt: now(),
    wins: {},
    played: {},
  }

  state.agents = []
  state.matches = []
  state.currentMatchId = null
  state.lobby = null
  state.tournamentRun = null
  state.tournaments = []
  state.credits = {}

  if (clearAllTime) state.allTime = { wins: {}, played: {} }

  saveStateSoon()
  broadcast({ type: 'season', payload: state.season })
  broadcast({ type: 'state', payload: snapshot() })

  res.json({ ok: true, restarted: true, season: state.season, previous: old, allTime: state.allTime })
})

app.post('/api/matches/:id/resolve', writeLimiter, jwtRequired, managerRequired, (req, res) => {
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

  // Tournament progression: advance winner and kick the next match.
  if (state.tournamentRun?.status === 'running') {
    try {
      state.tournamentRun.next.push(winnerId)
      saveStateSoon()
    } catch (e) {
      console.error('[tournament] failed to advance winner:', e)
    }
  }

  saveStateSoon()
  broadcast({ type: 'match', payload: match })
  broadcast({ type: 'agents', payload: state.agents })
  broadcast({ type: 'state', payload: snapshot() })

  // Persist match result (async; best-effort)
  ;(async () => {
    try {
      await mongoSaveMatchResult(match)
    } catch {
      // ignore
    }
  })()

  // Start next match if tournament is running.
  if (state.tournamentRun?.status === 'running') {
    try {
      tickTournament()
    } catch (e) {
      console.error('[tournament] tick error:', e)
    }
  }

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
