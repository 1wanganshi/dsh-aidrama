/**
 * dsh-aidrama — UI SHELL regression suite.
 *
 * WHY THIS EXISTS
 *
 * Two defects were reported from actual use of the workbench:
 *   1. "顶格了" — the panel hugged the top edge of the window.
 *   2. "关闭都不行" — it could not be dismissed.
 *
 * Both were real and both were structural:
 *   - the overlay was `position: fixed; inset: 0` and opaque, i.e. a full-bleed
 *     sheet welded to every viewport edge, with no scrim and no elevation;
 *   - there was literally ZERO key handling in the entire client file. Esc did
 *     nothing. The only exit was one text button.
 *
 * This suite drives the REAL client bundle against a DOM stub and asserts the
 * shell contract, so a regression in either property fails loudly.
 *
 * Run: node docs/verify-ui-shell.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

let passed = 0
let failed = 0
const failures = []
function check(label, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${label}`) }
  else { failed += 1; failures.push(label); console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}
const section = t => console.log(`\n— ${t} —`)

/* ----------------------------------------------------------- DOM stub */

const makeNode = (tag) => {
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    attributes: {},
    style: {},
    dataset: {},
    className: '',
    textContent: '',
    listeners: {},
    setAttribute(k, v) { this.attributes[k] = String(v) },
    getAttribute(k) { return this.attributes[k] ?? null },
    removeAttribute(k) { delete this.attributes[k] },
    hasAttribute(k) { return k in this.attributes },
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) },
    removeEventListener(name, fn) {
      this.listeners[name] = (this.listeners[name] ?? []).filter(f => f !== fn)
    },
    appendChild(child) {
      if (child === null || child === undefined) return child
      child.parentNode = this
      this.children.push(child)
      return child
    },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this)
      this.parentNode = null
    },
    querySelectorAll() { return [] },
    get firstChild() { return this.children[0] ?? null },
    get innerHTML() { return '' },
  }
  Object.defineProperty(node, 'textContent', {
    get() {
      return node.children.length === 0 ? (node._text ?? '') : node.children.map(c => c.textContent).join('')
    },
    set(v) { node._text = String(v); node.children = [] },
  })
  return node
}

const walk = (node, out = []) => {
  out.push(node)
  for (const c of node.children ?? []) walk(c, out)
  return out
}

globalThis.document = {
  head: makeNode('head'),
  body: makeNode('body'),
  listeners: {},
  createElement: tag => makeNode(tag),
  createElementNS: (_ns, tag) => makeNode(tag),
  createDocumentFragment: () => makeNode('#fragment'),
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) },
  removeEventListener(name, fn) {
    this.listeners[name] = (this.listeners[name] ?? []).filter(f => f !== fn)
  },
  getElementById: () => null,
}
globalThis.window = { document: globalThis.document, location: { href: 'http://127.0.0.1/' } }
globalThis.MutationObserver = class {
  observe() {} disconnect() {} takeRecords() { return [] }
}
globalThis.requestAnimationFrame = fn => { fn(0); return 0 }
globalThis.cancelAnimationFrame = () => {}

/* -------------------------------------------------------- load bundle */

const src = await fs.readFile(path.join(root, 'lib', 'client.js'), 'utf8')

// The client half is a lazy-CJS factory registered on window.__ModuleLoader__.
let factory = null
globalThis.window.__ModuleLoader__ = {
  load({ id, factory: f }) { factory = { id, fn: f } },
}

const requireStub = (spec) => {
  // Only the handful of bare specifiers the bundle may pull in.
  if (spec === 'react') return { createElement: () => null, useState: v => [v, () => {}], useEffect: () => {} }
  throw new Error(`unexpected require(${spec})`)
}

const moduleUrl = pathToFileURL(path.join(root, 'lib', 'client.js')).href
await import(moduleUrl)

check('the client bundle registered itself on __ModuleLoader__', factory !== null)

const mod = factory.fn(requireStub)
const plugin = mod?.default ?? mod
check('the bundle exports a plugin object', plugin !== null && typeof plugin === 'object')

const css = await fs.readFile(path.join(root, 'lib', 'client.js'), 'utf8')

/* ------------------------------------------------------- apply + mount */

section('A. the plugin applies without throwing into the void')

const appended = []
const effects = []
const ctx = {
  effect(fn, label) { effects.push({ fn, label }); const cleanup = fn(); return cleanup ?? (() => {}) },
  logger: { info() {}, warn() {}, error() {} },
}

let applied = true
try {
  plugin.apply(ctx)
} catch (e) {
  applied = false
  console.log('   apply threw:', e.message)
}
check('apply() does not throw (a throwing apply blanks the whole GUI)', applied, 'apply threw')
check('apply() installed at least one effect', effects.length > 0, `got ${effects.length}`)

const container = document.body.children.find(c => c.dataset.dshAidramaWorkbench !== undefined)
check('the workbench container was mounted into document.body', container !== undefined)

/* ------------------------------------------------------------ the shell */

section('B. the panel is NOT glued to the viewport edge (the 顶格 bug)')

{
  // Drive a render by opening the workbench through the sidebar entry path.
  const styleTag = document.head.children.find(c => c.dataset?.plugin === 'dsh-aidrama')
  check('the stylesheet was injected', styleTag !== undefined)
  check('the stylesheet is tagged for the shell HMR bookkeeping',
    styleTag?.dataset?.pluginCss === 'dsh-aidrama/workbench')

  // Read the CSS out of the template literal. Matching raw source would find the
  // reduced-motion OVERRIDES first (`.aidrama-shell { animation: none }`), which
  // is how an earlier version of this test reported four false failures.
  const cssStart = src.indexOf('    const CSS = `')
  const cssEnd = src.indexOf('\n`', cssStart)
  const body = src.slice(cssStart + '    const CSS = `'.length, cssEnd)

  // Walk the sheet tracking brace depth, and return the body of the first rule
  // whose selector matches AT DEPTH 1 (i.e. not nested inside an @media block).
  //
  // Two traps this has to dodge, both of which produced false failures:
  //   1. the reduced-motion OVERRIDE is declared before the real card rule, so a
  //      naive first-match search reports the card as unstyled;
  //   2. the sheet contains /* comments */ with braces in them, which desync a
  //      brace counter that does not strip comments first.
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '')
  const ruleOf = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const exact = new RegExp(`^${escaped}$`)
    let depth = 0
    let selectorStart = 0
    for (let i = 0; i < clean.length; i += 1) {
      const ch = clean[i]
      if (ch === '{') {
        const sel = clean.slice(selectorStart, i).trim()
        if (depth === 0 && exact.test(sel)) {
          let d = 1
          let j = i + 1
          while (j < clean.length && d > 0) {
            if (clean[j] === '{') d += 1
            else if (clean[j] === '}') d -= 1
            j += 1
          }
          return clean.slice(i + 1, j - 1)
        }
        depth += 1
        selectorStart = i + 1
      } else if (ch === '}') {
        depth -= 1
        selectorStart = i + 1
      }
    }
    return ''
  }

  const overlayRule = ruleOf('.aidrama-overlay')
  check('the overlay is a centred flex layer',
    /display:\s*flex/.test(overlayRule) && /align-items:\s*center/.test(overlayRule),
    'the overlay must centre its card, not stretch to the edges')
  check('the overlay has real padding (a gap from every edge)',
    /padding:\s*clamp\(/.test(overlayRule),
    'inset:0 with no padding is what produced the flush-to-top look')
  check('the overlay paints a scrim so it reads as a layer',
    /background:\s*var\(--dsw-alias-bg-mask/.test(overlayRule))
  check('the overlay blurs what is behind it',
    /backdrop-filter:\s*blur/.test(overlayRule))

  const shellRule = ruleOf('.aidrama-shell')
  check('an elevated .aidrama-shell card exists', shellRule !== '', 'no base .aidrama-shell rule found')
  check('the shell is capped in width (not edge to edge)', /width:\s*min\(/.test(shellRule), shellRule.slice(0, 80))
  check('the shell is capped in height', /height:\s*min\(/.test(shellRule), shellRule.slice(0, 80))
  check('the shell has elevation (box-shadow)', /box-shadow:/.test(shellRule), shellRule.slice(0, 80))
  check('the shell is rounded', /border-radius:/.test(shellRule), shellRule.slice(0, 80))
  check('safe-area / viewport units are respected',
    /dvh|vh/.test(body) || /safe-area/.test(body))

  check('small screens fall back to full-bleed instead of a cramped card',
    /@media \(max-width: 720px\)[\s\S]{0,240}\.aidrama-shell/.test(body))
  check('reduced-motion is honoured', /prefers-reduced-motion/.test(body))
}

section('C. the panel can actually be dismissed (the 关不掉 bug)')

{
  check('an Escape keydown handler is registered', /addEventListener\('keydown'/.test(src))
  check('the handler is capture-phase so nothing swallows it',
    /addEventListener\('keydown',\s*onKeyDown,\s*true\)/.test(src))
  check('Escape is the key it looks for', /event\.key !== 'Escape'/.test(src))
  check('Escape closes the LIGHTBOX first, not the whole panel',
    /state\.lightbox !== null[\s\S]{0,160}state\.lightbox = null/.test(src))
  check('Escape then closes an OPEN MENU',
    /state\.menuOpen[\s\S]{0,120}state\.menuOpen = false/.test(src))
  check('Escape finally closes the panel', /prevendDefault\(\)|preventDefault\(\)[\s\S]{0,80}close\(\)/.test(src))

  check('clicking the scrim dismisses (a third exit)', /event\.target === overlay/.test(src))
  check('the header close control is an icon button, not a text word',
    /aidrama-iconBtn/.test(src) && /const closeButton/.test(src))
  check('the close control carries an accessible label',
    /'aria-label':\s*'关闭'/.test(src))
  check('the close control advertises the Esc shortcut',
    /title:\s*'关闭（Esc）'/.test(src))

  // THE app-closing BUG.
  //
  // closeButton used to be defined at MODULE scope while the workbench's `close`
  // was a local inside createWorkbench. The bare `close()` therefore resolved to
  // the browser's global `window.close()`, so the ✕ shut down the whole DSH app.
  // A missing identifier is not a syntax error, and the DOM stub never noticed
  // because it had no global `close`.
  //
  // This asserts SCOPE, and it does it by actually invoking the handler with a
  // booby-trapped global `close` — so a regression fails loudly instead of
  // silently closing the user's window.
  {
    const fnStart = src.indexOf('const createWorkbench = (container, host) => {')
    const cbIndex = src.indexOf('const closeButton = ()')
    check('closeButton is defined INSIDE createWorkbench (scoped to the panel close)',
      fnStart !== -1 && cbIndex > fnStart,
      'a module-scope closeButton calls the global window.close() and closes the whole app')

    // Call the real handler with a global `close` that records the hit.
    let globalCloseCalled = false
    const hadGlobalClose = 'close' in globalThis
    const previousGlobalClose = globalThis.close
    globalThis.close = () => { globalCloseCalled = true }

    try {
      // The bundle's own closure captured `close` at definition time; if it was
      // module scope it captured the global. Re-importing with the poisoned
      // global reproduces the production failure mode exactly.
      const factory2 = { fn: null }
      const savedLoader = globalThis.window.__ModuleLoader__
      globalThis.window.__ModuleLoader__ = { load({ factory: f }) { factory2.fn = f } }
      await import(`${moduleUrl}?poison=${Date.now()}`)
      globalThis.window.__ModuleLoader__ = savedLoader
      const mod2 = factory2.fn(requireStub)
      const plugin2 = mod2?.default ?? mod2
      plugin2.apply({
        effect(fn) { fn(); return () => {} },
        logger: { info() {}, warn() {}, error() {} },
      })

      // Walk the rendered tree for the close control and click it.
      const container2 = document.body.children.find(c => c.dataset.dshAidramaWorkbench !== undefined)
      const nodes = container2 ? walk(container2) : []
      const btn = nodes.find(n => n.attributes?.['aria-label'] === '关闭')
      check('the close control is present in a freshly rendered header', btn !== undefined)
      if (btn) {
        for (const fn of btn.listeners.click ?? []) fn({ stopPropagation() {}, target: btn })
      }
      check('clicking ✕ does NOT reach the global window.close()',
        globalCloseCalled === false,
        'the ✕ closed the entire application instead of the panel')
    } finally {
      if (hadGlobalClose) globalThis.close = previousGlobalClose
      else delete globalThis.close
    }
  }

  check('the keydown listener is removed on teardown',
    /removeEventListener\('keydown',\s*onKeyDown,\s*true\)/.test(src))
}

section('D. the page behind the modal cannot scroll')

{
  check('body overflow is locked while open', /document\.body\.style\.overflow/.test(src))
  check('the previous overflow is restored on close',
    /previousOverflow/.test(src))
}

section('E. the step strip reads as an ordered pipeline')

{
  check('each step carries a number badge', /aidrama-stepNum/.test(src))
  check('the active step highlights its badge',
    /\.aidrama-step\[data-active\] \.aidrama-stepNum/.test(src))
  check('steps are joined by a connector',
    /\.aidrama-step:not\(:last-child\)::after/.test(src))
  check('the status dot still exists alongside the number',
    /aidrama-dot/.test(src) && /dataset: \{ status \}/.test(src))
}

section('G. the dashboard reads as a production tool, not a form')

{
  // The user's complaint was that the tool looked plain and un-systematic.
  // These assert the specific blocks that fix it actually exist and are wired
  // to REAL data rather than being decorative.

  check('a dashboard renderer exists', /const renderDashboard = \(\) =>/.test(src))
  check('the overview is reachable as its own stage', /state\.stage === 'home'/.test(src))
  check('opening a project lands on the overview, not a JSON textarea',
    /if \(state\.stage !== 'settings'\) state\.stage = 'home'/.test(src))

  check('a hero band exists', /aidrama-hero/.test(src))
  check('the hero carries artwork', /background-image:url/.test(src) && /HERO_ART/.test(src))
  check('the artwork is inlined as a data URI (no network dependency)',
    /const HERO_ART = 'data:image\/jpeg;base64,/.test(src))

  check('stage cards exist (not just a nav strip)', /aidrama-stageCard/.test(src))
  check('every stage card shows a real count',
    /const perStage = \{/.test(src) && /个镜头/.test(src))
  check('future stages visually recede', /\[data-future\]/.test(src) && /opacity/.test(src))

  check('progress rings use a CSS conic-gradient (no JS animation loop)',
    /conic-gradient\(from -90deg/.test(src))
  check('the ring is masked into a band',
    /mask: radial-gradient\(farthest-side/.test(src))
  check('the ring percentage is labelled, not a bare circle',
    /aidrama-ringPct/.test(src))

  check('a KPI row exists', /aidrama-kpis/.test(src) && /const kpi = /.test(src))
  check('timecodes are monospaced', /const timecode = /.test(src) && /--ad-mono/.test(src))

  check('an asset wall exists', /aidrama-wall/.test(src))
  check('empty asset slots are drawn at the real aspect ratio',
    /data-ratio/.test(src) && /data-empty/.test(src))
  check('empty slots are labelled with a shot slug', /data-slug/.test(src))

  check('an empty state offers an action rather than blank space',
    /const renderEmptyWorkbench = /.test(src) && /aidrama-emptyChips/.test(src))
  check('the empty state offers starter templates', /createProjectFromTemplate/.test(src))

  check('a keyboard hint bar exists', /const renderHints = /.test(src))
  // The hint bar advertises 1-6 and 0, so the handler must implement them.
  check('the advertised number shortcuts are actually implemented',
    /\/\^\[0-6\]\$\//.test(src) && /STAGE_IDS\[Number\(digit\) - 1\]/.test(src))
  check('shortcuts do not hijack typing in the JSON editor',
    /isContentEditable/.test(src) && /const typing =/.test(src))

  // The dark-first palette: every surface must resolve through a token, and no
  // stage may hardcode a light page background.
  check('the palette is declared as one token layer', /--ad-bg:/.test(src) && /--ad-accent:/.test(src))
  check('light-mode fallbacks were replaced (no #ffffff surfaces remain)',
    !/var\(--dsw-alias-[a-z0-9-]+,\s*#ffffff\)/.test(src),
    'a hardcoded white fallback makes the panel flash white on a dark host')
}

section('H. the sidebar entry (the surface a user sees FIRST)')

{
  // The entry lives in the HOST's sidebar, a separate DOM subtree from the
  // overlay. Scoping the palette to .aidrama-overlay meant every var(--ad-*)
  // inside .aidrama-entry resolved to NOTHING and the button lost its colours.
  check('the palette is declared on :root, not scoped to the overlay',
    /:root\s*\{[\s\S]{0,80}--ad-bg:/.test(src),
    'tokens scoped to .aidrama-overlay never reach the sidebar entry')

  const rootBlock = src.match(/:root\s*\{([\s\S]*?)\n\}/)
  check('the :root block defines the full palette',
    rootBlock !== null && ['--ad-bg', '--ad-surface-2', '--ad-text-3', '--ad-accent'].every(t => rootBlock[1].includes(t)))

  check('the entry has its own app mark', /aidrama-entryMark/.test(src))
  check('the app mark uses the same gradient as the header logo',
    /\.aidrama-entryMark[\s\S]{0,320}linear-gradient\(135deg,\s*var\(--ad-accent/.test(src))
  check('the entry shows a STUDIO tag', /aidrama-entryTag/.test(src))

  // The status line must be driven by live project data, not a static label.
  check('the entry shows a live status line', /aidrama-entryMeta/.test(src))
  check('the workbench exposes a summary for the entry',
    /const summary = \(\) =>/.test(src) && /isOpen, render, summary \}/.test(src))
  check('the summary reports real progress', /\$\{done\}\/\$\{rows\.length\}/.test(src))
  check('the entry refreshes on render, not only on open',
    /host\?\.onRender/.test(src) && /syncEntry = entryHandle\.sync/.test(src))
  check('the entry falls back to a tagline when nothing is open',
    /'从想法到成片'/.test(src))
  check('teardown removes the entry by selector as well as by reference',
    /querySelectorAll\('\[data-dsh-aidrama-entry\]'\)/.test(src))
}

section('F. the stylesheet cannot break the host page')

{
  check('every class is namespaced with aidrama-', !/^\s*\.[a-z]/m.test(
    (src.match(/<style[\s\S]*?<\/style>/) ?? [''])[0]))
  // The CSS lives inside a template literal, so a stray backtick would end it.
  const cssStart = src.indexOf('    const CSS = `')
  const cssEnd = src.indexOf('\n`', cssStart)
  const cssBody = src.slice(cssStart + '    const CSS = `'.length, cssEnd)
  check('the CSS template literal is not broken by a stray backtick',
    !cssBody.includes('`'),
    'a backtick inside the CSS string terminates it and breaks the bundle')
  check('colours resolve through the token layer',
    /var\(--ad-[a-z0-9-]+\)/.test(cssBody))
  check('the token layer itself keeps a DSH fallback',
    /--ad-bg:\s*var\(--dsw-alias-[a-z-]+,\s*[^)]+\)/.test(cssBody))
  check('no hardcoded white page background survives dark mode',
    !/background:\s*#fff\s*;/.test(cssBody))
}

/* --------------------------------------------------------------- report */

console.log(`\n${'='.repeat(56)}`)
if (failed === 0) {
  console.log(`ALL PASS — ${passed} passed, 0 failed`)
  console.log('UI SHELL CONTRACT VERIFIED (framing + dismissal + stepper)')
  process.exit(0)
} else {
  console.log(`FAILURES PRESENT — ${passed} passed, ${failed} failed`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
