/**
 * Guard the image MIME sniffing on the generation seam.
 *
 * WHY: d1api.xin answers an `b64_json` request with PNG or JPEG unpredictably —
 * a real 4-image run produced 3 PNG and 1 JPEG, with no pattern by prompt,
 * model or size. The code declared every base64 payload `image/png`. That
 * string becomes the Content-Type on the asset route, so a JPEG served as
 * `image/png` is a file strict viewers refuse to render — a silent failure
 * whose cause (the upstream format) is nowhere in the symptom.
 *
 * The bytes decide. A declared Content-Type is only trusted when it actually
 * starts with `image/`, because gateways commonly serve everything as
 * `application/octet-stream`.
 *
 * Run: node docs/verify-image-mime.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

console.log('--- the helper exists and is used on both branches ---')
check('sniffImageMime is defined', src.includes('function sniffImageMime'))
check('the b64_json branch sniffs', /item\.b64_json,[\s\S]{0,40}sniffImageMime/.test(src.replace(/\s+/g, ' ')) || /sniffImageMime\(Buffer\.from\(item\.b64_json/.test(src))
check('the url branch sniffs', src.includes('sniffImageMime(bytes)'))
check('no unconditional image/png for b64 payloads',
  !/images\.push\(\{\s*b64:\s*item\.b64_json,\s*mime:\s*'image\/png'/.test(src))
check('a declared type is only trusted when it is an image',
  /\/\^image\\\//.test(src) || src.includes("doc: '/^image\\//u'") || src.includes('/^image\\//u.test(declared)'))
check('io/octet-stream falls through to sniffing', src.includes('application/octet-stream'))

console.log('\n--- the STORED extension must match the bytes too ---')
// First half of the bug: the payload was sniffed correctly but stored under a
// hard-coded `.png` name. The asset route derives its Content-Type from the
// file extension, so the correct mime never reached the browser.
const routesSrc = fs.readFileSync(path.join(root, 'lib', 'host', 'routes.js'), 'utf8')
check('routes defines extensionForMime', routesSrc.includes('function extensionForMime'))
check('EXT_BY_MIME maps jpeg to .jpg', /'image\/jpeg':\s*'\.jpg'/.test(routesSrc))
check('the asset name uses the resolved extension',
  routesSrc.includes('extensionForMime(mime)') && !/name:\s*`\$\{text\(target\?\.name\) \|\| ref\}\.png`/.test(routesSrc))
check('the stored ext uses the resolved extension',
  /ext:\s*extensionForMime\(mime\)/.test(routesSrc))
check('an unknown type falls back to a non-rendering extension',
  routesSrc.includes("' .bin'") || routesSrc.includes("?? '.bin'"))
check('the asset route prefers the stored mime over the extension',
  /SAFE_INLINE_MIME\[declared\]\s*\?\?/.test(routesSrc))

console.log('\n--- sniffing must be right on the formats that actually occur ---')
// Re-derive the function from source so the test cannot drift from it.
const body = src.slice(src.indexOf('function sniffImageMime'))
const fn = body.slice(0, body.indexOf('\n}\n') + 3)
// eslint-disable-next-line no-new-func
const sniff = new Function('bytes', `${fn}; return sniffImageMime(bytes)`) // NOSONAR: local test helper

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0])
const JPG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
const GIF = Buffer.from('GIF89a............')
const BMP = Buffer.from([0x42, 0x4D, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
const JUNK = Buffer.alloc(16)

check('PNG magic -> image/png', sniff(PNG) === 'image/png', sniff(PNG))
check('JPEG magic -> image/jpeg', sniff(JPG) === 'image/jpeg', sniff(JPG))
check('WEBP magic -> image/webp', sniff(WEBP) === 'image/webp', sniff(WEBP))
check('GIF magic -> image/gif', sniff(GIF) === 'image/gif', sniff(GIF))
check('BMP magic -> image/bmp', sniff(BMP) === 'image/bmp', sniff(BMP))
check('unknown -> falls back, never crashes', sniff(JUNK) === 'image/png', sniff(JUNK))
check('a truncated buffer does not throw', (() => { try { sniff(Buffer.alloc(1)); return true } catch { return false } })())
check('an empty buffer does not throw', (() => { try { sniff(Buffer.alloc(0)); return true } catch { return false } })())

console.log('\n--- against the real generated files, if present ---')
const outDir = path.join(root, 'docs', 'realtest', 'out')
let checked = 0
if (fs.existsSync(outDir)) {
  for (const name of fs.readdirSync(outDir).filter(n => /\.(png|jpg|jpeg|webp)$/i.test(n))) {
    const bytes = fs.readFileSync(path.join(outDir, name))
    const got = sniff(bytes)
    const ext = path.extname(name).toLowerCase()
    const wanted = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    check(`${name} -> ${wanted}`, got === wanted, `got ${got}`)
    checked += 1
  }
}
if (checked === 0) console.log('SKIP  no generated images on disk')

console.log(`\n${'='.repeat(56)}`)
console.log(fail === 0 ? `ALL PASS — ${pass} passed, 0 failed` : `${fail} FAILED of ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
