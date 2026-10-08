/**
 * dsh-aidrama — shared protocol contract (FROZEN).
 *
 * Every host module and the browser half import their type/enum/constant
 * surface from here. This file is pure data: no imports, no side effects, so
 * both halves load it without pulling the host runtime into the browser.
 *
 * FROZEN means: add new members freely (append-only), never rename or remove an
 * existing one without updating `protocol.d.ts` in the same commit.
 */

/** Stable cordis plugin name (matches package.json name). */
export const PLUGIN_ID = 'aidrama'

/** Settings namespace rendered by the settings card. */
export const AIDRAMA_SETTINGS_NAMESPACE = 'aidrama'

/** Loopback-only route prefixes served by the host half. */
export const AIDRAMA_API = {
  /** Project CRUD + stage advancement. */
  project: '/api/dsh-aidrama/project',
  /** List / create / delete projects. */
  projects: '/api/dsh-aidrama/projects',
  /** Per-stage generation (image / text / video prompt pack). */
  stage: '/api/dsh-aidrama/stage',
  /** Asset (image / video) byte serving. */
  asset: '/api/dsh-aidrama/asset',
  /** Video generation task control. */
  video: '/api/dsh-aidrama/video',
  /** Settings bridge (mirrors the imagegen wire shape). */
  settings: '/api/dsh-aidrama/settings',
  /** Read the effective config (channels, defaults). */
  config: '/api/dsh-aidrama/config',
  /** Export the whole project (JSON / markdown script / prompt pack). */
  export: '/api/dsh-aidrama/export',
  /** Image-model discovery against a channel (reuses imagegen when present). */
  imageModels: '/api/dsh-aidrama/image-models',
}

/**
 * The six production stages, in canonical order. The stage engine advances
 * strictly left→right; a stage may be re-run without invalidating later ones
 * (the workbench marks dependents stale instead of deleting them).
 */
export const STAGES = [
  'idea',
  'story',
  'script',
  'bible',
  'visual',
  'video',
]

/** Human-facing stage metadata (zh-CN labels; the UI ships the same table). */
export const STAGE_META = {
  idea: {
    id: 'idea',
    label: '想法梳理',
    short: '想法',
    description: '把一个模糊的念头问清楚：题材、主角、冲突、爽点、结局走向。',
  },
  story: {
    id: 'story',
    label: '剧情设计',
    short: '剧情',
    description: '三幕结构、人物关系、分集切分与每集钩子。',
  },
  script: {
    id: 'script',
    label: '分场脚本',
    short: '脚本',
    description: '场次表、场景、时间、人物、动作、对白、预估时长。',
  },
  bible: {
    id: 'bible',
    label: '设定集',
    short: '设定',
    description: '人物卡（外观/性格/服装）与场景卡（环境/光线/氛围）。',
  },
  visual: {
    id: 'visual',
    label: '视觉资产',
    short: '视觉',
    description: '人物三视图、场景主图、逐镜分镜参考图。',
  },
  video: {
    id: 'video',
    label: '视频成片',
    short: '视频',
    description: '逐镜视频提示词、首帧图、视频生成与导出。',
  },
}

/** Stage lifecycle status. */
export const STAGE_STATUS = {
  /** No content yet. */
  empty: 'empty',
  /** Content exists but a dependency changed afterwards. */
  stale: 'stale',
  /** Content produced and current. */
  ready: 'ready',
  /** A generation is in flight. */
  running: 'running',
  /** Generation ended in an error. */
  failed: 'failed',
}

/** Asset kinds a project can own. */
export const ASSET_KIND = {
  /** Character model sheet (三视图). */
  characterSheet: 'character-sheet',
  /** Scene establishing image (场景主图). */
  sceneMaster: 'scene-master',
  /** Per-shot storyboard reference (分镜参考图). */
  shotRef: 'shot-ref',
  /** Per-shot video first frame (首帧). */
  firstFrame: 'first-frame',
  /** Generated video clip. */
  video: 'video',
}

/** Who produced a piece of content (rendered as a badge in the workbench). */
export const ORIGIN = {
  /** Written by the conversational model through an Agent tool. */
  agent: 'agent',
  /** Typed or edited by the human in the workbench. */
  human: 'human',
  /** Produced by an image model. */
  imageModel: 'image-model',
  /** Produced by a video model. */
  videoModel: 'video-model',
  /** Imported from a template or preset. */
  preset: 'preset',
}

/**
 * Video provider protocols the adapter layer understands. `prompt-pack` is the
 * always-available fallback: it emits a copy-ready prompt bundle and never
 * calls a network endpoint, so the pipeline completes with no video key.
 */
export const VIDEO_PROTOCOL = {
  /** MiniMax Hailuo native `/v1/video_generation`. */
  minimax: 'minimax',
  /** ByteDance Ark / Seedance `contents/generations/tasks`. */
  seedance: 'seedance',
  /** Any OpenAI-compatible relay exposing a video endpoint. */
  openaiCompat: 'openai-compat',
  /** No network: export prompts + first frames only. */
  promptPack: 'prompt-pack',
}

/** Video task lifecycle (matches the upstream polling states). */
export const VIDEO_TASK_STATUS = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
}

/** Aspect ratios the storyboard stage may request. */
export const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '3:4', '4:3']

/** Default project shape values (a fresh project copies this). */
export const PROJECT_DEFAULTS = {
  aspectRatio: '9:16',
  /** Target episode count for the story stage. */
  episodes: 1,
  /** Per-shot nominal duration in seconds (video models charge by second). */
  shotSeconds: 5,
  /** Visual style DNA prepended to every image prompt. */
  styleDna: '3D 国漫，电影级柔和轮廓光，统一 85mm 焦距，细腻皮肤质感，无畸变',
}

/** Schema version of the persisted project document (bump on breaking change). */
export const PROJECT_SCHEMA_VERSION = 1

/** Cap on one JSON request body (project saves carry base64-free metadata). */
export const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024

/** Cap on one uploaded image body. */
export const MAX_IMAGE_BODY_BYTES = 32 * 1024 * 1024

/** Cap on one project's asset count (guards a runaway generation loop). */
export const MAX_ASSETS_PER_PROJECT = 600

/** Stage ids that require an image model. */
export const IMAGE_STAGES = ['visual']

/** Stage ids that are pure text (driven by the conversational model). */
export const TEXT_STAGES = ['idea', 'story', 'script', 'bible']

/**
 * Build a fresh, valid project document.
 * @param {{ title?: string, logline?: string }} [input]
 * @returns {object} a project ready to persist.
 */
export function createProject(input = {}) {
  const now = Date.now()
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: '',
    title: (input.title ?? '').trim() || '未命名短剧',
    logline: (input.logline ?? '').trim(),
    aspectRatio: PROJECT_DEFAULTS.aspectRatio,
    episodes: PROJECT_DEFAULTS.episodes,
    shotSeconds: PROJECT_DEFAULTS.shotSeconds,
    styleDna: PROJECT_DEFAULTS.styleDna,
    createdAt: now,
    updatedAt: now,
    /** stage id → { status, revision, updatedAt, note } */
    stages: Object.fromEntries(STAGES.map(id => [id, {
      status: STAGE_STATUS.empty,
      revision: 0,
      updatedAt: 0,
      note: '',
    }])),
    /** Free-form stage payloads, keyed by stage id. Shape is stage-specific. */
    content: Object.fromEntries(STAGES.map(id => [id, null])),
    /** Every produced asset, newest last. */
    assets: [],
    /** Video generation tasks, newest last. */
    videoTasks: [],
  }
}

/**
 * Whether `value` is a known stage id.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isStageId(value) {
  return typeof value === 'string' && STAGES.includes(value)
}

/**
 * The stage that follows `id`, or undefined at the end of the pipeline.
 * @param {string} id
 * @returns {string | undefined}
 */
export function nextStage(id) {
  const index = STAGES.indexOf(id)
  return index < 0 || index === STAGES.length - 1 ? undefined : STAGES[index + 1]
}

/**
 * Every stage strictly after `id` (the ones a re-run invalidates).
 * @param {string} id
 * @returns {string[]}
 */
export function stagesAfter(id) {
  const index = STAGES.indexOf(id)
  return index < 0 ? [] : STAGES.slice(index + 1)
}

/**
 * Outline identifier helper: `shot-<seq>` / `char-<slug>` / `scene-<slug>`.
 * Kept here so host and browser mint identical ids.
 * @param {string} prefix
 * @param {string | number} key
 * @returns {string}
 */
export function outlineId(prefix, key) {
  const slug = String(key)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return `${prefix}-${slug === '' ? 'x' : slug}`
}
