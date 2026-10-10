/**
 * Guard the scene interior/exterior flag.
 *
 * Regression: the bible schema names this field `kind` ('interior' /
 * 'exterior'), but the normalizer only read `interior` / `inOut`. A card
 * written to spec produced `interior: false` — every scene, including train
 * carriages and control rooms, was labelled EXTERIOR. The consistency lock
 * then hard-coded "场景类型：室外" into the image prompt.
 *
 * Run: node docs/verify-scene-kind.mjs
 */
import { normalizeStageContent } from '../lib/host/stages.js'
import { lockScene } from '../lib/host/consistency.js'

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

const scenify = (scene) => normalizeStageContent('bible', {
  styleDna: 'x',
  characters: [],
  scenes: [scene],
}).scenes[0]

console.log('--- the schema field is `kind` ---')
{
  const a = scenify({ id: 'a', name: '广播间', kind: 'interior', description: 'd', lighting: 'l', composition: 'c', masterPrompt: 'm' })
  check('kind:"interior" -> interior:true', a.interior === true, JSON.stringify(a.interior))

  const b = scenify({ id: 'b', name: '站台', kind: 'exterior', description: 'd', lighting: 'l', composition: 'c', masterPrompt: 'm' })
  check('kind:"exterior" -> interior:false', b.interior === false, JSON.stringify(b.interior))
}

console.log('\n--- every scene in a real bible card keeps its kind ---')
{
  const names = ['地铁广播间', '地铁车厢', '地铁监控室', '地铁档案室']
  const allInterior = names.map((name, i) => scenify({
    id: `s${i}`, name, kind: 'interior', description: 'd', lighting: 'l', composition: 'c', masterPrompt: 'm',
  }))
  check('all four interior scenes stay interior',
    allInterior.every(s => s.interior === true),
    JSON.stringify(allInterior.map(s => [s.name, s.interior])))
}

console.log('\n--- the consistency lock must not call an interior scene 室外 ---')
{
  const scene = scenify({ id: 'a', name: '地铁车厢', kind: 'interior', description: '标准 B 型车厢', lighting: '顶灯 4000K', composition: '长纵深', masterPrompt: 'm' })
  const lock = lockScene(scene)
  check('lock does not say 室外', !lock.canonical.includes('室外'), lock.canonical)
  check('lock says 室内', lock.canonical.includes('室内'), lock.canonical)
}

console.log('\n--- the legacy shapes still work ---')
{
  const zh = scenify({ id: 'c', name: '内景', interior: '内', description: 'd', lighting: 'l', composition: 'c', masterPrompt: 'm' })
  check('interior:"内" still means interior', zh.interior === true, JSON.stringify(zh.interior))

  const bool = scenify({ id: 'd', name: '外景', interior: false, description: 'd', lighting: 'l', composition: 'c', masterPrompt: 'm' })
  check('a boolean still wins', bool.interior === false, JSON.stringify(bool.interior))

  const inout = scenify({ id: 'e', name: 'inOut内', inOut: 'indoor', description: 'd', lighting: 'l', composition: 'c', masterPrompt: 'm' })
  check('inOut:"indoor" still means interior', inout.interior === true, JSON.stringify(inout.interior))

  const ext = scenify({ id: 'f', name: 'exterior kind', kind: 'exterior', description: 'd', lighting: 'l', composition: 'c', masterPrompt: 'm' })
  check('exterior is not mistaken for interior', ext.interior === false, JSON.stringify(ext.interior))
}

console.log('\n--- an unknown kind falls back to interior, not exterior ---')
{
  const weird = scenify({ id: 'g', name: '怪', kind: '???', description: 'd', lighting: 'l', composition: 'c', masterPrompt: 'm' })
  // This assertion was REVERSED deliberately. The old default was `false`
  // (exterior), which is what stamped 场景类型：室外 onto subway carriages and
  // control rooms once every scene fell through to it. Short-drama scenes are
  // overwhelmingly interiors, and a wrongly-marked exterior is a visible error
  // in the prompt while an unmarked one is merely unstated — so the safe
  // default is interior.
  check('unknown kind -> true (interior)', weird.interior === true, JSON.stringify(weird.interior))
}

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
