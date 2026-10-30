// Moves between the tracked chains (lib/config.mjs CHAINS). A bridge leg leaving one chain and a bridge
// leg arriving on another for the same wallet, in the same coin (ETH and WETH as one, a dollar token as
// itself on both chains, xAERO as AERO: `canon`), arriving within MATCH_SECONDS with at most what left
// and no less than MATCH_FLOOR of it, are one move inside the strategy: both become internal and the
// coins on the way count as held until they arrive (`transit`), so the bridge's fee shows as a loss and
// nothing as money in or out. Anything unmatched stays money in or out, as a bridge with an untracked
// chain is.
export const MATCH_SECONDS = 6 * 3600, MATCH_FLOOR_PCT = 97n

// events: one wallet's ledger events from every chain, each with chain, block (on the common timeline),
// ts and legs. canon(asset) -> the coin it counts as; decimals(asset) -> its decimals.
export function matchCrossChain(events, canon, decimals) {
  const outs = [], ins = []
  for (const e of events) {
    for (const g of e.legs) if (g.cls === 'bridge' && g.amount !== 0n) (g.amount < 0n ? outs : ins).push({ e, g, coin: canon(g.asset), dec: decimals(g.asset) })
  }
  const byTime = (a, b) => a.e.ts - b.e.ts || a.e.block - b.e.block
  outs.sort(byTime); ins.sort(byTime)
  // Every possible pair, the closest first (the shortest wait, then the least lost), so transfers in
  // flight together are not paired crosswise, and an unrelated later arrival does not take a transfer's
  // place.
  const pairs = []
  for (const o of outs) {
    const sent = -o.g.amount
    for (const i of ins) {
      if (i.e.chain !== o.e.chain && i.coin === o.coin && i.dec === o.dec && i.e.ts >= o.e.ts && i.e.ts - o.e.ts <= MATCH_SECONDS &&
        i.g.amount <= sent && i.g.amount * 100n >= sent * MATCH_FLOOR_PCT) pairs.push({ o, i, sent })
    }
  }
  pairs.sort((a, b) => {
    const lost = (b.sent - b.i.g.amount) * a.sent - (a.sent - a.i.g.amount) * b.sent // compare (sent-got)/sent
    return (a.i.e.ts - a.o.e.ts) - (b.i.e.ts - b.o.e.ts) || (lost > 0n ? -1 : lost < 0n ? 1 : 0) || a.o.e.ts - b.o.e.ts
  })
  const used = new Set(), transit = []
  for (const { o, i, sent } of pairs) {
    if (used.has(o) || used.has(i)) continue
    used.add(o); used.add(i)
    for (const x of [o, i]) { x.g.cls = 'internal'; x.g.crossChain = true }
    // `received`: what arrived, so the bridge's fee is not taken for an unexplained move.
    transit.push({ block: o.e.block, amount: sent, asset: o.coin, hash: o.e.hash, crossChain: true }, { block: i.e.block, amount: -sent, asset: o.coin, hash: i.e.hash, crossChain: true, received: i.g.amount })
  }
  return transit
}
