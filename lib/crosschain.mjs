// Moves between the tracked chains (lib/config.mjs CHAINS). A bridge leg leaving one chain and a bridge
// leg arriving on another for the same wallet, in the same coin (ETH and WETH as one, a dollar token as
// itself on both chains, xAERO as AERO: `canon`), arriving within MATCH_SECONDS with at most what left
// and no less than MATCH_FLOOR of it, are one move inside the strategy: both become internal and the
// coins on the way count as held until they arrive (`transit`), so the bridge's fee shows as a loss and
// nothing as money in or out. A cross-chain swap (one coin leaving, another arriving within SWAP_SECONDS,
// worth SWAP_FLOOR..SWAP_CEIL of what left in dollars by `usd`) pairs the same way after same-coin moves:
// tighter than a same-coin move, since only the dollar values tie its two ends together. Solvers fill these
// within seconds to minutes, and what arrives is what left less fees and spread (a little more only when the
// coin's price moved in between). An intent-based bridge
// or cross-chain aggregator (LI.FI Intents, Mayan, NEAR Intents, Layerswap, Bungee) may pay the arrival
// from a solver no rule can know, or take the departure through a router no rule knows before handing it
// to a known bridge: when one end is a bridge, a one-way transfer on the other chain pairs with it on the
// same terms once known bridge pairs are taken. A bridge out still unmatched within MATCH_SECONDS of the
// newest data (`headTs`) is on its way: held, not money out, until it arrives or the time runs out.
// Anything else unmatched stays money in or out, as a bridge with an untracked chain is.
export const MATCH_SECONDS = 6 * 3600, MATCH_FLOOR_PCT = 97n
export const SWAP_SECONDS = 30 * 60, SWAP_FLOOR = 0.97, SWAP_CEIL = 1.005
// On the same chain a bridge out and in pair only as a fill moments later (Relay or Bungee settling a
// swap through two transactions), not a round trip through an untracked chain.
export const SAME_CHAIN_SECONDS = 15 * 60

// events: one wallet's ledger events from every chain, each with chain, block (on the common timeline),
// ts and legs. canon(asset) -> the coin it counts as; decimals(asset) -> its decimals; usd(leg, event) ->
// unsigned dollar value at that event's block, for cross-coin swaps.
export function matchCrossChain(events, canon, decimals, { headTs = Infinity, usd = null } = {}) {
  const outs = [], ins = [], straysIn = [], straysOut = []
  for (const e of events) {
    for (const g of e.legs) {
      if (g.amount === 0n) continue
      const x = { e, g, coin: canon(g.asset), dec: decimals(g.asset), usd: usd ? usd(g, e) : null }
      if (g.cls === 'bridge') (g.amount < 0n ? outs : ins).push(x)
      else if (g.cls === 'transfer' && !g.overridden && !g.fromOrder) {
        if (g.amount > 0n) straysIn.push(x)
        else if (g.review) straysOut.push(x)
      }
    }
  }
  const byTime = (a, b) => a.e.ts - b.e.ts || a.e.block - b.e.block
  outs.sort(byTime); ins.sort(byTime); straysIn.sort(byTime); straysOut.sort(byTime)
  const used = new Set(), transit = []
  // Every possible pair, the closest first (the shortest wait, then the smallest loss or value gap), so
  // transfers in flight together are not paired crosswise, and an unrelated later arrival does not take a
  // transfer's place. Same-coin pairs before swaps; known bridges on both ends before unknown counterparties.
  const pairUp = (departures, arrivals, sameChainOk, sameCoin) => {
    if (!sameCoin && !usd) return
    const pairs = []
    for (const o of departures) {
      if (used.has(o)) continue
      const sent = -o.g.amount
      for (const i of arrivals) {
        if (used.has(i)) continue
        const chainOk = i.e.chain !== o.e.chain || (sameChainOk && i.e.hash !== o.e.hash && i.e.ts - o.e.ts <= SAME_CHAIN_SECONDS)
        if (!chainOk || i.e.ts < o.e.ts || i.e.ts - o.e.ts > (sameCoin ? MATCH_SECONDS : SWAP_SECONDS)) continue
        if (sameCoin) {
          if (i.coin === o.coin && i.dec === o.dec && i.g.amount <= sent && i.g.amount * 100n >= sent * MATCH_FLOOR_PCT) pairs.push({ o, i, sent })
        } else if (i.coin !== o.coin && o.usd > 0 && i.usd > 0 && i.usd >= o.usd * SWAP_FLOOR && i.usd <= o.usd * SWAP_CEIL) {
          pairs.push({ o, i, sent, gap: Math.abs(i.usd - o.usd) / o.usd })
        }
      }
    }
    pairs.sort((a, b) => {
      const dt = (a.i.e.ts - a.o.e.ts) - (b.i.e.ts - b.o.e.ts)
      if (dt) return dt
      if (sameCoin) {
        const lost = (b.sent - b.i.g.amount) * a.sent - (a.sent - a.i.g.amount) * b.sent // compare (sent-got)/sent
        return (lost > 0n ? -1 : lost < 0n ? 1 : 0) || a.o.e.ts - b.o.e.ts
      }
      return a.gap - b.gap || a.o.e.ts - b.o.e.ts
    })
    for (const { o, i, sent } of pairs) {
      if (used.has(o) || used.has(i)) continue
      used.add(o); used.add(i)
      const swap = o.coin !== i.coin, bridge = o.e.bridge ?? i.e.bridge
      for (const x of [o, i]) {
        Object.assign(x.g, { cls: 'internal', crossChain: true, crossSwap: swap, sameChain: o.e.chain === i.e.chain, review: false, ...(bridge ? { bridge } : {}) })
        x.e.review = x.e.legs.some((g) => g.review)
      }
      // `received` and `receivedAsset`: what arrived, so a bridge fee or swap spread is not taken for an unexplained move.
      transit.push(
        { block: o.e.block, amount: sent, asset: o.coin, hash: o.e.hash, crossChain: true },
        { block: i.e.block, amount: -sent, asset: o.coin, hash: i.e.hash, crossChain: true, received: i.g.amount, receivedAsset: i.g.asset },
      )
    }
  }
  pairUp(outs, ins, true, true)
  pairUp(outs, ins, true, false)
  pairUp(outs, straysIn, false, true)
  pairUp(straysOut, ins, false, true)
  pairUp(outs, straysIn, false, false)
  pairUp(straysOut, ins, false, false)
  // Still on the way: held from when it left.
  for (const o of outs) {
    if (used.has(o) || o.e.ts <= headTs - MATCH_SECONDS) continue
    Object.assign(o.g, { cls: 'internal', crossChain: true, pending: true })
    transit.push({ block: o.e.block, amount: -o.g.amount, asset: o.coin, hash: o.e.hash, crossChain: true, pending: true })
  }
  return transit
}
