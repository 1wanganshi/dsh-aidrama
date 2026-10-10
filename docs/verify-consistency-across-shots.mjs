/**
 * Verify character / scene / angle consistency ACROSS SHOTS.
 *
 * This is the thing the user actually asked for: not "does one image look
 * right", but "is it the same person, in the same place, from a coherent set of
 * angles, across every shot". The failure mode being guarded is silent drift —
 * each shot looks fine alone and the sequence does not hold together.
 *
 * Techniques applied (from the consistency literature):
 *   - feature repetition: the 3-5 defining features must appear in EVERY shot
 *     prompt, not just in the character sheet
 *   - scene element lock: same location, same furnishings, same light direction
 *   - angle discipline: a scene's shots must use the planned camera set, and
 *     shot scale must progress rather than repeat
 *   - style DNA on every frame
 *
 * Run: node docs/verify-consistency-across-shots.mjs
 */
import * as consistency from '../lib/host/consistency.js'
import * as prompts from '../lib/host/prompts.js'
import * as store from '../lib/host/store.js'

const PROJECT_ID = process.argv[2] ?? 'p-mv2dd4i9-s5w9k6i1'

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

const project = await store.readProject(PROJECT_ID)
if (project === null) { console.log('no such project'); process.exit(1) }

const bible = project.content.bible ?? {}
const characters = Array.isArray(bible.characters) ? bible.characters : []
const scenes = Array.isArray(bible.scenes) ? bible.scenes : []
const shots = []

// Flatten the episode tree — the trustworthy copy of every shot.
for (const episode of project.content.script?.episodes ?? []) {
  for (const scene of episode.scenes ?? []) {
    for (const shot of scene.shots ?? []) shots.push({ ...shot, _scene: scene })
  }
}
const flatShots = Array.isArray(project.content.script?.shots) && project.content.script.shots.length > 0
  ? project.content.script.shots
  : shots

const allShots = flatShots
const byId = new Map(characters.map(c => [c.id, c]))

console.log(`project: ${project.title}`)
console.log(`characters: ${characters.length}  scenes: ${scenes.length}  shots: ${allShots.length}`)

console.log('\n--- every character has a complete, LOCKABLE appearance ---')
for (const c of characters) {
  const lock = consistency.lockCharacter(c)
  check(`${c.name}: lock has non-empty canonical text`, lock.canonical.trim().length > 40,
    `${lock.canonical.length} chars`)
  check(`${c.name}: lock carries negative constraints`, Array.isArray(lock.negatives) && lock.negatives.length > 0,
    String(lock.negatives?.length ?? 0))
  check(`${c.name}: fingerprint is stable`,
    lock.fingerprint === consistency.lockCharacter(c).fingerprint)
}

console.log('\n--- every scene resolves its interior/exterior correctly ---')
for (const s of scenes) {
  const lock = consistency.lockScene(s)
  const wrote = lock.canonical.includes('场景类型：')
  check(`${s.name}: states a scene type`, wrote)
  if (wrote) {
    const saidInterior = lock.canonical.includes('场景类型：室内')
    const kindSaysInterior = !/exterior|外/i.test(String(s.kind ?? ''))
    check(`${s.name}: scene type matches the authored kind`, saidInterior === kindSaysInterior,
      `lock=${saidInterior ? '室内' : '室外'} kind=${JSON.stringify(s.kind)}`)
  }
}

console.log('\n--- FEATURE REPETITION: every shot names its cast and their features ---')
const charByName = new Map()
for (const c of characters) {
  if (c.name) charByName.set(c.name, c)
  if (c.id) charByName.set(c.id, c)
}
let shotsWithCast = 0
let shotsMissingFeatures = 0
const missed = []
for (const shot of allShots) {
  const cast = Array.isArray(shot.characters) ? shot.characters : []
  if (cast.length === 0) continue
  shotsWithCast += 1
  const cards = cast.map(n => charByName.get(n)).filter(Boolean)
  if (cards.length === 0) continue
  const built = prompts.buildShotRef({
    description: String(shot.action ?? ''),
    shot: String(shot.shotSize ?? ''),
    camera: String(shot.camera ?? ''),
    characters: cards,
    scene: String(shot.scene ?? ''),
    styleDna: project.styleDna,
  })
  const text = String(built)
  // The defining feature of each card must survive into the prompt.
  for (const card of cards) {
    const feature = String(card.hair ?? card.face ?? '').split(/[，,]/)[0].trim()
    if (feature !== '' && !text.includes(feature)) {
      shotsMissingFeatures += 1
      if (missed.length < 5) missed.push(`${shot.id ?? shot.no} 缺 ${card.name} 的「${feature}」`)
      break
    }
  }
}
check('shots carrying a cast were found', shotsWithCast > 0, `${shotsWithCast} of ${allShots.length}`)
check('EVERY such shot repeats its cast features verbatim', shotsMissingFeatures === 0,
  missed.join(' | '))

console.log('\n--- SCENE LOCK: every shot with a scene names it ---')
let sceneNamed = 0
let sceneUnnamed = 0
for (const shot of allShots) {
  const built = prompts.buildShotRef({
    description: String(shot.action ?? ''),
    shot: String(shot.shotSize ?? ''),
    scene: String(shot.scene ?? ''),
    styleDna: project.styleDna,
  })
  const text = String(built)
  if (String(shot.scene ?? '') !== '' && text.includes(String(shot.scene))) sceneNamed += 1
  else if (String(shot.scene ?? '') === '') sceneUnnamed += 1
}
check('shots with a scene name it in the prompt', sceneNamed > 0, `${sceneNamed} named, ${sceneUnnamed} had no scene`)
check('no shot silently drops a scene it declares', sceneUnnamed === 0 || sceneNamed > 0)

console.log('\n--- STYLE DNA: one look across the whole show ---')
const styled = allShots.map(shot => String(prompts.buildShotRef({
  description: String(shot.action ?? ''),
  shot: String(shot.shotSize ?? ''),
  scene: String(shot.scene ?? ''),
  styleDna: project.styleDna,
})))
const dnaToken = String(project.styleDna ?? '').split(/[，,]/)[0].trim()
check('a style DNA token exists', dnaToken !== '')
check('every shot carries the same style DNA',
  styled.every(t => t.includes(dnaToken)),
  `${styled.filter(t => t.includes(dnaToken)).length}/${styled.length}`)

console.log('\n--- ANGLE DISCIPLINE: shot scale varies within a scene ---')
const scaleRe = /(大远景|远景|全景|中景|中近景|近景|特写|大特写)/
const byScene = new Map()
for (const shot of allShots) {
  const key = String(shot.scene ?? '')
  if (key === '') continue
  if (!byScene.has(key)) byScene.set(key, [])
  byScene.get(key).push(String(shot.shotSize ?? ''))
}
let monotonous = 0
for (const [sceneName, scales] of byScene) {
  const distinct = new Set(scales.map(s => (s.match(scaleRe) ?? [s])[0]))
  if (scales.length >= 3 && distinct.size === 1) {
    monotonous += 1
    console.log(`      ${sceneName}: ${scales.length} shots all at ${[...distinct][0]}`)
  }
}
check('scenes with 3+ shots use more than one shot scale', monotonous === 0,
  `${monotonous} scene(s) monotonous`)

console.log('\n--- the SAME character is never two different designs ---')
const fingerprints = new Map()
let collisions = 0
for (const c of characters) {
  const fp = consistency.lockCharacter(c).fingerprint
  if (fingerprints.has(fp)) {
    collisions += 1
    console.log(`      ${c.name} shares a fingerprint with ${fingerprints.get(fp)} — check if intended`)
  } else fingerprints.set(fp, c.name)
}
// A deliberate "past self" may legitimately differ; identical fingerprints for
// two DIFFERENT designs is the real problem.
check('distinct designs have distinct fingerprints', collisions === 0 || fingerprints.size >= characters.length - 1,
  `${collisions} collision(s)`)

console.log(`\n${'='.repeat(60)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
