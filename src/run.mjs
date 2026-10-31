// Scans the tracked wallets up to the safe head of every tracked chain (lib/config.mjs CHAINS), values
// them at the end of every Beijing day, and writes the dashboard's datasets to out/. Run through
// src/update.mjs, which keeps addresses out of logs. Base is the main chain: its blocks are the timeline
// every chain's events and snapshots are placed on, and its pools price everything.
import fs from 'node:fs'
import path from 'node:path'
import { client, clientOf, pmap } from '../lib/rpc.mjs'
import { scan } from '../lib/scan.mjs'
import { buildLedger, isExternal, owedPrincipal, positionsAt, gaugesAt } from '../lib/ledger.mjs'
import { escrowByAsset } from '../lib/orders.mjs'
import { matchCrossChain } from '../lib/crosschain.mjs'
import { usdCurve, amountsAtUsd } from '../lib/curve.mjs'
import { hodlHeld } from '../lib/hodl.mjs'
import { snapshot } from '../lib/snapshot.mjs'
import { pricesAt, usdOf, savePrices } from '../lib/prices.mjs'
import { npmAbi, clPoolAbi, factoryAbi, erc20Abi, gaugeAbi, TOPIC } from '../lib/abi.mjs'
import { tryRead } from '../lib/errors.mjs'
import { WALLETS, START_DAY, TOKENS, ALL_TOKENS, CHAINS, WETH, ZERO, LABELS, GAUGE_IMPLS, OVERRIDES_FILE, PRICE } from '../lib/config.mjs'
import { daysBetween, cstDay, cstDayStartTs, prevDay, createTimeline } from '../lib/time.mjs'
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
const decOf = (asset) => (asset === 'ETH' ? 18 : ALL_TOKENS[asset]?.decimals ?? 18)
const symOf = (asset) => (asset === 'ETH' ? 'ETH' : ALL_TOKENS[asset]?.symbol ?? asset.slice(0, 8))
// The coin an asset counts as on every chain: ETH and WETH are the same exposure, and another chain's
// dollar token or xAERO counts as Base's (lib/config.mjs canon), for valuation, for "what if we had
// just held it" and for transfers between the chains.
const hodlKey = (asset) => (asset === 'ETH' || asset === WETH ? 'ETH' : ALL_TOKENS[asset]?.canon ?? asset)
const isAero = (asset) => ALL_TOKENS[asset]?.price === 'aero'
// ETH-like and six-decimal dollar tokens: the pairs whose positions follow the ETH curve.
const ethLike = (a) => ALL_TOKENS[a]?.price === 'eth' && ALL_TOKENS[a].decimals === 18
const usdLike = (a) => ALL_TOKENS[a]?.price === 'usd' && ALL_TOKENS[a].decimals === 6
const curveOf = (x) => usdCurve(x, { eth: ethLike, usd: usdLike })
const chainOf = (key) => CHAINS[key ?? 'base']
const valueOf = (asset, raw, prices) => (asset === 'ETH' ? units(raw, 18) * prices.eth : usdOf(asset, raw, prices) ?? 0)
const r2 = (x) => Math.round(x * 100) / 100
const r6 = (x) => Math.round(x * 1e6) / 1e6
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + f(x), 0)
const cstTime = (ts) => new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' ')
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`

// A cache file that cannot be read is started over (its contents are read again from the chain).
function readJson(p, fallback) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback } catch { log(`${path.basename(p)} unreadable, starting it over`); return fallback } }
// Written whole or not at all, so a run stopped halfway never leaves half a file behind.
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p + '.tmp', JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 1) + '\n')
  fs.renameSync(p + '.tmp', p)
}

// Snapshots of finished days never change, so they are cached; BigInts round-trip through strings.
const BIG_FIELDS = ['liquidity', 'amount0', 'amount1', 'pending', 'fees0', 'fees1', 'sqrtP']
function reviveSnap(s) {
  s.balances = Object.fromEntries(Object.entries(s.balances).map(([k, v]) => [k, BigInt(v)]))
  s.deferred = BigInt(s.deferred)
  for (const p of s.positions) for (const f of BIG_FIELDS) p[f] = BigInt(p[f])
  return s
}

// ---------- scan and classify ----------
const baseHead = Number((await client.getBlock({ blockTag: 'safe' })).number)
const state = await scan({ head: baseHead })
// Block times from the chain (lib/time.mjs): exact across a change of block time.
const timeline = await createTimeline(client, baseHead, path.join('data', 'cache', 'timeline.json'))
await timeline.ensure(Object.values(state.txs).map((t) => t.block))
const tsOfBlock = timeline.tsOf
// Every transaction takes its block's real time, whatever the cache recorded (a release before the
// fix kept computing 2-second times).
for (const t of Object.values(state.txs)) t.ts = tsOfBlock(t.block)
log(`scanned to ${state.scannedTo}, ${Object.keys(state.txs).length} transactions`)

// The other chains, each to its own safe head. Everything is valued at one moment on every chain, so
// Base's head is held back to the earliest of their heads.
const ext = {} // chain key -> { chain, client, state, timeline, head, headTs }
for (const c of Object.values(CHAINS).filter((x) => x.key !== 'base')) {
  // A chain starting before the first reported day would bring in holdings no day accounts for.
  if (c.startTs < cstDayStartTs(START_DAY)) throw new Error(`${c.key}: its start (chains.${c.key}.startTs) is before ${START_DAY} 00:00 Beijing; set chains.${c.key}.scanFromBlock and startTs at or after it`)
  const cl = clientOf(c)
  const h = Number((await cl.getBlock({ blockTag: c.safeTag })).number)
  const st = await scan({ head: h, chain: c })
  const tl = await createTimeline(cl, h, path.resolve(c.files.timeline), { formula: c.formulaTs })
  await tl.ensure([c.scanFromBlock, ...Object.values(st.txs).map((t) => t.block)])
  for (const t of Object.values(st.txs)) t.ts = tl.tsOf(t.block)
  ext[c.key] = { chain: c, client: cl, state: st, timeline: tl, head: h, headTs: tl.tsOf(h) }
  log(`${c.key}: scanned to ${st.scannedTo}, ${Object.keys(st.txs).length} transactions`)
}
let head = baseHead
for (const x of Object.values(ext)) head = Math.min(head, await timeline.blockBefore(x.headTs + 1))
// Hand corrections are read strictly: a mistake in the file stops the run rather than drop them all.
const overrides = fs.existsSync(path.resolve(OVERRIDES_FILE)) ? JSON.parse(fs.readFileSync(path.resolve(OVERRIDES_FILE), 'utf8')) : {}

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
const ledger = buildLedger(state, (a, b) => codeCache[`${a}@${b}`] ?? 'contract', { gaugeOk, overrides })
log(`checked ${asked.size} counterparties, ${gaugeCands.size} gauge candidates`)

// The same on every other chain, its code lookups kept apart by chain.
const extLedger = {}
async function knownGauges(x, addresses) {
  const c = x.chain
  await pmap([...addresses].filter((a) => !(`gauge:${c.key}:${a}` in codeCache)), 4, async (a) => {
    const code = (await x.client.getCode({ address: a })) ?? '0x'
    const impl = code.length === 92 && code.startsWith('0x363d3d373d3d3d363d73') ? '0x' + code.slice(22, 62) : null
    codeCache[`gauge:${c.key}:${a}`] = Boolean(impl && c.gaugeImpls[impl])
  })
}
// The positions the wallets already held on a chain when its tracking starts, in the wallet or staked in
// a gauge: the ledger only learns of positions from transactions, and a staked position may only be
// claimed from afterwards. Read once at the start block (every pool's gauge of each position manager's
// factory) and kept in data/cache/seed-<chain>.json.
async function startPositions(x) {
  const c = x.chain, cl = x.client, blockNumber = BigInt(c.scanFromBlock), out = []
  for (const [npm, n] of Object.entries(c.npms)) {
    for (const w of WALLETS) {
      // Nothing to seed before the position manager existed (a start before Aero launched on the chain).
      const held = (await tryRead(cl.readContract({ address: npm, abi: npmAbi, functionName: 'balanceOf', args: [w.address], blockNumber }))) ?? 0n
      for (let i = 0n; i < held; i++) out.push({ wallet: w.address, npm, tokenId: (await cl.readContract({ address: npm, abi: npmAbi, functionName: 'tokenOfOwnerByIndex', args: [w.address, i], blockNumber })).toString() })
    }
    const count = Number((await tryRead(cl.readContract({ address: n.factory, abi: factoryAbi, functionName: 'allPoolsLength', blockNumber }))) ?? 0n)
    const pools = await pmap([...Array(count).keys()], 4, (i) => cl.readContract({ address: n.factory, abi: factoryAbi, functionName: 'allPools', args: [BigInt(i)], blockNumber }))
    const gauges = [...new Set((await pmap(pools, 4, (p) => tryRead(cl.readContract({ address: p, abi: clPoolAbi, functionName: 'gauge', blockNumber })))).filter((g) => g && lc(g) !== ZERO).map(lc))]
    await knownGauges(x, gauges)
    for (const g of gauges.filter((a) => codeCache[`gauge:${c.key}:${a}`] === true)) {
      for (const w of WALLETS) {
        const ids = (await tryRead(cl.readContract({ address: g, abi: gaugeAbi, functionName: 'stakedValues', args: [w.address], blockNumber }))) ?? []
        for (const id of ids) out.push({ wallet: w.address, npm, tokenId: id.toString(), gauge: g })
      }
    }
  }
  return out
}
for (const x of Object.values(ext)) {
  const c = x.chain, txs = Object.values(x.state.txs)
  const seedFile = path.resolve('data', 'cache', `seed-${c.key}.json`)
  let seeds = readJson(seedFile, null)
  const who = WALLETS.map((w) => w.address).sort().join(',')
  if (seeds?.block !== c.scanFromBlock || seeds?.wallets !== who) { seeds = { block: c.scanFromBlock, wallets: who, positions: await startPositions(x) }; writeJson(seedFile, seeds) }
  const seed = seeds.positions
  const cands = new Set([...txs.flatMap((r) => r.logs.filter((l) => gaugeTopics.has(l.topics[0])).map((l) => l.address)), ...seed.filter((p) => p.gauge).map((p) => p.gauge)])
  await knownGauges(x, cands)
  const ok = (a) => codeCache[`gauge:${c.key}:${a}`] === true
  const ask = new Map()
  buildLedger(x.state, (a, b) => { ask.set(`${c.key}:${a}@${b}`, [a, b]); return 'contract' }, { gaugeOk: ok, overrides, chain: c, seed })
  await pmap([...ask].filter(([k]) => !(k in codeCache)), 6, async ([k, [a, b]]) => {
    const code = await x.client.getCode({ address: a, blockNumber: BigInt(b) })
    codeCache[k] = !code || code === '0x' || code.startsWith('0xef0100') ? 'eoa' : 'contract'
  })
  extLedger[c.key] = buildLedger(x.state, (a, b) => codeCache[`${c.key}:${a}@${b}`] ?? 'contract', { gaugeOk: ok, overrides, chain: c, seed })
  log(`${c.key}: checked ${ask.size} counterparties, ${cands.size} gauge candidates, ${seed.length} positions held at the start`)
}
writeJson(CODE_CACHE, codeCache)

// Another chain's events take their place on Base's timeline, at the last Base block at their time and
// never before the chain's start, keeping their own block (chainBlock) for reading that chain. Then each
// wallet's ledger holds every chain's events, and transfers between the chains are matched
// (lib/crosschain.mjs). Positions stay listed per chain, for the snapshots.
const owedAtOf = { base: ledger.owedAt }
const startBase = {} // chain key -> the first Base block of the chain's tracking
for (const x of Object.values(ext)) {
  const c = x.chain, L = extLedger[c.key]
  owedAtOf[c.key] = L.owedAt
  startBase[c.key] = (await timeline.blockBefore(c.startTs)) + 1
  await timeline.ensure([startBase[c.key]]) // its time is needed and not otherwise read once the search is kept
  const toBase = new Map()
  for (const t of Object.values(x.state.txs)) if (!toBase.has(t.block)) toBase.set(t.block, Math.max(startBase[c.key], await timeline.blockBefore(t.ts + 1)))
  for (const w of WALLETS) {
    for (const e of L[w.key].events) Object.assign(e, { chain: c.key, chainBlock: e.block, block: toBase.get(e.block) })
    for (const m of L[w.key].escrow) Object.assign(m, { chainBlock: m.block, block: toBase.get(m.block) })
    for (const y of L[w.key].warnings) Object.assign(y, { chain: c.key, chainBlock: y.block, block: toBase.get(y.block) })
    for (const p of L[w.key].positions) p.chain = c.key
  }
}
for (const w of WALLETS) {
  const L = ledger[w.key]
  for (const e of L.events) { e.chain = 'base'; e.chainBlock = e.block }
  for (const p of L.positions) p.chain = 'base'
  L.unpriced = L.unpriced.map((t) => ({ chain: 'base', address: t }))
  for (const [k, X] of Object.entries(extLedger)) {
    L.events.push(...X[w.key].events)
    L.escrow = [...L.escrow, ...X[w.key].escrow]
    L.warnings.push(...X[w.key].warnings)
    L.unpriced.push(...X[w.key].unpriced.map((t) => ({ chain: k, address: t })))
  }
  L.events.sort((a, b) => a.block - b.block || a.ts - b.ts)
  L.warnings.sort((a, b) => a.block - b.block)
  if (Object.keys(ext).length) L.escrow.push(...matchCrossChain(L.events, hodlKey, decOf))
}

// Token pair and pool of each position, read on its chain at a block of that chain. They never change,
// so they are kept between runs (data/cache/pairs.json).
const PAIR_CACHE = path.resolve('data/cache/pairs.json')
const pairSaved = readJson(PAIR_CACHE, {})
const pairCache = new Map(Object.entries(pairSaved).map(([k, v]) => [k, Promise.resolve(v)]))
async function pairOf(chainKey, npm, tokenId, block) {
  const k = `${chainKey}:${npm}:${tokenId}`
  if (!pairCache.has(k)) {
    const c = chainOf(chainKey), cl = clientOf(c)
    const read = (b) => cl.readContract({ address: npm, abi: npmAbi, functionName: 'positions', args: [BigInt(tokenId)], blockNumber: BigInt(b) })
    pairCache.set(k, read(block).catch(() => read(block - 1)).then(async (p) => ({
      token0: lc(p[2]), token1: lc(p[3]), tickLower: Number(p[5]), tickUpper: Number(p[6]),
      pool: lc(await cl.readContract({ address: c.npms[npm].factory, abi: factoryAbi, functionName: 'getPool', args: [p[2], p[3], p[4]] })),
    })).then((x) => (pairSaved[k] = x)))
  }
  return pairCache.get(k)
}

// Value of a whole position at a block of its chain (used when a position changes hands).
async function positionValueAt(chainKey, npm, tokenId, block, prices) {
  const client = clientOf(chainOf(chainKey))
  const pair = await pairOf(chainKey, npm, tokenId, block)
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
const openingBlock = await timeline.dayEndBlock(prevDay(START_DAY))
const dayEnds = new Map()
for (const d of days) if (d !== today) dayEnds.set(d, await timeline.dayEndBlock(d))
const dayBlock = (d) => (d === today ? head : dayEnds.get(d))
timeline.save()
const blocks = [openingBlock, ...days.map(dayBlock)]

const snapCache = readJson(SNAP_CACHE, {})
const snaps = {}
const tokensKey = Object.keys(TOKENS).sort().join('+')
// The other chains at the same moments from their start: their last block of each day, their head now,
// and their start block, whose holdings count as money put in then.
for (const x of Object.values(ext)) {
  x.at = new Map() // Base moment block -> the chain's block
  for (const d of days) {
    const b = dayBlock(d)
    if (tsOfBlock(b) >= x.chain.startTs) x.at.set(b, d === today ? x.head : await x.timeline.dayEndBlock(d))
  }
  x.timeline.save()
}
try {
  for (const w of WALLETS) {
    snaps[w.key] = {}
    await pmap(blocks, 3, async (b) => {
      // Only the positions alive at b are read and make up the key, so opening a new position does not
      // send every finished day back to the chain.
      const positions = positionsAt(ledger[w.key].positions, b)
      // Gauges only burned positions had joined may still hold deferred rewards for the wallet.
      const left = gaugesAt(ledger[w.key].positions, b).filter((g) => !positions.some((p) => p.gauges.includes(g)))
      const key = [SNAP_VERSION, tokensKey, ...positions.map((p) => `${p.npm}:${p.tokenId}:${p.gauges.join('+')}`).sort(), ...(left.length ? [`deferred:${left.join('+')}`] : [])].join(',')
      const cached = snapCache[`${w.key}:${b}`]
      if (cached && cached.posKey === key) { snaps[w.key][b] = reviveSnap(structuredClone(cached.snap)); return }
      const s = await snapshot(w, positions, b, left)
      snaps[w.key][b] = s
      if (b !== head) snapCache[`${w.key}:${b}`] = { posKey: key, snap: JSON.parse(JSON.stringify(s, (k, x) => (typeof x === 'bigint' ? x.toString() : x))) }
    })
  }
  for (const x of Object.values(ext)) {
    const c = x.chain, cKey = Object.keys(c.tokens).sort().join('+')
    x.snaps = {}
    for (const w of WALLETS) {
      x.snaps[w.key] = {}
      const all = extLedger[c.key][w.key].positions
      await pmap([...new Set([c.scanFromBlock, ...x.at.values()])], 3, async (b) => {
        const positions = positionsAt(all, b)
        const left = gaugesAt(all, b).filter((g) => !positions.some((p) => p.gauges.includes(g)))
        const key = [SNAP_VERSION, c.key, cKey, ...positions.map((p) => `${p.npm}:${p.tokenId}:${p.gauges.join('+')}`).sort(), ...(left.length ? [`deferred:${left.join('+')}`] : [])].join(',')
        const cached = snapCache[`${c.key}:${w.key}:${b}`]
        if (cached && cached.posKey === key) { x.snaps[w.key][b] = reviveSnap(structuredClone(cached.snap)); return }
        const s = await snapshot(w, positions, b, left, c)
        x.snaps[w.key][b] = s
        if (b !== x.head) snapCache[`${c.key}:${w.key}:${b}`] = { posKey: key, snap: JSON.parse(JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v))) }
      })
    }
  }
} finally {
  // Kept even when a read failed, so the next run carries on from there instead of starting over.
  writeJson(SNAP_CACHE, snapCache)
}
// One snapshot per wallet and moment for every chain: another chain's balances (its native ETH adding
// to ETH) and positions join Base's, each position keeping its chain and that chain's block; `parts`
// keeps each chain's own snapshot.
function mergeSnap(s, o, chainKey) {
  const out = { ...s, balances: { ...s.balances }, positions: [...s.positions], deferred: s.deferred + o.deferred, parts: { ...(s.parts ?? { base: s }), [chainKey]: o } }
  for (const [a, raw] of Object.entries(o.balances)) out.balances[a] = (out.balances[a] ?? 0n) + raw
  for (const p of o.positions) out.positions.push({ ...p, chain: chainKey, chainBlock: o.block })
  return out
}
for (const x of Object.values(ext)) for (const w of WALLETS) for (const [b, cb] of x.at) snaps[w.key][b] = mergeSnap(snaps[w.key][b], x.snaps[w.key][cb], x.chain.key)
// What is on the way stays the wallet's money: WETH waiting in its open native-ETH orders
// (lib/orders.mjs) and coins in transit between the tracked chains (lib/crosschain.mjs).
for (const w of WALLETS) for (const b of blocks) snaps[w.key][b].escrow = escrowByAsset(ledger[w.key].escrow, b)
const prices = {}
const eventBlocks = WALLETS.flatMap((w) => ledger[w.key].events.map((e) => e.block)).filter((b) => b > openingBlock && b <= head)
await pmap([...new Set([...blocks, ...eventBlocks, ...Object.values(startBase).filter((b) => b <= head)])], 4, async (b) => { prices[b] = await pricesAt(b) })
await savePrices(head)
log(`valued ${blocks.length} day-end blocks and ${new Set(eventBlocks).size} event blocks`)
const pNowCurve = prices[head]

// A snapshot's static collect pays principal still owed first; only the rest is fees.
function valueSnapshot(s, p) {
  let wallet = 0, lp = 0, fees = 0, owedUsd = 0, lpEth = 0
  const tokens = {}, feeTok = {}
  for (const [asset, raw] of Object.entries(s.balances)) wallet += valueOf(asset, raw, p)
  for (const [asset, raw] of s.escrow ?? []) wallet += valueOf(asset, raw, p)
  for (const x of s.positions) {
    const owed = owedPrincipal(owedAtOf[x.chain ?? 'base'], x.npm, x.tokenId, x.chainBlock ?? s.block)
    const o0 = owed.owed0 < x.fees0 ? owed.owed0 : x.fees0, o1 = owed.owed1 < x.fees1 ? owed.owed1 : x.fees1
    const a0 = x.amount0 + o0, a1 = x.amount1 + o1, f0 = x.fees0 - o0, f1 = x.fees1 - o1
    lp += valueOf(x.token0, a0, p) + valueOf(x.token1, a1, p)
    fees += valueOf(x.token0, f0, p) + valueOf(x.token1, f1, p)
    owedUsd += valueOf(x.token0, o0, p) + valueOf(x.token1, o1, p)
    if (hodlKey(x.token0) === 'ETH') lpEth += units(a0, 18)
    if (hodlKey(x.token1) === 'ETH') lpEth += units(a1, 18)
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

  // Everything held at the opening block counts as money put in at the opening prices; on another chain,
  // what it held at its start (lib/config.mjs CHAINS) counts as money put in then.
  const flows = []
  const opening = (s, b, chain) => {
    const po = prices[b], ov = valueSnapshot(s, po)
    const add = (asset, raw) => { if (raw > 0n) flows.push({ block: b, ts: tsOfBlock(b), asset, amount: raw, usd: valueOf(asset, raw, po), kind: 'opening', hash: null, cp: null, chain: chain.key }) }
    for (const [asset, raw] of Object.entries(s.balances)) add(asset, raw)
    for (const [asset, raw] of s.escrow ?? []) add(asset, raw)
    for (const [asset, raw] of Object.entries(ov.lpTokens)) add(asset, raw)
    for (const [asset, raw] of Object.entries(ov.feeTok)) add(asset, raw)
    add(chain.rewardToken, s.positions.reduce((a, x) => a + x.pending, 0n) + s.deferred)
  }
  opening(snaps[w.key][openingBlock], openingBlock, CHAINS.base)
  for (const x of Object.values(ext)) {
    const sb = startBase[x.chain.key], s0 = x.snaps[w.key][x.chain.scanFromBlock]
    if (sb <= head) opening({ ...s0, positions: s0.positions.map((p) => ({ ...p, chain: x.chain.key, chainBlock: s0.block })) }, sb, x.chain)
  }

  const rewards = [], fees = [], gas = [], aeroOut = [], lpEvents = [], flagged = [], nftFlows = []
  for (const e of ev) {
    const p = prices[e.block]
    for (const g of e.legs) {
      if (isExternal(g.cls)) flows.push({ block: e.block, ts: e.ts, asset: g.asset, amount: g.amount, usd: valueOf(g.asset, g.amount, p), kind: g.cls, bridge: e.bridge, hash: e.hash, cp: g.cp, chain: e.chain })
    }
    // AERO (or xAERO) leaving, except to the wallet's own other chain and what went into its own positions
    // in the same transaction (still held), net of AERO that came back in it other than as a reward.
    let kept = 0n
    for (const x of e.lp) if (x.type === 'increase') { const pr = await pairOf(e.chain, x.npm, x.tokenId, e.chainBlock); if (isAero(pr.token0)) kept += x.amount0; if (isAero(pr.token1)) kept += x.amount1 }
    if (e.lp.length) for (const g of e.legs) if (isAero(g.asset) && g.amount > 0n && g.cls !== 'reward' && !g.crossChain) kept += g.amount
    for (const g of e.legs) {
      if (!isAero(g.asset) || g.amount >= 0n || g.crossChain) continue
      const take = kept < -g.amount ? kept : -g.amount, out = -g.amount - take
      kept -= take
      if (out > 0n) aeroOut.push({ block: e.block, amount: out, usd: valueOf(g.asset, out, p), between: g.cls === 'between' })
    }
    for (const m of e.nftMoves) {
      const v = await positionValueAt(e.chain, m.npm, m.tokenId, e.chainBlock, p)
      const sign = m.dir === 'in' ? 1n : -1n
      for (const [asset, raw] of [[v.token0, v.amount0], [v.token1, v.amount1]]) {
        flows.push({ block: e.block, ts: e.ts, asset, amount: sign * raw, usd: Number(sign) * valueOf(asset, raw, p), kind: m.cls, hash: e.hash, cp: m.cp, nft: m.tokenId, chain: e.chain })
      }
      nftFlows.push({ ...m, block: e.block, ts: e.ts, hash: e.hash, usd: v.usd, token0: v.token0, token1: v.token1, chain: e.chain })
    }
    for (const r of e.rewards) rewards.push({ block: e.block, ts: e.ts, hash: e.hash, tokenId: r.tokenId, amount: r.amount, recipient: r.recipient })
    for (const f of e.fees) {
      const pair = await pairOf(e.chain, f.npm, f.tokenId, e.chainBlock)
      fees.push({ block: e.block, ts: e.ts, hash: e.hash, tokenId: f.tokenId, token0: pair.token0, token1: pair.token1, amount0: f.amount0, amount1: f.amount1, chain: e.chain })
    }
    if (e.gas) gas.push({ block: e.block, wei: e.gas })
    for (const x of e.lp) {
      const pair = await pairOf(e.chain, x.npm, x.tokenId, e.chainBlock)
      lpEvents.push({ ...x, ...pair, block: e.block, ts: e.ts, hash: e.hash, usd: valueOf(pair.token0, x.amount0, p) + valueOf(pair.token1, x.amount1, p), chain: e.chain })
    }
  }

  // Check per block: moves inside the strategy should roughly net to zero once liquidity added or
  // removed, fees and rewards are taken out. A block that does not, or that holds a transfer the
  // rules could only guess at, is flagged for a person to look at.
  // WETH into or out of the wallet's open orders is the other side of an order's ETH, fill or refund; WETH
  // an order paid to someone else is booked as money leaving.
  const byBlock = new Map()
  const escrowIn = new Map() // tx hash -> [asset, amount] moved into (+) or out of (-) what is on the way
  // A matched transfer between chains releases only what arrived: its fee is a known cost, not a mismatch.
  for (const m of L.escrow) escrowIn.set(m.hash, [...(escrowIn.get(m.hash) ?? []), [m.asset, m.received != null ? -m.received : m.amount]])
  for (const e of ev) {
    const p = prices[e.block]
    const k = `${e.chain}:${e.block}`
    const g = byBlock.get(k) ?? { block: e.block, chain: e.chain, net: 0, gross: 0, hashes: [], review: false }
    for (const leg of e.legs) if (leg.cls === 'internal') { const v = valueOf(leg.asset, leg.amount, p); g.net += v; g.gross += Math.abs(v) }
    for (const leg of e.legs) if (leg.fromOrder) g.net -= valueOf(leg.asset, leg.amount, p)
    for (const [asset, amount] of escrowIn.get(e.hash) ?? []) g.net += valueOf(asset, amount, p)
    for (const x of lpEvents.filter((y) => y.hash === e.hash)) g.net += x.type === 'increase' ? x.usd : -x.usd
    // Principal removed but left in the position, or collected later: what the position owes changes
    // by it (lib/ledger.mjs), so a withdrawal split over two transactions balances in each.
    for (const o of e.owed ?? []) { const pr = await pairOf(e.chain, o.npm, o.tokenId, e.chainBlock); g.net += valueOf(pr.token0, o.amount0, p) + valueOf(pr.token1, o.amount1, p) }
    for (const f of fees.filter((y) => y.hash === e.hash)) g.net -= valueOf(f.token0, f.amount0, p) + valueOf(f.token1, f.amount1, p)
    g.hashes.push(e.hash)
    g.review ||= e.review
    byBlock.set(k, g)
  }
  for (const g of byBlock.values()) if (g.review || Math.abs(g.net) > Math.max(25, 0.02 * g.gross)) flagged.push({ block: g.block, chain: g.chain, net: g.net, hashes: g.hashes })

  flows.sort((a, b) => a.block - b.block)
  writeJson(PAIR_CACHE, pairSaved)
  walletData[w.key] = { L, ev, flows, rewards, fees, gas, aeroOut, lpEvents, nftFlows, flagged, warnings: L.warnings.filter((x) => x.block > openingBlock && x.block <= head) }
}

// Cumulative figures for some wallets at block b. In a multi-wallet scope, transfers between
// those wallets are left out: they are neither money in nor a change of what is held.
function cumulative(keys, b) {
  const multi = keys.length > 1
  const upTo = (xs) => xs.filter((x) => x.block <= b)
  const flows = keys.flatMap((k) => upTo(walletData[k].flows)).filter((f) => !(multi && f.kind === 'between'))
  const invested = sum(flows, (f) => f.usd)
  // "Just held it" (lib/hodl.mjs): what came in stays in its own coin; what went out comes out of it.
  const hodl = hodlHeld([...flows].sort((x, y) => x.block - y.block).map((f) => ({ ...f, prices: prices[f.block] })), hodlKey, valueOf)
  const claimed = keys.flatMap((k) => upTo(walletData[k].rewards)).reduce((a, r) => a + r.amount, 0n)
  const feeTok = {}
  for (const f of keys.flatMap((k) => upTo(walletData[k].fees))) {
    feeTok[f.token0] = (feeTok[f.token0] ?? 0n) + f.amount0
    feeTok[f.token1] = (feeTok[f.token1] ?? 0n) + f.amount1
  }
  const gasWei = keys.flatMap((k) => upTo(walletData[k].gas)).reduce((a, g) => a + g.wei, 0n)
  // AERO that left (sold, sent) and AERO brought in from outside, for the AERO price step.
  const aeroOutUsd = sum(keys.flatMap((k) => upTo(walletData[k].aeroOut)).filter((x) => !(multi && x.between)), (x) => x.usd)
  const aeroInUnits = flows.filter((f) => isAero(f.asset) && big(f.amount) > 0n).reduce((a, f) => a + big(f.amount), 0n)
  return { invested, hodl, claimed, feeTok, gasWei, aeroOutUsd, aeroInUnits }
}

function scopeAt(keys, b) {
  const p = prices[b]
  const vs = keys.map((k) => valueSnapshot(snaps[k][b], p))
  const c = cumulative(keys, b)
  const feeAccrued = { ...c.feeTok }
  for (const v of vs) for (const [t, a] of Object.entries(v.feeTok)) feeAccrued[t] = (feeAccrued[t] ?? 0n) + a
  const hodl = sum([...c.hodl], ([k, a]) => valueOf(k, a, p))
  const pendingAero = sum(vs, (v) => v.pendingAero)
  const aeroHeld = units(keys.reduce((a, k) => a + Object.entries(snaps[k][b].balances).reduce((x, [t, raw]) => x + (isAero(t) ? raw : 0n), 0n), 0n), 18)
  return {
    b, p, c, feeAccrued, hodl, pendingAero, aeroHeld,
    value: sum(vs, (v) => v.total), lp: sum(vs, (v) => v.lp), wallet: sum(vs, (v) => v.wallet), pending: sum(vs, (v) => v.pending), feesNow: sum(vs, (v) => v.fees),
    owedUsd: sum(vs, (v) => v.owedUsd), lpEth: sum(vs, (v) => v.lpEth), range: vs.map((v) => v.range),
    aeroAccrued: units(c.claimed, 18) + pendingAero,
  }
}

// Another chain's holdings at its start, valued then (lib/config.mjs CHAINS): on the day the chain
// starts they join the day's starting figures, as if held from the start of the day, so they count as
// neither the day's interest nor its LP result.
function chainStarts(key, a, b) {
  return Object.values(ext).filter((x) => startBase[x.chain.key] > a && startBase[x.chain.key] <= b && startBase[x.chain.key] <= head).map((x) => {
    const s0 = x.snaps[key][x.chain.scanFromBlock], sb = startBase[x.chain.key]
    return { block: sb, v: valueSnapshot({ ...s0, positions: s0.positions.map((p) => ({ ...p, chain: x.chain.key, chainBlock: s0.block })) }, prices[sb]) }
  })
}

// Time-weighted LP value over (startB, endB]: liquidity added or removed during the day only counts
// for the part of the day it was in the pool.
function lpTimeWeighted(key, startB, endB) {
  let lp = valueSnapshot(snaps[key][startB], prices[startB]).lp
  const changes = [
    ...chainStarts(key, startB, endB).map((o) => ({ block: o.block, d: o.v.lp })),
    ...walletData[key].lpEvents.filter((x) => x.block > startB && x.block <= endB).map((x) => ({ block: x.block, d: x.type === 'increase' ? x.usd : -x.usd })),
    ...walletData[key].nftFlows.filter((x) => x.block > startB && x.block <= endB).map((x) => ({ block: x.block, d: x.dir === 'in' ? x.usd : -x.usd })),
  ].sort((a, b) => a.block - b.block)
  // Weighted by time, not by block count: blocks stop being evenly spaced at the Denim hard fork.
  let cursor = startB, area = 0
  for (const c of changes) { area += lp * (tsOfBlock(c.block) - tsOfBlock(cursor)); lp = Math.max(0, lp + c.d); cursor = c.block }
  area += lp * (tsOfBlock(endB) - tsOfBlock(cursor))
  const span = tsOfBlock(endB) - tsOfBlock(startB)
  return span > 0 ? area / span : lp
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
    for (const [asset, raw] of s.escrow ?? []) {
      if (hodlKey(asset) === 'ETH') ethUnits += units(raw, 18)
      else fixedUsd += valueOf(asset, raw, pNowCurve)
    }
    fixedUsd += units(s.positions.reduce((a, x) => a + x.pending, 0n) + s.deferred, 18) * (pNowCurve.aero ?? 0)
    for (const x of s.positions) {
      // A WETH/USDC position in dollar terms, either token order (lib/curve.mjs); collect() also pays
      // owed principal and fees (extraEth, extraUsd).
      const c = curveOf(x)
      if (c) {
        // Only live positions follow a curve and set the lowest bound: one whose liquidity was all
        // removed but not burned holds nothing, and must not keep the scope looking "in a range".
        if (x.liquidity > 0n) curves.push({ ...c, key: k, address: x.pool, chain: x.chain ?? 'base' })
        ethUnits += c.extraEth; fixedUsd += c.extraUsd
      } else {
        fixedUsd += valueOf(x.token0, x.amount0 + x.fees0, pNowCurve) + valueOf(x.token1, x.amount1 + x.fees1, pNowCurve)
      }
    }
  }
  const amounts = amountsAtUsd
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

// The day's interest as a yearly rate on the money in the pool that day (time-weighted), and the AERO
// each $1,000 in the pool earned per day; a day still under way is scaled to a whole one. Null while
// there was too little in the pool for a rate to mean anything.
const yearly = (usd, tw, days) => (tw >= 50 && days > 0 ? r6((usd / tw) * (365 / days)) : null)
const per1k = (aero, tw, days) => (tw >= 50 && days > 0 ? r6(((aero / tw) * 1000) / days) : null)

// Daily rows per wallet, rounded; the combined rows add up the rounded wallet rows so every view agrees.
const walletRows = {}
for (const w of WALLETS) {
  walletRows[w.key] = []
  let prev = scopeAt([w.key], openingBlock), cum = 0, prevPnl = null
  for (const d of days) {
    const b = dayBlock(d)
    const cur = scopeAt([w.key], b)
    for (const { v } of chainStarts(w.key, prev.b, b)) {
      const feeAccrued = { ...prev.feeAccrued }
      for (const [t, a] of Object.entries(v.feeTok)) feeAccrued[t] = (feeAccrued[t] ?? 0n) + a
      prev = { ...prev, feeAccrued, aeroAccrued: prev.aeroAccrued + v.pendingAero, lp: prev.lp + v.lp, owedUsd: prev.owedUsd + v.owedUsd, feesNow: prev.feesNow + v.fees, pending: prev.pending + v.pending, value: prev.value + v.total }
    }
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
      const tw = lpTimeWeighted(w.key, prev.b, b), days = (tsOfBlock(b) - tsOfBlock(prev.b)) / 86400
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
        lp_usd: r2(cur.lp), lp_tw_usd: r2(tw), span_days: r6(days), apr_day: yearly(earn, tw, days), aero_per_1k: per1k(earnAero, tw, days),
        // How much of the day the money was in the pool: low on a day it went in or came out, when the
        // rate rests on a few hours.
        pool_share: Math.max(prev.lp, cur.lp) > 0 ? r6(Math.min(1, tw / Math.max(prev.lp, cur.lp))) : null,
        wallet_usd: r2(cur.wallet),
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
let prevTotalLp = 0 // the combined LP value at the previous day's close, for pool_share
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
  t.span_days = rows[0].span_days; t.apr_day = yearly(t.earn_usd, t.lp_tw_usd, t.span_days); t.aero_per_1k = per1k(t.earn_aero, t.lp_tw_usd, t.span_days)
  t.pool_share = Math.max(prevTotalLp, t.lp_usd) > 0 ? r6(Math.min(1, t.lp_tw_usd / Math.max(prevTotalLp, t.lp_usd))) : null
  prevTotalLp = t.lp_usd
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
  const ethHeld = (s) => [...Object.entries(s.balances), ...(s.escrow ?? [])].reduce((a, [t, raw]) => a + (hodlKey(t) === 'ETH' ? units(raw, 18) : 0), 0)
  const wallEth = keys.reduce((a, k) => a + ethHeld(snaps[k][head]), 0)
  const highest = Math.max(...c.curves.map((x) => x.high), -Infinity)
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
      // chain: which chain's RPCs the page reads the pool from; invert: its slot0 price is dollars per ETH
      // inverted (USDC is token0 there).
      positions: [...c.curves].sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key) || a.low - b.low).map((x) => ({ wallet: label(x.key), low: r2(x.low), high: r2(x.high), pool: r6(x.pool), in_range: x.inRange, pool_address: x.address, tick_lower: x.tickLower, tick_upper: x.tickUpper, L: x.L, sa: x.sa, sb: x.sb, chain: x.chain, invert: x.invert })),
    },
  }
}

// Tokens with no price source (lib/config.mjs TOKENS) that are valued at $0 somewhere in a wallet's
// figures, so the page says they are incomplete instead of showing them as whole: tokens in any
// position the wallet held at a day's close, added or removed liquidity, fees, or positions that moved
// in or out; and tokens the ledger saw the wallet receive (lib/ledger.mjs), which stay listed after
// they are gone, since the days they were held were valued without them.
const unpricedOf = (keys) => {
  const out = new Map() // address -> chain
  for (const k of keys) {
    const D = walletData[k]
    const seen = [...Object.values(snaps[k]).flatMap((s) => s.positions), ...D.lpEvents, ...D.fees, ...D.nftFlows].flatMap((x) => [{ chain: x.chain ?? 'base', address: x.token0 }, { chain: x.chain ?? 'base', address: x.token1 }])
    for (const t of [...seen, ...(ledger[k].unpriced ?? [])]) if (t.address && t.address !== 'ETH' && !chainOf(t.chain).tokens[t.address]) out.set(t.address, t.chain)
  }
  return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([address, chain]) => ({ address, chain }))
}
// What the rules could not settle, newest first, for the page to list and the phone to report: a
// one-way transfer with an unknown contract (booked as money in or out), a block whose moves inside
// the strategy do not add up, and the ledger's warnings. Fixed by hand in config/overrides.json.
const toCheck = (keys) => {
  const out = []
  for (const k of keys) {
    const D = walletData[k], wallet = WALLETS.find((w) => w.key === k)?.label ?? k
    for (const f of D.flagged) {
      const legs = D.ev.filter((e) => f.hashes.includes(e.hash)).flatMap((e) => e.legs.filter((g) => g.review).map((g) => ({ e, g })))
      for (const { e, g } of legs) {
        const into = g.amount > 0n
        const amount = `${r6(Math.abs(units(g.amount, decOf(g.asset))))} ${symOf(g.asset)}`
        out.push({ block: e.block, chain: e.chain, time_cst: cstTime(e.ts), wallet, tx: e.hash, usd: r2(valueOf(g.asset, g.amount, prices[e.block])),
          text: g.fromOrder
            ? (into ? `${amount} 从 ${short(g.cp)} 退回了挂单，暂按资金转入计` : `挂单把 ${amount} 付给了 ${short(g.cp)}，暂按资金转出计`)
            : `${into ? '收到' : '转出'} ${amount}，对方是不认识的合约 ${short(g.cp)}，暂按资金${into ? '转入' : '转出'}计` })
      }
      if (!legs.length) out.push({ block: f.block, chain: f.chain, time_cst: cstTime(tsOfBlock(f.block)), wallet, tx: f.hashes[0], usd: null, text: `这个区块里策略内部的进出对不上，差 $${Math.abs(f.net).toFixed(2)}` })
    }
    // Tokens without a price have their own notice and alert (summary.unpriced).
    for (const x of D.warnings.filter((y) => y.kind !== 'unpriced')) out.push({ block: x.block, chain: x.chain ?? 'base', time_cst: cstTime(tsOfBlock(x.block)), wallet, tx: x.hash, usd: null, text: x.text })
  }
  // Another chain's items say which chain (the page links them to its explorer, the alert names it).
  for (const x of out) if (x.chain && x.chain !== 'base') x.text = `（${chainOf(x.chain).label}）${x.text}`
  return out.sort((a, b) => b.block - a.block)
}

const unpricedSymbols = {}
for (const t of unpricedOf(WALLETS.map((w) => w.key))) {
  const c = chainOf(t.chain)
  unpricedSymbols[t.address] = await clientOf(c).readContract({ address: t.address, abi: erc20Abi, functionName: 'symbol', blockNumber: BigInt(c.key === 'base' ? head : ext[c.key].head) }).catch(() => null)
}

// Summary and attribution. Money figures come from the rounded daily rows, so the cards, the
// charts, the tables and the breakdown all show the same numbers.
const pNow = prices[head]
const summary = [], attribution = []
for (const sc of SCOPES) {
  const rows = daily.filter((r) => r.scope === sc.key)
  const n = scopeAt(sc.wallets, head)
  const checks = toCheck(sc.wallets)
  const last = rows.at(-1), prevRow = rows.at(-2)
  const finished = rows.filter((r) => !r.partial).slice(-7)
  const twLp = sum(finished, (r) => r.lp_tw_usd), earnN = sum(finished, (r) => r.earn_usd)
  const value = last?.value_usd ?? r2(n.value), invested = last?.invested_usd ?? r2(n.c.invested), hodl = last?.hodl_usd ?? r2(n.hodl)
  const rewards = r2(sum(rows, (r) => r.earn_aero_usd)), fees = r2(sum(rows, (r) => r.earn_fee_usd))
  const gasEth = units(n.c.gasWei, 18), gasUsd = r2(gasEth * pNow.eth)
  const pnl = r2(value - invested)
  // What the earned AERO is worth now (held or unclaimed at today's price, sold or sent at the price
  // then) against what it was worth when earned.
  const aeroNow = (n.aeroHeld + n.pendingAero - units(n.c.aeroInUnits, 18)) * (pNow.aero ?? 0) + n.c.aeroOutUsd
  summary.push({
    scope: sc.key, scope_label: sc.label,
    as_of: new Date(tsOfBlock(head) * 1000).toISOString(), as_of_cst: cstTime(tsOfBlock(head)), as_of_block: head,
    start_day: rows[0]?.day ?? null,
    invested_usd: invested, value_usd: value, pnl_usd: pnl, pnl_pct: invested ? r6(pnl / invested) : null,
    hodl_usd: hodl, vs_hodl_usd: r2(value - hodl),
    earn_total_usd: r2(rewards + fees), rewards_usd: rewards, fees_usd: fees,
    // Counted from the days, as rewards_usd is: AERO already unclaimed when a chain's tracking started
    // was money put in, not earned.
    aero_earned: r6(sum(rows, (r) => r.earn_aero)), aero_claimed: r6(units(n.c.claimed, 18)), aero_pending: r6(n.pendingAero), aero_held: r6(n.aeroHeld),
    aero_unsold_usd: r2((n.aeroHeld + n.pendingAero) * (pNow.aero ?? 0)), aero_drift_usd: r2(aeroNow - rewards),
    today_usd: last?.partial ? last.earn_usd : null, yesterday_usd: (last?.partial ? prevRow : last)?.earn_usd ?? null,
    apr_days: finished.length, earn_7d_usd: r2(earnN), apr_7d: twLp > 0 ? r6((earnN / twLp) * 365) : null,
    lp_usd: last?.lp_usd ?? r2(n.lp), wallet_usd: last?.wallet_usd ?? r2(n.wallet), pending_usd: r2(n.pending), fees_unclaimed_usd: r2(n.feesNow),
    gas_eth: r6(gasEth), gas_usd: gasUsd, eth_usd: r2(pNow.eth), aero_usd: pNow.aero == null ? null : r6(pNow.aero),
    eth_ref_pool: PRICE.ethPool, // the page reads it live; a public pool, not a wallet
    flagged: sum(sc.wallets, (k) => walletData[k].flagged.length + walletData[k].warnings.length),
    to_check_count: checks.length, to_check: checks.slice(0, 20).map(({ block, ...x }) => x), to_check_txs: [...new Set(checks.map((x) => x.tx))],
    ...ethPrices(sc.wallets, invested, r2(rewards + fees), value),
    unpriced: unpricedOf(sc.wallets).map(({ address, chain }) => ({ address, symbol: unpricedSymbols[address], chain })),
  })
  // From money put in to value now; the AERO step is aeroNow minus what it was worth when earned.
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
  const mine = (y) => y.npm === x.npm && y.tokenId === x.tokenId && (y.chain ?? 'base') === (x.chain ?? 'base')
  const cost = sum(D.lpEvents.filter(mine), (y) => (y.type === 'increase' ? y.usd : -y.usd)) + sum(D.nftFlows.filter(mine), (m) => (m.dir === 'in' ? m.usd : -m.usd))
  const c = curveOf(x)
  if (!c) return { cost_usd: r2(cost), eth_if_below: null, usdc_if_above: null, cost_price: null }
  const eth = c.L * (1 / c.sa - 1 / c.sb) / 1e18 + c.extraEth, usdc = c.L * (c.sb - c.sa) / 1e6 + c.extraUsd
  return { cost_usd: r2(cost), eth_if_below: r6(eth), usdc_if_above: r2(usdc), cost_price: eth > 0 ? r2(cost / eth) : null }
}

// Current positions and holdings.
const positions = [], holdings = []
for (const w of WALLETS) {
  const s = snaps[w.key][head]
  for (const x of s.positions) {
    const d0 = decOf(x.token0), d1 = decOf(x.token1), c = curveOf(x), ch = chainOf(x.chain)
    const owed = owedPrincipal(owedAtOf[ch.key], x.npm, x.tokenId, x.chainBlock ?? head)
    const o0 = owed.owed0 < x.fees0 ? owed.owed0 : x.fees0, o1 = owed.owed1 < x.fees1 ? owed.owed1 : x.fees1
    const a0 = x.amount0 + o0, a1 = x.amount1 + o1
    const pending = units(x.pending, 18)
    positions.push({
      scope: w.key, scope_label: w.label, position: `#${x.tokenId}`, token_id: x.tokenId,
      pool_label: `${c?.invert ? `${symOf(x.token1)}/${symOf(x.token0)}` : `${symOf(x.token0)}/${symOf(x.token1)}`} · CL${x.tickSpacing}`,
      venue: `${ch.npms[x.npm]?.label ?? x.npm}${ch.key === 'base' ? '' : ` · ${ch.label}`}`, chain: ch.key,
      status: x.staked ? '质押中' : '未质押', in_range: x.inRange,
      range_low: r2(c ? c.low : priceAtTick(x.tickLower, d0, d1)), range_high: r2(c ? c.high : priceAtTick(x.tickUpper, d0, d1)), price: r2(c ? c.pool : priceFromSqrt(x.sqrtP, d0, d1)),
      amount0: r6(units(a0, d0)), symbol0: symOf(x.token0), amount1: r6(units(a1, d1)), symbol1: symOf(x.token1),
      value_usd: r2(valueOf(x.token0, a0, pNow) + valueOf(x.token1, a1, pNow)),
      pending_aero: r6(pending), pending_usd: r2(pending * (pNow.aero ?? 0)),
      fees_usd: r2(valueOf(x.token0, x.fees0 - o0, pNow) + valueOf(x.token1, x.fees1 - o1, pNow)),
      ...positionCost(w.key, x),
    })
  }
  for (const [ck, part] of Object.entries(s.parts ?? { base: s })) {
    for (const [asset, raw] of Object.entries(part.balances)) {
      if (raw === 0n) continue
      holdings.push({ scope: w.key, scope_label: w.label, place: ck === 'base' ? '钱包' : `钱包（${chainOf(ck).label}）`, asset: symOf(asset), amount: r6(units(raw, decOf(asset))), value_usd: r2(valueOf(asset, raw, pNow)) })
    }
  }
  for (const [asset, raw] of s.escrow ?? []) holdings.push({ scope: w.key, scope_label: w.label, place: '挂单或跨链途中', asset: symOf(asset), amount: r6(units(raw, decOf(asset))), value_usd: r2(valueOf(asset, raw, pNow)) })
  const v = valueSnapshot(s, pNow)
  const lp = {}
  for (const [t, a] of Object.entries(v.lpTokens)) lp[t] = (lp[t] ?? 0n) + a
  for (const [t, a] of Object.entries(v.feeTok)) lp[t] = (lp[t] ?? 0n) + a
  for (const [asset, raw] of Object.entries(lp)) if (raw > 0n) holdings.push({ scope: w.key, scope_label: w.label, place: 'LP 仓位', asset: symOf(asset), amount: r6(units(raw, decOf(asset))), value_usd: r2(valueOf(asset, raw, pNow)) })
  for (const [ck, part] of Object.entries(s.parts ?? { base: s })) {
    const units18 = units(part.positions.reduce((a, x) => a + x.pending, 0n) + part.deferred, 18)
    if (units18 > 0) holdings.push({ scope: w.key, scope_label: w.label, place: ck === 'base' ? '待领奖励' : `待领奖励（${chainOf(ck).label}）`, asset: symOf(chainOf(ck).rewardToken), amount: r6(units18), value_usd: r2(units18 * (pNow.aero ?? 0)) })
  }
}

// The ledger as people read it: money in and out, LP moves, rewards, fees, swaps, and anything to check.
const events = []
for (const w of WALLETS) {
  const D = walletData[w.key]
  const flaggedHashes = new Set(D.flagged.flatMap((f) => f.hashes))
  // Positions the wallet already held at the opening or a chain's start were opened before: adds to them are 加仓.
  const seenMint = new Set([...ledger[w.key].positions, ...Object.entries(extLedger).flatMap(([k, X]) => X[w.key].positions.map((p) => ({ ...p, chain: k })))]
    .filter((p) => p.born == null).map((p) => `${p.chain ?? 'base'}:${p.npm}:${p.tokenId}`))
  for (const e of D.ev) {
    const p = prices[e.block]
    const base = { scope: w.key, scope_label: w.label, chain: e.chain, time_cst: cstTime(e.ts), day: cstDay(e.ts), block: e.block, tx: e.hash, flagged: flaggedHashes.has(e.hash) }
    const ch = chainOf(e.chain)
    const cpLabel = (g) => (g.cls === 'bridge' ? `${e.bridge} 跨链` : g.cls === 'between' ? (g.amount > 0n ? '来自另一钱包' : '转给另一钱包') : LABELS[g.cp] ?? ch.strategy[g.cp] ?? ch.bridges[g.cp] ?? short(g.cp))
    for (const g of e.legs.filter((x) => isExternal(x.cls))) {
      events.push({ ...base, kind: g.amount > 0n ? '资金转入' : '资金转出', detail: `${cpLabel(g)} · ${r6(Math.abs(units(g.amount, decOf(g.asset))))} ${symOf(g.asset)}${g.review ? '（规则无法确定，暂按资金进出计）' : ''}`, usd: r2(valueOf(g.asset, g.amount, p)) })
    }
    for (const m of D.nftFlows.filter((x) => x.hash === e.hash)) {
      events.push({ ...base, kind: m.dir === 'in' ? '仓位转入' : '仓位转出', detail: `#${m.tokenId} · ${m.cls === 'between' ? (m.dir === 'in' ? '来自另一钱包' : '转给另一钱包') : short(m.cp)}`, usd: r2(m.dir === 'in' ? m.usd : -m.usd) })
    }
    for (const x of D.lpEvents.filter((y) => y.hash === e.hash)) {
      const k = `${e.chain}:${x.npm}:${x.tokenId}`
      const kind = x.type === 'decrease' ? '撤出流动性' : seenMint.has(k) ? '加仓' : '开仓'
      if (x.type === 'increase') seenMint.add(k)
      const amt = (t, a) => (decOf(t) <= 6 ? r2(units(a, decOf(t))) : r6(units(a, decOf(t))))
      events.push({ ...base, kind, detail: `#${x.tokenId} · ${amt(x.token0, x.amount0)} ${symOf(x.token0)} + ${amt(x.token1, x.amount1)} ${symOf(x.token1)}`, usd: r2(x.usd) })
    }
    const claimed = e.rewards.reduce((a, r) => a + r.amount, 0n)
    if (claimed > 0n) events.push({ ...base, kind: '领取奖励', detail: `${r6(units(claimed, 18))} ${symOf(ch.rewardToken)}${e.rewards.some((r) => r.recipient !== w.address) ? '（领给了别的地址）' : ''}`, usd: r2(valueOf(ch.rewardToken, claimed, p)) })
    for (const f of D.fees.filter((y) => y.hash === e.hash)) {
      events.push({ ...base, kind: '收取手续费', detail: `#${f.tokenId} · ${r6(units(f.amount0, decOf(f.token0)))} ${symOf(f.token0)} + ${r6(units(f.amount1, decOf(f.token1)))} ${symOf(f.token1)}`, usd: r2(valueOf(f.token0, f.amount0, p) + valueOf(f.token1, f.amount1, p)) })
    }
    // Moves between the tracked chains (lib/crosschain.mjs), and principal collected after it was removed.
    for (const g of e.legs.filter((x) => x.crossChain)) {
      const amount = `${r6(Math.abs(units(g.amount, decOf(g.asset))))} ${symOf(g.asset)}`, via = e.bridge ? `（${e.bridge}）` : ''
      if (g.sameChain) { // a bridge's fill on the same chain: a swap settled in two transactions
        events.push({ ...base, kind: '兑换', detail: `${g.amount > 0n ? '收到' : '付出'} ${amount}${via}`, usd: r2(Math.abs(valueOf(g.asset, g.amount, p))) })
        continue
      }
      const other = Object.values(CHAINS).filter((c) => c.key !== e.chain).map((c) => c.label).join('、')
      events.push({ ...base, kind: g.amount > 0n ? '跨链转入' : '跨链转出', detail: `${g.amount > 0n ? `来自${other}` : `转到${other}`}${via} · ${amount}`, usd: r2(valueOf(g.asset, g.amount, p)) })
    }
    if (!e.lp.length && (e.owed ?? []).some((o) => o.amount0 < 0n || o.amount1 < 0n)) {
      for (const o of e.owed.filter((y) => y.amount0 < 0n || y.amount1 < 0n)) {
        const pr = await pairOf(e.chain, o.npm, o.tokenId, e.chainBlock)
        events.push({ ...base, kind: '取回本金', detail: `#${o.tokenId} · ${r6(units(-o.amount0, decOf(pr.token0)))} ${symOf(pr.token0)} + ${r6(units(-o.amount1, decOf(pr.token1)))} ${symOf(pr.token1)}`, usd: r2(-(valueOf(pr.token0, o.amount0, p) + valueOf(pr.token1, o.amount1, p))) })
      }
    }
    // Swaps: internal legs of a transaction with no liquidity change, netted per asset.
    if (!e.lp.length && !e.fees.length && !e.rewards.length && !(e.owed ?? []).length) {
      const net = {}
      for (const g of e.legs.filter((x) => x.cls === 'internal' && !x.crossChain && !x.bridgeFee)) net[g.asset] = (net[g.asset] ?? 0n) + g.amount
      const outs = Object.entries(net).filter(([, a]) => a < 0n), ins = Object.entries(net).filter(([, a]) => a > 0n)
      if (outs.length || ins.length) {
        const fmt = ([a, x]) => `${r6(Math.abs(units(x, decOf(a))))} ${symOf(a)}`
        const detail = outs.length && ins.length ? `${outs.map(fmt).join(' + ')} → ${ins.map(fmt).join(' + ')}` : outs.length ? `付出 ${outs.map(fmt).join(' + ')}（成交在另一笔交易）` : `收到 ${ins.map(fmt).join(' + ')}（挂单成交）`
        const usd = outs.length ? sum(outs, ([x, r]) => -valueOf(x, r, p)) : sum(ins, ([x, r]) => valueOf(x, r, p))
        const wrap = outs.length > 0 && ins.length > 0 && Object.keys(net).every((a) => hodlKey(a) === 'ETH')
        events.push({ ...base, kind: wrap ? '包装 ETH' : '兑换', detail, usd: r2(Math.abs(usd)) })
      }
    }
  }
  for (const x of D.warnings) events.push({ scope: w.key, scope_label: w.label, chain: x.chain ?? 'base', time_cst: cstTime(tsOfBlock(x.block)), day: cstDay(tsOfBlock(x.block)), block: x.block, tx: x.hash, kind: '待确认', detail: x.text, usd: null, flagged: true })
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
log(`wrote out/ as of block ${head} (${cstTime(tsOfBlock(head))} CST): ${daily.length} daily rows, ${events.length} ledger rows, ${summary.find((s) => s.scope === 'total')?.to_check_count ?? 0} to check, ${Object.keys(unpricedSymbols).length} tokens without a price`)
