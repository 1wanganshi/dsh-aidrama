/**
 * Guard the shot-duration fallback.
 *
 * Regression: the flattening used `scene.durationSec` as the per-shot default.
 * A scene's duration is the TOTAL for the whole scene, so every shot came out
 * as long as the entire scene — a 28s scene written as two shots reported 56s,
 * and the error scaled with the shot count.
 *
 * The correct fallback is the configured per-shot length (options.shotSeconds,
 * 5s by default).
 *
 * Run: node docs/verify-shot-duration.mjs
 */
import { normalizeStageContent } from '../lib/host/stages.js'

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

const scene = (shotCount, durationSec, extra = {}) => ({
  title: 'T',
  episodes: [{
    no: 1, title: 'E1', hook: 'h',
    scenes: [{
      no: 1, slug: 'INT. A - 夜', location: 'A', time: '夜',
      characters: ['甲'], action: 'x', durationSec,
      shots: Array.from({ length: shotCount }, (_, i) => ({
        no: i + 1, shot: '中景', camera: '固定', description: `d${i}`, motion: `m${i}`,
      })),
      ...extra,
    }],
  }],
})

const durationsOf = (payload, options) => {
  const norm = normalizeStageContent('script', payload)
  const shots = Array.isArray(norm.shots) ? norm.shots : []
  // flattenScriptShots is applied inside normalizeStageContent; if it did not
  // run, fall back to reading the nested structure.
  return shots.map(s => s.durationSeconds)
}

console.log('--- a shot with no own duration uses the per-shot default ---')
{
  const d = durationsOf(scene(2, 28))
  check('two shots are produced', d.length === 2, JSON.stringify(d))
  check('each defaults to 5s, not the scene length',
    d.every(v => v === 5), JSON.stringify(d))
  check('the scene length is NOT used as the per-shot default',
    !d.includes(28), JSON.stringify(d))
}

console.log('\n--- the bug scaled with the shot count ---')
{
  const two = durationsOf(scene(2, 28))
  const five = durationsOf(scene(5, 40))
  check('2-shot scene sums to 10s', two.reduce((a, b) => a + b, 0) === 10)
  check('5-shot scene sums to 25s', five.reduce((a, b) => a + b, 0) === 25)
  check('a longer scene does not lengthen its shots',
    five.every(v => v === 5), JSON.stringify(five))
}

console.log('\n--- an authored per-shot duration still wins ---')
{
  const payload = scene(2, 28)
  payload.episodes[0].scenes[0].shots[0].durationSeconds = 9
  const d = durationsOf(payload)
  check('the authored 9s is kept', d[0] === 9, JSON.stringify(d))
  check('the unspecified shot still defaults to 5s', d[1] === 5, JSON.stringify(d))
}

console.log('\n--- a scene with no shots still produces one row ---')
{
  const payload = {
    title: 'T',
    episodes: [{
      no: 1, title: 'E1', hook: 'h',
      scenes: [{
        no: 1, slug: 'INT. A - 夜', location: 'A', time: '夜',
        characters: ['甲'], action: 'x',
      }],
    }],
  }
  const norm = normalizeStageContent('script', payload)
  const shots = norm.shots ?? []
  check('one shot is synthesized', shots.length === 1, JSON.stringify(shots.length))
  check('and it has a sane duration', shots[0]?.durationSeconds >= 1, JSON.stringify(shots[0]?.durationSeconds))
}

console.log('\n--- every shot duration is a positive finite number ---')
{
  const d = durationsOf(scene(3, 30))
  check('all positive', d.every(v => Number.isFinite(v) && v >= 1), JSON.stringify(d))
}

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
