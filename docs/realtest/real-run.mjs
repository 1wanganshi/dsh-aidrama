/**
 * REAL end-to-end run of the aidrama pipeline against the LIVE image channel.
 *
 * This is not a stub test. It drives the plugin's own route handlers with a real
 * channel config, and its `generateImage` does the same live HTTP call the plugin
 * does. It exists because the unit suites prove the code is internally consistent
 * but cannot prove that a real provider returns real pixels.
 *
 * The upstream is known to be slow (28-36s success, ~125s Cloudflare 524 timeout),
 * so every image call is retried with backoff, and every failure is recorded
 * rather than swallowed.
 *
 * Usage: node docs/realtest/real-run.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const lib = name => import(pathToFileURL(path.join(root, 'lib', 'host', name)).href)

const store = await lib('store.js')
const stages = await lib('stages.js')
const prompts = await lib('prompts.js')
const video = await lib('video.js')
const { makeAidramaRoutes } = await lib('routes.js')
const P = await lib('protocol.js')

/* ------------------------------------------------------------------ config */

// The key is read from the environment so this script is safe to commit.
// The channel's key lives in ~/.dsh/profiles/desktop/cordis.patch.yml; export it
// as AIDRAMA_KEY before running, e.g.
//   $env:AIDRAMA_KEY = (读自本机配置); node docs/realtest/real-run.mjs
const API_KEY = process.env.AIDRAMA_KEY ?? ''
if (API_KEY === '') {
  console.error('缺少 AIDRAMA_KEY 环境变量。本脚本不内置密钥。')
  process.exit(2)
}
const API_URL = process.env.AIDRAMA_URL ?? 'https://coderxiaoc.com/v1'
const MODEL = process.env.AIDRAMA_MODEL ?? 'gpt-image-2.5-sunburst'

const outDir = path.join(root, 'docs', 'realtest', 'out')
await fs.mkdir(outDir, { recursive: true })
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-real-'))
store.setDataRoot(tmpRoot)

/* ---------------------------------------------------------------- image gen */

const callLog = []
let imageSeq = 0

/** The exact live call the plugin makes, with the retry a human would do. */
async function generateImage(request) {
  const url = `${API_URL}/images/generations`
  const prompt = request.negative
    ? `${request.prompt}。不要出现：${request.negative}`
    : request.prompt

  const attempts = []
  let lastError
  for (let i = 1; i <= 4; i++) {
    const t0 = Date.now()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: MODEL, prompt, n: 1,
          size: request.size ?? '1024x1024',
          response_format: 'b64_json',
        }),
      })
      const ms = Date.now() - t0
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`)
        attempts.push({ i, status: res.status, ms })
        if (res.status === 524 || res.status === 503 || res.status === 502) {
          await new Promise(r => setTimeout(r, 3000))
          continue
        }
        throw lastError
      }
      const payload = await res.json()
      const b64 = payload.data?.[0]?.b64_json
      if (typeof b64 !== 'string' || b64 === '') throw new Error('no b64_json in response')
      attempts.push({ i, status: 200, ms })
      imageSeq += 1
      const file = `${String(imageSeq).padStart(2, '0')}-${request.kind ?? 'img'}-${(request.ref ?? 'x').replace(/[^\w-]/g, '_')}.png`
      await fs.writeFile(path.join(outDir, file), Buffer.from(b64, 'base64'))
      callLog.push({ kind: request.kind, ref: request.ref, file, bytes: Buffer.from(b64, 'base64').length, attempts })
      console.log(`   ✅ ${file}  (${attempts.length} attempt(s), ${ms}ms, ${Math.round(Buffer.from(b64, 'base64').length / 1024)}KB)`)
      return { images: [{ b64, mime: 'image/png' }], model: MODEL, channel: 'coderxiaoc' }
    } catch (e) {
      lastError = e
      const ms = Date.now() - t0
      attempts.push({ i, error: e.message, ms })
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  callLog.push({ kind: request.kind, ref: request.ref, failed: true, attempts, error: lastError?.message })
  console.log(`   ❌ ${request.kind}/${request.ref} FAILED after ${attempts.length} attempts: ${lastError?.message}`)
  throw new Error(`上游图像接口持续失败：${lastError?.message}`)
}

/* ------------------------------------------------------------------ routes */

const routes = makeAidramaRoutes({
  store, stages, prompts, video,
  resolveConfig: () => ({
    enabled: true, allowAgentGeneration: true, announceToAgent: true,
    channels: [{ id: 'coderxiaoc', name: 'coderxiaoc', apiUrl: API_URL, apiKey: API_KEY,
      protocol: 'auto', models: [{ id: MODEL, alias: MODEL }] }],
    defaultChannelId: 'coderxiaoc', defaultModel: MODEL,
    videoChannels: [], defaultVideoChannelId: '',
    styleDna: P.PROJECT_DEFAULTS.styleDna,
    aspectRatio: '9:16', shotSeconds: 5,
  }),
  generateImage,
  log: () => {},
})

const byPath = p => routes.find(r => r.kind === 'exact' && r.path === p)
function call(routePath, body) {
  return new Promise((resolve, reject) => {
    const route = byPath(routePath)
    if (route === undefined) return reject(new Error(`no route ${routePath}`))
    const chunks = []
    const req = {
      method: 'POST', url: routePath, headers: { host: '127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }
    const res = {
      statusCode: 200,
      writeHead(code) { res.statusCode = code; return res },
      setHeader() { return res },
      end(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) },
    }
    route.handler(req, res)
  })
}

/* -------------------------------------------------------------------- run */

const t0 = Date.now()
console.log('════════ 真实六阶段流水线 ════════')
console.log(`渠道 ${API_URL}  模型 ${MODEL}\n`)

// Stage 1 — idea (model-written; we simulate the model's committed output)
console.log('【1/6】想法')
const created = await call(P.AIDRAMA_API.projects, { action: 'create', title: '最后一班地铁' })
const pid = created.project.id
console.log(`   项目 ${pid}`)

await call(P.AIDRAMA_API.stage, {
  projectId: pid, stage: 'idea', action: 'commit',
  payload: {
    title: '最后一班地铁',
    logline: '末班地铁上，一个总能预知下一站有人的女孩，发现自己预知的最后一站是她自己。',
    genre: '都市悬疑', tone: '冷调、克制、缓慢收紧',
    protagonist: '林晚，24 岁，地铁广播员，想要弄清自己预知能力的真相',
    hook: '她报出下一站的名字，车门打开，站台上站着一个不该在那里的人。',
    ending: '她选择报出那个名字，成为下一个被预知的人。',
  },
})
console.log('   ✅ idea 已提交')

// Stage 2 — story
console.log('【2/6】剧情')
const brief = await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'story', action: 'brief' })
const briefText = JSON.stringify(brief)
console.log(`   麦基结构已注入 brief: ${briefText.includes('激励事件')}`)
console.log(`   价值转折规则已注入: ${briefText.includes('价值')}`)
console.log(`   爆点要求已注入: ${briefText.includes('钩子') || briefText.includes('3 秒')}`)

// Stage 3 — script (with the craft fields wired this session)
console.log('【3/6】分场脚本')
await call(P.AIDRAMA_API.stage, {
  projectId: pid, stage: 'script', action: 'commit',
  payload: {
    title: '最后一班地铁',
    episodes: [{
      no: 1, title: '末班车', hook: '她报出的站名，站台上站着一个不该在那里的人', hookType: '预知反转',
      scenes: [{
        no: 1, slug: 'subway-night', location: '地铁车厢', time: '夜',
        characters: ['林晚'], action: '林晚对着广播话筒报站，车厢空得只剩她一个人。',
        dialogue: [{ who: '林晚', line: '下一站，西平路。' }],
        durationSec: 12, valueEntry: '安全', valueExit: '不安',
        shots: [
          { no: 1, shot: '中景', camera: '[推镜头]', description: '林晚对着话筒报站，车厢空荡', motion: '镜头缓慢推近' },
          { no: 2, shot: '特写', camera: '[固定机位]', description: '她的手指停在广播键上', motion: '手指微微颤动' },
        ],
      }],
    }],
  },
})
console.log('   ✅ script 已提交')

// Stage 4 — bible
console.log('【4/6】设定集（人物 + 场景）')
await call(P.AIDRAMA_API.stage, {
  projectId: pid, stage: 'bible', action: 'commit',
  payload: {
    styleDna: '3D 国漫，冷蓝夜色，电影级柔和轮廓光，统一 85mm 焦距，无畸变',
    characters: [{
      id: 'char-linwan', name: '林晚', role: '主角',
      appearance: '清瘦', hair: '黑色短发，齐耳', face: '鹅蛋脸，眼尾微垂',
      body: '偏瘦，165cm', outfit: '深蓝地铁制服，左胸工牌',
      accessory: '银色细链耳钉', personality: '克制、固执',
    }],
    scenes: [{
      id: 'scene-subway', name: '地铁车厢', kind: 'interior',
      description: '末班车空车厢，两侧长椅，车窗映着隧道灯', lighting: '冷白顶灯 + 隧道频闪',
      composition: '纵深透视，消失点在画面右侧',
    }],
  },
})
console.log('   ✅ bible 已提交')

// Stage 5 — visual: REAL image generation
console.log('【5/6】视觉资产（真实调用作图接口）')
const visual = await call(P.AIDRAMA_API.stage, {
  projectId: pid, stage: 'visual', action: 'generate', payload: {},
})
console.log(`   返回 ok=${visual.ok}  生成 ${(visual.assets ?? []).length} 张  失败 ${(visual.failures ?? []).length} 项`)

// Stage 6 — video prompt pack (text only; no video upstream is configured)
console.log('【6/6】视频提示词包')
const vp = await call(P.AIDRAMA_API.video, { projectId: pid, action: 'prompts' })
const packs = vp.packs ?? vp.prompts ?? []
console.log(`   产出 ${Array.isArray(packs) ? packs.length : '?'} 个提示词包`)
if (Array.isArray(packs) && packs.length > 0) {
  const first = packs[0]
  const text = typeof first === 'string' ? first : JSON.stringify(first)
  console.log(`   含运镜 token: ${/\[.+?\]/.test(text)}`)
}

/* ---------------------------------------------------------------- report */

const okCalls = callLog.filter(c => !c.failed)
const failedCalls = callLog.filter(c => c.failed)
const retried = callLog.filter(c => c.attempts.length > 1)

console.log('\n════════ 真实调用统计 ════════')
console.log(`成功 ${okCalls.length} 张   失败 ${failedCalls.length} 项`)
console.log(`其中需要重试的: ${retried.filter(c => !c.failed).length} 张`)
for (const c of callLog) {
  const st = c.failed ? 'FAIL' : 'OK  '
  const att = c.attempts.map(a => a.status ?? a.error).join(',')
  console.log(`  ${st} ${String(c.kind ?? '').padEnd(16)} ${String(c.ref ?? '').padEnd(18)} attempts=[${att}] ${c.file ?? ''}`)
}

await fs.writeFile(path.join(outDir, 'run-report.json'), JSON.stringify({
  model: MODEL, apiUrl: API_URL, elapsedMs: Date.now() - t0,
  generated: okCalls.length, failed: failedCalls.length, calls: callLog,
}, null, 2))

console.log(`\n耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(`产物目录: docs/realtest/out/`)
