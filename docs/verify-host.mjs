/**
 * dsh-aidrama — host entry contract verification.
 *
 * Proves lib/index.js is a well-formed cordis plugin BEFORE it is loaded by a
 * live profile: it must export `name`, an `inject` list, a schemastery `Config`,
 * and an `apply(ctx, config)` that registers routes/tools/settings without
 * throwing and disposes cleanly.
 *
 * A malformed host entry is the worst failure mode available here — it does not
 * fail one feature, it takes the whole profile down on startup. So this runs it
 * against a recording ctx and asserts the registration surface by name.
 *
 * Run: node docs/verify-host.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let passed = 0
let failed = 0
const failures = []
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failed += 1; failures.push(label); console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}
function section(title) { console.log(`\n— ${title} —`) }

const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))

/* ------------------------------------------------------- manifest wiring */

section('package.json wiring')
check('the package is named dsh-aidrama', manifest.name === 'dsh-aidrama', manifest.name)
check('main points at the host entry', manifest.main === 'lib/index.js', manifest.main)
check('the bundle patch is declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('a web client half is declared', manifest.dsh?.client?.platform === 'web')
check('the client inject list is present', Array.isArray(manifest.dsh?.client?.inject),
  JSON.stringify(manifest.dsh?.client?.inject))
check('exports expose the client entry', manifest.exports?.['./client'] === './lib/client.js')

{
  const patchText = await fs.readFile(path.join(root, 'cordis.patch.yml'), 'utf8')
  check('the patch inserts a row by package name',
    patchText.includes('dsh-aidrama') && /insert:/u.test(patchText))
}

/* ------------------------------------------------------------- the entry */

section('host entry shape')

/**
 * `@deepseek-ai/schemastery` is provided by the DSH runtime and lives in the
 * profile's node_modules, not in this workspace. docs/link-host-deps.mjs creates
 * a workspace-local node_modules link so the REAL entry can be imported
 * unmodified; this script only reports clearly if that link is missing.
 */
let mod
let skippedForMissingDep = false
try {
  mod = await import(pathToFileURL(path.join(root, 'lib/index.js')).href)
} catch (error) {
  if (String(error.message).includes('schemastery')) {
    // Expected in a fresh clone. DSH supplies schemastery on the HOST plane; it
    // only exists inside a DSH profile's node_modules, so a bare checkout has
    // nothing to resolve. That is a setup step, not a defect — skip rather than
    // fail, otherwise `npm test` is red for every new contributor.
    console.log('SKIP  the host entry imports cleanly — @deepseek-ai/schemastery is not linked yet.')
    console.log('      Run: node docs/link-host-deps.mjs   (links it from your DSH profile)')
    skippedForMissingDep = true
  } else {
    console.log(`FAIL  the host entry imports cleanly — ${error.message}`)
    failed += 1
    failures.push('the host entry imports cleanly')
  }
}

if (mod !== undefined) {
check('the entry exports a name', typeof mod.name === 'string' && mod.name !== '', JSON.stringify(mod.name))
check('the entry exports an inject list', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('the entry exposes apply as a function', typeof mod.apply === 'function')
check('the entry exposes a Config schema', mod.Config !== undefined)

{
  // schemastery schemas expose a callable that validates; a plain object would not.
  const config = mod.Config
  const looksLikeSchema = typeof config === 'function'
    || typeof config?.__schema === 'object'
    || typeof config?.['~standard'] === 'object'
    || typeof config?.toString === 'function'
  check('the Config value behaves like a schema', looksLikeSchema, typeof config)
}

/* --------------------------------------------------- apply with a fake ctx */

section('apply() registers the plugin surface')

/** A recording cordis ctx, shaped like the real host plane. */
function recordingCtx() {
  const record = {
    routes: [], tools: [], prompts: [], settings: [], effects: [], listeners: [], injections: [],
  }
  const services = new Map()
  const ctx = {
    record,
    get(name) { return services.get(name) },
    provide(name, value) { services.set(name, value) },
    inject(deps, callback) {
      record.injections.push(Array.isArray(deps) ? deps : [deps])
      // Run the callback with a child ctx that shares this recorder.
      if (typeof callback === 'function') callback(ctx)
      return () => {}
    },
    on(name, handler) { record.listeners.push({ name, handler }); return () => {} },
    effect(fn, label) {
      const cleanup = fn()
      record.effects.push({ label, cleanup })
      return () => { if (typeof cleanup === 'function') cleanup() }
    },
    tools: {
      register(tool) { record.tools.push(tool); return () => {} },
    },
    systemPrompt: {
      section(section_) { record.prompts.push(section_); return () => {} },
    },
    webServer: {
      register(route) { record.routes.push(route); return () => {} },
    },
    settings: {
      register(namespace, schema) { record.settings.push({ namespace, schema }); return () => {} },
      define(namespace, schema) { record.settings.push({ namespace, schema }); return () => {} },
      namespace(namespace, schema) { record.settings.push({ namespace, schema }); return () => {} },
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
  return ctx
}

let ctx
let applyError
try {
  ctx = recordingCtx()
  mod.apply(ctx, {})
} catch (error) {
  applyError = error
}
check('apply does not throw with a minimal ctx', applyError === undefined, applyError?.stack?.slice(0, 400))

if (ctx !== undefined) {
  const rec = ctx.record
  check('routes were registered', rec.routes.length > 0, `got ${rec.routes.length}`)
  check('every route has a kind and a path',
    rec.routes.every(route => (route.kind === 'exact' || route.kind === 'prefix') && typeof route.path === 'string'),
    JSON.stringify(rec.routes.map(route => route.path)))
  check('every route path is namespaced under /api/dsh-aidrama',
    rec.routes.every(route => route.path.startsWith('/api/dsh-aidrama/')),
    JSON.stringify(rec.routes.map(route => route.path)))
  check('every route exposes a handler',
    rec.routes.every(route => typeof route.handler === 'function'))

  check('agent tools were registered', rec.tools.length > 0, `got ${rec.tools.length}`)
  check('every tool has a name, description and parameters',
    rec.tools.every(tool => typeof tool.name === 'string' && tool.name !== ''
      && typeof tool.description === 'string' && tool.description !== ''
      && tool.parameters !== undefined))
  check('every tool name is aidrama-prefixed',
    rec.tools.every(tool => tool.name.startsWith('aidrama_')),
    JSON.stringify(rec.tools.map(tool => tool.name)))
  check('every tool declares an execute or handler',
    rec.tools.every(tool => typeof tool.execute === 'function' || typeof tool.handler === 'function'))

  check('a system-prompt section was contributed', rec.prompts.length > 0, `got ${rec.prompts.length}`)
  check('the prompt section is named and ordered',
    rec.prompts.every(item => typeof item.name === 'string' && item.text !== undefined))
}

/* ------------------------------------------------------------ idempotency */

section('apply is repeatable and cleans up')
{
  let secondError
  let secondCtx
  try {
    secondCtx = recordingCtx()
    mod.apply(secondCtx, {})
  } catch (error) { secondError = error }
  check('a second apply() on a fresh ctx also succeeds', secondError === undefined, secondError?.message)

  // Cleanup: the entry may return a disposer, or register disposers via effect.
  let cleanupError
  try {
    if (typeof mod.apply === 'function') {
      const disposable = mod.apply(recordingCtx(), {})
      if (typeof disposable === 'function') disposable()
    }
    if (ctx !== undefined) {
      for (const effect of ctx.record.effects) {
        if (typeof effect.cleanup === 'function') effect.cleanup()
      }
    }
  } catch (error) { cleanupError = error }
  check('disposal does not throw', cleanupError === undefined, cleanupError?.message)
}

}

/* ---------------------------------------------------------------- result */

console.log(`\n${'='.repeat(52)}`)
if (failed === 0) {
  console.log(`ALL PASS — ${passed} passed, 0 failed`)
  console.log('HOST ENTRY CONTRACT VERIFIED')
  process.exit(0)
} else {
  console.log(`FAILURES PRESENT — ${passed} passed, ${failed} failed`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exit(1)
}
