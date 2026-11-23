import test from 'node:test'
import assert from 'node:assert/strict'
import { usdCurve, amountsAtUsd, orderOf, openingDeposit } from '../lib/curve.mjs'
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

// WETH/cbBTC, 18 and 8 decimals: the same range in both token orders, 0.028-0.031 BTC per ETH at $80,000.
const B = '0xbtc', BTC_USD = 80000
const withCoin = { ...kind, coin: (a) => (a === B ? { symbol: 'cbBTC', decimals: 8, usd: BTC_USD } : null) }
const btcFirst = { token0: B, token1: W, tickLower: tickOf(1e10 / 0.031), tickUpper: tickOf(1e10 / 0.028) }
const ethBtc = { token0: W, token1: B, tickLower: tickOf(0.028e-10), tickUpper: tickOf(0.031e-10) }

test('WETH against another coin reads as a dollar position with the coin at its price, in either token order', () => {
  const L = 3n * 10n ** 14n
  for (const ratio of [0.025, 0.0285, 0.0295, 0.0305, 0.033]) {
    const a = { ...ethBtc, liquidity: L, sqrtP: BigInt(Math.round(Math.sqrt(ratio * 1e-10) * Q96)), fees0: 0n, fees1: 0n }
    const b = { ...btcFirst, liquidity: L, sqrtP: BigInt(Math.round(Math.sqrt(1e10 / ratio) * Q96)), fees0: 0n, fees1: 0n }
    const ca = usdCurve(a, withCoin), cb = usdCurve(b, withCoin)
    assert.ok(!ca.invert && cb.invert)
    const P = ratio * BTC_USD
    for (const c of [ca, cb]) {
      assert.ok(Math.abs(c.pool - P) / P < 1e-9, `pool ${c.pool} vs ${P}`)
      assert.ok(Math.abs(c.low - 0.028 * BTC_USD) / P < 1e-3 && Math.abs(c.high - 0.031 * BTC_USD) / P < 1e-3, `bounds ${c.low} ${c.high}`)
      assert.equal(c.quote.symbol, 'cbBTC')
      assert.ok(Math.abs(c.quote.low - 0.028) < 1e-4 && Math.abs(c.quote.high - 0.031) < 1e-4 && Math.abs(c.quote.pool - ratio) < 1e-9)
    }
    // Against the exact BigInt position maths of each pool: the ETH, and the dollars the coin is worth.
    for (const [x, c] of [[a, ca], [b, cb]]) {
      const { amount0, amount1 } = amountsForLiquidity(x.sqrtP, x.tickLower, x.tickUpper, L)
      const [e, u] = amountsAtUsd(c, c.pool)
      const exactEth = Number(x.token0 === W ? amount0 : amount1) / 1e18, exactUsd = (Number(x.token0 === W ? amount1 : amount0) / 1e8) * BTC_USD
      assert.ok(Math.abs(e - exactEth) <= 1e-6 * Math.max(1, exactEth) && Math.abs(u - exactUsd) <= 1e-3 * Math.max(1, exactUsd), `${x.token0 === W ? 'eth first' : 'coin first'} at ${ratio}: ${e}/${exactEth} ${u}/${exactUsd}`)
    }
  }
})

test('its scale turns the pool\'s raw price into the dollar price, and the coin\'s price does not move its bounds in the coin', () => {
  const x = { ...ethBtc, liquidity: 1n, sqrtP: BigInt(Math.round(Math.sqrt(0.0295e-10) * Q96)), fees0: 0n, fees1: 0n }
  const c = usdCurve(x, withCoin), raw = (Number(x.sqrtP) / Q96) ** 2
  assert.ok(Math.abs(raw * c.scale - c.pool) < 1e-6)
  const later = usdCurve(x, { ...kind, coin: () => ({ symbol: 'cbBTC', decimals: 8, usd: 90000 }) })
  assert.equal(later.quote.low, c.quote.low)
  assert.equal(later.quote.high, c.quote.high)
})

test('a WETH/USDC position is what it always was: no quote, its scale 1e12, its liquidity as it is', () => {
  const x = { ...ethFirst, liquidity: 4n * 10n ** 14n, sqrtP: BigInt(Math.round(Math.sqrt(2250e-12) * Q96)), fees0: 0n, fees1: 5_000000n }
  const c = usdCurve(x, withCoin)
  assert.equal(c.quote, null)
  assert.equal(c.scale, 1e12)
  assert.equal(c.L, Number(x.liquidity))
  assert.equal(c.extraUsd, 5)
})

test('fees in the other coin are paid out in dollars at its price', () => {
  const x = { ...ethBtc, liquidity: 1n, sqrtP: BigInt(Math.round(Math.sqrt(0.0295e-10) * Q96)), fees0: 10n ** 17n, fees1: 100000n }
  const c = usdCurve(x, withCoin)
  assert.equal(c.extraEth, 0.1)
  assert.ok(Math.abs(c.extraUsd - 80) < 1e-9)
})

test('a coin with no price to follow leaves the position off the curve', () => {
  assert.equal(usdCurve({ ...ethBtc, liquidity: 1n, sqrtP: sqrtRatioAtTick(0), fees0: 0n, fees1: 0n }, kind), null)
})

test('orderOf: a WETH/USDC range that took one coin at its opening deposit is an order, to buy ETH (USDC only: opened below the price) or sell it (ETH only: above)', () => {
  const L = 4n * 10n ** 14n
  for (const x of [ethFirst, usdFirst]) {
    const at = (P) => BigInt(Math.round((x.token0 === W ? Math.sqrt(P * 1e-12) : Math.sqrt(1e12 / P)) * Q96))
    // The opening deposit as its IncreaseLiquidity logs it, the range opened with ETH at P, read back from data/ as text.
    const opened = (P) => { const { amount0, amount1 } = amountsForLiquidity(at(P), x.tickLower, x.tickUpper, L); return { amount0: String(amount0), amount1: String(amount1) } }
    const c = usdCurve({ ...x, liquidity: L, sqrtP: at(2200), fees0: 0n, fees1: 0n }, kind)
    const name = x === ethFirst ? 'eth first' : 'usd first'
    assert.equal(orderOf(opened(2600), c), 'buy', name)
    assert.equal(orderOf(opened(1900), c), 'sell', name)
    assert.equal(orderOf(opened(2200), c), null, name)
    assert.equal(orderOf({ amount0: 0n, amount1: 0n }, c), null, name)
    assert.equal(orderOf(null, c), null, name)
  }
  // Against another coin a range is never read as an order.
  const b = usdCurve({ ...ethBtc, liquidity: L, sqrtP: BigInt(Math.round(Math.sqrt(0.0295e-10) * Q96)), fees0: 0n, fees1: 0n }, withCoin)
  assert.equal(orderOf({ amount0: '0', amount1: '100000' }, b), null)
})

test('openingDeposit: what the mint of a position took, in its own chain\'s block, all its additions there added up', () => {
  // The same position manager on two chains can give one token number to a position on each.
  const NPM = '0x00000000000000000000000000000000000000f1', OTHER = '0x00000000000000000000000000000000000000f2'
  const inc = (tokenId, chain, chainBlock, amount0, amount1, extra = {}) => ({ type: 'increase', npm: NPM, tokenId, chain, chainBlock, amount0, amount1, ...extra })
  const events = [
    inc('5', 'base', 100, '0', '700'), inc('5', 'base', 100, '0', '300'), inc('5', 'base', 200, '9', '0'),
    inc('5', 'eth', 40, '300', '8'), inc('5', 'eth', 100, '0', '50'), inc('5', 'base', 100, '1', '0', { npm: OTHER }),
    { type: 'decrease', npm: NPM, tokenId: '5', chain: 'base', chainBlock: 100, amount0: '3', amount1: '0' },
  ]
  const books = [{ npm: NPM, tokenId: '5', chain: 'base', born: 100, minted: true }, { npm: NPM, tokenId: '5', chain: 'eth', born: 40, minted: true }]
  assert.deepEqual(openingDeposit({ npm: NPM, tokenId: 5 }, books, events), { amount0: 0n, amount1: 1000n })
  assert.deepEqual(openingDeposit({ npm: NPM, tokenId: '5', chain: 'base' }, books, events), { amount0: 0n, amount1: 1000n })
  assert.deepEqual(openingDeposit({ npm: NPM, tokenId: '5', chain: 'eth' }, books, events), { amount0: 300n, amount1: 8n })
  // Born where it arrived from outside (not minted in the records), held before them, or not in the books: not known.
  const one = (born, minted) => openingDeposit({ npm: NPM, tokenId: '5' }, [{ npm: NPM, tokenId: '5', chain: 'base', born, minted }], events)
  assert.equal(one(100, false), null)
  assert.equal(one(100, undefined), null)
  assert.equal(one(null, false), null)
  assert.equal(one(150, true), null)
  assert.equal(openingDeposit({ npm: NPM, tokenId: '6' }, books, events), null)
})
