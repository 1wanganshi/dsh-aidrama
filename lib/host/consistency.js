/**
 * dsh-aidrama — consistency locks + camera language engine (host half).
 *
 * TWO IDEAS CARRY THIS FILE. Everything else is bookkeeping around them.
 *
 * 1. **VERBATIM REUSE (一致性锁).**  `docs/research-2026.md` §一 states the root
 *    cause: 图像模型是**无状态架构**——每次生成都独立运行，不保留角色记忆. So
 *    consistency is NOT a prompt-writing skill, it is an ENGINEERING problem:
 *    the character's state has to be re-injected on every single call. The way
 *    this file does that is `lockCharacter()` / `lockScene()`: a canonical
 *    appearance string derived ONCE from the bible and then reused
 *    **byte-identically** in every downstream prompt. A paraphrase is a
 *    different character — so the canonical string is frozen, order-fixed and
 *    deduplicated, and `lockCharacter` is deterministic (same input → same
 *    bytes, asserted in docs/verify-consistency.mjs).
 *
 * 2. **MACHINE-READABLE MOVES (可解析运镜指令).**  §二 is the highest-value
 *    finding in the research: 须用可解析运镜指令替代主观词，如 `[推镜头]` 而非
 *    "很有冲击力". An adjective is not a camera instruction — it cannot be
 *    executed, checked, or re-used. So `CAMERA_MOVES` is a real vocabulary of
 *    bracketed tokens, and `auditCamera()` actively FAILS a shot whose motion
 *    text is subjective ("震撼" / "有冲击力" / "丝滑") while no technical token
 *    is present, and hands back the token the author probably meant.
 *
 * COMPOSITION, NOT DUPLICATION. This module owns no prompt vocabulary of its
 * own: it COMPOSES `./prompts.js` (buildCharacterSheet / buildSceneMaster /
 * buildShotRef / buildVideoPrompt / QUALITY_BOOSTERS / CHARACTER_SHEET_NEGATIVE
 * / GENERIC_NEGATIVE). Adding a negative term here that already lives there
 * would fork the vocabulary and silently desynchronise the two, so
 * `buildConsistencyDirectives()` re-exports the prompts.js lists by reference
 * and the self-test asserts that (assertion (i)).
 *
 * HONESTY RULES OBSERVED THROUGHOUT (docs/research-2026.md §十 / §十一):
 *   - The research is SECOND-HAND search summaries, not first-party docs, and
 *     the numeric claims (92% / 65% / 5-character ceiling) are
 *     「检索到的行业口径」 — vendor-side figures. Comments below say so; none of
 *     them is asserted as a platform guarantee.
 *   - Where a rule is a rule of thumb, the comment says `rule of thumb`.
 *   - Nothing in this file has been validated against a real image or video
 *     model. See `uncertainties()` at the bottom for the machine-readable list.
 *   - SEED INHERITANCE (继承首帧 seed) is deliberately NOT implemented. §九
 *     notes it as a consistency technique; whether any channel accepts a seed
 *     parameter is untested, and passing an unverified field would be exactly
 *     the kind of laundered guess this file refuses to make.
 *
 * Constraints: plain ESM JavaScript, node >= 22, ZERO dependencies, no network,
 * no filesystem, no clock. Every exported function is pure and total: unknown
 * or missing input degrades to a sensible default rather than throwing, with
 * `lockCharacter` / `lockScene` being the sole documented exception (they throw
 * a TypeError for a non-object, matching `buildShotBreakdown`'s precedent).
 *
 * @see docs/research-2026.md §一 (consistency), §二 (camera), §三 (first/last frame)
 */

import {
  ASSET_KIND,
  PROJECT_DEFAULTS,
  outlineId,
} from './protocol.js'

import {
  QUALITY_BOOSTERS,
  CHARACTER_SHEET_NEGATIVE,
  GENERIC_NEGATIVE,
  buildCharacterSheet,
  buildSceneMaster,
  buildShotRef,
  buildVideoPrompt,
} from './prompts.js'

/* ------------------------------------------------------------------ *
 * 0. internal helpers
 * ------------------------------------------------------------------ */

/**
 * Section separator. Matches `prompts.js` exactly: the full-width comma, never
 * an ASCII one, so a fragment composed here and a fragment composed there can
 * be concatenated without producing a `,,`-style artefact.
 */
const SEP = '，'

/**
 * Normalize one scalar into a trimmed prompt-safe string.
 *
 * Deliberately mirrors `prompts.js#txt` semantics on the cases that matter to a
 * canonical string: `0` collapses to `''` (a half-built field left at 0 is
 * missing data, not the literal "0"), objects collapse to `''` (emitting
 * `[object Object]` into a canonical lock would poison every downstream frame),
 * and arrays flatten one level joined by `，`.
 *
 * NUMBERS ARE PRESERVED EXACTLY: `178cm`, `85mm`, `183cm`, `5600K` all survive
 * as written. A canonical string that silently rounds a measurement is a
 * different character (research §一 — verbatim reuse or nothing).
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
  if (typeof value === 'boolean') return ''
  if (Array.isArray(value)) return value.map(txt).filter(Boolean).join(SEP)
  return ''
}

/**
 * Normalize into a string array. Accepts an array, a `，`/`,`/`、`-separated
 * string, a named object (`{name|title|id|label}`), or nothing.
 *
 * Objects matter for the same reason they matter in `prompts.js#list`: cast
 * lists routinely arrive as bible character cards rather than bare names.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function list(value) {
  if (Array.isArray(value)) return value.flatMap(item => list(item))
  if (typeof value === 'string') {
    return value.split(/[，,、\n]/).map(part => part.trim()).filter(Boolean)
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)]
  if (value && typeof value === 'object') {
    const named = txt(value.name) || txt(value.title) || txt(value.id) || txt(value.label)
    return named ? [named] : []
  }
  return []
}

/**
 * Deduplicate strings while preserving first-seen order.
 *
 * Dedupe is part of the canonical-string contract, not cosmetic: the bible is
 * edited by several stages and the same clause can arrive in both `appearance`
 * and `face`. Sending it twice costs tokens and mildly biases the model toward
 * the repeated attribute, so it is removed. Whitespace is collapsed for the
 * comparison key only — the surviving text is untouched, so `178cm` stays
 * `178cm`.
 *
 * @param {Iterable<string>} parts
 * @returns {string[]}
 */
function dedupe(parts) {
  const seen = new Set()
  const out = []
  for (const part of parts) {
    const body = txt(part)
    if (body === '') continue
    const key = body.replace(/\s+/g, '')
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(body)
  }
  return out
}

/**
 * Is this a non-null, non-array object?
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * FNV-1a, 32-bit, over UTF-16 code units.
 *
 * Chosen over `node:crypto` because that would be an import with no benefit:
 * this hash is a CHANGE DETECTOR for a canonical string, not a security
 * primitive. It is seeded with a fixed offset basis and iterates in string
 * order, so it is byte-for-byte reproducible across runs and machines —
 * `Math.random()` and `Date.now()` never appear near it (this module reads no
 * clock at all; a hash that changed per run would defeat its own purpose).
 *
 * @param {string} text
 * @returns {number} unsigned 32-bit
 */
function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    // Multiply by the FNV prime 16777619 modulo 2^32, via shifts, so the result
    // is exact in IEEE-754 doubles (a plain `*` would round past 2^53).
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

/**
 * Short, stable, human-quotable fingerprint of a canonical string.
 * Zero-padded to 8 hex digits so two fingerprints are always the same width
 * (a ragged width makes diffing lock output by eye needlessly hard).
 *
 * @param {string} text
 * @returns {string} e.g. `a1b2c3d4`
 */
export function fingerprintOf(text) {
  return fnv1a(txt(text)).toString(16).padStart(8, '0')
}

/**
 * The order in which character attributes are woven into the canonical string.
 *
 * ORDER IS PART OF THE CONTRACT. It is fixed so that re-serializing the same
 * character always yields byte-identical output; a set or an unordered object
 * walk would make the lock non-deterministic and break the verbatim-reuse rule
 * (research §一). The order is also the order a human art director reads a
 * model sheet in: who → how old → face → hair → body → costume → accessory.
 *
 * `k` is the canonical field name that appears in the emitted string (kept
 * ASCII-free and stable so the string stays readable in the prompt), `keys` are
 * the accepted input aliases, because bible cards, script shots and hand-typed
 * forms all use different names for the same thing (see `normalizeCharacters`
 * in `stages.js`, which already reconciles `outfit`/`costume`/`wardrobe`).
 *
 * @type {Array<{ k: string, label: string, keys: string[] }>}
 */
const CHARACTER_FIELD_ORDER = [
  // 身份先于外观：模型需要先知道「这是谁」，后面的形容词才有归属。
  { k: 'role', label: '定位', keys: ['role', 'type', 'identity'] },
  { k: 'age', label: '年龄', keys: ['age'] },
  { k: 'gender', label: '性别', keys: ['gender', 'sex'] },
  // 面部与发型是「换脸」最容易暴露的两项，放在最前，确保它们一定被写出。
  { k: 'face', label: '五官脸型', keys: ['face', 'faceShape'] },
  { k: 'hair', label: '发型发色', keys: ['hair', 'hairStyle', 'hairstyle'] },
  // 身高与头身比给出比例锚点；数字原样保留（183cm 不能变成 183）。
  { k: 'body', label: '体型身高', keys: ['body', 'build', 'figure'] },
  { k: 'outfit', label: '服装', keys: ['outfit', 'costume', 'wardrobe', 'clothing'] },
  { k: 'accessory', label: '配饰', keys: ['accessory', 'accessories'] },
]

/**
 * Read the first non-empty value among a set of aliases.
 * @param {object} source
 * @param {string[]} keys
 * @returns {string}
 */
function pick(source, keys) {
  for (const key of keys) {
    const value = txt(source?.[key])
    if (value !== '') return value
  }
  return ''
}

/**
 * Stable key for a character / scene reference.
 *
 * Prefers the bible's own `id` (stable, ASCII, already the identity anchor that
 * research §九 describes as 「绑定唯一标签存入资产库」) and only falls back to a
 * name-derived slug. Falls back to `char-x` / `scene-x` rather than throwing:
 * a nameless card still needs a ref so the plan can order it.
 *
 * @param {string} prefix
 * @param {object} source
 * @param {string} name
 * @returns {string}
 */
function refOf(prefix, source, name) {
  const declared = txt(source?.id)
  if (declared !== '') return declared
  return outlineId(prefix, name || 'x')
}

/**
 * Put a bracketed camera token at the very END of a prompt.
 *
 * WHY THIS EXISTS (research §八, quoted): 「主体场景写最前面，**运镜指令放在提示词
 * 最后**！」 The finding is explicit that the camera instruction belongs last,
 * not buried mid-string. This is the single place that rule is applied, so it
 * cannot be forgotten at one of the several call sites.
 *
 * The separator is chosen from what is already in the text, and a prompt that
 * already ends with the token is returned unchanged (idempotent), which keeps
 * re-composition from stacking `[推镜头]` twice.
 *
 * CONFIDENCE: the ordering rule is a 检索共识, and §十一 item 7 flags that
 * per-platform word-order sensitivity is UNVERIFIED. Do not treat "last" as a
 * platform guarantee; treat it as our default until a real model says otherwise.
 *
 * @param {string} prompt
 * @param {string} token a bracketed token such as `[推镜头]`
 * @returns {string}
 */
export function withCameraTail(prompt, token) {
  const base = txt(prompt)
  const tail = txt(token)
  if (tail === '') return base
  if (base === '') return tail
  if (base.endsWith(tail)) return base
  const joiner = /[。！？；;]$/.test(base) ? '' : SEP
  return `${base}${joiner}${tail}`
}

/**
 * Append one token to an existing token list without duplicating it.
 * @param {string[]} tokens
 * @param {string} token
 * @returns {string[]}
 */
function addToken(tokens, token) {
  const body = txt(token)
  if (body === '' || tokens.includes(body)) return tokens
  return [...tokens, body]
}

/**
 * Canonicalize a speed value to `slow` | `medium` | `fast` | `''`.
 *
 * Anything unrecognised yields `''` (unknown) rather than a guessed default: a
 * silent guess here would make `auditCamera` blame the author for a duration
 * mismatch the author never asked for.
 *
 * @param {unknown} value
 * @returns {'slow'|'medium'|'fast'|''}
 */
function canonSpeed(value) {
  const raw = txt(value).toLowerCase()
  if (raw === '') return ''
  if (['slow', '缓', '缓慢', '慢', '慢速'].includes(raw)) return 'slow'
  if (['fast', '快', '快速', '急', '急速'].includes(raw)) return 'fast'
  if (['medium', '中', '中速', '正常', '匀速'].includes(raw)) return 'medium'
  return ''
}

/* ------------------------------------------------------------------ *
 * PART A-1 — the lock levels
 * ------------------------------------------------------------------ */

/**
 * How strongly a target's appearance is actually pinned, weakest → strongest.
 *
 * This is the answer to "how is consistency being achieved for THIS asset".
 * The workbench and the host must be able to say which level a target was
 * generated at, because the levels are not interchangeable and pretending they
 * are is how a project ships a recast character.
 *
 * Research §一 lays out exactly this ladder (提示词描述 → 参考图 → 角色专属 ID →
 * LoRA / 人脸融合) and observes that the gap between the weak and strong
 * options is mostly about the REFERENCE IMAGE, not the wording. Levels 0-2 are
 * the ones this plugin can reach; level 3 is documented for completeness only
 * and is deliberately NOT produced by any function here (research §六 lists
 * LoRA training among the things the plugin does not adopt, because it needs
 * training infrastructure the plugin does not have).
 *
 * @type {{ promptOnly: 0, lockedPrompt: 1, referenceImage: 2, trainedModel: 3 }}
 */
export const CONSISTENCY_LOCK = Object.freeze({
  /** 0 — appearance is only whatever the shot text happens to say. Drifty. */
  promptOnly: 0,
  /** 1 — a canonical lock string is re-injected verbatim on every call. */
  lockedPrompt: 1,
  /** 2 — the lock string PLUS an already-generated sheet/master as a condition. */
  referenceImage: 2,
  /** 3 — a per-character trained adapter. Out of scope; kept for the enum. */
  trainedModel: 3,
})

/**
 * zh-CN descriptions, so the UI can render "this asset is at level 1" as
 * something a human can act on rather than as a bare integer.
 *
 * @type {Record<number, { id: string, label: string, description: string }>}
 */
export const CONSISTENCY_LOCK_META = Object.freeze({
  0: {
    id: 'prompt-only',
    label: '仅提示词',
    description: '外观只靠本镜提示词里的临时描述，不注入锁定串。跨镜极易变脸，仅在草稿阶段使用。',
  },
  1: {
    id: 'locked-prompt',
    label: '锁定描述',
    description: '把从设定集导出的 canonical 外观串原样重复注入每一次调用。模型无状态，所以每次都必须重灌，一字不改。',
  },
  2: {
    id: 'reference-image',
    label: '参考图',
    description: '在锁定描述之外，再把已生成的角色三视图／场景主图作为条件输入带上。检索资料显示参考图条件是一致性提升的主要来源。',
  },
  3: {
    id: 'trained-model',
    label: '专属模型',
    description: '按角色训练专属权重。本插件不实现（需要训练基础设施），此枚举仅用于说明强度上限。',
  },
})

/**
 * Human-readable description of a lock level.
 * @param {number} level
 * @returns {string}
 */
export function describeLockLevel(level) {
  const meta = CONSISTENCY_LOCK_META[Number(level)]
  return meta ? `${meta.label}（第 ${Number(level)} 级）：${meta.description}` : '未知的一致性等级'
}

/**
 * Practical ceiling on how many characters may share one frame before their
 * features start contaminating each other.
 *
 * SOURCE, AND ITS LIMITS: research §一 quotes a Nano Banana note that the model
 * 「可以在一次生成中最多保持 **5 个角色**」. That is a VENDOR-SIDE CLAIM about
 * one model family, not a measurement of this plugin's channels — §十一 item 3
 * explicitly lists 「一次最多 5 个角色是否适用于用户实际渠道」 as UNVERIFIED.
 * It is used here as a WARNING THRESHOLD, never as a hard block: refusing to
 * build a 6-person shot would be worse than building one and saying it is at
 * risk.
 *
 * @type {number}
 */
export const CROWD_LIMIT = 5

/* ------------------------------------------------------------------ *
 * PART A-2 — character lock
 * ------------------------------------------------------------------ */

/**
 * Derive a character's canonical lock: fingerprint + verbatim appearance string.
 *
 * CONTRACT (the whole point of the file):
 *   - PURE AND DETERMINISTIC. The same input always produces a byte-identical
 *     `canonical` and `fingerprint`. No clock, no randomness, no locale-dependent
 *     sorting, no object-key iteration order leaking into the output.
 *   - ORDER-FIXED. Attributes are emitted in `CHARACTER_FIELD_ORDER` order.
 *   - DEDUPLICATED. A clause repeated across `appearance` and `outfit` is sent once.
 *   - VERBATIM DOWNSTREAM. Callers must place `canonical` into every prompt
 *     unchanged. Re-wording it — even to improve it — produces a different
 *     character, which is the exact failure research §一 names.
 *
 * `canonical` is the plain appearance string (what goes into an image prompt);
 * `negatives` are the failure modes to fence off. `level` is 1 (lockedPrompt):
 * a lock derived from the bible has nothing to reference yet, so it cannot be
 * level 2 by itself — `buildReferencePlan` is what promotes a downstream shot
 * to level 2 once a sheet exists.
 *
 * @param {object} character a bible character card (normalizeCharacters shape)
 * @returns {{ ref: string, fingerprint: string, canonical: string, negatives: string[], level: number, name: string, tokens: string[] }}
 * @throws {TypeError} when `character` is not an object (a programming error,
 *   unlike a merely empty card, which degrades to a name-only lock)
 */
export function lockCharacter(character) {
  if (!isRecord(character)) {
    throw new TypeError('lockCharacter(character): character 必须是一个对象')
  }

  const c = character
  const name = txt(c.name) || txt(c.title) || txt(c.id) || '未命名角色'
  const ref = refOf('char', c, name)

  // 整体外观一句话优先：它是美术给这个角色的第一定义，其它字段是对它的补充说明。
  // 放在最前面，后面即使有细化描述也不会推翻它。
  // 去重按 **属性本体** 判定，而不是按整行文本：`appearance: '深灰风衣'` 与
  // `outfit: '深灰风衣'` 说的是同一件事，只应出现一次；只有当带标签的形式带来了
  // 不带标签的版本所没有的信息时（例如 appearance 是一整句话），才两者都保留。
  const claimed = list(c.appearance).flatMap(part => part.split(/[，,、]/)).map(part => part.trim()).filter(Boolean)
  const parts = dedupe([
    ...list(c.appearance),
    ...CHARACTER_FIELD_ORDER.map(field => {
      const value = pick(c, field.keys)
      if (value === '') return ''
      const values = value.split(/[，,、]/).map(part => part.trim()).filter(Boolean)
      // 该字段的每一个值都已经在 appearance 里说过 → 不再重复输出带标签的形式。
      if (values.length > 0 && values.every(item => claimed.includes(item))) return ''
      return `${field.label}：${value}`
    }),
    txt(c.personality) && `性格气质：${txt(c.personality)}`,
  ])
  const clauses = parts.filter(Boolean)

  // 空卡片不是错误，但绝不能产出空串：空 canonical 会让下游提示词静默丢失锁定。
  // 退化成「名字 + 显式占位」，让缺陷在提示词里肉眼可见，而不是消失。
  const canonical = clauses.length > 0
    ? clauses.join(SEP)
    : `${name}（设定集未提供外观字段，生成前请先补齐设定卡）`

  // negatives 直接复用 prompts.js 的三视图负面表：一致性锁与三视图要求模型的
  // 是同一批失败模式（换脸、服装变化、配饰丢失…）。在这里另开一张表等于把词表
  // 分叉，两处迟早会不一致。
  const negatives = [...CHARACTER_SHEET_NEGATIVE]

  return {
    ref,
    fingerprint: fingerprintOf(canonical),
    canonical,
    negatives,
    level: CONSISTENCY_LOCK.lockedPrompt,
    name,
    // 便于审计工具判断「这条锁定到底锁了什么」而不用再解析字符串。
    tokens: [...clauses],
  }
}

/* ------------------------------------------------------------------ *
 * PART A-3 — scene lock
 * ------------------------------------------------------------------ */

/**
 * The empty-plate clause. A scene master is an ENVIRONMENT ASSET that every
 * shot in that location is composited against, so a baked-in extra would
 * contradict the shot prompt — this mirrors `buildSceneMaster` in `prompts.js`,
 * which enforces the same rule for the same reason.
 *
 * It is stated as its own exported constant so the self-test can assert the
 * rule is present in every scene lock rather than trusting the wording.
 *
 * @type {string}
 */
export const SCENE_NO_PEOPLE_CLAUSE = '画面中严禁出现任何人物、人脸、人形剪影与动物，只保留空场景'

/**
 * Derive a scene's canonical lock.
 *
 * Same contract as `lockCharacter` (pure, deterministic, order-fixed,
 * deduplicated, reused verbatim), plus one scene-specific rule: PEOPLE ARE
 * FORBIDDEN. The master plate is an empty plate, always — see
 * `SCENE_NO_PEOPLE_CLAUSE` and research §三, where environment anchoring is what
 * lets a later shot keep its background while the framing changes.
 *
 * @param {object} scene a bible scene card (normalizeScenes shape)
 * @returns {{ ref: string, fingerprint: string, canonical: string, negatives: string[], level: number, name: string, tokens: string[] }}
 * @throws {TypeError} when `scene` is not an object
 */
export function lockScene(scene) {
  if (!isRecord(scene)) {
    throw new TypeError('lockScene(scene): scene 必须是一个对象')
  }

  const s = scene
  const name = txt(s.name) || txt(s.title) || txt(s.location) || txt(s.id) || '未命名场景'
  const ref = refOf('scene', s, name)

  // `interior` 在 stages.js 里被规范成布尔，但手写的卡片可能是 '内'/'室内'/字符串。
  // 三种形态都要识别；识别不出来就不写，绝不猜一个内景。
  const kind = typeof s.interior === 'boolean'
    ? (s.interior ? '室内' : '室外')
    : (/^(内|室内|interior|indoor|int)$/i.test(txt(s.interior)) ? '室内'
      : (/^(外|室外|exterior|outdoor|ext)$/i.test(txt(s.interior)) ? '室外' : ''))

  const clauses = dedupe([
    txt(s.description),
    kind === '' ? '' : `场景类型：${kind}`,
    // 时间与氛围会决定光照动机，是跨镜不闪烁的关键（§三：光照必须一致）。
    pick(s, ['timeOfDay', 'time']) && `时间：${pick(s, ['timeOfDay', 'time'])}`,
    pick(s, ['lighting', 'light']) && `光源：${pick(s, ['lighting', 'light'])}`,
    pick(s, ['composition']) && `机位与纵深：${pick(s, ['composition'])}`,
    pick(s, ['atmosphere', 'mood']) && `氛围：${pick(s, ['atmosphere', 'mood'])}`,
    // 空场景约束永远在最后一条，位置固定，方便自检与人工核对。
    SCENE_NO_PEOPLE_CLAUSE,
  ]).filter(Boolean)

  const canonical = clauses.length > 0
    ? clauses.join(SEP)
    : `${name}（设定集未提供环境字段，生成前请先补齐场景卡）`

  // 场景负面表 = prompts.js 的通用负面表 + 空场景专属的排除项。
  // 通用部分必须是**同一批字符串**（不是同义词），否则两处词表会分叉。
  const negatives = [...GENERIC_NEGATIVE, '人物', '人形剪影', '动物', '交通工具']

  return {
    ref,
    fingerprint: fingerprintOf(canonical),
    canonical,
    negatives,
    level: CONSISTENCY_LOCK.lockedPrompt,
    name,
    tokens: [...clauses],
  }
}

/* ------------------------------------------------------------------ *
 * PART A-4 — reference plan
 * ------------------------------------------------------------------ */

/**
 * Which visual asset kind satisfies a given target kind.
 * @type {Record<string, string | null>}
 */
const REFERENCE_KIND_FOR = {
  [ASSET_KIND.characterSheet]: null,
  [ASSET_KIND.sceneMaster]: null,
  [ASSET_KIND.shotRef]: null,
  [ASSET_KIND.firstFrame]: null,
  [ASSET_KIND.video]: null,
}

/**
 * Read the asset ids off a record, tolerating the several names the codebase
 * uses for the same thing (`normalizeCharacters` already reconciles
 * `sheetAssetId` / `threeViewAssetId` / `referenceAssetIds`).
 * @param {object} record
 * @returns {string[]}
 */
function assetIdsOf(record) {
  return dedupe([
    ...list(record?.sheetAssetId),
    ...list(record?.threeViewAssetId),
    ...list(record?.masterAssetId),
    ...list(record?.referenceAssetIds),
    ...list(record?.imageAssetId),
  ])
}

/**
 * Build an index of every asset a project already produced, keyed both by
 * asset id and by the character/scene it belongs to.
 *
 * WHY BOTH KEYS: a route may hand us a raw asset list (id-keyed), or a visual
 * payload that already links `sheetAssetId` onto the bible card (subject-keyed).
 * Supporting one and not the other would make level 2 silently unavailable on
 * half the call paths, and a silent downgrade to level 1 is precisely the
 * dishonesty this plan is supposed to prevent.
 *
 * @param {object} project
 * @returns {{ byId: Map<string, object>, bySubject: Map<string, object[]> }}
 */
function indexAssets(project) {
  const byId = new Map()
  const bySubject = new Map()

  /** @param {object} asset */
  const remember = (asset) => {
    if (!isRecord(asset)) return
    const id = txt(asset.id)
    if (id !== '') byId.set(id, asset)
    // A subject key is whatever this asset represents: a character id, a scene
    // id, or nothing (a plain generated image).
    for (const key of dedupe([
      txt(asset.characterId),
      txt(asset.sceneId),
      txt(asset.subjectId),
      txt(asset.ownerId),
    ])) {
      const bucket = bySubject.get(key)
      if (bucket) bucket.push(asset)
      else bySubject.set(key, [asset])
    }
  }

  for (const asset of Array.isArray(project?.assets) ? project.assets : []) remember(asset)

  // The visual stage may store its links on the content payload rather than in
  // `project.assets`; fold those in so a project saved mid-pipeline still plans.
  const visual = project?.content?.visual
  for (const key of ['characterSheets', 'sceneMasters', 'shotRefs']) {
    for (const row of Array.isArray(visual?.[key]) ? visual[key] : []) remember(row)
  }
  return { byId, bySubject }
}

/**
 * Find a usable reference image for a subject.
 *
 * Returns `{ allowed, ref, url }`. `allowed: false` is the HONEST failure: the
 * record names an asset but we cannot resolve it to an id or a URL, so the plan
 * must fall back to level 1 and SAY SO rather than claiming a reference image
 * was used. Fabricating a reference is worse than not having one, because the
 * caller would then skip the prompt lock too.
 *
 * @param {{ byId: Map<string, object>, bySubject: Map<string, object[]> }} index
 * @param {object} record
 * @param {string} subjectId
 * @returns {{ allowed: boolean, ref: string, url: string, reason: string }}
 */
function resolveReference(index, record, subjectId) {
  const candidates = [
    ...assetIdsOf(record),
    ...(index.bySubject.get(subjectId) ?? []).map(asset => txt(asset.id)),
  ]

  for (const id of dedupe(candidates)) {
    const asset = index.byId.get(id)
    if (!asset) {
      // The id is named but unknown to us. If it LOOKS like a resolvable asset
      // id we still do not invent a URL for it — only ids we can see are real.
      continue
    }
    const url = txt(asset.url) || txt(asset.assetUrl) || txt(asset.href)
    return { allowed: true, ref: id, url, reason: '' }
  }

  // Second pass: an asset we hold that points at this subject but whose own id
  // we never learned. Still only usable if it carries a URL.
  for (const asset of index.bySubject.get(subjectId) ?? []) {
    const url = txt(asset.url) || txt(asset.assetUrl) || txt(asset.href)
    const id = txt(asset.id)
    if (url !== '' || id !== '') return { allowed: true, ref: id, url, reason: '' }
  }

  return { allowed: false, ref: '', url: '', reason: '尚未生成对应的参考图资产' }
}

/**
 * Plan, per target, HOW consistency is achieved — explicitly and inspectably.
 *
 * The rules (research §一, and §三 for the environment half):
 *   - A character sheet or scene master is itself level 1: there is nothing to
 *     reference yet, so the canonical lock string is all we have. Claiming
 *     otherwise would be the silent lie this plan exists to prevent.
 *   - A SHOT REF (or first frame) that contains character X references X's
 *     ALREADY-GENERATED sheet → level 2. This is the reference-image lever from
 *     §一; the research quotes a 65%→92% consistency difference and attributes
 *     it mainly to the reference-image condition. Those figures are
 *     检索到的行业口径 (vendor-side), not a measurement of anything we control.
 *   - When the sheet does NOT exist yet, the target FALLS BACK to level 1 and
 *     `rationale` says so in plain Chinese. Never silently pretend.
 *   - Same for a scene master reused across shots (environment anchoring, §三:
 *     首尾帧/同场景必须保持主体、构图、光照一致).
 *
 * ORDERING: sheets and masters come first, then the shots that depend on them.
 * `planIsOrdered` lets a caller assert that before running a batch — a shot
 * planned before its own sheet is a guaranteed re-render, and worse, a wasted
 * paid call.
 *
 * @param {object} project a project document
 * @param {Array<object>} targets what to plan for; each carries
 *   `{ ref?, kind?, name?, characterIds?, sceneId?, characters?, scene? }`
 * @param {object} [options]
 * @param {object} [options.characterById] id → bible character (defaults to bible content)
 * @param {object} [options.sceneById] id → bible scene (defaults to bible content)
 * @returns {Array<{ ref: string, kind: string, level: number, usesReferenceImage: boolean, referenceRef: string, referenceUrl?: string, rationale: string, characterRefs: string[], sceneRef: string }>}
 */
export function buildReferencePlan(project, targets = [], options = {}) {
  const p = isRecord(project) ? project : {}
  const o = isRecord(options) ? options : {}
  const index = indexAssets(p)

  const bible = isRecord(p.content?.bible) ? p.content.bible : {}
  const characterById = planIndex(o.characterById ?? bible.characters)
  const sceneById = planIndex(o.sceneById ?? bible.scenes)

  const rows = (Array.isArray(targets) ? targets : []).map((target, i) => {
    const t = isRecord(target) ? target : {}
    const kind = txt(t.kind) || ASSET_KIND.shotRef
    const name = txt(t.name)
    const ref = txt(t.ref) || outlineId(kind === ASSET_KIND.video ? 'video' : 'shot', name || i + 1)

    // 这一镜出场了谁、发生在哪个场景 —— 两者决定它能不能升级到第 2 级。
    const characterRefs = dedupe([
      ...list(t.characterIds),
      ...list(t.characters),
      ...list(t.cast),
    ])
    const sceneRef = txt(t.sceneId) || txt(t.scene)

    if (kind === ASSET_KIND.characterSheet) {
      const character = characterById.get(ref) ?? characterById.get(name) ?? null
      const lock = character ? lockCharacter(character) : null
      return {
        ref,
        kind,
        level: CONSISTENCY_LOCK.lockedPrompt,
        usesReferenceImage: false,
        referenceRef: '',
        // characterRefs 记录这一行「代表了谁」。对三视图来说就是它自己 ——
        // planIsOrdered 用它来验证「引用某个角色三视图的分镜，排在该三视图之后」。
        characterRefs: [ref],
        sceneRef: '',
        rationale: `角色三视图本身就是一致性的源头，没有更上游的图可参考；以锁定描述（第 1 级）生成`
          + (lock ? `，指纹 ${lock.fingerprint}` : '（设定集中未找到该角色卡，将只按名称生成）'),
      }
    }

    if (kind === ASSET_KIND.sceneMaster) {
      const scene = sceneById.get(ref) ?? sceneById.get(name) ?? null
      const lock = scene ? lockScene(scene) : null
      return {
        ref,
        kind,
        level: CONSISTENCY_LOCK.lockedPrompt,
        usesReferenceImage: false,
        referenceRef: '',
        characterRefs: [],
        sceneRef: ref,
        rationale: `场景主图是环境锚点，没有更上游的图可参考；以锁定描述（第 1 级）生成空场景`
          + (lock ? `，指纹 ${lock.fingerprint}` : '（设定集中未找到该场景卡，将只按名称生成）'),
      }
    }

    // 分镜参考图 / 首帧：这里才可能有上游图可用。
    const wanted = []
    const missing = []
    for (const characterRef of characterRefs) {
      const character = characterById.get(characterRef)
      const found = resolveReference(index, character ?? {}, characterRef)
      if (found.allowed) wanted.push({ characterRef, ...found })
      else missing.push(character ? (txt(character.name) || characterRef) : characterRef)
    }

    const scene = sceneRef === '' ? null : (sceneById.get(sceneRef) ?? null)
    const sceneFound = sceneRef === '' ? null : resolveReference(index, scene ?? {}, sceneRef)

    if (wanted.length > 0) {
      const first = wanted[0]
      const extra = wanted.slice(1).map(item => item.ref).filter(Boolean)
      return {
        ref,
        kind,
        level: CONSISTENCY_LOCK.referenceImage,
        usesReferenceImage: true,
        referenceRef: first.ref,
        ...(first.url !== '' ? { referenceUrl: first.url } : {}),
        rationale: `本镜含角色「${first.characterRef}」，引用其已生成的角色三视图作为条件输入（第 2 级）`
          + (extra.length > 0 ? `；另有 ${extra.length} 个角色也有可用参考图` : '')
          + (missing.length > 0 ? `；${missing.join('、')} 尚无三视图，这些角色只能靠锁定描述（退回第 1 级）` : ''),
        characterRefs,
        sceneRef,
      }
    }

    if (sceneFound?.allowed) {
      return {
        ref,
        kind,
        level: CONSISTENCY_LOCK.referenceImage,
        usesReferenceImage: true,
        referenceRef: sceneFound.ref,
        ...(sceneFound.url !== '' ? { referenceUrl: sceneFound.url } : {}),
        rationale: `本镜没有可用角色三视图，但场景「${sceneRef}」已有主图，引用它做环境锚定（第 2 级）`
          + (missing.length > 0 ? `；${missing.join('、')} 尚未生成三视图，其外观依赖锁定描述` : ''),
        characterRefs,
        sceneRef,
      }
    }

    // 诚实回退：明确说明为什么没有用上参考图。绝不假装用过。
    const reasons = []
    if (characterRefs.length > 0) {
      reasons.push(missing.length === characterRefs.length
        ? `本镜角色（${missing.join('、')}）均尚未生成角色三视图`
        : `${missing.join('、')} 尚未生成角色三视图`)
    } else {
      reasons.push('本镜没有关联角色')
    }
    if (sceneRef === '') reasons.push('也没有关联场景')
    else if (!scene) reasons.push(`设定集中找不到场景「${sceneRef}」`)
    else reasons.push(`场景「${sceneRef}」的主图尚未生成`)

    return {
      ref,
      kind,
      level: CONSISTENCY_LOCK.lockedPrompt,
      usesReferenceImage: false,
      referenceRef: '',
      rationale: `退回第 1 级（锁定描述）：${reasons.join('；')}。外观一致性完全依赖 canonical 串逐字重复注入，未使用任何参考图。`,
      characterRefs,
      sceneRef,
    }
  })

  // 安全顺序：先出「被依赖的资产」（三视图 / 场景主图），再出依赖它们的镜头。
  // 排序必须稳定 —— 同一输入两次调用得到同一顺序，否则 planIsOrdered 的断言
  // 会变成掷骰子。比较键用 rank + 原始下标，所以相等项保持输入顺序。
  const rank = (row) => {
    if (row.kind === ASSET_KIND.characterSheet) return 0
    if (row.kind === ASSET_KIND.sceneMaster) return 1
    return 2
  }
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (rank(a.row) - rank(b.row)) || (a.i - b.i))
    .map(item => item.row)
}

/**
 * Index a character/scene list by id AND by name.
 *
 * Both keys are needed because a script scene refers to its cast by the name
 * written in the dialogue (`who`), while the bible keys by `id`; the reference
 * plan must resolve either.
 *
 * @param {unknown} rows
 * @returns {Map<string, object>}
 */
function planIndex(rows) {
  const map = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isRecord(row)) continue
    for (const key of dedupe([txt(row.id), txt(row.name), txt(row.title)])) {
      if (!map.has(key)) map.set(key, row)
    }
  }
  return map
}

/**
 * Assert that a plan is in dependency order: every character sheet and scene
 * master appears BEFORE any shot that references it.
 *
 * A mis-ordered plan is not a style problem — it means a shot will be rendered
 * before the sheet it was supposed to reference exists, which downgrades it to
 * level 1 without anyone noticing. So callers should check this before spending
 * money, and the self-test asserts both a good plan (true) and a deliberately
 * broken one (false).
 *
 * @param {Array<object>} plan
 * @returns {boolean}
 */
export function planIsOrdered(plan) {
  if (!Array.isArray(plan)) return false

  // `available` accumulates every ref that has already been planned. A target
  // may only lean on something that is ALREADY in `available`; if its subject
  // appears later in the plan, the plan is broken. That single rule covers both
  // failure shapes (a sheet planned after its own shot, and a referenceRef that
  // points at something still to come).
  const available = new Set()

  for (const row of plan) {
    if (!isRecord(row)) return false
    const kind = txt(row.kind)
    const ref = txt(row.ref)
    const isSource = kind === ASSET_KIND.characterSheet || kind === ASSET_KIND.sceneMaster

    if (isSource) {
      if (!isRecord(row)) return false
      if (ref !== '') available.add(ref)
      continue
    }

    // A dependent target: if it claims to USE a reference, that reference must
    // already be available earlier in the plan.
    //
    // `usesReferenceImage` without a resolvable referenceRef is itself a broken
    // row — the caller would be told a reference exists and then handed none.
    const used = txt(row.referenceRef)
    if (row.usesReferenceImage === true && used === '') return false

    // NOTE ON THE ID SPACE: `referenceRef` is an ASSET id (`asset-…`), while
    // `ref` on a source row is the SUBJECT ref (`lin-yue`). They are different
    // namespaces and are generally NOT equal, so an asset id is legitimately
    // absent from `available`. The checkable invariant is therefore the
    // *subject* link: everything in `characterRefs` must already have been
    // planned. A referenceRef that happens to name a planned row is checked
    // too (that is the hand-built-plan case), but a foreign id is not treated
    // as a violation.
    if (used !== '' && available.has(used)) continue

    for (const subject of Array.isArray(row.characterRefs) ? row.characterRefs : []) {
      const key = txt(subject)
      if (key === '') continue
      // Still available → fine. Not yet available but planned LATER → the shot
      // is running ahead of its own source, which is the bug this guard exists
      // for. Not in the plan at all → the planner never claimed a dependency.
      if (!available.has(key) && planHasRefLater(plan, key, row)) return false
    }
  }
  return true
}

/**
 * Does `ref` appear strictly AFTER `row` in the plan?
 *
 * Used by `planIsOrdered` to detect the "shot planned before its own sheet"
 * ordering bug even when the reference link was never populated (which is
 * exactly the case where the bug is invisible to a reference-only check).
 *
 * @param {Array<object>} plan
 * @param {string} ref
 * @param {object} row the dependent row
 * @returns {boolean}
 */
function planHasRefLater(plan, ref, row) {
  const start = plan.indexOf(row)
  if (start < 0) return false
  for (let i = start + 1; i < plan.length; i += 1) {
    const candidate = plan[i]
    if (!isRecord(candidate)) continue
    if (txt(candidate.ref) === ref) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * PART A-5 — crowd audit
 * ------------------------------------------------------------------ */

/**
 * Warn when one frame asks for more characters than the practical ceiling.
 *
 * Research §一 (Nano Banana note) says the same-frame ceiling is about 5 before
 * characters start contaminating each other. That is a vendor-side claim, and
 * §十一 item 3 flags it as unverified for the user's actual channels — so this
 * returns a WARNING with a suggested fix, never a block. At or below the limit
 * it is completely silent (assertion (d) checks both 6 → warns and 4 → silent,
 * so the check cannot pass vacuously).
 *
 * @param {{ characters?: unknown, ref?: string, shotRef?: string }} [input]
 * @returns {Array<{ shotRef: string, code: string, severity: string, message: string, fix: string }>}
 */
export function auditCrowd(input = {}) {
  const i = isRecord(input) ? input : {}
  const shotRef = txt(i.ref) || txt(i.shotRef) || ''
  const cast = dedupe([
    ...list(i.characters),
    ...list(i.characterIds),
    ...list(i.cast),
  ])

  if (cast.length <= CROWD_LIMIT) return []

  const overflow = cast.length - CROWD_LIMIT
  return [{
    shotRef,
    code: 'crowd-limit-exceeded',
    severity: 'warning',
    message: `本镜同框 ${cast.length} 人，超过同框实用上限 ${CROWD_LIMIT} 人（检索到的行业口径，非平台硬限制；超出后角色之间容易互相污染特征）：${cast.join('、')}`,
    fix: `建议二选一：①把本镜拆成 ${Math.ceil(cast.length / CROWD_LIMIT)} 个镜头分组交代（先主对手，再群像）；②把多出的 ${overflow} 人挤出画面（只留背影、虚焦或画外音），让同框人数回到 ${CROWD_LIMIT} 人以内。`,
  }]
}

/* ------------------------------------------------------------------ *
 * PART B-6 — camera move vocabulary
 * ------------------------------------------------------------------ */

/**
 * The canonical camera moves, as MACHINE-READABLE bracketed tokens.
 *
 * THIS IS THE POINT OF PART B. Research §二, quoting the finding this whole
 * layer is built on: 「须用**可解析运镜指令**替代主观词，如 `[推镜头]` 而非"很有
 * 冲击力"」. An adjective cannot be executed by a model, cannot be checked by a
 * tool, and cannot be varied deliberately by an editor. A token can be all
 * three. So every move here has a bracketed `token` that is emitted verbatim
 * into the prompt, and `auditCamera` fails motion text that only has adjectives.
 *
 * Backbone confirmed by the cross-referenced list in research §八:
 *   - 基础 8：推 / 拉 / 摇 / 俯仰 / 移 / 跟 / 升降 / 变焦
 *   - 进阶 4：环绕 / 希区柯克变焦 / 复合升降 / 一镜到底
 * Two further entries (手持 / 甩镜) are included because they are standard
 * working vocabulary an operator will ask for by name and because the audit
 * needs a token to SUGGEST when one is written; their comments justify them.
 *
 * Field meanings:
 *   - `effect`: what the move does to the AUDIENCE. This is the field that makes
 *     a choice defensible — "推镜头" is not justified by being pretty, it is
 *     justified by compressing space and tightening attention.
 *   - `speedRange`: [min,max] seconds over which the move reads as intended.
 *     RULE OF THUMB, derived from how long a body-scale move takes to read on
 *     screen at short-drama pacing — NOT a platform parameter. No channel is
 *     known to accept a "move speed" field at all.
 *   - `risk`: the failure mode to watch for, in the author's terms.
 *
 * @type {Array<{ id: string, name: string, token: string, zh: string, en: string, effect: string, speedRange: [number, number], whenToUse: string, risk: string, family?: string }>}
 */
export const CAMERA_MOVES = Object.freeze([
  {
    id: 'push-in',
    name: '推镜头',
    token: '[推镜头]',
    zh: '推',
    en: 'push in / dolly in',
    // 观众效果：空间被压扁、注意力被收拢，观众感到"事情正在逼近"。
    // 这是短剧里最有效的紧张度工具，因为它不改变画面内容，只改变观看距离。
    effect: '压缩空间、收拢注意力、持续加压；观众被"推着"靠近人物的心理状态，情绪浓度随距离下降而升高',
    speedRange: [2, 8],
    whenToUse: '需要强调某个人物或某个细节时；情绪升温、对方说话露馅、主角下定决心的瞬间',
    risk: '推得太快会变成廉价冲刺感；对着没有信息量的画面推进会显得空洞',
  },
  {
    id: 'pull-out',
    name: '拉镜头',
    token: '[拉镜头]',
    zh: '拉',
    en: 'pull out / dolly out',
    // 观众效果：从"参与"退到"旁观"，人物被环境吞没，产生失重与无力感。
    effect: '揭示环境、放大孤立感；观众从人物的内心退到外部，感到他被更大的世界吞没，常用于场面收束或打击之后',
    speedRange: [3, 10],
    whenToUse: '场景收尾、人物被击垮或认清现实、需要交代他所处的巨大环境时',
    risk: '拉太快会像"跑掉"；没有新信息进入画面时，拉只是无意义的后退',
  },
  {
    id: 'pan',
    name: '摇镜头',
    token: '[摇镜头]',
    zh: '摇',
    en: 'pan',
    // 观众效果：视线被牵引着"扫过"空间，观众与镜头一样不知道下一个会看到什么，
    // 因此天然带悬念。水平摇尤其适合"从一个人移到另一个人"的关系建立。
    effect: '牵引视线横向扫过空间、建立人物/物体的空间联系；观众随镜头"发现"，因此带轻微悬念感',
    speedRange: [2, 6],
    whenToUse: '交代同一空间内的两个对象及其关系（对峙双方），或扫描环境信息时',
    risk: '摇太快会糊成一片、失去信息；摇得没有落点（停在不重要的东西上）会泄气',
  },
  {
    id: 'tilt',
    name: '俯仰镜头',
    token: '[俯仰镜头]',
    zh: '俯仰',
    en: 'tilt',
    // 观众效果：垂直方向的"打量"。仰摇让人物逐级变得高大（权力上升），
    // 俯摇则相反。它把"地位变化"变成可见的运动，而不是靠台词说明。
    effect: '自上而下或自下而上打量人物，直接编码权力落差；仰摇使人物逐渐高大压迫，俯摇使其逐渐渺小',
    speedRange: [2, 6],
    whenToUse: '强调身高差与权力关系、从细节亮到全场（如从手表摇到脸）、交代建筑高度时',
    risk: '与仰视/俯视机位叠用会重复表达，反而削弱；频次过高会让画面显得晕',
  },
  {
    id: 'truck',
    name: '移镜头',
    token: '[移镜头]',
    zh: '移',
    en: 'truck / track',
    // 观众效果：摄影机在空间中平移，视差让前景与背景分离，画面立刻获得体积感。
    // 观众感到"我正走在故事里"，是沉浸感最强的基础运动。
    effect: '产生视差与纵深、把观众带进空间内部（沉浸感）；前景掠过使画面有体积，不改变被摄主体的距离',
    speedRange: [3, 8],
    whenToUse: '人物边走边说、走廊/街道的推进、需要展示空间层次与陈设时',
    risk: '横移过快会让背景条带化；在无纵深的平面前平移几乎没有效果',
  },
  {
    id: 'follow',
    name: '跟镜头',
    token: '[跟镜头]',
    zh: '跟',
    en: 'follow / tracking',
    // 观众效果：与人物保持相对静止，把"移动"交给环境。观众与人物的步调一致，
    // 因此情绪是"陪伴"而不是"观察"，适合建立共情。
    effect: '与主体同步、主体在画面中位置稳定；观众与人物步调一致，形成陪伴式的共情，环境的移动代替人物的位移',
    speedRange: [3, 10],
    whenToUse: '人物行走/奔跑的关键段落、需要观众与主角同步呼吸时',
    risk: '跟得太远失去主体感、太近则看不到环境；主体停顿时镜头也跟着僵住会显得死',
  },
  {
    id: 'crane',
    name: '升降镜头',
    token: '[升降镜头]',
    zh: '升降',
    en: 'crane / boom',
    // 观众效果：改变机位高度即改变"立场"。升镜头往往用于告别、收束、
    // 让观众以上帝视角俯看全貌；降镜头则是"降临到事件里"，用于开场代入。
    effect: '改变观者立场与视角高度：升镜头抽离并收束（上帝视角、一场戏的句号），降镜头降临并代入（进入现场、开场）',
    speedRange: [3, 10],
    whenToUse: '场景开场交代全貌（降）、段落收束与告别（升）、情绪需要"抬高"或"落地"时',
    risk: '常见的"无人机感"：速度恒定且幅度过大就会像旅游航拍，与剧作无关',
  },
  {
    id: 'zoom',
    name: '变焦镜头',
    token: '[变焦镜头]',
    zh: '变焦',
    en: 'zoom',
    // 观众效果：与"推"不同——推是摄影机真的走近，空间关系随之改变；
    // 变焦只是裁切画面，空间被压扁但没有位移。观众会感到一种"不自然的凝视"，
    // 这正是它适合表达"被盯上""突然意识到"的原因。
    effect: '在不移动机位的前提下改变视野，压缩空间但无位移；产生非自然的凝视感，适合表达突然的察觉、被注视或主观抽离',
    speedRange: [1, 4],
    whenToUse: '机位无法移动时的强调、需要极快聚焦到某细节、表达人物心理抽紧时',
    risk: '与推镜头表意相近但质感不同，混用会让观众分不清是调度还是裁切；变焦太快有廉价感',
  },
  {
    id: 'static',
    name: '固定镜头',
    token: '[固定镜头]',
    zh: '固定',
    en: 'static / locked off',
    // 观众效果：画面不动，于是观众的注意力全部落到"画面里在发生什么"——
    // 表演、调度、构图本身成为内容。它不是"没运镜"，而是一种主动选择：
    // 用静止逼观众注视。research §八 记录的失败模式恰恰相反：整场都固定，
    // 就变成"像 PPT 一样死板"。所以固定要**局部**使用。
    effect: '把节奏交给表演与剪辑；画面绝对稳定，观众注意力全部落在人物的细微动作与表情上，静止本身构成压迫或克制',
    speedRange: [1, 6],
    whenToUse: '情绪对峙的高浓度对话、需要观众死盯细节（手、眼神）、与快速剪辑形成对比时',
    risk: '整场全用固定会像 PPT 一样死板（检索到的常见失败模式）；单镜过长会让观众走神',
  },
  {
    id: 'orbit',
    name: '环绕镜头',
    token: '[环绕镜头]',
    zh: '环绕',
    en: 'orbit / arc',
    // 观众效果：把人物变成"被展览的对象"，同时用背景的持续流动制造仪式感与
    // 时间膨胀。它适合展示一个"定格时刻"（亮相、觉醒、胜利），因为运动本身
    // 在替观众表达"这个瞬间值得多看一眼"。
    effect: '把主体置于视觉中心并环绕展示，背景持续流动制造仪式感与"时间被拉长"的错觉；观众被强制从这个人的四周打量他',
    // 下界 4 秒：低于 4 秒的环绕只能扫过一个小角度，读起来不像环绕而是抖动。
    speedRange: [4, 8],
    whenToUse: '人物亮相/觉醒/胜利的定格时刻、产品与造型展示、需要强调"这个人很重要"时',
    risk: '强烈的经验性负面建议：检索原文「人物出镜视频，少用环绕」——环绕是最容易导致面部漂移的运镜（与无状态模型的根因同源），且容易让观众眩晕。有人物特写时请把它当风险项，不要无脑推荐。',
    family: 'advanced',
  },
  {
    id: 'dolly-zoom',
    name: '希区柯克变焦',
    token: '[希区柯克变焦]',
    zh: '滑动变焦',
    en: 'dolly zoom / vertigo effect',
    // 观众效果：同时推近与拉远，主体的画面占比不变而背景透视剧烈变化。
    // 观众说不清画面哪里不对，但会感到"地基在动"——因此是表达世界观崩塌、
    // 认知失衡、噩耗降临的专用工具，而非通用运镜。
    effect: '主体大小不变而背景透视反向剧烈变化，制造眩晕与空间失真的生理不适；观众感到"现实变了形"，用于表达认知崩塌与震惊',
    speedRange: [2, 6],
    whenToUse: '重大真相揭露、主角世界观被击碎的瞬间；全片最多用一到两次，否则失灵',
    risk: 'CONFIDENCE LOW（检索原文对它的描述互相矛盾：有说"背景拉伸"，有说是无人机打杆动作）。术语可用，但不要断言各平台一定认这个词，也不要把实现细节写死；且对设备/模型要求高，容易生成失败。',
    family: 'advanced',
  },
  {
    id: 'crane-compound',
    name: '复合升降',
    token: '[复合升降]',
    zh: '复合升降',
    en: 'compound crane move',
    // 观众效果：升降同时叠加横移或推拉，画面同时给出"高度变化"与"空间展开"
    // 两条信息，因此信息密度最高，常用于一个镜头顶掉数镜的段落过渡。
    effect: '同时改变高度与水平关系，一个镜头内完成"交代环境 + 落到人物"两件事；观众一次性接收到空间全貌与落点，信息密度最高',
    speedRange: [4, 12],
    whenToUse: '段落开场、需要一镜交代多层的场面（楼上楼下、人群中的一个人）',
    risk: '运动维度一多就很难在短时长里读清楚；短视频里容易被压缩成"晃了一下"，务必给足时长',
    family: 'advanced',
  },
  {
    id: 'oner',
    name: '一镜到底',
    token: '[一镜到底]',
    zh: '长镜头',
    en: 'oner / long take',
    // 观众效果：不剪切意味着时间不被打断，观众的紧张感无法通过切换镜头释放，
    // 因此累积成持续的高压。它同时是最昂贵的表达方式——一切都要一次做对。
    effect: '不通过剪辑打断时间，压迫感持续累积无法释放；观众被"锁"在连续时空里，真实感与临场感最强',
    speedRange: [6, 20],
    whenToUse: '追逐、潜入、连续对话穿越多个空间；需要真实感与压迫感的关键段落',
    risk: '单次生成能承载的长度受上游模型时长上限约束（本插件各协议的 maxDurationSec 只有 6-20 秒），所谓的"一镜到底"在本管线里通常是"一段不切的长镜头"，不要当成真的整场不切；失败一次就是整段重来',
    family: 'advanced',
  },
  {
    id: 'handheld',
    name: '手持',
    token: '[手持跟拍]',
    zh: '手持',
    en: 'handheld',
    // 观众效果：画面轻微不稳=有个人在跟着拍。观众因此相信"这件事正在发生"，
    // 而不是被安排好的。它是纪录片质感的来源，也是把观众拽进混乱的手段。
    // 纳入理由：这是操作者会直接用中文点名的工作词汇，且当作者写下"晃""不稳"
    // 这类描述时，审计需要一个确定的 token 去建议，而不是让作者继续用形容词。
    effect: '轻微不规则晃动传递"现场正在发生"的真实感与不安；观众感到有第三人近距离跟随，适合制造混乱、慌乱与临场',
    speedRange: [2, 8],
    whenToUse: '冲突爆发、追逐、急诊式的慌乱场面；伪纪实的对话段落',
    risk: '幅度不加以约束就会变成剧烈抖动，观众看不清内容且容易晕；生成模型对"晃动"的理解差异极大，务必写明幅度小',
    family: 'extended',
  },
  {
    id: 'whip-pan',
    name: '甩镜',
    token: '[甩镜]',
    zh: '甩',
    en: 'whip pan',
    // 观众效果：快到糊成一片的运动把两个空间硬接在一起，观众来不及看清过程，
    // 只感到"被打断/被拽走"。它是一个标点符号式的运镜，用来制造节奏上的重音。
    // 纳入理由：它是短剧快剪里最常见的节奏工具之一，且"流畅衔接""丝滑"这类
    // 主观词最常见的真实意图就是它——审计必须能把它建议出来。
    effect: '极快的横向甩动使中间过程糊化，把两个空间/两个对象硬性连接；观众感到节奏被猛地打断再继续，是运镜里的"重音符号"',
    speedRange: [1, 3],
    whenToUse: '快速转场、打脸/反转的瞬间切换、两人对话的激烈来回',
    risk: '一次成片里用多了就变成廉价特效；甩的方向与落点必须与下一镜的构图对得上，否则观众会迷失方向',
    family: 'extended',
  },
])

/**
 * Token → move lookup, precomputed once.
 * @type {Map<string, object>}
 */
const MOVE_BY_TOKEN = new Map(CAMERA_MOVES.map(move => [move.token, move]))

/**
 * Move id → move lookup.
 * @type {Map<string, object>}
 */
const MOVE_BY_ID = new Map(CAMERA_MOVES.map(move => [move.id, move]))

/**
 * Every token, in table order.
 * @type {string[]}
 */
export const CAMERA_TOKENS = Object.freeze(CAMERA_MOVES.map(move => move.token))

/**
 * Look up a move by token (`[推镜头]`), by id (`push-in`) or by bare Chinese
 * short name (`推`). Accepts a name embedded inside a longer string so that
 * `'低机位缓慢推近'` resolves to the push-in move.
 *
 * @param {unknown} value
 * @returns {object | undefined}
 */
export function findCameraMove(value) {
  const raw = txt(value)
  if (raw === '') return undefined
  if (MOVE_BY_TOKEN.has(raw)) return MOVE_BY_TOKEN.get(raw)
  if (MOVE_BY_ID.has(raw)) return MOVE_BY_ID.get(raw)

  // A token appearing anywhere in the text.
  for (const move of CAMERA_MOVES) {
    if (raw.includes(move.token)) return move
  }
  // A bare short name. Longest-name-first avoids '推' matching inside '推近'
  // when a more specific move was actually meant.
  const byLength = [...CAMERA_MOVES].sort((a, b) => b.zh.length - a.zh.length)
  for (const move of byLength) {
    if (raw.includes(move.zh)) return move
  }
  // English names, for prompts authored in English.
  for (const move of CAMERA_MOVES) {
    if (new RegExp(move.en.split(/[\s/]+/)[0], 'i').test(raw)) return move
  }
  return undefined
}

/**
 * Detect the camera moves actually declared in a piece of text, as an ordered,
 * de-duplicated token list.
 *
 * Used by `auditCamera` to answer "does this shot have a technical move, or
 * only adjectives?".
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function detectCameraTokens(text) {
  const raw = typeof text === 'string' ? text : txt(text)
  if (raw === '') return []
  const found = []
  for (const move of [...CAMERA_MOVES].sort((a, b) => b.zh.length - a.zh.length)) {
    if (raw.includes(move.token) || raw.includes(move.zh)) found.push(move.token)
  }
  return dedupe(found)
}

/* ------------------------------------------------------------------ *
 * PART B-7 — shot sizes and angles
 * ------------------------------------------------------------------ */

/**
 * 景别 (shot size) vocabulary, wide → tight.
 *
 * `durationRange` is a RULE OF THUMB, not a platform parameter: it encodes how
 * long a frame at that scale keeps giving the audience new information at
 * short-drama pacing. A wide shot reads more slowly than a close-up, so it
 * tolerates (and needs) more time. `prompts.js` already maps each scale to a
 * default camera move (`CAMERA_BY_SHOT`) and a directing intent
 * (`shotIntent`); this table carries the same scales so the two modules agree
 * on names, and adds the pacing dimension prompts.js does not own.
 *
 * `purpose` is the audience-facing justification — why this scale, here.
 *
 * @type {Array<{ id: string, name: string, abbr: string, zh: string, purpose: string, durationRange: [number, number] }>}
 */
export const SHOT_SIZES = Object.freeze([
  {
    id: 'extreme-wide',
    name: '大远景',
    abbr: 'EWS',
    zh: '大远景',
    // 观众效果：人在画面里只是一粒，观众先读到"世界"，再读到"人"。
    // 它提供的不是情绪而是尺度——所有个人化的感受被环境稀释掉。
    purpose: '环境压过人物、交代世界规模；观众先接收尺度与孤独，再接收人，用于开场与命运的俯瞰',
    durationRange: [3, 8],
  },
  {
    id: 'wide',
    name: '远景',
    abbr: 'WS',
    zh: '远景',
    purpose: '交代地点与人物所处的空间位置；观众理解"他在哪、离目标多远"，是空间关系的说明书',
    durationRange: [3, 7],
  },
  {
    id: 'full',
    name: '全景',
    abbr: 'FS',
    zh: '全景',
    purpose: '完整呈现人物全身与周边关系；观众能同时看到动作与姿态，是动作段落的基准景别',
    durationRange: [2, 6],
  },
  {
    id: 'medium',
    name: '中景',
    abbr: 'MS',
    zh: '中景',
    purpose: '聚焦上半身与手部动作、兼顾环境；观众既看到"谁"，也看到"他在做什么"，是对话段落的默认景别',
    durationRange: [2, 6],
  },
  {
    id: 'medium-close',
    name: '近景',
    abbr: 'MCU',
    zh: '近景',
    // 观众效果：进入"人际距离"，观众开始读表情而不是读动作。
    purpose: '突出表情与情绪变化；观众进入人际距离内，开始读脸而不是读动作，是情绪线的起点',
    durationRange: [2, 5],
  },
  {
    id: 'close-up',
    name: '特写',
    abbr: 'CU',
    zh: '特写',
    purpose: '放大面部、情绪浓度最高；观众被迫只看这一件事，注意力无法逃开，是台词的落点',
    durationRange: [1, 4],
  },
  {
    id: 'extreme-close-up',
    name: '大特写',
    abbr: 'ECU',
    zh: '大特写',
    purpose: '只保留眼睛、手或某件关键道具；观众被逼到极近距离，产生压迫与侵入感，用于悬念与转折的最后一拍',
    // LOWER BOUND = 1，因为大特写是唯一能靠"更短"换取密度的景别。
    // 上界 3 秒：再长观众就会开始等待下一件事发生，压迫感反而泄掉。
    durationRange: [1, 3],
  },
])

/** Shot-size lookup by name, abbr or id. @type {Map<string, object>} */
const SIZE_BY_KEY = (() => {
  const map = new Map()
  for (const size of SHOT_SIZES) {
    map.set(size.name, size)
    map.set(size.abbr.toLowerCase(), size)
    map.set(size.id, size)
  }
  return map
})()

/**
 * Resolve a 景别 from a name, an abbreviation, an id, or a string that merely
 * CONTAINS one (a script shot often carries `'中景'` or `'第 3 镜：中景'`).
 * Defaults to 中景 — the neutral working scale — for anything unrecognised.
 *
 * @param {unknown} value
 * @returns {object} a SHOT_SIZES entry (never undefined)
 */
export function findShotSize(value) {
  const raw = txt(value)
  if (raw === '') return SIZE_BY_KEY.get('中景')
  const direct = SIZE_BY_KEY.get(raw) ?? SIZE_BY_KEY.get(raw.toLowerCase())
  if (direct) return direct
  // Longest name first so '大远景' wins over '远景', and '大特写' over '特写'.
  const byLength = [...SHOT_SIZES].sort((a, b) => b.name.length - a.name.length)
  for (const size of byLength) {
    if (raw.includes(size.name)) return size
  }
  return SIZE_BY_KEY.get('中景')
}

/**
 * Camera-angle vocabulary, with its dramatic meaning.
 *
 * Angles are the cheapest way to encode POWER: the same action shot from below
 * and from above is two different statements about who is winning. Like the
 * move table, `meaning` is written from the audience's side — that is the only
 * form of justification that survives a review.
 *
 * @type {Array<{ id: string, name: string, zh: string, meaning: string, whenToUse: string }>}
 */
export const CAMERA_ANGLES = Object.freeze([
  {
    id: 'eye-level',
    name: '平视',
    zh: '平视',
    // 观众效果：观众与人物等高，没有权力差，因此产生"平等旁观"的认同。
    meaning: '观众与人物等高，无权力暗示；产生平等的旁观与认同，是最中性、最不易出错的机位',
    whenToUse: '常规对话、需要观众不带立场看待人物时；也是全片的默认基准机位',
  },
  {
    id: 'high-angle',
    name: '俯视',
    zh: '俯视',
    // 观众效果：从高处看下去，人物被压低，观众获得"我比他高"的隐性优越/怜悯。
    meaning: '人物被压低、显得渺小与受制；观众居高临下，产生优越、审视或怜悯，用于表现被压倒的一方',
    whenToUse: '人物失败、被审讯、被围观、感到无力时',
  },
  {
    id: 'low-angle',
    name: '仰视',
    zh: '仰视',
    meaning: '人物被抬高、显得高大与压迫；观众处于下位，产生敬畏或被威慑，用于表现掌权者与威胁',
    whenToUse: '人物得势、登场、施压、宣告胜利时',
  },
  {
    id: 'over-the-shoulder',
    name: '过肩',
    zh: '过肩',
    // 观众效果：前景的肩膀替观众"站了位置"，观众成为对话中的第三方。
    meaning: '用前景人物的肩背框住对面的脸，观众被安置在对话现场成为第三方，强化对峙关系与在场感',
    whenToUse: '两人对峙的对话、审讯、谈判；需要交代双方位置关系时',
  },
  {
    id: 'pov',
    name: '主观',
    zh: '主观',
    // 观众效果：摄影机变成人物的眼睛，观众被剥夺了旁观的安全感。
    meaning: '镜头即人物双眼，观众被迫用他的视角看世界，代入感最强同时最不安全（看不到自己身后）',
    whenToUse: '悬念、惊吓、醉酒/眩晕、需要观众与人物同步"不知道"时',
  },
  {
    id: 'bird-eye',
    name: '鸟瞰',
    zh: '鸟瞰',
    meaning: '近乎垂直的俯视把人物变成棋局上的棋子；观众获得全局与宿命感，情绪被抽离，适合表现"谁也逃不掉"',
    whenToUse: '开场交代地理、群像调度、表现命运与无力时',
  },
  {
    id: 'dutch',
    name: '斜角',
    zh: '斜角',
    // 观众效果：地平线歪了，观众本能地感到"哪里不对"，是廉价但有效的失衡信号。
    meaning: '地平线倾斜使画面失衡，观众本能感到不安与失控；用来标记精神错乱、背叛或危险逼近',
    whenToUse: '情绪失控、反转揭示、反派登场的短促段落',
  },
])

/** Angle lookup by name/id. @type {Map<string, object>} */
const ANGLE_BY_KEY = new Map(CAMERA_ANGLES.flatMap(angle => [[angle.name, angle], [angle.zh, angle], [angle.id, angle]]))

/**
 * Resolve a camera angle from a name/id, or a string containing one.
 * Defaults to 平视 (the neutral baseline).
 * @param {unknown} value
 * @returns {object} a CAMERA_ANGLES entry (never undefined)
 */
export function findCameraAngle(value) {
  const raw = txt(value)
  if (raw === '') return ANGLE_BY_KEY.get('平视')
  const direct = ANGLE_BY_KEY.get(raw) ?? ANGLE_BY_KEY.get(raw.toLowerCase())
  if (direct) return direct
  for (const angle of CAMERA_ANGLES) {
    if (raw.includes(angle.name)) return angle
  }
  return ANGLE_BY_KEY.get('平视')
}

/* ------------------------------------------------------------------ *
 * PART B-8 — pacing / edit rhythm
 * ------------------------------------------------------------------ */

/**
 * Edit-rhythm presets.
 *
 * THE RULE THIS ENCODES (research §二, and §三): keep the CAMERA movement small
 * and let the CUT carry the energy. A big camera move inside a short clip is
 * what produces tearing and mush, while a fast cut rhythm produces the felt
 * speed without asking any single frame to do too much. So rhythm is expressed
 * as shots-per-minute plus a recommended shot duration, and the move/size
 * tables then constrain what is legal within that duration.
 *
 * `shotsPerMinute` figures are a RULE OF THUMB for vertical short drama pacing
 * derived from the durations below (60 / avg duration), not measured data and
 * not a platform parameter. §四 of the research notes the platform statistics it
 * quotes are 厂商/自媒体口径 — the same caveat applies here.
 *
 * @type {Record<string, { id: string, label: string, shotSecondsRange: [number, number], shotsPerMinute: [number, number], preference: { moveIds: string[], sizeIds: string[] }, note: string }>}
 */
export const EDIT_RHYTHM = Object.freeze({
  tense: {
    id: 'tense',
    label: '紧张',
    // 观众效果：切得密，观众没有时间消化，情绪被持续推高而无法释放。
    shotSecondsRange: [1, 3],
    shotsPerMinute: [20, 40],
    preference: {
      moveIds: ['push-in', 'whip-pan', 'handheld', 'static'],
      sizeIds: ['close-up', 'extreme-close-up', 'medium-close'],
    },
    note: '冲突爆发、追逐、打脸段。靠剪辑加快，而不是靠镜头乱动——每镜只做一个小运动。',
  },
  normal: {
    id: 'normal',
    label: '常规',
    shotSecondsRange: [3, 6],
    shotsPerMinute: [10, 20],
    preference: {
      moveIds: ['push-in', 'truck', 'follow', 'pan', 'static'],
      sizeIds: ['medium', 'medium-close', 'full'],
    },
    note: '对话与推进段。默认节奏，信息量与情绪并重。',
  },
  relaxed: {
    id: 'relaxed',
    label: '舒缓',
    shotSecondsRange: [5, 10],
    shotsPerMinute: [6, 12],
    preference: {
      moveIds: ['crane', 'truck', 'orbit', 'static'],
      sizeIds: ['wide', 'extreme-wide', 'full'],
    },
    note: '交代与沉淀段。镜头可以长，运动必须更慢更平滑，让观众有时间进入空间。',
  },
})

/**
 * Default rhythm when a scene gives no signal.
 * @type {string}
 */
export const DEFAULT_RHYTHM = 'normal'

/**
 * Resolve a rhythm preset by key, id or Chinese label. Falls back to `normal`.
 * @param {unknown} value
 * @returns {object} an EDIT_RHYTHM entry
 */
export function findRhythm(value) {
  const raw = txt(value)
  if (raw !== '') {
    if (EDIT_RHYTHM[raw]) return EDIT_RHYTHM[raw]
    for (const preset of Object.values(EDIT_RHYTHM)) {
      if (preset.id === raw || preset.label === raw) return preset
    }
  }
  return EDIT_RHYTHM[DEFAULT_RHYTHM]
}

/**
 * Heuristically pick a rhythm for a scene.
 *
 * DELIBERATELY CONSERVATIVE AND EXPLAINABLE. It reads only signals that are
 * actually present in the script schema (`action`, `dialogue`, `durationSec`,
 * `characters`) and returns the preset plus the reasons, so a human can see why
 * the machine chose "tense" and override it. It guesses nothing about genre.
 *
 * The signals, in order of weight:
 *   1. A short authored `durationSec` on the scene means the writer already
 *      wants speed.
 *   2. Conflict vocabulary in the action text (打、抢、吼、扇、摔、冲…) is the
 *      script-level marker of a fight/reveal beat.
 *   3. Many dialogue lines in a short scene means rapid back-and-forth.
 * Anything else is `normal`.
 *
 * @param {object} [scene] a script scene ({ action, dialogue, durationSec, characters })
 * @returns {{ rhythm: string, preset: object, reasons: string[], confidence: 'low'|'medium' }}
 */
export function suggestRhythm(scene = {}) {
  const s = isRecord(scene) ? scene : {}
  const reasons = []
  let score = 0

  const seconds = Number(s.durationSec ?? s.durationSeconds)
  if (Number.isFinite(seconds) && seconds > 0) {
    if (seconds <= 20) {
      score += 1
      reasons.push(`本场只有 ${seconds} 秒，场次体量偏小，倾向快节奏`)
    } else if (seconds >= 90) {
      score -= 1
      reasons.push(`本场 ${seconds} 秒，场次体量偏大，倾向有呼吸的节奏`)
    }
  }

  // 冲突词汇表：这些是分场脚本里可以直接看到的「爆点」信号。
  const CONFLICT_WORDS = ['打', '抢', '吼', '扇', '摔', '冲', '砸', '推倒', '撕', '夺', '骂', '扇耳光', '尖叫']
  const action = txt(s.action)
  const hits = CONFLICT_WORDS.filter(word => action.includes(word))
  if (hits.length > 0) {
    score += 2
    reasons.push(`action 中出现冲突动作（${hits.join('、')}），属于爆发段`)
  }

  const lines = Array.isArray(s.dialogue) ? s.dialogue.filter(isRecord).length
    : (typeof s.dialogue === 'string' && s.dialogue.trim() !== '' ? list(s.dialogue).length : 0)
  if (lines >= 6 && (!Number.isFinite(seconds) || seconds <= 60)) {
    score += 1
    reasons.push(`本场有 ${lines} 句台词且时长不长，属于高频对话来回`)
  }
  if (lines > 0 && lines <= 1 && Number.isFinite(seconds) && seconds >= 45) {
    score -= 1
    reasons.push('本场台词极少但时长较长，倾向用长镜头沉淀')
  }

  const preset = score >= 2 ? EDIT_RHYTHM.tense : (score <= -1 ? EDIT_RHYTHM.relaxed : EDIT_RHYTHM.normal)
  if (reasons.length === 0) reasons.push('未发现明显的快/慢信号，采用默认常规节奏')

  return {
    rhythm: preset.id,
    preset,
    reasons,
    // 信号只有两三条、且没有实测支撑，所以最高只敢标 medium。
    confidence: reasons.length >= 2 ? 'medium' : 'low',
  }
}

/* ------------------------------------------------------------------ *
 * PART B-9 — camera audit
 * ------------------------------------------------------------------ */

/**
 * Subjective words that are NOT camera instructions.
 *
 * Research §二 names this exact failure: 「须用可解析运镜指令替代主观词，如
 * `[推镜头]` 而非"很有冲击力"」. Each entry maps to the token the author most
 * likely MEANT, so the audit can do more than complain — it can hand back an
 * executable instruction. The `hint` is the human-facing reasoning.
 *
 * The mapping is a judgement call, not a specification: "震撼" could be a crane
 * reveal or a hard push. It is offered as a SUGGESTION (`fix`), and the message
 * says so, because a wrong-but-explicit suggestion is still more useful to an
 * author than a bare rejection.
 *
 * @type {Array<{ word: string, suggest: string, hint: string }>}
 */
export const SUBJECTIVE_CAMERA_WORDS = Object.freeze([
  { word: '震撼', suggest: '[拉镜头]', hint: '「震撼」不是运镜。想让人感到规模，通常靠拉镜头把人物交还给环境' },
  { word: '有冲击力', suggest: '[推镜头]', hint: '「有冲击力」不是运镜。冲击感来自推近压缩空间，或来自剪辑点的密度' },
  { word: '冲击力', suggest: '[推镜头]', hint: '同「有冲击力」：把主观感受换成可执行的推近' },
  { word: '丝滑', suggest: '[移镜头]', hint: '「丝滑」描述的是运动品质，不是运动方式。请写明是移、跟还是环绕，并写明速度' },
  { word: '流畅', suggest: '[移镜头]', hint: '「流畅」是观感评价。请指明具体运动（移/跟/摇）与速度' },
  { word: '高级感', suggest: '[固定镜头]', hint: '「高级感」是风格判断，无法执行。想表达克制请用固定镜头，想表达展示请用环绕镜头' },
  { word: '电影感', suggest: '[推镜头]', hint: '「电影感」是结果不是指令。它来自景别、运镜、光线与节奏的具体选择' },
  { word: '大气', suggest: '[升降镜头]', hint: '「大气」通常是升降或远景的功能描述，请直接写升降镜头' },
  { word: '紧张感', suggest: '[推镜头]', hint: '「紧张感」要靠推近 + 加快剪辑实现，不要把它当运镜写' },
  { word: '压迫感', suggest: '[推镜头]', hint: '「压迫感」的可执行形式是缓慢推近或俯视机位' },
  { word: '唯美', suggest: '[环绕镜头]', hint: '「唯美」是画面风格。展示造型可写环绕镜头，但注意有人物时环绕有面部漂移风险' },
  { word: '有张力', suggest: '[推镜头]', hint: '「有张力」请换成推近或加快剪辑节奏' },
  { word: '很有感觉', suggest: '[推镜头]', hint: '「很有感觉」无法执行，请写明具体运镜与速度' },
  { word: '酷炫', suggest: '[甩镜]', hint: '「酷炫」通常指的是快速甩镜或变焦，请写明具体形式' },
  { word: '炸裂', suggest: '[甩镜]', hint: '「炸裂」是情绪形容词。快节奏请用甩镜 + 短镜切换实现' },
  { word: '动感', suggest: '[手持跟拍]', hint: '「动感」请换成明确的手持、跟镜或甩镜' },
  { word: '缓慢', suggest: '', hint: '这是速度词而不是运镜词：它必须依附于一个具体运动（如「[推镜头]，缓慢」）' },
  { word: '快速', suggest: '', hint: '这是速度词而不是运镜词：请写明快的是运镜还是剪辑' },
  { word: '自然', suggest: '', hint: '「自然」不可执行，请写明具体机位与运动' },
])

/* ------------------------------------------------------------------ *
 * PART B-10 — camera plan
 * ------------------------------------------------------------------ */

/**
 * Shot-size rotation used when a shot carries no usable 景别.
 *
 * The order is the classic establishing→intensify progression rather than a
 * random walk, so an unauthored shot list still builds a readable scene. It is
 * a rule of thumb for pacing, nothing more.
 * @type {string[]}
 */
const SIZE_ROTATION = ['全景', '中景', '近景', '特写', '中景', '近景']

/**
 * Move ids that are safe default choices for a given rhythm, used to keep an
 * auto-built plan from assigning an orbit to every dialogue beat.
 * @param {object} preset an EDIT_RHYTHM entry
 * @returns {string[]}
 */
function movePoolFor(preset) {
  const pool = Array.isArray(preset?.preference?.moveIds) ? preset.preference.moveIds : []
  return pool.length > 0 ? pool : ['push-in', 'static', 'truck']
}

/**
 * Turn a flat shot list into a shootable camera plan.
 *
 * This is the function that makes a storyboard DIRECTABLE: every shot comes out
 * with a concrete move token, 景别, angle and duration, all consistent with the
 * chosen rhythm. It never overrides an authored choice unless that choice is
 * impossible (out-of-range duration, a subjective-only camera string) — the
 * author's intent wins whenever it is executable.
 *
 * Determinism: the assignment walks the tables by index and per-shot counters;
 * there is no randomness and no clock, so the same shot list always yields the
 * same plan.
 *
 * HARD INVARIANTS (asserted by the self-test):
 *   - every `durationSec` is an integer >= 1;
 *   - every `durationSec` lies within the union of the move's `speedRange` and
 *     the size's `durationRange` (so it is always defensible by at least one
 *     table, and the union is never empty);
 *   - every `move` token exists in `CAMERA_MOVES`.
 *
 * @param {Array<object>} [shots] flat shots (flattenScriptShots shape)
 * @param {object} [options]
 * @param {string|object} [options.rhythm] EDIT_RHYTHM key/id/label, or a preset
 * @param {string} [options.styleDna] project style DNA (echoed into the plan)
 * @param {string} [options.sceneRef] scene ref recorded on every row
 * @returns {{ rhythm: string, rhythmLabel: string, styleDna: string, shots: Array<object> }}
 */
export function buildCameraPlan(shots = [], options = {}) {
  const o = isRecord(options) ? options : {}
  const preset = isRecord(o.rhythm) ? o.rhythm : findRhythm(o.rhythm)
  const styleDna = txt(o.styleDna)
  const pool = movePoolFor(preset)
  const sceneRef = txt(o.sceneRef)

  const rows = (Array.isArray(shots) ? shots : []).filter(isRecord)
  let lastMoveId = ''
  let repeatRun = 0

  const out = rows.map((shot, index) => {
    const size = findShotSize(shot.shotSize ?? shot.shot ?? shot.size ?? shot.framing)
    const angle = findCameraAngle(shot.angle ?? shot.cameraAngle ?? shot.camera)

    // 作者写下的运镜优先，只要它真的可解析。解析不出来（只有形容词）就交给
    // 节奏池决定，稍后 auditCamera 会把「你写的是主观词」报给作者。
    const authored = detectCameraTokens(shot.cameraMove ?? shot.move ?? shot.camera)
    const authoredMove = authored.length > 0 ? findCameraMove(authored[0]) : undefined

    let move = authoredMove
    if (!move) {
      // 轮转分配，并且避开**连续重复**：同一运镜连排是单调感的主要来源。
      let candidateId = pool[index % pool.length]
      if (candidateId === lastMoveId && pool.length > 1) {
        candidateId = pool[(index + 1) % pool.length]
      }
      move = MOVE_BY_ID.get(candidateId) ?? CAMERA_MOVES[0]
    }

    if (move.id === lastMoveId) repeatRun += 1
    else repeatRun = 1
    lastMoveId = move.id

    const durationSec = chooseDuration({
      authored: Number(shot.durationSeconds ?? shot.durationSec ?? shot.duration),
      move,
      size,
      preset,
    })

    const speed = speedFor(durationSec, move)
    return {
      no: Number.isFinite(Number(shot.no)) ? Number(shot.no) : index + 1,
      ref: txt(shot.id) || txt(shot.ref) || outlineId('shot', index + 1),
      sceneRef,
      size: size.name,
      sizeAbbr: size.abbr,
      angle: angle.name,
      move: move.id,
      moveName: move.name,
      moveToken: move.token,
      speed,
      durationSec,
      effect: move.effect,
      // 运镜指令压在末尾（research §八：运镜指令放在提示词最后）。
      tailToken: move.token,
      note: authoredMove
        ? `沿用作者指定的运镜「${authoredMove.name}」`
        : `未指定可解析运镜，按「${preset.label}」节奏分配「${move.name}」`,
      index,
    }
  })

  return {
    rhythm: preset.id,
    rhythmLabel: preset.label,
    styleDna,
    shots: out,
  }
}

/**
 * Choose a duration that is defensible by at least one table.
 *
 * Precedence:
 *   1. The authored duration, when it already sits in the union of the move's
 *      `speedRange` and the size's `durationRange` — the author's intent wins.
 *   2. The authored duration clamped into that union, rounded to an integer.
 *   3. The rhythm preset's preferred range, clamped into the union.
 *
 * The union is always non-empty for every (move, size) pair in these tables,
 * which is what makes invariant (g) provable rather than hopeful.
 *
 * @param {{ authored: number, move: object, size: object, preset: object }} input
 * @returns {number} integer >= 1
 */
function chooseDuration({ authored, move, size, preset }) {
  const low = Math.max(1, Math.min(move.speedRange[0], size.durationRange[0]))
  const high = Math.max(low, Math.max(move.speedRange[1], size.durationRange[1]))

  if (Number.isFinite(authored) && authored >= 1) {
    const rounded = Math.round(authored)
    return Math.min(high, Math.max(low, rounded))
  }

  const preferred = Array.isArray(preset?.shotSecondsRange) ? preset.shotSecondsRange : [3, 6]
  const target = Math.round((preferred[0] + preferred[1]) / 2)
  return Math.min(high, Math.max(low, target))
}

/**
 * Classify a duration as slow / medium / fast relative to a move's range.
 * @param {number} seconds
 * @param {object} move
 * @returns {'slow'|'medium'|'fast'}
 */
function speedFor(seconds, move) {
  const [min, max] = move.speedRange
  if (!Number.isFinite(seconds)) return 'medium'
  if (seconds <= min) return 'fast'
  if (seconds >= max) return 'slow'
  return 'medium'
}

/**
 * Audit a shot list's camera language and return real, actionable findings.
 *
 * Every code below maps to a failure mode named in the research, which is why
 * each one carries a `fix` rather than only a complaint:
 *
 *   - `subjective-camera-word` (ERROR) — §二: a mood adjective standing in for a
 *     camera instruction. This is the exact failure the whole layer exists to
 *     catch, so it is an ERROR, not a warning.
 *   - `camera-monotony` (WARNING) — the same move repeated back to back reads as
 *     no direction at all.
 *   - `duration-out-of-range` (WARNING) — the requested time cannot contain the
 *     requested move at its stated speed.
 *   - `shot-size-monotony` (WARNING) — a scene with one 景别 throughout has no
 *     visual rhythm.
 *   - `static-scene` (WARNING) — §八 quotes the observed failure: 「90% 的人……
 *     忘了加运镜提示词……视频就是**像 PPT 一样死板**」. Corroborated externally.
 *   - `orbit-with-closeup` (WARNING) — §八's negative experience: 「人物出镜视频，
 *     少用环绕」. Orbit tends to drift faces (same root cause as the stateless
 *     model in §一). Marked as a RISK, and §十一 item 8 insists it is an
 *     empirical recommendation, NOT a platform limitation.
 *
 * Never returns an empty-string code, never throws, and is completely silent for
 * a clean scene (the self-test's positive controls (e)/(h) depend on that).
 *
 * @param {Array<object>} [shots] flat shots
 * @param {object} [options]
 * @param {string|object} [options.rhythm] rhythm preset key/id/label/object
 * @param {number} [options.monotonyRun] how many identical moves in a row trip
 *   the monotony warning (default 3: two in a row is a deliberate match cut,
 *   three is a rut)
 * @returns {Array<{ shotRef: string, code: string, severity: string, message: string, fix: string }>}
 */
export function auditCamera(shots = [], options = {}) {
  const o = isRecord(options) ? options : {}
  const preset = isRecord(o.rhythm) ? o.rhythm : findRhythm(o.rhythm)
  const monotonyRun = Number.isFinite(o.monotonyRun) && o.monotonyRun >= 2 ? Math.round(o.monotonyRun) : 3

  const rows = (Array.isArray(shots) ? shots : []).filter(isRecord)
  const findings = []

  /** @type {Array<{ moveId: string, sizeName: string, ref: string }>} */
  const seen = []
  let runMove = ''
  let runCount = 0
  let runStart = ''

  rows.forEach((shot, index) => {
    const ref = txt(shot.id) || txt(shot.ref) || outlineId('shot', index + 1)

    // The text an author actually wrote for the camera. Several field names are
    // accepted because shots arrive from the script (camera/cameraMove), from a
    // hand-built board (move), and from the flatten step (`motion`).
    const cameraText = [shot.camera, shot.cameraMove, shot.move].map(txt).filter(Boolean).join(SEP)
    const moveText = [shot.cameraMove, shot.move, shot.motion].map(txt).filter(Boolean).join(SEP)
    const tokens = detectCameraTokens(cameraText) 

    // ---- (1) subjective word with no technical move ------------------
    if (tokens.length === 0) {
      const haystack = `${cameraText}${SEP}${moveText}`
      const hits = SUBJECTIVE_CAMERA_WORDS.filter(entry => haystack.includes(entry.word))
      if (hits.length > 0) {
        const first = hits[0]
        const suggestions = dedupe(hits.map(entry => entry.suggest).filter(Boolean))
        findings.push({
          shotRef: ref,
          code: 'subjective-camera-word',
          severity: 'error',
          message: `第 ${index + 1} 镜的镜头描述里只有主观词（${hits.map(hit => `「${hit.word}」`).join('、')}），没有可解析的运镜指令：${first.hint}。`
            + '主观词无法被模型执行，也无法被剪辑检查。',
          fix: suggestions.length > 0
            ? `把主观词替换为方括号运镜标记，建议 ${suggestions.join(' 或 ')}（按你想表达的意图择一），并补上速度，例如「${suggestions[0]}，缓慢」。`
            : '请补一个方括号运镜标记（如 [推镜头]/[移镜头]/[固定镜头]），主观词只作补充说明。',
        })
      }
    }

    // ---- (2) resolve the move actually in use ------------------------
    const move = tokens.length > 0
      ? findCameraMove(tokens[0])
      : findCameraMove(`${cameraText}${SEP}${moveText}`)
    const size = findShotSize(shot.shotSize ?? shot.shot ?? shot.size ?? shot.framing)

    if (move) {
      if (move.id === runMove) {
        runCount += 1
      } else {
        runMove = move.id
        runCount = 1
        runStart = ref
      }
      if (runCount === monotonyRun) {
        findings.push({
          shotRef: ref,
          code: 'camera-monotony',
          severity: 'warning',
          message: `从第 ${idxOf(rows, runStart) + 1} 镜到第 ${index + 1} 镜连续 ${runCount} 个镜头都用了「${move.name}」。同一运镜连排超过两次，观众感知不到任何调度意图，只剩单调。`,
          fix: `至少换掉中间一镜：改用 ${alternativesTo(move.id).join(' / ')}，或把其中一镜改成固定镜头，用剪辑而不是运镜制造节奏。`,
        })
      }
    }

    // ---- (3) duration outside both tables ----------------------------
    const seconds = Number(shot.durationSeconds ?? shot.durationSec ?? shot.duration)
    if (Number.isFinite(seconds) && seconds > 0) {
      // 区间下界只由「景别」决定，上界取两张表里更宽松的一个。这是刻意的：
      // 极端景别（大特写）本身只需要 1 秒，所以一个 1 秒的推镜头是成立的
      // ——推镜头那 2 秒的下界针对的是「推」这个动作被看清所需的时间，而不是
      // 「这一镜至少要有 2 秒」。用两张表的下界取 min 会制造误报。
      const low = size.durationRange[0]
      const high = Math.max(size.durationRange[1], move ? move.speedRange[1] : 0)
      if (seconds < low || seconds > high) {
        findings.push({
          shotRef: ref,
          code: 'duration-out-of-range',
          severity: 'warning',
          message: `第 ${index + 1} 镜时长 ${seconds} 秒，超出「${size.name}」与「${move ? move.name : '未指定运镜'}」的合理区间 ${low}-${high} 秒（经验值，非平台限制，也不代表上游模型的时长上限）。`
            + (seconds < low ? '时长太短，这一镜还没被看清就切走了。' : '时长太长，单个运动撑不住这么久的注意力。'),
          fix: seconds < low
            ? `把本镜延长到 ${low} 秒以上，或改用持续时间更长的固定镜头／收回成中景。`
            : `把本镜压到 ${high} 秒以内，或拆成两镜（前段交代、后段落点），让剪辑承担推进。`,
        })
      }
    }

    seen.push({ moveId: move ? move.id : '', sizeName: size.name, ref })
  })

  // ---- (4) 景别 variety across the whole scene ------------------------
  const sizes = dedupe(seen.map(item => item.sizeName))
  if (seen.length >= 4 && sizes.length === 1) {
    findings.push({
      shotRef: '',
      code: 'shot-size-monotony',
      severity: 'warning',
      message: `整场 ${seen.length} 个镜头全是「${sizes[0]}」，没有任何景别变化。观众的信息密度恒定，情绪线也就平了。`,
      fix: '按「全 → 中 → 近 → 特」的推进关系至少安排三级景别：用全景交代空间、中景走动作、近景与特写落情绪。',
    })
  }

  // ---- (5) a whole scene with a dead camera ---------------------------
  const moves = dedupe(seen.map(item => item.moveId).filter(Boolean))
  if (seen.length >= 3 && moves.length === 1 && moves[0] === 'static') {
    findings.push({
      shotRef: '',
      code: 'static-scene',
      severity: 'warning',
      message: `整场 ${seen.length} 个镜头都是固定机位。检索到的常见失败模式原文：「90% 的人……忘了加运镜提示词……视频就是像 PPT 一样死板，镜头一动不动」。`,
      fix: '至少给开场和情绪落点各加一个温和的运动（缓推或缓移），把「不动」留给真正需要观众死盯的那一镜——固定镜头是重音，不是默认值。',
    })
  }

  // ---- (6) orbit on a character close-up is a RISK ---------------------
  rows.forEach((shot, index) => {
    const ref = txt(shot.id) || txt(shot.ref) || outlineId('shot', index + 1)
    const cameraText = [shot.camera, shot.cameraMove, shot.move].map(txt).filter(Boolean).join(SEP)
    const tokens = detectCameraTokens(cameraText)
    const move = tokens.length > 0 ? findCameraMove(tokens[0]) : findCameraMove(cameraText)
    if (!move || move.id !== 'orbit') return

    const size = findShotSize(shot.shotSize ?? shot.shot ?? shot.size ?? shot.framing)
    const tight = ['近景', '特写', '大特写'].includes(size.name)
    // 有具名角色才算「人物出镜」；群演不具名时不强行报警，避免噪声淹没真问题。
    const hasCharacter = dedupe([...list(shot.characters), ...list(shot.characterIds), ...list(shot.cast)]).length > 0
    if (!tight || !hasCharacter) return

    findings.push({
      shotRef: ref,
      code: 'orbit-with-closeup',
      severity: 'warning',
      message: `第 ${index + 1} 镜让角色在「${size.name}」里做环绕拍摄。检索到的经验性负面建议原文：「人物出镜视频，少用环绕」——环绕是最容易造成面部漂移的运镜（与无状态模型的一致性根因同源）。这是经验建议，不是平台限制。`,
      fix: `人物特写建议改用 ${alternativesTo('orbit').join(' / ')}；如果镜头意义确实需要环绕，就把它放在无近景的中景/全景上，并接受面部漂移风险。`,
    })
  })

  return findings
}

/**
 * Index of a shot ref within a row list (0-based), or 0 when not found.
 * @param {Array<object>} rows
 * @param {string} ref
 * @returns {number}
 */
function idxOf(rows, ref) {
  const index = rows.findIndex((row, i) => (txt(row.id) || txt(row.ref) || outlineId('shot', i + 1)) === ref)
  return index < 0 ? 0 : index
}

/**
 * Two moves that are meaningfully different from `moveId`, for the `fix` text.
 *
 * Chosen by looking at the move's own risk: if it is a big/risky move we offer
 * calmer alternatives, and vice versa. A generic "use something else" would be
 * useless advice.
 *
 * @param {string} moveId
 * @returns {string[]} bracketed tokens
 */
function alternativesTo(moveId) {
  const map = {
    'push-in': ['[移镜头]', '[固定镜头]'],
    'pull-out': ['[升降镜头]', '[固定镜头]'],
    pan: ['[俯仰镜头]', '[移镜头]'],
    tilt: ['[摇镜头]', '[固定镜头]'],
    truck: ['[跟镜头]', '[推镜头]'],
    follow: ['[移镜头]', '[手持跟拍]'],
    crane: ['[拉镜头]', '[升降镜头]'],
    zoom: ['[推镜头]', '[固定镜头]'],
    static: ['[推镜头]', '[移镜头]'],
    orbit: ['[移镜头]', '[升降镜头]'],
    'dolly-zoom': ['[推镜头]', '[俯仰镜头]'],
    'crane-compound': ['[升降镜头]', '[移镜头]'],
    oner: ['[跟镜头]', '[移镜头]'],
    handheld: ['[跟镜头]', '[固定镜头]'],
    'whip-pan': ['[摇镜头]', '[甩镜]'],
  }
  const tokens = map[moveId] ?? ['[推镜头]', '[固定镜头]']
  return dedupe(tokens.filter(token => token !== moveId))
}

/* ------------------------------------------------------------------ *
 * PART B-11 — first/last frame continuity
 * ------------------------------------------------------------------ */

/**
 * Motion budget thresholds, in "framing change units".
 *
 * A unit is one step of the 景别 ladder plus the composition deltas below. The
 * thresholds are a RULE OF THUMB: research §三 says the first and last frames
 * should keep subject / composition / lighting consistent and that 「坐标偏差
 * 控制在 5% 以内」, but the plugin has no pixel geometry to measure that with,
 * so we approximate with the descriptors we DO have and say so.
 * @type {{ small: number, medium: number }}
 */
const MOTION_BUDGET_THRESHOLDS = { small: 1, medium: 3 }

/** 景别 ladder, wide → tight, used to measure how far framing jumped. */
const SIZE_LADDER = SHOT_SIZES.map(size => size.name)

/**
 * Compare two consecutive shots for first-frame / last-frame continuity.
 *
 * THE RULE (research §三, quoted): the core idea for a transition that does not
 * flash is 「让首帧与尾帧在关键信息上尽可能一致，把'变量'留给运动本身，而不是
 * 留给画面风格」. So this function separates the two halves explicitly:
 *
 *   - `sharedAnchors` — what is KEPT across the cut (subject, lighting,
 *     location, composition). These must not change; if they do, the pair will
 *     flicker no matter how good either frame is on its own.
 *   - `motionBudget` — how much the FRAMING changed, graded small / medium /
 *     large. The budget is what the motion is allowed to spend: a small reframe
 *     can afford a bold movement, a large reframe needs a calm one.
 *
 * `ok` is false only for a genuinely risky pair: a missing anchor (which
 * guarantees a flash) or a `large` motion budget on a same-scene cut. A
 * deliberate cross-cut into a new scene is reported through `issues` but does
 * NOT set `ok: false` on its own — leaving a scene is supposed to look
 * different, and failing it would train authors to ignore the check.
 *
 * @param {object} [prev] the earlier shot
 * @param {object} [next] the later shot
 * @returns {{ ok: boolean, issues: Array<{ code: string, severity: string, message: string, fix: string }>, sharedAnchors: string[], motionBudget: 'small'|'medium'|'large', changed: string[] }}
 */
export function frameContinuity(prev = {}, next = {}) {
  const a = isRecord(prev) ? prev : {}
  const b = isRecord(next) ? next : {}
  const issues = []
  const sharedAnchors = []
  const changed = []

  const refOfPair = txt(b.id) || txt(b.ref) || '下一镜'

  // ---- anchors that must survive the cut -----------------------------
  const castA = dedupe([...list(a.characters), ...list(a.characterIds), ...list(a.cast)])
  const castB = dedupe([...list(b.characters), ...list(b.characterIds), ...list(b.cast)])
  const sharedCast = castA.filter(name => castB.includes(name))
  if (castA.length > 0 && castB.length > 0) {
    if (sharedCast.length > 0) sharedAnchors.push(`人物：${sharedCast.join('、')}`)
    else {
      changed.push('人物')
      issues.push({
        code: 'subject-changed',
        severity: 'warning',
        message: `${refOfPair} 与上一镜没有共同人物（上一镜：${castA.join('、')}；本镜：${castB.join('、')}）。`,
        fix: '同一场景内换人属于硬切，务必确认这是有意的调度；若要平滑衔接，请保留一个共同人物在画面里作为锚点，或改用明确的场景切换标记。',
      })
    }
  }

  const lightingA = txt(a.lighting)
  const lightingB = txt(b.lighting)
  if (lightingA !== '' && lightingB !== '') {
    if (lightingA === lightingB) sharedAnchors.push(`光照：${lightingA}`)
    else {
      changed.push('光照')
      issues.push({
        code: 'lighting-changed',
        severity: 'warning',
        message: `${refOfPair} 的光照描述与上一镜不同（「${lightingA}」→「${lightingB}」）。首尾帧光照不一致是转场闪烁的直接原因。`,
        fix: '把两镜的「光影」段统一成同一句（同一光源动机、同一色温），只允许运动变化，不要让光照跟着变。',
      })
    }
  }

  const sceneA = txt(a.sceneId) || txt(a.scene) || txt(a.location)
  const sceneB = txt(b.sceneId) || txt(b.scene) || txt(b.location)
  const sameScene = sceneA !== '' && sceneA === sceneB
  if (sameScene) sharedAnchors.push(`场景：${sceneA}`)

  // ---- framing deltas (what the motion has to pay for) ----------------
  let units = 0

  const sizeA = findShotSize(a.shotSize ?? a.shot ?? a.size ?? a.framing)
  const sizeB = findShotSize(b.shotSize ?? b.shot ?? b.size ?? b.framing)
  const stepA = SIZE_LADDER.indexOf(sizeA.name)
  const stepB = SIZE_LADDER.indexOf(sizeB.name)
  // 这里必须先确认两边都**真的写了**景别，再见比较。若某一镜没填，两边都会
  // 落到默认「中景」而看起来相同；若两边填了不同的未知值，也会都落到中景而
  // 看起来相同。两种情况都不是「构图没变」，计数就会漏掉一次真正的重构。
  const sizeDeclaredA = txt(a.shotSize ?? a.shot ?? a.size ?? a.framing)
  const sizeDeclaredB = txt(b.shotSize ?? b.shot ?? b.size ?? b.framing)
  if (stepA >= 0 && stepB >= 0 && sizeDeclaredA !== sizeDeclaredB) {
    units += Math.abs(stepA - stepB)
    changed.push(`景别（${sizeA.name} → ${sizeB.name}）`)
  }

  const angleA = findCameraAngle(a.angle ?? a.cameraAngle)
  const angleB = findCameraAngle(b.angle ?? b.cameraAngle)
  if (angleA.id !== angleB.id) {
    // 机位跃迁比景别变化更刺眼：从仰视直接切到鸟瞰，观众会失去空间感。
    units += 1
    changed.push(`机位（${angleA.name} → ${angleB.name}）`)
  }

  const moveA = findCameraMove(txt(a.cameraMove) || txt(a.move) || txt(a.camera))
  const moveB = findCameraMove(txt(b.cameraMove) || txt(b.move) || txt(b.camera))
  if (moveA && moveB && moveA.id !== moveB.id) {
    // 运动方向的翻转会让观众感到"镜头被拽回去"，但幅度中等。
    units += 1
    changed.push(`运镜（${moveA.name} → ${moveB.name}）`)
  }

  const budget = units <= MOTION_BUDGET_THRESHOLDS.small ? 'small'
    : (units <= MOTION_BUDGET_THRESHOLDS.medium ? 'medium' : 'large')

  if (budget === 'large') {
    // 同一场景内的大幅重构是最危险的一种：观众会以为换了空间，
    // 而且首尾帧几乎不可能对齐。所以它计两次，确保 ok 一定为 false。
    if (sameScene) units += 1
    issues.push({
      code: sameScene ? 'violent-reframe' : 'hard-cut-reframe',
      severity: sameScene ? 'warning' : 'info',
      message: sameScene
        ? `${refOfPair} 与上一镜在同一场景（${sceneA}）内，但构图变化幅度评为「大」（${changed.join('、')}）。同场景内的大幅重构会让观众以为换了空间，且首尾帧几乎不可能对齐。`
        : `${refOfPair} 跨场景硬切，构图变化幅度「大」（${changed.join('、')}）。跨场景本来就允许重构，但首尾帧绑定在此处不可靠，建议改用同机位切。`,
      fix: sameScene
        ? '把变化拆成两镜：先用一镜小的推/移过渡到中间景别，再切到目标构图；或把本镜改成与上一镜同景别、只让运动变化。'
        : '不要依赖首尾帧强绑定来跨场景衔接（检索资料已把首尾帧置信度标为待实测）；优先用同机位切或明确的转场镜头。',
    })
  }

  // 同场景却丢掉了锚点：这是必然会闪烁的组合，所以它才让 ok 变成 false。
  const lostAnchorInScene = sameScene && changed.some(item => item.startsWith('光照') || item.startsWith('人物'))
  const ok = !lostAnchorInScene && !(sameScene && budget === 'large')

  // `units` 在同一场景大幅重构时会被再计一次，所以这里量的其实是
  // 「重构的代价」而不只是「变化了多少」——同一处空间里的大改，代价更高。
  if (budget === 'large') sharedAnchors.push(`运动预算：large（重构代价 ${units} 单位）`)

  return { ok, issues, sharedAnchors, motionBudget: budget, changed, units }
}

/* ------------------------------------------------------------------ *
 * PART B-12 — consistency directives
 * ------------------------------------------------------------------ */

/**
 * The extra prompt text that enforces the locks.
 *
 * COMPOSITION, NOT DUPLICATION (this is the assertion (i) contract):
 *   - the negative lists are `CHARACTER_SHEET_NEGATIVE` / `GENERIC_NEGATIVE` /
 *     the scene additions FROM `prompts.js`, referenced rather than re-typed.
 *     Assertion (i) proves it by identity (`===`), which a copy could not pass.
 *   - the quality clauses are `QUALITY_BOOSTERS` values, likewise by reference.
 *   - where a builder is the right tool (`buildCharacterSheet`,
 *     `buildSceneMaster`, `buildShotRef`, `buildVideoPrompt`), it is CALLED.
 *     `buildShotRef`/`buildVideoPrompt` already weave the character and scene
 *     names into their own lock sentences, so those builders are the
 *     authoritative positive layer and this function only adds what they do not
 *     cover: the frozen canonical strings, the fingerprint, and the reference
 *     image statement.
 *
 * HONESTY: when `level` is 2 the directive states that a reference image IS used
 * and names it; when it is anything less the directive says the appearance rests
 * on the locked description ALONE. It never claims a reference image that was not
 * supplied. `buildConsistencyDirectives` deliberately does not resolve references
 * itself — `buildReferencePlan` owns that decision, and duplicating the lookup
 * here would let the two disagree.
 *
 * @param {object} [input]
 * @param {string|object} [input.styleDna] project style DNA
 * @param {number} [input.level] a CONSISTENCY_LOCK level (defaults to 1)
 * @param {Array<object|string>} [input.characters] bible cards, or precomputed locks
 * @param {Array<object|string>} [input.scenes] bible cards, or precomputed locks
 * @param {string} [input.kind] ASSET_KIND of the target being prompted
 * @param {object} [input.shot] the shot this prompt is for
 * @param {string} [input.scene] the scene name
 * @param {string} [input.aspectRatio] one of ASPECT_RATIOS
 * @param {string} [input.durationSec] clip length for the video builder
 * @param {string} [input.rhythm] rhythm for the camera tail
 * @returns {{ positive: string, negative: string, level: number, characters: Array<object>, scenes: Array<object>, tokens: string[], cameraTail: string, usesReferenceImage: boolean }}
 */
export function buildConsistencyDirectives(input = {}) {
  const i = isRecord(input) ? input : {}
  const level = Number.isFinite(Number(i.level)) ? Number(i.level) : CONSISTENCY_LOCK.lockedPrompt
  const style = txt(i.styleDna) || PROJECT_DEFAULTS.styleDna

  // 传入的既可能是设定卡，也可能已经是锁（buildReferencePlan 的调用方常常
  // 先锁好再传进来）。两种都接受，避免调用方为了适配这里而重复计算。
  const characterLocks = (Array.isArray(i.characters) ? i.characters : [])
    .map(entry => (isRecord(entry) && typeof entry.canonical === 'string'
      ? entry
      : (isRecord(entry) || typeof entry === 'string' ? lockCharacter(isRecord(entry) ? entry : { name: entry }) : null)))
    .filter(Boolean)

  const sceneLocks = (Array.isArray(i.scenes) ? i.scenes : [])
    .map(entry => (isRecord(entry) && typeof entry.canonical === 'string'
      ? entry
      : (isRecord(entry) || typeof entry === 'string' ? lockScene(isRecord(entry) ? entry : { name: entry }) : null)))
    .filter(Boolean)

  const kind = txt(i.kind)
  const usesReferenceImage = level >= CONSISTENCY_LOCK.referenceImage
  const cameraTail = txt(i.cameraTail)
  const tokens = []

  const parts = []

  // ---- 1. the authoritative positive layer, via prompts.js builders ----
  if (kind === ASSET_KIND.characterSheet) {
    const character = characterLocks[0]
    parts.push(buildCharacterSheet({
      name: character?.name ?? txt(i.name),
      description: character?.canonical ?? '',
      style,
      aspectRatio: txt(i.aspectRatio),
    }))
    tokens.push('buildCharacterSheet')
  } else if (kind === ASSET_KIND.sceneMaster) {
    const scene = sceneLocks[0]
    const card = isRecord(i.scenes?.[0]) ? i.scenes[0] : {}
    parts.push(buildSceneMaster({
      name: scene?.name ?? txt(i.name),
      description: txt(card.description),
      lighting: txt(card.lighting),
      composition: txt(card.composition),
      style,
      aspectRatio: txt(i.aspectRatio),
    }))
    tokens.push('buildSceneMaster')
  } else if (kind === ASSET_KIND.shotRef || kind === ASSET_KIND.firstFrame) {
    const card = isRecord(i.shot) ? i.shot : {}
    parts.push(buildShotRef({
      description: txt(card.action) || txt(card.description),
      shot: txt(card.shotSize) || txt(card.shot),
      camera: txt(card.camera),
      lighting: txt(card.lighting),
      composition: txt(card.composition),
      style,
      characters: characterLocks.map(lock => lock.name),
      scene: txt(i.scene) || sceneLocks[0]?.name || '',
      aspectRatio: txt(i.aspectRatio),
    }))
    tokens.push('buildShotRef')
  } else if (kind === ASSET_KIND.video) {
    const card = isRecord(i.shot) ? i.shot : {}
    parts.push(withCameraTail(buildVideoPrompt({
      shot: txt(card.shotSize) || txt(card.shot),
      camera: txt(card.camera),
      motion: txt(card.motion) || txt(card.action),
      durationSec: i.durationSec,
      dialogue: txt(card.dialogue),
      style,
    }), txt(i.cameraTail)))
    tokens.push('buildVideoPrompt')
  }

  // ---- 2. the frozen canonical locks, verbatim -------------------------
  // The style DNA is emitted HERE, in the shared section, rather than relying
  // only on the kind-specific builders above. Those builders do receive `style`,
  // but they are skipped whenever no `kind` is supplied (a legitimate way to ask
  // for just the lock block) — and in that case the show's visual identity used
  // to vanish silently while the character/scene locks still emitted, so the
  // caller got a confident-looking directive with the style quietly missing.
  // Emitting it here makes the style unconditional.
  parts.push(`风格 DNA（全片统一，任何镜头不得偏离）：${style}`)
  tokens.push('style:dna')

  if (characterLocks.length > 0) {
    const blocks = characterLocks.map(lock => `角色锁定[${lock.fingerprint}]：${lock.canonical}`)
    parts.push(`一致性锁定（以下外观描述为冻结版本，必须在每一次生成中原样重复，禁止改写、缩写、同义替换）：${blocks.join('；')}`)
    tokens.push('canonical:characters')
  }
  if (sceneLocks.length > 0) {
    const blocks = sceneLocks.map(lock => `场景锁定[${lock.fingerprint}]：${lock.canonical}`)
    parts.push(`场景锁定（同上，环境结构、陈设位置与光源动机必须逐字一致）：${blocks.join('；')}`)
    tokens.push('canonical:scenes')
  }

  // ---- 3. how consistency is actually achieved, stated honestly --------
  if (usesReferenceImage) {
    parts.push('一致性等级：第 2 级（参考图）——本镜除锁定描述外，另以上游已生成的角色三视图／场景主图作为条件输入，画面须与该参考图逐项对齐（面部、发型、体型、服装、配饰、环境结构），只允许机位与景别变化。')
    tokens.push('level:reference-image')
  } else {
    parts.push('一致性等级：第 1 级（锁定描述）——本镜没有可用的参考图，一致性完全依赖上面的冻结外观串被逐字重复注入；若上游模型无参考图条件，跨镜漂移风险由提示词承担，生成后请人工比对。')
    tokens.push('level:locked-prompt')
  }

  // ---- 4. quality clauses, referenced from prompts.js ------------------
  const boosters = dedupe([
    QUALITY_BOOSTERS.consistentFace,
    QUALITY_BOOSTERS.consistentBody,
    QUALITY_BOOSTERS.consistentOutfit,
  ])
  parts.push(`质量要求：${boosters.join('；')}`)
  parts.push(`渲染与色彩：${QUALITY_BOOSTERS.color}`)
  tokens.push('quality:boosters')

  // 运镜指令必须压在**整条提示词的最末尾**（research §八：「主体场景写最前面，
  // 运镜指令放在提示词最后」）。所以它不是拼接过程中的一段，而是最后一步：
  // 先按 SEP 拼好所有段落，再把 token 追到末尾。若在拼接前追加，后面的质量与
  // 色彩段落会把它挤到中间，规则就失效了。
  const positive = withCameraTail(parts.filter(Boolean).join(SEP), cameraTail)
  if (cameraTail !== '') tokens.push('camera:tail')

  // ---- 5. the negative layer, by reference ----------------------------
  // 直接拼 prompts.js 导出的数组本身，不做任何复制。自检会断言这里的数组与
  // prompts.js 的是同一个对象（===），所以「抄一份到本文件」会被立刻抓出来。
  const negativeParts = kind === ASSET_KIND.characterSheet
    ? [...CHARACTER_SHEET_NEGATIVE]
    : kind === ASSET_KIND.sceneMaster
      ? [...GENERIC_NEGATIVE, '人物', '人形剪影', '动物', '交通工具']
      : [...GENERIC_NEGATIVE]
  negativeParts.push(QUALITY_BOOSTERS.noText)
  tokens.push(kind === ASSET_KIND.characterSheet ? 'negative:character-sheet' : 'negative:generic')

  return {
    positive,
    negative: dedupe(negativeParts).join(SEP),
    level,
    characters: characterLocks,
    scenes: sceneLocks,
    tokens,
    cameraTail,
    usesReferenceImage,
  }
}

/**
 * The negative lists this module re-uses, EXPOSED BY REFERENCE so a caller (or
 * a test) can prove no copy was made.
 *
 * `===` against `prompts.js`'s exports is the whole point: if someone ever
 * "helpfully" inlines these arrays into this file, the identity check in
 * docs/verify-consistency.mjs fails and the fork is caught before it ships.
 *
 * @type {{ characterSheet: string[], generic: string[] }}
 */
export const REUSED_NEGATIVES = Object.freeze({
  characterSheet: CHARACTER_SHEET_NEGATIVE,
  generic: GENERIC_NEGATIVE,
})

/* ------------------------------------------------------------------ *
 * Honest uncertainty log
 * ------------------------------------------------------------------ */

/**
 * Machine-readable list of everything in this module that could NOT be verified
 * in this environment.
 *
 * This module has never been run against a real image or video model. Nothing
 * below was measured; it is either taken from `docs/research-2026.md` (itself
 * second-hand search summaries — see its §十) or it is a rule of thumb chosen to
 * produce sane defaults. The UI and dev tooling should surface these rather than
 * presenting the lock/camera layers as validated.
 *
 * @returns {Array<{ area: string, item: string, confidence: 'high'|'medium'|'low', note: string }>}
 */
export function uncertainties() {
  return [
    {
      area: 'consistency',
      item: '参考图能否真正提升跨镜一致性',
      confidence: 'low',
      note: 'research §一 引用的是检索到的行业口径（65%→92%）与厂商宣传，不是本插件实测，也不是独立第三方研究。本模块只负责把参考图引用与锁定描述无损地传到下游，是否生效取决于用户所选的渠道。',
    },
    {
      area: 'consistency',
      item: '同框角色上限 5 人',
      confidence: 'low',
      note: '出自 Nano Banana 的检索原文，§十一 明确列为待实测。本模块只把它当告警阈值，从不阻止生成。',
    },
    {
      area: 'consistency',
      item: 'Seed 继承（继承首帧 seed）',
      confidence: 'low',
      note: 'research §九 提到它是一致性手段，§十一 要求先实测各渠道是否接受 seed 参数。本模块**故意不实现**——写入一个未经验证的字段只会在上游静默忽略它，反而让使用者以为一致性已被继承。列为后续建议。',
    },
    {
      area: 'camera',
      item: '运镜方括号标记在各视频模型上的实际生效情况',
      confidence: 'low',
      note: 'research §二 的核心发现与 §十一 第 4 条：不同模型的运镜词汇表不同。本模块保证输出是「可解析、可检查、可替换」的指令，但不能证明任何模型会按它运动。',
    },
    {
      area: 'camera',
      item: '「运镜指令放在提示词最后」',
      confidence: 'medium',
      note: '检索共识（§八），§十一 第 7 条标注各平台词序敏感度需实测。本模块按「放最后」实现，视为默认而非平台保证。',
    },
    {
      area: 'camera',
      item: '「人物出镜少用环绕」',
      confidence: 'low',
      note: '§十一 第 8 条明确：这是经验性建议而不是平台限制。本模块按风险告警处理，不禁止。',
    },
    {
      area: 'camera',
      item: '各运镜的 speedRange 与各景别的 durationRange',
      confidence: 'low',
      note: '完全是经验值（rule of thumb），用于给出「这个时长是否撑得住这个运动」的提示；没有任何渠道接受过「运镜速度」参数。',
    },
    {
      area: 'camera',
      item: 'EDIT_RHYTHM 的 shotsPerMinute',
      confidence: 'low',
      note: '由各档时长的中位数反推得到，不是实测数据，也不是平台参数；§四 提醒同类平台数字属厂商口径。',
    },
    {
      area: 'continuity',
      item: '首尾帧「坐标偏差 5% 以内」',
      confidence: 'low',
      note: 'research §三 的原文引用。本模块没有像素几何可测量，只能用景别/机位/运镜的描述符近似「构图变化幅度」，这是近似而非度量。',
    },
  ]
}
