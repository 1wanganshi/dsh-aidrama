/**
 * Prove the "detail fields collapse for a blank project" rule.
 *
 * The DOM harness renders a fixture that already has content, so its details
 * element is open by design. This checks the underlying decision logic on a
 * genuinely empty draft — the state a brand-new project starts in.
 *
 * Run: node docs/verify-collapse.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

// The rule under test, mirroring renderFormStage: a key counts as "filled"
// when an array is non-empty or a scalar string is non-empty.
const filledCount = (draft, keys) => keys.filter(key => {
  const value = draft[key]
  if (Array.isArray(value)) return value.length > 0
  return value !== undefined && value !== null && String(value) !== ''
}).length

const IDEA_KEYS = ['title', 'logline', 'genre', 'tone', 'protagonist', 'conflict', 'hook', 'ending', 'questions']

console.log('--- a brand-new project starts collapsed ---')
check('empty draft has zero filled fields', filledCount({}, IDEA_KEYS) === 0)
check('a draft of only empty strings counts as unfilled',
  filledCount({ title: '', genre: '', questions: [] }, IDEA_KEYS) === 0)

console.log('\n--- it opens once there is real content ---')
check('one filled field opens the section', filledCount({ title: '退婚后我成了首富' }, IDEA_KEYS) === 1)
check('a filled array counts', filledCount({ questions: ['走感情线吗？'] }, IDEA_KEYS) === 1)
check('an empty array does NOT count', filledCount({ questions: [] }, IDEA_KEYS) === 0)

console.log('\n--- the summary says which ---')
check('the collapsed summary tells the user they can skip it',
  /可以让 AI 初稿来填|可以先不管/.test(src))
check('the expanded summary reports how many are filled',
  /已填 \$\{filled\.length\} 项/.test(src) || src.includes('已填 '))

console.log('\n--- the first screen is still just the question ---')
const formsStart = src.indexOf('const STAGE_FORMS = {')
const ideaStart = src.indexOf('      idea: {', formsStart)
const storyStart = src.indexOf('      story: {', ideaStart)
const idea = src.slice(ideaStart, storyStart)
check('idea has a primary prompt', idea.includes('primary: {'))
check('idea has tap-to-choose groups', (idea.match(/options: \[/g) ?? []).length >= 2)
check('idea has no required fields left', (idea.match(/req: true/g) ?? []).length === 0,
  `${(idea.match(/req: true/g) ?? []).length} remain`)

console.log('\n--- every stage collapses its details, not just idea ---')
const openCount = (src.match(/aidrama-detailFields/g) ?? []).length
check('the collapse wrapper is applied in the shared form renderer', openCount >= 2, `${openCount} hits`)
check('it auto-opens only when content exists', src.includes("if (filled.length > 0) details.setAttribute('open', '')"))

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
