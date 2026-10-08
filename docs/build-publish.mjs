/**
 * Build a clean, publishable copy of the plugin.
 *
 * This workspace is a MIXED directory: the plugin shares a folder with personal
 * material (family-education decks, exam papers, research scratch). Publishing
 * in place would upload all of it, so this assembles a plugin-only tree.
 *
 * Only these ship:
 *   lib/                  the implementation
 *   docs/                 verification suites and design notes
 *   package.json          manifest
 *   README.md             the front page
 *   cordis.patch.yml      the bundle patch
 *   LICENSE, .gitignore, .gitattributes, .editorconfig
 *
 * docs/realtest ships its SCRIPTS (so the tests are reproducible) but not the
 * multi-megabyte generated PNGs and intermediate run artefacts.
 *
 * Run: node docs/build-publish.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const out = path.join(root, '..', 'dsh-aidrama-publish')

/** Always excluded, anywhere in the tree. */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '__pycache__', '.cache'])
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db'])

/** Inside docs/realtest: keep scripted, reproducible material only. */
const REALTEST_EXCLUDE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.json', '.txt'])
const REALTEST_EXCLUDE_NAMES = new Set(['run-report.json', 'resume-report.json', 'latency.json'])
/** Whole subtrees that are pure generated output. */
const REALTEST_EXCLUDE_DIRS = new Set(['out', 'ui'])
/** Make an exception for the two review screenshots, which are documentation. */
const KEEP_REALTEST = [/^docs\/realtest\/ui\/(live|entry)\.png$/]
/** Generated HTML previews: reproducible from the scripts, not worth shipping. */
const DROP_IN_UI = new Set(['live.html', 'entry.html', 'entry-frame.html'])

let copied = 0
let bytes = 0
const skipped = []

function copyDir(srcDir, destDir, relBase = '') {
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name) || EXCLUDE_FILES.has(entry.name)) continue
    const src = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`

    if (entry.isDirectory()) {
      // Skip pure-output subtrees. `out/` is raw generated artwork; `ui/` holds
      // the review screenshots, so it is kept but filtered file-by-file below.
      const isRealtest = /(^|\/)realtest(\/|$)/.test(rel)
      if (isRealtest && REALTEST_EXCLUDE_DIRS.has(entry.name) && entry.name !== 'ui') {
        skipped.push(rel + '/')
        continue
      }
      copyDir(src, dest, rel)
      continue
    }

    const ext = path.extname(entry.name).toLowerCase()
    // Match on the full relative path, e.g. "docs/realtest/out/01.png", not on
    // a bare "realtest/" prefix — the caller passes "docs" as relBase.
    const inRealtest = /(^|\/)realtest(\/|$)/.test(rel)
    if (inRealtest && /(^|\/)ui\//.test(rel) && DROP_IN_UI.has(entry.name)) {
      skipped.push(rel)
      continue
    }
    if (inRealtest && KEEP_REALTEST.some(re => re.test(rel))) {
      fs.copyFileSync(src, dest)
      const size = fs.statSync(src).size
      bytes += size
      copied += 1
      console.log(`  ${String(size).padStart(9)}  ${rel}  (kept: review screenshot)`)
      continue
    }
    if (inRealtest && REALTEST_EXCLUDE_EXT.has(ext)) {
      skipped.push(rel)
      continue
    }
    if (inRealtest && REALTEST_EXCLUDE_NAMES.has(entry.name)) {
      skipped.push(rel)
      continue
    }

    fs.copyFileSync(src, dest)
    const size = fs.statSync(src).size
    bytes += size
    copied += 1
    console.log(`  ${String(size).padStart(9)}  ${rel}`)
  }
}

console.log('assembling a publishable copy (plugin only)\n')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

for (const name of ['lib', 'docs']) {
  const src = path.join(root, name)
  if (fs.existsSync(src)) copyDir(src, path.join(out, name), name)
}
for (const name of ['package.json', 'README.md', 'cordis.patch.yml']) {
  const src = path.join(root, name)
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(out, name))
    bytes += fs.statSync(src).size
    copied += 1
    console.log(`  ${String(fs.statSync(src).size).padStart(9)}  ${name}`)
  }
}

console.log(`\ncopied ${copied} files, ${(bytes / 1024).toFixed(0)} KB`)
console.log(`skipped ${skipped.length} large/generated artefact(s) under docs/realtest`)
console.log(`\noutput: ${out}`)
