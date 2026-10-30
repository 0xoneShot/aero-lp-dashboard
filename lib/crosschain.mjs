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
  const used = new Set(), transit = []
  for (const o of outs) {
    const sent = -o.g.amount
    const i = ins.find((x) => !used.has(x) && x.e.chain !== o.e.chain && x.coin === o.coin && x.dec === o.dec &&
      x.e.ts >= o.e.ts && x.e.ts - o.e.ts <= MATCH_SECONDS && x.g.amount <= sent && x.g.amount * 100n >= sent * MATCH_FLOOR_PCT)
    if (!i) continue
    used.add(i)
    for (const x of [o, i]) { x.g.cls = 'internal'; x.g.crossChain = true }
    transit.push({ block: o.e.block, amount: sent, asset: o.coin, hash: o.e.hash, crossChain: true }, { block: i.e.block, amount: -sent, asset: o.coin, hash: i.e.hash, crossChain: true })
  }
  return transit
}
