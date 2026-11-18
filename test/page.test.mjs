// The page keeps its own copies of a few lib functions (it loads no modules): each copy sits between
// /* name:start */ and /* name:end */ markers in dashboard/index.html, and must give exactly what the lib
// function gives, so the page and the phone alerts never say different things. Invented figures only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { recentre } from '../lib/curve.mjs'
import { putBackRates, evaluate } from '../lib/alerts.mjs'

const page = fs.readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8')
// The function `name` that the blocks marked `markers` define, built on their own (the blocks may use
// nothing else of the page).
function pageFn(markers, name) {
  const code = [markers].flat().map((marker) => {
    const start = `/* ${marker}:start */`, end = `/* ${marker}:end */`
    const a = page.indexOf(start), b = page.indexOf(end)
    assert.ok(a >= 0 && b > a && page.indexOf(start, a + 1) < 0 && page.indexOf(end, b + 1) < 0, `one ${marker} block in the page`)
    return page.slice(a + start.length, b)
  })
  return new Function(`${code.join('\n')}; return ${name};`)()
}
// A fixed sequence of pseudo-random numbers in [0, 1), so a failure can be repeated.
function rng(seed) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

test('the page\'s recentre is lib/curve.mjs recentre', () => {
  const mine = pageFn('recentre', 'recentre'), rand = rng(20261118)
  let n = 0
  for (const invert of [false, true]) {
    for (const spacing of [undefined, null, 0, 1, 10, 50, 100, 200]) {
      for (let k = 0; k < 200; k++) {
        const P = 900 + rand() * 6000, W = [40, 120, 300, 520, 1400][k % 5]
        const t = Math.round(Math.log(invert ? 1e12 / P : P / 1e12) / Math.log(1.0001)) + Math.round((rand() - 0.5) * 4000)
        const pos = { tick_lower: t, tick_upper: t + W, invert, low: 1000, high: 1100 }, at = P * (0.8 + rand() * 0.4)
        assert.deepEqual(mine(pos, at, spacing), recentre(pos, at, spacing), JSON.stringify({ pos, at, spacing }))
        n++
      }
    }
  }
  // Without usable ticks: the position's own width, off the grid.
  for (const pos of [{ low: 2000, high: 2240 }, { tick_lower: 5, tick_upper: 5, low: 1800, high: 1900 }, { tick_lower: 1.5, tick_upper: 300, low: 1800, high: 1900 }]) {
    assert.deepEqual(mine(pos, 2111, 50), recentre(pos, 2111, 50), JSON.stringify(pos))
    n++
  }
  assert.equal(n, 2 * 8 * 200 + 3)
})

test('the page\'s putBackRates is lib/alerts.mjs putBackRates', () => {
  const mine = pageFn('putback', 'putBackRates')
  const rates = [undefined, null, Number.NaN, 0, 0.5, 1.2, 2.04]
  const rows = [null, undefined, {}, { fixed: null }, { fixed: {} }]
  for (const here of [undefined, null, 'staked', 'unstaked', 'other']) {
    for (const stopped of [undefined, false, true]) {
      for (const staked of rates) {
        for (const fee of rates) rows.push({ here, stopped, label: 'CL50', fixed: { staked: { median: staked, recent: 0.9 }, fee: { median: fee } } })
      }
    }
  }
  const lines = [null, undefined, {}, { rate: null }, { rate: Number.NaN }, { rate: 0.5 }, { rate: 1.2 }, { rate: 1.5 }]
  for (const row of rows) for (const line of lines) assert.deepEqual(mine(row, line), putBackRates(row, line), JSON.stringify({ row, line }))
})

// A range out for a day, on the page and on the phone. Invented figures: ETH at 2,300 in two pools, two
// wallets each with a range above the price and one below it, every table drawn at random.
const P = 2300, T = Math.round(Math.log(P / 1e12) / Math.log(1.0001)), cents = (v) => Math.round(v * 100) / 100
const POOLS = ['0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000b2']
function outRange(wallet, side, k, pool) {
  const W = [200, 400, 600][k % 3], lower = side === 'below' ? T + 50 + 10 * k : T - 50 - 10 * k - W, upper = lower + W
  const low = 1e12 * 1.0001 ** lower, high = 1e12 * 1.0001 ** upper, sa = Math.sqrt(low * 1e-12), sb = Math.sqrt(high * 1e-12)
  return { wallet, low: cents(low), high: cents(high), pool: P, in_range: false, pool_address: pool, tick_lower: lower, tick_upper: upper, L: 1e15, sa, sb, chain: 'base', invert: false }
}
const tableOf = (pick) => ({ fixed_label: '±3.5%', cost_line: pick([null, { days: 7, vol: 0.5, rate: 1.1 }, { days: 7, vol: 0.5, rate: 1.1 }, { days: 7, vol: 0.5, rate: 0.9 }]),
  pools: POOLS.map((pool_address) => ({ chain: 'base', pool_address, label: pick(['CL100', 'CL50', 'CL1', undefined]), here: pick([undefined, 'staked', 'unstaked']), stopped: pick([undefined, false, true]),
    fixed: { staked: { median: pick([null, 0.7, 1.0, 1.3, 1.8]) }, fee: { median: pick([null, 0.4, 1.2]) } } })) })
const walletRow = (scope, label, positions, pool_compare) => ({ scope, scope_label: label, eth_usd: P, now_cost_eth_price: null, curve: { eth: 0, usd: 0, positions }, pool_compare })
// The phone's day-out message for each range of the wallets, its clock started 25 hours ago.
function dayOutMessages(wallets, total) {
  const t0 = Date.UTC(2026, 10, 10), prev = { update: 'ok' }
  for (const w of wallets) {
    prev[`${w.scope}:cost`] = 'na'
    for (const p of w.curve.positions) { const k = `${w.scope}:${p.low}-${p.high}`; prev[k] = p.tick_lower > T ? 'below' : 'above'; prev[`${k}:out`] = String(t0) }
  }
  const { messages } = evaluate([...wallets, total], prev, { now: t0 + 25 * 3600e3 })
  return new Map(messages.filter((m) => m.kind === 'out24').map((m) => [m.key, m.message]))
}
const dollars = (s) => Number(s.replace(/[$,]/g, ''))

test('a range out for a day is judged by its own wallet\'s table, on its own view and on the total view, as its phone alert judges it', () => {
  const outVerdict = pageFn(['putback', 'outline'], 'outVerdict'), recentreOf = pageFn('recentre', 'recentre'), rand = rng(1118)
  const pick = (xs) => xs[Math.floor(rand() * xs.length)]
  const seen = {}
  let n = 0, viewTableDiffers = 0
  for (let c = 0; c < 600; c++) {
    const wallets = [['a', '甲'], ['b', '乙']].map(([key, label], i) => walletRow(key, label, [outRange(label, 'below', 2 * i, pick(POOLS)), outRange(label, 'above', 2 * i + 1, pick(POOLS))], tableOf(pick)))
    const total = walletRow('total', '合计', wallets.flatMap((w) => w.curve.positions.map((p) => ({ ...p }))), tableOf(pick))
    const rows = [...wallets, total], said = dayOutMessages(wallets, total)
    for (const w of wallets) {
      for (const p of w.curve.positions) {
        const m = said.get(`${w.scope}:${p.low}-${p.high}:out`) ?? assert.fail(`no day-out for ${w.scope}`)
        const mine = outVerdict(rows, w, p), onTotal = outVerdict(rows, total, total.curve.positions.find((q) => q.wallet === p.wallet && q.low === p.low))
        assert.deepEqual(onTotal, mine)
        const byViewTable = outVerdict([], { ...total, scope: 'v' }, p)
        if (byViewTable.kind !== mine.kind) viewTableDiffers++
        const ctx = JSON.stringify({ mine, m })
        assert.equal(m.includes('要按现价重挂'), mine.kind === 'move', ctx)
        assert.equal(m.includes('放回去不划算'), mine.kind === 'under', ctx)
        assert.equal(m.includes('质押奖励已停'), mine.kind === 'stopped', ctx)
        assert.equal(m.includes('平常'), mine.kind === 'move' || mine.kind === 'under', ctx)
        if (mine.kind === 'move' || mine.kind === 'under') {
          const own = putBackRates(w.pool_compare.pools.find((q) => q.pool_address === p.pool_address), w.pool_compare.cost_line)
          assert.equal(mine.usual, own.usual, ctx)
          assert.equal(mine.line, own.line, ctx)
        }
        if (mine.kind === 'move') {
          const [, a, b] = /重挂、宽度不变的话：(\$[\d,.]+) – (\$[\d,.]+)/.exec(m) ?? assert.fail(m)
          const nb = recentreOf(p, P, mine.spacing)
          assert.ok(Math.abs(dollars(a) - nb.low) <= 0.5 && Math.abs(dollars(b) - nb.high) <= 0.5, `${ctx} ${nb.low}-${nb.high}`)
        }
        seen[mine.kind] = (seen[mine.kind] ?? 0) + 1
        n++
      }
    }
  }
  assert.equal(n, 600 * 4)
  for (const kind of ['plain', 'stopped', 'under', 'move']) assert.ok(seen[kind] > 50, JSON.stringify(seen))
  // The view's own table would have said otherwise often enough for the test to tell the two apart.
  assert.ok(viewTableDiffers > 300, `${viewTableDiffers}`)
})

test('on the total view, a range is judged by nothing when its wallet cannot be told: no row of that label, or two', () => {
  const outVerdict = pageFn(['putback', 'outline'], 'outVerdict')
  const pc = { fixed_label: '±3.5%', cost_line: { rate: 1.1 }, pools: [{ chain: 'base', pool_address: POOLS[0], label: 'CL100', fixed: { staked: { median: 1.8 } } }] }
  const p = outRange('甲', 'below', 0, POOLS[0]), total = walletRow('total', '合计', [p], pc)
  assert.equal(outVerdict([walletRow('a', '甲', [p], pc), total], total, p).kind, 'move')
  assert.deepEqual(outVerdict([total], total, p), { kind: 'plain' })
  assert.deepEqual(outVerdict([walletRow('a', '甲', [p], pc), walletRow('b', '甲', [], pc), total], total, p), { kind: 'plain' })
  // A wallet without a label is named by its key.
  assert.equal(outVerdict([walletRow('a', undefined, [p], pc), total], total, { ...p, wallet: 'a' }).kind, 'move')
  // Against another coin: only the day.
  assert.deepEqual(outVerdict([walletRow('a', '甲', [p], pc), total], total, { ...p, quote: { symbol: 'cbBTC' } }), { kind: 'plain' })
})
