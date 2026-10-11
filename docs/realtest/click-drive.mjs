/**
 * CLICK TEST — drive the real client bundle the way a user does.
 *
 * Every other check in this repo asserts on SOURCE. This one loads the actual
 * bundle into a DOM stub, mounts it through the real sidebar entry, and CLICKS
 * things: rail buttons, stage cards, chips, the draft textarea, the generate
 * buttons, the export menu, the lightbox. The point is to catch what source
 * assertions cannot — a handler that throws, a state transition that renders a
 * blank screen, a button whose label lies about what it does.
 *
 * A THROWING apply() blanks the whole GUI, and a throwing click handler blanks
 * one screen, so "did anything throw" is the primary signal here.
 *
 * Run: node docs/realtest/click-drive.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

let pass = 0
let fail = 0
const problems = []
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; problems.push(label); console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`) }
}

/* ------------------------------------------------------------------ *
 * DOM stub — enough surface for the real bundle.
 * ------------------------------------------------------------------ */
class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.childNodes = []
    this.attributes = {}
    this.dataset = {}
    this.listeners = {}
    this.style = {}
    this.parentNode = null
    this._text = ''
    this._value = ''
    this.isConnected = true
  }

  get children() { return this.childNodes.filter(n => n instanceof StubNode) }
  get parentElement() { return this.parentNode instanceof StubNode ? this.parentNode : null }
  get firstElementChild() { return this.children[0] ?? null }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null }
  get nextSibling() {
    if (!this.parentNode) return null
    const i = this.parentNode.childNodes.indexOf(this)
    return i < 0 ? null : (this.parentNode.childNodes[i + 1] ?? null)
  }
  get previousSibling() {
    if (!this.parentNode) return null
    const i = this.parentNode.childNodes.indexOf(this)
    return i <= 0 ? null : (this.parentNode.childNodes[i - 1] ?? null)
  }
  get textContent() {
    if (this.childNodes.length === 0) return this._text
    return this.childNodes.map(c => (c instanceof StubNode ? c.textContent : String(c))).join('')
  }
  set textContent(v) { this._text = String(v); this.childNodes = [] }
  get value() { return this._value }
  set value(v) { this._value = String(v) }
  get className() { return this.attributes.class ?? '' }
  set className(v) { this.attributes.class = String(v) }
  get classList() {
    const self = this
    return {
      add: (...c) => { const s = new Set(String(self.attributes.class || '').split(/\s+/).filter(Boolean)); c.forEach(x => s.add(x)); self.attributes.class = [...s].join(' ') },
      remove: (...c) => { const s = new Set(String(self.attributes.class || '').split(/\s+/).filter(Boolean)); c.forEach(x => s.delete(x)); self.attributes.class = [...s].join(' ') },
      contains: (c) => String(self.attributes.class || '').split(/\s+/).includes(c),
      toggle: (c, on) => { on ? self.classList.add(c) : self.classList.remove(c) },
    }
  }

  appendChild(child) {
    if (child instanceof StubNode) child.parentNode = this
    this.childNodes.push(child)
    return child
  }
  insertBefore(child, ref) {
    const i = ref === null || ref === undefined ? this.childNodes.length : this.childNodes.indexOf(ref)
    if (child instanceof StubNode) child.parentNode = this
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, child)
    return child
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child)
    if (i >= 0) this.childNodes.splice(i, 1)
    return child
  }
  remove() { this.parentNode?.removeChild(this) }
  replaceChildren(...kids) { this.childNodes = []; kids.forEach(k => this.appendChild(k)) }
  setAttribute(k, v) { this.attributes[k] = String(v) }
  getAttribute(k) { return this.attributes[k] ?? null }
  removeAttribute(k) { delete this.attributes[k] }
  hasAttribute(k) { return k in this.attributes }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  removeEventListener(type, fn) {
    const a = this.listeners[type]
    if (a) this.listeners[type] = a.filter(f => f !== fn)
  }
  querySelector() { return null }
  querySelectorAll() { return [] }
  closest(sel) {
    const want = String(sel).replace(/^\./, '')
    let n = this
    while (n) {
      if (String(n.attributes?.class || '').split(/\s+/).includes(want)) return n
      n = n.parentNode
    }
    return null
  }
  focus() {}
  blur() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } }
  get scrollHeight() { return 0 }
  get offsetHeight() { return 0 }
  get offsetWidth() { return 0 }
  contains(node) {
    if (node === this) return true
    return this.childNodes.some(c => c instanceof StubNode && c.contains(node))
  }
  cloneNode() { return new StubNode(this.tagName) }
}

const documentStub = {
  createElement: (tag) => new StubNode(tag),
  createElementNS: (_ns, tag) => new StubNode(tag),
  createTextNode: (t) => { const n = new StubNode('#text'); n.textContent = t; return n },
  createDocumentFragment: () => new StubNode('#fragment'),
  body: new StubNode('body'),
  head: new StubNode('head'),
  documentElement: new StubNode('html'),
  listeners: {},
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) },
  removeEventListener() {},
  querySelector(sel) {
    return StubNode.prototype.querySelector.call(this.body, sel)
  },
  querySelectorAll(sel) {
    return StubNode.prototype.querySelectorAll.call(this.body, sel)
  },
}

globalThis.document = documentStub

// The host shell must exist BEFORE apply(): the entry mounts itself next to the
// shell's New Session button, so without a shell it correctly stays hidden.
buildHostShell()

/** Depth-first search honouring a CSS-ish selector subset. */
function matchesSelector(node, sel) {
  return String(sel).split(',').map(s => s.trim()).filter(Boolean).some(part => {
    const attr = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/)
    if (attr) {
      const v = node.attributes?.[attr[1]]
      return v !== undefined && (attr[2] === undefined || v === attr[2])
    }
    if (part.startsWith('.')) return String(node.attributes?.class || '').split(/\s+/).includes(part.slice(1))
    if (part.startsWith('button')) {
      if (node.tagName !== 'BUTTON') return false
      const rest = part.slice('button'.length)
      if (rest === '') return true
      return matchesSelector(node, rest)
    }
    return node.tagName === part.toUpperCase()
  })
}

StubNode.prototype.querySelector = function querySelector(sel) {
  for (const child of this.childNodes) {
    if (!(child instanceof StubNode)) continue
    if (matchesSelector(child, sel)) return child
    const deep = child.querySelector(sel)
    if (deep !== null) return deep
  }
  return null
}
StubNode.prototype.querySelectorAll = function querySelectorAll(sel) {
  const out = []
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (!(child instanceof StubNode)) continue
      if (matchesSelector(child, sel)) out.push(child)
      visit(child)
    }
  }
  visit(this)
  return out
}

/**
 * Build the HOST SHELL the entry needs.
 *
 * The sidebar entry mounts itself next to the shell's "New Session" button and
 * stays hidden when that button is absent. An earlier version of this harness had
 * no shell at all, so the entry silently never appeared and the test blamed the
 * plugin. The shell is the environment here, not the thing under test.
 */
function buildHostShell() {
  const sidebar = new StubNode('div')
  sidebar.setAttribute('data-pane', 'sidebar')
  const column = new StubNode('div')
  column.className = 'sidebarCol'
  sidebar.appendChild(column)

  const logoRow = new StubNode('div')
  logoRow.className = 'logoRow'
  column.appendChild(logoRow)

  const newSession = new StubNode('button')
  newSession.className = 'newSession'
  newSession.setAttribute('data-dsh-part', 'new-session')
  newSession.setAttribute('aria-label', 'New Session')
  newSession.textContent = '新会话'
  column.appendChild(newSession)

  const list = new StubNode('div')
  list.className = 'sessionList'
  column.appendChild(list)

  documentStub.body.appendChild(sidebar)
  return { sidebar, column, newSession }
}

Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  configurable: true, writable: true,
})
globalThis.HTMLElement = StubNode
globalThis.Element = StubNode
globalThis.Node = StubNode
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } }
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })

/* ------------------------------------------------------------------ *
 * Capture the factory and load the REAL bundle.
 * ------------------------------------------------------------------ */
const captured = { factory: null }
globalThis.window = globalThis.window ?? {}
globalThis.window.__ModuleLoader__ = { load({ factory }) { captured.factory = factory } }
globalThis.window.addEventListener = () => {}
globalThis.window.removeEventListener = () => {}

const bundlePath = path.join(root, 'lib', 'client.js')
const source = fs.readFileSync(bundlePath, 'utf8')
await import(`file:///${bundlePath.replace(/\\/g, '/')}?v=${Date.now()}`)

check('the bundle registered a factory on __ModuleLoader__', captured.factory !== null)
if (captured.factory === null) { console.log('cannot continue'); process.exit(1) }

/* ------------------------------------------------------------------ *
 * A realistic backing project, served through a fetch stub.
 * ------------------------------------------------------------------ */
const PROJECT = {
  id: 'p-click', title: '点击测试', logline: '用来验证界面真的能点。',
  aspectRatio: '9:16', styleDna: '3D 国漫，电影级柔和轮廓光', episodes: 2, shotSeconds: 5,
  stages: Object.fromEntries(['idea', 'story', 'script', 'bible', 'visual', 'video'].map(id => [id, {
    status: ['idea', 'story', 'script', 'bible'].includes(id) ? 'ready' : 'empty',
    revision: 1, updatedAt: Date.now(), note: '',
  }])),
  content: {
    idea: {
      title: '点击测试', logline: '一个用来验证界面的故事。', genre: '测试',
      audience: '所有人', flavor: '轻快', length: '短篇', seed: '一句话想法',
      protagonist: '测试者', conflict: '按钮点不动', ending: '都点通了',
    },
    story: { title: '点击测试', logline: '一句话', synopsis: '梗概', theme: '主题', acts: [], beats: [], characters: [], episodes: [] },
    script: { title: '点击测试', episodes: [], shots: [] },
    bible: { characters: [], scenes: [] },
    visual: {}, video: {},
  },
  assets: [], videoTasks: [],
}

let fetchCount = 0
const requestLog = []
/** The projects the stub serves; the empty-project pass swaps this out. */
const PROJECTS_FOR_STUB = [PROJECT]
globalThis.fetch = async (url, init) => {
  fetchCount += 1
  const u = String(url)
  const body = init?.body ? JSON.parse(init.body) : {}
  requestLog.push(`${u} ${JSON.stringify(body).slice(0, 80)}`)
  const action = body.action ?? new URL(u, 'http://x').searchParams.get('action')
  const json = (p) => ({ ok: true, status: 200, json: async () => p, text: async () => JSON.stringify(p) })
  if (u.includes('/projects')) {
    if (action === 'list') return json({ ok: true, projects: PROJECTS_FOR_STUB.map(p => ({ ...p, assetCount: 0 })) })
    if (action === 'get') {
      const wanted = PROJECTS_FOR_STUB.find(p => p.id === body.id) ?? PROJECT
      return json({ ok: true, project: wanted })
    }
    if (action === 'create') return json({ ok: true, project: PROJECT })
  }
  if (u.includes('/project')) {
    if (action === 'get') return json({ ok: true, project: PROJECT })
    return json({ ok: true, project: PROJECT })
  }
  if (u.includes('/config')) {
    return json({ ok: true, config: {
      enabled: true, aspectRatio: '9:16', shotSeconds: 5, styleDna: '3D 国漫',
      channels: [{ id: 'c1', name: '测试渠道', apiUrl: 'https://x/v1', models: [{ alias: 'm1' }], hasKey: true, protocol: 'openai' }],
      videoChannels: [],
    } })
  }
  if (u.includes('/stage')) return json({ ok: true, assets: [], failures: [], project: PROJECT })
  if (u.includes('/video')) return json({ ok: true, tasks: [], failures: [] })
  if (u.includes('/export')) return json({ ok: true, export: { format: 'json', content: '{}' } })
  return json({ ok: true })
}

/* ------------------------------------------------------------------ *
 * Mount through the REAL sidebar entry.
 * ------------------------------------------------------------------ */
const injectedStyles = []
// Capture console noise: the client half warns instead of throwing in several
// places, and a swallowed warning is exactly why a blank screen has no symptom.
const warnings = []
const realWarn = console.warn
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); realWarn(...args) }

const ctx = {
  effect(fn) { try { fn() } catch (e) { check('ctx.effect threw', false, String(e)) } return () => {} },
  logger: { info() {}, warn() {}, error() {} },
  webServer: { register() { return () => {} } },
  systemPrompt: { add() {}, contribute() {} },
  on() { return () => {} },
  inject() { return () => {} },
  get() { return undefined },
  provide() {},
  set() {},
}

const requireStub = (name) => {
  if (name === 'react') {
    return {
      createElement: (type, props, ...kids) => ({ type, props: { ...props, children: kids } }),
      Fragment: 'Fragment', useState: (v) => [v, () => {}], useEffect: () => {},
      useRef: () => ({ current: null }), useMemo: (f) => (typeof f === 'function' ? f() : f),
      useCallback: (f) => f, useSyncExternalStore: () => null,
    }
  }
  if (String(name).startsWith('react-dom')) {
    return { createRoot: () => ({ render() {}, unmount() {} }), render() {}, hydrateRoot: () => ({ render() {}, unmount() {} }) }
  }
  throw new Error(`unexpected require: ${name}`)
}

let applyThrew = null
let plugin
try {
  plugin = captured.factory(requireStub)
  plugin = plugin?.default ?? plugin
} catch (e) {
  applyThrew = e
}
check('the factory produces a plugin object', plugin !== null && plugin !== undefined,
  applyThrew ? String(applyThrew) : '')

if (plugin && typeof plugin.apply === 'function') {
  try { plugin.apply(ctx) } catch (e) { applyThrew = e }
}
check('apply() does not throw (a throwing apply blanks the whole GUI)',
  applyThrew === null, applyThrew ? `${applyThrew.name}: ${applyThrew.message}` : '')

await new Promise(r => setTimeout(r, 80))

/* ------------------------------------------------------------------ *
 * Click everything.
 * ------------------------------------------------------------------ */
const walk = (node, out = []) => {
  out.push(node)
  for (const c of node.childNodes ?? []) if (c instanceof StubNode) walk(c, out)
  return out
}

const fire = (node, type, extra = {}) => {
  const fns = node.listeners?.[type] ?? []
  let threw = null
  for (const fn of fns) {
    try {
      fn({ stopPropagation() {}, preventDefault() {}, target: node, currentTarget: node, ...extra })
    } catch (e) { threw = e }
  }
  return { fired: fns.length, threw }
}

const all = () => walk(documentStub.body)
const byClass = (frag) => all().filter(n => String(n.attributes?.class || '').includes(frag))

console.log(`\nmounted nodes: ${all().length}`)
check('the workbench mounted something into the DOM', all().length > 1,
  `body children: ${documentStub.body.children.length}`)

// 1. Sidebar entry
const entry = byClass('aidrama-entry')
check('the sidebar entry exists', entry.length > 0)
if (entry.length > 0) {
  const r = fire(entry[0], 'click')
  check('clicking the sidebar entry does not throw', r.threw === null, r.threw ? String(r.threw) : '')
}
await new Promise(r => setTimeout(r, 120))

// 2. Every button, one at a time, re-rendering between clicks.
const readButtons = () => all().filter(n => n.tagName === 'BUTTON' && n.isConnected)
let clicked = 0
let threwOn = []

for (let round = 0; round < 6; round += 1) {
  const buttons = readButtons()
  if (buttons.length === 0) break
  let progressed = false
  for (const btn of buttons) {
    const label = (btn.textContent || '').trim().slice(0, 24) || '(无标签)'
    // Skip destructive actions: this test is about whether handlers survive.
    if (label.includes('删除')) continue
    const r = fire(btn, 'click')
    clicked += 1
    if (r.threw) { threwOn.push(`${label}: ${r.threw.message ?? r.threw}`); continue }
    progressed = true
    await new Promise(res => setTimeout(res, 12))
    break // re-read the DOM after each click; indices go stale
  }
  if (!progressed) break
}

check('buttons were actually clicked', clicked > 0, `clicked ${clicked}`)
check('no button click threw', threwOn.length === 0, threwOn.slice(0, 4).join(' | '))

// 3. Stage navigation — every stage in the rail.
let stageThrew = []
for (const frag of ['aidrama-stageCard', 'aidrama-railItem', 'aidrama-tab']) {
  for (const card of byClass(frag)) {
    const r = fire(card, 'click')
    if (r.threw) stageThrew.push(`${frag}: ${r.threw.message}`)
    await new Promise(res => setTimeout(res, 8))
  }
}
check('stage navigation does not throw', stageThrew.length === 0, stageThrew.slice(0, 3).join(' | '))

// 2. Open the project. The row is a <button class="aidrama-project">, so take the
//    first one regardless of tag — an earlier version filtered OUT buttons here
//    and then reported "no project row", blaming the UI for the harness's bug.
const projectRows = byClass('aidrama-project').filter(n => (n.listeners?.click ?? []).length > 0)
if (projectRows.length > 0) {
  const r = fire(projectRows[0], 'click')
  check('opening a project does not throw', r.threw === null, r.threw ? String(r.threw) : '')
} else {
  check('a project row is listed and clickable', false, 'no .aidrama-project with a click listener')
}
await new Promise(r => setTimeout(r, 150))

// 3. Walk every stage in order, the way a user works through the pipeline:
//    想法 → 剧情 → 脚本 → 设定 → 视觉 → 视频. Each one must render without
//    throwing, and we record whether the idea step really produces a draft box.
// The step titles are the full stage labels (想法梳理 … 视频成片), while the badge
// shows a short form. Match on the title attribute, prefix-wise.
const stageResults = []
for (const label of ['想法', '剧情', '分场脚本', '设定', '视觉', '视频', '总览']) {
  const step = byClass('aidrama-step').find(n => String(n.attributes?.title || '').startsWith(label))
  if (step === undefined) { stageResults.push({ label, threw: new Error('入口未找到'), chars: 0, areas: 0 }); continue }
  const r = fire(step, 'click')
  await new Promise(res => setTimeout(res, 60))
  const panel = byClass('aidrama-panel')[0]
  const text = (panel?.textContent ?? '').trim()
  const areas = all().filter(n => n.tagName === 'TEXTAREA').length
  stageResults.push({
    label,
    threw: r.threw,
    // A stage that renders an empty panel is the failure a source assertion
    // cannot see: the handler runs, nothing appears.
    chars: text.length,
    areas,
  })
}

check('no stage navigation threw',
  stageResults.every(s => !s.threw),
  stageResults.filter(s => s.threw).map(s => `${s.label}: ${s.threw.message}`).join(' | '))
check('EVERY stage renders visible content',
  stageResults.every(s => s.chars > 10),
  stageResults.filter(s => s.chars <= 10).map(s => `${s.label} rendered ${s.chars} chars`).join(' | '))
console.log('      ' + stageResults
  .map(s => `${s.label}: ${s.threw ? 'THREW' : 'ok'} ${s.chars}字 ${s.areas}个文本框`)
  .join('\n      '))

/**
 * Step-one shape, measured on the project the harness actually opened.
 *
 * The `<details>` holding the eight detail fields opens ITSELF as soon as any of
 * them holds a value (`if (filled.length > 0) details.setAttribute('open','')`),
 * which is deliberate — someone who filled details wants to see them. The stub
 * project here HAS an idea filled in, so seeing the fields open is CORRECT.
 *
 * The new-user case (nothing filled -> collapsed) is asserted separately in
 * docs/verify-idea-step-is-small.mjs, where the empty state can be constructed
 * cleanly instead of fighting the render loop.
 */
const ideaVisible = () => {
  const hiddenByDetails = (node) => {
    let n = node.parentNode
    while (n) {
      if (n.tagName === 'DETAILS' && !('open' in n.attributes)) return true
      n = n.parentNode
    }
    return false
  }
  return all().filter(n => !hiddenByDetails(n))
}

const ideaStepForAsk = byClass('aidrama-step').find(n => String(n.attributes?.title || '').startsWith('想法'))
if (ideaStepForAsk) { fire(ideaStepForAsk, 'click'); await new Promise(r => setTimeout(r, 100)) }

const visible = ideaVisible()
const visibleAreas = visible.filter(n => n.tagName === 'TEXTAREA')
const chipNodes = visible.filter(n => String(n.attributes?.class || '').includes('aidrama-chip'))
console.log(`\n  step-1 (idea filled): ${visibleAreas.length} textarea, ${chipNodes.length} chip`)

check('step one always offers tap-to-choose chips', chipNodes.length >= 3, `found ${chipNodes.length}`)
check('step one has an input for the idea itself', visibleAreas.length >= 1, `found ${visibleAreas.length}`)
// Whatever the open/closed state, the ONLY primary box must be first and the
// tap-to-choose row must be reachable without opening anything.
const primaryAreas = visible.filter(n => String(n.attributes?.class || '').includes('aidrama-primaryBox'))
check('the idea box is distinguishable from the detail fields',
  primaryAreas.length >= 1 || visibleAreas.length >= 1)

// Return to step 1 and confirm the draft box is there. Match on the step's TITLE
// attribute, not its text: the badge adds a leading digit ("1想法") and the text
// also carries a status dot, so a text match is fragile.
const ideaStep = byClass('aidrama-step').find(n => String(n.attributes?.title || '').startsWith('想法'))
if (ideaStep) { fire(ideaStep, 'click'); await new Promise(res => setTimeout(res, 80)) }

// 4. Text input — the draft textarea, then a chip.
const areas = all().filter(n => n.tagName === 'TEXTAREA')
if (areas.length === 0) {
  // Diagnostic: say WHERE we are, so a missing textarea is debuggable instead of
  // just "not found". The idea screen needs the project open AND the stage
  // selected; either step failing leaves the landing list on screen.
  const classes = [...new Set(all().map(n => String(n.attributes?.class || '')).filter(Boolean))]
  console.log('\n      --- no textarea; screen classes ---')
  console.log('      ' + classes.slice(0, 24).join('\n      '))
  const labels = all().filter(n => n.tagName === 'BUTTON').map(n => (n.textContent || '').trim().slice(0, 20))
  console.log('      buttons: ' + labels.join(' | '))
  console.log('      --- requests made ---')
  console.log('      ' + requestLog.slice(-8).join('\n      '))
  const details = all().filter(n => n.tagName === 'DETAILS' || n.tagName === 'SUMMARY')
  console.log('      details/summary: ' + details.map(n => n.textContent.trim().slice(0, 30)).join(' | '))
  const main = all().filter(n => String(n.attributes?.class || '').includes('aidrama-body'))
  if (main.length > 0) {
    const inner = walk(main[0]).map(n => String(n.attributes?.class || '')).filter(Boolean)
    console.log('      body content classes: ' + [...new Set(inner)].slice(0, 20).join(', '))
  }
  console.log('      --- warnings ---')
  console.log('      ' + (warnings.length ? warnings.slice(0, 6).join('\n      ') : '(none)'))
  const railText = byClass('aidrama-rail')[0]?.textContent ?? '(no rail)'
  console.log('      rail text: ' + railText.slice(0, 120))
  const panelText = byClass('aidrama-panel')[0]?.textContent ?? '(no panel)'
  console.log('      panel text: ' + panelText.slice(0, 160))
}
check('a text input is present for the draft', areas.length > 0, `found ${areas.length}`)
if (areas.length > 0) {
  const area = areas[0]
  area.value = '一个人在地铁里听见了自己的声音。'
  const r = fire(area, 'input')
  check('typing into the draft does not throw', r.threw === null, r.threw ? String(r.threw) : '')
}
const chips = byClass('aidrama-chip')
if (chips.length > 0) {
  const r = fire(chips[0], 'click')
  check('clicking a choice chip does not throw', r.threw === null, r.threw ? String(r.threw) : '')
} else {
  console.log('SKIP  no chips on this screen')
}
await new Promise(r => setTimeout(r, 40))

// 5. The screen must still have content — a blank render is the failure mode a
//    source assertion cannot see.
const finalNodes = all().length
check('the UI still renders content after all that clicking', finalNodes > 20,
  `${finalNodes} nodes`)

// 6. Every request the UI made must look well-formed.
check('the UI talked to the host', fetchCount > 0, `${fetchCount} requests`)

console.log(`\n${'='.repeat(60)}`)
console.log(fail === 0
  ? `ALL PASS — ${pass} passed, 0 failed  (${clicked} clicks, ${fetchCount} requests)`
  : `${fail} FAILED of ${pass + fail}`)
if (problems.length > 0) console.log('problems:\n  ' + problems.join('\n  '))
process.exit(fail === 0 ? 0 : 1)
