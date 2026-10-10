/**
 * Guard the "borrow dsh-imagegen's image client" seam.
 *
 * Regression: the seam was `ctx.get('imagegen')`, a single hard-coded service
 * name. But dsh-imagegen registers NO Cordis service — its inject list is
 * ["webServer","systemPrompt","commands"], it never calls provide('imagegen'),
 * and generateImage is only a module EXPORT. The lookup could never resolve,
 * so the borrow branch was dead code: a user who had configured image channels
 * in dsh-imagegen still got "尚未配置图像渠道" from this plugin, because the
 * fallback insists on this plugin's OWN (empty) channel list.
 *
 * The fix resolves the module from the host's profile node_modules. This test
 * pins the resolution logic, not the availability of the package itself.
 *
 * Run: node docs/verify-image-borrow.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('--- the borrow seam exists and is awaited ---')
check('borrows an image client', src.includes('borrowImageClient'))
check('the borrow is awaited before use', /await borrowImageClient\(\)/.test(src))
check('it tries more than one service alias',
  /IMAGE_SERVICE_ALIASES/.test(src) && (src.match(/'(imagegen|dsh-imagegen|image-generation)'/g) ?? []).length >= 2)
check('it tolerates a missing package (standalone mode)',
  /not available to borrow/.test(src))

console.log('\n--- resolution must not anchor above the profile dir ---')
check('resolves by walking profiles', src.includes('resolveImagegenEntry'))
check('reads the profiles directory', src.includes("readdirSync(root, { withFileTypes: true })"))
// The original bug shape: anchoring at ~/.dsh/profiles, which has no node_modules.
check('does not anchor at the profiles ROOT',
  !/createRequire\(path\.join\(anchor, 'noop\.js'\)\)[\s\S]{0,200}profiles'\)$/.test(src))
check('anchors per-profile directory', /path\.join\(root, name\)/.test(src))

console.log('\n--- the resolved entry is the package main, not a guess ---')
check('resolves the package.json first', src.includes("resolve('@dickpy/dsh-imagegen/package.json')"))
check('derives lib/index.js from the package dir', src.includes("'lib', 'index.js'"))
check('checks the file exists before importing', src.includes('existsSync(file)'))

console.log('\n--- failure is cached, not retried per generation ---')
check('memoizes the attempt', src.includes('imageClientState.tried'))
check('memoizes the value', src.includes('imageClientState.value'))

console.log('\n--- the low-level export needs a channel object FIRST ---')
// generateImage(upstream, request, options): calling it with one argument makes
// `upstream` the request and `request` undefined, which throws
// "Cannot read properties of undefined (reading 'trim')".
check('calls the low-level export with an upstream channel',
  src.includes('apiUrl: borrowed.apiUrl'))
check('prefers runtime.run when available', src.includes('runtime.run'))

console.log('\n--- an unset defaultModel must not crash ---')
check('does not trim a possibly-undefined defaultModel',
  !/\(request\.model \?\? value\.defaultModel\)\.trim\(\)/.test(src))
check('guards the model before trimming', src.includes("typeof value.defaultModel === 'string'"))

console.log('\n--- the live machine: does resolution actually work here? ---')
const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles')
let resolved
try {
  const names = fs.readdirSync(profilesRoot, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name)
  for (const name of names) {
    const candidate = path.join(profilesRoot, name, 'node_modules', '@dickpy', 'dsh-imagegen', 'lib', 'index.js')
    if (fs.existsSync(candidate)) { resolved = candidate; break }
  }
} catch { /* no profiles dir */ }

if (resolved === undefined) {
  console.log('SKIP  dsh-imagegen is not installed on this machine — cannot verify the live path')
} else {
  check('dsh-imagegen resolves on this machine', true)
  const mod = await import(new URL(`file://${resolved.replace(/\\/g, '/')}`).href)
  check('its generateImage is a function', typeof mod.generateImage === 'function')
  // This is the fact that made the original code dead: a module export is not
  // a Cordis service, so ctx.get can never see it.
  check('it is NOT registered as a service (the original bug)',
    !/provide\(\s*['"]imagegen['"]/.test(fs.readFileSync(resolved, 'utf8')))
}

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
