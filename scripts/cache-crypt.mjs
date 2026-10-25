// Encrypts the scan cache before it goes into the (public repository's) Actions cache, and back.
// The key is derived from AERO_CONFIG, which only this repository's workflows can read.
//   node scripts/cache-crypt.mjs seal   -> cache.enc from data/cache/*.json
//   node scripts/cache-crypt.mjs open   -> data/cache/*.json from cache.enc (no-op if absent)
import fs from 'node:fs'
import path from 'node:path'
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const config = process.env.AERO_CONFIG
if (!config) throw new Error('AERO_CONFIG is not set')
const key = createHash('sha256').update(`aero-lp-dashboard cache v1\n${config}`).digest()
const DIR = 'data/cache', FILE = 'cache.enc'

if (process.argv[2] === 'seal') {
  const files = Object.fromEntries(fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]))
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(files)), c.final()])
  fs.writeFileSync(FILE, Buffer.concat([iv, c.getAuthTag(), ct]))
  console.log(`sealed ${Object.keys(files).length} cache files`)
} else if (process.argv[2] === 'open') {
  if (!fs.existsSync(FILE)) { console.log('no cache to open'); process.exit(0) }
  const buf = fs.readFileSync(FILE)
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  const files = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'))
  fs.mkdirSync(DIR, { recursive: true })
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(DIR, path.basename(f)), text)
  console.log(`opened ${Object.keys(files).length} cache files`)
} else {
  throw new Error('usage: cache-crypt.mjs seal|open')
}
