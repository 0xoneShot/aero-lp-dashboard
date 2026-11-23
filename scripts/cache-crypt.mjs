// Encrypts the scan cache before it goes into the (public repository's) Actions cache, and back.
// The key is derived from AERO_CONFIG, which only this repository's workflows can read.
//   node scripts/cache-crypt.mjs seal          -> cache.enc from data/cache/*.json
//   node scripts/cache-crypt.mjs seal-requests -> requests.enc from data/cache/extras.json and the job's
//                                                 request key (secret.json) alone, saved right after the
//                                                 page's requests are read, so what was asked survives a
//                                                 run that later fails or times out
//   node scripts/cache-crypt.mjs open          -> data/cache/*.json from cache.enc, then from requests.enc
//                                                 extras.json if that copy is the newer (the store counts
//                                                 its writes, lib/requests.mjs) and secret.json if missing
import fs from 'node:fs'
import path from 'node:path'
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { storeOk } from '../lib/requests.mjs'

const config = process.env.AERO_CONFIG
if (!config) throw new Error('AERO_CONFIG is not set')
const key = createHash('sha256').update(`aero-lp-dashboard cache v1\n${config}`).digest()
const DIR = 'data/cache', FILE = 'cache.enc', REQUESTS = 'requests.enc'

// The size of what is saved is public too (the Actions cache prints it), and it grows when a tracked wallet's
// transactions are stored: the text is filled with spaces to a whole number of `step` bytes before it is
// encrypted, so the size changes only when a step is crossed, not hour by hour. Spaces after the JSON read as
// nothing when it is opened, by this version or an earlier one.
function seal(files, out, step) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const text = Buffer.from(JSON.stringify(files))
  const padded = Buffer.alloc(Math.ceil(text.length / step) * step, 0x20)
  text.copy(padded)
  const ct = Buffer.concat([c.update(padded), c.final()])
  fs.writeFileSync(out, Buffer.concat([iv, c.getAuthTag(), ct]))
}
function open(file) {
  const buf = fs.readFileSync(file)
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  d.setAuthTag(buf.subarray(12, 28))
  const text = Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
  // An error must not quote what was sealed (JSON.parse's own message does): the job's log is public.
  try { return JSON.parse(text) } catch { throw new Error(`${file} opened, but what is in it does not read as the files sealed into it`) }
}

if (process.argv[2] === 'seal') {
  const files = Object.fromEntries(fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]))
  seal(files, FILE, 1024 * 1024)
  console.log(`sealed ${Object.keys(files).length} cache files`)
} else if (process.argv[2] === 'seal-requests') {
  const files = Object.fromEntries(['extras.json', 'secret.json'].filter((f) => fs.existsSync(path.join(DIR, f))).map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]))
  if (!files['extras.json']) { console.log('no requests to seal'); process.exit(0) }
  seal(files, REQUESTS, 16 * 1024)
  console.log('sealed the requests')
} else if (process.argv[2] === 'open') {
  fs.mkdirSync(DIR, { recursive: true })
  if (fs.existsSync(FILE)) {
    const files = open(FILE)
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(DIR, path.basename(f)), text)
    console.log(`opened ${Object.keys(files).length} cache files`)
  } else console.log('no cache to open')
  // Saved after the requests were read, so usually the newer copy; but a run whose requests step failed
  // saves only the cache, so whichever copy has seen more writes is kept. One this code cannot read never
  // replaces one it can, whatever its count.
  if (fs.existsSync(REQUESTS)) {
    try {
      const r = open(REQUESTS)
      const genOf = (text) => { try { const s = JSON.parse(text); return storeOk(s) ? s.gen ?? 0 : -1 } catch { return -1 } }
      const mine = path.join(DIR, 'extras.json')
      const here = fs.existsSync(mine) ? genOf(fs.readFileSync(mine, 'utf8')) : -1
      if (r['extras.json'] && genOf(r['extras.json']) >= here) { fs.writeFileSync(mine, r['extras.json']); console.log('opened the requests') }
      else console.log('the cache\'s copy of the requests is the newer')
      if (r['secret.json'] && !fs.existsSync(path.join(DIR, 'secret.json'))) fs.writeFileSync(path.join(DIR, 'secret.json'), r['secret.json'])
    } catch { console.log('requests could not be opened; the cache\'s copy is kept') }
  }
} else {
  throw new Error('usage: cache-crypt.mjs seal|seal-requests|open')
}
