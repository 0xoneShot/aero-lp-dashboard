// A WETH/USDC position in dollar terms, whichever token is token0 (WETH comes first on Base, USDC on
// Ethereum). For the same liquidity Uniswap's amount formulas give the same ETH and USDC once prices
// are taken as dollars per ETH, so a position is published as its liquidity L with square-root bounds
// sa, sb of the dollar price bounds (scaled by 1e-12 for the 18 and 6 decimals), which is what
// src/run.mjs, lib/alerts.mjs and the page value it with.
//
// WETH against another coin with a dollar price (WETH/cbBTC) reads the same with the coin held at that
// price: bounds and pool price are coin per ETH times its dollar price, and L grows by sqrt(scale * 1e-12)
// so the same formulas give its ETH and the dollar value of the coin. `quote` says what it really is.
import { priceFromSqrt } from './univ3.mjs'

// `eth` and `usd`: whether an address is an ETH-like or a dollar token on the position's chain.
// `coin`: an address's { symbol, decimals, usd } when it is another coin to follow, else null.
export function usdCurve(x, { eth, usd, coin = () => null }) {
  const other = (a) => (usd(a) ? { decimals: 6, usd: 1 } : coin(a))
  const ethFirst = eth(x.token0), q = ethFirst ? other(x.token1) : eth(x.token1) ? other(x.token0) : null
  if (!q) return null
  const tick = (t) => 1.0001 ** t
  // Coin (or dollars) per ETH at a raw tick or price: token1 per token0 with 18 decimals and the coin's, or
  // its inverse.
  const unit = 10 ** (18 - q.decimals)
  const lowQ = ethFirst ? tick(x.tickLower) * unit : unit / tick(x.tickUpper)
  const highQ = ethFirst ? tick(x.tickUpper) * unit : unit / tick(x.tickLower)
  const raw = priceFromSqrt(x.sqrtP, 0, 0)
  const poolQ = ethFirst ? raw * unit : unit / raw
  const low = lowQ * q.usd, high = highQ * q.usd, scale = unit * q.usd
  return {
    invert: !ethFirst, scale, low, high, pool: poolQ * q.usd, L: Number(x.liquidity) * Math.sqrt(scale * 1e-12), sa: Math.sqrt(low * 1e-12), sb: Math.sqrt(high * 1e-12),
    inRange: x.inRange, tickLower: x.tickLower, tickUpper: x.tickUpper,
    // What collect() pays besides the position (fees and principal owed), split into ETH and dollars.
    extraEth: Number(ethFirst ? x.fees0 : x.fees1) / 1e18, extraUsd: (Number(ethFirst ? x.fees1 : x.fees0) / 10 ** q.decimals) * q.usd,
    quote: q.symbol ? { symbol: q.symbol, usd: q.usd, low: lowQ, high: highQ, pool: poolQ } : null,
  }
}

// ETH and dollars a curve position holds at a dollar price P.
export function amountsAtUsd(c, P) {
  const r = Math.sqrt(P * 1e-12)
  if (r <= c.sa) return [(c.L * (1 / c.sa - 1 / c.sb)) / 1e18, 0]
  if (r < c.sb) return [(c.L * (1 / r - 1 / c.sb)) / 1e18, (c.L * (r - c.sa)) / 1e6]
  return [0, (c.L * (c.sb - c.sa)) / 1e6]
}

// The dollar price of a pool from slot0's sqrtPriceX96, for a position published with `invert`.
export const poolUsd = (sqrtP, invert) => { const raw = priceFromSqrt(sqrtP, 0, 0); return invert ? 1e12 / raw : raw * 1e12 }

// A WETH/USDC range put back around the dollar price P, as wide as a published position's own
// ({ tick_lower, tick_upper, invert }): on its pool's tick grid when the spacing is known, so the width
// stays exactly the same and the centre lands within half a spacing of P. Ticks are of the pool's raw price
// as usdCurve reads them: WETH first (Base) P / 1e12 for the 18 and 6 decimals, USDC first (`invert`,
// Ethereum) 1e12 / P. Without a spacing (or ticks): P / sqrt(r) to P * sqrt(r), r the position's own
// high / low, off the grid (placing the range rounds each bound to it), and null ticks.
export function recentre(pos, P, spacing) {
  const W = pos.tick_upper - pos.tick_lower
  const ticks = Number.isInteger(pos.tick_lower) && Number.isInteger(pos.tick_upper) && W > 0
  if (!(spacing > 0) || !ticks) {
    const r = ticks ? 1.0001 ** W : pos.high / pos.low
    return { tick_lower: null, tick_upper: null, low: P / Math.sqrt(r), high: P * Math.sqrt(r) }
  }
  const t = Math.log(pos.invert ? 1e12 / P : P / 1e12) / Math.log(1.0001)
  const lower = Math.round((t - W / 2) / spacing) * spacing + 0, upper = lower + W
  return pos.invert
    ? { tick_lower: lower, tick_upper: upper, low: 1e12 / 1.0001 ** upper, high: 1e12 / 1.0001 ** lower }
    : { tick_lower: lower, tick_upper: upper, low: 1e12 * 1.0001 ** lower, high: 1e12 * 1.0001 ** upper }
}

// The share of its value a range [low, high] holds in ETH at the dollar price P, for the same liquidity
// across the whole range: 1 below it, 0 above it, a half at its geometric centre. To put money into a new
// range at P, that share of it goes in as ETH and the rest as dollars.
export function splitShare(low, high, P) {
  if (P <= low) return 1
  if (P >= high) return 0
  const e = 1 / Math.sqrt(P) - 1 / Math.sqrt(high), u = Math.sqrt(P) - Math.sqrt(low)
  return (e * P) / (e * P + u)
}
