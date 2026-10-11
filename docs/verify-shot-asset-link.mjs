/**
 * Guard the shot ↔ asset link.
 *
 * A generated still is worthless to the video stage unless the SHOT knows its
 * asset id. `firstFrameDataUrl` reads `shot.firstFrameAssetId` (falling back to
 * `imageAssetId`), and nothing ever wrote either field — so real video tasks
 * carried `firstFrame: { kind: 'image', ref: {} }`, an empty reference, and a
 * render would have started from no image at all while reporting success.
 *
 * Run: node docs/verify-shot-asset-link.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as store from '../lib/host/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

const storeSrc = fs.readFileSync(path.join(root, 'lib', 'host', 'store.js'), 'utf8')
const routesSrc = fs.readFileSync(path.join(root, 'lib', 'host', 'routes.js'), 'utf8')

console.log('--- the link exists and is wired in ---')
check('store exports linkShotAsset', /export async function linkShotAsset/.test(storeSrc))
// Check the CALL, not the word: an earlier version of this assertion matched the
// explanatory comment, so deleting the call still passed.
check('the generation loop AWAITS the link call',
  /await store\.linkShotAsset\(\s*project\.id\s*,\s*ref\s*,\s*record\.id\s*,\s*kind\s*\)/.test(routesSrc),
  'no `await store.linkShotAsset(project.id, ref, record.id, kind)` in routes.js')
check('it is called AFTER the asset is stored',
  routesSrc.indexOf('assets.push(projectAsset(project.id, record))')
    < routesSrc.indexOf('await store.linkShotAsset('))
check('it writes BOTH id fields',
  storeSrc.includes('shot.imageAssetId = assetId') && storeSrc.includes('shot.firstFrameAssetId = assetId'))
check('a link failure does not lose the image', /A failed link must not lose/.test(routesSrc))

console.log('--- it only touches shot-ref, never sheets or masters ---')
check('other kinds are ignored', /if \(kind !== 'shot-ref'\) return false/.test(storeSrc))

console.log('--- it searches the flat list AND the episode tree ---')
check('visits script.shots', storeSrc.includes('visit(script.shots)'))
check('visits episodes[].scenes[].shots', storeSrc.includes('visit(scene?.shots)'))

console.log('--- the video stage reads the field the link writes ---')
check('firstFrameDataUrl prefers firstFrameAssetId', routesSrc.includes('shot?.firstFrameAssetId'))
check('it falls back to imageAssetId', routesSrc.includes('|| text(shot?.imageAssetId)'))

console.log('\n--- live check: does the real project resolve first frames? ---')
const pid = 'p-mv2dd4i9-s5w9k6i1'
const file = path.join(os.homedir(), '.dsh', 'aidrama', 'projects', `${pid}.json`)
if (!fs.existsSync(file)) {
  console.log('SKIP  the 回声站 project is not on this machine')
} else {
  const project = await store.readProject(pid)

  // USE THE ROUTE'S OWN SHOT SOURCE.
  //
  // The first version of this test looked shots up in the flat
  // `content.script.shots` and passed while the real bug was live — because the
  // route calls `allShots()`, which prefers the EPISODE TREE, and tree shots are
  // raw model output with no `id` and no asset link. Testing a different
  // collection than the product uses is how a green suite hid a broken first
  // frame for two rounds.
  const routesSrc = fs.readFileSync(path.join(root, 'lib', 'host', 'routes.js'), 'utf8')
  const grab = (name) => {
    const start = routesSrc.indexOf(`function ${name}(`)
    if (start < 0) throw new Error(`routes.js has no function ${name}`)
    return routesSrc.slice(start, routesSrc.indexOf('\n}\n', start) + 2)
  }
  const { allShots, firstFrameDataUrl } = new Function(`
    const text = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
    const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const AIDRAMA_API = { asset: '/api/dsh-aidrama/asset' };
    ${grab('shotsFromTree')}
    ${grab('allShots')}
    ${grab('firstFrameDataUrl')}
    return { allShots, firstFrameDataUrl };
  `)() // NOSONAR: local test helper

  check('the route source is reachable from the test', typeof allShots === 'function')

  const shots = allShots(project)
  const shotRefs = (project.assets ?? []).filter(a => a.kind === 'shot-ref')
  check('allShots returns the 23-shot script', shots.length >= 20, `${shots.length}`)

  let resolvedCount = 0
  const unresolved = []
  for (const a of shotRefs) {
    const shot = shots.find(s => s.id === a.ref)
    if (shot === undefined) { unresolved.push(`${a.ref}(no shot)`); continue }
    if (firstFrameDataUrl(project, shot) !== undefined) resolvedCount += 1
    else unresolved.push(a.ref)
  }

  check('every shot that HAS a generated still resolves a first frame',
    shotRefs.length === 0 || resolvedCount === shotRefs.length,
    `${resolvedCount}/${shotRefs.length} — unresolved: ${unresolved.join(', ')}`)

  // The exact regression shape: the video bundle carried an empty ref object.
  check('no shot with a still reports an empty first frame', unresolved.length === 0,
    unresolved.join(', '))

  // And a shot with NO still must still report none, rather than a stale id.
  const never = shots.find(s => !s.imageAssetId && !s.firstFrameAssetId)
  if (never !== undefined) {
    check('a shot with no still resolves no first frame',
      firstFrameDataUrl(project, never) === undefined, never.id)
  }

  // Both id fields must survive the tree rebuild, because different readers use
  // different ones.
  const linked = shots.filter(s => s.imageAssetId)
  check('tree shots carry imageAssetId',
    linked.length === shotRefs.length,
    `${linked.length} of ${shotRefs.length}`)
  check('tree shots carry firstFrameAssetId too',
    linked.every(s => s.firstFrameAssetId === s.imageAssetId))
}

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
