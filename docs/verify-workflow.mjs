/**
 * Guard the "draft-first" workflow.
 *
 * The workbench originally opened onto a form with eight REQUIRED fields, which
 * meant someone who only had an idea — the actual starting condition — could
 * not begin. Step 1 must stay a single open question plus tap-to-choose chips,
 * and every stage must offer to produce a first draft instead of demanding one.
 *
 * These assertions are deliberately about the SHAPE of step 1, not wording, so
 * the copy can be edited freely while the principle is protected.
 *
 * Run: node docs/verify-workflow.mjs
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

// --- Pull the STAGE_FORMS object out of the bundle -------------------------
const formsStart = src.indexOf('const STAGE_FORMS = {')
const formsEnd = src.indexOf('\n    }\n', formsStart)
const forms = src.slice(formsStart, formsEnd)
check('STAGE_FORMS is present', formsStart !== -1 && forms.length > 400)

const stageBlock = (name) => {
  const i = forms.indexOf(`      ${name}: {`)
  if (i === -1) return ''
  // Next sibling stage, or end of object.
  const rest = ['story', 'script', 'bible'].map(s => forms.indexOf(`      ${s}: {`, i + 1)).filter(x => x > i)
  const end = rest.length > 0 ? Math.min(...rest) : forms.length
  return forms.slice(i, end)
}

console.log('\n--- step 1 asks ONE question ---')
const idea = stageBlock('idea')
check('idea declares a primary prompt', idea.includes('primary: {'))
check('the primary prompt is a question, not a field name', idea.includes('primary: {') && /label: '[^']*[?？]/.test(idea))
check('idea is not a wall of required fields', (idea.match(/req: true/g) ?? []).length === 0,
  `${(idea.match(/req: true/g) ?? []).length} required fields remain`)

console.log('\n--- step 1 can be finished by tapping ---')
check('idea offers tap-to-choose groups', idea.includes('choices: ['))
const choiceCount = (idea.match(/options: \[/g) ?? []).length
check('at least two choice groups exist', choiceCount >= 2, `found ${choiceCount}`)
check('choices are rendered as buttons, not free text', src.includes('aidrama-chipBtn'))
check('a chosen chip is visually distinct', src.includes('.aidrama-chipBtn[data-on="true"]'))

console.log('\n--- every stage offers a draft ---')
for (const stage of ['story', 'script', 'bible']) {
  const block = stageBlock(stage)
  check(`${stage} declares a draftHint`, block.includes('draftHint:'))
}
check('the draft button exists', src.includes('let AI') || /让 AI/.test(src))
check('the draft button is wired to the instruction copy path', src.includes('copyInstruction'))
check('step 1 wording points at direction-choosing', /出几个方向/.test(src))

console.log('\n--- the draft affordance is visually primary ---')
check('draft row has its own style', src.includes('.aidrama-draftRow'))
check('draft row reads as an action zone, not a field', src.includes('border: 1px dashed'))

console.log('\n--- the primary input is prominent ---')
check('primary input has its own style', src.includes('.aidrama-primaryInput'))
check('primary input is larger than normal fields', /\.aidrama-primaryInput[\s\S]{0,160}font-size: 14px/.test(src))

console.log('\n--- saving still goes through the host validator ---')
check('save uses api.commit (no client-side bypass)', src.includes('api.commit(state.projectId, state.stage'))
check('save advances to the next step', src.includes('selectStage(next)'))

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0
  ? `ALL PASS — ${pass} passed, 0 failed`
  : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
