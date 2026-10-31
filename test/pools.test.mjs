import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dollarsPerL, poolStats, samplePools, blockFinder } from '../lib/pools.mjs'
import { usdCurve, amountsAtUsd } from '../lib/curve.mjs'
import { evaluate } from '../lib/alerts.mjs'

const Q96 = 2 ** 96, Q128 = 2n ** 128n, HOUR = 3600, YEAR = 365 * 86400
const W = '0xweth', U = '0xusdc'
const kind = { eth: (a) => a === W, usd: (a) => a === U }

test('dollars per unit of liquidity match the curve of a real centred range', () => {
  for (const [P, ratio] of [[2385, 2519.992111 / 2257.507369], [3000, 1.5], [1500, 1.02]]) {
    const low = P / Math.sqrt(ratio), high = P * Math.sqrt(ratio), tick = (raw) => Math.log(raw) / Math.log(1.0001)
    const x = { token0: W, token1: U, tickLower: tick(low * 1e-12), tickUpper: tick(high * 1e-12), liquidity: 10n ** 16n, sqrtP: BigInt(Math.round(Math.sqrt(P * 1e-12) * Q96)), fees0: 0n, fees1: 0n }
    const [e, u] = amountsAtUsd(usdCurve(x, kind), P)
    const usd = e * P + u
    assert.ok(Math.abs(dollarsPerL(P, ratio) * 1e16 - usd) / usd < 1e-6, `${P} ${ratio}: ${dollarsPerL(P, ratio) * 1e16} vs ${usd}`)
  }
})

// Hourly samples of a pool whose price stays at P, paying `rewardApr` to staked and `feeApr` to unstaked
// liquidity for a range of `ratio`, AERO at $0.5. Growth per unit of liquidity is what makes those rates.
const T0 = Date.parse('2026-10-20T16:00:00Z') / 1000 // 10-21 00:00 Beijing
// The voter streams exactly what the staked liquidity (constant here) is credited, so the liquidity the
// rewards were shared by is the staked liquidity itself.
function pool({ P = 2400, ratio = 1.12, rewardApr = 1, feeApr = 0.5, hours = 24 * 5, wethFirst = true, staked = 9n * 10n ** 18n, liq = 10n ** 19n, gapAt = null } = {}) {
  const perL = dollarsPerL(P, ratio)
  const rgPerSec = (rewardApr * perL) / YEAR / 0.5 * 1e18 // AERO wei per unit of liquidity per second
  const feeUsdPerSec = (feeApr * perL) / YEAR // dollars per unit of liquidity per second, half in each token
  const sqrtP = BigInt(Math.round((wethFirst ? Math.sqrt(P * 1e-12) : Math.sqrt(1e12 / P)) * Q96))
  const samples = {}
  for (let h = 0; h <= hours; h++) {
    if (gapAt && h >= gapAt[0] && h < gapAt[1]) continue
    const t = T0 + h * HOUR, s = h * HOUR
    const ethWei = BigInt(Math.round(((feeUsdPerSec / 2) * s) / P * 1e18 * 2 ** 64)) * 2n ** 64n
    const usdUnits = BigInt(Math.round(((feeUsdPerSec / 2) * s) * 1e6 * 2 ** 64)) * 2n ** 64n
    const rg = BigInt(Math.round(rgPerSec * s * 2 ** 64)) * 2n ** 64n
    samples[t] = { ts: t, block: h, sqrtP: sqrtP.toString(), liq: liq.toString(), staked: staked.toString(), aero: 0.5, eth: P,
      rg: rg.toString(), share: ((rg * staked) / Q128).toString(), unsettled: '0',
      fg0: (wethFirst ? ethWei : usdUnits).toString(), fg1: (wethFirst ? usdUnits : ethWei).toString() }
  }
  return { chain: 'base', address: '0xpool', wethFirst, tickSpacing: 100, samples }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b))

test('a pool paying steady rates reads back those rates, in either token order', () => {
  for (const wethFirst of [true, false]) {
    const s = poolStats(pool({ wethFirst }), { ratio: 1.12, nowTs: T0 + 5 * 86400 + 600 })
    assert.equal(s.days, 5)
    for (const f of ['median', 'p25', 'mean7']) assert.ok(near(s.staked[f], 1) && near(s.fee[f], 0.5), `${wethFirst} ${f}: ${s.staked[f]} ${s.fee[f]}`)
    // A week's emissions a day: the reward the staked liquidity was credited, in tokens.
    const perDay = (1 * dollarsPerL(2400, 1.12)) / YEAR / 0.5 * 86400 * 9e18
    for (const w of s.weeks) assert.ok(near(w.emitted_day, perDay, 1e-4), `${w.emitted_day} ${perDay}`)
  }
})

test('a wider range earns less per dollar, by the dollars a unit of liquidity holds', () => {
  const e = pool({ ratio: 1.12 })
  const narrow = poolStats(e, { ratio: 1.12, nowTs: T0 + 6 * 86400 }), wide = poolStats(e, { ratio: 1.5, nowTs: T0 + 6 * 86400 })
  assert.ok(near(wide.staked.median / narrow.staked.median, dollarsPerL(2400, 1.12) / dollarsPerL(2400, 1.5)))
})

test('the owners\' money is shared with the pool, but what is already in it is not added again', () => {
  const e = pool(), myUsd = 1e6, myL = myUsd / dollarsPerL(2400, 1.12), nowTs = T0 + 6 * 86400
  const out = poolStats(e, { ratio: 1.12, myUsd, nowTs })
  assert.ok(near(out.staked.median, 9e18 / (9e18 + myL)) && near(out.fee.median, 0.5 * (1e19 / (1e19 + myL))))
  // All of it staked here already: it is in the staked total and in all the liquidity.
  const staked = poolStats(e, { ratio: 1.12, myUsd, inStakedUsd: myUsd, inPoolUsd: myUsd, nowTs })
  assert.ok(near(staked.staked.median, 1) && near(staked.fee.median, 0.5))
  // Here unstaked: staking it adds it to the staked total; the fees already count it.
  const unstaked = poolStats(e, { ratio: 1.12, myUsd, inPoolUsd: myUsd, nowTs })
  assert.ok(near(unstaked.staked.median, 9e18 / (9e18 + myL)) && near(unstaked.fee.median, 0.5))
  // Half of it staked here, half elsewhere or idle: only that half is added.
  const half = poolStats(e, { ratio: 1.12, myUsd, inStakedUsd: myUsd / 2, inPoolUsd: myUsd / 2, nowTs })
  assert.ok(near(half.staked.median, 9e18 / (9e18 + myL / 2)) && near(half.fee.median, 0.5 * (1e19 / (1e19 + myL / 2))))
})

test('hours with no unstaked liquidity in range leave the fee rate out, not at nothing; old days age out', () => {
  const nowTs = T0 + 6 * 86400
  const all = poolStats(pool({ liq: 9n * 10n ** 18n }), { ratio: 1.12, nowTs }) // every bit staked
  assert.equal(all.fee.median, null)
  assert.ok(near(all.staked.median, 1))
  const some = pool()
  for (const [t, x] of Object.entries(some.samples)) if (((Number(t) - T0) / HOUR) % 24 < 12) x.liq = x.staked
  assert.ok(near(poolStats(some, { ratio: 1.12, nowTs }).fee.median, 0.5, 1e-6))
  // Read 40 days later with nothing new: no day is within the window any more.
  assert.equal(poolStats(pool(), { ratio: 1.12, nowTs: T0 + 40 * 86400 }).days, 0)
})

test('the liquidity an hour\'s rewards were shared by is its emissions over the reward per unit', () => {
  // The voter streamed a fifth of what snapshot liquidity times growth would give: the rewards went to
  // moments with a fifth of the liquidity, so the owners' money takes a bigger share of them.
  const e = pool(), myUsd = 1e6, myL = myUsd / dollarsPerL(2400, 1.12), nowTs = T0 + 6 * 86400
  for (const x of Object.values(e.samples)) x.share = (BigInt(x.share) / 5n).toString()
  const out = poolStats(e, { ratio: 1.12, myUsd, nowTs })
  assert.ok(near(out.staked.median, 1.8e18 / (1.8e18 + myL), 1e-4), `${out.staked.median}`)
  assert.ok(near(out.fee.median, 0.5 * (2e18 / (2e18 + myL)), 1e-4), `${out.fee.median}`)
})

test('rewards streamed but not yet credited count; an hour the price leaves the range earns nothing', () => {
  const nowTs = T0 + 6 * 86400
  // Half of each hour's reward still uncredited at every sample: the rates are unchanged.
  const lag = pool()
  for (const x of Object.values(lag.samples)) {
    const half = BigInt(x.rg) / 2n
    x.rg = (BigInt(x.rg) - half).toString(); x.unsettled = ((half * BigInt(x.staked)) / Q128).toString()
  }
  assert.ok(near(poolStats(lag, { ratio: 1.12, nowTs }).staked.median, 1, 1e-4))
  // One hour a day the pool price jumps 20% (the market does not): those hours earn nothing.
  const jump = pool()
  for (const [t, x] of Object.entries(jump.samples)) if (((Number(t) - T0) / HOUR) % 24 === 5) x.sqrtP = BigInt(Math.round(Math.sqrt(2880 * 1e-12) * Q96)).toString()
  const j = poolStats(jump, { ratio: 1.12, nowTs })
  assert.ok(near(j.staked.median, 22 / 24, 1e-3) && near(j.fee.median, 22 / 24 * 0.5, 2e-2), `${j.staked.median} ${j.fee.median}`)
  // ETH is valued at the reference price, not at a pool price that has drifted from it.
  const drift = pool({ P: 2400 })
  for (const x of Object.values(drift.samples)) x.eth = 2400 * 0.9
  const d = poolStats(drift, { ratio: 1.12, nowTs })
  assert.ok(near(d.staked.median, dollarsPerL(2400, 1.12) / dollarsPerL(2400, 1.12, 2160), 1e-4))
})

test('a gauge that has paid nothing for hours is seen as stopped', () => {
  const nowTs = T0 + 6 * 86400, e = pool()
  const ts = Object.keys(e.samples).map(Number).sort((a, b) => a - b), frozen = e.samples[ts.at(-5)]
  for (const t of ts.slice(-4)) Object.assign(e.samples[t], { rg: frozen.rg, share: frozen.share })
  assert.equal(poolStats(e, { ratio: 1.12, nowTs }).quietHours, 4)
  assert.equal(poolStats(pool(), { ratio: 1.12, nowTs }).quietHours, 0)
})

test('days are Beijing days; today and days missing hours do not count, a gap is skipped', () => {
  // Hours 30-39 missing: day 2 (hours 24-48) keeps 13 of 24 hours and drops out of the statistics.
  const s = poolStats(pool({ hours: 24 * 4 + 5, gapAt: [30, 40] }), { ratio: 1.12, nowTs: T0 + 4 * 86400 + 5 * HOUR })
  assert.deepEqual(s.daily.map((d) => d.day), ['2026-10-21', '2026-10-23', '2026-10-24'])
  assert.ok(near(s.staked.median, 1))
  // Aero weeks start on Thursday 00:00 UTC (Thursday 08:00 Beijing): 10-22 is one.
  assert.deepEqual(s.weeks.map((w) => w.start), ['2026-10-15', '2026-10-22'])
})

test('the sampler fills missing hours newest first, keeps pools apart, and records hours before a pool existed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pools-')), file = path.join(dir, 'pools.json')
  const created = 1000 // blocks before this have no pool
  const headTs = T0 + 50 * HOUR
  let reads = 0
  const fakeClient = {
    getGasPrice: async () => 5n * 10n ** 9n,
    readContract: async ({ functionName }) => { assert.equal(functionName, 'tickSpacings'); return [50, 100] },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(T0 + Number(blockNumber) * 2) }),
    multicall: async ({ contracts, blockNumber, allowFailure }) => {
      const fn = contracts[0].functionName
      if (fn === 'getPool') { assert.equal(allowFailure, false); return contracts.map((c) => (c.args[2] === 100 ? '0x00000000000000000000000000000000000000aa' : '0x0000000000000000000000000000000000000000')) }
      if (fn === 'gauge') return ['0x00000000000000000000000000000000000000bb', W, 10n ** 18n, 2000n * 10n ** 6n]
      if (fn === 'voter') return ['0x00000000000000000000000000000000000000cc']
      reads++
      assert.equal(contracts.length, 8)
      assert.deepEqual(contracts[6].args, ['0x00000000000000000000000000000000000000bb'])
      if (Number(blockNumber) < created) return contracts.map(() => ({ status: 'failure', error: Object.assign(new Error('returned no data ("0x")'), { name: 'ContractFunctionZeroDataError' }) }))
      return [[123n * 2n ** 90n], 10n, 9n, 1n, 2n, 3n, 50n, 40n].map((result) => ({ status: 'success', result }))
    },
  }
  const chain = { key: 'base', weth: W, usdc: U, compare: { factory: '0xf' } }
  const blockAt = async (t) => ({ block: (t - T0) / 2, ts: t })
  const pmap = async (xs, n, f) => { for (const x of xs) await f(x) }
  const run = (maxNew) => samplePools({ chains: [{ chain, client: fakeClient, head: 90000, headTs, blockAt }], priceAt: async () => ({ aero: 0.5, eth: 2400 }), file, maxNew, pmap })
  let { cache, errors } = await run(10)
  assert.deepEqual(errors, [])
  const e = cache.pools['base:0x00000000000000000000000000000000000000aa']
  assert.equal(e.tickSpacing, 100)
  assert.equal(Object.keys(e.samples).length, 10)
  assert.equal(Math.max(...Object.keys(e.samples).map(Number)), headTs) // newest first
  ;({ cache } = await run(10000))
  const all = cache.pools['base:0x00000000000000000000000000000000000000aa'].samples
  assert.equal(Object.keys(all).length, 29 * 24 + 1) // the window and a day more, on the hour
  assert.ok(Object.values(all).some((s) => s.none) && Object.values(all).some((s) => !s.none))
  const real = Object.values(all).find((s) => !s.none)
  assert.deepEqual([real.share, real.unsettled, real.aero, real.eth], ['50', '10', 0.5, 2400])
  const before = reads
  await run(10000)
  assert.equal(reads, before) // nothing asked twice, not even the hours before the pool existed
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).gas.base.wei, String(5n * 10n ** 9n))
  assert.equal(cache.pools['base:0x00000000000000000000000000000000000000aa'].missing, 0)
  const key = 'base:0x00000000000000000000000000000000000000aa', newest = String(headTs)
  // A node that fails finding the pools: the error is reported and every sample is kept.
  const flaky = { ...fakeClient, multicall: async (args) => { if (args.contracts[0].functionName === 'getPool') throw new Error('HTTP 503'); return fakeClient.multicall(args) } }
  let r = await samplePools({ chains: [{ chain, client: flaky, head: 90000, headTs, blockAt }], priceAt: async () => ({ aero: 0.5, eth: 2400 }), file, pmap })
  assert.equal(r.errors.length, 1)
  assert.equal(Object.keys(r.cache.pools[key].samples).length, 29 * 24 + 1)
  // A node that fails reading an hour: nothing is stored for it (it is read next run), the error is reported.
  delete r.cache.pools[key].samples[newest]; fs.writeFileSync(file, JSON.stringify(r.cache))
  const failing = { ...fakeClient, multicall: async (args) => (args.contracts[0].functionName === 'slot0' ? args.contracts.map(() => ({ status: 'failure', error: new Error('HTTP 429') })) : fakeClient.multicall(args)) }
  r = await samplePools({ chains: [{ chain, client: failing, head: 90000, headTs, blockAt }], priceAt: async () => ({ aero: 0.5, eth: 2400 }), file, pmap })
  assert.equal(r.errors.length, 1)
  assert.ok(!(newest in r.cache.pools[key].samples))
  // A 'none' after the pool's first real sample (an earlier version stored failed reads so) is read again.
  r.cache.pools[key].samples[newest] = { ts: headTs, block: 1, none: true }; fs.writeFileSync(file, JSON.stringify(r.cache))
  r = await run(10000)
  assert.ok(!r.cache.pools[key].samples[newest].none)
})

test('a block is found near a time from the head and the average block time', async () => {
  // Blocks every 12 s with every 10th slot missed: the guess drifts, the correction finds it.
  const tsOf = (b) => 1e9 + Math.floor(b * 12 * 10 / 9)
  const client = { getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(tsOf(Number(blockNumber))) }) }
  const head = 200000, find = blockFinder(client, head, tsOf(head), 12)
  for (const t of [tsOf(head) - 3600, tsOf(head) - 28 * 86400, tsOf(10)]) {
    const { block, ts } = await find(t)
    assert.equal(ts, tsOf(block))
    assert.ok(Math.abs(ts - t) <= 14, `${t}: ${ts}`)
  }
})

// A summary row with two pools and a switch suggestion (to the better one) as src/run.mjs publishes it;
// the money now earns `current`, unstaked in the Ethereum pool.
const sw = ({ eth = 1.7, arb = 1.0, current = 0.6, complete = true, ...extra } = {}) => {
  const pools = [{ chain: 'eth', label: 'CL50', staked: { median: eth }, fee: { median: current } }, { chain: 'arb', label: 'CL100', staked: { median: arb }, fee: { median: 0.4 } }]
  const to = eth >= arb ? { chain: 'eth', chain_label: '以太坊', label: 'CL50', median: eth, tracked: true } : { chain: 'arb', chain_label: 'Arbitrum', label: 'CL100', median: arb, tracked: false }
  return { scope: 'a', scope_label: 'A', curve: { positions: [] }, pool_compare: { complete, pools, switch: {
    to: { mode: 'staked', p25: to.median - 0.2, days: 10, ...to }, from: [{ chain: 'eth', chain_label: '以太坊', label: 'CL50', mode: 'fee', usd: 28000, rate: current }],
    current, here: false, gap: to.median - current, extra_day_usd: 84, cost_usd: 0.5, payback_days: 0.01, stable: true, ...extra } } }
}
const total = { scope: 'total', scope_label: '合计', curve: { positions: [] } }

test('a better place for the money is said once, again only for another one, and not on old data', () => {
  const kinds = (rows, prev, opts) => { const r = evaluate([rows, total], prev, opts); return [r.messages.map((m) => m.kind), r.state, r.messages] }
  let [k, state, messages] = kinds(sw(), {})
  assert.deepEqual(k, ['switch'])
  assert.match(messages[0].title, /以太坊 CL50 质押/)
  assert.match(messages[0].message, /不到 0\.1 天回本/)
  ;[k, state] = kinds(sw({ eth: 0.75, arb: 0.5 }), state) // its lead shrank to 15 points, above half the gap
  assert.deepEqual(k, [])
  assert.equal(state['a:switch'], 'eth:CL50:staked')
  ;[k, state] = kinds(sw({ eth: 0.65, arb: 0.5 }), state) // the lead is gone
  assert.equal(state['a:switch'], 'none')
  ;[k, state] = kinds(sw(), state)
  assert.deepEqual(k, ['switch'])
  // Another pool takes the lead: said once; then the two trading places says nothing more.
  ;[k, state, messages] = kinds(sw({ arb: 1.9 }), state)
  assert.deepEqual(k, ['switch'])
  assert.match(messages[0].message, /只追踪 Base 和以太坊/)
  for (const x of [{ eth: 1.95, arb: 1.9 }, { arb: 2.0, eth: 1.95 }, { eth: 2.1, arb: 2.0 }]) { [k, state] = kinds(sw(x), state); assert.deepEqual(k, [], JSON.stringify(x)) }
  // While pools are still being read: say nothing and keep what was said.
  ;[k] = kinds(sw({ arb: 3, complete: false }), state)
  assert.deepEqual(k, [])
  assert.equal(evaluate([sw({ complete: false }), total], state).state['a:switch'], state['a:switch'])
  // Not stable, too little data, too slow to pay back, already there, or the gain unknown: nothing.
  for (const x of [{ stable: false }, { to: { ...sw().pool_compare.switch.to, days: 5 } }, { payback_days: 4 }, { here: true }, { gap: null, payback_days: null }]) {
    assert.deepEqual(evaluate([sw(x), total], { 'a:switch': 'none' }).messages, [], JSON.stringify(x))
  }
  // From the last good summary while the update fails: wait.
  assert.deepEqual(evaluate([sw(), total], { 'a:switch': 'none' }, { lastGood: true }).messages, [])
})
