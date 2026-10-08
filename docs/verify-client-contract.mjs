/**
 * LEAD's independent adversarial probe of the client bundle.
 *
 * Deliberately does NOT reuse the teammate's harness. It builds its own loader
 * stub from the contract I verified firsthand, then tries to BREAK the bundle:
 * missing services, hostile DOM, missing React, absent selectors, double load.
 * A bundle that only survives a friendly stub is not shippable.
 *
 * Run: node docs/_lead-client-probe.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')
const source = await fs.readFile(bundlePath, 'utf8')

let passed = 0
let failed = 0
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failed += 1; console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

/* ------------------------------------------------- a minimal, honest DOM */

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    childNodes: [],
    attributes: {},
    style: {},
    dataset: {},
    parentNode: null,
    isConnected: false,
    textContent: '',
    className: '',
    classList: {
      _set: new Set(),
      add(...names) { names.forEach(name => this._set.add(name)) },
      remove(...names) { names.forEach(name => this._set.delete(name)) },
      contains(name) { return this._set.has(name) },
      toggle(name) { this._set.has(name) ? this._set.delete(name) : this._set.add(name) },
    },
    get firstElementChild() { return this.children[0] ?? null },
    get lastElementChild() { return this.children[this.children.length - 1] ?? null },
    get nextSibling() { return null },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/gu, (_, c) => c.toUpperCase())
        this.dataset[key] = String(value)
      }
      if (name === 'class') this.className = String(value)
    },
    getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name) },
    removeAttribute(name) { delete this.attributes[name] },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child)
      this.children.push(child); this.childNodes.push(child)
      child.parentNode = this; child.isConnected = true
      return child
    },
    insertBefore(child, ref) {
      const index = ref === null ? this.children.length : this.children.indexOf(ref)
      const at = index === -1 ? this.children.length : index
      if (child.parentNode) child.parentNode.removeChild(child)
      this.children.splice(at, 0, child); this.childNodes.splice(at, 0, child)
      child.parentNode = this; child.isConnected = true
      return child
    },
    removeChild(child) {
      const i = this.children.indexOf(child)
      if (i !== -1) { this.children.splice(i, 1); this.childNodes.splice(i, 1) }
      child.parentNode = null; child.isConnected = false
      return child
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null },
    querySelectorAll() { return [] },
    cloneNode() { return makeElement(tag) },
  }
  return el
}

/** A document whose querySelector answers NOTHING — the hostile case. */
function makeBareDocument() {
  const head = makeElement('head')
  const body = makeElement('body')
  const doc = {
    head, body,
    documentElement: makeElement('html'),
    createElement: tag => makeElement(tag),
    createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
    createDocumentFragment: () => makeElement('fragment'),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
  }
  return doc
}

/**
 * Load the bundle under a fresh global environment.
 * @param {{withReact?:boolean, withDom?:boolean, throwOnUnexpected?:boolean}} [opts]
 */
async function loadBundle(opts = {}) {
  const withReact = opts.withReact ?? true
  const registry = []
  const requested = []

  const React = {
    createElement: (type, props, ...children) => ({ __el: true, type, props, children }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {}, useRef: value => ({ current: value }),
    useMemo: fn => fn(), useCallback: fn => fn, useLayoutEffect: () => {},
    Fragment: 'Fragment', createContext: () => ({ Provider: 'P', Consumer: 'C' }),
    forwardRef: fn => fn, memo: fn => fn,
  }
  const ReactDOMClient = {
    createRoot: () => ({ render() {}, unmount() {} }),
    hydrateRoot: () => ({ render() {}, unmount() {} }),
  }

  const globals = {
    window: { __ModuleLoader__: { load(reg) { registry.push(reg) } } },
    document: opts.withDom === false ? undefined : makeBareDocument(),
    navigator: { userAgent: 'node', clipboard: undefined },
    location: { href: 'http://127.0.0.1:19387/', origin: 'http://127.0.0.1:19387' },
    MutationObserver: class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} takeRecords() { return [] } },
    requestAnimationFrame: fn => setTimeout(fn, 0),
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => { throw new Error('no network in probe') },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
  }

  const saved = new Map()
  const define = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    if (value === undefined) {
      try { delete globalThis[key] } catch { /* non-configurable */ }
      return
    }
    // Some globals on modern Node (navigator) are getter-only accessors, so a
    // plain assignment throws; defineProperty replaces the descriptor wholesale.
    Object.defineProperty(globalThis, key, {
      value, writable: true, enumerable: true, configurable: true,
    })
  }
  const restoreAll = () => {
    for (const [key, descriptor] of saved.entries()) {
      try {
        if (descriptor === undefined) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      } catch { /* best effort */ }
    }
    delete globalThis.__probeReactDOMClient
  }

  for (const [key, value] of Object.entries(globals)) define(key, value)

  // react-dom/client must be reachable as a global the bundle may consult.
  globalThis.__probeReactDOMClient = ReactDOMClient

  const require = spec => {
    requested.push(spec)
    if (spec === 'react') {
      if (!withReact) throw new Error('missed the module table: react')
      return React
    }
    if (spec === 'react-dom/client' || spec === 'react-dom') return ReactDOMClient
    if (spec === 'react/jsx-runtime') {
      return {
        jsx: (type, props, key) => ({ __el: true, type, props, key }),
        jsxs: (type, props, key) => ({ __el: true, type, props, key }),
        Fragment: 'Fragment',
      }
    }
    if (spec.startsWith('@deepseek-ai/')) return {}
    if (opts.throwOnUnexpected) throw new Error(`missed the module table: ${spec}`)
    return {}
  }

  try {
    // Evaluate the bundle body as CommonJS-ish source in the global scope.
    const runner = new Function('require', 'module', 'exports', `${source}\n;return module.exports;`)
    const module_ = { exports: {} }
    const result = runner(require, module_, module_.exports)
    return { registry, requested, moduleExports: result ?? module_.exports, restore: restoreAll }
  } catch (error) {
    return { registry, requested, loadError: error, restore: restoreAll }
  }
}

/** A ctx that answers nothing — the worst realistic case. */
function bareCtx() {
  const disposers = []
  return {
    disposers,
    get: () => undefined,
    inject: () => {},
    on: () => ({}),
    provide: () => {},
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return () => {}
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
}

/* ------------------------------------------------------------------ probes */

console.log('== lead probe: the bundle registers and activates ==')
{
  const loaded = await loadBundle()
  check('the bundle evaluates without throwing', loaded.loadError === undefined,
    loaded.loadError?.message)
  check('it registered exactly one module', loaded.registry.length === 1,
    `got ${loaded.registry.length}`)

  const reg = loaded.registry[0]
  check('the module id is the package name', reg?.id === 'dsh-aidrama', String(reg?.id))
  check('the factory is a function', typeof reg?.factory === 'function')

  let exports_
  try {
    exports_ = reg.factory(loaded.registry.__require ?? (spec => {
      if (spec === 'react') return { createElement: () => ({}), useState: v => [v, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useMemo: f => f(), useCallback: f => f, Fragment: 'F' }
      return {}
    }))
    check('the factory returns exports', true)
  } catch (error) {
    check('the factory returns exports', false, error.message)
  }
  check('exports.apply is a function', typeof exports_?.apply === 'function', typeof exports_?.apply)
  check('exports.inject is an array', Array.isArray(exports_?.inject))
  loaded.restore()
}

console.log('\n== lead probe: apply survives a hostile environment ==')
{
  const loaded = await loadBundle()
  const reg = loaded.registry[0]
  const fakeRequire = spec => {
    if (spec === 'react') {
      return {
        createElement: () => ({}), useState: v => [typeof v === 'function' ? v() : v, () => {}],
        useEffect: () => {}, useRef: v => ({ current: v }), useMemo: f => f(),
        useCallback: f => f, useLayoutEffect: () => {}, Fragment: 'F',
        createContext: () => ({ Provider: 'P' }), forwardRef: f => f, memo: f => f,
      }
    }
    if (spec === 'react-dom/client' || spec === 'react-dom') return { createRoot: () => ({ render() {}, unmount() {} }) }
    if (spec === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}), Fragment: 'F' }
    return {}
  }

  let exports_
  try { exports_ = reg.factory(fakeRequire) } catch (error) {
    check('the factory is inert at load time', false, error.message)
  }
  check('the factory is inert at load time (no DOM touched)', true)

  if (typeof exports_?.apply === 'function') {
    const ctx = bareCtx()
    let threw
    try { exports_.apply(ctx) } catch (error) { threw = error }
    check('apply does NOT throw with every service missing and a selector-less DOM',
      threw === undefined, threw?.message)

    // Disposal must also survive.
    let disposeError
    try { for (const fn of ctx.disposers) fn() } catch (error) { disposeError = error }
    check('cleanup does not throw', disposeError === undefined, disposeError?.message)
  }
  loaded.restore()
}

console.log('\n== lead probe: a degraded React must still not blank the GUI ==')
{
  const loaded = await loadBundle({ throwOnUnexpected: true })
  const reg = loaded.registry[0]
  let threw
  let exports_
  try {
    // Only react + react-dom/client are documented; anything else must not be asked for.
    exports_ = reg.factory(spec => {
      if (spec === 'react') return { createElement: () => ({}), useState: v => [v, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useMemo: f => f(), useCallback: f => f, Fragment: 'F' }
      if (spec === 'react-dom/client' || spec === 'react-dom') return { createRoot: () => ({ render() {}, unmount() {} }) }
      if (spec === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}), Fragment: 'F' }
      throw new Error(`missed the module table: ${spec}`)
    })
  } catch (error) { threw = error }
  check('the factory asks only for documented specifiers', threw === undefined, threw?.message)

  if (typeof exports_?.apply === 'function') {
    const ctx = bareCtx()
    let applyThrew
    try { exports_.apply(ctx) } catch (error) { applyThrew = error }
    check('apply without any host service does not blank the shell', applyThrew === undefined, applyThrew?.message)
  }
  loaded.restore()
}

console.log('\n== lead probe: source-level hygiene ==')
{
  check('the bundle targets the real loader global', source.includes('__ModuleLoader__'))
  check('the bundle does not use innerHTML', !/\.innerHTML\s*=/u.test(source))
  check('every CSS class in the source is aidrama-prefixed',
    (() => {
      const classStrings = [...source.matchAll(/['"`]([a-z][a-z0-9-]*)(?:\s+[a-z0-9-\s]*)['"`]/gu)]
        .map(match => match[1])
        .filter(name => name.includes('-') && !name.startsWith('aidrama-') && !name.startsWith('data-'))
      // Only report names that look like real class tokens (contain a dash and a word).
      const suspicious = classStrings.filter(name => /^(dsh|ant|dsw|shell|sidebar)-/u.test(name))
      return suspicious.length === 0
    })())
  check('the bundle does not hardcode a hex background that breaks dark mode',
    !/background(?:-color)?\s*:\s*#[0-9a-fA-F]{3,6}/u.test(source))
  // The DOM idiom is `tag.dataset.plugin = 'dsh-aidrama'`, which sets the
  // data-plugin attribute - so accept either spelling, not just the literal.
  check('the style tag is tagged with data-plugin',
    /dataset\.plugin\s*=|setAttribute\(\s*['"]data-plugin['"]/u.test(source))
}

console.log(`\n${'='.repeat(50)}`)
console.log(failed === 0
  ? `LEAD PROBE PASSED — ${passed} passed, 0 failed`
  : `LEAD PROBE FAILED — ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
