/**
 * dsh-aidrama — host route verification.
 *
 * Boots the REAL route family from `lib/host/routes.js` with in-memory stubs for
 * store/stages/prompts/video, drives the real handlers with synthetic req/res
 * pairs, and asserts the contract the browser half depends on — most importantly
 * that NO API KEY ever leaves the host.
 *
 *   node docs/verify-routes.mjs
 *
 * Prints PASS/FAIL per assertion and exits non-zero if any assertion fails.
 * Zero dependencies, no network, no test runner.
 */

import {
  AIDRAMA_API,
  MAX_JSON_BODY_BYTES,
  PROJECT_DEFAULTS,
  STAGES,
  STAGE_STATUS,
  VIDEO_PROTOCOL,
  createProject,
} from '../lib/host/protocol.js'
import * as realStages from '../lib/host/stages.js'
import * as realPrompts from '../lib/host/prompts.js'
import { makeAidramaRoutes } from '../lib/host/routes.js'

/* ------------------------------------------------------------------ *
 * Tiny assertion harness
 * ------------------------------------------------------------------ */

let passed = 0
let failed = 0

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Deep equality for small JSON values. */
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/* ------------------------------------------------------------------ *
 * In-memory store stub (same surface the routes consume)
 * ------------------------------------------------------------------ */

/** The asset bytes the fake store hands out, keyed by `projectId/file`. */
const assetBytes = new Map()

/** Set to make `generateImage` throw for a specific ref (batch-resilience test). */
let failingImageRefs = new Set()

/**
 * Build the store stub around a plain Map.
 *
 * Mirrors the real module's observable behaviour, including the two quirks the
 * routes layer must respect:
 *   - `readProject` returns undefined (never throws) for a missing id;
 *   - `writeProject` MUTATES the object it is handed (it stamps `updatedAt`).
 */
function makeStoreStub() {
  /** @type {Map<string, object>} */
  const documents = new Map()

  const clone = value => JSON.parse(JSON.stringify(value))

  return {
    documents,
    isProjectId: value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value),
    isSafeFile: value => typeof value === 'string'
      && value !== '' && value.length <= 200
      && !value.includes('\0') && value !== '.' && value !== '..'
      && !value.includes('/') && !value.includes('\\')
      && !/^[A-Za-z]:/.test(value),

    async listProjects() {
      const out = []
      for (const document of documents.values()) {
        const counters = { ready: 0, stale: 0, running: 0, failed: 0, empty: 0 }
        for (const stageId of STAGES) {
          const status = document.stages?.[stageId]?.status
          if (typeof status === 'string' && Object.hasOwn(counters, status)) counters[status] += 1
        }
        out.push({
          id: document.id,
          title: document.title,
          logline: document.logline,
          aspectRatio: document.aspectRatio,
          episodes: document.episodes,
          shotSeconds: document.shotSeconds,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
          assetCount: (document.assets ?? []).length,
          stageCounts: counters,
        })
      }
      out.sort((a, b) => b.updatedAt - a.updatedAt)
      return out
    },

    async readProject(id) {
      if (!this.isProjectId(id)) return undefined
      const found = documents.get(id)
      return found === undefined ? undefined : clone(found)
    },

    async writeProject(project) {
      if (project === null || typeof project !== 'object') throw new TypeError('project must be an object')
      if (!this.isProjectId(project.id)) {
        throw new TypeError(`project.id must match /^[A-Za-z0-9_-]{1,64}$/, received ${JSON.stringify(project.id)}`)
      }
      // The real writer MUTATES its argument; reproduce that so a route that
      // forgets to copy is caught here rather than in production.
      project.updatedAt = Date.now()
      if (typeof project.schemaVersion !== 'number') project.schemaVersion = 1
      documents.set(project.id, clone(project))
      return project
    },

    async deleteProject(id) {
      if (!this.isProjectId(id)) return false
      return documents.delete(id)
    },

    async putAsset(projectId, input = {}) {
      if (!this.isProjectId(projectId)) throw new TypeError('asset projectId must match /^[A-Za-z0-9_-]{1,64}$/')
      const project = documents.get(projectId)
      if (project === undefined) throw new Error(`unknown project: ${projectId}`)
      if ((project.assets ?? []).length >= 600) throw new Error(`project ${projectId} already holds 600 assets (cap 600)`)
      const raw = typeof input.bytes === 'string'
        ? Buffer.from(input.bytes.replace(/^data:[^,]*,/u, ''), 'base64')
        : Buffer.from(input.bytes ?? [])
      if (raw.length === 0) throw new Error('putAsset(projectId, { bytes }): bytes decoded to zero length')
      const file = `${Date.now().toString(36)}-${(project.assets.length + 1).toString(36)}.png`
      assetBytes.set(`${projectId}/${file}`, raw)
      const asset = {
        id: `a-${projectId}-${project.assets.length + 1}`,
        kind: typeof input.kind === 'string' && input.kind !== '' ? input.kind : 'shot-ref',
        ref: typeof input.ref === 'string' ? input.ref : '',
        name: typeof input.name === 'string' && input.name !== '' ? input.name : file,
        file,
        mime: typeof input.mime === 'string' && input.mime !== '' ? input.mime : 'image/png',
        bytes: raw.length,
        createdAt: Date.now(),
        origin: typeof input.origin === 'string' ? input.origin : 'image-model',
        meta: input.meta ?? {},
      }
      project.assets.push(asset)
      documents.set(projectId, clone(project))
      return asset
    },

    async readAsset(projectId, file) {
      if (!this.isProjectId(projectId) || !this.isSafeFile(file)) return undefined
      const data = assetBytes.get(`${projectId}/${file}`)
      if (data === undefined) return undefined
      return { data, mime: file.endsWith('.png') ? 'image/png' : 'application/octet-stream' }
    },
  }
}

/* ------------------------------------------------------------------ *
 * Synthetic req / res
 * ------------------------------------------------------------------ */

/** Every JSON body every route produced during this run (key-hygiene sweep). */
const recordedResponses = []

/**
 * Drive one handler with a synthetic request.
 *
 * Every response body is appended to `recordedResponses` so the key-hygiene
 * assertions can sweep the WHOLE run's traffic, not just the /config call.
 *
 * @param {{ kind: string, path: string, handler: Function }} route
 * @param {object} options
 * @returns {Promise<{ status: number, headers: object, body: any, raw: string, type: string }>}
 */
async function callRoute(route, options = {}) {
  const {
    method = 'POST',
    body = {},
    url,
    remoteAddress = '127.0.0.1',
    host = '127.0.0.1:19387',
    origin,
    secFetchSite,
    rawBody,
    bodyFactory,
  } = options

  const payload = rawBody !== undefined ? rawBody : JSON.stringify(body ?? {})
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')

  const headers = { host, 'content-type': 'application/json' }
  if (origin !== undefined) headers.origin = origin
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite

  const req = {
    method,
    url: url ?? route.path,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      yield bodyFactory === undefined ? bytes : bodyFactory()
    },
  }

  let status = 0
  let responseHeaders = {}
  const chunks = []
  // Settle on `end`, but never hang the suite: a handler that forgets to answer
  // is a failure, not an infinite wait.
  let settle
  const done = new Promise(resolve => { settle = resolve })

  const res = {
    writeHead(code, extra) {
      status = code
      if (extra !== undefined && extra !== null) responseHeaders = { ...responseHeaders, ...extra }
      return res
    },
    setHeader(name, value) {
      responseHeaders[name] = value
      return res
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      }
      settle()
      return res
    },
  }

  const finished = await Promise.race([
    Promise.resolve(route.handler(req, res)).then(() => done),
    new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 8000)),
  ])
  if (finished === 'TIMEOUT') {
    throw new Error(`route ${route.path} never answered`)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  let parsed
  try {
    parsed = raw === '' ? undefined : JSON.parse(raw)
  } catch {
    parsed = undefined
  }

  recordedResponses.push(raw)

  return {
    status,
    headers: responseHeaders,
    body: parsed,
    raw,
    type: responseHeaders['content-type'] ?? '',
  }
}

/* ------------------------------------------------------------------ *
 * Deps
 * ------------------------------------------------------------------ */

/** The API keys the test plants in the config. */
const IMAGE_KEY = 'sk-image-SUPERSECRET-abcdefghijklmnop'
const VIDEO_KEY = 'sk-video-TOPSECRET-zyxwvutsrqponmlk'

/** A config carrying real-looking secrets in every channel. */
function testConfig() {
  return {
    enabled: true,
    allowAgentGeneration: true,
    announceToAgent: true,
    channels: [
      {
        id: 'coderxiaoc',
        name: 'coderxiaoc',
        apiUrl: 'https://coderxiaoc.com/v1',
        apiKey: IMAGE_KEY,
        protocol: 'auto',
        models: [{ alias: 'gpt-image-2.5-sunburst', id: 'gpt-image-2.5-sunburst' }],
      },
      {
        id: 'no-key-channel',
        name: '无密钥渠道',
        apiUrl: 'https://example.invalid/v1',
        apiKey: '',
        protocol: 'auto',
        models: [{ alias: 'x', id: 'x' }],
      },
    ],
    defaultChannelId: 'coderxiaoc',
    defaultModel: 'gpt-image-2.5-sunburst',
    // Deliberately EMPTY: the prompt-pack test proves the pack needs no channel.
    videoChannels: [],
    defaultVideoChannelId: '',
    styleDna: PROJECT_DEFAULTS.styleDna,
    aspectRatio: PROJECT_DEFAULTS.aspectRatio,
    shotSeconds: PROJECT_DEFAULTS.shotSeconds,
  }
}

/** A 1x1 PNG, as base64. */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let store
let routes
let imageCalls = []
let resolvedConfig

function bootDeps() {
  store = makeStoreStub()
  imageCalls = []
  failingImageRefs = new Set()
  resolvedConfig = testConfig()

  const deps = {
    store,
    stages: realStages,
    prompts: realPrompts,
    video: {
      // A video stub that NEVER touches the network. `submitVideo` echoes a
      // queued task; `pollVideo` returns a terminal task with OPTIONAL KEYS
      // OMITTED (never null), exactly like the real adapter layer.
      async submitVideo(input) {
        // Mirror the real adapter layer: a non-prompt-pack channel with no key is
        // an error. The message echoes the channel NAME (never the key), which is
        // exactly the shape the route must scrub if an upstream ever leaks one.
        if (input?.channel?.protocol !== VIDEO_PROTOCOL.promptPack && !input?.channel?.apiKey) {
          throw new Error(`Channel "${input?.channel?.name}" has no api key configured`)
        }
        // A channel flagged `leaky` simulates an upstream that echoes the
        // credential back at us — the case `withoutSecrets` exists to catch.
        if (input?.channel?.leaky === true) {
          throw new Error(`upstream rejected: authorization: Bearer ${input.channel.apiKey}`)
        }
        return { taskId: 'vt-stub-1', status: 'queued', raw: { protocol: input?.channel?.protocol, networkCalls: 0 } }
      },
      async pollVideo() {
        return { status: 'succeeded', videoUrl: 'https://cdn.invalid/clip.mp4', raw: { networkCalls: 0 } }
      },
      async fetchVideoBytes() {
        throw new Error('not used')
      },
      videoCapabilities: () => ({ textToVideo: true, imageToVideo: false, firstLastFrame: false, minDurationSec: 1, maxDurationSec: 600, aspectRatios: ['9:16'] }),
      videoChannelPresets: () => [],
    },
    resolveConfig: () => resolvedConfig,
    async generateImage(request) {
      imageCalls.push(request)
      const ref = String(request?.prompt ?? '')
      for (const marker of failingImageRefs) {
        if (ref.includes(marker)) throw new Error(`上游图像接口返回 500：模型 ${marker} 不可用`)
      }
      return { images: [{ b64: TINY_PNG, mime: 'image/png' }], model: 'gpt-image-2.5-sunburst', channel: 'coderxiaoc' }
    },
    log: () => {},
  }

  routes = makeAidramaRoutes(deps)
}

/** Look up one route by its frozen path. */
function routeAt(path) {
  const route = routes.find(candidate => candidate.path === path)
  if (route === undefined) throw new Error(`route not mounted: ${path}`)
  return route
}

const projects = () => routeAt(AIDRAMA_API.projects)
const stage = () => routeAt(AIDRAMA_API.stage)
const video = () => routeAt(AIDRAMA_API.video)
const asset = () => routeAt(AIDRAMA_API.asset)
const exportRoute = () => routeAt(AIDRAMA_API.export)
const configRoute = () => routeAt(AIDRAMA_API.config)

/* ------------------------------------------------------------------ *
 * Suite
 * ------------------------------------------------------------------ */

async function main() {
  console.log('dsh-aidrama — routes verification\n')

  bootDeps()

  /* ---------------------------------------------------------------- *
   * (a) loopback guard
   * ---------------------------------------------------------------- */
  console.log('— guards —')
  {
    const remote = await callRoute(projects(), { remoteAddress: '10.0.0.7', body: { action: 'list' } })
    check('(a) a non-loopback remote address → 403', remote.status === 403 && remote.body?.error === 'forbidden: loopback-only',
      `${remote.status} ${remote.raw}`)

    const foreignHost = await callRoute(projects(), { host: 'evil.example.com', body: { action: 'list' } })
    check('(a) a non-loopback Host header → 403', foreignHost.status === 403 && foreignHost.body?.error === 'forbidden: loopback-only',
      `${foreignHost.status} ${foreignHost.raw}`)

    const crossSite = await callRoute(projects(), { secFetchSite: 'cross-site', body: { action: 'list' } })
    check('(a) sec-fetch-site: cross-site → 403', crossSite.status === 403, `${crossSite.status} ${crossSite.raw}`)

    const badOrigin = await callRoute(projects(), { origin: 'https://evil.example.com', body: { action: 'list' } })
    check('(a) a mismatched Origin → 403', badOrigin.status === 403, `${badOrigin.status} ${badOrigin.raw}`)

    const goodOrigin = await callRoute(projects(), { origin: 'http://127.0.0.1:19387', body: { action: 'list' } })
    check('(a) a matching Origin passes the guard', goodOrigin.status === 200 && goodOrigin.body?.ok === true,
      `${goodOrigin.status} ${goodOrigin.raw.slice(0, 120)}`)

    const localhostAlias = await callRoute(projects(), { host: 'localhost:19387', origin: 'http://localhost:19387', body: { action: 'list' } })
    check('(a) the localhost alias is accepted', localhostAlias.status === 200, `${localhostAlias.status}`)

    // Every route must be guarded, not just /projects.
    const guarded = [
      [stage(), 'POST'], [video(), 'POST'], [exportRoute(), 'POST'], [configRoute(), 'POST'],
      [asset(), 'GET'],
    ]
    let allGuarded = true
    for (const [route, method] of guarded) {
      const res = await callRoute(route, { method, remoteAddress: '10.0.0.7', url: `${route.path}/x/y` })
      if (res.status !== 403) {
        allGuarded = false
        console.log(`      ${route.path} answered ${res.status}`)
      }
    }
    check('(a) every route is loopback-guarded', allGuarded)
  }

  /* ---------------------------------------------------------------- *
   * (b) method guard
   * ---------------------------------------------------------------- */
  console.log('\n— methods —')
  {
    const wrong = await callRoute(projects(), { method: 'GET' })
    check('(b) GET on a POST route → 405', wrong.status === 405 && /method not allowed/.test(String(wrong.body?.error)),
      `${wrong.status} ${wrong.raw}`)

    const wrongAsset = await callRoute(asset(), { method: 'POST', url: `${AIDRAMA_API.asset}/p-x/y.png` })
    check('(b) POST on the asset route → 405', wrongAsset.status === 405, `${wrongAsset.status} ${wrongAsset.raw}`)

    const headAsset = await callRoute(asset(), { method: 'HEAD', url: `${AIDRAMA_API.asset}/p-x/y.png` })
    check('(b) HEAD is allowed on the asset route', headAsset.status === 404, `${headAsset.status}`)
  }

  /* ---------------------------------------------------------------- *
   * (c) projects round-trip
   * ---------------------------------------------------------------- */
  console.log('\n— projects round-trip —')
  let projectId = ''
  {
    const created = await callRoute(projects(), {
      body: { action: 'create', title: '退婚后我成了首富', logline: '被逐出家门的赘婿林越，靠操盘术夺回一切。' },
    })
    projectId = String(created.body?.project?.id ?? '')
    check('(c) create returns a project with an id',
      created.status === 200 && created.body?.ok === true && /^[A-Za-z0-9_-]{1,64}$/.test(projectId),
      `${created.status} ${created.raw.slice(0, 200)}`)

    const got = await callRoute(projects(), { body: { action: 'get', id: projectId } })
    check('(c) get returns the project, its stage rail and its assets',
      got.body?.ok === true && got.body.project?.id === projectId
      && Array.isArray(got.body.stages) && got.body.stages.length === STAGES.length
      && Array.isArray(got.body.assets),
      `${got.status} ${got.raw.slice(0, 200)}`)

    const listed = await callRoute(projects(), { body: { action: 'list' } })
    const row = (listed.body?.projects ?? []).find(item => item.id === projectId)
    check('(c) list returns the summary WITH a stage array (store summaries omit content)',
      listed.body?.ok === true && row !== undefined
      && Array.isArray(row.stages) && row.stages.length === STAGES.length
      && row.stages[0].id === 'idea' && eq(row.stageCounts, { ready: 0, stale: 0, running: 0, failed: 0, empty: 6 }),
      `${listed.status} ${JSON.stringify(row?.stages?.[0] ?? null)}`)

    const missing = await callRoute(projects(), { body: { action: 'get', id: 'p-does-not-exist' } })
    check('(c) get on a missing project → handled failure, not 404',
      missing.status === 200 && missing.body?.ok === false && missing.body?.code === 'not-found',
      `${missing.status} ${missing.raw}`)

    const traversal = await callRoute(projects(), { body: { action: 'get', id: '../../etc/passwd' } })
    check('(c) a path-traversal id is refused as not-found',
      traversal.status === 200 && traversal.body?.ok === false && traversal.body?.code === 'not-found',
      `${traversal.status} ${traversal.raw}`)
  }

  /* ---------------------------------------------------------------- *
   * (c2) stage commit / advance / rerun
   * ---------------------------------------------------------------- */
  console.log('\n— stage engine —')
  {
    const brief = await callRoute(stage(), { body: { projectId, stage: 'idea', action: 'brief' } })
    const frozen = realPrompts.TEXT_STAGE_BRIEF.idea
    check('(c) brief returns the frozen TEXT_STAGE_BRIEF contract',
      brief.body?.ok === true
      && brief.body.brief?.system === frozen.system
      && brief.body.brief?.task === frozen.task
      && brief.body.brief?.schema === frozen.schema
      && JSON.parse(brief.body.brief.schema).required.includes('logline'),
      `${brief.status} ${brief.raw.slice(0, 120)}`)

    const visualBrief = await callRoute(stage(), { body: { projectId, stage: 'visual', action: 'brief' } })
    check('(c) brief on a non-text stage returns the template catalog instead of failing',
      visualBrief.body?.ok === true && visualBrief.body.brief?.text === false
      && Array.isArray(visualBrief.body.brief.templates) && visualBrief.body.brief.templates.length > 0,
      `${visualBrief.status} ${visualBrief.raw.slice(0, 160)}`)

    const committed = await callRoute(stage(), {
      body: {
        projectId,
        stage: 'script',
        action: 'commit',
        note: '第 1 版',
        payload: {
          episodes: [{
            no: 1,
            title: '第 1 集：退婚书',
            hook: '数字开始狂跳。',
            scenes: [{
              no: 1,
              slug: 'INT. 苏家餐厅 - 夜',
              location: '苏家餐厅',
              time: '夜',
              characters: ['林越', '苏建国'],
              action: '林越把退婚书放在转盘上，推过桌面。',
              dialogue: [{ who: '苏建国', line: '签了它，从今天起你跟我们苏家没关系。' }],
              durationSec: 45,
              shots: [
                { no: 1, shot: '中景', camera: '低机位缓推', description: '林越站在餐桌尽头。', motion: '他向前迈一步。', durationSec: 5 },
                { no: 2, shot: '特写', camera: '固定机位', description: '苏建国的手压住退婚书。', motion: '手指收紧。', durationSec: 3 },
              ],
            }],
          }],
        },
      },
    })
    const nestedScenes = committed.body?.project?.content?.script?.episodes?.[0]?.scenes
    check('(c) commit normalizes a text stage through stages.js',
      committed.body?.ok === true
      && committed.body.project.stages.script.status === STAGE_STATUS.ready
      && committed.body.project.stages.script.revision === 1
      && Array.isArray(nestedScenes) && nestedScenes.length === 1
      && nestedScenes[0].shots.length === 2
      && nestedScenes[0].shots[0].shot === '中景'
      && committed.body.project.stages.script.note === '第 1 版',
      `${committed.status} ${JSON.stringify(nestedScenes?.[0]?.shots?.map(s => s.shot) ?? null)}`)

    const advance = await callRoute(projects(), { body: { action: 'advance', id: projectId, stage: 'idea' } })
    check('(c) advance promotes the stage to ready',
      advance.body?.ok === true
      && advance.body.project.stages.idea.status === STAGE_STATUS.ready,
      `${advance.status} ${advance.raw.slice(0, 200)}`)

    // `idea` is the first stage, so it has no upstream to warn about: this
    // asserts the guard's documented {ok:true} shape for a clean advance.
    check('(c) advance on the first stage reports no warning',
      advance.body?.warning === undefined, JSON.stringify(advance.body?.warning ?? null))

    // A later stage DOES warn when something upstream is empty/stale.
    const warned = await callRoute(projects(), { body: { action: 'advance', id: projectId, stage: 'video' } })
    check('(c) advance on a later stage surfaces an upstream warning',
      warned.body?.ok === true && typeof warned.body.warning === 'string' && warned.body.warning !== '',
      `${warned.status} ${String(warned.body?.warning ?? '')}`)

    const unknownAdvance = await callRoute(projects(), { body: { action: 'advance', id: projectId, stage: 'nope' } })
    check('(c) advance on an unknown stage is a handled failure',
      unknownAdvance.body?.ok === false && unknownAdvance.body?.code === 'stage-blocked',
      `${unknownAdvance.status} ${unknownAdvance.raw}`)

    const beforeRerun = await callRoute(projects(), { body: { action: 'get', id: projectId } })
    check('(c) the downstream script stage is ready before the rerun',
      beforeRerun.body?.project?.stages?.script?.status === STAGE_STATUS.ready)

    const rerun = await callRoute(projects(), { body: { action: 'rerun', id: projectId, stage: 'idea' } })
    check('(c) rerun marks the stage stale AND invalidates every later stage',
      rerun.body?.ok === true
      && rerun.body.project.stages.idea.status === STAGE_STATUS.stale
      && rerun.body.project.stages.script.status === STAGE_STATUS.stale
      && rerun.body.project.stages.visual.status === STAGE_STATUS.empty,
      `${rerun.status} ${JSON.stringify(rerun.body?.project?.stages ?? null).slice(0, 300)}`)

    const persisted = await callRoute(projects(), { body: { action: 'get', id: projectId } })
    check('(c) the rerun was persisted',
      persisted.body?.project?.stages?.script?.status === STAGE_STATUS.stale)

    // save: conflict on a stale revision, success on the current one.
    const current = persisted.body.project
    const conflict = await callRoute(projects(), {
      body: { action: 'save', project: { ...current, title: '被抢改的标题' }, updatedAt: current.updatedAt - 9999 },
    })
    check('(c) save with a stale revision → handled conflict',
      conflict.body?.ok === false && conflict.body?.code === 'conflict',
      `${conflict.status} ${conflict.raw.slice(0, 200)}`)

    const saved = await callRoute(projects(), {
      body: { action: 'save', project: { ...current, title: '新标题' }, updatedAt: current.updatedAt },
    })
    check('(c) save with the current revision succeeds and returns the full document',
      saved.body?.ok === true && saved.body.project?.title === '新标题'
      && Array.isArray(saved.body.project.assets) && Array.isArray(saved.body.project.videoTasks),
      `${saved.status} ${saved.raw.slice(0, 200)}`)

    const badShape = await callRoute(projects(), { body: { action: 'save', project: { id: '../evil', stages: {}, content: {}, assets: [], videoTasks: [] } } })
    check('(c) save with a malformed document → bad-request',
      badShape.body?.ok === false && badShape.body?.code === 'bad-request',
      `${badShape.status} ${badShape.raw}`)
  }

  /* ---------------------------------------------------------------- *
   * (d) prompt-pack with NO video channel
   * ---------------------------------------------------------------- */
  console.log('\n— prompt pack (no video channel configured) —')
  {
    resolvedConfig = { ...testConfig(), videoChannels: [], defaultVideoChannelId: '' }
    const pack = await callRoute(video(), { body: { projectId, action: 'prompt-pack' } })
    check('(d) prompt-pack works with zero video channels configured',
      pack.body?.ok === true && Array.isArray(pack.body.pack?.prompts) && pack.body.pack.prompts.length === 2,
      `${pack.status} ${pack.raw.slice(0, 240)}`)

    check('(d) every pack row carries ref + shot + a single-line prompt',
      (pack.body?.pack?.prompts ?? []).every(row =>
        typeof row.ref === 'string' && row.ref !== ''
        && typeof row.shot === 'number'
        && typeof row.prompt === 'string' && row.prompt !== '' && !row.prompt.includes('\n')),
      JSON.stringify(pack.body?.pack?.prompts?.[0] ?? null).slice(0, 200))

    check('(d) the pack carries a human note', typeof pack.body?.pack?.note === 'string' && pack.body.pack.note !== '')

    // The same guarantee for the video stage's own fallback path.
    const submitted = await callRoute(video(), { body: { projectId, action: 'submit' } })
    check('(d) video submit falls back to prompt-pack with no channel (and never calls the network)',
      submitted.body?.ok === true && Array.isArray(submitted.body.tasks) && submitted.body.tasks.length === 2
      && submitted.body.tasks.every(task => task.protocol === VIDEO_PROTOCOL.promptPack),
      `${submitted.status} ${submitted.raw.slice(0, 240)}`)

    const statusCall = await callRoute(video(), { body: { projectId, action: 'status', taskId: submitted.body?.tasks?.[0]?.id } })
    check('(d) video status polls and reports terminal',
      statusCall.body?.ok === true && statusCall.body.task?.status === 'succeeded' && statusCall.body.terminal === true,
      `${statusCall.status} ${statusCall.raw.slice(0, 200)}`)

    const missingTask = await callRoute(video(), { body: { projectId, action: 'status', taskId: 'nope' } })
    check('(d) status on an unknown task → not-found',
      missingTask.body?.ok === false && missingTask.body?.code === 'not-found')

    const cancelled = await callRoute(video(), { body: { projectId, action: 'cancel', taskId: submitted.body?.tasks?.[0]?.id } })
    check('(d) cancel is best-effort and always reports ok', cancelled.body?.ok === true, cancelled.raw.slice(0, 160))
  }

  /* ---------------------------------------------------------------- *
   * (e) a generate batch survives one failing target
   * ---------------------------------------------------------------- */
  console.log('\n— visual generation batch —')
  {
    resolvedConfig = testConfig()
    const bible = await callRoute(stage(), {
      body: {
        projectId,
        stage: 'bible',
        action: 'commit',
        payload: {
          styleDna: PROJECT_DEFAULTS.styleDna,
          characters: [
            { id: 'lin-yue', name: '林越', role: '主角', appearance: '28 岁男性，黑色短发。', hair: '黑色短发', face: '窄长脸', body: '183cm 八头身', outfit: '深灰风衣', accessory: '银色手表', personality: '克制', arc: '夺回一切', sheetPrompt: '林越角色设定三视图' },
            { id: 'su-jianguo', name: '苏建国', role: '对手', appearance: '55 岁男性，灰白鬓角。', hair: '灰白短发', face: '方脸', body: '175cm', outfit: '深色西装', accessory: '金戒指', personality: '强硬', arc: '众叛亲离', sheetPrompt: '苏建国角色设定三视图' },
          ],
          scenes: [{ id: 'su-dining', name: '苏家餐厅', kind: 'interior', description: '挑高六米的现代中式餐厅。', lighting: '暖色筒灯', composition: '纵深透视', masterPrompt: '苏家餐厅场景主图，无人物' }],
        },
      },
    })
    check('(e) the bible commit normalizes characters and scenes',
      bible.body?.ok === true
      && bible.body.project.content.bible.characters.length === 2
      && bible.body.project.content.bible.characters[0].id === 'lin-yue'
      && bible.body.project.content.bible.scenes.length === 1,
      `${bible.status} ${bible.raw.slice(0, 200)}`)

    // The script stage was invalidated by the rerun, so re-commit it.
    await callRoute(stage(), {
      body: {
        projectId,
        stage: 'script',
        action: 'commit',
        payload: {
          episodes: [{
            no: 1,
            title: '第 1 集',
            hook: '数字开始狂跳。',
            scenes: [{
              no: 1,
              slug: 'INT. 苏家餐厅 - 夜',
              location: '苏家餐厅',
              time: '夜',
              characters: ['林越'],
              action: '林越把退婚书放在转盘上。',
              dialogue: [],
              durationSec: 45,
              shots: [{ no: 1, shot: '中景', camera: '低机位缓推', description: '林越站在餐桌尽头。', motion: '他向前迈一步。', durationSec: 5 }],
            }],
          }],
        },
      },
    })

    const derived = await callRoute(stage(), { body: { projectId, stage: 'visual', action: 'generate', payload: {} } })
    check('(e) generate derives targets from the bible + script when payload.targets is absent',
      derived.body?.ok === true
      && (derived.body.assets ?? []).length === 4
      && derived.body.assets.some(a => a.kind === 'character-sheet')
      && derived.body.assets.some(a => a.kind === 'scene-master')
      && derived.body.assets.some(a => a.kind === 'shot-ref')
      && derived.body.assets.some(a => a.ref === 'shot-1-1-1'),
      `${derived.status} ${JSON.stringify((derived.body?.assets ?? []).map(a => `${a.kind}:${a.ref}`))}`)

    check('(e) generate does NOT mint an asset for the lossy flat-shot ghost',
      !(derived.body?.assets ?? []).some(a => a.ref === 'shot-1' && a.kind === 'shot-ref'),
      JSON.stringify((derived.body?.assets ?? []).map(a => a.ref)))

    check('(e) every generated asset reports an id, a url and a byte count',
      (derived.body?.assets ?? []).every(a =>
        typeof a.id === 'string' && a.id !== ''
        && typeof a.url === 'string' && a.url.startsWith(`${AIDRAMA_API.asset}/`)
        && typeof a.bytes === 'number' && a.bytes > 0),
      JSON.stringify(derived.body?.assets?.[0] ?? null).slice(0, 240))

    check('(e) the image seam was called once per target with a single-line prompt',
      imageCalls.length === 4 && imageCalls.every(call => typeof call.prompt === 'string' && call.prompt !== '' && !call.prompt.includes('\n')),
      `calls=${imageCalls.length}`)

    // REGRESSION GUARD (a real bug this suite caught): `putAsset` appends to the
    // stored document, so a whole-document `writeProject` from the stale
    // in-memory copy AFTER the batch erased every asset it had just written.
    const storedAfterGenerate = store.documents.get(projectId)
    check('(e) every generated asset is actually persisted (no lost update)',
      storedAfterGenerate.assets.filter(a => a.kind === 'character-sheet' || a.kind === 'scene-master' || a.kind === 'shot-ref').length
        === (derived.body?.assets ?? []).length,
      `stored=${storedAfterGenerate.assets.length} reported=${(derived.body?.assets ?? []).length}`)

    const reloaded = await callRoute(projects(), { body: { action: 'get', id: projectId } })
    check('(e) a re-read project reports the same asset count the batch returned',
      reloaded.body?.assets?.length === (derived.body?.assets ?? []).length,
      `reloaded=${reloaded.body?.assets?.length} reported=${(derived.body?.assets ?? []).length}`)

    // One target throws: the batch must still return the others.
    imageCalls = []
    failingImageRefs = new Set(['苏建国'])
    const partial = await callRoute(stage(), {
      body: {
        projectId,
        stage: 'visual',
        action: 'generate',
        payload: {
          targets: [
            { kind: 'character-sheet', ref: 'lin-yue', name: '林越' },
            { kind: 'character-sheet', ref: 'su-jianguo', name: '苏建国' },
            { kind: 'scene-master', ref: 'su-dining', name: '苏家餐厅' },
          ],
        },
      },
    })
    check('(e) ONE FAILED TARGET DOES NOT ABORT THE BATCH (2 assets + 1 failure)',
      partial.body?.ok === true
      && (partial.body.assets ?? []).length === 2
      && (partial.body.failures ?? []).length === 1
      && partial.body.failures[0].ref === 'su-jianguo'
      && partial.body.assets.some(a => a.ref === 'lin-yue')
      && partial.body.assets.some(a => a.ref === 'su-dining'),
      `${partial.status} ${partial.raw.slice(0, 300)}`)

    check('(e) the failure message names the target and leaks no key',
      typeof partial.body?.failures?.[0]?.message === 'string'
      && partial.body.failures[0].message.includes('苏建国')
      && !partial.body.failures[0].message.includes(IMAGE_KEY),
      JSON.stringify(partial.body?.failures?.[0] ?? null))

    check('(e) a failure for one target never stops the later calls',
      imageCalls.length === 3, `calls=${imageCalls.length}`)

    failingImageRefs = new Set()

    const cleared = await callRoute(stage(), { body: { projectId, stage: 'visual', action: 'clear' } })
    check('(e) clear empties the stage content and invalidates dependents',
      cleared.body?.ok === true
      && cleared.body.project.content.visual === null
      && cleared.body.project.stages.visual.status === STAGE_STATUS.empty
      && cleared.body.project.stages.video.status !== STAGE_STATUS.ready,
      `${cleared.status} ${cleared.raw.slice(0, 200)}`)

    const badStage = await callRoute(stage(), { body: { projectId, stage: 'bible', action: 'generate' } })
    check('(e) generate on a non-image stage → bad-request',
      badStage.body?.ok === false && badStage.body?.code === 'bad-request', badStage.raw.slice(0, 160))
  }

  /* ---------------------------------------------------------------- *
   * asset route
   * ---------------------------------------------------------------- */
  console.log('\n— asset route —')
  {
    const document = store.documents.get(projectId)
    const storedAssets = document?.assets ?? []
    check('the fixture still holds generated assets to serve',
      storedAssets.length > 0, `assets=${storedAssets.length}`)

    // Only exercise the serving path when there really is a file: if the
    // generation step broke, the assertion above already recorded one honest
    // failure and this section must not turn it into a crash.
    if (storedAssets.length > 0) {
      const file = storedAssets[storedAssets.length - 1].file

      const served = await callRoute(asset(), { method: 'GET', url: `${AIDRAMA_API.asset}/${projectId}/${file}` })
      check('asset streams the stored bytes with the right content-type and cache header',
        served.status === 200
        && served.type.startsWith('image/png')
        && served.headers['cache-control'] === 'private, max-age=3600'
        && Buffer.from(served.raw, 'binary').length > 0,
        `${served.status} ${served.type} ${JSON.stringify(served.headers)}`)

      const miss = await callRoute(asset(), { method: 'GET', url: `${AIDRAMA_API.asset}/${projectId}/nope.png` })
      check('asset 404s on a missing file', miss.status === 404 && miss.body?.error === 'asset not found', `${miss.status}`)

      const traversal = await callRoute(asset(), { method: 'GET', url: `${AIDRAMA_API.asset}/${projectId}/..%2F..%2Fsecret.json` })
      check('asset refuses a traversal file name', traversal.status === 404, `${traversal.status} ${traversal.raw}`)

      const badProject = await callRoute(asset(), { method: 'GET', url: `${AIDRAMA_API.asset}/..%2F..%2Fetc/${file}` })
      check('asset refuses a traversal project id', badProject.status === 404, `${badProject.status} ${badProject.raw}`)

      const short = await callRoute(asset(), { method: 'GET', url: `${AIDRAMA_API.asset}/${projectId}` })
      check('asset 404s on an incomplete path', short.status === 404, `${short.status}`)
    }
  }

  /* ---------------------------------------------------------------- *
   * export route
   * ---------------------------------------------------------------- */
  console.log('\n— export —')
  {
    // Section (e) re-committed the script with an emptier fixture. Re-commit a
    // RICH one here so the markdown assertions test the renderer against data
    // this section owns rather than whatever a previous section happened to
    // leave behind.
    const scriptFixture = {
      episodes: [{
        no: 1,
        title: '第 1 集：退婚书',
        hook: '屏幕上的数字开始狂跳。',
        scenes: [{
          no: 1,
          slug: 'INT. 苏家餐厅 - 夜',
          location: '苏家餐厅',
          time: '夜',
          characters: ['林越', '苏建国'],
          action: '林越把退婚书放在转盘上，推过桌面。',
          dialogue: [{ who: '苏建国', line: '签了它，从今天起你跟我们苏家没关系。' }],
          durationSec: 45,
          shots: [
            { no: 1, shot: '中景', camera: '低机位缓推', description: '林越站在餐桌尽头。', motion: '他向前迈一步。', durationSec: 5 },
            { no: 2, shot: '特写', camera: '固定机位', description: '苏建国的手压住退婚书。', motion: '手指收紧。', durationSec: 3 },
          ],
        }],
      }],
    }
    await callRoute(stage(), { body: { projectId, stage: 'script', action: 'commit', payload: scriptFixture } })

    const markdown = await callRoute(exportRoute(), { body: { projectId, format: 'markdown' } })
    const md = String(markdown.body?.content ?? '')
    check('export markdown is a readable 分镜脚本',
      markdown.body?.ok === true
      && /分镜脚本/.test(String(markdown.body.filename))
      && md.includes('## 三、分场脚本')
      && md.includes('#### 第 1-1 场')
      && md.includes('INT. 苏家餐厅 - 夜')
      && md.includes('人物：林越、苏建国')
      && md.includes('动作：林越把退婚书放在转盘上'),
      `${markdown.status} ${md.slice(0, 200)}`)

    check('export markdown renders 对白 with speakers',
      md.includes('**对白**') && md.includes('苏建国：签了它，从今天起你跟我们苏家没关系。'),
      md.slice(0, 200))

    check('export markdown renders the 镜头 table with 景别 / 机位 / 时长',
      md.includes('| 镜号 | 景别 | 机位/运动 | 画面 | 主体动作 | 时长 |')
      && /\| 1 \| 中景 \| 低机位缓推 \|/.test(md)
      && /\| 2 \| 特写 \| 固定机位 \|/.test(md)
      && md.includes('| 5s |') && md.includes('| 3s |'),
      md.slice(0, 200))

    check('export markdown includes the bible sections and asset list',
      md.includes('## 四、设定集') && md.includes('**林越**')
      && md.includes('## 五、视觉资产') && md.includes('character-sheet'),
      md.slice(0, 200))

    const json = await callRoute(exportRoute(), { body: { projectId, format: 'json' } })
    check('export json is the raw project document',
      json.body?.ok === true
      && JSON.parse(String(json.body.content)).id === projectId
      && String(json.body.filename).endsWith('.json'),
      `${json.status} ${String(json.body?.content ?? '').slice(0, 80)}`)

    const pack = await callRoute(exportRoute(), { body: { projectId, format: 'prompt-pack' } })
    const packText = String(pack.body?.content ?? '')
    check('export prompt-pack lists image AND video prompts, copy-ready',
      pack.body?.ok === true
      && packText.includes('人物三视图')
      && packText.includes('场景主图')
      && packText.includes('逐镜视频提示词')
      && /```/.test(packText),
      `${pack.status} ${packText.slice(0, 160)}`)

    const bad = await callRoute(exportRoute(), { body: { projectId, format: 'pdf' } })
    check('export rejects an unknown format', bad.body?.ok === false && bad.body?.code === 'bad-request')

    const gone = await callRoute(exportRoute(), { body: { projectId: 'p-missing', format: 'json' } })
    check('export on a missing project → not-found', gone.body?.ok === false && gone.body?.code === 'not-found')
  }

  /* ---------------------------------------------------------------- *
   * (f) key hygiene
   * ---------------------------------------------------------------- */
  console.log('\n— key hygiene —')
  {
    const configured = await callRoute(configRoute(), { body: {} })
    const raw = configured.raw
    check('(f) /config never contains an api key',
      configured.body?.ok === true && !raw.includes(IMAGE_KEY) && !raw.includes(VIDEO_KEY),
      raw.slice(0, 200))

    const channels = configured.body?.config?.channels ?? []
    const withKey = channels.find(channel => channel.id === 'coderxiaoc')
    const withoutKey = channels.find(channel => channel.id === 'no-key-channel')
    check('(f) /config reports hasKey as a boolean only',
      withKey?.hasKey === true && withoutKey?.hasKey === false
      && !Object.hasOwn(withKey ?? {}, 'apiKey')
      && !Object.hasOwn(withoutKey ?? {}, 'apiKey'),
      JSON.stringify(channels))

    check('(f) /config projects exactly the documented channel fields',
      eq(Object.keys(withKey ?? {}).sort(), ['apiUrl', 'hasKey', 'id', 'models', 'name', 'protocol']),
      JSON.stringify(Object.keys(withKey ?? {})))

    check('(f) /config exposes no video key either',
      (configured.body?.config?.videoChannels ?? []).every(channel => !Object.hasOwn(channel, 'apiKey')),
      JSON.stringify(configured.body?.config?.videoChannels ?? []))

    // The strongest form: every response ever produced by this suite, and every
    // byte of state the routes handed out, must be free of both keys.
    const transcript = recordedResponses.join('\n')
    check('(f) NO response body anywhere in this run contains a key',
      !transcript.includes(IMAGE_KEY) && !transcript.includes(VIDEO_KEY),
      transcript.includes(IMAGE_KEY) ? 'IMAGE KEY FOUND' : (transcript.includes(VIDEO_KEY) ? 'VIDEO KEY FOUND' : ''))

    check('(f) no key appears in any generated asset URL',
      !recordedResponses.join('\n').includes(encodeURIComponent(IMAGE_KEY)))

    // A key placed inside an error path must still be scrubbed. The stub is told
    // to make the upstream echo the credential back verbatim, which regexes
    // alone could never catch — only literal removal of a known secret can.
    const previous = resolvedConfig
    resolvedConfig = {
      ...testConfig(),
      videoChannels: [{ id: 'leaky', name: 'leaky', protocol: VIDEO_PROTOCOL.minimax, apiUrl: 'https://x.invalid/v1', apiKey: VIDEO_KEY, model: 'm', leaky: true }],
      defaultVideoChannelId: 'leaky',
    }
    const failedSubmit = await callRoute(video(), { body: { projectId, action: 'submit' } })
    check('(f) a failure whose upstream echoes the key back leaks nothing',
      failedSubmit.body?.ok === true
      && (failedSubmit.body.failures ?? []).length > 0
      && !failedSubmit.raw.includes(VIDEO_KEY)
      && failedSubmit.raw.includes('****'),
      failedSubmit.raw.slice(0, 300))

    // Even the success path must not carry a key in a task record.
    check('(f) a stored video task never carries a key',
      !JSON.stringify(store.documents.get(projectId)?.videoTasks ?? []).includes(VIDEO_KEY))
    resolvedConfig = previous

    // The config resolver itself throwing must not leak the config object.
    const savedResolver = resolvedConfig
    bootDeps()
    // `bootDeps()` installs a fresh store, so the shared fixture is gone. Give
    // this sub-case its own project rather than assuming the old one survived.
    const throwConfigProjectId = String((await callRoute(projects(), {
      body: { action: 'create', title: '密钥测试' },
    })).body?.project?.id ?? '')
    const routesWithThrowingConfig = makeAidramaRoutes({
      store,
      stages: realStages,
      prompts: realPrompts,
      video: {},
      resolveConfig: () => { throw new Error(`boom ${IMAGE_KEY}`) },
      generateImage: async () => ({ images: [] }),
    })
    const throwingConfig = routesWithThrowingConfig.find(route => route.path === AIDRAMA_API.config)
    const configAfterThrow = await callRoute(throwingConfig, { body: {} })
    check('(f) a throwing config resolver yields an envelope, not a leak or a crash',
      configAfterThrow.status === 200
      && configAfterThrow.body?.config?.channels?.length === 0
      && !configAfterThrow.raw.includes(IMAGE_KEY),
      configAfterThrow.raw.slice(0, 200))
    resolvedConfig = savedResolver
    bootDeps()
  }

  /* ---------------------------------------------------------------- *
   * body cap + misc
   * ---------------------------------------------------------------- */
  console.log('\n— body cap —')
  {
    const oversized = await callRoute(projects(), { rawBody: 'x'.repeat(MAX_JSON_BODY_BYTES + 1024) })
    check(`an oversized body (> ${MAX_JSON_BODY_BYTES} bytes) → bad-request`,
      oversized.status === 200 && oversized.body?.ok === false && oversized.body?.code === 'bad-request',
      `${oversized.status} ${oversized.raw.slice(0, 160)}`)

    const malformed = await callRoute(projects(), { rawBody: '{ not json' })
    check('a malformed JSON body → bad-request',
      malformed.body?.ok === false && malformed.body?.code === 'bad-request', malformed.raw.slice(0, 160))

    const unknownAction = await callRoute(projects(), { body: { action: 'explode' } })
    check('an unknown action → bad-request',
      unknownAction.body?.ok === false && unknownAction.body?.code === 'bad-request', unknownAction.raw.slice(0, 160))

    const emptyAction = await callRoute(stage(), { body: { projectId } })
    check('a missing action → bad-request', emptyAction.body?.ok === false, emptyAction.raw.slice(0, 160))

    // `bootDeps()` ran in the key-hygiene section, so this section's store is
    // fresh: create a project HERE rather than reaching for the earlier fixture.
    const doomed = await callRoute(projects(), { body: { action: 'create', title: '待删除' } })
    const doomedId = String(doomed.body?.project?.id ?? '')
    check('a project was created to delete', doomedId !== '', doomed.raw.slice(0, 160))

    const deleted = await callRoute(projects(), { body: { action: 'delete', id: doomedId } })
    check('delete removes the project', deleted.body?.ok === true, deleted.raw.slice(0, 160))

    const afterDelete = await callRoute(projects(), { body: { action: 'get', id: doomedId } })
    check('the deleted project is really gone',
      afterDelete.body?.ok === false && afterDelete.body?.code === 'not-found')

    const listAfterDelete = await callRoute(projects(), { body: { action: 'list' } })
    check('the deleted project is absent from the listing',
      !(listAfterDelete.body?.projects ?? []).some(item => item.id === doomedId),
      JSON.stringify((listAfterDelete.body?.projects ?? []).map(p => p.id)))

    const deleteMissing = await callRoute(projects(), { body: { action: 'delete', id: 'p-missing' } })
    check('deleting a missing project → not-found',
      deleteMissing.body?.ok === false && deleteMissing.body?.code === 'not-found')
  }

  /* ---------------------------------------------------------------- *
   * route table
   * ---------------------------------------------------------------- */
  console.log('\n— route table —')
  {
    const expected = [
      ['exact', AIDRAMA_API.projects],
      ['exact', AIDRAMA_API.stage],
      ['exact', AIDRAMA_API.video],
      ['prefix', AIDRAMA_API.asset],
      ['exact', AIDRAMA_API.export],
      ['exact', AIDRAMA_API.config],
    ]
    const actual = routes.map(route => [route.kind, route.path])
    check('all six route families are mounted with the frozen kinds/paths',
      eq(actual, expected), JSON.stringify(actual))

    check('every route exposes a handler function',
      routes.every(route => typeof route.handler === 'function'))

    // The Agent tools look routes up by exact path, so a prefix must not shadow.
    check('the asset route is the only prefix route (so exact lookups stay unambiguous)',
      routes.filter(route => route.kind === 'prefix').length === 1)
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => {
  failed += 1
  console.log(`\nFAIL  harness crashed — ${error?.stack ?? error}`)
  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`)
  process.exit(1)
})
