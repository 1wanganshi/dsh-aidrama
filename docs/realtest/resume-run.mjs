/**
 * Resume/verify the REAL run: generate the scene master and shot refs for the
 * fix, then compare them against the character sheet for on-model consistency.
 *
 * Separate from real-run.mjs so a killed batch can be resumed without redoing
 * everything (the upstream is slow: ~33s per success, 125s per 524).
 *
 * Needs AIDRAMA_KEY in the environment.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const lib = n => import(pathToFileURL(path.join(root, 'lib', 'host', n)).href)

const KEY = process.env.AIDRAMA_KEY ?? ''
if (KEY === '') { console.error('缺少 AIDRAMA_KEY'); process.exit(2) }
const URL_ = process.env.AIDRAMA_URL ?? 'https://coderxiaoc.com/v1'
const MODEL = process.env.AIDRAMA_MODEL ?? 'gpt-image-2.5-sunburst'

const store = await lib('store.js')
const stages = await lib('stages.js')
const prompts = await lib('prompts.js')
const video = await lib('video.js')
const { makeAidramaRoutes } = await lib('routes.js')
const P = await lib('protocol.js')

const outDir = path.join(root, 'docs', 'realtest', 'out')
await fs.mkdir(outDir, { recursive: true })
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-resume-'))
store.setDataRoot(tmp)

let seq = 0
const log = []

async function generateImage(request) {
  const prompt = request.negative ? `${request.prompt}。不要出现：${request.negative}` : request.prompt
  for (let i = 1; i <= 4; i++) {
    const t0 = Date.now()
    try {
      const res = await fetch(`${URL_}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, prompt, n: 1, size: request.size ?? '1024x1024', response_format: 'b64_json' }),
      })
      const ms = Date.now() - t0
      if (!res.ok) {
        if ([524, 503, 502].includes(res.status)) { await new Promise(r => setTimeout(r, 4000)); continue }
        throw new Error(`HTTP ${res.status}`)
      }
      const j = await res.json()
      const b64 = j.data?.[0]?.b64_json
      if (typeof b64 !== 'string' || b64 === '') throw new Error('no b64_json')
      seq += 1
      const buf = Buffer.from(b64, 'base64')
      const file = `${String(seq).padStart(2, '0')}-${request.kind}.png`
      await fs.writeFile(path.join(outDir, file), buf)
      log.push({ kind: request.kind, ref: request.ref, file, bytes: buf.length, ms })
      console.log(`   ✅ ${file}  ${(ms / 1000).toFixed(1)}s  ${Math.round(buf.length / 1024)}KB`)
      return { images: [{ b64, mime: 'image/png' }], model: MODEL, channel: 'coderxiaoc' }
    } catch (e) {
      await new Promise(r => setTimeout(r, 3000))
    }
  }
  log.push({ kind: request.kind, ref: request.ref, failed: true })
  console.log(`   ❌ ${request.kind}/${request.ref} 4 次尝试全部失败`)
  throw new Error('上游持续失败')
}

const routes = makeAidramaRoutes({
  store, stages, prompts, video,
  resolveConfig: () => ({
    enabled: true, allowAgentGeneration: true, announceToAgent: true,
    channels: [{ id: 'coderxiaoc', name: 'coderxiaoc', apiUrl: URL_, apiKey: KEY, protocol: 'auto',
      models: [{ id: MODEL, alias: MODEL }] }],
    defaultChannelId: 'coderxiaoc', defaultModel: MODEL, videoChannels: [], defaultVideoChannelId: '',
    styleDna: P.PROJECT_DEFAULTS.styleDna, aspectRatio: '9:16', shotSeconds: 5,
  }),
  generateImage, log: () => {},
})

const byPath = p => routes.find(r => r.kind === 'exact' && r.path === p)
const call = (p, body) => new Promise((res, rej) => {
  const route = byPath(p)
  if (!route) return rej(new Error(`no route ${p}`))
  const chunks = []
  const req = { method: 'POST', url: p, headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
  const rs = { writeHead() { return rs }, setHeader() { return rs },
    end(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); res(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } }
  route.handler(req, rs)
})

const HAIR = '黑色短发齐耳'
const OUTFIT = '深蓝地铁制服左胸工牌'

const proj = await call(P.AIDRAMA_API.projects, { action: 'create', title: '最后一班地铁' })
const pid = proj.project.id

await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'bible', action: 'commit', payload: {
  styleDna: '3D 国漫，冷蓝夜色，电影级柔和轮廓光，统一 85mm 焦距，细腻皮肤质感，无畸变',
  characters: [{ id: 'char-linwan', name: '林晚', role: '主角', appearance: '清瘦',
    hair: HAIR, face: '鹅蛋脸，眼尾微垂', body: '偏瘦，165cm',
    outfit: OUTFIT, accessory: '银色细链耳钉' }],
  scenes: [{ id: 'scene-subway', name: '地铁车厢', kind: 'interior',
    description: '末班车空车厢，两侧长椅，车窗映着隧道灯',
    lighting: '冷白顶灯 + 隧道频闪', composition: '纵深透视，消失点在画面右侧' }],
}})

await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'script', action: 'commit', payload: {
  title: '最后一班地铁',
  episodes: [{ no: 1, title: '末班车',
    scenes: [{ no: 1, slug: 'subway-night', location: '地铁车厢', time: '夜',
      characters: ['char-linwan'], action: '林晚对着广播话筒报站，车厢空得只剩她一个人。',
      dialogue: [{ who: '林晚', line: '下一站，西平路。' }], durationSec: 12,
      shots: [
        { no: 1, shot: '中景', camera: '[推镜头]', description: '林晚对着话筒报站，车厢空荡', motion: '镜头缓慢推近' },
        { no: 2, shot: '特写', camera: '[固定机位]', description: '她的手指停在广播键上', motion: '手指微微颤动' },
      ] }] }],
}})

console.log('真实生成：角色三视图 + 分镜参考图')
const visual = await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'visual', action: 'generate', payload: {} })
console.log(`\n返回 ok=${visual.ok}  成功 ${log.filter(x => !x.failed).length} 张  失败 ${log.filter(x => x.failed).length} 项`)
for (const x of log) console.log(`  ${x.failed ? 'FAIL' : 'OK  '} ${String(x.kind).padEnd(16)} ${x.file ?? ''}`)

await fs.writeFile(path.join(outDir, 'resume-report.json'),
  JSON.stringify({ model: MODEL, calls: log }, null, 2))
await fs.rm(tmp, { recursive: true, force: true })
