/**
 * dsh-aidrama — CHARACTER LOCK PROPAGATION regression suite.
 *
 * WHY THIS FILE EXISTS
 *
 * A real run against the live image channel produced a character with long hair
 * and a black coat for a character the bible specified as short-haired in a navy
 * uniform with a badge. The image was beautiful and completely wrong.
 *
 * Root cause was a chain of four independent discards, each of which looked
 * harmless on its own:
 *
 *   1. `shotsFromTree()` returned the NESTED shot, which has no `characters`
 *      field — the cast is declared on the SCENE — so the cast list was empty.
 *   2. `characterById` mapped id/name to the NAME STRING, not the card, so even a
 *      successful lookup returned no appearance data.
 *   3. `list()` deliberately collapses an object to its `.name`, discarding every
 *      other field, and was being used to normalise the cast.
 *   4. `buildShotRef()` emitted only the names.
 *
 * The net effect: every shot prompt said "画面中的 <name> 必须严格沿用其角色设定
 * 三视图" while never describing the character. Naming is not describing.
 *
 * This suite asserts the WHOLE CHAIN, end to end through the real route handler,
 * because each layer individually passed its own unit tests while the pipeline
 * still lost the data.
 *
 * Run: node docs/verify-character-lock.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const lib = name => import(pathToFileURL(path.join(root, 'lib', 'host', name)).href)

let passed = 0
let failed = 0
const failures = []
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failed += 1; failures.push(label); console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}
const section = title => console.log(`\n— ${title} —`)

const store = await lib('store.js')
const stages = await lib('stages.js')
const prompts = await lib('prompts.js')
const video = await lib('video.js')
const { makeAidramaRoutes } = await lib('routes.js')
const P = await lib('protocol.js')

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-charlock-'))
store.setDataRoot(tmp)

let captured = []
const routes = makeAidramaRoutes({
  store, stages, prompts, video,
  resolveConfig: () => ({
    enabled: true, allowAgentGeneration: true, announceToAgent: true,
    channels: [{ id: 'c', name: 'c', apiUrl: 'https://example.invalid/v1', apiKey: 'k',
      protocol: 'auto', models: [{ id: 'm', alias: 'm' }] }],
    defaultChannelId: 'c', defaultModel: 'm', videoChannels: [], defaultVideoChannelId: '',
    styleDna: P.PROJECT_DEFAULTS.styleDna, aspectRatio: '9:16', shotSeconds: 5,
  }),
  // Capture the prompt instead of calling upstream: this suite is offline by design.
  generateImage: async request => { captured.push(request); throw new Error('captured') },
  log: () => {},
})

const byPath = p => routes.find(r => r.kind === 'exact' && r.path === p)
function call(routePath, body) {
  return new Promise((resolve, reject) => {
    const route = byPath(routePath)
    if (route === undefined) return reject(new Error(`no route ${routePath}`))
    const chunks = []
    const req = {
      method: 'POST', url: routePath, headers: { host: '127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }
    const res = {
      writeHead() { return res }, setHeader() { return res },
      end(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) },
    }
    route.handler(req, res)
  })
}

/** Distinctive tokens that must survive to the prompt. */
const HAIR = '黑色短发齐耳'
const OUTFIT = '深蓝地铁制服左胸工牌'
const ACCESSORY = '银色细链耳钉'

const proj = await call(P.AIDRAMA_API.projects, { action: 'create', title: '角色锁传播测试' })
const pid = proj.project.id

await call(P.AIDRAMA_API.stage, {
  projectId: pid, stage: 'bible', action: 'commit',
  payload: {
    styleDna: '3D 国漫，冷蓝夜色',
    characters: [{
      id: 'char-linwan', name: '林晚', role: '主角',
      appearance: '清瘦', hair: HAIR, face: '鹅蛋脸',
      body: '偏瘦，165cm', outfit: OUTFIT, accessory: ACCESSORY,
    }],
    scenes: [{ id: 'scene-subway', name: '地铁车厢', kind: 'interior',
      description: '末班车空车厢', lighting: '冷白顶灯', composition: '纵深透视' }],
  },
})

await call(P.AIDRAMA_API.stage, {
  projectId: pid, stage: 'script', action: 'commit',
  payload: {
    title: 't',
    episodes: [{
      no: 1, title: 'e',
      scenes: [{
        no: 1, slug: 'subway-night', location: '地铁车厢', time: '夜',
        // The cast is declared HERE, on the scene — not on the shot. That is the
        // shape the real normalizer produces and the shape that broke.
        characters: ['char-linwan'],
        action: '林晚对着话筒报站。',
        dialogue: [{ who: '林晚', line: '下一站，西平路。' }],
        durationSec: 12,
        shots: [
          // NOTE: no `characters` key — this is the crux of the bug.
          { no: 1, shot: '中景', camera: '[推镜头]', description: '林晚对着话筒报站', motion: '缓慢推近' },
        ],
      }],
    }],
  },
})

/* ------------------------------------------------------------------ run */

section('A. the route resolves the cast from the SCENE')

captured = []
const gen = await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'visual', action: 'generate', payload: {} })

check('generation ran and produced per-target requests', captured.length > 0, `captured ${captured.length}`)
check('the batch reports failures instead of throwing', gen.ok === true, JSON.stringify(gen).slice(0, 160))

const shotReqs = captured.filter(r => r.kind === P.ASSET_KIND.shotRef)
check('at least one shot-ref was requested', shotReqs.length > 0, `got ${shotReqs.length}`)

section('B. the shot prompt carries the LOCKED APPEARANCE (the actual bug)')

for (const request of shotReqs) {
  const text = String(request.prompt)
  const ref = request.ref
  check(`[${ref}] the prompt contains the locked hair (${HAIR})`, text.includes(HAIR))
  check(`[${ref}] the prompt contains the locked outfit (${OUTFIT})`, text.includes(OUTFIT))
  check(`[${ref}] the prompt contains the locked accessory (${ACCESSORY})`, text.includes(ACCESSORY))
  check(`[${ref}] the prompt names the character`, text.includes('林晚'))
  check(`[${ref}] the prompt does NOT fall back to the generic clause`,
    !text.includes('必须与本项目设定集保持一致') || text.includes(HAIR),
    'the generic fallback means the cast was empty again')
}

section('C. the character-sheet prompt also carries the appearance')

const sheetReqs = captured.filter(r => r.kind === P.ASSET_KIND.characterSheet)
check('a character sheet was requested', sheetReqs.length > 0)
for (const request of sheetReqs) {
  const text = String(request.prompt)
  check(`[${request.ref}] the sheet prompt contains the locked hair`, text.includes(HAIR))
  check(`[${request.ref}] the sheet prompt contains the locked outfit`, text.includes(OUTFIT))
}

section('D. the scene master carries its own scene data')

const masterReqs = captured.filter(r => r.kind === P.ASSET_KIND.sceneMaster)
check('a scene master was requested', masterReqs.length > 0)
for (const request of masterReqs) {
  const text = String(request.prompt)
  check(`[${request.ref}] the master prompt contains the scene lighting`,
    text.includes('冷白顶灯'), text.slice(0, 160))
}

/* ------------------------------------------- unit-level guards on helpers */

section('E. buildShotRef: naming is still allowed, describing is required when known')

{
  const withCard = prompts.buildShotRef({
    description: 'x', shot: '中景',
    characters: [{ id: 'char-linwan', name: '林晚', hair: HAIR, outfit: OUTFIT }],
  })
  check('a full card is described verbatim', withCard.includes(HAIR) && withCard.includes(OUTFIT))

  const nameOnly = prompts.buildShotRef({ description: 'x', shot: '中景', characters: ['林晚'] })
  check('a bare name still produces a usable prompt', nameOnly.includes('林晚'))
  check('a bare name does NOT fake a description', !nameOnly.includes(HAIR))

  const titleCard = prompts.buildShotRef({ description: 'x', shot: '中景', characters: [{ id: 's', title: '苏婉' }] })
  check('a card keyed by title is not dropped', titleCard.includes('苏婉'), titleCard.slice(0, 100))

  const idOnly = prompts.buildShotRef({ description: 'x', shot: '中景', characters: [{ id: 'lin-yue' }] })
  check('a card with only an id falls back to the id', idOnly.includes('lin-yue'))

  // THE ANTI-REGRESSION GUARD: a card WITH appearance must never render as bare
  // name, which is precisely what `list()` used to force.
  const mixed = prompts.buildShotRef({
    description: 'x', shot: '中景',
    characters: [{ name: '林晚', hair: HAIR }, '周衡'],
  })
  check('a mixed cast describes the known card and names the unknown one',
    mixed.includes(HAIR) && mixed.includes('周衡'), mixed.slice(0, 200))
}

section('F. the lossy helper is not used on the cast')

{
  const source = await fs.readFile(path.join(root, 'lib', 'host', 'prompts.js'), 'utf8')
  const fnStart = source.indexOf('export function buildShotRef')
  const fnEnd = source.indexOf('\n}', fnStart)
  const body = source.slice(fnStart, fnEnd)
  // Strip comments first: this check is about CODE, and the explanatory comment
  // above the fix mentions `list(v.characters)` by name. Matching raw text would
  // flag the very comment that documents the bug.
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  check('buildShotRef no longer collapses the cast with list()',
    !/list\(\s*v\.characters\s*\)/.test(code),
    'list(v.characters) silently drops every field except .name')

  // Positive control: the same detector DOES fire on the old form, so a passing
  // result cannot be an artefact of an over-eager stripper.
  const synthetic = 'const cast = list(v.characters)\n'
  check('the detector still catches the old form (positive control)',
    /list\(\s*v\.characters\s*\)/.test(synthetic))

  // And the cast must be built from the raw array, not from the lossy helper.
  check('the cast is taken from the raw characters array',
    /Array\.isArray\(v\.characters\)/.test(code) || /v\.characters/.test(code))
}

/* ---------------------------------------------------------------- report */

await fs.rm(tmp, { recursive: true, force: true })

console.log(`\n${'='.repeat(56)}`)
if (failed === 0) {
  console.log(`ALL PASS — ${passed} passed, 0 failed`)
  console.log('CHARACTER LOCK PROPAGATION VERIFIED (scene -> shot -> prompt)')
  process.exit(0)
} else {
  console.log(`FAILURES PRESENT — ${passed} passed, ${failed} failed`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exit(1)
}
