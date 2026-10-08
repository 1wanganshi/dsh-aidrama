// Prove what prompt the plugin ACTUALLY sends for a shot-ref, end to end,
// through the real route handler and the real pack builder.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const lib = n => import(pathToFileURL(path.join(root, 'lib', 'host', n)).href)

const store = await lib('store.js')
const stages = await lib('stages.js')
const prompts = await lib('prompts.js')
const video = await lib('video.js')
const { makeAidramaRoutes } = await lib('routes.js')
const P = await lib('protocol.js')

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-prompt-'))
store.setDataRoot(tmp)

let captured = null
const generateImage = async req => { captured = req; throw new Error('stop-here') }

const routes = makeAidramaRoutes({
  store, stages, prompts, video,
  resolveConfig: () => ({
    enabled: true, allowAgentGeneration: true, announceToAgent: true,
    channels: [{ id: 'c', name: 'c', apiUrl: 'https://x/v1', apiKey: 'k', protocol: 'auto',
      models: [{ id: 'm', alias: 'm' }] }],
    defaultChannelId: 'c', defaultModel: 'm', videoChannels: [], defaultVideoChannelId: '',
    styleDna: P.PROJECT_DEFAULTS.styleDna, aspectRatio: '9:16', shotSeconds: 5,
  }),
  generateImage, log: () => {},
})

const byPath = p => routes.find(r => r.kind === 'exact' && r.path === p)
const call = (p, body) => new Promise((res, rej) => {
  const route = byPath(p)
  const chunks = []
  const req = { method: 'POST', url: p, headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
  const rs = { writeHead(c) { return rs }, setHeader() { return rs },
    end(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); res(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } }
  route.handler(req, rs)
})

const proj = await call(P.AIDRAMA_API.projects, { action: 'create', title: 'prompt-probe' })
const pid = proj.project.id

await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'bible', action: 'commit', payload: {
  styleDna: '3D 国漫，冷蓝夜色',
  characters: [{ id: 'char-linwan', name: '林晚', role: '主角', appearance: '清瘦',
    hair: '黑色短发，齐耳', face: '鹅蛋脸，眼尾微垂', body: '偏瘦，165cm',
    outfit: '深蓝地铁制服，左胸工牌', accessory: '银色细链耳钉' }],
  scenes: [{ id: 'scene-subway', name: '地铁车厢', kind: 'interior',
    description: '末班车空车厢', lighting: '冷白顶灯', composition: '纵深透视' }],
}})

await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'script', action: 'commit', payload: {
  title: 't', episodes: [{ no: 1, title: 'e', scenes: [{
    no: 1, slug: 'subway-night', location: '地铁车厢', time: '夜',
    characters: ['char-linwan'], action: '林晚对着话筒报站。',
    dialogue: [{ who: '林晚', line: '下一站，西平路。' }], durationSec: 12,
    shots: [{ no: 1, shot: '中景', camera: '[推镜头]', description: '林晚对着话筒报站', motion: '缓慢推近' }],
  }] }],
}})

captured = null
const gen = await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'visual', action: 'generate', payload: {} })
console.log('visual ok:', gen.ok, ' assets:', (gen.assets ?? []).length, ' failures:', (gen.failures ?? []).length)
console.log('')
if (captured) {
  console.log('=== the ACTUAL prompt sent for the first image ===')
  console.log('kind:', captured.kind, ' ref:', captured.ref)
  console.log('size:', captured.size)
  console.log('')
  const text = String(captured.prompt)
  console.log('--- 主体段 ---')
  const seg = text.includes('，主体：') ? text.split('，主体：')[1].split('，场景：')[0] : '(no 主体 section)'
  console.log(seg)
  console.log('')
  console.log('contains 齐耳短发:', text.includes('齐耳'))
  console.log('contains 深蓝地铁制服:', text.includes('深蓝地铁制服'))
  console.log('contains 银色细链耳钉:', text.includes('银色细链耳钉'))
} else {
  console.log('!! generateImage was never called — no image request was made')
}
await fs.rm(tmp, { recursive: true, force: true })
