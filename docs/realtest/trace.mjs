// Trace exactly what the shot-ref route sees, one layer at a time.
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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aidrama-trace-'))
store.setDataRoot(tmp)

const seen = []
const routes = makeAidramaRoutes({
  store, stages, prompts, video,
  resolveConfig: () => ({
    enabled: true, allowAgentGeneration: true, announceToAgent: true,
    channels: [{ id: 'c', name: 'c', apiUrl: 'https://x/v1', apiKey: 'k', protocol: 'auto', models: [{ id: 'm', alias: 'm' }] }],
    defaultChannelId: 'c', defaultModel: 'm', videoChannels: [], defaultVideoChannelId: '',
    styleDna: P.PROJECT_DEFAULTS.styleDna, aspectRatio: '9:16', shotSeconds: 5,
  }),
  generateImage: async req => { seen.push(req); throw new Error('halt') },
  log: () => {},
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

const proj = await call(P.AIDRAMA_API.projects, { action: 'create', title: 'trace' })
const pid = proj.project.id

await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'bible', action: 'commit', payload: {
  styleDna: '3D 国漫，冷蓝夜色',
  characters: [{ id: 'char-linwan', name: '林晚', role: '主角', appearance: '清瘦',
    hair: '黑色短发，齐耳', face: '鹅蛋脸', body: '偏瘦，165cm',
    outfit: '深蓝地铁制服，左胸工牌', accessory: '银色细链耳钉' }],
  scenes: [{ id: 'scene-subway', name: '地铁车厢', kind: 'interior',
    description: '末班车空车厢', lighting: '冷白顶灯 + 隧道频闪', composition: '纵深透视' }],
}})

await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'script', action: 'commit', payload: {
  title: 't', episodes: [{ no: 1, title: 'e', scenes: [{
    no: 1, slug: 'subway-night', location: '地铁车厢', time: '夜',
    characters: ['char-linwan'], action: '林晚对着话筒报站。',
    dialogue: [{ who: '林晚', line: '下一站，西平路。' }], durationSec: 12,
    shots: [{ no: 1, shot: '中景', camera: '[推镜头]', description: '林晚对着话筒报站', motion: '缓慢推近' }],
  }] }],
}})

// Read the stored project and inspect what the route will see.
const doc = await store.readProject(pid)
// Content lives under `project.content[stageId]`; `project.stages[stageId]` holds
// only status metadata. (Reading the wrong one is how a trace lies to you.)
const sc = doc.content?.script ?? {}
console.log('=== stored script content ===')
console.log('script content keys:', Object.keys(sc))
console.log('shots at top level:', Array.isArray(sc.shots) ? sc.shots.length : '(none)')
if (Array.isArray(sc.shots) && sc.shots[0]) {
  console.log('shot[0]:', JSON.stringify({ id: sc.shots[0].id, characters: sc.shots[0].characters, sceneId: sc.shots[0].sceneId, scene: sc.shots[0].scene }))
}
console.log('episodes[0].scenes[0].characters:', JSON.stringify(sc.episodes?.[0]?.scenes?.[0]?.characters))
console.log('')
console.log('=== stored bible characters ===')
const bContent = doc.content?.bible ?? {}
console.log(JSON.stringify((bContent.characters ?? []).map(c => ({ id: c.id, name: c.name, hair: c.hair, outfit: c.outfit })), null, 2))
console.log('bible scenes:', JSON.stringify((bContent.scenes ?? []).map(s => ({ id: s.id, name: s.name, lighting: s.lighting }))))

// Now trigger generation and see the prompt.
seen.length = 0
const gen = await call(P.AIDRAMA_API.stage, { projectId: pid, stage: 'visual', action: 'generate', payload: {} })
console.log('')
console.log('=== generation requests captured:', seen.length, '===')
for (const req of seen) {
  console.log(`  kind=${req.kind} ref=${req.ref}`)
  const t = String(req.prompt)
  if (t.includes('，主体：')) {
    console.log('    主体:', t.split('，主体：')[1].split('，场景：')[0].slice(0, 200))
  }
}
await fs.rm(tmp, { recursive: true, force: true })
