/**
 * dsh-aidrama — prompt & template layer.
 *
 * This module owns EVERY prompt string the plugin sends upstream:
 *
 *   1. the fixed zh-CN scaffolding (quality boosters, negative lists);
 *   2. the three image-prompt builders (角色三视图 / 场景主图 / 分镜参考图);
 *   3. the motion-first video prompt builder;
 *   4. the style-DNA layer and the deterministic layer merge;
 *   5. the exact JSON contracts the conversational model must satisfy for the
 *      four text stages (idea / story / script / bible).
 *
 * Design rules (do not break them):
 *   - Plain ESM JavaScript, zero dependencies, no imports except the frozen
 *     `./protocol.js` contract. No network, no filesystem.
 *   - Every builder returns a SINGLE-LINE string. The image/video APIs take one
 *     string, never an object, so nothing may ever stringify an object into the
 *     prompt. `undefined` must never leak into output.
 *   - Sections are joined with the full-width comma `，` — never `,` — so a
 *     stray `,,` is structurally impossible.
 *   - Builders are pure and total: unknown / missing vars degrade to a sensible
 *     default rather than throwing. Only genuinely unusable input
 *     (e.g. a missing script scene during breakdown) throws.
 */

import {
  PROJECT_DEFAULTS,
  ASPECT_RATIOS,
  ASSET_KIND,
  STAGE_META,
} from './protocol.js'
import { STORY_BRIEF_OVERLAY, mergeSchemaAdditions } from './story.js'

/* ------------------------------------------------------------------ *
 * 0. internal helpers
 * ------------------------------------------------------------------ */

/** Full-width comma: the one and only section separator. */
const SEP = '，'

/** Fallback visual style when neither the caller nor the project sets one. */
const DEFAULT_STYLE = PROJECT_DEFAULTS.styleDna

/** Fallback aspect ratio. */
const DEFAULT_RATIO = PROJECT_DEFAULTS.aspectRatio

/** Fallback per-shot nominal duration, in seconds. */
const DEFAULT_SHOT_SECONDS = PROJECT_DEFAULTS.shotSeconds

/**
 * Normalize one scalar into a trimmed prompt-safe string.
 *
 * `undefined`, `null`, booleans, functions and symbols collapse to `''`.
 * Numeric zero also collapses to `''`: a field left at `0` by a half-built
 * form (or by `Number('')`) is missing data, not the literal string "0", and
 * shipping `服装：0` into a paid image prompt is worse than dropping the field.
 * Arrays are joined with `，` after normalizing each member, so nested arrays
 * flatten one level. Plain objects return `''` on purpose: silently emitting
 * `[object Object]` into a paid image prompt is worse than dropping the field.
 *
 * @param {unknown} value
 * @returns {string}
 */
function txt(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value === 0) return ''
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.map(txt).filter(Boolean).join(SEP)
  }
  return ''
}

/**
 * Normalize into a string array (for negative lists / character name lists).
 * Accepts an array, a `，`- or `,`-separated string, a character object with a
 * `name`/`title`/`id`, or nothing.
 *
 * Objects matter here: `buildShotRef` is routinely handed bible character cards
 * (`{ id, name, ... }`) rather than bare names, and dropping them would silently
 * un-name every character in the frame and break the on-model lock.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function list(value) {
  if (Array.isArray(value)) {
    return value.flatMap(item => list(item))
  }
  if (typeof value === 'string') {
    return value
      .split(/[，,、\n]/)
      .map(part => part.trim())
      .filter(Boolean)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)]
  if (value && typeof value === 'object') {
    const named = txt(value.name) || txt(value.title) || txt(value.id) || txt(value.label)
    return named ? [named] : []
  }
  return []
}

/**
 * Join labelled sections into ONE prompt line.
 *
 * Empty / label-only sections are dropped; nothing is emitted for a missing
 * field. `，`-prefixed labels are used so the result reads as a structured
 * brief rather than a sentence.
 *
 * @param {Array<[string, unknown]>} entries
 * @returns {string}
 */
function sections(entries) {
  return entries
    .map(([label, value]) => {
      const body = txt(value)
      return body ? `${label}：${body}` : ''
    })
    .filter(Boolean)
    .join(SEP)
}

/**
 * Drop duplicate sections while preserving order — a manual note that repeats
 * the style block should not be sent twice.
 *
 * @param {unknown} value
 * @returns {string}
 */
function uniq(value) {
  const seen = new Set()
  return list(value)
    .filter(part => {
      const key = part.replace(/\s+/g, '')
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .join(SEP)
}

/**
 * Coerce a duration into a whole, sane number of seconds.
 * @param {unknown} value
 * @returns {number}
 */
function seconds(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SHOT_SECONDS
  return Math.min(60, Math.max(1, n))
}

/**
 * Resolve an aspect ratio against the frozen allow-list.
 * @param {unknown} value
 * @returns {string}
 */
function ratio(value) {
  const raw = txt(value)
  if (ASPECT_RATIOS.includes(raw)) return raw
  return DEFAULT_RATIO
}

/**
 * Human phrase for an aspect ratio (used inside the 画幅 section).
 * @param {string} value
 * @returns {string}
 */
function ratioPhrase(value) {
  const r = ratio(value)
  if (r === '9:16') return `${r} 竖屏`
  if (r === '16:9') return `${r} 横屏`
  if (r === '1:1') return `${r} 方形`
  if (r === '3:4') return `${r} 竖幅`
  return `${r} 横幅`
}

/**
 * Pixel size hint for an aspect ratio, capped at 4K-class output.
 * @param {unknown} value
 * @returns {string}
 */
function pixelHint(value) {
  const r = ratio(value)
  const map = {
    '9:16': '1080x1920',
    '16:9': '1920x1080',
    '1:1': '1440x1440',
    '3:4': '1200x1600',
    '4:3': '1600x1200',
  }
  return `输出 ${map[r]} 像素`
}

/**
 * Name a subject inside a shot. Falls back to a neutral placeholder so the
 * surrounding sentence never collapses to a dangling 「」 pair.
 * @param {unknown} value
 * @returns {string}
 */
function subject(value) {
  return txt(value) || '画面主体'
}

/* ------------------------------------------------------------------ *
 * 1. fixed prompt vocabulary
 * ------------------------------------------------------------------ */

/**
 * Reusable quality clauses. `mergeLayers` concatenates a chosen subset and the
 * builders reference the same wording, so an operator editing a booster changes
 * every prompt that uses it.
 *
 * @type {Record<string, string>}
 */
export const QUALITY_BOOSTERS = {
  /** Photographic / render fidelity. */
  ultra: '8K 超高清，次世代 PBR 渲染，电影级柔和轮廓光，统一 85mm 焦距，微弱景深，无畸变',
  /** Surface detail — keeps skin and cloth from reading as plastic. */
  material: '细腻皮肤质感，次表面散射，发丝分层精细，布料纹理清晰，金属与皮革有真实高光',
  /** Colour / contrast discipline shared by every frame in an episode. */
  color: '统一色温 5600K，低饱和高级灰，暗部保留细节，高光不死白，全片色调一致',
  /** Clean sheet backdrop — no gradients, no props, no narrative. */
  clean: '纯色干净背景，无环境杂物，无投影，无多余元素，主体边缘清晰',
  /** Neutral grey sheet backdrop (the character-sheet default). */
  cleanGray: '均匀浅灰色摄影棚背景，背景无任何图案与文字，人物身上不投射背景阴影',
  /** Character-sheet pose: nothing that hides the silhouette. */
  neutral: '中性表情（无喜无怒无悲），眼神平视镜头，自然站立，双臂自然下垂，空手无持物，身上无任何背包与配饰遮挡',
  /** Anti-dramatic pose for reference plates. */
  plain: '无夸张动作，无戏剧化姿态，无动作模糊，全身舒展，手指自然分开不遮挡躯干',
  /** Consistency lock 1/3 — declared separately so it can be asserted. */
  consistentFace: '所有视图面部特征完全一致：同一张脸、同一发型、同一发色、同一瞳色、同一肤色',
  /** Consistency lock 2/3. */
  consistentBody: '所有视图身体比例完全一致：同一头身比、同一肩宽、同一腰线、同一四肢长度、同一身高',
  /** Consistency lock 3/3. */
  consistentOutfit: '所有视图服装与配饰完全一致：同一款式、同一颜色、同一材质、同一穿法、同一件配饰',
  /** Anti-text guard reused by every builder. */
  noText: '画面内严禁出现任何文字、字母、数字、水印、logo、签名与台标',
  /** Anti-collage guard for the three-view sheet. */
  noCollage: '各视图之间保留干净间隙，严禁画面融合、严禁多手多脚、严禁面部复制粘贴',
}

/**
 * Negative prompt for the character sheet: the failure modes that actually
 * happen when a model is asked for three full-body views on one canvas.
 *
 * @type {string[]}
 */
export const CHARACTER_SHEET_NEGATIVE = [
  '视图融合',
  '面板之间特征漂移',
  '同一角色不同脸',
  '身高忽高忽低',
  '多发丝与断发',
  '多余手指',
  '六指',
  '手部畸形',
  '面部畸变',
  '身体拉长变形',
  '服装变化',
  '配饰丢失',
  '风景背景污染',
  '复杂环境光',
  '水面倒影',
  '文字',
  '水印',
  'logo',
  '签名',
  '低分辨率',
  '过度锐化',
  'jpg 噪点',
  '胶片颗粒',
  '油画笔触',
  '3D 塑料感',
]

/**
 * Negative prompt for scene / shot images.
 *
 * @type {string[]}
 */
export const GENERIC_NEGATIVE = [
  '低分辨率',
  '画面模糊',
  '运动残影',
  '畸变',
  '多余肢体',
  '多余人物',
  '面部畸变',
  '透视错误',
  '比例失调',
  '构图混乱',
  '文字',
  '水印',
  'logo',
  '签名',
  '过曝',
  '欠曝',
  '过度饱和',
  '噪点',
  '塑料质感',
  'AI 味',
]

/** Negative list for a scene plate — the same list plus an explicit empty-set. */
const SCENE_NEGATIVE = [...GENERIC_NEGATIVE, '人物', '人形剪影', '动物', '交通工具']

/** Negative list for a per-shot reference frame. */
const SHOT_NEGATIVE = [...GENERIC_NEGATIVE, '分屏', '多格漫画', '边框', '对话气泡']

/** Default motion beats when the caller supplies no shot motion. */
const MOTION_FALLBACK = '人物动作保持连贯微动，呼吸与眨眼自然'

/** Default camera moves keyed by shot size, used when `cam` is empty. */
const CAMERA_BY_SHOT = {
  大远景: '高机位缓慢横移，交代空间关系',
  远景: '缓慢推近，建立环境',
  全景: '低机位缓推，带入人物全身与空间',
  中景: '腰部高度平稳横移，轻微跟随',
  近景: '胸口高度轻推，微呼吸感',
  特写: '固定机位，极缓推近，情绪聚焦',
  大特写: '完全固定，仅保留呼吸级微动',
}

/** Slug → readable location name for scene headings such as `INT. 交易室 - 夜`. */
const LOCATION_HINTS = {
  INT: '室内',
  EXT: '室外',
  'INT/EXT': '内外景',
}

/* ------------------------------------------------------------------ *
 * 2. image prompt builders
 * ------------------------------------------------------------------ */

/**
 * 角色设定三视图 (character model sheet).
 *
 * Layout is asymmetric on purpose: a face close-up on the left and three
 * full-body views on the right, so the model gets one high-resolution face
 * reference plus an unambiguous silhouette reference. The three-fold
 * consistency lock (面部 / 身体比例 / 服装) is emitted verbatim.
 *
 * @param {object} [vars]
 * @param {string} [vars.name] character display name.
 * @param {string} [vars.description] free-form description woven into 外观.
 * @param {string} [vars.hair] 发型发色.
 * @param {string} [vars.face] 五官 / 脸型.
 * @param {string} [vars.body] 体型 / 身高 / 头身比.
 * @param {string} [vars.outfit] 服装.
 * @param {string} [vars.accessory] 配饰.
 * @param {string} [vars.pose] overrides the neutral pose clause.
 * @param {string} [vars.lighting] overrides 摄影棚三点布光.
 * @param {string} [vars.camera] overrides the fixed 85mm camera clause.
 * @param {string} [vars.style] overrides the project style DNA.
 * @param {string} [vars.aspectRatio] one of ASPECT_RATIOS.
 * @returns {string} single-line prompt.
 */
export function buildCharacterSheet(vars = {}) {
  const v = vars ?? {}
  const name = subject(v.name)
  const style = txt(v.style) || DEFAULT_STYLE
  const r = ratio(v.aspectRatio)

  const appearance = uniq([
    txt(v.description),
    txt(v.hair) && `发型发色：${txt(v.hair)}`,
    txt(v.face) && `五官脸型：${txt(v.face)}`,
    txt(v.body) && `体型身高：${txt(v.body)}`,
    txt(v.outfit) && `服装：${txt(v.outfit)}`,
    txt(v.accessory) && `配饰：${txt(v.accessory)}`,
    '年龄与五官特征在所有视图中保持恒定，不做任何美化或换脸',
  ])

  return sections([
    ['主体', `${name} 的完整角色设定图，一张画布上同时呈现正脸特写与标准三视图，非剧情场景，纯设定用途`],
    ['外观', appearance],
    ['风格', style],
    ['渲染', `${QUALITY_BOOSTERS.ultra}，${QUALITY_BOOSTERS.material}`],
    ['姿态', `${txt(v.pose) || QUALITY_BOOSTERS.neutral}，${QUALITY_BOOSTERS.plain}`],
    ['光影', txt(v.lighting) || '摄影棚三点布光，柔和主光加轮廓光，面部与服装细节清晰可见，无戏剧化光比'],
    ['镜头', txt(v.camera) || '统一 85mm 定焦，平视机位，近似正交投影，透视极小，全身与面部均无畸变'],
    ['背景', QUALITY_BOOSTERS.cleanGray],
    ['版式', [
      '左区：角色正脸特写，面部占满左区，仅到肩部，无身体入镜',
      '右区：标准角色设定三视图，横向依次排列侧视图、正视图、背视图，从头顶到脚底完整无遮挡、无裁切',
      '左右两区比例约 1:2，两区之间留干净间隙，互不重叠',
    ].join('；')],
    ['度量', '三视图人物高度统一为画面高度的 80%，头顶与脚底对齐同一水平基线，三个视图身高差不超过一个像素级误差；面部特写中两眼间距约占脸宽的四分之一，便于统一比例'],
    ['一致性', [
      QUALITY_BOOSTERS.consistentFace,
      QUALITY_BOOSTERS.consistentBody,
      QUALITY_BOOSTERS.consistentOutfit,
    ].join('；') + '；三重一致性必须同时成立，任一视图偏离即为不合格'],
    ['负面', `${QUALITY_BOOSTERS.noText}，${QUALITY_BOOSTERS.noCollage}；${CHARACTER_SHEET_NEGATIVE.join('，')}`],
    ['画幅', `${ratioPhrase(r)}，人物居中，四周留安全边距，${pixelHint(r)}`],
  ])
}

/**
 * 场景主图 (scene master / establishing plate).
 *
 * People are forbidden in frame: the plate is an environment asset that every
 * shot in that location is composited against, so a baked-in extra would
 * contradict the shot prompt.
 *
 * @param {object} [vars]
 * @param {string} [vars.name] scene display name.
 * @param {string} [vars.description] environment description.
 * @param {string} [vars.lighting] lighting mood.
 * @param {string} [vars.composition] composition note.
 * @param {string} [vars.style] overrides the project style DNA.
 * @param {string} [vars.aspectRatio] one of ASPECT_RATIOS.
 * @returns {string} single-line prompt.
 */
export function buildSceneMaster(vars = {}) {
  const v = vars ?? {}
  const name = txt(v.name) || '未命名场景'
  const style = txt(v.style) || DEFAULT_STYLE
  const r = ratio(v.aspectRatio)

  return sections([
    ['主体', `${name} 的场景主图，只呈现环境本身，${txt(v.description) || '完整交代空间尺度、材质与陈设关系'}`],
    ['风格', style],
    ['渲染', `${QUALITY_BOOSTERS.ultra}，${QUALITY_BOOSTERS.material}，${QUALITY_BOOSTERS.color}`],
    ['光影', txt(v.lighting) || '自然体积光，主光方向明确，暗部有环境反射补光，光源动机会被交代清楚'],
    ['构图', txt(v.composition) || '纵深透视，前景遮挡加中景主体加远景延伸，视线引导清晰，主次分明，地平线水平不倾斜'],
    ['细节', '地面材质、墙面质感、门窗与陈设细节完整可辨，空间尺度真实，比例参照物明确'],
    ['约束', `画面中严禁出现任何人物、人脸、人形剪影与动物，只保留空场景；${QUALITY_BOOSTERS.noText}`],
    ['画幅', `${ratioPhrase(r)}，${pixelHint(r)}`],
  ])
}

/**
 * 分镜参考图 (per-shot storyboard reference frame).
 *
 * Named characters and the named scene are woven into the prompt body, not
 * appended as an afterthought: that is what keeps a generated frame on-model
 * relative to the character sheet and the scene master.
 *
 * @param {object} [vars]
 * @param {string} [vars.description] what happens in the frame.
 * @param {string} [vars.shot] 景别 (大远景…大特写) or a numeric shot number.
 * @param {string} [vars.camera] camera angle / move.
 * @param {string} [vars.lighting] lighting.
 * @param {string} [vars.composition] composition.
 * @param {string} [vars.style] overrides the project style DNA.
 * @param {Array<string|object>} [vars.characters] named characters in frame.
 * @param {string|object} [vars.scene] the scene this frame belongs to.
 * @param {string} [vars.aspectRatio] one of ASPECT_RATIOS.
 * @returns {string} single-line prompt.
 */
export function buildShotRef(vars = {}) {
  const v = vars ?? {}
  const style = txt(v.style) || DEFAULT_STYLE
  const r = ratio(v.aspectRatio)

  // NOTE: deliberately NOT `list(v.characters)`.
  //
  // `list()` is a name-flattening helper: for any object it keeps `.name` and
  // DROPS every other field (see its definition above). That is exactly right for
  // label lists, and exactly wrong here — the appearance fields are the whole
  // point of this prompt. Using it silently discarded hair/face/body/outfit,
  // which is how a "must match the character sheet" instruction ended up being
  // sent for a character whose sheet the model had never seen.
  const castRaw = Array.isArray(v.characters) ? v.characters : (v.characters == null ? [] : [v.characters])
  const cast = castRaw.flatMap(entry => (Array.isArray(entry) ? entry : [entry]))
    .filter(entry => (typeof entry === 'string' && entry.trim() !== '') || (entry && typeof entry === 'object'))
  const sceneName = sceneLabel(v.scene)
  const shotScale = shotScaleOf(v.shot)
  const camera = txt(v.camera) || CAMERA_BY_SHOT[shotScale] || '平视机位，轻微景深，画面稳定'

  // THE CONSISTENCY FIX.
  //
  // Before this, the prompt said "画面中的 <name> 必须严格沿用其角色设定三视图"
  // while passing ONLY the name — the model was ordered to match a design it had
  // never been shown, so it invented one. A real run on the live channel produced
  // a long-haired character in a black coat for a character specified as
  // short-haired in a navy uniform with a badge. Naming a character does not
  // describe them.
  //
  // Now each character contributes its ACTUAL locked appearance. Naming and
  // describing are both required: the name ties the frame to the bible, and the
  // appearance is the only thing that can actually constrain the pixels.
  const described = cast.map(entry => {
    if (typeof entry === 'string') return { name: entry, look: '' }
    // `title` is accepted alongside `name`/`id`: bible cards authored by hand use
    // any of the three, and dropping one silently removes a character from the
    // prompt entirely.
    const name = txt(entry?.name) || txt(entry?.title) || txt(entry?.id)
    // Preference order mirrors what a character sheet can actually depict.
    const parts = [
      txt(entry?.appearance), txt(entry?.hair), txt(entry?.face),
      txt(entry?.body), txt(entry?.outfit), txt(entry?.accessory),
    ].filter(Boolean)
    return { name, look: parts.join('，') }
  })
  const withLook = described.filter(d => d.look !== '')
  const names = described.map(d => d.name).filter(Boolean)

  let onModel
  if (withLook.length > 0) {
    const lines = withLook.map(d => `${d.name}（${d.look}）`)
    onModel = `画面中的 ${lines.join('；')} 必须逐字沿用上述外观：面部、发型、体型身高、服装与配饰逐项一致，禁止换脸、换装、改年龄、改发长`
    // Any cast member we only know by name still gets the softer instruction.
    const bare = names.filter(n => !withLook.some(d => d.name === n))
    if (bare.length > 0) {
      onModel += `；${bare.join('、')} 的外观必须与本项目设定集保持一致`
    }
  } else if (names.length > 0) {
    onModel = `画面中的 ${names.join('、')} 必须严格沿用其角色设定三视图：面部、发型、体型身高、服装与配饰逐项一致，禁止换脸、换装、改年龄`
  } else {
    onModel = '画面中人物的外观必须与本项目设定集保持一致，禁止凭空新增主要角色'
  }

  const inScene = sceneName
    ? `本镜发生在场景「${sceneName}」，环境结构、陈设位置与色调必须与该场景主图完全一致，只改变机位与景别，不得改造空间`
    : '环境需与本项目已建立的场景保持一致，不得自行发明新空间'

  return sections([
    ['画面', txt(v.description) || '本镜的剧情动作与画面结果'],
    ['主体', onModel],
    ['场景', inScene],
    ['风格', style],
    ['渲染', `${QUALITY_BOOSTERS.ultra}，${QUALITY_BOOSTERS.material}，${QUALITY_BOOSTERS.color}`],
    ['景别', `${shotScale}，${shotIntent(shotScale)}`],
    ['镜头', camera],
    ['光影', txt(v.lighting) || '延续该场景主图的光源动机，人物受光方向与环境一致，面部不过曝'],
    ['构图', txt(v.composition) || '主体明确，视线留白方向正确，前中后景层次分明，画面平衡'],
    ['负面', `${QUALITY_BOOSTERS.noText}；${SHOT_NEGATIVE.join('，')}`],
    ['画幅', `${ratioPhrase(r)}，${pixelHint(r)}`],
  ])
}

/**
 * Read a scene descriptor into a display name.
 * @param {unknown} value
 * @returns {string}
 */
function sceneLabel(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return txt(value.name) || txt(value.title) || txt(value.slug)
  }
  return ''
}

/**
 * Extract the 景别 from either a scale name or a shot number.
 * @param {unknown} value
 * @returns {string}
 */
function shotScaleOf(value) {
  const raw = txt(value)
  if (!raw) return '中景'
  const named = Object.keys(CAMERA_BY_SHOT).find(key => raw.includes(key))
  if (named) return named
  return '中景'
}

/**
 * One-line directing intent per shot scale.
 * @param {string} scale
 * @returns {string}
 */
function shotIntent(scale) {
  const map = {
    大远景: '以环境压过人物，交代世界与规模',
    远景: '交代地点与人物所处的空间位置',
    全景: '完整呈现人物全身与周边环境的关系',
    中景: '聚焦人物上半身与手部动作，兼顾环境信息',
    近景: '突出人物表情与情绪变化',
    特写: '放大面部细节，情绪浓度最高',
    大特写: '只保留眼睛或手部等关键局部，制造压迫感',
  }
  return map[scale] || '服务于本镜的叙事重点'
}

/* ------------------------------------------------------------------ *
 * 3. video prompt builder
 * ------------------------------------------------------------------ */

/**
 * Motion-first video prompt.
 *
 * The upstream video models are conditioned on movement, so the prompt leads
 * with subject motion, then camera movement, then pacing — a still-frame
 * description produces a nearly static clip. Dialogue is attached only as a
 * lip-sync / line hint; it is never the first clause.
 *
 * @param {object} [vars]
 * @param {string} [vars.shot] 景别 or shot number.
 * @param {string} [vars.camera] camera angle / move.
 * @param {string} [vars.motion] subject motion description.
 * @param {number} [vars.durationSec] clip length in seconds.
 * @param {string} [vars.dialogue] the spoken line for this shot.
 * @param {string} [vars.style] overrides the project style DNA.
 * @returns {string} single-line prompt.
 */
export function buildVideoPrompt(vars = {}) {
  const v = vars ?? {}
  const style = txt(v.style) || DEFAULT_STYLE
  const secs = seconds(v.durationSec)
  const scale = shotScaleOf(v.shot)
  const camera = txt(v.camera) || CAMERA_BY_SHOT[scale] || '缓慢横移'
  const dialogue = txt(v.dialogue)

  return sections([
    ['运动', txt(v.motion) || MOTION_FALLBACK],
    ['运镜', `${camera}，整个 ${secs} 秒内运动连续不中断，起幅与落幅稳定，无镜头抖动、无跳切`],
    ['节奏', `${secs} 秒内完成起幅、推进与落幅：前 ${Math.max(1, Math.round(secs / 3))} 秒建立画面，中段进入主要动作，最后 1 秒收束并留出剪辑余量`],
    ['景别', scale],
    ['连贯性', '人物外观、服装与场景在整段视频中保持一致，禁止中途换脸、换装或改变环境结构；动作符合重力与惯性，无肢体穿模'],
    ['对话', dialogue ? `人物口型与台词同步：「${dialogue}」，仅做对口型与细微表情，不出现对话字幕` : ''] ,
    ['画面', '背景元素持续微动（布料飘动、光线变化、环境粒子），避免画面死板'],
    ['风格', style],
    ['渲染', `${QUALITY_BOOSTERS.ultra}，24fps 电影感，运动模糊自然`],
    ['负面', `${QUALITY_BOOSTERS.noText}，无变形、无闪烁、无鬼影、无帧间跳变`],
  ])
}

/* ------------------------------------------------------------------ *
 * 4. style DNA + layer merge
 * ------------------------------------------------------------------ */

/**
 * Render the style-DNA layer as one clause.
 *
 * Accepts the project string, or an object such as
 * `{ look: '3D 国漫', lighting: '柔和轮廓光' }`, or an array of clauses.
 *
 * @param {unknown} styleDna
 * @returns {string} the clause, or `''` when there is no style DNA.
 */
export function styleDnaBlock(styleDna) {
  if (Array.isArray(styleDna)) {
    const joined = uniq(styleDna)
    return joined ? `统一风格：${joined}` : ''
  }
  if (styleDna && typeof styleDna === 'object') {
    const parts = Object.entries(styleDna)
      .map(([key, value]) => {
        const body = txt(value)
        if (!body) return ''
        return `${key}：${body}`
      })
      .filter(Boolean)
    return parts.length ? `统一风格：${parts.join('，')}` : ''
  }
  const raw = txt(styleDna)
  return raw ? `统一风格：${raw}` : ''
}

/**
 * Merge the four prompt layers deterministically:
 *   style DNA → template (template-library text) → template library entry →
 *   manual operator text → injections.
 *
 * @param {object} [opts]
 * @param {unknown} [opts.styleDna] project style DNA (string or object).
 * @param {unknown} [opts.template] builder output or hand-written template.
 * @param {unknown} [opts.manual] the operator's own wording — appended LAST in
 *   the positive layer so a human note always wins over boilerplate.
 * @param {unknown} [opts.injections] reserved for future layers; non-empty
 *   values are appended after `manual`.
 * @returns {{ positive: string, negative: string }} both single-line strings.
 */
export function mergeLayers(opts = {}) {
  const o = opts ?? {}
  const positive = [
    styleDnaBlock(o.styleDna),
    txt(o.template),
    txt(o.manual),
    txt(o.injections),
  ].filter(Boolean).join(SEP)

  return { positive, negative: GENERIC_NEGATIVE.join(SEP) }
}

/* ------------------------------------------------------------------ *
 * 5. text-stage briefs (JSON contracts for the conversational model)
 * ------------------------------------------------------------------ */

/** JSON schema literal: a string field. */
const str = (description, example) => ({ type: 'string', description, example })

/** JSON schema literal: an integer field. */
const int = (description, example) => ({ type: 'integer', description, example })

/**
 * The exact JSON contract each text stage must return. `stages.js` normalizes
 * against these shapes, so a field renamed here silently drops data there.
 * Only `type` / `description` / `example` appear in the schema objects (plus
 * `items` / `properties` / `required` / `additionalProperties` on containers)
 * because the schema string is pasted verbatim into a model prompt.
 *
 * @type {Record<'idea'|'story'|'script'|'bible', { system: string, task: string, schema: string }>}
 */
export const TEXT_STAGE_BRIEF = {
  idea: {
    system: '你是资深竖屏微短剧策划，专精 60 秒到 3 分钟一集的强钩子短剧。你只输出一个 JSON 对象，不写任何解释、前言、markdown 代码块或多余文字。所有文本使用简体中文。',
    task: [
      `阶段：${STAGE_META.idea.label}。把用户模糊的念头问清楚并落成可执行的一句话故事。`,
      '要求：',
      '1. 主角必须有明确身份与一个具体、可量化的目标，不要写成"想要变强"这类空话。',
      '2. 冲突必须由同一场景内的对手施加，第一集就必须爆发，不要铺垫。',
      '3. hook 是前 3 秒就能让观众停下的画面或台词，必须可直接拍摄。',
      '4. ending 给出结局走向与回收方式，不要留开放式结尾。',
      '5. 仍然不确定的关键选择放进 questions，最多 3 条，每条都是一个具体的选择题。',
      '输出严格符合下方 JSON 契约，字段不可增删改名。',
    ].join('\n'),
    schema: JSON.stringify({
      type: 'object',
      description: 'idea 阶段的产出',
      properties: {
        title: str('剧名，6-14 字，含冲突感', '退婚后我成了首富'),
        logline: str('一句话故事，包含主角、目标、阻碍', '被逐出家门的赘婿林越，靠一手操盘术在三十天内买回自己被夺走的一切。'),
        genre: str('题材类型', '都市逆袭'),
        tone: str('基调与情绪走向', '隐忍到爆发的爽感，冷色夜景，节奏凌厉'),
        protagonist: str('主角：姓名、身份、核心欲望', '林越，28 岁，被退婚的前操盘手，想要夺回公司'),
        conflict: str('核心冲突与对手', '岳父苏建国联手旧部架空他，逼他在一个月内还清三亿'),
        hook: str('前 3 秒的钩子，可直接拍摄', '林越把退婚书拍在餐桌上，转身按下电梯里的抄底键'),
        ending: str('结局走向与情绪落点', '开盘日他买回公司，旧部集体倒戈，苏建国独自离场'),
        questions: {
          type: 'array',
          description: '最多 3 个仍需用户拍板的选择题',
          items: { type: 'string' },
          example: ['复仇线停在买回公司，还是加上感情线？'],
        },
      },
      required: ['title', 'logline', 'genre', 'tone', 'protagonist', 'conflict', 'hook', 'ending', 'questions'],
      additionalProperties: false,
    }, null, 2),
  },

  story: {
    system: '你是短剧总编剧，熟悉三幕结构与竖屏短剧的留存曲线。你只输出一个 JSON 对象，不写任何解释、前言、markdown 代码块或多余文字。所有文本使用简体中文。',
    task: [
      `阶段：${STAGE_META.story.label}。把 idea 扩成完整故事：三幕结构、人物关系、分集切分与每集钩子。`,
      '要求：',
      '1. acts 固定 3 幕，每幕的 summary 写清这一幕结束时的状态变化，不写过程。',
      '2. characters 只列真正推动剧情的 3-6 人，want 与 obstacle 必须互相冲突。',
      '3. 集数由用户设定决定；每集 60-120 秒内容量，hook 写这一集最后一秒的悬念。',
      '4. 每集都必须有一个独立小高潮，同时推进主线，不允许纯铺垫集。',
      '输出严格符合下方 JSON 契约，字段不可增删改名。',
    ].join('\n'),
    schema: JSON.stringify({
      type: 'object',
      description: 'story 阶段的产出',
      properties: {
        title: str('剧名', '退婚后我成了首富'),
        logline: str('一句话故事', '被逐出家门的赘婿林越，靠一手操盘术在三十天内买回自己被夺走的一切。'),
        theme: str('主题一句话', '尊严要靠自己挣回来'),
        synopsis: str('300-500 字故事梗概，交代起承转合', '三年前林越入赘苏家……'),
        acts: {
          type: 'array',
          description: '固定 3 幕',
          items: {
            type: 'object',
            properties: {
              no: int('幕号，1 起 3', 1),
              name: str('幕名', '第一幕：退婚'),
              summary: str('这一幕结束时的状态变化', '林越被赶出苏家，拿回第一笔本金，立下三十天之约。'),
            },
            required: ['no', 'name', 'summary'],
            additionalProperties: false,
          },
          example: [{ no: 1, name: '第一幕：退婚', summary: '林越被赶出苏家，拿回第一笔本金。' }],
        },
        characters: {
          type: 'array',
          description: '3-6 位主要人物',
          items: {
            type: 'object',
            properties: {
              name: str('姓名', '林越'),
              role: str('在故事中的功能定位', '主角'),
              want: str('他想要什么', '买回被夺走的公司'),
              obstacle: str('什么在阻止他', '苏建国冻结了他的全部账户'),
            },
            required: ['name', 'role', 'want', 'obstacle'],
            additionalProperties: false,
          },
          example: [{ name: '林越', role: '主角', want: '买回公司', obstacle: '账户被冻结' }],
        },
        episodes: {
          type: 'array',
          description: '每一集',
          items: {
            type: 'object',
            properties: {
              no: int('集号，从 1 开始', 1),
              title: str('集标题', '第 1 集：退婚书'),
              hook: str('本集最后一秒的悬念', '他按下抄底键的瞬间，屏幕上的数字开始狂跳。'),
              summary: str('本集剧情摘要，80-150 字', '苏家当众退婚，林越被赶出门……'),
            },
            required: ['no', 'title', 'hook', 'summary'],
            additionalProperties: false,
          },
          example: [{ no: 1, title: '第 1 集：退婚书', hook: '数字开始狂跳。', summary: '苏家当众退婚……' }],
        },
      },
      required: ['title', 'logline', 'theme', 'synopsis', 'acts', 'characters', 'episodes'],
      additionalProperties: false,
    }, null, 2),
  },

  script: {
    system: '你是短剧分场编剧兼导演，写出来的每一行都要能被直接拍出来。你只输出一个 JSON 对象，不写任何解释、前言、markdown 代码块或多余文字。所有文本使用简体中文。',
    task: [
      `阶段：${STAGE_META.script.label}。把 story 拆成可拍摄的场次与镜头。`,
      '要求：',
      '1. 每场必须写 location、time、characters，slug 使用「INT./EXT. 地点 - 时间」格式。',
      '2. action 只写镜头里看得见的动作与画面，不写心理活动、不写旁白。',
      '3. dialogue 每行必须带 who，who 必须是该场 characters 里的名字。',
      '4. shots 覆盖整场，每个镜头 shot 填景别（大远景/远景/全景/中景/近景/特写/大特写），camera 填机位与运动，motion 填这一镜里主体在做什么，不要复述静态画面。',
      '5. durationSec 为该镜时长，按每镜 2-8 秒估算，全场镜头时长之和应与场次体量相符。',
      '输出严格符合下方 JSON 契约，字段不可增删改名。',
    ].join('\n'),
    schema: JSON.stringify({
      type: 'object',
      description: 'script 阶段的产出',
      properties: {
        title: str('剧名', '退婚后我成了首富'),
        episodes: {
          type: 'array',
          description: '每一集的分场脚本',
          items: {
            type: 'object',
            properties: {
              no: int('集号，从 1 开始', 1),
              title: str('集标题', '第 1 集：退婚书'),
              hook: str('本集最后的悬念', '屏幕上的数字开始狂跳。'),
              scenes: {
                type: 'array',
                description: '本集场次，按播放顺序',
                items: {
                  type: 'object',
                  properties: {
                    no: int('场号，从 1 开始', 1),
                    slug: str('场次标题，格式 INT./EXT. 地点 - 时间', 'INT. 苏家餐厅 - 夜'),
                    location: str('地点', '苏家餐厅'),
                    time: str('时间', '夜'),
                    characters: { type: 'array', description: '出场人物姓名', items: { type: 'string' }, example: ['林越', '苏建国'] },
                    action: str('可拍摄的动作与画面描述', '林越把退婚书放在转盘上，推过桌面。'),
                    dialogue: {
                      type: 'array',
                      description: '对白，按顺序',
                      items: {
                        type: 'object',
                        properties: {
                          who: str('说话人，必须是本场 characters 之一', '苏建国'),
                          line: str('台词', '签了它，从今天起你跟我们苏家没关系。'),
                        },
                        required: ['who', 'line'],
                        additionalProperties: false,
                      },
                      example: [{ who: '苏建国', line: '签了它。' }],
                    },
                    durationSec: int('本场预估时长（秒）', 45),
                    shots: {
                      type: 'array',
                      description: '本场镜头表',
                      items: {
                        type: 'object',
                        properties: {
                          no: int('镜号，从 1 开始', 1),
                          shot: str('景别', '中景'),
                          camera: str('机位与运动', '低机位缓推'),
                          description: str('这一镜的画面内容', '林越站在餐桌尽头，背后落地窗外的城市灯火。'),
                          motion: str('这一镜里主体与镜头的运动', '他摘下头盔，向前迈一步，镜头随之前推。'),
                        },
                        required: ['no', 'shot', 'camera', 'description', 'motion'],
                        additionalProperties: false,
                      },
                      example: [{ no: 1, shot: '中景', camera: '低机位缓推', description: '林越站在餐桌尽头。', motion: '他向前迈一步。' }],
                    },
                  },
                  required: ['no', 'slug', 'location', 'time', 'characters', 'action', 'dialogue', 'durationSec', 'shots'],
                  additionalProperties: false,
                },
              },
            },
            required: ['no', 'title', 'hook', 'scenes'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'episodes'],
      additionalProperties: false,
    }, null, 2),
  },

  bible: {
    system: '你是短剧美术指导与角色设计统筹，负责把剧本固化成可复用的视觉资产。你只输出一个 JSON 对象，不写任何解释、前言、markdown 代码块或多余文字。所有文本使用简体中文。',
    task: [
      `阶段：${STAGE_META.bible.label}。为 script 里的每个角色与每个场景生成设定卡。`,
      '要求：',
      '1. styleDna 是一句全片统一的视觉基调，包含风格、光线、焦距与质感，之后所有图片提示词都会带上它。',
      '2. characters 的 id 用小写英文或拼音短横线形式，例如 lin-yue，必须唯一且稳定。',
      '3. appearance 是整体外观一句话；hair / face / body / outfit / accessory 必须具体到颜色、材质、款式、长度，能被图像模型直接画出来。',
      '4. sheetPrompt 是这个角色的三视图提示词，一句话、逗号分隔、自包含，不引用其他设定。',
      '5. scenes 的 kind 只能填 interior 或 exterior；lighting 要写清光源方向与色温，composition 写清机位与纵深关系。',
      '6. masterPrompt 是该场景的主图提示词，一句话、逗号分隔，必须显式写明画面中没有任何人物。',
      '输出严格符合下方 JSON 契约，字段不可增删改名。',
    ].join('\n'),
    schema: JSON.stringify({
      type: 'object',
      description: 'bible 阶段的产出',
      properties: {
        styleDna: str('全片统一的视觉基调', '3D 国漫，电影级柔和轮廓光，统一 85mm 焦距，细腻皮肤质感，无畸变'),
        characters: {
          type: 'array',
          description: '角色设定卡',
          items: {
            type: 'object',
            properties: {
              id: str('稳定唯一 id，小写短横线', 'lin-yue'),
              name: str('姓名', '林越'),
              role: str('角色定位', '主角'),
              appearance: str('整体外观一句话', '28 岁男性，利落短发，黑色高领衫外罩深灰风衣'),
              hair: str('发型发色', '两侧推短的黑色短发，发尾微翘'),
              face: str('脸型五官', '窄长脸，眉骨高，单眼皮，左眉尾有一道浅疤'),
              body: str('体型身高', '身高 183cm，八头身，肩宽腰窄，体脂偏低'),
              outfit: str('服装', '黑色高领羊毛衫，深灰色中长风衣，黑色直筒西裤'),
              accessory: str('配饰', '左手腕银色机械表，表盘无数字'),
              personality: str('性格与说话方式', '沉默克制，说话短句、不解释，情绪只在眼神里'),
              arc: str('人物弧光', '从隐忍退让到主动夺回，最后学会不再向任何人证明自己'),
              sheetPrompt: str('该角色的三视图提示词，一句话逗号分隔', '林越角色设定三视图……'),
            },
            required: ['id', 'name', 'role', 'appearance', 'hair', 'face', 'body', 'outfit', 'accessory', 'personality', 'arc', 'sheetPrompt'],
            additionalProperties: false,
          },
          example: [{ id: 'lin-yue', name: '林越', role: '主角', appearance: '28 岁男性，黑色短发。', hair: '黑色短发', face: '窄长脸', body: '183cm 八头身', outfit: '深灰风衣', accessory: '银色手表', personality: '克制', arc: '夺回一切', sheetPrompt: '林越角色设定三视图，……' }],
        },
        scenes: {
          type: 'array',
          description: '场景设定卡',
          items: {
            type: 'object',
            properties: {
              id: str('稳定唯一 id，小写短横线', 'su-dining'),
              name: str('场景名', '苏家餐厅'),
              kind: { type: 'string', description: '场景类型', enum: ['interior', 'exterior'], example: 'interior' },
              description: str('环境描述：尺度、材质、陈设', '挑高六米的现代中式餐厅，胡桃木长桌，落地窗外是整个城市的夜景。'),
              lighting: str('光源方向与色温', '顶部暖色筒灯为主光，色温 3000K，窗外冷蓝夜景作轮廓补光'),
              composition: str('机位与纵深关系', '从餐桌一端向内拍，前景是转盘与碗筷，纵深落到落地窗'),
              masterPrompt: str('该场景主图提示词，一句话，必须写明无人物', '苏家餐厅场景主图，挑高六米……画面中没有任何人物'),
            },
            required: ['id', 'name', 'kind', 'description', 'lighting', 'composition', 'masterPrompt'],
            additionalProperties: false,
          },
          example: [{ id: 'su-dining', name: '苏家餐厅', kind: 'interior', description: '现代中式餐厅。', lighting: '暖色筒灯', composition: '纵深透视', masterPrompt: '苏家餐厅场景主图……无人物' }],
        },
      },
      required: ['styleDna', 'characters', 'scenes'],
      additionalProperties: false,
    }, null, 2),
  },
}

/* ------------------------------------------------------------------ *
 * 5b. fold in the story-craft overlay (McKee structure + hook + pacing)
 * ------------------------------------------------------------------ */

/**
 * Enrich the `story` and `script` briefs with the craft layer from `story.js`.
 *
 * WHY THIS IS A FOLD AND NOT A SECOND COPY: `story.js` owns the craft rules
 * (麦基 structure beats, the value-turn rule, the front-loaded hook requirement,
 * the reversal cadence). Duplicating that text here would let the two drift, and
 * a brief that disagrees with the validator is worse than no validator at all.
 * So the addenda come from `STORY_BRIEF_OVERLAY`, and the JSON schema is merged
 * by `mergeSchemaAdditions` from the base schema rather than restated.
 *
 * INVARIANT: this must run AFTER the object literal above is constructed, and it
 * mutates that table in place. `routes.js` serves `TEXT_STAGE_BRIEF[stageId]`
 * verbatim, so the enriched briefs ship to the model automatically.
 */
for (const stageId of ['story', 'script']) {
  const overlay = STORY_BRIEF_OVERLAY[stageId]
  const base = TEXT_STAGE_BRIEF[stageId]
  if (overlay === undefined || base === undefined) continue
  if (typeof overlay.systemAddendum === 'string' && overlay.systemAddendum !== '') {
    base.system = `${base.system}\n${overlay.systemAddendum}`
  }
  if (typeof overlay.taskAddendum === 'string' && overlay.taskAddendum !== '') {
    base.task = `${base.task}\n${overlay.taskAddendum}`
  }
  // The merged schema carries both the base fields and the craft fields, so the
  // model can actually express a beat / value charge / hook type.
  base.schema = mergeSchemaAdditions(base.schema, stageId)
}

/* ------------------------------------------------------------------ *
 * 6. template catalog (what the UI lists) + shot breakdown
 * ------------------------------------------------------------------ */

/**
 * The template library the workbench renders. `kind` is an ASSET_KIND value; the
 * `shotCraft` pseudo-kind is a text-only expert brief with no image model call.
 *
 * @type {Array<{ id: string, name: string, kind: string, description: string }>}
 */
export const TEMPLATE_CATALOG = [
  {
    id: 'character-sheet',
    name: '角色设定三视图',
    kind: ASSET_KIND.characterSheet,
    description: '左区正脸特写 + 右区侧/正/背全身三视图，含身高基线与三重一致性锁，用于锁定角色外观。',
  },
  {
    id: 'scene-master',
    name: '场景主图',
    kind: ASSET_KIND.sceneMaster,
    description: '空场景环境板，显式禁止人物入镜，作为该地点所有分镜的合成底图。',
  },
  {
    id: 'shot-scene',
    name: '分镜参考图',
    kind: ASSET_KIND.shotRef,
    description: '单镜画面参考，织入角色名与场景名以保持角色与空间一致。',
  },
  {
    id: 'first-frame',
    name: '视频首帧',
    kind: ASSET_KIND.firstFrame,
    description: '逐镜视频生成的首帧图，与分镜参考同构，但更强调构图稳定性与主体居中度。',
  },
  {
    id: 'video-motion',
    name: '逐镜视频提示词',
    kind: ASSET_KIND.video,
    description: '运动优先的视频提示词：主体动作、运镜、节奏、时长与台词口型。',
  },
  {
    id: 'shot-craft',
    name: '镜头语言增强',
    kind: 'shotCraft',
    description: '把一场戏拆成可拍摄的镜头表：景别、机位、运动、时长与剪辑点。',
  },
]

/* ------------------------------------------------------------------ *
 * 7. shot breakdown (used by the visual / video stages)
 * ------------------------------------------------------------------ */

/**
 * Heuristic shot breakdown for one script scene.
 *
 * Deterministic on purpose: the same scene always yields the same shot list, so
 * re-running the visual stage does not churn asset ids. If the scene already
 * carries an authored `shots` array, that array is returned as-is.
 *
 * @param {object} [scene] a script scene ({ action, dialogue, characters, shots, durationSec }).
 * @param {object} [opts]
 * @param {number} [opts.shotSeconds] nominal per-shot duration (default 5).
 * @param {number} [opts.maxShots] hard cap on the shot count (default 12).
 * @returns {Array<{ no: number, shot: string, camera: string, description: string, motion: string, durationSec: number }>}
 * @throws {Error} when `scene` is not an object.
 */
export function buildShotBreakdown(scene, opts = {}) {
  if (!scene || typeof scene !== 'object') {
    throw new Error('buildShotBreakdown 需要一场戏的对象')
  }

  const authored = Array.isArray(scene.shots) ? scene.shots.filter(Boolean) : []
  if (authored.length) {
    return authored.map((shot, index) => {
      const s = shot && typeof shot === 'object' ? shot : {}
      return {
        no: Number.isFinite(Number(s.no)) ? Number(s.no) : index + 1,
        shot: shotScaleOf(s.shot),
        camera: txt(s.camera) || CAMERA_BY_SHOT[shotScaleOf(s.shot)] || '平视机位',
        description: txt(s.description) || txt(s.action) || '延续本场动作',
        motion: txt(s.motion) || txt(s.action) || MOTION_FALLBACK,
        durationSec: seconds(s.durationSec ?? opts.shotSeconds ?? DEFAULT_SHOT_SECONDS),
      }
    })
  }

  const maxShots = Math.max(1, Math.min(24, Number(opts.maxShots) || 12))
  const perShot = seconds(opts.shotSeconds ?? DEFAULT_SHOT_SECONDS)
  const action = txt(scene.action)
  const beats = action
    .split(/[。；;！!？?\n]+/)
    .map(part => part.trim())
    .filter(Boolean)
  const lines = Array.isArray(scene.dialogue) ? scene.dialogue.filter(Boolean) : []
  const cast = list(scene.characters)
  const who = cast.length ? cast[0] : ''

  const plan = []
  plan.push({
    shot: '全景',
    description: action || '交代本场空间与人物位置',
    motion: '人物走入画面并停在既定位置，镜头缓慢横移',
  })
  beats.forEach(beat => {
    plan.push({
      shot: '中景',
      description: beat,
      motion: '人物完成该动作，镜头轻微跟随',
    })
  })
  lines.forEach(entry => {
    const line = entry && typeof entry === 'object' ? txt(entry.line) : txt(entry)
    const speaker = entry && typeof entry === 'object' ? txt(entry.who) : who
    plan.push({
      shot: '近景',
      description: speaker ? `${speaker} 说出台词` : '人物说出台词',
      motion: `口型与台词同步，面部表情随语句变化${line ? `，台词：${line}` : ''}`,
    })
  })
  plan.push({
    shot: '特写',
    description: '本场情绪落点，给出反应镜头',
    motion: '极缓推近，仅有呼吸级微动',
  })

  return plan.slice(0, maxShots).map((item, index) => ({
    no: index + 1,
    shot: item.shot,
    camera: CAMERA_BY_SHOT[item.shot] || '平视机位',
    description: item.description,
    motion: item.motion,
    durationSec: perShot,
  }))
}

/**
 * Readable location label for a slug such as `INT. 苏家餐厅 - 夜`.
 *
 * @param {unknown} slug
 * @returns {string} e.g. `室内 苏家餐厅 · 夜` (or `''` for empty input).
 */
export function sceneHeading(slug) {
  const raw = txt(slug)
  if (!raw) return ''
  const [head, tail] = raw.split(/\s*-\s*(?=[^-]*$)/)
  const prefix = head.match(/^(INT\/EXT|INT|EXT)\.?\s*/i)
  const kind = prefix ? (LOCATION_HINTS[prefix[1].toUpperCase()] ?? prefix[1].toUpperCase()) : ''
  const place = head.replace(/^(INT\/EXT|INT|EXT)\.?\s*/i, '').trim()
  const when = txt(tail)
  const parts = [kind, place].filter(Boolean).join(' ')
  return [parts, when].filter(Boolean).join(' · ')
}

/* ------------------------------------------------------------------ *
 * 8. prompt packs consumed by the workbench / export
 * ------------------------------------------------------------------ */

/**
 * Assemble the prompt scopes for EVERY scene and shot of a script.
 *
 * This is the function `stages.js` calls when it builds the visual plan, so the
 * output shape is part of the contract:
 *
 * ```js
 * [{
 *   episode: { no, title },
 *   scene:   { no, slug, heading, location, time },
 *   master:  { positive, negative },          // one scene-master prompt
 *   shots:   [{ no, shot, camera, description, motion, durationSec,
 *               prompt: { positive, negative } }],
 * }]
 * ```
 *
 * @param {object} [script] a normalized script content object.
 * @param {object} [options]
 * @param {string} [options.styleDna] project style DNA.
 * @param {string} [options.aspectRatio] project aspect ratio.
 * @param {number} [options.shotSeconds] nominal per-shot duration.
 * @param {Record<string,object>} [options.characterById] id → bible character.
 * @param {Record<string,object>} [options.sceneById] id → bible scene.
 * @returns {Array<object>} one entry per scene, in script order.
 */
export function buildScenePromptPack(script, options = {}) {
  const s = script && typeof script === 'object' ? script : {}
  const o = options ?? {}
  const episodes = Array.isArray(s.episodes) ? s.episodes : []
  const style = txt(o.styleDna) || DEFAULT_STYLE
  const r = ratio(o.aspectRatio)
  const charById = o.characterById && typeof o.characterById === 'object' ? o.characterById : {}
  const sceneById = o.sceneById && typeof o.sceneById === 'object' ? o.sceneById : {}

  const out = []
  episodes.forEach((episode, episodeIndex) => {
    const ep = episode && typeof episode === 'object' ? episode : {}
    const epNo = Number.isFinite(Number(ep.no)) ? Number(ep.no) : episodeIndex + 1
    const scenes = Array.isArray(ep.scenes) ? ep.scenes : []
    scenes.forEach((scene, sceneIndex) => {
      const sc = scene && typeof scene === 'object' ? scene : {}
      const scNo = Number.isFinite(Number(sc.no)) ? Number(sc.no) : sceneIndex + 1
      const bibleScene = sceneById[txt(sc.sceneId)] || null
      const rawSlug = txt(sc.slug)
      const location = txt(sc.location) || txt(bibleScene?.name)
      const time = txt(sc.time)
      const heading = sceneHeading(rawSlug) || [location, time].filter(Boolean).join(' · ')

      const castIds = list(sc.characters)
      // Pass the FULL bible cards, not just names. buildShotRef needs the actual
      // appearance to constrain the image; a name alone cannot. Falls back to the
      // id when a character is missing from the bible, so an unresolved cast
      // member degrades to the softer "match the 设定集" instruction instead of
      // silently vanishing from the prompt.
      const castCards = castIds.map(id => charById[txt(id)] ?? { name: txt(id) })

      const master = {
        positive: buildSceneMaster({
          name: location || heading || `第 ${scNo} 场`,
          description: txt(bibleScene?.description) || txt(sc.action),
          lighting: txt(bibleScene?.lighting),
          composition: txt(bibleScene?.composition),
          style,
          aspectRatio: r,
        }),
        negative: SCENE_NEGATIVE.join(SEP),
      }

      const shots = buildShotBreakdown(sc, { shotSeconds: o.shotSeconds }).map(shot => {
        const shotRef = buildShotRef({
          description: shot.description,
          shot: shot.shot,
          camera: shot.camera,
          lighting: txt(bibleScene?.lighting),
          composition: txt(bibleScene?.composition),
          style,
          characters: castCards,
          scene: location || heading,
          aspectRatio: r,
        })
        return {
          ...shot,
          prompt: {
            positive: shotRef,
            negative: SHOT_NEGATIVE.join(SEP),
          },
        }
      })

      out.push({
        episode: { no: epNo, title: txt(ep.title) },
        scene: { no: scNo, slug: rawSlug, heading, location, time },
        master,
        shots,
      })
    })
  })
  return out
}

/**
 * Assemble one video prompt per shot for the whole script.
 *
 * Returned entries carry `shotId` (`shot-<ep>-<sc>-<no>`) so the caller can key
 * assets and video tasks without re-deriving ids.
 *
 * @param {object} [script]
 * @param {object} [options]
 * @param {string} [options.styleDna]
 * @param {number} [options.shotSeconds]
 * @returns {Array<{ shotId: string, episode: number, scene: number, no: number, shot: string, camera: string, durationSec: number, dialogue: string, prompt: string, negative: string }>}
 */
export function buildVideoPromptPack(script, options = {}) {
  const s = script && typeof script === 'object' ? script : {}
  const o = options ?? {}
  const episodes = Array.isArray(s.episodes) ? s.episodes : []
  const style = txt(o.styleDna) || DEFAULT_STYLE
  const out = []

  episodes.forEach((episode, episodeIndex) => {
    const ep = episode && typeof episode === 'object' ? episode : {}
    const epNo = Number.isFinite(Number(ep.no)) ? Number(ep.no) : episodeIndex + 1
    const scenes = Array.isArray(ep.scenes) ? ep.scenes : []
    scenes.forEach((scene, sceneIndex) => {
      const sc = scene && typeof scene === 'object' ? scene : {}
      const scNo = Number.isFinite(Number(sc.no)) ? Number(sc.no) : sceneIndex + 1
      const shots = buildShotBreakdown(sc, { shotSeconds: o.shotSeconds })
      shots.forEach(shot => {
        out.push({
          shotId: `shot-${epNo}-${scNo}-${shot.no}`,
          episode: epNo,
          scene: scNo,
          no: shot.no,
          shot: shot.shot,
          camera: shot.camera,
          durationSec: shot.durationSec,
          dialogue: dialogueFor(sc, shot),
          prompt: buildVideoPrompt({
            shot: shot.shot,
            camera: shot.camera,
            motion: shot.motion,
            durationSec: shot.durationSec,
            dialogue: dialogueFor(sc, shot),
            style,
          }),
          negative: GENERIC_NEGATIVE.join(SEP),
        })
      })
    })
  })
  return out
}

/**
 * Pick the dialogue line that belongs to a shot, if any.
 * @param {object} scene
 * @param {{ no: number }} shot
 * @returns {string}
 */
function dialogueFor(scene, shot) {
  const lines = Array.isArray(scene?.dialogue) ? scene.dialogue.filter(Boolean) : []
  if (!lines.length) return ''
  const entry = lines[(shot.no - 1) % lines.length]
  return entry && typeof entry === 'object' ? txt(entry.line) : txt(entry)
}
