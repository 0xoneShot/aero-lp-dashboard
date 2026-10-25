// Concentrated-liquidity math (Uniswap v3 TickMath / LiquidityAmounts), exact BigInt port.
const Q96 = 1n << 96n
const MAX_UINT256 = (1n << 256n) - 1n

export function sqrtRatioAtTick(tick) {
  const abs = BigInt(tick < 0 ? -tick : tick)
  let r = abs & 0x1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n
  const k = [
    [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ]
  for (const [bit, m] of k) if (abs & bit) r = (r * m) >> 128n
  if (tick > 0) r = MAX_UINT256 / r
  return (r >> 32n) + (r % (1n << 32n) === 0n ? 0n : 1n)
}

function amount0(sa, sb, L) {
  if (sa > sb) [sa, sb] = [sb, sa]
  return ((L << 96n) * (sb - sa)) / sb / sa
}
function amount1(sa, sb, L) {
  if (sa > sb) [sa, sb] = [sb, sa]
  return (L * (sb - sa)) / Q96
}

// Token amounts (raw units) held by `liquidity` between two ticks at the pool price sqrtP.
export function amountsForLiquidity(sqrtP, tickLower, tickUpper, liquidity) {
  const sa = sqrtRatioAtTick(tickLower), sb = sqrtRatioAtTick(tickUpper), L = BigInt(liquidity)
  if (sqrtP <= sa) return { amount0: amount0(sa, sb, L), amount1: 0n, inRange: false }
  if (sqrtP < sb) return { amount0: amount0(sqrtP, sb, L), amount1: amount1(sa, sqrtP, L), inRange: true }
  return { amount0: 0n, amount1: amount1(sa, sb, L), inRange: false }
}

// Price of token0 quoted in token1, as a float, from sqrtPriceX96.
export function priceFromSqrt(sqrtP, dec0, dec1) {
  const p = Number(sqrtP) / 2 ** 96
  return p * p * 10 ** (dec0 - dec1)
}

// Human price of token0 in token1 at a tick (e.g. ETH price in USDC for range bounds).
export function priceAtTick(tick, dec0, dec1) {
  return 1.0001 ** tick * 10 ** (dec0 - dec1)
}
