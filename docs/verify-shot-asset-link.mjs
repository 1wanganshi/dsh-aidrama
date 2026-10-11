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
  const shotRefs = (project.assets ?? []).filter(a => a.kind === 'shot-ref')

  const resolve = (shot) => {
    const assetId = String(shot?.firstFrameAssetId ?? '') || String(shot?.imageAssetId ?? '')
    if (assetId === '') return undefined
    const asset = (project.assets ?? []).find(a => a?.id === assetId)
    return asset === undefined ? undefined : String(asset.file ?? '')
  }

  let resolvedCount = 0
  for (const a of shotRefs) {
    const shot = (project.content.script.shots ?? []).find(s => s.id === a.ref)
    if (shot === undefined) continue
    if (resolve(shot) !== undefined) resolvedCount += 1
  }

  check('every shot that HAS a generated still resolves a first frame',
    shotRefs.length === 0 || resolvedCount === shotRefs.length,
    `${resolvedCount}/${shotRefs.length}`)

  // The exact regression shape: the video bundle carried an empty ref object.
  const unlinked = shotRefs.filter(a => {
    const shot = (project.content.script.shots ?? []).find(s => s.id === a.ref)
    return shot !== undefined && resolve(shot) === undefined
  })
  check('no shot with a still reports an empty first frame', unlinked.length === 0,
    unlinked.map(a => a.ref).join(', '))

  // And a shot with NO still must still report none, rather than a stale id.
  const never = (project.content.script.shots ?? []).find(s => !s.imageAssetId && !s.firstFrameAssetId)
  if (never !== undefined) {
    check('a shot with no still resolves no first frame', resolve(never) === undefined)
  }
}

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
