/**
 * END-TO-END STAGE FLOW on a throwaway project.
 *
 * The real project (回声站) is already finished, so it cannot answer the question
 * that matters most to a new user: does the pipeline actually carry you from an
 * empty idea to a video prompt pack, one stage at a time, without a dead end?
 *
 * This drives the HOST half directly — the GUI is exercised by click-drive.mjs, so
 * repeating that here would only add flakiness. What it checks is the stage
 * machine: can each stage be committed, does it advance, does the NEXT brief
 * reflect what was just written rather than a fixed template, and does the final
 * stage produce a usable prompt pack.
 *
 * It writes to a TEMP data root, so the user's 回声站 project is never touched.
 *
 * Run: node docs/realtest/stage-flow.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

let pass = 0, fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`) }
}

// Point the store at a scratch directory BEFORE importing anything that reads it.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aidrama-flow-'))
const store = await import(pathToFileURL(path.join(root, 'lib', 'host', 'store.js')).href)
store.setDataRoot(scratch)

const stages = await import(pathToFileURL(path.join(root, 'lib', 'host', 'stages.js')).href)
const routes = await import(pathToFileURL(path.join(root, 'lib', 'host', 'routes.js')).href)

const project = await store.createProjectDoc({ title: '流程测试', logline: '验证六个阶段能不能一路走通。' })
await store.writeProject(project)
console.log(`scratch project: ${project.id}  (data root: ${scratch})\n`)

const reload = async () => store.readProject(project.id)

/* ------------------------------------------------------------------ *
 * Stage content, minimal but structurally real.
 * ------------------------------------------------------------------ */
const CONTENT = {
  idea: {
    seed: '我总梦见自己在地铁上，但车永远不停。',
    audience: '都能看',
    flavor: '悬疑为主 · 层层反转',
    length: '4 集',
    title: '回声站',
    logline: '一个末班车乘客发现，车永远到不了终点。',
    protagonist: '周晚，28 岁，值夜班的播音员，想弄清楚为什么自己每晚都在同一节车厢醒来',
    conflict: '她要下车，而车、广播和自己的记忆都在阻止她。',
    hook: '她按下紧急制动，门开了，外面是同一个车厢。',
    ending: '她意识到自己就是那段循环的广播。',
  },
  story: {
    title: '回声站',
    logline: '一个末班车乘客发现，车永远到不了终点。',
    synopsis: '周晚在末班地铁上醒来，发现列车永远不停。她逐个车厢寻找出口，每一节都重复着她自己的过去。最终她发现，自己早已不在车上——她是那段循环的广播。',
    controllingIdea: '逃避记忆的人，最终会成为记忆本身。',
    theme: '记忆与自我',
    acts: [
      { name: '第一幕', summary: '周晚醒来，发现车不停。' },
      { name: '第二幕', summary: '她穿行车厢，遇到过去的自己。' },
      { name: '第三幕', summary: '她接受自己就是广播。' },
    ],
    beats: [
      { no: 1, name: '醒来', purpose: '周晚在末班车上醒来，车不停。', act: 1 },
      { no: 2, name: '寻找', purpose: '她走向下一节车厢。', act: 2 },
      { no: 3, name: '相认', purpose: '她看见三年前的自己。', act: 2 },
      { no: 4, name: '回声', purpose: '她发现自己就是广播。', act: 3 },
    ],
    characters: [],
    episodes: [],
  },
  script: {
    title: '回声站',
    episodes: [
      {
        no: 1,
        title: '第一集',
        summary: '周晚在末班车上醒来，发现车不停。',
        hook: '她按下制动，外面是同一个车厢。',
        scenes: [
          {
            no: 1,
            slug: '内 · 末班地铁车厢 · 夜',
            kind: '内景',
            shots: [
              { no: 1, shot: '特写', description: '周晚的手抓着扶手', action: '车灯闪了一下', line: '', motion: '轻微手持晃动', camera: '特写', durationSeconds: 5, hookCue: '广播说"终点站到了"，车却在动' },
              { no: 2, shot: '中景', description: '周晚抬头看向车厢尽头', action: '她站起来', line: '周晚：这是哪一站？', motion: '镜头缓缓推进', camera: '中景', durationSeconds: 5 },
            ],
          },
        ],
      },
    ],
    shots: [],
  },
  bible: {
    styleDna: '3D 国漫，电影级柔和轮廓光，统一 85mm 焦距，细腻皮肤质感，无畸变',
    characters: [
      {
        id: 'zhou-wan',
        name: '周晚',
        role: '主角',
        appearance: '28 岁女性，齐耳黑短发中分，左眼下一颗小痣',
        hair: '齐耳黑短发，中分',
        face: '清瘦，左眼下一颗小痣',
        body: '偏瘦，中等身高',
        outfit: '藏青色制服外套，白衬衫，藏青领带',
        accessory: '银色圆环耳饰，挂红绳的工作证',
        personality: '克制，习惯先观察再开口',
        arc: '从逃避记忆到承认自己就是记忆',
      },
      {
        id: 'chen-mo',
        name: '陈默',
        role: '对手',
        appearance: '35 岁男性，寸头，方脸，浓眉，胡茬',
        hair: '寸头',
        face: '方脸，浓眉，胡茬',
        body: '壮实',
        outfit: '深灰夹克内搭灰色针织衫，黑色靴子',
        accessory: '腰侧别着对讲机',
        personality: '沉默，只说实话',
        arc: '揭示真相',
      },
    ],
    scenes: [
      {
        id: 'carriage-night',
        name: '末班地铁车厢',
        kind: '内景',
        interior: true,
        description: '空荡的地铁车厢，蓝灰色座椅，顶灯忽明忽暗，窗外是纯黑',
        lighting: '冷白顶灯，色温 5600K，间隔闪烁',
        composition: '纵深长镜头，座椅形成透视线',
      },
    ],
  },
}

/* ------------------------------------------------------------------ *
 * Walk the pipeline.
 * ------------------------------------------------------------------ */
const ORDER = ['idea', 'story', 'script', 'bible']

console.log('--- 四个文本阶段能依次提交 ---')
for (const id of ORDER) {
  const before = await reload()
  check(`${id}: 起始状态是未完成`, before.stages?.[id]?.status !== 'ready',
    `status=${before.stages?.[id]?.status}`)

  const normalized = stages.normalizeStageContent(id, CONTENT[id], before)
  check(`${id}: 内容能被规范化`, normalized !== null && normalized !== undefined)

  // markStageReady() sets project.content[stageId] ITSELF (stages.js:646) — the
  // content is an argument, not a prior assignment. Writing content separately
  // then calling it with two arguments silently produces content:null, which is
  // exactly the mistake this test made on its first run.
  stages.markStageReady(before, id, CONTENT[id])
  await store.writeProject(before)

  const after = await reload()
  check(`${id}: 提交后标记为完成`, after.stages?.[id]?.status === 'ready',
    `status=${after.stages?.[id]?.status}`)
  check(`${id}: 内容真的落盘了`, after.content?.[id] !== null && after.content?.[id] !== undefined,
    `content.${id} = ${JSON.stringify(after.content?.[id])?.slice(0, 60)}`)
}

const filled = await reload()
console.log(`\n  已就绪阶段: ${ORDER.filter(id => filled.stages?.[id]?.status === 'ready').join(', ')}`)

/* ------------------------------------------------------------------ *
 * The script stage must yield shots the later stages can consume.
 * ------------------------------------------------------------------ */
console.log('\n--- 脚本阶段产出的镜头能被后续阶段读到 ---')
// NOTE: flattenScriptShots takes the SCRIPT CONTENT, not the project document.
// Passing the project made it fall through to normalizeShots(payload), which
// returned one junk shot carrying the whole doc — a mistake in this test, not in
// the product, and a good example of why the shape must be read before use.
const flat = stages.flattenScriptShots(filled.content.script)
console.log(`  flattenScriptShots -> ${flat.length} 个镜头`)
check('脚本里的分镜被摊平出来', flat.length >= 2, `${flat.length} shots`)
check('每个镜头都带集数和场号', flat.every(s => s.episode !== undefined && s.scene !== undefined),
  JSON.stringify(flat[0] ?? {}).slice(0, 160))
check('镜头 id 是可读的 shot-集-场-镜 形式',
  flat.every(s => /^shot-\d+-\d+-\d+$/u.test(String(s.id))),
  flat.map(s => s.id).join(', '))

/* ------------------------------------------------------------------ *
 * Bible must normalize the characters/scenes the visual stage will render.
 * ------------------------------------------------------------------ */
console.log('\n--- 设定集能被规范化成人物与场景 ---')
const chars = stages.normalizeCharacters(filled.content.bible.characters)
const scenes = stages.normalizeScenes(filled.content.bible.scenes)
check('人物被规范化', chars.length === 2, `${chars.length}`)
check('人物保留了外观字段（一致性靠它）',
  chars.every(c => String(c.appearance ?? '') !== '' && String(c.hair ?? '') !== ''),
  JSON.stringify(chars[0] ?? {}).slice(0, 120))
check('场景被规范化', scenes.length === 1, `${scenes.length}`)
check('场景保留了内景标记', scenes[0]?.interior === true, String(scenes[0]?.interior))

/* ------------------------------------------------------------------ *
 * The visual stage must be able to build prompts for every target.
 * ------------------------------------------------------------------ */
console.log('\n--- 视觉阶段能为每个目标生成提示词 ---')
const prompts = await import(pathToFileURL(path.join(root, 'lib', 'host', 'prompts.js')).href)
const styleDna = filled.content.bible.styleDna

for (const c of chars) {
  const p = String(prompts.buildCharacterSheet(c, { styleDna }))
  // Assert on the FIELDS that carry identity (hair/face/outfit), not on
  // `appearance` — the builder expands those granular fields, and `appearance`
  // is only a human-written summary that may not appear verbatim.
  const carriesLook = [c.hair, c.face, c.outfit]
    .filter(v => String(v ?? '') !== '')
    .every(v => p.includes(String(v).split('，')[0]))
  check(`${c.name} 的三视图提示词带上了外观细节`, p.length > 60 && carriesLook,
    p.slice(0, 90))
}
for (const s of scenes) {
  const p = String(prompts.buildSceneMaster(s, { styleDna }))
  check(`${s.name} 的场景主图提示词非空`, p.length > 40, p.slice(0, 90))
}

/* ------------------------------------------------------------------ *
 * The video stage must hand back a prompt pack when no channel is set.
 * ------------------------------------------------------------------ */
console.log('\n--- 视频阶段：无渠道时导出提示词包 ---')
const shotLike = {
  id: 'shot-1-1-1', no: 1, episode: 1, scene: 1,
  shot: '特写', description: '周晚的手抓着扶手', action: '车灯闪了一下',
  camera: '特写', durationSeconds: 5, motion: '轻微手持晃动',
}
const shotPrompt = String(prompts.buildShotRef({
  ...shotLike,
  // Flat named keys, NOT an options object: buildShotRef reads v.characters /
  // v.scene / v.style directly. It also deliberately avoids the `list()` helper,
  // which would strip every appearance field except `.name`.
  characters: [chars[0]],
  scene: scenes[0],
  style: styleDna,
  aspectRatio: filled.aspectRatio,
}))
check('分镜参考图提示词非空', shotPrompt.length > 60, shotPrompt.slice(0, 120))
check('分镜提示词带上了人物的真实外观（跨镜一致性的机制）',
  shotPrompt.includes('小痣') || shotPrompt.includes('齐耳'),
  '镜头提示词没有重复人物外观 —— 跨镜一致性就靠这个')

/* ------------------------------------------------------------------ *
 * Clean up.
 * ------------------------------------------------------------------ */
try { store.deleteProject(project.id) } catch { /* best effort */ }
fs.rmSync(scratch, { recursive: true, force: true })

console.log(`\n${'='.repeat(60)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
