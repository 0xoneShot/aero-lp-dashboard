// "What if everything put in had just been held": every coin that came in is kept in that coin (ETH
// and WETH count as one). Money taken out comes out of those holdings: first from the same coin, as
// far as they hold it, and the rest pro rata to what each holding was worth at the time, the way a fund
// pays out by selling a slice of everything it holds. Nothing more is taken once they are empty.
//
// flows: [{ asset, amount (signed raw units), usd (signed, at the time), prices (at the time) }] in
// time order. keyOf(asset) merges coins; valueOf(key, raw, prices) values raw units of a key.
// Returns Map key -> raw units held.
export function hodlHeld(flows, keyOf, valueOf) {
  const held = new Map()
  const SCALE = 10n ** 12n
  for (const f of flows) {
    const k = keyOf(f.asset), a = BigInt(f.amount)
    if (a === 0n) continue
    if (a > 0n) { held.set(k, (held.get(k) ?? 0n) + a); continue }
    const out = -a, same = held.get(k) ?? 0n, take = out < same ? out : same
    if (take > 0n) held.set(k, same - take)
    if (take === out) continue
    // The part not covered by the same coin, in dollars at the time.
    const rest = Math.abs(f.usd) * (Number(out - take) / Number(out))
    const worth = [...held].map(([key, x]) => [key, x, Math.max(0, valueOf(key, x, f.prices) ?? 0)])
    const total = worth.reduce((s, [, , v]) => s + v, 0)
    if (!(rest > 0) || !(total > 0)) continue
    const keep = BigInt(Math.round(Math.max(0, 1 - rest / total) * 1e12))
    for (const [key, x] of worth) held.set(key, (x * keep) / SCALE)
  }
  return held
}
