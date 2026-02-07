import fs from 'node:fs'

import { serve } from '@hono/node-server'
import { createFacilitatorRoutes } from '@faremeter/facilitator'
import { createFacilitatorHandler as createSolanaHandler } from '@faremeter/payment-solana/exact'
import { createSolanaRpc, devnet, mainnet } from '@solana/kit'
import { Keypair, PublicKey } from '@solana/web3.js'

const PORT = Number(process.env.FAREMETER_FACILITATOR_PORT || 8788)

// Network cluster for handler
const CLUSTER = (process.env.FAREMETER_SOLANA_CLUSTER || 'devnet').trim() // devnet|mainnet-beta
const RPC_URL = (process.env.FAREMETER_SOLANA_RPC_URL || '').trim()

// Fee payer keypair (pays Solana tx fees for settlements)
// Expected JSON array of bytes (64)
const feePayerJson = (process.env.FAREMETER_FEEPAYER_KEYPAIR_JSON || '').trim()
const feePayerPath = (process.env.FAREMETER_FEEPAYER_KEYPAIR_PATH || '').trim()
if (!feePayerJson && !feePayerPath) {
  console.error('[faremeter facilitator] Set FAREMETER_FEEPAYER_KEYPAIR_JSON (JSON array of bytes) or FAREMETER_FEEPAYER_KEYPAIR_PATH (path to JSON file).')
  process.exit(1)
}

let feePayer
try {
  const raw = feePayerJson || fs.readFileSync(feePayerPath, 'utf8')
  const arr = JSON.parse(raw)
  if (!Array.isArray(arr) || arr.length < 32) throw new Error('must be an array of bytes')
  feePayer = Keypair.fromSecretKey(Uint8Array.from(arr.map((n) => Number(n))))
} catch (e) {
  console.error('[faremeter facilitator] failed to parse fee payer keypair:', e)
  process.exit(1)
}

// Mint (default devnet USDC)
const mintStr = (process.env.FAREMETER_SOLANA_MINT || '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU').trim()
const mint = new PublicKey(mintStr)

const rpc = createSolanaRpc(
  CLUSTER === 'mainnet-beta'
    ? mainnet(RPC_URL || 'https://api.mainnet-beta.solana.com')
    : devnet(RPC_URL || 'https://api.devnet.solana.com'),
)

const solanaHandler = await createSolanaHandler(CLUSTER, rpc, feePayer, mint)

const routes = createFacilitatorRoutes({
  handlers: [await solanaHandler],
  timeout: {
    getRequirements: 1500,
    getSupported: 800,
  },
})

serve({
  fetch: routes.fetch,
  port: PORT,
})

console.log(`[faremeter facilitator] listening on :${PORT} (cluster=${CLUSTER})`)
