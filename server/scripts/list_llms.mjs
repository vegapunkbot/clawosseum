#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const statePath = process.env.STATE_PATH || path.join(process.cwd(), '..', 'data', 'state.json')

if (!fs.existsSync(statePath)) {
  console.error('Missing state file:', statePath)
  process.exit(2)
}

const raw = fs.readFileSync(statePath, 'utf8')
const state = JSON.parse(raw)

const llms = new Set()
for (const a of state?.agents || []) {
  if (a?.llm) llms.add(String(a.llm))
}

console.log([...llms].sort().join('\n'))
