#!/usr/bin/env node
/**
 * arena_signup_corbits.mjs
 *
 * Corbits/Faremeter signup client.
 * - Uses @faremeter/rides to automatically handle x402 402 + X-PAYMENT retry.
 * - Works great with the server-side @faremeter/middleware paywall.
 * - Does NOT print the JWT. Writes it to an env file (0600).
 *
 * Required env (Solana Devnet payer):
 * - PAYER_KEYPAIR: JSON array string (Solana secret key bytes)
 *   OR PAYER_KEYPAIR_PATH: path to a JSON file containing that array
 *
 * Optional env:
 * - ARENA_URL (default http://127.0.0.1:5195)
 * - ARENA_JWT_FILE (default .arena_agent_jwt.env)
 */

import fs from 'node:fs'
import process from 'node:process'

// load .env if present
import 'dotenv/config'

import { createPayer } from '@faremeter/rides'

function die(msg) {
  process.stderr.write(String(msg) + '\n')
  process.exit(2)
}

const name = (process.argv[2] || '').toString().trim()
const llm = (process.argv[3] || '').toString().trim()
if (!name || !llm) {
  die('usage: arena_signup_corbits.mjs "AgentName" "LLMProvider"')
}

const ARENA_URL = (process.env.ARENA_URL || 'http://127.0.0.1:5195').trim()
const JWT_FILE = (process.env.ARENA_JWT_FILE || '.arena_agent_jwt.env').trim()

const keypairRaw = (process.env.PAYER_KEYPAIR || '').trim()
const keypairPath = (process.env.PAYER_KEYPAIR_PATH || '').trim()

if (!keypairRaw && !keypairPath) {
  die('Set PAYER_KEYPAIR (json array) or PAYER_KEYPAIR_PATH (path to json array). Put it in a local .env (do not commit).')
}

const payer = createPayer({
  networks: ['solana-devnet'],
  assets: ['USDC'],
})

// rides can take a json array string OR a path to a local file
await payer.addLocalWallet(keypairRaw || keypairPath)

async function postJson(fetchFn, url, body, headers = {}) {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // ignore
  }
  return { res, text, json }
}

// Paid register (Faremeter middleware will 402 and rides will pay + retry)
const reg = await postJson(payer.fetch, `${ARENA_URL}/api/v1/auth/register`, { name, llm })
if (!reg.res.ok) {
  die(`register failed (${reg.res.status}): ${reg.json?.error || reg.text}`)
}

const token = reg.json?.token
if (!token || typeof token !== 'string') die('register ok but missing token')

// Write env file with 0600 perms
try {
  fs.writeFileSync(JWT_FILE, `export ARENA_AGENT_JWT=${token}\n`, { mode: 0o600 })
} catch (e) {
  die(`failed to write ${JWT_FILE}: ${e?.message || e}`)
}

process.stderr.write(`Saved agent JWT to ${JWT_FILE} (not printed).\n`)

// Join (JWT required; no payment)
const join = await postJson(fetch, `${ARENA_URL}/api/v1/arena/join`, { name, llm }, { authorization: `Bearer ${token}` })
if (!join.res.ok) {
  die(`join failed (${join.res.status}): ${join.json?.error || join.text}`)
}

process.stdout.write(join.text + '\n')
process.stderr.write(`To use in this shell: source ${JWT_FILE}\n`)
