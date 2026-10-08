/**
 * dsh-aidrama — story-craft engine (McKee structure + short-drama hook mechanics).
 *
 * WHY THIS MODULE EXISTS
 * A one-line idea is not a story. Left alone, the conversational model writes a
 * competent synopsis that nobody watches, because two independent things are
 * missing and neither is a "writing skill" problem:
 *
 *   1. STRUCTURE — a story without a placed inciting incident, a midpoint
 *      reversal and an answered controlling idea is a mood, not a plot.
 *      Robert McKee《故事》gives the hierarchy (节拍→场景→序列→幕→故事), the
 *      requirement that each scene turn its value charge, and the rule that the
 *      ending must answer the 控制性理念 (docs/research-2026.md §五).
 *   2. RETENTION MECHANICS — short-drama viewers are not film viewers. They
 *      decide in about 3 seconds, and the platform data in
 *      docs/research-2026.md §四 says >85% of swipe-aways happen in the first
 *      3 seconds, a designed hook lifts retention ~68%, and the house rhythm is
 *      a small reversal roughly every 30 seconds.
 *
 * Both of those are CHECKABLE, so they are checked here instead of being
 * requested politely in a prompt. Every rule in this file states where it comes
 * from and whether it is a citation or a rule of thumb.
 *
 * HONEST SCOPE LIMIT (read this before trusting the output):
 * This module validates the SHAPE of a story, not its QUALITY. A model can
 * satisfy every assertion here and still write something boring — nothing in
 * this file can measure whether a reversal is surprising or a line is funny.
 * The audits are a floor, deliberately: they catch the failure modes that are
 * objectively detectable (a missing inciting incident, an episode that opens on
 * scenery, a 90-second stretch with no turn) and they refuse to guess about the
 * rest. Do not read `ok: true` as "this is good".
 *
 * CONVENTIONS
 *   - Plain ESM JavaScript, node >= 22, ZERO dependencies, no network, no I/O.
 *     The only import is the frozen `./protocol.js` contract.
 *   - Pure and total: never throws on malformed input, never mutates an
 *     argument. A surprising payload yields `ok: false` / empty audits, because
 *     these functions run on model output during a request.
 *   - Positions are FRACTIONS of total runtime in 0..1, never seconds. Seconds
 *     are a presentation detail derived at the edge by `proposeStructure`.
 */

import { PROJECT_DEFAULTS, outlineId } from './protocol.js'

/* ================================================================== *
 * 0. small total helpers
 * ================================================================== */

/**
 * A non-null, non-array object.
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * A trimmed string, or '' (never undefined).
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * A finite number, or undefined. Accepts numeric strings ("0.12").
 * @param {unknown} value
 * @returns {number | undefined}
 */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * A finite number, or the fallback.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function numOr(value, fallback) {
  return num(value) ?? fallback
}

/**
 * Clamp into [min, max].
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * Every record inside `value`, or `[]`.
 * @param {unknown} value
 * @returns {Array<Record<string, unknown>>}
 */
function records(value) {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/**
 * Round to `digits` decimals, avoiding float noise in generated offsets
 * (`0.1 + 0.2 → 0.30000000000000004` must not leak into output).
 * @param {number} value
 * @param {number} [digits]
 * @returns {number}
 */
function round(value, digits = 4) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Read a field by trying an ordered list of candidate key names.
 *
 * The JSON contract tells the model to use one spelling, but models drift, so
 * the audits accept the documented aliases rather than failing a story for
 * saying `value` where the contract said `valuePair`.
 *
 * @param {Record<string, unknown>} record
 * @param {string[]} keys
 * @returns {unknown}
 */
function pick(record, keys) {
  for (const key of keys) {
    if (Object.hasOwn(record, key) && record[key] !== undefined && record[key] !== null) {
      return record[key]
    }
  }
  return undefined
}

/* ================================================================== *
 * 1. McKee structure model
 * ================================================================== */

/**
 * The canonical beat list.
 *
 * SOURCE — docs/research-2026.md §五 (麦基《故事》术语体系): 激励事件 / 转折点 /
 * 价值转折 / 鸿沟 / 控制性理念 are the terms encoded here, and 幕 is closed by a
 * turning point. `positionMin`/`positionMax` are FRACTIONS of total runtime.
 *
 * WHERE THE NUMBERS COME FROM — read this before changing them:
 *   - 激励事件 "must land in the first 12%" is a RULE OF THUMB, not an
 *     attributed formulation. Research §五 records the plugin's existing
 *     (looser) encoding as "必须在前 1/4 发生" (McKee: 打破主角生活平衡的事件).
 *     12% is tighter than that and is justified by the retention data in §四
 *     (>85% of swipes happen in the first 3 seconds), i.e. the audience must be
 *     in motion almost immediately. 12% is therefore OUR retention-driven
 *     tightening, not something McKee said. Treat it as tunable, not doctrine.
 *   - The 25% act-one turning point and the ~50% midpoint are 三幕结构惯例 (the
 *     conventional three-act proportions), which research §五 associates with
 *     McKee's 幕/转折点 framework. They are marked 'warning' severity precisely
 *     BECAUSE they are convention rather than a rule the craft makes objectively
 *     wrong when missed.
 *   - ATTRIBUTION DISCIPLINE (research §十): the McKee term-lists were confirmed
 *     by search, but exact wording and page numbers were NOT verified. So this
 *     file cites McKee by CONCEPT NAME only (价值转折 / 故事鸿沟 / 控制性理念 /
 *     幕以转折点收束) and never quotes him. Where a rule is standard practice
 *     rather than something verified as his, it is labelled 结构惯例.
 *   - 结局 has `positionMax: 1` because "the last beat" is tautological, not a
 *     measurement.
 *
 * Positions are checked against the window ONLY when a beat declares a
 * position. A story that lists beats without positions is not failed for it —
 * see the note on honest measurement in `validateStructure`.
 *
 * @type {Array<{
 *   id: string, name: string, purpose: string,
 *   positionMin: number, positionMax: number,
 *   required: boolean, severity: 'error' | 'warning',
 * }>}
 */
export const STORY_BEATS = [
  {
    id: 'inciting',
    name: '激励事件',
    purpose: '打破主角生活的平衡，把故事从"日常"推入"追逐"。观众必须在前 3 秒内先看到冲突的余波（研究 §四）。',
    positionMin: 0,
    positionMax: 0.12,
    required: true,
    severity: 'error',
  },
  {
    id: 'act1-turn',
    name: '第一幕转折点',
    purpose: '主角做出无法回头的选择，进入新的处境；这一幕由此收束（麦基：幕以转折点收尾）。',
    positionMin: 0.12,
    positionMax: 0.3,
    required: true,
    severity: 'warning',
  },
  {
    id: 'midpoint',
    name: '中点反转',
    purpose: '真相或力量关系反转一次：期望与结果之间被拉开落差（麦基的「故事鸿沟」概念：期望与结果之间的落差），主角的原始策略失效。',
    positionMin: 0.4,
    positionMax: 0.6,
    required: true,
    severity: 'warning',
  },
  {
    id: 'crisis',
    name: '危机',
    purpose: '主角面对真正的两难：两个选项各有不可接受的代价，必须选一个（麦基：危机是高潮前的抉择）。',
    positionMin: 0.7,
    positionMax: 0.88,
    required: true,
    severity: 'error',
  },
  {
    id: 'climax',
    name: '高潮',
    purpose: '主角在最大压力下做出行动，故事的价值在此刻被最终决定，之后不再有新的信息。',
    positionMin: 0.85,
    positionMax: 0.97,
    required: true,
    severity: 'error',
  },
  {
    id: 'resolution',
    name: '结局',
    purpose: '回答控制性理念：让观众看到"因为主角的选择，世界变成了什么样"。不引入新冲突。',
    positionMin: 0.95,
    positionMax: 1,
    required: true,
    severity: 'error',
  },
]

/** Fast id → beat lookup. */
const BEAT_BY_ID = new Map(STORY_BEATS.map(beat => [beat.id, beat]))

/**
 * Whether `value` is a known beat id.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBeatId(value) {
  return typeof value === 'string' && BEAT_BY_ID.has(value)
}

/**
 * Look up one canonical beat.
 * @param {string} id
 * @returns {typeof STORY_BEATS[number] | undefined}
 */
export function beatById(id) {
  return BEAT_BY_ID.get(text(id))
}

/**
 * The beat vocabulary, as one ``, ``-free list for prompt text.
 *
 * Kept as a function (not a constant string) so `STORY_BEATS` stays the single
 * source of truth: editing a beat cannot leave a stale sentence in the brief.
 *
 * @returns {string[]} e.g. `['激励事件（inciting）', '第一幕转折点（act1-turn）', …]`
 */
export function beatIdList() {
  return STORY_BEATS.map(beat => `${beat.name}（${beat.id}）`)
}

/**
 * Render a fraction as a human percentage, e.g. `0.12 → '12%'`.
 * @param {number} value
 * @returns {string}
 */
function pct(value) {
  return `${round(value * 100, 1)}%`
}

/**
 * The window caption used in issue messages, e.g. `第 0%–12%`.
 * @param {{ positionMin: number, positionMax: number }} beat
 * @returns {string}
 */
function windowLabel(beat) {
  return `第 ${pct(beat.positionMin)}–${pct(beat.positionMax)}`
}

/**
 * How permissive a window check is: a beat whose window is narrower than this
 * still gets a small tolerance, because positions arrive as model-estimated
 * decimals and a beat at 0.121 against a 0.12 boundary is not a craft failure.
 */
const WINDOW_TOLERANCE = 0.02

/**
 * Read a story's beats into a normalized list.
 *
 * Accepts `beats: [{id, name, position}]` (the documented contract) and the
 * common drift shapes: `beat` / `beatId` for the id, `at` / `position` /
 * `positionFraction` for the position, and a number in place of the object.
 *
 * @param {unknown} story
 * @returns {Array<{ id: string, name: string, position: number | undefined, raw: unknown }>}
 */
export function readBeats(story) {
  const root = isRecord(story) ? story : {}
  const source = Array.isArray(root.beats) ? root.beats : []
  const out = []
  for (const entry of source) {
    if (typeof entry === 'string') {
      out.push({ id: text(entry), name: '', position: undefined, raw: entry })
      continue
    }
    if (!isRecord(entry)) continue
    out.push({
      id: text(pick(entry, ['id', 'beat', 'beatId', 'type'])),
      name: text(pick(entry, ['name', 'label', 'title'])),
      position: num(pick(entry, ['position', 'at', 'positionFraction', 'progress'])),
      raw: entry,
    })
  }
  return out
}

/**
 * Find one beat by id, accepting the Chinese label as an alias.
 * @param {Array<{id: string, name: string}>} beats
 * @param {string} id
 * @returns {{ id: string, name: string, position: number | undefined, raw: unknown } | undefined}
 */
function findBeat(beats, id) {
  const canonical = BEAT_BY_ID.get(id)
  return beats.find(beat => {
    if (beat.id === id) return true
    const label = canonical?.name ?? ''
    return label !== '' && (beat.id === label || beat.name === label)
  })
}

/**
 * Whether the ending answers the controlling idea.
 *
 * McKee (research §五): the ending must answer the 控制性理念 — the story's final
 * value proposition. This is the closest thing to an objective check available
 * without reading the prose, so it is implemented as: the story declares a
 * controlling idea, AND the ending beat carries a DECLARED answer.
 *
 * WHY `purpose` IS NOT ACCEPTED AS THE ANSWER: `purpose` is the beat's own
 * description, present on EVERY beat. Treating it as the answer made the check
 * unfalsifiable — every story with a resolution beat passed automatically — and
 * the assertion that a resolution WITHOUT an answer is rejected could never fail.
 * A validator whose negative case cannot fire is not a validator. The answer is
 * therefore an explicit `answer` (or a synonym) field.
 *
 * @param {unknown} story
 * @returns {{ declared: string, answered: boolean, ending: unknown }}
 */
export function answerCheck(story) {
  const root = isRecord(story) ? story : {}
  const declared = text(pick(root, ['theme', 'controllingIdeaAnswer', 'controllingIdea']))
  const ending = findBeat(readBeats(root), 'resolution')
  const raw = isRecord(ending?.raw) ? ending.raw : {}
  const body = text(pick(raw, [
    'answer', 'controllingIdeaAnswer', 'idea', 'thesis', 'resolutionAnswer',
  ]))
  return { declared, answered: declared !== '' && body !== '', ending: raw }
}

/**
 * Validate a story against the McKee structure model.
 *
 * WHAT THIS CAN AND CANNOT SEE — stated plainly, because a validator that
 * overstates itself is worse than none:
 *   - It CAN see: which canonical beats are declared, where they sit in the
 *     runtime, whether the ending answers the declared controlling idea, and
 *     whether every act has a turning point.
 *   - It CANNOT see: whether a beat's prose actually does what its name claims.
 *     A model that writes `{id:'inciting'}` over an empty string passes. The
 *     `purpose` field and the beat's own text are checked only for presence.
 *
 * @param {unknown} story a story-stage payload
 * @returns {{
 *   ok: boolean,
 *   score: number,
 *   issues: Array<{ code: string, severity: 'error' | 'warning', message: string, fix: string }>,
 *   beats: Array<{ id: string, name: string, present: boolean, position?: number, inWindow?: boolean }>,
 * }}
 */
export function validateStructure(story) {
  const issues = []
  const root = isRecord(story) ? story : {}
  const beats = readBeats(root)

  /** @param {string} code @param {'error'|'warning'} severity @param {string} message @param {string} fix */
  const push = (code, severity, message, fix) => { issues.push({ code, severity, message, fix }) }

  if (!isRecord(story)) {
    push('story-not-an-object', 'error', 'story 不是一个对象，无法进行结构校验。',
      '传入 story 阶段返回的 JSON 对象（含 beats / acts / theme）。')
  }

  const rows = []

  for (const canonical of STORY_BEATS) {
    const found = findBeat(beats, canonical.id)
    if (found === undefined) {
      if (canonical.required) {
        push('beat-missing', canonical.severity,
          `缺少必填节拍「${canonical.name}」(${canonical.id})：${canonical.purpose}`,
          `在 beats 里补一个 { id: "${canonical.id}", name: "${canonical.name}", position: ${canonical.positionMin}, purpose: "…", answer: "…" }，位置应落在 ${windowLabel(canonical)}。`)
      }
      rows.push({ id: canonical.id, name: canonical.name, present: false })
      continue
    }

    const row = { id: canonical.id, name: canonical.name, present: true }
    if (found.position !== undefined) {
      const position = found.position
      row.position = round(position, 4)
      const low = canonical.positionMin - WINDOW_TOLERANCE
      const high = canonical.positionMax + WINDOW_TOLERANCE
      const inWindow = position >= low && position <= high
      row.inWindow = inWindow
      if (!inWindow) {
        // Severity is PER BEAT, from the canonical table: the position rules are
        // craft convention (warning) except where research §四 makes them a hard
        // retention requirement (激励事件 = error).
        push('beat-out-of-window', canonical.severity,
          `「${canonical.name}」出现在 ${pct(position)}，超出允许区间 ${windowLabel(canonical)}。`,
          `把该节拍移到 ${windowLabel(canonical)} 之内；如果剧情确实不允许，请调整分集切分让总时长变长，而不是把节拍硬塞进错误的位置。`)
      }
    }
    rows.push(row)
  }

  /* --- controlling idea is answered by the ending (McKee, research §五) --- */
  const answer = answerCheck(root)
  if (answer.declared === '') {
    push('theme-missing', 'error',
      '没有声明控制性理念（theme）：结局将无从被判定为"回答了什么"。',
      '顶层补 theme，用一句价值判断写清这个故事最终要证明什么，例如「尊严只能靠自己挣回来」。')
  } else if (!answer.answered) {
    push('ending-does-not-answer-theme', 'error',
      `结局没有回答控制性理念「${answer.declared}」。`,
      '在「结局」节拍上加 answer，写清"因为主角最后的选择，世界变成了什么样"，让这句话与 theme 正面呼应。')
  }

  /* --- each act has a turning point (McKee, research §五) --- */
  const acts = records(root.acts)
  if (acts.length === 0) {
    push('acts-missing', 'error',
      '没有 acts：三幕结构缺失，无法判断幕的转折点。',
      '补 acts 数组，固定 3 幕，每幕写清这一幕结束时的状态变化。')
  } else {
    if (acts.length !== 3) {
      push('act-count', 'warning',
        `acts 有 ${acts.length} 幕，短剧通用的是三幕结构。`,
        '合并或拆分到 3 幕；幕数不是硬性错误，但每一幕都必须以一次状态变化收尾。')
    }
    acts.forEach((act, index) => {
      const no = Math.max(1, Math.round(numOr(pick(act, ['no', 'number']), index + 1)))
      const turningPoint = text(pick(act, ['turningPoint', 'turn', 'pivot']))
      if (turningPoint === '') {
        push('act-without-turning-point', 'warning',
          `第 ${no} 幕没有 turningPoint：这一幕以状态收束，但没有转折点。`,
          `给第 ${no} 幕补 turningPoint，写清"什么被改变了"，而不是"发生了什么"。`)
      }
    })
  }

  /* --- 场景必须翻转价值负荷 (McKee) — see `auditScenes` for the full audit */
  const turns = auditScenes(root).filter(row => row.value !== '' || row.turns === false)
  const flat = turns.filter(row => row.turns === false)
  if (flat.length > 0) {
    push('scene-flat', 'warning',
      `${flat.length} 个场景的价值负荷没有翻转（入口与出口同号），这些场景按麦基的标准没有存在理由。`,
      '给每个场景补 valueEntry / valueExit（正负相反），或把该场景合并进相邻场景。')
  }

  const errors = issues.filter(issue => issue.severity === 'error').length
  const warnings = issues.length - errors

  return {
    ok: errors === 0,
    score: Math.max(0, Math.round(100 - errors * 18 - warnings * 6)),
    issues,
    beats: rows,
  }
}

/* ================================================================== *
 * 2. value charge (McKee: a scene must turn its value)
 * ================================================================== */

/**
 * The value-charge vocabulary.
 *
 * SOURCE — docs/research-2026.md §五: "每个场景要有价值转折（场景开头与结尾的
 * 价值负荷必须相反，否则这个场景没有存在理由）". This is a direct encoding of
 * McKee's rule.
 *
 * Each entry names ONE value axis and its two poles. A scene declares which
 * axis it is about, and whether it entered on the positive or the negative
 * pole; a scene whose entry and exit sit on the SAME pole has not turned and,
 * by McKee's standard, has no reason to exist.
 *
 * @type {Array<{ id: string, name: string, positive: string, negative: string }>}
 */
export const VALUE_CHARGES = [
  { id: 'love', name: '爱/恨', positive: '爱', negative: '恨' },
  { id: 'freedom', name: '自由/奴役', positive: '自由', negative: '奴役' },
  { id: 'life', name: '生/死', positive: '生', negative: '死' },
  { id: 'hope', name: '希望/绝望', positive: '希望', negative: '绝望' },
  { id: 'truth', name: '真相/谎言', positive: '真相', negative: '谎言' },
  { id: 'victory', name: '胜利/失败', positive: '胜利', negative: '失败' },
  { id: 'power', name: '掌权/失势', positive: '掌权', negative: '失势' },
  { id: 'trust', name: '信任/背叛', positive: '信任', negative: '背叛' },
  { id: 'dignity', name: '尊严/屈辱', positive: '尊严', negative: '屈辱' },
  { id: 'wealth', name: '富足/贫困', positive: '富足', negative: '贫困' },
]

/** Fast id → value axis lookup. */
const CHARGE_BY_ID = new Map(VALUE_CHARGES.map(charge => [charge.id, charge]))

/**
 * A value-charge id list for prompt text.
 * @returns {string[]} e.g. `['love（爱/恨）', …]`
 */
export function valueChargeList() {
  return VALUE_CHARGES.map(charge => `${charge.id}（${charge.name}）`)
}

/**
 * The direction of one declared charge.
 *
 * Understands the three spellings a model realistically emits:
 *   - a stable id (`'hope'`),
 *   - a pole word (`'希望'`),
 *   - an axis name (`'希望/绝望'`).
 * Directional words and an explicit `+`/`-` prefix are matched FIRST, because
 * `'希望/绝望'` contains BOTH poles and only the entry/exit text can say which
 * one this is.
 *
 * THE AXIS IS ALWAYS INFERRED FROM THE TEXT, never trusted as a label. An
 * earlier version returned the raw string as the axis whenever a direction was
 * present, which silently deleted the axis for the single most common input —
 * `valuePair: '希望/绝望'` — and made the reported `value` field empty. Axis
 * inference is what makes the audit's own output readable, so it is derived
 * here for the pole-word and axis-name cases as well as the id case.
 *
 * @param {unknown} value
 * @returns {{ axis: string, dir: 1 | -1 | 0, label: string }} dir 1 positive, -1 negative, 0 unknown
 */
function chargeOf(value) {
  if (isRecord(value)) {
    // `{ axis: 'hope', pole: 'negative' }` — also read a nested entry/exit pair.
    const axis = text(pick(value, ['axis', 'value', 'id', 'name']))
    const pole = text(pick(value, ['pole', 'sign', 'charge', 'direction']))
    const nested = pole !== '' ? pole : text(pick(value, ['exit', 'entry']))
    const resolved = chargeOf(axis)
    if (nested === '') return resolved
    return { axis: resolved.axis, dir: directionOf(nested) || resolved.dir, label: nested }
  }

  const raw = text(value)
  if (raw === '') return { axis: '', dir: 0, label: '' }

  const directional = directionOf(raw)
  const axis = CHARGE_BY_ID.has(raw)
    ? raw
    : (VALUE_CHARGES.find(charge =>
      raw.includes(charge.positive) || raw.includes(charge.negative))?.id ?? '')

  // A `-` / `负` / `neg` prefix is the other common spelling of the negative
  // pole; likewise `+` / `正` / `pos` for the positive.
  const explicitNegative = /^\s*[-−]/.test(raw) || /^负/.test(raw) || /^neg/i.test(raw)
  const explicitPositive = /^\s*\+/.test(raw) || /^正/.test(raw) || /^pos/i.test(raw)
  const dir = directional !== 0
    ? directional
    : explicitNegative
      ? -1
      : explicitPositive
        ? 1
        : 0

  return { axis, dir, label: raw }
}

/**
 * Map a pole word to its sign.
 * @param {string} raw
 * @returns {1 | -1 | 0}
 */
function directionOf(raw) {
  const value = text(raw)
  if (value === '') return 0
  if (value === '+' || /^pos/i.test(value) || /^(positive|正|好|吉)/.test(value)) return 1
  if (value === '-' || /^neg/i.test(value) || /^(negative|负|坏|凶)/.test(value)) return -1
  for (const charge of VALUE_CHARGES) {
    if (value === charge.positive) return 1
    if (value === charge.negative) return -1
  }
  return 0
}

/**
 * Read the scenes out of any story/script shape.
 *
 * WHY THIS IS NOT A ONE-LINER: a script stage payload is an
 * episode→scene→shot TREE (`episodes[].scenes[]`), while a story stage payload
 * keys beats by fraction and rarely lists shots. Auditing scenes must therefore
 * walk the tree AND tolerate a flat `scenes: []` de-normalized by a human edit.
 *
 * @param {unknown} story
 * @returns {Array<{ sceneRef: string, scene: Record<string, unknown>, episodeNo: number, sceneNo: number, index: number }>}
 */
export function readScenes(story) {
  const root = isRecord(story) ? story : {}
  const out = []
  let index = 0

  const episodes = records(root.episodes)
  episodes.forEach((episode, episodeIndex) => {
    const episodeNo = Math.max(1, Math.round(numOr(pick(episode, ['no', 'number']), episodeIndex + 1)))
    records(episode.scenes).forEach((scene, sceneIndex) => {
      index += 1
      const sceneNo = Math.max(1, Math.round(numOr(pick(scene, ['no', 'number']), sceneIndex + 1)))
      const slug = text(pick(scene, ['slug', 'sceneId', 'id', 'name'])) || `ep${episodeNo}-sc${sceneNo}`
      out.push({ sceneRef: outlineId('scene', slug), scene, episodeNo, sceneNo, index })
    })
  })

  if (out.length === 0) {
    records(root.scenes).forEach((scene, sceneIndex) => {
      index += 1
      const sceneNo = Math.max(1, Math.round(numOr(pick(scene, ['no', 'number']), sceneIndex + 1)))
      const slug = text(pick(scene, ['slug', 'sceneId', 'id', 'name'])) || `sc${sceneNo}`
      out.push({ sceneRef: outlineId('scene', slug), scene, episodeNo: 1, sceneNo, index })
    })
  }

  return out
}

/**
 * Audit every scene's value charge.
 *
 * MCKEE'S RULE (research §五): "场景开头与结尾的价值负荷必须相反，否则这个场景没有
 * 存在理由". A scene whose entry and exit charges are the SAME has not turned.
 *
 * MEASUREMENT (and what it means when it is empty):
 * `turns` is only judged when the scene actually DECLARES both poles. A scene
 * with no declaration gets `turns: true` and `value: ''`, i.e. "not measured".
 * Failing an undeclared scene would be laundering a guess into a fact, and would
 * also fail every script written before this engine existed. The declared-but-
 * flat case — the one McKee actually condemns — is flagged in `message`, and
 * `validateStructure` reports the count.
 *
 * @param {unknown} story
 * @returns {Array<{ sceneRef: string, value: string, entry: string, exit: string, turns: boolean, message: string }>}
 */
export function auditScenes(story) {
  return readScenes(story).map(row => {
    const scene = row.scene
    const rawAxis = pick(scene, ['value', 'valuePair', 'valueCharge', 'valueAxis'])
    const rawEntry = pick(scene, ['valueEntry', 'entry', 'valueStart'])
    const rawExit = pick(scene, ['valueExit', 'exit', 'valueEnd'])

    const axis = chargeOf(rawAxis)
    const entry = chargeOf(rawEntry)
    const exit = chargeOf(rawExit)

    const value = text(axis.label) || text(entry.label) || text(exit.label)
    const entryLabel = text(entry.label)
    const exitLabel = text(exit.label)

    // Both poles must be decidable to make a claim about turning.
    const measured = entry.dir !== 0 && exit.dir !== 0
    const turns = measured ? entry.dir !== exit.dir : true

    let message
    if (!measured) {
      message = '未声明价值负荷：无法判断本场是否翻转（不算通过，也不算失败）。'
    } else if (turns) {
      message = `开场「${entryLabel}」→ 收场「${exitLabel}」，价值负荷翻转。`
    } else {
      message = `开场「${entryLabel}」→ 收场「${exitLabel}」，价值负荷没有翻转：按麦基的标准，这场戏没有存在理由，应合并或重写。`
    }

    return {
      sceneRef: row.sceneRef,
      value,
      entry: entryLabel,
      exit: exitLabel,
      turns,
      message,
    }
  })
}

/* ================================================================== *
 * 3. hook mechanics (short-drama specific)
 * ================================================================== */

/**
 * The hook vocabulary.
 *
 * SOURCE — docs/research-2026.md §四: "短剧需遵循强钩子 + 快节奏 + 反转密原则：
 * 开头 3 秒抛出冲突（打脸/逆袭）", and "AI 内置'黄金三秒''强冲突''反转'等短剧
 * 特有结构，确保开篇 3 秒设置钩子（如吵架、穿越、打脸）".
 *
 * These six are the shapes that data describes. `risk` is the honest cost of
 * each: a hook type is not free, and a brief that recommends one without saying
 * what it costs produces a worse script than no advice.
 *
 * @type {Array<{ id: string, name: string, whenToUse: string, examples: string[], risk: string }>}
 */
export const HOOK_TYPES = [
  {
    id: 'reversal-face-slap',
    name: '打脸/逆袭',
    whenToUse: '观众已经知道主角被低估时。第一集就用，让观众在 3 秒内站到主角一边。',
    examples: [
      '被当众羞辱的赘婿，在退婚现场接到并购成功的电话，只说一句"那就按我的价买"。',
      '全班嘲笑她考不上，成绩单贴出来的那一刻，嘲笑她的人自己念出了分数。',
    ],
    risk: '滥用会让人物变成工具：主角如果每次都能反杀，观众会提前知道结果，悬念归零。每 3 集最多用 1 次，其余靠信息差。',
  },
  {
    id: 'identity-reveal',
    name: '身份反转',
    whenToUse: '主角真实身份与表面身份落差足够大，且这个落差能解释前面的所有委屈时。',
    examples: [
      '所有人叫她"扫地的"，直到集团年会大屏亮出她的持股比例。',
      '当铺学徒打开老板锁了三十年的抽屉，里面全是他自己的照片。',
    ],
    risk: '身份反转必须在前 3 集内给过一次可回溯的伏笔，否则观众会觉得被骗而不是被惊到。',
  },
  {
    id: 'countdown',
    name: '危机倒计时',
    whenToUse: '有一个明确的截止时间，且超时的后果当场可见时。适合中段维持节奏。',
    examples: [
      '手术同意书放在桌上，护士说"还有四十分钟"。',
      '屏幕上的数字每秒减少，男主的手停在转账键上。',
    ],
    risk: '倒计时一旦开始就不能暂停；把倒计时当背景板会让观众认定"反正不会真的爆"。',
  },
  {
    id: 'question',
    name: '悬念提问',
    whenToUse: '答案是一个具体、可被拍出来的事实，而不是情绪时。适合每集结尾。',
    examples: [
      '她终于打开那封信——信上的日期，是她出生前一年。',
      '所有人都说是意外，只有他知道，那天车上还有第三个人。',
    ],
    risk: '悬念必须当集或次集给出部分答案。只提问不回答，第 3 集起留存会断崖式下跌。',
  },
  {
    id: 'visual-impact',
    name: '视觉冲击',
    whenToUse: '有竖屏无法忽视的画面时（近景血、火、坠物、极端表情）。用于第 1 集第 1 秒。',
    examples: [
      '开场特写：一只戴婚戒的手，把整杯红酒倒在自己的合同上。',
      '暴雨里，他跪在车灯前，西装上全是血，手里攥着一张登机牌。',
    ],
    risk: '视觉冲击必须与主线有关。炫技式的开场画面会让观众记住画面、记不住故事，第 2 集就掉。',
  },
  {
    id: 'conflict-open',
    name: '冲突开场',
    whenToUse: '默认选项。当没有更好的钩子时，让两个人在第一秒就为具体的东西争执。',
    examples: [
      '"签了它。"她把离婚协议推过桌面，手机在同时震了七次。',
      '"货不对板，退钱。"他当着一屋子人的面，把那箱药倒在地上。',
    ],
    risk: '冲突必须是"具体的、正在发生的"分歧，不是互相喊叫。吵得越抽象，观众越早划走。',
  },
]

/** Fast id → hook type lookup. */
const HOOK_BY_ID = new Map(HOOK_TYPES.map(hook => [hook.id, hook]))

/**
 * A hook-type id list for prompt text.
 * @returns {string[]} e.g. `['打脸/逆袭（reversal-face-slap）', …]`
 */
export function hookTypeList() {
  return HOOK_TYPES.map(hook => `${hook.name}（${hook.id}）`)
}

/**
 * Look up one hook type.
 * @param {string} id
 * @returns {typeof HOOK_TYPES[number] | undefined}
 */
export function hookById(id) {
  return HOOK_BY_ID.get(text(id))
}

/**
 * The first-3-seconds retention deadline.
 *
 * SOURCE — docs/research-2026.md §四: "超 85% 的用户划走行为发生在视频前三秒"
 * and "开头 3 秒抛出冲突"; §四 corroboration: "开头 3 秒炸裂" and the core
 * principle 冲突前置. The number is a PARAMETER, not a constant, because §四
 * warns these are platform/vendor figures and §十 repeats that a vendor-side
 * number is a default, not a law.
 */
export const DEFAULT_HOOK_SECONDS = 3

/**
 * How late the FIRST concrete conflict may arrive before it is a retention bug.
 *
 * WHY A SECOND, SEPARATE RULE (this is the 冲突前置 check): "the opening contains
 * a conflict" and "the opening STARTS with one" are different requirements, and
 * only the second one matches the data. A model can satisfy `auditHook`'s
 * scenery check with a neutral first shot — someone answers a phone, someone
 * walks down a corridor — and drop the actual conflict at 20s. Everything looks
 * compliant and the episode still loses the audience, because §四 says >85% of
 * swipes happen in the first 3 seconds: a conflict at 20s reaches almost nobody.
 *
 * SOURCE — docs/research-2026.md §四 corroboration (added after the first pass):
 * "爆火短剧一般 30 秒内有冲突" plus the three cores 冲突前置、情绪拉满、节奏反转,
 * and "开头 3 秒炸裂". Two independently-worded sources put the conflict window
 * at the very front, so this is implemented as a PARAMETER with the same 3-second
 * default as the hook window rather than as a second hardcoded constant.
 *
 * TUNABLE, LIKE `reversalEverySec`: research §十 states the platform figures are
 * vendor-side, and §十一 keeps "每 30 秒一个反转是否适合本项目调性" on the
 * unverified list. The same scepticism applies here — override
 * `conflictBySec` per project.
 *
 * @type {number}
 */
export const DEFAULT_CONFLICT_BY_SEC = 3

/**
 * Scene-setting / scenery-only openings — the #1 retention killer.
 *
 * WHY A WORD LIST IS THE WRONG INSTRUMENT (and what is done instead): the only
 * reliable way to know whether the first shot is scenery is to READ it. A regex
 * over `action` can catch stock scenery nouns ("清晨", "阳光洒进", "城市全景"),
 * but it will miss a beautifully written empty establishing shot. So this list is
 * used as EVIDENCE FOR A FLAG, never as a pass: a clean regex result does NOT
 * clear the opening — the absence of an explicit conflict/suspense/hook cue
 * does. See `auditHook`.
 *
 * @type {string[]}
 */
export const SCENERY_MARKERS = [
  '清晨', '早晨', '阳光', '晨光', '夕阳', '晚霞', '夜色', '月光',
  '全景', '空镜', '航拍', '远景', '俯瞰', '镜头缓缓推进',
  '城市', '街道', '车流', '人流', '天空', '云层', '雨滴落在',
  '画面渐渐亮起', '镜头从', '拉开帷幕', '伴随着音乐',
]

/**
 * Conflict / suspense cues that count as "a concrete hook is present".
 *
 * Kept deliberately small and physical: these are words that describe something
 * HAPPENING between people, not atmosphere. Used by both the scenery check and
 * the 冲突前置 check, so widening this list moves both rules at once.
 *
 * HONEST LIMIT: this is a lexicon, not comprehension. It cannot recognise a
 * conflict expressed without any of these words ("他把杯子放下了。" can be the
 * most threatening line in an episode), which is exactly why a miss produces a
 * flag the human can override rather than a silent pass.
 *
 * @type {string[]}
 */
export const CONFLICT_MARKERS = [
  '摔', '砸', '掀', '推倒', '打', '扇', '掐', '拽', '夺', '抢', '吼', '骂', '质问',
  '签', '撕', '拒绝', '打断', '逼', '威胁', '警告', '赶出', '退婚', '离婚', '翻脸',
  '倒戈', '背叛', '出卖', '晕倒', '流血', '跪', '跪下', '崩溃', '哭喊',
  '真相', '秘密', '谎言', '骗', '瞒', '冒充', '替身', '身份',
  '倒计时', '还剩', '最后', '来不及', '马上', '立即', '立刻',
]

/**
 * Read the opening shots of one episode, in order.
 *
 * Accepts an episode object (`{ scenes: [{ shots: [...] }] }`), a bare episode
 * with a flat `shots` array, or a normalized shot list. The order that matters
 * is PLAYBACK order, so scenes and shots are walked in array order and shots are
 * NOT re-sorted by `seq` — a model that numbers shots globally still means the
 * array order on screen.
 *
 * @param {unknown} episode
 * @returns {Array<Record<string, unknown>>}
 */
export function readEpisodeShots(episode) {
  const root = isRecord(episode) ? episode : {}
  const out = []
  for (const scene of records(root.scenes)) {
    out.push(...records(scene.shots))
    // A scene with no shots still contributes its own action as the opening
    // image, because that is literally what would be on screen.
    if (records(scene.shots).length === 0 && text(pick(scene, ['action', 'description'])) !== '') {
      out.push({
        action: pick(scene, ['action', 'description']),
        dialogue: pick(scene, ['dialogue', 'lines']),
        durationSeconds: pick(scene, ['durationSec', 'durationSeconds']),
      })
    }
  }
  if (out.length === 0) out.push(...records(root.shots))
  return out
}

/**
 * One shot's readable surface: action + dialogue + camera intent, joined.
 * @param {Record<string, unknown>} shot
 * @returns {string}
 */
function shotSurface(shot) {
  const dialogue = shot.dialogue
  const spoken = Array.isArray(dialogue)
    ? records(dialogue).map(line => text(pick(line, ['line', 'text']))).join(' ')
    : text(dialogue)
  return [
    text(pick(shot, ['action', 'description', 'content', 'motion'])),
    text(pick(shot, ['speaker'])),
    spoken,
    text(pick(shot, ['hookCue'])),
  ].filter(part => part !== '').join(' ')
}

/**
 * Find the earliest second at which a concrete conflict appears in a shot list.
 *
 * WHY SECOND-ACCURATE RATHER THAN SHOT-INDEXED: the brief tells the model
 * "conflict within 3 seconds", and a model can satisfy that either with a 3s
 * first shot that carries the conflict or with a 2s neutral shot followed by a
 * 2s conflict. Both are compliant and only a time-based measure can tell them
 * apart (and tell them apart from the 20s case that is the real failure).
 *
 * @param {Array<Record<string, unknown>>} shots in playback order
 * @param {{ shotSeconds?: number, hookCue?: string }} [options]
 * @returns {{ atSecond: number, shotIndex: number, marker: string, viaCue: boolean } | undefined}
 *   `undefined` when no conflict cue is found anywhere in the episode.
 */
export function findFirstConflict(shots, options = {}) {
  const opts = isRecord(options) ? options : {}
  const shotSeconds = Math.max(1, numOr(opts.shotSeconds, PROJECT_DEFAULTS.shotSeconds))
  const cue = text(opts.hookCue)

  let elapsed = 0
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index]
    const surface = shotSurface(shot)
    const marker = CONFLICT_MARKERS.find(candidate => surface.includes(candidate))
    // A declared hookCue counts, but only where it actually sits: the cue on
    // shot 1 means 0s, and the cue on shot 6 means whatever came before it.
    const viaCue = cue !== '' && surface.includes(cue)
    if (marker !== undefined || viaCue) {
      return { atSecond: round(elapsed, 2), shotIndex: index, marker: marker ?? 'hookCue', viaCue }
    }
    elapsed += Math.max(1, numOr(pick(shot, ['durationSeconds', 'duration', 'durationSec', 'seconds']), shotSeconds))
  }
  return undefined
}

/**
 * Audit one episode's opening hook against BOTH retention rules.
 *
 * SOURCE — docs/research-2026.md §四: >85% of swipe-aways happen in the first
 * 3 seconds; a designed hook lifts retention ~68%. §四 also flags these as
 * platform/vendor figures (§十 repeats it), so every threshold here is a
 * parameter with a default.
 *
 * RULE 1 — CONFLICT PRESENT IN THE OPENING WINDOW (`hookSeconds`, default 3s).
 * Accumulate shots in playback order until `hookSeconds` of runtime has elapsed
 * (always at least ONE shot — a 6-second first shot is still the first 3 seconds
 * of the show), and require a concrete conflict/suspense cue. Opening on scenery
 * alone is an ERROR: it is the single most expensive failure mode in the data.
 *
 * RULE 2 — CONFLICT FRONT-LOADED (`conflictBySec`, default 3s). 冲突前置: the
 * conflict must be at the FRONT, not merely somewhere in the episode. A neutral
 * first shot whose conflict arrives at 20s passes rule 1 only if the opening
 * window is stretched to 20s, which is why this is measured separately across the
 * whole episode. Reported as `firstConflictAt` and as an ERROR past the threshold.
 *
 * HONEST LIMIT: this is a lexical check over the shots' text plus the declared
 * `hookCue`. It cannot tell a gripping scene-setting line from a dull one, and it
 * cannot see a conflict that carries none of the listed words. It errs toward
 * flagging — a false flag costs a rewrite, a missed flag costs the episode — and
 * every threshold is overridable so a project with a different tonality can move
 * it (research §十一 keeps this class of number explicitly unverified).
 *
 * @param {unknown} episode
 * @param {{ hookSeconds?: number, shotSeconds?: number, conflictBySec?: number }} [options]
 * @returns {{
 *   ok: boolean, hookType: string, hookSeconds: number, conflictBySec: number,
 *   openingSeconds: number, firstConflictAt: number | null,
 *   issues: Array<{ code: string, severity: 'error' | 'warning', message: string, fix: string }>,
 * }}
 */
export function auditHook(episode, options = {}) {
  const opts = isRecord(options) ? options : {}
  const hookSeconds = Math.max(1, numOr(opts.hookSeconds, DEFAULT_HOOK_SECONDS))
  // PARAMETER, defaulted from research §四 corroboration (冲突前置), tunable per §十.
  const conflictBySec = Math.max(1, numOr(opts.conflictBySec, DEFAULT_CONFLICT_BY_SEC))
  const shotSeconds = Math.max(1, numOr(opts.shotSeconds, PROJECT_DEFAULTS.shotSeconds))
  const root = isRecord(episode) ? episode : {}

  const issues = []
  /** @param {string} code @param {'error'|'warning'} severity @param {string} message @param {string} fix */
  const push = (code, severity, message, fix) => { issues.push({ code, severity, message, fix }) }

  const shots = readEpisodeShots(root)
  if (shots.length === 0) {
    push('opening-missing', 'error',
      '这一集没有可检查的开场镜头：没有镜头就意味着前 3 秒是空的。',
      '补本集第一场的 shots，第 1 镜必须是正在发生的冲突或悬念，不是环境交代。')
    return {
      ok: false,
      hookType: text(pick(root, ['hookType'])),
      hookSeconds,
      conflictBySec,
      openingSeconds: 0,
      firstConflictAt: null,
      issues,
    }
  }

  // Walk playback order until the FIRST retention window closes (always ≥ 1 shot).
  const opening = []
  let elapsed = 0
  for (const shot of shots) {
    opening.push(shot)
    elapsed += Math.max(1, numOr(pick(shot, ['durationSeconds', 'duration', 'durationSec', 'seconds']), shotSeconds))
    if (elapsed >= hookSeconds) break
  }
  const openingSeconds = round(elapsed, 2)

  // The episode-level `hookCue` is authored BY the opening, so it belongs to the
  // FIRST shot, not to every shot in the window. Applying it to the whole window
  // made the scenery rule unreachable: a neutral 10-second shot 1 followed by a
  // conflict at 20s would "have a cue" and never be flagged. A cue declared on a
  // shot is that shot's own surface and stays where it is.
  const episodeCue = text(pick(root, ['hookCue', 'openingHook']))
  const openingShotCues = opening.map(shot => text(pick(shot, ['hookCue']))).filter(part => part !== '')
  const hookCue = episodeCue !== '' ? episodeCue : openingShotCues.join(' ')

  const surfaces = opening.map(shotSurface)
  if (episodeCue !== '' && surfaces.length > 0) surfaces[0] = `${surfaces[0]} ${episodeCue}`.trim()
  const surface = surfaces.join(' ')

  const declaredType = text(pick(root, ['hookType', 'hook']))
  const knownType = HOOK_BY_ID.has(declaredType)

  const conflictHits = CONFLICT_MARKERS.filter(marker => surface.includes(marker))
  const sceneryHits = SCENERY_MARKERS.filter(marker => surface.includes(marker))
  const hasCue = conflictHits.length > 0

  // Where does the first real conflict land? Computed BEFORE rule 1, because the
  // two rules share it: a conflict at 12s is a FRONT-LOADING failure (it exists,
  // it is just late) and must not be reported as a scenery failure (which would
  // tell the writer to invent a conflict that is already there).
  const first = findFirstConflict(shots, { shotSeconds, hookCue: episodeCue })
  const firstConflictAt = first === undefined ? null : first.atSecond
  const conflictWithinWindow = firstConflictAt !== null && firstConflictAt <= hookSeconds
  const conflictExists = first !== undefined

  /* ---- RULE 1: is there a conflict inside the opening window? ---- */
  if (!hasCue && !conflictWithinWindow) {
    if (conflictExists) {
      // A conflict exists but sits past the window: that is 冲突前置, diagnosed
      // precisely by rule 2 below with the real second. Emitting the scenery
      // error here as well would double-report and prescribe the wrong fix.
      // (Nothing is pushed; rule 2 carries the finding.)
    } else if (episodeCue !== '' && surface.replace(episodeCue, '').trim() === '') {
      push('hook-cue-unverified', 'warning',
        `开场声明了 hookCue「${episodeCue}」，但镜头正文是空的，无法确认这个钩子真的被拍出来了。`,
        '把 hookCue 落成第 1 镜的 action（谁对谁做了什么），而不是只写在 episode 的字段里。')
    } else {
      push('opening-is-scenery', 'error',
        `开场 ${openingSeconds} 秒内没有任何具体冲突或悬念（只有环境/氛围描写：${sceneryHits.join('、') || '未识别到明确冲突词'}）。研究 §四：超 85% 的划走发生在前 3 秒，环境开场是留存第一杀手。`,
        '把第 1 镜换成一个正在发生的冲突：两个人正在为一件具体的东西争执，或一个已经发生的坏结果的第一帧。把环境交代挪到第 2-3 镜，或干脆删掉。')
    }
  }

  /* ---- RULE 2: 冲突前置 — how late does the first real conflict arrive? ---- */
  if (first === undefined) {
    // No recognisable conflict anywhere in the episode: stronger than "late".
    push('conflict-absent', 'error',
      '整集没有任何可识别的冲突动作：钩子不只是"来得晚"，而是不存在。',
      '给本集一个具体的对立：谁要什么、谁在阻止他。开场就把这个对立摆到画面上。')
  } else if (firstConflictAt !== null && firstConflictAt > conflictBySec) {
    // A conflict that exists but arrives late. Severity tracks HOW late: past the
    // error ratio it is the documented front-loading error; between the window
    // and that ratio it is a warning, because the conflict is at least present.
    const severe = firstConflictAt >= conflictBySec * 2
    push('conflict-not-front-loaded', severe ? 'error' : 'warning',
      `冲突第一次出现在第 ${firstConflictAt} 秒（第 ${first.shotIndex + 1} 镜，命中「${first.marker}」），超过 ${conflictBySec} 秒的冲突前置阈值。研究 §四：冲突必须前置，前 3 秒没有冲突的话绝大多数观众已经划走。`,
      `把第 ${first.shotIndex + 1} 镜的冲突提到第 1 镜，或把第 1 镜换成一个已经发生的冲突结果；前面 ${firstConflictAt} 秒的铺垫全部删掉或压缩进台词。`)
  }

  if (declaredType === '') {
    push('hook-type-missing', 'warning',
      '这一集没有声明 hookType：钩子的类型没有被写下来，无法复用也无法避免重复。',
      `补 hookType，从这些里选一个：${hookTypeList().join('、')}。`)
  } else if (!knownType) {
    push('hook-type-unknown', 'warning',
      `hookType「${declaredType}」不在钩子类型表里。`,
      `改用标准 id：${HOOK_TYPES.map(hook => hook.id).join('、')}。`)
  }

  return {
    ok: issues.every(issue => issue.severity !== 'error'),
    hookType: declaredType,
    hookSeconds,
    conflictBySec,
    openingSeconds,
    firstConflictAt,
    issues,
  }
}

/* ================================================================== *
 * 4. pacing audit (short-drama rhythm)
 * ================================================================== */

/**
 * The house rhythm: a small reversal roughly every 30 seconds.
 *
 * SOURCE — docs/research-2026.md §四: "每 30 秒一个小反转".
 * §四 CORROBORATION: a second, independently-worded source states
 * "爆火短剧一般 30 秒内有冲突，2 分钟内出现反转", which supports 30s as the
 * default for the CONFLICT cadence. Note the two sources are not describing
 * quite the same beat (one is a small reversal, the other a conflict), which is
 * a further reason to treat this as an order-of-magnitude default rather than a
 * precise specification.
 *
 * ⚠️ RESEARCH §十一 ITEM 5 EXPLICITLY FLAGS THIS AS UNVERIFIED: "具体的「每 30 秒
 * 一个反转」是否适合本项目调性——这是默认值，用户应可覆盖." Research §十 adds
 * that the platform figures are vendor-side, not independent research. It is
 * therefore a DEFAULT PARAMETER (`reversalEverySec`), never a hardcoded
 * constant, and every consumer takes it from options.
 *
 * @type {number}
 */
export const DEFAULT_REVERSAL_EVERY_SEC = 30

/**
 * Read the reversal timestamps an episode declares.
 *
 * A reversal point may be declared in three ways, all accepted:
 *   - `reversalPoints: [12, 40]` — seconds from the start of the episode;
 *   - `reversalPoints: [{ at: 12 }]` / `{ second: 12 }` — an object per point;
 *   - a scene flagged `reversal: true` / `isReversal: true` — the position is
 *     then derived from the running shot durations.
 *
 * @param {unknown} episode
 * @param {{ shotSeconds?: number }} [options]
 * @returns {{ points: number[], source: 'declared' | 'derived' | 'none', episodeSeconds: number }}
 */
export function readReversalPoints(episode, options = {}) {
  const opts = isRecord(options) ? options : {}
  const shotSeconds = Math.max(1, numOr(opts.shotSeconds, PROJECT_DEFAULTS.shotSeconds))
  const root = isRecord(episode) ? episode : {}

  let elapsed = 0
  const derived = []
  let anyReversalFlag = false

  for (const scene of records(root.scenes)) {
    const shots = records(scene.shots)
    const flag = pick(scene, ['reversal', 'isReversal', 'turns'])
    if (flag === true || flag === 'true') {
      anyReversalFlag = true
      derived.push(round(elapsed, 2))
    }
    if (shots.length === 0) {
      elapsed += Math.max(1, numOr(pick(scene, ['durationSec', 'durationSeconds']), shotSeconds))
      continue
    }
    for (const shot of shots) {
      const flagShot = pick(shot, ['reversal', 'isReversal'])
      if (flagShot === true || flagShot === 'true') {
        anyReversalFlag = true
        derived.push(round(elapsed, 2))
      }
      elapsed += Math.max(1, numOr(pick(shot, ['durationSeconds', 'duration', 'durationSec', 'seconds']), shotSeconds))
    }
  }
  if (elapsed === 0) {
    elapsed = records(root.shots).reduce((sum, shot) =>
      sum + Math.max(1, numOr(pick(shot, ['durationSeconds', 'duration', 'durationSec', 'seconds']), shotSeconds)), 0)
  }
  const episodeSeconds = round(elapsed, 2)

  const raw = pick(root, ['reversalPoints', 'reversals', 'turns'])
  if (Array.isArray(raw) && raw.length > 0) {
    const points = raw
      .map(entry => (isRecord(entry) ? num(pick(entry, ['at', 'second', 'seconds', 'time', 'position'])) : num(entry)))
      .filter(point => point !== undefined)
      .map(point => round(/** @type {number} */ (point), 2))
      .sort((a, b) => a - b)
    if (points.length > 0) return { points, source: 'declared', episodeSeconds }
  }

  if (anyReversalFlag) {
    return { points: derived.sort((a, b) => a - b), source: 'derived', episodeSeconds }
  }
  return { points: [], source: 'none', episodeSeconds }
}

/**
 * Audit reversal spacing across an episode.
 *
 * THE MEASUREMENT: build the ordered list of reversal times
 * `[0, ...declared, episodeSeconds]` and measure the gaps between consecutive
 * entries. The leading 0 is the episode's own opening, which research §四 counts
 * as a hook position, so a first reversal at 25s is a 25s gap, not a 25s hole
 * with nothing before it. The trailing `episodeSeconds` exists so a LONG TAIL
 * after the last reversal is caught — an episode whose last reversal is at 40s of
 * a 180s runtime is exactly the "节奏掉了" failure, and without the tail it would
 * look perfect.
 *
 * @param {unknown} script an episode, a `{episodes:[…]}` script, or `{shots:[…]}`
 * @param {{ shotSeconds?: number, reversalEverySec?: number }} [options]
 * @returns {{
 *   ok: boolean, reversalEverySec: number, episodes: Array<object>,
 *   issues: Array<{ code: string, severity: 'error' | 'warning', message: string, fix: string }>,
 * }}
 */
export function auditPacing(script, options = {}) {
  const opts = isRecord(options) ? options : {}
  // PARAMETER, defaulted from research §四 and flagged unverifiable by §十一 item 5.
  const reversalEverySec = Math.max(1, numOr(opts.reversalEverySec, DEFAULT_REVERSAL_EVERY_SEC))
  const shotSeconds = Math.max(1, numOr(opts.shotSeconds, PROJECT_DEFAULTS.shotSeconds))

  const root = isRecord(script) ? script : {}
  const episodes = records(root.episodes).length > 0 ? records(root.episodes) : [root]

  const issues = []
  /** @param {string} code @param {'error'|'warning'} severity @param {string} message @param {string} fix */
  const push = (code, severity, message, fix) => { issues.push({ code, severity, message, fix }) }

  // A gap more than this many times the interval is an error rather than a
  // warning: at 2×, the audience has sat through two missed beats.
  const errorRatio = 2

  const report = episodes.map((episode, index) => {
    const episodeNo = Math.max(1, Math.round(numOr(pick(episode, ['no', 'number']), index + 1)))
    const { points, source, episodeSeconds } = readReversalPoints(episode, { shotSeconds })

    const timeline = [0, ...points.filter(point => point > 0 && point <= episodeSeconds), episodeSeconds]
    const gaps = []
    for (let i = 1; i < timeline.length; i += 1) {
      const from = timeline[i - 1]
      const to = timeline[i]
      const seconds = round(to - from, 2)
      const tooLong = seconds > reversalEverySec
      gaps.push({
        from,
        to,
        seconds,
        reversals: seconds > reversalEverySec ? Math.max(0, Math.ceil(seconds / reversalEverySec) - 1) : 0,
        ok: !tooLong,
      })
    }

    const worst = gaps.reduce((max, gap) => (gap.seconds > max ? gap.seconds : max), 0)
    const overlong = gaps.filter(gap => !gap.ok)
    const missing = overlong.reduce((sum, gap) => sum + gap.reversals, 0)

    for (const gap of overlong) {
      const severity = gap.seconds >= reversalEverySec * errorRatio ? 'error' : 'warning'
      push('gap-too-long', severity,
        `第 ${episodeNo} 集 ${gap.from}s → ${gap.to}s 之间有 ${gap.seconds} 秒没有反转（阈值 ${reversalEverySec} 秒）。`,
        `在这 ${gap.seconds} 秒里补 ${gap.reversals} 个反转点：一个具体的信息翻转或力量关系变化，不是"情绪加重"。`)
    }

    if (source === 'none' && episodeSeconds > reversalEverySec) {
      push('reversals-undeclared', 'warning',
        `第 ${episodeNo} 集约 ${episodeSeconds} 秒，但没有任何 reversalPoints：节奏完全无法被验证。`,
        '补 episodes[].reversalPoints（相对本集开头的秒数数组），或给发生反转的场景标 reversal: true。')
    }

    return {
      episode: episodeNo,
      episodeSeconds,
      source,
      reversalPoints: points,
      gaps,
      worstGapSeconds: round(worst, 2),
      missingReversals: missing,
      ok: overlong.length === 0,
    }
  })

  return {
    ok: issues.every(issue => issue.severity !== 'error'),
    reversalEverySec,
    episodes: report,
    issues,
  }
}

/* ================================================================== *
 * 5. structure from an idea
 * ================================================================== */

/**
 * Place a beat inside its canonical window at a requested fraction.
 * @param {typeof STORY_BEATS[number]} beat
 * @param {number} fraction the desired position (0..1)
 * @returns {number} clamped into the beat's window
 */
function placeBeat(beat, fraction) {
  return round(clamp(fraction, beat.positionMin, beat.positionMax), 4)
}

/**
 * Fill a structure skeleton from a one-line idea.
 *
 * This is the function that turns "一个想法" into "一个被设计过的故事": it places
 * every canonical beat at a REAL second offset, sizes the scene count from the
 * runtime, and hands each episode a hook type chosen by position in the show
 * (episode 1 must hook cold; the last episode must resolve, not tease).
 *
 * The beat placement is intentionally formulaic, not clever: the point is to
 * give the model a skeleton it must fill, so a one-line idea cannot decay into a
 * freeform ramble. Offsets are clamped into each beat's window, so the output is
 * always structurally valid even for a pathological runtime.
 *
 * @param {{
 *   logline?: string, genre?: string, episodes?: number, shotSeconds?: number,
 *   totalSeconds?: number, reversalEverySec?: number, conflictBySec?: number,
 *   scenesPerEpisode?: number,
 * }} [input]
 * @returns {{
 *   logline: string, genre: string, episodes: number, shotSeconds: number,
 *   totalSeconds: number, episodeSeconds: number, reversalEverySec: number,
 *   conflictBySec: number,
 *   beats: Array<{ id: string, name: string, purpose: string, position: number,
 *     atSecond: number, required: boolean }>,
 *   episodePlan: Array<{ no: number, startSecond: number, endSecond: number,
 *     seconds: number, hookType: string, hookSuggestion: string,
 *     reversalPoints: number[], minReversals: number }>,
 *   sceneCount: number, scenesPerEpisode: number, notes: string[],
 * }}
 */
export function proposeStructure(input = {}) {
  const source = isRecord(input) ? input : {}

  const episodes = Math.max(1, Math.round(numOr(source.episodes, PROJECT_DEFAULTS.episodes)))
  const shotSeconds = Math.max(1, Math.round(numOr(source.shotSeconds, PROJECT_DEFAULTS.shotSeconds)))

  // Total runtime: prefer an explicit figure, then an explicit per-episode
  // figure, then a 90-second default per episode (research §四 puts a
  // short-drama episode at 60-120 seconds; prompts.js already briefs "每集
  // 60-120 秒内容量").
  const explicitTotal = num(source.totalSeconds)
  const explicitPerEpisode = num(source.episodeSeconds)
  const fallbackPerEpisode = 90
  const perEpisode = explicitPerEpisode !== undefined
    ? Math.max(10, explicitPerEpisode)
    : explicitTotal !== undefined
      ? Math.max(10, explicitTotal / episodes)
      : fallbackPerEpisode
  const totalSeconds = Math.max(10, explicitTotal ?? perEpisode * episodes)

  // Scene count: an average short-drama scene runs 30-60 seconds, but every
  // scene must turn a value (McKee), so a scene shorter than ~15s cannot do the
  // job. At least 2 scenes per episode keeps a turn possible even in a 60s
  // episode.
  const scenesPerEpisode = Math.max(2, Math.round(numOr(source.scenesPerEpisode, Math.max(2, Math.round(perEpisode / 30)))))
  const sceneCount = scenesPerEpisode * episodes

  const beats = STORY_BEATS.map(beat => {
    // Aim at the MIDDLE of the window with a nudge for early beats: research §四
    // rewards front-loading, so the inciting incident is placed near the start
    // of its window rather than the middle.
    const front = beat.id === 'inciting'
    const fraction = front
      ? beat.positionMin + (beat.positionMax - beat.positionMin) * 0.35
      : (beat.positionMin + beat.positionMax) / 2
    const position = placeBeat(beat, fraction)
    return {
      id: beat.id,
      name: beat.name,
      purpose: beat.purpose,
      position,
      atSecond: round(position * totalSeconds, 1),
      required: beat.required,
    }
  })

  // Hook assignment by POSITION IN THE SHOW, not at random:
  //   - episode 1 hooks cold, so it uses the strongest available opening types;
  //   - the final episode must resolve the controlling idea, so it is told to
  //     close rather than to tease (research §四: "结尾留悬念" applies to
  //     non-final episodes; a final episode that teases leaves the theme
  //     unanswered and fails validateStructure).
  const episodePlan = Array.from({ length: episodes }, (_, index) => {
    const no = index + 1
    const startSecond = round(index * perEpisode, 1)
    const endSecond = round(Math.min(totalSeconds, (index + 1) * perEpisode), 1)
    const seconds = round(endSecond - startSecond, 1)
    const isFirst = no === 1
    const isLast = no === episodes

    // Rotate through the vocabulary so consecutive episodes do not repeat a
    // hook shape; `risk` is surfaced to the model below.
    const rotation = HOOK_TYPES.map(hook => hook.id)
    const hookType = isFirst
      ? 'conflict-open'
      : rotation[(no - 1) % rotation.length]
    const hook = HOOK_BY_ID.get(hookType) ?? HOOK_TYPES[HOOK_TYPES.length - 1]

    // Reversal points at the parameterised interval, plus a final reversal
    // shortly before the close. Every point is stored relative to this
    // episode's own start, matching the schema's definition.
    const step = Math.max(1, numOr(source.reversalEverySec, DEFAULT_REVERSAL_EVERY_SEC))
    const reversalPoints = []
    for (let at = step; at < seconds - step / 2; at += step) reversalPoints.push(round(at, 1))

    return {
      no,
      startSecond,
      endSecond,
      seconds,
      hookType: isLast && episodes > 1 ? 'question' : hookType,
      hookSuggestion: isFirst
        ? '第 1 秒就在画面上发生冲突：两个人正在为一件具体的东西争执，或一个已经发生的坏结果的第一帧。'
        : isLast
          ? '最后一集不吊悬念：让结局正面回答控制性理念，把价值落定。'
          : `用「${hook.name}」开场：${hook.examples[0]}`,
      reversalPoints,
      minReversals: Math.max(1, Math.floor(seconds / step)),
    }
  })

  const notes = [
    `总时长约 ${totalSeconds} 秒，分 ${episodes} 集，每集约 ${round(perEpisode, 1)} 秒；建议共 ${sceneCount} 场（每集 ${scenesPerEpisode} 场）。`,
    `激励事件必须落在第 ${round((STORY_BEATS[0].positionMax) * 100, 1)}% 之前（研究 §四：超 85% 的划走发生在前 3 秒）。`,
    `反转间隔按 ${numOr(source.reversalEverySec, DEFAULT_REVERSAL_EVERY_SEC)} 秒设计，这是研究 §四 的平台默认值（§四 另有一来源记作"30 秒内有冲突"），并被 §十一 标注为可调、§十 标注为厂商口径，不是定律。`,
    `冲突必须前置：第 1 镜就是冲突，不允许先铺垫再在第 ${numOr(source.conflictBySec, DEFAULT_CONFLICT_BY_SEC)} 秒之后才出现冲突（§四 的 冲突前置 原则）。`,
    '每个场景都必须翻转价值负荷（麦基：入口与出口的价值必须相反，否则这场戏没有存在理由）。',
    '结局必须回答控制性理念：写清"因为主角最后的选择，世界变成了什么样"。',
  ]
  if (episodes === 1) {
    notes.push('只有 1 集：结局与高潮距离很近，注意不要在结局里引入新冲突。')
  }

  return {
    logline: text(source.logline),
    genre: text(source.genre),
    episodes,
    shotSeconds,
    totalSeconds,
    episodeSeconds: round(perEpisode, 1),
    reversalEverySec: Math.max(1, numOr(source.reversalEverySec, DEFAULT_REVERSAL_EVERY_SEC)),
    conflictBySec: Math.max(1, numOr(source.conflictBySec, DEFAULT_CONFLICT_BY_SEC)),
    beats,
    episodePlan,
    sceneCount,
    scenesPerEpisode,
    notes,
  }
}

/* ================================================================== *
 * 6. brief integration (what the conversational model is told)
 * ================================================================== */

/**
 * The two stage schemas this module extends, expressed as JSON Schema
 * ADDITIONS rather than replacements.
 *
 * WHY ADDITIONS: `stages.js` reads a fixed set of keys explicitly and passes
 * every OTHER key through (`keepExtras` for shots, `{...wrapper}` for the
 * script/story root and for scenes/episodes). So a field is safe to add only
 * when it sits on a record whose extras survive the normalizer. Verified
 * empirically before this was written (see docs/verify-story.mjs assertion g):
 *   - script root, episodes[], scenes[], shots[] → extras survive;
 *   - an episode with NO `scenes` key is not reachable after normalization —
 *     `flattenScriptShots` reads `episode.scenes` directly, so a missing/typo'd
 *     `scenes` silently drops the whole episode from the shot list.
 *
 * These additions are therefore emitted RECURSIVELY into the existing object
 * properties rather than as new top-level shape, and `scenes` is left alone so
 * the normalizer's episode walk keeps working.
 *
 * @type {Record<'story'|'script', object>}
 */
export const STORY_SCHEMA_ADDITIONS = {
  story: {
    beats: {
      type: 'array',
      description: `必填：故事节拍表，按时间顺序。必含 ${STORY_BEATS.map(beat => beat.id).join(' / ')}，position 是占总时长的比例（0..1）。`,
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '节拍 id，只能用固定这几个',
            enum: STORY_BEATS.map(beat => beat.id),
          },
          name: { type: 'string', description: '节拍中文名', example: '激励事件' },
          position: {
            type: 'number',
            description: `本拍所在的时长比例（0..1）：激励事件 ≤ ${STORY_BEATS[0].positionMax}，第一幕转折点 ${STORY_BEATS[1].positionMin}-${STORY_BEATS[1].positionMax}，中点 ${STORY_BEATS[2].positionMin}-${STORY_BEATS[2].positionMax}，危机 ${STORY_BEATS[3].positionMin}-${STORY_BEATS[3].positionMax}，高潮 ${STORY_BEATS[4].positionMin}-${STORY_BEATS[4].positionMax}，结局 ${STORY_BEATS[5].positionMin}-${STORY_BEATS[5].positionMax}`,
            example: 0.08,
          },
          purpose: { type: 'string', description: '这一拍具体发生了什么（可见的事件，不是情绪）', example: '苏家当众退婚，林越被赶出家门。' },
          answer: { type: 'string', description: '仅结局节拍需要：控制性理念的答案，写清因主角的选择世界变成了什么样。这一项是必填的：没有 answer 的结局会被结构校验判为不合格。', example: '尊严不是别人给的：他不再需要苏家承认。' },
        },
        required: ['id', 'name', 'position', 'purpose'],
        additionalProperties: true,
      },
      example: [{
        id: 'inciting',
        name: '激励事件',
        position: 0.08,
        purpose: '苏家当众退婚，林越被赶出家门。',
        answer: '',
      }],
    },
    controllingIdea: {
      type: 'string',
      description: '控制性理念：这个故事的最终价值主张，必须能被结局正面回答',
      example: '尊严只能靠自己挣回来。',
    },
  },
  script: {
    episodesHookFields: {
      hookType: {
        type: 'string',
        description: '本集开场钩子的类型 id',
        enum: HOOK_TYPES.map(hook => hook.id),
        example: 'conflict-open',
      },
      reversalPoints: {
        type: 'array',
        description: `本集反转点，单位是相对本集开头的秒数，升序。相邻反转之间不得超过 ${DEFAULT_REVERSAL_EVERY_SEC} 秒。`,
        items: { type: 'number' },
        example: [25, 52, 78],
      },
    },
    sceneValueFields: {
      valuePair: {
        type: 'string',
        description: '本场的价值轴，写成「正极/负极」，只能用下列之一',
        enum: VALUE_CHARGES.map(charge => charge.name),
        example: '希望/绝望',
      },
      valueEntry: { type: 'string', description: '本场开场时主角处在这一价值轴的哪一极', example: '希望' },
      valueExit: { type: 'string', description: '本场结束时主角处在这一价值轴的哪一极，必须与 valueEntry 相反', example: '绝望' },
    },
    shotBeatFields: {
      beatId: {
        type: 'string',
        description: '本镜服务的故事节拍 id（与 beats[].id 对应）',
        enum: STORY_BEATS.map(beat => beat.id),
        example: 'inciting',
      },
      hookCue: {
        type: 'string',
        description: '仅第 1 集第 1 镜需要：一句可拍的钩子画面，必须是一个正在发生的冲突或悬念',
        example: '她把离婚协议推过桌面，同时按下了录音笔。',
      },
    },
  },
}

/**
 * Whether a fragment is a bag of NAMED properties rather than one schema node.
 *
 * WHAT MAKES THIS SUBTLE: a JSON Schema node (`{ type, description, example }`)
 * and a property bag (`{ hookType: {...}, reversalPoints: {...} }`) are both
 * plain objects, so the discriminator has to be the SCHEMA KEYWORDS rather than
 * shape alone. Choosing `properties` as the marker is deliberate: every schema
 * NODE this module authors carries `type`, while no property bag ever does. An
 * earlier version used the inverse test (a fragment is a bag unless it contains
 * one of a listed set of keywords) and therefore classified the story root's
 * `beats` node as a bag, reporting a phantom field named "type". `addedSchemaFields`
 * depends on this being right, because the same classifier decides which names
 * the integration test asserts.
 *
 * KNOWN LIMITATION, stated rather than hidden: a future node authored WITHOUT
 * `type` would be misread as a bag. Every node in `STORY_SCHEMA_ADDITIONS` has
 * one, so this is currently exact; a node that omitted it should add `type`
 * rather than rely on this helper guessing.
 *
 * @param {unknown} fragment
 * @returns {boolean}
 */
function isPropertyBag(fragment) {
  if (!isRecord(fragment)) return false
  if (Object.hasOwn(fragment, 'type')) return false
  return Object.keys(fragment).length > 0
}

/**
 * Merge schema additions into a JSON Schema string.
 *
 * WHY STRING IN / STRING OUT: `TEXT_STAGE_BRIEF[stage].schema` is a JSON STRING
 * that gets pasted verbatim into a model prompt (prompts.js §5). The overlay
 * must therefore degrade to the ORIGINAL STRING UNCHANGED whenever it cannot
 * understand the input — a malformed brief must never crash a request, and a
 * partial merge must never drop a field the normalizer needs.
 *
 * Merging is additive at three levels, addressed by path so the additions land
 * inside the right nested object:
 *   - `beats` / `controllingIdea` → the story root `properties`;
 *   - `hookType` / `reversalPoints` → `properties.episodes.items.properties`;
 *     a top-level field with that name is added too when it is absent, so the
 *     model can express the same thing for a one-episode script;
 *   - `valuePair` / `valueEntry` / `valueExit` →
 *     `properties.episodes.items.properties.scenes.items.properties`;
 *   - `beatId` / `hookCue` → `…scenes.items.properties.shots.items.properties`.
 * `required` is NEVER modified: every addition is optional by design, so a model
 * that ignores them still produces a schema-valid payload.
 *
 * @param {unknown} schemaString a JSON schema literal (string or object)
 * @param {'story'|'script'|string} stageId
 * @returns {string} the merged schema, or the input unchanged as a string
 */
export function mergeSchemaAdditions(schemaString, stageId) {
  const original = typeof schemaString === 'string' ? schemaString : JSON.stringify(schemaString ?? {})
  const addition = STORY_SCHEMA_ADDITIONS[stageId]
  if (addition === undefined) return original

  let schema
  try {
    schema = JSON.parse(original)
  } catch {
    return original
  }
  if (!isRecord(schema)) return original
  if (!isRecord(schema.properties)) schema.properties = {}

  /** Merge a property bag into a `properties` map without overwriting anything. */
  const mergeInto = (target, bag, label) => {
    if (!isRecord(target)) return
    for (const [key, value] of Object.entries(bag)) {
      if (Object.hasOwn(target, key)) continue
      target[key] = value
    }
    void label
  }

  /**
   * Walk a property path, creating intermediate nodes.
   *
   * A path is a flat sequence of `properties` hops separated by the literal
   * `'items'`: `['episodes', 'items', 'properties', 'scenes', 'items', …]`.
   *
   * WHY THIS SHAPE (and not an array of hop descriptors): an earlier version
   * passed `['properties', 'episodes', 'items', …]`, which made the FIRST hop a
   * property literally named "properties" — so every nested addition was merged
   * into a node that does not exist in the schema and was silently dropped. Only
   * the story-level `beats` / `controllingIdea` additions landed. The flat form
   * removes the opportunity for that mistake: a name is a property key, the
   * literal `'items'` descends into an array's element schema.
   */
  const at = (path) => {
    let node = schema
    for (const hop of path) {
      if (hop === 'items') {
        if (!isRecord(node.items)) node.items = { type: 'object', properties: {} }
        node = node.items
        continue
      }
      if (!isRecord(node.properties)) node.properties = {}
      if (!isRecord(node.properties[hop])) node.properties[hop] = { type: 'object', properties: {} }
      node = node.properties[hop]
    }
    return node
  }

  const episodePath = ['episodes', 'items']
  const scenePath = [...episodePath, 'scenes', 'items']
  const shotPath = [...scenePath, 'shots', 'items']

  try {
    const episodesProperties = at(episodePath).properties
    const scenesProperties = at(scenePath).properties
    const shotsProperties = at(shotPath).properties

    for (const [key, fragment] of Object.entries(addition)) {
      if (key === 'beats' || key === 'controllingIdea') {
        // Story ROOT additions: these are single schema nodes, not bags.
        if (!Object.hasOwn(schema.properties, key)) schema.properties[key] = fragment
        continue
      }
      if (key === 'episodesHookFields') { mergeInto(episodesProperties, fragment); continue }
      if (key === 'sceneValueFields') { mergeInto(scenesProperties, fragment); continue }
      if (key === 'shotBeatFields') { mergeInto(shotsProperties, fragment); continue }
      // Unknown fragment: ignore rather than guess. A wrong merge is worse than
      // a missing one, because it can corrupt a field the normalizer reads.
    }

    // The two episode-level fields are ALSO offered at the script root when it
    // has no property of that name. A one-episode script is routinely written as
    // a bare root (the normalizer tolerates a flat `episodes: []`), and without
    // this the model gets no way to express the hook type there.
    for (const [key, fragment] of Object.entries(addition.episodesHookFields ?? {})) {
      if (!Object.hasOwn(schema.properties, key)) schema.properties[key] = fragment
    }
  } catch {
    return original
  }

  return JSON.stringify(schema, null, 2)
}

/**
 * Every property name this module adds to a stage schema, by stage.
 *
 * Exported so the self-test can walk the REAL additions instead of a hand-typed
 * copy: an assertion that hardcodes its own field list would keep passing after
 * someone added a field that the normalizer silently drops.
 *
 * @returns {Record<string, string[]>}
 */
export function addedSchemaFields() {
  const out = {}
  for (const [stageId, addition] of Object.entries(STORY_SCHEMA_ADDITIONS)) {
    const names = []
    for (const [key, fragment] of Object.entries(addition)) {
      // A reusable property bag names its fields directly (every key of the bag
      // is a property); a single schema node — the story root's `beats` /
      // `controllingIdea` — names its field via ITS OWN KEY, not via a nested
      // `properties` map. Both branches are needed: reading only `properties`
      // reported the story stage as adding nothing at all.
      if (isPropertyBag(fragment)) names.push(...Object.keys(fragment))
      else names.push(key)
    }
    out[stageId] = [...new Set(names)]
  }
  return out
}

/**
 * The property names this module adds to one stage's schema.
 *
 * A flat, directly assertable list — `addedSchemaFields()` keyed by stage exists
 * for the same purpose, but consumers that need only one stage should not have
 * to remember which fragment held which field.
 *
 * @param {'story'|'script'|string} stageId
 * @returns {string[]}
 */
export function addedFieldsFor(stageId) {
  return addedSchemaFields()[text(stageId)] ?? []
}

/**
 * The instructions this module folds into a stage brief.
 *
 * SHAPE: `{ [stageId]: { systemAddendum, taskAddendum, schemaAddendum } }` where
 * `systemAddendum` / `taskAddendum` are strings (append) and `schemaAddendum` is
 * a JSON Schema STRING already merged with the stage's existing schema by
 * `buildStoryBrief`. The Lead wires this into `TEXT_STAGE_BRIEF` in prompts.js,
 * which this module does not edit.
 *
 * WHY A SEPARATE MAP: prompts.js is the single owner of every prompt string sent
 * upstream. Handing it an overlay keeps that ownership intact while still letting
 * this module own the craft rules it validates — the brief and the validator
 * cannot drift, because both are generated from `STORY_BEATS` / `HOOK_TYPES` /
 * `VALUE_CHARGES` in this file.
 *
 * @type {Record<'story'|'script', { systemAddendum: string, taskAddendum: string, schemaAddendum?: string }>}
 */
export const STORY_BRIEF_OVERLAY = {
  story: {
    systemAddendum: '你按麦基《故事》的结构写作：节拍按比例落位，每个场景必须翻转价值负荷，结局必须回答控制性理念。',
    taskAddendum: storyTaskAddendum(),
    // schemaAddendum is filled by buildStoryBrief; see the note there.
    schemaAddendum: '',
  },
  script: {
    systemAddendum: '你按麦基《故事》的场次写法写作：每一场都必须翻转价值负荷；同时守住短剧留存曲线，开场 3 秒内必须有冲突。',
    taskAddendum: scriptTaskAddendum(),
    schemaAddendum: '',
  },
}

/**
 * The actionable story-stage instructions, generated from the canonical tables.
 *
 * WHY GENERATED: a hand-written paragraph listing beat positions goes stale the
 * moment `STORY_BEATS` changes, and a brief that disagrees with the validator is
 * worse than no brief — the model gets graded on rules it was never told.
 *
 * @returns {string}
 */
export function storyTaskAddendum() {
  const beatLines = STORY_BEATS.map(beat =>
    `  - ${beat.id}｜${beat.name}：position 必须落在 ${windowLabel(beat)}（占全长比例）。${beat.purpose}`)
  return [
    '结构硬性要求（按麦基《故事》的层级，配合短剧留存数据）：',
    '6. beats 必须给全下列 6 拍，position 是占全片时长的比例（0..1），超出区间会被校验器判为不合格：',
    ...beatLines,
    `7. 激励事件的 position 必须 ≤ ${STORY_BEATS[0].positionMax}：研究数据显示超 85% 的观众在前 3 秒划走，故事必须几乎立刻进入运动状态。`,
    `8. 顶层必须给 theme（控制性理念），并且结局那一拍的 answer 要正面回答它：写"因为主角最后的选择，世界变成了什么样"。没有 answer 的结局会被判为不合格。`,
    '9. acts 的每一幕都要写 turningPoint：一幕以状态变化收束，不写"发生了什么"，写"什么被改变了"。',
    '10. 每一集的 summary 必须写清本集末尾的状态变化，不允许纯铺垫集。',
    '输出严格符合下方 JSON 契约，字段不可增删改名；beats 是必填数组。',
  ].join('\n')
}

/**
 * The actionable script-stage instructions, generated from the canonical tables.
 *
 * @returns {string}
 */
export function scriptTaskAddendum() {
  const sceneLines = VALUE_CHARGES.map(charge => `${charge.id}（${charge.name}）`)
  const hookLines = HOOK_TYPES.map(hook => `${hook.id}（${hook.name}）`)
  return [
    '场次与节奏硬性要求：',
    '6. 每一场必须声明价值负荷：valuePair 写清本场讨论的是哪一条价值轴，valueEntry / valueExit 写清开场与收场各自在哪一极，两者必须相反。',
    `   可选价值轴（valuePair 只能用这些）：${sceneLines.join('、')}。`,
    '   同极收场的场景按麦基的标准没有存在理由：应当合并进相邻场景，或重写成真的发生了翻转。',
    `7. 每一集必须声明 hookType（开场钩子类型）：${hookLines.join('、')}。`,
    `8. 每一集必须声明 reversalPoints：相对本集开头的秒数数组，升序，相邻两个之间不得超过 ${DEFAULT_REVERSAL_EVERY_SEC} 秒。这是研究给出的平台默认值（另一来源亦记作"30 秒内有冲突、2 分钟内出现反转"），可用 options.reversalEverySec 覆盖，但声明了就要自洽。`,
    `9. 第 1 集的第 1 镜必须是正在发生的冲突或悬念，禁止环境描写/空镜/城市全景开场，并且冲突必须"前置"：不得先写一段中性的日常再让冲突在第 ${DEFAULT_CONFLICT_BY_SEC} 秒之后才出现。研究数据里超 85% 的划走发生在前 3 秒，环境开场与延迟冲突是留存的两大杀手。第 1 镜请同时填 hookCue（一句可拍的钩子画面）。`,
    '10. 每个镜头填 beatId，指明这一镜服务的是哪一个故事节拍（与 story 阶段的 beats[].id 对应），让每一镜都有存在理由。',
    '11. episodes 的每一集都必须保留 scenes 数组：没有 scenes 的集不会被识别为脚本，会被整集丢弃。',
    '输出严格符合下方 JSON 契约，字段不可增删改名。',
  ].join('\n')
}

/**
 * The stage ids `buildStoryBrief` serves.
 *
 * @type {string[]}
 */
export const STORY_STAGES = ['story', 'script']

/**
 * Build an ENRICHED brief for the `story` or `script` stage.
 *
 * @param {string} stageId
 * @param {{
 *   base?: { system?: string, task?: string, schema?: string },
 *   includeSchema?: boolean,
 *   logline?: string, genre?: string, episodes?: number,
 *   shotSeconds?: number, totalSeconds?: number, reversalEverySec?: number,
 * }} [options]
 *   `base` is the existing `TEXT_STAGE_BRIEF[stageId]`. When it is omitted the
 *   brief is built from the addenda alone, which is what the self-test uses.
 * @returns {{ system: string, task: string, schema: string, schemaAddendum: string, stage: string, structure?: object }}
 */
export function buildStoryBrief(stageId, options = {}) {
  const opts = isRecord(options) ? options : {}
  const id = STORY_STAGES.includes(text(stageId)) ? text(stageId) : 'story'
  const overlay = STORY_BRIEF_OVERLAY[id]

  const base = isRecord(opts.base) ? opts.base : {}
  const baseSystem = text(base.system)
  const baseTask = text(base.task)
  const baseSchema = text(base.schema)

  // The skeleton is computed only when the caller gave enough to size it, so a
  // bare `buildStoryBrief('story')` stays cheap and never invents a runtime.
  const structure = id === 'story'
    ? proposeStructure({
      logline: opts.logline,
      genre: opts.genre,
      episodes: opts.episodes,
      shotSeconds: opts.shotSeconds,
      totalSeconds: opts.totalSeconds,
      reversalEverySec: opts.reversalEverySec,
    })
    : undefined

  const parts = [baseTask, overlay.taskAddendum]
  if (structure !== undefined && opts.includeStructure !== false) {
    parts.push([
      '【结构骨架：以下秒数已按用户设定的集数与时长算好，请按此落位，不要自行改比例】',
      ...structure.beats.map(beat => `  - ${beat.name}(${beat.id}) 约第 ${beat.atSecond} 秒（position ${beat.position}）`),
      `  建议总场次：${structure.sceneCount}（每集 ${structure.scenesPerEpisode} 场）。`,
      ...structure.notes.map(note => `  注：${note}`),
    ].join('\n'))
  }

  const schemaAddendum = baseSchema === '' ? '' : mergeSchemaAdditions(baseSchema, id)

  return {
    stage: id,
    system: baseSystem === '' ? overlay.systemAddendum : `${baseSystem}\n${overlay.systemAddendum}`,
    task: parts.filter(part => part !== '').join('\n'),
    schema: schemaAddendum,
    schemaAddendum,
    structure,
  }
}

/* ================================================================== *
 * 7. one-call convenience audit
 * ================================================================== */

/**
 * Run every audit and return one combined report.
 *
 * WHY THIS EXISTS: the three audits answer different questions (structure,
 * hook, rhythm) and a caller that must remember to run all three will forget
 * one. `score` is the structural score only — it is NOT a quality score, and no
 * amount of passing assertions here means the story is good. See the module
 * header.
 *
 * @param {{ story?: unknown, script?: unknown }} [input]
 * @param {{ hookSeconds?: number, shotSeconds?: number, reversalEverySec?: number,
 *   conflictBySec?: number }} [options]
 * @returns {{
 *   ok: boolean, structure: object, hooks: Array<object>, pacing: object,
 *   scenes: Array<object>, issues: Array<object>,
 * }}
 */
export function auditStory(input = {}, options = {}) {
  const source = isRecord(input) ? input : {}
  const opts = isRecord(options) ? options : {}

  const story = source.story
  const script = source.script ?? story
  const structure = validateStructure(story)

  const scriptRoot = isRecord(script) ? script : {}
  const episodes = records(scriptRoot.episodes).length > 0 ? records(scriptRoot.episodes) : []
  const hooks = episodes.map(episode => auditHook(episode, opts))

  // An episode that declares no conflict at all never reaches `auditHook`
  // (there is nothing to walk), so the absence has to be stated here or a
  // script-only payload with no episodes would report `ok: true` vacuously.
  const conflictsDeclared = episodes.length > 0 && hooks.every(hook => hook.firstConflictAt !== null)

  const pacing = auditPacing(script, opts)
  const scenes = auditScenes(script)

  const issues = [
    ...structure.issues,
    ...hooks.flatMap((hook, index) => hook.issues.map(issue => ({ ...issue, episode: index + 1 }))),
    ...pacing.issues,
  ]

  return {
    ok: structure.ok && conflictsDeclared && hooks.every(hook => hook.ok) && pacing.ok,
    structure,
    hooks,
    pacing,
    scenes,
    issues,
  }
}
