#!/usr/bin/env node
/**
 * dsh-aidrama — prompts.js acceptance test.
 *
 * Zero dependencies. Runs the real builders with realistic sample vars and
 * asserts the prompt-layer invariants described in the task:
 *
 *   (a) non-empty output
 *   (b) no 'undefined' and no '[object Object]' substring
 *   (c) no stray double full-width comma, no leading/trailing comma
 *   (d) the three-fold consistency lock is present in the character sheet
 *
 * Prints PASS/FAIL per assertion and exits non-zero if anything failed.
 *
 *   node docs/verify-prompts.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPTS_URL = new URL('../lib/host/prompts.js', import.meta.url)

const P = await import(PROMPTS_URL)
const {
  QUALITY_BOOSTERS,
  CHARACTER_SHEET_NEGATIVE,
  GENERIC_NEGATIVE,
  buildCharacterSheet,
  buildSceneMaster,
  buildShotRef,
  buildVideoPrompt,
  styleDnaBlock,
  mergeLayers,
  TEXT_STAGE_BRIEF,
  TEMPLATE_CATALOG,
} = P

const FROZEN = await import(new URL('../lib/host/protocol.js', import.meta.url))

/* ------------------------------------------------------------------ *
 * tiny test harness
 * ------------------------------------------------------------------ */

let passed = 0
let failed = 0
const failures = []

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
 * shared assertions
 * ------------------------------------------------------------------ */

const SEP = '，'

/**
 * Normalize a prompt for substring comparison: collapse the full-width comma to
 * a half-width one so a value that itself contains `，` (a style DNA such as
 * `3D 国漫，柔和光`) can still be matched field-by-field.
 * @param {unknown} value
 * @returns {string}
 */
const norm = value => String(value).replace(/，/g, ',')

/** Whether `prompt` carries `needle` once both are comma-normalized. */
const carries = (prompt, needle) => norm(prompt).includes(norm(needle))

/**
 * Read the body of a `标签：` section out of a single-line prompt.
 *
 * A naive `split('，')` is WRONG here: a style DNA legitimately contains `，`
 * (`3D 国漫，柔和光`), so it would be sliced into fragments. Sections are
 * therefore delimited by the next known label, not by the comma alone.
 *
 * @param {string} prompt
 * @param {string} label
 * @param {string[]} knownLabels
 * @returns {string} the section body, or `''` when absent.
 */
function sectionBody(prompt, label, knownLabels) {
  const start = prompt.indexOf(`${label}：`)
  if (start < 0) return ''
  let end = prompt.length
  for (const other of knownLabels) {
    if (other === label) continue
    const at = prompt.indexOf(`${SEP}${other}：`, start + label.length + 1)
    if (at >= 0 && at < end) end = at
  }
  return prompt.slice(start + label.length + 1, end)
}

/**
 * The universal prompt invariants. Returns the string so it can be chained.
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function checkPrompt(value, label) {
  assert.equal(typeof value, 'string', `${label}: 必须返回字符串，实际 ${typeof value}`)
  assert.ok(value.trim().length > 0, `${label}: 输出为空`)
  assert.ok(!value.includes('undefined'), `${label}: 输出包含 'undefined'`)
  assert.ok(!value.includes('null'), `${label}: 输出包含 'null'`)
  assert.ok(!value.includes('[object Object]'), `${label}: 输出包含 '[object Object]'`)
  assert.ok(!value.includes('NaN'), `${label}: 输出包含 'NaN'`)
  assert.ok(!value.includes('${'), `${label}: 输出残留模板占位符`)
  assert.ok(!value.includes('{{'), `${label}: 输出残留 {{}} 占位符`)
  assert.ok(value.includes(SEP), `${label}: 未使用全角逗号分段`)
  assert.ok(!value.includes(',,') && !value.includes('，，'), `${label}: 出现连续逗号`)
  assert.ok(!value.includes(',，') && !value.includes('，,'), `${label}: 出现半角/全角混排逗号`)
  assert.ok(!/^[，,]/.test(value), `${label}: 以逗号开头`)
  assert.ok(!/[，,]$/.test(value), `${label}: 以逗号结尾`)
  assert.ok(!value.includes(':：') && !value.includes('：:'), `${label}: 标签残缺`)
  assert.ok(!/：\s*[，,]/.test(value), `${label}: 出现空标签（如 "镜头：，"）`)
  assert.ok(!/[\r\n]/.test(value), `${label}: 输出不是单行（含换行）`)
  assert.ok(!value.includes('  '), `${label}: 输出包含连续空格`)
  return value
}

/** JSON schema string invariants: parseable, object-rooted, no stray prose. */
function checkSchema(schemaJson, label) {
  assert.equal(typeof schemaJson, 'string', `${label}.schema 必须是字符串`)
  let parsed
  try {
    parsed = JSON.parse(schemaJson)
  } catch (error) {
    throw new Error(`${label}.schema 不是合法 JSON: ${error.message}`)
  }
  assert.equal(parsed.type, 'object', `${label}.schema 根类型必须是 object`)
  assert.ok(Array.isArray(parsed.required) && parsed.required.length > 0, `${label}.schema 缺少 required`)
  assert.equal(parsed.additionalProperties, false, `${label}.schema 必须 additionalProperties:false`)
  for (const key of parsed.required) {
    assert.ok(parsed.properties && parsed.properties[key], `${label}.schema required 字段 ${key} 未定义`)
  }
  assert.ok(schemaJson.includes('\n'), `${label}.schema 应以缩进 JSON 形式给出，便于阅读`)
  assert.ok(!schemaJson.includes('undefined'), `${label}.schema 包含 'undefined'`)
  return parsed
}

/* ------------------------------------------------------------------ *
 * sample data
 * ------------------------------------------------------------------ */

const SAMPLE_STYLE = '3D 国漫，电影级柔和轮廓光，统一 85mm 焦距，细腻皮肤质感，无畸变'

const SHEET_VARS = {
  name: '林越',
  description: '28 岁男性，前操盘手，气质冷峻克制',
  hair: '两侧推短的黑色短发，发尾微翘，发际线清晰',
  face: '窄长脸，眉骨高，单眼皮，左眉尾有一道浅疤，薄唇',
  body: '身高 183cm，八头身，肩宽腰窄，体脂偏低',
  outfit: '黑色高领羊毛衫，深灰色中长风衣，黑色直筒西裤，黑色切尔西靴',
  accessory: '左手腕银色机械表（表盘无数字），右手无名指素圈戒指',
  pose: '自然站立，双臂自然下垂，掌心向内',
  lighting: '摄影棚三点布光，暖白主光加冷色轮廓光',
  camera: '统一 85mm 定焦，平视机位，近似正交投影',
  style: SAMPLE_STYLE,
  aspectRatio: '16:9',
}

const SCENE_VARS = {
  name: '苏家餐厅',
  description: '挑高六米的现代中式餐厅，胡桃木长桌，落地窗外是整座城市的夜景',
  lighting: '顶部暖色筒灯为主光（3000K），窗外冷蓝夜景作轮廓补光',
  composition: '从餐桌一端向内拍，前景是转盘与碗筷，纵深落到落地窗',
  style: SAMPLE_STYLE,
  aspectRatio: '9:16',
}

const SHOT_VARS = {
  description: '林越摘下头盔，把退婚书放在转盘上推过桌面，眼神落在苏建国脸上',
  shot: '中景',
  camera: '低机位缓推，浅景深，前景有雨丝',
  lighting: '窗外冷蓝夜景作轮廓光，桌面暖光打在脸上',
  composition: '三分法构图，主体偏右，视线朝向左侧留白',
  style: SAMPLE_STYLE,
  characters: ['林越', '苏建国'],
  scene: '苏家餐厅',
  aspectRatio: '9:16',
}

const VIDEO_VARS = {
  shot: '中景',
  camera: '低机位缓推',
  motion: '林越向前迈一步，右手把退婚书推过桌面，风衣下摆随之扬起',
  durationSec: 5,
  dialogue: '签了它，从今天起你跟我们苏家没关系。',
  style: SAMPLE_STYLE,
}

/** A minimal but structurally complete script, shared by the pack tests. */
const SAMPLE_SCRIPT = {
  title: '退婚后我成了首富',
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
      action: '林越把退婚书放在转盘上推过桌面。苏建国冷笑着签下自己的名字。林越起身走向电梯。',
      dialogue: [
        { who: '苏建国', line: '签了它，从今天起你跟我们苏家没关系。' },
        { who: '林越', line: '三十天后，你会自己来求我。' },
      ],
      durationSec: 45,
      shots: [],
    }],
  }],
}

/* ------------------------------------------------------------------ *
 * 1. exported surface
 * ------------------------------------------------------------------ */

console.log('== 导出契约 ==')

ok('QUALITY_BOOSTERS 是非空字符串字典', () => {
  assert.equal(typeof QUALITY_BOOSTERS, 'object')
  const keys = Object.keys(QUALITY_BOOSTERS)
  assert.ok(keys.length >= 6, `quality boosters 太少: ${keys.length}`)
  for (const key of keys) {
    assert.equal(typeof QUALITY_BOOSTERS[key], 'string', `${key} 不是字符串`)
    assert.ok(QUALITY_BOOSTERS[key].trim().length > 0, `${key} 为空`)
  }
})

ok('CHARACTER_SHEET_NEGATIVE 是为角色三视图定制的非空字符串数组', () => {
  assert.ok(Array.isArray(CHARACTER_SHEET_NEGATIVE))
  assert.ok(CHARACTER_SHEET_NEGATIVE.length >= 10)
  for (const item of CHARACTER_SHEET_NEGATIVE) {
    assert.equal(typeof item, 'string')
    assert.ok(item.trim().length > 0)
    assert.ok(!item.includes(SEP), `负面词条不应自带分隔符: ${item}`)
  }
})

ok('GENERIC_NEGATIVE 是非空字符串数组', () => {
  assert.ok(Array.isArray(GENERIC_NEGATIVE))
  assert.ok(GENERIC_NEGATIVE.length >= 8)
  for (const item of GENERIC_NEGATIVE) {
    assert.equal(typeof item, 'string')
    assert.ok(item.trim().length > 0)
  }
})

ok('TEMPLATE_CATALOG 条目带有 id/name/kind/description', () => {
  assert.ok(Array.isArray(TEMPLATE_CATALOG))
  assert.ok(TEMPLATE_CATALOG.length >= 4)
  const kinds = Object.values(FROZEN.ASSET_KIND)
  for (const entry of TEMPLATE_CATALOG) {
    assert.equal(typeof entry.id, 'string')
    assert.ok(entry.id.length > 0)
    assert.equal(typeof entry.name, 'string')
    assert.ok(entry.name.length > 0)
    assert.equal(typeof entry.kind, 'string')
    assert.ok(entry.kind === 'shotCraft' || kinds.includes(entry.kind), `未知 kind: ${entry.kind}`)
    assert.equal(typeof entry.description, 'string')
    assert.ok(entry.description.length > 0)
  }
  const ids = TEMPLATE_CATALOG.map(e => e.id)
  assert.equal(new Set(ids).size, ids.length, 'TEMPLATE_CATALOG id 重复')
})

ok('TEMPLATE_CATALOG 覆盖三种图像资产类型', () => {
  const kinds = new Set(TEMPLATE_CATALOG.map(e => e.kind))
  assert.ok(kinds.has(FROZEN.ASSET_KIND.characterSheet))
  assert.ok(kinds.has(FROZEN.ASSET_KIND.sceneMaster))
  assert.ok(kinds.has(FROZEN.ASSET_KIND.shotRef))
})

/* ------------------------------------------------------------------ *
 * 2. buildCharacterSheet
 * ------------------------------------------------------------------ */

console.log('\n== buildCharacterSheet ==')

const sheet = checkPrompt(buildCharacterSheet(SHEET_VARS), 'buildCharacterSheet')

ok('角色三视图包含全部 12 个章节', () => {
  for (const label of ['主体', '外观', '渲染', '姿态', '光影', '镜头', '背景', '版式', '度量', '一致性', '负面', '画幅']) {
    assert.ok(sheet.includes(`${label}：`), `缺少章节: ${label}`)
  }
})

ok('角色三视图左区是正脸特写、右区是侧/正/背全身三视图', () => {
  assert.ok(/左区：角色正脸特写/.test(sheet), '缺少左区正脸特写定义')
  assert.ok(/面部占满左区/.test(sheet), '左区未限定面部占满')
  assert.ok(/无身体入镜/.test(sheet), '左区未禁止身体入镜')
  assert.ok(/右区：标准角色设定三视图/.test(sheet), '缺少右区三视图定义')
  assert.ok(/侧视图、正视图、背视图/.test(sheet), '右区视图顺序不完整')
  assert.ok(/从头顶到脚底完整无遮挡、无裁切/.test(sheet), '右区未要求全身完整')
})

ok('角色三视图含可度量身高锚点', () => {
  assert.ok(/画面高度的\s*80%/.test(sheet), '缺少 80% 身高度量')
  assert.ok(/同一水平基线/.test(sheet), '缺少对齐基线')
  assert.ok(/两眼间距约占脸宽的四分之一/.test(sheet), '缺少面部度量锚点')
})

ok('角色三视图含三重一致性锁（面部/身体比例/服装）', () => {
  assert.ok(sheet.includes(QUALITY_BOOSTERS.consistentFace), '缺少面部一致性声明')
  assert.ok(sheet.includes(QUALITY_BOOSTERS.consistentBody), '缺少身体比例一致性声明')
  assert.ok(sheet.includes(QUALITY_BOOSTERS.consistentOutfit), '缺少服装一致性声明')
  assert.ok(/三重一致性必须同时成立/.test(sheet), '缺少三重锁的强制语义')
  assert.ok(sheet.includes('面部特征完全一致'), '缺少"面部一致"字面')
  assert.ok(sheet.includes('身体比例完全一致'), '缺少"身体比例一致"字面')
  assert.ok(sheet.includes('服装与配饰完全一致'), '缺少"服装一致"字面')
})

ok('角色三视图织入角色名、发型、服装与配饰等原始设定', () => {
  assert.ok(sheet.includes('林越'))
  assert.ok(carries(sheet, SHEET_VARS.hair), '发型未织入')
  assert.ok(carries(sheet, SHEET_VARS.outfit), '服装未织入')
  assert.ok(carries(sheet, SHEET_VARS.accessory), '配饰未织入')
  assert.ok(carries(sheet, SHEET_VARS.style), '风格 DNA 未织入')
  assert.ok(sheet.includes('16:9 横屏'))
})

ok('角色三视图的负面段落使用导出的 CHARACTER_SHEET_NEGATIVE', () => {
  const negative = sheet.slice(sheet.indexOf('负面：'))
  for (const term of CHARACTER_SHEET_NEGATIVE) {
    assert.ok(negative.includes(term), `负面段落缺少词条: ${term}`)
  }
})

ok('角色三视图禁止画面文字与水印', () => {
  assert.ok(sheet.includes(QUALITY_BOOSTERS.noText))
  assert.ok(sheet.includes('严禁画面融合') || sheet.includes(QUALITY_BOOSTERS.noCollage))
})

ok('角色三视图缺失变量时不产生占位垃圾', () => {
  const bare = checkPrompt(buildCharacterSheet({}), 'buildCharacterSheet({})')
  assert.ok(bare.includes('画面主体'), '空 name 未回退到占位主体名')
  assert.ok(carries(bare, FROZEN.PROJECT_DEFAULTS.styleDna), '空 style 未回退到项目默认风格')
  assert.ok(bare.includes(FROZEN.PROJECT_DEFAULTS.aspectRatio), '空 aspectRatio 未回退到项目默认画幅')
  const nulls = checkPrompt(buildCharacterSheet({ name: null, hair: undefined, outfit: 0, accessory: false }), 'buildCharacterSheet(半空)')
  // Scoped to the 外观 section: the fixed 光影 boilerplate legitimately contains
  // the word 服装 ("面部与服装细节清晰可见"), so a whole-prompt word search
  // would false-positive.
  const appearance = sectionBody(nulls, '外观', ['渲染', '风格', '姿态', '光影', '镜头', '背景', '版式', '度量', '一致性', '负面', '画幅'])
  for (const label of ['发型发色', '五官脸型', '体型身高', '服装', '配饰']) {
    assert.ok(!appearance.includes(`${label}：`), `外观 段落含空的 ${label} 字段: ${appearance}`)
  }
  assert.ok(!appearance.includes('：0'), '外观 段落泄漏了零值')
  assert.ok(!/：\s*(，|$)/.test(appearance), '外观 段落含空字段')
  assert.ok(appearance.length > 0, '外观 段落为空')
  // Guard against a vacuous pass: a real outfit must still land in 外观.
  const withOutfit = sectionBody(
    buildCharacterSheet({ outfit: '黑色高领羊毛衫' }),
    '外观',
    ['渲染', '风格', '姿态', '光影', '镜头', '背景', '版式', '度量', '一致性', '负面', '画幅'],
  )
  assert.ok(withOutfit.includes('服装：黑色高领羊毛衫'), `有效服装未进入 外观: ${withOutfit}`)
})

/* ------------------------------------------------------------------ *
 * 3. buildSceneMaster
 * ------------------------------------------------------------------ */

console.log('\n== buildSceneMaster ==')

const master = checkPrompt(buildSceneMaster(SCENE_VARS), 'buildSceneMaster')

ok('场景主图包含必需章节', () => {
  for (const label of ['主体', '风格', '渲染', '光影', '构图', '细节', '约束', '画幅']) {
    assert.ok(master.includes(`${label}：`), `缺少章节: ${label}`)
  }
})

ok('场景主图显式禁止人物入镜', () => {
  assert.ok(/严禁出现任何人物/.test(master), '缺少"严禁出现任何人物"')
  assert.ok(/人形剪影/.test(master), '缺少对剪影的禁止')
  assert.ok(/只保留空场景/.test(master), '缺少空场景约束')
  assert.ok(/人脸/.test(master), '缺少对人脸的禁止')
})

ok('场景主图织入场景名与描述', () => {
  assert.ok(master.includes(SCENE_VARS.name))
  assert.ok(master.includes(SCENE_VARS.description))
  assert.ok(master.includes(SCENE_VARS.lighting))
  assert.ok(master.includes(SCENE_VARS.composition))
  assert.ok(master.includes('9:16 竖屏'))
})

ok('场景主图缺失变量时有安全回退', () => {
  const bare = checkPrompt(buildSceneMaster(), 'buildSceneMaster()')
  assert.ok(bare.includes('未命名场景'))
  assert.ok(/严禁出现任何人物/.test(bare))
  assert.ok(bare.includes(FROZEN.PROJECT_DEFAULTS.aspectRatio))
})

/* ------------------------------------------------------------------ *
 * 4. buildShotRef
 * ------------------------------------------------------------------ */

console.log('\n== buildShotRef ==')

const shotRef = checkPrompt(buildShotRef(SHOT_VARS), 'buildShotRef')

ok('分镜参考图包含必需章节', () => {
  for (const label of ['画面', '主体', '场景', '风格', '渲染', '景别', '镜头', '光影', '构图', '负面', '画幅']) {
    assert.ok(shotRef.includes(`${label}：`), `缺少章节: ${label}`)
  }
})

ok('分镜参考图织入全部具名角色并锁定外观', () => {
  assert.ok(shotRef.includes('林越'), '缺少角色 林越')
  assert.ok(shotRef.includes('苏建国'), '缺少角色 苏建国')
  assert.ok(/严格沿用其角色设定三视图/.test(shotRef), '缺少沿用三视图的要求')
  assert.ok(/禁止换脸、换装、改年龄/.test(shotRef), '缺少禁止换脸换装')
})

ok('分镜参考图织入场景名并要求与场景主图一致', () => {
  assert.ok(shotRef.includes(`场景「${SHOT_VARS.scene}」`), '缺少具名场景')
  assert.ok(/与该场景主图完全一致/.test(shotRef), '缺少与场景主图一致的要求')
  assert.ok(/不得改造空间/.test(shotRef), '缺少禁止改造空间')
})

ok('分镜参考图接收角色/场景对象形式', () => {
  const obj = checkPrompt(buildShotRef({
    ...SHOT_VARS,
    characters: [{ name: '林越' }, { name: '苏婉' }],
    scene: { name: '旧交易室', description: '深夜空荡的交易所' },
  }), 'buildShotRef(对象入参)')
  assert.ok(obj.includes('林越'), '对象角色名丢失')
  assert.ok(obj.includes('苏婉'), '对象角色名丢失')
  assert.ok(obj.includes('旧交易室'), '对象场景名丢失')
  assert.ok(!obj.includes('[object Object]'))
})

ok('分镜参考图接受 bible 角色卡（id/name 形式）', () => {
  const card = checkPrompt(buildShotRef({
    description: '两人对视',
    characters: [{ id: 'lin-yue', name: '林越' }, { id: 'su-wan', title: '苏婉' }],
  }), 'buildShotRef(角色卡)')
  assert.ok(card.includes('林越'), '角色卡 name 丢失')
  assert.ok(card.includes('苏婉'), '角色卡 title 丢失')
  // A card without any display name must not silently vanish into the cast list.
  const idOnly = checkPrompt(buildShotRef({ description: '单人', characters: [{ id: 'lin-yue' }] }), 'buildShotRef(仅 id)')
  assert.ok(idOnly.includes('lin-yue'), '仅有 id 的角色卡未回退到 id')
})

ok('角色三视图与场景主图都带出调用方传入的风格 DNA', () => {
  const custom = '水墨写意，宣纸质感，留白构图'
  const cases = [
    ['buildCharacterSheet', buildCharacterSheet({ name: '甲', style: custom }),
      ['主体', '外观', '风格', '渲染', '姿态', '光影', '镜头', '背景', '版式', '度量', '一致性', '负面', '画幅']],
    ['buildSceneMaster', buildSceneMaster({ name: '乙', style: custom }),
      ['主体', '风格', '渲染', '光影', '构图', '细节', '约束', '画幅']],
    ['buildShotRef', buildShotRef({ description: '丙', style: custom }),
      ['画面', '主体', '场景', '风格', '渲染', '景别', '镜头', '光影', '构图', '负面', '画幅']],
  ]
  for (const [label, prompt, labels] of cases) {
    const body = sectionBody(prompt, '风格', labels)
    assert.equal(body, custom, `${label} 的 风格 段落不完整（含逗号的风格 DNA 被截断）`)
  }
})

ok('分镜参考图缺失变量时有安全回退', () => {
  const bare = checkPrompt(buildShotRef(), 'buildShotRef()')
  assert.ok(bare.includes('中景'), '缺少景别回退')
  const styleBody = sectionBody(bare, '风格', ['画面', '主体', '场景', '渲染', '景别', '镜头', '光影', '构图', '负面', '画幅'])
  assert.equal(styleBody, FROZEN.PROJECT_DEFAULTS.styleDna, '缺少风格回退到项目默认值')
  assert.ok(!bare.includes('画面主体：'), '空主体名不应生成空主体段落')
})

/* ------------------------------------------------------------------ *
 * 5. buildVideoPrompt
 * ------------------------------------------------------------------ */

console.log('\n== buildVideoPrompt ==')

const video = checkPrompt(buildVideoPrompt(VIDEO_VARS), 'buildVideoPrompt')

ok('视频提示词为运动优先：第一段是运动', () => {
  assert.ok(video.startsWith('运动：'), `第一段必须是运动，实际开头: ${video.slice(0, 30)}`)
  assert.ok(video.includes(VIDEO_VARS.motion), '缺少主体动作描述')
  assert.ok(video.indexOf('运镜：') > video.indexOf('运动：'), '运镜段落应在运动之后')
  assert.ok(video.indexOf('节奏：') > video.indexOf('运镜：'), '节奏段落应在运镜之后')
})

ok('视频提示词包含运动/运镜/节奏/时长/台词', () => {
  for (const label of ['运动', '运镜', '节奏', '景别', '连贯性', '对话', '画面', '风格', '渲染', '负面']) {
    assert.ok(video.includes(`${label}：`), `缺少章节: ${label}`)
  }
  assert.ok(video.includes('整个 5 秒内运动连续不中断'), '缺少时长绑定')
  assert.ok(video.includes('5 秒内完成起幅、推进与落幅'), '缺少节奏分段')
  assert.ok(video.includes(VIDEO_VARS.dialogue), '缺少台词')
  assert.ok(video.includes('口型'), '缺少口型同步要求')
})

ok('视频提示词不是静态画面描述', () => {
  assert.ok(video.includes('无镜头抖动、无跳切'), '缺少镜头稳定性要求')
  assert.ok(video.includes('惯性'), '缺少动作物理合理性')
  assert.ok(video.includes('背景元素持续微动'), '缺少背景微动防止死板')
})

ok('视频提示词处理时长与台词缺失', () => {
  const silent = checkPrompt(buildVideoPrompt({ shot: '大特写', motion: '只有眨眼与呼吸' }), 'buildVideoPrompt(无台词)')
  assert.ok(!silent.includes('对话：'), '无台词时不应输出对话段落')
  assert.ok(silent.includes(`整个 ${FROZEN.PROJECT_DEFAULTS.shotSeconds} 秒内运动连续不中断`), '缺少默认时长回退')
  const badSeconds = checkPrompt(buildVideoPrompt({ motion: '转身', durationSec: -3 }), 'buildVideoPrompt(负时长)')
  assert.ok(badSeconds.includes(`整个 ${FROZEN.PROJECT_DEFAULTS.shotSeconds} 秒内`), '非法时长未回退到默认值')
  const huge = checkPrompt(buildVideoPrompt({ motion: '走过长廊', durationSec: 999 }), 'buildVideoPrompt(超长时长)')
  assert.ok(huge.includes('整个 60 秒内'), '超长时长未被钳制到 60 秒')
})

/* ------------------------------------------------------------------ *
 * 6. styleDnaBlock + mergeLayers
 * ------------------------------------------------------------------ */

console.log('\n== styleDnaBlock / mergeLayers ==')

ok('styleDnaBlock 处理字符串/对象/数组/空值', () => {
  assert.equal(styleDnaBlock(''), '')
  assert.equal(styleDnaBlock(null), '')
  assert.equal(styleDnaBlock(undefined), '')
  assert.equal(styleDnaBlock('3D 国漫'), '统一风格：3D 国漫')
  assert.equal(styleDnaBlock({ 风格: '3D 国漫' }), '统一风格：风格：3D 国漫')
  assert.equal(styleDnaBlock(['3D 国漫', '柔和轮廓光']), '统一风格：3D 国漫，柔和轮廓光')
  assert.ok(!styleDnaBlock({ a: null, b: '' }).includes('[object Object]'))
})

ok('mergeLayers 正向层顺序为 风格DNA → 模板 → 手动 → 注入', () => {
  const merged = mergeLayers({
    styleDna: '3D 国漫',
    template: '模板句',
    manual: '手动句',
    injections: '注入句',
  })
  assert.equal(merged.positive, '统一风格：3D 国漫，模板句，手动句，注入句')
  assert.ok(merged.negative.includes(GENERIC_NEGATIVE[0]))
})

ok('mergeLayers 输出满足全部提示词不变量', () => {
  const merged = mergeLayers({
    styleDna: SHEET_VARS.style,
    template: buildShotRef(SHOT_VARS),
    manual: '手动补充：主体偏右三分之一',
    injections: '',
  })
  checkPrompt(merged.positive, 'mergeLayers.positive')
  checkPrompt(merged.negative, 'mergeLayers.negative')
  assert.ok(merged.positive.indexOf('手动补充') > merged.positive.indexOf('统一风格'), '手动层必须排在模板层之后')
})

ok('mergeLayers 容忍空/畸形入参', () => {
  const empty = mergeLayers()
  assert.equal(empty.positive, '')
  assert.ok(empty.negative.length > 0)
  const dirty = mergeLayers({ styleDna: null, template: undefined, manual: '   ', injections: {} })
  assert.equal(dirty.positive, '')
  assert.ok(!dirty.positive.includes('[object Object]'))
})

/* ------------------------------------------------------------------ *
 * 7. TEXT_STAGE_BRIEF
 * ------------------------------------------------------------------ */

console.log('\n== TEXT_STAGE_BRIEF ==')

const TEXT_STAGE_IDS = ['idea', 'story', 'script', 'bible']

ok('TEXT_STAGE_BRIEF 覆盖四个文本阶段', () => {
  assert.equal(typeof TEXT_STAGE_BRIEF, 'object')
  assert.deepEqual(Object.keys(TEXT_STAGE_BRIEF).sort(), [...TEXT_STAGE_IDS].sort())
  for (const id of TEXT_STAGE_IDS) {
    const brief = TEXT_STAGE_BRIEF[id]
    assert.equal(typeof brief.system, 'string')
    assert.ok(brief.system.length > 20, `${id}.system 过短`)
    assert.ok(brief.system.includes('只输出一个 JSON'), `${id}.system 未约束 JSON-only`)
    assert.ok(brief.system.includes('简体中文'), `${id}.system 未约束语言`)
    assert.equal(typeof brief.task, 'string')
    assert.ok(brief.task.length > 40, `${id}.task 过短`)
    assert.ok(brief.task.includes(FROZEN.STAGE_META[id].label), `${id}.task 未引用阶段标签`)
  }
})

ok('每个 schema 都是合法的、对象根、additionalProperties:false 的 JSON', () => {
  for (const id of TEXT_STAGE_IDS) {
    checkSchema(TEXT_STAGE_BRIEF[id].schema, id)
  }
})

/** Collect field paths of a parsed schema, `a.b[].c` style. */
function pathsOf(node, prefix = '') {
  const out = []
  if (!node || typeof node !== 'object') return out
  if (node.type === 'array' && node.items) {
    out.push(`${prefix}[]`)
    out.push(...pathsOf(node.items, `${prefix}[]`))
    return out
  }
  if (node.properties) {
    for (const [key, value] of Object.entries(node.properties)) {
      const path = prefix ? `${prefix}.${key}` : key
      out.push(path)
      out.push(...pathsOf(value, path))
    }
  }
  return out
}

const EXPECTED_PATHS = {
  idea: [
    'title', 'logline', 'genre', 'tone', 'protagonist', 'conflict', 'hook', 'ending', 'questions', 'questions[]',
  ],
  story: [
    'title', 'logline', 'theme', 'synopsis',
    'acts', 'acts[]', 'acts[].no', 'acts[].name', 'acts[].summary',
    'characters', 'characters[]', 'characters[].name', 'characters[].role', 'characters[].want', 'characters[].obstacle',
    'episodes', 'episodes[]', 'episodes[].no', 'episodes[].title', 'episodes[].hook', 'episodes[].summary',
  ],
  script: [
    'title', 'episodes', 'episodes[]', 'episodes[].no', 'episodes[].title', 'episodes[].hook', 'episodes[].scenes',
    'episodes[].scenes[]', 'episodes[].scenes[].no', 'episodes[].scenes[].slug', 'episodes[].scenes[].location',
    'episodes[].scenes[].time', 'episodes[].scenes[].characters', 'episodes[].scenes[].characters[]',
    'episodes[].scenes[].action', 'episodes[].scenes[].dialogue', 'episodes[].scenes[].dialogue[]',
    'episodes[].scenes[].dialogue[].who', 'episodes[].scenes[].dialogue[].line',
    'episodes[].scenes[].durationSec', 'episodes[].scenes[].shots', 'episodes[].scenes[].shots[]',
    'episodes[].scenes[].shots[].no', 'episodes[].scenes[].shots[].shot', 'episodes[].scenes[].shots[].camera',
    'episodes[].scenes[].shots[].description', 'episodes[].scenes[].shots[].motion',
  ],
  bible: [
    'styleDna', 'characters', 'characters[]',
    'characters[].id', 'characters[].name', 'characters[].role', 'characters[].appearance', 'characters[].hair',
    'characters[].face', 'characters[].body', 'characters[].outfit', 'characters[].accessory',
    'characters[].personality', 'characters[].arc', 'characters[].sheetPrompt',
    'scenes', 'scenes[]', 'scenes[].id', 'scenes[].name', 'scenes[].kind', 'scenes[].description',
    'scenes[].lighting', 'scenes[].composition', 'scenes[].masterPrompt',
  ],
}

/**
 * Fields that `story.js`'s `STORY_BRIEF_OVERLAY` intentionally ADDS to the story
 * and script schemas, folded in at the bottom of prompts.js.
 *
 * The original assertion demanded exact equality, which was right before the
 * craft layer existed. It is now wrong for two reasons: the additions are
 * deliberate, and an exact-match assertion would have to be edited every time a
 * craft field is added. The check below therefore allows exactly these paths and
 * still fails on anything else, so accidental drift is caught while the intended
 * enrichment is not mistaken for a bug.
 *
 * Keep this list in sync with STORY_BRIEF_OVERLAY — `verify-craft.mjs` proves the
 * fields truly survive normalizeStageContent, which is the check that matters.
 */
const CRAFT_ADDITIONS = {
  story: [
    'controllingIdea',
    'beats', 'beats[]', 'beats[].id', 'beats[].name', 'beats[].position',
    'beats[].purpose', 'beats[].answer',
    'episodes[].hookType', 'episodes[].reversalPoints', 'episodes[].scenes',
    'acts[].turningPoint',
  ],
  script: [
    'hookType', 'reversalPoints', 'reversalPoints[]',
    'episodes[].hookType', 'episodes[].reversalPoints', 'episodes[].reversalPoints[]',
    'episodes[].scenes[].valueEntry', 'episodes[].scenes[].valueExit', 'episodes[].scenes[].valuePair',
    'episodes[].scenes[].shots[].beatId', 'episodes[].scenes[].shots[].hookCue',
  ],
}

ok('四个 schema 的字段路径与 stages.js 归一化形状逐一匹配', () => {
  for (const id of TEXT_STAGE_IDS) {
    const actual = new Set(pathsOf(JSON.parse(TEXT_STAGE_BRIEF[id].schema)))
    const expected = new Set(EXPECTED_PATHS[id])
    const allowed = new Set(CRAFT_ADDITIONS[id] ?? [])

    const missing = [...expected].filter(p => !actual.has(p))
    const extra = [...actual].filter(p => !expected.has(p) && !allowed.has(p))

    assert.deepEqual(missing, [], `${id}.schema 缺少字段: ${missing.join(', ')}`)
    assert.deepEqual(extra, [], `${id}.schema 多出未声明字段: ${extra.join(', ')}`)
  }
})

ok('craft 附加字段确实出现在 schema 里（不是空声明）', () => {
  // A positive control: the allow-list above must not be vacuous. If the overlay
  // silently stopped being folded in, an allow-list would hide the regression.
  const storySchema = JSON.parse(TEXT_STAGE_BRIEF.story.schema)
  const storyPaths = new Set(pathsOf(storySchema))
  assert.ok(storyPaths.has('beats') && storyPaths.has('beats[].id'),
    'story.schema 未包含 beats —— STORY_BRIEF_OVERLAY 可能没有折叠进来')
  assert.ok(storyPaths.has('controllingIdea'), 'story.schema 未包含 controllingIdea')

  const scriptSchema = JSON.parse(TEXT_STAGE_BRIEF.script.schema)
  const scriptPaths = new Set(pathsOf(scriptSchema))
  assert.ok(scriptPaths.has('episodes[].scenes[].valueEntry'),
    'script.schema 未包含 valueEntry —— 价值转折规则没有传给模型')

  // And the brief TEXT must carry the craft rules, not just the schema shape.
  assert.ok(TEXT_STAGE_BRIEF.story.system.includes('麦基') || TEXT_STAGE_BRIEF.story.task.includes('激励事件'),
    'story brief 未包含麦基结构说明')
  assert.ok(/钩子/.test(TEXT_STAGE_BRIEF.story.task) || /3 秒|前三秒/.test(TEXT_STAGE_BRIEF.story.task),
    'story brief 未包含爆点要求')
})

ok('bible.schema 的 sheetPrompt/masterPrompt 与图像构建器语义一致', () => {
  const bible = JSON.parse(TEXT_STAGE_BRIEF.bible.schema)
  const sheetDesc = bible.properties.characters.items.properties.sheetPrompt.description
  const masterDesc = bible.properties.scenes.items.properties.masterPrompt.description
  assert.ok(/三视图/.test(sheetDesc), 'sheetPrompt 未要求三视图')
  assert.ok(/无人物|没有任何人物|禁止.*人物/.test(masterDesc), 'masterPrompt 未要求无人物')
  assert.deepEqual(bible.properties.scenes.items.properties.kind.enum, ['interior', 'exterior'])
})

ok('script.schema 的 shot 字段覆盖景别与运动', () => {
  const script = JSON.parse(TEXT_STAGE_BRIEF.script.schema)
  const shot = script.properties.episodes.items.properties.scenes.items.properties.shots.items
  assert.deepEqual(shot.required, ['no', 'shot', 'camera', 'description', 'motion'])
  assert.ok(/景别/.test(shot.properties.shot.description))
  assert.ok(/运动/.test(shot.properties.motion.description))
})

/* ------------------------------------------------------------------ *
 * 8. pack builders + scene heading (consumed by stages.js)
 * ------------------------------------------------------------------ */

console.log('\n== buildScenePromptPack / buildVideoPromptPack ==')

ok('buildScenePromptPack 为每个场景产出主图与逐镜提示词', () => {
  const pack = P.buildScenePromptPack(SAMPLE_SCRIPT, {
    styleDna: SAMPLE_STYLE,
    aspectRatio: '9:16',
    shotSeconds: 5,
  })
  assert.equal(pack.length, 1, '场景数应为 1')
  const entry = pack[0]
  assert.equal(entry.episode.no, 1)
  assert.equal(entry.scene.no, 1)
  assert.equal(entry.scene.heading, '室内 苏家餐厅 · 夜')
  checkPrompt(entry.master.positive, 'pack.master.positive')
  checkPrompt(entry.master.negative, 'pack.master.negative')
  assert.ok(/严禁出现任何人物/.test(entry.master.positive), '场景主图未禁人物')
  assert.ok(entry.shots.length >= 3, `镜头数过少: ${entry.shots.length}`)
  for (const shot of entry.shots) {
    checkPrompt(shot.prompt.positive, `pack.shots[${shot.no}].positive`)
    checkPrompt(shot.prompt.negative, `pack.shots[${shot.no}].negative`)
    assert.ok(shot.shot && shot.camera && shot.description && shot.motion)
    assert.ok(shot.durationSec > 0)
    assert.ok(shot.prompt.positive.includes('林越'), '分镜未织入角色名')
  }
})

ok('buildScenePromptPack 对空/畸形脚本返回空数组而不抛错', () => {
  assert.deepEqual(P.buildScenePromptPack(), [])
  assert.deepEqual(P.buildScenePromptPack(null), [])
  assert.deepEqual(P.buildScenePromptPack({}), [])
  assert.deepEqual(P.buildScenePromptPack({ episodes: [] }), [])
  assert.deepEqual(P.buildScenePromptPack({ episodes: [{ scenes: [] }] }), [])
})

ok('buildVideoPromptPack 为每镜产出运动优先提示词与稳定 shotId', () => {
  const pack = P.buildVideoPromptPack(SAMPLE_SCRIPT, { styleDna: SAMPLE_STYLE, shotSeconds: 5 })
  assert.ok(pack.length >= 3)
  const ids = pack.map(item => item.shotId)
  assert.equal(new Set(ids).size, ids.length, 'shotId 重复')
  for (const item of pack) {
    assert.match(item.shotId, /^shot-\d+-\d+-\d+$/)
    checkPrompt(item.prompt, `videoPack[${item.shotId}].prompt`)
    assert.ok(item.prompt.startsWith('运动：'), `${item.shotId} 不是运动优先`)
    assert.equal(item.durationSec, 5)
  }
  assert.deepEqual(P.buildVideoPromptPack(), [])
})

ok('buildShotBreakdown 尊重已授权的 shots 并保留编号', () => {
  const authored = P.buildShotBreakdown({
    action: '两人对峙',
    shots: [
      { no: 1, shot: '远景', camera: '固定广角', description: '交代餐厅全貌', motion: '镜头静止', durationSec: 4 },
      { no: 2, shot: '特写', camera: '固定', description: '退婚书落桌', motion: '纸张滑入画面', durationSec: 3 },
    ],
  })
  assert.equal(authored.length, 2)
  assert.equal(authored[0].shot, '远景')
  assert.equal(authored[1].durationSec, 3)
  assert.ok(!authored.some(s => !s.description || !s.motion))
})

ok('buildShotBreakdown 对非对象入参抛出可读错误', () => {
  assert.throws(() => P.buildShotBreakdown(null), /需要一场戏的对象/)
  assert.throws(() => P.buildShotBreakdown('INT. 苏家餐厅'), /需要一场戏的对象/)
})

ok('sceneHeading 解析 INT/EXT 场次标题', () => {
  assert.equal(P.sceneHeading('INT. 苏家餐厅 - 夜'), '室内 苏家餐厅 · 夜')
  assert.equal(P.sceneHeading('EXT. 天台 - 清晨'), '室外 天台 · 清晨')
  assert.equal(P.sceneHeading('INT/EXT. 车库 - 雨夜'), '内外景 车库 · 雨夜')
  assert.equal(P.sceneHeading(''), '')
  assert.equal(P.sceneHeading(null), '')
})

ok('buildShotBreakdown 是确定性的（重复调用结果一致）', () => {
  const a = P.buildShotBreakdown(SAMPLE_SCRIPT.episodes[0].scenes[0])
  const b = P.buildShotBreakdown(SAMPLE_SCRIPT.episodes[0].scenes[0])
  assert.deepEqual(a, b)
})

/* ------------------------------------------------------------------ *
 * 9. static hygiene
 * ------------------------------------------------------------------ */

console.log('\n== 静态检查 ==')

ok('prompts.js 只依赖内部兄弟模块，零外部依赖', () => {
  const source = readFileSync(fileURLToPath(PROMPTS_URL), 'utf8')
  const specifiers = [...source.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)'/gm)].map(m => m[1])

  // Every relative import is a sibling module shipped in this same package
  // (protocol.js is the frozen contract; story.js is the craft layer folded in
  // below TEXT_STAGE_BRIEF). Anything NOT relative would be an external package,
  // which this plugin must never add.
  const external = specifiers.filter(s => !s.startsWith('./') && !s.startsWith('../'))
  assert.deepEqual(external, [], `出现了外部依赖: ${external.join(', ')}`)

  // The known internal set is still pinned, so an unexpected sibling import is
  // caught rather than silently accepted by the looser rule above.
  const internal = [...specifiers].sort()
  assert.deepEqual(internal, ['./protocol.js', './story.js'].sort(),
    `内部依赖集合变化: ${internal.join(', ')}`)

  assert.ok(!/require\s*\(/.test(source), '不应出现 require()')
  assert.ok(!/\bfetch\s*\(/.test(source), '不应出现网络调用')
  assert.ok(!/node:fs|from 'fs'|node:path/.test(source), '不应触碰文件系统')
  assert.ok(source.includes('export const QUALITY_BOOSTERS'))
  assert.ok(source.includes('export function mergeLayers'))
  assert.ok(source.includes('export const TEXT_STAGE_BRIEF'))
})

ok('prompts.js 未重新定义 protocol.js 的冻结常量', () => {
  const source = readFileSync(fileURLToPath(PROMPTS_URL), 'utf8')
  for (const frozen of ['export const STAGES', 'export const STAGE_META', 'export const ASSET_KIND', 'export const ASPECT_RATIOS', 'export const PROJECT_DEFAULTS']) {
    assert.ok(!source.includes(frozen), `重复导出了冻结常量: ${frozen}`)
  }
})

/* ------------------------------------------------------------------ *
 * summary
 * ------------------------------------------------------------------ */

console.log('\n----------------------------------------')
console.log(`PASS ${passed} / FAIL ${failed}`)
if (failed > 0) {
  console.log('\n失败详情：')
  for (const item of failures) {
    console.log(`- ${item.name}`)
    console.log(`  ${item.error && item.error.message ? item.error.message : item.error}`)
  }
  process.exit(1)
}
console.log('ALL PROMPT ASSERTIONS PASSED')
console.log(`workspace: ${join(HERE, '..')}`)
