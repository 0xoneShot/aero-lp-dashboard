// Where the owners' money suits best among the compared pools (lib/pools.mjs), and whether moving it
// there pays: for the pool card and the switch alert (src/run.mjs, lib/alerts.mjs). Pure.
//
// Every option (a pool, staked or not) is judged by its median daily rate against what the positions
// earn where they are now (each at its pool's rate for how it is held), for all the money (money outside
// positions would go wherever the rest is): the extra a day, what moving the positions costs, how many
// days of the extra pay for it, and whether it leads steadily (its bad days, the lower quartile, beat the
// best rate the money has now, and it led in each of the last two Aero weeks). With no position the
// money has only to go in. Pools with under 3 days of data, or read more than a day ago, are not picked.
//
// Rates within SWITCH.gap of each other are as good as tied: daily rates swing between about 100% and
// 500%, and which of two such pools leads did not last from one day or week to the next (2026-10-22..
// 11-01, and six months of Base's previous pools). So when what the money earns now is within the gap of
// the top, staying is the pick. Otherwise, among the options tied with the top: one holding most of the
// money already, then one on a chain the dashboard tracks, then the most earned over a week after the
// cost of moving. The alert names the pick when it meets all its conditions, else the one picked the
// same way among those that do (the card then names that one too).
//
// cost: gas for leaving and entering at each chain's gas price now, in gas units of real transactions
// (2026-10, Aero's router on Base and Ethereum: unstake and withdraw 700-770k, mint and stake 790-930k, a
// swap 330-400k; L2 data fees not counted); swapping half the money back to the new range's ratio; and a
// bridge between chains (0.05%: live quotes for $28k were 0.01-0.02%, and Relay took about 0.02% on the
// owners' own move). Staking or unstaking in the same pool costs only that transaction.
import { SWITCH } from './alerts.mjs'

export const GAS_UNITS = { exit: 300_000, unstake: 470_000, enter: 850_000, stake: 500_000, bridge: 150_000 }
const SWAP_COST = 0.0005 / 2, BRIDGE_COST = 0.0005

const r2 = (x) => Math.round(x * 100) / 100
const r6 = (x) => Math.round(x * 1e6) / 1e6
const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + f(x), 0)

// pools: the card's rows (chain, chain_label, label, pool_address, days, age_h, stopped, staked/fee
// {median, p25}, weeks). positions: the live ones, { chain, pool, staked, usd }. gas: { chain: { wei,
// token } }; ethUsd; tracked(chain): whether the dashboard tracks wallets there; chainLabel(chain).
export function switchTo({ pools, positions, myUsd, gas = {}, ethUsd, tracked, chainLabel = (c) => c }) {
  const options = pools.flatMap((p) => ['staked', 'fee'].map((mode) => ({ p, mode, median: p[mode].median, p25: p[mode].p25 })))
    .filter((o) => o.median != null && o.p.days >= 3 && o.p.age_h != null && o.p.age_h <= 24)
  if (!options.length || !(myUsd > 0)) return null
  const gasUsd = (chain, units) => { const g = gas[chain]; return g ? (units * Number(g.wei)) / 1e18 * (g.token === 'usd' ? 1 : ethUsd) : 0 }
  const now = positions.map((x) => {
    const p = pools.find((q) => q.chain === x.chain && q.pool_address === x.pool), mode = x.staked ? 'staked' : 'fee'
    // Staked in a pool whose rewards stopped earns nothing.
    return { ...x, p, mode, rate: p ? (p.stopped && mode === 'staked' ? 0 : p[mode].median) : null }
  })
  // A position in a pool not compared (or not paying) has no rate: what the money earns now is unknown.
  const known = now.filter((n) => n.rate != null), inKnown = sum(known, (n) => n.usd), allKnown = known.length === now.length
  const inPositions = sum(now, (n) => n.usd)
  const current = inKnown > 0 ? sum(known, (n) => n.usd * n.rate) / inKnown : 0
  const weekOf = (p, mode, start) => p?.weeks.find((w) => w.start === start && w.hours >= 24)?.[mode] ?? null
  const judge = (o) => {
    const cost = sum(now, (n) => {
      const to = o.p.chain
      if (n.p === o.p) return n.mode === o.mode ? 0 : gasUsd(n.chain, o.mode === 'staked' ? GAS_UNITS.stake : GAS_UNITS.unstake)
      let c = gasUsd(n.chain, GAS_UNITS.exit + (n.staked ? GAS_UNITS.unstake : 0)) + gasUsd(to, GAS_UNITS.enter + (o.mode === 'staked' ? GAS_UNITS.stake : 0)) + n.usd * SWAP_COST
      if (n.chain !== to) c += n.usd * BRIDGE_COST + gasUsd(n.chain, GAS_UNITS.bridge)
      return c
    }) + (now.length ? 0 : gasUsd(o.p.chain, GAS_UNITS.enter + (o.mode === 'staked' ? GAS_UNITS.stake : 0)) + myUsd * SWAP_COST)
    const extra = allKnown ? ((o.median - current) * myUsd) / 365 : null
    const starts = o.p.weeks.filter((w) => w.hours >= 24).map((w) => w.start).slice(-2)
    const weeksAhead = starts.filter((d) => {
      const b = weekOf(o.p, o.mode, d), c = known.map((n) => [n.usd, weekOf(n.p, n.mode, d)])
      return b != null && c.every(([, r]) => r != null) && b > (inKnown > 0 ? sum(c, ([u, r]) => u * r) / inKnown : 0)
    }).length
    return {
      to: { chain: o.p.chain, chain_label: o.p.chain_label, label: o.p.label, mode: o.mode, median: r6(o.median), p25: o.p25 == null ? null : r6(o.p25), days: o.p.days, tracked: tracked(o.p.chain) },
      here: now.length > 0 && now.every((n) => n.p === o.p && n.mode === o.mode),
      // The share of the money in positions that is already in this option.
      held: inPositions > 0 ? r6(sum(now.filter((n) => n.p === o.p && n.mode === o.mode), (n) => n.usd) / inPositions) : 0,
      gap: allKnown ? r6(o.median - current) : null, extra_day_usd: extra == null ? null : r2(extra), cost_usd: r2(cost), payback_days: extra > 0 ? r2(cost / extra) : null,
      weeks_ahead: weeksAhead, weeks_compared: starts.length,
      stable: allKnown && o.p25 != null && known.length > 0 && o.p25 > Math.max(...known.map((n) => n.rate)) && starts.length === 2 && weeksAhead === 2,
    }
  }
  const judged = options.map((o) => ({ o, j: judge(o) }))
  const best = judged.reduce((a, x) => (x.o.median > a.o.median ? x : a))
  const meets = (j) => !j.here && j.stable && j.to.days >= SWITCH.days && j.gap >= SWITCH.gap && j.payback_days != null && j.payback_days <= SWITCH.payback
  const net = (x) => (x.j.extra_day_usd ?? 0) * 7 - x.j.cost_usd
  const prefer = (xs) => {
    const top = Math.max(...xs.map((x) => x.o.median)), tied = xs.filter((x) => x.o.median > top - SWITCH.gap)
    return tied.find((x) => x.j.here) ?? tied.find((x) => x.j.held >= 0.5)
      ?? tied.reduce((a, x) => (!a || (x.j.to.tracked && !a.j.to.tracked) || (x.j.to.tracked === a.j.to.tracked && net(x) > net(a)) ? x : a), null)
  }
  // Staying: the money already earns within the gap of the top (wherever its positions are).
  const stay = allKnown && known.length > 0 && current > best.o.median - SWITCH.gap
  const pick = prefer(judged), qualifying = judged.filter((x) => meets(x.j))
  const steady = meets(pick.j) ? pick : qualifying.length ? prefer(qualifying) : null
  return {
    ...best.j, steady: steady ? steady.j : null, pick: pick.j, stay,
    from: now.map((n) => ({ chain: n.chain, chain_label: chainLabel(n.chain), label: n.p?.label ?? null, mode: n.mode, usd: r2(n.usd), rate: n.rate == null ? null : r6(n.rate) })),
    current: allKnown && known.length ? r6(current) : null,
  }
}
