/**
 * Lock the episode-count sync and the scene interior/exterior resolution.
 *
 * TWO REAL BUGS THIS GUARDS:
 *
 * 1. `project.episodes` never followed the script. A project could hold a
 *    4-episode script while `episodes` stayed at its default 1, and
 *    routes.js:795 printed 「集数：1」 into the export header.
 *
 * 2. `lockScene` trusted the DERIVED boolean `s.interior` over the AUTHORED
 *    `s.kind`. An earlier normalizer never read `kind`, so it stamped
 *    `interior: false` onto every scene — and the lock then wrote
 *    「场景类型：室外」 into image prompts for subway carriages and control
 *    rooms. Fixing the normalizer did not heal data already written; the lock
 *    had to prefer the author's word to recover it.
 *
 * Run: node docs/verify-episodes-and-kind.mjs
 */
import * as stages from '../lib/host/stages.js'
import * as consistency from '../lib/host/consistency.js'

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('--- project.episodes follows the committed script ---')
{
  const p = stages.newProjectFrom({ title: 't' })
  check('a new project defaults to 1 episode', p.episodes === 1, String(p.episodes))

  stages.markStageReady(p, 'script', { title: 't', episodes: [{ no: 1 }, { no: 2 }, { no: 3 }, { no: 4 }] })
  check('committing a 4-episode script sets episodes = 4', p.episodes === 4, String(p.episodes))

  stages.markStageReady(p, 'script', { title: 't', episodes: [{ no: 1 }, { no: 2 }] })
  check('re-committing a 2-episode script sets episodes = 2', p.episodes === 2, String(p.episodes))
}
{
  const p = stages.newProjectFrom({ title: 't' })
  stages.markStageReady(p, 'idea', { seed: 'x' })
  check('a non-script stage never touches episodes', p.episodes === 1, String(p.episodes))
}
{
  const p = stages.newProjectFrom({ title: 't' })
  stages.markStageReady(p, 'script', { title: 't', episodes: [] })
  check('an empty episode list leaves episodes alone', p.episodes === 1, String(p.episodes))
}
{
  const p = stages.newProjectFrom({ title: 't', episodes: 24 })
  check('an explicitly sized project keeps its count before any script', p.episodes === 24, String(p.episodes))
}

console.log('\n--- a scene lock prefers the authored kind over a stale boolean ---')
const lockKind = (scene) => {
  const lock = consistency.lockScene(scene)
  if (lock.canonical.includes('场景类型：室内')) return '室内'
  if (lock.canonical.includes('场景类型：室外')) return '室外'
  return '(未写)'
}

check('kind "interior" wins over interior: false',
  lockKind({ id: 'a', name: 'A', kind: 'interior', interior: false }) === '室内')
check('kind "exterior" wins over interior: true',
  lockKind({ id: 'b', name: 'B', kind: 'exterior', interior: true }) === '室外')
check('Chinese kind 内景 resolves',
  lockKind({ id: 'c', name: 'C', kind: '内景' }) === '室内')
check('Chinese kind 外景 resolves',
  lockKind({ id: 'd', name: 'D', kind: '外景' }) === '室外')
check('a boolean still works when kind is absent',
  lockKind({ id: 'e', name: 'E', interior: true }) === '室内')
check('an absent kind and absent boolean writes nothing',
  lockKind({ id: 'f', name: 'F' }) === '(未写)')
check('an unrecognized value writes nothing rather than guessing exterior',
  lockKind({ id: 'g', name: 'G', kind: 'wobbly' }) === '(未写)')

console.log('\n--- the normalizer itself must heal stale data, not preserve it ---')
// This is the subtle one: an earlier version of the fix checked `row.interior`
// FIRST, so the stale `false` already stored in every project short-circuited
// the expression and the bug survived its own repair.
const normalizedKind = (scene) => {
  const row = stages.normalizeScenes({ scenes: [scene] })[0]
  return row.interior
}
check('kind "interior" overrides a stored interior: false',
  normalizedKind({ id: 'a', kind: 'interior', interior: false }) === true)
check('kind "exterior" overrides a stored interior: true',
  normalizedKind({ id: 'b', kind: 'exterior', interior: true }) === false)
check('kind 内景 resolves', normalizedKind({ id: 'c', kind: '内景' }) === true)
check('kind 外景 resolves', normalizedKind({ id: 'd', kind: '外景' }) === false)
check('a lone interior: false is still honoured',
  normalizedKind({ id: 'e', interior: false }) === false)
check('an unmarked scene defaults to interior',
  normalizedKind({ id: 'f', name: 'x' }) === true)

console.log('\n--- the exact regression: an interior stamped exterior ---')
// This is the stored shape of every scene in the 回声站 project before the fix.
const subway = { id: 'carriage', name: '地铁车厢', kind: 'interior', interior: false }
const lock = consistency.lockScene(subway)
check('a subway carriage is not called 室外', !lock.canonical.includes('室外'))
check('a subway carriage is called 室内', lock.canonical.includes('室内'))
check('the wrong boolean does not leak into the prompt text',
  !/场景类型：室外/.test(lock.canonical))

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
