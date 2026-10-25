// Scans the tracked wallets up to Base's safe head, values them at the end of every Beijing day, and
// writes the dashboard's datasets to out/. Run through src/update.mjs, which keeps addresses out of logs.
import fs from 'node:fs'
import path from 'node:path'
import { client, pmap } from '../lib/rpc.mjs'
import { scan } from '../lib/scan.mjs'
import { buildLedger, isExternal, owedPrincipal } from '../lib/ledger.mjs'
import { snapshot } from '../lib/snapshot.mjs'
import { pricesAt, usdOf } from '../lib/prices.mjs'
import { npmAbi, clPoolAbi, factoryAbi, TOPIC } from '../lib/abi.mjs'
import { WALLETS, START_DAY, TOKENS, NPMS, WETH, AERO, USDC as TOKEN_USDC, LABELS, GAUGE_IMPLS, STRATEGY, BRIDGES, OVERRIDES_FILE, PRICE } from '../lib/config.mjs'
import { daysBetween, dayEndBlock, cstDay, tsOfBlock } from '../lib/time.mjs'
import { priceAtTick, priceFromSqrt, amountsForLiquidity } from '../lib/univ3.mjs'

const OUT = path.resolve('out')
const SNAP_CACHE = path.resolve('data/cache/snapshots.json')
const CODE_CACHE = path.resolve('data/cache/code.json')
const SNAP_VERSION = 'snap-v2' // bump whenever lib/snapshot.mjs changes what it reads
const log = (...a) => console.error('[update]', ...a)
const lc = (a) => a.toLowerCase()

// ---------- helpers ----------
const big = (x) => (typeof x === 'bigint' ? x : BigInt(x))
const units = (raw, dec) => Number(big(raw)) / 10 ** dec
const decOf = (asset) => (asset === 'ETH' ? 18 : TOKENS[asset]?.decimals ?? 18)
const symOf = (asset) => (asset === 'ETH' ? 'ETH' : TOKENS[asset]?.symbol ?? asset.slice(0, 8))
// ETH and WETH are the same exposure for valuation and for "what if we had just held it".
const hodlKey = (asset) => (asset === 'ETH' || asset === WETH ? 'ETH' : asset)
const valueOf = (asset, raw, prices) => (asset === 'ETH' ? units(raw, 18) * prices.eth : usdOf(asset, raw, prices) ?? 0)
const r2 = (x) => Math.round(x * 100) / 100
const r6 = (x) => Math.round(x * 1e6) / 1e6
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + f(x), 0)
const cstTime = (ts) => new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ')
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`

function readJson(p, fallback) { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback }
function writeJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 1) + '\n') }

// Snapshots of finished days never change, so they are cached; BigInts round-trip through strings.
const BIG_FIELDS = ['liquidity', 'amount0', 'amount1', 'pending', 'fees0', 'fees1', 'sqrtP']
function reviveSnap(s) {
  s.balances = Object.fromEntries(Object.entries(s.balances).map(([k, v]) => [k, BigInt(v)]))
  s.deferred = BigInt(s.deferred)
  for (const p of s.positions) for (const f of BIG_FIELDS) p[f] = BigInt(p[f])
  return s
}

// ---------- scan and classify ----------
const head = Number((await client.getBlock({ blockTag: 'safe' })).number)
const state = await scan({ head })
log(`scanned to ${state.scannedTo}, ${Object.keys(state.txs).length} transactions`)
const overrides = readJson(path.resolve(OVERRIDES_FILE), {})

// A gauge counts only if it is a minimal-proxy clone of a known gauge implementation.
const codeCache = readJson(CODE_CACHE, {})
const gaugeTopics = new Set([TOPIC.GaugeDeposit, TOPIC.GaugeWithdraw, TOPIC.EmissionsClaimed, TOPIC.DeferredEmissionsClaimed])
const gaugeCands = new Set(Object.values(state.txs).flatMap((r) => r.logs.filter((l) => gaugeTopics.has(l.topics[0])).map((l) => l.address)))
await pmap([...gaugeCands].filter((a) => !(`gauge:${a}` in codeCache)), 4, async (a) => {
  const code = (await client.getCode({ address: a })) ?? '0x'
  const impl = code.length === 92 && code.startsWith('0x363d3d373d3d3d363d73') ? '0x' + code.slice(22, 62) : null
  codeCache[`gauge:${a}`] = Boolean(impl && GAUGE_IMPLS[impl])
})
const gaugeOk = (a) => codeCache[`gauge:${a}`] === true

// Whether a counterparty was a plain account (exchange, person, relayer) at the time. Only the
// ones a classification depends on are looked up: a first pass records them.
const asked = new Map()
buildLedger(state, (a, b) => { asked.set(`${a}@${b}`, [a, b]); return 'contract' }, { gaugeOk, overrides })
await pmap([...asked.values()].filter(([a, b]) => !(`${a}@${b}` in codeCache)), 6, async ([a, b]) => {
  const code = await client.getCode({ address: a, blockNumber: BigInt(b) })
  codeCache[`${a}@${b}`] = !code || code === '0x' || code.startsWith('0xef0100') ? 'eoa' : 'contract'
})
writeJson(CODE_CACHE, codeCache)
const ledger = buildLedger(state, (a, b) => codeCache[`${a}@${b}`] ?? 'contract', { gaugeOk, overrides })
log(`checked ${asked.size} counterparties, ${gaugeCands.size} gauge candidates`)

// Token pair and pool of each position.
const pairCache = new Map()
async function pairOf(npm, tokenId, block) {
  const k = `${npm}:${tokenId}`
  if (!pairCache.has(k)) {
    const read = (b) => client.readContract({ address: npm, abi: npmAbi, functionName: 'positions', args: [BigInt(tokenId)], blockNumber: BigInt(b) })
    pairCache.set(k, read(block).catch(() => read(block - 1)).then(async (p) => ({
      token0: lc(p[2]), token1: lc(p[3]), tickLower: Number(p[5]), tickUpper: Number(p[6]),
      pool: lc(await client.readContract({ address: NPMS[npm].factory, abi: factoryAbi, functionName: 'getPool', args: [p[2], p[3], p[4]] })),
    })))
  }
  return pairCache.get(k)
}

// Value of a whole position at a block (used when a position changes hands).
async function positionValueAt(npm, tokenId, block, prices) {
  const pair = await pairOf(npm, tokenId, block)
  const read = (b) => client.readContract({ address: npm, abi: npmAbi, functionName: 'positions', args: [BigInt(tokenId)], blockNumber: BigInt(b) })
  const pos = await read(block).catch(() => read(block - 1))
  const [sqrtP] = await client.readContract({ address: pair.pool, abi: clPoolAbi, functionName: 'slot0', blockNumber: BigInt(block) })
  const { amount0, amount1 } = amountsForLiquidity(sqrtP, pair.tickLower, pair.tickUpper, pos[7])
  const a0 = amount0 + pos[10], a1 = amount1 + pos[11]
  return { ...pair, amount0: a0, amount1: a1, usd: valueOf(pair.token0, a0, prices) + valueOf(pair.token1, a1, prices) }
}

// ---------- day-end snapshots ----------
const today = cstDay(tsOfBlock(head))
const days = daysBetween(START_DAY, today)
const openingBlock = dayEndBlock(new Date(Date.parse(`${START_DAY}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10))
const dayBlock = (d) => (d === today ? head : dayEndBlock(d))
const blocks = [openingBlock, ...days.map(dayBlock)]

const snapCache = readJson(SNAP_CACHE, {})
const snaps = {}
for (const w of WALLETS) {
  snaps[w.key] = {}
  const positions = ledger[w.key].positions
  const key = [SNAP_VERSION, Object.keys(TOKENS).sort().join('+'), ...positions.map((p) => `${p.npm}:${p.tokenId}:${p.gauges.join('+')}`).sort()].join(',')
  await pmap(blocks, 3, async (b) => {
    const cached = snapCache[`${w.key}:${b}`]
    if (cached && cached.posKey === key) { snaps[w.key][b] = reviveSnap(structuredClone(cached.snap)); return }
    const s = await snapshot(w, positions, b)
    snaps[w.key][b] = s
    if (b !== head) snapCache[`${w.key}:${b}`] = { posKey: key, snap: JSON.parse(JSON.stringify(s, (k, x) => (typeof x === 'bigint' ? x.toString() : x))) }
  })
}
writeJson(SNAP_CACHE, snapCache)
const prices = {}
const eventBlocks = WALLETS.flatMap((w) => ledger[w.key].events.map((e) => e.block)).filter((b) => b > openingBlock && b <= head)
await pmap([...new Set([...blocks, ...eventBlocks])], 4, async (b) => { prices[b] = await pricesAt(b) })
log(`valued ${blocks.length} day-end blocks and ${new Set(eventBlocks).size} event blocks`)
const pNowCurve = prices[head]

// A snapshot's static collect pays principal still owed first; only the rest is fees.
function valueSnapshot(s, p) {
  let wallet = 0, lp = 0, fees = 0, owedUsd = 0, lpEth = 0
  const tokens = {}, feeTok = {}
  for (const [asset, raw] of Object.entries(s.balances)) wallet += valueOf(asset, raw, p)
  for (const x of s.positions) {
    const owed = owedPrincipal(ledger.owedAt, x.npm, x.tokenId, s.block)
    const o0 = owed.owed0 < x.fees0 ? owed.owed0 : x.fees0, o1 = owed.owed1 < x.fees1 ? owed.owed1 : x.fees1
    const a0 = x.amount0 + o0, a1 = x.amount1 + o1, f0 = x.fees0 - o0, f1 = x.fees1 - o1
    lp += valueOf(x.token0, a0, p) + valueOf(x.token1, a1, p)
    fees += valueOf(x.token0, f0, p) + valueOf(x.token1, f1, p)
    owedUsd += valueOf(x.token0, o0, p) + valueOf(x.token1, o1, p)
    if (hodlKey(x.token0) === 'ETH') lpEth += units(a0, 18)
    tokens[x.token0] = (tokens[x.token0] ?? 0n) + a0; tokens[x.token1] = (tokens[x.token1] ?? 0n) + a1
    feeTok[x.token0] = (feeTok[x.token0] ?? 0n) + f0; feeTok[x.token1] = (feeTok[x.token1] ?? 0n) + f1
  }
  const pendingAero = units(s.positions.reduce((a, x) => a + x.pending, 0n) + s.deferred, 18)
  const pending = pendingAero * (p.aero ?? 0)
  const live = s.positions.filter((x) => x.liquidity > 0n)
  const range = !live.length ? 'none' : live.every((x) => x.inRange) ? 'in' : live.some((x) => x.inRange) ? 'part' : 'out'
  return { wallet, lp, fees, pending, pendingAero, total: wallet + lp + fees + pending, lpTokens: tokens, feeTok, owedUsd, lpEth, range }
}

// ---------- per-wallet accounting ----------
const walletData = {}
for (const w of WALLETS) {
  const L = ledger[w.key]
  const ev = L.events.filter((e) => e.block > openingBlock && e.block <= head)

  // Everything held at the opening block counts as money put in at the opening prices.
  const open = snaps[w.key][openingBlock], po = prices[openingBlock], ov = valueSnapshot(open, po)
  const flows = []
  const addOpening = (asset, raw) => { if (raw > 0n) flows.push({ block: openingBlock, ts: tsOfBlock(openingBlock), asset, amount: raw, usd: valueOf(asset, raw, po), kind: 'opening', hash: null, cp: null }) }
  for (const [asset, raw] of Object.entries(open.balances)) addOpening(asset, raw)
  for (const [asset, raw] of Object.entries(ov.lpTokens)) addOpening(asset, raw)
  for (const [asset, raw] of Object.entries(ov.feeTok)) addOpening(asset, raw)
  addOpening(AERO, open.positions.reduce((a, x) => a + x.pending, 0n) + open.deferred)

  const rewards = [], fees = [], gas = [], aeroOut = [], lpEvents = [], flagged = [], nftFlows = []
  for (const e of ev) {
    const p = prices[e.block]
    for (const g of e.legs) {
      if (isExternal(g.cls)) flows.push({ block: e.block, ts: e.ts, asset: g.asset, amount: g.amount, usd: valueOf(g.asset, g.amount, p), kind: g.cls, bridge: e.bridge, hash: e.hash, cp: g.cp })
      if (g.asset === AERO && g.amount < 0n) aeroOut.push({ block: e.block, amount: -g.amount, usd: valueOf(AERO, -g.amount, p), between: g.cls === 'between' })
    }
    for (const m of e.nftMoves) {
      const v = await positionValueAt(m.npm, m.tokenId, e.block, p)
      const sign = m.dir === 'in' ? 1n : -1n
      for (const [asset, raw] of [[v.token0, v.amount0], [v.token1, v.amount1]]) {
        flows.push({ block: e.block, ts: e.ts, asset, amount: sign * raw, usd: Number(sign) * valueOf(asset, raw, p), kind: m.cls, hash: e.hash, cp: m.cp, nft: m.tokenId })
      }
      nftFlows.push({ ...m, block: e.block, ts: e.ts, hash: e.hash, usd: v.usd })
    }
    for (const r of e.rewards) rewards.push({ block: e.block, ts: e.ts, hash: e.hash, tokenId: r.tokenId, amount: r.amount, recipient: r.recipient })
    for (const f of e.fees) {
      const pair = await pairOf(f.npm, f.tokenId, e.block)
      fees.push({ block: e.block, ts: e.ts, hash: e.hash, tokenId: f.tokenId, token0: pair.token0, token1: pair.token1, amount0: f.amount0, amount1: f.amount1 })
    }
    if (e.gas) gas.push({ block: e.block, wei: e.gas })
    for (const x of e.lp) {
      const pair = await pairOf(x.npm, x.tokenId, e.block)
      lpEvents.push({ ...x, ...pair, block: e.block, ts: e.ts, hash: e.hash, usd: valueOf(pair.token0, x.amount0, p) + valueOf(pair.token1, x.amount1, p) })
    }
  }

  // Check per block: moves inside the strategy should roughly net to zero once liquidity added or
  // removed, fees and rewards are taken out. A block that does not, or that holds a transfer the
  // rules could only guess at, is flagged for a person to look at.
  const byBlock = new Map()
  for (const e of ev) {
    const p = prices[e.block]
    const g = byBlock.get(e.block) ?? { net: 0, gross: 0, hashes: [], review: false }
    for (const leg of e.legs) if (leg.cls === 'internal') { const v = valueOf(leg.asset, leg.amount, p); g.net += v; g.gross += Math.abs(v) }
    for (const x of lpEvents.filter((y) => y.hash === e.hash)) g.net += x.type === 'increase' ? x.usd : -x.usd
    for (const f of fees.filter((y) => y.hash === e.hash)) g.net -= valueOf(f.token0, f.amount0, p) + valueOf(f.token1, f.amount1, p)
    g.hashes.push(e.hash)
    g.review ||= e.review
    byBlock.set(e.block, g)
  }
  for (const [b, g] of byBlock) if (g.review || Math.abs(g.net) > Math.max(25, 0.02 * g.gross)) flagged.push({ block: b, net: g.net, hashes: g.hashes })

  walletData[w.key] = { L, ev, flows, rewards, fees, gas, aeroOut, lpEvents, nftFlows, flagged, warnings: L.warnings.filter((x) => x.block > openingBlock && x.block <= head) }
}

// Cumulative figures for some wallets at block b. In a multi-wallet scope, transfers between
// those wallets are left out: they are neither money in nor a change of what is held.
function cumulative(keys, b) {
  const multi = keys.length > 1
  const upTo = (xs) => xs.filter((x) => x.block <= b)
  const flows = keys.flatMap((k) => upTo(walletData[k].flows)).filter((f) => !(multi && f.kind === 'between'))
  const invested = sum(flows, (f) => f.usd)
  // "Just held it": what came in stays in its own coin; what went out leaves at its value then.
  const hodlIn = {}
  let hodlOutUsd = 0
  for (const f of flows) {
    if (big(f.amount) > 0n) hodlIn[hodlKey(f.asset)] = (hodlIn[hodlKey(f.asset)] ?? 0n) + big(f.amount)
    else hodlOutUsd += f.usd
  }
  const claimed = keys.flatMap((k) => upTo(walletData[k].rewards)).reduce((a, r) => a + r.amount, 0n)
  const feeTok = {}
  for (const f of keys.flatMap((k) => upTo(walletData[k].fees))) {
    feeTok[f.token0] = (feeTok[f.token0] ?? 0n) + f.amount0
    feeTok[f.token1] = (feeTok[f.token1] ?? 0n) + f.amount1
  }
  const gasWei = keys.flatMap((k) => upTo(walletData[k].gas)).reduce((a, g) => a + g.wei, 0n)
  // AERO that left (sold, sent) and AERO brought in from outside, for the AERO price step.
  const aeroOutUsd = sum(keys.flatMap((k) => upTo(walletData[k].aeroOut)).filter((x) => !(multi && x.between)), (x) => x.usd)
  const aeroInUnits = flows.filter((f) => f.asset === AERO && big(f.amount) > 0n).reduce((a, f) => a + big(f.amount), 0n)
  return { invested, hodlIn, hodlOutUsd, claimed, feeTok, gasWei, aeroOutUsd, aeroInUnits }
}

function scopeAt(keys, b) {
  const p = prices[b]
  const vs = keys.map((k) => valueSnapshot(snaps[k][b], p))
  const c = cumulative(keys, b)
  const feeAccrued = { ...c.feeTok }
  for (const v of vs) for (const [t, a] of Object.entries(v.feeTok)) feeAccrued[t] = (feeAccrued[t] ?? 0n) + a
  let hodl = -c.hodlOutUsd
  for (const [k, a] of Object.entries(c.hodlIn)) hodl += k === 'ETH' ? units(a, 18) * p.eth : usdOf(k, a, p) ?? 0
  const pendingAero = sum(vs, (v) => v.pendingAero)
  const aeroHeld = units(keys.reduce((a, k) => a + (snaps[k][b].balances[AERO] ?? 0n), 0n), 18)
  return {
    b, p, c, feeAccrued, hodl, pendingAero, aeroHeld,
    value: sum(vs, (v) => v.total), lp: sum(vs, (v) => v.lp), wallet: sum(vs, (v) => v.wallet), pending: sum(vs, (v) => v.pending), feesNow: sum(vs, (v) => v.fees),
    owedUsd: sum(vs, (v) => v.owedUsd), lpEth: sum(vs, (v) => v.lpEth), range: vs.map((v) => v.range),
    aeroAccrued: units(c.claimed, 18) + pendingAero,
  }
}

// Time-weighted LP value over (startB, endB]: liquidity added or removed during the day only counts
// for the part of the day it was in the pool.
function lpTimeWeighted(key, startB, endB) {
  let lp = valueSnapshot(snaps[key][startB], prices[startB]).lp
  const changes = [
    ...walletData[key].lpEvents.filter((x) => x.block > startB && x.block <= endB).map((x) => ({ block: x.block, d: x.type === 'increase' ? x.usd : -x.usd })),
    ...walletData[key].nftFlows.filter((x) => x.block > startB && x.block <= endB).map((x) => ({ block: x.block, d: x.dir === 'in' ? x.usd : -x.usd })),
  ].sort((a, b) => a.block - b.block)
  let cursor = startB, area = 0
  for (const c of changes) { area += lp * (c.block - cursor); lp = Math.max(0, lp + c.d); cursor = c.block }
  area += lp * (endB - cursor)
  return endB > startB ? area / (endB - startB) : lp
}

// Money moved into (+) or out of (-) a wallet's LP bundle (positions, their uncollected fees and
// unclaimed AERO) during (a, b], at the prices of each event: liquidity added or removed, fees
// collected, rewards claimed, positions received or sent.
function lpNetFlow(key, a, b) {
  const D = walletData[key], inR = (x) => x.block > a && x.block <= b
  let net = 0
  for (const x of D.lpEvents.filter(inR)) net += x.type === 'increase' ? x.usd : -x.usd
  for (const f of D.fees.filter(inR)) net -= valueOf(f.token0, f.amount0, prices[f.block]) + valueOf(f.token1, f.amount1, prices[f.block])
  for (const r of D.rewards.filter(inR)) net -= units(r.amount, 18) * (prices[r.block].aero ?? 0)
  for (const m of D.nftFlows.filter(inR)) net += m.dir === 'in' ? m.usd : -m.usd
  return net
}

// Value of some wallets' current holdings as a function of the ETH price, with AERO and every
// other token held at today's price. Concentrated positions follow their real curve: as ETH falls
// they turn into ETH, below the range entirely. Used for the ETH cost and break-even prices.
function ethCurve(keys) {
  let fixedUsd = 0, ethUnits = 0
  const curves = []
  for (const k of keys) {
    const s = snaps[k][head]
    for (const [asset, raw] of Object.entries(s.balances)) {
      if (hodlKey(asset) === 'ETH') ethUnits += units(raw, 18)
      else fixedUsd += valueOf(asset, raw, pNowCurve)
    }
    fixedUsd += units(s.positions.reduce((a, x) => a + x.pending, 0n) + s.deferred, 18) * (pNowCurve.aero ?? 0)
    for (const x of s.positions) {
      const extra0 = x.fees0, extra1 = x.fees1 // owed principal plus fees, both paid by collect()
      if (x.token0 === WETH && x.token1 === TOKEN_USDC) {
        // Only live positions follow a curve and set the lowest bound: one whose liquidity was all
        // removed but not burned holds nothing, and must not keep the scope looking "in a range".
        if (x.liquidity > 0n) curves.push({ key: k, L: Number(x.liquidity), sa: Math.sqrt(1.0001 ** x.tickLower), sb: Math.sqrt(1.0001 ** x.tickUpper), low: priceAtTick(x.tickLower, 18, 6), high: priceAtTick(x.tickUpper, 18, 6), pool: priceFromSqrt(x.sqrtP, 18, 6), inRange: x.inRange, address: x.pool, tickLower: x.tickLower, tickUpper: x.tickUpper })
        ethUnits += units(extra0, 18); fixedUsd += units(extra1, 6)
      } else {
        fixedUsd += valueOf(x.token0, x.amount0 + extra0, pNowCurve) + valueOf(x.token1, x.amount1 + extra1, pNowCurve)
      }
    }
  }
  const amounts = (c, P) => {
    const r = Math.sqrt(P * 1e-12)
    if (r <= c.sa) return [c.L * (1 / c.sa - 1 / c.sb) / 1e18, 0]
    if (r < c.sb) return [c.L * (1 / r - 1 / c.sb) / 1e18, c.L * (r - c.sa) / 1e6]
    return [0, c.L * (c.sb - c.sa) / 1e6]
  }
  const value = (P) => fixedUsd + ethUnits * P + curves.reduce((a, c) => { const [e, u] = amounts(c, P); return a + e * P + u }, 0)
  const ethAt = (P) => ethUnits + curves.reduce((a, c) => a + amounts(c, P)[0], 0)
  // ETH price at which the holdings are worth `target`; 0 when any ETH price already gets there (as the
  // withdraw-and-hold prices), null when no ETH price does.
  const solve = (target) => {
    let lo = 1, hi = 1e7
    if (value(lo) >= target) return 0
    if (value(hi) < target) return null
    for (let i = 0; i < 200; i++) { const mid = Math.sqrt(lo * hi); if (value(mid) < target) lo = mid; else hi = mid }
    return hi
  }
  return { value, ethAt, solve, amounts, ethUnits, fixedUsd, curves, lowest: curves.length ? Math.min(...curves.map((c) => c.low)) : null }
}

// ---------- datasets ----------
const SCOPES = [...WALLETS.map((w) => ({ key: w.key, label: w.label, wallets: [w.key] })), { key: 'total', label: '合计', wallets: WALLETS.map((w) => w.key) }]
const firstFlowDay = Object.fromEntries(WALLETS.map((w) => {
  const f = walletData[w.key].flows.find((x) => x.kind !== 'opening')
  return [w.key, f ? cstDay(f.ts) : null]
}))

// Daily rows per wallet, rounded; the combined rows add up the rounded wallet rows so every view agrees.
const walletRows = {}
for (const w of WALLETS) {
  walletRows[w.key] = []
  let prev = scopeAt([w.key], openingBlock), cum = 0, prevPnl = null
  for (const d of days) {
    const b = dayBlock(d)
    const cur = scopeAt([w.key], b)
    // A wallet's rows start once it holds real money (more than dust) or money arrives.
    const started = prev.value > 10 || (firstFlowDay[w.key] && firstFlowDay[w.key] <= d)
    const earnAero = cur.aeroAccrued - prev.aeroAccrued
    let feeUsd = 0
    for (const t of new Set([...Object.keys(cur.feeAccrued), ...Object.keys(prev.feeAccrued)])) feeUsd += usdOf(t, (cur.feeAccrued[t] ?? 0n) - (prev.feeAccrued[t] ?? 0n), cur.p) ?? 0
    const earnAeroUsd = earnAero * (cur.p.aero ?? 0)
    cum += earnAeroUsd + feeUsd
    if (started) {
      const value = r2(cur.value), invested = r2(cur.c.invested), hodl = r2(cur.hodl)
      const pnl = r2(value - invested), earn = r2(r2(earnAeroUsd) + r2(feeUsd))
      prevPnl ??= 0 // the first reported day carries everything before it, so the days add up to the total
      // The day's result: change in cumulative P&L, and the LP bundle's own result (its value change
      // after taking out what was added or removed); both include the day's interest.
      const pnlDay = r2(pnl - prevPnl)
      // Principal removed but not yet collected counts as gone from the pool, as lpNetFlow books it.
      const bundle = (x) => x.lp - x.owedUsd + x.feesNow + x.pending
      const lpDay = r2(bundle(cur) - bundle(prev) - lpNetFlow(w.key, prev.b, b))
      prevPnl = pnl
      walletRows[w.key].push({
        day: d, scope: w.key, scope_label: w.label, partial: d === today,
        earn_aero: r6(earnAero), earn_aero_usd: r2(earnAeroUsd), earn_fee_usd: r2(feeUsd), earn_usd: r2(r2(earnAeroUsd) + r2(feeUsd)), earn_cum_usd: r2(cum),
        value_usd: value, invested_usd: invested, pnl_usd: r2(value - invested), hodl_usd: hodl, vs_hodl_usd: r2(value - hodl),
        lp_usd: r2(cur.lp), lp_tw_usd: r2(lpTimeWeighted(w.key, prev.b, b)), wallet_usd: r2(cur.wallet),
        pnl_day_usd: pnlDay, price_day_usd: r2(pnlDay - earn), lp_pnl_day_usd: lpDay, lp_price_day_usd: r2(lpDay - earn), idle_day_usd: r2(pnlDay - lpDay),
        range_status: cur.range[0], lp_eth: r6(cur.lpEth),
        eth_usd: r2(cur.p.eth), aero_usd: cur.p.aero == null ? null : r6(cur.p.aero), block: b,
      })
    }
    prev = cur
  }
}
const daily = WALLETS.flatMap((w) => walletRows[w.key])
const MONEY = ['earn_aero_usd', 'earn_fee_usd', 'earn_usd', 'earn_cum_usd', 'value_usd', 'invested_usd', 'hodl_usd', 'lp_usd', 'lp_tw_usd', 'wallet_usd', 'pnl_day_usd', 'price_day_usd', 'lp_pnl_day_usd', 'lp_price_day_usd', 'idle_day_usd']
const combineRange = (xs) => { const live = xs.filter((x) => x !== 'none'); return !live.length ? 'none' : live.every((x) => x === 'in') ? 'in' : live.every((x) => x === 'out') ? 'out' : 'part' }
for (const d of days) {
  const rows = WALLETS.map((w) => walletRows[w.key].find((r) => r.day === d)).filter(Boolean)
  if (!rows.length) continue
  const t = { day: d, scope: 'total', scope_label: '合计', partial: d === today, earn_aero: r6(sum(rows, (r) => r.earn_aero)) }
  for (const f of MONEY) t[f] = r2(sum(rows, (r) => r[f]))
  // Holding transfers between the wallets is not a change of what the two hold together.
  t.hodl_usd = r2(scopeAt(WALLETS.map((w) => w.key), rows[0].block).hodl)
  t.pnl_usd = r2(t.value_usd - t.invested_usd)
  t.vs_hodl_usd = r2(t.value_usd - t.hodl_usd)
  t.eth_usd = rows[0].eth_usd; t.aero_usd = rows[0].aero_usd; t.block = rows[0].block
  t.range_status = combineRange(rows.map((r) => r.range_status)); t.lp_eth = r6(sum(rows, (r) => r.lp_eth))
  daily.push(t)
}

// The ETH prices the owners decide sales by. Two cases:
//  - after a fall below every range, liquidity withdrawn and the ETH held (their plan): a fixed amount
//    of ETH plus everything else, so price = (target - everything else) / ETH;
//  - liquidity left in the pool: the holdings follow the positions' curve back up, so the price is
//    solved on that curve (as ETH recovers, the pool sells ETH again).
// Targets: money put in plus the interest earned (cost price), or just the money put in (break-even).
// With no position left (already withdrawn) the first case is simply the wallet as it is.
// The same prices for withdrawing now, at today's ETH price, and the curve itself so the page can
// work them out for any withdrawal price.
function ethPrices(keys, invested, interest, value) {
  const c = ethCurve(keys)
  const now = pNow.eth
  if (Math.abs(c.value(now) - value) > 1) log(`ETH curve check off by ${(c.value(now) - value).toFixed(2)} USD`)
  const p0 = c.lowest != null ? Math.min(c.lowest * 0.999, now) : now
  const eth = c.ethAt(p0), rest = c.value(p0) - eth * p0
  // 0: what is held besides ETH already covers it; null: too little ETH for a price to mean anything.
  const price = (target) => (target <= rest ? 0 : eth < 0.05 ? null : r2((target - rest) / eth))
  const gap = (x) => (x == null ? null : r6(x / now - 1))
  const cost = price(invested + interest), even = price(invested)
  const holdCost = c.lowest != null ? c.solve(invested + interest) : null, holdEven = c.lowest != null ? c.solve(invested) : null
  // Each live position's side, from its own pool: the page draws the ranges and the withdrawal from
  // the pool prices, so the state must agree with them rather than with the reference price.
  const sides = c.curves.map((x) => (x.inRange ? 'in' : x.pool < (x.low + x.high) / 2 ? 'below' : 'above'))
  const wallEth = keys.reduce((a, k) => a + units((snaps[k][head].balances.ETH ?? 0n) + (snaps[k][head].balances[WETH] ?? 0n), 18), 0)
  const highest = Math.max(...keys.flatMap((k) => snaps[k][head].positions.filter((x) => x.liquidity > 0n).map((x) => priceAtTick(x.tickUpper, 18, 6))), -Infinity)
  // Withdrawing now pays each position out at its own pool's price, which can differ a little from
  // the reference price the rest is valued at.
  const [ethNow, restNow] = c.curves.reduce(([e, u], x) => { const [a, b] = c.amounts(x, x.pool); return [e + a, u + b] }, [c.ethUnits, c.fixedUsd])
  const priceNow = (target) => (target <= restNow ? 0 : ethNow < 0.05 ? null : r2((target - restNow) / ethNow))
  const label = (k) => WALLETS.find((w) => w.key === k)?.label ?? k
  return {
    // 'gap': every position is out of its own range, some below and some above.
    range_state: !sides.length ? 'none' : sides.every((x) => x === 'in') ? 'in' : sides.some((x) => x === 'in') ? 'part' : sides.every((x) => x === 'below') ? 'below' : sides.every((x) => x === 'above') ? 'above' : 'gap',
    cost_eth_price: cost, cost_gap_pct: gap(cost || null),
    breakeven_eth_price: even, breakeven_gap_pct: gap(even || null),
    hold_cost_eth_price: holdCost == null ? null : r2(holdCost), hold_cost_gap_pct: gap(holdCost || null),
    hold_breakeven_eth_price: holdEven == null ? null : r2(holdEven), hold_breakeven_gap_pct: gap(holdEven || null),
    eth_units_now: r6(ethNow), eth_units_below: r6(eth), eth_units_wallet: r6(wallEth), eth_units_positions_below: r6(Math.max(0, eth - wallEth)),
    range_low_min: c.lowest == null ? null : r2(c.lowest), range_high_max: Number.isFinite(highest) ? r2(highest) : null,
    rest_usd: r2(rest),
    now_cost_eth_price: priceNow(invested + interest), now_breakeven_eth_price: priceNow(invested), rest_now_usd: r2(restNow),
    curve: {
      eth: c.ethUnits, usd: c.fixedUsd,
      positions: [...c.curves].sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key) || a.low - b.low).map((x) => ({ wallet: label(x.key), low: r2(x.low), high: r2(x.high), pool: r6(x.pool), in_range: x.inRange, pool_address: x.address, tick_lower: x.tickLower, tick_upper: x.tickUpper, L: x.L, sa: x.sa, sb: x.sb })),
    },
  }
}

// Summary and attribution. Money figures come from the rounded daily rows, so the cards, the
// charts, the tables and the breakdown all show the same numbers.
const pNow = prices[head]
const summary = [], attribution = []
for (const sc of SCOPES) {
  const rows = daily.filter((r) => r.scope === sc.key)
  const n = scopeAt(sc.wallets, head)
  const last = rows.at(-1), prevRow = rows.at(-2)
  const finished = rows.filter((r) => !r.partial).slice(-7)
  const twLp = sum(finished, (r) => r.lp_tw_usd), earnN = sum(finished, (r) => r.earn_usd)
  const value = last?.value_usd ?? r2(n.value), invested = last?.invested_usd ?? r2(n.c.invested), hodl = last?.hodl_usd ?? r2(n.hodl)
  const rewards = r2(sum(rows, (r) => r.earn_aero_usd)), fees = r2(sum(rows, (r) => r.earn_fee_usd))
  const gasEth = units(n.c.gasWei, 18), gasUsd = r2(gasEth * pNow.eth)
  const pnl = r2(value - invested)
  summary.push({
    scope: sc.key, scope_label: sc.label,
    as_of: new Date(tsOfBlock(head) * 1000).toISOString(), as_of_cst: cstTime(tsOfBlock(head)), as_of_block: head,
    start_day: rows[0]?.day ?? null,
    invested_usd: invested, value_usd: value, pnl_usd: pnl, pnl_pct: invested ? r6(pnl / invested) : null,
    hodl_usd: hodl, vs_hodl_usd: r2(value - hodl),
    earn_total_usd: r2(rewards + fees), rewards_usd: rewards, fees_usd: fees,
    aero_earned: r6(n.aeroAccrued), aero_claimed: r6(units(n.c.claimed, 18)), aero_pending: r6(n.pendingAero), aero_held: r6(n.aeroHeld),
    today_usd: last?.partial ? last.earn_usd : null, yesterday_usd: (last?.partial ? prevRow : last)?.earn_usd ?? null,
    apr_days: finished.length, earn_7d_usd: r2(earnN), apr_7d: twLp > 0 ? r6((earnN / twLp) * 365) : null,
    lp_usd: last?.lp_usd ?? r2(n.lp), wallet_usd: last?.wallet_usd ?? r2(n.wallet), pending_usd: r2(n.pending), fees_unclaimed_usd: r2(n.feesNow),
    gas_eth: r6(gasEth), gas_usd: gasUsd, eth_usd: r2(pNow.eth), aero_usd: pNow.aero == null ? null : r6(pNow.aero),
    eth_ref_pool: PRICE.ethPool, // the page reads it live; a public pool, not a wallet
    flagged: sum(sc.wallets, (k) => walletData[k].flagged.length + walletData[k].warnings.length),
    ...ethPrices(sc.wallets, invested, r2(rewards + fees), value),
  })
  // From money put in to value now. The AERO step is what the earned AERO is worth now (held or
  // unclaimed at today's price, sold or sent at the price then) minus what it was worth when earned.
  const aeroNow = (n.aeroHeld + n.pendingAero - units(n.c.aeroInUnits, 18)) * (pNow.aero ?? 0) + n.c.aeroOutUsd
  const steps = { market: r2(hodl - invested), rewards, fees, aero_drift: r2(aeroNow - rewards), gas: -gasUsd }
  steps.residual = r2(pnl - sum(Object.values(steps)))
  const order = [['invested', '净投入', invested], ['market', '带入资产涨跌', steps.market], ['rewards', 'AERO 奖励', steps.rewards], ['fees', '交易手续费', steps.fees],
    ['aero_drift', 'AERO 价格变动', steps.aero_drift], ['gas', 'Gas', steps.gas], ['residual', '无常损失与调仓', steps.residual], ['value', '现值', value]]
  order.forEach(([step, label, usd], i) => attribution.push({ scope: sc.key, step, label, usd: r2(usd), order: i + 1 }))
}

// What a WETH/USDC position turns into outside its range, and what was put into it: below the
// range it is all ETH, so its cost price is the money put in divided by that ETH.
function positionCost(key, x) {
  const D = walletData[key]
  const mine = (y) => y.npm === x.npm && y.tokenId === x.tokenId
  const cost = sum(D.lpEvents.filter(mine), (y) => (y.type === 'increase' ? y.usd : -y.usd)) + sum(D.nftFlows.filter(mine), (m) => (m.dir === 'in' ? m.usd : -m.usd))
  if (!(x.token0 === WETH && x.token1 === TOKEN_USDC)) return { cost_usd: r2(cost), eth_if_below: null, usdc_if_above: null, cost_price: null }
  const L = Number(x.liquidity), sa = Math.sqrt(1.0001 ** x.tickLower), sb = Math.sqrt(1.0001 ** x.tickUpper)
  const eth = L * (1 / sa - 1 / sb) / 1e18 + units(x.fees0, 18), usdc = L * (sb - sa) / 1e6 + units(x.fees1, 6)
  return { cost_usd: r2(cost), eth_if_below: r6(eth), usdc_if_above: r2(usdc), cost_price: eth > 0 ? r2(cost / eth) : null }
}

// Current positions and holdings.
const positions = [], holdings = []
for (const w of WALLETS) {
  const s = snaps[w.key][head]
  for (const x of s.positions) {
    const d0 = decOf(x.token0), d1 = decOf(x.token1)
    const owed = owedPrincipal(ledger.owedAt, x.npm, x.tokenId, head)
    const o0 = owed.owed0 < x.fees0 ? owed.owed0 : x.fees0, o1 = owed.owed1 < x.fees1 ? owed.owed1 : x.fees1
    const a0 = x.amount0 + o0, a1 = x.amount1 + o1
    const pending = units(x.pending, 18)
    positions.push({
      scope: w.key, scope_label: w.label, position: `#${x.tokenId}`, token_id: x.tokenId,
      pool_label: `${symOf(x.token0)}/${symOf(x.token1)} · CL${x.tickSpacing}`, venue: NPMS[x.npm]?.label ?? x.npm,
      status: x.staked ? '质押中' : '未质押', in_range: x.inRange,
      range_low: r2(priceAtTick(x.tickLower, d0, d1)), range_high: r2(priceAtTick(x.tickUpper, d0, d1)), price: r2(priceFromSqrt(x.sqrtP, d0, d1)),
      amount0: r6(units(a0, d0)), symbol0: symOf(x.token0), amount1: r6(units(a1, d1)), symbol1: symOf(x.token1),
      value_usd: r2(valueOf(x.token0, a0, pNow) + valueOf(x.token1, a1, pNow)),
      pending_aero: r6(pending), pending_usd: r2(pending * (pNow.aero ?? 0)),
      fees_usd: r2(valueOf(x.token0, x.fees0 - o0, pNow) + valueOf(x.token1, x.fees1 - o1, pNow)),
      ...positionCost(w.key, x),
    })
  }
  for (const [asset, raw] of Object.entries(s.balances)) {
    if (raw === 0n) continue
    holdings.push({ scope: w.key, scope_label: w.label, place: '钱包', asset: symOf(asset), amount: r6(units(raw, decOf(asset))), value_usd: r2(valueOf(asset, raw, pNow)) })
  }
  const v = valueSnapshot(s, pNow)
  const lp = {}
  for (const [t, a] of Object.entries(v.lpTokens)) lp[t] = (lp[t] ?? 0n) + a
  for (const [t, a] of Object.entries(v.feeTok)) lp[t] = (lp[t] ?? 0n) + a
  for (const [asset, raw] of Object.entries(lp)) if (raw > 0n) holdings.push({ scope: w.key, scope_label: w.label, place: 'LP 仓位', asset: symOf(asset), amount: r6(units(raw, decOf(asset))), value_usd: r2(valueOf(asset, raw, pNow)) })
  if (v.pendingAero > 0) holdings.push({ scope: w.key, scope_label: w.label, place: '待领奖励', asset: 'AERO', amount: r6(v.pendingAero), value_usd: r2(v.pending) })
}

// The ledger as people read it: money in and out, LP moves, rewards, fees, swaps, and anything to check.
const events = []
for (const w of WALLETS) {
  const D = walletData[w.key]
  const flaggedHashes = new Set(D.flagged.flatMap((f) => f.hashes))
  const seenMint = new Set()
  for (const e of D.ev) {
    const p = prices[e.block]
    const base = { scope: w.key, scope_label: w.label, time_cst: cstTime(e.ts), day: cstDay(e.ts), block: e.block, tx: e.hash, flagged: flaggedHashes.has(e.hash) }
    const cpLabel = (g) => (g.cls === 'bridge' ? `${e.bridge} 跨链` : g.cls === 'between' ? (g.amount > 0n ? '来自另一钱包' : '转给另一钱包') : LABELS[g.cp] ?? STRATEGY[g.cp] ?? BRIDGES[g.cp] ?? short(g.cp))
    for (const g of e.legs.filter((x) => isExternal(x.cls))) {
      events.push({ ...base, kind: g.amount > 0n ? '资金转入' : '资金转出', detail: `${cpLabel(g)} · ${r6(Math.abs(units(g.amount, decOf(g.asset))))} ${symOf(g.asset)}${g.review ? '（规则无法确定，暂按资金进出计）' : ''}`, usd: r2(valueOf(g.asset, g.amount, p)) })
    }
    for (const m of D.nftFlows.filter((x) => x.hash === e.hash)) {
      events.push({ ...base, kind: m.dir === 'in' ? '仓位转入' : '仓位转出', detail: `#${m.tokenId} · ${m.cls === 'between' ? (m.dir === 'in' ? '来自另一钱包' : '转给另一钱包') : short(m.cp)}`, usd: r2(m.dir === 'in' ? m.usd : -m.usd) })
    }
    for (const x of D.lpEvents.filter((y) => y.hash === e.hash)) {
      const k = `${x.npm}:${x.tokenId}`
      const kind = x.type === 'decrease' ? '撤出流动性' : seenMint.has(k) ? '加仓' : '开仓'
      if (x.type === 'increase') seenMint.add(k)
      events.push({ ...base, kind, detail: `#${x.tokenId} · ${r6(units(x.amount0, decOf(x.token0)))} ${symOf(x.token0)} + ${r2(units(x.amount1, decOf(x.token1)))} ${symOf(x.token1)}`, usd: r2(x.usd) })
    }
    const claimed = e.rewards.reduce((a, r) => a + r.amount, 0n)
    if (claimed > 0n) events.push({ ...base, kind: '领取奖励', detail: `${r6(units(claimed, 18))} AERO${e.rewards.some((r) => r.recipient !== w.address) ? '（领给了别的地址）' : ''}`, usd: r2(valueOf(AERO, claimed, p)) })
    for (const f of D.fees.filter((y) => y.hash === e.hash)) {
      events.push({ ...base, kind: '收取手续费', detail: `#${f.tokenId} · ${r6(units(f.amount0, decOf(f.token0)))} ${symOf(f.token0)} + ${r6(units(f.amount1, decOf(f.token1)))} ${symOf(f.token1)}`, usd: r2(valueOf(f.token0, f.amount0, p) + valueOf(f.token1, f.amount1, p)) })
    }
    // Swaps: internal legs of a transaction with no liquidity change, netted per asset.
    if (!e.lp.length && !e.fees.length && !e.rewards.length) {
      const net = {}
      for (const g of e.legs.filter((x) => x.cls === 'internal')) net[g.asset] = (net[g.asset] ?? 0n) + g.amount
      const outs = Object.entries(net).filter(([, a]) => a < 0n), ins = Object.entries(net).filter(([, a]) => a > 0n)
      if (outs.length || ins.length) {
        const fmt = ([a, x]) => `${r6(Math.abs(units(x, decOf(a))))} ${symOf(a)}`
        const detail = outs.length && ins.length ? `${outs.map(fmt).join(' + ')} → ${ins.map(fmt).join(' + ')}` : outs.length ? `付出 ${outs.map(fmt).join(' + ')}（成交在另一笔交易）` : `收到 ${ins.map(fmt).join(' + ')}（挂单成交）`
        const usd = outs.length ? sum(outs, ([x, r]) => -valueOf(x, r, p)) : sum(ins, ([x, r]) => valueOf(x, r, p))
        const wrap = outs.length > 0 && ins.length > 0 && Object.keys(net).every((a) => a === 'ETH' || a === WETH)
        events.push({ ...base, kind: wrap ? '包装 ETH' : '兑换', detail, usd: r2(Math.abs(usd)) })
      }
    }
  }
  for (const x of D.warnings) events.push({ scope: w.key, scope_label: w.label, time_cst: cstTime(tsOfBlock(x.block)), day: cstDay(tsOfBlock(x.block)), block: x.block, tx: x.hash, kind: '待确认', detail: x.text, usd: null, flagged: true })
}
events.sort((a, b) => b.block - a.block || a.scope.localeCompare(b.scope))
events.forEach((r, i) => { r.id = events.length - i })

fs.mkdirSync(OUT, { recursive: true })
writeJson(path.join(OUT, 'summary.json'), summary)
writeJson(path.join(OUT, 'daily.json'), daily)
writeJson(path.join(OUT, 'attribution.json'), attribution)
writeJson(path.join(OUT, 'positions.json'), positions)
writeJson(path.join(OUT, 'holdings.json'), holdings)
writeJson(path.join(OUT, 'events.json'), events)
writeJson(path.join(OUT, 'flows.json'), WALLETS.flatMap((w) => walletData[w.key].flows.map((f) => ({ scope: w.key, ...f, amount: units(f.amount, decOf(f.asset)), asset: symOf(f.asset) }))))
// Only counts are printed: the hourly job's logs are public.
log(`wrote out/ as of block ${head} (${cstTime(tsOfBlock(head))} CST): ${daily.length} daily rows, ${events.length} ledger rows, ${summary.find((s) => s.scope === 'total')?.flagged ?? 0} to check`)
