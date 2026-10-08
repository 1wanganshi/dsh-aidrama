#!/usr/bin/env node
/**
 * dsh-aidrama — consistency + camera engine acceptance test.
 *
 * Zero dependencies, no network, no I/O beyond importing the two modules. Runs
 * the real engine against realistic sample data and asserts the acceptance list
 * from task-7, lettered (a)–(i) so a reader can check the list off against the
 * output. (Several further checks are marked with their own names where the
 * acceptance list did not name them.)
 *
 * WHY THE POSITIVE CONTROLS MATTER: assertions (e) and (h) each assert BOTH that
 * a bad input is flagged AND that a good input is NOT. A check that only proves
 * "something was flagged" passes vacuously when the detector is broken and
 * flags everything — the pair is what makes the evidence real.
 *
 * DETERMINISM: this suite reads no clock, uses no randomness, starts no timers
 * and opens no sockets. Every assertion is a pure function of the two imported
 * modules, so running it N times must produce byte-identical output. Assertion
 * (a) additionally re-derives locks in a shuffled key order and in a fresh
 * process-shaped call sequence to prove `lockCharacter` is order-independent.
 *
 *   node docs/verify-consistency.mjs
 *
 * Prints PASS/FAIL per assertion and exits non-zero if any assertion fails.
 */

import assert from 'node:assert/strict'

import {
  CONSISTENCY_LOCK,
  CONSISTENCY_LOCK_META,
  CROWD_LIMIT,
  SCENE_NO_PEOPLE_CLAUSE,
  CAMERA_MOVES,
  CAMERA_TOKENS,
  SHOT_SIZES,
  CAMERA_ANGLES,
  EDIT_RHYTHM,
  SUBJECTIVE_CAMERA_WORDS,
  REUSED_NEGATIVES,
  describeLockLevel,
  fingerprintOf,
  lockCharacter,
  lockScene,
  buildReferencePlan,
  planIsOrdered,
  auditCrowd,
  auditCamera,
  buildCameraPlan,
  frameContinuity,
  buildConsistencyDirectives,
  findCameraMove,
  detectCameraTokens,
  findShotSize,
  findRhythm,
  suggestRhythm,
  withCameraTail,
  uncertainties,
} from '../lib/host/consistency.js'

import {
  QUALITY_BOOSTERS,
  CHARACTER_SHEET_NEGATIVE,
  GENERIC_NEGATIVE,
} from '../lib/host/prompts.js'

import { ASSET_KIND } from '../lib/host/protocol.js'

/* ------------------------------------------------------------------ *
 * tiny test harness
 * ------------------------------------------------------------------ */

let passed = 0
let failed = 0
const failures = []

/**
 * Run one labelled assertion.
 * @param {string} name
 * @param {() => void} fn
 */
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${String(error && error.message ? error.message : error).split('\n').join('\n      ')}`)
  }
}

/* ------------------------------------------------------------------ *
 * fixtures — realistic bible cards, in the shape normalizeCharacters /
 * normalizeScenes in stages.js produce
 * ------------------------------------------------------------------ */

/** 主角。与林晚只差一项：face 里的瞳色。 */
const LINYUE = {
  id: 'lin-yue',
  name: '林越',
  role: '主角',
  age: '28 岁',
  gender: '男',
  appearance: '28 岁男性，利落短发，黑色高领衫外罩深灰风衣',
  hair: '两侧推短的黑色短发，发尾微翘',
  face: '窄长脸，眉骨高，单眼皮，深黑色瞳，左眉尾有一道浅疤',
  body: '身高 183cm，八头身，肩宽腰窄，体脂偏低',
  outfit: '黑色高领羊毛衫，深灰色中长风衣，黑色直筒西裤',
  accessory: '左手腕银色机械表，表盘无数字',
  personality: '沉默克制，说话短句',
}

/** 与 LINYUE 逐字段相同，只有瞳色不同（琥珀色 vs 深黑色）。 */
const LINYUE_AMBER = { ...LINYUE, id: 'lin-yue-amber', face: '窄长脸，眉骨高，单眼皮，琥珀色瞳，左眉尾有一道浅疤' }

/** 反派。 */
const SUJIANGUO = {
  id: 'su-jianguo',
  name: '苏建国',
  role: '对手',
  age: '56 岁',
  gender: '男',
  appearance: '56 岁男性，花白背头，深色三件套西装',
  hair: '向后梳的花白背头，发际线偏高',
  face: '方正脸，法令纹深，双眼皮，眼神锐利',
  body: '身高 172cm，略显发福，肩背厚实',
  outfit: '深藏青三件套西装，白色口袋巾，黑色皮鞋',
  accessory: '右手无名指一枚宽金戒指',
  personality: '强势、习惯用身份压人',
}

const SU_DINING = {
  id: 'su-dining',
  name: '苏家餐厅',
  kind: 'interior',
  description: '挑高六米的现代中式餐厅，胡桃木长桌，落地窗外是整个城市的夜景',
  lighting: '顶部暖色筒灯为主光，色温 3000K，窗外冷蓝夜景作轮廓补光',
  composition: '从餐桌一端向内拍，前景是转盘与碗筷，纵深落到落地窗',
  timeOfDay: '夜',
  interior: true,
}

/* ------------------------------------------------------------------ *
 * table sanity — run first, so a malformed table fails loudly and early
 * rather than producing confusing downstream symptoms
 * ------------------------------------------------------------------ */

console.log('— table sanity —')

ok('T1 CAMERA_MOVES entries are well-formed and cover the required backbone', () => {
  // task-7 names 推/拉/摇/移/跟/环绕/升降/变焦/固定 as the required nine, and
  // research §八 adds 俯仰 plus a note that 手持/甩镜 may be justified.
  const requiredZh = ['推', '拉', '摇', '俯仰', '移', '跟', '升降', '变焦', '固定', '环绕']
  const haveZh = new Set(CAMERA_MOVES.map(move => move.zh))
  for (const zh of requiredZh) {
    assert.ok(haveZh.has(zh), `CAMERA_MOVES 缺少必选运镜「${zh}」`)
  }
  assert.ok(CAMERA_MOVES.length >= 11, `运镜数量应 >= 11，实际 ${CAMERA_MOVES.length}`)

  const ids = new Set()
  const tokens = new Set()
  for (const move of CAMERA_MOVES) {
    assert.equal(typeof move.id, 'string', 'id 必须是字符串')
    assert.ok(move.id !== '', 'id 不能为空')
    assert.ok(!ids.has(move.id), `id 重复：${move.id}`)
    ids.add(move.id)

    // token 必须是方括号形式 —— 这是「可解析」的定义（research §二）。
    assert.ok(/^\[.+\]$/.test(move.token), `${move.id} 的 token 不是方括号形式：${move.token}`)
    assert.ok(!tokens.has(move.token), `token 重复：${move.token}`)
    tokens.add(move.token)

    // 每个条目都必须有 why/effect 注释字段，否则这个选择无法被辩护。
    for (const field of ['name', 'zh', 'en', 'effect', 'whenToUse', 'risk']) {
      assert.ok(typeof move[field] === 'string' && move[field].trim() !== '',
        `${move.id} 缺少字段 ${field}`)
    }
    assert.ok(move.effect.length >= 20, `${move.id} 的 effect 太短，不足以说明对观众做了什么`)
    assert.ok(move.whenToUse.length >= 10, `${move.id} 的 whenToUse 太短`)
    assert.ok(move.risk.length >= 10, `${move.id} 的 risk 太短`)

    assert.ok(Array.isArray(move.speedRange) && move.speedRange.length === 2,
      `${move.id} 的 speedRange 必须是 [min,max]`)
    const [min, max] = move.speedRange
    assert.ok(Number.isFinite(min) && Number.isFinite(max) && min >= 1 && max > min,
      `${move.id} 的 speedRange 不合法：${JSON.stringify(move.speedRange)}`)
  }

  // 用户明确要求：环绕必须有风险说明，希区柯克变焦必须带 LOW 置信度警告。
  const orbit = CAMERA_MOVES.find(move => move.id === 'orbit')
  assert.ok(/少用环绕|面部漂移/.test(orbit.risk), '环绕的 risk 必须写明「人物出镜少用环绕／面部漂移」')
  const dollyZoom = CAMERA_MOVES.find(move => move.id === 'dolly-zoom')
  assert.ok(/LOW/i.test(dollyZoom.risk), '希区柯克变焦的 risk 必须标出 LOW 置信度')
})

ok('T2 SHOT_SIZES / CAMERA_ANGLES / EDIT_RHYTHM entries are well-formed', () => {
  const requiredSizes = ['大远景', '远景', '全景', '中景', '近景', '特写', '大特写']
  const haveSizes = SHOT_SIZES.map(size => size.name)
  for (const name of requiredSizes) {
    assert.ok(haveSizes.includes(name), `SHOT_SIZES 缺少「${name}」`)
  }
  // 表按由宽到紧排列，frameContinuity 的阶梯距离依赖这个顺序。
  assert.deepEqual(haveSizes, requiredSizes, 'SHOT_SIZES 必须按由宽到紧排列')

  for (const size of SHOT_SIZES) {
    for (const field of ['id', 'name', 'abbr', 'zh', 'purpose']) {
      assert.ok(typeof size[field] === 'string' && size[field].trim() !== '', `${size.name} 缺少 ${field}`)
    }
    assert.ok(size.purpose.length >= 15, `${size.name} 的 purpose 太短，不足以说明观众看到什么`)
    assert.ok(Array.isArray(size.durationRange) && size.durationRange.length === 2,
      `${size.name} 的 durationRange 必须是 [min,max]`)
    const [min, max] = size.durationRange
    assert.ok(Number.isFinite(min) && Number.isFinite(max) && min >= 1 && max >= min,
      `${size.name} 的 durationRange 不合法`)
  }

  const requiredAngles = ['平视', '俯视', '仰视', '过肩', '主观', '鸟瞰']
  for (const name of requiredAngles) {
    const angle = CAMERA_ANGLES.find(item => item.name === name)
    assert.ok(angle, `CAMERA_ANGLES 缺少「${name}」`)
    assert.ok(angle.meaning.length >= 15, `${name} 的 meaning 太短，必须写清戏剧含义`)
    assert.ok(angle.whenToUse.length >= 8, `${name} 的 whenToUse 太短`)
  }

  for (const key of ['tense', 'normal', 'relaxed']) {
    const preset = EDIT_RHYTHM[key]
    assert.ok(preset, `EDIT_RHYTHM 缺少 ${key}`)
    assert.equal(preset.id, key)
    assert.ok(typeof preset.label === 'string' && preset.label !== '', `${key} 缺少 label`)
    assert.ok(Array.isArray(preset.shotSecondsRange) && preset.shotSecondsRange.length === 2,
      `${key} 缺少 shotSecondsRange`)
    assert.ok(Array.isArray(preset.shotsPerMinute) && preset.shotsPerMinute.length === 2,
      `${key} 缺少 shotsPerMinute`)
    assert.ok(preset.note.length >= 10, `${key} 的 note 太短`)
    assert.ok(Array.isArray(preset.preference.moveIds) && preset.preference.moveIds.length > 0,
      `${key} 缺少 preference.moveIds`)
  }
  // 紧张档必须比舒缓档切得更快，否则这套节奏表没有意义。
  assert.ok(EDIT_RHYTHM.tense.shotsPerMinute[0] > EDIT_RHYTHM.relaxed.shotsPerMinute[1],
    '紧张档的每分钟镜头数必须高于舒缓档')
})

ok('T3 CONSISTENCY_LOCK levels are ordered and described in zh-CN', () => {
  assert.equal(CONSISTENCY_LOCK.promptOnly, 0)
  assert.equal(CONSISTENCY_LOCK.lockedPrompt, 1)
  assert.equal(CONSISTENCY_LOCK.referenceImage, 2)
  assert.equal(CONSISTENCY_LOCK.trainedModel, 3)
  for (const [key, value] of Object.entries(CONSISTENCY_LOCK)) {
    const meta = CONSISTENCY_LOCK_META[value]
    assert.ok(meta, `等级 ${value} 缺少中文说明`)
    assert.ok(typeof meta.label === 'string' && meta.label !== '', `等级 ${value} 缺少 label`)
    assert.ok(typeof meta.description === 'string' && meta.description.length >= 15,
      `等级 ${value} 的 description 太短`)
    assert.ok(describeLockLevel(value).includes(meta.label), `describeLockLevel(${value}) 未包含 label`)
    assert.ok(key.length > 0)
  }
  assert.ok(describeLockLevel(99).includes('未知'), '未知等级必须给出「未知」而不是抛错')
  assert.equal(CROWD_LIMIT, 5, '同框上限应为 5（research §一 检索口径）')

  // 每一处「未实测」都必须在 uncertainties() 里有对应条目，否则等于把猜测洗成事实。
  const areas = uncertainties().map(item => item.area)
  for (const area of ['consistency', 'camera', 'continuity']) {
    assert.ok(areas.includes(area), `uncertainties() 缺少 ${area} 分组`)
  }
  assert.ok(uncertainties().length >= 8, 'uncertainties() 条目过少，不像诚实清单')
  assert.ok(uncertainties().every(item => item.note.length >= 20), 'uncertainties() 的 note 太短')
})

/* ------------------------------------------------------------------ *
 * (a) lockCharacter determinism + sensitivity
 * ------------------------------------------------------------------ */

console.log('\n— (a) lockCharacter —')

ok('(a) lockCharacter 对同一输入逐字节确定（含打乱键序）', () => {
  const first = lockCharacter(LINYUE)
  const second = lockCharacter(LINYUE)
  const third = lockCharacter({ ...LINYUE })

  assert.equal(first.canonical, second.canonical, '同一输入两次调用必须逐字节相同')
  assert.equal(first.fingerprint, second.fingerprint, '指纹必须相同')
  assert.equal(first.canonical, third.canonical, '展开复制（键顺序不同）必须得到同一字符串')

  // 键顺序彻底打乱：canonical 必须仍然一样。这是「顺序固定」的直接证明。
  const shuffled = {}
  for (const key of Object.keys(LINYUE).reverse()) shuffled[key] = LINYUE[key]
  shuffled.outfit = LINYUE.outfit
  shuffled.hair = LINYUE.hair
  assert.equal(lockCharacter(shuffled).canonical, first.canonical,
    '输入对象的键顺序不得影响 canonical')

  // 可重复构造：连续 20 次结果全等（防止任何隐藏的计数器/缓存污染）。
  for (let i = 0; i < 20; i += 1) {
    assert.equal(lockCharacter(LINYUE).canonical, first.canonical, `第 ${i} 次调用漂移了`)
  }

  // 指纹形态：8 位小写十六进制，稳定。
  assert.match(first.fingerprint, /^[0-9a-f]{8}$/)
  assert.equal(first.fingerprint, fingerprintOf(first.canonical))
  // 指纹必须真的能区分：两个不同 canonical 不允许撞同一个指纹。
  assert.notEqual(fingerprintOf('甲'), fingerprintOf('乙'))
})

ok('(a) lockCharacter 对只看瞳色不同的两个角色给出不同锁定', () => {
  const a = lockCharacter(LINYUE)
  const b = lockCharacter(LINYUE_AMBER)

  assert.notEqual(a.canonical, b.canonical, '瞳色不同必须导致 canonical 不同')
  assert.notEqual(a.fingerprint, b.fingerprint, '瞳色不同必须导致指纹不同')
  assert.ok(a.canonical.includes('深黑色瞳'), 'canonical 必须保留原始瞳色用词')
  assert.ok(b.canonical.includes('琥珀色瞳'), 'canonical 必须保留原始瞳色用词')
  // 反过来：同一角色即使换了 id 也不该改变外观锁（id 只是索引，不是外观）。
  assert.equal(lockCharacter({ ...LINYUE, id: 'renamed' }).canonical, a.canonical,
    'id 变化不应改变外观 canonical（否则改名就等于换人）')
})

ok('(a) lockCharacter 的 canonical 保留数字精度、去重、并拒绝空串', () => {
  const lock = lockCharacter(LINYUE)
  // 数字原样保留：183cm 不能被四舍五入或改写。
  assert.ok(lock.canonical.includes('183cm'), `canonical 丢失了精确身高：${lock.canonical}`)

  // 重复子句去重：appearance 与 outfit 写同一句话时只出现一次。
  const dup = lockCharacter({ name: '测试', appearance: '深灰风衣', outfit: '深灰风衣' })
  const occurrences = dup.canonical.split('深灰风衣').length - 1
  assert.equal(occurrences, 1, `重复子句未被去重（出现 ${occurrences} 次）`)

  // 空卡片：绝不产出空 canonical（空串会让下游静默丢掉锁定）。
  const empty = lockCharacter({ name: '无名' })
  assert.ok(empty.canonical.trim() !== '', '空卡片不得产出空 canonical')
  assert.ok(empty.canonical.includes('无名'), '空卡片的 canonical 仍应可辨识')
  assert.match(empty.fingerprint, /^[0-9a-f]{8}$/)

  // 不可用输入抛错（与 buildShotBreakdown 的先例一致），而空卡片不抛。
  assert.throws(() => lockCharacter(null), TypeError)
  assert.throws(() => lockCharacter('林越'), TypeError)

  // level 必须是第 1 级：从设定集导出的锁没有上游图可参考。
  assert.equal(lock.level, CONSISTENCY_LOCK.lockedPrompt)
  assert.equal(lock.ref, 'lin-yue')
  // negatives 必须是 prompts.js 的三视图负面表本体，而不是一份副本。
  assert.notEqual(lock.negatives, CHARACTER_SHEET_NEGATIVE, '内部持有的是拷贝，避免外部改动污染锁')
  assert.deepEqual(lock.negatives, CHARACTER_SHEET_NEGATIVE)
})

ok('(a) lockScene 确定、禁用人物、且保留光照动机', () => {
  const a = lockScene(SU_DINING)
  const b = lockScene(SU_DINING)
  assert.equal(a.canonical, b.canonical, 'lockScene 必须确定')
  assert.equal(a.fingerprint, b.fingerprint)
  assert.match(a.fingerprint, /^[0-9a-f]{8}$/)

  // 空场景约束：主图必须是空盘，这与 prompts.js 的 buildSceneMaster 一致。
  assert.ok(a.canonical.includes(SCENE_NO_PEOPLE_CLAUSE), '场景锁必须包含禁止人物的约束')
  assert.ok(/严禁出现任何人物/.test(a.canonical), '禁止人物的措辞必须可被断言')
  assert.ok(a.negatives.includes('人物'), '场景负面表必须包含「人物」')
  assert.ok(a.negatives.includes('人形剪影'), '场景负面表必须包含「人形剪影」')

  // 光照是首尾帧不闪烁的关键（research §三），必须进锁。
  assert.ok(a.canonical.includes('3000K'), '场景锁必须保留色温这样的精确光源信息')
  assert.equal(a.level, CONSISTENCY_LOCK.lockedPrompt)
  assert.equal(a.ref, 'su-dining')

  // interior 的三种表示都要被识别，识别不出就不写（不猜）。
  assert.ok(lockScene({ name: 'A', interior: false }).canonical.includes('室外'))
  assert.ok(lockScene({ name: 'A', interior: '室内' }).canonical.includes('室内'))
  assert.ok(!lockScene({ name: 'A', interior: '不知道' }).canonical.includes('场景类型'))

  assert.throws(() => lockScene(undefined), TypeError)
})

ok('(a+) 指纹是真正的变更检测器：改任何一个外观字段都会改变它', () => {
  const base = lockCharacter(LINYUE)
  const mutations = {
    hair: '两侧推短的棕黑色短发',
    face: '窄长脸，单眼皮',
    body: '身高 180cm，八头身',
    outfit: '黑色高领羊毛衫',
    accessory: '左手腕银色机械表',
    age: '29 岁',
  }
  for (const [field, value] of Object.entries(mutations)) {
    const changed = lockCharacter({ ...LINYUE, [field]: value })
    assert.notEqual(changed.fingerprint, base.fingerprint,
      `修改 ${field} 后指纹未变化，锁定无法检测设定变更`)
  }
})

/* ------------------------------------------------------------------ *
 * (b) reference plan levels + honest fallback
 * ------------------------------------------------------------------ */

console.log('\n— (b) buildReferencePlan —')

/** 一个已经生成过林越三视图的项目。 */
const PROJECT_WITH_SHEET = {
  id: 'p-test',
  assets: [
    { id: 'asset-lin-yue-sheet', kind: ASSET_KIND.characterSheet, characterId: 'lin-yue', url: '/api/dsh-aidrama/asset?id=asset-lin-yue-sheet' },
  ],
  content: {
    bible: { characters: [LINYUE, SUJIANGUO], scenes: [SU_DINING] },
    visual: { characterSheets: [], sceneMasters: [], shotRefs: [] },
  },
}

/** 什么都没生成过的项目。 */
const PROJECT_EMPTY = {
  id: 'p-empty',
  assets: [],
  content: { bible: { characters: [LINYUE, SUJIANGUO], scenes: [SU_DINING] } },
}

ok('(b) 有已生成三视图的分镜拿到第 2 级 + usesReferenceImage', () => {
  const plan = buildReferencePlan(PROJECT_WITH_SHEET, [
    { ref: 'shot-1-1-1', kind: ASSET_KIND.shotRef, name: '第 1 镜', characterIds: ['lin-yue'], sceneId: 'su-dining' },
  ])

  const shot = plan.find(row => row.ref === 'shot-1-1-1')
  assert.ok(shot, '计划中找不到该分镜')
  assert.equal(shot.level, CONSISTENCY_LOCK.referenceImage, '有参考图时必须升到第 2 级')
  assert.equal(shot.usesReferenceImage, true)
  assert.equal(shot.referenceRef, 'asset-lin-yue-sheet', '必须引用到真实存在的资产 id')
  assert.ok(shot.referenceUrl.includes('asset-lin-yue-sheet'), '应带出可用的参考图地址')
  assert.ok(shot.rationale.includes('第 2 级'), '第 2 级的理由必须写明等级')
})

ok('(b) 没有三视图的分镜退回第 1 级，且 rationale 诚实说明原因', () => {
  const plan = buildReferencePlan(PROJECT_EMPTY, [
    { ref: 'shot-1-1-1', kind: ASSET_KIND.shotRef, name: '第 1 镜', characterIds: ['lin-yue'], sceneId: 'su-dining' },
  ])

  const shot = plan.find(row => row.ref === 'shot-1-1-1')
  assert.equal(shot.level, CONSISTENCY_LOCK.lockedPrompt, '没有参考图时必须退回第 1 级')
  assert.equal(shot.usesReferenceImage, false, '绝不能假装用了参考图')
  assert.equal(shot.referenceRef, '', '没有参考图时不得编造 referenceRef')
  assert.equal(shot.referenceUrl, undefined, '没有参考图时不得编造 URL')
  // 诚实性：必须点名是谁还没有三视图，而不是笼统地说「无参考图」。
  assert.ok(shot.rationale.includes('林越'), `rationale 必须点名缺图角色：${shot.rationale}`)
  assert.ok(/退回第 1 级/.test(shot.rationale), 'rationale 必须明说退回第 1 级')
  assert.ok(/未使用任何参考图/.test(shot.rationale), 'rationale 必须明说未使用参考图')
})

ok('(b+) 角色三视图与场景主图本身是第 1 级（没有上游图可参考）', () => {
  const plan = buildReferencePlan(PROJECT_WITH_SHEET, [
    { ref: 'lin-yue', kind: ASSET_KIND.characterSheet, name: '林越' },
    { ref: 'su-dining', kind: ASSET_KIND.sceneMaster, name: '苏家餐厅' },
  ])

  for (const row of plan) {
    assert.equal(row.level, CONSISTENCY_LOCK.lockedPrompt, `${row.ref} 不应自称第 2 级`)
    assert.equal(row.usesReferenceImage, false)
    assert.ok(row.rationale.includes('第 1 级'))
  }
  // 三视图的 rationale 应带上指纹，方便人工核对锁的是哪一版外观。
  const sheet = plan.find(row => row.ref === 'lin-yue')
  const lock = lockCharacter(LINYUE)
  assert.ok(sheet.rationale.includes(lock.fingerprint), '三视图 rationale 必须带指纹')
})

ok('(b+) 场景主图可用时，没有三视图的分镜也能靠环境锚定升到第 2 级', () => {
  const project = {
    id: 'p-scene-only',
    assets: [{ id: 'asset-su-dining', kind: ASSET_KIND.sceneMaster, sceneId: 'su-dining', url: '/asset/su-dining' }],
    content: { bible: { characters: [LINYUE], scenes: [SU_DINING] } },
  }
  const plan = buildReferencePlan(project, [
    { ref: 'shot-9', kind: ASSET_KIND.shotRef, characterIds: ['lin-yue'], sceneId: 'su-dining' },
  ])
  const shot = plan[0]
  assert.equal(shot.level, CONSISTENCY_LOCK.referenceImage)
  assert.equal(shot.usesReferenceImage, true)
  assert.equal(shot.referenceRef, 'asset-su-dining')
  // 仍然要诚实：角色三视图没有，所以外观靠锁定描述。
  assert.ok(shot.rationale.includes('环境锚定'), '必须说明靠的是场景锚定')
  assert.ok(shot.rationale.includes('林越'), '必须点名角色仍缺三视图')
})

ok('(b+) 声称有资产但资产不可解析时，退回第 1 级而不是编造引用', () => {
  // sheetAssetId 指向一个项目里并不存在的资产：这是最容易偷偷假装的情况。
  const project = {
    id: 'p-dangling',
    assets: [],
    content: { bible: { characters: [{ ...LINYUE, sheetAssetId: 'asset-does-not-exist' }], scenes: [] } },
  }
  const plan = buildReferencePlan(project, [
    { ref: 'shot-1', kind: ASSET_KIND.shotRef, characterIds: ['lin-yue'] },
  ])
  assert.equal(plan[0].level, CONSISTENCY_LOCK.lockedPrompt, '悬空资产不得被当成可用参考图')
  assert.equal(plan[0].usesReferenceImage, false)
  assert.equal(plan[0].referenceRef, '')
})

/* ------------------------------------------------------------------ *
 * (c) plan ordering
 * ------------------------------------------------------------------ */

console.log('\n— (c) planIsOrdered —')

/** 真实的乱序输入：镜头写在前面，三视图/场景主图写在后面。 */
const DISORDERED_TARGETS = [
  { ref: 'shot-1-1-2', kind: ASSET_KIND.shotRef, characterIds: ['lin-yue'], sceneId: 'su-dining' },
  { ref: 'su-dining', kind: ASSET_KIND.sceneMaster, name: '苏家餐厅' },
  { ref: 'shot-1-1-1', kind: ASSET_KIND.shotRef, characterIds: ['lin-yue'], sceneId: 'su-dining' },
  { ref: 'lin-yue', kind: ASSET_KIND.characterSheet, name: '林越' },
]

ok('(c) 真实计划（输入乱序）被排成安全顺序：planIsOrdered 为 true', () => {
  const plan = buildReferencePlan(PROJECT_WITH_SHEET, DISORDERED_TARGETS)
  assert.equal(planIsOrdered(plan), true, 'buildReferencePlan 的输出必须自洽有序')

  // 并且排序真的发生了：三视图在最前，场景主图第二，依赖它们的镜头在后。
  const kinds = plan.map(row => row.kind)
  const lastSheet = kinds.lastIndexOf(ASSET_KIND.characterSheet)
  const lastMaster = kinds.lastIndexOf(ASSET_KIND.sceneMaster)
  const firstShot = kinds.indexOf(ASSET_KIND.shotRef)
  assert.ok(lastSheet < firstShot, '角色三视图必须排在所有分镜之前')
  assert.ok(lastMaster < firstShot, '场景主图必须排在所有分镜之前')

  // 稳定排序：同一输入两次结果顺序完全一致。
  const again = buildReferencePlan(PROJECT_WITH_SHEET, DISORDERED_TARGETS)
  assert.deepEqual(again.map(row => row.ref), plan.map(row => row.ref), '计划顺序必须稳定')
})

ok('(c) 故意打乱依赖关系的计划被判为 false', () => {
  const plan = buildReferencePlan(PROJECT_WITH_SHEET, DISORDERED_TARGETS)
  assert.equal(planIsOrdered(plan), true, '前置条件：原计划是有效的')

  // 把三视图挪到最后：依赖它的镜头就排在了它的前面。
  const sheetIndex = plan.findIndex(row => row.kind === ASSET_KIND.characterSheet)
  const broken = [...plan]
  const [sheet] = broken.splice(sheetIndex, 1)
  broken.push(sheet)
  assert.equal(planIsOrdered(broken), false, '依赖项排在后面时必须为 false')

  // 另一种破坏方式：让某个分镜引用一个**在同一计划里稍后才会出现**的主体。
  // 注意不能用「引用一个陌生的资产 id」来构造反例 —— referenceRef 是资产 id
  // （asset-…），而计划行的 ref 是主体 ref（lin-yue），两者本就不同命名空间，
  // 陌生资产 id 是合法的。真正可检验的不变量是「角色链必须在分镜之前」。
  const lastShot = plan.map((row, i) => ({ row, i })).filter(item => item.row.kind === ASSET_KIND.shotRef).pop()
  const dangling = plan.map((row, i) => (i === lastShot.i
    ? { ...row, characterRefs: [...row.characterRefs, 'su-jianguo'] }
    : row))
  // 把苏建国的三视图补到计划末尾：于是这条分镜引用了排在它后面的主体。
  dangling.push({ ref: 'su-jianguo', kind: ASSET_KIND.characterSheet, level: 1, usesReferenceImage: false, referenceRef: '', characterRefs: ['su-jianguo'], sceneRef: '' })
  assert.equal(planIsOrdered(dangling), false, '引用了排在后面的角色三视图时必须为 false')

  // 同一个计划，把苏建国的三视图挪到分镜**之前**，就应当重新变成合法。
  const reordered = [dangling[dangling.length - 1], ...dangling.slice(0, -1)]
  assert.equal(planIsOrdered(reordered), true, '把依赖挪到前面后必须恢复为 true')

  // 非数组输入必须是 false，而不是抛错。
  assert.equal(planIsOrdered(null), false)
  assert.equal(planIsOrdered(undefined), false)
  assert.equal(planIsOrdered([null]), false)
  assert.equal(planIsOrdered([]), true, '空计划是平凡有序的')
})

/* ------------------------------------------------------------------ *
 * (d) crowd audit
 * ------------------------------------------------------------------ */

console.log('\n— (d) auditCrowd —')

ok('(d) auditCrowd 在 6 人时告警、在 4 人时完全安静', () => {
  const six = ['林越', '苏建国', '苏母', '苏念', '管家', '司机']
  const four = ['林越', '苏建国', '苏母', '苏念']

  const warned = auditCrowd({ ref: 'shot-1-1-3', characters: six })
  assert.equal(warned.length, 1, '6 人必须产生恰好一条告警')
  assert.equal(warned[0].code, 'crowd-limit-exceeded')
  assert.equal(warned[0].severity, 'warning')
  assert.equal(warned[0].shotRef, 'shot-1-1-3')
  assert.ok(warned[0].message.includes('6'), '告警必须写明实际人数')
  assert.ok(warned[0].message.includes(String(CROWD_LIMIT)), '告警必须写明上限')
  // 必须给出可执行的修法，而不是只说「人太多了」。
  assert.ok(/拆/.test(warned[0].fix), 'fix 必须给出拆镜建议')
  assert.ok(/挤出画面|画外音|虚焦/.test(warned[0].fix), 'fix 必须给出把人挤出画面的建议')

  // 正向对照：4 人必须完全安静，否则这条检查是空转的。
  assert.deepEqual(auditCrowd({ ref: 'shot-1-1-4', characters: four }), [],
    '4 人（低于上限）不得产生任何告警')

  // 边界：正好等于上限也不告警。
  assert.deepEqual(auditCrowd({ characters: six.slice(0, CROWD_LIMIT) }), [],
    `正好 ${CROWD_LIMIT} 人不得告警`)
  // 超过上限一人才开始告警。
  assert.equal(auditCrowd({ characters: six.slice(0, CROWD_LIMIT + 1) }).length, 1)

  // 去重后再计数：同一人被写两遍不应该触发人数告警。
  assert.deepEqual(auditCrowd({ characters: [...four, '林越', '林越'] }), [],
    '重复姓名去重后仍为 4 人，不得告警')
  // 空输入安静。
  assert.deepEqual(auditCrowd({}), [])
  assert.deepEqual(auditCrowd(), [])
})

/* ------------------------------------------------------------------ *
 * (e) subjective camera words + positive control
 * ------------------------------------------------------------------ */

console.log('\n— (e) auditCamera: 主观词 vs 可解析运镜 —')

ok('(e) auditCamera 标出主观词并给出正确的建议 token', () => {
  const shots = [
    { id: 'shot-1', action: '林越走进餐厅', camera: '很有冲击力的镜头' },
  ]
  const findings = auditCamera(shots)
  const hit = findings.find(item => item.code === 'subjective-camera-word')
  assert.ok(hit, `未标出主观词，实际发现：${JSON.stringify(findings)}`)
  // research §二 点名的那种失败必须是 ERROR（不是 warning）。
  assert.equal(hit.severity, 'error')
  assert.equal(hit.shotRef, 'shot-1')
  assert.ok(hit.message.includes('有冲击力'), `message 必须引用原词：${hit.message}`)
  // 建议的 token 必须是真实存在的、可解析的运镜标记。
  assert.ok(hit.fix.includes('[推镜头]'), `fix 必须建议 [推镜头]：${hit.fix}`)
  assert.ok(CAMERA_TOKENS.includes('[推镜头]'), '建议的 token 必须在 CAMERA_MOVES 里真实存在')

  // 「震撼」应建议拉镜头，而不是所有词都建议同一个 token。
  const shock = auditCamera([{ id: 'shot-2', camera: '震撼的镜头' }])
  const shockHit = shock.find(item => item.code === 'subjective-camera-word')
  assert.ok(shockHit, '「震撼」必须被标出')
  assert.ok(shockHit.fix.includes('[拉镜头]'), `「震撼」应建议 [拉镜头]：${shockHit.fix}`)

  // 常见的几个主观词都要被抓到，并且每个建议的 token 都真实存在。
  for (const word of ['丝滑', '电影感', '高级感', '炸裂']) {
    const found = auditCamera([{ id: 'x', camera: `${word}的运镜` }])
    const item = found.find(entry => entry.code === 'subjective-camera-word')
    assert.ok(item, `主观词「${word}」未被标出`)
    const suggested = CAMERA_TOKENS.filter(token => item.fix.includes(token))
    assert.ok(suggested.length > 0, `「${word}」的 fix 未给出任何真实 token：${item.fix}`)
  }
})

ok('(e) 正向对照：已经写了方括号运镜的镜头不被标记', () => {
  const good = [
    { id: 'shot-1', shotSize: '中景', cameraMove: '[推镜头]，缓慢', durationSeconds: 4 },
    { id: 'shot-2', shotSize: '近景', cameraMove: '[固定镜头]', durationSeconds: 3 },
    { id: 'shot-3', shotSize: '全景', cameraMove: '[移镜头]，匀速横移', durationSeconds: 5 },
  ]
  const findings = auditCamera(good)
  const subjective = findings.filter(item => item.code === 'subjective-camera-word')
  assert.deepEqual(subjective, [],
    `已有可解析运镜的镜头不得被判为主观词：${JSON.stringify(subjective)}`)

  // 更强的对照：光有标记也不行，得是可解析的。带运镜的文本里再出现主观词，
  // 因为已经有了技术指令，就不应再报 error（避免把补充说明当成错误）。
  const withBoth = auditCamera([{ id: 'shot-4', cameraMove: '[推镜头]，营造震撼感', durationSeconds: 4 }])
  assert.deepEqual(withBoth.filter(item => item.code === 'subjective-camera-word'), [],
    '已有技术运镜时，补充性的主观描述不应报错')
})

ok('(e+) detectCameraTokens / findCameraMove 能解析各种写法', () => {
  assert.deepEqual(detectCameraTokens('[推镜头]'), ['[推镜头]'])
  assert.ok(detectCameraTokens('低机位缓慢推近').includes('[推镜头]'), '自然语言里的「推」应被解析出来')
  assert.ok(detectCameraTokens('环绕展示').includes('[环绕镜头]'))
  // 「大特写」类文本不应误判；纯风景描述应解析不出任何运镜。
  assert.deepEqual(detectCameraTokens('平静的湖面'), [])
  assert.deepEqual(detectCameraTokens(''), [])
  assert.deepEqual(detectCameraTokens(null), [])

  assert.equal(findCameraMove('[推镜头]').id, 'push-in')
  assert.equal(findCameraMove('push-in').id, 'push-in')
  assert.equal(findCameraMove('推').id, 'push-in')
  assert.equal(findCameraMove('缓慢拉远').id, 'pull-out')
  assert.equal(findCameraMove('不存在的运镜'), undefined)
  assert.equal(findCameraMove(''), undefined)
})

/* ------------------------------------------------------------------ *
 * (f) monotony
 * ------------------------------------------------------------------ */

console.log('\n— (f) auditCamera: 单调 —')

ok('(f) 连续 5 个相同运镜被判为单调', () => {
  const shots = Array.from({ length: 5 }, (_, i) => ({
    id: `shot-${i + 1}`,
    shotSize: '中景',
    cameraMove: '[推镜头]',
    durationSeconds: 4,
  }))
  const findings = auditCamera(shots)
  const monotony = findings.filter(item => item.code === 'camera-monotony')
  assert.ok(monotony.length >= 1, `连续 5 个相同运镜未被判为单调：${JSON.stringify(findings)}`)
  assert.equal(monotony[0].severity, 'warning')
  assert.ok(monotony[0].message.includes('推镜头'), 'message 必须点名重复的运镜')
  assert.ok(/连续 3 个镜头|连续 4 个镜头|连续 5 个镜头/.test(monotony[0].message),
    `message 必须写明连续次数：${monotony[0].message}`)
  // fix 必须给出替代方案，而不是只说「换一个」。
  assert.ok(CAMERA_TOKENS.some(token => monotony[0].fix.includes(token)), 'fix 必须给出具体替代 token')

  // 正向对照：5 个各不相同的运镜不得被判单调。
  const varied = ['[推镜头]', '[移镜头]', '[固定镜头]', '[摇镜头]', '[拉镜头]'].map((token, i) => ({
    id: `v-${i + 1}`,
    shotSize: ['全景', '中景', '近景', '特写', '全景'][i],
    cameraMove: token,
    durationSeconds: 4,
  }))
  assert.deepEqual(auditCamera(varied).filter(item => item.code === 'camera-monotony'), [],
    '五个不同运镜不得被判单调')

  // 两个连排属于有意的匹配剪辑，不该报警（阈值是 3）。
  const two = [
    { id: 'a', shotSize: '中景', cameraMove: '[推镜头]', durationSeconds: 4 },
    { id: 'b', shotSize: '近景', cameraMove: '[推镜头]', durationSeconds: 3 },
  ]
  assert.deepEqual(auditCamera(two).filter(item => item.code === 'camera-monotony'), [],
    '两个连排不应触发单调告警')
})

ok('(f+) 整场固定机位 / 单一景别 / 时长越界都能被报出来', () => {
  // 整场固定 = 检索到的「像 PPT 一样死板」失败模式。
  const staticScene = Array.from({ length: 4 }, (_, i) => ({
    id: `s-${i + 1}`, shotSize: '中景', cameraMove: '[固定镜头]', durationSeconds: 4,
  }))
  const staticFindings = auditCamera(staticScene)
  assert.ok(staticFindings.some(item => item.code === 'static-scene'), '整场固定机位必须告警')

  // 单一景别。
  const sameSize = Array.from({ length: 4 }, (_, i) => ({
    id: `z-${i + 1}`, shotSize: '中景', cameraMove: ['[推镜头]', '[移镜头]', '[摇镜头]', '[拉镜头]'][i], durationSeconds: 4,
  }))
  assert.ok(auditCamera(sameSize).some(item => item.code === 'shot-size-monotony'), '单一景别必须告警')

  // 时长越界：1 秒的全景读不完（全景/环绕的下界都高于 1 秒），
  // 25 秒的大特写撑不住（大特写 1-3 秒、推镜头 2-8 秒）。
  // 注意这里刻意不用「大特写 + 1 秒」当短的一侧：大特写的下界就是 1 秒，
  // 1 秒的大特写是合法的，用它做反例会把一个正确的判断当成 bug。
  const badDurations = auditCamera([
    { id: 'short', shotSize: '全景', cameraMove: '[环绕镜头]', durationSeconds: 1 },
    { id: 'long', shotSize: '大特写', cameraMove: '[推镜头]', durationSeconds: 25 },
  ])
  const range = badDurations.filter(item => item.code === 'duration-out-of-range')
  assert.equal(range.length, 2, `两个越界时长都必须被报出：${JSON.stringify(badDurations)}`)
  assert.ok(range.every(item => /经验值|区间/.test(item.message)), '必须说明这是经验区间而不是平台限制')
  // 两个方向都要给出不同的修法，而不是同一句套话。
  assert.ok(/延长到/.test(range[0].fix), '过短的 fix 必须建议延长')
  assert.ok(/压到/.test(range[1].fix), '过长的 fix 必须建议压缩')

  // 正向对照：合理时长不得报越界（含边界值：大特写下界 1 秒是合法的）。
  assert.deepEqual(
    auditCamera([{ id: 'fine', shotSize: '中景', cameraMove: '[推镜头]', durationSeconds: 4 }])
      .filter(item => item.code === 'duration-out-of-range'),
    [],
  )
  assert.deepEqual(
    auditCamera([{ id: 'edge', shotSize: '大特写', cameraMove: '[固定镜头]', durationSeconds: 1 }])
      .filter(item => item.code === 'duration-out-of-range'),
    [],
    '正好落在景别下界的时长不得被报为越界（这是边界，不是错误）',
  )
})

ok('(f+) 有人物近景 + 环绕 = 风险告警（research §八 负面经验）', () => {
  const risky = auditCamera([{
    id: 'orbit-1', shotSize: '近景', cameraMove: '[环绕镜头]', characters: ['林越'], durationSeconds: 4,
  }])
  const hit = risky.find(item => item.code === 'orbit-with-closeup')
  assert.ok(hit, '人物近景 + 环绕必须被标为风险')
  assert.equal(hit.severity, 'warning')
  assert.ok(/面部漂移|少用环绕/.test(hit.message), 'message 必须说明漂移风险')
  assert.ok(/不是平台限制/.test(hit.message), '必须声明这是经验建议而非平台限制')

  // 正向对照 1：环绕 + 全景（无近景）不应触发这条规则。
  assert.deepEqual(
    auditCamera([{ id: 'orbit-2', shotSize: '全景', cameraMove: '[环绕镜头]', characters: ['林越'], durationSeconds: 5 }])
      .filter(item => item.code === 'orbit-with-closeup'),
    [],
  )
  // 正向对照 2：近景 + 环绕但没有具名角色（纯环境/道具），不触发。
  assert.deepEqual(
    auditCamera([{ id: 'orbit-3', shotSize: '近景', cameraMove: '[环绕镜头]', durationSeconds: 4 }])
      .filter(item => item.code === 'orbit-with-closeup'),
    [],
  )
})

ok('(f+) 干净的镜头表不产生任何发现（防误报）', () => {
  const clean = [
    { id: 'c-1', shotSize: '全景', cameraMove: '[移镜头]', durationSeconds: 5 },
    { id: 'c-2', shotSize: '中景', cameraMove: '[跟镜头]', durationSeconds: 5 },
    { id: 'c-3', shotSize: '近景', cameraMove: '[推镜头]', durationSeconds: 3 },
    { id: 'c-4', shotSize: '特写', cameraMove: '[固定镜头]', durationSeconds: 2 },
  ]
  const findings = auditCamera(clean)
  assert.deepEqual(findings, [], `干净镜头表不应有任何发现：${JSON.stringify(findings)}`)
})

/* ------------------------------------------------------------------ *
 * (g) camera plan invariants
 * ------------------------------------------------------------------ */

console.log('\n— (g) buildCameraPlan —')

/** 一张真实的乱序镜头表，含作者已指定的运镜与越界时长。 */
const SAMPLE_SHOTS = [
  { id: 'shot-1', no: 1, shotSize: '全景', action: '林越走进餐厅', motion: '他推门而入', durationSeconds: 5 },
  { id: 'shot-2', no: 2, shotSize: '中景', cameraMove: '[固定镜头]', action: '苏建国抬头', durationSeconds: 4 },
  { id: 'shot-3', no: 3, shotSize: '近景', cameraMove: '很有冲击力', action: '两人对视', durationSeconds: 3 },
  { id: 'shot-4', no: 4, shotSize: '特写', action: '退婚书被推过桌面', durationSeconds: 2 },
  { id: 'shot-5', no: 5, shotSize: '大特写', action: '手指敲击桌面', durationSeconds: 1 },
  // 越界时长：作者写了 30 秒，必须被拉回可辩护区间而不是原样放行。
  { id: 'shot-6', no: 6, shotSize: '中景', action: '长镜头对峙', durationSeconds: 30 },
]

ok('(g) 计划里每个镜头都有 >= 1 的整数时长，且落在两张表的并集内', () => {
  for (const rhythmKey of Object.keys(EDIT_RHYTHM)) {
    const plan = buildCameraPlan(SAMPLE_SHOTS, { rhythm: rhythmKey, styleDna: '3D 国漫' })
    assert.equal(plan.shots.length, SAMPLE_SHOTS.length, '每个镜头都必须被规划')
    assert.equal(plan.rhythm, rhythmKey)

    for (const row of plan.shots) {
      // 时长必须是不小于 1 的整数。
      assert.ok(Number.isInteger(row.durationSec), `${row.ref} 的时长不是整数：${row.durationSec}`)
      assert.ok(row.durationSec >= 1, `${row.ref} 的时长小于 1 秒：${row.durationSec}`)

      // 必须落在「运镜 speedRange」与「景别 durationRange」的并集内。
      const move = CAMERA_MOVES.find(item => item.id === row.move)
      assert.ok(move, `${row.ref} 的运镜 id 不在表里：${row.move}`)
      const size = SHOT_SIZES.find(item => item.name === row.size)
      assert.ok(size, `${row.ref} 的景别不在表里：${row.size}`)
      const unionLow = Math.max(1, Math.min(move.speedRange[0], size.durationRange[0]))
      const unionHigh = Math.max(unionLow, Math.max(move.speedRange[1], size.durationRange[1]))
      assert.ok(row.durationSec >= unionLow && row.durationSec <= unionHigh,
        `${row.ref} 的时长 ${row.durationSec} 不在并集 [${unionLow}, ${unionHigh}] 内`)

      // token 必须是真实的方括号运镜，且 effect 必须被带上（可辩护性）。
      assert.ok(CAMERA_TOKENS.includes(row.moveToken), `${row.ref} 的 token 不合法：${row.moveToken}`)
      assert.equal(row.tailToken, row.moveToken)
      assert.ok(typeof row.effect === 'string' && row.effect.length >= 20, `${row.ref} 缺少 effect`)

      // 速度分级必须自洽。
      assert.ok(['slow', 'medium', 'fast'].includes(row.speed), `${row.ref} 的速度分级不合法`)
      // 机位与景别都必须来自表。
      assert.ok(SHOT_SIZES.some(item => item.name === row.size))
      assert.ok(CAMERA_ANGLES.some(item => item.name === row.angle))
    }
  }
})

ok('(g) 计划是确定的、尊重作者指定、并对单调运镜做轮转', () => {
  const a = buildCameraPlan(SAMPLE_SHOTS, { rhythm: 'normal' })
  const b = buildCameraPlan(SAMPLE_SHOTS, { rhythm: 'normal' })
  assert.deepEqual(a, b, '同一输入的相机计划必须逐字段相同')

  // 作者明确写了 [固定镜头] 的镜头必须被沿用。
  const authored = a.shots.find(row => row.ref === 'shot-2')
  assert.equal(authored.move, 'static', '作者指定的 [固定镜头] 必须被沿用')
  assert.ok(authored.note.includes('沿用作者'), 'note 必须说明这是沿用作者意图')

  // 作者只写了主观词的镜头必须被自动补上可解析运镜。
  const subjective = a.shots.find(row => row.ref === 'shot-3')
  assert.ok(CAMERA_TOKENS.includes(subjective.moveToken), '主观词镜头必须被补上真实 token')
  assert.ok(!CAMERA_MOVES.find(m => m.id === subjective.move) === false, '补出来的运镜必须存在')

  // 轮转不得连续重复同一个运镜（这是单调感的来源）。
  const autoMoves = a.shots.map(row => row.move)
  for (let i = 1; i < autoMoves.length; i += 1) {
    assert.notEqual(autoMoves[i], autoMoves[i - 1],
      `自动分配的运镜在第 ${i + 1} 镜连续重复了 ${autoMoves[i]}`)
  }

  // 空输入与垃圾输入都要给出可用的空计划，而不是抛错。
  assert.deepEqual(buildCameraPlan().shots, [])
  assert.deepEqual(buildCameraPlan(null).shots, [])
  assert.equal(buildCameraPlan([], { rhythm: '不存在' }).rhythm, 'normal', '未知节奏应退回常规')
})

/* ------------------------------------------------------------------ *
 * (h) frame continuity + positive control
 * ------------------------------------------------------------------ */

console.log('\n— (h) frameContinuity —')

ok('(h) 剧烈重构被标出，且 motionBudget 为 large', () => {
  const prev = {
    id: 'shot-1', shotSize: '大远景', angle: '鸟瞰', cameraMove: '[固定镜头]',
    characters: ['林越'], sceneId: 'su-dining', lighting: '暖色筒灯，3000K',
  }
  const next = {
    id: 'shot-2', shotSize: '大特写', angle: '仰视', cameraMove: '[推镜头]',
    characters: ['林越'], sceneId: 'su-dining', lighting: '暖色筒灯，3000K',
  }
  const result = frameContinuity(prev, next)
  assert.equal(result.ok, false, '同场景内的剧烈重构必须判为不通过')
  assert.equal(result.motionBudget, 'large', `运动预算应为 large，实际 ${result.motionBudget}`)
  const violent = result.issues.find(item => item.code === 'violent-reframe')
  assert.ok(violent, `必须报出 violent-reframe：${JSON.stringify(result.issues)}`)
  assert.equal(violent.severity, 'warning')
  assert.ok(/景别|机位|运镜/.test(violent.message), 'message 必须写明变化的具体维度')
  assert.ok(violent.fix.length >= 15, 'fix 必须给出可执行的修法')
  // 共同锚点仍要被识别出来：同一人物、同一光照、同一场景。
  assert.ok(result.sharedAnchors.some(item => item.includes('林越')), '必须识别出共同人物锚点')
  assert.ok(result.sharedAnchors.some(item => item.includes('光照')), '必须识别出共同光照锚点')
  assert.ok(result.sharedAnchors.some(item => item.includes('su-dining')), '必须识别出同一场景')
})

ok('(h) 正向对照：匹配的一对镜头通过，且运动预算为 small', () => {
  const prev = {
    id: 'shot-1', shotSize: '中景', angle: '平视', cameraMove: '[推镜头]',
    characters: ['林越'], sceneId: 'su-dining', lighting: '暖色筒灯，3000K',
  }
  const next = {
    id: 'shot-2', shotSize: '中景', angle: '平视', cameraMove: '[推镜头]',
    characters: ['林越'], sceneId: 'su-dining', lighting: '暖色筒灯，3000K',
  }
  const result = frameContinuity(prev, next)
  assert.equal(result.ok, true, `匹配的一对必须通过，实际问题：${JSON.stringify(result.issues)}`)
  assert.equal(result.motionBudget, 'small', `运动预算应为 small，实际 ${result.motionBudget}`)
  assert.deepEqual(result.issues, [], '匹配的一对不应有任何问题')
  assert.deepEqual(result.changed, [], '匹配的一对不应报告任何变化')
  assert.ok(result.sharedAnchors.length >= 3, '匹配的一对必须识别出人物/光照/场景三个锚点')

  // 相邻一档景别的变化计 1 单位，属于 small —— 这是刻意的：景别阶梯本身就是
  // 渐进设计，走一级是「同一场景内的正常推进」，不是重构。要走两档以上，
  // 或者叠加机位/运镜变化，才会累加到 medium / large。
  const medium = frameContinuity(prev, { ...next, id: 'shot-3', shotSize: '近景' })
  assert.equal(medium.motionBudget, 'small', '景别只走一级仍属于 small（正常推进）')
  assert.equal(medium.ok, true)
  assert.ok(medium.changed.some(item => item.includes('景别')), '必须报告景别发生了变化')

  // 走两档景别 = 2 单位 = medium：仍然是同场景内的合理变化，但已经被标记出来。
  const twoSteps = frameContinuity(prev, { ...next, id: 'shot-4', shotSize: '特写' })
  assert.equal(twoSteps.motionBudget, 'medium', '景别走两档应升到 medium')
  assert.equal(twoSteps.ok, true, 'medium 幅度仍然可以通过')
})

ok('(h+) 同场景丢掉光照/人物锚点必须判为不通过；跨场景不因此判死', () => {
  const base = {
    id: 'shot-1', shotSize: '中景', angle: '平视', cameraMove: '[固定镜头]',
    characters: ['林越'], sceneId: 'su-dining', lighting: '暖色筒灯，3000K',
  }

  // 光照变了：首尾帧闪烁的直接原因（research §三）。
  const lightingChanged = frameContinuity(base, { ...base, id: 'shot-2', lighting: '冷蓝夜景，5600K' })
  assert.equal(lightingChanged.ok, false, '同场景光照变化必须判为不通过')
  assert.ok(lightingChanged.issues.some(item => item.code === 'lighting-changed'))
  assert.ok(lightingChanged.changed.includes('光照'))

  // 人物全换：同场景硬切换人，也必须判为不通过。
  const cast = frameContinuity(base, { ...base, id: 'shot-3', characters: ['苏建国'] })
  assert.equal(cast.ok, false, '同场景完全换人必须判为不通过')
  assert.ok(cast.issues.some(item => item.code === 'subject-changed'))

  // 跨场景硬切 + 大幅重构：仍要报出风险，但不该判死（离开一个场景本来就该长得不一样）。
  const cross = frameContinuity(base, {
    ...base, id: 'shot-4', sceneId: 'su-study', shotSize: '大特写', angle: '鸟瞰',
  })
  assert.equal(cross.motionBudget, 'large')
  assert.ok(cross.issues.some(item => item.code === 'hard-cut-reframe'), '跨场景大幅重构必须报出')
  assert.equal(cross.ok, true, '跨场景不应仅因重构幅度大就判为不通过')

  // 垃圾输入：不得抛错，返回一个可用的判断。
  const junk = frameContinuity(null, undefined)
  assert.equal(typeof junk.ok, 'boolean')
  assert.equal(junk.motionBudget, 'small')
  assert.ok(Array.isArray(junk.issues))
})

/* ------------------------------------------------------------------ *
 * (i) COMPOSITION PROOF
 * ------------------------------------------------------------------ */

console.log('\n— (i) 组合证明（复用而非复制）—')

ok('(i) 第 2 级指令包含角色 canonical 与指纹，并复用 prompts.js 的负面表', () => {
  const lock = lockCharacter(LINYUE)
  const sceneLock = lockScene(SU_DINING)

  const directive = buildConsistencyDirectives({
    styleDna: '3D 国漫，电影级柔和轮廓光',
    level: CONSISTENCY_LOCK.referenceImage,
    characters: [LINYUE],
    scenes: [SU_DINING],
    kind: ASSET_KIND.shotRef,
    shot: { action: '林越把退婚书推过桌面', shotSize: '中景', camera: '[推镜头]' },
    scene: '苏家餐厅',
    aspectRatio: '9:16',
  })

  // —— 1. canonical 与指纹必须原样出现在指令里（逐字复用，不能改写）。
  assert.ok(directive.positive.includes(lock.canonical),
    '第 2 级指令必须逐字包含角色的 canonical 外观串')
  assert.ok(directive.positive.includes(lock.fingerprint),
    '第 2 级指令必须包含角色指纹，便于核对锁的是哪一版')
  assert.ok(directive.positive.includes(sceneLock.canonical),
    '第 2 级指令必须逐字包含场景 canonical')
  assert.ok(directive.positive.includes(`${sceneLock.fingerprint}`))

  // —— 2. 必须如实声明等级为第 2 级。
  assert.equal(directive.level, CONSISTENCY_LOCK.referenceImage)
  assert.equal(directive.usesReferenceImage, true)
  assert.ok(directive.positive.includes('第 2 级'), '必须写明一致性等级')
  assert.ok(/参考图/.test(directive.positive), '第 2 级必须说明使用了参考图')

  // —— 3. 复用而非复制：负面表必须与 prompts.js 是同一个对象。
  assert.equal(REUSED_NEGATIVES.characterSheet, CHARACTER_SHEET_NEGATIVE,
    'CHARACTER_SHEET_NEGATIVE 必须按引用复用，不得在本模块复制一份')
  assert.equal(REUSED_NEGATIVES.generic, GENERIC_NEGATIVE,
    'GENERIC_NEGATIVE 必须按引用复用，不得在本模块复制一份')

  // 负面文本必须真的由 prompts.js 的条目拼成（逐条核对包含关系）。
  for (const term of GENERIC_NEGATIVE) {
    assert.ok(directive.negative.includes(term),
      `负面串缺少 prompts.js 的条目「${term}」`)
  }
  assert.ok(directive.negative.includes(QUALITY_BOOSTERS.noText),
    '负面串必须复用 prompts.js 的无文字约束')

  // —— 4. 复用而非复制：正面里的质量子句必须来自 QUALITY_BOOSTERS。
  for (const key of ['consistentFace', 'consistentBody', 'consistentOutfit']) {
    assert.ok(directive.positive.includes(QUALITY_BOOSTERS[key]),
      `正面串缺少 QUALITY_BOOSTERS.${key}`)
  }
  assert.ok(directive.positive.includes(QUALITY_BOOSTERS.color),
    '正面串必须复用 prompts.js 的色彩纪律子句')
  assert.ok(directive.tokens.includes('quality:boosters'), 'token 记录里必须能看到复用了 quality boosters')

  // —— 5. 必须真的调用了 prompts.js 的构建器，而不是自己拼一套。
  assert.ok(directive.tokens.includes('buildShotRef'), '分镜指令必须经由 buildShotRef 生成')
  // buildShotRef 的特征措辞必须出现（证明是它生成的）。
  assert.ok(/角色设定三视图|场景主图/.test(directive.positive),
    '必须出现 buildShotRef 的锚定措辞，证明复用了 prompts.js 的构建器')

  // —— 6. 组合出的提示词必须是单行、无 undefined、无 [object Object]。
  assert.ok(!directive.positive.includes('\n'), '指令必须是单行')
  assert.ok(!directive.positive.includes('undefined'), '指令里不得出现 undefined')
  assert.ok(!directive.positive.includes('[object Object]'), '指令里不得出现 [object Object]')
  assert.ok(!/，，/.test(directive.positive), '指令里不得出现连续的全角逗号')
  assert.ok(directive.positive.trim() !== '' && directive.negative.trim() !== '')
})

ok('(i) 第 1 级指令不得声称使用了参考图（诚实性对照）', () => {
  const directive = buildConsistencyDirectives({
    level: CONSISTENCY_LOCK.lockedPrompt,
    characters: [LINYUE],
    scenes: [SU_DINING],
    kind: ASSET_KIND.shotRef,
    shot: { action: '林越抬头', shotSize: '近景' },
  })
  assert.equal(directive.usesReferenceImage, false)
  assert.ok(directive.positive.includes('第 1 级'), '必须写明是第 1 级')
  assert.ok(/没有可用的参考图/.test(directive.positive), '必须明说没有可用参考图')
  assert.ok(!/第 2 级/.test(directive.positive), '第 1 级指令不得出现第 2 级的措辞')
  // 但锁定串仍然必须逐字在场——第 1 级靠的就是它。
  assert.ok(directive.positive.includes(lockCharacter(LINYUE).canonical),
    '第 1 级也必须逐字包含 canonical（这是它唯一的一致性手段）')

  // 三视图类型走的是 prompts.js 的 buildCharacterSheet，负面表也应换成三视图专属。
  const sheet = buildConsistencyDirectives({
    level: CONSISTENCY_LOCK.lockedPrompt,
    characters: [LINYUE],
    kind: ASSET_KIND.characterSheet,
    name: '林越',
  })
  assert.ok(sheet.tokens.includes('buildCharacterSheet'))
  for (const term of CHARACTER_SHEET_NEGATIVE) {
    assert.ok(sheet.negative.includes(term), `三视图负面串缺少「${term}」`)
  }
})

ok('(i+) 运镜指令被压在提示词末尾（research §八），且合成是幂等的', () => {
  const directive = buildConsistencyDirectives({
    level: CONSISTENCY_LOCK.referenceImage,
    characters: [LINYUE],
    kind: ASSET_KIND.video,
    shot: { shotSize: '中景', cameraMove: '[移镜头]', motion: '他向前一步', dialogue: '签了它。' },
    durationSec: 5,
    cameraTail: '[推镜头]',
  })
  const tail = directive.positive.slice(-'[推镜头]'.length)
  assert.equal(tail, '[推镜头]', `运镜指令必须出现在最后：…${directive.positive.slice(-40)}`)
  assert.ok(directive.tokens.includes('camera:tail'))
  assert.ok(directive.tokens.includes('buildVideoPrompt'))

  // withCameraTail 的组合语义：幂等、不产生空串、不重复。
  assert.equal(withCameraTail('画面说明', '[推镜头]'), '画面说明，[推镜头]')
  assert.equal(withCameraTail('画面说明，[推镜头]', '[推镜头]'), '画面说明，[推镜头]', '重复追加必须幂等')
  assert.equal(withCameraTail('画面说明。', '[推镜头]'), '画面说明。[推镜头]', '句末不再补逗号')
  assert.equal(withCameraTail('', '[推镜头]'), '[推镜头]')
  assert.equal(withCameraTail('画面说明', ''), '画面说明')
})

/* ------------------------------------------------------------------ *
 * cross-module sanity: the camera layer must agree with video.js
 * ------------------------------------------------------------------ */

console.log('\n— cross-module sanity —')

ok('X1 计划的时长与 videoCapabilities 的包络兼容说明', async () => {
  // video.js 的 videoCapabilities() 给出各协议可接受的时长包络；相机计划产出的
  // 时长是「这一镜该怎么拍」，两者不必相等（video.js 会把越界值 clamp 掉）。
  // 这里只断言计划产出的时长是有限的整数秒，能被 video.js 的 clamp 逻辑消费。
  const plan = buildCameraPlan(SAMPLE_SHOTS, { rhythm: 'tense' })
  for (const row of plan.shots) {
    assert.ok(Number.isInteger(row.durationSec) && row.durationSec >= 1,
      `${row.ref} 的时长无法被 submitVideo 消费：${row.durationSec}`)
  }
  // 节奏档与计划输出必须一致，方便 UI 显示「本场按紧张档排」。
  assert.equal(plan.rhythm, 'tense')
  assert.equal(plan.rhythmLabel, EDIT_RHYTHM.tense.label)
})

ok('X2 suggestRhythm 读取真实剧本字段并给出理由', () => {
  const tense = suggestRhythm({
    action: '林越一把抢过退婚书，苏建国怒吼着拍桌',
    dialogue: [{ who: '苏建国', line: '签了它。' }],
    durationSec: 15,
    characters: ['林越', '苏建国'],
  })
  assert.equal(tense.rhythm, 'tense', `冲突场应判为紧张，实际 ${tense.rhythm}`)
  assert.ok(tense.reasons.length >= 2, '必须给出理由')
  assert.equal(tense.confidence, 'medium')
  assert.ok(tense.reasons.some(reason => /冲突动作/.test(reason)), '理由必须点名冲突动作')

  const relaxed = suggestRhythm({ action: '林越独自站在窗前', durationSec: 120, dialogue: [] })
  assert.equal(relaxed.rhythm, 'relaxed', `长而静的场应判为舒缓，实际 ${relaxed.rhythm}`)

  const normal = suggestRhythm({ action: '两人坐下说话', durationSec: 45, dialogue: [{ who: 'A', line: '一' }, { who: 'B', line: '二' }] })
  assert.equal(normal.rhythm, 'normal')

  // findRhythm 接受 key / id / 中文标签，未知值退回常规。
  assert.equal(findRhythm('tense').id, 'tense')
  assert.equal(findRhythm('紧张').id, 'tense')
  assert.equal(findRhythm('relaxed').id, 'relaxed')
  assert.equal(findRhythm('不存在').id, 'normal')
  assert.equal(findRhythm(undefined).id, 'normal')

  // findShotSize / findCameraAngle 的解析与兜底。
  assert.equal(findShotSize('大特写').abbr, 'ECU')
  assert.equal(findShotSize('第 3 镜：近景').name, '近景')
  assert.equal(findShotSize('莫名其妙').name, '中景', '未知景别应退回中景')
  assert.equal(findShotSize('').name, '中景')
})

/* ------------------------------------------------------------------ *
 * summary
 * ------------------------------------------------------------------ */

console.log(`\n${'-'.repeat(60)}`)
console.log(`${passed} passed, ${failed} failed, ${passed + failed} checks total`)

if (failed > 0) {
  console.log('\nFAILURES:')
  for (const failure of failures) {
    console.log(`  ✗ ${failure.name}`)
    console.log(`    ${String(failure.error && failure.error.message ? failure.error.message : failure.error)}`)
  }
  process.exitCode = 1
} else {
  console.log('ALL CHECKS PASSED')
}
