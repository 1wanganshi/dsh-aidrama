/**
 * dsh-aidrama — video generation adapter layer (host half).
 *
 * Design: one narrow adapter interface per upstream PROTOCOL, so a channel is
 * fully described by { protocol, apiUrl, apiKey, model }. Everything the stage
 * engine needs above this file is the six exported functions at the bottom.
 *
 * Adapter interface (deliberately thin — "薄抽象"):
 *
 *   {
 *     protocol: string,                 // one of VIDEO_PROTOCOL
 *     capabilities: {...},              // see videoCapabilities()
 *     submit(ctx) -> { taskId, status, raw },
 *     poll(ctx)   -> { status, videoUrl?, coverUrl?, error?, raw },
 *     fetch(ctx)  -> { data: Buffer, mime },
 *   }
 *
 * `ctx` always carries { apiUrl, apiKey, model } plus the per-call request
 * fields (prompt / firstFrame / lastFrame / durationSec / aspectRatio /
 * taskId / url / signal).
 *
 * The `prompt-pack` adapter is the always-available fallback: it performs ZERO
 * network calls and never requires a key, so the six-stage pipeline finishes
 * (emitting a copy-ready prompt bundle) even with no video credentials at all.
 *
 * Zero dependencies: global fetch, global AbortController, node:buffer only.
 *
 * UPSTREAM PROTOCOL CONFIDENCE (read this before trusting a field name):
 * This module was written without live access to the vendors' docs pages.
 * Every endpoint/field below is documented inline with its source URL and a
 * CONFIDENCE note. Anything marked UNVERIFIED should be re-checked against the
 * live API before shipping a paid run. See `uncertainties()` at the bottom for
 * the machine-readable list.
 */

import { Buffer } from 'node:buffer'
import {
  VIDEO_PROTOCOL,
  VIDEO_TASK_STATUS,
  PROJECT_DEFAULTS,
} from './protocol.js'

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Cap on how much of an upstream error body we ever surface. */
const ERROR_BODY_CAP = 500

/** Default per-request timeouts (ms). Submit can be slow on aggregators. */
const SUBMIT_TIMEOUT_MS = 60_000
const POLL_TIMEOUT_MS = 30_000
const FILE_TIMEOUT_MS = 120_000

/** Terminal statuses upstream may report, normalised per protocol. */
const TERMINAL = {
  succeeded: VIDEO_TASK_STATUS.succeeded,
  failed: VIDEO_TASK_STATUS.failed,
}

/**
 * Mask a secret so it can appear in a message without leaking the whole key.
 * Short keys collapse to `****` so no key is ever reconstructible.
 * @param {unknown} key
 * @returns {string}
 */
export function maskKey(key) {
  const value = typeof key === 'string' ? key : ''
  if (value === '') return '(empty)'
  if (value.length <= 4) return '****'
  return `****${value.slice(-4)}`
}

/**
 * Strip anything that looks like a credential out of free text. Belt-and-braces
 * on top of maskKey: upstream bodies occasionally echo the Authorization
 * header back at us.
 *
 * `knownKey` is the channel's actual key. Regexes alone cannot catch a key that
 * an upstream echoed verbatim inside a prose message (e.g. a 200-status
 * `base_resp.status_msg`), so when we know the secret we remove it literally.
 *
 * @param {string} text
 * @param {string} [knownKey]
 * @returns {string}
 */
function scrubSecrets(text, knownKey) {
  let out = String(text)
  // Literal removal first: this is the only defence that cannot be evaded by
  // an unexpected message shape.
  if (typeof knownKey === 'string' && knownKey.length >= 4) {
    out = out.split(knownKey).join(maskKey(knownKey))
  }
  return out
    .replace(/\b(?:Bearer|Token|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ****')
    .replace(/("?(?:api[_-]?key|access[_-]?token|authorization)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi, '$1****')
}

/**
 * Truncate a response body to a readable one-liner.
 * @param {string} body
 * @returns {string}
 */
function truncateBody(body) {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= ERROR_BODY_CAP) return flat
  return `${flat.slice(0, ERROR_BODY_CAP)}… [truncated, ${flat.length} chars total]`
}

/**
 * Build the single error type this module throws for upstream failures.
 * Guarantees: includes the HTTP status, includes a truncated body, never
 * includes an unmasked key.
 * @param {string} label  human-readable call label, e.g. `POST https://…/videos`
 * @param {number} status
 * @param {string} body
 * @param {string} [apiKey] used only in masked form, for correlation
 * @returns {Error}
 */
function upstreamError(label, status, body, apiKey) {
  const err = new Error(
    `${scrubSecrets(label, apiKey)} failed: HTTP ${status} — ${truncateBody(scrubSecrets(body, apiKey))}` +
    (apiKey ? ` (key ${maskKey(apiKey)})` : ''),
  )
  err.name = 'UpstreamError'
  err.status = status
  err.body = truncateBody(scrubSecrets(body, apiKey))
  return err
}

/** Shape error for a malformed/unsupported request (never leaks a key). */
function badRequest(message) {
  const err = new Error(message)
  err.name = 'AdapterInputError'
  return err
}

/**
 * Is this an AbortSignal-driven cancellation? We must rethrow these untouched
 * rather than wrapping them as upstream failures.
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbort(err) {
  return Boolean(err) && (
    err.name === 'AbortError' ||
    err.code === 'ABORT_ERR' ||
    err.code === 'ERR_CANCELED' ||
    // undici surfaces an aborted body read as a TypeError with this message
    /aborted/i.test(String(err.message ?? ''))
  )
}

/**
 * Throw a canonical AbortError so callers see `err.name === 'AbortError'`
 * regardless of which layer noticed the cancellation.
 * @param {string} [reason]
 * @returns {never}
 */
function throwAbort(reason) {
  const err = new Error(reason || 'The video request was aborted')
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  throw err
}

/**
 * Combine a caller signal with a per-request timeout. Returns the combined
 * signal plus a cleanup fn. Honours the caller signal exactly: aborting either
 * one aborts the fetch, and the caller's abort reason is preserved.
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {{ signal: AbortSignal, cleanup: () => void, cause: () => string }}
 */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  let cause = 'timeout'
  const timer = setTimeout(() => {
    cause = 'timeout'
    controller.abort()
  }, timeoutMs)
  // Do not keep the event loop alive purely for a timeout.
  if (typeof timer.unref === 'function') timer.unref()

  const onAbort = () => {
    cause = 'caller'
    controller.abort()
  }

  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throwAbort('The video request was aborted before it started')
    }
    signal.addEventListener('abort', onAbort, { once: true })
  }

  return {
    signal: controller.signal,
    cause: () => cause,
    cleanup: () => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

/** Join an apiUrl and a path without doubling or dropping the slash. */
function joinUrl(apiUrl, path) {
  const base = String(apiUrl ?? '').trim().replace(/\/+$/, '')
  if (base === '') throw badRequest('Channel apiUrl is empty')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/**
 * fetch() wrapper implementing the module-wide error/abort contract.
 * @param {string} label
 * @param {string} url
 * @param {RequestInit & { apiKey?: string, timeoutMs?: number }} init
 * @returns {Promise<Response>}
 */
async function request(label, url, init) {
  const { apiKey, timeoutMs = POLL_TIMEOUT_MS, signal, ...rest } = init
  const guard = withTimeout(signal, timeoutMs)
  let res
  try {
    res = await fetch(url, { ...rest, signal: guard.signal })
  } catch (err) {
    if (isAbort(err)) {
      if (guard.cause() === 'caller') throwAbort('The video request was aborted by the caller')
      const timeoutErr = new Error(`${label} timed out after ${timeoutMs}ms`)
      timeoutErr.name = 'TimeoutError'
      throw timeoutErr
    }
    const netErr = new Error(`${label} failed: ${scrubSecrets(String(err?.message ?? err), apiKey)}`)
    netErr.name = 'NetworkError'
    netErr.cause = err
    throw netErr
  } finally {
    guard.cleanup()
  }

  if (!res.ok) {
    let body = ''
    try {
      body = await res.text()
    } catch {
      body = '(unreadable body)'
    }
    throw upstreamError(label, res.status, body, apiKey)
  }
  return res
}

/**
 * `request` + JSON parse, returning { json, res }.
 * @param {string} label
 * @param {string} url
 * @param {RequestInit & { apiKey?: string, timeoutMs?: number }} init
 * @returns {Promise<{ json: any, res: Response, text: string }>}
 */
async function requestJson(label, url, init) {
  const res = await request(label, url, init)
  const text = await res.text()
  if (text.trim() === '') return { json: {}, res, text }
  try {
    return { json: JSON.parse(text), res, text }
  } catch {
    throw new Error(`${label} returned non-JSON: ${truncateBody(scrubSecrets(text, apiKey))}`)
  }
}

/** First non-empty string among the candidates. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Absolutise a possibly relative media URL against the channel apiUrl.
 * @param {string | undefined} url
 * @param {string | undefined} apiUrl
 * @returns {string | undefined}
 */
function absoluteUrl(url, apiUrl) {
  if (typeof url !== 'string' || url.trim() === '') return undefined
  if (/^https?:\/\//i.test(url)) return url
  if (!apiUrl) return url
  try {
    return new URL(url, `${String(apiUrl).replace(/\/+$/, '')}/`).toString()
  } catch {
    return url
  }
}

/* ------------------------------------------------------------------ *
 * Clamping
 * ------------------------------------------------------------------ */

/**
 * Clamp a requested duration to the protocol's capability envelope.
 * Clamping (not rejecting) is a hard requirement: a storyboard asking for 7s
 * on a 6s-max model must still produce a video.
 *
 * The no-request fallback is the project default pinned into [min, max]: a 5s
 * project default must NOT be forwarded to a model whose floor is 6s.
 *
 * @param {number | undefined} requested
 * @param {number} maxDurationSec
 * @param {number} [minDurationSec]
 * @returns {{ value: number, clamped: boolean, reason?: string }}
 */
function clampDuration(requested, maxDurationSec, minDurationSec = 1) {
  const fallback = Math.max(minDurationSec, Math.min(PROJECT_DEFAULTS.shotSeconds, maxDurationSec))
  const raw = Number(requested)
  if (!Number.isFinite(raw) || raw <= 0) {
    return { value: fallback, clamped: false }
  }
  const rounded = Math.round(raw)
  if (rounded > maxDurationSec) {
    return { value: maxDurationSec, clamped: true, reason: `duration ${rounded}s exceeds max ${maxDurationSec}s` }
  }
  if (rounded < minDurationSec) {
    return { value: minDurationSec, clamped: true, reason: `duration ${rounded}s below min ${minDurationSec}s` }
  }
  return { value: rounded, clamped: false }
}

/**
 * Clamp a requested aspect ratio to the protocol's supported set. On an
 * unsupported value we fall back to the project default when that is
 * supported, else the first supported ratio.
 * @param {string | undefined} requested
 * @param {string[]} supported
 * @returns {{ value: string, clamped: boolean, reason?: string }}
 */
function clampAspect(requested, supported) {
  const list = supported.length > 0 ? supported : [PROJECT_DEFAULTS.aspectRatio]
  const wanted = typeof requested === 'string' ? requested.trim() : ''
  if (wanted !== '' && list.includes(wanted)) {
    return { value: wanted, clamped: false }
  }
  const fallback = list.includes(PROJECT_DEFAULTS.aspectRatio) ? PROJECT_DEFAULTS.aspectRatio : list[0]
  if (wanted === '') return { value: fallback, clamped: false }
  return { value: fallback, clamped: true, reason: `aspect ${wanted} unsupported (have ${list.join(', ')})` }
}

/**
 * Apply both clamps and collect the report placed on `raw.clamped`.
 * @param {{ durationSec?: number, aspectRatio?: string }} req
 * @param {ReturnType<typeof videoCapabilities>} caps
 * @returns {{ durationSec: number, aspectRatio: string, clamped: object | undefined, notes: string[] }}
 */
function applyClamps(req, caps) {
  const minDuration = caps.minDurationSec ?? 1
  const duration = clampDuration(req.durationSec, caps.maxDurationSec, minDuration)
  const aspect = clampAspect(req.aspectRatio, caps.aspectRatios)
  const notes = []
  if (duration.clamped) notes.push(duration.reason)
  if (aspect.clamped) notes.push(aspect.reason)
  return {
    durationSec: duration.value,
    aspectRatio: aspect.value,
    clamped: notes.length > 0
      ? {
        requested: { durationSec: req.durationSec, aspectRatio: req.aspectRatio },
        applied: { durationSec: duration.value, aspectRatio: aspect.value },
        notes,
      }
      : undefined,
    notes,
  }
}

/**
 * Attach `raw.clamped` without clobbering anything the adapter already set.
 * @param {object} result
 * @param {object | undefined} clamped
 * @returns {object}
 */
function withClamp(result, clamped) {
  if (!clamped) return result
  const raw = (result && typeof result.raw === 'object' && result.raw !== null) ? result.raw : {}
  return { ...result, raw: { ...raw, clamped } }
}

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

/**
 * What a protocol can actually do. Used both for clamping and for greying out
 * UI controls, so it must stay honest about first/last-frame support.
 * @param {string} protocol
 * @returns {{ textToVideo: boolean, imageToVideo: boolean, firstLastFrame: boolean,
 *            maxDurationSec: number, minDurationSec: number, aspectRatios: string[] }}
 */
export function videoCapabilities(protocol) {
  switch (protocol) {
    case VIDEO_PROTOCOL.minimax:
      // MiniMax Hailuo-class: text-to-video, image-to-video via first_frame_image,
      // and (on the newer models) last_frame_image. Durations are 6s/10s.
      return {
        textToVideo: true,
        imageToVideo: true,
        firstLastFrame: true,
        minDurationSec: 6,
        maxDurationSec: 10,
        aspectRatios: ['16:9', '9:16', '1:1'],
      }
    case VIDEO_PROTOCOL.seedance:
      // ByteDance Ark / Seedance-class. UNVERIFIED: exact duration grid and the
      // last-frame extension mechanism (commonly the `--ratio`/`--dur` text
      // suffix or a `last_frame_url` content entry) vary per model revision.
      return {
        textToVideo: true,
        imageToVideo: true,
        firstLastFrame: true,
        minDurationSec: 2,
        maxDurationSec: 12,
        aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      }
    case VIDEO_PROTOCOL.openaiCompat:
      // Generic relay: we cannot know the backend, so advertise the widest
      // envelope and let the upstream reject what it does not support.
      return {
        textToVideo: true,
        imageToVideo: true,
        firstLastFrame: true,
        minDurationSec: 1,
        maxDurationSec: 20,
        aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
      }
    case VIDEO_PROTOCOL.promptPack:
      // No model at all: the "duration"/ratio describe the requested shot and
      // are echoed into the prompt bundle, so nothing is really clamped.
      return {
        textToVideo: true,
        imageToVideo: false,
        firstLastFrame: false,
        minDurationSec: 1,
        maxDurationSec: 600,
        aspectRatios: ['9:16', '16:9', '1:1', '3:4', '4:3'],
      }
    default:
      throw badRequest(`Unknown video protocol: ${JSON.stringify(protocol)}`)
  }
}

/* ------------------------------------------------------------------ *
 * prompt-pack adapter (offline fallback)
 * ------------------------------------------------------------------ */

/**
 * The prompt-pack "adapter". It is a real adapter shaped exactly like the
 * network ones, but every method is pure. There is intentionally no apiKey
 * check anywhere in this file's path to it.
 */
const promptPackAdapter = {
  protocol: VIDEO_PROTOCOL.promptPack,
  capabilities: videoCapabilities(VIDEO_PROTOCOL.promptPack),

  /**
   * @param {object} ctx
   * @returns {Promise<{ taskId: string, status: string, raw: object }>}
   */
  async submit(ctx = {}) {
    const prompt = String(ctx.prompt ?? '').trim()
    if (prompt === '') throw badRequest('prompt-pack requires a non-empty prompt')
    // Still honour an already-aborted signal so callers see identical
    // cancellation semantics on every protocol.
    if (ctx.signal?.aborted) throwAbort('The video request was aborted before it started')
    return {
      taskId: 'prompt-pack',
      status: VIDEO_TASK_STATUS.succeeded,
      raw: {
        protocol: VIDEO_PROTOCOL.promptPack,
        networkCalls: 0,
        // The bundle is what the export stage writes to disk / clipboard.
        bundle: {
          prompt,
          durationSec: ctx.durationSec,
          aspectRatio: ctx.aspectRatio,
          negativePrompt: ctx.negativePrompt ?? '',
          firstFrame: ctx.firstFrame ? { kind: 'image', ref: ctx.firstFrame } : null,
          lastFrame: ctx.lastFrame ? { kind: 'image', ref: ctx.lastFrame } : null,
          model: ctx.model ?? '',
          note: '把本提示词与首帧图粘到任意视频模型即可（无 API 密钥时的人工回退）。',
        },
      },
    }
  },

  /**
   * Echoes the synthetic task so the pipeline advances to `succeeded`.
   * @param {object} ctx
   * @returns {Promise<{ status: string, raw: object }>}
   */
  async poll(ctx = {}) {
    if (ctx.signal?.aborted) throwAbort('The video request was aborted by the caller')
    return {
      status: VIDEO_TASK_STATUS.succeeded,
      raw: { protocol: VIDEO_PROTOCOL.promptPack, taskId: ctx.taskId ?? 'prompt-pack', networkCalls: 0 },
    }
  },

  /** No remote bytes exist: always a local file:// ref or a caller error. */
  async fetch() {
    throw badRequest('prompt-pack produces no video bytes; download the prompt bundle instead')
  },
}

/* ------------------------------------------------------------------ *
 * minimax adapter
 * ------------------------------------------------------------------ *
 * Docs (MiniMax open platform, "Video Generation"):
 *   https://platform.minimaxi.com/document/video_generation
 *   https://www.minimax.io/platform/document/video_generation
 *
 * Flow:  POST {apiUrl}/video_generation            -> { task_id }
 *        GET  {apiUrl}/query/video_generation      -> { status, file_id }
 *        GET  {apiUrl}/files/retrieve?id=<file_id> -> { file: { download_url } }
 * Status strings observed across revisions: Queueing | Processing | Success |
 * Fail. We accept the documented ones plus a few tolerated aliases.
 */
const minimaxAdapter = {
  protocol: VIDEO_PROTOCOL.minimax,
  capabilities: videoCapabilities(VIDEO_PROTOCOL.minimax),

  /**
   * @param {object} ctx
   * @returns {Promise<{ taskId: string, status: string, raw: object }>}
   */
  async submit(ctx) {
    const { apiUrl, apiKey, model, prompt, firstFrame, lastFrame, durationSec, aspectRatio, signal } = ctx
    if (!apiKey) throw badRequest('minimax channel has no api key configured')
    const body = { model, prompt }
    // CONFIDENCE high: `first_frame_image` is the documented image-to-video
    // field. It accepts either a public URL or a base64 data URL.
    if (firstFrame) body.first_frame_image = firstFrame
    // CONFIDENCE medium (UNVERIFIED): `last_frame_image` appears in newer
    // MiniMax video models; older ones silently ignore unknown keys, so sending
    // it is safe but not guaranteed to take effect.
    if (lastFrame) body.last_frame_image = lastFrame
    if (durationSec) body.duration = durationSec
    if (aspectRatio) body.aspect_ratio = aspectRatio

    const url = joinUrl(apiUrl, '/video_generation')
    const label = `minimax POST ${url}`
    const { json } = await requestJson(label, url, {
      method: 'POST',
      apiKey,
      signal,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    // MiniMax wraps failures as { base_resp: { status_code, status_msg } }.
    const base = json?.base_resp
    if (base && Number(base.status_code) !== 0) {
      const err = new Error(
        `${label} rejected the task: ${scrubSecrets(String(base.status_msg ?? 'unknown'), apiKey)} ` +
        `(status_code ${base.status_code}, key ${maskKey(apiKey)})`,
      )
      err.name = 'UpstreamError'
      err.status = 200
      err.body = truncateBody(scrubSecrets(JSON.stringify(base), apiKey))
      throw err
    }

    const taskId = firstString(json?.task_id, json?.data?.task_id, json?.id)
    if (!taskId) throw badRequest(`${label} returned no task_id: ${truncateBody(scrubSecrets(JSON.stringify(json), apiKey))}`)
    return { taskId, status: VIDEO_TASK_STATUS.queued, raw: { protocol: this.protocol, response: json } }
  },

  /**
   * @param {object} ctx
   * @returns {Promise<{ status: string, videoUrl?: string, coverUrl?: string, error?: string, raw: object }>}
   */
  async poll(ctx) {
    const { apiUrl, apiKey, taskId, signal } = ctx
    if (!apiKey) throw badRequest('minimax channel has no api key configured')
    const status = await readMinimaxStatus(apiUrl, apiKey, taskId, signal)
    return status
  },

  async fetch(ctx) {
    const { url, signal } = ctx
    return downloadBytes(url, signal)
  },
}

/**
 * Read one MiniMax task status, resolving the file download URL on success.
 * @param {string} apiUrl
 * @param {string} apiKey
 * @param {string} taskId
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ status: string, videoUrl?: string, coverUrl?: string, error?: string, raw: object }>}
 */
async function readMinimaxStatus(apiUrl, apiKey, taskId, signal) {
  const url = `${joinUrl(apiUrl, '/query/video_generation')}?task_id=${encodeURIComponent(taskId)}`
  const label = `minimax GET ${url}`
  const { json } = await requestJson(label, url, {
    method: 'GET',
    apiKey,
    signal,
    headers: { authorization: `Bearer ${apiKey}` },
  })

  const base = json?.base_resp
  if (base && Number(base.status_code) !== 0) {
    const err = new Error(
      `${label} failed: ${scrubSecrets(String(base.status_msg ?? 'unknown'), apiKey)} ` +
      `(status_code ${base.status_code}, key ${maskKey(apiKey)})`,
    )
    err.name = 'UpstreamError'
    err.body = truncateBody(scrubSecrets(JSON.stringify(base), apiKey))
    throw err
  }

  const upstream = String(json?.status ?? json?.data?.status ?? '').trim()
  const normalized = normalizeMinimaxStatus(upstream)

  if (normalized === VIDEO_TASK_STATUS.failed) {
    return {
      status: normalized,
      error: scrubSecrets(String(json?.error_message ?? json?.base_resp?.status_msg ?? `upstream status ${upstream || 'Fail'}`), apiKey),
      raw: { protocol: VIDEO_PROTOCOL.minimax, upstream, response: json },
    }
  }
  if (normalized !== VIDEO_TASK_STATUS.succeeded) {
    return { status: normalized, raw: { protocol: VIDEO_PROTOCOL.minimax, upstream, response: json } }
  }

  // Succeeded: resolve file_id -> download_url.
  const fileId = firstString(json?.file_id, json?.data?.file_id)
  if (!fileId) {
    // Some relays inline the URL directly; accept it rather than failing.
    const inline = firstString(json?.download_url, json?.video_url, json?.data?.download_url)
    if (inline) {
      return {
        status: normalized,
        videoUrl: absoluteUrl(inline, apiUrl),
        raw: { protocol: VIDEO_PROTOCOL.minimax, upstream, response: json },
      }
    }
    throw badRequest(
      `minimax task ${taskId} reported Success but no file_id: ${truncateBody(scrubSecrets(JSON.stringify(json), apiKey))}`,
    )
  }

  const fileUrl = `${joinUrl(apiUrl, '/files/retrieve')}?file_id=${encodeURIComponent(fileId)}`
  const fileLabel = `minimax GET ${fileUrl}`
  const { json: fileJson } = await requestJson(fileLabel, fileUrl, {
    method: 'GET',
    apiKey,
    signal,
    headers: { authorization: `Bearer ${apiKey}` },
  })

  const download = firstString(
    fileJson?.file?.download_url,
    fileJson?.download_url,
    fileJson?.data?.file?.download_url,
  )
  if (!download) {
    throw badRequest(
      `minimax file ${fileId} has no download_url: ${truncateBody(scrubSecrets(JSON.stringify(fileJson), apiKey))}`,
    )
  }

  return {
    status: normalized,
    videoUrl: absoluteUrl(download, apiUrl),
    coverUrl: absoluteUrl(firstString(json?.cover_url, json?.data?.cover_url), apiUrl),
    raw: { protocol: VIDEO_PROTOCOL.minimax, upstream, fileId, response: json, file: fileJson },
  }
}

/**
 * Map MiniMax status text onto VIDEO_TASK_STATUS.
 * CONFIDENCE: `Success` / `Fail` are documented; Queueing/Processing are the
 * in-flight states. Anything unknown is treated as still-running so a novel
 * status string cannot silently mark a paid task failed.
 * @param {string} upstream
 * @returns {string}
 */
function normalizeMinimaxStatus(upstream) {
  const value = upstream.toLowerCase()
  if (value === 'success' || value === 'succeeded' || value === 'completed' || value === 'done') {
    return VIDEO_TASK_STATUS.succeeded
  }
  if (value === 'fail' || value === 'failed' || value === 'error') {
    return VIDEO_TASK_STATUS.failed
  }
  if (value === 'queueing' || value === 'queued' || value === 'preparing' || value === 'waiting') {
    return VIDEO_TASK_STATUS.queued
  }
  return VIDEO_TASK_STATUS.running
}

/* ------------------------------------------------------------------ *
 * seedance adapter
 * ------------------------------------------------------------------ *
 * Docs (火山方舟 / ByteDance Ark, "视频生成" content-generation tasks):
 *   https://www.volcengine.com/docs/82379/1520757
 * Flow:  POST {apiUrl}/contents/generations/tasks  -> { id }
 *        GET  {apiUrl}/contents/generations/tasks/{id}
 *             -> { status: queued|running|succeeded|failed, content: { video_url } }
 * This is the same task API family as Ark's image/video generation, so the
 * poll envelope is uniform.
 */
const seedanceAdapter = {
  protocol: VIDEO_PROTOCOL.seedance,
  capabilities: videoCapabilities(VIDEO_PROTOCOL.seedance),

  async submit(ctx) {
    const { apiUrl, apiKey, model, prompt, firstFrame, lastFrame, durationSec, aspectRatio, signal } = ctx
    if (!apiKey) throw badRequest('seedance channel has no api key configured')

    /** @type {Array<object>} */
    const content = []
    if (typeof prompt === 'string' && prompt.trim() !== '') {
      content.push({ type: 'text', text: prompt })
    }
    // CONFIDENCE high: first frame is an `image_url` content entry.
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
    // CONFIDENCE low (UNVERIFIED): whether last-frame conditioning is a second
    // `image_url` entry with `role: 'last_frame'` or appended into the text as
    // `--last_frame_url …`. We send the structured form (harmless if ignored)
    // and flag it here. Do not rely on last-frame locking without a live test.
    if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' })
    if (content.length === 0) throw badRequest('seedance requires a prompt or a first frame')

    const body = { model, content }
    // CONFIDENCE medium: Ark accepts generation params either as top-level
    // keys or as a `--dur`/`--ratio` suffix inside the text. We send the
    // structured form to avoid mangling the prompt.
    if (durationSec) body.duration = durationSec
    if (aspectRatio) body.ratio = aspectRatio

    const url = joinUrl(apiUrl, '/contents/generations/tasks')
    const label = `seedance POST ${url}`
    const { json } = await requestJson(label, url, {
      method: 'POST',
      apiKey,
      signal,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    const taskId = firstString(json?.id, json?.task_id, json?.data?.id)
    if (!taskId) {
      // Ark reports failures as { error: { code, message } } with HTTP 200 in
      // some gateway deployments — surface it instead of a confusing "no id".
      const upstreamMessage = firstString(json?.error?.message, json?.message, json?.error_msg)
      if (upstreamMessage) {
        const err = new Error(`${label} rejected the task: ${scrubSecrets(upstreamMessage)} (key ${maskKey(apiKey)})`)
        err.name = 'UpstreamError'
        err.body = truncateBody(scrubSecrets(JSON.stringify(json?.error ?? json), apiKey))
        throw err
      }
      throw badRequest(`${label} returned no task id: ${truncateBody(scrubSecrets(JSON.stringify(json), apiKey))}`)
    }
    return { taskId, status: VIDEO_TASK_STATUS.queued, raw: { protocol: this.protocol, response: json } }
  },

  async poll(ctx) {
    const { apiUrl, apiKey, taskId, signal } = ctx
    if (!apiKey) throw badRequest('seedance channel has no api key configured')
    const url = joinUrl(apiUrl, `/contents/generations/tasks/${encodeURIComponent(taskId)}`)
    const label = `seedance GET ${url}`
    const { json } = await requestJson(label, url, {
      method: 'GET',
      apiKey,
      signal,
      headers: { authorization: `Bearer ${apiKey}` },
    })

    const upstream = String(json?.status ?? '').trim().toLowerCase()
    let normalized
    if (upstream === 'succeeded' || upstream === 'success' || upstream === 'completed') {
      normalized = VIDEO_TASK_STATUS.succeeded
    } else if (upstream === 'failed' || upstream === 'fail' || upstream === 'canceled' || upstream === 'cancelled') {
      normalized = VIDEO_TASK_STATUS.failed
    } else if (upstream === 'queued' || upstream === 'pending' || upstream === 'created') {
      normalized = VIDEO_TASK_STATUS.queued
    } else {
      normalized = VIDEO_TASK_STATUS.running
    }

    if (normalized === VIDEO_TASK_STATUS.failed) {
      return {
        status: normalized,
        error: scrubSecrets(firstString(json?.error?.message, json?.error_message, json?.message) ?? `upstream status ${upstream || 'failed'}`, apiKey),
        raw: { protocol: this.protocol, upstream, response: json },
      }
    }
    if (normalized !== VIDEO_TASK_STATUS.succeeded) {
      return { status: normalized, raw: { protocol: this.protocol, upstream, response: json } }
    }

    const videoUrl = firstString(
      json?.content?.video_url,
      json?.content?.download_url,
      json?.video_url,
      json?.download_url,
      json?.data?.video_url,
    )
    if (!videoUrl) {
      throw badRequest(
        `seedance task ${taskId} succeeded without a video url: ${truncateBody(scrubSecrets(JSON.stringify(json), apiKey))}`,
      )
    }
    return {
      status: normalized,
      videoUrl: absoluteUrl(videoUrl, apiUrl),
      coverUrl: absoluteUrl(firstString(json?.content?.cover_url, json?.cover_url), apiUrl),
      raw: { protocol: this.protocol, upstream, response: json },
    }
  },

  async fetch(ctx) {
    return downloadBytes(ctx.url, ctx.signal)
  },
}

/* ------------------------------------------------------------------ *
 * openai-compat adapter
 * ------------------------------------------------------------------ *
 * There is no single official OpenAI video endpoint. Third-party aggregators
 * (the "relay" case this plugin targets) usually copy one of two shapes:
 *   A) OpenAI Sora-style   POST {apiUrl}/videos      -> { id, status }
 *                          GET  {apiUrl}/videos/{id} -> { status, ... }
 *   B) simple sync relay   POST {apiUrl}/video/generations -> { data: [{ url }] }
 * We try A, fall back to B on 404/405, and tolerate an immediate result in
 * either shape. This is the least-standardised adapter — see `uncertainties()`.
 */
const openaiCompatAdapter = {
  protocol: VIDEO_PROTOCOL.openaiCompat,
  capabilities: videoCapabilities(VIDEO_PROTOCOL.openaiCompat),

  async submit(ctx) {
    const { apiUrl, apiKey, model, prompt, firstFrame, durationSec, aspectRatio, signal } = ctx
    if (!apiKey) throw badRequest('openai-compat channel has no api key configured')
    const body = { model, prompt }
    if (firstFrame) body.image = firstFrame
    if (durationSec) body.duration = durationSec
    if (aspectRatio) body.aspect_ratio = aspectRatio

    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    }

    /** @type {{ json: any, url: string, label: string }} */
    let last
    const attempts = ['/videos', '/video/generations']
    let notFound = 0
    for (const path of attempts) {
      const url = joinUrl(apiUrl, path)
      const label = `openai-compat POST ${url}`
      try {
        const { json } = await requestJson(label, url, {
          method: 'POST',
          apiKey,
          signal,
          timeoutMs: SUBMIT_TIMEOUT_MS,
          headers,
          body: JSON.stringify(body),
        })
        last = { json, url, label }
        notFound = 0
        break
      } catch (err) {
        if (isAbort(err)) throw err
        // Only a 404/405 justifies trying the alternate path shape.
        if (err?.status === 404 || err?.status === 405) {
          notFound += 1
          continue
        }
        throw err
      }
    }
    if (!last) {
      throw new Error(
        `openai-compat: neither /videos nor /video/generations exists on this relay ` +
        `(${notFound} routes returned 404/405)`,
      )
    }

    const { json } = last
    const immediate = extractImmediateVideo(json, apiUrl)
    const taskId = firstString(json?.id, json?.task_id, json?.data?.id, json?.data?.[0]?.id)
    if (immediate && !taskId) {
      // Pure synchronous relay: synthesise a task id and return succeeded so
      // poll() is a no-op.
      const synthetic = `sync-${Date.now().toString(36)}`
      return {
        taskId: synthetic,
        status: VIDEO_TASK_STATUS.succeeded,
        raw: {
          protocol: this.protocol,
          endpoint: last.url,
          immediate: true,
          videoUrl: immediate.videoUrl,
          coverUrl: immediate.coverUrl,
          response: json,
        },
      }
    }
    if (!taskId) {
      const upstreamMessage = firstString(json?.error?.message, json?.message, json?.error)
      if (upstreamMessage) {
        const err = new Error(`${last.label} rejected the task: ${scrubSecrets(upstreamMessage)} (key ${maskKey(apiKey)})`)
        err.name = 'UpstreamError'
        throw err
      }
      throw badRequest(`${last.label} returned no task id: ${truncateBody(scrubSecrets(JSON.stringify(json), apiKey))}`)
    }

    return {
      taskId,
      status: normalizeGenericStatus(json?.status) ?? VIDEO_TASK_STATUS.queued,
      raw: {
        protocol: this.protocol,
        endpoint: last.url,
        response: json,
        ...(immediate ? { videoUrl: immediate.videoUrl, coverUrl: immediate.coverUrl } : {}),
      },
    }
  },

  async poll(ctx) {
    const { apiUrl, apiKey, taskId, signal } = ctx
    if (!apiKey) throw badRequest('openai-compat channel has no api key configured')
    if (String(taskId).startsWith('sync-')) {
      // A synchronous relay handed us its result at submit time.
      return {
        status: VIDEO_TASK_STATUS.succeeded,
        raw: { protocol: this.protocol, note: 'synchronous relay result was returned at submit time' },
      }
    }
    const url = joinUrl(apiUrl, `/videos/${encodeURIComponent(taskId)}`)
    const label = `openai-compat GET ${url}`
    const { json } = await requestJson(label, url, {
      method: 'GET',
      apiKey,
      signal,
      headers: { authorization: `Bearer ${apiKey}` },
    })

    const immediate = extractImmediateVideo(json, apiUrl)
    const normalized = normalizeGenericStatus(json?.status ?? (immediate ? 'succeeded' : undefined))
      ?? VIDEO_TASK_STATUS.running

    if (normalized === VIDEO_TASK_STATUS.failed) {
      return {
        status: normalized,
        error: scrubSecrets(firstString(json?.error?.message, json?.error?.code, json?.error, json?.message) ?? 'upstream reported failure', apiKey),
        raw: { protocol: this.protocol, response: json },
      }
    }
    if (normalized === VIDEO_TASK_STATUS.succeeded) {
      const videoUrl = immediate?.videoUrl
        ?? absoluteUrl(firstString(json?.video_url, json?.url, json?.output?.url), apiUrl)
      if (!videoUrl) {
        // Succeeded but no URL yet: report running so the caller keeps polling
        // instead of failing a task the user already paid for.
        return {
          status: VIDEO_TASK_STATUS.running,
          raw: { protocol: this.protocol, note: 'succeeded without a url yet', response: json },
        }
      }
      return {
        status: VIDEO_TASK_STATUS.succeeded,
        videoUrl,
        coverUrl: immediate?.coverUrl ?? absoluteUrl(firstString(json?.cover_url, json?.thumbnail_url), apiUrl),
        raw: { protocol: this.protocol, response: json },
      }
    }
    return { status: normalized, raw: { protocol: this.protocol, response: json } }
  },

  async fetch(ctx) {
    return downloadBytes(ctx.url, ctx.signal)
  },
}

/**
 * Normalise an OpenAI-ish status string.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeGenericStatus(value) {
  if (typeof value !== 'string') return undefined
  switch (value.trim().toLowerCase()) {
    case 'queued':
    case 'pending':
    case 'created':
      return VIDEO_TASK_STATUS.queued
    case 'running':
    case 'in_progress':
    case 'processing':
    case 'generating':
      return VIDEO_TASK_STATUS.running
    case 'succeeded':
    case 'success':
    case 'completed':
    case 'complete':
    case 'done':
      return VIDEO_TASK_STATUS.succeeded
    case 'failed':
    case 'fail':
    case 'error':
    case 'cancelled':
    case 'canceled':
      return VIDEO_TASK_STATUS.failed
    default:
      return undefined
  }
}

/**
 * Detect a `{ data: [{ url }] }` / `{ output: { url } }` style immediate result.
 * @param {any} json
 * @param {string | undefined} apiUrl
 * @returns {{ videoUrl: string, coverUrl?: string } | undefined}
 */
function extractImmediateVideo(json, apiUrl) {
  const candidate = firstString(
    json?.data?.[0]?.url,
    json?.data?.[0]?.video_url,
    json?.data?.url,
    json?.output?.url,
    json?.video?.url,
  )
  if (!candidate) return undefined
  const videoUrl = absoluteUrl(candidate, apiUrl)
  const cover = firstString(json?.data?.[0]?.cover_url, json?.data?.[0]?.thumbnail_url)
  return { videoUrl, ...(cover ? { coverUrl: absoluteUrl(cover, apiUrl) } : {}) }
}

/* ------------------------------------------------------------------ *
 * Byte download
 * ------------------------------------------------------------------ */

/** Extension → mime, for when the server lies (or omits content-type). */
const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * Download a produced asset (video or first-frame image).
 * @param {string} url
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ data: Buffer, mime: string }>}
 */
async function downloadBytes(url, signal) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw badRequest('fetchVideoBytes requires a url')
  }
  // data: URLs are legitimate here (MiniMax accepts base64 frames back).
  const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (dataUrl) {
    const mime = dataUrl[1] || 'application/octet-stream'
    const payload = dataUrl[3] ?? ''
    const data = dataUrl[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8')
    return { data, mime }
  }

  const label = `GET ${url}`
  const res = await request(label, url, { method: 'GET', signal, timeoutMs: FILE_TIMEOUT_MS })
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length === 0) throw new Error(`${label} returned an empty body`)
  const headerMime = String(res.headers.get('content-type') ?? '').split(';')[0].trim()
  const ext = (/\.([a-z0-9]+)(?:\?|#|$)/i.exec(url)?.[1] ?? '').toLowerCase()
  const mime = headerMime !== '' && headerMime !== 'application/octet-stream' && headerMime !== 'binary/octet-stream'
    ? headerMime
    : (MIME_BY_EXT[ext] ?? 'application/octet-stream')
  return { data: buf, mime }
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

/** protocol → adapter. */
export const ADAPTERS = Object.freeze({
  [VIDEO_PROTOCOL.minimax]: minimaxAdapter,
  [VIDEO_PROTOCOL.seedance]: seedanceAdapter,
  [VIDEO_PROTOCOL.openaiCompat]: openaiCompatAdapter,
  [VIDEO_PROTOCOL.promptPack]: promptPackAdapter,
})

/**
 * Look up the adapter for a protocol.
 * @param {string} protocol
 * @returns {{ protocol: string, capabilities: object, submit: Function, poll: Function, fetch: Function }}
 */
export function adapterFor(protocol) {
  const adapter = ADAPTERS[protocol]
  if (!adapter) {
    throw badRequest(
      `Unknown video protocol ${JSON.stringify(protocol)}; known: ${Object.keys(ADAPTERS).join(', ')}`,
    )
  }
  return adapter
}

/**
 * Normalise a caller-supplied channel into the shape adapters expect.
 * @param {object} channel
 * @returns {{ id: string, name: string, protocol: string, apiUrl: string, apiKey: string, model: string }}
 */
function normalizeChannel(channel) {
  if (!channel || typeof channel !== 'object') {
    throw badRequest('submitVideo/pollVideo require a channel object')
  }
  const protocol = channel.protocol ?? VIDEO_PROTOCOL.promptPack
  adapterFor(protocol) // validates the protocol early, with a clear message
  return {
    id: String(channel.id ?? ''),
    name: String(channel.name ?? ''),
    protocol,
    apiUrl: typeof channel.apiUrl === 'string' ? channel.apiUrl.trim() : '',
    apiKey: typeof channel.apiKey === 'string' ? channel.apiKey.trim() : '',
    model: typeof channel.model === 'string' ? channel.model.trim() : '',
  }
}

const PROMPT_PACK_MARKER = 'prompt-pack'

/* ------------------------------------------------------------------ *
 * Public API (what routes.js calls)
 * ------------------------------------------------------------------ */

/**
 * Submit one shot to a channel.
 *
 * @param {{
 *   channel: { id?: string, name?: string, protocol: string, apiUrl?: string, apiKey?: string, model?: string },
 *   prompt: string,
 *   firstFrame?: string,
 *   lastFrame?: string,
 *   durationSec?: number,
 *   aspectRatio?: string,
 *   negativePrompt?: string,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ taskId: string, status: string, raw: object }>}
 */
export async function submitVideo(input) {
  const channel = normalizeChannel(input?.channel)
  const prompt = String(input?.prompt ?? '').trim()
  if (prompt === '') throw badRequest('submitVideo requires a non-empty prompt')

  const adapter = adapterFor(channel.protocol)
  if (channel.protocol !== VIDEO_PROTOCOL.promptPack && !channel.apiKey) {
    throw badRequest(`Channel "${channel.name || channel.id}" (${channel.protocol}) has no api key configured`)
  }
  if (channel.protocol !== VIDEO_PROTOCOL.promptPack && !channel.apiUrl) {
    throw badRequest(`Channel "${channel.name || channel.id}" (${channel.protocol}) has no apiUrl configured`)
  }

  const clamp = applyClamps(
    { durationSec: input?.durationSec, aspectRatio: input?.aspectRatio },
    adapter.capabilities,
  )

  const ctx = {
    apiUrl: channel.apiUrl,
    apiKey: channel.apiKey,
    model: channel.model,
    prompt,
    negativePrompt: input?.negativePrompt,
    firstFrame: input?.firstFrame,
    lastFrame: input?.lastFrame,
    durationSec: clamp.durationSec,
    aspectRatio: clamp.aspectRatio,
    signal: input?.signal,
  }

  const result = await adapter.submit(ctx)
  return withClamp(
    {
      taskId: result.taskId,
      status: result.status,
      raw: { ...(result.raw ?? {}), protocol: channel.protocol, model: channel.model },
    },
    clamp.clamped,
  )
}

/**
 * Poll one task. For prompt-pack this is a pure echo (no network).
 *
 * @param {{
 *   channel: { id?: string, name?: string, protocol: string, apiUrl?: string, apiKey?: string, model?: string },
 *   taskId: string,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ status: string, videoUrl?: string, coverUrl?: string, error?: string, raw: object }>}
 */
export async function pollVideo(input) {
  const channel = normalizeChannel(input?.channel)
  const taskId = String(input?.taskId ?? '').trim()
  if (taskId === '') throw badRequest('pollVideo requires a taskId')

  const adapter = adapterFor(channel.protocol)
  const result = await adapter.poll({
    apiUrl: channel.apiUrl,
    apiKey: channel.apiKey,
    model: channel.model,
    taskId,
    signal: input?.signal,
  })

  const out = {
    status: result.status,
    raw: { ...(result.raw ?? {}), protocol: channel.protocol },
  }
  if (result.videoUrl) out.videoUrl = result.videoUrl
  if (result.coverUrl) out.coverUrl = result.coverUrl
  if (result.error) out.error = result.error
  return out
}

/**
 * Download produced bytes. The video URL usually points at the upstream CDN,
 * but a prompt-pack task may point at a local asset URL served by routes.js —
 * both go through the same code path.
 *
 * @param {{ url: string, signal?: AbortSignal }} input
 * @returns {Promise<{ data: Buffer, mime: string }>}
 */
export async function fetchVideoBytes(input) {
  return downloadBytes(input?.url, input?.signal)
}

/* ------------------------------------------------------------------ *
 * Channel presets
 * ------------------------------------------------------------------ */

/**
 * Ready-to-fill channel presets shown in the settings card. `hint` is the
 * zh-CN advice string; `models` are placeholder model ids the user must
 * replace with whatever their aggregator actually advertises.
 *
 * NOTE: model ids here are COMMON NAMES, not a guarantee. The plugin must let
 * the user type any model id, because third-party aggregators rename models.
 *
 * @returns {Array<{ id: string, name: string, protocol: string, apiUrl: string, hint: string, models: string[] }>}
 */
export function videoChannelPresets() {
  return [
    {
      id: 'minimax-hailuo-intl',
      name: 'MiniMax Hailuo（国际站）',
      protocol: VIDEO_PROTOCOL.minimax,
      apiUrl: 'https://api.minimax.io/v1',
      hint: 'MiniMax 原生协议：POST /video_generation，轮询 /query/video_generation，成功后用 /files/retrieve 换下载地址。密钥是 MiniMax 的 API Key（JWT 或 group 密钥按官方要求填）。',
      models: ['MiniMax-Hailuo-02', 'video-01'],
    },
    {
      id: 'minimax-hailuo-cn',
      name: 'MiniMax Hailuo（国内站）',
      protocol: VIDEO_PROTOCOL.minimax,
      apiUrl: 'https://api.minimaxi.com/v1',
      hint: '与国内站同协议，只是域名不同（api.minimaxi.com）。若你用的是第三方聚合站，请把 apiUrl 改成聚合站的 /v1 地址。',
      models: ['MiniMax-Hailuo-02', 'video-01'],
    },
    {
      id: 'seedance-ark',
      name: 'Seedance / 火山方舟',
      protocol: VIDEO_PROTOCOL.seedance,
      apiUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      hint: '方舟内容生成任务协议：POST /contents/generations/tasks，轮询 /contents/generations/tasks/{id}。model 要填方舟的接入点 ID（ep-…）或模型名。',
      models: ['doubao-seedance-1-0-pro-250528', 'doubao-seedance-2-5'],
    },
    {
      id: 'openai-compat-relay',
      name: '通用 OpenAI 兼容聚合站（视频）',
      protocol: VIDEO_PROTOCOL.openaiCompat,
      apiUrl: 'https://your-aggregator.example.com/v1',
      hint: '先试 POST /videos（Sora 风格），404 时自动回退 /video/generations。聚合站之间的字段差异最大，跑通后请把真实模型名填进 model。',
      models: ['veo-3', 'sora-2', 'kling-v2'],
    },
    {
      id: 'prompt-pack',
      name: '仅提示词包（无密钥回退）',
      protocol: VIDEO_PROTOCOL.promptPack,
      apiUrl: '',
      hint: '完全不联网、不需要密钥：把逐镜提示词 + 首帧图打包导出，你自己粘到任意视频模型里生成。这是没有视频额度时也能跑完全流程的兜底方案。',
      models: [],
    },
  ]
}

/* ------------------------------------------------------------------ *
 * Honest uncertainty log
 * ------------------------------------------------------------------ */

/**
 * Machine-readable list of the places where a real upstream protocol could not
 * be confirmed from a live doc page in this environment. The UI/dev tooling can
 * surface these instead of pretending the integration is fully verified.
 * @returns {Array<{ protocol: string, field: string, confidence: 'high'|'medium'|'low', note: string }>}
 */
export function uncertainties() {
  return [
    {
      protocol: VIDEO_PROTOCOL.minimax,
      field: 'endpoints / status strings',
      confidence: 'high',
      note: 'POST /video_generation, GET /query/video_generation?task_id=, GET /files/retrieve?file_id= with Success/Fail are the long-standing MiniMax shape.',
    },
    {
      protocol: VIDEO_PROTOCOL.minimax,
      field: 'last_frame_image',
      confidence: 'low',
      note: 'Last-frame conditioning exists on some newer Hailuo models only. If the model ignores it, the clip will drift from the requested end state — verify before relying on it.',
    },
    {
      protocol: VIDEO_PROTOCOL.minimax,
      field: 'duration / aspect_ratio request fields',
      confidence: 'medium',
      note: 'Older video-01 models take neither and silently ignore them; durations are usually 6s/10s.',
    },
    {
      protocol: VIDEO_PROTOCOL.seedance,
      field: 'last-frame conditioning',
      confidence: 'low',
      note: 'Sent as a second image_url content entry with role:"last_frame". Ark may instead expect a --last_frame_url text suffix, or may not support it at all for a given model revision.',
    },
    {
      protocol: VIDEO_PROTOCOL.seedance,
      field: 'duration / ratio param placement',
      confidence: 'medium',
      note: 'Sent as top-level `duration` and `ratio`. Some models want `--dur n --ratio 16:9` appended to the text prompt instead.',
    },
    {
      protocol: VIDEO_PROTOCOL.seedance,
      field: 'permission / watermark keys',
      confidence: 'low',
      note: 'Not sent. Some Ark video models require an explicit watermark/permission field; if the API rejects the body, add it per the model doc.',
    },
    {
      protocol: VIDEO_PROTOCOL.openaiCompat,
      field: 'endpoint path',
      confidence: 'low',
      note: 'There is no official OpenAI video endpoint. We probe /videos then /video/generations. Aggregators often invent their own path — if both 404, set apiUrl to the relay base that the vendor documents.',
    },
    {
      protocol: VIDEO_PROTOCOL.openaiCompat,
      field: 'response envelope',
      confidence: 'low',
      note: 'We tolerate {id,status}, {data:[{url}]}, {output:{url}} and {video:{url}}. Any other shape will be reported as an error with the truncated body so you can adapt it.',
    },
    {
      protocol: VIDEO_PROTOCOL.promptPack,
      field: 'whole protocol',
      confidence: 'high',
      note: 'Not an upstream protocol at all — it is our own local fallback and is fully verified by docs/verify-video.mjs.',
    },
  ]
}
