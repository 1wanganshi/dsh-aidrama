import fs from 'node:fs'
const s = fs.readFileSync('lib/client.js', 'utf8')

// Tokens actually DECLARED in :root
const rootStart = s.indexOf(':root {', s.indexOf('const CSS'))
const rootEnd = s.indexOf('}', rootStart)
const declared = new Set(
  (s.slice(rootStart, rootEnd).match(/--ad-[a-z0-9-]+(?=\s*:)/g) ?? []),
)
console.log('declared tokens:', [...declared].sort().join(', '))

// Tokens I USED anywhere in the CSS
const cssStart = s.indexOf('const CSS')
const cssEnd = s.indexOf('\n    `', cssStart)
const css = s.slice(cssStart, cssEnd)
const used = new Set((css.match(/var\(--ad-[a-z0-9-]+/g) ?? []).map(t => t.slice(4)))
console.log('\nused tokens:', [...used].sort().join(', '))

const missing = [...used].filter(t => !declared.has(t))
console.log('\n*** USED BUT NEVER DECLARED ***')
console.log(missing.length ? missing.join('\n') : '(none)')
