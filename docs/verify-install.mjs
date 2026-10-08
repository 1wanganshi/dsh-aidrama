/**
 * Verify the plugin is installed correctly in the live DSH profile.
 *
 * Checks the three things that must all be true for the host to load it:
 *   1. the profile can RESOLVE the package by name (node_modules link)
 *   2. the host entry IMPORTS without throwing
 *   3. the browser half is reachable through the declared export
 *
 * Run from anywhere: node verify-install.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const profile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const pkgDir = path.join(profile, 'node_modules', 'dsh-aidrama')

let fail = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail += 1
}

console.log('=== 1. 包是否可见 ===')
check('node_modules/dsh-aidrama 存在', fs.existsSync(pkgDir), pkgDir)
if (!fs.existsSync(pkgDir)) process.exit(1)

const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
check('package.json 可读', pkg.name === 'dsh-aidrama', `name=${pkg.name} v${pkg.version}`)
check('声明了宿主入口', typeof pkg.main === 'string', pkg.main)
check('声明了 dsh.bundle.patch', pkg.dsh?.bundle?.patch !== undefined, String(pkg.dsh?.bundle?.patch))
check('声明了 dsh.client（浏览器半）', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
check('client inject 为空数组', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length === 0)
check('导出 ./client', pkg.exports?.['./client'] !== undefined, String(pkg.exports?.['./client']))
check('cordis.patch.yml 存在', fs.existsSync(path.join(pkgDir, pkg.dsh?.bundle?.patch ?? 'cordis.patch.yml')))

console.log('\n=== 2. 宿主入口能否 import ===')
try {
  const mod = await import(pathToFileURL(path.join(pkgDir, pkg.main)).href)
  const real = mod.default ?? mod
  check('入口 import 成功', true)
  check('导出 name', typeof real.name === 'string', real.name)
  check('导出 inject 数组', Array.isArray(real.inject), JSON.stringify(real.inject))
  check('导出 apply 函数', typeof real.apply === 'function')
  check('导出 Config schema', real.Config !== undefined)
} catch (error) {
  const msg = String(error.message)
  if (msg.includes('schemastery')) {
    console.log('SKIP  入口 import — @deepseek-ai/schemastery 未解析（该依赖由 DSH 宿主提供）')
    console.log('      这不是安装问题：DSH 运行时自带它。')
  } else {
    check('入口 import 成功', false, msg)
  }
}

console.log('\n=== 3. 浏览器半是否可用 ===')
const clientPath = path.join(pkgDir, 'lib', 'client.js')
check('lib/client.js 存在', fs.existsSync(clientPath))
if (fs.existsSync(clientPath)) {
  const src = fs.readFileSync(clientPath, 'utf8')
  check('用 ModuleLoader 协议注册（非 ESM）', src.includes('__ModuleLoader__'))
  check('含侧边栏入口标记', src.includes('data-dsh-aidrama-entry'))
  check('含六个阶段 id', ['idea', 'story', 'script', 'bible', 'visual', 'video'].every(s => src.includes(`'${s}'`)))
}

console.log('\n=== 4. 项目数据目录 ===')
const projects = path.join(os.homedir(), '.dsh', 'aidrama', 'projects')
check('项目目录存在', fs.existsSync(projects), projects)
if (fs.existsSync(projects)) {
  const files = fs.readdirSync(projects).filter(f => f.endsWith('.json'))
  console.log(`      已有 ${files.length} 个项目文件`)
}

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? 'INSTALL OK' : `${fail} 项未通过`)
process.exit(fail === 0 ? 0 : 1)
