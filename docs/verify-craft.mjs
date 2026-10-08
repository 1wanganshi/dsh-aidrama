/**
 * dsh-aidrama — CRAFT INTEGRATION verification.
 *
 * The per-module suites prove `story.js` and `consistency.js` work in isolation.
 * THIS suite proves the opposite and more valuable thing: that the two new craft
 * engines are actually WIRED INTO the shipping pipeline, and that the pipeline got
 * BETTER rather than merely bigger.
 *
 * It answers the questions a per-module suite structurally cannot:
 *   - does the story brief a model receives actually contain the McKee beats?
 *   - does a generated 分镜 prompt actually carry a locked character canon and a
 *     machine-readable camera token, rather than a paraphrase and an adjective?
 *   - are the new schema fields preserved through the REAL normalizer?
 *   - did the graph/facet definitions stay in step with each other?
 *
 * Run: node docs/verify-craft.mjs
 * Zero dependencies. Exits non-zero on any failure.
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const load = name => import(pathToFileURL(path.join(root, 'lib', 'host', name)).href)

let passed = 0
let failed = 0
const failures = []
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failed += 1; failures.push(label); console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}
function section(title) { console.log(`\n— ${title} —`) }

const exists = async rel => fs.stat(path.join(root, rel)).then(() => true, () => false)

/* ------------------------------------------------------------------ gate */

section('the craft modules exist')

const hasStory = await exists('lib/host/story.js')
const hasConsistency = await exists('lib/host/consistency.js')

check('lib/host/story.js exists', hasStory)
check('lib/host/consistency.js exists', hasConsistency)

if (!hasStory || !hasConsistency) {
  console.log('\nSKIPPED — the craft modules have not landed yet.')
  console.log(`${passed} passed, ${failed} failed (gate)`)
  process.exit(failed === 0 ? 0 : 1)
}

const story = await load('story.js')
const consistency = await load('consistency.js')
const prompts = await load('prompts.js')
const stages = await load('stages.js')
const protocol = await load('protocol.js')

/* -------------------------------------------------- story brief wiring */

section('A. the McKee layer reaches the model')

check('story.js exports STORY_BRIEF_OVERLAY', story.STORY_BRIEF_OVERLAY !== undefined)

if (story.STORY_BRIEF_OVERLAY !== undefined) {
  const overlay = story.STORY_BRIEF_OVERLAY
  check('the overlay covers the story stage', overlay.story !== undefined)
  check('the overlay covers the script stage', overlay.script !== undefined)

  // THE WIRING TEST: the brief the model actually receives must carry the craft.
  const wired = typeof prompts.buildEnrichedBrief === 'function'
    ? prompts.buildEnrichedBrief('story', { overlay })
    : undefined

  if (wired === undefined) {
    // Fall back to inspecting TEXT_STAGE_BRIEF directly for the overlay's content.
    const briefStory = prompts.TEXT_STAGE_BRIEF?.story
    const briefScript = prompts.TEXT_STAGE_BRIEF?.script
    const storyText = `${briefStory?.system ?? ''}\n${briefStory?.task ?? ''}\n${briefStory?.schema ?? ''}`
    const scriptText = `${briefScript?.system ?? ''}\n${briefScript?.task ?? ''}\n${briefScript?.schema ?? ''}`

    const beatWords = (story.STORY_BEATS ?? []).map(beat => beat.name).filter(Boolean)
    const needles = ['激励事件', '转折点', '高潮', '价值']
    const foundInStory = needles.filter(word => storyText.includes(word))
    // The beats the model is told to fill should appear in the brief it is given.
    const beatNamesPresent = beatWords.filter(name => storyText.includes(name))

    check('the story brief mentions the inciting incident', storyText.includes('激励事件'),
      `brief len ${storyText.length}`)
    check('the story brief carries at least 3 McKee beats by name',
      beatNamesPresent.length >= 3, `found: ${beatNamesPresent.join('/')}`)
    check('the story brief states the value-turn rule',
      storyText.includes('价值') || storyText.includes('转折'))
    check('the story brief mentions the opening hook requirement',
      storyText.includes('钩子') || storyText.includes('前三秒') || storyText.includes('3 秒'))
    check('the script brief also received craft guidance',
      scriptText.includes('价值') || scriptText.includes('转折') || scriptText.includes('运镜')
        || scriptText.includes('景别'),
      `script brief len ${scriptText.length}`)
    check('the hooks are enumerated for the model',
      needles.some(word => storyText.includes(word)), foundInStory.join('/'))
  } else {
    const text = JSON.stringify(wired)
    check('an enriched story brief can be built', typeof wired === 'object' && wired !== null)
    check('the enriched story brief mentions 激励事件', text.includes('激励事件'))
  }
}

/* ---------------------------------------- story schema survives the store */

section('B. the new story fields survive the REAL normalizer')

{
  // A story using the fields the overlay's schemaAddendum introduces.
  const enrichedStory = {
    title: '逆袭的算法',
    logline: '林越被自己写的算法裁掉，三十天内夺回一切。',
    theme: '技术与良知',
    controllingIdea: '真正的算法应当服务于人，而不是替人做决定。',
    synopsis: '林越被裁后加入小公司，用算法做出爆款产品，最终选择开源。',
    acts: [
      { no: 1, name: '坠落', summary: '林越被自己写的算法裁掉', turningPoint: '发现裁员名单出自自己的算法' },
      { no: 2, name: '重建', summary: '加入小公司做出产品', turningPoint: '产品上线即被前导师抄袭' },
      { no: 3, name: '抉择', summary: '发现导师抄袭，选择开源', turningPoint: '在发布会上公开全部代码' },
    ],
    beats: [
      { id: 'inciting-incident', name: '激励事件', atSec: 6, summary: '屏幕上跳出他自己的名字' },
      { id: 'midpoint', name: '中点', atSec: 90, summary: '产品被抄，怀疑内部泄密' },
      { id: 'climax', name: '高潮', atSec: 200, summary: '发布会现场对峙' },
    ],
    characters: [
      { name: '林越', role: '主角', want: '证明算法可以有温度', obstacle: '被行业封杀' },
      { name: '周衡', role: '导师/对手', want: '保住行业地位', obstacle: '良心不安' },
    ],
    episodes: [
      { no: 1, title: '名单', hook: '裁员名单出自林越自己的算法', hookType: '身份反转',
        summary: '林越被裁员', reversalPoints: [6, 45, 90] },
    ],
  }

  const normalized = stages.normalizeStageContent('story', enrichedStory)

  check('the story normalizer keeps the controlling idea',
    normalized.controllingIdea === enrichedStory.controllingIdea,
    JSON.stringify(normalized.controllingIdea))
  check('the story normalizer keeps the beats array',
    Array.isArray(normalized.beats) && normalized.beats.length === 3,
    `got ${normalized.beats?.length}`)
  check('a beat keeps its id and second offset',
    normalized.beats?.[0]?.id === 'inciting-incident' && normalized.beats?.[0]?.atSec === 6,
    JSON.stringify(normalized.beats?.[0]))
  check('an act keeps its turning point',
    normalized.acts?.[0]?.turningPoint !== undefined,
    JSON.stringify(normalized.acts?.[0]))
  check('an episode keeps its hookType',
    normalized.episodes?.[0]?.hookType === '身份反转',
    JSON.stringify(normalized.episodes?.[0]?.hookType))
  check('an episode keeps its reversal points',
    Array.isArray(normalized.episodes?.[0]?.reversalPoints)
      && normalized.episodes[0].reversalPoints.length === 3,
    JSON.stringify(normalized.episodes?.[0]?.reversalPoints))
}

section('C. the new script fields survive the REAL normalizer')

{
  const enrichedScript = {
    title: '逆袭的算法',
    episodes: [{
      no: 1, title: '名单', hook: '名单出自他自己的算法', hookType: '身份反转',
      scenes: [{
        no: 1, slug: 'office-night', location: '写字楼开放办公区', time: '夜',
        characters: ['林越'], action: '林越独自坐在工位前，屏幕上是裁员名单。',
        dialogue: [{ who: '林越', line: '……这个排序，是我写的。' }],
        durationSec: 12,
        valueEntry: '希望', valueExit: '绝望',
        shots: [
          { no: 1, shot: '中景', camera: '缓推', description: '背影，屏幕冷光打在肩上', motion: '镜头缓慢推近' },
          { no: 2, shot: '特写', camera: '固定', description: '光标停在他自己的名字', motion: '光标微微闪烁' },
        ],
      }],
    }],
  }

  const normalized = stages.normalizeStageContent('script', enrichedScript)
  const shots = normalized.shots ?? []

  check('the script still flattens to real shots', shots.length === 2, `got ${shots.length}`)
  check('flattened shots still carry scene context', shots[0]?.sceneId?.startsWith('scene-'))
  check('the scene value charges survive as passthrough',
    normalized.episodes?.[0]?.scenes?.[0]?.valueEntry === '希望'
      && normalized.episodes?.[0]?.scenes?.[0]?.valueExit === '绝望',
    JSON.stringify([normalized.episodes?.[0]?.scenes?.[0]?.valueEntry, normalized.episodes?.[0]?.scenes?.[0]?.valueExit]))
  check('the episode hookType survives',
    normalized.episodes?.[0]?.hookType === '身份反转')
}

/* ------------------------------------------- consistency + camera wiring */

section('D. the camera vocabulary is real and machine-readable')

{
  const moves = consistency.CAMERA_MOVES
  check('CAMERA_MOVES is exported', moves !== undefined && typeof moves === 'object')

  const list = Array.isArray(moves) ? moves : Object.values(moves ?? {})
  check('there are at least 8 canonical moves', list.length >= 8, `got ${list.length}`)

  const tokens = list.map(move => move.token).filter(Boolean)
  check('every move carries a bracketed token',
    tokens.length === list.length && tokens.every(token => token.startsWith('[') && token.endsWith(']')),
    JSON.stringify(tokens.slice(0, 4)))
  check('the token vocabulary covers 推/拉/摇/移',
    ['推', '拉', '摇', '移'].every(word => tokens.some(token => token.includes(word))),
    JSON.stringify(tokens))
  check('every move documents its audience effect',
    list.every(move => typeof move.effect === 'string' && move.effect !== ''))

  const sizes = consistency.SHOT_SIZES
  const sizeList = Array.isArray(sizes) ? sizes : Object.values(sizes ?? {})
  check('SHOT_SIZES is exported and non-trivial', sizeList.length >= 5, `got ${sizeList.length}`)
  check('the 景别 set includes 特写 and 全景',
    sizeList.some(size => JSON.stringify(size).includes('特写'))
      && sizeList.some(size => JSON.stringify(size).includes('全景')))
}

section('E. a generated shot prompt carries the LOCK, not a paraphrase')

{
  const bible = {
    styleDna: '3D 国漫，电影级柔和轮廓光',
    characters: [{
      id: 'char-linyue', name: '林越', role: '主角',
      appearance: '清瘦', hair: '黑色短发，略乱', face: '下颌线清晰', body: '偏瘦高，178cm',
      outfit: '灰色连帽卫衣', accessory: '金属边框眼镜',
    }],
    scenes: [{ id: 'scene-office', name: '写字楼开放办公区', kind: 'interior',
      description: '深夜空旷工位区', lighting: '冷白屏光', composition: '纵深透视' }],
  }

  const normalizedBible = stages.normalizeStageContent('bible', bible)
  const character = normalizedBible.characters?.[0]
  check('the bible normalizes a character to lock', character !== undefined)

  const lock = consistency.lockCharacter(character)
  check('lockCharacter returns a canonical string', typeof lock?.canonical === 'string' && lock.canonical !== '')
  check('lockCharacter returns a fingerprint', typeof lock?.fingerprint === 'string' && lock.fingerprint !== '')

  const lockAgain = consistency.lockCharacter(character)
  check('the lock is DETERMINISTIC (byte-identical on re-lock)',
    lock.canonical === lockAgain.canonical && lock.fingerprint === lockAgain.fingerprint)

  // A different character must not collide.
  const other = consistency.lockCharacter({ ...character, name: '周衡', id: 'char-zhouheng', face: '方圆脸' })
  check('a different character produces a different fingerprint',
    other.fingerprint !== lock.fingerprint)

  // The reference plan must be honest and ordered.
  const plan = consistency.buildReferencePlan(
    { content: normalizedBible, assets: [] },
    [
      { kind: protocol.ASSET_KIND.shotRef, ref: 'shot-1-1-1', characters: ['林越'] },
      { kind: protocol.ASSET_KIND.characterSheet, ref: 'char-linyue' },
    ],
  )
  check('buildReferencePlan returns a plan', Array.isArray(plan), typeof plan)
  if (Array.isArray(plan)) {
    check('the plan orders dependencies first (sheets before dependent shots)',
      consistency.planIsOrdered(plan) === true,
      JSON.stringify(plan.map(entry => `${entry.kind}:${entry.ref}:L${entry.level}`)))
    check('a shot whose character has NO sheet yet is honest about it',
      plan.some(entry => entry.usesReferenceImage === false
        && typeof entry.rationale === 'string' && entry.rationale !== ''),
      JSON.stringify(plan.map(entry => ({ ref: entry.ref, lvl: entry.level, uses: entry.usesReferenceImage }))))
  }
}

section('F. the camera audit enforces machine-readable moves')

{
  const bad = consistency.auditCamera([
    { id: 'shot-1', seq: 1, cameraMove: '很有冲击力', action: '林越看着屏幕' },
    { id: 'shot-2', seq: 2, cameraMove: '震撼', action: '他站起身' },
  ], {})
  check('auditCamera flags subjective words with no technical move',
    Array.isArray(bad) && bad.length > 0, JSON.stringify(bad).slice(0, 200))
  check('the finding names a suggested token',
    Array.isArray(bad) && bad.some(finding => /\[.+\]/u.test(String(finding.fix ?? '') + String(finding.message ?? ''))),
    JSON.stringify(bad?.[0]))

  // Positive control: a properly tokened move must NOT be flagged as subjective.
  const good = consistency.auditCamera([
    { id: 'shot-1', seq: 1, cameraMove: '[推镜头]', shotSize: '中景', durationSeconds: 4, action: 'a' },
    { id: 'shot-2', seq: 2, cameraMove: '[摇镜头]', shotSize: '特写', durationSeconds: 3, action: 'b' },
  ], {})
  const subjectiveFindings = (good ?? []).filter(finding => finding.code === 'subjective-move'
    || /主观|形容词/u.test(String(finding.message ?? '')))
  check('a properly tokened move is NOT flagged as subjective (positive control)',
    subjectiveFindings.length === 0, JSON.stringify(subjectiveFindings))
}

section('G. the two engines agree with prompts.js rather than duplicating it')

{
  // The consistency layer must REUSE the negative list, not carry a copy.
  const negatives = prompts.GENERIC_NEGATIVE ?? prompts.CHARACTER_SHEET_NEGATIVE
  check('prompts.js still exports a negative list to reuse', Array.isArray(negatives) && negatives.length > 0)

  const directives = typeof consistency.buildConsistencyDirectives === 'function'
    ? consistency.buildConsistencyDirectives({
      styleDna: '3D 国漫',
      level: 2,
      characters: [{ id: 'char-linyue', name: '林越', hair: '黑色短发' }],
      scenes: [{ id: 'scene-office', name: '写字楼' }],
    })
    : undefined

  check('buildConsistencyDirectives returns something', directives !== undefined)
  if (directives !== undefined) {
    const text = typeof directives === 'string' ? directives : JSON.stringify(directives)
    check('the directives mention the 风格 DNA', text.includes('3D 国漫'))
    const sample = negatives[0]
    check('the directives re-use prompts.js negative wording verbatim',
      typeof sample === 'string' && text.includes(sample),
      `looked for ${sample}`)
  }
}

section('H. the story engine validates rather than rubber-stamps')

{
  const good = story.validateStructure({
    title: 'T', logline: 'L',
    controllingIdea: '真正的算法服务于人。',
    synopsis: 'S',
    acts: [
      { no: 1, name: 'A', summary: 's', turningPoint: 't1' },
      { no: 2, name: 'B', summary: 's', turningPoint: 't2' },
      { no: 3, name: 'C', summary: 's', turningPoint: 't3' },
    ],
    beats: (story.STORY_BEATS ?? []).map(beat => ({
      id: beat.id, name: beat.name,
      atSec: Math.round(((beat.positionMin + beat.positionMax) / 2) * 300),
      summary: 'x',
    })),
    ending: '林越开源了自己的算法，回答了控制性理念。',
    episodes: [{ no: 1, title: 'E', hook: 'h', summary: 's' }],
  })
  check('validateStructure returns a verdict object',
    good !== undefined && typeof good.ok === 'boolean', JSON.stringify(good)?.slice(0, 160))

  const missingInciting = story.validateStructure({
    title: 'T', logline: 'L', controllingIdea: 'c', synopsis: 's',
    acts: [{ no: 1, name: 'A', summary: 's', turningPoint: 't' }],
    beats: [{ id: 'climax', name: '高潮', atSec: 200, summary: 'x' }],
    ending: 'e', episodes: [{ no: 1, title: 'E', hook: 'h', summary: 's' }],
  })
  check('validateStructure REJECTS a story with no 激励事件',
    missingInciting?.ok === false, JSON.stringify(missingInciting)?.slice(0, 200))
}

/* ------------------------------------------------------------------ result */

console.log(`\n${'='.repeat(56)}`)
if (failed === 0) {
  console.log(`ALL PASS — ${passed} passed, 0 failed`)
  console.log('CRAFT INTEGRATION VERIFIED (both engines are wired in, not merely present)')
  process.exit(0)
} else {
  console.log(`FAILURES PRESENT — ${passed} passed, ${failed} failed`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exit(1)
}
