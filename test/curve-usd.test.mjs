import test from 'node:test'
import assert from 'node:assert/strict'
import { usdCurve, amountsAtUsd } from '../lib/curve.mjs'
import { amountsForLiquidity, sqrtRatioAtTick } from '../lib/univ3.mjs'

const W = '0xweth', U = '0xusdc'
const kind = { eth: (a) => a === W, usd: (a) => a === U }
const Q96 = 2 ** 96

// The same range, $2,000–$2,500, in both token orders: ticks of the raw token1/token0 price.
const tickOf = (raw) => Math.round(Math.log(raw) / Math.log(1.0001))
const ethFirst = { token0: W, token1: U, tickLower: tickOf(2000e-12), tickUpper: tickOf(2500e-12) }
const usdFirst = { token0: U, token1: W, tickLower: tickOf(1e12 / 2500), tickUpper: tickOf(1e12 / 2000) }

test('a WETH/USDC position values the same in either token order', () => {
  const L = 4n * 10n ** 14n
  for (const P of [1800, 2100, 2250, 2400, 2700]) {
    const a = { ...ethFirst, liquidity: L, sqrtP: BigInt(Math.round(Math.sqrt(P * 1e-12) * Q96)), fees0: 0n, fees1: 0n }
    const b = { ...usdFirst, liquidity: L, sqrtP: BigInt(Math.round(Math.sqrt(1e12 / P) * Q96)), fees0: 0n, fees1: 0n }
    const ca = usdCurve(a, kind), cb = usdCurve(b, kind)
    assert.ok(!ca.invert && cb.invert)
    for (const c of [ca, cb]) assert.ok(Math.abs(c.pool - P) / P < 1e-9, `pool ${c.pool} vs ${P}`)
    assert.ok(Math.abs(ca.low - cb.low) / 2000 < 1e-3 && Math.abs(ca.high - cb.high) / 2500 < 1e-3)
    // Against the exact BigInt position maths of each pool.
    for (const [x, c] of [[a, ca], [b, cb]]) {
      const { amount0, amount1 } = amountsForLiquidity(x.sqrtP, x.tickLower, x.tickUpper, L)
      const [e, u] = amountsAtUsd(c, P)
      const exactEth = Number(x.token0 === W ? amount0 : amount1) / 1e18, exactUsd = Number(x.token0 === W ? amount1 : amount0) / 1e6
      assert.ok(Math.abs(e - exactEth) <= 1e-6 * Math.max(1, exactEth) && Math.abs(u - exactUsd) <= 1e-3 * Math.max(1, exactUsd), `${x.token0 === W ? 'eth first' : 'usd first'} at ${P}: ${e}/${exactEth} ${u}/${exactUsd}`)
    }
  }
  assert.equal(usdCurve({ ...ethFirst, token1: '0xother', liquidity: 1n, sqrtP: sqrtRatioAtTick(0), fees0: 0n, fees1: 0n }, kind), null)
})
