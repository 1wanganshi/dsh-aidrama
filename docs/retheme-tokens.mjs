/**
 * Map the plugin's remaining light-mode colour fallbacks onto the dark-first
 * token layer defined on `.aidrama-overlay`.
 *
 * Each entry keeps the DSH theme variable first (so the host theme still wins /
 * is inherited) and swaps ONLY the hardcoded fallback for our token. The tokens
 * themselves carry their own DSH-first fallback, so this stays theme-aware.
 *
 * Run: node docs/retheme-tokens.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const file = path.join(root, 'lib', 'client.js')

const MAP = [
  // brand / accent
  [/var\(--dsw-alias-brand-primary,\s*#4d6bfe\)/g, 'var(--ad-accent)'],
  // text
  [/var\(--dsw-alias-label-primary,\s*#1f2329\)/g, 'var(--ad-text)'],
  [/var\(--dsw-alias-label-secondary,\s*#5f6672\)/g, 'var(--ad-text-2)'],
  [/var\(--dsw-alias-label-tertiary,\s*#8b93a1\)/g, 'var(--ad-text-3)'],
  // surfaces
  [/var\(--dsw-alias-bg-base,\s*#ffffff\)/g, 'var(--ad-bg)'],
  [/var\(--dsw-alias-bg-base,\s*#fff\)/g, 'var(--ad-bg)'],
  [/var\(--dsw-alias-bg-layer-1,\s*#ffffff\)/g, 'var(--ad-surface)'],
  [/var\(--dsw-alias-bg-layer-1,\s*#fff\)/g, 'var(--ad-surface)'],
  [/var\(--dsw-alias-bg-layer-2,\s*#f5f6f8\)/g, 'var(--ad-surface-2)'],
  [/var\(--dsw-alias-bg-layer-2,\s*#f7f8fa\)/g, 'var(--ad-surface-2)'],
  [/var\(--dsw-alias-bg-layer-3,\s*rgba\(127,127,127,\.16\)\)/g, 'var(--ad-surface-3)'],
  // borders
  [/var\(--dsw-alias-border-l1,\s*rgba\(127,127,127,\.22\)\)/g, 'var(--ad-border)'],
  [/var\(--dsw-alias-border-l2,\s*rgba\(127,127,127,\.3\)\)/g, 'var(--ad-border-strong)'],
  [/var\(--dsw-alias-border-l2,\s*rgba\(127,127,127,\.35\)\)/g, 'var(--ad-border-strong)'],
  [/var\(--dsw-alias-border-l2,\s*rgba\(127,127,127,\.28\)\)/g, 'var(--ad-border)'],
  // interaction
  [/var\(--dsw-alias-interactive-bg-hover,\s*rgba\(127,127,127,\.14\)\)/g, 'var(--ad-surface-3)'],
  [/var\(--dsw-alias-interactive-bg-hover,\s*rgba\(127,127,127,\.10\)\)/g, 'var(--ad-surface-3)'],
  // state
  [/var\(--dsw-alias-state-error-primary,\s*#d64545\)/g, 'var(--ad-err)'],
  [/var\(--dsw-alias-state-success-primary,\s*#22a06b\)/g, 'var(--ad-ok)'],
  [/var\(--dsw-alias-state-warning-primary,\s*#d9822b\)/g, 'var(--ad-warn)'],
]

const original = fs.readFileSync(file, 'utf8')
let out = original
const counts = []
for (const [re, to] of MAP) {
  const found = (out.match(re) ?? []).length
  if (found > 0) counts.push([to, found])
  out = out.replace(re, to)
}

if (out === original) {
  console.log('nothing to change — already on tokens')
  process.exit(0)
}

fs.writeFileSync(file, out, 'utf8')
console.log('replaced fallbacks:')
let total = 0
for (const [to, n] of counts) { console.log(`  ${String(n).padStart(3)}x  ->  ${to}`); total += n }
console.log(`\ntotal replacements: ${total}`)

const remaining = (out.match(/var\(--dsw-alias-[a-z0-9-]+,\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]*\))\)/g) ?? [])
console.log(`remaining light fallbacks: ${remaining.length}`)
for (const r of [...new Set(remaining)]) console.log(`  ${r}`)
