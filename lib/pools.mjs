// Aero's WETH/USDC pools compared by what a position of the owners' width would have earned in each,
// staked (gauge emissions only) or not (trading fees only), per Beijing day, for the page's pool card.
//
// In these pools a staked position earns no trading fees and an unstaked one no emissions. Each pool
// keeps two running totals per unit of liquidity in range: rewardGrowthGlobalX128 grows by every
// emission paid out over the staked liquidity in range, and feeGrowthGlobal0X128/1X128 by every swap
// fee's unstaked share (net of the pool's unstaked fee) over the unstaked liquidity in range. Between
// two moments their growth is exactly what one unit of liquidity earned there while in range, staked
// or not (it is what a real position's growth inside its range adds up to while the price is inside).
// Divided by the dollars one unit of liquidity holds in a range of the owners' width centred on the
// price, that is the yearly rate such a position earned. Sampled on the hour, kept in data/cache/pools.json.
// The reward total is settled lazily (on swaps across ticks, stakes and claims); a sample adds what the
// voter has streamed to the gauge since, as the gauge's own earned() does. Checked against the realised
// rewards of real staked positions of similar widths (2026-10-25 to 10-31: within a few points a day).
import fs from 'node:fs'
import { parseAbi } from 'viem'
import { factoryAbi, clPoolAbi, erc20Abi } from './abi.mjs'
import { poolUsd } from './curve.mjs'
import { cstDay } from './time.mjs'

const growthAbi = parseAbi([
  'function liquidity() view returns (uint128)',
  'function rewardGrowthGlobalX128() view returns (uint256)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function token0() view returns (address)',
  'function tickSpacings() view returns (int24[])',
  'function voter() view returns (address)',
  'function projectedCumulativeRewardShare(address gauge) view returns (uint256)',
  'function lastCumulativeRewardShare() view returns (uint256)',
])

const HOUR = 3600, YEAR = 365 * 86400, WEEK = 7 * 86400
// Multicall3, at the same address on every chain compared.
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11'
const Q128 = 2 ** 128
export const WINDOW_DAYS = 28

// Every WETH/USDC pool of a chain's factory that has a gauge, at a block, over every tick spacing the
// factory enables.
export async function discoverPools(client, chain, blockNumber) {
  const { factory } = chain.compare
  const tickSpacings = (await client.readContract({ address: factory, abi: growthAbi, functionName: 'tickSpacings', blockNumber: BigInt(blockNumber) })).map(Number)
  // Every read here answers for a real pool (getPool gives the zero address for a missing one), so any
  // failure is the node's: it throws, and the chain keeps the samples it has.
  const found = await client.multicall({ multicallAddress: MULTICALL, allowFailure: false, blockNumber: BigInt(blockNumber), contracts: tickSpacings.map((ts) => ({ address: factory, abi: factoryAbi, functionName: 'getPool', args: [chain.weth, chain.usdc, ts] })) })
  const pools = found.map((r, i) => ({ address: r.toLowerCase(), tickSpacing: tickSpacings[i] })).filter((p) => !/^0x0{40}$/.test(p.address))
  if (!pools.length) return []
  const info = await client.multicall({ multicallAddress: MULTICALL, allowFailure: false, blockNumber: BigInt(blockNumber), contracts: pools.flatMap((p) => [
    { address: p.address, abi: clPoolAbi, functionName: 'gauge' },
    { address: p.address, abi: growthAbi, functionName: 'token0' },
    { address: chain.weth, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
    { address: chain.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [p.address] },
  ]) })
  const gauged = pools.map((p, i) => {
    const [g, t0, bw, bu] = info.slice(i * 4, i * 4 + 4)
    return { ...p, gauge: g.toLowerCase(), wethFirst: t0.toLowerCase() === chain.weth, weth: bw, usdc: bu }
  }).filter((p) => !/^0x0{40}$/.test(p.gauge))
  if (!gauged.length) return []
  const voters = await client.multicall({ multicallAddress: MULTICALL, allowFailure: false, blockNumber: BigInt(blockNumber), contracts: gauged.map((p) => ({ address: p.gauge, abi: growthAbi, functionName: 'voter' })) })
  return gauged.map((p, i) => ({ ...p, voter: voters[i].toLowerCase() }))
}

// The block nearest a time on a chain whose blocks come at a roughly even pace: a guess from the
// average block time back from the head, corrected by the guessed block's own time until it is within
// half a block (a few reads), which is close enough for an hourly sample.
export function blockFinder(client, head, headTs, secs) {
  const tsOf = async (b) => Number((await client.getBlock({ blockNumber: BigInt(b) })).timestamp)
  const clamp = (b) => Math.min(head, Math.max(0, b))
  return async (t) => {
    let b = clamp(head - Math.round((headTs - t) / secs)), ts = await tsOf(b)
    for (let i = 0; i < 6; i++) {
      const off = Math.round((ts - t) / secs)
      if (!off || clamp(b - off) === b) break
      b = clamp(b - off); ts = await tsOf(b)
    }
    return { block: b, ts }
  }
}

const walk = (err, re) => Boolean(err && (err.walk ? err.walk((e) => re.test(`${e.name} ${e.shortMessage ?? ''}`)) : re.test(`${err.name} ${err.message}`)))
const noData = (err) => walk(err, /ZeroData|returned no data/i)
const reverted = (err) => walk(err, /ContractFunctionRevertedError|execution reverted/i)

// Reads at block `block` of one pool, or null if it did not exist yet (no code there, or no Multicall3
// yet on the chain, answers with no data); any other failure is the node's and throws, so the hour is
// read again next run. `share` is the reward the voter has streamed to the gauge in all (the hour's
// emissions are its growth), `unsettled` the part of it the pool has not credited yet; both are left
// out if the voter reverts.
async function readPool(client, p, block) {
  const address = p.address
  const r = await client.multicall({ multicallAddress: MULTICALL, allowFailure: true, blockNumber: BigInt(block), contracts: [
    { address, abi: clPoolAbi, functionName: 'slot0' },
    { address, abi: growthAbi, functionName: 'liquidity' },
    { address, abi: clPoolAbi, functionName: 'stakedLiquidity' },
    { address, abi: growthAbi, functionName: 'rewardGrowthGlobalX128' },
    { address, abi: growthAbi, functionName: 'feeGrowthGlobal0X128' },
    { address, abi: growthAbi, functionName: 'feeGrowthGlobal1X128' },
    ...(p.voter ? [{ address: p.voter, abi: growthAbi, functionName: 'projectedCumulativeRewardShare', args: [p.gauge] }, { address: p.gauge, abi: growthAbi, functionName: 'lastCumulativeRewardShare' }] : []),
  ] })
  const bad = r.filter((x, i) => x.status !== 'success' && (i < 6 || !reverted(x.error)))
  if (bad.length) {
    if (bad.every((x) => noData(x.error))) return null
    throw bad[0].error
  }
  const [s0, liq, staked, rg, fg0, fg1, share, last] = r.map((x) => (x.status === 'success' ? x.result : null))
  const out = { sqrtP: s0[0].toString(), liq: liq.toString(), staked: staked.toString(), rg: rg.toString(), fg0: fg0.toString(), fg1: fg1.toString() }
  if (share != null && last != null) Object.assign(out, { share: share.toString(), unsettled: (share > last ? share - last : 0n).toString() })
  return out
}

// Adds the missing hourly samples of every pool to the cache file, newest first, at most `maxNew` per
// pool and only until `deadline` (ms), so a first run fills the window over a few runs if it must.
// chains: [{ chain, client, head, headTs, blockAt(ts) -> { block, ts } }]; priceAt(ts) -> { aero, eth } in
// dollars, the reference prices the earnings and the position are valued at.
// A chain that cannot be read keeps its earlier samples; its error is returned, not thrown.
export const SAMPLE_VERSION = 2 // bump whenever a sample reads something new
export async function samplePools({ chains, priceAt, file, maxNew = 800, deadline = Infinity, pmap, log = () => {} }) {
  let cache = { version: SAMPLE_VERSION, pools: {} }
  try { if (fs.existsSync(file)) { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (j.version === SAMPLE_VERSION) cache = j } } catch {}
  // A pool exists from its first real sample on: a 'none' after it was a failed read (as an earlier
  // version of this file stored them), and is read again.
  for (const e of Object.values(cache.pools)) {
    const first = Math.min(...Object.entries(e.samples).filter(([, v]) => !v.none).map(([t]) => Number(t)))
    for (const [t, v] of Object.entries(e.samples)) if (v.none && Number(t) > first) delete e.samples[t]
  }
  const errors = []
  for (const x of chains) {
    try {
      const found = await discoverPools(x.client, x.chain, x.head)
      // The chain's gas price now, for what moving a position there would cost (src/run.mjs).
      cache.gas = { ...cache.gas, [x.chain.key]: { wei: (await x.client.getGasPrice()).toString(), token: x.chain.gasToken ?? 'eth', ts: x.headTs } }
      const oldest = Math.floor(x.headTs / HOUR) * HOUR - (WINDOW_DAYS + 1) * 86400
      const hours = []
      for (let t = Math.floor(x.headTs / HOUR) * HOUR; t >= oldest; t -= HOUR) hours.push(t)
      const at = new Map() // hour -> { block, ts }, shared by the chain's pools
      for (const p of found) {
        const key = `${x.chain.key}:${p.address}`
        const e = (cache.pools[key] ??= { chain: x.chain.key, address: p.address, samples: {} })
        Object.assign(e, { tickSpacing: p.tickSpacing, gauge: p.gauge, voter: p.voter, wethFirst: p.wethFirst, seenAt: x.headTs,
          tvl: { weth: p.weth.toString(), usdc: p.usdc.toString() } })
        for (const t of Object.keys(e.samples)) if (Number(t) < oldest) delete e.samples[t]
        const todo = hours.filter((t) => !(t in e.samples)).slice(0, maxNew)
        let added = 0
        await pmap(todo, 4, async (t) => {
          if (Date.now() > deadline) return
          try {
            if (!at.has(t)) at.set(t, x.blockAt(t))
            const { block, ts } = await at.get(t)
            // A block before Multicall3 existed on the chain answers with no data: the pool was not there either.
            const s = await readPool(x.client, p, block)
            // A pool that did not exist yet stays recorded as such, so it is not asked again.
            if (s) { const pr = await priceAt(t); e.samples[t] = { ts, block, ...s, aero: pr.aero, eth: pr.eth } } else e.samples[t] = { ts, block, none: true }
            added++
          } catch (err) {
            at.delete(t)
            if (!errors.some((m) => m.startsWith(x.chain.key))) errors.push(`${x.chain.key}: ${err.shortMessage ?? err.message}`)
          }
        })
        // Hours of the window still to read (a first run that ran out of time, or a chain that failed).
        e.missing = hours.filter((t) => !(t in e.samples)).length
        if (added) log(`pools: ${key.slice(0, 16)}… ${added} new hourly samples (${Object.keys(e.samples).length} kept)`)
      }
      // A pool the factory no longer returns, or without a gauge, is no longer compared (discovery
      // succeeded: a failed read has thrown above).
      const live = new Set(found.map((p) => `${x.chain.key}:${p.address}`))
      for (const [k, e] of Object.entries(cache.pools)) if (e.chain === x.chain.key && !live.has(k)) delete cache.pools[k]
    } catch (err) {
      errors.push(`${x.chain.key}: ${err.shortMessage ?? err.message}`)
    }
  }
  fs.writeFileSync(file + '.tmp', JSON.stringify(cache))
  fs.renameSync(file + '.tmp', file)
  return { cache, errors }
}

// Dollars one unit of liquidity holds in a range whose upper bound is `ratio` times its lower bound,
// centred (geometrically) on the pool's dollar price P, with ETH valued at `ref`: the same amounts as
// lib/curve.mjs amountsAtUsd.
export function dollarsPerL(P, ratio, ref = P) {
  const r = Math.sqrt(P * 1e-12), k = ratio ** 0.25, sa = r / k, sb = r * k
  return ((1 / r - 1 / sb) / 1e18) * ref + (r - sa) / 1e6
}

// The pool's reward per unit of staked liquidity at a sample, with what the voter has streamed to the
// gauge but the pool has not credited yet (credited the same way when it is: over the staked liquidity).
const settled = (x) => BigInt(x.rg) + (x.unsettled != null && BigInt(x.staked) > 0n ? (BigInt(x.unsettled) * 2n ** 128n) / BigInt(x.staked) : 0n)

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null }
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return null; const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo) }

// What a position of width `ratio` holding `myUsd` would have earned in one pool, as yearly rates.
// The owners' money shares the emissions with the staked liquidity, or the fees with all of it; what of
// it is already in the pool (`inStakedUsd` staked, `inPoolUsd` in all) is in those totals already, so
// only the rest is added. In-range staked liquidity swings
// many times over within an hour, and rewards go mostly to the moments it is thin, so the liquidity an
// hour's rewards were really shared by is the hour's emissions over its reward per unit of liquidity
// (their harmonic mean over the hour), not the liquidity at the hour's start.
// A range centred at an hour's start whose price has left it by the hour's end earned for only part of
// the hour, and the pool price moved that far in a moment (as Ethereum's did on 10-30, to $2,703 with
// the market at $2,258): such an hour counts as earning nothing. ETH is valued at the reference price.
// Fee growth stops while no unstaked liquidity is in range (every fee then goes to the gauge), though
// a position joining unstaked would earn: hours with none at either end are left out of the fee rate
// rather than counted as earning nothing.
// Days are Beijing days within the window before `nowTs`; a day counts in the medians once 20 hours of
// it are sampled (and, for fees, 6 hours have unstaked liquidity).
export function poolStats(e, { ratio, myUsd = 0, inStakedUsd = 0, inPoolUsd = 0, nowTs }) {
  const ts = Object.keys(e.samples).map(Number).sort((a, b) => a - b)
  const days = new Map(), weeks = new Map()
  const add = (m, k, dt, st, fe, em) => {
    const d = m.get(k) ?? { secs: 0, feeSecs: 0, staked: 0, fee: 0, emitted: 0 }
    d.secs += dt; d.staked += st * dt; d.emitted += em
    if (fe != null) { d.feeSecs += dt; d.fee += fe * dt }
    m.set(k, d)
  }
  let last = null, quiet = 0 // hours in a row, up to the last sample, in which the gauge paid nothing
  for (let i = 1; i < ts.length; i++) {
    const a = e.samples[ts[i - 1]], b = e.samples[ts[i]]
    if (a.none || b.none) continue
    const dt = b.ts - a.ts
    if (dt <= 0 || dt > 3 * HOUR) continue // a gap: what was earned in it cannot be placed in a day
    const invert = !e.wethFirst
    const Pa = poolUsd(BigInt(a.sqrtP), invert), Pb = poolUsd(BigInt(b.sqrtP), invert)
    const ref = a.eth != null && b.eth != null ? (a.eth + b.eth) / 2 : (Pa + Pb) / 2
    const perL = dollarsPerL(Pa, ratio, ref)
    const inside = Pb >= Pa / Math.sqrt(ratio) && Pb <= Pa * Math.sqrt(ratio)
    const aero = a.aero != null && b.aero != null ? (a.aero + b.aero) / 2 : a.aero ?? b.aero ?? 0
    const dg = Number(settled(b) - settled(a)) / Q128 // reward wei per unit of staked liquidity
    const reward = (dg / 1e18) * aero
    const d0 = Number(BigInt(b.fg0) - BigInt(a.fg0)) / Q128, d1 = Number(BigInt(b.fg1) - BigInt(a.fg1)) / Q128
    const fee = e.wethFirst ? (d0 / 1e18) * ref + d1 / 1e6 : d0 / 1e6 + (d1 / 1e18) * ref
    const S = Number(a.staked), L = Number(a.liq)
    const emitted = a.share != null && b.share != null ? Number(BigInt(b.share) - BigInt(a.share)) : 0
    const Seff = emitted > 0 && dg > 0 ? emitted / dg : S, Leff = S > 0 ? Seff * (L / S) : L
    const addS = Math.max(0, myUsd - inStakedUsd) / perL, addL = Math.max(0, myUsd - inPoolUsd) / perL
    const stakedShare = Seff > 0 ? Seff / (Seff + addS) : 0, feeShare = Leff > 0 ? Leff / (Leff + addL) : 0
    const feeOk = BigInt(a.liq) > BigInt(a.staked) || BigInt(b.liq) > BigInt(b.staked)
    const st = inside ? ((reward * stakedShare) / perL) * (YEAR / dt) : 0
    const fe = !feeOk ? null : inside ? ((fee * feeShare) / perL) * (YEAR / dt) : 0
    const mid = (a.ts + b.ts) / 2
    add(days, cstDay(mid), dt, st, fe, emitted)
    // Aero's weeks (epochs) start on Thursdays at 00:00 UTC; the unix epoch was one.
    add(weeks, Math.floor(mid / WEEK) * WEEK, dt, st, fe, emitted)
    last = { ts: b.ts, price: Pb, ref, stakedShare: L > 0 ? S / L : null }
    quiet = emitted > 0 || dg > 0 ? 0 : quiet + dt / HOUR
  }
  const today = cstDay(nowTs), from = cstDay(nowTs - WINDOW_DAYS * 86400)
  const feeOf = (d) => (d.feeSecs >= 6 * HOUR ? d.fee / d.feeSecs : null)
  const rows = [...days].map(([day, d]) => ({ day, hours: Math.round((d.secs / HOUR) * 10) / 10, staked: d.staked / d.secs, fee: feeOf(d) }))
  const full = rows.filter((r) => r.day !== today && r.day >= from && r.hours >= 20)
  const stat = (f) => {
    const xs = full.map((r) => r[f]).filter((x) => x != null), seven = full.slice(-7).map((r) => r[f]).filter((x) => x != null)
    return { median: median(xs), p25: quantile(xs, 0.25), mean7: seven.length ? seven.reduce((a, x) => a + x, 0) / seven.length : null }
  }
  return {
    // A gauge streams every second while it pays: hours of nothing mean its rewards stopped (killed).
    days: full.length, staked: stat('staked'), fee: stat('fee'), quietHours: quiet,
    daily: full.map((r) => ({ day: r.day, staked: r.staked, fee: r.fee })),
    // The week's emissions to the gauge a day (reward tokens): set each week by the votes and the
    // gauge's cap, so the week under way tells where rates are heading.
    weeks: [...weeks].slice(-4).map(([start, d]) => ({ start: cstDay(start), hours: Math.round(d.secs / HOUR), staked: d.staked / d.secs, fee: feeOf(d), emitted_day: (d.emitted / 1e18) * (86400 / d.secs) })),
    last,
  }
}
