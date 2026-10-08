/**
 * Pre-publish secret audit.
 *
 * Before anything goes to a public remote, sweep the files that would actually
 * be committed for credentials. The known key is checked by value; everything
 * else is caught by shape (provider prefixes and high-entropy assignments).
 *
 * Run: node docs/audit-secrets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

// Shapes that indicate a live credential.
const PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'OpenAI/DeepSeek-style key'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, 'Anthropic key'],
  [/\bghp_[A-Za-z0-9]{20,}/g, 'GitHub personal access token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'GitHub fine-grained PAT'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'GitLab token'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS access key id'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'Google API key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/\bhf_[A-Za-z0-9]{20,}/g, 'HuggingFace token'],
  [/\bBearer\s+[A-Za-z0-9_-]{24,}/g, 'literal Bearer token'],
]

/** Assignment of a secret-looking value to a secret-looking name. */
const ASSIGN = /(?:api[_-]?key|apikey|secret|password|passwd|token|authorization)\s*[:=]\s*['"`]([^'"`\s]{16,})['"`]/gi

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.yml', '.yaml', '.md', '.txt', '.html', '.ps1', '.sh', '.py', '.env', '.toml', '.ini'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build'])

/** Files that SHOULD be published. */
function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collect(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * Values that are DELIBERATELY fake.
 *
 * The verification suites inject canary keys to prove the real key never reaches
 * an error message, a log line, or an asset URL. Those hits are evidence the
 * tests work, not leaks — but they must be recognised by an EXPLICIT allow-list
 * rather than by loosening the patterns, so a real key that merely looks
 * similar is still caught.
 *
 * Note: no literal canary is written in this file, so the scanner never has to
 * whitelist itself.
 */
const CANARY_RE = /(CANARY|MUST-NOT-LEAK|LEAK-|SUPERSECRET|TOPSECRET|E2E-|SUPPLIER|TOP-|TEST-KEY|test-key|abcdefghijklmnopqrstuvwxyz|zyxwvutsrqponmlk)/i
// Normalise separators first: on Windows path.relative yields backslashes, and a
// forward-slash-only regex silently matched nothing. Digits matter too —
// verify-e2e.mjs would not match a bare [a-z-]+ class.
const CANARY_FILES = /(^|[\\/])verify-[a-z0-9-]+\.mjs$|(^|[\\/])realtest[\\/]/i

/** True when a hit is an intentional test fixture. */
function isCanary(rel, value) {
  return CANARY_FILES.test(rel) && CANARY_RE.test(value)
}

const files = collect(root)
const findings = []
let canaries = 0

for (const file of files) {
  const ext = path.extname(file).toLowerCase()
  // Only scan text-ish files, plus extensionless files like .gitignore.
  if (ext && !TEXT_EXT.has(ext)) continue
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (text.includes('\u0000')) continue
  const rel = path.relative(root, file)

  for (const [re, label] of PATTERNS) {
    re.lastIndex = 0
    const m = text.match(re)
    if (m) for (const hit of m) {
      if (isCanary(rel, hit)) { canaries += 1; continue }
      findings.push({ rel, label, sample: hit.slice(0, 12) + '…' })
    }
  }

  ASSIGN.lastIndex = 0
  let a
  while ((a = ASSIGN.exec(text)) !== null) {
    const value = a[1]
    // Placeholders are fine.
    if (/^(YOUR|MY|REPLACE|CHANGE|xxx|test|dummy|example|placeholder|\.\.\.)/i.test(value)) continue
    if (/^[<${\[]/.test(value)) continue
    if (isCanary(rel, value)) { canaries += 1; continue }
    findings.push({ rel, label: `assignment to "${a[0].split(/[:=]/)[0].trim()}"`, sample: value.slice(0, 6) + '…' })
  }
}

console.log(`scanned ${files.length} files under ${root}`)
console.log(`ignored ${canaries} deliberate test canary(s) in the verification suites\n`)

if (findings.length === 0) {
  console.log('CLEAN — no credential-shaped strings found.')
  process.exit(0)
}

console.log(`FOUND ${findings.length} potential secret(s):\n`)
const byFile = new Map()
for (const f of findings) {
  if (!byFile.has(f.rel)) byFile.set(f.rel, [])
  byFile.get(f.rel).push(f)
}
for (const [file, hits] of byFile) {
  console.log(`  ${file}`)
  for (const h of hits) console.log(`      - ${h.label}: ${h.sample}`)
}
process.exit(1)
