// Sends the phone alerts lib/alerts.mjs asks for to the ntfy topic in NTFY_TOPIC (a secret: anyone
// who knows it can read the alerts). Run after `npm run update`; the state is kept in
// data/cache/alerts.json, which travels with the encrypted scan cache. Without NTFY_TOPIC it only
// keeps the state up to date. `--test` sends one test message.
// With UPDATE_OK=false (the update or its checks failed) it alerts from the last good summary, kept in
// data/cache/last-summary.json, at live pool prices read from each chain's public RPCs (pool contracts only).
// Only counts are printed: the hourly job's logs are public, and the alerts name the wallets.
import fs from 'node:fs'
import { evaluate, withLivePrices } from '../lib/alerts.mjs'

const topic = process.env.NTFY_TOPIC?.trim()
const STATE = 'data/cache/alerts.json', LAST = 'data/cache/last-summary.json', SITE = 'https://0xoneshot.github.io/aero-lp-dashboard/'
const RPCS = {
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org'],
  eth: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://cloudflare-eth.com'],
}

// slot0() of one chain's WETH/USDC pools (18 and 6 decimals), as the page reads them: [{ address, invert }]
// -> [{ price, tick }], the price in dollars per ETH (inverted where USDC is token0).
async function slot0s(chain, pools) {
  const calls = pools.map((p, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: p.address, data: '0x3850c7bd' }, 'latest'] }))
  for (const url of RPCS[chain] ?? []) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls), signal: AbortSignal.timeout(10_000) })
      const out = await r.json()
      if (!Array.isArray(out) || out.length !== calls.length || out.some((x) => x.error || typeof x.result !== 'string' || x.result.length < 130)) continue
      return out.sort((a, b) => a.id - b.id).map((x, i) => {
        const w = x.result.slice(2), q = Number(BigInt('0x' + w.slice(0, 64))) / 2 ** 96
        return { price: pools[i].invert ? 1e12 / (q * q) : q * q * 1e12, tick: Number(BigInt.asIntN(24, BigInt('0x' + w.slice(64, 128)))) }
      })
    } catch {}
  }
  return null
}

async function lastSummaryLive() {
  if (!fs.existsSync(LAST)) return null
  const summary = JSON.parse(fs.readFileSync(LAST, 'utf8'))
  const ref = summary[0]?.eth_ref_pool, hourly = summary[0]?.eth_usd
  // The reference pool is on Base; each position's pool on its own chain.
  const want = new Map(ref ? [[`base:${ref}`, { chain: 'base', address: ref, invert: false }]] : [])
  for (const p of summary.flatMap((r) => r.curve?.positions ?? [])) if (p.pool_address) want.set(`${p.chain ?? 'base'}:${p.pool_address}`, { chain: p.chain ?? 'base', address: p.pool_address, invert: Boolean(p.invert) })
  const live = {}
  for (const chain of new Set([...want.values()].map((q) => q.chain))) {
    const keys = [...want].filter(([, q]) => q.chain === chain)
    const got = await slot0s(chain, keys.map(([, q]) => q))
    if (got) keys.forEach(([k], i) => { live[k] = got[i] })
  }
  if (!ref || Object.keys(live).length < want.size || Object.values(live).some((x) => !(x.price > hourly / 2 && x.price < hourly * 2))) {
    console.log('alerts: no live prices either')
    return { summary, live: false }
  }
  return { summary: withLivePrices(summary, live, live[`base:${ref}`].price), live: true }
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
