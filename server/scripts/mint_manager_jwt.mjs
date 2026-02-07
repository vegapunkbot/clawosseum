#!/usr/bin/env node
import jwt from 'jsonwebtoken'

const secret = (process.env.ARENA_JWT_SECRET || process.env.JWT_SECRET || '').trim()
if (!secret) {
  console.error('Missing ARENA_JWT_SECRET (or JWT_SECRET)')
  process.exit(1)
}

// Usage:
//   ARENA_JWT_SECRET=... node scripts/mint_manager_jwt.mjs "The Tournament Manager" 365d
const name = (process.argv[2] || 'Tournament Manager').toString()
const expiresIn = (process.argv[3] || '365d').toString()

const token = jwt.sign(
  {
    sub: 'arena-manager',
    name,
    role: 'manager',
    scopes: ['admin'],
  },
  secret,
  { expiresIn },
)

process.stdout.write(token + '\n')
