// What one wallet holds at the end of a block: wallet balances, LP positions (staked or not)
// with their token amounts, unclaimed AERO and what collect() would pay (fees plus any principal
// already removed but not yet collected; the caller separates the two).
// A read that fails for any reason other than "nothing there" throws, so a bad snapshot is never cached.
import { client } from './rpc.mjs'
import { erc20Abi, npmAbi, factoryAbi, clPoolAbi, gaugeAbi } from './abi.mjs'
import { TOKENS, NPMS } from './config.mjs'
import { amountsForLiquidity } from './univ3.mjs'
import { tryRead } from './errors.mjs'

const lc = (a) => a.toLowerCase()
const MAX128 = 2n ** 128n - 1n
const poolCache = new Map()

async function poolOf(npm, token0, token1, tickSpacing) {
  const k = `${npm}:${token0}:${token1}:${tickSpacing}`
  if (!poolCache.has(k)) {
    poolCache.set(k, client.readContract({ address: NPMS[npm].factory, abi: factoryAbi, functionName: 'getPool', args: [token0, token1, tickSpacing] }).then(lc))
  }
  return poolCache.get(k)
}

export async function snapshot(wallet, positions, block) {
  const blockNumber = BigInt(block)
  const W = wallet.address
  const balances = { ETH: await client.getBalance({ address: W, blockNumber }) }
  await Promise.all(Object.keys(TOKENS).map(async (t) => {
    // A token deployed after this block has no balance yet.
    balances[t] = (await tryRead(client.readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [W], blockNumber }))) ?? 0n
  }))

  // earned(account, ids) adds the account's deferred rewards to every answer, so read them once
  // per gauge and take them back out of the per-position figures.
  const gauges = [...new Set(positions.flatMap((p) => p.gauges))]
  const deferredBy = {}
  for (const g of gauges) {
    deferredBy[g] = (await tryRead(client.readContract({ address: g, abi: gaugeAbi, functionName: 'deferredEmissions', args: [W], blockNumber }))) ?? 0n
  }
  const deferred = Object.values(deferredBy).reduce((a, b) => a + b, 0n)

  const held = []
  await Promise.all(positions.map(async (p) => {
    const id = BigInt(p.tokenId)
    const [owner, pos] = await Promise.all([
      tryRead(client.readContract({ address: p.npm, abi: npmAbi, functionName: 'ownerOf', args: [id], blockNumber })),
      tryRead(client.readContract({ address: p.npm, abi: npmAbi, functionName: 'positions', args: [id], blockNumber })),
    ])
    if (!owner || !pos) return // not minted yet, or burned
    const o = lc(owner)
    let staked = false, gauge = null
    if (o !== W) {
      gauge = p.gauges.find((g) => g === o)
      if (!gauge) return
      staked = await client.readContract({ address: gauge, abi: gaugeAbi, functionName: 'stakedContains', args: [W, id], blockNumber })
      if (!staked) return
    }
    const [, , token0, token1, tickSpacing, tickLower, tickUpper, liquidity] = pos
    const pool = await poolOf(p.npm, token0, token1, tickSpacing)
    const [sqrtP, tick] = await client.readContract({ address: pool, abi: clPoolAbi, functionName: 'slot0', blockNumber })
    const { amount0, amount1, inRange } = amountsForLiquidity(sqrtP, tickLower, tickUpper, liquidity)
    let pending = 0n, fees0 = 0n, fees1 = 0n
    if (staked) {
      pending = await client.readContract({ address: gauge, abi: gaugeAbi, functionName: 'earned', args: [W, [id]], blockNumber })
      pending = pending > deferredBy[gauge] ? pending - deferredBy[gauge] : 0n
    } else if (liquidity > 0n || pos[10] > 0n || pos[11] > 0n) {
      // Uncollected fees: what collect() would pay the owner right now.
      const { result } = await client.simulateContract({
        address: p.npm, abi: npmAbi, functionName: 'collect', account: W, blockNumber,
        args: [{ tokenId: id, recipient: W, amount0Max: MAX128, amount1Max: MAX128 }],
      })
      ;[fees0, fees1] = result
    }
    held.push({
      npm: p.npm, tokenId: p.tokenId, pool, token0: lc(token0), token1: lc(token1), tickSpacing: Number(tickSpacing),
      tickLower: Number(tickLower), tickUpper: Number(tickUpper), tick: Number(tick), sqrtP,
      liquidity, amount0, amount1, inRange, staked, gauge, pending, fees0, fees1,
    })
  }))

  held.sort((a, b) => Number(BigInt(a.tokenId) - BigInt(b.tokenId)))
  return { block: Number(block), balances, positions: held, deferred }
}
