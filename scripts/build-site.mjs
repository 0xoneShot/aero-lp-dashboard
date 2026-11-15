// Builds the static website into public/: the dashboard page inside site/shell.html, d3, and one
// encrypted data file per view (each tracked wallet alone, the configured wallets together, and each
// combined view asked for on the page), which only someone who enters the wallet address(es) can find
// and read. See lib/views.mjs and lib/requests.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { WALLETS, BASE_WALLETS, GROUPS } from '../lib/config.mjs'
import { encryptView, normalizeSet } from '../lib/views.mjs'
import { readStore, jobKeys } from '../lib/requests.mjs'

// The page shows only the headline figures and the daily rows; nothing else is published.
const IDS = ['summary', 'daily']
const missing = IDS.filter((id) => !fs.existsSync(path.join('out', `${id}.json`)))
if (missing.length) throw new Error(`no data in out/ for ${missing.join(', ')}: run npm run update first`)
if (!WALLETS.length) throw new Error('no wallets configured (AERO_CONFIG or config/wallets.local.json)')

fs.rmSync('public', { recursive: true, force: true })
fs.mkdirSync('public/data', { recursive: true })
fs.mkdirSync('public/vendor', { recursive: true })

const shell = fs.readFileSync('site/shell.html', 'utf8')
const page = fs.readFileSync('dashboard/index.html', 'utf8')
if (!shell.includes('<!-- DASHBOARD -->')) throw new Error('site/shell.html has no <!-- DASHBOARD --> slot')
if (!shell.includes('__AERO_JOB_KEY__')) throw new Error('site/shell.html has no __AERO_JOB_KEY__ slot')
// The public half of the job's key for requests (lib/views.mjs), made by scripts/requests.mjs; without it
// the page offers no 加地址.
const keys = await jobKeys()
// A function, so `$` sequences in the page are not read as replacement patterns.
fs.writeFileSync('public/index.html', shell.replace('__AERO_JOB_KEY__', () => keys?.pub ?? '').replace('<!-- DASHBOARD -->', () => page))
fs.copyFileSync('node_modules/d3/dist/d3.min.js', 'public/vendor/d3.min.js')
fs.writeFileSync('public/robots.txt', 'User-agent: *\nDisallow: /\n')

const all = Object.fromEntries(IDS.map((id) => [id, JSON.parse(fs.readFileSync(path.join('out', `${id}.json`), 'utf8'))]))
// A wallet is published once the update has rows for it: an address added on the page waits until it is
// caught up (src/run.mjs), so its view never opens half-read.
const ready = new Set(all.summary.map((r) => r.scope))
const live = WALLETS.filter((w) => ready.has(w.key))
// A combined view's own total is published under 'total', the scope the page treats as combined.
const asTotal = (r) => { const { group, ...x } = r; return { ...x, scope: 'total', scope_label: '合计' } }
const pick = (scopes, total) => Object.fromEntries(IDS.map((id) => [id, all[id].filter((r) => scopes.includes(r.scope) || (total && r.scope === total)).map((r) => (total && total !== 'total' && r.scope === total ? asTotal(r) : r))]))
// What became of the requests sent from a view's wallets (lib/requests.mjs), for the page to show: every
// entry of the dozen requests last written about in the last few days (an address let go later is filed
// under the request that added it), newest last, an address only by its last four characters. Whole
// requests, so one with many entries never pushes another's answer out.
const store = readStore()
const since = Date.now() - 3 * 86400_000
function requestsOf(keys) {
  const entries = store.log.filter((x) => keys.includes(x.by) && x.ts >= since)
  const recent = new Set([...new Set([...entries].reverse().map((x) => `${x.by}:${x.req}`))].slice(0, 12))
  return entries.filter((x) => recent.has(`${x.by}:${x.req}`)).map(({ req, op, tail, state, reason }) => ({ req, op, tail, state, reason }))
}
// A view's wallets that were added on the page (the page offers an added address alone 停止追踪).
const addedIn = (keys) => keys.filter((k) => WALLETS.some((w) => w.key === k && w.extra))

// Each wallet alone; the configured wallets together (their 'total', unchanged by added addresses);
// and each group asked for on the page.
const views = live.map((w) => ({ addresses: [w.address], scopes: [w.key], keys: [w.key] }))
const base = BASE_WALLETS.filter((w) => ready.has(w.key))
if (BASE_WALLETS.length > 1 && ready.has('total')) views.push({ addresses: BASE_WALLETS.map((w) => w.address), scopes: base.map((w) => w.key), keys: base.map((w) => w.key), total: 'total' })
for (const g of GROUPS.filter((x) => ready.has(x.key))) {
  const members = live.filter((w) => g.members.includes(w.key))
  views.push({ addresses: members.map((w) => w.address), scopes: members.map((w) => w.key), keys: members.map((w) => w.key), total: g.key })
}
const written = new Set()
for (const v of views) {
  // Two views over the same addresses would be one file: the first (a wallet alone, then the configured
  // set) wins.
  const id = normalizeSet(v.addresses)
  if (written.has(id)) continue
  written.add(id)
  const { name, body } = await encryptView(v.addresses, { ...pick(v.scopes, v.total), requests: requestsOf(v.keys), added: addedIn(v.keys) })
  fs.writeFileSync(path.join('public/data', `${name}.json`), body)
}
console.log(`built public/ with ${written.size} encrypted views`)
