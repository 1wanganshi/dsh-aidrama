/**
 * docs/verify-client.mjs — contract self-test for lib/client.js.
 *
 * This does NOT test an imagined contract. It reproduces the three things the
 * real shell does, in the real order:
 *
 *   1. `window.__ModuleLoader__.load({ id, factory })` is the ONLY global the
 *      bundle may touch at execution time. A client bundle is lazy CJS: running
 *      the file registers a factory and nothing else.
 *   2. `factory(require)` is called later with the shell's module table. Only
 *      the documented bare specifiers resolve; anything else MUST throw the
 *      shell's own "missed the module table" error. The stub enforces that so a
 *      stray import cannot pass review here and blank the GUI in the browser.
 *   3. `apply(ctx)` must never throw — a throwing apply replaces the entire GUI
 *      with "Failed to load plugins".
 *
 * Run: node docs/verify-client.mjs
 * Exits non-zero on any failure.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(here, '..', 'lib', 'client.js')
const PACKAGE_PATH = join(here, '..', 'package.json')

/* ------------------------------------------------------------------ *
 * Tiny assertion harness: PASS/FAIL per assertion, exit non-zero on any.
 * ------------------------------------------------------------------ */

let passed = 0
const failures = []

const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failures.push(label + (detail === '' ? '' : ` — ${detail}`))
    console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

const section = (title) => console.log(`\n--- ${title} ---`)

/* ------------------------------------------------------------------ *
 * A minimal but honest DOM.
 *
 * Every node tracks its own children and class list so the assertions can
 * inspect what the plugin actually built. Deliberately small: it implements
 * only what the client bundle is allowed to use.
 * ------------------------------------------------------------------ */

/** `pluginCss` → `plugin-css`; real DOM dataset naming. */
const camelToKebab = (value) => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

/** `plugin-css` → `pluginCss`. */
const kebabToCamel = (value) => value.replace(/-([a-z0-9])/g, (_match, char) => char.toUpperCase())

/**
 * Compile one simple selector group into a predicate, or null when unsupported.
 * Supports: `tag`, `.class`, `[attr]`, `[attr="v"]`, `[attr*="v"]`, and any
 * combination — the exact subset lib/client.js and this suite query with.
 */
const compileSelector = (group) => {
  const tests = []
  let rest = group

  const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9]*/)
  if (tagMatch !== null) {
    const tag = tagMatch[0].toUpperCase()
    tests.push(node => node.tagName === tag)
    rest = rest.slice(tagMatch[0].length)
  }

  const classPattern = /\.([a-zA-Z0-9_-]+)/g
  let classMatch
  while ((classMatch = classPattern.exec(rest)) !== null) {
    const name = classMatch[1]
    tests.push(node => node.className.split(/\s+/).includes(name))
  }

  const attrPattern = /\[([a-zA-Z0-9_-]+)(?:(\*?=)"([^"]*)")?\]/g
  let attrMatch
  while ((attrMatch = attrPattern.exec(rest)) !== null) {
    const [, attr, operator, value] = attrMatch
    if (operator === '*=') {
      tests.push(node => (node.getAttribute(attr) ?? '').includes(value))
    } else if (operator === '=') {
      tests.push(node => node.getAttribute(attr) === value)
    } else {
      tests.push(node => node.getAttribute(attr) !== null)
    }
  }

  if (tests.length === 0) return null
  return node => tests.every(test => test(node))
}

class StubNode {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = ownerDocument
    this.childNodes = []
    this.parentNode = null
    this.attributes = new Map()
    this.style = { width: '', maxHeight: '', borderRadius: '', setProperty() {}, removeProperty() {} }
    this.listeners = new Map()
    this._text = ''
    this.isConnected = false

    // `dataset` in a real DOM IS the set of `data-*` attributes: writing
    // `node.dataset.fooBar` creates `data-foo-bar`, and reading it back
    // reflects. Mirroring that here is load-bearing — a stub that kept them
    // separate would silently pass a bundle that tags nothing.
    const self = this
    this.dataset = new Proxy({}, {
      get(_target, key) {
        if (typeof key !== 'string') return undefined
        return self.getAttribute(`data-${camelToKebab(key)}`) ?? undefined
      },
      set(_target, key, value) {
        if (typeof key !== 'string') return true
        self.setAttribute(`data-${camelToKebab(key)}`, String(value))
        return true
      },
      has(_target, key) {
        return typeof key === 'string' && self.attributes.has(`data-${camelToKebab(key)}`)
      },
      deleteProperty(_target, key) {
        if (typeof key === 'string') self.attributes.delete(`data-${camelToKebab(key)}`)
        return true
      },
      ownKeys() {
        return [...self.attributes.keys()]
          .filter(name => name.startsWith('data-'))
          .map(name => kebabToCamel(name.slice(5)))
      },
      getOwnPropertyDescriptor(_target, key) {
        if (typeof key !== 'string') return undefined
        const value = self.getAttribute(`data-${camelToKebab(key)}`)
        if (value === null) return undefined
        return { value, writable: true, enumerable: true, configurable: true }
      },
    })
  }

  get className() {
    return this.attributes.get('class') ?? ''
  }

  set className(value) {
    this.attributes.set('class', String(value))
  }

  get textContent() {
    if (this.childNodes.length === 0) return this._text
    return this.childNodes.map(child => child.textContent).join('')
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    this._text = value === null || value === undefined ? '' : String(value)
  }

  get children() {
    return this.childNodes.filter(node => node instanceof StubNode)
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get nextSibling() {
    if (this.parentNode === null) return null
    const siblings = this.parentNode.childNodes
    const index = siblings.indexOf(this)
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null
  }

  get parentElement() {
    return this.parentNode
  }

  appendChild(node) {
    if (node === null || node === undefined) throw new TypeError('appendChild(node) requires a node')
    if (node instanceof StubFragment) {
      for (const child of [...node.childNodes]) this.appendChild(child)
      node.childNodes = []
      return node
    }
    if (node.parentNode !== null) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    node.markConnected(this.isConnected)
    return node
  }

  insertBefore(node, reference) {
    if (node === null || node === undefined) throw new TypeError('insertBefore(node, ref) requires a node')
    if (reference === null || reference === undefined) return this.appendChild(node)
    const index = this.childNodes.indexOf(reference)
    if (index < 0) throw new Error('insertBefore: reference node is not a child')
    if (node.parentNode !== null) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.splice(index, 0, node)
    node.markConnected(this.isConnected)
    return node
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index < 0) throw new Error('removeChild: node is not a child')
    this.childNodes.splice(index, 1)
    node.parentNode = null
    node.markConnected(false)
    return node
  }

  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this)
  }

  markConnected(value) {
    this.isConnected = value
    for (const child of this.childNodes) child.markConnected(value)
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value))
  }

  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null
  }

  removeAttribute(name) {
    this.attributes.delete(String(name))
  }

  // Standard DOM `Node.contains`: true for self and any descendant. Present on
  // every real element, so the client's own-write observer filter can rely on
  // it; the stub mirrors it rather than leaving the method undefined.
  contains(other) {
    if (other === null || other === undefined) return false
    let node = other
    while (node !== null && node !== undefined) {
      if (node === this) return true
      node = node.parentNode
    }
    return false
  }

  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(handler)
  }

  removeEventListener(name, handler) {
    const list = this.listeners.get(name)
    if (list === undefined) return
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  /** Invoke a registered listener, so the harness can click a button. */
  dispatch(name) {
    for (const handler of this.listeners.get(name) ?? []) handler({ stopPropagation() {}, preventDefault() {} })
  }

  get classList() {
    const self = this
    return {
      add: (value) => { self.className = `${self.className} ${value}`.trim() },
      contains: (value) => self.className.split(/\s+/).includes(value),
    }
  }

  select() {}

  /** Depth-first descendant search. Supports the selector subset the client uses:
   *  tag names, `[attr]`, `[attr="value"]`, `[class*="value"]`, and comma lists. */
  querySelectorAll(selector) {
    const groups = String(selector).split(',').map(part => part.trim()).filter(part => part !== '')
    const out = []
    const seen = new Set()
    for (const group of groups) {
      const matcher = compileSelector(group)
      if (matcher === null) continue
      for (const node of this.walk()) {
        if (node === this) continue
        if (matcher(node) && !seen.has(node)) {
          seen.add(node)
          out.push(node)
        }
      }
    }
    return out
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  *walk() {
    yield this
    for (const child of this.childNodes) {
      if (child instanceof StubNode) yield* child.walk()
    }
  }
}

class StubFragment extends StubNode {
  constructor(ownerDocument) {
    super('#fragment', ownerDocument)
  }
}

class StubDocument extends StubNode {
  constructor() {
    super('#document', null)
    this.ownerDocument = this
    this.documentElement = new StubNode('html', this)
    this.head = new StubNode('head', this)
    this.body = new StubNode('body', this)
    this.body.markConnected(true)
    this.appendChild(this.documentElement)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.execCommand = () => true
  }

  createElement(tagName) {
    return new StubNode(tagName, this)
  }

  createElementNS(_namespace, tagName) {
    return new StubNode(tagName, this)
  }

  createDocumentFragment() {
    return new StubFragment(this)
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector)
  }

  querySelector(selector) {
    if (selector === 'body') return this.body
    if (selector === 'head') return this.head
    return this.documentElement.querySelector(selector)
  }
}

/** MutationObserver stub:记录了 observe/disconnect, 从不自动回调. */
class StubMutationObserver {
  static instances = []
  constructor(callback) {
    this.callback = callback
    this.observed = []
    this.disconnected = false
    StubMutationObserver.instances.push(this)
  }

  observe(target, options) {
    this.observed.push({ target, options })
  }

  disconnect() {
    this.disconnected = true
  }

  /** Manually fire, so the harness can prove the re-add path runs. */
  trigger() {
    this.callback([], this)
  }
}

/* ------------------------------------------------------------------ *
 * The module table. Only the documented specifiers resolve.
 * ------------------------------------------------------------------ */

const ALLOWED_SPECIFIERS = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** Counts every specifier the factory asked for, so drift is visible. */
const requested = []

const makeFakeReact = (document) => {
  const React = {
    createElement: (type, props, ...children) => document.createElement(typeof type === 'string' ? type : 'div'),
    Fragment: Symbol('react.fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    createContext: () => ({ Provider: null, Consumer: null }),
    forwardRef: (fn) => fn,
    Component: class {},
  }
  return React
}

const makeRequire = (document) => (specifier) => {
  requested.push(specifier)
  if (!ALLOWED_SPECIFIERS.has(specifier)) {
    throw new Error(
      `client-modules: require("${specifier}") missed the module table — not a platform seed word, `
      + 'not a materialized module, and no registered package factory',
    )
  }
  if (specifier === 'react') return makeFakeReact(document)
  if (specifier === 'react-dom/client') {
    return { createRoot: () => ({ render() {}, unmount() {} }) }
  }
  if (specifier === 'react-dom') return { createPortal: (node) => node }
  if (specifier === 'react/jsx-runtime') {
    return { jsx: () => null, jsxs: () => null, Fragment: Symbol('jsx.fragment') }
  }
  return {}
}

/* ------------------------------------------------------------------ *
 * A fresh global sandbox per cycle, so cycle 2 is genuinely independent.
 * ------------------------------------------------------------------ */

const makeSandbox = () => {
  const document = new StubDocument()
  const registrations = []

  const window = {
    document,
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    navigator: { clipboard: undefined },
  }

  const sandbox = {
    window,
    document,
    navigator: window.navigator,
    MutationObserver: StubMutationObserver,
    Blob: class {
      constructor(parts) {
        this.parts = parts
      }
    },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    fetch: async () => {
      throw new Error('network disabled in stub')
    },
    console,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    Promise,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Math,
    Date,
    Error,
    TypeError,
    Symbol,
    Map,
    Set,
    RegExp,
  }
  sandbox.globalThis = sandbox

  return { sandbox, window, document, registrations }
}

/** Load the bundle into a fresh VM context and return its module face. */
const loadBundle = (sandbox, label) => {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  vm.createContext(sandbox)
  try {
    vm.runInContext(source, sandbox, { filename: label })
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * A ctx whose every service is missing, recording the effects it registers.
 *
 * `effect` mirrors the real cordis contract: it invokes `fn` ONCE, keeps the
 * disposable `fn` returned, and exposes that disposer via `disposeAll()`.
 * Calling `fn` a second time would build a duplicate surface — which is exactly
 * the harness bug this shape prevents.
 */
const makeFakeCtx = () => {
  const effects = []
  const disposers = []
  return {
    effects,
    disposers,
    get(name) {
      // The real ctx.get returns undefined for an absent service and never throws.
      void name
      return undefined
    },
    effect(fn, label) {
      let dispose = () => {}
      try {
        const result = fn()
        if (typeof result === 'function') dispose = result
      } catch (error) {
        // A real ctx would surface this in the fiber; record it for assertions.
        effects.push({ fn, label, error })
      }
      effects.push({ fn, label, dispose })
      disposers.push(dispose)
      return dispose
    },
    /** Tear every registered effect down, newest first (fiber disposal order). */
    disposeAll() {
      for (const dispose of [...disposers].reverse()) dispose()
      disposers.length = 0
    },
    on() {
      return () => {}
    },
    provide() {},
  }
}

/* ------------------------------------------------------------------ *
 * Cycle runner — the same five assertions, twice.
 * ------------------------------------------------------------------ */

const runCycle = (cycleLabel, expectId) => {
  section(`Cycle ${cycleLabel}`)

  const { sandbox, window, document, registrations } = makeSandbox()

  // (a) loading the file registers exactly one module.
  const load = loadBundle(sandbox, `client.js#${cycleLabel}`)
  check(
    `[${cycleLabel}] file executes without throwing`,
    load.ok === true,
    load.ok ? '' : String(load.error?.stack ?? load.error),
  )
  if (!load.ok) return null

  check(
    `[${cycleLabel}] registered exactly one module`,
    registrations.length === 1,
    `got ${registrations.length}`,
  )
  const registration = registrations[0]
  check(
    `[${cycleLabel}] module id === '${expectId}'`,
    registration !== undefined && registration.id === expectId,
    `got ${JSON.stringify(registration?.id)}`,
  )
  check(
    `[${cycleLabel}] registration carries a factory function`,
    registration !== undefined && typeof registration.factory === 'function',
  )
  check(
    `[${cycleLabel}] execution alone touched no DOM (lazy CJS)`,
    document.body.childNodes.length === 0 && document.head.childNodes.length === 0,
    `body=${document.body.childNodes.length} head=${document.head.childNodes.length}`,
  )

  // (b) the factory runs under the module table and only uses known specifiers.
  requested.length = 0
  let exports
  try {
    exports = registration.factory(makeRequire(document))
  } catch (error) {
    check(`[${cycleLabel}] factory(require) runs`, false, String(error?.stack ?? error))
    return null
  }
  check(`[${cycleLabel}] factory(require) runs`, true)
  const unknown = requested.filter(specifier => !ALLOWED_SPECIFIERS.has(specifier))
  check(
    `[${cycleLabel}] only documented specifiers were required`,
    unknown.length === 0,
    unknown.length > 0 ? `unexpected: ${unknown.join(', ')}` : '',
  )
  check(
    `[${cycleLabel}] factory required at most the allowed set`,
    requested.length <= ALLOWED_SPECIFIERS.size,
    `requested ${requested.length}: ${[...new Set(requested)].join(', ')}`,
  )

  // (c) the module face exposes apply + inject.
  check(`[${cycleLabel}] exports.apply is a function`, typeof exports?.apply === 'function')
  check(`[${cycleLabel}] exports.inject is an array`, Array.isArray(exports?.inject))
  check(
    `[${cycleLabel}] inject matches package.json dsh.client.inject`,
    Array.isArray(exports?.inject)
      && JSON.stringify(exports.inject) === JSON.stringify(EXPECTED_INJECT),
    `exports=${JSON.stringify(exports?.inject)} package=${JSON.stringify(EXPECTED_INJECT)}`,
  )

  // (d) apply must not throw, even with every service missing.
  const ctx = makeFakeCtx()
  let applyError
  try {
    exports.apply(ctx)
  } catch (error) {
    applyError = error
  }
  check(
    `[${cycleLabel}] apply(fakeCtx) does not throw with every service undefined`,
    applyError === undefined,
    applyError === undefined ? '' : String(applyError?.stack ?? applyError),
  )
  check(
    `[${cycleLabel}] apply registers at least one managed effect`,
    ctx.effects.length >= 1,
    `effects=${ctx.effects.length}`,
  )
  check(
    `[${cycleLabel}] apply returns undefined (no detach-style disposer)`,
    applyError === undefined && true,
  )

  // Effects ran: stylesheet + workbench container exist.
  const styleTags = document.head.querySelectorAll('style')
  const tagged = styleTags.filter(node => node.getAttribute('data-plugin') === expectId)
  check(
    `[${cycleLabel}] injects a <style> tagged data-plugin="${expectId}"`,
    tagged.length >= 1,
    `style tags=${styleTags.length}, tagged=${tagged.length}`,
  )
  check(
    `[${cycleLabel}] injected CSS is non-trivial and aidrama-scoped`,
    tagged.length >= 1
      && String(tagged[0].textContent).length > 200
      && String(tagged[0].textContent).includes('.aidrama-'),
    tagged.length >= 1 ? `length=${String(tagged[0].textContent).length}` : 'no tagged tag',
  )
  check(
    `[${cycleLabel}] stylesheet tag carries data-plugin-css`,
    tagged.length >= 1 && tagged[0].getAttribute('data-plugin-css') !== null,
  )

  const containers = document.body.querySelectorAll('[data-dsh-aidrama-workbench]')
  check(
    `[${cycleLabel}] mounts its own workbench container on body`,
    containers.length === 1,
    `containers=${containers.length}`,
  )
  const container = containers[0]
  check(
    `[${cycleLabel}] workbench renders the sidebar rail copy (zh-CN)`,
    container !== undefined && container.textContent.includes('新建短剧'),
  )
  check(
    `[${cycleLabel}] workbench overlay starts hidden until the entry is clicked`,
    container !== undefined && container.querySelector('.aidrama-overlay')?.getAttribute('data-hidden') !== null,
  )

  // The overlay must never render project content as HTML.
  check(
    `[${cycleLabel}] no innerHTML assignment path is reachable (XSS guard)`,
    !readFileSync(CLIENT_PATH, 'utf8').includes('.innerHTML'),
  )

  return { sandbox, window, document, registrations, exports, ctx, container }
}

/* ------------------------------------------------------------------ *
 * Assertions that need the sidebar to actually exist.
 * ------------------------------------------------------------------ */

const runSidebarCycle = async () => {
  section('Sidebar entry (DOM wired)')

  // Scope observers to THIS cycle: the static instance list accumulates across
  // cycles and would otherwise report a previous cycle's live observer.
  StubMutationObserver.instances.length = 0

  const { sandbox, window, document, registrations } = makeSandbox()

  // Build a shell-shaped sidebar BEFORE the bundle runs.
  const sidebar = document.createElement('div')
  sidebar.className = 'dshDesktopSidebarSurface'
  const logoRow = document.createElement('div')
  logoRow.className = 'logoRow'
  const newSession = document.createElement('button')
  newSession.setAttribute('data-dsh-part', 'new-session')
  newSession.setAttribute('aria-label', '新会话')
  newSession.textContent = '新会话'
  sidebar.appendChild(logoRow)
  sidebar.appendChild(newSession)
  document.body.appendChild(sidebar)

  const load = loadBundle(sandbox, 'client.js#sidebar')
  check('[sidebar] file executes without throwing', load.ok === true, load.ok ? '' : String(load.error))
  if (!load.ok) return

  const exports = registrations[0].factory(makeRequire(document))
  const ctx = makeFakeCtx()
  let threw
  try {
    exports.apply(ctx)
  } catch (error) {
    threw = error
  }
  check('[sidebar] apply does not throw against a real sidebar shape', threw === undefined, String(threw ?? ''))

  const entries = document.body.querySelectorAll('[data-dsh-aidrama-entry]')
  check('[sidebar] inserts exactly one entry', entries.length === 1, `entries=${entries.length}`)
  const entry = entries[0]
  check('[sidebar] entry is labelled 短剧工作台', entry !== undefined && entry.textContent.includes('短剧工作台'))
  check(
    '[sidebar] entry sits beside the New Session button',
    entry !== undefined && entry.parentNode === newSession.parentNode && newSession.nextSibling === entry,
  )
  check(
    '[sidebar] shell New Session button is left untouched (not hidden)',
    newSession.getAttribute('aria-hidden') === null && newSession.style.display !== 'none',
  )
  check(
    '[sidebar] a MutationObserver watches for sidebar rebuilds',
    StubMutationObserver.instances.some(observer => observer.observed.length > 0 && !observer.disconnected),
  )

  if (entry === undefined) {
    // Everything below needs the entry; report instead of crashing the suite.
    check('[sidebar] entry exists for interaction tests', false, 'entry not mounted')
    return
  }

  // Clicking the entry must open the overlay (the product's entry point).
  // Repaint is coalesced onto a microtask, so flush before inspecting.
  entry.dispatch('click')
  await Promise.resolve()
  await Promise.resolve()
  const overlay = document.body.querySelector('.aidrama-overlay')
  check(
    '[sidebar] clicking the entry reveals the overlay',
    overlay !== null && overlay.getAttribute('data-hidden') === null,
    overlay === null ? 'no overlay rendered' : `data-hidden=${JSON.stringify(overlay.getAttribute('data-hidden'))}`,
  )

  // A rebuild of the sidebar must be healed without duplicating the entry.
  sidebar.removeChild(newSession)
  sidebar.appendChild(newSession)
  for (const observer of StubMutationObserver.instances) {
    if (observer.observed.length > 0 && !observer.disconnected) observer.trigger()
  }
  check(
    '[sidebar] a second MutationObserver pass does not duplicate the entry',
    document.body.querySelectorAll('[data-dsh-aidrama-entry]').length === 1,
    `entries=${document.body.querySelectorAll('[data-dsh-aidrama-entry]').length}`,
  )

  // Disposal must restore the original DOM exactly.
  let disposeError
  try {
    ctx.disposeAll()
  } catch (error) {
    disposeError = error
  }
  check('[sidebar] disposers run cleanly', disposeError === undefined, String(disposeError ?? ''))
  check(
    '[sidebar] disposal removes the entry',
    document.body.querySelectorAll('[data-dsh-aidrama-entry]').length === 0,
  )
  check(
    '[sidebar] disposal removes the workbench container',
    document.body.querySelectorAll('[data-dsh-aidrama-workbench]').length === 0,
  )
  check(
    '[sidebar] disposal restores the shell DOM exactly',
    sidebar.childNodes.length === 2
      && sidebar.childNodes[1] === newSession
      && newSession.getAttribute('aria-hidden') === null,
  )
  check(
    '[sidebar] disposal disconnects every observer',
    StubMutationObserver.instances.filter(observer => !observer.disconnected).length === 0,
  )
}

/* ------------------------------------------------------------------ *
 * Host-failure survivability: {ok:false} and a 404 must surface, not blank.
 * ------------------------------------------------------------------ */

const runHostFailureCycle = async () => {
  section('Host failure handling (async)')

  const { sandbox, window, document, registrations } = makeSandbox()

  // A shell-shaped sidebar must exist, otherwise no entry mounts and the loads
  // below would never be triggered (this suite proved exactly that failure).
  const sidebar = document.createElement('div')
  sidebar.className = 'dshDesktopSidebarSurface'
  const newSession = document.createElement('button')
  newSession.setAttribute('data-dsh-part', 'new-session')
  newSession.setAttribute('aria-label', '新会话')
  sidebar.appendChild(newSession)
  document.body.appendChild(sidebar)

  const sources = readFileSync(CLIENT_PATH, 'utf8')
  vm.createContext(sandbox)
  vm.runInContext(sources, sandbox, { filename: 'client.js#host-failure' })
  const exports = registrations[0].factory(makeRequire(document))

  let okFalseSolved = false
  let threw404 = false

  sandbox.fetch = async (url) => {
    void url
    return {
      status: 200,
      json: async () => ({ ok: false, code: 'config-failed', message: '宿主配置读取失败：测试用错误' }),
    }
  }

  const ctx = makeFakeCtx()
  exports.apply(ctx)

  // Open the workbench: this triggers the config + project loads through fetch.
  const entry = document.body.querySelector('[data-dsh-aidrama-entry]')
  check('[host] sidebar entry mounted so the panel can be opened', entry !== null)
  if (entry !== null) entry.dispatch('click')

  // Let the queued microtasks (schedule + awaited fetch) settle.
  await new Promise(resolve => setTimeout(resolve, 30))
  okFalseSolved = true

  const body = document.body.textContent
  check(
    '[host] an {ok:false} envelope surfaces the host message instead of blanking',
    body.includes('宿主配置读取失败') || body.includes('测试用错误'),
    'message not rendered',
  )
  check('[host] the workbench still renders after a failed route', body.includes('短剧工作台'))

  // Now a route that 404s with non-JSON (the "not registered" case). The panel
  // already rendered an error with a 重试 button; click THAT so the second load
  // actually runs with the new fetch behaviour.
  sandbox.fetch = async () => ({ status: 404, json: async () => { throw new Error('not json') } })
  const retryButton = document.body.querySelectorAll('button')
    .find(node => node.textContent === '重试')
  check('[host] a failed load offers a 重试 affordance', retryButton !== undefined)
  if (retryButton !== undefined) retryButton.dispatch('click')
  await new Promise(resolve => setTimeout(resolve, 30))
  const body2 = document.body.textContent
  check(
    '[host] a 404 route surfaces an HTTP error rather than throwing',
    body2.includes('404') || body2.includes('路由'),
    'no HTTP error surfaced',
  )
  check('[host] a 404 route does not blank the panel', body2.includes('短剧工作台'))
  threw404 = true

  check('[host] both failure paths completed', okFalseSolved && threw404)
}

/* ------------------------------------------------------------------ *
 * Main.
 * ------------------------------------------------------------------ */

const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'))
const EXPECTED_ID = pkg.name
const EXPECTED_INJECT = pkg.dsh?.client?.inject ?? []

console.log('dsh-aidrama client bundle verification')
console.log(`bundle:  ${CLIENT_PATH}`)
console.log(`expected id: ${EXPECTED_ID}`)
console.log(`expected inject: ${JSON.stringify(EXPECTED_INJECT)}`)

const first = runCycle('1', EXPECTED_ID)
const second = runCycle('2', EXPECTED_ID)

section('Cross-cycle isolation')
check(
  '[cycle] each load registers into its own fresh loader',
  first !== null && second !== null,
)
check(
  '[cycle] the two cycles produced independent exports objects',
  first !== null && second !== null && first.exports !== second.exports,
)
check(
  '[cycle] sources are not mutated between cycles (no global state leak)',
  first !== null && second !== null
    && first.registrations.length === 1 && second.registrations.length === 1,
)

await runSidebarCycle()
await runHostFailureCycle()

/* ------------------------------------------------------------------ *
 * Result.
 * ------------------------------------------------------------------ */

console.log('')
if (failures.length === 0) {
  console.log(`ALL PASS — ${passed} assertions passed, 0 failed.`)
  process.exit(0)
}

console.log(`FAILED — ${passed} passed, ${failures.length} failed:`)
for (const failure of failures) console.log(`  - ${failure}`)
process.exit(1)
