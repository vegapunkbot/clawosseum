import express from 'express'

import { x402Facilitator } from '@x402/core/facilitator'
import { createKeyPairSignerFromBytes } from '@solana/kit'

import { registerExactSvmScheme, toFacilitatorSvmSigner } from '@x402/svm'
import { SOLANA_MAINNET_CAIP2 } from '@x402/svm'

const PORT = Number(process.env.FACILITATOR_PORT || 8787)

// Expected format: JSON array of 64 bytes (Solana secret key)
// Example: FACILITATOR_SECRET_KEY_JSON="[12,34,...]"
const secretKeyJson = (process.env.FACILITATOR_SECRET_KEY_JSON || '').trim()
if (!secretKeyJson) {
  console.error('[x402 facilitator] FACILITATOR_SECRET_KEY_JSON is required (JSON array of bytes)')
  process.exit(1)
}

/** @type {number[]} */
let secretKeyBytes
try {
  const parsed = JSON.parse(secretKeyJson)
  if (!Array.isArray(parsed) || parsed.length < 32) throw new Error('must be an array of bytes')
  secretKeyBytes = parsed.map((n) => Number(n))
  if (secretKeyBytes.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    throw new Error('invalid byte values')
  }
} catch (e) {
  console.error('[x402 facilitator] failed to parse FACILITATOR_SECRET_KEY_JSON:', e)
  process.exit(1)
}

const app = express()
app.use(express.json({ limit: '256kb' }))

const rawNetwork = (process.env.FACILITATOR_NETWORK || SOLANA_MAINNET_CAIP2).trim()
const rpcUrl = (process.env.SOLANA_RPC_URL || '').trim() || undefined

const keypair = await createKeyPairSignerFromBytes(Uint8Array.from(secretKeyBytes))
const signer = toFacilitatorSvmSigner(keypair, rpcUrl ? { defaultRpcUrl: rpcUrl } : undefined)

const facilitator = new x402Facilitator()
registerExactSvmScheme(facilitator, { signer, networks: rawNetwork })

app.get('/health', (_req, res) => res.json({ ok: true }))

app.get('/supported', async (_req, res) => {
  try {
    const supported = await facilitator.getSupported()
    res.json(supported)
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
  }
})

app.post('/verify', async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body || {}
    const result = await facilitator.verify(paymentPayload, paymentRequirements)
    res.status(result.isValid ? 200 : 402).json(result)
  } catch (e) {
    // The client expects JSON with isValid when possible.
    res.status(500).json({ isValid: false, invalidReason: e instanceof Error ? e.message : String(e), payer: '' })
  }
})

app.post('/settle', async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body || {}
    const result = await facilitator.settle(paymentPayload, paymentRequirements)
    res.status(result.success ? 200 : 402).json(result)
  } catch (e) {
    res.status(500).json({ success: false, errorReason: e instanceof Error ? e.message : String(e), transaction: '', network: rawNetwork, payer: '' })
  }
})

app.listen(PORT, () => {
  console.log(`[x402 facilitator] listening on :${PORT} (network=${rawNetwork})`)
})
