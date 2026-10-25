// Builds the static website into public/: the dashboard page inside site/shell.html, d3, and one
// encrypted data file per view (each tracked wallet alone, and all of them together), which only
// someone who enters the wallet address(es) can find and read. See lib/views.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { WALLETS } from '../lib/config.mjs'
import { encryptView } from '../lib/views.mjs'

const IDS = ['summary', 'daily', 'attribution', 'positions', 'holdings', 'events']
const missing = IDS.filter((id) => !fs.existsSync(path.join('out', `${id}.json`)))
if (missing.length) throw new Error(`no data in out/ for ${missing.join(', ')}: run npm run update first`)
if (!WALLETS.length) throw new Error('no wallets configured (AERO_CONFIG or config/wallets.local.json)')

fs.rmSync('public', { recursive: true, force: true })
fs.mkdirSync('public/data', { recursive: true })
fs.mkdirSync('public/vendor', { recursive: true })

const shell = fs.readFileSync('site/shell.html', 'utf8')
const page = fs.readFileSync('dashboard/index.html', 'utf8')
if (!shell.includes('<!-- DASHBOARD -->')) throw new Error('site/shell.html has no <!-- DASHBOARD --> slot')
fs.writeFileSync('public/index.html', shell.replace('<!-- DASHBOARD -->', page))
fs.copyFileSync('node_modules/d3/dist/d3.min.js', 'public/vendor/d3.min.js')
fs.writeFileSync('public/robots.txt', 'User-agent: *\nDisallow: /\n')

const all = Object.fromEntries(IDS.map((id) => [id, JSON.parse(fs.readFileSync(path.join('out', `${id}.json`), 'utf8'))]))
const pick = (scopes) => Object.fromEntries(IDS.map((id) => [id, all[id].filter((r) => scopes.includes(r.scope))]))
const views = WALLETS.map((w) => ({ addresses: [w.address], scopes: [w.key] }))
if (WALLETS.length > 1) views.push({ addresses: WALLETS.map((w) => w.address), scopes: ['total', ...WALLETS.map((w) => w.key)] })
for (const v of views) {
  const { name, body } = await encryptView(v.addresses, pick(v.scopes))
  fs.writeFileSync(path.join('public/data', `${name}.json`), body)
}
console.log(`built public/ with ${views.length} encrypted views`)
