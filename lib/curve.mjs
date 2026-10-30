// A WETH/USDC position in dollar terms, whichever token is token0 (WETH comes first on Base, USDC on
// Ethereum). For the same liquidity Uniswap's amount formulas give the same ETH and USDC once prices
// are taken as dollars per ETH, so a position is published as its liquidity L with square-root bounds
// sa, sb of the dollar price bounds (scaled by 1e-12 for the 18 and 6 decimals), which is what
// src/run.mjs, lib/alerts.mjs and the page value it with.
import { priceFromSqrt } from './univ3.mjs'

// `eth` and `usd`: whether an address is an ETH-like or a dollar token on the position's chain.
export function usdCurve(x, { eth, usd }) {
  const ethFirst = eth(x.token0) && usd(x.token1), usdFirst = usd(x.token0) && eth(x.token1)
  if (!ethFirst && !usdFirst) return null
  const tick = (t) => 1.0001 ** t
  // Dollars per ETH at a raw tick or price: token1 per token0 with 18 and 6 decimals, or its inverse.
  const low = ethFirst ? tick(x.tickLower) * 1e12 : 1e12 / tick(x.tickUpper)
  const high = ethFirst ? tick(x.tickUpper) * 1e12 : 1e12 / tick(x.tickLower)
  const raw = priceFromSqrt(x.sqrtP, 0, 0)
  const pool = ethFirst ? raw * 1e12 : 1e12 / raw
  return {
    invert: usdFirst, low, high, pool, L: Number(x.liquidity), sa: Math.sqrt(low * 1e-12), sb: Math.sqrt(high * 1e-12),
    inRange: x.inRange, tickLower: x.tickLower, tickUpper: x.tickUpper,
    // What collect() pays besides the position (fees and principal owed), split into ETH and dollars.
    extraEth: Number(ethFirst ? x.fees0 : x.fees1) / 1e18, extraUsd: Number(ethFirst ? x.fees1 : x.fees0) / 1e6,
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
