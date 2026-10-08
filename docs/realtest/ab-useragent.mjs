// Controlled A/B: is the User-Agent header the decisive factor?
// Interleave the two variants so upstream drift can't masquerade as a signal.
const key = process.env.AIDRAMA_KEY ?? ''
const url = 'https://coderxiaoc.com/v1/images/generations'
const body = JSON.stringify({
  model: 'gpt-image-2.5-sunburst',
  prompt: 'a red apple on a white table',
  n: 1,
  size: '1024x1024',
  response_format: 'b64_json',
})

async function call(label, withUA) {
  const headers = { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
  if (withUA) headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
  const t0 = Date.now()
  try {
    const res = await fetch(url, { method: 'POST', headers, body })
    const text = await res.text()
    const ok = res.status === 200 && text.includes('b64_json')
    console.log(`${label.padEnd(24)} HTTP ${res.status}  ${String(Date.now() - t0).padStart(6)}ms  ${ok ? 'IMAGE OK' : text.slice(0, 70).replace(/\s+/g, ' ')}`)
    return ok
  } catch (e) {
    console.log(`${label.padEnd(24)} THREW ${e.cause?.code ?? e.message}  ${Date.now() - t0}ms`)
    return false
  }
}

let noUAok = 0, withUAok = 0
const N = 4
for (let i = 1; i <= N; i++) {
  if (await call(`round ${i} WITHOUT ua`, false)) noUAok++
  if (await call(`round ${i} WITH ua`, true)) withUAok++
}
console.log(`\nRESULT  without UA: ${noUAok}/${N}    with UA: ${withUAok}/${N}`)
