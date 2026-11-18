// The page keeps its own copies of a few lib functions (it loads no modules): each copy sits between
// /* name:start */ and /* name:end */ markers in dashboard/index.html, and must give exactly what the lib
// function gives, so the page and the phone alerts never say different things. A rule only the page has (the
// 每日年化 axis, aprtop, and the week and month rows it reads, byperiod with parseday and periodof) sits in such
// a block too and is tested on its own. Invented figures only.
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

// The 每日年化 axis (aprtop). Invented rates, 1 = 100% a year.
const aprRow = (i, apr_day, extra = {}) => ({ day: `2026-03-${String(i + 1).padStart(2, '0')}`, apr_day, pool_share: 1, span_days: 1, partial: false, ...extra })
const steadyRows = [0.9, 1.3, 0.4, 1.6, 0, 1.1].map((v, i) => aprRow(i, v))

test('the 每日年化 axis reaches every steady day however high, and leaves out only a part-day far above them', () => {
  const aprTop = pageFn('aprtop', 'aprTop'), aprShort = pageFn('aprtop', 'aprShort')
  // A lasting change of level, or one odd day: the axis reaches them.
  assert.equal(aprTop([...steadyRows, aprRow(6, 5.2), aprRow(7, 6.1), aprRow(8, 5.5)]), 6.1)
  assert.equal(aprTop([...steadyRows, aprRow(6, 4.2)]), 4.2)
  // Money in for part of the day (pool_share under one half): left out when more than twice the steady
  // days, reached otherwise (twice exactly too).
  assert.equal(aprShort(aprRow(6, 0.8, { pool_share: 0.49 })), true)
  assert.equal(aprShort(aprRow(6, 0.8, { pool_share: 0.5 })), false)
  assert.equal(aprTop([...steadyRows, aprRow(6, 12, { pool_share: 0.2 })]), 1.6)
  assert.equal(aprTop([...steadyRows, aprRow(6, 2.8, { pool_share: 0.3 })]), 2.8)
  assert.equal(aprTop([...steadyRows, aprRow(6, 3.2, { pool_share: 0.3 })]), 3.2)
  assert.equal(aprTop([...steadyRows, aprRow(6, 3.3, { pool_share: 0.3 })]), 1.6)
  // In and out within the day: no money at either end, so pool_share is null, yet a rate.
  assert.equal(aprShort(aprRow(6, 9, { pool_share: null })), true)
  assert.equal(aprTop([...steadyRows, aprRow(6, 9, { pool_share: null })]), 1.6)
  // No rate: never a part-day (no money that day, or today's row just after midnight, which has no pool_share).
  assert.equal(aprShort(aprRow(6, null, { pool_share: null })), false)
  assert.equal(aprShort({ day: '2026-03-07', partial: true, apr_day: null }), false)
  // A row without pool_share is not short, even with a rate (no published day row lacks it; a guard).
  assert.equal(aprShort({ day: '2026-03-07', apr_day: 0.8, span_days: 1, partial: false }), false)
  // Today's first six hours: a cent of interest reads high, so it counts only within twice the steady days.
  assert.equal(aprTop([...steadyRows, aprRow(6, 9, { partial: true, span_days: 0.01 })]), 1.6)
  assert.equal(aprTop([...steadyRows, aprRow(6, 2.5, { partial: true, span_days: 0.01 })]), 2.5)
  assert.equal(aprTop([...steadyRows, aprRow(6, 9, { partial: true, span_days: 0.4 })]), 9)
  // A row with days in place of span_days and no steady_apr is judged by its days (a guard: byPeriod writes
  // steady_apr on every week and month, and the page judges those by it).
  assert.equal(aprTop([...steadyRows, { day: '2026-03-02', apr_day: 9, pool_share: 1, partial: true, days: 0.1 }]), 1.6)
  assert.equal(aprTop([...steadyRows, { day: '2026-03-02', apr_day: 9, pool_share: 1, partial: true, days: 3 }]), 9)
  // No steady day above 0%: every day counts. Nothing above 0%: 100%.
  assert.equal(aprTop([aprRow(0, 0), aprRow(1, 0), aprRow(2, 2.5, { pool_share: 0.3 })]), 2.5)
  assert.equal(aprTop([aprRow(0, 3, { pool_share: 0.3 }), aprRow(1, 1.5, { pool_share: 0.4 })]), 3)
  assert.equal(aprTop([aprRow(0, 0), aprRow(1, 0)]), 1)
  assert.equal(aprTop([]), 1)
})

// A day row as the hourly job writes it, for byPeriod: $10,000 in the pool all day at the yearly rate apr.
const addDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)
function dayRow(day, apr, extra = {}) {
  const r = { scope: 'a', scope_label: '甲', day, partial: false, lp_tw_usd: 10000, span_days: 1, pool_share: 1, earn_aero: 1, earn_fee_usd: 0, pnl_day_usd: 0, pnl_usd: 0, eth_usd: 2300, range_status: 'in', ...extra }
  return { ...r, earn_usd: (apr * r.lp_tw_usd * r.span_days) / 365, apr_day: apr }
}
const dayRows = (from, n, apr, extra) => Array.from({ length: n }, (_, i) => dayRow(addDay(from, i), apr, extra))

test('on the 每日年化 axis a week or month vouches only for the rate of its steady days, as its days do', () => {
  const byPeriod = pageFn(['parseday', 'periodof', 'aprtop', 'byperiod'], 'byPeriod')
  const aprTop = pageFn('aprtop', 'aprTop'), aprShort = pageFn('aprtop', 'aprShort'), aprWeight = pageFn('aprtop', 'aprWeight')
  assert.equal(aprWeight({ pool_share: null }), 0)
  assert.equal(aprWeight({ pool_share: 0.3 }), 0.3)
  assert.equal(aprWeight({}), 1)
  // $2,000 time-weighted over the day, nothing in the pool at either end.
  const inOut = { pool_share: null, lp_tw_usd: 2000 }
  // Two steady weeks (Monday 3/2 and 3/9), then a week of one such day.
  const weeks = byPeriod([...dayRows('2026-03-02', 7, 1.5), ...dayRows('2026-03-09', 7, 1.4), dayRow('2026-03-18', 9, inOut)], 'week')
  assert.deepEqual(weeks.map((w) => w.day), ['2026-03-02', '2026-03-09', '2026-03-16'])
  assert.deepEqual(weeks.map((w) => Math.round(w.apr_day * 1e6) / 1e6), [1.5, 1.4, 9])
  assert.deepEqual(weeks.map((w) => w.pool_share), [1, 1, 0])
  assert.deepEqual(weeks.map(aprShort), [false, false, true])
  assert.equal(aprTop(weeks), weeks[0].apr_day)
  // The same by month.
  const months = byPeriod([...dayRows('2026-01-05', 20, 1.5), ...dayRows('2026-02-02', 20, 1.4), dayRow('2026-03-18', 9, inOut)], 'month')
  assert.deepEqual(months.map((m) => m.day), ['2026-01', '2026-02', '2026-03'])
  assert.deepEqual(months.map((m) => m.pool_share), [1, 1, 0])
  assert.deepEqual(months.map(aprShort), [false, false, true])
  assert.equal(aprTop(months), months[0].apr_day)
  // Such a day among steady ones weighs by its money-time: the week stays steady.
  const [mixed] = byPeriod([...dayRows('2026-03-02', 6, 1.5), dayRow('2026-03-08', 9, inOut)], 'week')
  assert.ok(Math.abs(mixed.pool_share - 60000 / 62000) < 1e-12, `${mixed.pool_share}`)
  assert.equal(aprShort(mixed), false)
  // A day of money in part of it, weighed by its own share.
  const [part] = byPeriod([dayRow('2026-03-02', 1.5), dayRow('2026-03-03', 6, { pool_share: 0.2 })], 'week')
  assert.ok(Math.abs(part.pool_share - 12000 / 20000) < 1e-12, `${part.pool_share}`)
  // Today's row opening a new week, at noon: its half day weighs its money, its rate is the day's own.
  const past = [...dayRows('2026-03-02', 7, 1.5), ...dayRows('2026-03-09', 7, 1.4)]
  const noon = byPeriod([...past, dayRow('2026-03-16', 6, { partial: true, span_days: 0.5, lp_tw_usd: 4000, pool_share: 0.3 })], 'week')[2]
  assert.ok(Math.abs(noon.pool_share - 0.3) < 1e-12, `${noon.pool_share}`)
  assert.ok(Math.abs(noon.apr_day - 6) < 1e-9, `${noon.apr_day}`)
  assert.equal(aprShort(noon), true)
  // A week of steady days vouches for its own rate on the axis, so it is always reached; a week of only a
  // short day (as at noon above) vouches for none.
  assert.deepEqual(byPeriod(past, 'week').map((w) => w.steady_apr === w.apr_day), [true, true])
  assert.equal(noon.steady_apr, null)
  // At 03:00 the new week is today's first hours: partial, three hours of days, vouching for nothing, so far
  // above the steady weeks it is left out.
  const early = byPeriod([...past, dayRow('2026-03-16', 11.68, { partial: true, span_days: 0.125 })], 'week')
  assert.equal(early[2].partial, true)
  assert.ok(Math.abs(early[2].days - 0.125) < 1e-12, `${early[2].days}`)
  assert.equal(early[2].steady_apr, null)
  assert.equal(aprTop(early), early[0].apr_day)
  // Money put in at 01:00 after two days with none in the pool (rows the job still writes: no money, no rate):
  // the week rests on today's first hour as today's row does, though its days count past two, so it is left
  // out the same way. With money in on those days the week vouches for their rate and is reached.
  const empty = (day) => ({ ...dayRow(day, 0, { lp_tw_usd: 0, pool_share: null }), apr_day: null })
  const firstHour = dayRow('2026-03-18', 24, { partial: true, span_days: 1 / 24, pool_share: 0.9 })
  const back = byPeriod([...past, empty('2026-03-16'), empty('2026-03-17'), firstHour], 'week')
  assert.ok(back[2].days > 2, `${back[2].days}`)
  assert.ok(Math.abs(back[2].apr_day - 24) < 1e-9, `${back[2].apr_day}`)
  assert.equal(aprShort(back[2]), false)
  assert.equal(back[2].steady_apr, null)
  assert.equal(aprTop(back), back[0].apr_day)
  const along = byPeriod([...past, ...dayRows('2026-03-16', 2, 1.6), firstHour], 'week')
  assert.ok(Math.abs(along[2].steady_apr - 1.6) < 1e-9, `${along[2].steady_apr}`)
  assert.equal(aprTop(along), along[2].apr_day)
  // Left out only when far above, as such a day is: at 2.5, within twice the steady weeks, the axis reaches it.
  const low = byPeriod([...past, empty('2026-03-16'), empty('2026-03-17'), dayRow('2026-03-18', 2.5, { partial: true, span_days: 0.125, pool_share: 0.9 })], 'week')
  assert.equal(low[2].steady_apr, null)
  assert.ok(Math.abs(low[2].apr_day - 2.5) < 1e-9, `${low[2].apr_day}`)
  assert.equal(aprTop(low), low[2].apr_day)
  // A steady day at 1.6 and today's first three hours: the week vouches for the day's 1.6 only, so its own
  // rate counts up to twice the highest rate vouched for (3.2), however the money-time splits between them.
  const hours = (apr, lp) => byPeriod([...past, dayRow('2026-03-16', 1.6, { lp_tw_usd: lp }), dayRow('2026-03-17', apr, { partial: true, span_days: 0.125 })], 'week')
  assert.ok(Math.abs(hours(4.7, 1250)[2].steady_apr - 1.6) < 1e-9, `${hours(4.7, 1250)[2].steady_apr}`)
  assert.ok(Math.abs(hours(4.7, 1250)[2].apr_day - 3.15) < 1e-9, `${hours(4.7, 1250)[2].apr_day}`)
  assert.equal(aprTop(hours(4.7, 1250)), hours(4.7, 1250)[2].apr_day)
  assert.ok(Math.abs(hours(4.9, 1250)[2].apr_day - 3.25) < 1e-9, `${hours(4.9, 1250)[2].apr_day}`)
  assert.equal(aprTop(hours(4.9, 1250)), hours(4.9, 1250)[0].apr_day)
  assert.equal(aprTop(hours(24, 1250)), hours(24, 1250)[0].apr_day)
  assert.equal(aprTop(hours(24, 100000)), hours(24, 100000)[2].apr_day)
  // Steady days too small for a rate (under 50 dollar-days, as the week's own rate and, per day, the job's)
  // vouch for none: a day of dust beside today's first hours leaves the week vouching for nothing.
  const small = (lp) => byPeriod([...past, dayRow('2026-03-16', 3, { lp_tw_usd: lp }), dayRow('2026-03-17', 24, { partial: true, span_days: 0.125 })], 'week')[2].steady_apr
  assert.ok(Math.abs(small(50) - 3) < 1e-9, `${small(50)}`)
  assert.equal(small(49.99), null)
  const dust = byPeriod([...past, { ...dayRow('2026-03-16', 30, { lp_tw_usd: 40 }), apr_day: null }, dayRow('2026-03-17', 24, { partial: true, span_days: 0.125 })], 'week')
  assert.equal(dust[2].steady_apr, null)
  assert.equal(aprTop(dust), dust[0].apr_day)
  // A week alone, far above its own steady days and nothing else drawn above 0%: the axis goes up to the rate
  // its steady days vouch for, and the week sits on the top edge.
  const alone = byPeriod([dayRow('2026-03-16', 0.4), dayRow('2026-03-17', 30, { lp_tw_usd: 2000, pool_share: 0.2 })], 'week')
  assert.ok(alone[0].apr_day > 2 * alone[0].steady_apr, `${alone[0].apr_day}`)
  assert.equal(aprTop(alone), alone[0].steady_apr)
  // As on a day row, only today's first six hours: from 06:00 the week vouches for today's rate, not a little
  // before, and a past day that was short because the wallet was first seen late that day vouches for its own.
  const at = (span) => byPeriod([...past, empty('2026-03-16'), empty('2026-03-17'), dayRow('2026-03-18', 24, { partial: true, span_days: span, pool_share: 0.9 })], 'week')
  assert.equal(at(0.25)[2].steady_apr, at(0.25)[2].apr_day)
  assert.equal(aprTop(at(0.25)), at(0.25)[2].apr_day)
  assert.equal(at(0.249)[2].steady_apr, null)
  assert.equal(aprTop(at(0.249)), at(0.249)[0].apr_day)
  const [late] = byPeriod([dayRow('2026-03-19', 3, { span_days: 0.17 })], 'week')
  assert.equal(late.steady_apr, late.apr_day)
  // A week's steady days weigh by money-time, as its own rate does, not day by day: two whole days at 40%
  // and today's first nine hours at 150%.
  const nine = byPeriod([...past, ...dayRows('2026-03-16', 2, 0.4), dayRow('2026-03-18', 1.5, { partial: true, span_days: 0.375 })], 'week')[2]
  assert.ok(Math.abs(nine.apr_day - (0.4 * 2 + 1.5 * 0.375) / 2.375) < 1e-9, `${nine.apr_day}`)
  assert.equal(nine.steady_apr, nine.apr_day)
  // Money put in at 21:00 yesterday after a day with none (a short day: in for an eighth of it), then today's
  // first three hours, half of the week's money-time each, the week's own pool_share over one half: no day of
  // it vouches for a rate, so the week counts as they do and is left out.
  const evening = byPeriod([...past, empty('2026-03-16'), dayRow('2026-03-17', 6, { lp_tw_usd: 1250, pool_share: 0.125 }), dayRow('2026-03-18', 6, { partial: true, span_days: 0.125 })], 'week')
  assert.ok(Math.abs(evening[2].pool_share - 0.5625) < 1e-12, `${evening[2].pool_share}`)
  assert.equal(aprShort(evening[2]), false)
  assert.equal(evening[2].steady_apr, null)
  assert.equal(aprTop(evening), evening[0].apr_day)
  // A past week whose short day earned far more than its other days: it vouches for those days' 1.2 only and
  // is left out. With the money in for half of that day every day is steady and the week vouches for its own.
  const thin = (share) => byPeriod([...past, ...dayRows('2026-03-16', 2, 1.2, { lp_tw_usd: 1000 }), dayRow('2026-03-18', 9, { pool_share: share })], 'week')
  assert.ok(Math.abs(thin(0.45)[2].steady_apr - 1.2) < 1e-9, `${thin(0.45)[2].steady_apr}`)
  assert.equal(aprTop(thin(0.45)), thin(0.45)[0].apr_day)
  assert.equal(thin(0.5)[2].steady_apr, thin(0.5)[2].apr_day)
  assert.equal(aprTop(thin(0.5)), thin(0.5)[2].apr_day)
  // Short days that earned what the other days did leave the period at its height, as they are on the day
  // view. A month whose money-time is mostly two such days (much more money in overnight) vouches for its
  // steady days' 40% and is drawn above months at 15%; a week whose wide position was out from 10:00 Monday
  // (Monday short at an ordinary 38%, the other days the narrow one's 150%) is drawn among weeks at 25%.
  const overnight = byPeriod([...dayRows('2026-03-01', 9, 0.4, { lp_tw_usd: 1000 }), dayRow('2026-03-10', 0.4, { lp_tw_usd: 19750, pool_share: 0.387 }), dayRow('2026-03-11', 0.4, { lp_tw_usd: 21833, pool_share: 0.428 }), ...dayRows('2026-03-12', 20, 0.4, { lp_tw_usd: 1000 }), ...dayRows('2026-04-01', 30, 0.15)], 'month')
  assert.ok(Math.abs(overnight[0].steady_apr - 0.4) < 1e-9, `${overnight[0].steady_apr}`)
  assert.equal(aprTop(overnight), overnight[0].apr_day)
  const wideOut = byPeriod([...dayRows('2026-03-02', 14, 0.25, { lp_tw_usd: 105000 }), dayRow('2026-03-16', 0.384, { lp_tw_usd: 46667, pool_share: 0.444 }), ...dayRows('2026-03-17', 6, 1.5, { lp_tw_usd: 5000 })], 'week')
  assert.ok(Math.abs(wideOut[2].steady_apr - 1.5) < 1e-9, `${wideOut[2].steady_apr}`)
  assert.equal(aprTop(wideOut), wideOut[2].apr_day)
  // This week, money put back in at 13:00 on Wednesday after days with none, at three times the earlier
  // weeks: from 06:00 on Thursday today's row vouches for its rate, as on the day view, and the week is drawn;
  // at 03:00 no day of it vouches for one yet and it is left out.
  const steadyPast = [...dayRows('2026-03-02', 7, 0.4), ...dayRows('2026-03-09', 7, 0.4)]
  const wed = (span) => byPeriod([...steadyPast, empty('2026-03-16'), empty('2026-03-17'), dayRow('2026-03-18', 1.2, { lp_tw_usd: 10000 * 11 / 24, pool_share: 11 / 24 }), dayRow('2026-03-19', 1.2, { partial: true, span_days: span })], 'week')
  assert.equal(aprTop(wed(0.25)), wed(0.25)[2].apr_day)
  assert.equal(aprTop(wed(0.125)), wed(0.125)[0].apr_day)
  // The same by month: the 4th, after three days with none.
  const months4th = byPeriod([...dayRows('2026-01-05', 20, 1.5), ...dayRows('2026-02-02', 20, 1.4), empty('2026-03-01'), empty('2026-03-02'), empty('2026-03-03'), dayRow('2026-03-04', 24, { partial: true, span_days: 0.125, pool_share: 0.9 })], 'month')
  assert.deepEqual(months4th.map((m) => m.steady_apr === m.apr_day), [true, true, false])
  assert.equal(months4th[2].steady_apr, null)
  assert.equal(aprTop(months4th), months4th[0].apr_day)
})

test('on random rows, the 每日年化 axis never leaves out a steady row, and leaves out any other exactly when it is more than twice every rate the rows vouch for', () => {
  const aprTop = pageFn('aprtop', 'aprTop'), rand = rng(20261119)
  const pick = (xs) => xs[Math.floor(rand() * xs.length)]
  // Each row is made as a kind, so the test does not lean on the page's own rule to tell them apart: a steady
  // row vouches for its own rate, a short one for none, a partly steady week or month for the rate of its
  // steady days, whatever its own.
  const OWN = Symbol('own')
  const steady = () => pick([
    { pool_share: 1 }, { pool_share: 0.5 }, { pool_share: 0.5 + rand() * 0.5 },
    { pool_share: undefined }, // no pool_share (a guard)
    { partial: true, span_days: pick([0.25, 0.26, 0.25 + rand() * 0.75]) }, // today, past its first six hours
    { partial: true, span_days: undefined, days: pick([0.25, 0.25 + rand() * 6]) }, // a period row without steady_apr (a guard), the same
    { span_days: undefined, days: 1 + rand() * 6 }, // the same, a past week or month
    { span_days: undefined, days: 1 + rand() * 6, partial: pick([true, false]), steady_apr: OWN }, // a week or month of steady days
  ])
  const short = () => pick([
    { pool_share: rand() * 0.5 }, { pool_share: 0.49 }, { pool_share: 0 }, { pool_share: null },
    { partial: true, span_days: pick([0.01, 0.24, 0.249, rand() * 0.25]) },
    { partial: true, span_days: undefined, days: rand() * 0.25 },
    // A week or month none of whose days vouch for a rate, however its other fields read.
    { span_days: undefined, days: pick([0.1, 1 + rand() * 6]), partial: pick([true, false]), pool_share: pick([1, 0.3, null]), steady_apr: null },
  ])
  const partly = (level) => ({ span_days: undefined, days: pick([0.1, 1 + rand() * 6]), partial: pick([true, false]), pool_share: pick([1, 0.6, 0.3, null]), steady_apr: pick([0, rand() * level, rand() * level * 3]) })
  const seen = { leftOut: 0, shortIn: 0, vouchedIn: 0, steadyFar: 0 }
  for (let k = 0; k < 20000; k++) {
    // Steady rates around a level; the others up to six times it, so they fall either side of twice.
    const level = pick([0.3, 1, 3, 10])
    const rows = Array.from({ length: 1 + Math.floor(rand() * 30) }, (_, i) => {
      const v = rand(), kind = v < 0.55 ? 'steady' : v < 0.85 ? 'short' : 'partly', u = rand()
      const apr = u < 0.08 ? pick([null, undefined, Number.NaN]) : u < 0.16 ? 0 : rand() * level * (kind === 'steady' ? 1 : 6)
      const r = { ...aprRow(i, apr, kind === 'steady' ? steady() : kind === 'short' ? short() : partly(level)), kind }
      if (r.steady_apr === OWN) r.steady_apr = apr
      return r
    })
    const top = aprTop(rows), rated = rows.filter((r) => Number.isFinite(r.apr_day))
    const vouched = (r) => (r.kind === 'steady' ? r.apr_day : r.kind === 'partly' ? r.steady_apr : null)
    const most = Math.max(0, ...rows.map(vouched).filter(Number.isFinite))
    const mostSteady = Math.max(0, ...rated.filter((r) => r.kind === 'steady').map((r) => r.apr_day))
    const far = (r) => most > 0 && r.apr_day > 2 * most
    const want = Math.max(0, ...rated.filter((r) => !far(r)).map((r) => r.apr_day)) || most || 1
    if (top !== want) assert.fail(JSON.stringify({ top, want, most, rows }))
    for (const r of rated) {
      if (r.kind === 'steady') {
        if (r.apr_day > top) assert.fail(JSON.stringify({ r, top, most }))
        if (r.apr_day === mostSteady && rated.some((q) => q.kind === 'steady' && q.apr_day > 0 && r.apr_day > 2 * q.apr_day)) seen.steadyFar++
      } else {
        if ((r.apr_day > top) !== far(r)) assert.fail(JSON.stringify({ r, top, most }))
        if (r.apr_day > top) seen.leftOut++
        else if (mostSteady > 0 && r.apr_day > 2 * mostSteady) seen.vouchedIn++
        else if (r.apr_day > most) seen.shortIn++
      }
    }
  }
  // Each outcome came up often: a row left out; one above every rate vouched for, yet reached; one reached
  // only because a partly steady week or month vouched for more than the steady rows; and a steady row more
  // than twice another steady one, reached.
  assert.ok(seen.leftOut > 1000 && seen.shortIn > 1000 && seen.vouchedIn > 300 && seen.steadyFar > 1000, JSON.stringify(seen))
})
