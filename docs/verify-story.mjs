/**
 * dsh-aidrama — story craft engine self-test.
 *
 *   node docs/verify-story.mjs
 *
 * Prints PASS/FAIL per assertion, a summary, and exits non-zero when anything
 * fails. No dependencies, no network, no filesystem writes: `node:` built-ins
 * only.
 *
 * WHY THE RUNNER IS SPLIT IN TWO: the acceptance criteria require proof that the
 * output is byte-identical across runs. A suite that reads a clock, a temp
 * directory, a PID or a random id cannot offer that proof, so `runStorySuite`
 * below touches NOTHING ambient and the runner only ever prints what it returns.
 * Determinism is then an observable property of the program rather than a claim
 * about it. (Two sibling suites in this build shipped flakes; this one refuses
 * to have the opportunity.)
 *
 * The assertions deliberately mirror the task's acceptance list (a)-(h).
 */

import {
  CONFLICT_MARKERS,
  DEFAULT_CONFLICT_BY_SEC,
  DEFAULT_HOOK_SECONDS,
  DEFAULT_REVERSAL_EVERY_SEC,
  HOOK_TYPES,
  SCENERY_MARKERS,
  STORY_BEATS,
  STORY_BRIEF_OVERLAY,
  STORY_SCHEMA_ADDITIONS,
  VALUE_CHARGES,
  addedSchemaFields,
  auditHook,
  auditPacing,
  auditScenes,
  auditStory,
  buildStoryBrief,
  mergeSchemaAdditions,
  proposeStructure,
  readEpisodeShots,
  validateStructure,
} from '../lib/host/story.js'
import { normalizeStageContent } from '../lib/host/stages.js'

/* ------------------------------------------------------------------ runner */

/**
 * Execute the suite and return its lines. PURE: no I/O, no clock, no randomness,
 * no process accessor — everything the output depends on is either a literal in
 * this file or a value returned by the module under test.
 *
 * @returns {{ lines: string[], failures: string[], passed: number, total: number }}
 */
export function runStorySuite() {
  const lines = []
  const failures = []
  let passed = 0

  /** @param {string} label @param {unknown} condition @param {unknown} [detail] */
  const ok = (label, condition, detail) => {
    if (condition) {
      passed += 1
      lines.push(`PASS  ${label}`)
    } else {
      failures.push(label)
      lines.push(`FAIL  ${label}${detail === undefined ? '' : `  -> ${format(detail)}`}`)
    }
  }

  /** @param {string} label @param {unknown} actual @param {unknown} expected */
  const eq = (label, actual, expected) => {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    ok(label, a === b, `actual=${a} expected=${b}`)
  }

  /** @param {string} label @param {unknown} value */
  const section = (label, value) => {
    lines.push('')
    lines.push(`# ${label}`)
    void value
  }

  /* ======================= fixtures ======================= */

  /**
   * A deliberately PERFECT story. This is the positive control (h): if the
   * validator cannot say yes to this, it is not validating, it is just refusing.
   */
  const perfectStory = {
    title: '退婚后我成了首富',
    logline: '被逐出家门的赘婿林越，靠一手操盘术在三十天内买回自己被夺走的一切。',
    theme: '尊严只能靠自己挣回来。',
    controllingIdea: '尊严只能靠自己挣回来。',
    acts: [
      { no: 1, name: '第一幕：退婚', summary: '林越被赶出苏家。', turningPoint: '他签下三十天之约，主动走进对手的局。' },
      { no: 2, name: '第二幕：反攻', summary: '林越拿到第一笔本金。', turningPoint: '他发现救自己的正是当年被他放过的人。' },
      { no: 3, name: '第三幕：开盘', summary: '林越买回公司。', turningPoint: '他在董事会上放弃清算，选择重建。' },
    ],
    beats: [
      { id: 'inciting', name: '激励事件', position: 0.06, purpose: '苏家当众退婚，林越被赶出家门。' },
      { id: 'act1-turn', name: '第一幕转折点', position: 0.2, purpose: '他立下三十天之约。' },
      { id: 'midpoint', name: '中点反转', position: 0.5, purpose: '他发现冻结他账户的人另有其人。' },
      { id: 'crisis', name: '危机', position: 0.8, purpose: '救公司就要毁掉唯一相信他的人。' },
      { id: 'climax', name: '高潮', position: 0.92, purpose: '他在开盘日按下了那个键。' },
      {
        id: 'resolution',
        name: '结局',
        position: 0.98,
        purpose: '他买回公司，却把董事席位让了出去。',
        answer: '因为最后选择了不向任何人证明自己，他得到的不是苏家的承认，而是不再需要承认的自由——尊严只能靠自己挣回来。',
      },
    ],
  }

  // A conflict-first opening in the first shot (compliant).
  // NOTE: the child scenes are shared with `goodScript` below so the two
  // fixtures cannot drift apart — `auditStory` takes a SCRIPT (`{episodes:[…]}`)
  // while `auditHook` takes an EPISODE.
  const goodScenes = [
    {
      no: 1,
      slug: 'INT. 苏家餐厅 - 夜',
      location: '苏家餐厅',
      time: '夜',
      characters: ['林越', '苏建国'],
      action: '苏建国把离婚协议摔在林越面前，逼他当场签字。',
      valuePair: '尊严/屈辱',
      valueEntry: '尊严',
      valueExit: '屈辱',
      durationSec: 30,
      shots: [
        {
          no: 1,
          shot: '中景',
          camera: '低机位缓推',
          description: '苏建国把离婚协议摔在转盘上，推过桌面。',
          motion: '他抬手砸下协议，镜头随之前推。',
          durationSeconds: 3,
          beatId: 'inciting',
          hookCue: '她把离婚协议推过桌面。',
        },
        {
          no: 2,
          shot: '近景',
          camera: '胸口高度轻推',
          description: '林越看向苏建国。',
          motion: '他缓慢抬起头。',
          durationSeconds: 4,
          beatId: 'inciting',
        },
      ],
    },
    {
      no: 2,
      slug: 'EXT. 苏家大门 - 夜',
      location: '苏家大门',
      time: '夜',
      characters: ['林越'],
      action: '林越被赶出门，回头看了一眼那扇门。',
      valuePair: '希望/绝望',
      valueEntry: '绝望',
      valueExit: '希望',
      reversal: true,
      durationSec: 55,
      shots: [
        {
          no: 1,
          shot: '全景',
          camera: '门外固定机位',
          description: '门在他身后关上，他站在雨里。',
          motion: '他往前迈了一步，停住。',
          durationSeconds: 5,
          beatId: 'act1-turn',
        },
      ],
    },
  ]

  const goodEpisode = {
    no: 1,
    title: '第 1 集：退婚书',
    hookType: 'conflict-open',
    hookCue: '她把离婚协议推过桌面，同时按下了录音笔。',
    reversalPoints: [25, 52],
    scenes: goodScenes,
  }

  /** The same episode inside the script wrapper `auditStory` expects. */
  const goodScript = { episodes: [goodEpisode] }

  /* ============ (a)+(h) validateStructure accept / reject ============ */

  section('(a) validateStructure: accepts well-formed, rejects missing 激励事件', null)

  const perfect = validateStructure(perfectStory)
  ok('(h) positive control: a deliberately perfect story is accepted', perfect.ok === true,
    perfect.issues.filter(issue => issue.severity === 'error'))
  ok('(h) positive control has zero error-severity issues',
    perfect.issues.every(issue => issue.severity !== 'error'),
    perfect.issues.filter(issue => issue.severity === 'error'))
  ok('(h) positive control scores 100', perfect.score === 100, perfect.score)
  ok('(a) every canonical beat is reported present',
    perfect.beats.length === STORY_BEATS.length && perfect.beats.every(row => row.present), perfect.beats)

  const noInciting = {
    ...perfectStory,
    beats: perfectStory.beats.filter(beat => beat.id !== 'inciting'),
  }
  const missing = validateStructure(noInciting)
  ok('(a) a story missing 激励事件 is rejected', missing.ok === false, missing.issues)
  ok('(a) the rejection names beat-missing with error severity',
    missing.issues.some(issue => issue.code === 'beat-missing' && issue.severity === 'error'),
    missing.issues.map(issue => `${issue.severity}/${issue.code}`))
  ok('(a) the rejection carries an actionable fix',
    missing.issues.every(issue => typeof issue.fix === 'string' && issue.fix.length > 10),
    missing.issues)
  ok('(a) the missing beat is reported as absent',
    missing.beats.find(row => row.id === 'inciting')?.present === false)

  /* ================= (b) window violations & severity ================= */

  section('(b) beat outside its window is flagged with the right severity', null)

  // 激励事件 at 40% — outside 0..12%, and research §四 makes that an ERROR.
  const lateInciting = {
    ...perfectStory,
    beats: perfectStory.beats.map(beat =>
      beat.id === 'inciting' ? { ...beat, position: 0.4 } : beat),
  }
  const late = validateStructure(lateInciting)
  const lateIssue = late.issues.find(issue => issue.code === 'beat-out-of-window')
  ok('(b) a late 激励事件 is flagged', lateIssue !== undefined, late.issues)
  ok('(b) the late 激励事件 issue is an ERROR (retention-critical beat)',
    lateIssue?.severity === 'error', lateIssue)
  ok('(b) reporting it makes the story not-ok', late.ok === false)
  ok('(b) the issue message states the actual position and the window',
    typeof lateIssue?.message === 'string' && lateIssue.message.includes('40%') && lateIssue.message.includes('12%'),
    lateIssue?.message)

  // 第一幕转折点 at 40% — outside 12..30%, but craft convention → WARNING.
  const lateTurn = {
    ...perfectStory,
    beats: perfectStory.beats.map(beat =>
      beat.id === 'act1-turn' ? { ...beat, position: 0.4 } : beat),
  }
  const turn = validateStructure(lateTurn)
  const turnIssue = turn.issues.find(issue => issue.code === 'beat-out-of-window')
  ok('(b) an out-of-window 第一幕转折点 is flagged WARNING, not error',
    turnIssue?.severity === 'warning', turnIssue)
  ok('(b) a warning alone does not make the story not-ok', turn.ok === true, turn.issues)
  ok('(b) a warning still lowers the score below a perfect one',
    turn.score < perfect.score && turn.score > 0, { turn: turn.score, perfect: perfect.score })

  // A beat exactly on the boundary is inside (no off-by-one failure).
  const onBoundary = {
    ...perfectStory,
    beats: perfectStory.beats.map(beat =>
      beat.id === 'inciting' ? { ...beat, position: 0.12 } : beat),
  }
  ok('(b) a beat exactly on the window edge is NOT flagged',
    validateStructure(onBoundary).issues.every(issue => issue.code !== 'beat-out-of-window'),
    validateStructure(onBoundary).issues)

  /* ==================== (a-cont) theme answered ==================== */

  section('(a-cont) the controlling idea must be answered by the ending', null)

  const unanswered = {
    ...perfectStory,
    beats: perfectStory.beats.map(beat =>
      beat.id === 'resolution' ? { id: 'resolution', name: '结局', position: 0.98, purpose: '大家各自散去。' } : beat),
  }
  const noAnswer = validateStructure(unanswered)
  ok('(a) an ending that does not answer the theme is rejected', noAnswer.ok === false, noAnswer.issues)
  ok('(a) it is reported as ending-does-not-answer-theme',
    noAnswer.issues.some(issue => issue.code === 'ending-does-not-answer-theme'), noAnswer.issues)

  const noTheme = validateStructure({ ...perfectStory, theme: '', controllingIdea: '' })
  ok('(a) a story with no declared theme is rejected',
    noTheme.ok === false && noTheme.issues.some(issue => issue.code === 'theme-missing'), noTheme.issues)

  /* ======================= (c) value charge ======================= */

  section('(c) auditScenes: a scene that does not turn is flagged, one that does is not', null)

  const flatScene = {
    episodes: [{
      no: 1,
      scenes: [
        {
          no: 1,
          slug: 'INT. 会议室 - 日',
          action: '两个人继续讨论预算。',
          valuePair: '希望/绝望',
          valueEntry: '希望',
          valueExit: '希望',
        },
      ],
    }],
  }
  const flatRows = auditScenes(flatScene)
  eq('(c) flat entry==exit is reported as turns:false',
    flatRows.map(row => row.turns), [false])
  ok('(c) the flat scene message explains there is no reason for it to exist',
    flatRows[0].message.includes('没有翻转'), flatRows[0].message)
  eq('(c) the value axis is echoed back',
    flatRows[0].value, '希望/绝望')

  const turningScene = {
    episodes: [{
      no: 1,
      scenes: [
        {
          no: 1,
          slug: 'INT. 会议室 - 日',
          action: '她终于摊牌。',
          valuePair: '希望/绝望',
          valueEntry: '希望',
          valueExit: '绝望',
        },
      ],
    }],
  }
  const turningRows = auditScenes(turningScene)
  eq('(c) opposite entry/exit is reported as turns:true',
    turningRows.map(row => row.turns), [true])

  // The positive control's own scenes must pass the same audit.
  ok('(c) the positive control\u2019s scenes all turn',
    auditScenes(goodEpisode).every(row => row.turns === true), auditScenes(goodEpisode))

  // An undeclared scene is NOT measured (and must not be silently failed).
  const undeclared = auditScenes({ episodes: [{ no: 1, scenes: [{ no: 1, action: '他走进房间。' }] }] })
  ok('(c) an undeclared scene yields turns:true but value:"" (not measured, not failed)',
    undeclared.length === 1 && undeclared[0].turns === true && undeclared[0].value === '',
    undeclared)
  ok('(c) the undeclared case says so in its message',
    undeclared[0].message.includes('未声明'), undeclared[0].message)

  // A flat scene must also surface through validateStructure.
  const flatStory = { ...perfectStory, episodes: flatScene.episodes }
  const flatReport = validateStructure(flatStory)
  ok('(c) validateStructure surfaces the flat scene as a warning',
    flatReport.issues.some(issue => issue.code === 'scene-flat' && issue.severity === 'warning'),
    flatReport.issues.map(issue => issue.code))

  /* ======================= (d) hook audit ======================= */

  section('(d) auditHook: rejects scenery opening, accepts conflict opening', null)

  const sceneryEpisode = {
    no: 1,
    title: '第 1 集',
    hookType: 'conflict-open',
    scenes: [{
      no: 1,
      slug: 'EXT. 城市 - 晨',
      location: '城市',
      time: '晨',
      action: '清晨的阳光洒进城市，镜头缓缓推进，航拍街道与车流。',
      durationSec: 40,
      shots: [
        {
          no: 1,
          shot: '大远景',
          camera: '航拍',
          description: '清晨的城市全景，阳光洒进楼群。',
          motion: '镜头缓缓推进。',
          durationSeconds: 6,
        },
      ],
    }],
  }
  const sceneryAudit = auditHook(sceneryEpisode)
  ok('(d) an episode that opens on scenery is rejected', sceneryAudit.ok === false, sceneryAudit)
  ok('(d) the failure is coded opening-is-scenery with error severity',
    sceneryAudit.issues.some(issue => issue.code === 'opening-is-scenery' && issue.severity === 'error'),
    sceneryAudit.issues.map(issue => `${issue.severity}/${issue.code}`))
  ok('(d) the scenery names the markers it matched',
    sceneryAudit.issues.some(issue => /清晨|阳光|航拍/.test(issue.message)), sceneryAudit.issues)

  const conflictAudit = auditHook(goodEpisode)
  ok('(d) a conflict-first opening is accepted', conflictAudit.ok === true, conflictAudit)
  ok('(d) the accepted episode reports when its first conflict lands',
    conflictAudit.firstConflictAt === 0, conflictAudit.firstConflictAt)

  const noShots = auditHook({ no: 1, title: '空集' })
  ok('(d) an episode with no shots is rejected rather than passing vacuously',
    noShots.ok === false && noShots.issues.some(issue => issue.code === 'opening-missing'), noShots)

  // 冲突前置 (research §四 corroboration): the conflict marker must be at the
  // FRONT. Here shot 1 is a 12-second establishing beat with NO conflict and the
  // conflict lands in shot 2 at 12s — the 冲突前置 failure, which is distinct
  // from the scenery failure and must not be conflated with it.
  const delayedEpisode = {
    no: 1,
    title: '第 1 集',
    hookType: 'conflict-open',
    scenes: [{
      no: 1,
      slug: 'INT. 办公室 - 日',
      action: '他整理桌面。',
      durationSec: 40,
      shots: [
        { no: 1, shot: '中景', camera: '固定机位', description: '他走进办公室，把钥匙放在桌上。', motion: '他走到桌边。', durationSeconds: 12 },
        { no: 2, shot: '近景', camera: '轻推', description: '同事推门进来，把文件摔在桌上，两人争执起来。', motion: '他把文件摔下。', durationSeconds: 8 },
        { no: 3, shot: '特写', camera: '轻推', description: '他看着桌上的照片。', motion: '他拿起照片。', durationSeconds: 5 },
      ],
    }],
  }
  const delayedAudit = auditHook(delayedEpisode)
  const frontIssue = delayedAudit.issues.find(issue => issue.code === 'conflict-not-front-loaded')
  ok('(d) 冲突前置: a conflict that first appears at 12s is REJECTED',
    delayedAudit.ok === false && frontIssue !== undefined,
    { ok: delayedAudit.ok, first: delayedAudit.firstConflictAt, issues: delayedAudit.issues.map(issue => issue.code) })
  ok('(d) the front-loading issue reports the real second (12s)',
    typeof frontIssue?.message === 'string' && frontIssue.message.includes('12'), frontIssue?.message)
  ok('(d) the front-loading fix tells the writer which shot to move',
    typeof frontIssue?.fix === 'string' && frontIssue.fix.includes('第 2 镜'), frontIssue?.fix)
  ok('(d) the delayed episode does NOT trip the scenery rule (a conflict IS in the window)',
    delayedAudit.issues.every(issue => issue.code !== 'opening-is-scenery'),
    delayedAudit.issues.map(issue => issue.code))
  ok('(d) firstConflictAt records the arrival second',
    delayedAudit.firstConflictAt === 12, delayedAudit.firstConflictAt)

  // A neutral opening with NO conflict anywhere is the OTHER failure: it must be
  // reported as scenery/absent, never as "the conflict is too late".
  const neutralOnly = {
    no: 1,
    title: '第 1 集',
    hookType: 'conflict-open',
    scenes: [{
      no: 1,
      slug: 'INT. 办公室 - 日',
      action: '他整理桌面。',
      durationSec: 40,
      shots: [
        { no: 1, shot: '中景', camera: '固定机位', description: '他走进办公室，放下钥匙。', motion: '他走到桌边。', durationSeconds: 10 },
        { no: 2, shot: '特写', camera: '轻推', description: '他看着桌上的照片。', motion: '他拿起照片。', durationSeconds: 10 },
      ],
    }],
  }
  const neutralAudit = auditHook(neutralOnly)
  ok('(d) an opening with no conflict at all is reported as scenery, not as "late"',
    neutralAudit.issues.some(issue => issue.code === 'opening-is-scenery')
      && neutralAudit.issues.some(issue => issue.code === 'conflict-absent')
      && neutralAudit.issues.every(issue => issue.code !== 'conflict-not-front-loaded'),
    neutralAudit.issues.map(issue => issue.code))

  // The 冲突前置 threshold must be a parameter, like the pacing interval.
  ok('(d) conflictBySec defaults to 3s (parameter, not a hardcoded constant)',
    conflictAudit.conflictBySec === DEFAULT_CONFLICT_BY_SEC && DEFAULT_CONFLICT_BY_SEC === 3,
    DEFAULT_CONFLICT_BY_SEC)
  const relaxed = auditHook(delayedEpisode, { conflictBySec: 15 })
  ok('(d) raising conflictBySec lets the same episode pass (the threshold is tunable)',
    relaxed.ok === true && relaxed.firstConflictAt === 12, relaxed.issues)

  /* ======================= (e) pacing ======================= */

  section('(e) auditPacing: 90s gap flagged at 30s interval, 25s passes', null)

  const longGap = {
    episodes: [{
      no: 1,
      reversalPoints: [10, 100],
      scenes: [{ no: 1, durationSec: 100, shots: [{ no: 1, durationSeconds: 100 }] }],
    }],
  }
  const longGapAudit = auditPacing(longGap, { reversalEverySec: 30, shotSeconds: 5 })
  const gapIssue = longGapAudit.issues.find(issue => issue.code === 'gap-too-long')
  ok('(e) a 90-second gap at a 30-second interval is flagged', longGapAudit.ok === false, longGapAudit.issues)
  ok('(e) the flagged gap is exactly 90 seconds', gapIssue?.message.includes('90'), gapIssue?.message)
  ok('(e) the flag is an error at 3× the interval', gapIssue?.severity === 'error', gapIssue?.severity)
  ok('(e) the diagnosis says how many reversals to add',
    typeof gapIssue?.fix === 'string' && gapIssue.fix.includes('补 2 个反转点'), gapIssue?.fix)
  eq('(e) the per-gap report marks the 90s span as not ok',
    longGapAudit.episodes[0].gaps.filter(gap => gap.ok === false).map(gap => gap.seconds), [90])
  eq('(e) missingReversals counts the beats that should have been there',
    longGapAudit.episodes[0].missingReversals, 2)

  const shortGap = {
    episodes: [{
      no: 1,
      reversalPoints: [25, 50],
      scenes: [{ no: 1, durationSec: 60, shots: [{ no: 1, durationSeconds: 60 }] }],
    }],
  }
  const shortGapAudit = auditPacing(shortGap, { reversalEverySec: 30, shotSeconds: 5 })
  ok('(e) a 25-second gap passes at a 30-second interval', shortGapAudit.ok === true, shortGapAudit.issues)
  eq('(e) no gap in the compliant episode is marked not-ok',
    shortGapAudit.episodes[0].gaps.filter(gap => !gap.ok).length, 0)

  // The interval is a PARAMETER: the same gap flips with the threshold.
  // NOTE the boundary is INCLUSIVE (`seconds > interval`), so a 45s gap at a 45s
  // interval passes and at 44s fails — asserted both ways rather than assumed.
  const midGap = {
    episodes: [{
      no: 1,
      reversalPoints: [45, 90],
      scenes: [{ no: 1, durationSec: 90, shots: [{ no: 1, durationSeconds: 90 }] }],
    }],
  }
  ok('(e) a 45-second gap passes at a 60-second interval',
    auditPacing(midGap, { reversalEverySec: 60 }).ok === true,
    auditPacing(midGap, { reversalEverySec: 60 }).issues)
  ok('(e) a 45-second gap passes at EXACTLY a 45-second interval (boundary is inclusive)',
    auditPacing(midGap, { reversalEverySec: 45 }).ok === true,
    auditPacing(midGap, { reversalEverySec: 45 }).issues)
  // 45s is 1.5× the interval: past the threshold but under the 2× error ratio, so
  // it is reported as a WARNING — and `ok` is driven by errors only, matching the
  // documented "ok:false only for errors" contract.
  const midAt30 = auditPacing(midGap, { reversalEverySec: 30 })
  ok('(e) the SAME 45-second gap at a 30-second interval is flagged (warning, 1.5×)',
    midAt30.issues.some(issue => issue.code === 'gap-too-long' && issue.severity === 'warning'),
    midAt30.issues.map(issue => `${issue.severity}/${issue.code}`))
  ok('(e) 1.5× the interval is a warning, so `ok` stays true (errors drive ok)',
    midAt30.ok === true && midAt30.episodes[0].ok === false, midAt30)
  // 3× the interval IS an error, and that is what flips `ok`.
  ok('(e) the SAME 45-second gap at a 15-second interval is an ERROR (3×)',
    auditPacing(midGap, { reversalEverySec: 15 }).issues
      .some(issue => issue.code === 'gap-too-long' && issue.severity === 'error')
      && auditPacing(midGap, { reversalEverySec: 15 }).ok === false,
    auditPacing(midGap, { reversalEverySec: 15 }).issues)
  ok('(e) the SAME 45-second gap fails the PER-EPISODE check at a 44-second interval',
    auditPacing(midGap, { reversalEverySec: 44 }).episodes[0].ok === false)
  ok('(e) reversalEverySec defaults to 30 (research §四), reported in the result',
    auditPacing(shortGap).reversalEverySec === DEFAULT_REVERSAL_EVERY_SEC
      && DEFAULT_REVERSAL_EVERY_SEC === 30, auditPacing(shortGap).reversalEverySec)

  // A long tail after the last reversal must be caught, not hidden.
  const tail = {
    episodes: [{
      no: 1,
      reversalPoints: [30],
      scenes: [{ no: 1, durationSec: 180, shots: [{ no: 1, durationSeconds: 180 }] }],
    }],
  }
  const tailAudit = auditPacing(tail, { reversalEverySec: 30 })
  ok('(e) a 150-second tail after the last reversal is caught',
    tailAudit.ok === false
      && tailAudit.episodes[0].gaps.some(gap => gap.seconds === 150 && gap.ok === false),
    tailAudit.episodes[0].gaps)

  // An episode with no declared reversals at all must be flagged, not assumed fine.
  const undeclaredReversals = auditPacing({
    episodes: [{ no: 1, scenes: [{ no: 1, durationSec: 120, shots: [{ no: 1, durationSeconds: 120 }] }] }],
  })
  ok('(e) a long episode with no reversalPoints is flagged as unverifiable',
    undeclaredReversals.issues.some(issue => issue.code === 'reversals-undeclared'),
    undeclaredReversals.issues.map(issue => issue.code))

  /* ===================== (f) proposeStructure ===================== */

  section('(f) proposeStructure: monotonic offsets that fit the runtime', null)

  const plan = proposeStructure({
    logline: '赘婿三十天买回公司',
    genre: '都市逆袭',
    episodes: 3,
    shotSeconds: 5,
  })

  eq('(f) every canonical beat is present exactly once',
    plan.beats.map(beat => beat.id), STORY_BEATS.map(beat => beat.id))
  ok('(f) second offsets are strictly monotonic',
    plan.beats.every((beat, index) => index === 0 || beat.atSecond > plan.beats[index - 1].atSecond),
    plan.beats.map(beat => beat.atSecond))
  ok('(f) every offset fits inside the total runtime',
    plan.beats.every(beat => beat.atSecond >= 0 && beat.atSecond <= plan.totalSeconds),
    { total: plan.totalSeconds, at: plan.beats.map(beat => beat.atSecond) })
  ok('(f) every position sits inside its own canonical window',
    plan.beats.every(beat => {
      const canonical = STORY_BEATS.find(item => item.id === beat.id)
      return beat.position >= canonical.positionMin && beat.position <= canonical.positionMax
    }),
    plan.beats.map(beat => `${beat.id}:${beat.position}`))
  ok('(f) the 激励事件 lands in the first 12%',
    plan.beats[0].id === 'inciting' && plan.beats[0].position <= 0.12,
    plan.beats[0])

  ok('(f) the episode plan covers the whole runtime without gaps',
    plan.episodePlan.length === 3
      && plan.episodePlan[0].startSecond === 0
      && plan.episodePlan.every((episode, index) =>
        index === 0 || episode.startSecond === plan.episodePlan[index - 1].endSecond),
    plan.episodePlan)
  ok('(f) the last episode ends exactly at the total runtime',
    plan.episodePlan[plan.episodePlan.length - 1].endSecond === plan.totalSeconds,
    plan.episodePlan)

  ok('(f) reversalPoint arrays are ascending and inside their episode',
    plan.episodePlan.every(episode =>
      episode.reversalPoints.every((point, index) =>
        (index === 0 || point > episode.reversalPoints[index - 1]) && point > 0 && point < episode.seconds)),
    plan.episodePlan.map(episode => episode.reversalPoints))
  ok('(f) reversal gaps never exceed the declared interval',
    plan.episodePlan.every(episode => {
      const timeline = [0, ...episode.reversalPoints, episode.seconds]
      return timeline.every((point, index) => index === 0 || point - timeline[index - 1] <= plan.reversalEverySec + 1e-6)
    }),
    plan.episodePlan.map(episode => episode.reversalPoints))
  ok('(f) every suggested hookType is a real hook type',
    plan.episodePlan.every(episode => HOOK_TYPES.some(hook => hook.id === episode.hookType)),
    plan.episodePlan.map(episode => episode.hookType))
  ok('(f) the first episode is suggested a cold-open hook',
    plan.episodePlan[0].hookType === 'conflict-open', plan.episodePlan[0].hookType)
  ok('(f) the final episode is told to resolve, not to tease',
    plan.episodePlan[2].hookSuggestion.includes('不吊悬念'), plan.episodePlan[2].hookSuggestion)
  ok('(f) a suggested scene count is produced',
    Number.isInteger(plan.sceneCount) && plan.sceneCount >= plan.episodes * 2, plan.sceneCount)

  // Degenerate inputs must still yield a structurally valid skeleton.
  const single = proposeStructure({ episodes: 1, shotSeconds: 5 })
  ok('(f) a 1-episode plan still produces a valid, monotonic skeleton',
    single.episodes === 1
      && single.beats.every((beat, index) => index === 0 || beat.atSecond > single.beats[index - 1].atSecond)
      && single.beats.every(beat => beat.atSecond <= single.totalSeconds),
    single.beats.map(beat => beat.atSecond))
  const empty = proposeStructure()
  ok('(f) proposeStructure() with no input is total and never throws',
    empty.beats.length === STORY_BEATS.length && empty.totalSeconds > 0, empty)

  /* ============ (g) THE INTEGRATION PROOF: real normalizer ============ */

  section('(g) every added schema field survives a REAL normalizeStageContent round-trip', null)

  const added = addedSchemaFields()
  ok('(g) the module declares added fields for both stages',
    Array.isArray(added.story) && added.story.length > 0
      && Array.isArray(added.script) && added.script.length > 0, added)
  ok('(g) the added field list covers the documented core fields',
    ['beats', 'controllingIdea'].every(name => added.story.includes(name))
      && ['hookType', 'reversalPoints', 'valuePair', 'valueEntry', 'valueExit', 'beatId', 'hookCue']
        .every(name => added.script.includes(name)),
    added)

  // A payload that exercises EVERY added field, in the shape the brief asks for.
  const storyPayload = {
    title: perfectStory.title,
    theme: perfectStory.theme,
    controllingIdea: perfectStory.controllingIdea,
    acts: perfectStory.acts,
    beats: perfectStory.beats,
  }
  const scriptPayload = {
    title: '退婚后我成了首富',
    episodes: [{
      no: 1,
      title: '第 1 集：退婚书',
      hook: '数字开始狂跳。',
      hookType: 'conflict-open',
      reversalPoints: [25, 52],
      scenes: [{
        no: 1,
        slug: 'INT. 苏家餐厅 - 夜',
        location: '苏家餐厅',
        time: '夜',
        characters: ['林越', '苏建国'],
        action: '苏建国把离婚协议摔在林越面前。',
        valuePair: '尊严/屈辱',
        valueEntry: '尊严',
        valueExit: '屈辱',
        durationSec: 30,
        dialogue: [{ who: '苏建国', line: '签了它。' }],
        shots: [{
          no: 1,
          shot: '中景',
          camera: '低机位缓推',
          description: '协议被摔在转盘上。',
          motion: '他抬手砸下协议。',
          beatId: 'inciting',
          hookCue: '她把离婚协议推过桌面。',
        }],
      }],
    }],
  }

  // THE REAL NORMALIZER — imported from stages.js, never re-implemented here.
  const normalizedStory = normalizeStageContent('story', storyPayload)
  const normalizedScript = normalizeStageContent('script', scriptPayload)

  for (const name of added.story) {
    ok(`(g) story.${name} survives normalizeStageContent`,
      normalizedStory !== null && typeof normalizedStory === 'object'
        && Object.hasOwn(normalizedStory, name)
        && JSON.stringify(normalizedStory[name]) === JSON.stringify(storyPayload[name]),
      { name, got: normalizedStory?.[name] })
  }

  // The script stage is normalized into `{ ...wrapper, shots }`; nested records
  // (episodes / scenes / shots) keep their extras, so fields are asserted at the
  // level the schema actually places them.
  const normalizedEpisode = normalizedScript.episodes?.[0]
  const normalizedScene = normalizedEpisode?.scenes?.[0]
  const normalizedShot = normalizedScript.shots?.[0]

  const scriptFieldHome = new Map([
    ['hookType', ['episode', normalizedEpisode]],
    ['reversalPoints', ['episode', normalizedEpisode]],
    ['valuePair', ['scene', normalizedScene]],
    ['valueEntry', ['scene', normalizedScene]],
    ['valueExit', ['scene', normalizedScene]],
    ['beatId', ['shot', normalizedShot]],
    ['hookCue', ['shot', normalizedShot]],
  ])

  for (const name of added.script) {
    const home = scriptFieldHome.get(name)
    if (home === undefined) {
      ok(`(g) script.${name} has a known normalization home`, false, { name, added: added.script })
      continue
    }
    const [, node] = home
    ok(`(g) script.${name} survives normalizeStageContent (on ${home[0]})`,
      node !== undefined && node !== null && Object.hasOwn(node, name), { name, node })
  }

  // Values — not just key presence — must round-trip unchanged.
  eq('(g) story beat positions survive with their values',
    normalizedStory.beats.map(beat => beat.position),
    storyPayload.beats.map(beat => beat.position))
  eq('(g) story 结局 answer survives',
    normalizedStory.beats[normalizedStory.beats.length - 1].answer,
    storyPayload.beats[storyPayload.beats.length - 1].answer)
  eq('(g) episode reversalPoints survive as numbers',
    normalizedEpisode.reversalPoints, [25, 52])
  eq('(g) scene valueEntry/valueExit survive',
    [normalizedScene.valueEntry, normalizedScene.valueExit], ['尊严', '屈辱'])
  eq('(g) shot beatId/hookCue survive',
    [normalizedShot.beatId, normalizedShot.hookCue], ['inciting', '她把离婚协议推过桌面。'])

  // The normalizer must still do its OWN job on the extended payload: the whole
  // point is to add fields WITHOUT breaking what it already normalizes.
  eq('(g) the normalizer still flattens the episode tree into shots',
    normalizedScript.shots.length, 1)
  ok('(g) the flattened shot still carries its scene context',
    normalizedScript.shots[0].sceneId === 'scene-int-苏家餐厅-夜'
      || normalizedScript.shots[0].sceneId.startsWith('scene-'),
    normalizedScript.shots[0].sceneId)
  ok('(g) the flattened shot still carries the scene dialogue',
    normalizedScript.shots[0].dialogue.includes('签了它'), normalizedScript.shots[0].dialogue)
  ok('(g) the normalizer still assigned canonical shot fields',
    normalizedScript.shots[0].seq === 1
      && typeof normalizedScript.shots[0].durationSeconds === 'number'
      && typeof normalizedScript.shots[0].status === 'string',
    normalizedScript.shots[0])
  // An episode WITHOUT `scenes` is dropped by flattenScriptShots (it reads
  // `episode.scenes` directly). The brief therefore requires `scenes`; this
  // asserts the hazard is real so the requirement is not cargo cult.
  const noScenes = normalizeStageContent('script', { episodes: [{ no: 1, title: '无场次', hookType: 'question' }] })
  eq('(g) DOCUMENTED HAZARD: an episode without `scenes` produces no shots',
    noScenes.shots.length, 0)

  // An agent that hands its payload back as a JSON STRING must survive too.
  const stringPayload = normalizeStageContent('script', JSON.stringify(scriptPayload))
  eq('(g) a JSON-string payload the agent stringified still round-trips the added fields',
    [stringPayload.episodes[0].hookType, stringPayload.episodes[0].scenes[0].valueEntry, stringPayload.shots[0].beatId],
    ['conflict-open', '尊严', 'inciting'])

  /* ============ (g-cont) schema additions are actually emitted ============ */

  section('(g-cont) the brief emits the schema additions into a valid JSON schema', null)

  // A miniature of the REAL script schema (same nesting the brief uses), built
  // programmatically so the fixture cannot drift out of balance by hand.
  const scriptSchemaFixture = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      episodes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            no: { type: 'integer' },
            // NO hookType/reversalPoints here: the merge must add them.
            scenes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  no: { type: 'integer' },
                  shots: {
                    type: 'array',
                    items: { type: 'object', properties: { no: { type: 'integer' } } },
                  },
                },
              },
            },
          },
        },
      },
    },
    required: ['title', 'episodes'],
  }

  const brief = buildStoryBrief('script', {
    base: {
      system: '你是短剧分场编剧。',
      task: '阶段：分场脚本。',
      schema: JSON.stringify(scriptSchemaFixture),
    },
  })

  let parsedBrief
  let parseFailed = false
  try {
    parsedBrief = JSON.parse(brief.schema)
  } catch {
    parseFailed = true
  }
  ok('(g-cont) the merged script schema is still valid JSON', parseFailed === false, brief.schema)
  ok('(g-cont) the original schema fields are preserved',
    parseFailed === false
      && parsedBrief.properties.title !== undefined
      && parsedBrief.properties.episodes.items.properties.no !== undefined, parsedBrief?.properties)

  const mergedEpisodes = parsedBrief?.properties?.episodes?.items?.properties ?? {}
  const mergedScenes = mergedEpisodes.scenes?.items?.properties ?? {}
  const mergedShots = mergedScenes.shots?.items?.properties ?? {}
  ok('(g-cont) hookType/reversalPoints reach episodes[].properties',
    mergedEpisodes.hookType !== undefined && mergedEpisodes.reversalPoints !== undefined,
    Object.keys(mergedEpisodes))
  ok('(g-cont) valuePair/valueEntry/valueExit reach scenes[].properties',
    mergedScenes.valuePair !== undefined && mergedScenes.valueEntry !== undefined && mergedScenes.valueExit !== undefined,
    Object.keys(mergedScenes))
  ok('(g-cont) beatId/hookCue reach scenes[].shots[].properties',
    mergedShots.beatId !== undefined && mergedShots.hookCue !== undefined, Object.keys(mergedShots))
  ok('(g-cont) `required` was NOT weakened or extended (all additions stay optional)',
    JSON.stringify(parsedBrief?.required) === JSON.stringify(['title', 'episodes'])
      && parsedBrief.properties.episodes.items.required === undefined,
    parsedBrief?.required)

  const storyBrief = buildStoryBrief('story', {
    base: { system: '你是总编剧。', task: '阶段：剧情设计。', schema: JSON.stringify({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }) },
    episodes: 2,
  })
  const parsedStory = JSON.parse(storyBrief.schema)
  ok('(g-cont) beats/controllingIdea reach the story root properties',
    parsedStory.properties.beats !== undefined && parsedStory.properties.controllingIdea !== undefined,
    Object.keys(parsedStory.properties))
  ok('(g-cont) the enum of beats[].id is exactly the canonical beat list',
    JSON.stringify(parsedStory.properties.beats.items.properties.id.enum)
      === JSON.stringify(STORY_BEATS.map(beat => beat.id)),
    parsedStory.properties.beats.items.properties.id.enum)

  // Degradation: a malformed schema must never throw and never lose the original.
  ok('(g-cont) a malformed schema degrades to the original string (never throws)',
    mergeSchemaAdditions('not json at all', 'script') === 'not json at all')
  ok('(g-cont) an unknown stage passes its schema through untouched',
    mergeSchemaAdditions('{"a":1}', 'bible') === '{"a":1}')
  ok('(g-cont) a null schema degrades instead of throwing',
    typeof mergeSchemaAdditions(null, 'story') === 'string')

  /* ============ brief content: the rules must be IN the brief ============ */

  section('brief: the rules the validator enforces are stated to the model', null)

  const task = brief.task
  ok('the script brief states the value-charge rule',
    task.includes('valueEntry') && task.includes('valueExit') && task.includes('必须相反'), task.slice(0, 200))
  ok('the script brief states the reversal interval as a number',
    task.includes(String(DEFAULT_REVERSAL_EVERY_SEC)), task.slice(0, 200))
  ok('the script brief forbids scenery openings explicitly',
    task.includes('禁止环境描写'), task.slice(0, 200))
  ok('the script brief states the 冲突前置 requirement',
    task.includes('前置') && task.includes(String(DEFAULT_CONFLICT_BY_SEC)), task.slice(0, 200))
  ok('the script brief warns that a missing scenes array drops the episode',
    task.includes('scenes'), task.slice(0, 200))
  ok('the story brief carries every canonical beat id',
    STORY_BEATS.every(beat => buildStoryBrief('story').task.includes(beat.id)),
    buildStoryBrief('story').task)
  ok('the story brief states the 12% inciting-incident deadline',
    buildStoryBrief('story').task.includes('12%'), buildStoryBrief('story').task.slice(0, 400))
  ok('the story brief requires an answer on the resolution beat',
    buildStoryBrief('story').task.includes('answer'), buildStoryBrief('story').task)
  ok('the story brief includes computed second offsets when sized',
    storyBrief.task.includes('约第') && storyBrief.structure?.totalSeconds > 0, storyBrief.structure)

  /* ============== overlay shape + catalogue integrity ============== */

  section('STORY_BRIEF_OVERLAY shape (what the Lead wires into prompts.js)', null)

  for (const stageId of ['story', 'script']) {
    const entry = STORY_BRIEF_OVERLAY[stageId]
    ok(`overlay.${stageId} has string systemAddendum/taskAddendum/schemaAddendum`,
      typeof entry?.systemAddendum === 'string' && entry.systemAddendum.length > 0
        && typeof entry?.taskAddendum === 'string' && entry.taskAddendum.length > 0
        && typeof entry?.schemaAddendum === 'string',
      entry)
  }
  ok('overlay keys are exactly the two stages this engine serves',
    JSON.stringify(Object.keys(STORY_BRIEF_OVERLAY).sort()) === JSON.stringify(['script', 'story']),
    Object.keys(STORY_BRIEF_OVERLAY))

  section('catalogue integrity (the tables the whole engine reads)', null)

  ok('STORY_BEATS ids are unique and windows are ordered',
    new Set(STORY_BEATS.map(beat => beat.id)).size === STORY_BEATS.length
      && STORY_BEATS.every(beat => beat.positionMin >= 0 && beat.positionMax <= 1 && beat.positionMin < beat.positionMax),
    STORY_BEATS)
  ok('every canonical beat has a Chinese name and a purpose',
    STORY_BEATS.every(beat => beat.name.length > 0 && beat.purpose.length > 10), STORY_BEATS)
  ok('the six required beats from the spec are all present',
    ['inciting', 'act1-turn', 'midpoint', 'crisis', 'climax', 'resolution'].every(id => STORY_BEATS.some(beat => beat.id === id)),
    STORY_BEATS.map(beat => beat.id))
  ok('beat windows are non-overlapping and ascending',
    STORY_BEATS.every((beat, index) => index === 0 || beat.positionMin >= STORY_BEATS[index - 1].positionMin))
  ok('severity is only ever error|warning',
    STORY_BEATS.every(beat => beat.severity === 'error' || beat.severity === 'warning'))

  ok('the six required hook types from the spec are all present',
    ['reversal-face-slap', 'identity-reveal', 'countdown', 'question', 'visual-impact', 'conflict-open']
      .every(id => HOOK_TYPES.some(hook => hook.id === id)), HOOK_TYPES.map(hook => hook.id))
  ok('every hook type carries whenToUse, examples and a risk',
    HOOK_TYPES.every(hook => hook.whenToUse.length > 5
      && Array.isArray(hook.examples) && hook.examples.length >= 1
      && hook.risk.length > 10), HOOK_TYPES)

  ok('VALUE_CHARGES cover the axes named in the spec',
    ['爱/恨', '自由/奴役', '生/死', '希望/绝望', '真相/谎言'].every(name => VALUE_CHARGES.some(charge => charge.name === name)),
    VALUE_CHARGES.map(charge => charge.name))
  ok('every value axis has both poles and a stable id',
    VALUE_CHARGES.every(charge => charge.id.length > 0 && charge.positive !== charge.negative), VALUE_CHARGES)

  ok('the retention thresholds are parameters with documented defaults',
    DEFAULT_REVERSAL_EVERY_SEC === 30 && DEFAULT_CONFLICT_BY_SEC === 3 && DEFAULT_HOOK_SECONDS === 3,
    { DEFAULT_REVERSAL_EVERY_SEC, DEFAULT_CONFLICT_BY_SEC, DEFAULT_HOOK_SECONDS })

  // The marker lists must actually be able to fire, or the audits are decoration.
  ok('CONFLICT_MARKERS and SCENERY_MARKERS are non-empty and disjoint enough',
    CONFLICT_MARKERS.length >= 10 && SCENERY_MARKERS.length >= 10
      && CONFLICT_MARKERS.every(marker => !SCENERY_MARKERS.includes(marker)),
    { conflict: CONFLICT_MARKERS.length, scenery: SCENERY_MARKERS.length })

  /* ==================== auditStory orchestration ==================== */

  section('auditStory: one call, combined verdict', null)

  const combined = auditStory({ story: perfectStory, script: goodScript }, { shotSeconds: 5 })
  ok('auditStory reports the structural verdict', combined.structure.ok === true, combined.structure.issues)
  ok('auditStory runs a hook audit per episode', combined.hooks.length === 1, combined.hooks)
  ok('auditStory runs the pacing audit', typeof combined.pacing.reversalEverySec === 'number', combined.pacing)
  ok('auditStory runs the scene value audit', Array.isArray(combined.scenes) && combined.scenes.length > 0, combined.scenes)
  ok('auditStory identifies the first conflict second', combined.hooks[0].firstConflictAt === 0, combined.hooks[0])

  // Totality: malformed input must degrade, never throw.
  const hostile = auditStory({ story: 'nonsense', script: 42 })
  ok('auditStory on malformed input returns a report instead of throwing',
    hostile.ok === false && Array.isArray(hostile.issues), hostile)
  ok('auditStory flags a story that declares no conflict at all',
    auditStory({ story: noInciting }, {}).ok === false)

  /* =========================== summary =========================== */

  const total = passed + failures.length
  lines.push('')
  lines.push(`${failures.length === 0 ? 'ALL PASS' : 'FAILURES'}  ${passed}/${total} assertions passed`)
  if (failures.length > 0) {
    for (const label of failures) lines.push(`  - ${label}`)
  }

  return { lines, failures, passed, total }
}

/** Truncate a value for a one-line failure detail. */
function format(value) {
  const rendered = typeof value === 'string' ? value : safeStringify(value)
  return rendered !== undefined && rendered.length > 240 ? `${rendered.slice(0, 240)}…` : rendered
}

/** JSON.stringify that cannot throw (all values here originate from JSON). */
function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/* ---------------------------------------------------------------- main */

const { lines, failures } = runStorySuite()
for (const line of lines) console.log(line)
if (failures.length > 0) process.exitCode = 1
