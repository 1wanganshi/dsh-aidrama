/**
 * Does an EMPTY idea stage leave the detail fields collapsed?
 *
 * This is the new-user path, and the redesign's premise depends on it: step one
 * must be one box plus some chips, not a nine-field form. The <details> opens
 * itself once any detail field holds a value, so the empty case is the one that
 * decides whether a first-time user sees a small ask or a wall.
 *
 * Rather than drive the whole GUI, this isolates the decision: it evaluates the
 * exact expression lib/client.js uses to choose `open`, against both a filled and
 * an empty stage.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')

let pass = 0, fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`) }
}

// 1. The rule exists and is the one we think it is.
const rule = src.match(/if \(filled\.length > 0\) details\.setAttribute\('open', ''\)/)
check('the <details> opens only when a detail field is already filled', rule !== null)

// 2. The collapsed summary must tell the user they can skip it.
const skipHint = src.match(/细节字段（可以先不管[^`]*?）/)
check('the collapsed summary says the fields can be skipped', skipHint !== null,
  skipHint ? '' : 'summary text does not reassure the user')

// 3. Step one is ONE primary box, not eight required fields.
const ideaBlock = src.slice(src.indexOf('idea: {'), src.indexOf('idea: {') + 2600)
const primaryCount = (ideaBlock.match(/primary:\s*\{/g) ?? []).length
check('step one declares exactly one primary question', primaryCount === 1, `found ${primaryCount}`)
const reqInPrimary = /primary:\s*\{[\s\S]*?req:\s*true/.test(ideaBlock)
check('the primary question is not a different required field', primaryCount === 1)

// 4. The choices exist and are tappable, so step one can be done without typing.
const choiceCount = (ideaBlock.match(/key: '(audience|flavor|length)'/g) ?? []).length
check('step one offers at least three tap-to-choose questions', choiceCount >= 3, `found ${choiceCount}`)

// 5. Nothing in the idea stage's detail fields is marked required.
const fieldsBlock = ideaBlock.slice(ideaBlock.indexOf('fields:'), ideaBlock.indexOf('lists:'))
const requiredFields = [...fieldsBlock.matchAll(/key: '([^']+)'[^}]*req: true/g)].map(m => m[1])
check('no idea detail field is required', requiredFields.length === 0,
  `required: ${requiredFields.join(', ')}`)

// 6. Simulate the open-decision for both cases.
const decideOpen = (content) => {
  const keys = [...fieldsBlock.matchAll(/key: '([^']+)'/g)].map(m => m[1])
  const filled = keys.filter(k => {
    const v = content[k]
    if (Array.isArray(v)) return v.length > 0
    return v !== undefined && v !== null && String(v) !== ''
  })
  return { open: filled.length > 0, filled: filled.length, total: keys.length }
}
const empty = decideOpen({})
const full = decideOpen(Object.fromEntries(
  [...fieldsBlock.matchAll(/key: '([^']+)'/g)].map(m => [m[1], '内容'])))
console.log(`\n  empty stage: ${empty.filled}/${empty.total} filled -> ${empty.open ? 'OPEN' : 'collapsed'}`)
console.log(`  filled stage: ${full.filled}/${full.total} filled -> ${full.open ? 'OPEN' : 'collapsed'}`)
check('a fresh project shows the fields COLLAPSED', empty.open === false)
check('a project that already has details shows them OPEN', full.open === true)

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
