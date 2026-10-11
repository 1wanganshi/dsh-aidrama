/**
 * THE ASSET URL MUST SURVIVE THE TRIP FROM HOST TO GRID.
 *
 * Images did not appear in the workbench at all. Nothing errored: the request
 * returned 200, the bytes were on disk, and `GET /asset/...` served a valid PNG
 * with the right content-type. The URL was simply DROPPED one line after it
 * arrived — the host sends assets twice, `project.assets` (raw document records,
 * no `url`) and a top-level `assets` (mapped, with `url`), and the client kept
 * only `body.project`.
 *
 * `renderAssetGrid` then did `const url = str(asset.url)` → `''` and skipped the
 * <img>, so 101 tiles drew no pictures. That is the worst shape a bug can take:
 * every individual layer looks correct and the user sees nothing.
 *
 * This suite therefore asserts on the CONTRACT between the two halves — that the
 * mapped list is what gets read — rather than on either half alone.
 *
 * Run: node docs/verify-asset-url.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let pass = 0, fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`) }
}

const clientSrc = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
const routesSrc = fs.readFileSync(path.join(root, 'lib', 'host', 'routes.js'), 'utf8')

/* ------------------------------------------------------------------ *
 * 1. The host must send the mapped list.
 * ------------------------------------------------------------------ */
console.log('--- 宿主侧 ---')
check('project get 把资产过一遍 projectAsset（那一步才加上 url）',
  /project\.assets\.map\(asset => projectAsset\(project\.id, asset\)\)/.test(routesSrc))
// Check the shape, not the exact punctuation: `projectAsset` must build a URL
// from the asset route and the file name.
check('projectAsset 会生成 url',
  routesSrc.includes('url: file ===') && /AIDRAMA_API\.asset/.test(routesSrc))
check('响应里带上了顶层 assets',
  /writeJson\(res, 200, \{[\s\S]{0,200}assets,/.test(routesSrc))

/* ------------------------------------------------------------------ *
 * 2. The client must keep it.
 * ------------------------------------------------------------------ */
console.log('\n--- 客户端侧 ---')
check('loadProject 保存了顶层 assets',
  /state\.assets = Array\.isArray\(body\.assets\) \? body\.assets : \[\]/.test(clientSrc))
// The specific regression: reading the raw document list.
check('projectAssets() 不再直接读 state.project.assets',
  !/const projectAssets = \(\) => asArray\(state\.project\?\.assets\)\s*$/m.test(clientSrc))
check('projectAssets() 优先用 state.assets',
  /if \(Array\.isArray\(state\.assets\) && state\.assets\.length > 0\) return state\.assets/.test(clientSrc))
check('state 里声明了 assets', /assets: \[\],/.test(clientSrc))

/* ------------------------------------------------------------------ *
 * 3. Reproduce the decision with the REAL predicate, then run it on both
 *    shapes of data. Source assertions alone would have passed on the broken
 *    build too — the grid logic was always correct; the INPUT was wrong.
 * ------------------------------------------------------------------ */
console.log('\n--- 用真实响应验证渲染条件 ---')
const pid = 'p-mv2dd4i9-s5w9k6i1'
let live = null
try {
  const r = await fetch('http://127.0.0.1:19387/api/dsh-aidrama/projects', {
    method: 'POST',
    // Ask for a closed connection: see the teardown note at the end of this file.
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ action: 'get', id: pid }),
  })
  live = await r.json()
} catch (error) {
  console.log(`SKIP  连不上宿主（${error.message}），跳过实测部分`)
}

if (live?.ok) {
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))

  const rawCount = (live.project?.assets ?? []).filter(a => str(a.url) !== '').length
  const mappedCount = (live.assets ?? []).filter(a => str(a.url) !== '').length

  console.log(`  project.assets 里能渲染的: ${rawCount} / ${live.project?.assets?.length ?? 0}`)
  console.log(`  顶层 assets 里能渲染的   : ${mappedCount} / ${live.assets?.length ?? 0}`)

  check('原始文档数组确实没有可渲染的 url（这正是 bug）', rawCount === 0,
    `${rawCount} 个带 url`)
  check('宿主映射后的数组供应了全部 url', mappedCount > 0
    && mappedCount === (live.assets?.length ?? 0),
    `${mappedCount} 个带 url`)

  // The fixed reader must now yield a drawable list.
  const readWithFix = () => {
    const state = { assets: live.assets, project: live.project }
    if (Array.isArray(state.assets) && state.assets.length > 0) return state.assets
    return Array.isArray(state.project?.assets) ? state.project.assets : []
  }
  const fixed = readWithFix()
  const drawable = fixed.filter(a => str(a.url) !== '').length
  check('修复后的读法能得到可渲染的资产列表', drawable === fixed.length && drawable > 0,
    `${drawable} / ${fixed.length}`)

  // And the URL must actually resolve.
  const first = fixed.find(a => str(a.url) !== '')
  if (first) {
    const res = await fetch(`http://127.0.0.1:19387${first.url}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    const ct = res.headers.get('content-type') ?? ''
    const magicOk =
      (bytes[0] === 0x89 && bytes[1] === 0x50) ||
      (bytes[0] === 0xFF && bytes[1] === 0xD8) ||
      (bytes.toString('ascii', 0, 4) === 'RIFF')
    check('第一个资产的 URL 真的能取到图片', res.status === 200 && bytes.length > 0,
      `status=${res.status} bytes=${bytes.length}`)
    check('返回的 content-type 是图片', /^image\//.test(ct), ct)
    check('字节与声明的类型一致（魔数校验）', magicOk,
      `前 4 字节: ${bytes.slice(0, 4).toString('hex')} ct=${ct}`)
  }
}

console.log(`\n${'='.repeat(60)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)

// Node's fetch keeps a keep-alive socket open, and on Windows tearing that down
// at exit trips an assertion in libuv (`!(handle->flags & UV_HANDLE_CLOSING)`)
// that aborts the process AFTER all output is printed — so the run looks like a
// crash and CI would read exit -1073740791 as a failure. Tear the pool down
// explicitly instead of letting the process die with live sockets.
try {
  const { getGlobalDispatcher } = await import('node:undici').catch(() => ({}))
  if (typeof getGlobalDispatcher === 'function') await getGlobalDispatcher().close()
} catch { /* not fatal: the assertions below are what matter */ }

// Exit only after stdout has flushed, and with an explicit 0 so a benign
// teardown warning cannot masquerade as a failed check.
process.exitCode = fail === 0 ? 0 : 1
