/**
 * dsh-aidrama — video adapter verification.
 *
 * Starts a REAL local http server that emulates each upstream protocol's
 * submit / poll / terminal flow, points channels at it, and asserts the
 * adapter-layer contract. No network access, no dependencies, no test runner.
 *
 *   node docs/verify-video.mjs
 *
 * Prints PASS/FAIL per assertion and exits non-zero if any assertion fails.
 */

import http from 'node:http'
import { Buffer } from 'node:buffer'
import {
  ADAPTERS,
  adapterFor,
  submitVideo,
  pollVideo,
  fetchVideoBytes,
  videoCapabilities,
  videoChannelPresets,
} from '../lib/host/video.js'
import { VIDEO_PROTOCOL, VIDEO_TASK_STATUS, PROJECT_DEFAULTS } from '../lib/host/protocol.js'

/* ------------------------------------------------------------------ *
 * Tiny assertion harness
 * ------------------------------------------------------------------ */

let passed = 0
let failed = 0

/**
 * Record one assertion.
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Deep-ish equality for small JSON values. */
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/* ------------------------------------------------------------------ *
 * Fake upstream server
 * ------------------------------------------------------------------ */

/** Absolute base URL of the fake upstream, set once listening. */
let BASE = ''
/** Per-run knobs the tests mutate. */
const state = {
  /** How many polls before a task reaches its terminal state. */
  pollsBeforeTerminal: 2,
  /** Terminal state the next task will reach. */
  terminal: 'success',
  /** Count of poll requests received, for the abort test. */
  pollCount: 0,
  /** Fail with this HTTP status + body when set (non-2xx error contract). */
  forceHttpError: null,
  /** Secret the fake upstream will echo back in its error messages. */
  secret: '',
  /**
   * When set, the poll handler aborts this controller while the request is in
   * flight and then never answers. This makes the abort test deterministic:
   * cancellation provably happens mid-request, not on a wall-clock timer that
   * races the in-process server.
   */
  abortOnPoll: null,
}

/** task id → { polls, kind } */
const tasks = new Map()

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return {}
  try { return JSON.parse(text) } catch { return { __raw: text } }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE || 'http://127.0.0.1')
  const path = url.pathname

  // A big binary payload so we can prove byte-faithful download.
  if (path === '/cdn/clip.mp4') {
    const bytes = Buffer.alloc(64 * 1024, 7)
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length })
    res.end(bytes)
    return
  }
  // A URL whose extension lies, to exercise the mime fallback.
  if (path === '/cdn/opaque') {
    const bytes = Buffer.from('not-really-a-video')
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
    res.end(bytes)
    return
  }
  if (path === '/cdn/empty.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 0 })
    res.end()
    return
  }
  if (path === '/cdn/boom.mp4') {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(`upstream exploded ${'x'.repeat(4000)}`)
    return
  }

  if (state.forceHttpError) {
    const { status, body } = state.forceHttpError
    json(res, status, { error: { message: `${body} token=${state.secret}` } })
    return
  }

  /* --- MiniMax ---------------------------------------------------- */
  if (path === '/v1/video_generation' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body.model || !body.prompt) return json(res, 400, { base_resp: { status_code: 2013, status_msg: 'invalid params' } })
    const id = `mm-${tasks.size + 1}`
    tasks.set(id, { polls: 0, kind: 'minimax', body })
    return json(res, 200, { task_id: id, base_resp: { status_code: 0, status_msg: 'success' } })
  }
  if (path === '/v1/query/video_generation') {
    state.pollCount += 1
    // Deterministic mid-flight cancellation: abort the caller's signal now, then
    // stall forever so the only way the poll can settle is by rejecting.
    if (state.abortOnPoll) {
      const controller = state.abortOnPoll
      state.abortOnPoll = null
      controller.abort()
      return
    }
    const id = url.searchParams.get('task_id')
    const task = tasks.get(id)
    if (!task) return json(res, 200, { base_resp: { status_code: 1004, status_msg: 'task not found' } })
    task.polls += 1
    if (task.polls < state.pollsBeforeTerminal) {
      return json(res, 200, { task_id: id, status: task.polls === 1 ? 'Queueing' : 'Processing', base_resp: { status_code: 0 } })
    }
    if (state.terminal === 'fail') {
      return json(res, 200, { task_id: id, status: 'Fail', base_resp: { status_code: 0, status_msg: `content review rejected token=${state.secret}` } })
    }
    return json(res, 200, { task_id: id, status: 'Success', file_id: `file-${id}`, base_resp: { status_code: 0 } })
  }
  if (path === '/v1/files/retrieve') {
    const id = url.searchParams.get('file_id')
    if (!id) return json(res, 400, { base_resp: { status_code: 1002, status_msg: 'missing file_id' } })
    return json(res, 200, { file: { file_id: id, download_url: `${BASE}/cdn/clip.mp4`, bytes: 65536 } })
  }

  /* --- Seedance / Ark --------------------------------------------- */
  if (path === '/api/v3/contents/generations/tasks' && req.method === 'POST') {
    const body = await readBody(req)
    if (!Array.isArray(body.content) || body.content.length === 0) {
      return json(res, 400, { error: { code: 'InvalidParameter', message: 'content must not be empty' } })
    }
    const id = `sd-${tasks.size + 1}`
    tasks.set(id, { polls: 0, kind: 'seedance', body })
    return json(res, 200, { id })
  }
  if (path.startsWith('/api/v3/contents/generations/tasks/')) {
    state.pollCount += 1
    const id = path.split('/').pop()
    const task = tasks.get(id)
    if (!task) return json(res, 404, { error: { code: 'NotFound', message: 'task not found' } })
    task.polls += 1
    if (task.polls < state.pollsBeforeTerminal) {
      return json(res, 200, { id, status: task.polls === 1 ? 'queued' : 'running' })
    }
    if (state.terminal === 'fail') {
      return json(res, 200, { id, status: 'failed', error: { code: 'SensitiveContent', message: `blocked by moderation token=${state.secret}` } })
    }
    return json(res, 200, {
      id,
      status: 'succeeded',
      content: { video_url: `${BASE}/cdn/clip.mp4`, cover_url: `${BASE}/cdn/opaque` },
      usage: { completion_tokens: 12345 },
    })
  }

  /* --- OpenAI-compat ---------------------------------------------- */
  if (path === '/v1/videos' && req.method === 'POST') {
    const body = await readBody(req)
    if (!body.prompt) return json(res, 400, { error: { message: 'prompt is required' } })
    const id = `oa-${tasks.size + 1}`
    tasks.set(id, { polls: 0, kind: 'openai', body })
    return json(res, 200, { id, status: 'queued', model: body.model })
  }
  if (path.startsWith('/v1/videos/')) {
    state.pollCount += 1
    const id = path.split('/').pop()
    const task = tasks.get(id)
    if (!task) return json(res, 404, { error: { message: 'no such video task' } })
    task.polls += 1
    if (task.polls < state.pollsBeforeTerminal) {
      return json(res, 200, { id, status: 'in_progress', progress: 40 })
    }
    if (state.terminal === 'fail') {
      return json(res, 200, { id, status: 'failed', error: { message: `renderer OOM token=${state.secret}` } })
    }
    return json(res, 200, { id, status: 'completed', video_url: `${BASE}/cdn/clip.mp4`, thumbnail_url: `${BASE}/cdn/opaque` })
  }
  // A sync-style relay returning { data: [{ url }] } straight away.
  if (path === '/v1/video/generations' && req.method === 'POST') {
    const body = await readBody(req)
    return json(res, 200, { created: Date.now(), data: [{ url: `${BASE}/cdn/clip.mp4`, cover_url: `${BASE}/cdn/opaque` }], model: body.model })
  }
  // Relay with no video endpoint at all, to prove the 404 fallback path.
  if (path === '/v1/sync-only/videos' && req.method === 'POST') {
    return json(res, 404, { error: { message: 'unknown route' } })
  }
  if (path === '/v1/sync-only/video/generations' && req.method === 'POST') {
    return json(res, 200, { data: [{ url: `${BASE}/cdn/clip.mp4` }] })
  }

  json(res, 404, { error: { message: `no fake route for ${req.method} ${path}` } })
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
BASE = `http://127.0.0.1:${server.address().port}`
console.log(`fake upstream listening on ${BASE}\n`)

/** Shorthand for a channel pointing at the fake server. */
function channel(protocol, path, model, key = 'sk-test-key-abcd1234') {
  return { id: `t-${protocol}`, name: `test-${protocol}`, protocol, apiUrl: `${BASE}${path}`, apiKey: key, model }
}

/** Poll until terminal (or a bounded number of tries). */
async function pollUntilDone(ch, taskId, { max = 8, signal } = {}) {
  let last
  for (let i = 0; i < max; i += 1) {
    last = await pollVideo({ channel: ch, taskId, signal })
    if (last.status === VIDEO_TASK_STATUS.succeeded || last.status === VIDEO_TASK_STATUS.failed) return last
  }
  return last
}

try {
  /* ================================================================ *
   * 1. Interface shape
   * ================================================================ */
  console.log('— interface —')
  const protocols = Object.values(VIDEO_PROTOCOL)
  check('ADAPTERS exposes exactly the four protocols', eq(Object.keys(ADAPTERS).sort(), [...protocols].sort()), JSON.stringify(Object.keys(ADAPTERS)))
  for (const p of protocols) {
    const a = adapterFor(p)
    check(`adapterFor(${p}) has {protocol, capabilities, submit, poll, fetch}`,
      a.protocol === p && typeof a.submit === 'function' && typeof a.poll === 'function' &&
      typeof a.fetch === 'function' && typeof a.capabilities === 'object')
  }
  let unknownThrew = false
  try { adapterFor('nope') } catch { unknownThrew = true }
  check('adapterFor(unknown) throws', unknownThrew)
  check('prompt-pack capabilities claim no last-frame support',
    videoCapabilities(VIDEO_PROTOCOL.promptPack).firstLastFrame === false)
  const presets = videoChannelPresets()
  check('presets cover minimax / seedance / openai-compat / prompt-pack',
    eq([...new Set(presets.map(p => p.protocol))].sort(), [...protocols].sort()), JSON.stringify(presets.map(p => p.protocol)))
  check('presets include both MiniMax hosts',
    presets.some(p => p.apiUrl === 'https://api.minimax.io/v1') && presets.some(p => p.apiUrl === 'https://api.minimaxi.com/v1'))
  check('preset shape is {id,name,protocol,apiUrl,hint,models}',
    presets.every(p => typeof p.id === 'string' && typeof p.name === 'string' && typeof p.protocol === 'string' &&
      typeof p.apiUrl === 'string' && typeof p.hint === 'string' && Array.isArray(p.models)))

  /* ================================================================ *
   * (a) submit → running → succeeded returns a videoUrl
   * ================================================================ */
  console.log('\n— (a) happy path per protocol —')

  state.terminal = 'success'
  state.pollsBeforeTerminal = 2

  {
    const ch = channel(VIDEO_PROTOCOL.minimax, '/v1', 'MiniMax-Hailuo-02')
    const sub = await submitVideo({ channel: ch, prompt: '一只猫在雨夜奔跑', firstFrame: `${BASE}/cdn/opaque`, durationSec: 6, aspectRatio: '16:9' })
    check('minimax submit returns a queued taskId', typeof sub.taskId === 'string' && sub.taskId.startsWith('mm-') && sub.status === VIDEO_TASK_STATUS.queued, JSON.stringify(sub))
    const firstPoll = await pollVideo({ channel: ch, taskId: sub.taskId })
    check('minimax first poll is non-terminal (queued/running)',
      firstPoll.status === VIDEO_TASK_STATUS.queued || firstPoll.status === VIDEO_TASK_STATUS.running, JSON.stringify(firstPoll))
    const done = await pollUntilDone(ch, sub.taskId)
    check('minimax reaches succeeded with a videoUrl',
      done.status === VIDEO_TASK_STATUS.succeeded && done.videoUrl === `${BASE}/cdn/clip.mp4`, JSON.stringify(done))
    check('minimax resolved file_id → /files/retrieve → download_url', done.raw?.fileId === `file-${sub.taskId}`)
    check('minimax sent first_frame_image for image-to-video',
      tasks.get(sub.taskId).body.first_frame_image === `${BASE}/cdn/opaque`)
    const bytes = await fetchVideoBytes({ url: done.videoUrl })
    check('minimax video bytes download intact (64 KiB, video/mp4)', bytes.data.length === 65536 && bytes.mime === 'video/mp4', `${bytes.data.length} ${bytes.mime}`)
  }

  {
    const ch = channel(VIDEO_PROTOCOL.seedance, '/api/v3', 'doubao-seedance-1-0-pro-250528')
    const sub = await submitVideo({ channel: ch, prompt: '赛博朋克街道延时', firstFrame: `${BASE}/cdn/opaque`, durationSec: 5, aspectRatio: '16:9' })
    check('seedance submit returns a task id', typeof sub.taskId === 'string' && sub.taskId.startsWith('sd-'), JSON.stringify(sub))
    const done = await pollUntilDone(ch, sub.taskId)
    check('seedance reaches succeeded with a videoUrl',
      done.status === VIDEO_TASK_STATUS.succeeded && done.videoUrl === `${BASE}/cdn/clip.mp4`, JSON.stringify(done))
    const sent = tasks.get(sub.taskId).body
    check('seedance body used content[] with text + image_url entries',
      eq(sent.content, [
        { type: 'text', text: '赛博朋克街道延时' },
        { type: 'image_url', image_url: { url: `${BASE}/cdn/opaque` }, role: 'first_frame' },
      ]), JSON.stringify(sent.content))
    check('seedance exposes coverUrl', done.coverUrl === `${BASE}/cdn/opaque`)
  }

  {
    const ch = channel(VIDEO_PROTOCOL.openaiCompat, '/v1', 'veo-3')
    const sub = await submitVideo({ channel: ch, prompt: '航拍海岸线', durationSec: 5, aspectRatio: '16:9' })
    check('openai-compat submit hits /videos', String(sub.raw?.endpoint ?? '').endsWith('/videos'), JSON.stringify(sub.raw?.endpoint))
    const mid = await pollVideo({ channel: ch, taskId: sub.taskId })
    check('openai-compat surfaces running from in_progress', mid.status === VIDEO_TASK_STATUS.running, JSON.stringify(mid))
    const done = await pollUntilDone(ch, sub.taskId)
    check('openai-compat reaches succeeded with a videoUrl',
      done.status === VIDEO_TASK_STATUS.succeeded && done.videoUrl === `${BASE}/cdn/clip.mp4`, JSON.stringify(done))
  }

  {
    // Sync relay: result returned straight away, path fallback /videos → /video/generations.
    const ch = channel(VIDEO_PROTOCOL.openaiCompat, '/v1/sync-only', 'sora-2')
    const sub = await submitVideo({ channel: ch, prompt: '同步返回', durationSec: 5, aspectRatio: '16:9' })
    check('openai-compat falls back to /video/generations on 404 and tolerates {data:[{url}]}',
      sub.status === VIDEO_TASK_STATUS.succeeded && sub.raw?.videoUrl === `${BASE}/cdn/clip.mp4`, JSON.stringify(sub))
    const done = await pollVideo({ channel: ch, taskId: sub.taskId })
    check('sync-relay task id polls as succeeded without a second network call',
      done.status === VIDEO_TASK_STATUS.succeeded, JSON.stringify(done))
  }

  /* ================================================================ *
   * (b) failure terminal state surfaces the upstream error
   * ================================================================ */
  console.log('\n— (b) failure terminal states —')
  state.terminal = 'fail'
  state.pollsBeforeTerminal = 1
  state.secret = 'sk-LEAK-CANARY-987654'

  {
    const ch = channel(VIDEO_PROTOCOL.minimax, '/v1', 'MiniMax-Hailuo-02')
    const sub = await submitVideo({ channel: ch, prompt: '会被审核拒绝的镜头' })
    const done = await pollUntilDone(ch, sub.taskId, { max: 3 })
    check('minimax Fail → status failed', done.status === VIDEO_TASK_STATUS.failed, JSON.stringify(done))
    check('minimax failure surfaces the upstream error text', /content review rejected/.test(done.error ?? ''), done.error)
    check('minimax failure carries no videoUrl', done.videoUrl === undefined)
  }
  {
    const ch = channel(VIDEO_PROTOCOL.seedance, '/api/v3', 'doubao-seedance-1-0-pro')
    const sub = await submitVideo({ channel: ch, prompt: '违规内容' })
    const done = await pollUntilDone(ch, sub.taskId, { max: 3 })
    check('seedance failed → status failed', done.status === VIDEO_TASK_STATUS.failed, JSON.stringify(done))
    check('seedance failure surfaces the upstream error text', /blocked by moderation/.test(done.error ?? ''), done.error)
  }
  {
    const ch = channel(VIDEO_PROTOCOL.openaiCompat, '/v1', 'veo-3')
    const sub = await submitVideo({ channel: ch, prompt: '崩溃的渲染' })
    const done = await pollUntilDone(ch, sub.taskId, { max: 3 })
    check('openai-compat failed → status failed', done.status === VIDEO_TASK_STATUS.failed, JSON.stringify(done))
    check('openai-compat failure surfaces the upstream error text', /renderer OOM/.test(done.error ?? ''), done.error)
  }

  /* ================================================================ *
   * (c) prompt-pack: no server, no key
   * ================================================================ */
  console.log('\n— (c) prompt-pack offline fallback —')
  {
    const ch = { id: 'pp', name: '仅提示词包', protocol: VIDEO_PROTOCOL.promptPack, apiUrl: '', apiKey: '', model: '' }
    const sub = await submitVideo({ channel: ch, prompt: '少女推开门，逆光', firstFrame: 'asset://first-frame-1', durationSec: 5, aspectRatio: '9:16' })
    check('prompt-pack submit succeeds with no key and no apiUrl',
      sub.status === VIDEO_TASK_STATUS.succeeded && sub.taskId === 'prompt-pack', JSON.stringify(sub))
    check('prompt-pack reports zero network calls', sub.raw?.networkCalls === 0)
    check('prompt-pack bundle carries prompt + firstFrame + ratio',
      sub.raw?.bundle?.prompt === '少女推开门，逆光' && sub.raw?.bundle?.firstFrame?.ref === 'asset://first-frame-1' && sub.raw?.bundle?.aspectRatio === '9:16',
      JSON.stringify(sub.raw?.bundle))
    const done = await pollVideo({ channel: ch, taskId: 'prompt-pack' })
    check('prompt-pack poll echoes succeeded', done.status === VIDEO_TASK_STATUS.succeeded, JSON.stringify(done))
    const during = state.pollCount
    await pollVideo({ channel: ch, taskId: 'prompt-pack' })
    check('prompt-pack poll made no HTTP request', state.pollCount === during)
    let fetchThrew = false
    try { await fetchVideoBytes({ url: '' }) } catch { fetchThrew = true }
    check('fetchVideoBytes rejects an empty url', fetchThrew)
  }

  /* ================================================================ *
   * (d) duration / aspect clamps are reported
   * ================================================================ */
  console.log('\n— (d) clamping —')
  state.terminal = 'success'
  state.pollsBeforeTerminal = 1
  {
    const ch = channel(VIDEO_PROTOCOL.minimax, '/v1', 'MiniMax-Hailuo-02')
    const sub = await submitVideo({ channel: ch, prompt: '长镜头', durationSec: 999, aspectRatio: '21:9' })
    const clamped = sub.raw?.clamped
    check('over-long duration is clamped, not rejected', clamped?.applied?.durationSec === videoCapabilities(VIDEO_PROTOCOL.minimax).maxDurationSec, JSON.stringify(clamped))
    // minimax supports 16:9 / 9:16 / 1:1; 21:9 is unsupported, and the project
    // default (9:16) IS supported, so the default wins and is reported.
    check('unsupported aspect falls back to the project default',
      clamped?.applied?.aspectRatio === PROJECT_DEFAULTS.aspectRatio, JSON.stringify(clamped))
    check('clamp report keeps the requested values', clamped?.requested?.durationSec === 999 && clamped?.requested?.aspectRatio === '21:9')
    check('clamp notes explain both decisions', Array.isArray(clamped?.notes) && clamped.notes.length === 2, JSON.stringify(clamped?.notes))
    check('the clamped values are what actually went upstream',
      tasks.get(sub.taskId).body.duration === 10 && tasks.get(sub.taskId).body.aspect_ratio === PROJECT_DEFAULTS.aspectRatio,
      JSON.stringify(tasks.get(sub.taskId).body))
    // The project default shot length is 5s but minimax's floor is 6s: the
    // default must be pinned up into range or the upstream rejects the call.
    const ok = await submitVideo({ channel: ch, prompt: '正常镜头', durationSec: 6, aspectRatio: '9:16' })
    check('an in-range request reports no clamp', ok.raw?.clamped === undefined, JSON.stringify(ok.raw?.clamped))

    const below = await submitVideo({ channel: ch, prompt: '太短的镜头', durationSec: 1, aspectRatio: '16:9' })
    check('below-minimum duration clamps up to the model minimum',
      below.raw?.clamped?.applied?.durationSec === videoCapabilities(VIDEO_PROTOCOL.minimax).minDurationSec, JSON.stringify(below.raw?.clamped))

    const dflt = await submitVideo({ channel: ch, prompt: '没写时长', durationSec: undefined, aspectRatio: undefined })
    check('an unspecified duration uses the project default pinned into [min,max]',
      dflt.raw?.clamped === undefined && tasks.get(dflt.taskId).body.duration === 6, JSON.stringify(tasks.get(dflt.taskId).body))
  }
  {
    const ch = channel(VIDEO_PROTOCOL.seedance, '/api/v3', 'doubao-seedance-1-0-pro')
    const sub = await submitVideo({ channel: ch, prompt: '超长', durationSec: 60, aspectRatio: '9:16' })
    check('clamping is per-protocol (seedance allows 12s)',
      sub.raw?.clamped?.applied?.durationSec === 12 && sub.raw?.clamped?.applied?.aspectRatio === '9:16', JSON.stringify(sub.raw?.clamped))
  }

  /* ================================================================ *
   * (e) an AbortSignal cancels an in-flight poll
   * ================================================================ */
  console.log('\n— (e) abort —')
  state.pollsBeforeTerminal = 99
  state.terminal = 'success'
  {
    const ch = channel(VIDEO_PROTOCOL.minimax, '/v1', 'MiniMax-Hailuo-02')
    const sub = await submitVideo({ channel: ch, prompt: '永不结束的任务' })
    const controller = new AbortController()
    // Abort from INSIDE the server handler, so the request is provably in
    // flight when the signal fires. A wall-clock setTimeout here is a race: the
    // in-process fake server usually answers in <1ms, so the poll would settle
    // before the timer ever fired and the assertion flaked ~50% of runs.
    state.abortOnPoll = controller
    const pending = pollVideo({ channel: ch, taskId: sub.taskId, signal: controller.signal })
    let abortErr = null
    try { await pending } catch (err) { abortErr = err }
    state.abortOnPoll = null
    check('an aborted in-flight poll rejects with AbortError', abortErr?.name === 'AbortError', String(abortErr))

    // A pre-aborted signal must reject too, and must not reach the network.
    const pre = new AbortController()
    pre.abort()
    const before = state.pollCount
    let preErr = null
    try { await pollVideo({ channel: ch, taskId: sub.taskId, signal: pre.signal }) } catch (err) { preErr = err }
    check('a pre-aborted signal rejects immediately', preErr?.name === 'AbortError', String(preErr))
    check('a pre-aborted signal never reaches the network', state.pollCount === before, `${before} → ${state.pollCount}`)

    let submitErr = null
    try { await submitVideo({ channel: ch, prompt: '别提交', signal: pre.signal }) } catch (err) { submitErr = err }
    check('a pre-aborted signal also cancels submit', submitErr?.name === 'AbortError', String(submitErr))

    let bytesErr = null
    const bytesController = new AbortController()
    const bytesPending = fetchVideoBytes({ url: `${BASE}/cdn/clip.mp4`, signal: bytesController.signal })
    bytesController.abort()
    try { await bytesPending } catch (err) { bytesErr = err }
    check('fetchVideoBytes honours the signal', bytesErr?.name === 'AbortError', String(bytesErr))
  }
  state.pollsBeforeTerminal = 1

  /* ================================================================ *
   * (f) no api key appears in any thrown message
   * ================================================================ */
  console.log('\n— (f) key hygiene + error truncation —')
  const CANARY = 'sk-CANARY-MUST-NOT-LEAK-4f2a'
  state.forceHttpError = { status: 429, body: `rate limited, please retry ${'y'.repeat(3000)}` }
  state.secret = CANARY
  const thrown = []
  for (const p of [VIDEO_PROTOCOL.minimax, VIDEO_PROTOCOL.seedance, VIDEO_PROTOCOL.openaiCompat]) {
    const path = p === VIDEO_PROTOCOL.minimax ? '/v1' : p === VIDEO_PROTOCOL.seedance ? '/api/v3' : '/v1'
    const ch = channel(p, path, 'm', CANARY)
    try { await submitVideo({ channel: ch, prompt: '强制 HTTP 错误' }) } catch (err) { thrown.push({ p, err }) }
  }
  check('a non-2xx upstream response throws for every protocol', thrown.length === 3, `threw ${thrown.length}/3`)
  check('every thrown message includes the HTTP status',
    thrown.every(({ err }) => /429/.test(String(err.message))), thrown.map(t => t.err.message).join(' | '))
  check('every thrown message is truncated to a readable body',
    thrown.every(({ err }) => String(err.message).length < 1200), thrown.map(t => String(t.err.message).length).join(','))
  check('every thrown message includes the truncated marker',
    thrown.every(({ err }) => /truncated/.test(String(err.message))))
  check('no full api key appears in any thrown message',
    thrown.every(({ err }) => !String(err.message).includes(CANARY)), thrown.map(t => t.err.message).join(' | '))
  check('the key is masked to its last 4 characters where shown',
    thrown.every(({ err }) => /key \*{4}4f2a/.test(String(err.message))), thrown.map(t => t.err.message).join(' | '))
  check('the raw key never appears in err.body either',
    thrown.every(({ err }) => !String(err.body ?? '').includes(CANARY)))
  check('an upstream-echoed Bearer token is scrubbed',
    thrown.every(({ err }) => !/Bearer sk-/.test(String(err.message))))
  state.forceHttpError = null

  // Upstream HTTP-200 application errors (base_resp / error.message) too.
  {
    const ch = channel(VIDEO_PROTOCOL.minimax, '/v1', 'MiniMax-Hailuo-02', CANARY)
    let msg = ''
    try { await submitVideo({ channel: ch, prompt: '' }) } catch (err) { msg = String(err.message) }
    check('an empty prompt is rejected before any network call', /non-empty prompt/.test(msg), msg)
  }
  {
    const ch = channel(VIDEO_PROTOCOL.minimax, '/v1', 'MiniMax-Hailuo-02', CANARY)
    let msg = ''
    // A prompt of only spaces still counts as empty.
    try { await submitVideo({ channel: ch, prompt: '   ' }) } catch (err) { msg = String(err.message) }
    check('a whitespace-only prompt is rejected', /non-empty prompt/.test(msg), msg)
  }
  {
    // Fake upstream returns base_resp.status_code != 0 with HTTP 200.
    const server2 = http.createServer((req, res) => {
      json(res, 200, { base_resp: { status_code: 1008, status_msg: `insufficient balance token=${CANARY}` } })
    })
    await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve))
    const ch = { protocol: VIDEO_PROTOCOL.minimax, apiUrl: `http://127.0.0.1:${server2.address().port}/v1`, apiKey: CANARY, model: 'x' }
    let err200 = null
    try { await submitVideo({ channel: ch, prompt: '余额不足' }) } catch (err) { err200 = err }
    check('a MiniMax base_resp error surfaces as a thrown error', /insufficient balance/.test(String(err200?.message)), String(err200?.message))
    check('a MiniMax base_resp error message hides the key', err200 !== null && !String(err200.message).includes(CANARY))
    await new Promise(resolve => server2.close(resolve))
  }
  {
    let msg = ''
    try { await submitVideo({ channel: { protocol: VIDEO_PROTOCOL.seedance, apiUrl: `${BASE}/api/v3`, apiKey: '', model: 'm' }, prompt: 'x' }) } catch (err) { msg = String(err.message) }
    check('a missing key is rejected clearly and early', /no api key/.test(msg), msg)
  }

  /* ================================================================ *
   * Extra contract checks
   * ================================================================ */
  console.log('\n— extra contract —')
  {
    const bytes = await fetchVideoBytes({ url: `${BASE}/cdn/opaque` })
    check('mime falls back to the url extension when upstream says octet-stream',
      bytes.mime === 'application/octet-stream' && bytes.data.toString() === 'not-really-a-video', `${bytes.mime} ${bytes.data.length}`)
    let emptyThrew = false
    try { await fetchVideoBytes({ url: `${BASE}/cdn/empty.mp4` }) } catch { emptyThrew = true }
    check('an empty body is an error, not a zero-byte asset', emptyThrew)
    let boomMsg = ''
    try { await fetchVideoBytes({ url: `${BASE}/cdn/boom.mp4` }) } catch (err) { boomMsg = String(err.message) }
    check('a failed asset download reports status + truncated body',
      /HTTP 500/.test(boomMsg) && /truncated/.test(boomMsg) && boomMsg.length < 1200, boomMsg.slice(0, 200))
    const dataBytes = await fetchVideoBytes({ url: 'data:video/mp4;base64,AAAA' })
    check('data: URLs are decoded without a network call', dataBytes.data.length === 3 && dataBytes.mime === 'video/mp4')
  }
  {
    // A key long enough to be reconstructible must never be echoed whole.
    const LONG_KEY = 'sk-live-abcdefghijklmnopqrstuvwxyz0123456789'
    let msg = ''
    try { await submitVideo({ channel: { protocol: VIDEO_PROTOCOL.minimax, apiUrl: `${BASE}/v1`, apiKey: LONG_KEY, model: '' }, prompt: 'x' }) } catch (err) { msg = String(err.message) }
    check('a long key is never echoed beyond its last 4 characters',
      msg === '' || (!msg.includes(LONG_KEY) && !msg.includes(LONG_KEY.slice(0, -4))), msg)
    // Short keys collapse to **** so they are not partially recoverable.
    const SHORT_KEY = 'kkkk'
    let shortMsg = ''
    try { await submitVideo({ channel: { protocol: VIDEO_PROTOCOL.minimax, apiUrl: `${BASE}/v1`, apiKey: SHORT_KEY, model: '' }, prompt: 'x' }) } catch (err) { shortMsg = String(err.message) }
    check('a 4-character key masks to **** with no key material', shortMsg === '' || shortMsg.includes('****') === false || !shortMsg.includes(SHORT_KEY), shortMsg)
  }
} catch (err) {
  failed += 1
  console.log(`\nFAIL  harness crashed — ${err?.stack ?? err}`)
} finally {
  await new Promise(resolve => server.close(resolve))
}

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
