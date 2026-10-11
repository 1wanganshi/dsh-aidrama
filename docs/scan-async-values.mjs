/**
 * Guard against the "async function used as a synchronised value" bug.
 *
 * WHY THIS EXISTS: `firstFrameDataUrl` was declared `async` while six call sites
 * used it as a plain value. The bundle therefore stored a Promise, and a Promise
 * serializes to `{}` — which is exactly the `"firstFrame": { "kind": "image",
 * "ref": {} }` every video task shipped. Nothing in the symptom pointed at async:
 * the task reported success, the data looked merely incomplete, and there was no
 * error anywhere. It took three wrong diagnoses to find.
 *
 * A `return someAsyncFn(...)` inside an `async` function is CORRECT — the caller
 * awaits the outer promise and the chain resolves. Only a call whose result is
 * stored or serialized without awaiting is a defect, so this scan checks the
 * call's position in the expression rather than merely its presence.
 *
 * Run: node docs/scan-async-values.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const dir = path.join(root, 'lib', 'host')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`) }
}

/** Every async function name declared in a source file. */
function asyncNames(src) {
  return [...new Set([
    ...[...src.matchAll(/async\s+function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
    ...[...src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*async\s*\(/g)].map(m => m[1]),
  ])]
}

const IGNORE_LINE = [
  /^\s*\*/,           // jsdoc continuation
  /^\s*\/\*/,         // jsdoc opening
  /^\s*\/\//,         // comment
  /^\s*throw /,       // error message text
  /Error\(/,          // ditto
  /new RegExp/,       // a pattern, not a call
]

const findings = []
const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'))

for (const file of files) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8')
  const names = asyncNames(src)
  if (names.length === 0) continue

  const lines = src.split('\n')
  for (const name of names) {
    lines.forEach((line, i) => {
      if (IGNORE_LINE.some(re => re.test(line))) return
      // The declaration itself.
      if (new RegExp(`(async\\s+function\\s+${name}\\b|const\\s+${name}\\s*=\\s*async)`).test(line)) return
      // Must actually be a CALL.
      if (!new RegExp(`\\b${name}\\s*\\(`).test(line)) return
      // `await name(...)` is fine.
      if (/await\s/.test(line)) return
      // `return name(...)` inside an async function is a correct tail call: the
      // caller awaits the outer promise. Treat as safe.
      if (/^\s*return\s+(?:await\s+)?[\w$.]*\b/.test(line) && new RegExp(`^\\s*return\\s+${name}\\s*\\(`).test(line)) return
      // `.then/.catch/.finally` chains handle the promise.
      if (new RegExp(`${name}\\s*\\([^)]*\\)\\s*\\.(then|catch|finally)\\b`).test(line)) return
      // Passed as a reference to an event API, not called for its value.
      if (/(addEventListener|\.on|\.once)\s*\(/.test(line)) return

      findings.push({
        file,
        line: i + 1,
        name,
        text: line.trim().slice(0, 120),
      })
    })
  }
}

console.log(`scanned ${files.length} host files\n`)
console.log('--- no async function may be used as a synchronised value ---')
check('no un-awaited async call sites found', findings.length === 0,
  findings.map(f => `${f.file}:${f.line}  ${f.name}(...) — ${f.text}`).join('\n      '))

console.log('\n--- the specific bug stays fixed ---')
const routesSrc = fs.readFileSync(path.join(dir, 'routes.js'), 'utf8')
check('firstFrameDataUrl is not async', !/async\s+function\s+firstFrameDataUrl/.test(routesSrc))
check('nothing awaits firstFrameDataUrl', !/await\s+firstFrameDataUrl/.test(routesSrc))

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
