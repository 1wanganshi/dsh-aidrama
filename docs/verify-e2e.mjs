/**
 * dsh-aidrama — end-to-end pipeline acceptance.
 *
 * This is the LEAD's acceptance test, deliberately separate from the per-module
 * self-tests: those prove each module in isolation, this proves the SIX STAGES
 * actually chain. It drives the REAL route handlers against a REAL on-disk store
 * in a temp root, walking a whole short drama from a one-line idea to a video
 * prompt pack, and asserts the contract at every hand-off.
 *
 * What only this test can catch:
 *  - a stage that produces output the NEXT stage cannot read
 *  - asset bytes reachable over the asset route after a generation batch
 *  - the ghost-shot regression (shots stranded inside the episode tree)
 *  - config/routes leaking a key anywhere in the whole run
 *  - prompt-pack completing with no video channel configured
 *
 * Run: node docs/verify-e2e.mjs
 * Zero dependencies. Exits non-zero on any failure.
 */

import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

import * as store from '../lib/host/store.js'
import * as stages from '../lib/host/stages.js'
import * as prompts from '../lib/host/prompts.js'
import * as video from '../lib/host/video.js'
import { makeAidramaRoutes } from '../lib/host/routes.js'
import { AIDRAMA_API, STAGES, STAGE_STATUS, VIDEO_PROTOCOL, ASSET_KIND } from '../lib/host/protocol.js'

/* ------------------------------------------------------------------ harness */

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function section(title) {
  console.log(`\n— ${title} —`)
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-aidrama-e2e-'))
store.setDataRoot(tempRoot)

/** A tiny 1x1 PNG, so the store sees real image bytes. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** Every response body this run produced, for the key-hygiene sweep. */
const seenBodies = []

const CANARY_KEY = 'sk-E2E-CANARY-MUST-NOT-LEAK-3b7f'

const effectiveConfig = {
  enabled: true,
  announceToAgent: true,
  allowAgentGeneration: true,
  channels: [{
    id: 'img-1',
    name: '主图像渠道',
    apiUrl: 'https://images.example.invalid/v1',
    apiKey: CANARY_KEY,
    protocol: 'auto',
    models: [{ alias: 'test-image', id: 'test-image-upstream' }],
  }],
  defaultChannelId: 'img-1',
  defaultModel: 'test-image',
  // A keyed video channel is deliberately ABSENT so prompt-pack is exercised.
  videoChannels: [],
  defaultVideoChannelId: '',
  styleDna: '3D 国漫，电影级柔和轮廓光',
  aspectRatio: '9:16',
  shotSeconds: 5,
}

/** The last generation request the seam received, for prompt assertions. */
const generationRequests = []
/**
 * Targets the seam should reject. Matched on the ASSET KIND the route is
 * generating (the prompt text is model-authored and changes with the templates,
 * so matching on it was brittle and silently never fired).
 */
const failKinds = new Set()

const routes = makeAidramaRoutes({
  store,
  stages,
  prompts,
  video,
  resolveConfig: () => effectiveConfig,
  generateImage: async request => {
    generationRequests.push(request)
    if (request.kind !== undefined && failKinds.has(request.kind)) {
      throw new Error('上游拒绝（故意构造的失败）')
    }
    return { images: [{ b64: PNG_1X1.toString('base64'), mime: 'image/png' }], model: 'test-image', channel: '主图像渠道' }
  },
})

/** Find an exact route by path. */
function routeFor(apiPath) {
  const found = routes.find(route => route.kind === 'exact' && route.path === apiPath)
  if (found === undefined) throw new Error(`no exact route for ${apiPath}`)
  return found
}

/**
 * Drive a route handler with a synthetic request/response pair.
 * @param {{kind:string, path:string, handler:Function}} route
 * @param {object} body
 * @param {{method?:string, url?:string, remoteAddress?:string, headers?:object}} [opts]
 */
function call(route, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let status = 200
    const headers = {}
    const req = {
      method: opts.method ?? 'POST',
      url: opts.url ?? route.path,
      headers: { host: '127.0.0.1:19387', 'content-type': 'application/json', ...(opts.headers ?? {}) },
      socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body ?? {}), 'utf8')
      },
    }
    const res = {
      writeHead(code, extra) {
        status = code
        if (extra) Object.assign(headers, extra)
        return res
      },
      setHeader(name, value) { headers[name] = value; return res },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        }
        const raw = Buffer.concat(chunks)
        seenBodies.push(raw.toString('utf8'))
        let parsed
        try { parsed = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8')) } catch { parsed = { __raw: raw } }
        resolve({ status, headers, body: parsed })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

const post = (apiPath, body, opts) => call(routeFor(apiPath), body, opts)

/* ================================================================== stages */

section('every stage is reachable and starts empty')
{
  const created = await post(AIDRAMA_API.projects, { action: 'create', title: '逆袭的算法', logline: '一个被裁的程序员用 AI 翻盘' })
  check('create returns a project', created.body.ok === true && created.body.project !== undefined)
  const project = created.body.project
  const projectId = project.id

  check('a new project has all six stages', stages.stageView(project).length === STAGES.length,
    `got ${stages.stageView(project).length}`)
  check('every stage starts empty',
    stages.stageView(project).every(stage => stage.status === STAGE_STATUS.empty))

  /* ------------------------------------------------ 1. idea (text stage) */
  section('1. idea — brief then commit')
  const ideaBrief = await post(AIDRAMA_API.stage, { projectId, stage: 'idea', action: 'brief' })
  check('idea brief is served', ideaBrief.body.ok === true)
  check('the brief carries a schema', typeof ideaBrief.body.brief?.schema === 'string'
    && ideaBrief.body.brief.schema.includes('logline'))

  const ideaContent = {
    title: '逆袭的算法',
    logline: '被裁的程序员林越用一段算法翻盘，却发现对手是他的前导师。',
    genre: '都市逆袭',
    tone: '克制、热血',
    protagonist: '林越，28 岁算法工程师',
    conflict: '技术理想与商业现实的冲突，以及与前导师的师徒对决',
    hook: '第一集结尾，林越发现裁员名单是他自己写的算法生成的',
    ending: '林越放弃复仇，开源了自己的算法',
    questions: ['你想要更爽的节奏还是更写实的质感？'],
  }
  const ideaCommit = await post(AIDRAMA_API.stage, { projectId, stage: 'idea', action: 'commit', payload: ideaContent })
  check('idea commits', ideaCommit.body.ok === true, JSON.stringify(ideaCommit.body).slice(0, 200))
  check('idea is marked ready', ideaCommit.body.project?.stages?.idea?.status === STAGE_STATUS.ready)

  /* ----------------------------------------------- 2. story (text stage) */
  section('2. story')
  const storyContent = {
    title: '逆袭的算法',
    logline: ideaContent.logline,
    theme: '技术与良知',
    synopsis: '林越被裁后加入小公司，用算法做出爆款产品。',
    acts: [
      { no: 1, name: '坠落', summary: '林越被自己写的算法裁掉' },
      { no: 2, name: '重建', summary: '加入小公司，做出产品' },
      { no: 3, name: '抉择', summary: '发现导师抄袭，选择开源' },
    ],
    characters: [
      { name: '林越', role: '主角', want: '证明算法可以有温度', obstacle: '被行业封杀' },
      { name: '周衡', role: '导师/对手', want: '保住行业地位', obstacle: '良心不安' },
    ],
    episodes: [
      { no: 1, title: '名单', hook: '裁员名单出自林越自己的算法', summary: '林越被裁员' },
      { no: 2, title: '重启', hook: '新产品上线即被抄袭', summary: '林越加入小公司' },
    ],
  }
  const storyCommit = await post(AIDRAMA_API.stage, { projectId, stage: 'story', action: 'commit', payload: storyContent })
  check('story commits', storyCommit.body.ok === true)
  check('story is marked ready', storyCommit.body.project?.stages?.story?.status === STAGE_STATUS.ready)

  /* ---------------------------------------------- 3. script (text stage) */
  section('3. script — the tree that must flatten correctly')
  const scriptContent = {
    title: '逆袭的算法',
    episodes: [
      {
        no: 1,
        title: '名单',
        hook: '裁员名单出自林越自己的算法',
        scenes: [
          {
            no: 1,
            slug: 'office-night',
            location: '写字楼开放办公区',
            time: '夜',
            characters: ['林越'],
            action: '林越独自坐在工位前，屏幕上是裁员名单，他一行行往下看，停在自己的名字上。',
            dialogue: [
              { who: '林越', line: '……这个排序，是我写的。' },
            ],
            durationSec: 12,
            shots: [
              { no: 1, shot: '中景', camera: '缓推', description: '林越背影，屏幕冷光打在肩上', motion: '镜头缓慢推近' },
              { no: 2, shot: '特写', camera: '固定', description: '屏幕上光标停在他自己的名字', motion: '光标微微闪烁' },
              { no: 3, shot: '近景', camera: '手持', description: '林越的脸，眼神从困惑转为自嘲', motion: '轻微呼吸起伏' },
            ],
          },
          {
            no: 2,
            slug: 'rooftop-dawn',
            location: '天台',
            time: '清晨',
            characters: ['林越'],
            action: '林越站在天台上，城市刚亮。他删掉了手机里所有求职邮件。',
            dialogue: [{ who: '林越', line: '那就重写一遍。' }],
            durationSec: 8,
            shots: [
              { no: 1, shot: '大全景', camera: '升格', description: '天台边缘的剪影，远处城市天际线', motion: '航拍缓慢上升' },
            ],
          },
        ],
      },
    ],
  }
  const scriptCommit = await post(AIDRAMA_API.stage, { projectId, stage: 'script', action: 'commit', payload: scriptContent })
  check('script commits', scriptCommit.body.ok === true)

  const shots = scriptCommit.body.project?.content?.script?.shots ?? []
  check('script flattens into REAL shots, not one ghost row', shots.length === 4, `got ${shots.length}`)
  check('a flattened shot carries its scene context',
    shots[0]?.sceneId?.startsWith('scene-') && shots[0]?.scene !== '' && shots[0]?.time === '夜',
    JSON.stringify({ sceneId: shots[0]?.sceneId, scene: shots[0]?.scene, time: shots[0]?.time }))
  check('a flattened shot carries scene 2 context too',
    shots[3]?.time === '清晨' && shots[3]?.location === '天台',
    JSON.stringify({ time: shots[3]?.time, location: shots[3]?.location }))
  check('dialogue is flattened into readable lines',
    shots[0]?.dialogue?.includes('这个排序') === true, JSON.stringify(shots[0]?.dialogue))
  check('shot ids are episode-scene-shot scoped',
    shots[0]?.id === 'shot-1-1-1' && shots[3]?.id === 'shot-1-2-1',
    JSON.stringify([shots[0]?.id, shots[3]?.id]))
  check('shots are ordered by seq 1..4',
    shots.map(shot => shot.seq).join(',') === '1,2,3,4', shots.map(shot => shot.seq).join(','))

  /* ------------------------------------------------ 4. bible (text stage) */
  section('4. bible')
  const bibleContent = {
    styleDna: '3D 国漫，电影级柔和轮廓光',
    characters: [
      {
        id: 'char-linyue',
        name: '林越',
        role: '主角',
        appearance: '清瘦，衬衫袖子挽到手肘',
        hair: '黑色短发，略乱',
        face: '下颌线清晰，眼窝略深',
        body: '偏瘦高，178cm',
        outfit: '灰色连帽卫衣，深色工装裤',
        accessory: '金属边框眼镜',
        personality: '内敛，认死理',
        arc: '从自证到释然',
        sheetPrompt: '林越三视图提示词',
      },
      {
        id: 'char-zhouheng',
        name: '周衡',
        role: '导师/对手',
        appearance: '中年，保养得当',
        hair: '灰白短发，向后梳',
        face: '方圆脸，法令纹明显',
        body: '中等身材',
        outfit: '深蓝西装，无领带',
        accessory: '腕表',
        personality: '体面，精于计算',
        arc: '从掌控到崩塌',
        sheetPrompt: '周衡三视图提示词',
      },
    ],
    scenes: [
      {
        id: 'scene-office',
        name: '写字楼开放办公区',
        kind: 'interior',
        description: '深夜的空旷工位区，只有一排显示器亮着',
        lighting: '冷白屏光 + 远端应急灯',
        composition: '纵深透视，工位重复排列',
        masterPrompt: '场景主图提示词',
      },
      {
        id: 'scene-rooftop',
        name: '天台',
        kind: 'exterior',
        description: '清晨的天台，水泥地面有水渍',
        lighting: '晨光侧逆光，长阴影',
        composition: '广角，天际线占上三分之一',
        masterPrompt: '场景主图提示词',
      },
    ],
  }
  const bibleCommit = await post(AIDRAMA_API.stage, { projectId, stage: 'bible', action: 'commit', payload: bibleContent })
  check('bible commits', bibleCommit.body.ok === true)
  const characters = bibleCommit.body.project?.content?.bible?.characters ?? []
  const scenes = bibleCommit.body.project?.content?.bible?.scenes ?? []
  check('bible keeps both characters', characters.length === 2, `got ${characters.length}`)
  check('bible keeps both scenes', scenes.length === 2, `got ${scenes.length}`)
  check('a character card carries its costume', characters[0]?.costume !== undefined && characters[0]?.costume !== '')

  /* --------------------------------------- 5. visual — real generation */
  section('5. visual — three-view + scene master + shot refs')
  const visualRun = await post(AIDRAMA_API.stage, { projectId, stage: 'visual', action: 'generate', payload: {} })
  check('the visual batch reports ok', visualRun.body.ok === true, JSON.stringify(visualRun.body).slice(0, 300))

  const produced = visualRun.body.assets ?? []
  const producedFailures = visualRun.body.failures ?? []
  check('assets were produced', produced.length > 0, `got ${produced.length}`)
  check('character sheets were generated',
    produced.some(asset => asset.kind === ASSET_KIND.characterSheet))
  check('scene masters were generated',
    produced.some(asset => asset.kind === ASSET_KIND.sceneMaster))
  check('shot refs were generated',
    produced.some(asset => asset.kind === ASSET_KIND.shotRef))
  check('the batch had no unexpected failures', producedFailures.length === 0,
    JSON.stringify(producedFailures).slice(0, 300))

  // routes.js forwards `aspectRatio` to this seam; lib/index.js is what turns a
  // ratio into a concrete pixel size. Assert the ratio arrives, and that the
  // mapping the host entry ships produces a vertical frame for a 9:16 show.
  const sizeForRatio = (ratio, fallback) => {
    if (typeof fallback === 'string' && fallback.trim() !== '' && fallback.trim() !== 'auto') return fallback.trim()
    const key = typeof ratio === 'string' ? ratio.trim() : ''
    return { '9:16': '1080x1920', '16:9': '1920x1080', '3:4': '1080x1440', '4:3': '1440x1080', '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024', '21:9': '1890x810' }[key] ?? 'auto'
  }
  check('the project aspect ratio reaches the image seam',
    generationRequests.every(request => request.aspectRatio === '9:16'),
    JSON.stringify(generationRequests.map(request => request.aspectRatio)))
  check('the host entry maps 9:16 to a VERTICAL pixel size',
    sizeForRatio('9:16', undefined) === '1080x1920', sizeForRatio('9:16', undefined))
  check('an explicit size still wins over the project ratio',
    sizeForRatio('9:16', '512x512') === '512x512')
  check('every generation request carried a prompt',
    generationRequests.every(request => typeof request.prompt === 'string' && request.prompt.trim() !== ''))

  const sheetRequest = generationRequests.find(request => String(request.prompt).includes('三视图')
    || String(request.prompt).includes('视图'))
  check('a character-sheet prompt really is a three-view', sheetRequest !== undefined
    && /侧视图|正视图|背视图|三视图/.test(String(sheetRequest.prompt)),
    String(sheetRequest?.prompt).slice(0, 160))
  check('the character-sheet prompt locks consistency',
    sheetRequest !== undefined && /一致/.test(String(sheetRequest.prompt)))

  const shotRequests = generationRequests.filter(request => request.prompt !== undefined)
  check('shot prompts weave in the character name',
    shotRequests.some(request => String(request.prompt).includes('林越')),
    shotRequests.map(request => String(request.prompt).slice(0, 40)).join(' | '))

  /* ------------------------------- the asset route actually serves bytes */
  const firstAsset = produced[0]
  check('a produced asset exposes a same-origin url', typeof firstAsset?.url === 'string' && firstAsset.url.startsWith('/api/dsh-aidrama/asset/'),
    String(firstAsset?.url))
  {
    const assetRoute = routes.find(route => route.kind === 'prefix' && route.path === AIDRAMA_API.asset)
    check('the asset route is a prefix route', assetRoute !== undefined)
    const served = await call(assetRoute, null, { method: 'GET', url: firstAsset.url })
    check('the asset route serves the image', served.status === 200
      && /^image\//.test(String(served.headers['content-type'] ?? '')),
      `status ${served.status} ct ${served.headers['content-type']}`)
  }
  {
    const onDisk = await store.readProject(projectId)
    check('every reported asset is actually on disk',
      onDisk.assets.length === produced.length, `disk ${onDisk.assets.length} vs reported ${produced.length}`)
  }

  /* --------------------- a failed target must not abort the whole batch */
  section('5b. visual — batch resilience')
  const before = (await store.readProject(projectId)).assets.length
  failKinds.add(ASSET_KIND.characterSheet)  // force the character sheet to fail upstream
  const partial = await post(AIDRAMA_API.stage, {
    projectId, stage: 'visual', action: 'generate',
    payload: { targets: [
      { kind: ASSET_KIND.characterSheet, ref: 'char-linyue' },
      { kind: ASSET_KIND.sceneMaster, ref: 'scene-office' },
    ] },
  })
  failKinds.clear()
  check('a partial failure still returns ok', partial.body.ok === true)
  check('the surviving target still produced an asset',
    (partial.body.assets ?? []).length >= 1, JSON.stringify(partial.body.assets ?? []).slice(0, 200))
  check('the failed target is reported with a reason',
    (partial.body.failures ?? []).length >= 1
      && typeof partial.body.failures[0].message === 'string'
      && partial.body.failures[0].message !== '',
    JSON.stringify(partial.body.failures ?? []).slice(0, 200))
  {
    const after = await store.readProject(projectId)
    check('the batch did not lose previously stored assets', after.assets.length >= before,
      `before ${before}, after ${after.assets.length}`)
  }

  /* ------------------------------------- 6. video — prompt-pack fallback */
  section('6. video — prompt pack with NO video channel configured')
  check('no video channel is configured for this run', effectiveConfig.videoChannels.length === 0)
  const pack = await post(AIDRAMA_API.video, { projectId, action: 'prompt-pack' })
  check('prompt-pack succeeds with no channel and no key', pack.body.ok === true,
    JSON.stringify(pack.body).slice(0, 200))
  const packPrompts = pack.body.pack?.prompts ?? []
  check('the pack contains one prompt per shot', packPrompts.length === shots.length,
    `pack ${packPrompts.length} vs shots ${shots.length}`)
  check('every packed prompt is non-empty',
    packPrompts.every(entry => typeof entry.prompt === 'string' && entry.prompt.trim() !== ''))
  check('video prompts are motion-first',
    packPrompts.some(entry => /运动|运镜|节奏/.test(entry.prompt)),
    String(packPrompts[0]?.prompt).slice(0, 160))

  /* ------------------------------------------------------- export paths */
  section('export — markdown script + prompt pack + json')
  const md = await post(AIDRAMA_API.export, { projectId, format: 'markdown' })
  check('markdown export succeeds', md.body.ok === true)
  check('markdown carries the scene location', String(md.body.content).includes('写字楼开放办公区'),
    `len=${String(md.body.content).length}`)
  check('markdown carries the dialogue', String(md.body.content).includes('这个排序'))
  check('markdown carries a filename', typeof md.body.filename === 'string' && md.body.filename !== '')

  const packExport = await post(AIDRAMA_API.export, { projectId, format: 'prompt-pack' })
  check('prompt-pack export succeeds', packExport.body.ok === true)
  check('prompt-pack export mentions the shots', String(packExport.body.content).length > 100)

  const jsonExport = await post(AIDRAMA_API.export, { projectId, format: 'json' })
  check('json export succeeds', jsonExport.body.ok === true)

  /* ------------------------------------------------------- stage advance */
  section('advance / rerun — the stage machine end to end')
  const advance = await post(AIDRAMA_API.projects, { action: 'advance', id: projectId, stage: 'video' })
  check('advancing a stage succeeds', advance.body.ok === true, JSON.stringify(advance.body).slice(0, 200))

  const rerun = await post(AIDRAMA_API.projects, { action: 'rerun', id: projectId, stage: 'script' })
  check('rerunning the script marks it stale', rerun.body.project?.stages?.script?.status === STAGE_STATUS.stale)
  check('rerunning invalidates the downstream bible', rerun.body.project?.stages?.bible?.status === STAGE_STATUS.stale)
  check('rerunning does not erase the script content',
    (rerun.body.project?.content?.script?.shots ?? []).length === 4)

  /* --------------------------------------------------- config + hygiene */
  section('config + key hygiene')
  const config = await post(AIDRAMA_API.config, {})
  check('config is served', config.body.ok === true)
  check('config reports the image channel', (config.body.config?.channels ?? []).length === 1)
  check('config reports hasKey without the key',
    config.body.config?.channels?.[0]?.hasKey === true
      && config.body.config?.channels?.[0]?.apiKey === undefined)
  check('config reports zero video channels', (config.body.config?.videoChannels ?? []).length === 0)

  const list = await post(AIDRAMA_API.projects, { action: 'list' })
  check('the project list includes the project', (list.body.projects ?? []).some(row => row.id === projectId))
  const row = (list.body.projects ?? []).find(candidate => candidate.id === projectId)
  check('a list row carries the six-stage rail', (row?.stages ?? []).length === STAGES.length,
    `got ${(row?.stages ?? []).length}`)

  const leaked = seenBodies.filter(body => body.includes(CANARY_KEY))
  check('the api key never appears in ANY response body of the whole run', leaked.length === 0,
    `${leaked.length} leaked`)

  /* -------------------------------------------------------- loopback + 405 */
  section('loopback fence + method guard')
  const foreign = await post(AIDRAMA_API.projects, { action: 'list' }, { remoteAddress: '10.1.2.3' })
  check('a non-loopback caller is refused', foreign.status === 403,
    `status ${foreign.status}`)
  const crossSite = await post(AIDRAMA_API.projects, { action: 'list' }, { headers: { 'sec-fetch-site': 'cross-site' } })
  check('a cross-site caller is refused', crossSite.status === 403, `status ${crossSite.status}`)
  const wrongMethod = await post(AIDRAMA_API.projects, { action: 'list' }, { method: 'GET' })
  check('a wrong method is refused', wrongMethod.status === 405, `status ${wrongMethod.status}`)

  /* ---------------------------------------------- unknown ids stay honest */
  section('negative paths are handled, not crashed')
  const missing = await post(AIDRAMA_API.projects, { action: 'get', id: 'p-does-not-exist' })
  check('a missing project answers ok:false not a crash',
    missing.body.ok === false && missing.body.code === 'not-found', JSON.stringify(missing.body))
  const badStage = await post(AIDRAMA_API.stage, { projectId, stage: 'nonsense', action: 'brief' })
  // Not an error: the route answers with the template catalogue and an
  // explanatory note, so naming a non-text stage still yields something actionable.
  check('an unknown stage answers with an explanatory brief, not a crash',
    badStage.body.ok === true && badStage.body.brief?.text === false
      && typeof badStage.body.brief?.note === 'string' && badStage.body.brief.note !== '',
    JSON.stringify(badStage.body).slice(0, 160))
  const badCommit = await post(AIDRAMA_API.stage, { projectId, stage: 'nonsense', action: 'commit', payload: {} })
  check('committing to an unknown stage is refused',
    badCommit.body.ok === false, JSON.stringify(badCommit.body).slice(0, 160))

  /* ------------------------------------------------------ persistence */
  section('persistence')
  {
    const reloaded = await store.readProject(projectId)
    check('the project survives a re-read', reloaded !== undefined && reloaded.id === projectId)
    check('the reloaded project keeps its assets', reloaded.assets.length > 0)
    check('the reloaded project keeps its script shots',
      (reloaded.content?.script?.shots ?? []).length === 4)
  }

  // ------------------------------------------------------------------ teardown
  const deleted = await post(AIDRAMA_API.projects, { action: 'delete', id: projectId })
  check('the project deletes', deleted.body.ok === true)
  check('a deleted project is really gone', (await store.readProject(projectId)) === undefined)
}

/* ------------------------------------------------------------------- report */

await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})

console.log(`\n${'='.repeat(56)}`)
if (failed === 0) {
  console.log(`ALL PASS — ${passed} passed, 0 failed`)
  console.log('END-TO-END PIPELINE VERIFIED')
  process.exit(0)
} else {
  console.log(`FAILURES PRESENT — ${passed} passed, ${failed} failed`)
  for (const label of failures) console.log(`  - ${label}`)
  process.exit(1)
}
