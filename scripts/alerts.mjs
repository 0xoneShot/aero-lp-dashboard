// Sends the phone alerts lib/alerts.mjs asks for to the ntfy topic in NTFY_TOPIC (a secret: anyone
// who knows it can read the alerts). Run after `npm run update`; the state is kept in
// data/cache/alerts.json, which travels with the encrypted scan cache. Without NTFY_TOPIC it only
// keeps the state up to date. `--test` sends one test message.
// With UPDATE_OK=false (the update or its checks failed) it alerts from the last good summary, kept in
// data/cache/last-summary.json, at live pool prices read from public Base RPCs (pool contracts only).
// Only counts are printed: the hourly job's logs are public, and the alerts name the wallets.
import fs from 'node:fs'
import { evaluate, withLivePrices } from '../lib/alerts.mjs'

const topic = process.env.NTFY_TOPIC?.trim()
const STATE = 'data/cache/alerts.json', LAST = 'data/cache/last-summary.json', SITE = 'https://0xoneshot.github.io/aero-lp-dashboard/'
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org']

// slot0() of WETH/USDC pools (18 and 6 decimals), as the page reads them.
async function slot0s(addresses) {
  const calls = addresses.map((to, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to, data: '0x3850c7bd' }, 'latest'] }))
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls), signal: AbortSignal.timeout(10_000) })
      const out = await r.json()
      if (!Array.isArray(out) || out.length !== calls.length || out.some((x) => x.error || typeof x.result !== 'string' || x.result.length < 130)) continue
      return Object.fromEntries(out.sort((a, b) => a.id - b.id).map((x, i) => {
        const w = x.result.slice(2), q = Number(BigInt('0x' + w.slice(0, 64))) / 2 ** 96
        return [addresses[i], { price: q * q * 1e12, tick: Number(BigInt.asIntN(24, BigInt('0x' + w.slice(64, 128)))) }]
      }))
    } catch {}
  }
  return null
}

async function lastSummaryLive() {
  if (!fs.existsSync(LAST)) return null
  const summary = JSON.parse(fs.readFileSync(LAST, 'utf8'))
  const ref = summary[0]?.eth_ref_pool, hourly = summary[0]?.eth_usd
  const pools = [...new Set(summary.flatMap((r) => (r.curve?.positions ?? []).map((p) => p.pool_address)).filter(Boolean))]
  const live = ref ? await slot0s([ref, ...pools.filter((a) => a !== ref)]) : null
  if (!live || Object.values(live).some((x) => !(x.price > hourly / 2 && x.price < hourly * 2))) {
    console.log('alerts: no live prices either')
    return { summary, live: false }
  }
  return { summary: withLivePrices(summary, live, live[ref].price), live: true }
}

async function send(m) {
  const r = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic, title: m.title, message: m.message, priority: m.priority, tags: m.tags, click: SITE }),
  })
  if (!r.ok) throw new Error(`ntfy answered ${r.status}`)
}

if (process.argv[2] === '--test') {
  if (!topic) throw new Error('NTFY_TOPIC is not set')
  await send({ title: 'Aero LP 价格提醒已开启', message: '快到区间下沿、跌出或涨出区间、回到区间，以及跌出区间后 ETH 涨回成本价时，会在这里提醒你。', priority: 3, tags: ['bell'] })
  console.log('alerts: test sent')
  process.exit(0)
}

const updated = process.env.UPDATE_OK !== 'false'
let summary, live = true
if (updated) {
  summary = JSON.parse(fs.readFileSync('out/summary.json', 'utf8'))
  fs.mkdirSync('data/cache', { recursive: true })
  fs.writeFileSync(LAST, JSON.stringify(summary))
} else {
  const last = await lastSummaryLive()
  if (!last) { console.log('alerts: the update failed and there is no earlier summary'); process.exit(0) }
  ;({ summary, live } = last)
}
// An unreadable state starts over (records only), rather than stopping the alerts for good.
let prev = null
try { if (fs.existsSync(STATE)) prev = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { console.log('alerts: state unreadable, starting over') }
const { messages, state } = evaluate(summary, prev, { lastGood: !updated, noPrices: !live })
let sent = 0
if (topic) {
  for (const m of messages) {
    try { await send(m); sent++ } catch (e) {
      // Keep the previous state for what was not sent, so the next run tries again.
      if (prev && m.key in prev) state[m.key] = prev[m.key]
      console.log(`alerts: one message failed (${e.message})`)
    }
  }
}
fs.mkdirSync('data/cache', { recursive: true })
fs.writeFileSync(STATE, JSON.stringify(state))
console.log(`${updated ? '' : '(from the last good data) '}${topic ? `alerts: ${sent} of ${messages.length} sent` : `alerts: off (${messages.length} would have been sent)`}`)
