// The stock/USDC pools listed beside the WETH/USDC ones: which they are, how they are read, how they are shown.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { poolStats, stayShare } from '../lib/pools.mjs'
import { isStock, sampleStockPools, stockRows, STOCK_DAYS, STOCK_MIN_USD, STOCK_KEEP_USD } from '../lib/stocks.mjs'

const Q96 = 2 ** 96, Q128 = 2n ** 128n, HOUR = 3600, YEAR = 365 * 86400
const T0 = 1_790_000_000 - (1_790_000_000 % HOUR)
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const COINBASE = '0xb2000000000000000000002d0ba3164cc74f58b7'

test('the stocks are told by their issuer\'s address and their kind of name', () => {
  for (const s of ['AMZNc', 'GOOGLc', 'MUc', 'LIc']) assert.ok(isStock(COINBASE, s), s)
  assert.ok(isStock('0x5cda0e1ca4000000000000000000000000000000', 'wtCOIN'))
  // The same factory's other tokens.
  for (const s of ['cbZEC', 'cbHYPE', 'BLUECHIP', 'Basecat']) assert.ok(!isStock(COINBASE, s), s)
  // The name alone proves nothing, and a token may not answer at all.
  assert.ok(!isStock('0x1111111111111111111111111111111111111111', 'AMZNc'))
  assert.ok(!isStock(COINBASE, null))
})

// A USDC/stock pool (USDC is token0) at a dollar price, with a token of 8 decimals: 18 - 8 scales the raw price.
const samples = (hours, { price = () => 300, dec = 8, feeUsdcPerHour = 0, rewardPerHour = 0, staked = 10n ** 12n, liq = 10n ** 12n, gap = 0 } = {}) => {
  const out = {}
  let rg = 0n, fg0 = 0n
  for (let h = 0; h <= hours; h++) {
    const raw = 10 ** (dec - 6) / price(h) // token raw per USDC raw
    out[T0 + h * HOUR] = { ts: T0 + h * HOUR, block: h, sqrtP: BigInt(Math.round(Math.sqrt(raw) * Q96)).toString(), liq: liq.toString(), staked: staked.toString(), rg: rg.toString(), fg0: fg0.toString(), fg1: '0', aero: 2 }
    rg += (BigInt(rewardPerHour) * Q128) / staked
    fg0 += (BigInt(feeUsdcPerHour) * Q128) / liq
    void gap
  }
  return out
}

test('a pool of an 8-decimal stock reads its rate as an 18-decimal token at the same price would', () => {
  const ratio = 1.05 ** 2, nowTs = T0 + 240 * HOUR
  // The dollars a unit of liquidity holds at a centred range, exactly, for each token's decimals.
  const perL = (dec) => {
    const raw = 10 ** (6 - dec) * 300, r = Math.sqrt(raw), k = ratio ** 0.25, sa = r / k, sb = r * k
    return ((1 / r - 1 / sb) / 10 ** dec) * 300 + (r - sa) / 1e6
  }
  // AERO paid per hour per unit of liquidity, so a real position's earnings are known: 2 dollars an AERO.
  const reward = 10n ** 15n, staked = 10n ** 12n
  for (const dec of [8, 18]) {
    const e = { wethFirst: false, samples: samples(240, { dec, rewardPerHour: reward * staked / 10n ** 12n, staked }) }
    const s = poolStats(e, { ratio, nowTs })
    const usdPerLHour = (Number(reward) / 1e12 / 1e18) * 2 // per unit of liquidity
    const expected = ((usdPerLHour / perL(dec)) * YEAR) / HOUR
    assert.ok(Math.abs(s.recent.staked - expected) / expected < 1e-6, `${dec}: ${s.recent.staked} vs ${expected}`)
  }
})

test('the share of hours a range set and left alone stays in', () => {
  const nowTs = T0 + 100 * HOUR, ratio = 1.05 ** 2
  // Flat: always inside.
  assert.equal(stayShare({ wethFirst: false, samples: samples(100) }, ratio, { hours: 10, days: 9, nowTs }), 1)
  // A step of 10% halfway: ranges set before it are left when the price jumps, those after it stay.
  const step = { wethFirst: false, samples: samples(100, { price: (h) => (h < 50 ? 300 : 330) }) }
  const share = stayShare(step, ratio, { hours: 10, days: 9, nowTs })
  let inside = 0, count = 0
  for (let i = 0; i + 10 <= 100; i++) for (let j = i + 1; j <= i + 10; j++) { count++; if ((i < 50) === (j < 50)) inside++ }
  assert.ok(Math.abs(share - inside / count) < 1e-9, `${share} vs ${inside / count}`)
  // Too few hours to say, and hours that did not exist yet are not counted.
  assert.equal(stayShare({ wethFirst: false, samples: samples(5) }, ratio, { hours: 10, days: 9, nowTs: T0 + 5 * HOUR }), null)
  const none = samples(100); for (let h = 0; h < 95; h++) none[T0 + h * HOUR] = { ts: T0 + h * HOUR, block: h, none: true }
  assert.equal(stayShare({ wethFirst: false, samples: none }, ratio, { hours: 10, days: 9, nowTs }), null)
  // The width only: a token's decimals do not matter.
  assert.equal(stayShare(step, ratio, { hours: 10, days: 9, nowTs }), stayShare({ wethFirst: false, samples: samples(100, { dec: 18, price: (h) => (h < 50 ? 300 : 330) }) }, ratio, { hours: 10, days: 9, nowTs }))
})

const pool = (symbol, over = {}, sampleOver = {}) => ({ address: `0x${symbol}`, symbol, tickSpacing: 10, wethFirst: false, tvlUsd: 500_000, missing: 0, samples: samples(9 * 24, { feeUsdcPerHour: 1, rewardPerHour: 10n ** 22n, ...sampleOver }), ...over })

test('the list has the pools with enough money, highest first, each by what earns more', () => {
  const nowTs = T0 + 9 * 24 * HOUR
  const cache = { pools: {
    a: pool('LOWc', {}, { rewardPerHour: 10n ** 21n }), b: pool('HIGHc'), c: pool('THINc', { tvlUsd: STOCK_MIN_USD - 1 }),
    d: pool('FEEc', {}, { rewardPerHour: 0, feeUsdcPerHour: 10n ** 7n, staked: 5n * 10n ** 11n }),
  } }
  const rows = stockRows(cache, { ratio: 1.05 ** 2, myUsd: 30000, nowTs })
  assert.deepEqual(rows.map((r) => r.symbol).sort(), ['FEEc', 'HIGHc', 'LOWc'])
  assert.ok(rows.every((r, i) => i === 0 || (rows[i - 1].rate ?? -1) >= (r.rate ?? -1)))
  assert.equal(rows.find((r) => r.symbol === 'HIGHc').mode, 'staked')
  assert.equal(rows.find((r) => r.symbol === 'FEEc').mode, 'fee')
  const high = rows.find((r) => r.symbol === 'HIGHc')
  assert.equal(high.rate, Math.min(high.median, high.recent))
  assert.equal(high.in_range_72h, 1)
  assert.equal(high.stale, false)
})

test('a gauge that stopped paying is not listed as a rate for staking, and old data says so', () => {
  const nowTs = T0 + 9 * 24 * HOUR
  const rows = stockRows({ pools: { a: pool('STOPc', {}, { rewardPerHour: 0, staked: 5n * 10n ** 11n, feeUsdcPerHour: 10n ** 7n }) } }, { ratio: 1.05 ** 2, nowTs })
  assert.equal(rows[0].stopped, true)
  assert.equal(rows[0].mode, 'fee')
  const later = stockRows({ pools: { a: pool('OLDc') } }, { ratio: 1.05 ** 2, nowTs: nowTs + 5 * HOUR })
  assert.equal(later[0].stale, true)
  // No samples yet: listed, with nothing to say.
  const empty = stockRows({ pools: { a: pool('NEWc', { samples: {}, missing: 217 }) } }, { ratio: 1.05 ** 2, nowTs })
  assert.deepEqual([empty[0].rate, empty[0].mode, empty[0].days, empty[0].in_range_72h, empty[0].stale], [null, null, 0, null, true])
})

// A factory and its pools, as viem would answer: with allowFailure a failed call is a failure of each of its calls.
const revert = () => Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError' })
const nodeDown = () => new Error('HTTP 503')
function chainOf({ pools, reads = { n: 0, found: [] }, failing = () => null, onRead = () => {}, poolRead = null }) {
  const by = (a) => pools.find((p) => p.address === a)
  return {
    reads,
    readContract: async ({ functionName }) => { assert.equal(functionName, 'allPoolsLength'); return BigInt(pools.length) },
    multicall: async ({ contracts, allowFailure, blockNumber }) => {
      // readPool's own reads of a pool at a block, with or without the voter's.
      if (contracts[1]?.functionName === 'liquidity') {
        onRead({ contracts, blockNumber })
        if (poolRead) return poolRead({ contracts, blockNumber })
        return [[BigInt(Math.round(Math.sqrt(10 ** 2 / 300) * Q96))], 10n, 9n, 1n, 2n, 3n, 50n, 40n].slice(0, contracts.length).map((result) => ({ status: 'success', result }))
      }
      const down = contracts.map((c) => failing(c.functionName, c)).find(Boolean)
      if (down && !allowFailure) throw down
      return contracts.map((c) => {
        const err = failing(c.functionName, c)
        if (err) return { status: 'failure', error: err }
        const ok = (result) => (allowFailure ? { status: 'success', result } : result)
        const p = by(c.address)
        switch (c.functionName) {
          case 'allPools': reads.found.push(Number(c.args[0])); return ok(pools[Number(c.args[0])].address)
          case 'token0': return ok(p.t0)
          case 'token1': return ok(p.t1)
          case 'tickSpacing': return ok(p.tickSpacing ?? 10)
          case 'gauge': return ok(p.gauge ?? '0x0000000000000000000000000000000000000000')
          case 'slot0': return ok([BigInt(Math.round(Math.sqrt(p.raw ?? 10 ** 2 / 300) * Q96)), 0])
          case 'voter': return ok('0x00000000000000000000000000000000000000cc')
          case 'symbol': return ok(pools.find((q) => q.t1 === c.address || q.t0 === c.address).symbol)
          case 'decimals': return ok(8)
          case 'balanceOf': { const q = by(c.args[0]); return ok(c.address === USDC ? BigInt(q.usdc ?? 0) * 10n ** 6n : BigInt(q.stock ?? 0) * 10n ** 8n) }
          default: throw new Error(`unexpected ${c.functionName}`)
        }
      })
    },
  }
}
const pmap = async (xs, n, f) => { for (const x of xs) await f(x) }
const A = (n) => `0x${String(n).padStart(40, '0')}`
const stockTok = (n) => `0xb2000000${String(n).padStart(32, '0')}`
const stockPool = (n, symbol, usdc, over = {}) => ({ address: A(n), t0: USDC, t1: stockTok(n), symbol, gauge: A(900 + n), usdc, stock: 0, ...over })
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stocks-')), 'stocks.json')
const HEAD_TS = T0 + 400 * HOUR
const baseOpts = (file) => ({ chain: { compare: { factory: '0xf' }, usdc: USDC }, head: 90000, headTs: HEAD_TS, blockAt: async (t) => ({ block: (t - T0) / 2, ts: t }), priceAt: async () => ({ aero: 0.5 }), file, pmap })
const FULL = STOCK_DAYS * 24 + 1

test('the sampler finds the pools once, reads those with money in them, and keeps the window short', async () => {
  const opts = baseOpts(tmpFile())
  const chainPools = [
    stockPool(1, 'AMZNc', 2_000_000), stockPool(2, 'THINc', 1_000), { address: A(3), t0: USDC, t1: A(777), symbol: 'SOL', gauge: A(903), usdc: 9_000_000 },
    { address: A(4), t0: A(778), t1: A(779), symbol: 'WETH', gauge: A(904) }, stockPool(5, 'NOGc', 2_000_000, { gauge: undefined }), stockPool(6, 'ODDc', 2_000_000, { raw: 1e-30 }),
  ]
  const reads = { n: 0, found: [] }
  const client = chainOf({ pools: chainPools, reads, onRead: () => { reads.n++ } })
  let { cache, errors } = await sampleStockPools({ ...opts, client })
  assert.deepEqual(errors, [])
  // Each stock pool is known, the only one with money and a gauge and a sane price is read.
  assert.deepEqual(Object.values(cache.known).map((p) => p.symbol).sort(), ['AMZNc', 'NOGc', 'ODDc', 'THINc'])
  assert.deepEqual(Object.values(cache.pools).map((p) => p.symbol), ['AMZNc'])
  const e = cache.pools[A(1)]
  assert.equal(Object.keys(e.samples).length, FULL)
  assert.equal(e.missing, 0)
  assert.equal(e.wethFirst, false)
  assert.equal(e.voter, '0x00000000000000000000000000000000000000cc')
  assert.equal(e.tvlUsd, 2_000_000)
  const firstReads = reads.n
  assert.equal(firstReads, FULL)
  // Nothing asked twice: no pool looked up again, no hour read again.
  reads.found.length = 0
  ;({ cache, errors } = await sampleStockPools({ ...opts, client }))
  assert.deepEqual([reads.found.length, reads.n], [0, firstReads])
  // A new pool is looked up alone; an hour later one sample more, and the oldest ages out.
  chainPools.push(stockPool(7, 'NEWc', 200_000))
  reads.found.length = 0
  ;({ cache } = await sampleStockPools({ ...opts, client, headTs: HEAD_TS + HOUR }))
  assert.deepEqual(reads.found, [6])
  assert.equal(Object.keys(cache.pools[A(1)].samples).length, FULL)
  assert.ok(!((HEAD_TS - STOCK_DAYS * 86400) in cache.pools[A(1)].samples))
  assert.ok(A(7) in cache.pools)
})

test('money leaving for a moment changes nothing; money gone for most of a day stops the reading', async () => {
  const opts = baseOpts(tmpFile()), chainPools = [stockPool(1, 'RKLBc', 216_000)]
  const client = chainOf({ pools: chainPools })
  const at = (h) => sampleStockPools({ ...opts, client, headTs: HEAD_TS + h * HOUR })
  for (let h = 0; h < 5; h++) await at(h)
  // One reading of $62, as these pools do between two blocks: the samples and the row stay as they were.
  chainPools[0].usdc = 62
  let { cache } = await at(5)
  assert.equal(Object.keys(cache.pools[A(1)].samples).length, FULL)
  assert.equal(cache.pools[A(1)].tvlUsd, 216_000)
  assert.equal(stockRows(cache, { ratio: 1.05 ** 2, nowTs: HEAD_TS + 5 * HOUR }).length, 1)
  // Staying away: under the line it is read and not listed, and well under it, it goes.
  chainPools[0].usdc = STOCK_KEEP_USD + 1
  for (let h = 6; h < 30; h++) ({ cache } = await at(h))
  assert.ok(A(1) in cache.pools)
  assert.equal(stockRows(cache, { ratio: 1.05 ** 2, nowTs: HEAD_TS + 29 * HOUR }).length, 0)
  chainPools[0].usdc = 62
  for (let h = 30; h < 55 && A(1) in cache.pools; h++) ({ cache } = await at(h))
  assert.ok(!(A(1) in cache.pools))
  assert.ok(A(1) in cache.known)
  // A pool just found stands on its best reading until it has a few, even if a second run of its first hour
  // reads $62 and its second hour too; a price that means nothing counts as no money, and for long enough ends it.
  chainPools[0].usdc = 216_000
  ;({ cache } = await at(60))
  assert.ok(A(1) in cache.pools)
  chainPools[0].usdc = 62
  ;({ cache } = await at(60))
  assert.equal(cache.pools[A(1)].tvlUsd, 216_000)
  ;({ cache } = await at(61))
  assert.equal(cache.pools[A(1)].tvlUsd, 216_000)
  assert.equal(stockRows(cache, { ratio: 1.05 ** 2, nowTs: HEAD_TS + 61 * HOUR }).length, 1)
  chainPools[0].usdc = 216_000; chainPools[0].raw = 1e-30
  for (let h = 62; h < 66; h++) ({ cache } = await at(h))
  assert.ok(!(A(1) in cache.pools))
  // Readings do not run out while nothing runs: a day without runs is not taken for a day without money.
  delete chainPools[0].raw
  for (let h = 70; h < 80; h++) ({ cache } = await at(h))
  chainPools[0].usdc = 62
  ;({ cache } = await at(120))
  assert.equal(cache.pools[A(1)].tvlUsd, 216_000)
})

test('a node refusing a token\'s symbol is asked again; a token refusing it is no stock', async () => {
  const opts = baseOpts(tmpFile()), chainPools = [stockPool(1, 'AMZNc', 2_000_000)]
  let { cache, errors } = await sampleStockPools({ ...opts, client: chainOf({ pools: chainPools, failing: (fn) => (fn === 'symbol' ? nodeDown() : null) }) })
  assert.equal(errors.length, 1)
  assert.equal(cache.scanned, 0)
  assert.deepEqual(cache.known, {})
  ;({ cache, errors } = await sampleStockPools({ ...opts, client: chainOf({ pools: chainPools }) }))
  assert.deepEqual(errors, [])
  assert.equal(cache.scanned, 1)
  assert.ok(A(1) in cache.pools)
  const other = baseOpts(tmpFile())
  ;({ cache, errors } = await sampleStockPools({ ...other, client: chainOf({ pools: chainPools, failing: (fn) => (fn === 'symbol' ? revert() : null) }) }))
  assert.deepEqual(errors, [])
  assert.equal(cache.scanned, 1)
  assert.deepEqual(cache.known, {})
})

test('a symbol that cannot be decoded is no stock; a whole call failing, however it looks, is the node\'s', async () => {
  const chainPools = [stockPool(1, 'AMZNc', 2_000_000)]
  // A token keeping its symbol as bytes32, as MKR does, as viem reports it.
  const bytes32 = () => Object.assign(new Error('Number is not in safe integer range'), { name: 'IntegerOutOfRangeError', functionName: 'symbol' })
  let r = await sampleStockPools({ ...baseOpts(tmpFile()), client: chainOf({ pools: chainPools, failing: (fn) => (fn === 'symbol' ? bytes32() : null) }) })
  assert.deepEqual(r.errors, [])
  assert.equal(r.cache.scanned, 1)
  assert.deepEqual(r.cache.known, {})
  // viem turns a node's -32603 on the whole call into what looks like every call's revert.
  const opts = baseOpts(tmpFile())
  const whole = () => Object.assign(new Error('execution reverted'), { name: 'ContractFunctionRevertedError', functionName: 'aggregate3' })
  r = await sampleStockPools({ ...opts, client: chainOf({ pools: chainPools, failing: (fn) => (fn === 'symbol' ? whole() : null) }) })
  assert.equal(r.errors.length, 1)
  assert.equal(r.cache.scanned, 0)
  r = await sampleStockPools({ ...opts, client: chainOf({ pools: chainPools }) })
  assert.ok(A(1) in r.cache.known)
})

test('a token with the right name and no decimals holds nothing up', async () => {
  const opts = baseOpts(tmpFile())
  const chainPools = [stockPool(1, 'AMZNc', 2_000_000), { address: A(2), t0: USDC, t1: A(778), symbol: 'wtSPAM', gauge: A(902), usdc: 9_000_000 }]
  const client = chainOf({ pools: chainPools, failing: (fn, c) => (fn === 'decimals' && c.address === A(778) ? revert() : null) })
  const { cache, errors } = await sampleStockPools({ ...opts, client })
  assert.deepEqual(errors, [])
  assert.equal(cache.scanned, 2)
  assert.deepEqual(Object.values(cache.known).map((p) => p.symbol), ['AMZNc'])
  assert.ok(A(1) in cache.pools)
})

test('a pool waits for its voter rather than take samples the rates would be wrong from', async () => {
  const opts = baseOpts(tmpFile()), chainPools = [stockPool(1, 'AMZNc', 2_000_000)]
  let n = 0
  let r = await sampleStockPools({ ...opts, client: chainOf({ pools: chainPools, onRead: () => { n++ }, failing: (fn) => (fn === 'voter' ? nodeDown() : null) }) })
  assert.equal(r.errors.length, 1)
  assert.equal(n, 0)
  assert.ok(!(A(1) in r.cache.pools))
  r = await sampleStockPools({ ...opts, client: chainOf({ pools: chainPools }) })
  assert.equal(r.cache.pools[A(1)].voter, '0x00000000000000000000000000000000000000cc')
  assert.ok(Object.values(r.cache.pools[A(1)].samples).every((s) => s.share === '50'))
  // A gauge replaced: the new one's voter is asked for, and what was read stays.
  chainPools[0].gauge = A(555)
  const voters = []
  r = await sampleStockPools({ ...opts, client: chainOf({ pools: chainPools, failing: (fn, c) => { if (fn === 'voter') voters.push(c.address); return null } }) })
  assert.deepEqual([...new Set(voters)], [A(555)])
  assert.equal(r.cache.pools[A(1)].gauge, A(555))
  assert.equal(Object.keys(r.cache.pools[A(1)].samples).length, FULL)
})

test('a node that fails costs nothing but the hours it failed, and a pool it cannot read keeps its samples', async () => {
  const opts = baseOpts(tmpFile()), chainPools = [stockPool(1, 'AMZNc', 2_000_000)]
  const good = chainOf({ pools: chainPools })
  // Out of time: what was read is kept, and what is missing counted.
  let n = 0
  let r = await sampleStockPools({ ...opts, client: chainOf({ pools: chainPools, onRead: () => { n++ } }), deadline: Date.now() - 1 })
  assert.equal(n, 0)
  assert.equal(r.cache.pools[A(1)].missing, FULL)
  // One hour's read fails: reported and not stored, the rest read, and it is read next run.
  const bad = T0 + 395 * HOUR
  r = await sampleStockPools({ ...opts, client: chainOf({ pools: chainPools, poolRead: ({ contracts, blockNumber }) => {
    if (Number(blockNumber) === (bad - T0) / 2) throw new Error('HTTP 429')
    return [[BigInt(Math.round(Math.sqrt(10 ** 2 / 300) * Q96))], 10n, 9n, 1n, 2n, 3n, 50n, 40n].slice(0, contracts.length).map((result) => ({ status: 'success', result }))
  } }) })
  assert.equal(r.errors.length, 1)
  assert.equal(r.cache.pools[A(1)].missing, 1)
  assert.ok(!(bad in r.cache.pools[A(1)].samples))
  r = await sampleStockPools({ ...opts, client: good })
  assert.equal(r.cache.pools[A(1)].missing, 0)
  // The node refuses everything: reported, not thrown, and every sample is still there.
  const down = { readContract: async () => { throw nodeDown() }, multicall: async ({ contracts }) => contracts.map(() => ({ status: 'failure', error: nodeDown() })) }
  r = await sampleStockPools({ ...opts, client: down })
  assert.equal(r.errors.length, 1)
  assert.equal(Object.keys(r.cache.pools[A(1)].samples).length, FULL)
  // Finding new pools fails: the known ones are still read.
  let reads = 0
  r = await sampleStockPools({ ...opts, headTs: HEAD_TS + HOUR, client: { ...chainOf({ pools: chainPools, onRead: () => { reads++ } }), readContract: async () => { throw nodeDown() } } })
  assert.equal(r.errors.length, 1)
  assert.equal(reads, 1)
  // Any of a pool's reads failing this run, its gauge alone included: it is not dropped for that.
  for (const fn of ['slot0', 'gauge']) {
    r = await sampleStockPools({ ...opts, client: chainOf({ pools: chainPools, failing: (f) => (f === fn ? nodeDown() : null) }) })
    assert.equal(Object.keys(r.cache.pools[A(1)].samples).length, FULL, fn)
    assert.equal(r.errors.length, 1, fn)
  }
  // An hour before the pool existed is recorded as such, and not asked again.
  const fresh = baseOpts(tmpFile())
  const noPool = ({ contracts }) => contracts.map(() => ({ status: 'failure', error: Object.assign(new Error('returned no data ("0x")'), { name: 'ContractFunctionZeroDataError' }) }))
  r = await sampleStockPools({ ...fresh, client: chainOf({ pools: chainPools, poolRead: noPool }) })
  assert.ok(Object.values(r.cache.pools[A(1)].samples).every((s) => s.none))
  n = 0
  r = await sampleStockPools({ ...fresh, client: chainOf({ pools: chainPools, onRead: () => { n++ } }) })
  assert.equal(n, 0)
  // A broken cache file starts over.
  fs.writeFileSync(opts.file, '{not json')
  r = await sampleStockPools({ ...opts, client: good })
  assert.equal(r.cache.scanned, 1)
})

test('a pool no longer read says since when, and goes below those that are', () => {
  const nowTs = T0 + 9 * 24 * HOUR
  const old = pool('OLDc', { samples: samples(9 * 24 - 10, { feeUsdcPerHour: 1, rewardPerHour: 10n ** 23n }) }), fresh = pool('NOWc')
  const rows = stockRows({ pools: { a: old, b: fresh } }, { ratio: 1.05 ** 2, nowTs })
  assert.deepEqual(rows.map((r) => r.symbol), ['NOWc', 'OLDc'])
  assert.ok(rows[0].rate < stockRows({ pools: { a: old } }, { ratio: 1.05 ** 2, nowTs })[0].rate)
  assert.equal(rows[1].stale, true)
  assert.equal(rows[1].age_h, 10)
  assert.equal(rows[1].last_sample, new Date((T0 + (9 * 24 - 10) * HOUR + 8 * 3600) * 1000).toISOString().slice(0, 16).replace('T', ' '))
})
