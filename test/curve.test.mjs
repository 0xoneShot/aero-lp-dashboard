// The page works out the ETH cost price for any withdrawal price from the curve published in
// out/summary.json; check that curve against the prices src/run.mjs computed. Run after `npm run update`.
// The published ETH price is rounded to the cent, which moves the ETH a position holds by a few
// ten-thousandths, hence the tolerances.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Same maths as dashboard/index.html.
const amountsAt = (p, P) => {
  const r = Math.sqrt(P * 1e-12)
  if (r <= p.sa) return [(p.L * (1 / p.sa - 1 / p.sb)) / 1e18, 0]
  if (r < p.sb) return [(p.L * (1 / r - 1 / p.sb)) / 1e18, (p.L * (r - p.sa)) / 1e6]
  return [0, (p.L * (p.sb - p.sa)) / 1e6]
}
const holdAt = (c, P) => c.positions.reduce(([e, u], p) => { const [a, b] = amountsAt(p, P); return [e + a, u + b] }, [c.eth, c.usd])
const needed = (e, u, target) => (e < 0.05 ? null : Math.max(0, (target - u) / e))
const close = (a, b, tol, what) => {
  if (a == null || b == null) return assert.equal(a == null ? null : a, b == null ? null : b, what)
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`)
}

const file = 'out/summary.json'
test('the published ETH curve gives the same value and cost prices', { skip: !fs.existsSync(file) }, () => {
  for (const s of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    const c = s.curve
    assert.ok(c && Array.isArray(c.positions), `${s.scope}: curve`)
    const target = s.invested_usd + s.earn_total_usd
    const [en, un] = holdAt(c, s.eth_usd)
    close(un + en * s.eth_usd, s.value_usd, 1, `${s.scope} value at today's price`)
    close(en, s.eth_units_now, 2e-3, `${s.scope} ETH now`)
    close(needed(en, un, target), s.now_cost_eth_price, 0.1, `${s.scope} cost price withdrawing now`)
    close(needed(en, un, s.invested_usd), s.now_breakeven_eth_price, 0.1, `${s.scope} break-even withdrawing now`)
    if (!c.positions.length) continue
    const low = Math.min(...c.positions.map((p) => p.low))
    const [eb, ub] = holdAt(c, low * 0.999)
    close(eb, s.eth_units_below, 1e-4, `${s.scope} ETH below the range`)
    close(needed(eb, ub, target), s.cost_eth_price, 0.02, `${s.scope} cost price below the range`)
    for (const p of c.positions) assert.ok(p.low < p.high && p.L > 0 && p.wallet, `${s.scope}: position fields`)
  }
})
