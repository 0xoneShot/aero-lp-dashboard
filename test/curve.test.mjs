// The page works out the ETH cost price for any withdrawal price from the curve published in
// out/summary.json; check that curve against the prices src/run.mjs computed. Run after `npm run update`.
// Withdrawing now is valued at each position's own pool price; the reference ETH price values the rest.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { BASE_WALLETS } from '../lib/config.mjs'
import { recentre, splitShare, usdCurve, amountsAtUsd } from '../lib/curve.mjs'
import { hushed } from '../lib/public.mjs'

// Same maths as dashboard/index.html.
const amountsAt = (p, P) => {
  const r = Math.sqrt(P * 1e-12)
  if (r <= p.sa) return [(p.L * (1 / p.sa - 1 / p.sb)) / 1e18, 0]
  if (r < p.sb) return [(p.L * (1 / r - 1 / p.sb)) / 1e18, (p.L * (r - p.sa)) / 1e6]
  return [0, (p.L * (p.sb - p.sa)) / 1e6]
}
const holdAt = (c, P) => c.positions.reduce(([e, u], p) => { const [a, b] = amountsAt(p, P); return [e + a, u + b] }, [c.eth, c.usd])
const needed = (e, u, target) => (target <= u ? 0 : e < 0.05 ? null : (target - u) / e)
const close = (a, b, tol, what) => {
  if (a == null || b == null) return assert.equal(a == null ? null : a, b == null ? null : b, what)
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`)
}

const file = 'out/summary.json'
// The configured wallets and their total: the rows that hold back publishing when they are wrong. An
// address added on the page, and the views holding one, never do (and their figures stay out of the log).
const gating = new Set([...BASE_WALLETS.map((w) => w.key), 'total'])
// hushed (lib/public.mjs): in the job's public log a failure says which check, not a wallet's figures or bounds.
test('the published ETH curve gives the same value and cost prices', { skip: !fs.existsSync(file) }, hushed(() => {
  for (const s of JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => gating.has(r.scope))) {
    const c = s.curve
    assert.ok(c && Array.isArray(c.positions), `${s.scope}: curve`)
    const target = s.invested_usd + s.earn_total_usd
    // WETH/cbBTC holds what its own pool price gives: the feed behind its dollar scale can lag the
    // reference ETH price by more than the other positions' pools do.
    const [er, ur] = c.positions.reduce(([e, u], p) => { const [a, b] = amountsAt(p, p.quote ? p.pool : s.eth_usd); return [e + a, u + b] }, [c.eth, c.usd])
    close(ur + er * s.eth_usd, s.value_usd, 1, `${s.scope} value at today's price`)
    const [en, un] = c.positions.reduce(([e, u], p) => { const [a, b] = amountsAt(p, p.pool); return [e + a, u + b] }, [c.eth, c.usd])
    close(en, s.eth_units_now, 1e-4, `${s.scope} ETH withdrawing now`)
    close(un, s.rest_now_usd, 0.02, `${s.scope} other assets withdrawing now`)
    close(needed(en, un, target), s.now_cost_eth_price, 0.02, `${s.scope} cost price withdrawing now`)
    close(needed(en, un, s.invested_usd), s.now_breakeven_eth_price, 0.02, `${s.scope} break-even withdrawing now`)
    for (const p of c.positions) close(p.pool, s.eth_usd, s.eth_usd * (p.quote ? 0.05 : 0.01), `${s.scope} pool price near the reference price`)
    if (!c.positions.length) continue
    const low = Math.min(...c.positions.map((p) => p.low))
    const [eb, ub] = holdAt(c, low * 0.999)
    close(eb, s.eth_units_below, 1e-4, `${s.scope} ETH below the range`)
    close(needed(eb, ub, target), s.cost_eth_price, 0.02, `${s.scope} cost price below the range`)
    for (const p of c.positions) assert.ok(p.low < p.high && p.L > 0 && p.wallet && typeof p.in_range === 'boolean' && /^0x[0-9a-f]{40}$/.test(p.pool_address) && p.tick_lower < p.tick_upper, `${s.scope}: position fields`)
    assert.match(s.eth_ref_pool, /^0x[0-9a-f]{40}$/, `${s.scope}: reference pool`)
    // The state follows the positions' own pools.
    const inside = c.positions.filter((p) => p.in_range).length
    if (s.range_state === 'in') assert.equal(inside, c.positions.length, `${s.scope}: in`)
    if (s.range_state === 'part') assert.ok(inside > 0 && inside < c.positions.length, `${s.scope}: part`)
    if (['below', 'above', 'gap'].includes(s.range_state)) assert.equal(inside, 0, `${s.scope}: ${s.range_state}`)
  }
}))

// A range put back around the price, as wide as it was (the day-out alert, lib/alerts.mjs). Invented ranges:
// 400 ticks on a spacing of 100 with WETH first (Base's order), and 300 on 50 with USDC first (inverted).
const wethFirst = { tick_lower: -199200, tick_upper: -198800 }, usdcFirst = { tick_lower: 198550, tick_upper: 198850, invert: true }
const rawTick = (P, invert) => Math.log(invert ? 1e12 / P : P / 1e12) / Math.log(1.0001)
const near = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.abs(b)

test('a range put back keeps its width exactly, on the pool\'s grid, centred within half a spacing of the price', () => {
  // usdCurve reads the new ticks back into dollars, in the pool's own token order.
  const T = { weth: '0xe0', usdc: '0xu0' }, kind = { eth: (a) => a === T.weth, usd: (a) => a === T.usdc }
  for (const [pos, spacing] of [[wethFirst, 100], [usdcFirst, 50]]) {
    const W = pos.tick_upper - pos.tick_lower
    for (const P of [1750, 2128.4, 2447, 2640.9, 3333.3, 4200]) {
      const r = recentre(pos, P, spacing), what = `${pos.invert ? 'USDC first' : 'WETH first'} at ${P}`
      assert.equal(r.tick_upper - r.tick_lower, W, what)
      assert.ok(r.tick_lower % spacing === 0 && r.tick_upper % spacing === 0, what)
      assert.ok(Math.abs((r.tick_lower + r.tick_upper) / 2 - rawTick(P, pos.invert)) <= spacing / 2 + 1e-6, what)
      assert.ok(r.low < P && P < r.high, what)
      assert.ok(near(r.high / r.low, 1.0001 ** W), what)
      assert.ok(Math.abs(Math.log(Math.sqrt(r.low * r.high) / P)) <= (spacing / 2) * Math.log(1.0001) + 1e-9, what)
      const raw = pos.invert ? 1e12 / P : P / 1e12
      const x = { token0: pos.invert ? T.usdc : T.weth, token1: pos.invert ? T.weth : T.usdc, tickLower: r.tick_lower, tickUpper: r.tick_upper,
        liquidity: 1n, sqrtP: BigInt(Math.round(Math.sqrt(raw) * 2 ** 96)), fees0: 0n, fees1: 0n }
      const c = usdCurve(x, kind)
      assert.equal(c.invert, Boolean(pos.invert), what)
      assert.ok(near(c.low, r.low) && near(c.high, r.high) && near(c.pool, P, 1e-6), `${what}: ${c.low}-${c.high} vs ${r.low}-${r.high}`)
    }
  }
})

test('a range put back at its own centre comes back as it was', () => {
  for (const [pos, spacing] of [[wethFirst, 100], [usdcFirst, 50]]) {
    const at = (t) => (pos.invert ? 1e12 / 1.0001 ** t : 1e12 * 1.0001 ** t)
    const centre = Math.sqrt(at(pos.tick_lower) * at(pos.tick_upper))
    const r = recentre(pos, centre, spacing)
    assert.deepEqual([r.tick_lower, r.tick_upper], [pos.tick_lower, pos.tick_upper])
    assert.ok(near(Math.min(r.low, r.high), Math.min(at(pos.tick_lower), at(pos.tick_upper))) && near(Math.max(r.low, r.high), Math.max(at(pos.tick_lower), at(pos.tick_upper))))
  }
})

test('without the pool\'s spacing a range is put back at its own width around the price, off the grid', () => {
  const r = recentre(wethFirst, 2460)
  assert.deepEqual([r.tick_lower, r.tick_upper], [null, null])
  assert.ok(near(r.high / r.low, 1.0001 ** 400) && near(Math.sqrt(r.low * r.high), 2460))
  // Without ticks either: its dollar bounds give the width.
  const d = recentre({ low: 2000, high: 2200 }, 2100, 100)
  assert.deepEqual([d.tick_lower, d.tick_upper], [null, null])
  assert.ok(near(d.high / d.low, 1.1) && near(Math.sqrt(d.low * d.high), 2100))
})

test('the ETH share of a range is a half at its centre, all of it below the range and none above', () => {
  const low = 2235.04, high = 2326.26
  assert.ok(Math.abs(splitShare(low, high, Math.sqrt(low * high)) - 0.5) < 1e-12)
  assert.deepEqual([splitShare(low, high, low * 0.9), splitShare(low, high, low), splitShare(low, high, high), splitShare(low, high, high * 1.1)], [1, 1, 0, 0])
  let last = 1
  for (let i = 0; i <= 200; i++) {
    const P = low * 0.98 + ((high * 1.02 - low * 0.98) * i) / 200, s = splitShare(low, high, P)
    assert.ok(s >= 0 && s <= 1 && s <= last + 1e-12, `${P}: ${s}`)
    last = s
  }
  // What a position of any liquidity holds there (amountsAtUsd), in value.
  const c = { L: 3.7e15, sa: Math.sqrt(low * 1e-12), sb: Math.sqrt(high * 1e-12) }
  for (const P of [low * 1.001, 2280, high * 0.999]) {
    const [e, u] = amountsAtUsd(c, P)
    assert.ok(Math.abs(splitShare(low, high, P) - (e * P) / (e * P + u)) < 1e-9, `${P}`)
  }
})
