// Moves between the tracked chains (lib/config.mjs CHAINS). A bridge leg leaving one chain and a bridge
// leg arriving on another for the same wallet, in the same coin (ETH and WETH as one, a dollar token as
// itself on both chains, xAERO as AERO: `canon`), arriving within MATCH_SECONDS with at most what left
// and no less than MATCH_FLOOR of it, are one move inside the strategy: both become internal and the
// coins on the way count as held until they arrive (`transit`), so the bridge's fee shows as a loss and
// nothing as money in or out. An intent-based bridge (LI.FI Intents, Mayan, NEAR Intents, Layerswap) pays
// the arrival from a solver no rule can know, a plain account or its own contract: a one-way arrival
// booked as money in can be the other side of a bridge out, on another chain and on the same terms, when
// no bridge arrival is. A bridge out still unmatched within MATCH_SECONDS of the newest data (`headTs`) is
// on its way: held, not money out, until it arrives or the time runs out. Anything else unmatched stays
// money in or out, as a bridge with an untracked chain is.
export const MATCH_SECONDS = 6 * 3600, MATCH_FLOOR_PCT = 97n
// On the same chain a bridge out and in pair only as a fill moments later (Relay settling a swap through
// its own transfer), not a round trip through an untracked chain.
export const SAME_CHAIN_SECONDS = 15 * 60

// events: one wallet's ledger events from every chain, each with chain, block (on the common timeline),
// ts and legs. canon(asset) -> the coin it counts as; decimals(asset) -> its decimals.
export function matchCrossChain(events, canon, decimals, { headTs = Infinity } = {}) {
  const outs = [], ins = [], strays = []
  for (const e of events) {
    for (const g of e.legs) {
      if (g.amount === 0n) continue
      const x = { e, g, coin: canon(g.asset), dec: decimals(g.asset) }
      if (g.cls === 'bridge') (g.amount < 0n ? outs : ins).push(x)
      else if (g.cls === 'transfer' && g.amount > 0n && !g.overridden) strays.push(x)
    }
  }
  const byTime = (a, b) => a.e.ts - b.e.ts || a.e.block - b.e.block
  outs.sort(byTime); ins.sort(byTime); strays.sort(byTime)
  const used = new Set(), transit = []
  // Every possible pair, the closest first (the shortest wait, then the least lost), so transfers in
  // flight together are not paired crosswise, and an unrelated later arrival does not take a transfer's
  // place. Bridge arrivals first; then, for what is left, arrivals from unknown payers on another chain.
  const pairUp = (arrivals, sameChainOk) => {
    const pairs = []
    for (const o of outs) {
      if (used.has(o)) continue
      const sent = -o.g.amount
      for (const i of arrivals) {
        if (used.has(i)) continue
        const chainOk = i.e.chain !== o.e.chain || (sameChainOk && i.e.hash !== o.e.hash && i.e.ts - o.e.ts <= SAME_CHAIN_SECONDS)
        if (chainOk && i.coin === o.coin && i.dec === o.dec && i.e.ts >= o.e.ts && i.e.ts - o.e.ts <= MATCH_SECONDS &&
          i.g.amount <= sent && i.g.amount * 100n >= sent * MATCH_FLOOR_PCT) pairs.push({ o, i, sent })
      }
    }
    pairs.sort((a, b) => {
      const lost = (b.sent - b.i.g.amount) * a.sent - (a.sent - a.i.g.amount) * b.sent // compare (sent-got)/sent
      return (a.i.e.ts - a.o.e.ts) - (b.i.e.ts - b.o.e.ts) || (lost > 0n ? -1 : lost < 0n ? 1 : 0) || a.o.e.ts - b.o.e.ts
    })
    for (const { o, i, sent } of pairs) {
      if (used.has(o) || used.has(i)) continue
      used.add(o); used.add(i)
      for (const x of [o, i]) { x.g.cls = 'internal'; x.g.crossChain = true; x.g.sameChain = o.e.chain === i.e.chain; x.g.review = false }
      // `received`: what arrived, so the bridge's fee is not taken for an unexplained move.
      transit.push({ block: o.e.block, amount: sent, asset: o.coin, hash: o.e.hash, crossChain: true }, { block: i.e.block, amount: -sent, asset: o.coin, hash: i.e.hash, crossChain: true, received: i.g.amount })
    }
  }
  pairUp(ins, true)
  pairUp(strays, false)
  // Still on the way: held from when it left.
  for (const o of outs) {
    if (used.has(o) || o.e.ts <= headTs - MATCH_SECONDS) continue
    Object.assign(o.g, { cls: 'internal', crossChain: true, pending: true })
    transit.push({ block: o.e.block, amount: -o.g.amount, asset: o.coin, hash: o.e.hash, crossChain: true, pending: true })
  }
  return transit
}
