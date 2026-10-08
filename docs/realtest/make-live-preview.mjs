/**
 * Render the REAL workbench to a screenshot.
 *
 * The previous preview hand-rebuilt the markup, so it could drift from what the
 * plugin actually draws and would happily show a screen that no longer exists.
 *
 * This does it properly:
 *   1. a small DOM is provided (same shape the DOM-stub suites use),
 *   2. the ACTUAL client bundle is loaded through its real loader contract,
 *   3. `apply()` runs, the workbench is opened, and a fake API is fed a project
 *      with content in every stage,
 *   4. the resulting live DOM is serialised to HTML,
 *   5. headless Chrome screenshots it.
 *
 * So the screenshot is the plugin's own output, not an artist's impression.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const outDir = path.join(root, 'docs', 'realtest', 'ui')
fs.mkdirSync(outDir, { recursive: true })

/* ------------------------------------------------------------------ *
 * Minimal DOM.
 * ------------------------------------------------------------------ */
const SVG_NS = 'http://www.w3.org/2000/svg'

class Node {
  constructor(tag, ns) {
    this.tagName = (tag || '').toUpperCase()
    this.namespaceURI = ns ?? null
    this.childNodes = []
    this.attributes = {}
    this.dataset = {}
    this.style = {}
    this.listeners = {}
    this.parentNode = null
    this._text = ''
    this.value = ''
    this.isContentEditable = false
  }
  get children() { return this.childNodes.filter(n => n instanceof Node) }
  appendChild(child) {
    if (child && child.__fragment) {
      for (const c of child.childNodes) { c.parentNode = this; this.childNodes.push(c) }
      child.childNodes = []
      return child
    }
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }
  append(...nodes) { for (const n of nodes) if (n) this.appendChild(n) }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(n => n !== this) }
  setAttribute(name, value) {
    this.attributes[name] = String(value)
    const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (camel.startsWith('data')) this.dataset[camel.slice(4).toLowerCase()] = String(value)
  }
  getAttribute(name) { return this.attributes[name] ?? null }
  hasAttribute(name) { return name in this.attributes }
  removeAttribute(name) { delete this.attributes[name] }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn) }
  set textContent(v) { this.childNodes = []; this._text = String(v) }
  get textContent() {
    if (this.childNodes.length === 0) return this._text
    return this.childNodes.map(n => n.textContent).join('')
  }
  // `str(props.text)` is assigned via textContent, but the SVG/`icon` path and
  // some call sites write `.text` directly.
  set text(v) { this.textContent = v }
  get text() { return this.textContent }
  get classList() {
    const self = this
    return {
      add: (c) => { const s = new Set(String(self.attributes.class || '').split(/\s+/).filter(Boolean)); s.add(c); self.attributes.class = [...s].join(' ') },
      remove: (c) => { const s = new Set(String(self.attributes.class || '').split(/\s+/).filter(Boolean)); s.delete(c); self.attributes.class = [...s].join(' ') },
      contains: (c) => String(self.attributes.class || '').split(/\s+/).includes(c),
    }
  }
}

class TextNode {
  constructor(text) { this._text = String(text); this.parentNode = null }
  get textContent() { return this._text }
}

const document = {
  body: new Node('body'),
  head: new Node('head'),
  documentElement: new Node('html'),
  createElement: (tag) => new Node(tag),
  createElementNS: (ns, tag) => new Node(tag, ns),
  createTextNode: (t) => new TextNode(t),
  createDocumentFragment: () => { const f = new Node('#fragment'); f.__fragment = true; return f },
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [],
}
// A minimal host sidebar, so the plugin's REAL entry button mounts and its
// click handler opens the workbench exactly as it does in the app.
const sidebarColumn = new Node('div')
sidebarColumn.setAttribute('data-pane', 'sidebar')
const newSessionBtn = new Node('button')
newSessionBtn.setAttribute('data-dsh-part', 'new-session')
newSessionBtn.setAttribute('aria-label', '新会话')
newSessionBtn.textContent = '新会话'
sidebarColumn.appendChild(newSessionBtn)
document.body.appendChild(sidebarColumn)

/** Substring-match helper mirroring the CSS `[class*=...]` tests we need. */
const attrMatches = (node, selector) => {
  // Supports: [attr="v"], [attr], [class*="v"], and comma-separated lists.
  for (const part of String(selector).split(',').map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^\[([\w-]+)(?:([*^$]?=)"?([^"\]]*)"?)?\]$/)
    if (!m) continue
    const [, name, op, value] = m
    const actual = node.attributes?.[name]
    if (actual === undefined) continue
    if (!op) return true
    if (op === '*' && String(actual).includes(value)) return true
    if (op === '=' && String(actual) === value) return true
  }
  return false
}

/** Cascading querySelector/All over a subtree, tag + attribute aware. */
function queryAll(rootNode, selector) {
  const scope = walk(rootNode)
  const parts = String(selector).split(',').map(s => s.trim()).filter(Boolean)
  const out = []
  for (const part of parts) {
    const tagMatch = part.match(/^([a-zA-Z]+)?(\[.*\])?$/)
    const wantTag = tagMatch?.[1] ? tagMatch[1].toUpperCase() : null
    const attrPart = part.replace(/^[a-zA-Z]+/, '')
    for (const n of scope) {
      if (wantTag && n.tagName !== wantTag) continue
      if (attrPart && !attrMatches(n, attrPart)) continue
      out.push(n)
    }
  }
  return out
}

Node.prototype.querySelector = function (selector) { return queryAll(this, selector)[0] ?? null }
Node.prototype.querySelectorAll = function (selector) { return queryAll(this, selector) }
Node.prototype.getElementsByTagName = function (tag) { return walk(this).filter(n => n.tagName === String(tag).toUpperCase()) }
Object.defineProperty(Node.prototype, 'firstElementChild', {
  get() { return this.children[0] ?? null }, configurable: true,
})
Object.defineProperty(Node.prototype, 'nextSibling', {
  get() {
    if (!this.parentNode) return null
    const sibs = this.parentNode.childNodes
    return sibs[sibs.indexOf(this) + 1] ?? null
  }, configurable: true,
})
Object.defineProperty(Node.prototype, 'isConnected', {
  get() {
    let n = this
    while (n) { if (n === documentStub.body) return true; n = n.parentNode }
    return false
  }, configurable: true,
})
Object.defineProperty(Node.prototype, 'parentElement', {
  get() { return this.parentNode ?? null }, configurable: true,
})
// The plugin's `el()` helper assigns `node.className`, the DOM property form.
// Without this accessor every element silently lost its class and the whole
// tree was unstyleable — the stub has to model BOTH spellings.
Object.defineProperty(Node.prototype, 'className', {
  get() { return this.attributes.class ?? '' },
  set(v) { this.attributes.class = String(v) },
  configurable: true,
})
Node.prototype.insertBefore = function (node, ref) {
  node.parentNode = this
  const i = ref ? this.childNodes.indexOf(ref) : -1
  if (i === -1) this.childNodes.push(node)
  else this.childNodes.splice(i, 0, node)
  return node
}

document.querySelectorAll = (selector) => queryAll(document.body, selector)
document.querySelector = (selector) => document.querySelectorAll(selector)[0] ?? null

document.body.style = {}

const documentStub = document

/* ------------------------------------------------------------------ *
 * Fake API — a project with content at every stage.
 * ------------------------------------------------------------------ */
const CHARACTER = {
  id: 'char-linwan',
  name: '林晚',
  appearance: '黑色齐耳短发，深蓝地铁制服，左胸工牌，银色细链耳钉',
  hair: '黑色齐耳短发',
  outfit: '深蓝地铁制服',
  accessory: '银色细链耳钉',
  want: '离开这座城市的夜班',
  wound: '三年前那场事故',
}
const SCENE = {
  id: 'scene-subway',
  name: '地铁车厢',
  lighting: '冷白顶灯 + 窗外流动的隧道灯带',
  mood: '疲惫、空旷',
}

/**
 * Real generated assets, pre-shrunk to 360px JPEG data URIs.
 *
 * The originals are 1024x1024 PNGs; inlining them raw made the preview page
 * 5.5 MB. The wall shows them at ~130px, so this is visually identical and
 * keeps the page shareable. Regenerate with docs/realtest/_mkthumbs.py.
 */
const IMG = readThumb('_t1.txt')
const IMG2 = readThumb('_t2.txt')

function readThumb(name) {
  const p = path.join(outDir, name)
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null
}

const PROJECT = {
  id: 'proj-1',
  title: '最后一班地铁',
  logline: '末班地铁的广播员发现，每晚都会多出一个不存在的站名。',
  aspectRatio: '9:16',
  episodes: 1,
  shotSeconds: 5,
  styleDna: '3D 国漫，电影级柔和轮廓光，统一 85mm 焦距',
  updatedAt: Date.now(),
  stages: [
    { id: 'idea', label: '想法梳理', short: '想法', status: 'ready' },
    { id: 'story', label: '剧情设计', short: '剧情', status: 'ready' },
    { id: 'script', label: '分场脚本', short: '脚本', status: 'ready' },
    { id: 'bible', label: '设定集', short: '设定集', status: 'ready' },
    { id: 'visual', label: '视觉资产', short: '视觉', status: 'running' },
    { id: 'video', label: '视频成片', short: '视频', status: 'empty' },
  ],
  content: {
    idea: { logline: '末班地铁的广播员发现，每晚都会多出一个不存在的站名。', hook: '不存在的站名' },
    story: { scenes: [{ id: 'sc-1' }, { id: 'sc-2' }, { id: 'sc-3' }] },
    script: {
      shots: [
        { id: 'sh-1', seq: 1, scene: '地铁车厢', shotSize: '中景', cameraMove: '推镜头', durationSeconds: 5, dialogue: '林晚：下一站，西平路。' },
        { id: 'sh-2', seq: 2, scene: '地铁车厢', shotSize: '特写', cameraMove: '固定机位', durationSeconds: 5 },
        { id: 'sh-3', seq: 3, scene: '站台', shotSize: '全景', cameraMove: '横移', durationSeconds: 5 },
        { id: 'sh-4', seq: 4, scene: '站台', shotSize: '近景', cameraMove: '手持', durationSeconds: 5 },
      ],
    },
    bible: { characters: [CHARACTER], scenes: [SCENE] },
    visual: {},
    video: {},
  },
  assets: [
    { id: 'a1', kind: 'character-sheet', ref: 'char-linwan', createdAt: Date.now(), bytes: 1000, width: 1024, height: 1024, name: '林晚 · 三视图', url: IMG },
    { id: 'a2', kind: 'shot-ref', ref: 'sh-1', createdAt: Date.now(), bytes: 1000, width: 1024, height: 1024, name: '镜 1 · 参考图', url: IMG2 },
  ],
  videoTasks: [],
}
const assetUrl = (projectId, assetId) => ({
  a1: IMG, a2: IMG2,
}[assetId] ?? null)

/* ------------------------------------------------------------------ *
 * Load the real bundle.
 * ------------------------------------------------------------------ */
globalThis.window = globalThis.window ?? {}
globalThis.document = documentStub
// Node 24 defines `navigator` as a getter-only accessor, so a plain assignment
// throws. Redefine it instead.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node' }, configurable: true, writable: true,
})
globalThis.HTMLElement = Node
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.MutationObserver = class { observe() {} disconnect() {} }

const captured = { factory: null }
globalThis.window.__ModuleLoader__ = { load({ factory }) { captured.factory = factory } }

const bundlePath = path.join(root, 'lib', 'client.js')
await import(`file:///${bundlePath.replace(/\\/g, '/')}?v=${Date.now()}`)

const requireStub = (name) => {
  if (name === 'react') return { createElement: () => null, Fragment: null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useMemo: (f) => f(), useCallback: (f) => f() }
  // The host half may look for React; this preview only exercises the client
  // half, so provide an inert surface rather than failing the whole load.
  if (name === 'react-dom/client' || name === 'react-dom') return { createRoot: () => ({ render() {}, unmount() {} }), render: () => {}, hydrateRoot: () => ({ render() {}, unmount() {} }) }
  throw new Error(`unexpected require: ${name}`)
}

const mod = captured.factory(requireStub)
const plugin = mod?.default ?? mod

/* ------------------------------------------------------------------ *
 * Drive it.
 * ------------------------------------------------------------------ */
const effects = []
const injectedStyles = []

const ctx = {
  effect(fn) { effects.push(fn); fn(); return () => {} },
  logger: { info() {}, warn() {}, error() {} },
  webServer: {
    register(route) { return () => {} },
  },
  systemPrompt: { add() {}, contribute() {} },
  on() { return () => {} },
}

const fetchStub = async (url, init) => {
  const u = String(url)
  const body = init?.body ? JSON.parse(init.body) : {}
  const action = body.action ?? new URL(u, 'http://x').searchParams.get('action')
  const json = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) })

  if (u.includes('/projects')) {
    if (action === 'list') return json({ ok: true, projects: [{ ...PROJECT, assetCount: 2 }] })
    if (action === 'get') return json({ ok: true, project: PROJECT })
  }
  if (u.includes('/config')) return json({ ok: true, channels: [{ id: 'coderxiaoc', name: 'coderxiaoc', apiUrl: 'https://coderxiaoc.com/v1', models: ['gpt-image-2.5-sunburst'], hasKey: true, protocol: 'openai' }], videoChannels: [] })
  if (u.includes('/asset')) {
    const id = body.id ?? new URL(u, 'http://x').searchParams.get('id')
    return { ok: true, status: 200, blob: async () => ({ size: 1000 }), json: async () => ({ ok: true }) }
  }
  return json({ ok: true })
}
globalThis.fetch = fetchStub

plugin.apply(ctx)

// Wait for the async loads the workbench kicks off, then render.
await new Promise(r => setTimeout(r, 60))

// Find the mounted container and open the panel.
const container = document.body.children.find(c => c.dataset && 'dshAidramaWorkbench' in c.dataset)
  ?? document.body.children.find(c => String(c.attributes.class || '').includes('aidrama'))

if (!container) {
  console.error('could not find the mounted container; children =', document.body.children.map(c => c.tagName + '.' + (c.attributes.class || '')))
  process.exit(1)
}

// Force a full render with a project loaded by simulating the rail click, then
// fall back to just showing the overlay.
const fire = (node, type, event = {}) => {
  for (const fn of node.listeners?.[type] ?? []) fn({ stopPropagation() {}, preventDefault() {}, target: node, ...event })
}

function walk(node, out = []) {
  out.push(node)
  for (const c of node.childNodes) if (c instanceof Node) walk(c, out)
  return out
}

const all = walk(container)
console.log('container:', container.tagName, container.attributes.class || '(no class)')
console.log('descendant nodes:', all.length)

// Open through the REAL sidebar entry, which is the path a user takes. The
// entry is mounted into the host's sidebar anchor, so search document.body.
const everything = walk(document.body)
const entry = everything.find(n => String(n.attributes?.class || '').includes('aidrama-entry'))
console.log('body nodes:', everything.length)
console.log('classes present:', [...new Set(everything.map(n => n.attributes?.class).filter(Boolean))].slice(0, 30))
if (entry) {
  console.log('found sidebar entry; clicking it')
  fire(entry, 'click')
} else {
  console.log('no sidebar entry found; nodes with a class:',
    everything.filter(n => n.attributes && n.attributes.class).map(n => n.attributes.class).slice(0, 24))
}
await new Promise(r => setTimeout(r, 150))

const projectBtn = walk(container).find(n => String(n.attributes.class || '').includes('aidrama-project'))
if (projectBtn) fire(projectBtn, 'click')
await new Promise(r => setTimeout(r, 200))

// Deliberately NOT clicking a stage card: the whole point is to screenshot the
// DEFAULT landing screen, which is what a user sees first.
const nodes = walk(container)

/* ------------------------------------------------------------------ *
 * Serialise.
 * ------------------------------------------------------------------ */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function serialize(node) {
  if (node instanceof TextNode) return esc(node._text)
  if (node.tagName === '#FRAGMENT') return node.childNodes.map(serialize).join('')
  let attrs = ''
  for (const [k, v] of Object.entries(node.attributes ?? {})) {
    if (k === 'style' && (v === '' || v == null)) continue
    attrs += ` ${k}="${esc(v)}"`
  }
  // Inline explicit style objects (the plugin sets attrs.style directly).
  if (node.attributes && node.attributes.style) attrs = attrs.replace(/ style="[^"]*"/, ` style="${esc(node.attributes.style)}"`)
  const voidTags = new Set(['IMG', 'BR', 'HR', 'INPUT', 'META', 'LINK'])
  // A node whose text was set via `textContent` holds it in `_text` with no
  // child nodes, so the inner HTML must fall back to that string.
  const inner = node.childNodes.length > 0
    ? node.childNodes.map(serialize).join('')
    : esc(node._text ?? '')
  if (voidTags.has(node.tagName)) return `<${node.tagName.toLowerCase()}${attrs}>`
  // Preserve SVG namespace so <path> renders.
  if (node.namespaceURI === SVG_NS && node.tagName === 'SVG') {
    return `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${inner}</svg>`
  }
  return `<${node.tagName.toLowerCase()}${attrs}>${inner}</${node.tagName.toLowerCase()}>`
}

const liveHtml = serialize(container)

const src = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
const cssStart = src.indexOf('    const CSS = `')
const cssEnd = src.indexOf('\n`', cssStart)
const pluginCss = src.slice(cssStart + '    const CSS = `'.length, cssEnd)

// The host theme, matching DSH's own desktop profile values.
const HOST_TOKENS = `
  --dsw-alias-bg-base:#101114; --dsw-alias-bg-layer-1:#16181D; --dsw-alias-bg-layer-2:#1B1E24; --dsw-alias-bg-layer-3:#22262E;
  --dsw-alias-label-primary:#E6E8EC; --dsw-alias-label-secondary:#A2A8B4; --dsw-alias-label-tertiary:#7A8290;
  --dsw-alias-border-l1:rgba(255,255,255,.09); --dsw-alias-border-l2:rgba(255,255,255,.16);
  --dsw-alias-brand-primary:#7C5CFF; --dsw-alias-interactive-bg-hover:rgba(255,255,255,.08);
  --dsw-alias-bg-mask:rgba(8,9,12,.62);
  --dsw-alias-state-success-primary:#2FBF7A; --dsw-alias-state-warning-primary:#F5A524; --dsw-alias-state-error-primary:#F2555A;
`

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  ${HOST_TOKENS}
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  background: #0d0e11; color: var(--dsw-alias-label-primary);
}
/* Stand-in for the host app behind the modal. */
.hostApp { position: absolute; inset: 0; padding: 26px 30px; color: #4d5462; font-size: 13px; }
.hostApp h1 { font-size: 17px; margin: 0 0 10px; color: #5b6270; }
.hostApp p { margin: 0 0 6px; }
${pluginCss}
</style></head><body>
  <div class="hostApp">
    <h1>DeepSeek Harness</h1>
    <p>对话内容位于模态层背后，会被遮罩压暗并虚化。</p>
    <p>短剧工作台是一个独立浮层，不占对话空间。</p>
  </div>
  ${liveHtml}
</body></html>`

fs.writeFileSync(path.join(outDir, 'live.html'), page)
console.log('wrote live.html  (', page.length, 'bytes )')

/* ------------------------------------------------------------------ *
 * Sidebar entry shot.
 *
 * The entry lives in the HOST's sidebar, so it never appears in the overlay
 * screenshot and was easy to forget entirely. Render it inside a stand-in
 * sidebar so the surface a user sees FIRST actually gets reviewed.
 * ------------------------------------------------------------------ */
const entryNode = walk(document.body).find(n => String(n.attributes?.class || '').includes('aidrama-entry'))
const entryHtml = entryNode ? serialize(entryNode) : '<em>entry not mounted</em>'
const framePath = path.join(outDir, 'entry-frame.html')
if (fs.existsSync(framePath)) {
  const entryPage = fs.readFileSync(framePath, 'utf8')
    .replace('/* PLUGIN_CSS */', pluginCss)
    .replace('<!-- entry injected here -->', entryHtml)
  fs.writeFileSync(path.join(outDir, 'entry.html'), entryPage)
  console.log('wrote entry.html (', entryPage.length, 'bytes )')
}
console.log('entry mounted:       ', entryNode !== undefined)
if (entryNode) {
  const metaNode = walk(entryNode).find(n => String(n.attributes?.class || '').includes('aidrama-entryMeta'))
  console.log('entry status line:   ', metaNode ? metaNode.textContent : '(missing)')
}
console.log('stage cards rendered:', nodes.filter(n => String(n.attributes.class || '').includes('aidrama-stageCard')).length)
console.log('kpi tiles rendered:  ', nodes.filter(n => String(n.attributes.class || '').includes('aidrama-kpi')).length)
console.log('hero rendered:       ', nodes.some(n => String(n.attributes.class || '').includes('aidrama-hero')))
console.log('rings rendered:      ', nodes.filter(n => String(n.attributes.class || '').includes('aidrama-ring')).length)
console.log('chips rendered:      ', nodes.filter(n => String(n.attributes.class || '').includes('aidrama-chip')).length)
console.log('stageGrid rendered:  ', nodes.some(n => String(n.attributes.class || '').includes('aidrama-stageGrid')))
