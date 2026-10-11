/**
 * WHOLE-FILM CONSISTENCY AUDIT.
 *
 * Consistency is not a property of one image, it is a property of the SET. A
 * project can look right shot by shot and still drift, because the thing that
 * holds a character together across 23 frames is that their real appearance is
 * repeated VERBATIM in every prompt that features them.
 *
 * So this does not look at pictures. It looks at the prompts the route would
 * build — using the route's own shot source and its own cast resolution — and
 * asks, for every shot, three questions:
 *
 *   1. Does the shot resolve to a cast at all? (An empty cast silently falls back
 *      to "与设定集保持一致", which is an instruction to match a design the model
 *      was never shown. That failure produced a long-haired, black-coated
 *      character for one specified as short-haired in a navy uniform.)
 *   2. Is every cast member's appearance actually present in the text?
 *   3. Does one character's description leak into a shot they are not in?
 *
 * Run: node docs/realtest/consistency-audit.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

let pass = 0, fail = 0
const problems = []
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1 }
  else { fail += 1; problems.push(`${label}${detail ? ` — ${detail}` : ''}`) }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `\n        ${detail}`}`)
}

const PROJECT = 'p-mv2dd4i9-s5w9k6i1'
const file = path.join(os.homedir(), '.dsh', 'aidrama', 'projects', `${PROJECT}.json`)
const project = JSON.parse(fs.readFileSync(file, 'utf8'))

/* ------------------------------------------------------------------ *
 * Use the ROUTE'S OWN shot source, not the flat one.
 *
 * `allShots()` prefers the episode tree, whose shots are raw model output. Reading
 * the flat list instead is how a green suite hid a broken first frame for two
 * rounds, so this takes the same path the product does.
 * ------------------------------------------------------------------ */
const routesSrc = fs.readFileSync(path.join(root, 'lib', 'host', 'routes.js'), 'utf8')
const grab = (name) => {
  const start = routesSrc.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`routes.js has no function ${name}`)
  return routesSrc.slice(start, routesSrc.indexOf('\n}\n', start) + 2)
}
const { allShots } = new Function(`
  const text = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  ${grab('shotsFromTree')}
  ${grab('allShots')}
  return { allShots };
`)()

const prompts = await import(pathToFileURL(path.join(root, 'lib', 'host', 'prompts.js')).href)

const bible = project.content.bible
const characters = Array.isArray(bible.characters) ? bible.characters : []
const scenes = Array.isArray(bible.scenes) ? bible.scenes : []
const shots = allShots(project)

// Mirror the route's resolution: id AND name both map to the card.
const characterById = new Map()
for (const c of characters) {
  if (c.id) characterById.set(String(c.id), c)
  if (c.name) characterById.set(String(c.name), c)
}

console.log(`项目「${project.title}」：${shots.length} 个镜头，${characters.length} 个人物\n`)
console.log('=== 逐镜审计 ===')

/** The appearance fragments that must appear for a character to be locked. */
function appearanceFragments(character) {
  return [
    character.hair, character.face, character.outfit, character.accessory,
  ]
    .map(v => String(v ?? '').trim())
    .filter(v => v !== '')
    // A field may hold "齐耳黑短发，中分"; the builder may reorder clauses, so
    // require the FIRST distinctive fragment only.
    .map(v => v.split(/[，,]/)[0].trim())
    .filter(v => v.length >= 2)
}

const results = []
for (const shot of shots) {
  const castNames = Array.isArray(shot.characters) ? shot.characters : []
  const cast = castNames.map(n => characterById.get(String(n)) ?? { name: String(n) })
  const scene = scenes.find(s => String(s.name) === String(shot.scene))
    ?? scenes.find(s => String(s.name).includes(String(shot.scene)))
    ?? {}

  const prompt = String(prompts.buildShotRef({
    ...shot,
    characters: cast,
    scene,
    style: bible.styleDna,
    aspectRatio: project.aspectRatio,
  }))

  const known = cast.filter(c => c.hair || c.face || c.outfit)
  const missing = []
  for (const c of known) {
    const frags = appearanceFragments(c)
    if (frags.length === 0) continue
    const hits = frags.filter(f => prompt.includes(f))
    if (hits.length === 0) missing.push(`${c.name}(${frags[0]})`)
  }

  results.push({ id: shot.id, castNames, prompt, missing, characters: cast })
  const tag = missing.length === 0 ? '✓' : '✗'
  console.log(`  ${tag} ${String(shot.id).padEnd(13)} cast=${JSON.stringify(castNames).padEnd(30)} ${missing.length ? `缺: ${missing.join(', ')}` : ''}`)
}

/* ------------------------------------------------------------------ *
 * 1. Every shot must resolve to a cast.
 * ------------------------------------------------------------------ */
console.log('\n=== 汇总 ===')
const noCast = results.filter(r => r.castNames.length === 0)
check('每个镜头都解析出了人物', noCast.length === 0,
  noCast.map(r => r.id).join(', '))

/* ------------------------------------------------------------------ *
 * 2. Every cast member's appearance must be in the prompt.
 * ------------------------------------------------------------------ */
const withMissing = results.filter(r => r.missing.length > 0)
check('每个人物的外观都写进了对应镜头的提示词', withMissing.length === 0,
  withMissing.map(r => `${r.id}: ${r.missing.join(', ')}`).join(' | '))

/* ------------------------------------------------------------------ *
 * 3. A character must NOT leak into a shot they are not in.
 * ------------------------------------------------------------------ */
const leaks = []
for (const r of results) {
  for (const c of characters) {
    if (r.castNames.includes(String(c.name)) || r.castNames.includes(String(c.id))) continue
    const frags = appearanceFragments(c)
    if (frags.length === 0) continue
    // Two fragments matching is a leak; one may be coincidence shared wording.
    const hits = frags.filter(f => r.prompt.includes(f))
    if (hits.length >= 2) leaks.push(`${r.id} 混入了 ${c.name}`)
  }
}
check('没有人物串场（未出场者的外观不会出现在提示词里）', leaks.length === 0, leaks.join(' | '))

/* ------------------------------------------------------------------ *
 * 4. A character who appears in several shots must be described the SAME way.
 * ------------------------------------------------------------------ */
console.log('\n=== 同一人物跨镜描述是否一致 ===')
for (const c of characters) {
  const frags = appearanceFragments(c)
  if (frags.length === 0) continue
  const inShots = results.filter(r =>
    r.castNames.includes(String(c.name)) || r.castNames.includes(String(c.id)))
  if (inShots.length === 0) continue
  // For each shot, which of the fragments are present.
  const signatures = inShots.map(r => frags.filter(f => r.prompt.includes(f)).join('|'))
  const unique = [...new Set(signatures)]
  check(`  ${c.name}：${inShots.length} 个镜头里描述一致（${frags.length} 个特征片段）`,
    unique.length === 1,
    unique.length === 1 ? '' : `出现 ${unique.length} 种不同组合：${unique.join(' / ')}`)
}

/* ------------------------------------------------------------------ *
 * 5. The two 周晚 must be distinguishable in the same frame.
 * ------------------------------------------------------------------ */
console.log('\n=== 两个周晚同框 ===')
const both = results.filter(r =>
  r.castNames.includes('周晚') && r.castNames.includes('三年前的周晚'))
console.log(`  同框镜头：${both.map(r => r.id).join(', ') || '(无)'}`)
check('第 4 集有两人同框的镜头', both.length >= 3, `找到 ${both.length} 个`)
if (both.length > 0) {
  const sample = both[0]
  const young = characters.find(c => String(c.name) === '周晚')
  const past = characters.find(c => String(c.name) === '三年前的周晚')
  check('同框提示词同时包含两人', sample.prompt.includes(String(young?.hair).split('，')[0])
    && sample.prompt.includes(String(past?.hair).split('，')[0]),
    sample.prompt.slice(0, 160))
  // They must be told apart, not just both mentioned.
  check('同框提示词里两人特征不同（能区分）',
    String(young?.hair) !== String(past?.hair),
    `周晚 hair=${young?.hair} / 三年前=${past?.hair}`)
}

console.log(`\n${'='.repeat(60)}`)
if (fail === 0) {
  console.log(`ALL PASS — ${pass} passed, 0 failed`)
} else {
  console.log(`${fail} FAILED of ${pass + fail}`)
  console.log('problems:\n  ' + problems.join('\n  '))
}
process.exit(fail === 0 ? 0 : 1)
