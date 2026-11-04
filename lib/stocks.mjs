// Aero's stock/USDC pools on Base, only to list them on the page beside the WETH/USDC pools: their rates are
// read and worked out the same way (lib/pools.mjs), with the stock's own pool as its price. Moving there is
// another bet than moving between WETH/USDC pools, so they take no part in the pick or the alerts, and the
// wallets' figures do not follow a position in them.
//
// Pools are found once: each run asks only about pools the factory made since the last. Those with money in
// them are sampled hourly, kept in data/cache/stocks.json for as long as the rates need (STOCK_DAYS), a far
// shorter window than the WETH/USDC pools' since no weekly lead is worked out here.
import fs from 'node:fs'
import { parseAbi } from 'viem'
import { factoryAbi, clPoolAbi, erc20Abi } from './abi.mjs'
import { poolUsd } from './curve.mjs'
import { readPool, poolStats, stayShare, median, walk, noData, reverted, MULTICALL } from './pools.mjs'

const abi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function decimals() view returns (uint8)',
  'function voter() view returns (address)',
])

const HOUR = 3600
const r6 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e6) / 1e6)
const r2 = (x) => Math.round(x * 100) / 100
const lc = (a) => a.toLowerCase()
const cstTime = (ts) => new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ')
const noAddress = (a) => /^0x0{40}$/.test(a)

export const CACHE_VERSION = 1
// Seven full Beijing days, today's hours, and the part of the eighth day before them.
export const STOCK_DAYS = 9
// Sampled from this much in the pool, and listed while it holds this much; sampling goes on down to
// STOCK_KEEP_USD, so a pool that dips under the line comes back with its rates. Thinner pools are mostly dust at
// odd prices. Judged on the median of the last READINGS hours read: the money in these pools leaves and returns
// within minutes (a pool of $200k reads $62 two blocks later), which one reading would take for its end. Until it
// has SETTLED of them a pool stands on the best it has, having just shown that much.
export const STOCK_MIN_USD = 100_000, STOCK_KEEP_USD = 50_000
const READINGS = 24, SETTLED = 6
const MAX_PRICE = 1e6 // a thin pool can sit at any price: no share is worth this, so it holds no money to speak of

// Coinbase's tokenised stocks ("AMZNc") come from one factory, whose addresses start alike (it makes other
// tokens too, under other kinds of names), and ST0x's wrapped ones are "wtCOIN".
export const isStock = (address, symbol) => typeof symbol === 'string' && ((lc(address).startsWith('0xb2000000') && /^[A-Z]{1,6}c$/.test(symbol)) || /^wt[A-Z]{2,6}$/.test(symbol))

async function batches(client, blockNumber, contracts, allowFailure) {
  const out = []
  for (let i = 0; i < contracts.length; i += 150) {
    out.push(...await client.multicall({ multicallAddress: MULTICALL, allowFailure, blockNumber, contracts: contracts.slice(i, i + 150) }))
  }
  return out
}
const value = (x) => (x.status === 'success' ? x.result : null)
// A contract's own answer that it is not what was asked (a symbol kept as bytes32 reads as an impossible
// offset). Anything else is the node's and says nothing about the contract, and so is the failure of a whole call:
// it comes back as a failure of each call in it, named after the Multicall3 function, whatever it looks like.
const refused = (err) => err.functionName !== 'aggregate3' && (noData(err) || reverted(err) || walk(err, /Decod|OutOfBounds|OutOfRange|SizeMismatch|InvalidBytes/i))
const answers = (rows) => rows.map((x) => {
  if (x.status === 'success') return x.result
  if (refused(x.error)) return null
  throw x.error
})

// The stock pools among those the factory made since the last run. Advances `scanned` only when all of them
// were read, so a failure asks again next run.
async function findNew(client, chain, cache, blockNumber) {
  const factory = chain.compare.factory, usdc = lc(chain.usdc)
  const n = Number(await client.readContract({ address: factory, abi: factoryAbi, functionName: 'allPoolsLength', blockNumber }))
  if (n <= cache.scanned) return 0
  const ids = Array.from({ length: n - cache.scanned }, (_, i) => BigInt(cache.scanned + i))
  const addrs = (await batches(client, blockNumber, ids.map((i) => ({ address: factory, abi: factoryAbi, functionName: 'allPools', args: [i] })), false)).map(lc)
  const tokens = await batches(client, blockNumber, addrs.flatMap((address) => [{ address, abi, functionName: 'token0' }, { address, abi, functionName: 'token1' }]), false)
  const paired = addrs.map((address, i) => ({ address, t0: lc(tokens[i * 2]), t1: lc(tokens[i * 2 + 1]) })).filter((p) => p.t0 === usdc || p.t1 === usdc).map((p) => ({ ...p, token: p.t0 === usdc ? p.t1 : p.t0 }))
  const symbols = answers(await batches(client, blockNumber, paired.map((p) => ({ address: p.token, abi: erc20Abi, functionName: 'symbol' })), true))
  const named = paired.map((p, i) => ({ ...p, symbol: symbols[i] })).filter((p) => isStock(p.token, p.symbol))
  // Anyone can make a pool: a token that does not answer as a token is no stock.
  const decimals = answers(await batches(client, blockNumber, named.map((p) => ({ address: p.token, abi, functionName: 'decimals' })), true))
  const found = named.map((p, i) => ({ ...p, decimals: decimals[i] })).filter((p) => p.decimals != null)
  const spacing = await batches(client, blockNumber, found.map((p) => ({ address: p.address, abi, functionName: 'tickSpacing' })), false)
  found.forEach((p, i) => {
    cache.known[p.address] = { address: p.address, token: p.token, symbol: p.symbol, decimals: Number(p.decimals), tickSpacing: Number(spacing[i]), wethFirst: p.t0 === p.token }
  })
  cache.scanned = n
  return found.length
}

// Every known pool's gauge and the dollars in it now, from its balances at its own price. A pool that could not
// be read is left out, and said (`fail`).
async function poolsNow(client, chain, cache, blockNumber, fail) {
  const known = Object.values(cache.known), usdc = chain.usdc
  const r = await batches(client, blockNumber, known.flatMap((p) => [
    { address: p.address, abi: clPoolAbi, functionName: 'gauge' },
    { address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
    { address: p.token, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
    { address: p.address, abi: clPoolAbi, functionName: 'slot0' },
  ]), true)
  const bad = r.find((x) => x.status !== 'success' && !refused(x.error))
  if (bad) fail(bad.error)
  return known.map((p, i) => {
    const [gauge, u, t, s0] = r.slice(i * 4, i * 4 + 4).map(value)
    if (gauge == null || u == null || t == null || s0 == null) return null
    const price = poolUsd(s0[0], !p.wethFirst) / 10 ** (18 - p.decimals)
    return { p, gauge: lc(gauge), usd: price > 0 && price < MAX_PRICE ? Number(u) / 1e6 + (Number(t) / 10 ** p.decimals) * price : 0 }
  }).filter(Boolean)
}

// Adds the missing hourly samples of the pools with money in them to the cache file, the fullest pools first and
// only until `deadline` (ms), so the first runs fill the window over a few runs if they must. What cannot be read
// is reported in `errors` and asked again next run; it never throws for the node's sake, since nothing but this
// list depends on it. blockAt(ts) -> { block, ts }, priceAt(ts) -> { aero }.
export async function sampleStockPools({ client, chain, head, headTs, blockAt, priceAt, file, pmap, deadline = Infinity, log = () => {} }) {
  let cache = { version: CACHE_VERSION, scanned: 0, known: {}, pools: {} }
  try { if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j.version === CACHE_VERSION) cache = j } } catch {}
  const errors = [], blockNumber = BigInt(head)
  const fail = (err) => { if (!errors.length) errors.push(err.shortMessage ?? err.message) }
  // Not finding new pools leaves the known ones to be read.
  try {
    const fresh = await findNew(client, chain, cache, blockNumber)
    if (fresh) log(`stocks: ${fresh} new pools of ${Object.keys(cache.known).length}`)
  } catch (err) { fail(err) }
  try {
    const newest = Math.floor(headTs / HOUR) * HOUR, oldest = newest - STOCK_DAYS * 86400
    const now = await poolsNow(client, chain, cache, blockNumber, fail)
    // A pool that could not be read at all this run keeps what it has, as it was.
    const seen = new Set(now.map((x) => x.p.address))
    const wanted = []
    for (const x of now) {
      const e = cache.pools[x.p.address]
      if (noAddress(x.gauge)) continue
      if (!e) { if (x.usd >= STOCK_MIN_USD) wanted.push(x); continue }
      e.readings[newest] = Math.max(e.readings[newest] ?? 0, x.usd)
      for (const t of Object.keys(e.readings).map(Number).sort((a, b) => a - b).slice(0, -READINGS)) delete e.readings[t]
      const read = Object.values(e.readings)
      e.tvlUsd = r2(read.length < SETTLED ? Math.max(...read) : median(read))
      if (e.tvlUsd >= STOCK_KEEP_USD) wanted.push({ ...x, usd: e.tvlUsd })
    }
    wanted.sort((a, b) => b.usd - a.usd)
    const stay = new Set(wanted.map((x) => x.p.address))
    for (const a of Object.keys(cache.pools)) if (seen.has(a) && !stay.has(a)) delete cache.pools[a]
    // A gauge's voter gives the hour's emissions: without it the rates would be wrong, so a pool waits for it.
    const askVoter = wanted.filter((x) => { const e = cache.pools[x.p.address]; return !e?.voter || e.gauge !== x.gauge })
    const voters = await batches(client, blockNumber, askVoter.map((x) => ({ address: x.gauge, abi, functionName: 'voter' })), true)
    askVoter.forEach((x, i) => {
      x.voter = value(voters[i]) ? lc(value(voters[i])) : null
      if (!x.voter && !refused(voters[i].error)) fail(voters[i].error)
    })
    const hours = []
    for (let t = newest; t >= oldest; t -= HOUR) hours.push(t)
    const at = new Map() // hour -> { block, ts }, shared by the pools
    let added = 0, sampled = 0
    for (const x of wanted) {
      if ('voter' in x && !x.voter) continue
      const e = (cache.pools[x.p.address] ??= { ...x.p, readings: { [newest]: x.usd }, tvlUsd: r2(x.usd), samples: {} })
      if ('voter' in x) Object.assign(e, { gauge: x.gauge, voter: x.voter })
      e.seenAt = headTs
      sampled++
      for (const t of Object.keys(e.samples)) if (Number(t) < oldest) delete e.samples[t]
      await pmap(hours.filter((t) => !(t in e.samples)), 4, async (t) => {
        if (Date.now() > deadline) return
        try {
          if (!at.has(t)) at.set(t, blockAt(t))
          const { block, ts } = await at.get(t)
          const s = await readPool(client, e, block)
          // A pool that did not exist yet stays recorded as such, so it is not asked again.
          if (s) { const { aero } = await priceAt(t); e.samples[t] = { ts, block, ...s, aero } } else e.samples[t] = { ts, block, none: true }
          added++
        } catch (err) { at.delete(t); fail(err) }
      })
      e.missing = hours.filter((t) => !(t in e.samples)).length
    }
    log(`stocks: ${sampled} pools sampled, ${added} new hourly samples`)
  } catch (err) { fail(err) }
  fs.writeFileSync(file + '.tmp', JSON.stringify(cache))
  fs.renameSync(file + '.tmp', file)
  return { cache, errors }
}

// The lower of the usual (median day) and the last 24 hours, as options are judged (lib/switch.mjs).
const lower = (median, recent) => (median == null ? null : Math.min(median, recent ?? median))

// The pools to list for some money and a width, highest first and those no longer being read last: each by
// whichever of staking or not earns more, in the same terms as the WETH/USDC pools' rows (src/run.mjs poolCompare).
export function stockRows(cache, { ratio, myUsd = 0, nowTs, minUsd = STOCK_MIN_USD }) {
  return Object.values(cache.pools).filter((e) => e.tvlUsd >= minUsd).map((e) => {
    const st = poolStats(e, { ratio, myUsd: Math.max(0, myUsd), nowTs })
    // A gauge that has paid nothing for 3 hours has stopped: staking there is no option.
    const stopped = st.quietHours >= 3
    const staked = stopped ? null : lower(st.staked.median, st.recent.staked), fee = lower(st.fee.median, st.recent.fee)
    const mode = staked == null && fee == null ? null : fee == null || (staked != null && staked >= fee) ? 'staked' : 'fee'
    const ageH = st.last ? Math.max(0, Math.floor((nowTs - st.last.ts) / HOUR)) : null
    return {
      symbol: e.symbol, label: `CL${e.tickSpacing}`, pool_address: e.address, tvl_usd: e.tvlUsd, days: st.days, stopped,
      mode, rate: r6(mode === 'staked' ? staked : mode === 'fee' ? fee : null),
      median: r6(mode === 'staked' ? st.staked.median : mode === 'fee' ? st.fee.median : null), recent: r6(mode === 'staked' ? st.recent.staked : mode === 'fee' ? st.recent.fee : null),
      in_range_72h: r6(stayShare(e, ratio, { nowTs, days: STOCK_DAYS })), missing_hours: e.missing ?? null,
      last_sample: st.last ? cstTime(st.last.ts) : null, age_h: ageH, stale: ageH == null || ageH > 3,
    }
  }).sort((a, b) => Number(a.stale) - Number(b.stale) || (b.rate ?? -1) - (a.rate ?? -1))
}
