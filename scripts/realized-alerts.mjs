// Sends the BTC and ETH realized-price alerts (lib/realized.mjs) to the ntfy topic in NTFY_TOPIC, as
// scripts/alerts.mjs does the wallets'. Public market data only, nothing of the wallets: it runs every hour,
// whether or not the update went through. The state, with the last realized prices read, is kept in
// data/cache/realized-alerts.json, which travels with the encrypted scan cache; without NTFY_TOPIC it only
// keeps the state up to date.
//   realized prices: Coin Metrics' community API, once a day per coin (the last ones read are used while it
//                    fails, up to RP_MAX_AGE)
//   prices:          Chainlink's BTC/USD and ETH/USD feeds on Base, read from public RPCs; Coinbase's spot
//                    price when a feed cannot be read or is old
import fs from 'node:fs'
import { ASSETS, NAMES, PRICE_MAX_AGE, evaluateRealized, unsent, realizedFrom, latestRealized, freshRealized, feedAnswer } from '../lib/realized.mjs'

// The step has a minute (refresh.yml): every request has its own short limit, and sending stops in time
// for the state to be written; what is left waits for the next run.
const started = Date.now(), SEND_UNTIL = started + 40_000
const topic = process.env.NTFY_TOPIC?.trim()
const STATE = 'data/cache/realized-alerts.json', SITE = 'https://0xoneshot.github.io/aero-lp-dashboard/'
const FEEDS = { btc: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F', eth: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70' }
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org']

async function realized() {
  const from = new Date(started - 10 * 86400e3).toISOString().slice(0, 10)
  const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${ASSETS.join(',')}&metrics=PriceUSD,CapMVRVCur&frequency=1d&start_time=${from}&page_size=100`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) })
    if (!r.ok) throw new Error(`answered ${r.status}`)
    return realizedFrom((await r.json())?.data)
  } catch (e) {
    console.log(`realized alerts: Coin Metrics not read (${e.message})`)
    return {}
  }
}

// latestRoundData() of each feed, from the first RPC that answers it; an answer older than PRICE_MAX_AGE is not taken.
async function chainlink() {
  const out = {}
  for (const url of RPCS) {
    const want = ASSETS.filter((a) => !(a in out))
    if (!want.length) break
    try {
      const calls = want.map((a, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [{ to: FEEDS[a], data: '0xfeaf968c' }, 'latest'] }))
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls), signal: AbortSignal.timeout(6_000) })
      const got = await r.json()
      if (!Array.isArray(got)) continue
      for (const x of got) {
        const a = want[x?.id], v = feedAnswer(x?.result)
        if (a && v && Date.now() - v.at <= PRICE_MAX_AGE) out[a] = v.price
      }
    } catch {}
  }
  return out
}

async function coinbase(a) {
  try {
    const r = await fetch(`https://api.coinbase.com/v2/prices/${NAMES[a]}-USD/spot`, { signal: AbortSignal.timeout(6_000) })
    const v = Number((await r.json())?.data?.amount)
    return v > 0 ? v : null
  } catch { return null }
}

async function send(m) {
  const r = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic, title: m.title, message: m.message, priority: m.priority, tags: m.tags, click: SITE }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) throw new Error(`ntfy answered ${r.status}`)
}

// An unreadable state starts over (records only, and says where both stand), rather than stopping the alerts.
let prev = null
try { if (fs.existsSync(STATE)) prev = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { console.log('realized alerts: state unreadable, starting over') }
const [read, feeds] = await Promise.all([realized(), chainlink()])
const prices = { ...feeds }
const fallback = ASSETS.filter((a) => !(a in prices))
for (const [i, v] of (await Promise.all(fallback.map(coinbase))).entries()) if (v) prices[fallback[i]] = v
const rp = latestRealized(prev?.rp, read)
const now = Date.now()
const quotes = Object.fromEntries(ASSETS.map((a) => {
  const ok = freshRealized(rp[a], now)
  return [a, { price: prices[a] ?? null, rp: ok ? rp[a].rp : null, rpDate: ok ? rp[a].date : null }]
}))
const { messages, state } = evaluateRealized(quotes, prev, { now })
let sent = 0, left = 0
if (topic) {
  for (const m of messages) {
    if (Date.now() > SEND_UNTIL) { unsent(state, prev, m); left++; continue }
    try { await send(m); sent++ } catch (e) {
      unsent(state, prev, m)
      console.log(`realized alerts: one message failed (${e.message})`)
    }
  }
}
fs.mkdirSync('data/cache', { recursive: true })
fs.writeFileSync(STATE, JSON.stringify({ ...state, rp }))
// Public market figures only: the multiples, the day of each realized price and where the prices came from.
const where = ASSETS.map((a) => {
  const q = quotes[a]
  if (!(q.price > 0 && q.rp > 0)) return `${NAMES[a]} not judged (${q.price > 0 ? 'no realized price' : 'no price'})`
  return `${NAMES[a]} ${(q.price / q.rp).toFixed(3)}x (realized ${q.rpDate}, price ${a in feeds ? 'Chainlink' : 'Coinbase'})`
}).join(', ')
console.log(`realized alerts: ${where}; ${topic ? `${sent} of ${messages.length} sent${left ? ` (${left} left for the next run: out of time)` : ''}` : `off (${messages.length} would have been sent)`}`)
