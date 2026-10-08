/**
 * Scan the client bundle for BARE GLOBAL references that could silently resolve
 * to a browser global — the class of bug that made ✕ call window.close().
 *
 * The mechanism: inside a nested function, a reference to a name that is not
 * declared in any enclosing scope resolves to a global. There is no syntax error
 * and no linting here, so the call quietly does something else entirely.
 *
 * This collects every identifier that is CALLED and checks whether it is
 * declared anywhere in the file (or is a known-safe builtin).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

// Strip comments and strings so their contents do not pollute the scan.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')

// Names DECLARED anywhere in the file.
const declared = new Set()
for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
  for (const part of m[1].split(',')) {
    const name = part.split(':').pop().trim().replace(/=.*$/, '').trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
  }
}
for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
  for (const p of m[1].split(',')) {
    const name = p.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
  }
}
for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
  for (const p of m[1].split(',')) {
    const name = p.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
  }
}
for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1])
for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) declared.add(m[1])
for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])

// Identifiers that are CALLED as `name(` or `name?.(` and are not methods.
const called = new Map()
const callRe = /(?<![.\w$?'"`])([A-Za-z_$][\w$]*)\s*\??\.?\s*\(/g
for (const m of code.matchAll(callRe)) {
  const name = m[1]
  if (!called.has(name)) called.set(name, 0)
  called.set(name, called.get(name) + 1)
}

// Globals that exist in a browser and are LEGITIMATE to call.
const SAFE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new', 'await', 'delete', 'in', 'of', 'do', 'else', 'try', 'finally', 'throw', 'yield',
  // Keywords my call-regex misreads as calls (`async (`, `super(`, `constructor(`).
  'async', 'super', 'constructor', 'get', 'set', 'static', 'void', 'this',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'RegExp', 'Symbol', 'BigInt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone',
  'fetch', 'Request', 'Response', 'Headers', 'AbortController', 'URL', 'URLSearchParams', 'FormData', 'Blob', 'File', 'FileReader',
  'requestAnimationFrame', 'cancelAnimationFrame', 'console', 'require', 'import',
  'document', 'window', 'globalThis', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'CustomEvent', 'Event',
  'TextEncoder', 'TextDecoder', 'crypto', 'performance', 'localStorage', 'sessionStorage', 'navigator',
])

const suspicious = []
for (const [name, count] of called) {
  if (SAFE.has(name)) continue
  if (declared.has(name)) continue
  suspicious.push({ name, count })
}

console.log(`declared identifiers: ${declared.size}`)
console.log(`called identifiers:   ${called.size}`)
console.log('')
if (suspicious.length === 0) {
  console.log('OK — every called identifier is declared in-file or a known-safe global.')
} else {
  console.log('SUSPICIOUS — called but never declared (may resolve to a browser global):')
  for (const s of suspicious.sort((a, b) => b.count - a.count)) {
    console.log(`  ${s.name}  (${s.count}x)`)
  }
}

// Explicitly assert the specific historical hazard.
//
// TWO forms must be caught, because the first fix only covered one of them:
//   (a) a BARE `close()` with no declaration — resolves to window.close();
//   (b) an EXPLICIT `window.close()` / `globalThis.close()` — same effect, and
//       invisible to a bare-identifier scan.
const bareClose = /(?<![.\w$])close\s*\(/.test(code) && !declared.has('close')
const explicitClose = /\b(?:window|globalThis|self)\s*\.\s*close\s*\(/.test(code)
const closeCall = bareClose || explicitClose

if (closeCall) {
  console.log('')
  console.log('HAZARD: this file closes the application window.')
  if (bareClose) console.log('  - a bare undeclared close() call resolves to window.close()')
  if (explicitClose) console.log('  - an explicit window.close() / globalThis.close() call')
  console.log('  The workbench ✕ must dismiss the PANEL, never the DSH application.')
} else {
  console.log('')
  console.log('no application-closing close() call')
}

process.exit(suspicious.length === 0 && !closeCall ? 0 : 1)
