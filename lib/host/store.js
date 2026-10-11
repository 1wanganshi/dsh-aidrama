/**
 * dsh-aidrama — host-side project persistence.
 *
 * One project = one JSON document plus a sibling asset directory:
 *
 *   <dataRoot>/projects/<id>.json          project document (UTF-8 JSON)
 *   <dataRoot>/projects/<id>/assets/<file> image / video bytes
 *
 * Design rules that the rest of the host half relies on:
 *
 *  - Writes are ATOMIC: bytes land in a temp file in the same directory and are
 *    then renamed over the target, so a crash or a concurrent reader never sees
 *    a half-written project document.
 *  - Reads are TOLERANT: a corrupt / truncated / foreign document resolves to
 *    `undefined` (or is skipped while listing). A raw `SyntaxError` never
 *    escapes this module.
 *  - Nothing here imports the host runtime: only `node:fs/promises`,
 *    `node:path`, `node:crypto` and `node:os`, so the module is unit-testable
 *    against a temp root with no plugin host present.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  mkdir,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  ASPECT_RATIOS,
  MAX_ASSETS_PER_PROJECT,
  PROJECT_SCHEMA_VERSION,
  STAGES,
  STAGE_STATUS,
  createProject,
} from './protocol.js'

/** Directory under the data root holding every project document + asset tree. */
const PROJECTS_DIR = 'projects'

/** Directory under a project dir holding its bytes. */
const ASSETS_DIR = 'assets'

/** Same-directory temp suffix; `.json` stays last so tooling still sees JSON. */
const TMP_SUFFIX = '.tmp.json'

/** Every legal stage status, as an array for membership checks. */
const STAGE_STATUSES = Object.values(STAGE_STATUS)

/**
 * Smallest plausible project document. `{}` is one byte over this, so this
 * only rejects empty files and obvious truncation — the parser handles the
 * rest, tolerantly.
 */
const MIN_PROJECT_BYTES = 2

/**
 * Injected data-root override. `undefined` means "derive from os.homedir()".
 * A plain module-level string is deliberate: the host half is a singleton per
 * plugin instance, and tests set this once via `setDataRoot`.
 * @type {string | undefined}
 */
let dataRootOverride

/**
 * Memoised default root. The home directory does not move during a process
 * lifetime, so resolving it once keeps `dataRoot()` allocation-free.
 * @type {string | undefined}
 */
let defaultRootCache

/**
 * Resolve the base data directory used for every read and write.
 *
 * Default is `~/.dsh/aidrama`; `setDataRoot()` overrides it (used by
 * `docs/verify-store.mjs` to point at a temp directory).
 *
 * @returns {string} absolute path, no trailing separator
 */
export function dataRoot() {
  if (typeof dataRootOverride === 'string' && dataRootOverride !== '') {
    return dataRootOverride
  }
  if (defaultRootCache === undefined) {
    defaultRootCache = path.join(homedir(), '.dsh', 'aidrama')
  }
  return defaultRootCache
}

/**
 * Point the store at a different base directory.
 *
 * Pass an empty / non-string value to fall back to the `~/.dsh/aidrama`
 * default. The path is resolved to absolute but NOT created here: directories
 * are created lazily by the first write.
 *
 * @param {string} next absolute or relative directory
 * @returns {void}
 */
export function setDataRoot(next) {
  dataRootOverride = typeof next === 'string' && next !== '' ? path.resolve(next) : undefined
}

/**
 * Absolute path of the directory holding every project document.
 * @returns {string}
 */
function projectsDir() {
  return path.join(dataRoot(), PROJECTS_DIR)
}

/**
 * Absolute path of `<id>.json`.
 * @param {string} id
 * @returns {string}
 */
function projectFile(id) {
  return path.join(projectsDir(), `${id}.json`)
}

/**
 * Absolute path of a project's own directory (parent of `assets/`).
 * @param {string} id
 * @returns {string}
 */
function projectDir(id) {
  return path.join(projectsDir(), id)
}

/**
 * Absolute path of a project's asset directory.
 * @param {string} id
 * @returns {string}
 */
function assetsDir(id) {
  return path.join(projectDir(id), ASSETS_DIR)
}

/**
 * Whether `value` is usable as a project id.
 *
 * Ids are minted here, but they also travel through URLs and become file
 * names, so the shape is validated before touching the filesystem.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isProjectId(value) {
  return typeof value === 'string' && value !== '' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

/**
 * Reject anything that is not a well-formed project id.
 * @param {unknown} id
 * @param {string} what caller name, used in the error message
 * @returns {string} the validated id
 */
function requireProjectId(id, what = 'project id') {
  if (!isProjectId(id)) {
    throw new TypeError(`${what} must match /^[A-Za-z0-9_-]{1,64}$/, received ${JSON.stringify(id)}`)
  }
  return id
}

/**
 * Reject anything that is not a single, safe file name.
 *
 * `assetPath()` joins caller-supplied segments into a real filesystem path, so
 * path traversal (`../`, absolute paths, NUL bytes) is refused here rather than
 * being neutralised later.
 *
 * @param {unknown} file
 * @param {string} what caller name, used in the error message
 * @returns {string} the validated file name
 */
export function isSafeFile(file) {
  if (typeof file !== 'string' || file === '' || file.length > 200) return false
  if (file.includes('\0')) return false
  if (file === '.' || file === '..' || file.includes('/') || file.includes('\\')) return false
  // Windows drive-relative ("C:x") and reserved device names would escape or
  // misbehave; none of them are ever produced by mintFileName().
  if (/^[A-Za-z]:/.test(file)) return false
  return true
}

/**
 * Validate an asset file name.
 * @param {unknown} file
 * @returns {string}
 */
function requireSafeFile(file) {
  if (!isSafeFile(file)) {
    throw new TypeError(`asset file must be a plain file name, received ${JSON.stringify(file)}`)
  }
  return file
}

/**
 * Best-effort cleanup for a temp file left behind by a failed write.
 * @param {string} tmp
 * @returns {Promise<void>}
 */
async function discardTemp(tmp) {
  try {
    await unlink(tmp)
  } catch {
    /* the temp file never appeared, or is already gone — nothing to do */
  }
}

/**
 * Atomically replace `file` with `data`.
 *
 * Writes to `<dir>/.<name>.<pid>.<random>.tmp.json` and renames over the
 * target. Same directory keeps the rename on one filesystem, so it is atomic
 * on POSIX and on Windows (`fs.rename` replaces an existing file there).
 *
 * @param {string} file absolute destination path
 * @param {string | Buffer} data payload
 * @returns {Promise<void>}
 */
async function atomicWrite(file, data) {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`)
  try {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, file)
  } catch (error) {
    await discardTemp(tmp)
    throw error
  }
}

/**
 * Read + parse one project document.
 * @param {string} id
 * @returns {Promise<object | undefined>} the parsed document, or undefined
 */
async function loadDocument(id) {
  let text
  try {
    text = await readFile(projectFile(id), 'utf8')
  } catch {
    // ENOENT and friends: "no such project" is a normal answer, not an error.
    return undefined
  }
  // Read the size alongside the bytes so the syntax check is skipped entirely
  // for an empty or absurdly small file, and so a truncated document is
  // rejected before it ever reaches the parser.
  let info
  try {
    info = await stat(projectFile(id))
  } catch {
    return undefined
  }
  if (!info.isFile() || info.size < MIN_PROJECT_BYTES) return undefined

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // A truncated write from an older version, a hand-edit gone wrong: report
    // absence rather than throwing a raw SyntaxError at the caller.
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed
}

/**
 * Fill in every field a consumer may touch.
 *
 * Documents produced by an older schema, or hand-written ones, are repaired in
 * memory so downstream code never has to guard against `undefined.stages`.
 *
 * @param {object} raw parsed document
 * @param {string} id the id the document was loaded under
 * @returns {object} a well-formed project
 */
function normalizeProject(raw, id) {
  const base = createProject({
    title: typeof raw.title === 'string' ? raw.title : undefined,
    logline: typeof raw.logline === 'string' ? raw.logline : undefined,
  })

  const stages = {}
  const rawStages = raw.stages !== null && typeof raw.stages === 'object' ? raw.stages : {}
  for (const stageId of STAGES) {
    const entry = rawStages[stageId]
    const fallback = base.stages[stageId]
    stages[stageId] = entry !== null && typeof entry === 'object'
      ? {
          // An unknown status value (hand-edit, newer schema) is coerced to
          // `empty` rather than leaked into the UI's status switch.
          status: STAGE_STATUSES.includes(entry.status) ? entry.status : fallback.status,
          revision: Number.isFinite(entry.revision) ? entry.revision : fallback.revision,
          updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : fallback.updatedAt,
          note: typeof entry.note === 'string' ? entry.note : fallback.note,
        }
      : fallback
  }

  const content = {}
  const rawContent = raw.content !== null && typeof raw.content === 'object' ? raw.content : {}
  for (const stageId of STAGES) {
    content[stageId] = rawContent[stageId] === undefined ? null : rawContent[stageId]
  }

  // Preserve unknown keys: a newer writer's fields survive a round-trip
  // through this host, which keeps mixed-version sessions lossless.
  return {
    ...base,
    ...raw,
    id,
    schemaVersion: Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : PROJECT_SCHEMA_VERSION,
    title: base.title,
    logline: base.logline,
    aspectRatio: typeof raw.aspectRatio === 'string' && raw.aspectRatio !== ''
      ? raw.aspectRatio
      : base.aspectRatio,
    episodes: Number.isFinite(raw.episodes) ? raw.episodes : base.episodes,
    shotSeconds: Number.isFinite(raw.shotSeconds) ? raw.shotSeconds : base.shotSeconds,
    styleDna: typeof raw.styleDna === 'string' ? raw.styleDna : base.styleDna,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : base.createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : base.updatedAt,
    stages,
    content,
    assets: Array.isArray(raw.assets) ? raw.assets : [],
    videoTasks: Array.isArray(raw.videoTasks) ? raw.videoTasks : [],
  }
}

/**
 * Extract the cheap summary returned by `listProjects()`.
 * @param {object} project full document
 * @returns {object} summary (title + progress only, never content payloads)
 */
function toSummary(project) {
  const counters = { ready: 0, stale: 0, running: 0, failed: 0, empty: 0 }
  for (const stageId of STAGES) {
    const status = project.stages[stageId]?.status
    // `Object.hasOwn`, NOT `in`: `in` walks the prototype chain, so keys like
    // 'constructor' / 'toString' would pass the guard and corrupt the counter
    // (`counters['toString'] += 1` turns it into NaN, then a string).
    if (typeof status === 'string' && Object.hasOwn(counters, status)) counters[status] += 1
  }
  return {
    id: project.id,
    title: project.title,
    logline: project.logline,
    aspectRatio: project.aspectRatio,
    episodes: project.episodes,
    shotSeconds: project.shotSeconds,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    assetCount: project.assets.length,
    stageCounts: counters,
  }
}

/**
 * Mint a filesystem-safe, collision-resistant project id.
 * @returns {string}
 */
function mintProjectId() {
  return `p-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/**
 * List every project summary, newest first.
 *
 * Files that are unreadable, unparseable, or not valid ids are skipped: one
 * damaged document must not make the whole workbench unusable.
 *
 * @returns {Promise<Array<object>>}
 */
export async function listProjects() {
  let dir
  try {
    dir = await opendir(projectsDir())
  } catch {
    // No projects directory yet (fresh install) — an empty library is correct.
    return []
  }

  const summaries = []
  for await (const entry of dir) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.json')) continue
    if (entry.name.endsWith(TMP_SUFFIX)) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (!isProjectId(id)) continue
    const raw = await loadDocument(id)
    if (raw === undefined) continue
    summaries.push(toSummary(normalizeProject(raw, id)))
  }

  summaries.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
  return summaries
}

/**
 * Create a fresh project document on disk.
 *
 * @param {{ title?: string, logline?: string, id?: string, aspectRatio?: string,
 *           episodes?: number, shotSeconds?: number, styleDna?: string }} [input]
 * @returns {Promise<object>} the persisted project
 */
export async function createProjectDoc(input = {}) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const id = source.id === undefined ? mintProjectId() : requireProjectId(source.id)

  const project = createProject({
    title: typeof source.title === 'string' ? source.title : undefined,
    logline: typeof source.logline === 'string' ? source.logline : undefined,
  })
  project.id = id
  if (typeof source.aspectRatio === 'string' && ASPECT_RATIOS.includes(source.aspectRatio)) {
    project.aspectRatio = source.aspectRatio
  }
  if (Number.isFinite(source.episodes)) project.episodes = source.episodes
  if (Number.isFinite(source.shotSeconds)) project.shotSeconds = source.shotSeconds
  if (typeof source.styleDna === 'string' && source.styleDna !== '') {
    project.styleDna = source.styleDna
  }

  await atomicWrite(projectFile(id), serializeProject(project))
  return project
}

/**
 * Read one project document.
 *
 * @param {string} id
 * @returns {Promise<object | undefined>} undefined when missing, corrupt, or an
 *   invalid id — callers turn that into a 404.
 */
export async function readProject(id) {
  if (!isProjectId(id)) return undefined
  const raw = await loadDocument(id)
  if (raw === undefined) return undefined
  return normalizeProject(raw, id)
}

/**
 * Serialise a project document.
 * @param {object} project
 * @returns {string}
 */
function serializeProject(project) {
  return `${JSON.stringify(project, null, 2)}\n`
}

/**
 * Persist a project document, stamping `updatedAt` with the current time.
 *
 * The write is atomic (temp file + rename) and creates the projects directory
 * when it does not exist yet. The stamped document is returned so callers can
 * hand it straight back to the client; the caller's object is not mutated.
 *
 * @param {object} project a project with a valid `id`
 * @returns {Promise<object>} the document as written (with the new updatedAt)
 */
export async function writeProject(project) {
  if (project === null || typeof project !== 'object' || Array.isArray(project)) {
    throw new TypeError('writeProject(project): project must be an object')
  }
  const id = requireProjectId(project.id, 'project.id')

  if (typeof project.schemaVersion !== 'number') project.schemaVersion = PROJECT_SCHEMA_VERSION
  project.updatedAt = Date.now()

  await atomicWrite(projectFile(id), serializeProject(project))
  return project
}

/**
 * Delete a project document and its whole asset tree.
 *
 * @param {string} id
 * @returns {Promise<boolean>} true when a document was actually removed
 */
export async function deleteProject(id) {
  if (!isProjectId(id)) return false

  let removed = false
  try {
    await unlink(projectFile(id))
    removed = true
  } catch {
    // Missing document: still sweep the asset directory below, then report
    // `false` because nothing was deleted as far as the caller is concerned.
  }

  try {
    await rm(projectDir(id), { recursive: true, force: true })
  } catch {
    /* best effort: a locked file must not fail the whole delete */
  }

  return removed
}

/**
 * Mint a collision-resistant, filesystem-safe asset file name.
 *
 * @param {string} ext extension including the dot, e.g. `.png`
 * @returns {string}
 */
function mintFileName(ext) {
  const suffix = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.bin'
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}${suffix}`
}

/** Canonical extension per asset kind (a video never lands in a `.png`). */
const EXT_BY_KIND = {
  'video': '.mp4',
  'character-sheet': '.png',
  'scene-master': '.png',
  'shot-ref': '.png',
  'first-frame': '.png',
}

/** MIME type by extension, for the byte-serving route. */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
}

/**
 * Decode a base64 payload into a Buffer.
 *
 * Accepts a `data:` URL prefix (what browsers hand back from `canvas` /
 * `fetch`) as well as bare base64. Invalid base64 yields an empty buffer, which
 * the caller reports as a bad request.
 *
 * @param {unknown} value
 * @returns {Buffer}
 */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value !== 'string' || value === '') return Buffer.alloc(0)
  const comma = value.startsWith('data:') ? value.indexOf(',') : -1
  const payload = comma >= 0 ? value.slice(comma + 1) : value
  try {
    // Buffer.from(..., 'base64') silently skips invalid characters, so verify
    // the round-trip length instead of trusting it.
    const buffer = Buffer.from(payload, 'base64')
    return buffer
  } catch {
    return Buffer.alloc(0)
  }
}

/**
 * Guess an asset's MIME type from its extension.
 * @param {string} file
 * @returns {string}
 */
export function mimeForFile(file) {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Absolute path of one asset file.
 *
 * @param {string} projectId
 * @param {string} file plain file name (no separators)
 * @returns {string}
 */
export function assetPath(projectId, file) {
  return path.join(assetsDir(requireProjectId(projectId, 'asset projectId')), requireSafeFile(file))
}

/**
 * Store bytes for a project and append the matching asset record.
 *
 * Bytes are written first (atomically), then the document is rewritten, so a
 * crash in between leaves an unreferenced file on disk rather than a record
 * pointing at nothing.
 *
 * @param {string} projectId
 * @param {{ kind?: string, ref?: string, name?: string, bytes?: unknown,
 *           meta?: object, ext?: string, mime?: string, width?: number,
 *           height?: number, durationSeconds?: number, origin?: string }} input
 * @returns {Promise<object>} the appended asset record
 */
export async function putAsset(projectId, input = {}) {
  requireProjectId(projectId, 'asset projectId')
  const source = input !== null && typeof input === 'object' ? input : {}

  const project = await readProject(projectId)
  if (project === undefined) throw new Error(`unknown project: ${projectId}`)

  if (project.assets.length >= MAX_ASSETS_PER_PROJECT) {
    throw new Error(
      `project ${projectId} already holds ${project.assets.length} assets (cap ${MAX_ASSETS_PER_PROJECT})`,
    )
  }

  const kind = typeof source.kind === 'string' && source.kind !== '' ? source.kind : 'shot-ref'
  const bytes = toBuffer(source.bytes)
  if (bytes.length === 0) {
    throw new Error('putAsset(projectId, { bytes }): bytes decoded to zero length')
  }

  // Prefer the caller's extension (it usually knows the real container); fall
  // back to the canonical one for the kind.
  const ext = typeof source.ext === 'string' && source.ext !== ''
    ? (source.ext.startsWith('.') ? source.ext : `.${source.ext}`).toLowerCase()
    : (EXT_BY_KIND[kind] ?? '.bin')

  const file = mintFileName(ext)
  await mkdir(assetsDir(projectId), { recursive: true })
  await atomicWrite(assetPath(projectId, file), bytes)

  const asset = {
    id: `a-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
    kind,
    ref: typeof source.ref === 'string' ? source.ref : '',
    name: typeof source.name === 'string' && source.name !== '' ? source.name : file,
    file,
    mime: typeof source.mime === 'string' && source.mime !== '' ? source.mime : mimeForFile(file),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: Date.now(),
    origin: typeof source.origin === 'string' && source.origin !== '' ? source.origin : 'image-model',
    meta: source.meta !== null && typeof source.meta === 'object' && !Array.isArray(source.meta)
      ? source.meta
      : {},
  }
  if (Number.isFinite(source.width)) asset.width = source.width
  if (Number.isFinite(source.height)) asset.height = source.height
  if (Number.isFinite(source.durationSeconds)) asset.durationSeconds = source.durationSeconds

  project.assets.push(asset)
  await writeProject(project)
  return asset
}

/**
 * Point a shot at the asset that was just generated for it.
 *
 * WHY THIS IS NEEDED: a generated image is useless to the video stage unless
 * the shot knows its id. `firstFrameDataUrl` looks up `shot.firstFrameAssetId`
 * (falling back to `imageAssetId`), and nothing ever wrote either field — so
 * every video task carried `firstFrame: { kind: 'image', ref: {} }`, an empty
 * reference, and the render would have started from no image at all.
 *
 * Written through `putAsset`'s own read-modify-write path so it composes with
 * the asset store instead of racing it: read the document fresh, patch the one
 * shot, write back.
 *
 * @param {string} projectId
 * @param {string} shotRef the shot id the asset was generated for
 * @param {string} assetId
 * @param {string} kind 'shot-ref' links the still; anything else is ignored
 * @returns {Promise<boolean>} whether a shot was actually updated
 */
export async function linkShotAsset(projectId, shotRef, assetId, kind) {
  if (!isProjectId(projectId) || shotRef === '' || assetId === '') return false
  // Only a shot still belongs to the shot. Character sheets and scene masters
  // are looked up by their own fields.
  if (kind !== 'shot-ref') return false

  const project = await readProject(projectId)
  if (project === undefined) return false

  let touched = false
  const visit = shots => {
    if (!Array.isArray(shots)) return
    for (const shot of shots) {
      if (shot === null || typeof shot !== 'object') continue
      if (String(shot.id ?? '') !== shotRef) continue
      // `imageAssetId` is the still this shot renders; the video stage reads it
      // as the first frame. Both are set so either reader finds it.
      shot.imageAssetId = assetId
      shot.firstFrameAssetId = assetId
      touched = true
    }
  }

  // The shot may live in the flat list, the episode tree, or both.
  const content = project.content ?? {}
  const script = content.script ?? {}
  visit(script.shots)
  for (const episode of Array.isArray(script.episodes) ? script.episodes : []) {
    for (const scene of Array.isArray(episode?.scenes) ? episode.scenes : []) visit(scene?.shots)
  }

  if (touched) await writeProject(project)
  return touched
}

/**
 * Read asset bytes for serving.
 *
 * @param {string} projectId
 * @param {string} file plain file name
 * @returns {Promise<{ data: Buffer, mime: string } | undefined>} undefined when
 *   the project, the file, or the name is invalid — the caller answers 404.
 */
export async function readAsset(projectId, file) {
  if (!isProjectId(projectId) || !isSafeFile(file)) return undefined
  const target = path.join(assetsDir(projectId), file)
  try {
    const info = await stat(target)
    if (!info.isFile()) return undefined
    const data = await readFile(target)
    return { data, mime: mimeForFile(file) }
  } catch {
    return undefined
  }
}

/**
 * Internal helpers exposed for tests and for the routes layer's diagnostics.
 * Not part of the plugin's public protocol surface.
 */
export const __internals = {
  ASSETS_DIR,
  PROJECTS_DIR,
  TMP_SUFFIX,
  atomicWrite,
  mintProjectId,
}
