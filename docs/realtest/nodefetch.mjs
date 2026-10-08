// Reproduce the plugin's own request path using Node's global fetch.
const key = process.env.AIDRAMA_KEY ?? ''
const url = 'https://coderxiaoc.com/v1/images/generations'

async function attempt(label, body, headers) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(key),
      body: JSON.stringify(body),
    })
    const text = await res.text()
    console.log(`${label.padEnd(34)} HTTP ${res.status}  ${text.length} bytes  ${text.slice(0, 90).replace(/\s+/g, ' ')}`)
  } catch (e) {
    console.log(`${label.padEnd(34)} THREW: ${e.message}  cause=${e.cause?.code ?? e.cause?.message ?? '-'}`)
  }
}

const hJson = k => ({ 'Authorization': `Bearer ${k}`, 'Content-Type': 'application/json' })
const hPlain = k => ({ 'Authorization': `Bearer ${k}` })

const base = { model: 'gpt-image-2.5-sunburst', prompt: 'a red apple', n: 1 }
const plugin = { ...base, size: '1024x1024', response_format: 'b64_json' }

await attempt('1. plain fetch + json header', base, hJson)
await attempt('2. plugin body + json header', plugin, hJson)
await attempt('3. plugin body, NO content-type', plugin, hPlain)
await attempt('4. plugin body + UA header', plugin, k => ({ ...hJson(k), 'User-Agent': 'Mozilla/5.0' }))
