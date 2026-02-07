#!/usr/bin/env node
/**
 * arena_signup_x402.mjs
 *
 * Paid agent registration helper for internet-facing deployments.
 *
 * Flow:
 * 1) POST /api/v1/auth/register
 * 2) if 402 Payment Required, use x402 client to create PAYMENT-SIGNATURE and retry
 * 3) write JWT to a local env file (default .arena_agent_jwt.env) with 0600 perms
 * 4) POST /api/v1/arena/join (JWT)
 *
 * Required env:
 * - X402_WALLET_PRIVATE_KEY (0x...)  (payer)
 * - X402_RPC_URL (EVM RPC endpoint)
 *
 * Optional env:
 * - ARENA_URL (default http://127.0.0.1:5195)
 * - ARENA_JWT_FILE / ARENA_JWT_FILE (default .arena_agent_jwt.env)
 */

import fs from 'node:fs'
import process from 'node:process'

function die(msg) {
  process.stderr.write(String(msg) + '\n')
  process.exit(2)
}

function getArg(i) {
  return (process.argv[i] || '').toString().trim()
}

const name = getArg(2)
const llm = getArg(3)
if (!name || !llm) {
  die('usage: arena_signup_paid.sh "AgentName" "LLMProvider"')
}

const ARENA_URL = (process.env.ARENA_URL || 'http://127.0.0.1:5195').trim()
const JWT_FILE = (process.env.ARENA_JWT_FILE || process.env.ARENA_JWT_FILE || '.arena_agent_jwt.env').trim()

const PRIVKEY = (process.env.X402_WALLET_PRIVATE_KEY || '').trim()
const RPC_URL = (process.env.X402_RPC_URL || '').trim()

// Note: For Solana/SVM, use X402_SVM_KEYPAIR_B64 or X402_SVM_KEYPAIR_JSON (+ optional X402_SVM_RPC_URL)
// and you do NOT need the EVM variables below.

async function readJson(res) {
  const text = await res.text()
  try {
    return { json: JSON.parse(text), text }
  } catch {
    return { json: null, text }
  }
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const payload = await readJson(res)
  return { res, ...payload }
}

async function paidRegister() {
  const url = `${ARENA_URL}/api/v1/auth/register`

  // First attempt (may 402)
  let first = await postJson(url, { name, llm })
  if (first.res.status !== 402) return first

  // x402 payment flow
  const { x402Client, x402HTTPClient } = await import('@x402/core/client')

  const prHeader = first.res.headers.get('payment-required')
  if (!prHeader) die('Server returned 402 but missing PAYMENT-REQUIRED header')

  const httpClient = new x402HTTPClient(new x402Client())
  const paymentRequired = httpClient.getPaymentRequiredResponse((h) => first.res.headers.get(h), first.json)

  const net = String(paymentRequired.accepts?.[0]?.network || '')

  // --- EVM (viem) ---
  if (net.startsWith('eip155:')) {
    const { registerExactEvmScheme } = await import('@x402/evm/exact/client')
    const { createWalletClient, createPublicClient, http } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')

    const account = privateKeyToAccount(PRIVKEY)

    // Minimal chain stub; we primarily need chainId for typed-data signing.
    const chainId = Number(net.split(':')[1])
    const chain = {
      id: Number.isFinite(chainId) ? chainId : 84532,
      name: 'x402-evm',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    }

    const walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) })
    const publicClient = createPublicClient({ chain, transport: http(RPC_URL) })

    const signer = {
      address: account.address,
      signTypedData: walletClient.signTypedData,
      // optional methods used by x402 client scheme sometimes
      readContract: publicClient.readContract,
    }

    const client = registerExactEvmScheme(x402Client.fromConfig({ schemes: [] }), { signer })
    const httpPaid = new x402HTTPClient(client)

    const paymentPayload = await httpPaid.createPaymentPayload(paymentRequired)
    const payHeaders = httpPaid.encodePaymentSignatureHeader(paymentPayload)
    return await postJson(url, { name, llm }, payHeaders)
  }

  // --- Solana / SVM ---
  if (net.startsWith('solana:') || net.startsWith('solana-')) {
    const { registerExactSvmScheme } = await import('@x402/svm/exact/client')
    const { createKeyPairSignerFromBytes } = await import('@solana/kit')

    const keyJson = (process.env.X402_SVM_KEYPAIR_JSON || '').trim()
    const keyB64 = (process.env.X402_SVM_KEYPAIR_B64 || '').trim()

    let keyBytes = null
    if (keyB64) {
      keyBytes = new Uint8Array(Buffer.from(keyB64, 'base64'))
    } else if (keyJson) {
      // Accept either a JSON array string or a path to a json file
      const raw = keyJson.startsWith('[') ? keyJson : fs.readFileSync(keyJson, 'utf8')
      const arr = JSON.parse(raw)
      if (!Array.isArray(arr)) die('X402_SVM_KEYPAIR_JSON must be a JSON array (or a file path to one)')
      keyBytes = new Uint8Array(arr)
    } else {
      die('SVM payment required: set X402_SVM_KEYPAIR_B64 or X402_SVM_KEYPAIR_JSON')
    }

    // For SVM, we don’t use X402_WALLET_PRIVATE_KEY / X402_RPC_URL.
    const signer = await createKeyPairSignerFromBytes(keyBytes)

    const client = registerExactSvmScheme(x402Client.fromConfig({ schemes: [] }), {
      signer,
      // optional: X402_SVM_RPC_URL can override devnet/testnet/mainnet default
      rpcUrl: (process.env.X402_SVM_RPC_URL || '').trim() || undefined,
    })

    const httpPaid = new x402HTTPClient(client)
    const paymentPayload = await httpPaid.createPaymentPayload(paymentRequired)
    const payHeaders = httpPaid.encodePaymentSignatureHeader(paymentPayload)

    return await postJson(url, { name, llm }, payHeaders)
  }

  die(`Unsupported x402 network in PAYMENT-REQUIRED: ${net || '(empty)'}`)
}

const reg = await paidRegister()
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

// Join
const join = await postJson(
  `${ARENA_URL}/api/v1/arena/join`,
  { name, llm },
  { authorization: `Bearer ${token}` },
)

if (!join.res.ok) {
  die(`join failed (${join.res.status}): ${join.json?.error || join.text}`)
}

process.stdout.write(join.text + '\n')
process.stderr.write(`To use in this shell: source ${JWT_FILE}\n`)
