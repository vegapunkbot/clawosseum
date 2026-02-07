#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { Connection, Keypair, PublicKey, clusterApiUrl, LAMPORTS_PER_SOL } from '@solana/web3.js'

const outDir = process.env.OUT_DIR || path.join(process.cwd(), '..', '.secrets')
const devnetRpc = process.env.SOLANA_DEVNET_RPC || clusterApiUrl('devnet')

const conn = new Connection(devnetRpc, 'confirmed')

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
  try { fs.chmodSync(p, 0o700) } catch {}
}

function saveKeypair(file, kp) {
  const arr = Array.from(kp.secretKey)
  fs.writeFileSync(file, JSON.stringify(arr), { mode: 0o600 })
}

async function airdrop(pubkey, sol) {
  try {
    const sig = await conn.requestAirdrop(pubkey, Math.round(sol * LAMPORTS_PER_SOL))
    await conn.confirmTransaction(sig, 'confirmed')
    return { ok: true, sig }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

const receiver = process.argv[2] ? new PublicKey(process.argv[2]) : null

ensureDir(outDir)

// fee payer for facilitator
const feePayer = Keypair.generate()
const feePayerPath = path.join(outDir, 'faremeter_fee_payer.json')
saveKeypair(feePayerPath, feePayer)

// test payer (agent wallet)
const testPayer = Keypair.generate()
const testPayerPath = path.join(outDir, 'agent_test_payer.json')
saveKeypair(testPayerPath, testPayer)

console.log('Created keypairs:')
console.log(' fee payer (facilitator tx fees):', feePayer.publicKey.toBase58())
console.log('   saved:', feePayerPath)
console.log(' test payer (agent pays USDC):  ', testPayer.publicKey.toBase58())
console.log('   saved:', testPayerPath)

console.log('\nAirdropping SOL on devnet...')
const drops = []

drops.push({ who: 'feePayer', pubkey: feePayer.publicKey.toBase58(), res: await airdrop(feePayer.publicKey, 1) })
drops.push({ who: 'testPayer', pubkey: testPayer.publicKey.toBase58(), res: await airdrop(testPayer.publicKey, 0.5) })
if (receiver) drops.push({ who: 'receiver', pubkey: receiver.toBase58(), res: await airdrop(receiver, 0.5) })

for (const d of drops) {
  if (d.res.ok) console.log(` ${d.who}: airdrop ok ${d.res.sig}`)
  else {
    console.log(` ${d.who}: airdrop failed (${d.pubkey})`)
    console.log(`   ${String(d.res.error).split('\n')[0]}`)
  }
}

console.log('\nIf airdrops failed due to rate limits, fund these addresses manually:')
console.log(' fee payer:', feePayer.publicKey.toBase58())
console.log(' test payer:', testPayer.publicKey.toBase58())
if (receiver) console.log(' receiver:', receiver.toBase58())
console.log('Suggested SOL sources: https://faucet.solana.com')

const envPath = path.join(outDir, 'devnet.env')
const env = [
  `# local devnet secrets (DO NOT COMMIT)`,
  `FAREMETER_SOLANA_CLUSTER=devnet`,
  `FAREMETER_FEEPAYER_KEYPAIR_PATH=${feePayerPath}`,
  `PAYER_KEYPAIR_PATH=${testPayerPath}`,
  `SOLANA_DEVNET_RPC=${devnetRpc}`,
].join('\n') + '\n'
fs.writeFileSync(envPath, env, { mode: 0o600 })
console.log('\nWrote:', envPath)
