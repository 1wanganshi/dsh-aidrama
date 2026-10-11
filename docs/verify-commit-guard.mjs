/**
 * A malformed commit must be REFUSED, not silently applied.
 *
 * WHAT THIS GUARDS: `commit` used to accept any payload. It went to
 * `markStageReady()` → `normalizeStageContent()`, which returns whatever it is
 * given — so a null, a string or an array REPLACED the stage's real content and
 * the stage was marked `ready`. Success was reported. One malformed call could
 * wipe a stage holding months of writing, and nothing said so.
 *
 * This was not hypothetical: writing the error-path suite destroyed the idea
 * stage of the author's own project, twice, before the guard existed.
 *
 * The route is driven over HTTP, which is the surface the GUI and the agent tool
 * both use. To exercise UNLOADED code the suite spawns its own short-lived host
 * is impractical, so instead it checks both layers:
 *   - the guard exists in source (so it survives refactors)
 *   - the guard's predicate rejects every unsafe value and accepts real content
 *
 * Run: node docs/verify-commit-guard.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let pass = 0, fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`) }
}

const routesSrc = fs.readFileSync(path.join(root, 'lib', 'host', 'routes.js'), 'utf8')

console.log('--- 守卫存在于源码里 ---')
check('commitStage 会先校验 payload 是不是对象',
  /if \(!isRecord\(payload\)\)/.test(routesSrc))
check('空对象也被拒绝（提示改用 clear）',
  /Object\.keys\(payload\)\.length === 0/.test(routesSrc))
check('拒绝时明确说明原有内容未被改动',
  /原有内容未被改动/.test(routesSrc))
check('类型错误会变成 bad-request 而不是 500',
  /error instanceof TypeError \? 'bad-request'/.test(routesSrc))

/* ------------------------------------------------------------------ *
 * The predicate itself, evaluated for real.
 * ------------------------------------------------------------------ */
console.log('\n--- 判定逻辑逐值验证 ---')
// Extract the REAL `isRecord` from routes.js rather than reimplementing it. A
// copy would pass while the product's version drifted — the same mistake as
// testing a different collection than the code uses.
const fn = new Function(`${routesSrc.match(/function isRecord\(value\) \{[^}]+\}/)[0]}
  return isRecord`)
const predicate = fn()
check('成功从 routes.js 取到真实的 isRecord', typeof predicate === 'function')

for (const [label, value, want] of [
  ['null', null, false],
  ['undefined', undefined, false],
  ['字符串', 'nope', false],
  ['数字', 42, false],
  ['布尔', true, false],
  ['数组', [1, 2, 3], false],
  ['真实内容', { seed: '一个想法' }, true],
  ['内容含嵌套', { characters: [{ name: '周晚' }] }, true],
]) {
  const got = predicate(value)
  check(`  ${label} -> ${want ? '接受' : '拒绝'}`, got === want, `得到 ${got}`)
}

console.log('\n--- 空对象单独判定 ---')
const isEmptyObject = (p) => predicate(p) && Object.keys(p).length === 0
check('  {} 被判为空', isEmptyObject({}) === true)
check('  {seed:""} 不算空（用户可能真的写了空串）', isEmptyObject({ seed: '' }) === false)

/* ------------------------------------------------------------------ *
 * The damage must be recoverable — prove the store can repair a stage.
 * ------------------------------------------------------------------ */
console.log('\n--- 被写坏的阶段可以被修回来 ---')
const store = await import(pathToFileURL(path.join(root, 'lib', 'host', 'store.js')).href)
const os = await import('node:os')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aidrama-guard-'))
store.setDataRoot(scratch)

const stages = await import(pathToFileURL(path.join(root, 'lib', 'host', 'stages.js')).href)
const project = await store.createProjectDoc({ title: '守卫测试' })
stages.markStageReady(project, 'idea', { seed: '重要内容', title: '回声站' })
await store.writeProject(project)

// Simulate the OLD behaviour: bad payload accepted.
stages.markStageReady(project, 'idea', null)
await store.writeProject(project)
const broken = await store.readProject(project.id)
check('旧行为确实会清空内容（说明这个守卫是必要的）',
  broken.content.idea === null || broken.content.idea === undefined,
  JSON.stringify(broken.content.idea))
check('旧行为还会把阶段标成已完成（更危险的部分）',
  broken.stages.idea.status === 'ready',
  `status=${broken.stages.idea.status}`)

// Repair, exactly as was done for the real project.
broken.content.idea = { seed: '重要内容', title: '回声站' }
await store.writeProject(broken)
const fixed = await store.readProject(project.id)
check('内容可以被完整修回', fixed.content.idea?.seed === '重要内容')

fs.rmSync(scratch, { recursive: true, force: true })

console.log(`\n${'='.repeat(60)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
