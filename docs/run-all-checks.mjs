/**
 * Run every check in the repository.
 *
 * This is the single command a contributor (or CI) needs:
 *
 *     npm test
 *
 * It runs the structural verification suites plus the two static gates — the
 * bare-globals scanner (which caught two shipped ReferenceErrors) and the
 * secret audit (which must pass before anything is published).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

const suites = fs.readdirSync(here)
  .filter(f => f.startsWith('verify-') && f.endsWith('.mjs'))
  .sort()

const gates = ['scan-bare-globals.mjs', 'audit-secrets.mjs']

let passed = 0
const failed = []

function run(file) {
  const result = spawnSync(process.execPath, [path.join(here, file)], {
    encoding: 'utf8',
    cwd: root,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const summary = output
    .split('\n')
    .filter(l => /ALL PASS|ALL CHECKS|ALL PROMPT|LEAD PROBE|FAILURES|CLEAN|FOUND/.test(l))
    .pop() ?? ''
  const ok = result.status === 0
  if (ok) passed += 1
  else failed.push(file)
  const tag = ok ? 'ok  ' : 'FAIL'
  console.log(`  [${tag}] ${file.padEnd(30)} ${summary.trim()}`)
}

console.log(`running ${suites.length} verification suites + ${gates.length} static gates\n`)
for (const f of suites) run(f)
for (const f of gates) run(f)

const total = suites.length + gates.length
console.log(`\n${'='.repeat(60)}`)
if (failed.length === 0) {
  console.log(`ALL GREEN — ${total} checks passed`)
  process.exit(0)
}
console.log(`${passed}/${total} passed — FAILURES in: ${failed.join(', ')}`)
process.exit(1)
