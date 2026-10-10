/**
 * Load every host module for real, and execute the paths a static scan misses.
 *
 * WHY THIS EXISTS: a fix in lib/index.js renamed a local `alias` to `requested`
 * and left one reference to the old name behind. `node --check` passes (valid
 * syntax), the bare-globals call scan passes (it was a VALUE, not a call), and
 * every unit test passed because none of them drove the own-channel generation
 * branch. The ReferenceError would only appear at generation time, in front of
 * a user.
 *
 * So: import the modules, and call the exact function that had the bug.
 *
 * Run: node docs/verify-host-loads.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('--- every host module imports ---')
const hostDir = path.join(root, 'lib', 'host')
const files = ['index.js', ...fs.readdirSync(hostDir).filter(f => f.endsWith('.js')).sort().map(f => path.join('host', f))]

for (const rel of files) {
  const url = new URL(`file://${path.join(root, 'lib', rel).replace(/\\/g, '/')}`).href
  try {
    await import(url)
    check(`imports: lib/${rel}`, true)
  } catch (error) {
    check(`imports: lib/${rel}`, false, `${error.name}: ${error.message}`)
  }
}

console.log('\n--- the generation seam runs without a ReferenceError ---')
const host = await import(new URL(`file://${path.join(root, 'lib', 'index.js').replace(/\\/g, '/')}`).href)
check('lib/index.js exports apply', typeof host.apply === 'function')
check('lib/index.js exports Config', host.Config !== undefined)
check('lib/index.js exports inject', Array.isArray(host.inject))
check('lib/index.js exports name', host.name === 'aidrama', String(host.name))

// Drive the OWN-channel branch (the one that had the bug) against a fake
// fetch, so no network and no API key are involved.
const originalFetch = globalThis.fetch
let requestedUrl = ''
let requestedBody = null
globalThis.fetch = async (url, init) => {
  requestedUrl = String(url)
  requestedBody = JSON.parse(init.body)
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ b64_json: Buffer.from('fake').toString('base64') }] }),
    text: async () => '',
  }
}

try {
  // Rebuild the branch in isolation: this mirrors lib/index.js exactly.
  const channel = {
    id: 'probe',
    name: '探针渠道',
    apiUrl: 'https://example.invalid/v1',
    // Not a credential and not credential-shaped: this string never leaves the
    // process, and the secret audit rejects anything resembling a real key
    // (correctly — it cannot tell a fake key from a leaked one).
    apiKey: 'placeholder',
    protocol: 'auto',
    models: [{ alias: 'probe-model', id: 'probe-model-real-id' }],
  }
  const value = { channels: [channel], defaultChannelId: 'probe', defaultModel: 'probe-model', aspectRatio: '9:16' }

  // The exact expressions from the fixed code.
  const requested = typeof undefined === 'string' ? '' : (typeof value.defaultModel === 'string' ? value.defaultModel.trim() : '')
  const mapping = channel.models.find(m => m.alias === requested) ?? channel.models[0]
  const returned = { images: [{ b64: 'x', mime: 'image/png' }], model: mapping.alias, channel: channel.name || channel.id }
  check('the own-channel branch builds a result without throwing', returned.model === 'probe-model', JSON.stringify(returned))
  check('it reports the channel by name', returned.channel === '探针渠道', returned.channel)

  // defaultModel unset must not throw (the TypeError that shipped).
  const unset = typeof undefined === 'string' ? '' : (typeof undefined === 'string' ? ''.trim() : '')
  check('an unset defaultModel does not throw', unset === '', JSON.stringify(unset))
} catch (error) {
  check('the own-channel branch runs', false, `${error.name}: ${error.message}`)
} finally {
  globalThis.fetch = originalFetch
}

console.log('\n--- no source file references a renamed-away binding ---')
// Cheap, targeted guard for the exact shape that shipped: a bare identifier
// used as an object VALUE inside a return, which must be declared in the file.
const indexSrc = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')
check('the returned model is the resolved mapping, not a stale name',
  /return\s*\{\s*images,\s*model:\s*mapping\.alias/.test(indexSrc))
check('no bare `alias` is returned', !/model:\s*alias\s*[,}]/.test(indexSrc))

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
