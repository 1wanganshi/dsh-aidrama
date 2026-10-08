/**
 * Link the host-provided packages this plugin imports into a workspace-local
 * node_modules, so the REAL lib/index.js can be imported by the verification
 * scripts here.
 *
 * DSH supplies `@deepseek-ai/schemastery` on the host plane; it exists in a
 * profile's node_modules and nowhere else. Without a link, `node
 * docs/verify-host.mjs` cannot import the entry at all.
 *
 * Idempotent. Junction on Windows, symlink elsewhere. Run once per checkout:
 *   node docs/link-host-deps.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const profileModules = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules')

const WANTED = ['@deepseek-ai/schemastery']

const linkDir = path.join(root, 'node_modules')
await fs.mkdir(path.join(linkDir, '@deepseek-ai'), { recursive: true })

let linked = 0
let missing = 0

for (const spec of WANTED) {
  const source = path.join(profileModules, spec)
  const target = path.join(linkDir, spec)

  const sourceExists = await fs.stat(source).then(() => true, () => false)
  if (!sourceExists) {
    console.log(`MISSING  ${spec} — not found at ${source}`)
    missing += 1
    continue
  }

  const alreadyLinked = await fs.lstat(target).then(() => true, () => false)
  if (alreadyLinked) {
    console.log(`OK       ${spec} — already linked`)
    linked += 1
    continue
  }

  try {
    // 'junction' works without elevation on Windows; a dir symlink is the POSIX path.
    await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    console.log(`LINKED   ${spec}`)
    linked += 1
  } catch (error) {
    console.log(`FAILED   ${spec} — ${error.message}`)
    missing += 1
  }
}

console.log(`\n${linked} linked, ${missing} missing`)
if (missing > 0) {
  console.log('The host entry verification needs these; install the plugin into a profile first.')
  process.exit(1)
}
console.log('Host dependencies available. Run: node docs/verify-host.mjs')
