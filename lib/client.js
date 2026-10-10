/**
 * dsh-aidrama — browser half: sidebar entry + six-stage workbench.
 *
 * LOADED AS A LAZY-CJS BUNDLE, NOT AN ES MODULE. The shell registers this file
 * with `window.__ModuleLoader__.load({ id, factory })` and materializes it on
 * first import; `factory(require)` returns the module face. There is no `ctx`,
 * `React`, `host` or `styles` global — `ctx` is the single `apply` argument, and
 * React arrives through the synchronous `require` module table (lowercase keys:
 * `react`, `react-dom/client`, `react/jsx-runtime`).
 *
 * FAILURE POLICY (non-negotiable): a throwing `apply` — or a throwing factory
 * body — makes the shell render "Failed to load plugins" instead of the whole
 * GUI. Every risky step here is wrapped and degrades to `console.warn`. This
 * module never lets an error escape `apply` or the factory.
 *
 * Host access is plain same-origin `fetch` against the plugin's own
 * /api/dsh-aidrama/* route family; there is no host.call.
 */

window.__ModuleLoader__.load({
  id: 'dsh-aidrama',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /* ---------------------------------------------------------------- *
     * Module-table requires. Only these specifiers are importable; each
     * is pulled defensively so a missing row degrades instead of throwing
     * out of the factory.
     * ---------------------------------------------------------------- */

    const safeRequire = (specifier) => {
      try {
        return require(specifier)
      } catch (error) {
        console.warn(`[dsh-aidrama] module "${specifier}" unavailable:`, error)
        return undefined
      }
    }

    const React = safeRequire('react')
    const ReactDOMClient = safeRequire('react-dom/client')
    const createElement = React !== undefined && typeof React.createElement === 'function'
      ? React.createElement.bind(React)
      : () => null

    /**
     * Wait services. Deliberately EMPTY: `dsh.client.inject` is `[]`, and a
     * listed-but-absent service leaves `apply` pending forever — a silently
     * blank sidebar. Optional services are reached through `ctx.get(name)`,
     * which returns undefined rather than throwing.
     */
    const inject = []

    /* ---------------------------------------------------------------- *
     * Route family + stage vocabulary (mirrors lib/host/protocol.js).
     * ---------------------------------------------------------------- */

    const API = {
      projects: '/api/dsh-aidrama/projects',
      stage: '/api/dsh-aidrama/stage',
      video: '/api/dsh-aidrama/video',
      export: '/api/dsh-aidrama/export',
      config: '/api/dsh-aidrama/config',
      asset: '/api/dsh-aidrama/asset',
    }

    const STAGE_IDS = ['idea', 'story', 'script', 'bible', 'visual', 'video']
    const TEXT_STAGE_IDS = ['idea', 'story', 'script', 'bible']
    const STAGE_SHORT = {
      idea: '想法',
      story: '剧情',
      script: '脚本',
      bible: '设定',
      visual: '视觉',
      video: '视频',
    }
    const STAGE_LABEL = {
      idea: '想法梳理',
      story: '剧情设计',
      script: '分场脚本',
      bible: '设定集',
      visual: '视觉资产',
      video: '视频成片',
    }
    const STAGE_STATUS = {
      empty: 'empty',
      stale: 'stale',
      ready: 'ready',
      running: 'running',
      failed: 'failed',
    }

    /* ---------------------------------------------------------------- *
     * EDITABLE FIELD DEFINITIONS.
     *
     * Derived from the real contracts in lib/host/prompts.js (dump them with
     * `node docs/dump-schemas.mjs`) — NOT guessed — so the forms match exactly
     * what the host validates.
     *
     * These live INSIDE this file on purpose: the bundle is loaded as a
     * lazy-CJS factory via window.__ModuleLoader__, so it cannot `import` a
     * sibling module. Anything the client needs must be in this one file.
     *
     *   fields   scalar inputs, rendered in order
     *   lists    repeatable groups (acts, characters, episodes, scenes, shots)
     *
     * `kind` picks the control: text | textarea | number | select | tags | lines
     * `req`  marks a field the host validates, so the form can mark it required.
     * ---------------------------------------------------------------- */
    const STAGE_FORMS = {
      idea: {
        // Step one asks ONE question. Everything else is produced for the user
        // rather than demanded from them — see "PRIMARY" below.
        primary: {
          key: 'seed',
          label: '你想要一个什么样的故事？',
          ph: '随便写。一个念头、一个梦、一句台词、看见的一个画面都行 —— 比如"我总梦见自己在地铁上，但车永远不停"。',
          hint: '写得越随意越好，剩下的我来编排。',
          rows: 5,
        },
        // Tap-to-choose, so step one can be finished without typing anything
        // beyond the idea itself. Values map onto fields the later stages use.
        choices: [
          {
            key: 'audience',
            label: '给谁看',
            options: ['男频 · 扮猪吃虎', '男频 · 逆袭打脸', '女频 · 先婚后爱', '女频 · 复仇归来', '都能看'],
          },
          {
            key: 'flavor',
            label: '什么味',
            options: ['爽为主 · 一路碾压', '虐为主 · 先抑后扬', '悬疑为主 · 层层反转', '温情为主 · 治愈向'],
          },
          {
            key: 'length',
            label: '多少集',
            options: ['短平快 · 12 集以内', '标准 · 24-40 集', '长线 · 60 集以上'],
          },
        ],
        help: '先写想法，再点两个选择题。下面的细节可以等你选了方向之后，让我来填。',
        fields: [
          { key: 'title', label: '剧名', kind: 'text', ph: '退婚后我成了首富', hint: '不急，可以让我起' },
          { key: 'logline', label: '一句话故事', kind: 'textarea', rows: 2, ph: '被逐出家门的赘婿林越，靠一手操盘术在三十天内买回自己被夺走的一切。', hint: '包含主角、目标、阻碍' },
          { key: 'genre', label: '题材类型', kind: 'text', ph: '都市逆袭' },
          { key: 'tone', label: '基调与情绪走向', kind: 'text', ph: '隐忍到爆发的爽感，冷色夜景，节奏凌厉' },
          { key: 'protagonist', label: '主角', kind: 'textarea', rows: 2, ph: '林越，28 岁，被退婚的前操盘手，想要夺回公司', hint: '姓名、身份、核心欲望' },
          { key: 'conflict', label: '核心冲突与对手', kind: 'textarea', rows: 2, ph: '岳父苏建国联手旧部架空他，逼他在一个月内还清三亿' },
          { key: 'hook', label: '前 3 秒钩子', kind: 'textarea', rows: 2, ph: '林越把退婚书拍在餐桌上，转身按下电梯里的抄底键', hint: '要能直接拍出来' },
          { key: 'ending', label: '结局走向', kind: 'textarea', rows: 2, ph: '开盘日他买回公司，旧部集体倒戈，苏建国独自离场' },
        ],
        lists: [
          { key: 'questions', label: '待确认问题', kind: 'lines', max: 3, hint: '最多 3 个需要你拍板的选择题；留空也可以', ph: '复仇线停在买回公司，还是加上感情线？' },
        ],
      },

      story: {
        draftHint: '三幕、人物、分集、节拍加起来几十个字段。先让我按你想法的方向出一版初稿，你只改不顺眼的地方。',
        help: '三幕结构、人物欲望与障碍、分集与钩子。',
        fields: [
          { key: 'title', label: '剧名', kind: 'text' },
          { key: 'logline', label: '一句话故事', kind: 'textarea', rows: 2 },
          { key: 'theme', label: '主题一句话', kind: 'text', ph: '尊严要靠自己挣回来' },
          { key: 'synopsis', label: '故事梗概', kind: 'textarea', rows: 5, hint: '300-500 字，交代起承转合' },
          { key: 'controllingIdea', label: '控制性理念', kind: 'textarea', rows: 2, hint: '这个故事的价值主张，必须能被结局正面回答' },
        ],
        lists: [
          {
            key: 'acts', label: '三幕', item: '幕', addable: true, reorder: true,
            fields: [
              { key: 'name', label: '幕名', kind: 'text', ph: '第一幕：退婚' },
              { key: 'summary', label: '结束时的状态变化', kind: 'textarea', rows: 2 },
            ],
          },
          {
            key: 'characters', label: '主要人物', item: '人物', addable: true,
            fields: [
              { key: 'name', label: '姓名', kind: 'text', req: true },
              { key: 'role', label: '定位', kind: 'text', ph: '主角 / 对手 / 恋人' },
              { key: 'want', label: '他想要什么', kind: 'text' },
              { key: 'obstacle', label: '什么在阻止他', kind: 'text' },
            ],
          },
          {
            key: 'episodes', label: '分集', item: '集', addable: true, reorder: true,
            fields: [
              { key: 'title', label: '集标题', kind: 'text', ph: '第 1 集：退婚书' },
              { key: 'hook', label: '本集最后一秒的悬念', kind: 'textarea', rows: 2 },
              { key: 'summary', label: '本集摘要', kind: 'textarea', rows: 3, hint: '80-150 字' },
            ],
          },
          {
            key: 'beats', label: '故事节拍', item: '节拍', addable: true, reorder: true,
            hint: '必含 inciting / act1-turn / midpoint / crisis / climax / resolution',
            fields: [
              { key: 'id', label: '节拍 id', kind: 'select', options: ['inciting', 'act1-turn', 'midpoint', 'crisis', 'climax', 'resolution'] },
              { key: 'name', label: '中文名', kind: 'text', ph: '激励事件' },
              { key: 'position', label: '时长比例', kind: 'number', step: '0.01', min: '0', max: '1', hint: '0..1；激励事件 ≤0.12，高潮 0.85-0.97' },
              { key: 'purpose', label: '这一拍发生了什么', kind: 'textarea', rows: 2, hint: '写可见的事件，不是情绪' },
              { key: 'answer', label: '控制性理念的答案', kind: 'textarea', rows: 2, hint: '仅结局节拍需要' },
            ],
          },
        ],
      },

      script: {
        draftHint: '集 → 场 → 镜，字段最多。同样先出初稿，再逐场改。',
        help: '集 → 场 → 镜。这是真正拿去拍的东西。',
        fields: [{ key: 'title', label: '剧名', kind: 'text' }],
        lists: [
          {
            key: 'episodes', label: '集', item: '集', addable: true, reorder: true,
            fields: [
              { key: 'title', label: '集标题', kind: 'text', req: true, ph: '第 1 集：退婚书' },
              { key: 'hook', label: '本集最后的悬念', kind: 'textarea', rows: 2 },
              { key: 'hookType', label: '开场钩子类型', kind: 'text', hint: '如 conflict-open' },
              { key: 'reversalPoints', label: '反转点（秒）', kind: 'tags', hint: '升序，相邻间隔 ≤30 秒' },
            ],
            children: [
              {
                key: 'scenes', label: '场', item: '场', addable: true, reorder: true,
                fields: [
                  { key: 'slug', label: '场次标题', kind: 'text', req: true, ph: 'INT. 苏家餐厅 - 夜', hint: 'INT./EXT. 地点 - 时间' },
                  { key: 'location', label: '地点', kind: 'text' },
                  { key: 'time', label: '时间', kind: 'text', ph: '夜' },
                  { key: 'characters', label: '出场人物', kind: 'tags', hint: '逗号分隔的姓名' },
                  { key: 'action', label: '动作与画面', kind: 'textarea', rows: 3 },
                  { key: 'durationSec', label: '预估时长（秒）', kind: 'number', min: '0' },
                  { key: 'valuePair', label: '价值轴', kind: 'text', ph: '希望/绝望' },
                  { key: 'valueEntry', label: '开场在哪一极', kind: 'text' },
                  { key: 'valueExit', label: '结束在哪一极', kind: 'text', hint: '必须与开场相反' },
                  { key: 'hookCue', label: '钩子画面', kind: 'textarea', rows: 2, hint: '仅第 1 集第 1 镜需要' },
                ],
                children: [
                  {
                    key: 'dialogue', label: '对白', item: '句', addable: true,
                    fields: [
                      { key: 'who', label: '说话人', kind: 'text', hint: '必须是本场 characters 之一' },
                      { key: 'line', label: '台词', kind: 'textarea', rows: 2 },
                    ],
                  },
                  {
                    key: 'shots', label: '镜头', item: '镜', addable: true, reorder: true,
                    fields: [
                      { key: 'shot', label: '景别', kind: 'select', options: ['大远景', '远景', '全景', '中景', '中近景', '近景', '特写'] },
                      { key: 'camera', label: '机位与运动', kind: 'text', ph: '低机位缓推' },
                      { key: 'description', label: '画面内容', kind: 'textarea', rows: 2 },
                      { key: 'motion', label: '主体与镜头运动', kind: 'textarea', rows: 2 },
                      { key: 'beatId', label: '服务哪一拍', kind: 'text', hint: '对应 beats[].id' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },

      bible: {
        draftHint: '人物卡每个字段都会被缝进图像提示词。先出初稿，再逐条调到你觉得「就是他」。',
        help: '人物卡与场景卡。写得越具体，出图越稳。',
        fields: [
          { key: 'styleDna', label: '视觉基调（全片统一）', kind: 'textarea', rows: 3, ph: '3D 国漫，电影级柔和轮廓光，统一 85mm 焦距，细腻皮肤质感，无畸变' },
        ],
        lists: [
          {
            key: 'characters', label: '角色', item: '角色', addable: true,
            fields: [
              { key: 'id', label: '稳定 id', kind: 'text', req: true, ph: 'lin-yue', hint: '小写短横线；改名会断开已生成素材的关联' },
              { key: 'name', label: '姓名', kind: 'text', req: true },
              { key: 'role', label: '角色定位', kind: 'text', ph: '主角 / 对手' },
              { key: 'appearance', label: '整体外观', kind: 'textarea', rows: 2, req: true, ph: '28 岁男性，利落短发，黑色高领衫外罩深灰风衣' },
              { key: 'hair', label: '发型发色', kind: 'text', ph: '两侧推短的黑色短发，发尾微翘' },
              { key: 'face', label: '脸型五官', kind: 'text', ph: '窄长脸，眉骨高，单眼皮' },
              { key: 'body', label: '体型身高', kind: 'text', ph: '身高 183cm，八头身' },
              { key: 'outfit', label: '服装', kind: 'textarea', rows: 2 },
              { key: 'accessory', label: '配饰', kind: 'text' },
              { key: 'personality', label: '性格与说话方式', kind: 'textarea', rows: 2 },
              { key: 'arc', label: '人物弧光', kind: 'textarea', rows: 2 },
            ],
          },
          {
            key: 'scenes', label: '场景', item: '场景', addable: true,
            fields: [
              { key: 'id', label: '稳定 id', kind: 'text', req: true, ph: 'su-dining' },
              { key: 'name', label: '场景名', kind: 'text', req: true },
              { key: 'kind', label: '场景类型', kind: 'select', options: ['interior', 'exterior'] },
              { key: 'description', label: '环境描述', kind: 'textarea', rows: 3, req: true, hint: '尺度、材质、陈设' },
              { key: 'lighting', label: '光源与色温', kind: 'textarea', rows: 2 },
              { key: 'composition', label: '机位与纵深', kind: 'textarea', rows: 2 },
            ],
          },
        ],
      },
    }

    const STATUS_TEXT = {
      empty: '未开始',
      stale: '待更新',
      ready: '已完成',
      running: '生成中',
      failed: '失败',
    }
    const ASSET_KIND = {
      characterSheet: 'character-sheet',
      sceneMaster: 'scene-master',
      shotRef: 'shot-ref',
      video: 'video',
    }
    const ASSET_KIND_TEXT = {
      'character-sheet': '三视图',
      'scene-master': '场景主图',
      'shot-ref': '分镜图',
      'first-frame': '首帧',
      video: '视频',
    }

    /* ---------------------------------------------------------------- *
     * Small utilities. No innerHTML anywhere project content is rendered.
     * ---------------------------------------------------------------- */

    const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

    const text = (value) => (typeof value === 'string' ? value : '')

    /** Coerce any host field to a display string without printing "undefined". */
    const str = (value) => {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return ''
    }

    /** Render a field that may be a string, an array, or an object. */
    const listText = (value) => {
      if (Array.isArray(value)) {
        return value.map(item => (isRecord(item) ? str(item.name ?? item.id ?? item.line) : str(item)))
          .filter(part => part !== '')
          .join('、')
      }
      return str(value)
    }

    const asArray = (value) => (Array.isArray(value) ? value.filter(isRecord) : [])

    /** `1710000000000` → `2024/03/09 12:00`, tolerant of junk. */
    const formatTime = (value) => {
      const ms = Number(value)
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      try {
        const date = new Date(ms)
        const pad = (n) => String(n).padStart(2, '0')
        return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
      } catch {
        return '—'
      }
    }

    const formatBytes = (value) => {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    /** Pretty-print JSON without throwing on a circular or exotic value. */
    const prettyJson = (value) => {
      try {
        return JSON.stringify(value, null, 2) ?? ''
      } catch {
        return str(value)
      }
    }

    /**
     * Parse the textarea the user pastes stage JSON into.
     *
     * Tolerates the two shapes a conversational model actually emits: a bare
     * JSON object, or that object inside a ```json fence. Throws a readable
     * error, which the caller renders inline.
     */
    const parseStageJson = (raw) => {
      const source = str(raw).trim()
      if (source === '') throw new Error('内容为空：请先粘贴对话模型返回的 JSON')
      const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)
      const candidate = (fenced !== null ? fenced[1] : source).trim()
      let parsed
      try {
        parsed = JSON.parse(candidate)
      } catch (error) {
        throw new Error(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if (parsed === null || typeof parsed !== 'object') {
        throw new Error('顶层必须是一个 JSON 对象或数组')
      }
      return parsed
    }

    /* ---------------------------------------------------------------- *
     * Host transport: ONE envelope helper for every route.
     * ---------------------------------------------------------------- */

    /** Error carrying the route's JSON `message`, modelled on imagegen's ApiError. */
    class AidramaApiError extends Error {
      constructor(message, code = 'aidrama-failed', status = 0) {
        super(message)
        this.name = 'AidramaApiError'
        this.code = code
        this.status = status
      }
    }

    /** Parse the `{ ok, ... }` envelope or throw an AidramaApiError. */
    const readEnvelope = async (response) => {
      let body
      try {
        body = await response.json()
      } catch {
        throw new AidramaApiError(
          `HTTP ${response.status}：宿主返回的不是 JSON（路由可能不存在，或尚未注册）`,
          'bad-response',
          response.status,
        )
      }
      if (!isRecord(body)) {
        throw new AidramaApiError(`HTTP ${response.status}：响应格式不正确`, 'bad-response', response.status)
      }
      if (body.ok !== true) {
        throw new AidramaApiError(
          text(body.message) || `HTTP ${response.status}`,
          text(body.code) || 'aidrama-failed',
          response.status,
        )
      }
      return body
    }

    /** POST one JSON body to a route and return the parsed envelope. */
    const post = async (path, payload) => {
      let response
      try {
        response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        })
      } catch (error) {
        throw new AidramaApiError(
          `无法连接宿主路由 ${path}：${error instanceof Error ? error.message : String(error)}`,
          'network',
        )
      }
      return await readEnvelope(response)
    }

    const api = {
      listProjects: async () => (await post(API.projects, { action: 'list' })).projects ?? [],
      createProject: async (input) => (await post(API.projects, { action: 'create', ...input })).project,
      getProject: async (id) => await post(API.projects, { action: 'get', id }),
      deleteProject: async (id) => await post(API.projects, { action: 'delete', id }),
      advance: async (id, stage) => (await post(API.projects, { action: 'advance', id, stage })).project,
      rerun: async (id, stage) => (await post(API.projects, { action: 'rerun', id, stage })).project,
      brief: async (projectId, stage) => (await post(API.stage, { projectId, stage, action: 'brief' })).brief,
      commit: async (projectId, stage, payload, note) =>
        (await post(API.stage, { projectId, stage, action: 'commit', payload, note })).project,
      generate: async (projectId, targets) => await post(API.stage, {
        projectId,
        stage: 'visual',
        action: 'generate',
        payload: { targets },
      }),
      promptPack: async (projectId) => (await post(API.video, { projectId, action: 'prompt-pack' })).pack,
      videoStatus: async (projectId, taskId) =>
        await post(API.video, { projectId, action: 'status', taskId }),
      submitVideo: async (projectId, shotRefs) =>
        await post(API.video, { projectId, action: 'submit', shotRefs }),
      exportProject: async (projectId, format) => await post(API.export, { projectId, format }),
      config: async () => (await post(API.config, {})).config,
    }

    /* ---------------------------------------------------------------- *
     * CSS. There is no `styles` object, so the sheet is injected from a
     * guarded <style> tag. Every class is `aidrama-` prefixed and every
     * colour is a custom property with a fallback that works in light AND
     * dark, so nothing here hardcodes a background that breaks dark mode.
     * ---------------------------------------------------------------- */

    const CSS = `
/* --------------------------------------------------------------- *
 * SIDEBAR ENTRY.
 *
 * This button lives in the HOST's sidebar, not in our overlay, so it has to
 * hold its own visually while still reading as part of the tool: a gradient
 * app mark, the product name, a "STUDIO" qualifier, and a live status line
 * summarising the active project.
 * --------------------------------------------------------------- */
.aidrama-entry {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 8px 10px; border: 1px solid transparent; border-radius: 10px; cursor: pointer;
  background: transparent; color: var(--ad-text, #E6E8EC);
  font: inherit; text-align: left;
  transition: background 130ms ease, border-color 130ms ease, transform 130ms ease;
}
.aidrama-entry:hover {
  background: var(--ad-surface-2, #1B1E24);
  border-color: var(--ad-border, rgba(255,255,255,.09));
}
.aidrama-entry:focus-visible { outline: 2px solid var(--ad-accent, #7C5CFF); outline-offset: 1px; }
.aidrama-entry:active { transform: scale(.99); }
.aidrama-entry[data-active] {
  background: color-mix(in srgb, var(--ad-accent, #7C5CFF) 15%, transparent);
  border-color: color-mix(in srgb, var(--ad-accent, #7C5CFF) 45%, transparent);
}
.aidrama-entryMark {
  flex: none; width: 26px; height: 26px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  color: #fff; background: linear-gradient(135deg, var(--ad-accent, #7C5CFF), #4A32C9);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--ad-accent, #7C5CFF) 38%, transparent);
}
.aidrama-entryText { min-width: 0; flex: 1; }
.aidrama-entryName {
  display: flex; align-items: center; gap: 5px;
  font-size: 13px; font-weight: 600; line-height: 1.25;
}
.aidrama-entryTag {
  font-size: 8.5px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
  color: var(--ad-accent, #7C5CFF);
  background: color-mix(in srgb, var(--ad-accent, #7C5CFF) 18%, transparent);
  border-radius: 4px; padding: 1.5px 4px;
}
.aidrama-entryMeta {
  margin-top: 2px; font-size: 10.5px; color: var(--ad-text-3, #7A8290);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.aidrama-entry svg { flex: none; }
.aidrama-entry span { overflow: hidden; text-overflow: ellipsis; }
.aidrama-entry span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* --------------------------------------------------------------- *
 * Workbench shell.
 *
 * WHY THIS IS NOT A FULL-BLEED SHEET ANY MORE
 *
 * The sheet used to be a full-bleed opaque rectangle pinned to all four
 * viewport edges. Two consequences, both reported as bugs:
 *   - it sat flush against the top edge ("顶格"), covering the app's own
 *     title bar, with no breathing room and no way to tell it was a layer
 *     rather than a page;
 *   - because it was opaque and edge-to-edge there was no scrim, no
 *     elevation, and no visual exit — it read as "the app got stuck".
 *
 * It is now a centred, elevated CARD on a blurred scrim, with a pointer
 * offset from every edge, so it is unmistakably a modal layer.
 *
 * Layout uses dvh/vh units and honours safe-area insets, so the panel is
 * never clipped on notched or short viewports.
 * --------------------------------------------------------------- */

.aidrama-overlay {
  position: fixed; inset: 0; z-index: 900;
  display: flex; align-items: center; justify-content: center;
  padding: clamp(8px, 2.2vh, 22px) clamp(8px, 2vw, 26px);
  box-sizing: border-box;
  background: var(--dsw-alias-bg-mask, rgba(15,18,24,.44));
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
  color: var(--ad-text);
  font-family: inherit; font-size: 13px;
  animation: aidrama-scrim-in 140ms ease-out;
}
.aidrama-overlay[data-hidden] { display: none; }

@keyframes aidrama-scrim-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes aidrama-card-in {
  from { opacity: 0; transform: translateY(8px) scale(.994); }
  to   { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .aidrama-overlay, .aidrama-shell { animation: none !important; }
}

/* The elevated card. */
.aidrama-shell {
  display: flex; flex-direction: column;
  width: min(1180px, 100%);
  height: min(860px, 100%);
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid var(--ad-border);
  background: var(--ad-bg);
  box-shadow:
    0 1px 2px rgba(0,0,0,.06),
    0 12px 28px rgba(0,0,0,.14),
    0 32px 64px -12px rgba(0,0,0,.22);
  animation: aidrama-card-in 170ms cubic-bezier(.22,.68,.34,1);
}

/* Full-bleed on small screens, where a floating card wastes space. */
@media (max-width: 720px) {
  .aidrama-overlay { padding: 0; }
  .aidrama-shell { width: 100%; height: 100%; border-radius: 0; border: 0; }
}

.aidrama-head {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 11px 14px 11px 16px;
  border-bottom: 1px solid var(--ad-border);
  background: var(--ad-surface);
}
.aidrama-head h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: .01em; }
.aidrama-logo {
  flex: none; width: 26px; height: 26px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  color: #fff; background: linear-gradient(135deg, var(--ad-accent), #4A32C9);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--ad-accent) 40%, transparent);
}
.aidrama-headSpacer { flex: 1; }
/* A real 16px glyph target rather than a text word, so "close" reads as an
   affordance instead of a label competing with 设置 / 导出. */
.aidrama-iconBtn {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; padding: 0; border-radius: 9px; cursor: pointer;
  border: 1px solid transparent; background: transparent;
  color: var(--ad-text-2); font: inherit;
}
.aidrama-iconBtn:hover { background: var(--ad-surface-3); color: var(--ad-text); }
.aidrama-iconBtn:focus-visible { outline: 2px solid var(--ad-accent); outline-offset: 1px; }

.aidrama-body { flex: 1; display: flex; min-height: 0; }

/* --------------------------------------------------------------- *
 * TOKENS.
 *
 * DARK-FIRST, and deliberately so: this tool's whole output is imagery, and
 * generated artwork has to be the brightest thing on screen. A white canvas
 * competes with the pictures and makes every thumbnail look muddy.
 *
 * Every value is a local custom property so the palette can be tuned in one
 * place, and each still falls back to a DSH theme token when the host has one —
 * so we inherit the app's look instead of fighting it.
 *
 * Neutral scale, never pure black or pure white: #000 + #fff is the fastest
 * way to look amateur. Elevation comes from surface LIGHTNESS plus hairline
 * borders, not heavy drop shadows.
 * --------------------------------------------------------------- */
/*
 * Declared on :root, NOT on .aidrama-overlay.
 *
 * The sidebar entry button lives in the host's sidebar — a completely separate
 * DOM subtree from the overlay. When the tokens were scoped to the overlay the
 * entry inherited NOTHING, so every var(--ad-*) inside .aidrama-entry resolved
 * to an empty value and the button lost its colours entirely.
 *
 * Scoping them to :root also lets both surfaces share one palette.
 */
:root {
  --ad-bg: var(--dsw-alias-bg-base, #0E1013);
  --ad-surface: var(--dsw-alias-bg-layer-1, #16181D);
  --ad-surface-2: var(--dsw-alias-bg-layer-2, #1B1E24);
  --ad-surface-3: var(--dsw-alias-bg-layer-3, #22262E);
  --ad-border: var(--dsw-alias-border-l1, rgba(255,255,255,.09));
  --ad-border-strong: var(--dsw-alias-border-l2, rgba(255,255,255,.16));
  --ad-text: var(--dsw-alias-label-primary, #E6E8EC);
  --ad-text-2: var(--dsw-alias-label-secondary, #A2A8B4);
  --ad-text-3: var(--dsw-alias-label-tertiary, #7A8290);
  --ad-accent: var(--dsw-alias-brand-primary, #7C5CFF);
  --ad-accent-2: #F5A524;
  --ad-ok: var(--dsw-alias-state-success-primary, #2FBF7A);
  --ad-warn: var(--dsw-alias-state-warning-primary, #F5A524);
  --ad-err: var(--dsw-alias-state-error-primary, #F2555A);
  --ad-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Consolas, monospace;
}

/* Small helpers used across the tool. */
.aidrama-mono { font-family: var(--ad-mono); font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.aidrama-eyebrow {
  font-size: 10.5px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
  color: var(--ad-text-3);
}
.aidrama-chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10.5px; line-height: 1; padding: 3.5px 7px; border-radius: 6px;
  background: var(--ad-surface-3); color: var(--ad-text-2); white-space: nowrap;
  border: 1px solid transparent;
}
.aidrama-chip[data-tone=accent] { color: var(--ad-accent); background: color-mix(in srgb, var(--ad-accent) 16%, transparent); }
.aidrama-chip[data-tone=ok] { color: var(--ad-ok); background: color-mix(in srgb, var(--ad-ok) 15%, transparent); }
.aidrama-chip[data-tone=warn] { color: var(--ad-warn); background: color-mix(in srgb, var(--ad-warn) 15%, transparent); }
.aidrama-chip[data-tone=err] { color: var(--ad-err); background: color-mix(in srgb, var(--ad-err) 15%, transparent); }
.aidrama-chip[data-tone=amber] { color: var(--ad-accent-2); background: color-mix(in srgb, var(--ad-accent-2) 15%, transparent); }
.aidrama-chip svg { flex: none; }

.aidrama-rail {
  flex: none; width: 236px; min-width: 236px; overflow-y: auto;
  border-right: 1px solid var(--ad-border);
  background: var(--ad-surface);
  padding: 11px;
}
.aidrama-railHead { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.aidrama-railTitle {
  font-weight: 700; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--ad-text-3);
}

.aidrama-project {
  display: block; width: 100%; text-align: left; cursor: pointer;
  border: 1px solid var(--ad-border);
  background: var(--ad-surface-2);
  color: inherit; font: inherit; border-radius: 10px; padding: 9px 10px; margin-bottom: 7px;
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
.aidrama-project:hover { border-color: var(--ad-border-strong); box-shadow: 0 2px 10px rgba(0,0,0,.3); }
.aidrama-project[data-active] {
  border-color: color-mix(in srgb, var(--ad-accent) 55%, transparent);
  background: color-mix(in srgb, var(--ad-accent) 13%, var(--ad-surface-2));
  box-shadow: inset 3px 0 0 var(--ad-accent);
}
.aidrama-projectTitle { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aidrama-projectMeta { margin-top: 3px; font-size: 11px; color: var(--ad-text-3); }

.aidrama-main { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }

/* --------------------------------------------------------------- *
 * Step strip.
 *
 * A horizontal stepper with a connecting rule, so the six stages read as
 * a PROGRESSIVE PIPELINE rather than six unrelated pill buttons. The dot's
 * colour is the only status carrier, which keeps it scannable at a glance.
 * --------------------------------------------------------------- */
.aidrama-steps {
  flex: none; display: flex; align-items: stretch; gap: 0;
  padding: 11px 16px; overflow-x: auto;
  border-bottom: 1px solid var(--ad-border);
  background: var(--ad-surface);
  scrollbar-width: thin;
}
.aidrama-step {
  position: relative; flex: none;
  display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
  border: 0; background: transparent; color: var(--ad-text-2);
  font: inherit; font-size: 12.5px; padding: 4px 13px 4px 4px; white-space: nowrap;
  border-radius: 8px;
  transition: color 120ms ease, background 120ms ease;
}
.aidrama-step:hover { color: var(--ad-text); background: var(--ad-surface-3); }
.aidrama-step:focus-visible { outline: 2px solid var(--ad-accent); outline-offset: 1px; }
.aidrama-step[data-active] { color: var(--ad-accent); font-weight: 620; }
.aidrama-step[data-active] .aidrama-stepNum {
  background: var(--ad-accent); color: #fff;
  border-color: transparent;
}
/* The connector: drawn as a pseudo-element so it never becomes a grid item. */
.aidrama-step:not(:last-child)::after {
  content: ''; position: absolute; right: 3px; top: 50%;
  width: 6px; height: 1px; background: var(--ad-border-strong);
}
.aidrama-stepNum {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 21px; height: 21px; border-radius: 50%;
  border: 1px solid var(--ad-border-strong);
  background: var(--ad-surface-2);
  font-size: 10.5px; font-weight: 650; font-variant-numeric: tabular-nums;
  color: var(--ad-text-2);
}
.aidrama-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--ad-text-3); }
.aidrama-dot[data-status=ready] { background: var(--ad-ok); }
.aidrama-dot[data-status=running] { background: var(--ad-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ad-accent) 25%, transparent); }
.aidrama-dot[data-status=stale] { background: var(--ad-warn); }
.aidrama-dot[data-status=failed] { background: var(--ad-err); }

/* --------------------------------------------------------------- *
 * PROGRESS RING.
 *
 * Pure CSS: a conic-gradient sweep masked to a ring by a radial-gradient.
 * Used on every stage card, which is what makes the pipeline read as a
 * production tracker instead of a row of buttons.
 *
 * Two details matter for legibility, both learned from the first screenshot:
 *   - a thicker band (5px, not 3px) so the arc is visible at 34px;
 *   - the fill starts at 12 o'clock (from -90deg) and 0% renders as a full
 *     track rather than nothing, so an empty stage still looks intentional.
 * --------------------------------------------------------------- */
.aidrama-ring {
  --p: 0;
  --ring-color: var(--ad-accent);
  flex: none; position: relative;
  width: 36px; height: 36px; border-radius: 50%;
  background: conic-gradient(from -90deg, var(--ring-color) calc(var(--p) * 1%), var(--ad-surface-3) 0);
  -webkit-mask: radial-gradient(farthest-side, #0000 calc(100% - 5px), #000 calc(100% - 4px));
  mask: radial-gradient(farthest-side, #0000 calc(100% - 5px), #000 calc(100% - 4px));
  display: inline-flex; align-items: center; justify-content: center;
}
.aidrama-ring[data-tone=ok] { --ring-color: var(--ad-ok); }
.aidrama-ring[data-tone=warn] { --ring-color: var(--ad-warn); }
.aidrama-ring[data-tone=err] { --ring-color: var(--ad-err); }
/* The mask would hide any label, so the number rides OUTSIDE the masked layer
   via a sibling, not a child. */
.aidrama-ringWrap { flex: none; display: flex; flex-direction: column; align-items: center; gap: 3px; }
.aidrama-ringPct {
  font-family: var(--ad-mono); font-size: 9.5px; color: var(--ad-text-3);
  font-variant-numeric: tabular-nums;
}

/* --------------------------------------------------------------- *
 * DASHBOARD.
 * --------------------------------------------------------------- */
.aidrama-hero {
  position: relative; overflow: hidden;
  border-radius: 14px; border: 1px solid var(--ad-border);
  margin-bottom: 14px; min-height: 132px;
  display: flex; align-items: flex-end;
  background: linear-gradient(120deg, #12141A 0%, #1A1D26 55%, #241C2E 100%);
}
.aidrama-heroArt {
  position: absolute; inset: 0;
  background-size: cover; background-position: center 42%;
  opacity: .55;
}
.aidrama-heroScrim {
  position: absolute; inset: 0;
  background: linear-gradient(90deg, rgba(10,11,14,.94) 0%, rgba(10,11,14,.72) 46%, rgba(10,11,14,.12) 100%);
}
.aidrama-heroBody { position: relative; padding: 16px 18px; }
.aidrama-heroTitle { font-size: 19px; font-weight: 700; letter-spacing: -.015em; margin: 5px 0 4px; }
.aidrama-heroSub { font-size: 12px; color: var(--ad-text-2); max-width: 62ch; line-height: 1.6; }
.aidrama-heroChips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }

.aidrama-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 9px; margin-bottom: 14px; }
.aidrama-kpi {
  border: 1px solid var(--ad-border); background: var(--ad-surface);
  border-radius: 11px; padding: 10px 11px;
}
.aidrama-kpiValue {
  font-family: var(--ad-mono); font-size: 19px; font-weight: 600; line-height: 1.1;
  font-variant-numeric: tabular-nums; letter-spacing: -.02em;
}
.aidrama-kpiValue small { font-size: 11.5px; color: var(--ad-text-3); font-weight: 500; }
.aidrama-kpiLabel { margin-top: 4px; font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--ad-text-3); }
.aidrama-kpiBar { margin-top: 7px; height: 3px; border-radius: 999px; background: var(--ad-surface-3); overflow: hidden; }
.aidrama-kpiBar i { display: block; height: 100%; border-radius: 999px; background: var(--ad-accent); }

/* Stage cards — the pipeline, as content rather than navigation. */
.aidrama-stageGrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(238px, 1fr)); gap: 10px; margin-bottom: 14px; }
.aidrama-stageCard {
  position: relative; text-align: left; cursor: pointer; font: inherit; color: inherit;
  border: 1px solid var(--ad-border); background: var(--ad-surface);
  border-radius: 12px; padding: 12px; display: flex; gap: 11px; align-items: flex-start;
  transition: border-color 130ms ease, transform 130ms ease, box-shadow 130ms ease, opacity 130ms ease;
}
.aidrama-stageCard:hover { border-color: var(--ad-border-strong); transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,.35); }
.aidrama-stageCard[data-active] { border-color: color-mix(in srgb, var(--ad-accent) 60%, transparent); box-shadow: inset 3px 0 0 var(--ad-accent); }
/* Future stages recede: an instant read of "where am I in the pipeline". */
.aidrama-stageCard[data-future] { opacity: .58; }
.aidrama-stageCard[data-future]:hover { opacity: .82; }
.aidrama-stageIcon {
  flex: none; width: 34px; height: 34px; border-radius: 10px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--ad-surface-3); color: var(--ad-text-2);
}
.aidrama-stageCard[data-active] .aidrama-stageIcon { background: color-mix(in srgb, var(--ad-accent) 20%, transparent); color: var(--ad-accent); }
.aidrama-stageCard[data-state=done] .aidrama-stageIcon { background: color-mix(in srgb, var(--ad-ok) 17%, transparent); color: var(--ad-ok); }
.aidrama-stageName { font-size: 13px; font-weight: 620; display: flex; align-items: center; gap: 6px; }
.aidrama-stageMeta { margin-top: 3px; font-size: 11px; color: var(--ad-text-3); line-height: 1.5; }
.aidrama-stageNo {
  font-family: var(--ad-mono); font-size: 10px; color: var(--ad-text-3);
  border: 1px solid var(--ad-border); border-radius: 4px; padding: 1px 4px;
}

/* Section headers inside the panel. */
.aidrama-sec { display: flex; align-items: center; gap: 8px; margin: 16px 0 9px; }
.aidrama-secTitle { font-size: 12.5px; font-weight: 650; }
.aidrama-secRule { flex: 1; height: 1px; background: var(--ad-border); }
.aidrama-secCount { font-family: var(--ad-mono); font-size: 11px; color: var(--ad-text-3); }

.aidrama-panel { flex: 1; overflow-y: auto; padding: 16px; min-height: 0; }
.aidrama-panel h3 { margin: 0 0 10px; font-size: 14.5px; font-weight: 650; letter-spacing: .01em; }
.aidrama-card {
  border: 1px solid var(--ad-border);
  background: var(--ad-surface);
  border-radius: 12px; padding: 13px; margin-bottom: 12px;
}
.aidrama-card h4 { margin: 0 0 8px; font-size: 13px; font-weight: 650; }
.aidrama-hint { color: var(--ad-text-3); font-size: 11.5px; line-height: 1.6; margin: 6px 0 0; }
.aidrama-pre {
  margin: 6px 0 0; padding: 9px 10px; max-height: 240px; overflow: auto;
  background: var(--ad-bg);
  border: 1px solid var(--ad-border);
  border-radius: 8px; font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word;
  font-family: var(--ad-mono);
}
.aidrama-textarea {
  width: 100%; min-height: 190px; box-sizing: border-box; resize: vertical;
  border: 1px solid var(--ad-border-strong);
  background: var(--ad-surface-2);
  color: var(--ad-text);
  font: inherit; font-size: 12px; line-height: 1.6; border-radius: 9px; padding: 9px 11px;
}
.aidrama-textarea:focus-visible { outline: 2px solid var(--ad-accent); outline-offset: 1px; }
/* .aidrama-input lives in the FORM EDITOR block below — defined once, there. */
.aidrama-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.aidrama-btn {
  cursor: pointer; font: inherit; font-size: 12px; border-radius: 8px; padding: 6px 13px;
  border: 1px solid var(--ad-border-strong);
  background: var(--ad-surface);
  color: var(--ad-text);
  transition: border-color 120ms ease, background 120ms ease, color 120ms ease, box-shadow 120ms ease;
}
.aidrama-btn:hover:not(:disabled) {
  border-color: var(--ad-accent);
  color: var(--ad-accent);
  background: color-mix(in srgb, var(--ad-accent) 7%, var(--ad-surface));
}
.aidrama-btn:focus-visible { outline: 2px solid var(--ad-accent); outline-offset: 1px; }
.aidrama-btn:active:not(:disabled) { transform: translateY(.5px); }
.aidrama-btn:disabled { opacity: .5; cursor: default; }
.aidrama-btn[data-variant=primary] {
  border-color: transparent; color: #fff;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--ad-accent) 92%, #fff),
    var(--ad-accent));
  box-shadow: 0 1px 2px rgba(0,0,0,.14);
}
.aidrama-btn[data-variant=primary]:hover:not(:disabled) { color: #fff; filter: brightness(1.06); }
.aidrama-btn[data-variant=danger]:hover:not(:disabled) { border-color: var(--ad-err); color: var(--ad-err); }

.aidrama-error {
  border: 1px solid color-mix(in srgb, var(--ad-err) 55%, transparent);
  background: color-mix(in srgb, var(--ad-err) 9%, transparent);
  color: var(--ad-err);
  border-radius: 9px; padding: 9px 11px; margin: 8px 0 0; font-size: 12px; line-height: 1.6; word-break: break-word;
}
.aidrama-ok {
  border: 1px solid color-mix(in srgb, var(--ad-ok) 55%, transparent);
  background: color-mix(in srgb, var(--ad-ok) 9%, transparent);
  color: var(--ad-ok);
  border-radius: 9px; padding: 9px 11px; margin: 8px 0 0; font-size: 12px;
}
.aidrama-loading { color: var(--ad-text-3); font-size: 12px; padding: 8px 0; }
.aidrama-empty { color: var(--ad-text-3); font-size: 12.5px; padding: 22px 4px; text-align: center; line-height: 1.7; }

/* Cap the track width so two assets on a wide panel do not stretch into huge
   slabs. auto-fill alone grows each track to share all the free space. */
.aidrama-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 190px));
  gap: 11px;
  justify-content: start;
}
.aidrama-thumb {
  border: 1px solid var(--ad-border);
  background: var(--ad-surface);
  border-radius: 11px; padding: 7px; display: flex; flex-direction: column; gap: 6px;
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
.aidrama-thumb:hover {
  border-color: var(--ad-accent);
  box-shadow: 0 4px 14px rgba(0,0,0,.11);
  transform: translateY(-1px);
}
.aidrama-thumb img {
  width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 8px;
  background: var(--ad-surface-2); cursor: zoom-in; display: block;
}
.aidrama-thumbName { font-size: 11.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aidrama-thumbMeta { font-family: var(--ad-mono); font-size: 10px; color: var(--ad-text-3); }

/* --------------------------------------------------------------- *
 * ASSET WALL + ASPECT-TRUE PREVIEW FRAMES.
 *
 * Frames always carry the project's real aspect ratio, so an ungenerated shot
 * still looks like a loaded slot in a filmstrip rather than a gap. Letterbox
 * bars and a slug overlay are the cheapest legitimate "cinematic" signal.
 * --------------------------------------------------------------- */
/* Wall cells are capped and use a landscape-ish tile so a 9:16 project does not
   produce enormously tall columns that overflow the panel. */
.aidrama-wall {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(126px, 1fr));
  gap: 10px;
}
.aidrama-wall .aidrama-frame { aspect-ratio: 4 / 3; }
.aidrama-wall .aidrama-frame img { object-fit: cover; object-position: center 30%; }
/* A bare empty slot (no thumbnail chrome around it) still needs the cap. */
.aidrama-wall > .aidrama-frame { aspect-ratio: 4 / 3; }
.aidrama-frame {
  position: relative; overflow: hidden; border-radius: 9px;
  border: 1px solid var(--ad-border);
  background: linear-gradient(160deg, #191C23, #12141A);
  display: flex; align-items: center; justify-content: center;
}
.aidrama-frame[data-ratio="9:16"] { aspect-ratio: 9 / 16; }
.aidrama-frame[data-ratio="16:9"] { aspect-ratio: 16 / 9; }
.aidrama-frame[data-ratio="1:1"] { aspect-ratio: 1 / 1; }
.aidrama-frame[data-ratio="4:3"] { aspect-ratio: 4 / 3; }
.aidrama-frame[data-ratio="3:4"] { aspect-ratio: 3 / 4; }
.aidrama-frame[data-ratio="2:3"] { aspect-ratio: 2 / 3; }
.aidrama-frame[data-ratio="3:2"] { aspect-ratio: 3 / 2; }
.aidrama-frame[data-ratio="21:9"] { aspect-ratio: 21 / 9; }
.aidrama-frame img { width: 100%; height: 100%; object-fit: cover; display: block; }
.aidrama-frame[data-empty] { border-style: dashed; }
.aidrama-frame[data-empty]::after {
  content: attr(data-slug);
  font-family: var(--ad-mono); font-size: 10px; color: var(--ad-text-3);
  letter-spacing: .04em;
}
.aidrama-frame[data-empty]::before {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(to bottom, rgba(0,0,0,.4) 0 5%, transparent 5% 95%, rgba(0,0,0,.4) 95% 100%);
}

/* Shot strip — a mini timeline of proportional shot cells. */
.aidrama-strip { display: flex; gap: 4px; align-items: stretch; height: 40px; margin-top: 9px; }
.aidrama-stripCell {
  position: relative; overflow: hidden; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--ad-border); background: var(--ad-surface-3);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--ad-mono); font-size: 9.5px; color: var(--ad-text-3);
  transition: border-color 120ms ease, transform 120ms ease;
}
.aidrama-stripCell:hover { border-color: var(--ad-accent); transform: translateY(-1px); }
.aidrama-stripCell img { width: 100%; height: 100%; object-fit: cover; }
.aidrama-stripCell[data-active] { border-color: var(--ad-accent); box-shadow: inset 0 -2px 0 var(--ad-accent); }

/* Two-column list + inspector. Turns a stage form into a tool. */
.aidrama-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: 12px; align-items: start; }
@media (max-width: 900px) { .aidrama-split { grid-template-columns: minmax(0, 1fr); } }
.aidrama-listItem {
  display: flex; gap: 9px; align-items: flex-start; width: 100%; text-align: left;
  font: inherit; color: inherit; cursor: pointer;
  border: 1px solid var(--ad-border); background: var(--ad-surface);
  border-radius: 9px; padding: 8px 9px; margin-bottom: 6px;
  transition: border-color 120ms ease, background 120ms ease;
}
.aidrama-listItem:hover { border-color: var(--ad-border-strong); background: var(--ad-surface-2); }
.aidrama-listItem[data-active] {
  border-color: color-mix(in srgb, var(--ad-accent) 55%, transparent);
  background: color-mix(in srgb, var(--ad-accent) 11%, var(--ad-surface));
}
.aidrama-inspector {
  border: 1px solid var(--ad-border); background: var(--ad-surface);
  border-radius: 12px; padding: 12px; position: sticky; top: 0;
}
.aidrama-kv { display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 5px 9px; font-size: 11.5px; margin-top: 9px; }
.aidrama-kvKey { color: var(--ad-text-3); }
.aidrama-kvVal { color: var(--ad-text); line-height: 1.55; word-break: break-word; }

/* Empty state: illustration + one action + starter chips, never blank. */
.aidrama-empty { text-align: center; padding: 26px 18px; border: 1px dashed var(--ad-border); border-radius: 12px; }
.aidrama-emptyIcon {
  width: 46px; height: 46px; margin: 0 auto 11px; border-radius: 13px;
  display: flex; align-items: center; justify-content: center;
  background: var(--ad-surface-3); color: var(--ad-accent);
}
.aidrama-emptyTitle { font-size: 13.5px; font-weight: 650; }
.aidrama-emptyText { font-size: 11.5px; color: var(--ad-text-3); margin: 6px auto 12px; max-width: 46ch; line-height: 1.6; }
.aidrama-emptyChips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }

/* Keyboard hint bar — pinned footer. */
.aidrama-hints {
  flex: none; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 7px 14px; border-top: 1px solid var(--ad-border);
  background: var(--ad-surface); font-size: 10.5px; color: var(--ad-text-3);
}
.aidrama-hints kbd {
  font-family: var(--ad-mono); font-size: 10px; padding: 1.5px 5px; border-radius: 4px;
  border: 1px solid var(--ad-border-strong); background: var(--ad-surface-3); color: var(--ad-text-2);
}

.aidrama-target {
  border: 1px solid var(--ad-border);
  background: var(--ad-surface-2);
  border-radius: 10px; padding: 9px; margin-bottom: 7px;
}
.aidrama-targetHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.aidrama-targetName { font-weight: 600; font-size: 12.5px; }
.aidrama-tag {
  font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
  background: var(--ad-surface-3);
  color: var(--ad-text-2);
}
.aidrama-shot {
  border: 1px solid var(--ad-border);
  background: var(--ad-surface-2);
  border-radius: 10px; padding: 9px; margin-bottom: 8px;
}
.aidrama-shotHead { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 6px; }
.aidrama-shotNo { font-weight: 650; font-size: 12px; }
.aidrama-shotMeta { font-size: 11px; color: var(--ad-text-3); }
.aidrama-shotBody { font-size: 12px; line-height: 1.65; color: var(--ad-text); white-space: pre-wrap; word-break: break-word; }
.aidrama-dialog { margin-top: 5px; font-size: 12px; line-height: 1.65; color: var(--ad-text-2); white-space: pre-wrap; }

.aidrama-episode { margin-bottom: 12px; }
.aidrama-episodeTitle { font-weight: 650; font-size: 13px; margin-bottom: 6px; }
.aidrama-sceneGroup { margin: 0 0 9px 10px; padding-left: 9px; border-left: 2px solid var(--ad-border); }
.aidrama-sceneTitle { font-size: 12px; color: var(--ad-text-2); margin-bottom: 5px; }

.aidrama-lightbox {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.82); padding: 30px; cursor: zoom-out;
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.aidrama-lightbox img, .aidrama-lightbox video { max-width: 100%; max-height: 100%; border-radius: 12px; cursor: default; box-shadow: 0 24px 64px rgba(0,0,0,.5); }
.aidrama-lightboxClose {
  position: absolute; top: 16px; right: 18px; width: 36px; height: 36px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center; padding: 0;
  border: 1px solid rgba(255,255,255,.32); background: rgba(255,255,255,.14); color: #fff;
  cursor: pointer;
}
.aidrama-lightboxClose:hover { background: rgba(255,255,255,.26); }
.aidrama-lightboxClose:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.aidrama-caption { position: absolute; left: 0; right: 0; bottom: 14px; text-align: center; color: #fff; font-size: 12px; opacity: .9; }

.aidrama-menuBtn { position: relative; }
.aidrama-menu {
  position: absolute; top: 100%; right: 0; z-index: 20; margin-top: 5px; min-width: 168px;
  border: 1px solid var(--ad-border-strong);
  background: var(--ad-surface);
  border-radius: 10px; padding: 4px; box-shadow: 0 8px 26px rgba(0,0,0,.18);
}
.aidrama-menu button {
  display: block; width: 100%; text-align: left; cursor: pointer; font: inherit; font-size: 12px;
  border: 0; border-radius: 7px; padding: 7px 10px;
  background: transparent; color: var(--ad-text);
}
.aidrama-menu button:hover { background: var(--ad-surface-3); }

.aidrama-channels { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 9px; }
.aidrama-channel {
  border: 1px solid var(--ad-border);
  background: var(--ad-surface-2);
  border-radius: 10px; padding: 9px;
}
.aidrama-channelName { font-weight: 600; font-size: 12.5px; margin-bottom: 3px; }
.aidrama-channelUrl { font-size: 11px; color: var(--ad-text-3); word-break: break-all; }
.aidrama-kv { display: flex; gap: 6px; font-size: 11.5px; color: var(--ad-text-2); margin-top: 4px; }

/* --------------------------------------------------------------- *
 * FORM EDITOR.
 * The workbench used to show read-only cards and one raw JSON box, so a
 * stage could be inspected but not worked in. These are the real inputs.
 * --------------------------------------------------------------- */
.aidrama-formCard { display: flex; flex-direction: column; gap: 14px; }

/* ---- Step 1: ask ONE question, offer choices, do not demand a form ---- */
.aidrama-primary { display: flex; flex-direction: column; gap: 7px; }
.aidrama-primaryLabel { font-size: 15px; font-weight: 620; color: var(--ad-text); }
.aidrama-primaryInput {
  font-size: 14px; line-height: 1.7; min-height: 96px;
  background: color-mix(in srgb, var(--ad-surface-2) 80%, transparent);
}
.aidrama-choice { display: flex; flex-direction: column; gap: 7px; }
.aidrama-choiceLabel { font-size: 12.5px; font-weight: 560; color: var(--ad-text-2); }
.aidrama-choiceRow { display: flex; flex-wrap: wrap; gap: 7px; }
.aidrama-chipBtn {
  cursor: pointer; font: inherit; font-size: 12.5px;
  padding: 6px 13px; border-radius: 999px;
  border: 1px solid var(--ad-border-strong);
  background: var(--ad-surface); color: var(--ad-text-2);
  transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
}
.aidrama-chipBtn:hover { border-color: var(--ad-accent); color: var(--ad-text); }
.aidrama-chipBtn[data-on="true"] {
  border-color: transparent; color: #fff;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--ad-accent) 92%, #fff),
    var(--ad-accent));
}
.aidrama-chipBtn[data-on="true"]:hover { color: #fff; }
.aidrama-draftRow {
  display: flex; align-items: center; gap: 11px; flex-wrap: wrap;
  padding: 12px; border-radius: 10px;
  border: 1px dashed color-mix(in srgb, var(--ad-accent) 40%, transparent);
  background: color-mix(in srgb, var(--ad-accent) 6%, transparent);
}
.aidrama-draftRow .aidrama-fieldHint { flex: 1; min-width: 200px; }

/* Detail fields stay folded away until wanted. */
.aidrama-detailFields { margin-top: 2px; }
.aidrama-detailFields > summary {
  font-size: 13px; color: var(--ad-text-2); font-weight: 520;
  padding: 13px 14px;
}
.aidrama-detailFields > summary:hover { color: var(--ad-text); }
.aidrama-detailFields[open] > summary { color: var(--ad-text); }
.aidrama-detailFields > *:not(summary) { margin: 0 14px 14px; }
.aidrama-detailFields { display: flex; flex-direction: column; gap: 12px; }
.aidrama-detailFields > summary { order: -1; }
.aidrama-formHelp {
  font-size: 12.5px; color: var(--ad-text-2); line-height: 1.6;
  padding-bottom: 10px; border-bottom: 1px solid var(--ad-border);
}

/* One labelled control. */
.aidrama-field { display: flex; flex-direction: column; gap: 5px; }
.aidrama-fieldLabel {
  display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap;
  font-size: 12.5px; font-weight: 560; color: var(--ad-text);
}
.aidrama-fieldLabel .aidrama-fieldHint { font-weight: 400; }
.aidrama-req {
  font-size: 10px; font-weight: 500; letter-spacing: .02em;
  color: var(--ad-warn); border: 1px solid color-mix(in srgb, var(--ad-warn) 40%, transparent);
  border-radius: 5px; padding: 0 5px; line-height: 15px;
}
.aidrama-fieldHint { font-size: 11.5px; color: var(--ad-text-2); line-height: 1.55; }

.aidrama-input {
  width: 100%; box-sizing: border-box; font: inherit; font-size: 13px;
  color: var(--ad-text); background: var(--ad-surface-2);
  border: 1px solid var(--ad-border-strong); border-radius: 8px;
  padding: 8px 11px; resize: vertical; line-height: 1.55;
  transition: border-color 120ms ease, box-shadow 120ms ease;
}
.aidrama-input::placeholder { color: var(--ad-text-3); }
.aidrama-input:hover { border-color: color-mix(in srgb, var(--ad-accent) 34%, var(--ad-border-strong)); }
.aidrama-input:focus {
  outline: none; border-color: var(--ad-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ad-accent) 16%, transparent);
}
select.aidrama-input { cursor: pointer; }

/* Repeatable groups: 幕 / 人物 / 集 / 场 / 镜. */
.aidrama-group {
  border: 1px solid var(--ad-border); border-radius: 12px;
  padding: 12px; display: flex; flex-direction: column; gap: 10px;
  background: color-mix(in srgb, var(--ad-surface) 60%, transparent);
}
.aidrama-group[data-depth="1"] { background: transparent; border-style: dashed; }
.aidrama-group[data-depth="2"] { background: transparent; border-style: dotted; padding: 10px; }
.aidrama-groupHead { display: flex; align-items: baseline; gap: 9px; }
.aidrama-groupTitle { font-size: 13px; font-weight: 620; color: var(--ad-text); }
.aidrama-groupCount { font-size: 11.5px; color: var(--ad-text-2); }
.aidrama-groupEmpty {
  font-size: 12px; color: var(--ad-text-2); padding: 12px; text-align: center;
  border: 1px dashed var(--ad-border-strong); border-radius: 9px;
}

.aidrama-item {
  border: 1px solid var(--ad-border); border-radius: 10px; padding: 12px;
  display: flex; flex-direction: column; gap: 11px; background: var(--ad-surface);
}
.aidrama-itemHead { display: flex; align-items: center; gap: 8px; }
.aidrama-itemNo {
  font-size: 11px; font-weight: 620; color: var(--ad-accent);
  background: color-mix(in srgb, var(--ad-accent) 12%, transparent);
  border-radius: 5px; padding: 1px 7px;
}
.aidrama-itemTitle {
  font-size: 12.5px; color: var(--ad-text); font-weight: 520;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46%;
}
.aidrama-itemTools { margin-left: auto; display: flex; gap: 4px; }
.aidrama-itemTools .aidrama-btn { padding: 3px 8px; font-size: 11.5px; }

/* Step heading + save bar. Sticky at the top of the form so the primary
   action is reachable without scrolling to the bottom of a long stage. */
.aidrama-stepNo {
  font-size: 11px; letter-spacing: .04em; color: var(--ad-text-2);
  font-variant-numeric: tabular-nums;
}
.aidrama-stepTitle { margin: 0; font-size: 17px; font-weight: 640; color: var(--ad-text); }
.aidrama-saveBar {
  position: sticky; top: -1px; z-index: 2;
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 10px 0 12px; margin: -2px 0 0;
  border-bottom: 1px solid var(--ad-border);
  background: var(--ad-surface);
}
.aidrama-saveMeta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.aidrama-saveActions {
  margin-left: auto; display: flex; align-items: center; gap: 9px; flex-wrap: wrap;
}
.aidrama-dirty {
  font-size: 11.5px; color: var(--ad-warn);
  display: inline-flex; align-items: center; gap: 5px;
}
.aidrama-dirty::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%;
  background: var(--ad-warn);
}

/* Secondary reference views collapse away by default. */
.aidrama-details {
  border: 1px solid var(--ad-border); border-radius: 12px;
  background: color-mix(in srgb, var(--ad-surface) 55%, transparent);
}
.aidrama-details > summary {
  cursor: pointer; padding: 11px 14px; font-size: 12.5px;
  color: var(--ad-text-2); user-select: none; list-style: none;
}
.aidrama-details > summary::marker { content: ""; }
.aidrama-details > summary::before { content: "▸ "; color: var(--ad-text-3); }
.aidrama-details[open] > summary::before { content: "▾ "; }
.aidrama-details > summary:hover { color: var(--ad-text); }
.aidrama-details[open] > summary { border-bottom: 1px solid var(--ad-border); }
.aidrama-details > *:not(summary) { margin: 12px 14px; }

`

    /** Inject the stylesheet once, tagged so the shell's HMR bookkeeping owns it. */
    const injectCss = () => {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-aidrama'
      tag.dataset.pluginCss = 'dsh-aidrama/workbench'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        try {
          tag.remove()
        } catch {
          /* already detached */
        }
      }
    }

    /* ---------------------------------------------------------------- *
     * Minimal DOM builder. Everything user- or model-derived goes through
     * `textContent`, never innerHTML.
     * ---------------------------------------------------------------- */

    /**
     * @param {string} tag
     * @param {object} [props] `class`, `text`, `dataset`, `attrs`, `on`, `style`
     * @param {Array<Node|null|undefined>} [children]
     */
    const el = (tag, props = {}, children = []) => {
      const node = document.createElement(tag)
      if (props.class !== undefined) node.className = props.class
      if (props.text !== undefined) node.textContent = str(props.text)
      if (isRecord(props.dataset)) {
        for (const [key, value] of Object.entries(props.dataset)) node.dataset[key] = str(value)
      }
      if (isRecord(props.attrs)) {
        for (const [key, value] of Object.entries(props.attrs)) node.setAttribute(key, str(value))
      }
      if (isRecord(props.on)) {
        for (const [name, handler] of Object.entries(props.on)) {
          if (typeof handler === 'function') node.addEventListener(name, handler)
        }
      }
      for (const child of children) {
        if (child !== null && child !== undefined) node.appendChild(child)
      }
      return node
    }

    const button = (label, onClick, options = {}) => el('button', {
      class: 'aidrama-btn',
      text: label,
      attrs: { type: 'button', ...(options.variant !== undefined ? { 'data-variant': options.variant } : {}) },
      on: { click: onClick },
    })

    /**
     * Inline SVG icon on a 24x24 grid (Lucide conventions: 2px stroke, round
     * caps and joins). Rendered smaller than 24 in dense UI, where the stroke is
     * thinned to 1.75 so it still reads as a tool rather than a consumer app.
     *
     * Literal markup only — never project content. One icon family, one stroke
     * weight: mixing families is the fastest way to look amateur.
     *
     * @param {Array<string>} paths path `d` strings
     * @param {number} [size] rendered px (default 16)
     */
    const icon = (paths, size = 16) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('width', String(size))
      svg.setAttribute('height', String(size))
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', size >= 20 ? '2' : '1.75')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('focusable', 'false')
      for (const d of paths) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', d)
        svg.appendChild(path)
      }
      return svg
    }

    /* ---------------------------------------------------------------- *
     * Icon set. Keys are semantic so call sites read as intent.
     * ---------------------------------------------------------------- */
    const ICONS = {
      // The six pipeline stages — the primary icon vocabulary of the tool.
      idea: ['M9 18h6', 'M10 22h4', 'M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z'],
      story: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z', 'M9 7h7', 'M9 11h5'],
      script: ['M3 5.5h18v13H3z', 'M3 5.5l2.6-3 15.8 1.8-.4 1.2', 'M7.4 4.9l1.6-2.7', 'M12.2 5.4l1.6-2.7', 'M4 9.5h16'],
      bible: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z', 'M22 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
      visual: ['M3 3h18v18H3z', 'M8.5 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z', 'M21 15l-5-5L5 21'],
      video: ['M2 6.5h13v11H2z', 'M15 10.5l7-4v11l-7-4z', 'M6 3.5v3', 'M11 3.5v3'],
      settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z'],
      close: ['M18 6L6 18', 'M6 6l12 12'],
      // Actions
      sparkles: ['M12 3l1.9 4.8L18.7 9.7l-4.8 1.9L12 16.4l-1.9-4.8L5.3 9.7l4.8-1.9L12 3Z', 'M19 15l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9.9-2.3Z'],
      plus: ['M12 5v14', 'M5 12h14'],
      download: ['M12 3v12', 'M7.5 10.5L12 15l4.5-4.5', 'M4 20h16'],
      refresh: ['M3 12a9 9 0 0 1 15.5-6.2L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-15.5 6.2L3 16', 'M3 21v-5h5'],
      trash: ['M4 7h16', 'M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2', 'M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13', 'M10 11v6', 'M14 11v6'],
      check: ['M20 6L9 17l-5-5'],
      play: ['M7 4.5l12 7.5-12 7.5z'],
      film: ['M3 4h18v16H3z', 'M3 9h18', 'M3 15h18', 'M8 4v16', 'M16 4v16'],
      users: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z', 'M22 21v-2a4 4 0 0 0-3-3.9'],
      mountain: ['M3 19h18L14 7l-3.5 6-2-3.2L3 19Z', 'M16.5 7.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z'],
      layers: ['M12 2.5l9 4.8-9 4.8-9-4.8 9-4.8Z', 'M3.5 12.5l8.5 4.5 8.5-4.5', 'M3.5 16.8l8.5 4.5 8.5-4.5'],
      camera: ['M3 7.5h3l1.5-2h9L18 7.5h3v11H3z', 'M12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z'],
      timer: ['M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'M12 9v4l2.5 2.5', 'M9 2h6'],
      image: ['M3 3h18v18H3z', 'M8.5 8.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z', 'M21 15l-5-5L5 21'],
      plug: ['M9 3v6', 'M15 3v6', 'M6 9h12v3a6 6 0 0 1-12 0z', 'M12 18v3'],
      alert: ['M12 3.5L21.5 20H2.5L12 3.5Z', 'M12 10v4', 'M12 17.2v.1'],
      clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v5l3 2'],
      chevronRight: ['M9 5l7 7-7 7'],
      copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
      box: ['M12 2.5l9 4.8v9.4l-9 4.8-9-4.8V7.3l9-4.8Z', 'M3 7.3l9 4.8 9-4.8', 'M12 12.1V21.5'],
    }

    /** Render one named icon. */
    const ico = (name, size) => icon(ICONS[name] ?? ICONS.box, size)

    /*
     * Hero artwork for the dashboard band.
     *
     * Inlined as a data URI on purpose: the plugin ships ZERO dependencies and
     * no build step, and the host exposes no static-asset route. A data URI also
     * keeps the panel fully offline and immune to the loopback guard.
     */
    const HERO_ART = 'data:image/jpeg;base64,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'

    const CLAPPER_ICON = ICONS.script
    const CLOSE_ICON = ICONS.close

    /* NOTE — `closeButton` deliberately lives INSIDE `createWorkbench`, not here.
     *
     * An earlier version defined it at module scope and called a bare `close()`.
     * There is no module-scope `close`, so that identifier resolved to the
     * browser's global `window.close()` — clicking the ✕ dismissed the ENTIRE
     * DSH application instead of the workbench panel. A plain reference to an
     * unbound name is not caught by `node --check`, and the DOM-stub suite could
     * not see it either because the stub had no global `close`.
     */

    /* ---------------------------------------------------------------- *
     * Workbench state + view. A plain re-render on every mutation keeps the
     * tree honest without a diffing layer; the panel is small enough that a
     * full repaint is cheaper than the bugs a partial update would hide.
     * ---------------------------------------------------------------- */

    const createWorkbench = (container, host) => {
      const state = {
        open: false,
        loadingProjects: false,
        projectsError: '',
        projects: [],
        projectId: '',
        project: null,
        detailError: '',
        stage: 'idea',
        brief: null,
        briefError: '',
        briefLoading: false,
        draft: '',
        commitError: '',
        commitOk: '',
        generating: false,
        genError: '',
        genOk: '',
        failures: [],
        pack: null,
        packError: '',
        packing: false,
        videoBusy: false,
        videoError: '',
        videoOk: '',
        config: null,
        configError: '',
        configLoading: false,
        lightbox: null,
        menuOpen: false,
        busy: false,
        /** Editable working copy for the active text stage (see STAGE_FORMS). */
        formDraft: null,
        /** True once a field changed, so the save bar can say so. */
        formDirty: false,
        /** The landing page shows the dashboard only when explicitly asked. */
        showDashboard: false,
      }

      let root = null
      let renderQueued = false

      /** Schedule one repaint; coalesces bursts of state writes. */
      const schedule = () => {
        if (renderQueued) return
        renderQueued = true
        try {
          Promise.resolve().then(() => {
            renderQueued = false
            render()
          })
        } catch {
          renderQueued = false
          render()
        }
      }

      const setError = (key, error) => {
        state[key] = error instanceof Error ? error.message : String(error)
      }

      /* --------------------------- data loads --------------------------- */

      const loadProjects = async () => {
        state.loadingProjects = true
        state.projectsError = ''
        schedule()
        try {
          const projects = await api.listProjects()
          state.projects = Array.isArray(projects) ? projects : []
          if (state.projectId !== '' && !state.projects.some(p => str(p.id) === state.projectId)) {
            state.projectId = ''
            state.project = null
          }
        } catch (error) {
          setError('projectsError', error)
          state.projects = []
        } finally {
          state.loadingProjects = false
          schedule()
        }
      }

      const loadProject = async (id) => {
        if (str(id) === '') return
        state.projectId = str(id)
        state.detailError = ''
        state.failures = []
        state.commitError = ''
        state.commitOk = ''
        state.genError = ''
        state.genOk = ''
        schedule()
        try {
          const body = await api.getProject(str(id))
          state.project = body.project ?? null
          state.draft = ''
          state.brief = null
          // Land DIRECTLY on the step that needs work — not on an overview.
          // Opening a project used to force `stage = 'home'`, which is why the
          // workbench felt like a report you could only read.
          if (state.stage !== 'settings') {
            state.stage = nextEditableStageOf(state.project)
            state.formDraft = null
            state.formDirty = false
          }
          if (state.project !== null) {
            state.draft = prettyJson(currentStageContent())
          }
        } catch (error) {
          setError('detailError', error)
          state.project = null
        } finally {
          schedule()
        }
      }

      /**
       * Which stage should the user be working in?
       *
       * The first text stage whose status is not `ready`; if all four are done,
       * the visual stage, then video. "Start" therefore always means the next
       * thing that actually needs a human.
       */
      const nextEditableStageOf = (project) => {
        const stages = project !== null && isRecord(project.stages) ? project.stages : {}
        for (const id of TEXT_STAGE_IDS) {
          if (str(stages[id]?.status) !== STAGE_STATUS.ready) return id
        }
        if (str(stages.visual?.status) !== STAGE_STATUS.ready) return 'visual'
        if (str(stages.video?.status) !== STAGE_STATUS.ready) return 'video'
        return 'idea'
      }

      const currentStageContent = () => {
        const project = state.project
        if (project === null || !isRecord(project.content)) return null
        return project.content[state.stage] ?? null
      }

      /** The project's own stage rail, else a synthesized one for six rows. */
      const stageRows = () => {
        const project = state.project
        const view = project !== null && Array.isArray(project.stages) ? project.stages : null
        if (view !== null && view.length > 0) return view
        const map = project !== null && isRecord(project.stages) ? project.stages : {}
        return STAGE_IDS.map(id => {
          const entry = isRecord(map[id]) ? map[id] : {}
          return {
            id,
            label: STAGE_LABEL[id],
            short: STAGE_SHORT[id],
            status: str(entry.status) || STAGE_STATUS.empty,
            revision: Number(entry.revision) || 0,
            note: str(entry.note),
            ready: str(entry.status) === STAGE_STATUS.ready,
            blocked: false,
          }
        })
      }

      const loadBrief = async () => {
        if (state.projectId === '' || !TEXT_STAGE_IDS.includes(state.stage)) {
          state.brief = null
          state.briefError = ''
          state.briefLoading = false
          schedule()
          return
        }
        state.briefLoading = true
        state.briefError = ''
        schedule()
        try {
          state.brief = await api.brief(state.projectId, state.stage)
        } catch (error) {
          setError('briefError', error)
          state.brief = null
        } finally {
          state.briefLoading = false
          schedule()
        }
      }

      const loadConfig = async () => {
        state.configLoading = true
        state.configError = ''
        schedule()
        try {
          state.config = await api.config()
        } catch (error) {
          setError('configError', error)
          state.config = null
        } finally {
          state.configLoading = false
          schedule()
        }
      }

      /* --------------------------- actions --------------------------- */

      const open = () => {
        state.open = true
        schedule()
        if (state.projects.length === 0 && state.projectsError === '' && !state.loadingProjects) void loadProjects()
        if (state.config === null && state.configError === '' && !state.configLoading) void loadConfig()
      }

      const close = () => {
        state.open = false
        state.lightbox = null
        state.menuOpen = false
        schedule()
      }

      /**
       * The header dismiss control.
       *
       * Must be defined HERE, in scope of the workbench's own `close`. Rendered
       * as an ICON rather than the word 「关闭」 because a text label at the same
       * weight as 设置 / 导出 read as a peer action instead of the way out.
       *
       * `event.stopPropagation()` also matters: the overlay's scrim handler
       * closes on any click whose target IS the overlay, and without this the
       * click would bubble into that path as well.
       */
      const closeButton = () => el('button', {
        class: 'aidrama-iconBtn',
        attrs: { type: 'button', 'aria-label': '关闭', title: '关闭（Esc）' },
        on: { click: (event) => { event.stopPropagation(); close() } },
      }, [icon(CLOSE_ICON)])

      const createProject = async () => {
        if (state.busy) return
        state.busy = true
        state.projectsError = ''
        schedule()
        try {
          const project = await api.createProject({ title: '未命名短剧' })
          await loadProjects()
          await loadProject(str(project?.id))
        } catch (error) {
          setError('projectsError', error)
        } finally {
          state.busy = false
          schedule()
        }
      }

      const removeProject = async (id) => {
        if (state.busy) return
        state.busy = true
        schedule()
        try {
          await api.deleteProject(id)
          if (state.projectId === str(id)) {
            state.projectId = ''
            state.project = null
          }
          await loadProjects()
        } catch (error) {
          setError('projectsError', error)
        } finally {
          state.busy = false
          schedule()
        }
      }

      const selectStage = (id) => {
        state.stage = id
        state.commitError = ''
        state.commitOk = ''
        state.genError = ''
        state.genOk = ''
        state.menuOpen = false
        state.draft = prettyJson(currentStageContent())
        // Re-seed the form for the newly selected stage. Any unsaved edits in
        // the previous stage are dropped — the draft is per-stage, and quietly
        // carrying them across would corrupt the next stage's shape.
        state.formDraft = null
        state.formDirty = false
        schedule()
        // Only the six real stages have a brief; 'home' and 'settings' do not,
        // and asking for one would surface a spurious error.
        if (STAGE_IDS.indexOf(id) !== -1) void loadBrief()
      }

      const commitDraft = async () => {
        if (state.busy) return
        state.commitError = ''
        state.commitOk = ''
        let payload
        try {
          payload = parseStageJson(state.draft)
        } catch (error) {
          setError('commitError', error)
          schedule()
          return
        }
        state.busy = true
        schedule()
        try {
          const project = await api.commit(state.projectId, state.stage, payload, '')
          state.project = project ?? state.project
          state.commitOk = '已提交，阶段状态已更新'
          state.draft = prettyJson(currentStageContent())
          await loadProjects()
        } catch (error) {
          setError('commitError', error)
        } finally {
          state.busy = false
          schedule()
        }
      }

      /**
       * Mark the current stage as needing regeneration.
       *
       * The button called a `markRerun` that was NEVER DECLARED anywhere in the
       * file, so clicking it threw `ReferenceError: markRerun is not defined`.
       * The host route and the `api.rerun` wrapper both already existed — only
       * the wiring was missing.
       */
      const markRerun = async () => {
        if (state.busy) return
        state.busy = true
        state.commitError = ''
        state.commitOk = ''
        schedule()
        try {
          const project = await api.rerun(state.projectId, state.stage)
          state.project = project ?? state.project
          state.commitOk = '已标记为重新生成'
          await loadProjects()
        } catch (error) {
          setError('commitError', error)
        } finally {
          state.busy = false
          schedule()
        }
      }

      /** Build the paste-ready instruction handed to the conversational model. */
      const instructionText = () => {
        const brief = isRecord(state.brief) ? state.brief : {}
        const parts = [`请为短剧项目完成「${STAGE_LABEL[state.stage] ?? state.stage}」阶段。`]
        if (str(brief.system) !== '') parts.push('', '【系统要求】', str(brief.system))
        if (str(brief.task) !== '') parts.push('', '【任务】', str(brief.task))
        if (str(brief.schema) !== '') parts.push('', '【输出 JSON 契约】', str(brief.schema))
        parts.push('', '请只返回符合上述契约的 JSON，不要附加解释文字。')
        return parts.join('\n')
      }

      const copyInstruction = async () => {
        const source = instructionText()
        try {
          if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(source)
            state.commitOk = '已复制给对话模型，可直接粘贴'
            state.commitError = ''
            schedule()
            return
          }
        } catch {
          /* fall through to the selection fallback */
        }
        try {
          const area = el('textarea', { class: 'aidrama-textarea' })
          area.value = source
          document.body.appendChild(area)
          area.select()
          const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
          area.remove()
          state.commitOk = copied ? '已复制给对话模型' : ''
          state.commitError = copied ? '' : '复制失败：请手动从下方文本框复制'
        } catch {
          state.commitError = '复制失败：请手动从下方文本框复制'
        }
        schedule()
      }

      const runGenerate = async (targets) => {
        if (state.generating) return
        state.generating = true
        state.genError = ''
        state.genOk = ''
        state.failures = []
        schedule()
        try {
          const body = await api.generate(state.projectId, targets)
          const assets = Array.isArray(body.assets) ? body.assets : []
          state.failures = Array.isArray(body.failures) ? body.failures : []
          state.genOk = `生成完成：成功 ${assets.length} 张${state.failures.length > 0 ? `，失败 ${state.failures.length} 个` : ''}`
          await loadProject(state.projectId)
        } catch (error) {
          setError('genError', error)
        } finally {
          state.generating = false
          schedule()
        }
      }

      const loadPack = async () => {
        if (state.packing) return
        state.packing = true
        state.packError = ''
        schedule()
        try {
          state.pack = await api.promptPack(state.projectId)
        } catch (error) {
          setError('packError', error)
          state.pack = null
        } finally {
          state.packing = false
          schedule()
        }
      }

      const refreshVideo = async (taskId) => {
        if (state.videoBusy) return
        state.videoBusy = true
        state.videoError = ''
        schedule()
        try {
          const body = await api.videoStatus(state.projectId, taskId)
          const status = str(body?.task?.status)
          state.videoOk = `任务状态：${status || '未知'}`
          await loadProject(state.projectId)
        } catch (error) {
          setError('videoError', error)
        } finally {
          state.videoBusy = false
          schedule()
        }
      }

      /**
       * Submit the listed shots to the configured video channel.
       *
       * The button referenced a `submitVideo` that was NEVER DECLARED — it only
       * existed as the API client method `api.submitVideo`, so clicking it threw
       * `ReferenceError: submitVideo is not defined`. Same defect class as the ✕
       * button that called the global `window.close()`: a bare identifier that
       * silently resolves to the wrong thing (or nothing).
       */
      const submitVideo = async (shotRefs) => {
        if (state.videoBusy) return
        state.videoBusy = true
        state.videoError = ''
        state.videoOk = ''
        schedule()
        try {
          const body = await api.submitVideo(state.projectId, shotRefs)
          // The route returns { ok, tasks, failures }. When no video channel is
          // configured the upstream call fails per shot and everything lands in
          // `failures`, so reporting only the task count would read as "nothing
          // happened" — surface both sides.
          const tasks = Array.isArray(body?.tasks) ? body.tasks : []
          const failures = Array.isArray(body?.failures) ? body.failures : []
          if (tasks.length > 0 && failures.length === 0) {
            state.videoOk = `已提交 ${tasks.length} 个视频任务`
          } else if (tasks.length > 0) {
            state.videoOk = `已提交 ${tasks.length} 个视频任务，${failures.length} 个失败`
          } else if (failures.length > 0) {
            state.videoError = `提交失败：${str(failures[0]?.message) || '上游拒绝了请求'}`
          } else {
            state.videoOk = '提交完成，但上游没有返回任务'
          }
          await loadProject(state.projectId)
        } catch (error) {
          setError('videoError', error)
        } finally {
          state.videoBusy = false
          schedule()
        }
      }

      const download = (filename, content) => {
        try {
          const blob = new Blob([str(content)], { type: 'text/plain;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = str(filename) || 'aidrama.txt'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          URL.revokeObjectURL(url)
        } catch (error) {
          setError('detailError', error)
          schedule()
        }
      }

      const doExport = async (format) => {
        state.menuOpen = false
        schedule()
        try {
          const body = await api.exportProject(state.projectId, format)
          download(body.filename, body.content)
        } catch (error) {
          setError('detailError', error)
          schedule()
        }
      }

      /* --------------------------- view --------------------------- */

      const renderRail = () => {
        const rail = el('div', { class: 'aidrama-rail' })
        rail.appendChild(el('div', { class: 'aidrama-railHead' }, [
          el('span', { class: 'aidrama-railTitle', text: '项目' }),
        ]))
        rail.appendChild(button('＋ 新建短剧', () => { void createProject() }, { variant: 'primary' }))

        if (state.loadingProjects) {
          rail.appendChild(el('div', { class: 'aidrama-loading', text: '正在加载项目…' }))
        }
        if (state.projectsError !== '') {
          rail.appendChild(el('div', { class: 'aidrama-error', text: state.projectsError }))
          rail.appendChild(button('重试', () => { void loadProjects() }))
        }
        if (!state.loadingProjects && state.projectsError === '' && state.projects.length === 0) {
          rail.appendChild(el('div', { class: 'aidrama-empty', text: '还没有项目，点击「新建短剧」开始。' }))
        }

        for (const project of state.projects) {
          const id = str(project.id)
          const row = el('button', {
            class: 'aidrama-project',
            attrs: { type: 'button', ...(id === state.projectId ? { 'data-active': '' } : {}) },
            on: { click: () => { void loadProject(id) } },
          }, [
            el('div', { class: 'aidrama-projectTitle', text: str(project.title) || '未命名短剧' }),
            el('div', {
              class: 'aidrama-projectMeta',
              text: `${str(project.aspectRatio) || '9:16'} · 资产 ${Number(project.assetCount) || 0} · ${formatTime(project.updatedAt)}`,
            }),
          ])
          rail.appendChild(row)
        }
        return rail
      }

      const renderSteps = () => {
        const bar = el('div', { class: 'aidrama-steps' })
        // An explicit overview entry, so the dashboard is a place you can return
        // to rather than only the initial screen.
        bar.appendChild(el('button', {
          class: 'aidrama-step',
          attrs: {
            type: 'button',
            title: '总览 — 项目概览与生产流程',
            ...(state.stage === 'home' ? { 'data-active': '' } : {}),
          },
          on: { click: () => selectStage('home') },
        }, [
          el('span', { class: 'aidrama-stepNum' }, [ico('layers', 12)]),
          el('span', { text: '总览' }),
        ]))

        let index = 0
        for (const row of stageRows()) {
          const id = str(row.id)
          const status = str(row.status) || STAGE_STATUS.empty
          index += 1
          const step = el('button', {
            class: 'aidrama-step',
            attrs: { type: 'button', title: `${str(row.label) || id} — ${STATUS_TEXT[status] ?? status}`, ...(id === state.stage ? { 'data-active': '' } : {}) },
            on: { click: () => selectStage(id) },
          }, [
            // A numbered badge plus a status dot: the number communicates
            // ORDER (this is a six-step pipeline), the dot communicates STATE.
            // Pills alone conveyed neither.
            el('span', { class: 'aidrama-stepNum', text: String(index) }),
            el('span', { text: str(row.short) || STAGE_SHORT[id] || id }),
            el('span', { class: 'aidrama-dot', dataset: { status } }),
          ])
          bar.appendChild(step)
        }
        return bar
      }

      /* ---------------------------------------------------------------- *
       * Dashboard pieces.
       *
       * The rule every block below follows: it must expose a REAL state or a
       * REAL count. Anything that cannot is decoration, and decoration is what
       * makes a tool read as empty.
       * ---------------------------------------------------------------- */

      /** Count of generated image assets, per kind. */
      const assetCounts = () => {
        const assets = Array.isArray(state.project?.assets) ? state.project.assets : []
        const by = { character: 0, scene: 0, shot: 0, other: 0 }
        for (const asset of assets) {
          const kind = str(asset?.kind)
          if (kind === ASSET_KIND.characterSheet) by.character += 1
          else if (kind === ASSET_KIND.sceneMaster) by.scene += 1
          else if (kind === ASSET_KIND.shotRef) by.shot += 1
          else by.other += 1
        }
        return { total: assets.length, ...by }
      }

      /** How many of a collection exist, tolerating either shape. */
      const countOf = (value) => (Array.isArray(value) ? value.length : 0)

      /** Total screen time in seconds implied by the script. */
      const totalSeconds = () => {
        const shots = flattenShotsForUi()
        const per = Number(state.project?.shotSeconds) || 5
        return shots.reduce((sum, shot) => {
          const d = Number(shot?.durationSeconds)
          return sum + (Number.isFinite(d) && d > 0 ? d : per)
        }, 0)
      }

      /** mm:ss — mono timecodes are an authenticity tell, every NLE has them. */
      const timecode = (seconds) => {
        const s = Math.max(0, Math.round(seconds))
        return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      }

      const sectionHeader = (title, count) => el('div', { class: 'aidrama-sec' }, [
        el('span', { class: 'aidrama-secTitle', text: title }),
        el('span', { class: 'aidrama-secRule' }),
        ...(count === undefined ? [] : [el('span', { class: 'aidrama-secCount', text: String(count) })]),
      ])

      const kpi = (label, value, options = {}) => {
        const box = el('div', { class: 'aidrama-kpi' }, [
          el('div', { class: 'aidrama-kpiValue' }, [
            el('span', { text: String(value) }),
            ...(options.unit ? [el('small', { text: ` ${options.unit}` })] : []),
          ]),
          el('div', { class: 'aidrama-kpiLabel', text: label }),
        ])
        if (Number.isFinite(options.ratio)) {
          const pct = Math.max(0, Math.min(100, Math.round(options.ratio * 100)))
          box.appendChild(el('div', { class: 'aidrama-kpiBar' }, [
            el('i', { attrs: { style: `width:${pct}%` } }),
          ]))
        }
        return box
      }

      /** One stage as a card carrying icon, state, progress ring and a count. */
      const stageCard = (row, index) => {
        const id = str(row.id)
        const status = str(row.status) || STAGE_STATUS.empty
        const done = status === STAGE_STATUS.ready
        const active = id === state.stage
        const counts = assetCounts()
        const shots = flattenShotsForUi().length
        const perStage = {
          [STAGE_IDS[0]]: state.project?.content?.idea ? '已记录想法与卖点' : '还没有想法',
          [STAGE_IDS[1]]: countOf(state.project?.content?.story?.scenes) > 0
            ? `${countOf(state.project.content.story.scenes)} 场`
            : '还没有剧情结构',
          [STAGE_IDS[2]]: shots > 0 ? `${shots} 个镜头 · ${timecode(totalSeconds())}` : '还没有分场脚本',
          [STAGE_IDS[3]]: (() => {
            const bible = state.project?.content?.bible ?? {}
            const c = countOf(bible.characters)
            const s = countOf(bible.scenes)
            return c + s > 0 ? `${c} 人物 · ${s} 场景` : '还没有人物与场景'
          })(),
          [STAGE_IDS[4]]: counts.total > 0
            ? `${counts.total} 张 · 人物 ${counts.character} 场景 ${counts.scene} 分镜 ${counts.shot}`
            : '还没有生成任何图',
          [STAGE_IDS[5]]: countOf(state.project?.videoTasks) > 0
            ? `${countOf(state.project.videoTasks)} 个视频任务`
            : '还没有提交视频',
        }
        const ratio = id === STAGE_IDS[4] && shots > 0
          ? Math.min(1, counts.shot / shots)
          : (done ? 1 : 0)

        return el('button', {
          class: 'aidrama-stageCard',
          attrs: {
            type: 'button',
            title: `${str(row.label) || id} — ${STATUS_TEXT[status] ?? status}`,
            'data-state': done ? 'done' : (status === STAGE_STATUS.empty ? 'todo' : status),
            ...(active ? { 'data-active': '' } : {}),
            // Stages BEYOND the current one recede, so the pipeline reads at a
            // glance without any legend.
            ...(!active && !done && index > stageIndex() ? { 'data-future': '' } : {}),
          },
          on: { click: () => selectStage(id) },
        }, [
          el('span', { class: 'aidrama-stageIcon' }, [ico(id, 18)]),
          el('span', { attrs: { style: 'flex:1;min-width:0' } }, [
            el('span', { class: 'aidrama-stageName' }, [
              el('span', { text: str(row.label) || STAGE_LABEL[id] || id }),
              el('span', { class: 'aidrama-stageNo', text: `0${index}` }),
            ]),
            el('span', { class: 'aidrama-stageMeta', text: perStage[id] ?? '' }),
            el('span', { class: 'aidrama-chips', attrs: { style: 'display:flex;gap:5px;margin-top:7px;flex-wrap:wrap' } }, [
              el('span', {
                class: 'aidrama-chip',
                dataset: { tone: done ? 'ok' : (status === STAGE_STATUS.empty ? '' : 'accent') },
                text: STATUS_TEXT[status] ?? status,
              }),
            ]),
          ]),
          el('span', { class: 'aidrama-ringWrap' }, [
            el('span', {
              class: 'aidrama-ring',
              attrs: { style: `--p:${Math.round(ratio * 100)}` },
              dataset: { tone: done ? 'ok' : '' },
            }),
            el('span', { class: 'aidrama-ringPct', text: `${Math.round(ratio * 100)}%` }),
          ]),
        ])
      }

      const stageIndex = () => Math.max(0, STAGE_IDS.indexOf(state.stage))

      /** The hero band: artwork, title, and the project's real spec chips. */
      const renderHero = () => {
        const project = state.project
        const shots = flattenShotsForUi().length
        const counts = assetCounts()
        const wrap = el('div', { class: 'aidrama-hero' })
        wrap.appendChild(el('div', { class: 'aidrama-heroArt', attrs: { style: `background-image:url('${HERO_ART}')` } }))
        wrap.appendChild(el('div', { class: 'aidrama-heroScrim' }))
        wrap.appendChild(el('div', { class: 'aidrama-heroBody' }, [
          el('div', { class: 'aidrama-eyebrow', text: 'AI 短剧生产工作台' }),
          el('div', { class: 'aidrama-heroTitle', text: str(project?.title) || '未命名短剧' }),
          el('div', {
            class: 'aidrama-heroSub',
            text: str(project?.logline) !== ''
              ? str(project.logline)
              : '从一句想法到成片：梳理想法 → 设计剧情 → 分场脚本 → 设定集 → 视觉资产 → 视频。',
          }),
          el('div', { class: 'aidrama-heroChips' }, [
            el('span', { class: 'aidrama-chip', dataset: { tone: 'accent' }, text: `画幅 ${str(project?.aspectRatio) || '9:16'}` }),
            el('span', { class: 'aidrama-chip', text: `${Number(project?.episodes) || 1} 集` }),
            el('span', { class: 'aidrama-chip', text: `单镜 ${Number(project?.shotSeconds) || 5}s` }),
            el('span', { class: 'aidrama-chip', text: `${shots} 镜 · ${timecode(totalSeconds())}` }),
            el('span', { class: 'aidrama-chip', dataset: { tone: counts.total > 0 ? 'ok' : '' }, text: `已出图 ${counts.total}` }),
          ]),
        ]))
        return wrap
      }

      /** KPI row, then the six stage cards. The "systematic" core. */
      const renderDashboard = () => {
        const shots = flattenShotsForUi().length
        const counts = assetCounts()
        const bible = state.project?.content?.bible ?? {}
        const filled = assetCounts().total
        const block = el('div')

        block.appendChild(renderHero())

        block.appendChild(el('div', { class: 'aidrama-kpis' }, [
          kpi('人物', countOf(bible.characters)),
          kpi('场景', countOf(bible.scenes)),
          kpi('镜头', shots, { unit: '镜' }),
          kpi('总时长', timecode(totalSeconds())),
          kpi('已出图', counts.total, { unit: '张' }),
          kpi('素材', filled, { ratio: shots > 0 ? Math.min(1, counts.shot / shots) : 0 }),
        ]))

        block.appendChild(sectionHeader('生产流程', `${STAGE_IDS.length} 个阶段`))
        const grid = el('div', { class: 'aidrama-stageGrid' })
        stageRows().forEach((row, i) => grid.appendChild(stageCard(row, i + 1)))
        block.appendChild(grid)

        // Asset wall — the newest generated frames, in aspect-correct frames.
        // A production tool with no imagery on screen always reads as empty,
        // so this runs even before anything is generated: the frames are drawn
        // as labelled empty slots at the project's real ratio.
        const assets = projectAssets().slice(0, 12)
        const shotCount = Math.min(shots, 8)
        block.appendChild(sectionHeader('素材', assets.length > 0 ? `${assets.length} 张` : '尚未生成'))
        if (assets.length === 0 && shotCount === 0) {
          block.appendChild(el('div', { class: 'aidrama-empty' }, [
            el('div', { class: 'aidrama-emptyIcon' }, [ico('image', 24)]),
            el('div', { class: 'aidrama-emptyTitle', text: '还没有任何素材' }),
            el('div', { class: 'aidrama-emptyText', text: '完成设定集后即可生成人物三视图、场景主图与分镜参考图。' }),
          ]))
        } else {
          const wall = el('div', { class: 'aidrama-wall' })
          for (const asset of assets) {
            const url = str(asset.url) || null
            const frame = el('div', {
              class: 'aidrama-frame',
              attrs: { 'data-ratio': str(state.project?.aspectRatio) || '9:16' },
            })
            if (url !== null) {
              frame.appendChild(el('img', {
                attrs: { src: url, alt: str(asset.name) || '素材', loading: 'lazy' },
                on: { click: () => { state.lightbox = { url, name: str(asset.name) || '素材' }; schedule() } },
              }))
            }
            const meta = el('div', { class: 'aidrama-thumbMeta', attrs: { style: 'padding:5px 6px' } })
            meta.textContent = str(asset.name) || str(asset.kind)
            const cell = el('div', { class: 'aidrama-thumb', attrs: { style: 'padding:0;overflow:hidden' } }, [frame, meta])
            wall.appendChild(cell)
          }
          // Slots for shots that have no reference image yet.
          const doneRefs = new Set(assets.filter(a => str(a.kind) === ASSET_KIND.shotRef).map(a => str(a.ref)))
          for (const shot of flattenShotsForUi().slice(0, shotCount)) {
            if (doneRefs.has(str(shot.id))) continue
            wall.appendChild(el('div', {
              class: 'aidrama-frame',
              attrs: { 'data-ratio': str(state.project?.aspectRatio) || '9:16', 'data-empty': '', 'data-slug': `SH-${String(Number(shot.seq) || 0).padStart(3, '0')}` },
            }))
          }
          block.appendChild(wall)
        }

        return block
      }

      /** Shared wrapper: loading / error / body for the active stage panel. */
      const panelShell = (title, body) => {
        const panel = el('div', { class: 'aidrama-panel' })
        // An empty title means the panel supplies its own heading (the form's
        // sticky bar does), so skip the element rather than render a blank.
        if (str(title) !== '') panel.appendChild(el('h3', { text: title }))
        if (state.detailError !== '') {
          panel.appendChild(el('div', { class: 'aidrama-error', text: state.detailError }))
          panel.appendChild(button('重新载入', () => { void loadProject(state.projectId) }))
          return panel
        }
        for (const node of body) panel.appendChild(node)
        return panel
      }

      /** Rows from `content.script.shots` — the authoritative flat list. */
      /**
       * Shots for dashboard counters.
       *
       * Declared as a hoisted `function` on purpose: the dashboard helpers above
       * call it, but `scriptShots` is a `const` arrow defined further down. A
       * const reference from an earlier line would throw a TDZ error the moment
       * a dashboard rendered — legal-looking code that only fails at runtime.
       */
      function flattenShotsForUi() {
        return scriptShots()
      }

      const scriptShots = () => {
        const content = isRecord(state.project?.content) ? state.project.content.script : null
        return isRecord(content) ? asArray(content.shots) : []
      }

      const bibleCharacters = () => {
        const content = isRecord(state.project?.content) ? state.project.content.bible : null
        return isRecord(content) ? asArray(content.characters) : []
      }

      const bibleScenes = () => {
        const content = isRecord(state.project?.content) ? state.project.content.bible : null
        return isRecord(content) ? asArray(content.scenes) : []
      }

      const projectAssets = () => asArray(state.project?.assets)

      /** Assets of one kind, newest first, optionally filtered by ref. */
      const assetsOfKind = (kind, ref) => projectAssets()
        .filter(asset => str(asset.kind) === kind && (ref === undefined || str(asset.ref) === str(ref)))
        .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))

      const shotLabel = (shot, index) => {
        const seq = Number(shot.seq)
        const episode = Number(shot.episode)
        const parts = [`镜 ${Number.isFinite(seq) ? seq : index + 1}`]
        if (Number.isFinite(episode) && episode > 0) parts.push(`第 ${episode} 集`)
        if (str(shot.scene) !== '') parts.push(str(shot.scene))
        return parts.join(' · ')
      }

      /** The text-stage (idea/story/script/bible) panel. */
      const renderTextStage = () => {
        const body = []
        const form = STAGE_FORMS[state.stage]

        // The EDITABLE FORM comes first — that is the point of the step.
        // The read-only cards and the JSON box move behind a <details> toggle:
        // showing three views of the same data at once is what made a stage
        // feel like a report instead of something you work in.
        //
        // The step heading is rendered INSIDE the form's save bar, so there is
        // exactly one title on screen instead of the two this used to stack.
        if (form !== undefined) {
          const formCard = renderFormStage(state.stage)
          if (formCard !== null) body.push(formCard)
        }

        const extras = el('details', { class: 'aidrama-details' })
        extras.appendChild(el('summary', { text: '参考：只读预览 · 任务说明 · JSON 粘贴' }))

        const cards = renderStructuredCards()
        if (cards !== null) extras.appendChild(cards)

        const briefCard = el('div', { class: 'aidrama-card' })
        briefCard.appendChild(el('h4', { text: '阶段任务说明' }))
        if (state.briefLoading) {
          briefCard.appendChild(el('div', { class: 'aidrama-loading', text: '正在读取任务说明…' }))
        } else if (state.briefError !== '') {
          briefCard.appendChild(el('div', { class: 'aidrama-error', text: state.briefError }))
          briefCard.appendChild(button('重试', () => { void loadBrief() }))
        } else if (isRecord(state.brief)) {
          if (str(state.brief.system) !== '') {
            briefCard.appendChild(el('div', { class: 'aidrama-hint', text: '系统要求' }))
            briefCard.appendChild(el('pre', { class: 'aidrama-pre', text: str(state.brief.system) }))
          }
          if (str(state.brief.task) !== '') {
            briefCard.appendChild(el('div', { class: 'aidrama-hint', text: '任务' }))
            briefCard.appendChild(el('pre', { class: 'aidrama-pre', text: str(state.brief.task) }))
          }
          if (str(state.brief.schema) !== '') {
            briefCard.appendChild(el('div', { class: 'aidrama-hint', text: '输出 JSON 契约' }))
            let formatted = str(state.brief.schema)
            try {
              formatted = JSON.stringify(JSON.parse(formatted), null, 2)
            } catch {
              /* the host may hand back a loose contract; show it verbatim */
            }
            briefCard.appendChild(el('pre', { class: 'aidrama-pre', text: formatted }))
          }
        } else {
          briefCard.appendChild(el('div', { class: 'aidrama-hint', text: '暂无任务说明。' }))
        }
        if (state.projectId !== '') {
          briefCard.appendChild(el('div', { class: 'aidrama-row' }, [
            button('复制给对话模型', () => { void copyInstruction() }, { variant: 'primary' }),
          ]))
        }
        body.push(briefCard)

        const editCard = el('div', { class: 'aidrama-card' })
        editCard.appendChild(el('h4', { text: 'JSON 粘贴（高级）' }))
        editCard.appendChild(el('div', {
          class: 'aidrama-hint',
          text: '如果你更习惯直接给 JSON：把对话模型返回的内容整段粘进来（支持 ```json 代码块），点「提交结果」。上面的表单会自动同步。',
        }))
        const area = el('textarea', { class: 'aidrama-textarea' })
        area.value = state.draft
        area.addEventListener('input', () => { state.draft = area.value })
        editCard.appendChild(area)
        const actionRow = el('div', { class: 'aidrama-row' })
        actionRow.appendChild(button(state.busy ? '提交中…' : '提交结果', () => { void commitDraft() }, { variant: 'primary' }))
        actionRow.appendChild(button('用当前内容重置', () => {
          state.draft = prettyJson(currentStageContent())
          schedule()
        }))
        actionRow.appendChild(button('标记重新生成', () => { void markRerun() }))
        editCard.appendChild(actionRow)
        if (state.commitError !== '') editCard.appendChild(el('div', { class: 'aidrama-error', text: state.commitError }))
        if (state.commitOk !== '') editCard.appendChild(el('div', { class: 'aidrama-ok', text: state.commitOk }))
        extras.appendChild(editCard)
        body.push(extras)

        // No panelShell title here: the form's sticky bar already carries the
        // step number and name, and stacking both printed the title twice.
        return panelShell('', body)
      }

      /** Grouped episode → scene → shot cards built from the flat shot list. */
      const renderScriptCards = () => {
        const shots = scriptShots()
        if (shots.length === 0) return null
        const card = el('div', { class: 'aidrama-card' })
        card.appendChild(el('h4', { text: `分场脚本 · 共 ${shots.length} 个镜头` }))

        const episodes = new Map()
        for (const shot of shots) {
          const episodeNo = Number(shot.episode) || 1
          if (!episodes.has(episodeNo)) episodes.set(episodeNo, new Map())
          const scenes = episodes.get(episodeNo)
          const sceneKey = str(shot.sceneId) || str(shot.scene) || '未分场'
          if (!scenes.has(sceneKey)) scenes.set(sceneKey, [])
          scenes.get(sceneKey).push(shot)
        }

        for (const [episodeNo, scenes] of [...episodes.entries()].sort((a, b) => a[0] - b[0])) {
          const block = el('div', { class: 'aidrama-episode' })
          block.appendChild(el('div', { class: 'aidrama-episodeTitle', text: `第 ${episodeNo} 集` }))
          for (const [sceneKey, sceneShots] of scenes) {
            const group = el('div', { class: 'aidrama-sceneGroup' })
            const first = sceneShots[0]
            const where = [str(first.scene), str(first.location), str(first.time)].filter(p => p !== '').join(' · ')
            group.appendChild(el('div', { class: 'aidrama-sceneTitle', text: where !== '' ? where : sceneKey }))
            for (const shot of sceneShots) {
              const row = el('div', { class: 'aidrama-shot' })
              const head = el('div', { class: 'aidrama-shotHead' }, [
                el('span', { class: 'aidrama-shotNo', text: shotLabel(shot, 0) }),
                el('span', { class: 'aidrama-shotMeta', text: [str(shot.shotSize), str(shot.cameraMove) || str(shot.camera), `${Number(shot.durationSeconds) || 0}s`].filter(p => p !== '').join(' · ') }),
              ])
              if (listText(shot.characters) !== '') {
                head.appendChild(el('span', { class: 'aidrama-tag', text: listText(shot.characters) }))
              }
              row.appendChild(head)
              if (str(shot.action) !== '') row.appendChild(el('div', { class: 'aidrama-shotBody', text: str(shot.action) }))
              if (str(shot.dialogue) !== '') row.appendChild(el('div', { class: 'aidrama-dialog', text: str(shot.dialogue) }))
              group.appendChild(row)
            }
            block.appendChild(group)
          }
          card.appendChild(block)
        }
        return card
      }

      /** Story-stage cards: three acts + character wants + episodes. */
      const renderStoryCards = () => {
        const content = isRecord(state.project?.content) ? state.project.content.story : null
        if (!isRecord(content)) return null
        const acts = asArray(content.acts)
        const characters = asArray(content.characters)
        const episodes = asArray(content.episodes)
        if (acts.length === 0 && characters.length === 0 && episodes.length === 0) return null

        const card = el('div', { class: 'aidrama-card' })
        card.appendChild(el('h4', { text: '剧情结构' }))
        for (const act of acts) {
          const row = el('div', { class: 'aidrama-sceneGroup' }, [
            el('div', { class: 'aidrama-sceneTitle', text: `第 ${str(act.no) || '?'} 幕 · ${str(act.name)}` }),
            el('div', { class: 'aidrama-shotBody', text: str(act.summary) }),
          ])
          card.appendChild(row)
        }
        for (const episode of episodes) {
          card.appendChild(el('div', { class: 'aidrama-sceneGroup' }, [
            el('div', { class: 'aidrama-sceneTitle', text: `第 ${str(episode.no) || '?'} 集 · ${str(episode.title)}` }),
            str(episode.hook) !== '' ? el('div', { class: 'aidrama-shotBody', text: `钩子：${str(episode.hook)}` }) : null,
            str(episode.summary) !== '' ? el('div', { class: 'aidrama-shotBody', text: str(episode.summary) }) : null,
          ]))
        }
        for (const character of characters) {
          card.appendChild(el('div', { class: 'aidrama-target' }, [
            el('div', { class: 'aidrama-targetHead' }, [
              el('span', { class: 'aidrama-targetName', text: str(character.name) }),
              el('span', { class: 'aidrama-tag', text: str(character.role) }),
            ]),
            str(character.want) !== '' ? el('div', { class: 'aidrama-shotBody', text: `想要：${str(character.want)}` }) : null,
            str(character.obstacle) !== '' ? el('div', { class: 'aidrama-shotBody', text: `阻碍：${str(character.obstacle)}` }) : null,
          ]))
        }
        return card
      }

      /** Idea-stage cards: logline + genre + conflict + open questions. */
      const renderIdeaCards = () => {
        const content = isRecord(state.project?.content) ? state.project.content.idea : null
        if (!isRecord(content)) return null
        const questions = Array.isArray(content.questions) ? content.questions.map(str).filter(Boolean) : []
        if (Object.keys(content).length === 0) return null
        const card = el('div', { class: 'aidrama-card' })
        card.appendChild(el('h4', { text: '想法要点' }))
        const pairs = [
          ['题材', content.genre], ['基调', content.tone], ['主角', content.protagonist],
          ['核心冲突', content.conflict], ['爽点', content.hook], ['结局走向', content.ending],
          ['一句话故事', content.logline],
        ]
        for (const [label, value] of pairs) {
          if (listText(value) === '') continue
          card.appendChild(el('div', { class: 'aidrama-shotBody', text: `${label}：${listText(value)}` }))
        }
        if (questions.length > 0) {
          card.appendChild(el('div', { class: 'aidrama-hint', text: '待确认问题' }))
          for (const question of questions) {
            card.appendChild(el('div', { class: 'aidrama-shotBody', text: `· ${question}` }))
          }
        }
        return card
      }

      /** Bible-stage cards: character + scene cards, each with its own asset. */
      const renderBibleCards = () => {
        const characters = bibleCharacters()
        const scenes = bibleScenes()
        if (characters.length === 0 && scenes.length === 0) return null
        const card = el('div', { class: 'aidrama-card' })
        card.appendChild(el('h4', { text: `设定集 · 角色 ${characters.length} · 场景 ${scenes.length}` }))

        for (const character of characters) {
          const name = str(character.name) || str(character.id)
          const sheet = assetsOfKind(ASSET_KIND.characterSheet, str(character.id))[0]
          const row = el('div', { class: 'aidrama-target' })
          row.appendChild(el('div', { class: 'aidrama-targetHead' }, [
            el('span', { class: 'aidrama-targetName', text: name }),
            el('span', { class: 'aidrama-tag', text: str(character.role) || '配角' }),
            sheet !== undefined ? el('span', { class: 'aidrama-tag', text: '已出三视图' }) : null,
          ]))
          const description = [str(character.appearance), str(character.costume)].filter(p => p !== '').join('；')
          if (description !== '') row.appendChild(el('div', { class: 'aidrama-shotBody', text: description }))
          if (str(character.personality) !== '') row.appendChild(el('div', { class: 'aidrama-dialog', text: `性格：${str(character.personality)}` }))
          card.appendChild(row)
        }

        for (const scene of scenes) {
          const name = str(scene.name) || str(scene.id)
          const master = assetsOfKind(ASSET_KIND.sceneMaster, str(scene.id))[0]
          const row = el('div', { class: 'aidrama-target' })
          row.appendChild(el('div', { class: 'aidrama-targetHead' }, [
            el('span', { class: 'aidrama-targetName', text: name }),
            el('span', { class: 'aidrama-tag', text: [str(scene.timeOfDay), str(scene.interior) === 'true' ? '内景' : ''].filter(p => p !== '').join(' · ') }),
            master !== undefined ? el('span', { class: 'aidrama-tag', text: '已出主图' }) : null,
          ]))
          if (str(scene.description) !== '') row.appendChild(el('div', { class: 'aidrama-shotBody', text: str(scene.description) }))
          if (str(scene.lighting) !== '') row.appendChild(el('div', { class: 'aidrama-dialog', text: `光线：${str(scene.lighting)}` }))
          card.appendChild(row)
        }
        return card
      }

      /* ---------------------------------------------------------------- *
       * FORM EDITOR.
       *
       * The earlier version showed read-only cards plus one raw JSON textarea,
       * which meant you could LOOK at your drama but not edit it — no way to
       * start, no way to work through it. These render real inputs instead.
       *
       * The whole stage object is kept in `state.formDraft` and saved in one
       * `commit` call, so the host still validates exactly as before; the form
       * is just a friendlier way to produce that JSON.
       * ---------------------------------------------------------------- */

      /** Read the working copy for the active stage, seeding it from the project. */
      const formDraftData = () => {
        if (!isRecord(state.formDraft)) {
          const existing = currentStageContent()
          state.formDraft = isRecord(existing) ? JSON.parse(JSON.stringify(existing)) : {}
        }
        return state.formDraft
      }

      const setField = (path, value) => {
        const data = formDraftData()
        let node = data
        for (let i = 0; i < path.length - 1; i += 1) {
          const key = path[i]
          if (!isRecord(node[key])) {
            // Create the right container: arrays for numeric keys, objects else.
            node[key] = typeof path[i + 1] === 'number' ? [] : {}
          }
          node = node[key]
        }
        const last = path[path.length - 1]
        if (value === '' || value === undefined) delete node[last]
        else node[last] = value
      }

      const getField = (path) => {
        let node = formDraftData()
        for (const key of path) {
          if (node === null || node === undefined) return undefined
          node = node[key]
        }
        return node
      }

      /** One labelled control. */
      const fieldControl = (field, path, options = {}) => {
        const wrap = el('div', { class: 'aidrama-field' })
        if (options.hideLabel !== true) {
          const labelRow = el('div', { class: 'aidrama-fieldLabel' })
          labelRow.appendChild(el('span', { text: field.label }))
          if (field.req === true) labelRow.appendChild(el('span', { class: 'aidrama-req', text: '必填' }))
          // The hint rides on the LABEL row, not under the input: underneath it
          // read like a caption for the next field.
          if (field.hint !== undefined) {
            labelRow.appendChild(el('span', { class: 'aidrama-fieldHint', text: str(field.hint) }))
          }
          wrap.appendChild(labelRow)
        }
        const current = getField(path)
        const commit = (value) => {
          setField(path, value)
          state.formDirty = true
          schedule()
        }

        let control
        if (field.kind === 'textarea') {
          control = el('textarea', { class: 'aidrama-input', attrs: { rows: str(field.rows ?? 3), placeholder: str(field.ph) } })
          control.value = current === undefined ? '' : str(current)
          control.addEventListener('input', () => { setField(path, control.value); state.formDirty = true })
        } else if (field.kind === 'select') {
          control = el('select', { class: 'aidrama-input' })
          const blank = el('option', { text: '— 未设置 —' })
          blank.value = ''
          control.appendChild(blank)
          for (const option of field.options ?? []) {
            const o = el('option', { text: option })
            o.value = option
            control.appendChild(o)
          }
          control.value = current === undefined ? '' : str(current)
          control.addEventListener('change', () => commit(control.value))
        } else if (field.kind === 'number') {
          control = el('input', {
            class: 'aidrama-input',
            attrs: { type: 'number', step: str(field.step ?? '1'), min: str(field.min ?? ''), max: str(field.max ?? ''), placeholder: str(field.ph) },
          })
          control.value = current === undefined ? '' : str(current)
          control.addEventListener('input', () => {
            const raw = control.value.trim()
            setField(path, raw === '' ? '' : Number(raw))
            state.formDirty = true
          })
        } else if (field.kind === 'tags') {
          // Comma-separated list shown as one line; stored as an array.
          control = el('input', { class: 'aidrama-input', attrs: { type: 'text', placeholder: str(field.ph ?? '用逗号分隔') } })
          control.value = Array.isArray(current) ? current.map(str).join(', ') : str(current ?? '')
          control.addEventListener('input', () => {
            const parts = control.value.split(/[,，]/).map(s => s.trim()).filter(s => s !== '')
            setField(path, parts.length === 0 ? '' : parts)
            state.formDirty = true
          })
        } else {
          control = el('input', { class: 'aidrama-input', attrs: { type: 'text', placeholder: str(field.ph) } })
          control.value = current === undefined ? '' : str(current)
          control.addEventListener('input', () => { setField(path, control.value); state.formDirty = true })
        }
        wrap.appendChild(control)
        return wrap
      }

      /** A repeatable group: header with count + add, then each item expanded. */
      const fieldList = (list, basePath, depth = 0) => {
        const rows = getField(basePath)
        const items = Array.isArray(rows) ? rows : []
        const box = el('div', { class: 'aidrama-group', attrs: { 'data-depth': str(depth) } })

        const head = el('div', { class: 'aidrama-groupHead' })
        head.appendChild(el('span', { class: 'aidrama-groupTitle', text: str(list.label) }))
        head.appendChild(el('span', { class: 'aidrama-groupCount', text: `${items.length} ${str(list.item ?? '项')}` }))
        box.appendChild(head)
        if (list.hint !== undefined) box.appendChild(el('div', { class: 'aidrama-fieldHint', text: str(list.hint) }))

        if (items.length === 0) {
          box.appendChild(el('div', { class: 'aidrama-groupEmpty', text: `还没有${str(list.label)}。点下面的按钮添加。` }))
        }

        items.forEach((item, index) => {
          const itemPath = [...basePath, index]
          const card = el('div', { class: 'aidrama-item' })
          const itemHead = el('div', { class: 'aidrama-itemHead' })
          // A readable title beats "第 1 项": use the most identifying field.
          const titleKey = list.fields.find(f => ['title', 'name', 'slug', 'id', 'who', 'shot'].includes(f.key)) ?? list.fields[0]
          const titleValue = titleKey ? str(item?.[titleKey.key]) : ''
          itemHead.appendChild(el('span', {
            class: 'aidrama-itemNo',
            text: `${str(list.item ?? '项')} ${index + 1}`,
          }))
          if (titleValue !== '') itemHead.appendChild(el('span', { class: 'aidrama-itemTitle', text: titleValue }))
          const tools = el('div', { class: 'aidrama-itemTools' })
          if (list.reorder === true) {
            tools.appendChild(button('↑', () => {
              if (index === 0) return
              const arr = getField(basePath)
              const [moved] = arr.splice(index, 1)
              arr.splice(index - 1, 0, moved)
              state.formDirty = true
              schedule()
            }, { variant: 'ghost' }))
            tools.appendChild(button('↓', () => {
              const arr = getField(basePath)
              if (index >= arr.length - 1) return
              const [moved] = arr.splice(index, 1)
              arr.splice(index + 1, 0, moved)
              state.formDirty = true
              schedule()
            }, { variant: 'ghost' }))
          }
          tools.appendChild(button('删除', () => {
            const arr = getField(basePath)
            arr.splice(index, 1)
            state.formDirty = true
            schedule()
          }, { variant: 'ghost' }))
          itemHead.appendChild(tools)
          card.appendChild(itemHead)

          for (const field of list.fields) {
            card.appendChild(fieldControl(field, [...itemPath, field.key]))
          }
          for (const child of list.children ?? []) {
            card.appendChild(fieldList(child, [...itemPath, child.key], depth + 1))
          }
          box.appendChild(card)
        })

        if (list.addable === true) {
          box.appendChild(el('div', { class: 'aidrama-row' }, [
            button(`+ 添加${str(list.item ?? '一项')}`, () => {
              const data = formDraftData()
              let node = data
              for (const key of basePath.slice(0, -1)) {
                if (!isRecord(node[key])) node[key] = typeof key === 'number' ? [] : {}
                node = node[key]
              }
              const lastKey = basePath[basePath.length - 1]
              if (!Array.isArray(node[lastKey])) node[lastKey] = []
              const seeded = {}
              for (const f of list.fields) if (f.kind === 'number') seeded[f.key] = 0
              node[lastKey].push(seeded)
              state.formDirty = true
              schedule()
            }, { variant: 'ghost' }),
          ]))
        }
        return box
      }

      /** Renders the whole editable stage, with a sticky save bar. */
      const renderFormStage = (stageId) => {
        const form = STAGE_FORMS[stageId]
        if (form === undefined) return null
        const card = el('div', { class: 'aidrama-card aidrama-formCard' })

        // The save bar sits at the TOP, riding along as you scroll. Putting it
        // at the bottom meant the primary action was off-screen on every stage
        // with more than a few fields — which is all of them.
        const stepIndex = TEXT_STAGE_IDS.indexOf(stageId)
        const bar = el('div', { class: 'aidrama-saveBar' })
        const left = el('div', { class: 'aidrama-saveMeta' })
        left.appendChild(el('span', {
          class: 'aidrama-stepNo',
          text: `第 ${stepIndex + 1} 步 / 共 ${TEXT_STAGE_IDS.length} 步`,
        }))
        left.appendChild(el('h3', {
          class: 'aidrama-stepTitle',
          text: STAGE_LABEL[stageId] ?? stageId,
        }))
        bar.appendChild(left)
        const actions = el('div', { class: 'aidrama-saveActions' })
        if (state.formDirty) {
          actions.appendChild(el('span', { class: 'aidrama-dirty', text: '有未保存的修改' }))
        }
        actions.appendChild(button(
          state.busy ? '保存中…' : '保存并继续',
          () => { void saveForm() },
          { variant: 'primary' },
        ))
        actions.appendChild(button('清空重填', () => {
          state.formDraft = {}
          state.formDirty = true
          schedule()
        }, { variant: 'ghost' }))
        bar.appendChild(actions)
        card.appendChild(bar)

        // Ask ONE thing first. For step 1 that is the raw idea; for later
        // stages it is whatever the user already has.
        if (isRecord(form.primary)) {
          const box = el('div', { class: 'aidrama-primary' })
          box.appendChild(el('label', { class: 'aidrama-primaryLabel', text: str(form.primary.label) }))
          const area = el('textarea', {
            class: 'aidrama-input aidrama-primaryInput',
            attrs: { rows: str(form.primary.rows ?? 4), placeholder: str(form.primary.ph) },
          })
          area.value = str(getField([form.primary.key]) ?? '')
          area.addEventListener('input', () => {
            setField([form.primary.key], area.value)
            state.formDirty = true
          })
          box.appendChild(area)
          if (form.primary.hint !== undefined) {
            box.appendChild(el('div', { class: 'aidrama-fieldHint', text: str(form.primary.hint) }))
          }
          card.appendChild(box)
        }

        // Tap-to-choose. These exist so step 1 can be finished without typing
        // anything beyond the idea itself.
        for (const choice of form.choices ?? []) {
          const box = el('div', { class: 'aidrama-choice' })
          box.appendChild(el('div', { class: 'aidrama-choiceLabel', text: str(choice.label) }))
          const row = el('div', { class: 'aidrama-choiceRow' })
          const current = str(getField([choice.key]) ?? '')
          for (const option of choice.options) {
            const chip = el('button', {
              class: 'aidrama-chipBtn',
              text: option,
              attrs: { type: 'button', 'data-on': String(option === current) },
            })
            chip.addEventListener('click', () => {
              setField([choice.key], option === current ? '' : option)
              state.formDirty = true
              schedule()
            })
            row.appendChild(chip)
          }
          box.appendChild(row)
          card.appendChild(box)
        }

        // The draft affordance: hand the work to the conversation model instead
        // of making the user face the fields cold.
        const draftRow = el('div', { class: 'aidrama-draftRow' })
        draftRow.appendChild(button(
          state.stage === 'idea' ? '让 AI 按我的想法出几个方向' : '让 AI 出一版初稿',
          () => { void copyInstruction() },
          { variant: 'primary' },
        ))
        if (str(form.draftHint) !== '') {
          draftRow.appendChild(el('span', { class: 'aidrama-fieldHint', text: str(form.draftHint) }))
        }
        card.appendChild(draftRow)

        // The detail fields are COLLAPSED by default.
        //
        // Marking them "optional" was not enough: someone who only has an idea
        // still sees eight empty boxes asking for a genre, a tone, a
        // protagonist, an antagonist. The boxes themselves are the barrier, not
        // the asterisks. So step 1 shows one question and a few choices; the
        // rest is there when wanted and auto-expands once there is content.
        const detailKeys = [...form.fields.map(f => f.key), ...(form.lists ?? []).map(l => l.key)]
        const filled = detailKeys.filter(key => {
          const value = getField([key])
          if (Array.isArray(value)) return value.length > 0
          return str(value ?? '') !== ''
        })
        const details = el('details', { class: 'aidrama-details aidrama-detailFields' })
        if (filled.length > 0) details.setAttribute('open', '')
        details.appendChild(el('summary', {
          text: filled.length > 0
            ? `细节字段（已填 ${filled.length} 项）`
            : '细节字段（可以先不管 —— 让 AI 初稿来填）',
        }))

        if (str(form.help) !== '') {
          details.appendChild(el('div', { class: 'aidrama-formHelp', text: str(form.help) }))
        }
        for (const field of form.fields) details.appendChild(fieldControl(field, [field.key]))
        for (const list of form.lists ?? []) details.appendChild(fieldList(list, [list.key]))
        card.appendChild(details)

        if (state.commitError !== '') card.appendChild(el('div', { class: 'aidrama-error', text: state.commitError }))
        if (state.commitOk !== '') card.appendChild(el('div', { class: 'aidrama-ok', text: state.commitOk }))

        return card
      }

      /** Save the form, then land on the next step. */
      const saveForm = async () => {
        if (state.projectId === '' || state.busy) return
        state.busy = true
        state.commitError = ''
        state.commitOk = ''
        schedule()
        try {
          const payload = formDraftData()
          const project = await api.commit(state.projectId, state.stage, payload, '在表单里编辑')
          if (isRecord(project)) state.project = project
          state.formDirty = false
          state.commitOk = '已保存。'
          // Advance to the next TEXT stage automatically — the wizard should
          // keep moving forward, which is what "一步一步往下" asks for.
          const index = TEXT_STAGE_IDS.indexOf(state.stage)
          const next = index !== -1 ? TEXT_STAGE_IDS[index + 1] : undefined
          if (next !== undefined) {
            selectStage(next)
          } else {
            state.formDraft = null
            void loadBrief()
          }
        } catch (error) {
          state.commitError = `保存失败：${str(error?.message ?? error)}`
        } finally {
          state.busy = false
          schedule()
        }
      }

      /** Read-only rendering of a stage, kept as a secondary view. */
      const renderStructuredCards = () => {
        if (state.stage === 'idea') return renderIdeaCards()
        if (state.stage === 'story') return renderStoryCards()
        if (state.stage === 'script') return renderScriptCards()
        if (state.stage === 'bible') return renderBibleCards()
        return null
      }

      /** The thumbnail grid + lightbox trigger shared by visual and video. */
      const renderAssetGrid = (assets) => {
        const grid = el('div', { class: 'aidrama-grid' })
        for (const asset of assets) {
          const url = str(asset.url)
          const tile = el('div', { class: 'aidrama-thumb' })
          if (url !== '') {
            const image = el('img', {
              attrs: { src: url, alt: str(asset.name), loading: 'lazy' },
              on: { click: () => { state.lightbox = { url, name: str(asset.name) }; schedule() } },
            })
            tile.appendChild(image)
          }
          tile.appendChild(el('div', { class: 'aidrama-thumbName', text: str(asset.name) }))
          tile.appendChild(el('div', {
            class: 'aidrama-thumbMeta',
            text: [ASSET_KIND_TEXT[str(asset.kind)] ?? str(asset.kind), formatBytes(asset.bytes)].filter(p => p !== '').join(' · '),
          }))
          grid.appendChild(tile)
        }
        return grid
      }

      const renderVisual = () => {
        const body = []
        const config = isRecord(state.config) ? state.config : {}
        const channels = asArray(config.channels)
        const hasImageChannel = channels.some(channel => channel.hasKey === true)

        const head = el('div', { class: 'aidrama-card' })
        head.appendChild(el('h4', { text: '图像渠道' }))
        if (channels.length === 0) {
          head.appendChild(el('div', { class: 'aidrama-hint', text: '尚未配置图像渠道。请在「设置 → 短剧工作台」中添加渠道后再生成。' }))
        } else {
          head.appendChild(el('div', {
            class: 'aidrama-hint',
            text: hasImageChannel
              ? `可用渠道 ${channels.filter(c => c.hasKey === true).length} 个，默认模型：${str(config.defaultModel) || '(未指定)'}`
              : '渠道已配置但缺少 API Key，生成会失败。',
          }))
        }
        head.appendChild(el('div', { class: 'aidrama-row' }, [
          button(state.generating ? '生成中…' : '生成全部视觉资产', () => { void runGenerate([]) }, { variant: 'primary' }),
        ]))
        if (state.genError !== '') head.appendChild(el('div', { class: 'aidrama-error', text: state.genError }))
        if (state.genOk !== '') head.appendChild(el('div', { class: 'aidrama-ok', text: state.genOk }))
        body.push(head)

        const characters = bibleCharacters()
        const scenes = bibleScenes()
        const shots = scriptShots()

        const targetsCard = el('div', { class: 'aidrama-card' })
        targetsCard.appendChild(el('h4', { text: '生成目标' }))
        if (characters.length === 0 && scenes.length === 0 && shots.length === 0) {
          targetsCard.appendChild(el('div', {
            class: 'aidrama-empty',
            text: '还没有可生成的目标：请先完成「设定集」与「分场脚本」阶段。',
          }))
        }
        for (const character of characters) {
          targetsCard.appendChild(el('div', { class: 'aidrama-target' }, [
            el('div', { class: 'aidrama-targetHead' }, [
              el('span', { class: 'aidrama-targetName', text: str(character.name) || str(character.id) }),
              el('span', { class: 'aidrama-tag', text: '角色' }),
            ]),
            el('div', { class: 'aidrama-row' }, [
              button('生成三视图', () => { void runGenerate([{ kind: ASSET_KIND.characterSheet, ref: str(character.id), name: str(character.name) }]) }),
            ]),
          ]))
        }
        for (const scene of scenes) {
          targetsCard.appendChild(el('div', { class: 'aidrama-target' }, [
            el('div', { class: 'aidrama-targetHead' }, [
              el('span', { class: 'aidrama-targetName', text: str(scene.name) || str(scene.id) }),
              el('span', { class: 'aidrama-tag', text: '场景' }),
            ]),
            el('div', { class: 'aidrama-row' }, [
              button('生成场景主图', () => { void runGenerate([{ kind: ASSET_KIND.sceneMaster, ref: str(scene.id), name: str(scene.name) }]) }),
            ]),
          ]))
        }
        for (const shot of shots) {
          targetsCard.appendChild(el('div', { class: 'aidrama-target' }, [
            el('div', { class: 'aidrama-targetHead' }, [
              el('span', { class: 'aidrama-targetName', text: shotLabel(shot, 0) }),
              el('span', { class: 'aidrama-tag', text: '分镜' }),
            ]),
            el('div', { class: 'aidrama-row' }, [
              button('生成分镜图', () => { void runGenerate([{ kind: ASSET_KIND.shotRef, ref: str(shot.id), name: str(shot.id) }]) }),
            ]),
          ]))
        }
        body.push(targetsCard)

        if (state.failures.length > 0) {
          const failCard = el('div', { class: 'aidrama-card' })
          failCard.appendChild(el('h4', { text: `失败目标（${state.failures.length}）` }))
          for (const failure of state.failures) {
            failCard.appendChild(el('div', {
              class: 'aidrama-error',
              text: `${str(failure.ref) || '(未知目标)'}：${str(failure.message)}`,
            }))
          }
          body.push(failCard)
        }

        const assets = projectAssets()
        const assetCard = el('div', { class: 'aidrama-card' })
        assetCard.appendChild(el('h4', { text: `已生成资产（${assets.length}）` }))
        if (assets.length === 0) {
          assetCard.appendChild(el('div', { class: 'aidrama-empty', text: '还没有生成任何图片。' }))
        } else {
          assetCard.appendChild(renderAssetGrid(assets))
        }
        body.push(assetCard)

        return panelShell(`第 5 步 · ${STAGE_LABEL.visual}`, body)
      }

      const renderVideo = () => {
        const body = []
        const config = isRecord(state.config) ? state.config : {}
        const videoChannels = asArray(config.videoChannels)
        const usableVideoChannel = videoChannels.find(channel => channel.hasKey === true)
        const shots = scriptShots()

        const packCard = el('div', { class: 'aidrama-card' })
        packCard.appendChild(el('h4', { text: '导出提示词包' }))
        packCard.appendChild(el('div', {
          class: 'aidrama-hint',
          text: '提示词包完全在本地生成，不需要视频渠道或 API Key，任何情况下都可用。',
        }))
        packCard.appendChild(el('div', { class: 'aidrama-row' }, [
          button(state.packing ? '读取中…' : '导出提示词包', () => { void loadPack() }, { variant: 'primary' }),
        ]))
        if (state.packError !== '') packCard.appendChild(el('div', { class: 'aidrama-error', text: state.packError }))
        if (isRecord(state.pack)) {
          const prompts = asArray(state.pack.prompts)
          if (str(state.pack.note) !== '') packCard.appendChild(el('div', { class: 'aidrama-hint', text: str(state.pack.note) }))
          if (prompts.length === 0) {
            packCard.appendChild(el('div', { class: 'aidrama-empty', text: '提示词包为空：请先完成「分场脚本」阶段。' }))
          }
          for (const row of prompts) {
            packCard.appendChild(el('div', { class: 'aidrama-shot' }, [
              el('div', { class: 'aidrama-shotHead' }, [
                el('span', { class: 'aidrama-shotNo', text: str(row.shot) || str(row.ref) }),
              ]),
              el('div', { class: 'aidrama-shotBody', text: str(row.prompt) }),
            ]))
          }
        }
        body.push(packCard)

        const submitCard = el('div', { class: 'aidrama-card' })
        submitCard.appendChild(el('h4', { text: '视频生成' }))
        if (videoChannels.length === 0) {
          submitCard.appendChild(el('div', {
            class: 'aidrama-hint',
            text: '尚未配置视频渠道。请在「设置 → 短剧工作台」中添加视频渠道，或直接使用上方的提示词包。',
          }))
        } else if (usableVideoChannel === undefined) {
          submitCard.appendChild(el('div', {
            class: 'aidrama-hint',
            text: '视频渠道已配置但缺少 API Key，提交会失败。',
          }))
        } else {
          submitCard.appendChild(el('div', {
            class: 'aidrama-hint',
            text: `将使用渠道「${str(usableVideoChannel.name)}」(${str(usableVideoChannel.protocol)}) 提交 ${shots.length} 个镜头。`,
          }))
        }
        const shotRefs = shots.map(shot => str(shot.id)).filter(id => id !== '')
        submitCard.appendChild(el('div', { class: 'aidrama-row' }, [
          button(state.videoBusy ? '提交中…' : `提交视频（${shotRefs.length} 个镜头）`, () => { void submitVideo(shotRefs) }, { variant: 'primary' }),
        ]))
        if (state.videoError !== '') submitCard.appendChild(el('div', { class: 'aidrama-error', text: state.videoError }))
        if (state.videoOk !== '') submitCard.appendChild(el('div', { class: 'aidrama-ok', text: state.videoOk }))
        body.push(submitCard)

        const tasks = asArray(state.project?.videoTasks)
        const taskCard = el('div', { class: 'aidrama-card' })
        taskCard.appendChild(el('h4', { text: `视频任务（${tasks.length}）` }))
        if (tasks.length === 0) {
          taskCard.appendChild(el('div', { class: 'aidrama-empty', text: '还没有视频任务。' }))
        }
        for (const task of tasks) {
          const taskId = str(task.taskId ?? task.id)
          const row = el('div', { class: 'aidrama-target' })
          row.appendChild(el('div', { class: 'aidrama-targetHead' }, [
            el('span', { class: 'aidrama-targetName', text: str(task.ref) || taskId }),
            el('span', { class: 'aidrama-tag', text: str(task.status) || '未知' }),
          ]))
          if (str(task.error) !== '') row.appendChild(el('div', { class: 'aidrama-error', text: str(task.error) }))
          row.appendChild(el('div', { class: 'aidrama-row' }, [
            button('刷新状态', () => { void refreshVideo(taskId) }),
          ]))
          taskCard.appendChild(row)
        }
        body.push(taskCard)

        const videos = projectAssets().filter(asset => str(asset.kind) === ASSET_KIND.video)
        if (videos.length > 0) {
          const card = el('div', { class: 'aidrama-card' })
          card.appendChild(el('h4', { text: '成片' }))
          for (const asset of videos) {
            const url = str(asset.url)
            if (url === '') continue
            const video = el('video', { attrs: { src: url, controls: 'controls', preload: 'metadata' } })
            video.style.width = '100%'
            video.style.maxHeight = '320px'
            video.style.borderRadius = '9px'
            card.appendChild(video)
            card.appendChild(el('div', { class: 'aidrama-thumbMeta', text: str(asset.name) }))
          }
          body.push(card)
        }

        return panelShell(`第 6 步 · ${STAGE_LABEL.video}`, body)
      }

      const renderSettings = () => {
        const body = []
        const card = el('div', { class: 'aidrama-card' })
        card.appendChild(el('h4', { text: '渠道配置（只读）' }))
        card.appendChild(el('div', {
          class: 'aidrama-hint',
          text: '此面板只读展示当前生效的渠道。修改请前往「设置 → 短剧工作台」。API Key 不会下发到浏览器，这里只显示是否已配置。',
        }))

        if (state.configLoading) {
          card.appendChild(el('div', { class: 'aidrama-loading', text: '正在读取配置…' }))
        } else if (state.configError !== '') {
          card.appendChild(el('div', { class: 'aidrama-error', text: state.configError }))
          card.appendChild(button('重试', () => { void loadConfig() }))
        } else if (isRecord(state.config)) {
          const config = state.config
          card.appendChild(el('div', {
            class: 'aidrama-hint',
            text: `画幅 ${str(config.aspectRatio) || '—'} · 单镜时长 ${Number(config.shotSeconds) || 0}s · 状态 ${config.enabled === false ? '已停用' : '已启用'}`,
          }))
          if (str(config.styleDna) !== '') {
            card.appendChild(el('div', { class: 'aidrama-hint', text: '风格 DNA' }))
            card.appendChild(el('pre', { class: 'aidrama-pre', text: str(config.styleDna) }))
          }

          const channels = asArray(config.channels)
          card.appendChild(el('div', { class: 'aidrama-hint', text: `图像渠道（${channels.length}）` }))
          if (channels.length === 0) card.appendChild(el('div', { class: 'aidrama-empty', text: '未配置图像渠道。' }))
          const imageGrid = el('div', { class: 'aidrama-channels' })
          for (const channel of channels) {
            const models = asArray(channel.models)
            imageGrid.appendChild(el('div', { class: 'aidrama-channel' }, [
              el('div', { class: 'aidrama-channelName', text: str(channel.name) || str(channel.id) }),
              el('div', { class: 'aidrama-channelUrl', text: str(channel.apiUrl) }),
              el('div', { class: 'aidrama-kv', text: `协议：${str(channel.protocol) || '—'}` }),
              el('div', { class: 'aidrama-kv', text: `API Key：${channel.hasKey === true ? '已配置' : '未配置'}` }),
              el('div', { class: 'aidrama-kv', text: `模型：${models.map(model => str(model.alias) || str(model.id)).filter(Boolean).join('、') || '—'}` }),
            ]))
          }
          if (channels.length > 0) card.appendChild(imageGrid)

          const videoChannels = asArray(config.videoChannels)
          card.appendChild(el('div', { class: 'aidrama-hint', text: `视频渠道（${videoChannels.length}）` }))
          if (videoChannels.length === 0) card.appendChild(el('div', { class: 'aidrama-empty', text: '未配置视频渠道，可使用提示词包导出兜底。' }))
          const videoGrid = el('div', { class: 'aidrama-channels' })
          for (const channel of videoChannels) {
            videoGrid.appendChild(el('div', { class: 'aidrama-channel' }, [
              el('div', { class: 'aidrama-channelName', text: str(channel.name) || str(channel.id) }),
              el('div', { class: 'aidrama-channelUrl', text: str(channel.apiUrl) }),
              el('div', { class: 'aidrama-kv', text: `协议：${str(channel.protocol) || '—'}` }),
              el('div', { class: 'aidrama-kv', text: `模型：${str(channel.model) || '—'}` }),
              el('div', { class: 'aidrama-kv', text: `API Key：${channel.hasKey === true ? '已配置' : '未配置'}` }),
            ]))
          }
          if (videoChannels.length > 0) card.appendChild(videoGrid)
        }
        body.push(card)
        return panelShell('设置', body)
      }

      /**
       * Pinned keyboard hint bar.
       *
       * Cheap, and it does real work: it advertises the shortcuts that already
       * exist (Esc peels one layer at a time) and signals "this is an app with
       * keybindings", not a page.
       */
      const renderHints = () => el('div', { class: 'aidrama-hints' }, [
        el('span', {}, [el('kbd', { text: 'Esc' }), el('span', { text: ' 逐层关闭' })]),
        el('span', {}, [el('kbd', { text: '1' }), el('span', { text: '–' }), el('kbd', { text: '6' }), el('span', { text: ' 切换阶段' })]),
        el('span', {}, [el('kbd', { text: '0' }), el('span', { text: ' 总览' })]),
        el('div', { attrs: { style: 'flex:1' } }),
        el('span', {
          class: 'aidrama-mono',
          text: state.project === null ? '' : `${STAGE_IDS.length} 阶段 · ${state.project?.aspectRatio ?? '9:16'}`,
        }),
      ])

      const renderPanel = () => {
        if (state.projectId === '' || state.project === null) {
          return panelShell('工作台', [renderEmptyWorkbench()])
        }
        if (state.stage === 'home') return panelShell('总览', [renderDashboard()])
        if (state.stage === 'visual') return renderVisual()
        if (state.stage === 'video') return renderVideo()
        if (state.stage === 'settings') return renderSettings()
        return renderTextStage()
      }

      /**
       * Empty state for "no project selected".
       *
       * An illustration, ONE primary action, and starter chips — a blank panel
       * is what makes a tool feel like an unfinished form.
       */
      const renderEmptyWorkbench = () => {
        const box = el('div', { class: 'aidrama-empty' })
        box.appendChild(el('div', { class: 'aidrama-emptyIcon' }, [ico('film', 24)]))
        box.appendChild(el('div', { class: 'aidrama-emptyTitle', text: '还没有打开短剧项目' }))
        box.appendChild(el('div', {
          class: 'aidrama-emptyText',
          text: '新建一个项目即可开始：从一句想法出发，依次完成剧情、分场脚本、设定集、三视图与分镜参考图，最后提交视频生成。',
        }))
        box.appendChild(button('＋ 新建短剧', () => { void createProject() }, { variant: 'primary' }))
        const chips = el('div', { class: 'aidrama-emptyChips', attrs: { style: 'margin-top:14px' } })
        for (const [label, logline] of [
          ['悬疑 · 末班地铁', '末班地铁的广播员发现，每晚都会多出一个不存在的站名。'],
          ['甜宠 · 合租合约', '为了拿到租房补贴，两个陌生人签下了一年的假恋爱合约。'],
          ['复仇 · 旧钟表店', '修表匠用二十年时间，等那个害死他师父的人上门。'],
        ]) {
          chips.appendChild(el('button', {
            class: 'aidrama-chip',
            attrs: { type: 'button', title: logline },
            text: label,
            on: { click: () => { void createProjectFromTemplate(label, logline) } },
          }))
        }
        box.appendChild(chips)
        return box
      }

      /** Create a project pre-seeded with a logline. */
      const createProjectFromTemplate = async (title, logline) => {
        if (state.busy) return
        state.busy = true
        schedule()
        try {
          const project = await api.createProject({ title, logline })
          await loadProjects()
          await loadProject(str(project?.id))
        } catch (error) {
          setError('projectsError', error)
        } finally {
          state.busy = false
          schedule()
        }
      }

      const renderMenu = () => {
        const menu = el('div', { class: 'aidrama-menu' })
        const entries = [
          ['分镜脚本 Markdown', 'markdown'],
          ['提示词包', 'prompt-pack'],
          ['项目 JSON', 'json'],
        ]
        for (const [label, format] of entries) {
          menu.appendChild(el('button', {
            text: label,
            attrs: { type: 'button' },
            on: { click: () => { void doExport(format) } },
          }))
        }
        return menu
      }

      const renderLightbox = () => {
        if (state.lightbox === null) return null
        const { url, name } = state.lightbox
        const box = el('div', {
          class: 'aidrama-lightbox',
          on: { click: () => { state.lightbox = null; schedule() } },
        }, [
          el('img', { attrs: { src: url, alt: name }, on: { click: (event) => event.stopPropagation() } }),
          el('div', { class: 'aidrama-caption', text: name }),
          el('button', {
            class: 'aidrama-lightboxClose',
            text: '×',
            attrs: { type: 'button', 'aria-label': '关闭' },
            on: { click: (event) => { event.stopPropagation(); state.lightbox = null; schedule() } },
          }),
        ])
        return box
      }

      const renderOverlay = () => {
        const overlay = el('div', {
          class: 'aidrama-overlay',
          attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '短剧工作台' },
          // Clicking the scrim (but not the card) dismisses — one of the three
          // independent exits, alongside Esc and the X button.
          on: {
            click: (event) => {
              if (event.target === overlay) close()
            },
          },
          ...(state.open ? {} : { dataset: { hidden: '' } }),
        })

        const head = el('div', { class: 'aidrama-head' }, [
          el('span', { class: 'aidrama-logo' }, [ico('film', 15)]),
          el('h2', { text: '短剧工作台' }),
          el('span', { class: 'aidrama-eyebrow', attrs: { style: 'margin-left:2px' }, text: 'STUDIO' }),
          el('div', { class: 'aidrama-headSpacer' }),
        ])

        if (state.projectId !== '' && state.project !== null) {
          const title = str(state.project.title) || '未命名短剧'
          head.appendChild(el('span', { class: 'aidrama-hint', text: title }))
          head.appendChild(button('总览', () => selectStage('home')))
          head.appendChild(button('设置', () => selectStage('settings')))
          const menuWrap = el('div', { class: 'aidrama-menuBtn' })
          menuWrap.appendChild(button('导出 ▾', () => { state.menuOpen = !state.menuOpen; schedule() }))
          if (state.menuOpen) menuWrap.appendChild(renderMenu())
          head.appendChild(menuWrap)
          head.appendChild(button('删除', () => { void removeProject(state.projectId) }, { variant: 'danger' }))
        }
        head.appendChild(closeButton())

        const main = el('div', { class: 'aidrama-main' })
        if (state.projectId !== '' && state.project !== null) {
          main.appendChild(renderSteps())
        }
        main.appendChild(renderPanel())
        main.appendChild(renderHints())

        // The card. Marked so the scrim's click handler can tell a click on the
        // panel from a click on the surrounding backdrop.
        const shell = el('div', { class: 'aidrama-shell' }, [
          head,
          el('div', { class: 'aidrama-body' }, [renderRail(), main]),
        ])
        overlay.appendChild(shell)

        const lightbox = renderLightbox()
        const fragment = document.createDocumentFragment()
        fragment.appendChild(overlay)
        if (lightbox !== null) fragment.appendChild(lightbox)
        return fragment
      }

      const render = () => {
        if (container === null) return
        try {
          const fragment = renderOverlay()
          container.textContent = ''
          container.appendChild(fragment)
        } catch (error) {
          console.warn('[dsh-aidrama] render failed:', error)
        }
        try {
          if (typeof host?.onOpenChange === 'function') host.onOpenChange(state.open)
        } catch (error) {
          console.warn('[dsh-aidrama] open-state notify failed:', error)
        }
        // Separate from onOpenChange: that one only fires on value CHANGE, so
        // it could never refresh the sidebar's status line after a data update.
        try {
          if (typeof host?.onRender === 'function') host.onRender()
        } catch (error) {
          console.warn('[dsh-aidrama] render notify failed:', error)
        }
      }

      const isOpen = () => state.open

      const mount = () => {
        try {
          container.textContent = ''
          render()
        } catch (error) {
          console.warn('[dsh-aidrama] workbench mount failed:', error)
        }

        // ---------------------------------------------------------------- *
        // Keyboard + scroll ownership.
        //
        // The panel previously had NO key handler at all: Esc did nothing, and
        // the only way out was one small header button. This adds the exits
        // people actually reach for, in priority order so that Esc peels one
        // layer at a time (lightbox -> menu -> panel) instead of nuking the
        // whole surface while a user is just trying to close an image.
        // ---------------------------------------------------------------- *
        const onKeyDown = (event) => {
          if (!state.open) return

          // Never steal keys from a field the user is typing in: the stage JSON
          // editor is a textarea, and swallowing digits there would be hostile.
          const tag = str(event.target?.tagName).toLowerCase()
          const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable === true

          if (typing) {
            if (event.key !== 'Escape') return
          }

          if (event.key === 'Escape') {
            if (state.lightbox !== null && state.lightbox !== undefined) {
              event.preventDefault()
              state.lightbox = null
              schedule()
              return
            }
            if (state.menuOpen) {
              event.preventDefault()
              state.menuOpen = false
              schedule()
              return
            }
            event.preventDefault()
            close()
            return
          }

          if (typing) return

          // 1-6 jump to a stage, 0 returns to the overview. Advertised by the
          // hint bar, so the keys have to actually exist.
          const digit = str(event.key)
          if (/^[0-6]$/.test(digit) && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (state.projectId === '' || state.project === null) return
            event.preventDefault()
            selectStage(digit === '0' ? 'home' : STAGE_IDS[Number(digit) - 1])
          }
        }

        // While the modal is open the page behind it must not scroll; otherwise
        // a wheel gesture over the backdrop scrolled the conversation and the
        // panel felt glued to the document instead of floating above it.
        const previousOverflow = document.body.style.overflow
        const onOpenChange = (isOpenNow) => {
          try {
            document.body.style.overflow = isOpenNow ? 'hidden' : previousOverflow
          } catch (error) {
            console.warn('[dsh-aidrama] scroll lock failed:', error)
          }
        }

        document.addEventListener('keydown', onKeyDown, true)
        if (host !== null && typeof host === 'object') host.onOpenChange = onOpenChange

        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          try {
            document.body.style.overflow = previousOverflow
          } catch {
            /* body may be gone during teardown */
          }
          try {
            container.textContent = ''
          } catch (error) {
            console.warn('[dsh-aidrama] workbench teardown failed:', error)
          }
        }
      }

      /**
       * One-line status for the sidebar entry.
       *
       * Returns null when nothing is open, so the caller falls back to a
       * generic tagline rather than rendering "未命名 · 0/6".
       */
      const summary = () => {
        const project = state.project
        if (project === null || state.projectId === '') return null
        const title = str(project.title) || '未命名短剧'
        const rows = stageRows()
        const done = rows.filter(r => str(r.status) === STAGE_STATUS.ready).length
        return `${title} · ${done}/${rows.length} 阶段`
      }

      return { mount, open, close, isOpen, render, summary }
    }

    /* ---------------------------------------------------------------- *
     * Sidebar entry. Inserted beside the shell's New Session button and
     * re-added after React rebuilds the sidebar.
     * ---------------------------------------------------------------- */

    const SIDEBAR_SELECTOR = [
      '[data-pane="sidebar"]',
      '[class*="sidebarCol"]',
      '[class*="dshDesktopSidebarSurface"]',
      '[class*="dshDesktopUpstreamSidebar"]',
    ].join(', ')

    const NEW_SESSION_LABELS = ['new session', 'new chat', '新会话', '新建会话', '新对话', '新话题']

    const looksLikeNewSession = (target) => {
      const name = `${target.getAttribute?.('aria-label') ?? ''} ${target.getAttribute?.('title') ?? ''} ${target.textContent ?? ''}`
        .toLowerCase()
        .replace(/\s+/g, ' ')
      return NEW_SESSION_LABELS.some(label => name.includes(label))
    }

    /** The shell's New Session button, hooked or label-matched. */
    const findNewSessionButton = (root) => {
      const hooked = root.querySelector('button[data-dsh-part="new-session"], button[class*="newSession"]')
      if (hooked !== null) return hooked
      const labelled = Array.from(root.querySelectorAll('button')).find(looksLikeNewSession)
      if (labelled !== undefined) return labelled
      return undefined
    }

    /** The sidebar shell root, or undefined while it is not mounted. */
    const findSidebarRoot = () => {
      const column = document.querySelector(SIDEBAR_SELECTOR)
      const logoRow = (column ?? document).querySelector('[class*="logoRow"]')
      if (logoRow !== null && logoRow.parentElement !== null) return logoRow.parentElement
      if (column === null) return undefined
      // IMPORTANT: do NOT return `column.firstElementChild` blindly — on a shell
      // that renders the New Session button as the sidebar's first child, that
      // IS the button, and searching for the button INSIDE it then finds
      // nothing (the entry would silently never mount). Return the narrowest
      // node that actually CONTAINS a New Session button, else the column.
      if (findNewSessionButton(column) !== undefined) return column
      return column.firstElementChild ?? column
    }

    /**
     * Mount the workbench entry into the sidebar.
     *
     * Returns a disposer that removes everything added and restores the
     * original DOM exactly, so unloading leaves the shell untouched.
     */
    const mountSidebarEntry = (controller, onOpen) => {
      let root
      let entry
      let anchor

      const syncActive = () => {
        if (entry === undefined) return
        // Guard BOTH writes with an actual-change check. This runs from the
        // MutationObserver callback below, and a no-op DOM write still emits an
        // attribute/childList mutation. Without the guard, writing textContent
        // (which replaces the text node) or toggling an attribute re-triggers
        // the observer → ensure → syncActive → write, an infinite microtask
        // loop that pegs the renderer at 100% and locks the UI.
        const shouldBeActive = controller.isOpen() === true
        // Read via getAttribute (present on any DOM element and every test
        // stub) rather than hasAttribute, and write via set/removeAttribute.
        // `dataset.active = ''` / `delete dataset.active` cannot remove a
        // valueless `data-active=""` — the active highlight would stick forever.
        const isActive = entry.getAttribute('data-active') !== null
        if (shouldBeActive !== isActive) {
          if (shouldBeActive) entry.setAttribute('data-active', '')
          else entry.removeAttribute('data-active')
        }

        // Keep the status line current. Without this the entry froze on
        // whatever was open when it first mounted, which is worse than showing
        // nothing — it silently misreports progress.
        const summary = typeof controller.summary === 'function' ? controller.summary() : null
        const next = summary ?? '从想法到成片'
        const meta = entry.__meta
        if (meta !== undefined && meta.textContent !== next) meta.textContent = next
      }

      const ensure = () => {
        root = findSidebarRoot()
        if (root === undefined) return
        const button = findNewSessionButton(root)
        if (button === undefined) return
        const parent = button.parentElement
        if (parent === null) return

        // Already correctly placed: the entry is a live child of the same
        // parent, immediately after the current New Session button. Checking
        // POSITION (not just isConnected) is what makes this idempotent — React
        // can rebuild the button's wrapper and leave our node connected but
        // stranded, or move the button out from under us.
        const placed = entry !== undefined
          && entry.isConnected
          && entry.parentNode === parent
          && button.nextSibling === entry
        if (placed) {
          syncActive()
          return
        }

        entry?.remove()
        entry = undefined
        anchor = button

        const meta = el('div', { class: 'aidrama-entryMeta' })
        const node = el('button', {
          class: 'aidrama-entry',
          attrs: { type: 'button', 'aria-label': '短剧工作台', title: '短剧工作台 · AI 短剧生产工作台', 'data-dsh-aidrama-entry': '' },
          on: { click: () => onOpen() },
        }, [
          // A gradient app mark, matching the panel's header logo, so the entry
          // reads as the same product rather than a generic menu row.
          el('span', { class: 'aidrama-entryMark' }, [icon(CLAPPER_ICON, 15)]),
          el('span', { class: 'aidrama-entryText' }, [
            el('span', { class: 'aidrama-entryName' }, [
              el('span', { text: '短剧工作台' }),
              el('span', { class: 'aidrama-entryTag', text: 'STUDIO' }),
            ]),
            meta,
          ]),
        ])
        // Live status line: which project is open and how far along it is.
        // `syncActive` refills this whenever the workbench re-renders.
        meta.textContent = '从想法到成片'
        // Insert AFTER the New Session button so the shell's own affordance
        // keeps its position.
        parent.insertBefore(node, button.nextSibling)
        node.__meta = meta
        entry = node
        syncActive()
      }

      let observer
      let scheduled = false
      // Coalesce mutation bursts into a single reconcile on the next microtask.
      // A burst (e.g. React committing a sidebar rebuild) otherwise fires the
      // callback once per record, and each run re-queries the whole document.
      const scheduleEnsure = () => {
        if (scheduled) return
        scheduled = true
        const run = () => {
          scheduled = false
          try {
            ensure()
          } catch (error) {
            console.warn('[dsh-aidrama] sidebar re-add failed:', error)
          }
        }
        if (typeof queueMicrotask === 'function') queueMicrotask(run)
        else Promise.resolve().then(run)
      }
      try {
        observer = new MutationObserver((records) => {
          // Ignore batches made up ENTIRELY of our own entry's subtree. Our
          // writes there cannot change where the entry belongs, and treating
          // them as external changes is exactly what turned a stray no-op
          // write into an infinite reconcile loop. A batch that touches the
          // shell's sidebar (outside `entry`) still reconciles.
          const onlyOwnWrites = entry !== undefined
            && typeof entry.contains === 'function'
            && records.length > 0
            && records.every((record) => entry.contains(record.target))
          if (onlyOwnWrites) return
          scheduleEnsure()
        })
        observer.observe(document.body, { childList: true, subtree: true })
      } catch (error) {
        console.warn('[dsh-aidrama] sidebar observer unavailable:', error)
      }

      try {
        ensure()
      } catch (error) {
        console.warn('[dsh-aidrama] sidebar entry mount failed:', error)
      }

      return {
        /** Re-add and refresh the entry; safe to call before it is mounted. */
        sync: () => {
          try {
            ensure()
          } catch (error) {
            console.warn('[dsh-aidrama] sidebar sync failed:', error)
          }
        },
        dispose: () => {
          try {
            observer?.disconnect()
          } catch {
            /* ignore */
          }
          // Remove by SELECTOR as well as by reference: a detached-then-readded
          // React rebuild can leave an orphan we no longer hold.
          try {
            entry?.remove()
          } catch {
            /* ignore */
          }
          try {
            for (const node of document.querySelectorAll('[data-dsh-aidrama-entry]')) node.remove()
          } catch (error) {
            console.warn('[dsh-aidrama] sidebar entry cleanup failed:', error)
          }
          entry = undefined
          anchor = undefined
        },
      }
    }

    /* ---------------------------------------------------------------- *
     * apply — the only context entry point. MUST NOT THROW.
     * ---------------------------------------------------------------- */

    /**
     * @param {object} ctx cordis client context. `ctx.get(name)` returns
     *   undefined for an absent service; `ctx.effect(fn, label)` runs `fn`
     *   and disposes its return value with the fiber.
     */
    function apply(ctx) {
      try {
        const runEffect = (fn, label) => {
          try {
            if (ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function') {
              return ctx.effect(fn, label)
            }
          } catch (error) {
            console.warn(`[dsh-aidrama] ctx.effect(${label}) unavailable:`, error)
          }
          // Without a fiber the surface still needs to exist; run it detached.
          try {
            fn()
          } catch (error) {
            console.warn(`[dsh-aidrama] ${label} failed:`, error)
          }
          return () => {}
        }

        runEffect(() => injectCss(), 'dsh-aidrama: stylesheet')

        runEffect(() => {
          const container = document.createElement('div')
          container.dataset.dshAidramaWorkbench = ''
          document.body.appendChild(container)

          let workbench
          let syncEntry = () => {}
          const open = () => {
            try {
              workbench?.open()
            } catch (error) {
              console.warn('[dsh-aidrama] open failed:', error)
            }
          }
          workbench = createWorkbench(container, {
            onOpenChange: () => {},
            // Refresh the sidebar entry's status line whenever the workbench
            // repaints, so it tracks the open project instead of freezing.
            // `syncEntry` is reassigned below once the entry actually mounts.
            onRender: () => {
              try {
                syncEntry()
              } catch (error) {
                console.warn('[dsh-aidrama] sidebar sync failed:', error)
              }
            },
          })
          const unmountWorkbench = workbench.mount()
          const entryHandle = mountSidebarEntry(workbench, open)
          const unmountEntry = entryHandle.dispose
          syncEntry = entryHandle.sync

          return () => {
            try {
              unmountEntry()
            } catch (error) {
              console.warn('[dsh-aidrama] sidebar teardown failed:', error)
            }
            try {
              unmountWorkbench()
            } catch (error) {
              console.warn('[dsh-aidrama] workbench teardown failed:', error)
            }
            try {
              container.remove()
            } catch {
              /* already detached */
            }
          }
        }, 'dsh-aidrama: workbench')

        return undefined
      } catch (error) {
        // A throw here blanks the whole GUI. Never.
        console.warn('[dsh-aidrama] apply failed:', error)
        return undefined
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
