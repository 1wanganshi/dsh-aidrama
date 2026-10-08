// Measure the actual latency distribution of the upstream.
// The A/B run showed successes at ~33s and failures at ~125s == Cloudflare 524.
// This quantifies it: is success a function of how long the origin takes?
const key = process.env.AIDRAMA_KEY ?? ''
const url = 'https://coderxiaoc.com/v1/images/generations'

const body = JSON.stringify({
  model: process.argv[2] || 'gpt-image-2.5-sunburst',
  prompt: 'a single ripe red apple centered on a plain white surface, soft even studio light',
  n: 1,
  size: '1024x1024',
  response_format: 'b64_json',
})

const runs = []
for (let i = 1; i <= 3; i++) {
  const t0 = Date.now()
  let status = 'ERR'
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
    })
    status = res.status
    await res.arrayBuffer()
  } catch (e) { status = `THREW ${e.cause?.code ?? e.message}` }
  const ms = Date.now() - t0
  runs.push({ i, status, ms })
  console.log(`run ${i}: HTTP ${status}  ${(ms / 1000).toFixed(1)}s`)
}

const ok = runs.filter(r => r.status === 200)
const bad = runs.filter(r => r.status !== 200)
console.log('')
console.log(`model: ${JSON.parse(body).model}`)
console.log(`success: ${ok.length}/${runs.length}`)
if (ok.length) console.log(`  avg success latency: ${(ok.reduce((a, r) => a + r.ms, 0) / ok.length / 1000).toFixed(1)}s`)
if (bad.length) console.log(`  avg failure latency: ${(bad.reduce((a, r) => a + r.ms, 0) / bad.length / 1000).toFixed(1)}s  (statuses: ${bad.map(r => r.status).join(',')})`)
