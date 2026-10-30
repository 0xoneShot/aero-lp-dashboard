// USD prices at a block, read from on-chain pools and feeds (state after that block). USDC is the $1 unit.
import { parseAbi } from 'viem'
import { client } from './rpc.mjs'
import { uniV3PoolAbi, clPoolAbi, vammAbi } from './abi.mjs'
import { PRICE, ALL_TOKENS as TOKENS } from './config.mjs'
import { tryRead } from './errors.mjs'

const Q192 = 2n ** 192n
const feedAbi = parseAbi(['function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'])

// Price of token0 in token1 from sqrtPriceX96, kept exact until the final division.
function sqrtToPrice(sqrtP, dec0, dec1) {
  const num = BigInt(sqrtP) * BigInt(sqrtP) * 10n ** BigInt(dec0)
  const den = Q192 * 10n ** BigInt(dec1)
  return Number((num * 10n ** 18n) / den) / 1e18
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const FEEDS = [...new Set(Object.values(TOKENS).map((t) => t.price).filter((p) => p.startsWith('feed:')))]
const cache = new Map()

export async function pricesAt(block) {
  const key = Number(block)
  if (cache.has(key)) return cache.get(key)
  const p = (async () => {
    const blockNumber = BigInt(block)
    const [s] = await client.readContract({ address: PRICE.ethPool, abi: uniV3PoolAbi, functionName: 'slot0', blockNumber })
    const out = { block: key, eth: sqrtToPrice(s, 18, 6), aero: null, usd: 1 }
    if (key >= PRICE.aeroMarketFromBlock) {
      // A pool that is not deployed or empty is skipped; any other read error fails the run.
      const [vamm, clUsdc, clWeth] = await Promise.all([
        tryRead(client.readContract({ address: PRICE.aeroVamm, abi: vammAbi, functionName: 'getReserves', blockNumber })),
        tryRead(client.readContract({ address: PRICE.aeroClUsdc, abi: clPoolAbi, functionName: 'slot0', blockNumber })),
        tryRead(client.readContract({ address: PRICE.aeroClWeth, abi: clPoolAbi, functionName: 'slot0', blockNumber })),
      ])
      const vals = []
      if (vamm && vamm[0] > 0n) vals.push(Number(vamm[1]) / 1e6 / (Number(vamm[0]) / 1e18))
      if (clUsdc) vals.push(sqrtToPrice(clUsdc[0], 18, 6))
      if (clWeth) vals.push(sqrtToPrice(clWeth[0], 18, 18) * out.eth)
      out.aero = median(vals)
      if (out.aero == null) throw new Error(`no AERO price at block ${key}`)
    }
    for (const f of FEEDS) {
      const r = await tryRead(client.readContract({ address: f.slice(5), abi: feedAbi, functionName: 'latestRoundData', blockNumber }))
      out[f] = r ? Number(r[1]) / 1e8 : null
    }
    return out
  })()
  cache.set(key, p)
  p.catch(() => cache.delete(key))
  return p
}

// USD value of a raw token amount (bigint) at the given prices; null when the token has no price.
export function usdOf(token, raw, prices) {
  const t = TOKENS[token.toLowerCase()]
  if (!t) return null
  const unit = prices[t.price]
  if (unit == null) return null
  return (Number(raw) / 10 ** t.decimals) * unit
}
