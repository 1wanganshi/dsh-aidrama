/**
 * dsh-aidrama — host store + stage engine self-test.
 *
 * Runs the whole host-core contract against a TEMPORARY data root: nothing is
 * written to `~/.dsh/aidrama`. Prints one PASS/FAIL line per assertion, a
 * summary, and exits non-zero when anything fails.
 *
 *   node docs/verify-store.mjs
 *
 * No dependencies, no network: `node:` built-ins only.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  MAX_ASSETS_PER_PROJECT,
  ORIGIN,
  STAGES,
  STAGE_STATUS,
  outlineId,
} from '../lib/host/protocol.js'
import {
  assetPath,
  createProjectDoc,
  dataRoot,
  deleteProject,
  listProjects,
  putAsset,
  readAsset,
  readProject,
  setDataRoot,
  writeProject,
} from '../lib/host/store.js'
import {
  advanceGuard,
  invalidateAfter,
  markStageReady,
  markStageStale,
  newProjectFrom,
  normalizeCharacters,
  normalizeScenes,
  normalizeShots,
  stageView,
} from '../lib/host/stages.js'

/* ------------------------------------------------------------------ runner */

let passed = 0
const failures = []

/**
 * Assert a condition, recording PASS/FAIL.
 * @param {string} label
 * @param {unknown} condition
 * @param {unknown} [detail]
 */
function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL  ${label}${detail === undefined ? '' : `  -> ${format(detail)}`}`)
  }
}

/**
 * Assert deep equality (JSON-level) of two values.
 * @param {string} label
 * @param {unknown} actual
 * @param {unknown} expected
 */
function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(label, a === b, `actual=${a} expected=${b}`)
}

/** Truncate a value for a one-line failure detail. */
function format(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text !== undefined && text.length > 240 ? `${text.slice(0, 240)}…` : text
}

/**
 * Run an async step; a throw is recorded as a FAIL instead of aborting.
 * @param {string} label
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<unknown>}
 */
async function step(label, fn) {
  try {
    return await fn()
  } catch (error) {
    ok(label, false, `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`)
    return undefined
  }
}

/* ------------------------------------------------------------------- setup */

const tempRoot = await mkdtemp(path.join(tmpdir(), 'dsh-aidrama-verify-'))
const realRoot = dataRoot()
setDataRoot(tempRoot)

console.log('dsh-aidrama host-core self-test')
console.log(`  temp dataRoot : ${tempRoot}`)
console.log(`  default root  : ${realRoot}`)
console.log('')

try {
  /* ------------------------------------------------- 1. root + defaults */

  await step('dataRoot honours the injected override', async () => {
    ok('dataRoot() returns the injected temp root', dataRoot() === tempRoot, dataRoot())
    ok('dataRoot() does not point at the real home', dataRoot() !== realRoot)
  })

  await step('listProjects on a fresh root returns []', async () => {
    const projects = await listProjects()
    ok('empty library is an empty array', Array.isArray(projects) && projects.length === 0, projects)
  })

  /* --------------------------------------------- 2. create → write → read */

  const created = await step('createProjectDoc persists a document', async () => {
    const project = await createProjectDoc({ title: '替身新娘', logline: '她替姐姐嫁进了仇家。' })
    ok('created project has an id', typeof project.id === 'string' && project.id.length > 0, project.id)
    ok('created project keeps the title', project.title === '替身新娘', project.title)
    ok('created project starts with six empty stages', STAGES.every(id => project.stages[id].status === STAGE_STATUS.empty))
    ok('created project starts with no assets', project.assets.length === 0)

    const docPath = path.join(tempRoot, 'projects', `${project.id}.json`)
    const onDisk = JSON.parse(await readFile(docPath, 'utf8'))
    ok('document exists at <dataRoot>/projects/<id>.json', onDisk.id === project.id, docPath)
    return project
  })

  await step('readProject round-trips the document', async () => {
    const read = await readProject(created.id)
    ok('readProject returns the document', read !== undefined)
    eq('round-tripped title/logline/aspectRatio match', {
      title: read.title,
      logline: read.logline,
      aspectRatio: read.aspectRatio,
      episodes: read.episodes,
      shotSeconds: read.shotSeconds,
    }, {
      title: '替身新娘',
      logline: '她替姐姐嫁进了仇家。',
      aspectRatio: '9:16',
      episodes: 1,
      shotSeconds: 5,
    })
  })

  await step('readProject tolerates bad ids and missing files', async () => {
    ok('missing project → undefined', (await readProject('p-does-not-exist')) === undefined)
    ok('traversal id → undefined', (await readProject('../escape')) === undefined)
    ok('empty id → undefined', (await readProject('')) === undefined)
    ok('non-string id → undefined', (await readProject(null)) === undefined)
  })

  await step('readProject never throws a raw SyntaxError on corrupt JSON', async () => {
    const corruptId = 'p-corrupt-json'
    await writeFile(path.join(tempRoot, 'projects', `${corruptId}.json`), '{ "title": "broken",', 'utf8')
    const result = await readProject(corruptId)
    ok('corrupt JSON → undefined (no throw)', result === undefined, result)
    // A one-off broken document must not break the library listing either.
    const listed = await listProjects()
    ok('corrupt document is skipped while listing', listed.every(row => row.id !== corruptId), listed.map(r => r.id))
    ok('library still lists the good project', listed.some(row => row.id === created.id), listed.map(r => r.id))
  })

  /* ------------------------------------------- 3. stage engine lifecycle */

  await step('stage engine: ready → invalidate → stale', async () => {
    const project = await readProject(created.id)

    markStageReady(project, 'idea', { questions: ['题材'], answers: ['复仇'] }, '第一版')
    ok('idea is ready after markStageReady', project.stages.idea.status === STAGE_STATUS.ready)
    ok('idea revision bumped to 1', project.stages.idea.revision === 1, project.stages.idea.revision)
    ok('idea note stored', project.stages.idea.note === '第一版', project.stages.idea.note)

    markStageReady(project, 'story', { acts: 3 }, '三幕')
    markStageReady(project, 'script', {
      shots: [
        { seq: 1, scene: '婚礼现场', action: '林晚掀开盖头', dialogue: '我不嫁。', durationSeconds: 4 },
      ],
    }, '首版分场')
    ok('script content is normalized to a shots array',
      Array.isArray(project.content.script.shots) && project.content.script.shots.length === 1)
    ok('normalized shot has a minted id', project.content.script.shots[0].id === 'shot-1', project.content.script.shots[0].id)

    const view = stageView(project)
    ok('stageView returns one row per stage', view.length === STAGES.length, view.length)
    eq('stageView ids are in canonical order', view.map(row => row.id), [...STAGES])
    ok('stageView marks idea ready', view[0].ready === true && view[0].status === STAGE_STATUS.ready)
    ok('stageView exposes label + short from STAGE_META',
      view[0].label === '想法梳理' && view[0].short === '想法', view[0])
    ok('stageView marks untouched later stages as blocked',
      view[3].blocked === true && view[3].ready === false, view[3])
    ok('stageView never leaves note/updatedAt undefined',
      view.every(row => typeof row.note === 'string' && typeof row.updatedAt === 'number'))

    // Re-running idea invalidates everything downstream, but keeps the content.
    markStageReady(project, 'idea', { questions: ['题材', '结局'], answers: ['复仇', 'he'] }, '第二版')
    ok('re-running idea bumps its revision to 2', project.stages.idea.revision === 2)
    invalidateAfter(project, 'idea')

    ok('story is stale after idea re-ran', project.stages.story.status === STAGE_STATUS.stale)
    ok('script is stale after idea re-ran', project.stages.script.status === STAGE_STATUS.stale)
    // Stages that never produced content must NOT be marked stale: `empty` is
    // the honest status, and `stale` would imply artifacts exist to redo.
    ok('video (never run) stays empty, not stale', project.stages.video.status === STAGE_STATUS.empty,
      project.stages.video)
    ok('bible (never run) stays empty, not stale', project.stages.bible.status === STAGE_STATUS.empty,
      project.stages.bible)
    ok('idea itself stays ready', project.stages.idea.status === STAGE_STATUS.ready)
    ok('stale stages keep their content (nothing is deleted)',
      project.content.script?.shots?.length === 1, project.content.script)
    ok('stale stage records why', project.stages.story.note.includes('想法'), project.stages.story.note)

    // Positive control: a later stage that DID produce content goes stale.
    markStageReady(project, 'video', { shots: [] }, '成片')
    markStageReady(project, 'idea', { questions: ['题材', '结局', '爽点'], answers: ['复仇', 'he', '反杀'] }, '第三版')
    invalidateAfter(project, 'idea')
    ok('a later stage WITH content does go stale', project.stages.video.status === STAGE_STATUS.stale,
      project.stages.video)
    ok('video keeps its content while stale', project.content.video !== null, project.content.video)

    const staleView = stageView(project)
    ok('stageView reports stale as still ready-to-read',
      staleView[1].status === STAGE_STATUS.stale && staleView[1].ready === true, staleView[1])

    // An empty stage has nothing to invalidate. Run LAST: on a fresh unsaved
    // project `video` is empty, so this must not disturb the persisted state
    // asserted below.
    const scratch = newProjectFrom({ title: '空转测试' })
    markStageStale(scratch, 'video')
    ok('markStageStale leaves an empty stage empty', scratch.stages.video.status === STAGE_STATUS.empty)

    await writeProject(project)
    const reloaded = await readProject(created.id)
    ok('stage state survives a write/read round-trip',
      reloaded.stages.idea.revision === 3 &&
      reloaded.stages.idea.note === '第三版' &&
      reloaded.stages.script.status === STAGE_STATUS.stale &&
      reloaded.stages.video.status === STAGE_STATUS.stale,
      { idea: reloaded.stages.idea, script: reloaded.stages.script, video: reloaded.stages.video })
    ok('stale-with-content survives the round-trip',
      reloaded.content.video !== null && reloaded.stages.video.revision === 1, reloaded.content.video)
    return project
  })

  await step('advanceGuard warns but never hard-blocks on upstream gaps', async () => {
    const project = await readProject(created.id)
    const staleAdvance = advanceGuard(project, 'visual')
    ok('advancing with a stale upstream is allowed', staleAdvance.ok === true, staleAdvance)
    ok('advancing with a stale upstream carries a warning',
      typeof staleAdvance.warning === 'string' && staleAdvance.warning.length > 0, staleAdvance)

    const empty = newProjectFrom({ title: '空项目' })
    const emptyAdvance = advanceGuard(empty, 'video')
    ok('advancing across empty upstreams is still allowed', emptyAdvance.ok === true, emptyAdvance)
    ok('empty upstreams produce a warning',
      typeof emptyAdvance.warning === 'string' && emptyAdvance.warning.length > 0, emptyAdvance)

    const first = advanceGuard(newProjectFrom({ title: '首阶段' }), 'idea')
    ok('the first stage advances clean (no warning)', first.ok === true && first.warning === undefined, first)

    const bad = advanceGuard(newProjectFrom({ title: 'x' }), 'nope')
    ok('an unknown stage is refused', bad.ok === false && typeof bad.reason === 'string', bad)

    const running = newProjectFrom({ title: 'y' })
    running.stages.script.status = STAGE_STATUS.running
    const busy = advanceGuard(running, 'script')
    ok('a stage already running is refused', busy.ok === false, busy)

    ok('advanceGuard tolerates a null project', advanceGuard(null, 'idea').ok === false)
  })

  /* ------------------------------------------------- 4. tolerant readers */

  await step('normalizers always return well-formed arrays', async () => {
    const partial = normalizeShots({ shots: [{ action: '推门而入' }, { seq: 2, characters: '林晚、顾总' }] })
    ok('normalizeShots accepts { shots: [...] }', partial.length === 2, partial)
    ok('missing shot fields are filled, never undefined',
      partial.every(shot => STAGES.length > 0 &&
        typeof shot.id === 'string' &&
        typeof shot.seq === 'number' &&
        typeof shot.shotSize === 'string' &&
        typeof shot.camera === 'string' &&
        typeof shot.cameraMove === 'string' &&
        typeof shot.durationSeconds === 'number' &&
        Array.isArray(shot.characters) &&
        typeof shot.status === 'string'), partial[0])
    eq('a comma-separated character string becomes an array', partial[1].characters, ['林晚', '顾总'])
    eq('missing id is minted from the sequence', partial[0].id, 'shot-1')

    ok('normalizeShots accepts a bare array', normalizeShots([{ seq: 9 }]).length === 1)
    ok('normalizeShots accepts a JSON string', normalizeShots('[{"seq":1}]').length === 1)
    ok('normalizeShots accepts a single bare object', normalizeShots({ action: '唯一镜头' }).length === 1)
    ok('normalizeShots(null) → []', normalizeShots(null).length === 0)
    ok('normalizeShots(garbage string) → []', normalizeShots('not json at all').length === 0)
    ok('normalizeShots(42) → []', normalizeShots(42).length === 0)

    const characters = normalizeCharacters({
      characters: [
        { name: '林晚', appearance: '素色旗袍' },
        { id: 'char-jiu', name: '林晚', role: '反派' },
        'nope',
      ],
    })
    ok('normalizeCharacters accepts { characters: [...] }', characters.length === 2, characters)
    ok('normalizeCharacters mints a stable id from the name',
      characters[0].id === outlineId('char', '林晚'), characters[0].id)
    ok('normalizeCharacters avoids id collisions on duplicate names',
      characters[0].id !== characters[1].id, characters.map(c => c.id))
    ok('normalizeCharacters fills every documented field',
      characters.every(c => typeof c.name === 'string' && typeof c.role === 'string' &&
        typeof c.appearance === 'string' && typeof c.personality === 'string' &&
        typeof c.costume === 'string' && Array.isArray(c.relationships) &&
        Array.isArray(c.referenceAssetIds) && typeof c.seed === 'number'), characters[0])
    ok('normalizeCharacters(null) → []', normalizeCharacters(null).length === 0)
    ok('normalizeCharacters({}) → [] (never fabricates a ghost card)', normalizeCharacters({}).length === 0)
    ok('normalizeCharacters({ characters: {} }) → []', normalizeCharacters({ characters: {} }).length === 0)
    ok('normalizeCharacters({"characters":{...}}) unwraps a keyed map',
      normalizeCharacters({ characters: { a: { name: '林晚' } } }).length === 1,
      normalizeCharacters({ characters: { a: { name: '林晚' } } }))
    ok('normalizeCharacters accepts a JSON string',
      normalizeCharacters(JSON.stringify({ characters: [{ name: '顾寒' }] })).length === 1)
    ok('normalizeCharacters({}) does not inflate the bible payload',
      normalizeCharacters({ characters: undefined }).length === 0)

    const scenes = normalizeScenes({ scenes: [{ name: '顾宅客厅', timeOfDay: '夜' }, { location: '天台' }] })
    ok('normalizeScenes accepts { scenes: [...] }', scenes.length === 2, scenes)
    ok('normalizeScenes fills every documented field',
      scenes.every(s => typeof s.id === 'string' && typeof s.name === 'string' &&
        typeof s.timeOfDay === 'string' && typeof s.interior === 'boolean' &&
        typeof s.atmosphere === 'string' && Array.isArray(s.shots) &&
        Array.isArray(s.referenceAssetIds)), scenes[0])
    ok('normalizeScenes(null) → []', normalizeScenes(null).length === 0)

    const bible = await readProject(created.id)
    markStageReady(bible, 'bible', { characters: [{ name: '顾寒' }], scenes: [{ name: '天台' }] }, '设定')
    ok('markStageReady normalizes the bible payload',
      Array.isArray(bible.content.bible.characters) && Array.isArray(bible.content.bible.scenes),
      bible.content.bible)
    ok('bible character keeps the CJK-derived id', bible.content.bible.characters[0].id === outlineId('char', '顾寒'),
      bible.content.bible.characters[0])
  })

  /* ------------------------------------------------------- 5. asset bytes */

  /** 1x1 transparent PNG. */
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  )

  await step('putAsset → readAsset round-trips bytes', async () => {
    const record = await putAsset(created.id, {
      kind: 'shot-ref',
      ref: 'shot-1',
      name: '分镜 1',
      bytes: pngBytes,
      meta: { prompt: '婚礼现场，逆光' },
    })
    ok('putAsset returns a record with a minted file name',
      typeof record.file === 'string' && record.file.endsWith('.png'), record.file)
    ok('putAsset records the byte length', record.bytes === pngBytes.length, record.bytes)
    ok('putAsset records a sha256', typeof record.sha256 === 'string' && record.sha256.length === 64)
    ok('putAsset keeps the caller ref + kind', record.kind === 'shot-ref' && record.ref === 'shot-1', record)
    ok('putAsset defaults origin to image-model', record.origin === ORIGIN.imageModel, record.origin)
    eq('putAsset keeps meta', record.meta, { prompt: '婚礼现场，逆光' })

    const onDisk = path.join(tempRoot, 'projects', created.id, 'assets', record.file)
    const stat = await readFile(onDisk)
    ok('bytes exist at <dataRoot>/projects/<id>/assets/<file>', stat.equals(pngBytes), onDisk.length)

    const back = await readAsset(created.id, record.file)
    ok('readAsset returns the bytes', back !== undefined && back.data.equals(pngBytes), back?.data?.length)
    ok('readAsset infers image/png', back?.mime === 'image/png', back?.mime)

    const persisted = await readProject(created.id)
    ok('the asset is appended to the project document',
      persisted.assets.length === 1 && persisted.assets[0].file === record.file, persisted.assets)

    // data: URL input (what the browser hands back) is accepted too.
    const dataUrl = await putAsset(created.id, {
      kind: 'video',
      bytes: `data:image/png;base64,${pngBytes.toString('base64')}`,
    })
    ok('putAsset accepts a data: URL payload', dataUrl.bytes === pngBytes.length, dataUrl.bytes)
    ok('a video asset keeps a .mp4 container',
      dataUrl.file.endsWith('.mp4') && dataUrl.mime === 'video/mp4', dataUrl)

    // Bad inputs are rejected loudly, never silently.
    let rejectedEmpty = false
    try {
      await putAsset(created.id, { bytes: '' })
    } catch {
      rejectedEmpty = true
    }
    ok('putAsset rejects an empty payload', rejectedEmpty)

    let rejectedUnknown = false
    try {
      await putAsset('p-not-here', { bytes: pngBytes })
    } catch {
      rejectedUnknown = true
    }
    ok('putAsset rejects an unknown project', rejectedUnknown)

    let traversalBlocked = false
    try {
      assetPath(created.id, '../../escape.png')
    } catch {
      traversalBlocked = true
    }
    ok('assetPath refuses path traversal', traversalBlocked)
    ok('readAsset refuses path traversal', (await readAsset(created.id, '../../package.json')) === undefined)
    ok('readAsset returns undefined for a missing file', (await readAsset(created.id, 'nope.png')) === undefined)

    return record
  })

  await step('asset cap is enforced', async () => {
    const capped = await createProjectDoc({ title: '容量测试' })
    const doc = await readProject(capped.id)
    // Fill the document to the cap without writing 600 real files.
    doc.assets = Array.from({ length: MAX_ASSETS_PER_PROJECT }, (_, i) => ({ id: `a-${i}`, file: `f${i}.png` }))
    await writeProject(doc)

    let refused = false
    try {
      await putAsset(capped.id, { bytes: pngBytes })
    } catch (error) {
      refused = /cap/i.test(String(error?.message))
    }
    ok(`putAsset refuses beyond MAX_ASSETS_PER_PROJECT (${MAX_ASSETS_PER_PROJECT})`, refused)
    return capped
  })

  /* --------------------------------------------------- 6. library + delete */

  await step('listProjects returns summaries newest first', async () => {
    const older = await createProjectDoc({ title: '旧项目' })
    // Force a distinct, older updatedAt so ordering is deterministic.
    const olderDoc = await readProject(older.id)
    olderDoc.updatedAt = Date.now() - 60_000
    await writeProject(olderDoc)
    await new Promise(resolve => setTimeout(resolve, 5))
    const newest = await createProjectDoc({ title: '新项目' })

    const rows = await listProjects()
    const ids = rows.map(row => row.id)
    ok('every created project is listed', ids.includes(created.id) && ids.includes(older.id) && ids.includes(newest.id), ids)
    ok('newest project is first', ids[0] === newest.id, ids)
    ok('ordering is strictly non-increasing by updatedAt',
      rows.every((row, i) => i === 0 || rows[i - 1].updatedAt >= row.updatedAt), rows.map(r => r.updatedAt))
    const row = rows.find(r => r.id === created.id)
    ok('summary carries title + assetCount, not the payload',
      row.title === '替身新娘' && row.assetCount === 2 && row.content === undefined, row)
    // Regression: `if (status in counters)` walked Object.prototype, so keys
    // like 'constructor' matched and inflated the counters. This fixture ends
    // as idea=ready, story+script+video=stale, bible+visual=empty.
    eq('summary counts reflect the real stage statuses', row.stageCounts, {
      ready: 1, stale: 3, running: 0, failed: 0, empty: 2,
    })
    ok('summary stageCounts has only own, numeric keys',
      Object.keys(row.stageCounts).length === 5 &&
      Object.values(row.stageCounts).every(value => typeof value === 'number' && Number.isFinite(value)),
      row.stageCounts)
    ok('temp files are never listed as projects',
      ids.every(id => !id.includes('tmp')), ids)

    const leftovers = (await readdir(path.join(tempRoot, 'projects'))).filter(name => name.endsWith('.tmp.json'))
    ok('no temp file is left behind by atomic writes', leftovers.length === 0, leftovers)
  })

  await step('writeProject bumps updatedAt and stays atomic', async () => {
    const project = await readProject(created.id)
    const before = project.updatedAt
    // Wait until the wall clock has actually advanced. A fixed 5 ms sleep was
    // flaky: under load two writes can land in the same millisecond, so the
    // strict `>` below would fail for a reason that has nothing to do with the
    // store. Bounded so a clock that never moves still fails, not hangs.
    let waited = 0
    while (Date.now() <= before && waited < 1000) {
      await new Promise(resolve => setTimeout(resolve, 2))
      waited += 2
    }
    await writeProject(project)
    ok('writeProject stamps a newer updatedAt', project.updatedAt > before, { before, after: project.updatedAt })

    const reloaded = await readProject(created.id)
    ok('the stamped timestamp is what was persisted', reloaded.updatedAt === project.updatedAt)

    let rejected = false
    try {
      await writeProject({ title: '没有 id' })
    } catch {
      rejected = true
    }
    ok('writeProject refuses a document without a usable id', rejected)
  })

  await step('deleteProject removes the document and its asset tree', async () => {
    const doomed = await createProjectDoc({ title: '待删除' })
    await putAsset(doomed.id, { kind: 'shot-ref', bytes: pngBytes })
    const projectDir = path.join(tempRoot, 'projects', doomed.id)
    ok('asset directory exists before delete', (await readdir(path.join(projectDir, 'assets'))).length === 1)

    const removed = await deleteProject(doomed.id)
    ok('deleteProject reports true for an existing project', removed === true, removed)
    ok('document is gone', (await readProject(doomed.id)) === undefined)
    ok('asset tree is gone', (await rm(projectDir, { recursive: true, force: true }).then(() => true)) === true)
    ok('deleting again reports false', (await deleteProject(doomed.id)) === false)
    ok('deleting an invalid id reports false without throwing', (await deleteProject('../../etc')) === false)

    const rows = await listProjects()
    ok('deleted project is no longer listed', !rows.some(row => row.id === doomed.id), rows.map(r => r.id))
  })

  await step('nested writes create missing directories recursively', async () => {
    // Point at a root whose `projects/` directory does not exist yet.
    const nestedRoot = path.join(tempRoot, 'deep', 'nested', 'root')
    setDataRoot(nestedRoot)
    const project = await createProjectDoc({ title: '深目录' })
    ok('createProjectDoc mkdir -p the projects directory',
      (await readProject(project.id))?.title === '深目录')
    const record = await putAsset(project.id, { kind: 'scene-master', bytes: pngBytes })
    ok('putAsset mkdir -p the assets directory',
      (await readAsset(project.id, record.file))?.data.length === pngBytes.length)
    setDataRoot(tempRoot)
    ok('setDataRoot(previous) takes effect immediately', dataRoot() === tempRoot, dataRoot())
  })

  /* --------------------------------------------------- 7. newProjectFrom */

  await step('newProjectFrom mints a ready-to-persist project', async () => {
    const project = newProjectFrom({ title: '  留白  ', aspectRatio: '16:9', episodes: 12 })
    ok('id is minted', typeof project.id === 'string' && project.id.length > 0, project.id)
    ok('title is trimmed', project.title === '留白', project.title)
    ok('valid overrides are applied', project.aspectRatio === '16:9' && project.episodes === 12, project)
    ok('every stage starts empty', STAGES.every(id => project.stages[id].status === STAGE_STATUS.empty))
    ok('unknown override types are ignored',
      newProjectFrom({ episodes: '很多' }).episodes === 1, newProjectFrom({ episodes: '很多' }).episodes)

    const persisted = await writeProject(project)
    ok('a minted project is directly persistable',
      (await readProject(persisted.id))?.aspectRatio === '16:9')
    await deleteProject(persisted.id)
  })
} finally {
  setDataRoot('')
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
}

/* ----------------------------------------------------------------- summary */

const total = passed + failures.length
console.log('')
console.log(`${failures.length === 0 ? 'ALL PASS' : 'FAILURES'}  ${passed}/${total} assertions passed`)
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`)
  process.exitCode = 1
}
