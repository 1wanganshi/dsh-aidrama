/**
 * dsh-aidrama — host half.
 *
 * Mounts:
 *  - the plugin's own settings section (image + video channels, defaults),
 *  - the `/api/dsh-aidrama/*` route family (loopback-only),
 *  - a system-prompt announcement describing the pipeline to the conversational
 *    model, which is what actually writes 想法 / 剧情 / 脚本 / 设定,
 *  - Agent tools the conversational model uses to drive a project forward.
 *
 * Design note — why the text stages are NOT implemented here: the user chose to
 * reuse the current session model rather than configure a second LLM endpoint.
 * So this plugin never calls an LLM. It owns persistence, the stage state
 * machine, prompt construction, image generation and video submission; the
 * *writing* is done by the conversation, steered by the briefs in prompts.js and
 * committed back through `stage --action commit`.
 *
 * Both the Agent tools and the browser half talk to the SAME HTTP route family.
 * There is exactly one implementation of every operation, so an Agent and the
 * workbench can never disagree about what a commit or a generation batch does.
 *
 * The browser half loads from the `dsh.client` field of package.json
 * (exports "./client" → lib/client.js, served at /plugins/aidrama/client.js).
 */

import z from '@deepseek-ai/schemastery'

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  PLUGIN_ID,
  AIDRAMA_SETTINGS_NAMESPACE,
  AIDRAMA_API,
  STAGES,
  STAGE_META,
  STAGE_STATUS,
  PROJECT_DEFAULTS,
  VIDEO_PROTOCOL,
  createProject,
} from './host/protocol.js'

import * as store from './host/store.js'
import * as stages from './host/stages.js'
import * as prompts from './host/prompts.js'
import * as video from './host/video.js'
import { makeAidramaRoutes } from './host/routes.js'

/** Stable cordis plugin name. */
export const name = PLUGIN_ID

/** Services required before the surfaces can mount. */
export const inject = ['webServer', 'systemPrompt']

/**
 * Service aliases this plugin will borrow an image client from, in order.
 *
 * dsh-imagegen does NOT register a Cordis service: its `inject` is
 * ["webServer","systemPrompt","commands"] and it never calls
 * `provide('imagegen')` — `generateImage` is only a module EXPORT. A module
 * export is not reachable through `ctx.get`, so the original single lookup for
 * 'imagegen' could never resolve and the borrow path was dead code. Every
 * visual generation therefore fell through to this plugin's own channels, which
 * a user who only configured dsh-imagegen had never filled in.
 *
 * Both spellings are tried so this keeps working if imagegen later publishes a
 * real service under either name.
 */
const IMAGE_SERVICE_ALIASES = ['imagegen', 'dsh-imagegen', 'image-generation']

/**
 * Locate dsh-imagegen's host entry across every installed profile.
 *
 * Anchoring at ~/.dsh/profiles is wrong — node_modules lives one level deeper,
 * at ~/.dsh/profiles/<profile>. Any profile that has the package wins.
 *
 * @returns {string|undefined} absolute path to the entry module
 */
function resolveImagegenEntry() {
  const root = path.join(homedir(), '.dsh', 'profiles')
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch { /* no profiles dir: fall through to the standalone case */ }

  for (const name of names) {
    const anchor = path.join(root, name)
    try {
      const requireFromProfile = createRequire(path.join(anchor, 'noop.js'))
      const pkg = requireFromProfile.resolve('@dickpy/dsh-imagegen/package.json')
      const file = path.join(path.dirname(pkg), 'lib', 'index.js')
      if (existsSync(file)) return file
    } catch { /* this profile does not have it; try the next */ }
  }
  return undefined
}

/**
 * Memoized outcome of importing dsh-imagegen's module exports.
 *
 * `value` holds a PROMISE once resolved, so repeated generations reuse one
 * import. Import failures are cached too — a missing optional peer must not
 * make every generation retry (and re-log) the resolution.
 */
const imageClientState = { tried: false, value: undefined }

/** Model-facing announcement order, inside the tool-guidance band. */
const SECTION_ORDER = 152

/**
 * One configured image channel. Mirrors the shape dsh-imagegen uses, so the two
 * plugins' settings cards look and behave the same.
 */
const channelSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  apiUrl: z.string().default(''),
  protocol: z.union([z.const('auto'), z.const('images'), z.const('chat-completions')]).default('auto'),
  models: z.array(z.object({
    alias: z.string(),
    id: z.string().default(''),
  })).default([]),
})

/** One configured video channel (a third-party aggregator, presumably). */
const videoChannelSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  protocol: z.union([
    z.const(VIDEO_PROTOCOL.minimax),
    z.const(VIDEO_PROTOCOL.seedance),
    z.const(VIDEO_PROTOCOL.openaiCompat),
    z.const(VIDEO_PROTOCOL.promptPack),
  ]).default(VIDEO_PROTOCOL.promptPack),
  apiUrl: z.string().default(''),
  model: z.string().default(''),
})

/**
 * Plugin config, validated by the same-named schemastery schema.
 *
 * Every field is `.volatile()` so the host renders it in this plugin's settings
 * panel and hands the value over as a live reference; a write re-reads through
 * `resolve()`, so edits apply with no restart.
 *
 * API keys live in the secret dictionaries (`channelSecrets`,
 * `videoChannelSecrets`) rather than inside the channel objects: settings path
 * ops cannot reach inside arrays, so a whole-array write must never carry a
 * secret it would clobber.
 */
const configSchema = z.object({
  enabled: z.boolean().default(true).volatile(),
  announceToAgent: z.boolean().default(true).volatile(),
  allowAgentGeneration: z.boolean().default(true).volatile(),
  channels: z.array(channelSchema).default([]).volatile(),
  channelSecrets: z.dict(z.string().role('secret')).default({}).volatile(),
  defaultChannelId: z.string().default('').volatile(),
  defaultModel: z.string().default('').volatile(),
  videoChannels: z.array(videoChannelSchema).default([]).volatile(),
  videoChannelSecrets: z.dict(z.string().role('secret')).default({}).volatile(),
  defaultVideoChannelId: z.string().default('').volatile(),
  styleDna: z.string().default(PROJECT_DEFAULTS.styleDna).volatile(),
  aspectRatio: z.string().default(PROJECT_DEFAULTS.aspectRatio).volatile(),
  shotSeconds: z.number().default(PROJECT_DEFAULTS.shotSeconds).volatile(),
  localStoragePath: z.string().default('').volatile(),
})

export const Config = configSchema

/** Read a value that may be a volatile config reference. */
function unwrapVolatileValue(value) {
  if (typeof value === 'object' && value !== null && typeof value.get === 'function') {
    return value.get()
  }
  return value
}

/** Detach the plain config view from the loader's top-level volatile fields. */
function unwrapConfig(value) {
  if (typeof value !== 'object' || value === null) return {}
  const out = {}
  for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field)
  return out
}

/** Human-readable text from an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Normalize the raw image-channel array off the settings document. */
function normalizeChannels(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '') continue
    const models = []
    if (Array.isArray(item.models)) {
      for (const model of item.models) {
        if (model === null || typeof model !== 'object') continue
        const alias = typeof model.alias === 'string' ? model.alias.trim() : ''
        if (alias === '') continue
        const upstream = typeof model.id === 'string' ? model.id.trim() : ''
        models.push({ alias, id: upstream === '' ? alias : upstream })
      }
    }
    out.push({
      id,
      name: typeof item.name === 'string' ? item.name.trim() : '',
      apiUrl: typeof item.apiUrl === 'string' ? item.apiUrl.trim() : '',
      apiKey: '',
      protocol: typeof item.protocol === 'string' ? item.protocol : 'auto',
      models,
    })
  }
  return out
}

/** Normalize the raw video-channel array off the settings document. */
function normalizeVideoChannels(value) {
  if (!Array.isArray(value)) return []
  const known = new Set(Object.values(VIDEO_PROTOCOL))
  const out = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '') continue
    out.push({
      id,
      name: typeof item.name === 'string' ? item.name.trim() : '',
      apiUrl: typeof item.apiUrl === 'string' ? item.apiUrl.trim() : '',
      apiKey: '',
      protocol: typeof item.protocol === 'string' && known.has(item.protocol)
        ? item.protocol
        : VIDEO_PROTOCOL.promptPack,
      model: typeof item.model === 'string' ? item.model.trim() : '',
    })
  }
  return out
}

/**
 * Build the model-facing announcement.
 *
 * This text is the contract between the plugin and the conversational model:
 * the model writes the text stages, and it can only do that if it knows the
 * pipeline, the JSON shape it must return, and which tool commits the result.
 * @param {object} value - resolved config (channel availability reported live).
 * @returns {string}
 */
function guidanceFor(value) {
  const imageChannels = value.channels.length === 0
    ? '尚未配置图像渠道'
    : value.channels.map(channel => {
      const models = channel.models.map(model => model.alias).join('、') || '未配置模型'
      const mark = channel.id === value.defaultChannelId ? '（默认）' : ''
      return `「${channel.name || channel.id}」${mark} 模型：${models}`
    }).join('；')
  const videoChannels = value.videoChannels.length === 0
    ? '尚未配置视频渠道（视频阶段仍可用「导出提示词包」完成）'
    : value.videoChannels.map(channel => {
      const mark = channel.id === value.defaultVideoChannelId ? '（默认）' : ''
      return `「${channel.name || channel.id}」${mark} 协议：${channel.protocol}`
    }).join('；')
  const stageList = STAGES.map(id => `${STAGE_META[id].label}(${id})`).join(' → ')
  return [
    '本机已安装 dsh-aidrama 插件（AI 短剧工作台），侧边栏有独立工作台入口。',
    `六个阶段：${stageList}。`,
    '分工：第 1-4 阶段（想法/剧情/脚本/设定）由你（会话模型）撰写，插件负责存储与校验，不调用外部 LLM；第 5 阶段（视觉资产：人物三视图、场景主图、分镜参考图）由插件调用图像渠道生成；第 6 阶段（视频）由插件调用视频渠道生成，未配置渠道时导出提示词包。',
    `当前图像渠道：${imageChannels}。`,
    `当前视频渠道：${videoChannels}。`,
    `默认画幅 ${value.aspectRatio}，单镜 ${value.shotSeconds} 秒，风格 DNA：${value.styleDna}。`,
    '工作方式：用 aidrama_brief 读取某个阶段的任务说明与目标 JSON 结构 → 你按该结构写出内容 → 用 aidrama_commit_stage 提交（会自动校验并推进阶段）。不要跳过阶段；用户已经明确要求直接出图时可以先提交设定集再生成。',
    '用户提到「短剧 / 剧本 / 分镜 / 三视图 / 设定集 / 参考图 / 视频」时即指本插件。',
  ].join(' ')
}

/**
 * Register the Agent-facing tools.
 *
 * Deliberately small: four tools that map onto the stage engine, rather than one
 * tool per stage. The model reads a brief, writes, commits, and — when the user
 * asks — starts a generation.
 * @param {object} ctx - the injected context carrying `tools`.
 * @param {object} deps - route callers and the config resolver.
 * @returns {() => void} a disposer that unregisters every tool.
 */
function registerAgentTools(ctx, deps) {
  const disposers = []
  const text = value => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  disposers.push(ctx.tools.register({
    name: 'aidrama_projects',
    description: '列出、创建、查看或删除 AI 短剧项目。action=list/create/get/delete。创建后可获得 projectId，其余工具都需要它。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'get', 'delete'], description: '要执行的操作' },
        id: { type: 'string', description: '项目 id（get/delete 必填）' },
        title: { type: 'string', description: '项目标题（create 可选）' },
        logline: { type: 'string', description: '一句话故事（create 可选）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value) },
    execute: async args => await deps.callProjects(args ?? {}),
  }))

  disposers.push(ctx.tools.register({
    name: 'aidrama_brief',
    description: '读取某个短剧阶段的任务说明与需要你返回的 JSON 结构。写内容之前必须先调用它，否则结构会对不上。stage 取 idea/story/script/bible。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        stage: { type: 'string', enum: ['idea', 'story', 'script', 'bible'], description: '阶段 id' },
      },
      required: ['projectId', 'stage'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value) },
    execute: async args => await deps.callStage({
      projectId: args?.projectId,
      stage: args?.stage,
      action: 'brief',
    }),
  }))

  disposers.push(ctx.tools.register({
    name: 'aidrama_commit_stage',
    description: '提交某个文本阶段（idea/story/script/bible）的成果，插件会校验结构、标记该阶段完成并推进到下一阶段。必须先用 aidrama_brief 拿到结构。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        stage: { type: 'string', enum: ['idea', 'story', 'script', 'bible'], description: '阶段 id' },
        content: { type: 'object', additionalProperties: true, description: '按 brief 的 schema 写好的 JSON 对象' },
        note: { type: 'string', description: '可选备注，例如本阶段的创作取舍' },
      },
      required: ['projectId', 'stage', 'content'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value) },
    execute: async args => await deps.callStage({
      projectId: args?.projectId,
      stage: args?.stage,
      action: 'commit',
      payload: args?.content,
      note: args?.note,
    }),
  }))

  disposers.push(ctx.tools.register({
    name: 'aidrama_generate',
    description: '为短剧项目生成视觉资产或视频。stage 取 visual 时按人物/场景/镜头生成三视图、场景主图与分镜参考图；stage 取 video 时按镜头提交视频任务，未配置视频渠道则返回提示词包。',
    parameters: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: '项目 id' },
        stage: { type: 'string', enum: ['visual', 'video'], description: '要生成的阶段' },
        targets: {
          type: 'array',
          description: 'visual 阶段可选：指定要生成的对象；留空表示按设定集与脚本全量生成',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: 'character-sheet / scene-master / shot-ref' },
              ref: { type: 'string', description: '人物 id、场景 id 或镜头 ref' },
            },
            required: ['kind', 'ref'],
            additionalProperties: true,
          },
        },
        shotRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'video 阶段要提交的镜头 ref 列表；留空表示全部',
        },
      },
      required: ['projectId', 'stage'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => text(value) },
    execute: async args => {
      if (args?.stage === 'video') {
        return await deps.callVideo({ projectId: args?.projectId, action: 'submit', shotRefs: args?.shotRefs })
      }
      return await deps.callStage({
        projectId: args?.projectId,
        stage: 'visual',
        action: 'generate',
        payload: { targets: args?.targets },
      })
    },
  }))

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch { /* already gone */ }
    }
  }
}

/**
 * Drive one route handler as a plain function call.
 *
 * The Agent tools reuse the HTTP handlers instead of duplicating their logic, so
 * this synthesises the request/response pair the handler expects and resolves
 * with the JSON envelope it wrote. Guard failures (403/405) surface as
 * `{ ok: false }` with their status, never as a thrown error.
 * @param {{ path: string, handler: Function }} route
 * @param {unknown} body
 * @returns {Promise<object>}
 */
function callRouteAsFunction(route, body) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let status = 200
    const req = {
      method: 'POST',
      url: route.path,
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body ?? {}), 'utf8')
      },
    }
    const res = {
      writeHead(code) { status = code; return res },
      setHeader() { return res },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        }
        const raw = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = raw === '' ? {} : JSON.parse(raw)
        } catch {
          parsed = { ok: false, code: 'bad-response', message: `宿主返回了非 JSON 响应（状态 ${status}）` }
        }
        if (parsed !== null && typeof parsed === 'object') resolve(parsed)
        else resolve({ ok: status < 400, value: parsed })
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

/**
 * Mount the plugin.
 * @param {object} ctx - host plugin context carrying webServer/systemPrompt.
 * @param {object} [config] - resolved plugin config (defaults applied by the loader).
 * @returns {() => void} the disposer.
 */
export function apply(ctx, config) {
  // The live source the surfaces read: the settings section once the settings
  // service is attached, the composition entry otherwise.
  let current = () => config ?? {}

  /** Resolve the effective configuration (defaults + secrets folded in). */
  const resolve = () => {
    const value = unwrapConfig(current())

    // The data root follows the setting when set. Resolved per access so a
    // settings edit takes effect on the next write, exactly like the channels.
    const configuredRoot = typeof value.localStoragePath === 'string' ? value.localStoragePath.trim() : ''
    if (configuredRoot !== '') store.setDataRoot(configuredRoot)

    const channels = normalizeChannels(value.channels)
    const secrets = { ...(value.channelSecrets ?? {}) }
    for (const channel of channels) {
      channel.apiKey = typeof secrets[channel.id] === 'string' ? secrets[channel.id] : ''
    }
    const videoChannels = normalizeVideoChannels(value.videoChannels)
    const videoSecrets = { ...(value.videoChannelSecrets ?? {}) }
    for (const channel of videoChannels) {
      channel.apiKey = typeof videoSecrets[channel.id] === 'string' ? videoSecrets[channel.id] : ''
    }

    const defaultChannelId = channels.some(channel => channel.id === value.defaultChannelId)
      ? String(value.defaultChannelId)
      : (channels[0]?.id ?? '')
    const aliases = [...new Set(channels.flatMap(channel => channel.models.map(model => model.alias)))]
    const defaultModel = typeof value.defaultModel === 'string' && aliases.includes(value.defaultModel.trim())
      ? value.defaultModel.trim()
      : (aliases[0] ?? '')
    const defaultVideoChannelId = videoChannels.some(channel => channel.id === value.defaultVideoChannelId)
      ? String(value.defaultVideoChannelId)
      : (videoChannels[0]?.id ?? '')
    return {
      enabled: value.enabled ?? true,
      announceToAgent: value.announceToAgent ?? true,
      allowAgentGeneration: value.allowAgentGeneration ?? true,
      channels,
      defaultChannelId,
      defaultModel,
      videoChannels,
      defaultVideoChannelId,
      styleDna: typeof value.styleDna === 'string' && value.styleDna.trim() !== ''
        ? value.styleDna.trim()
        : PROJECT_DEFAULTS.styleDna,
      aspectRatio: typeof value.aspectRatio === 'string' && value.aspectRatio.trim() !== ''
        ? value.aspectRatio.trim()
        : PROJECT_DEFAULTS.aspectRatio,
      shotSeconds: Number.isFinite(value.shotSeconds) && value.shotSeconds > 0
        ? Number(value.shotSeconds)
        : PROJECT_DEFAULTS.shotSeconds,
    }
  }

  /**
   * Map a project aspect ratio onto a concrete `size` the image APIs accept.
   *
   * The image endpoints take either a preset keyword or `WxH`, not a ratio, so a
   * ratio has to be resolved somewhere. Vertical 9:16 is the short-drama default
   * and must survive the trip: a 16:9 frame for a 9:16 show is a silently wrong
   * deliverable, not a cosmetic issue.
   *
   * @param {unknown} ratio e.g. '9:16'
   * @param {string} fallback the configured / explicit size to prefer
   * @returns {string} a size string
   */
  const sizeForRatio = (ratio, fallback) => {
    if (typeof fallback === 'string' && fallback.trim() !== '' && fallback.trim() !== 'auto') {
      return fallback.trim()
    }
    const text = typeof ratio === 'string' ? ratio.trim() : ''
    // Exact dimensions, not ratios: several endpoints also accept preset
    // keywords, but a wrong keyword silently returns the WRONG ASPECT (a 2:3
    // frame for a 9:16 show is an 18% error), so explicit WxH is the only safe
    // encoding. Each long edge stays within 640-1536, which mainline endpoints accept.
    const table = {
      '9:16': '1080x1920',
      '16:9': '1920x1080',
      '3:4': '1080x1440',
      '4:3': '1440x1080',
      '1:1': '1024x1024',
      '2:3': '1024x1536',
      '3:2': '1536x1024',
      '21:9': '1890x810',
    }
    return table[text] ?? 'auto'
  }

  /**
   * Find a usable image client published by another plugin.
   *
   * Returns the object that carries `generateImage`, or undefined.
   *
   * WHY THIS IS NOT A ONE-LINER: dsh-imagegen registers NO Cordis service. Its
   * `inject` is ["webServer","systemPrompt","commands"], it never calls
   * `provide('imagegen')`, and its own `ctx.get` calls ask for settings /
   * credentials / agentPresets / agentDefaultModel. `generateImage` is only a
   * module EXPORT, so `ctx.get('imagegen')` can never resolve it — the original
   * borrow branch was unreachable and every visual generation silently fell
   * through to this plugin's own channels.
   *
   * A dynamic `import('@dickpy/dsh-imagegen')` works ONLY when the importing
   * file can see that package. Because this plugin is commonly linked via a
   * junction to a development directory, Node resolves modules relative to the
   * junction's TARGET, not to ~/.dsh/profiles/<p>/node_modules — so a bare
   * specifier import throws ERR_MODULE_NOT_FOUND there. We therefore try, in
   * order: services, then a bare import, then a file URL built from the host's
   * own node_modules directory.
   */
  const borrowImageClient = async () => {
    for (const alias of IMAGE_SERVICE_ALIASES) {
      const candidate = ctx.get?.(alias)
      if (candidate !== undefined && typeof candidate.generateImage === 'function') return candidate
    }

    const registry = ctx.get?.('plugins')
    if (registry !== undefined && typeof registry === 'object') {
      for (const entry of Object.values(registry)) {
        const value = entry?.exports ?? entry?.default ?? entry
        if (value !== undefined && typeof value.generateImage === 'function') return value
      }
    }

    const loaded = await imageClientModule()
    return loaded !== undefined && typeof loaded.generateImage === 'function' ? loaded : undefined
  }

  /**
   * Import dsh-imagegen's module exports, caching the outcome.
   *
   * Returns undefined when the package is genuinely absent (this plugin is
   * designed to work standalone, so that is not an error).
   */
  const imageClientModule = () => {
    if (imageClientState.tried) return imageClientState.value
    imageClientState.tried = true
    try {
      // Resolve through the HOST's node_modules rather than our own location.
      //
      // `createRequire` must be anchored at a profile directory that actually
      // contains node_modules — ~/.dsh/profiles itself does not, only
      // ~/.dsh/profiles/<profile> does. The profile name is not knowable from
      // here (this same source runs under 'desktop', 'web', ...), so every
      // candidate is tried and the first that resolves wins.
      const file = resolveImagegenEntry()
      if (file === undefined) throw new Error('@dickpy/dsh-imagegen not resolvable from any profile')
      imageClientState.value = import(pathToFileURL(file).href)
      return imageClientState.value
    } catch (error) {
      ctx.logger?.info?.(`${PLUGIN_ID}: dsh-imagegen not available to borrow (${messageOf(error)})`)
      imageClientState.value = undefined
      return undefined
    }
  }

  /**
   * The image-generation seam.
   *
   * This plugin does not re-implement an image client. It borrows whatever
   * generation service the deployment already has: dsh-imagegen publishes one on
   * the host plane and that is preferred, because it already understands every
   * channel protocol the user configured there. When it is absent we fall back to
   * an OpenAI-compatible `/images/generations` call against our own channels, so
   * the plugin still works standalone.
   */
  const generateImage = async (request) => {
    const value = resolve()
    if (!value.enabled) throw new Error('插件已关闭：请在「设置 → 短剧工作台」中启用')
    if (!value.allowAgentGeneration) throw new Error('当前配置不允许生成（allowAgentGeneration 为 false）')

    // Resolve the frame size ONCE, so the borrowed path and our own fallback can
    // never disagree about the shape of the deliverable.
    const size = sizeForRatio(request.aspectRatio ?? value.aspectRatio, request.size)

    const borrowed = await borrowImageClient()
    if (borrowed !== undefined) {
      const result = await borrowed.generateImage({ ...request, size })
      return {
        images: Array.isArray(result?.images) ? result.images : [],
        model: String(result?.model ?? request.model ?? ''),
        channel: String(result?.channel ?? ''),
      }
    }

    const channel = value.channels.find(candidate => candidate.id === (request.channelId ?? value.defaultChannelId))
      ?? value.channels.find(candidate => candidate.id === value.defaultChannelId)
      ?? value.channels[0]
    if (channel === undefined) {
      throw new Error('尚未配置图像渠道：请打开「设置 → 短剧工作台」添加渠道并填写 API 地址与密钥')
    }
    if (channel.apiKey === '') throw new Error(`图像渠道「${channel.name || channel.id}」尚未填写 API 密钥`)
    const alias = (request.model ?? value.defaultModel).trim()
    const mapping = channel.models.find(model => model.alias === alias) ?? channel.models[0]
    if (mapping === undefined) throw new Error(`渠道「${channel.name || channel.id}」尚未配置模型`)

    const base = channel.apiUrl.replace(/\/+$/u, '')
    const url = channel.protocol === 'chat-completions' || /\/chat\/completions$/u.test(base)
      ? base
      : `${base}/images/generations`
    const prompt = request.negative !== undefined && request.negative.trim() !== ''
      ? `${request.prompt}。不要出现：${request.negative}`
      : request.prompt
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${channel.apiKey}` },
      body: JSON.stringify({
        model: mapping.id,
        prompt,
        n: 1,
        size,
        response_format: 'b64_json',
      }),
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500)
      throw new Error(`图像接口返回 ${response.status}：${detail}`)
    }
    const payload = await response.json()
    const images = []
    for (const item of payload.data ?? []) {
      if (typeof item.b64_json === 'string' && item.b64_json !== '') {
        images.push({ b64: item.b64_json, mime: 'image/png' })
      } else if (typeof item.url === 'string' && item.url !== '') {
        const fetched = await fetch(item.url, request.signal === undefined ? {} : { signal: request.signal })
        if (!fetched.ok) continue
        const bytes = Buffer.from(await fetched.arrayBuffer())
        images.push({ b64: bytes.toString('base64'), mime: fetched.headers.get('content-type') ?? 'image/png' })
      }
    }
    if (images.length === 0) throw new Error('图像接口没有返回任何图片')
    return { images, model: alias, channel: channel.name || channel.id }
  }

  // ------------------------------------------------------------------ routes
  const routes = makeAidramaRoutes({
    store,
    stages,
    prompts,
    video,
    resolveConfig: resolve,
    generateImage,
    log: message => ctx.logger?.info?.(`${PLUGIN_ID}: ${message}`),
  })

  ctx.effect(() => {
    const disposers = routes.map(route => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* already gone */ }
      }
    }
  }, 'dsh-aidrama: routes')

  // ------------------------------------------------- agent-tool implementations
  //
  // The tools and the browser half BOTH go through the HTTP route family. One
  // wire means one implementation: `callRouteAsFunction` drives the very same
  // handler the browser reaches over fetch.
  const routeOf = apiPath => routes.find(route => route.kind === 'exact' && route.path === apiPath)

  const callRoute = async (apiPath, body, label) => {
    const route = routeOf(apiPath)
    if (route === undefined) return { ok: false, code: 'no-route', message: `${label}路由未挂载` }
    return await callRouteAsFunction(route, body)
  }

  const callProjects = async body => await callRoute(AIDRAMA_API.projects, body, '项目')
  const callStage = async body => await callRoute(AIDRAMA_API.stage, body, '阶段')
  const callVideo = async body => await callRoute(AIDRAMA_API.video, body, '视频')

  // -------------------------------------------------------------- agent tools
  try {
    ctx.inject(['tools'], tctx => {
      tctx.effect(
        () => registerAgentTools(tctx, { resolve, callProjects, callStage, callVideo }),
        'dsh-aidrama: agent tools',
      )
    })
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN_ID}: tools injection failed: ${messageOf(error)}`)
  }

  // --------------------------------------------------------- prompt section
  let disposeSection
  const sync = () => {
    if (disposeSection !== undefined) {
      try { disposeSection() } catch { /* already gone */ }
      disposeSection = undefined
    }
    const value = resolve()
    if (!value.enabled || !value.announceToAgent) return
    try {
      disposeSection = ctx.systemPrompt.section({
        name: `plugin:${PLUGIN_ID}`,
        order: SECTION_ORDER,
        text: guidanceFor(value),
      })
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN_ID}: system prompt section failed: ${messageOf(error)}`)
    }
  }

  // -------------------------------------------------------------- settings
  //
  // Installed through the settings service so this plugin's namespace renders in
  // the settings dialog. `setSource` hands back the live accessor the surfaces
  // read, which is what makes a settings edit apply with no restart.
  try {
    ctx.inject(['settings'], sctx => {
      const settings = sctx.get('settings')
      if (settings === undefined) return
      sctx.effect(() => {
        let dispose = () => {}
        const install = settings.section ?? settings.install
        if (typeof install === 'function') {
          try {
            const handle = install.call(settings, {
              namespace: AIDRAMA_SETTINGS_NAMESPACE,
              schema: Config,
              value: unwrapConfig(config),
              setSource: source => { current = source; sync() },
              onChange: sync,
            })
            if (typeof handle === 'function') dispose = handle
          } catch (error) {
            ctx.logger?.warn?.(`${PLUGIN_ID}: settings section not installed: ${messageOf(error)}`)
          }
        }
        return () => {
          try { dispose() } catch { /* already gone */ }
        }
      }, 'dsh-aidrama: settings')
    })
  } catch (error) {
    ctx.logger?.warn?.(`${PLUGIN_ID}: settings injection failed: ${messageOf(error)}`)
  }

  // Initial registration from the composition entry (covers deployments with no
  // settings service, whose install never fires the hooks above).
  sync()

  ctx.logger?.info?.(`${PLUGIN_ID}: mounted (${STAGES.length} stages, ${routes.length} routes)`)

  return () => {
    if (disposeSection !== undefined) {
      try { disposeSection() } catch { /* already gone */ }
      disposeSection = undefined
    }
  }
}

/** Re-exported so the browser bundle and the verify scripts share one contract. */
export { STAGES, STAGE_META, STAGE_STATUS, AIDRAMA_API, AIDRAMA_SETTINGS_NAMESPACE, createProject }
