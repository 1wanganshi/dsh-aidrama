/**
 * Pin the conclusion that "borrowing dsh-imagegen's image client" is
 * IMPOSSIBLE — so nobody tries it a fourth time.
 *
 * Three attempts, each reasonable-looking, each failed:
 *
 *   1. `ctx.get('imagegen')` — the original. Never resolves: imagegen's inject
 *      is ["webServer","systemPrompt","commands"] and it never calls
 *      provide('imagegen'). A module EXPORT is not a Cordis service.
 *
 *   2. Resolve the package from the profile's node_modules and call its export.
 *      This RESOLVES (verified below) but cannot be CALLED: the signature is
 *      generateImage(upstream, request, options), where `upstream` must carry
 *      {apiUrl, apiKey, ...} — imagegen's private channel settings.
 *
 *   3. Feed the module itself in as `upstream`. upstream.apiUrl is undefined,
 *      so imagegen throws "Cannot read properties of undefined (reading
 *      'trim')" — an error that names nothing the user can act on. This one
 *      SHIPPED and was hit on a real run.
 *
 * The plugin therefore uses its own configured channels. This test asserts
 * that no borrow branch exists any more.
 *
 * Run: node docs/verify-image-borrow.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('--- no borrow branch remains ---')
check('no borrowImageClient helper', !src.includes('borrowImageClient'))
check('no image-client module loader', !src.includes('imageClientModule'))
check('no service-alias list', !src.includes('IMAGE_SERVICE_ALIASES'))
check('no profile-walking resolver', !src.includes('resolveImagegenEntry'))
check('no module import machinery', !/createRequire|pathToFileURL/.test(src))
check('no stale memo cell', !src.includes('imageClientState'))

console.log('\n--- the module is never passed in as an upstream channel ---')
// The shipped bug: `{ apiUrl: borrowed.apiUrl, ... }` where borrowed is the
// MODULE, so every field is undefined.
check('does not build an upstream from borrowed.*', !/apiUrl:\s*borrowed\./.test(src))

console.log("\n--- generation goes to this plugin's own channel ---")
check('calls /images/generations', src.includes('`${base}/images/generations`'))
check('reads the channel from resolve()', /value\.channels\.find\(/.test(src))
check('names the settings path when unconfigured',
  src.includes('尚未配置图像渠道：请打开「设置 → 短剧工作台」'))

console.log('\n--- the conclusion is documented, not just coded ---')
check('the call site explains why borrowing is impossible',
  src.includes('Borrowing dsh-imagegen') || src.includes('NOT possible'))

console.log('\n--- the live machine: the facts behind the conclusion ---')
const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles')
let resolved
try {
  for (const name of fs.readdirSync(profilesRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
    const candidate = path.join(profilesRoot, name, 'node_modules', '@dickpy', 'dsh-imagegen', 'lib', 'index.js')
    if (fs.existsSync(candidate)) { resolved = candidate; break }
  }
} catch { /* not installed */ }

if (resolved === undefined) {
  console.log('SKIP  dsh-imagegen is not installed here')
} else {
  const genSrc = fs.readFileSync(resolved, 'utf8')
  // (1) no service.
  check('imagegen registers no Cordis service', !/provide\(\s*['"]imagegen['"]/.test(genSrc))

  const mod = await import(new URL(`file://${resolved.replace(/\\/g, '/')}`).href)
  // (2) the low-level export needs a channel object first.
  check('its generateImage takes an upstream channel first', mod.generateImage.length === 2)
  check('that upstream must carry apiUrl', /upstream\.apiUrl/.test(String(mod.generateImage)))
  // (3) the high-level wrapper is not constructible from outside.
  check('ImageGenerationRuntime needs injectable internals',
    /constructor\s*\(\s*resolve\s*,\s*history/.test(String(mod.ImageGenerationRuntime)))
}

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
