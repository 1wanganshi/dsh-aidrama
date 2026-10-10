/**
 * dsh-aidrama — stage state machine.
 *
 * The six production stages (idea → story → script → bible → visual → video)
 * advance strictly left→right. Re-running an earlier stage never deletes later
 * work: it marks the dependents `stale` so the workbench can show "this was
 * built from an older version" and offer a regenerate button. Every function
 * here is PURE: it mutates only the project object it is handed, never touches
 * the disk, and never throws for a merely surprising input.
 *
 * Persisting the returned project is the caller's job (`writeProject`).
 */

import {
  ORIGIN,
  STAGES,
  STAGE_META,
  STAGE_STATUS,
  createProject,
  isStageId,
  outlineId,
  stagesAfter,
} from './protocol.js'

/** Fields that may be dragged onto a new project from an untrusted input bag. */
const PASSTHROUGH_FIELDS = ['aspectRatio', 'episodes', 'shotSeconds', 'styleDna', 'logline', 'title']

/**
 * Whether `value` is a non-null, non-array object (a candidate record).
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Coerce any stage-content payload into a plain array of objects.
 *
 * Agent output arrives in whatever shape the model felt like emitting
 * (`{ shots: [...] }`, `[...]`, a single object, a JSON string, null), so every
 * normalizer starts here rather than trusting the shape.
 *
 * @param {unknown} content
 * @param {string[]} [keys] wrapper keys to unwrap, tried in order
 * @returns {Array<Record<string, unknown>>}
 */
function asObjectArray(content, keys = []) {
  let value = content

  // A JSON string is a common agent-output wrapper; one parse attempt only,
  // because `JSON.parse` on a huge blob should not become a DoS vector.
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return []
    try {
      value = JSON.parse(text)
    } catch {
      return []
    }
  }

  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.filter(isRecord)

  for (const key of keys) {
    const nested = value[key]
    if (Array.isArray(nested)) return nested.filter(isRecord)
    // `{ characters: { 林晚: {...} } }` — a keyed map instead of a list.
    if (isRecord(nested)) return Object.values(nested).filter(isRecord)
  }

  // A single bare object counts as a one-element list, but ONLY when it is not
  // merely a wrapper for OTHER lists. `{ characters: undefined, scenes: [] }`
  // must yield no characters, not a fabricated card built from the wrapper
  // itself — that ghost used to land in the saved project.
  if (keys.some(key => Object.hasOwn(value, key))) return []

  if (Object.keys(value).length === 0) return []
  return [value]
}

/**
 * A trimmed string, or '' for anything else (never undefined).
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * A finite number, or the fallback.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function num(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/**
 * A deduplicated, trimmed string list.
 * @param {unknown} value
 * @returns {string[]}
 */
function textList(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[、,，;；\n]/)
      : []
  const seen = new Set()
  const out = []
  for (const item of source) {
    const value_ = text(item)
    if (value_ === '' || seen.has(value_)) continue
    seen.add(value_)
    out.push(value_)
  }
  return out
}

/**
 * Stable, id-safe key derived from a free-form name.
 * @param {string} value
 * @returns {string}
 */
function keyOf(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'x'
}

/**
 * Merge unknown extra keys through, so agent-authored fields are not dropped.
 *
 * Uses `Object.hasOwn` rather than `in`: `'constructor' in target` is always
 * true, which would silently drop a legitimate extra field of that name.
 *
 * @param {object} target
 * @param {object} source
 * @param {string[]} known keys already handled by the caller
 * @returns {object} target
 */
function keepExtras(target, source, known) {
  for (const [key, value] of Object.entries(source)) {
    if (known.includes(key) || Object.hasOwn(target, key)) continue
    if (value === undefined) continue
    target[key] = value
  }
  return target
}

/** Fields read explicitly off a shot record. */
const SHOT_FIELDS = [
  'id', 'seq', 'sceneId', 'scene', 'shotSize', 'camera', 'cameraMove',
  'action', 'dialogue', 'speaker', 'durationSeconds', 'prompt', 'negativePrompt',
  'imageAssetId', 'firstFrameAssetId', 'videoAssetId', 'videoPrompt',
  'characters', 'notes', 'status',
  // Read explicitly off a shot flattened from the episode tree, so they are not
  // duplicated into `extras` by keepExtras.
  'episode', 'location', 'time',
]

/**
 * Normalize the script stage's shot list.
 *
 * @param {unknown} content `{ shots: [...] }`, a bare array, or a JSON string
 * @param {{ sceneCount?: number }} [options]
 * @returns {Array<object>} always an array; every field defined
 */
export function normalizeShots(content, options = {}) {
  const rows = asObjectArray(content, ['shots', 'shotList', 'storyboard', 'items', 'list', 'data'])
  const defaultSeconds = num(options.shotSeconds, 0)

  return rows.map((row, index) => {
    const seq = Math.max(1, Math.round(num(row.seq ?? row.index ?? row.number, index + 1)))
    const sceneKey = text(row.sceneId ?? row.scene ?? row.sceneKey)
    const shot = {
      id: text(row.id) || outlineId('shot', seq),
      seq,
      sceneId: sceneKey === '' ? '' : outlineId('scene', sceneKey),
      scene: text(row.sceneName ?? row.sceneTitle ?? row.scene),
      shotSize: text(row.shotSize ?? row.size ?? row.framing) || '中景',
      camera: text(row.camera ?? row.lens) || '固定机位',
      cameraMove: text(row.cameraMove ?? row.move) || '固定',
      action: text(row.action ?? row.description ?? row.content),
      dialogue: text(row.dialogue ?? row.line ?? row.lines),
      speaker: text(row.speaker ?? row.character ?? row.who),
      durationSeconds: Math.max(1, num(row.durationSeconds ?? row.duration ?? row.seconds, defaultSeconds || 5)),
      prompt: text(row.prompt ?? row.imagePrompt),
      negativePrompt: text(row.negativePrompt ?? row.negative),
      imageAssetId: text(row.imageAssetId ?? row.assetId),
      firstFrameAssetId: text(row.firstFrameAssetId ?? row.firstFrame),
      videoAssetId: text(row.videoAssetId ?? row.video),
      videoPrompt: text(row.videoPrompt ?? row.video_prompt),
      characters: textList(row.characters ?? row.cast ?? row.roles),
      notes: text(row.notes ?? row.note),
      status: text(row.status) || STAGE_STATUS.empty,
    }
    return keepExtras(shot, row, SHOT_FIELDS)
  })
}

/**
 * Flatten the script stage's episode→scene→shot tree into the canonical shot list.
 *
 * WHY THIS EXISTS: `TEXT_STAGE_BRIEF.script.schema` tells the model to return
 * `{ title, episodes: [{ scenes: [{ shots: [...] }] }] }`, so EVERY stored script
 * arrives as a tree. Feeding that straight to `normalizeShots` is wrong: the
 * wrapper is not a shot, so `asObjectArray(payload, ['shots', ...])` finds no
 * `shots` key, falls through to "a single bare object is a one-element list", and
 * returns ONE ghost row built from the wrapper — with empty action/dialogue and
 * the whole real tree smuggled inside an `episodes` passthrough key. The real
 * shots live only in `episodes[].scenes[].shots[]`.
 *
 * So: walk the tree when it exists and stamp each shot with its scene context, so
 * `sceneId` / `scene` / `speaker` survive and a consumer can act on a shot without
 * re-walking the episodes. Fall back to the flat readers only when there is no
 * tree, which keeps hand-written and legacy payloads working.
 *
 * @param {unknown} payload the unwrapped script content
 * @param {{ shotSeconds?: number }} [options]
 * @returns {Array<object>} always an array; every field defined
 */
export function flattenScriptShots(payload, options = {}) {
  const root = isRecord(payload) ? payload : {}
  const episodes = Array.isArray(root.episodes) ? root.episodes.filter(isRecord) : []
  if (episodes.length === 0) return normalizeShots(payload, options)

  const out = []
  let seq = 0

  episodes.forEach((episode, episodeIndex) => {
    const episodeNo = Math.max(1, Math.round(num(episode.no ?? episode.number, episodeIndex + 1)))
    const scenes = Array.isArray(episode.scenes) ? episode.scenes.filter(isRecord) : []

    // An episode with no scenes is legal (a summary-only episode); skip it rather
    // than fabricating a scene, which is the same ghost the flat path produced.
    scenes.forEach((scene, sceneIndex) => {
      const sceneNo = Math.max(1, Math.round(num(scene.no ?? scene.number, sceneIndex + 1)))
      const slug = text(scene.slug ?? scene.sceneId ?? scene.id)
        || `ep${episodeNo}-sc${sceneNo}`
      const sceneId = outlineId('scene', slug)
      const rows = Array.isArray(scene.shots) ? scene.shots.filter(isRecord) : []
      // The scene's own dialogue, inherited by any shot that authored none.
      const sceneDialogue = scene.dialogue ?? scene.lines

      // A scene with no authored shots still needs one row, otherwise its action
      // and dialogue would be unreachable from the shot list.
      const source = rows.length > 0
        ? rows
        : [{ action: scene.action, dialogue: scene.dialogue, durationSeconds: scene.durationSec }]

      source.forEach((row, shotIndex) => {
        seq += 1
        // Dialogue belongs to the SCENE in the script schema, not to an
        // individual shot, so a shot with none of its own inherits the scene's
        // lines. Without this the flattening silently dropped every line of
        // dialogue in the show — the shots carried no words at all.
        const dialogueSource = row.dialogue ?? sceneDialogue
        const dialogueText = typeof dialogueSource === 'string'
          ? dialogueSource
          : Array.isArray(dialogueSource)
            ? dialogueSource
              .filter(isRecord)
              .map(line => [text(line.who ?? line.speaker ?? line.character), text(line.line ?? line.text)]
                .filter(part => part !== '')
                .join('：'))
              .filter(line => line !== '')
              .join('\n')
            : ''
        const speakers = Array.isArray(dialogueSource)
          ? dialogueSource.filter(isRecord).map(line => text(line.who ?? line.speaker ?? line.character)).filter(name => name !== '')
          : []
        const cast = textList(row.characters ?? row.cast ?? row.roles)
        const shot = {
          id: text(row.id) || `shot-${episodeNo}-${sceneNo}-${Math.max(1, Math.round(num(row.no ?? row.number, shotIndex + 1)))}`,
          seq,
          episode: episodeNo,
          sceneId,
          scene: text(scene.name ?? scene.title) || text(scene.location),
          location: text(scene.location),
          time: text(scene.time),
          shotSize: text(row.shotSize ?? row.size ?? row.framing ?? row.shot) || '中景',
          camera: text(row.camera ?? row.lens) || '固定机位',
          cameraMove: text(row.cameraMove ?? row.move ?? row.motion) || '固定',
          action: text(row.action ?? row.description ?? row.content) || text(scene.action),
          dialogue: text(row.dialogueText) || dialogueText,
          speaker: text(row.speaker) || speakers[0] || '',
          durationSeconds: Math.max(1, num(
            row.durationSeconds ?? row.duration ?? row.durationSec ?? row.seconds,
            // The fallback is the CONFIGURED PER-SHOT length, never the scene's
            // own duration. A scene's durationSec is the total for the whole
            // scene, so using it here made every shot as long as the entire
            // scene: a 28s scene written as two shots reported 56s. The
            // timeline silently doubled, and the error compounds with the shot
            // count.
            num(options.shotSeconds, 0) || 5,
          )),
          prompt: text(row.prompt ?? row.imagePrompt),
          negativePrompt: text(row.negativePrompt ?? row.negative),
          imageAssetId: text(row.imageAssetId ?? row.assetId),
          firstFrameAssetId: text(row.firstFrameAssetId ?? row.firstFrame),
          videoAssetId: text(row.videoAssetId ?? row.video),
          videoPrompt: text(row.videoPrompt ?? row.video_prompt),
          characters: cast.length > 0 ? cast : (speakers.length > 0 ? [...new Set(speakers)] : textList(scene.characters)),
          notes: text(row.notes ?? row.note),
          status: text(row.status) || STAGE_STATUS.empty,
        }
        out.push(keepExtras(shot, row, SHOT_FIELDS))
      })
    })
  })

  return out
}

/** Fields read explicitly off a character record. */
const CHARACTER_FIELDS = [
  'id', 'name', 'role', 'alias', 'age', 'gender', 'appearance', 'personality',
  'costume', 'voice', 'arc', 'relationships', 'sheetPrompt', 'sheetAssetId',
  'threeViewAssetId', 'referenceAssetIds', 'notes', 'seed', 'status',
]

/**
 * Normalize the bible stage's character cards.
 *
 * @param {unknown} content `{ characters: [...] }`, a bare array, or a JSON string
 * @returns {Array<object>} always an array; every field defined
 */
export function normalizeCharacters(content) {
  const rows = asObjectArray(content, ['characters', 'cast', 'roles', 'people', 'items', 'data'])
  const seen = new Set()

  return rows.map((row, index) => {
    const name = text(row.name ?? row.character ?? row.title) || `角色${index + 1}`
    let id = text(row.id) || outlineId('char', name)
    // Two characters whose names slug to the same key must not collide.
    if (seen.has(id)) id = `${id}-${index + 1}`
    seen.add(id)

    const character = {
      id,
      name,
      role: text(row.role ?? row.type ?? row.identity) || '配角',
      alias: text(row.alias ?? row.nickname),
      age: text(row.age),
      gender: text(row.gender ?? row.sex),
      appearance: text(row.appearance ?? row.look ?? row.design),
      personality: text(row.personality ?? row.character ?? row.traits),
      costume: text(row.costume ?? row.wardrobe ?? row.outfit),
      voice: text(row.voice ?? row.voiceStyle),
      arc: text(row.arc ?? row.growth),
      relationships: textList(row.relationships ?? row.relations),
      sheetPrompt: text(row.sheetPrompt ?? row.prompt ?? row.imagePrompt),
      sheetAssetId: text(row.sheetAssetId ?? row.assetId),
      threeViewAssetId: text(row.threeViewAssetId ?? row.threeView),
      referenceAssetIds: textList(row.referenceAssetIds ?? row.references),
      notes: text(row.notes ?? row.note),
      seed: Math.round(num(row.seed, 0)),
      status: text(row.status) || STAGE_STATUS.empty,
    }
    return keepExtras(character, row, CHARACTER_FIELDS)
  })
}

/** Fields read explicitly off a scene record. */
const SCENE_FIELDS = [
  'id', 'name', 'location', 'timeOfDay', 'interior', 'atmosphere', 'lighting',
  'masterPrompt', 'masterAssetId', 'referenceAssetIds', 'shots', 'notes', 'status',
]

/**
 * Normalize the bible stage's scene cards.
 *
 * @param {unknown} content `{ scenes: [...] }`, a bare array, or a JSON string
 * @returns {Array<object>} always an array; every field defined
 */
export function normalizeScenes(content) {
  const rows = asObjectArray(content, ['scenes', 'locations', 'sets', 'items', 'data'])
  const seen = new Set()

  return rows.map((row, index) => {
    const name = text(row.name ?? row.scene ?? row.title ?? row.location) || `场景${index + 1}`
    let id = text(row.id) || outlineId('scene', name)
    if (seen.has(id)) id = `${id}-${index + 1}`
    seen.add(id)

    const scene = {
      id,
      name,
      location: text(row.location ?? row.place ?? row.address),
      timeOfDay: text(row.timeOfDay ?? row.time ?? row.dayNight) || '日',
      // Read `kind` too, not just `interior`/`inOut`.
      //
      // The bible schema names this field `kind` with values 'interior' /
      // 'exterior', but this normalizer only looked at `interior` and `inOut`.
      // A card written exactly to spec therefore fell through to the regex,
      // which saw an empty string and produced `false` — silently labelling
      // every scene as EXTERIOR, including train carriages and control rooms.
      // That `false` then hard-codes 场景类型：室外 into the scene's consistency
      // lock, so the error reached the image prompts.
      interior: typeof row.interior === 'boolean'
        ? row.interior
        : (/^外|exterior|outdoor|ext$/i.test(text(row.kind)) || /^外|exterior|outdoor|ext$/i.test(text(row.inOut))
            ? false
            : /内|interior|indoor|int/i.test(text(row.kind)) || /内|interior|indoor|int/i.test(text(row.interior ?? row.inOut))
              ? true
              : false),
      atmosphere: text(row.atmosphere ?? row.mood),
      lighting: text(row.lighting ?? row.light),
      masterPrompt: text(row.masterPrompt ?? row.prompt ?? row.imagePrompt),
      masterAssetId: text(row.masterAssetId ?? row.assetId),
      referenceAssetIds: textList(row.referenceAssetIds ?? row.references),
      shots: textList(row.shots ?? row.shotIds),
      notes: text(row.notes ?? row.note),
      status: text(row.status) || STAGE_STATUS.empty,
    }
    return keepExtras(scene, row, SCENE_FIELDS)
  })
}

/**
 * Read an object/array payload, unwrapping a JSON-string envelope once.
 *
 * Agents frequently hand back their stage payload as a JSON *string*, so the
 * envelope has to be understood here (the individual normalizers unwrap their
 * own list wrappers, but they cannot see wrapper siblings like `title`).
 *
 * @param {unknown} content
 * @returns {object | Array<unknown> | undefined} the payload, or undefined
 */
function unwrapEnvelope(content) {
  if (content === null || content === undefined) return undefined
  if (typeof content === 'string') {
    const text_ = content.trim()
    if (text_ === '') return undefined
    try {
      const parsed = JSON.parse(text_)
      return isRecord(parsed) || Array.isArray(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return isRecord(content) || Array.isArray(content) ? content : undefined
}

/**
 * Wrapper keys consumed by the per-stage normalizers.
 * @param {string} stageId
 * @returns {string[]}
 */
function wrapperKeysFor(stageId) {
  if (stageId === 'script') return ['shots', 'shotList', 'storyboard', 'items', 'list', 'data']
  if (stageId === 'bible') return ['characters', 'cast', 'roles', 'people', 'scenes', 'locations', 'sets', 'items', 'data']
  return []
}

/**
 * Normalize any stage payload by stage id.
 *
 * `script` → shots, `bible` → characters/scenes, `visual` → asset references
 * keyed by shot / character, every other stage → its raw value. Unknown stages
 * pass their content through untouched.
 *
 * @param {string} stageId
 * @param {unknown} content
 * @returns {unknown}
 */
export function normalizeStageContent(stageId, content) {
  if (stageId === 'script') {
    const payload = unwrapEnvelope(content)
    const wrapper = isRecord(payload) ? payload : {}
    const shots = flattenScriptShots(payload)
    return { ...wrapper, shots, ...keepExtras({}, wrapper, wrapperKeysFor(stageId)) }
  }
  if (stageId === 'bible') {
    const payload = unwrapEnvelope(content)
    const wrapper = isRecord(payload) ? payload : {}
    return {
      ...wrapper,
      characters: normalizeCharacters(isRecord(payload) ? payload.characters ?? payload : payload),
      scenes: normalizeScenes(isRecord(payload) ? payload.scenes ?? payload : payload),
    }
  }
  if (stageId === 'visual') {
    const wrapper = isRecord(content) ? content : {}
    return {
      ...wrapper,
      characterSheets: Array.isArray(wrapper.characterSheets) ? wrapper.characterSheets : [],
      sceneMasters: Array.isArray(wrapper.sceneMasters) ? wrapper.sceneMasters : [],
      shotRefs: Array.isArray(wrapper.shotRefs) ? wrapper.shotRefs : [],
    }
  }
  return content
}

/**
 * Mint a fresh project id for a new document.
 * @returns {string}
 */
function mintId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Build a brand-new project from conversational input.
 *
 * Unlike `protocol.createProject` (which is pure and leaves `id` empty), this
 * mints the id and coerces every caller-supplied field, so the result is ready
 * for `writeProject`.
 *
 * @param {{ title?: string, logline?: string, id?: string, aspectRatio?: string,
 *           episodes?: number, shotSeconds?: number, styleDna?: string }} [input]
 * @returns {object} a project with a non-empty id
 */
export function newProjectFrom(input = {}) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const project = createProject({
    title: typeof source.title === 'string' ? source.title : undefined,
    logline: typeof source.logline === 'string' ? source.logline : undefined,
  })

  project.id = typeof source.id === 'string' && source.id !== '' ? source.id : mintId()

  for (const field of PASSTHROUGH_FIELDS) {
    if (field === 'title' || field === 'logline') continue
    if (source[field] === undefined) continue
    if (field === 'episodes' || field === 'shotSeconds') {
      if (Number.isFinite(source[field])) project[field] = source[field]
    } else if (typeof source[field] === 'string' && source[field] !== '') {
      project[field] = source[field]
    }
  }

  return project
}

/**
 * Ensure a project object has every field the stage engine relies on.
 * Mirrors the repair pass in `store.js` so pure callers can be defensive too.
 *
 * @param {object} project
 * @returns {object} the same project, repaired in place
 */
function ensureShape(project) {
  if (project.stages === null || typeof project.stages !== 'object') project.stages = {}
  if (project.content === null || typeof project.content !== 'object') project.content = {}
  if (!Array.isArray(project.assets)) project.assets = []
  if (!Array.isArray(project.videoTasks)) project.videoTasks = []
  if (!Number.isFinite(project.updatedAt)) project.updatedAt = Date.now()
  if (!Number.isFinite(project.createdAt)) project.createdAt = project.updatedAt

  for (const stageId of STAGES) {
    const entry = project.stages[stageId]
    if (entry === null || typeof entry !== 'object') {
      project.stages[stageId] = { status: STAGE_STATUS.empty, revision: 0, updatedAt: 0, note: '' }
    } else {
      if (typeof entry.status !== 'string') entry.status = STAGE_STATUS.empty
      if (!Number.isFinite(entry.revision)) entry.revision = 0
      if (!Number.isFinite(entry.updatedAt)) entry.updatedAt = 0
      if (typeof entry.note !== 'string') entry.note = ''
    }
    if (project.content[stageId] === undefined) project.content[stageId] = null
  }
  return project
}

/**
 * Record that a stage produced fresh content.
 *
 * Bumps the stage's revision, stamps `updatedAt`, stores the normalized
 * payload, and marks `origin` (defaults to `agent`). Re-running a stage does
 * NOT itself invalidate later stages — `invalidateAfter` does that explicitly.
 *
 * @param {object} project
 * @param {string} stageId
 * @param {unknown} content stage payload
 * @param {string} [note] short human-facing note ("第 3 版：加强钩子")
 * @param {{ origin?: string }} [options]
 * @returns {object} the same project
 */
export function markStageReady(project, stageId, content, note = '', options = {}) {
  if (project === null || typeof project !== 'object') {
    throw new TypeError('markStageReady(project): project must be an object')
  }
  if (!isStageId(stageId)) {
    throw new TypeError(`markStageReady(project, stageId): unknown stage ${JSON.stringify(stageId)}`)
  }
  ensureShape(project)

  const entry = project.stages[stageId]
  const now = Date.now()
  entry.status = STAGE_STATUS.ready
  entry.revision += 1
  entry.updatedAt = now
  entry.note = typeof note === 'string' ? note : ''
  entry.origin = typeof options.origin === 'string' && options.origin !== '' ? options.origin : ORIGIN.agent

  project.content[stageId] = normalizeStageContent(stageId, content)
  project.updatedAt = now
  return project
}

/**
 * Record that a stage's content exists but its input changed underneath it.
 *
 * @param {object} project
 * @param {string} stageId
 * @param {string} [reason] why it went stale, kept as the stage note
 * @returns {object} the same project
 */
export function markStageStale(project, stageId, reason = '') {
  if (project === null || typeof project !== 'object') {
    throw new TypeError('markStageStale(project): project must be an object')
  }
  if (!isStageId(stageId)) {
    throw new TypeError(`markStageStale(project, stageId): unknown stage ${JSON.stringify(stageId)}`)
  }
  ensureShape(project)

  const entry = project.stages[stageId]
  // An empty stage has nothing to go stale — it stays empty / failed / running.
  if (entry.status === STAGE_STATUS.ready || entry.status === STAGE_STATUS.stale) {
    entry.status = STAGE_STATUS.stale
    entry.note = typeof reason === 'string' && reason !== '' ? reason : entry.note
    entry.updatedAt = Date.now()
    project.updatedAt = entry.updatedAt
  }
  return project
}

/**
 * Mark every stage after `stageId` stale.
 *
 * This is what a re-run of an earlier stage does to its dependents: their
 * artifacts are kept (never deleted) but flagged as built from older input.
 *
 * @param {object} project
 * @param {string} stageId
 * @returns {object} the same project
 */
export function invalidateAfter(project, stageId) {
  if (project === null || typeof project !== 'object') {
    throw new TypeError('invalidateAfter(project): project must be an object')
  }
  if (!isStageId(stageId)) return project
  ensureShape(project)

  const label = STAGE_META[stageId]?.short ?? stageId
  for (const later of stagesAfter(stageId)) {
    markStageStale(project, later, `上游「${label}」已更新，需要重做`)
  }
  return project
}

/** Resolve a stage entry, tolerating a missing map. */
function stageEntry(project, stageId) {
  const entry = project?.stages?.[stageId]
  if (entry !== null && typeof entry === 'object') return entry
  return { status: STAGE_STATUS.empty, revision: 0, updatedAt: 0, note: '' }
}

/**
 * Snapshot every stage for the workbench rail.
 *
 * `ready` means "has current content" (status ready or stale — the content is
 * still usable). `blocked` means "has no content but something upstream does",
 * i.e. it is worth offering a generate action.
 *
 * @param {object} project
 * @returns {Array<{id: string, label: string, short: string, status: string,
 *   revision: number, updatedAt: number, note: string, ready: boolean,
 *   blocked: boolean}>}
 */
export function stageView(project) {
  ensureShape(project)

  // Forward scan: a stage is "offerable" once any predecessor holds content.
  let upstreamHasContent = false
  return STAGES.map(stageId => {
    const entry = stageEntry(project, stageId)
    const meta = STAGE_META[stageId] ?? { id: stageId, label: stageId, short: stageId }
    const hasContent = entry.status === STAGE_STATUS.ready || entry.status === STAGE_STATUS.stale
    const row = {
      id: stageId,
      label: typeof meta.label === 'string' ? meta.label : stageId,
      short: typeof meta.short === 'string' ? meta.short : stageId,
      status: entry.status,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
      note: entry.note ?? '',
      ready: hasContent,
      blocked: !hasContent && upstreamHasContent,
    }
    if (hasContent) upstreamHasContent = true
    return row
  })
}

/**
 * Decide whether a stage may run right now.
 *
 * Deliberately never hard-blocks: a stale or empty earlier stage produces
 * `{ ok: true, warning }` so the human (or the agent) can still push forward
 * and fix upstream later. `ok: false` is reserved for genuinely impossible
 * requests — an unknown stage id, or a stage already running.
 *
 * @param {object} project
 * @param {string} stageId
 * @returns {{ ok: true, warning?: string } | { ok: false, reason: string }}
 */
export function advanceGuard(project, stageId) {
  if (project === null || typeof project !== 'object') {
    return { ok: false, reason: '项目不存在' }
  }
  if (!isStageId(stageId)) {
    return { ok: false, reason: `未知阶段：${String(stageId)}` }
  }
  ensureShape(project)

  const entry = stageEntry(project, stageId)
  if (entry.status === STAGE_STATUS.running) {
    return { ok: false, reason: `「${STAGE_META[stageId].short}」正在生成中，请等待本轮结束` }
  }

  const warnings = []
  const index = STAGES.indexOf(stageId)
  for (const earlier of STAGES.slice(0, index)) {
    const earlierEntry = stageEntry(project, earlier)
    const earlierShort = STAGE_META[earlier]?.short ?? earlier
    if (earlierEntry.status === STAGE_STATUS.stale) {
      warnings.push(`上游「${earlierShort}」已过期，本阶段结果可能不一致`)
    } else if (earlierEntry.status === STAGE_STATUS.empty) {
      warnings.push(`上游「${earlierShort}」还是空的，将按现有信息继续`)
    } else if (earlierEntry.status === STAGE_STATUS.failed) {
      warnings.push(`上游「${earlierShort}」上次生成失败，结果可能不完整`)
    }
  }

  return warnings.length > 0 ? { ok: true, warning: warnings.join('；') } : { ok: true }
}
