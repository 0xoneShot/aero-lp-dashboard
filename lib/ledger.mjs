// Turns the scanned transactions into each wallet's ledger: money in and out, rewards, fees,
// liquidity changes, gas and everything else ("internal": swaps and LP moves inside the strategy).
import { TOPIC } from './abi.mjs'
import { WALLETS, CHAINS, ZERO } from './config.mjs'
import { ethDelta } from './scan.mjs'
import { orderEscrows } from './orders.mjs'

const topicAddr = (t) => '0x' + t.slice(26).toLowerCase()
const word = (data, i) => BigInt('0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1)))
const posKey = (npm, id) => `${npm}:${id}`

// Who owns each LP position after every transaction that touches it. A position staked in a gauge
// belongs to the account the gauge staked it for. Position-manager events in a transaction are
// booked to the owner before it (or after it, for a mint), and a collect pays outstanding principal
// before fees, so principal removed in one transaction and collected in a later one is never a fee.
// Each position also records the blocks a snapshot has to read it for: from its mint (or its arrival
// from an outside address) until it is burned, and since when each gauge could hold it.
function positionsTimeline(txs, gaugeOk, walletList, NPMS) {
  const wallets = new Set(walletList.map((w) => w.address))
  const st = new Map() // key -> { npm, tokenId, holder, staker, owed0, owed1 }
  const perTx = new Map() // hash -> [{ key, before, after, lp: [], fees: [] }]
  const owedAt = new Map() // key -> [{ block, owed0, owed1 }]
  const owner = (s) => {
    if (!s || s.holder === ZERO) return null
    if (wallets.has(s.holder)) return s.holder
    if (s.staker && s.gauge === s.holder) return s.staker
    return s.holder
  }
  for (const rec of txs) {
    const touched = new Map()
    const touch = (npm, id) => {
      const key = posKey(npm, id)
      if (!st.has(key)) {
        // A position first seen arriving from somewhere (not minted in the scanned history) was that
        // sender's: a gauge returning it to whoever staked it, another wallet, or an outside address,
        // which makes it money coming in rather than a new mint. The transfer may come after a
        // collect or other position event in the same transaction, so look for it in the whole one.
        const t = rec.logs.find((x) => x.address === npm && x.topics[0] === TOPIC.Transfer && x.topics.length === 4 && BigInt(x.topics[3]).toString() === id)
        const from = t ? topicAddr(t.topics[1]) : ZERO, fromGauge = from !== ZERO && gaugeOk(from)
        // Minted here, or arriving from an outside address: it was nobody's here before. Otherwise
        // (from a gauge or a wallet, or first seen without a transfer) it existed before the scan.
        const born = t && (from === ZERO || (!fromGauge && !wallets.has(from))) ? rec.block : null
        st.set(key, { npm, tokenId: id, holder: from === ZERO ? null : from, staker: fromGauge ? topicAddr(t.topics[2]) : null, gauge: fromGauge ? from : null, owed0: 0n, owed1: 0n, gauges: new Set(fromGauge ? [from] : []), born, burned: null, gaugeSince: new Map(fromGauge ? [[from, 0]] : []) })
      }
      if (!touched.has(key)) touched.set(key, { key, before: owner(st.get(key)), lp: [], fees: [], collect: [0n, 0n], decrease: [0n, 0n] })
      return st.get(key)
    }
    for (const l of rec.logs) {
      const t0 = l.topics[0]
      if (t0 === TOPIC.Transfer && l.topics.length === 4 && NPMS[l.address]) {
        const s = touch(l.address, BigInt(l.topics[3]).toString())
        s.holder = topicAddr(l.topics[2])
        if (s.holder !== s.gauge) s.staker = null
        if (s.holder === ZERO) s.burned ??= rec.block
      } else if ((t0 === TOPIC.GaugeDeposit || t0 === TOPIC.GaugeWithdraw) && gaugeOk(l.address)) {
        const id = BigInt(l.topics[3]).toString()
        const nft = rec.logs.find((x) => x.topics[0] === TOPIC.Transfer && x.topics.length === 4 && NPMS[x.address] && BigInt(x.topics[3]).toString() === id)
        if (!nft) continue
        const s = touch(nft.address, id)
        s.gauges.add(l.address)
        if (!s.gaugeSince.has(l.address)) s.gaugeSince.set(l.address, rec.block)
        if (t0 === TOPIC.GaugeDeposit) { s.gauge = l.address; s.staker = topicAddr(l.topics[2]) }
        else { s.staker = null }
      } else if (NPMS[l.address] && l.topics.length >= 2 && [TOPIC.IncreaseLiquidity, TOPIC.IncreaseLiquidityV3, TOPIC.DecreaseLiquidity, TOPIC.Collect].includes(t0)) {
        const id = BigInt(l.topics[1]).toString()
        touch(l.address, id)
        const x = touched.get(posKey(l.address, id))
        const amount0 = word(l.data, 1), amount1 = word(l.data, 2) // after liquidity (or recipient, for Collect)
        if (t0 === TOPIC.Collect) { x.collect[0] += amount0; x.collect[1] += amount1 }
        else if (t0 === TOPIC.DecreaseLiquidity) { x.decrease[0] += amount0; x.decrease[1] += amount1; x.lp.push({ type: 'decrease', npm: l.address, tokenId: id, liquidity: word(l.data, 0), amount0, amount1 }) }
        else x.lp.push({ type: 'increase', npm: l.address, tokenId: id, liquidity: word(l.data, 0), amount0, amount1 })
      }
    }
    const list = []
    for (const x of touched.values()) {
      const s = st.get(x.key)
      // Principal removed becomes owed; a collect pays it first and the rest is trading fees.
      s.owed0 += x.decrease[0]; s.owed1 += x.decrease[1]
      const p0 = x.collect[0] < s.owed0 ? x.collect[0] : s.owed0
      const p1 = x.collect[1] < s.owed1 ? x.collect[1] : s.owed1
      s.owed0 -= p0; s.owed1 -= p1
      const f0 = x.collect[0] - p0, f1 = x.collect[1] - p1
      if (f0 || f1) x.fees.push({ npm: s.npm, tokenId: s.tokenId, amount0: f0, amount1: f1 })
      x.after = owner(s)
      x.npm = s.npm; x.tokenId = s.tokenId
      list.push(x)
      owedAt.set(x.key, [...(owedAt.get(x.key) ?? []), { block: rec.block, owed0: s.owed0, owed1: s.owed1 }])
    }
    if (list.length) perTx.set(rec.hash, list)
  }
  return { perTx, positions: st, owedAt }
}

// Principal removed from a position but not yet collected, as of the end of a block.
export function owedPrincipal(ledgerOwed, npm, tokenId, block) {
  let o = { owed0: 0n, owed1: 0n }
  for (const x of ledgerOwed.get(posKey(npm, tokenId)) ?? []) { if (x.block <= block) o = x; else break }
  return o
}

// The positions a snapshot at the end of block b has to read, each with the gauges that could hold it
// by then: none before it was minted or arrived from outside, none once burned. So opening a new
// position leaves the snapshots of finished days as they were.
export function positionsAt(positions, b) {
  return positions
    .filter((p) => (p.born == null || p.born <= b) && (p.burned == null || p.burned > b))
    .map((p) => ({ ...p, gauges: p.gauges.filter((g) => (p.gaugeSince?.[g] ?? 0) <= b) }))
}

// Every gauge the wallet's positions had joined by block b, burned positions included: a gauge keeps
// rewards it could not pay at withdrawal for the account (deferredEmissions) until they are claimed.
export function gaugesAt(positions, b) {
  return [...new Set(positions.flatMap((p) => p.gauges.filter((g) => (p.gaugeSince?.[g] ?? 0) <= b)))].sort()
}

// codeKind(address, block) -> 'eoa' | 'contract' (EIP-7702 accounts count as 'eoa').
// gaugeOk(address) -> whether a contract is a real gauge. overrides: { hash: { walletKey: cls } }.
// wallets defaults to the configured ones; tests pass their own. chain: whose transactions these are
// (lib/config.mjs CHAINS; Base by default): its tokens, position managers, routers, bridges, reward token.
export function buildLedger(state, codeKind, { gaugeOk = () => true, overrides = {}, wallets = WALLETS, chain = CHAINS.base } = {}) {
  const { tokens: TOKENS, npms: NPMS, bridges: BRIDGES, strategy: STRATEGY, rewardToken: AERO, weth: WETH } = chain
  const priced = (asset) => asset === 'ETH' || Boolean(TOKENS[asset])
  const txs = Object.values(state.txs).sort((a, b) => a.block - b.block || (a.index ?? 0) - (b.index ?? 0))
  const walletAddrs = new Set(wallets.map((w) => w.address))
  const keyOf = Object.fromEntries(wallets.map((w) => [w.address, w.key]))
  const { perTx, positions, owedAt } = positionsTimeline(txs, gaugeOk, wallets, NPMS)
  const orders = orderEscrows(txs, walletAddrs, chain)
  const out = {}

  for (const w of wallets) {
    const W = w.address
    const events = [], warnings = [], unpriced = new Set()
    const drainedTo = new Map() // where the wallet's orders paid out to someone else -> how that was booked
    for (const rec of txs) {
      const legs = []
      for (const l of rec.logs) {
        const t0 = l.topics[0]
        if (t0 === TOPIC.Transfer && l.topics.length === 3) {
          const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]), amt = BigInt(l.data)
          if (from === W && to !== W) legs.push({ asset: l.address, amount: -amt, cp: to })
          if (to === W && from !== W) legs.push({ asset: l.address, amount: amt, cp: from })
        } else if (l.address === WETH && t0 === TOPIC.WethDeposit && topicAddr(l.topics[1]) === W) {
          legs.push({ asset: WETH, amount: BigInt(l.data), cp: WETH })
        } else if (l.address === WETH && t0 === TOPIC.WethWithdrawal && topicAddr(l.topics[1]) === W) {
          legs.push({ asset: WETH, amount: -BigInt(l.data), cp: WETH })
        }
      }
      for (const g of rec.eth?.[W]?.legs ?? []) if (g.cp !== W) legs.push({ asset: 'ETH', amount: BigInt(g.value), cp: g.cp })
      // One of the wallet's orders paid its WETH to someone else: money leaving, for a CoW order with
      // another receiver, and for a 1inch order when nothing came back to the wallet in the same
      // transaction (a cross-chain order, or one paying another receiver); and such a payment coming back
      // to the order (a cancelled cross-chain order): money returning.
      const gotBack = legs.some((g) => g.amount > 0n)
      for (const d of orders.drains.get(rec.hash)?.get(W) ?? []) if (d.receiver || !gotBack) legs.push({ asset: WETH, amount: -d.amount, cp: d.to, fromOrder: true })
      for (const r of orders.returns.get(rec.hash)?.get(W) ?? []) legs.push({ asset: WETH, amount: r.amount, cp: r.from, fromOrder: true })
      const settled = orders.settled.get(rec.hash)?.has(W) ?? false // an order of the wallet's paid out here
      // The other wallet's order paying this one: a transfer between them.
      const payer = [...(orders.drains.get(rec.hash) ?? [])].find(([w2, ds]) => w2 !== W && ds.some((d) => d.to === W))?.[0]
      const gas = rec.from === W ? BigInt(rec.gasCost) : 0n

      // Rewards from real gauges, accepted only when the AERO actually reached the recipient.
      const claims = rec.logs.flatMap((l) => {
        if (!gaugeOk(l.address)) return []
        if (l.topics[0] === TOPIC.EmissionsClaimed) return [{ gauge: l.address, account: topicAddr(l.topics[1]), tokenId: BigInt(l.topics[2]).toString(), recipient: topicAddr(l.topics[3]), amount: BigInt(l.data) }]
        if (l.topics[0] === TOPIC.DeferredEmissionsClaimed) return [{ gauge: l.address, account: topicAddr(l.topics[1]), tokenId: null, recipient: topicAddr(l.topics[2]), amount: BigInt(l.data) }]
        return []
      })
      const paid = (r) => rec.logs.filter((l) => l.address === AERO && l.topics[0] === TOPIC.Transfer && l.topics.length === 3 && topicAddr(l.topics[2]) === r).reduce((a, l) => a + BigInt(l.data), 0n)
      const validClaims = claims.filter((c) => paid(c.recipient) + 1n >= claims.filter((x) => x.recipient === c.recipient).reduce((a, x) => a + x.amount, 0n))
      if (validClaims.length < claims.length && claims.some((c) => c.account === W)) warnings.push({ hash: rec.hash, block: rec.block, text: '奖励事件没有对应的 AERO 到账，已忽略' })
      const rewards = validClaims.filter((c) => c.account === W)
      // A claim paid to someone else: the wallet earned it, then sent it on.
      for (const r of rewards) if (r.recipient !== W) legs.push({ asset: AERO, amount: -r.amount, cp: r.recipient, viaClaim: true })

      // Liquidity, fees and position moves booked to this wallet.
      const lp = [], fees = [], nftMoves = []
      for (const x of perTx.get(rec.hash) ?? []) {
        const mine = x.before === W || (x.before == null && x.after === W)
        if (mine) { lp.push(...x.lp); fees.push(...x.fees) }
        if (x.before && x.after && x.before !== x.after && (x.before === W || x.after === W)) {
          const other = x.before === W ? x.after : x.before
          nftMoves.push({ npm: x.npm, tokenId: x.tokenId, dir: x.before === W ? 'out' : 'in', cp: other, cls: walletAddrs.has(other) ? 'between' : 'transfer' })
        }
      }

      const valueLegs = legs.filter((g) => priced(g.asset) && g.amount !== 0n)
      const unpricedLegs = legs.filter((g) => !priced(g.asset) && g.amount !== 0n)
      // Unpriced tokens matter unless they are airdrop spam: tokens nobody asked for, in someone else's
      // transaction (spam also fakes "sent from you" transfers). Asked for: the wallet's own
      // transaction, one with priced money moving too, the token delivered by a known router or
      // settlement contract (an order filled by someone else), or taken out alongside the wallet's
      // positions or rewards. Tokens the wallet received this way are valued at $0 in its figures
      // from then on.
      const ours = lp.length || fees.length || rewards.length || nftMoves.length
      if (unpricedLegs.length && (rec.from === W || valueLegs.length || settled || unpricedLegs.some((g) => STRATEGY[g.cp] || (ours && g.amount < 0n)))) {
        warnings.push({ hash: rec.hash, block: rec.block, kind: 'unpriced', text: `没有价格的代币：${[...new Set(unpricedLegs.map((g) => g.asset))].join(', ')}` })
        for (const g of unpricedLegs) if (g.amount > 0n) unpriced.add(g.asset)
      }
      if (!valueLegs.length && !gas && !rewards.length && !lp.length && !fees.length && !nftMoves.length) continue

      // Classify each leg: money in or out of the strategy versus a move inside it.
      const bridge = [...new Set(rec.logs.map((l) => BRIDGES[l.address]).filter(Boolean))][0] ?? null
      const strategyTx = rewards.length > 0 || lp.length > 0 || fees.length > 0
      const open = []
      for (const g of valueLegs) {
        if (g.fromOrder) {
          // Money coming back to an order counts the way it left.
          g.cls = walletAddrs.has(g.cp) ? 'between' : bridge ? 'bridge' : g.amount > 0n ? drainedTo.get(g.cp) ?? 'transfer' : 'transfer'
          g.review = g.cls === 'transfer'
          if (g.amount < 0n) drainedTo.set(g.cp, g.cls)
        } else if (payer && g.amount > 0n) { g.cls = 'between'; g.cp = payer }
        else if (g.asset === AERO && g.cp === ZERO && g.amount > 0n && validClaims.some((c) => c.recipient === W)) {
          const acct = validClaims.find((c) => c.recipient === W).account
          if (acct === W) g.cls = 'reward'
          else if (walletAddrs.has(acct)) { g.cls = 'between'; g.cp = acct }
          else g.cls = 'transfer'
        } else if (walletAddrs.has(g.cp)) g.cls = 'between'
        else if (bridge) g.cls = 'bridge'
        else if (strategyTx && !g.viaClaim) g.cls = 'internal'
        else if (settled && g.amount > 0n) g.cls = 'internal' // its proceeds or refund, whoever paid them
        else open.push(g)
      }
      const signs = new Set(open.map((g) => g.amount > 0n))
      for (const g of open) {
        if (signs.size > 1 && !g.viaClaim) g.cls = 'internal' // a swap: something went out and something came back
        else if (STRATEGY[g.cp] || orders.owner.get(g.cp) === W) g.cls = 'internal' // an order and its fill, a wrap
        else if (g.cp !== ZERO && codeKind(g.cp, rec.block) === 'eoa') g.cls = 'transfer'
        else { g.cls = 'transfer'; g.review = true } // one-way with an unknown contract: count it as money in or out, flag it
      }
      const forced = overrides[rec.hash]?.[w.key]
      if (forced) for (const g of valueLegs) if (g.cls !== 'reward') { g.cls = forced; g.review = false; g.overridden = true }

      const strayNft = rec.from === W && rec.logs.some((l) => l.topics[0] === TOPIC.Transfer && l.topics.length === 4 && !NPMS[l.address] && topicAddr(l.topics[2]) === W)
      if (strayNft) warnings.push({ hash: rec.hash, block: rec.block, text: '收到未知合约的 NFT，可能是没有计入的仓位' })

      events.push({
        hash: rec.hash, block: rec.block, ts: rec.ts, from: rec.from, to: rec.to, selector: rec.selector,
        status: rec.status, own: rec.from === W, bridge, legs: valueLegs, gas, rewards, lp, fees, nftMoves,
        review: valueLegs.some((g) => g.review),
      })
    }

    const mine = [...positions.values()].filter((s) => [...perTx.values()].some((list) => list.some((x) => x.key === posKey(s.npm, s.tokenId) && (x.before === W || x.after === W))))
    out[w.key] = {
      key: w.key, address: W, events, warnings, unpriced: [...unpriced],
      positions: mine.map((s) => ({ npm: s.npm, tokenId: s.tokenId, gauges: [...s.gauges], born: s.born, burned: s.burned, gaugeSince: Object.fromEntries(s.gaugeSince) })),
      escrow: orders.moves.get(W) ?? [],
      openingBlock: state.wallets[w.key].openingBlock,
      openingEth: BigInt(state.wallets[w.key].openingEth),
    }
  }
  out.owedAt = owedAt
  out.keyOf = keyOf
  return out
}

export const isExternal = (cls) => cls === 'transfer' || cls === 'bridge' || cls === 'between'
export { ethDelta }
