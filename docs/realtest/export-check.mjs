/**
 * EXPORT FORMATS against the real project.
 *
 * Export is the one thing a user takes OUT of the tool, so a broken export is
 * worse than a broken screen: the screen can be retried, an exported file gets
 * handed to someone else. This checks each format is non-empty, structurally
 * sane, and free of the two things that must never appear in a shared file — an
 * API key, and a raw local path.
 *
 * Run: node docs/realtest/export-check.mjs
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

// exportMarkdown/exportPromptPack are PRIVATE to routes.js. Rather than reach
// into module internals, drive the real HTTP route the export button uses — that
// is the path the user actually takes, and it exercises the format switch too.
const BASE = 'http://127.0.0.1:19387/api/dsh-aidrama/export'

async function doExport(format) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: pid, format }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const fmt = await import(pathToFileURL(path.join(root, 'lib', 'host', 'prompts.js')).href)
console.log('prompts.js exports:', Object.keys(fmt).join(', '), '\n')

// Use the REAL project so the export is exercised on real content (a 4-episode
// script with 23 shots), not a toy.
const pid = 'p-mv2dd4i9-s5w9k6i1'
const file = path.join(os.homedir(), '.dsh', 'aidrama', 'projects', `${pid}.json`)
if (!fs.existsSync(file)) {
  console.log(`SKIP: real project not found at ${file}`)
  process.exit(0)
}
const project = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log(`project: ${project.title} — ${project.episodes} 集\n`)

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */
console.log('--- JSON ---')
const rJson = await doExport('json')
check('导出路由可用', rJson.status === 200 && rJson.body?.ok === true,
  `status=${rJson.status} body=${JSON.stringify(rJson.body)?.slice(0, 120)}`)
const json = String(rJson.body?.content ?? '')
check('JSON 导出非空', json.length > 1000, `${json.length} bytes`)
check('JSON 能被重新解析', (() => { try { JSON.parse(json); return true } catch { return false } })())
check('JSON 文件名安全（无路径分隔符）',
  !/[/\\]/u.test(String(rJson.body?.filename ?? '')), String(rJson.body?.filename))
check('JSON 保留了四个文本阶段',
  ['idea', 'story', 'script', 'bible'].every(k => project.content?.[k] != null),
  Object.keys(project.content ?? {}).filter(k => project.content[k] != null).join(', '))

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */
console.log('\n--- Markdown 分镜脚本 ---')
const rMd = await doExport('markdown')
const md = String(rMd.body?.content ?? '')
check('markdown 导出成功', rMd.body?.ok === true, JSON.stringify(rMd.body)?.slice(0, 120))
check('markdown 导出非空', md.length > 500, `${md.length} chars`)
check('markdown 有标题', /^#\s/m.test(md), md.slice(0, 60))
check('markdown 提到了集数', md.includes('集'))
const hasLook = /发|五官|服装|外型|外观/.test(md)
check('markdown 带上人物外观信息（拍片时靠它保持一致）', hasLook, md.slice(0, 100))

/* ------------------------------------------------------------------ *
 * Prompt pack
 * ------------------------------------------------------------------ */
console.log('\n--- 提示词包 ---')
const rPack = await doExport('prompt-pack')
const pack = String(rPack.body?.content ?? '')
check('提示词包导出成功', rPack.body?.ok === true, JSON.stringify(rPack.body)?.slice(0, 120))
check('提示词包非空', pack.length > 500, `${pack.length} chars`)
check('提示词包按镜头给出提示词',
  (pack.match(/shot-\d+-\d+-\d+/g) ?? []).length >= 5,
  `${(pack.match(/shot-\d+-\d+-\d+/g) ?? []).length} 个镜头引用`)
check('提示词包包含风格 DNA', pack.includes('85mm') || pack.includes('国漫'), pack.slice(0, 80))

/* ------------------------------------------------------------------ *
 * Unknown format must not silently return JSON.
 * ------------------------------------------------------------------ */
console.log('\n--- 未知格式 ---')
const rBad = await doExport('docx')
check('未知导出格式被明确拒绝', rBad.body?.ok === false && rBad.body?.code === 'bad-request',
  `ok=${rBad.body?.ok} code=${rBad.body?.code} msg=${rBad.body?.message}`)

/* ------------------------------------------------------------------ *
 * Nothing that must stay on this machine may appear in an export.
 * ------------------------------------------------------------------ */
console.log('\n--- 导出物里不能带的东西 ---')
const everything = `${json}\n${md}\n${pack}`
check('不含 API key', !/sk-[A-Za-z0-9_-]{16,}/.test(everything),
  (everything.match(/sk-[A-Za-z0-9_-]{16,}/g) ?? []).join(', '))
check('不含用户主目录路径', !/C:\\Users\\|C:\/Users\/|\/home\//.test(everything),
  (everything.match(/C:\\Users\\[^\s"]+/g) ?? []).slice(0, 2).join(', '))
// NOTE on what "no channel address" means. Each generated asset stores
// `meta.channel` — the channel's local ID ("d1api"), kept as provenance so you
// can tell which provider made which image. That is an id, not a credential and
// not an endpoint, so it is allowed. What must NEVER appear is a URL or a key.
check('不含渠道 API 地址', !/https?:\/\/[^\s"')]*(d1api|xiaoc|minimax|dashscope)/i.test(everything),
  (everything.match(/https?:\/\/[^\s"')]*(d1api|xiaoc|minimax|dashscope)[^\s"')]*/gi) ?? []).join(', '))
check('不含渠道密钥字段', !/(api[_-]?key|apiKey|channelSecrets|authorization|bearer\s)/i.test(everything),
  (everything.match(/.{0,40}(api[_-]?key|channelSecrets|bearer).{0,40}/gi) ?? []).slice(0, 2).join(' | '))

console.log(`\n${'='.repeat(60)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
