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

/**
 * Every shipped host file, not just the browser bundle.
 *
 * This started as a client-only scan. Then a fix in lib/index.js renamed a
 * variable and left one reference to the old name behind — `node --check`
 * passes (it is valid syntax) and nothing else looked, so a busy `alias` would
 * have thrown a ReferenceError at generation time. Scanning the host too is
 * what closes that hole.
 */
const hostFiles = [
  'lib/index.js',
  ...fs.readdirSync(path.join(root, 'lib', 'host'))
    .filter(name => name.endsWith('.js'))
    .sort()
    .map(name => `lib/host/${name}`),
]

/** Strip comments and strings so their contents do not pollute the scan. */
function prepare(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    // Regex literals: `/\b(?:Bearer|...)/` contains `b(` and would read as a
    // call to an undeclared `b`. Matched only where a regex can legally start
    // (after `(`, `,`, `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `;`, or return).
    .replace(/(?<=[(,=:[!&|?{};]\s*)\/(?![*/])(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g, '/RE/')
}

/** Scan one file's source for called-but-never-declared identifiers. */
function scan(code, { node }) {
  const declared = new Set()
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(',')) {
      const name = p.trim().split(':').pop().trim().replace(/=.*$/, '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
    }
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const p of m[1].split(',')) {
      const name = p.trim().replace(/=.*$/, '').trim()
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
  // Imported bindings are declared by their import statement.
  for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s+from/g)) declared.add(m[1])
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(',')) {
      const name = p.trim().split(/\s+as\s+/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
    }
  }
  for (const m of code.matchAll(/\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1])
  // Export lists re-export names that must already exist; treat as declared.
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(',')) {
      const name = p.trim().split(/\s+as\s+/)[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
    }
  }

  const called = new Map()
  // A CALL is `name(` NOT preceded by `.` and NOT a definition site.
  //
  // Two shapes must be excluded or they read as calls:
  //   `writeHead(code) { ... }`  — a shorthand method DEFINITION inside an object
  //   `submit(ctx) -> {...}`     — JSDoc prose (already stripped, but be safe)
  // A definition has no `.`/`?.` before it AND is followed by a `{` body with no
  // `=>` — so requiring a non-`{` right-hand side after the closing paren is
  // what separates the two.
  const callRe = /(?<![.\w$?'"`])([A-Za-z_$][\w$]*)\s*\??\.?\s*\(/g
  for (const m of code.matchAll(callRe)) {
    const name = m[1]
    const after = code.slice(m.index + m[0].length)
    const close = after.indexOf(')')
    if (close !== -1) {
      const rest = after.slice(close + 1).replace(/^\s*/, '')
      // `name(...) {` with no arrow is a method definition, not a call.
      if (rest.startsWith('{') && !/^\{[^}]*\}\s*=>/.test(rest)) continue
    }
    if (!called.has(name)) called.set(name, 0)
    called.set(name, called.get(name) + 1)
  }

  const suspicious = []
  for (const [name, count] of called) {
    if (SAFE.has(name)) continue
    if (declared.has(name)) continue
    if (node && NODE_SAFE.has(name)) continue
    suspicious.push({ name, count })
  }
  return { suspicious, declared, called }
}

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

/** Extra globals that are safe in the Node host half only. */
const NODE_SAFE = new Set([
  'Buffer', 'process', 'global', '__dirname', '__filename', 'URL', 'URLSearchParams',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'structuredClone', 'fetch', 'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
  'require', 'console',
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

// --- host half: same scan, Node globals allowed -------------------------
console.log('')
console.log(`host files: ${hostFiles.length}`)
const hostProblems = []
for (const rel of hostFiles) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8')
  const { suspicious: found } = scan(prepare(source), { node: true })
  if (found.length > 0) hostProblems.push({ rel, found })
}

if (hostProblems.length === 0) {
  console.log('OK — host half: every called identifier is declared or a Node global.')
} else {
  console.log('SUSPICIOUS — host half has called-but-undeclared identifiers:')
  for (const { rel, found } of hostProblems) {
    for (const s of found.sort((a, b) => b.count - a.count)) {
      console.log(`  ${rel}: ${s.name}  (${s.count}x)`)
    }
  }
}

// Undefined VALUE references.
//
// A regex cannot do this reliably: telling `{ model: alias }` (a reference)
// from `{ alias: 1 }` (a key) or `'alias'` (a string) needs real scoping, and
// the naive attempt produced dozens of false positives (true, false, null,
// and every enum value). A noisy gate gets ignored, so this is NOT a regex.
//
// Instead, load each host module and check that the names it REFERENCES at
// runtime actually exist. See docs/verify-host-loads.mjs, which imports every
// host module for real — a renamed-away binding there is a hard failure.
console.log('')
console.log('value-reference scan: delegated to verify-host-loads.mjs (real import)')

process.exit(suspicious.length === 0 && !closeCall && hostProblems.length === 0 ? 0 : 1)
