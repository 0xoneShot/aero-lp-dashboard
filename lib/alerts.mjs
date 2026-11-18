// Which phone alerts the latest summary calls for, given what was already sent. Pure: takes the
// summary rows and the previous state, returns the messages and the next state.
//
// Per wallet and per range (a wallet's positions with the same bounds count as one):
//   near   the pool price came within NEAR of the lower bound (re-armed once it is REARM away again)
//   below  the price left the range downwards: the position is all ETH and earns nothing
//   above  the price left the range upwards: all USDC
//   (a WETH/cbBTC position follows the price of ETH in cbBTC, and is said in it: all cbBTC above)
//   back   the price came back into the range, by more than BACK (so a price hovering at a bound
//          does not send 跌出/回到 every hour)
//   out24  the range has been out (below or above) for OUT_MS in a row, once per time out: in backtests of a
//          narrow range that follows the price, re-placing it after a day out did better than at once, and
//          most exits that come back do so within the day. Its state `<range>:out` holds when the run of
//          out-of-range updates began (`:sent` once said); back inside the bounds, even within BACK, it ends.
//          It never comes in the same run as its range's 跌出 or 涨出, nor while one is still to be sent.
//          A range whose side was already out in a state from before this clock existed (no clock kept for it)
//          counts as said: how long it has been out is not known, and its owner has seen it out before. A range
//          first seen already out (an address just added) gets no 跌出 or 涨出, and its day counts from then.
//          It sets the pool's 平常 (as the money is held there) against the loss line (both at the table's
//          width; they scale nearly alike with it, so which is higher holds at any width) and, for a
//          WETH/USDC range only when 平常 is known to clear the line, says where a range as wide lies around
//          the price, on the pool's tick grid, and how much of what comes out to swap first; a stopped gauge
//          is said instead (putBackRates; the page says the same). The page reads the clock too (lib/outclock.mjs).
// Per wallet, while it holds its ETH out of range (all below, or withdrawn):
//   cost   ETH rose to the cost price, where selling keeps the money put in and all the interest
//          (re-armed once ETH is REARM below it again). An address added on the page that moved money
//          with other tracked wallets takes the cost price of a combined view holding it and all of them
//          (costSources), here and in its 跌出 message, and names who it is counted with, while it holds
//          0.05 ETH or more itself; with no such view, its own, said to count it alone. While that view is
//          missing from an update it waits (one that went out of range meanwhile is told on the view's price
//          once the view is back). A change of the price it is judged against starts afresh from where ETH
//          is: a state already judged is told at once if ETH is above the new price. A configured wallet's
//          cost price is always its own.
// Per wallet, once per new token or transaction:
//   unpriced  a position or fee holds a token with no price source, so the figures are incomplete
//   check     a transaction the rules could not settle (summary.to_check): a person has to look
// Per wallet, once per better place for its money (summary pool_compare.switch, src/run.mjs):
//   switch    the best option meeting every condition (src/run.mjs switch.steady): another pool, or
//             staking where it is, has earned at least SWITCH.gap more a year by the
//             median of SWITCH.days or more days, leads steadily (its bad days, the lower quartile, still
//             beat what the money earns now, and it led in each of the last two Aero weeks), and the
//             extra pays for moving within SWITCH.payback days. Said again only for an option that beats
//             those already said by half the gap, or for the same one after its lead fell below half the gap. Not while any pool is still
//             being read over the window (the first runs after a pool or chain is added).
// For the whole dashboard:
//   stale     the data is more than STALE_MS old: the hourly update keeps failing
//   fresh     it is up to date again
// The first run only records the state, so turning alerts on sends nothing until something changes.
// While the update fails, the alerts run on the last summary with live pool prices (withLivePrices).
// Its positions may have changed since (the owner may have withdrawn), so then a range coming back,
// and the cost state lapsing because the old ranges look in range again, wait for fresh data; without
// live prices nothing price-driven moves.
import { recentre, splitShare } from './curve.mjs'

export const NEAR = 0.01, REARM = 0.02, BACK = 0.005, STALE_MS = 2 * 3600e3, OUT_MS = 24 * 3600e3
// gap: 30 points a year. Between pools of the same pair, daily leads of 15-45 points come and go (liquidity
// follows emissions and evens the rates out); a lead that persisted, in six months of Base pools, was a
// lasting structural one, as staking against not staking.
export const SWITCH = { gap: 0.3, days: 7, payback: 3 }

// To the cent: an alert fires just past a threshold, where whole dollars could read as equal.
const usd = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)
const pct = (v) => `${(Math.abs(v) * 100).toFixed(2)}%`
const up = (v) => Math.ceil(v * 100) / 100 // a price to sell at or above, rounded up
// As the page writes dollars and ETH amounts (dashboard/index.html fmtUsd, fmtEth): whole dollars from $100
// (bounds to type in, amounts to swap).
const usd0 = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v)
const money = (v) => (Math.abs(v) >= 100 ? usd0(v) : usd(v))
const ethAmount = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 0.1 ? 2 : 4 })
// Two rates as the page writes them (whole percents from 10%), with a decimal more while they would read
// the same: 平常 and the loss line side by side must show which is higher.
function ratePair(a, b) {
  const f = (v, d) => `${(v * 100).toFixed(Math.max(d, v < 0.1 ? 1 : 0))}%`
  let d = 0
  while (d < 2 && f(a, d) === f(b, d)) d++
  return [f(a, d), f(b, d)]
}

// Chains other than Base, as messages name them.
const CHAIN_NAMES = { eth: '以太坊' }

// A range's bounds as its state is keyed: against another coin in the coin, since its dollar bounds move
// with the coin's price every update and its own do not.
const boundsOf = (p) => (p.quote ? `${p.quote.low}-${p.quote.high}` : `${p.low}-${p.high}`)
const stateKey = (scope, chain, bounds) => `${scope}:${chain === 'base' ? '' : chain + ':'}${bounds}`
// The key of the clock of a published position's range in wallet `scope` (lib/outclock.mjs reads it for the page).
export const outKeyOf = (scope, p) => `${stateKey(scope, p.chain ?? 'base', boundsOf(p))}:out`

function ranges(row) {
  const out = []
  for (const p of row.curve?.positions ?? []) {
    const chain = p.chain ?? 'base'
    const bounds = boundsOf(p)
    const same = out.find((q) => q.bounds === bounds && q.chain === chain)
    // Positions of one range hold its liquidity together.
    if (same) { same.in_range ||= p.in_range; same.held ||= Boolean(p.held); same.L = Number.isFinite(same.L) && Number.isFinite(p.L) ? same.L + p.L : null }
    else out.push({ low: p.low, high: p.high, bounds, quote: p.quote ?? null, pool: p.pool, pool_address: p.pool_address ?? null, in_range: p.in_range, chain, held: Boolean(p.held),
      tick_lower: p.tick_lower, tick_upper: p.tick_upper, invert: Boolean(p.invert), L: Number.isFinite(p.L) ? p.L : null, sa: p.sa, sb: p.sb })
  }
  return out
}
const rangeKey = (row, r) => stateKey(row.scope, r.chain, r.bounds)

// Whether a range out for a day is worth putting back, as the page says it too (dashboard/index.html
// actOf): its pool's 平常 in the table, staked unless none of the money there is (the column the page
// puts the loss line under), against the loss line, both at the table's width. `both` only when both are
// numbers; `stopped` when the gauge has stopped paying and 平常 is the staked one (then it is null).
export function putBackRates(poolRow, costLine) {
  const mode = poolRow?.here === 'unstaked' ? 'fee' : 'staked'
  const usual = poolRow?.fixed?.[mode]?.median, line = costLine?.rate
  const both = Number.isFinite(usual) && Number.isFinite(line)
  return { both, under: both && usual < line, usual, line, stopped: !both && mode === 'staked' && poolRow?.stopped === true }
}

// For the day-out message of a WETH/USDC range: where a range as wide as this one lies around its pool's
// price now, on the pool's tick grid (spacing n from the table's 'CL{n}'; without it the same width, not
// aligned), and, from the range's own liquidity (the rewards stay aside), what withdrawing it gives and how
// much of that to swap first so the new range takes all of it: out above, all USDC, of which its ETH share
// at the price goes into ETH; out below, all ETH, of which the dollar share goes into USDC.
function putBack(r, side, spacing) {
  const P = r.pool
  if (!(P > 0)) return ''
  const nb = recentre(r, P, spacing)
  if (!(nb.low > 0 && nb.high > nb.low)) return ''
  let swap = ''
  if (r.L > 0 && [r.sa, r.sb].every(Number.isFinite)) {
    const [e, u] = amountsAt(r, P), s = splitShare(nb.low, nb.high, P)
    swap = side === 'above' ? `；撤出后约 ${money(u)} USDC，先把约 ${money(u * s)} USDC 换成 ETH` : `；撤出后约 ${ethAmount(e)} ETH，先把约 ${ethAmount(e * (1 - s))} ETH 换成 USDC`
  }
  return `要按现价重挂、宽度不变的话：${money(nb.low)} – ${money(nb.high)}${swap}。`
}

function sideOf(r, prev) {
  if (!r.in_range) return r.pool < (r.low + r.high) / 2 ? 'below' : 'above'
  if (prev === 'below' && (r.pool - r.low) / r.pool < BACK) return 'below'
  if (prev === 'above' && (r.high - r.pool) / r.pool < BACK) return 'above'
  const dist = (r.pool - r.low) / r.pool
  return dist <= NEAR || (prev === 'near' && dist <= REARM) ? 'near' : 'in'
}

const sideState = (positions) => {
  const sides = positions.map((p) => (p.in_range ? 'in' : p.pool < (p.low + p.high) / 2 ? 'below' : 'above'))
  return !sides.length ? 'none' : sides.every((x) => x === 'in') ? 'in' : sides.some((x) => x === 'in') ? 'part'
    : sides.every((x) => x === 'below') ? 'below' : sides.every((x) => x === 'above') ? 'above' : 'gap'
}

// ETH and USDC in a WETH/USDC position at pool price P (src/run.mjs ethCurve, the page's amountsAt).
function amountsAt(p, P) {
  const r = Math.sqrt(P * 1e-12)
  if (r <= p.sa) return [(p.L * (1 / p.sa - 1 / p.sb)) / 1e18, 0]
  if (r < p.sb) return [(p.L * (1 / r - 1 / p.sb)) / 1e18, (p.L * (r - p.sa)) / 1e6]
  return [0, (p.L * (p.sb - p.sa)) / 1e6]
}

// The summary at live prices, the way the page redoes it: each position's side and pool price, the
// wallet's range state, the ETH price, and the ETH held and the cost price for withdrawing now (each
// position paid out at its own pool's price, as src/run.mjs works it out) follow the pools; the rest stays
// as published.
// pools: { 'chain:pool address': { tick, price } }, eth: the reference ETH price.
export function withLivePrices(summary, pools, eth) {
  return summary.map((row) => {
    if (!row.curve) return row
    const positions = row.curve.positions.map((p) => {
      // A pool that could not be read live keeps its published state, marked held.
      const q = pools[`${p.chain ?? 'base'}:${p.pool_address}`]
      return q ? { ...p, pool: q.price, in_range: q.tick >= p.tick_lower && q.tick < p.tick_upper } : p.pool_address ? { ...p, held: true } : p
    })
    let cost = row.now_cost_eth_price, liveEth = {}
    if ([row.curve.eth, row.curve.usd, row.invested_usd, row.earn_total_usd].every(Number.isFinite) && positions.every((p) => [p.L, p.sa, p.sb, p.pool].every(Number.isFinite))) {
      // Another coin moves too: its price now is ETH's over the pool's coin per ETH (as the page's coin_up).
      const [e, u] = positions.reduce(([e, u], p) => { const [a, b] = amountsAt(p, p.pool); return [e + a, u + b * (p.quote && !p.held ? (eth ?? row.eth_usd) / p.pool : 1)] }, [row.curve.eth, row.curve.usd])
      const target = row.invested_usd + row.earn_total_usd
      cost = target <= u ? 0 : e < 0.05 ? null : Math.round(((target - u) / e) * 100) / 100
      liveEth = { eth_units_now: Math.round(e * 1e6) / 1e6 }
    }
    return { ...row, eth_usd: eth ?? row.eth_usd, range_state: sideState(positions), curve: { ...row.curve, positions }, now_cost_eth_price: cost, ...liveEth }
  })
}

// Keys of the alert state that follow prices: a wallet's ranges (and how long each has been out) and its cost state.
const priceKey = (k) => /:[\d.]+-[\d.]+(:out)?$|:cost$/.test(k)

// Dollars of a single move with another tracked wallet below which the two are not tied together for the
// cost price: a gas top-up (or a few, or a test sent and sent back) carries no gain or loss worth counting, a
// move of capital is one transfer far above it.
export const LINK_FLOOR = 100

// The tracked wallets an address moved money to or from, each by its key (keyAt: address -> key, every
// tracked wallet), in the order of `order` (the wallets' keys): its flows (src/run.mjs) booked 'between',
// and those booked 'transfer' with a tracked wallet left out of this update (not in `present`), as its books
// book a move with a wallet they were not given. A hand correction to 'transfer' (`forced`) is money in or
// out. A wallet with no single move of at least `floor` dollars is left out.
export function costLinks(flows, keyAt, self, order, { present = null, floor = 0 } = {}) {
  const moved = new Map()
  for (const f of flows) {
    const k = Object.hasOwn(keyAt, f.cp ?? '') ? keyAt[f.cp] : null
    if (!k || k === self) continue
    if (f.kind !== 'between' && !(f.kind === 'transfer' && !f.forced && present && !present.has(k))) continue
    moved.set(k, Math.max(moved.get(k) ?? 0, Math.abs(f.usd ?? 0) || 0))
  }
  return order.filter((k) => moved.has(k) && moved.get(k) >= floor)
}

// Where an address added on the page takes its cost price from, given every tracked wallet its money moved
// through (costSources) and the combined views asked for on the page ([{ key, wallets }], in the order asked
// for). What came from another wallet was valued as it arrived, and the gain or loss made on it before stays
// in that wallet's books: its own cost price can say the money put in is safe while, counted with them, it
// is still at a loss. A view holding it and every one of them counts those moves as neither money in nor
// out; of those, the smallest (the fewest other wallets' gains and losses mixed in), then the first asked
// for. Returns { scope, with: the view's other wallets }, { scope: null, with: links } when no view holds
// it and all of them, or null when it moved no money with a tracked wallet.
export function costSource(self, links, groups) {
  if (!links.length) return null
  let best = null
  for (const g of groups) {
    if (!g.wallets.includes(self) || !links.every((k) => g.wallets.includes(k))) continue
    if (!best || g.wallets.length < best.wallets.length) best = g
  }
  return best ? { scope: best.key, with: best.wallets.filter((k) => k !== self) } : { scope: null, with: [...links] }
}

// For each address added on the page that is in this update: where its cost alerts take their cost price
// from (costSource; src/run.mjs writes it as cost_from). wallets: every tracked wallet ({ key, address,
// extra }), in order, also those left out of this update; present: the keys in this update; flowsOf(key):
// the flows of one in it; groups: every combined view asked for ([{ key, wallets }]), also one missing from
// this update, so a view left out for an hour (another address of it not caught up) is still the one named
// and the alerts wait for it (costOf `lost`) rather than count the address alone. The wallets its money
// moved through are followed on through the other added addresses (A to x1 to x2 ties x2 to A as well). A
// configured wallet's books stand on their own, as its own alerts do, so the trail ends there.
//
// A tracked wallet left out of this update has no books, and the others' books do not know it as one of
// ours: a reward it claimed to one of them, or its order paying one, is booked from the reward or settlement
// contract and names it nowhere. So the links found in earlier updates (`seen`: address -> the addresses it is
// linked to, kept in data/cache/cost-links.json) stand in for it, read both ways (a link is a move between the
// two, whichever of them it was found from): an added address's links to wallets left out now, and the links
// of an added address left out now, to follow the trail on through it. Between two wallets in this update the
// links are found afresh. Returns { sources, links }: `links` is `seen` with the links each added address in
// this update has now (found afresh, and kept with wallets still left out), for the next update.
export function costSources({ wallets, present, flowsOf, groups, floor = LINK_FLOOR, seen = {} }) {
  const keyAt = Object.fromEntries(wallets.map((w) => [w.address, w.key]))
  const addressOf = Object.fromEntries(wallets.map((w) => [w.key, w.address]))
  const order = wallets.map((w) => w.key)
  const prior = seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : {}
  const kept = new Map(order.map((k) => [k, new Set()]))
  for (const w of wallets) {
    const list = Object.hasOwn(prior, w.address) && Array.isArray(prior[w.address]) ? prior[w.address] : []
    for (const a of list) {
      if (typeof a !== 'string' || !Object.hasOwn(keyAt, a) || keyAt[a] === w.key) continue
      kept.get(w.key).add(keyAt[a])
      kept.get(keyAt[a]).add(w.key)
    }
  }
  const added = wallets.filter((w) => w.extra), here = added.filter((w) => present.has(w.key))
  const direct = {}
  for (const w of added) {
    const was = kept.get(w.key)
    if (!present.has(w.key)) { direct[w.key] = order.filter((k) => k !== w.key && was.has(k)); continue }
    const found = new Set(costLinks(flowsOf(w.key), keyAt, w.key, order, { present, floor }))
    direct[w.key] = order.filter((k) => k !== w.key && (found.has(k) || (!present.has(k) && was.has(k))))
  }
  const sources = Object.fromEntries(here.map((w) => {
    const reach = new Set(direct[w.key]), todo = [...direct[w.key]]
    while (todo.length) for (const j of direct[todo.pop()] ?? []) if (j !== w.key && !reach.has(j)) { reach.add(j); todo.push(j) }
    return [w.key, costSource(w.key, order.filter((j) => reach.has(j)), groups)]
  }))
  const links = { ...prior }
  for (const w of here) links[w.address] = direct[w.key].map((k) => addressOf[k])
  return { sources, links }
}

// costSources as src/run.mjs calls it: every tracked wallet, the configured ones (base) then the added ones
// (extra), as configured and never trimmed to this update, and every view asked for by its members.
export function costSourcesFor({ base, extra, present, groups, flowsOf, seen }) {
  const wallets = [...base, ...extra]
  const views = groups.map((g) => ({ key: g.key, wallets: wallets.filter((w) => g.members.includes(w.key)).map((w) => w.key) }))
  return costSources({ wallets, present, flowsOf, groups: views, seen })
}

// A wallet row's cost price for withdrawing now and how to name it. An added wallet with a cost source
// (src/run.mjs cost_from, costSources): the combined view's (`via`; `lost` while that view is missing from
// the summary), or its own (`own`), `mates` naming the wallets it is counted with or moved money with and
// `hint` where to add it to be counted with them; `on` is what its cost state is judged against. Any other
// wallet's is its own, as ever.
function costOf(row, summary) {
  const src = row.added ? row.cost_from : null
  if (!src) return { cost: row.now_cost_eth_price, via: null, own: false, lost: false, on: '', mates: '', hint: '' }
  const nameOf = (k) => { const r = summary.find((x) => walletRow(x) && x.scope === k); return r ? (r.added ? `网页加的·${r.scope_label}` : r.scope_label) : null }
  // A wallet left out of this update has no row to be named by: it is counted, and no view is pointed to
  // that would leave it out.
  const all = src.with ?? [], names = all.map(nameOf).filter(Boolean), unread = all.length - names.length
  const mates = [...names, ...(unread ? [`${unread} 个这一小时没读完的地址`] : [])].join('、') || '另一个追踪中的钱包'
  if (!src.scope) {
    const hint = unread || !names.length ? '' : names.length > 1 ? `在同时含有 ${mates} 的看板上点「加地址」加它` : `在 ${mates} 的看板上点「加地址」加它`
    return { cost: row.now_cost_eth_price, via: null, own: true, lost: false, on: 'own', mates, hint }
  }
  const via = summary.find((x) => x.group && x.scope === src.scope) ?? null
  return { cost: via ? via.now_cost_eth_price : null, via, own: false, lost: !via, on: src.scope, mates, hint: '' }
}

// Options, for the alerts run from the last good summary while the update fails: lastGood (its positions
// may be out of date), noPrices (no live prices could be read either).
export function evaluate(summary, prev, opts = {}) {
  // A wallet no longer tracked says nothing, as the last good data may still hold one let go since.
  if (opts.tracked) summary = summary.filter((r) => !walletRow(r) || opts.tracked.has(r.scope))
  const out = evaluateNow(summary, prev, opts)
  keepAbsent(out.state, summary, prev, opts.tracked)
  if (!prev || !(opts.lastGood || opts.noPrices)) return out
  let { messages, state } = out
  if (opts.noPrices) {
    for (const k of Object.keys(prev)) if (priceKey(k)) state[k] = prev[k]
    // No clock starts on old prices either.
    for (const k of Object.keys(state)) if (k.endsWith(':out') && !(k in prev)) delete state[k]
    messages = messages.filter((m) => !priceKey(m.key))
  } else {
    // A range coming back, or a day out of it, waits for fresh data: the positions may have been withdrawn.
    messages = messages.filter((m) => { if (m.kind !== 'back' && m.kind !== 'out24') return true; state[m.key] = prev[m.key]; return false })
    for (const k of Object.keys(state)) if (k.endsWith(':cost') && state[k] === 'na' && prev[k]) state[k] = prev[k]
    // Rates and positions are those of the last good update: nothing new to say about where to move.
    for (const k of Object.keys(state)) if (k.endsWith(':switch')) state[k] = prev[k] ?? state[k]
    messages = messages.filter((m) => m.kind !== 'switch')
    // Ranges whose pool had no live quote (its chain's RPCs were down), and the cost state of their wallet,
    // wait as well: their published state is old.
    const held = new Set()
    for (const row of summary.filter(walletRow)) {
      const rs = ranges(row).filter((r) => r.held)
      for (const r of rs) { held.add(rangeKey(row, r)); held.add(`${rangeKey(row, r)}:out`) }
      // A cost price taken from a combined view waits as well when one of that view's ranges had no quote.
      const { via } = costOf(row, summary)
      if (rs.length || (via && ranges(via).some((r) => r.held))) held.add(`${row.scope}:cost`)
    }
    for (const k of held) if (k in prev) state[k] = prev[k]; else if (k.endsWith(':out')) delete state[k]
    messages = messages.filter((m) => !held.has(m.key))
  }
  return { messages, state }
}

// A wallet still tracked (`tracked`: the keys of every wallet tracked now) but missing from this summary,
// as an address added on the page is in an hour whose update ran without it, or while it catches up again,
// keeps its state: back, it is not taken for a newcomer, and what changed meanwhile is told then. A wallet
// no longer tracked is forgotten.
function keepAbsent(state, summary, prev, tracked) {
  if (!prev || !tracked) return
  const here = new Set(summary.map((r) => r.scope))
  for (const [k, v] of Object.entries(prev)) {
    const i = k.indexOf(':'), scope = i > 0 ? k.slice(0, i) : null
    if (scope && !here.has(scope) && tracked.has(scope) && !(k in state)) state[k] = v
  }
}

// The rows that are one wallet each: not 'total', and not a combined view asked for on the page
// (src/run.mjs marks those `group`), whose ranges are their wallets' own.
const walletRow = (r) => r.scope !== 'total' && !r.group

function evaluateNow(summary, prev, { now = Date.now() } = {}) {
  const state = {}, messages = [], tNow = now
  const first = !prev
  prev ??= {}

  // How old the data is: said once when the update has been failing for a while, and once when it is back.
  const head = summary.find((r) => r.as_of)
  const asOf = Date.parse(head?.as_of ?? '')
  if (Number.isFinite(asOf)) {
    const stale = now - asOf > STALE_MS
    state.update = stale ? 'stale' : 'ok'
    if (!first && stale && prev.update !== 'stale') {
      messages.push({ key: 'update', kind: 'stale', priority: 4, tags: ['hourglass'], title: `看板 ${Math.floor((now - asOf) / 3600e3)} 小时没更新了`,
        message: `数据停在 ${head.as_of_cst}（北京时间），整点更新一直没成功。出区间提醒按实时价格照常发，但用的是那时的仓位；看板上的现值和盈亏也是那时的，先别按它做决定。` })
    } else if (!first && !stale && prev.update === 'stale') {
      messages.push({ key: 'update', kind: 'fresh', priority: 2, tags: ['white_check_mark'], title: '看板恢复更新',
        message: `数据已更新到 ${head.as_of_cst}（北京时间）。` })
    }
  }

  const hadWallets = Object.keys(prev).some((k) => k.endsWith(':cost'))
  for (const row of summary.filter(walletRow)) {
    // An address added on the page (src/run.mjs marks its row) is named as such: its name is the sender's
    // choice, and must never pass for a configured wallet's.
    const who = row.added ? `网页加的·${row.scope_label}` : row.scope_label
    // A wallet seen for the first time (an address just added on the page) starts quiet, as the very
    // first run does: its old checks, unpriced coins and pool leads are not news. Every wallet's cost state
    // is written on every run, so a state holding others' but not its own marks a newcomer.
    const quiet = first || (hadWallets && !(`${row.scope}:cost` in prev))
    const co = costOf(row, summary)
    for (const r of ranges(row)) {
      // A range on another chain than Base is kept and named apart, as is one against another coin.
      const where = `${who}${r.chain === 'base' ? '' : `（${CHAIN_NAMES[r.chain] ?? r.chain}）`}${r.quote ? ` WETH/${r.quote.symbol}` : ''}`
      // A price of ETH as this range is set: in dollars, or in the coin it is against.
      const at = (v) => (r.quote ? `${(v / r.quote.usd).toPrecision(5)} ${r.quote.symbol}` : usd(v))
      const eth = r.quote ? `1 ETH = ${at(r.pool)}` : `ETH ${usd(r.pool)}`
      const key = rangeKey(row, r)
      const was = prev[key], now = sideOf(r, was)
      state[key] = now
      {
        // How long the range has been out: from the first update that found it out (or this one).
        const outKey = `${key}:out`, out = (now === 'below' || now === 'above') && !r.in_range
        if (out) {
          // A clock still running counts even when the side was put back to what it was before (a 跌出 or 涨出
          // that failed to send is tried again next run): the range has been out since then all the same.
          const clock = prev[outKey], running = typeof clock === 'string' && /^\d+(:sent)?$/.test(clock)
          const [since0, sent0] = String(clock ?? '').split(':')
          const wasOut = (running || was === 'below' || was === 'above') && clock !== 'in'
          const since = wasOut ? Number(since0) || tNow : tNow
          const sent = wasOut && (Boolean(sent0) || prev[outKey] == null)
          // Never ahead of the 跌出 or 涨出 it follows: a run that sends one (again, after failed sends, when the
          // day may be over already) leaves the day out to the next run.
          const leaving = Boolean(was) && was !== now
          const due = !first && !sent && !leaving && tNow - since >= OUT_MS
          state[outKey] = `${since}${sent || due ? ':sent' : ''}`
          if (due) {
            // The range's pool in the table, its 平常 as the money is held there (the fee column when none
            // of it is staked, as the page puts the loss line under it) and its tick spacing (label 'CL{n}').
            const pr = r.pool_address ? row.pool_compare?.pools?.find((q) => q.chain === r.chain && q.pool_address?.toLowerCase() === r.pool_address.toLowerCase()) : null
            const hours = Math.floor((tNow - since) / 3600e3)
            const { both, under, usual, line, stopped } = putBackRates(pr, row.pool_compare?.cost_line)
            const [usualText, lineText] = both ? ratePair(usual, line) : []
            const rates = both ? (under ? `看板表格里你那一行：平常 ${usualText}，已经低于损耗线 ${lineText}，放回去不划算。` : `看板表格里你那一行：平常 ${usualText}，高过损耗线 ${lineText}。`)
              : stopped ? '看板表格里这个池子的质押奖励已停。' : ''
            // Bounds only when the pool is known to pay more than the line: not against another coin, not
            // when either number is missing (a stopped gauge, a pool not in the table), not below the line.
            const spacing = Number(/^CL(\d+)$/.exec(pr?.label ?? '')?.[1]) || undefined
            const move = r.quote || !both || under ? '' : putBack(r, now, spacing)
            messages.push({ key: outKey, kind: 'out24', priority: 4, tags: ['hourglass'], title: `${where} 出区间已满 ${hours} 小时`,
              message: `${eth}，${now === 'below' ? `低于下沿 ${at(r.low)}，这个仓位现在全是 ETH` : `高于上沿 ${at(r.high)}，这个仓位现在全是 ${r.quote?.symbol ?? 'USDC'}`}，不赚利息。` + rates + move })
          }
        // Back inside the bounds (within BACK, or further in after being out): the clock ends, and says so
        // while the side is still out, as it stays when a 回到 waits for fresh data or failed to send.
        } else if (now === 'below' || now === 'above' || was === 'below' || was === 'above') state[outKey] = 'in'
      }
      if (first || !was || was === now) continue
      if (now === 'near' && was === 'in') {
        messages.push({ key, kind: 'near', priority: 4, tags: ['eyes'], title: `${where} 快到区间下沿`,
          message: `${eth}，离下沿 ${at(r.low)} 还差 ${pct((r.pool - r.low) / r.pool)}。跌破后仓位会全部变成 ETH，不再赚利息。` })
      } else if (now === 'below') {
        // The price for withdrawing now: other ranges of the wallet may still hold USDC.
        const cost = co.cost
        // Out of a range against another coin, ETH may well be above its cost price already.
        const line = co.lost ? '和它合在一起算成本价的地址这一小时有没读完的，成本价先不算。'
          // A combined view's price is the wallet's to act on only while it holds some ETH itself, as its cost alert.
          : !(cost > 0) || (co.via && !(row.eth_units_now >= 0.05)) ? ''
          // Counted alone, an added wallet that moved money with another gives no advice on it.
          : co.own ? `现在撤出的话，只按它自己的账算 ETH 成本价 ${usd(up(cost))}：它和 ${co.mates} 之间转过钱，转账的币按当时的价算，那边之前的盈亏不在里面。` + (co.hint ? `${co.hint}，就按合在一起的成本价算。` : '')
          // A combined view's price holds for every position of its wallets withdrawn now and all the ETH sold.
          : co.via ? `和 ${co.mates} 合在一起算，现在一起撤出的话 ETH 成本价 ${usd(up(cost))}` + (row.eth_usd >= cost ? `，ETH ${usd(row.eth_usd)} 已经高于它：这个价以上把 ETH 全卖掉，本金不亏、利息全拿。`
            : '：涨到这个价以上把 ETH 全卖掉，本金不亏、利息全拿。')
          : row.eth_usd >= cost ? `现在撤出的话 ETH 成本价 ${usd(up(cost))}，ETH ${usd(row.eth_usd)} 已经高于它：这个价以上卖，本金不亏、利息全拿。`
          : `现在撤出的话 ETH 成本价 ${usd(up(cost))}：涨到这个价以上再卖，本金不亏、利息全拿。`
        messages.push({ key, kind: 'below', priority: 5, tags: ['warning'], title: `${where} 跌出区间`,
          message: `${eth}，低于下沿 ${at(r.low)}，这个仓位全部变成了 ETH，现在不赚利息。` + line })
      } else if (now === 'above') {
        messages.push({ key, kind: 'above', priority: 4, tags: ['warning'], title: `${where} 涨出区间`,
          message: `${eth}，高于上沿 ${at(r.high)}，这个仓位全部变成了 ${r.quote?.symbol ?? 'USDC'}，现在不赚利息。` })
      } else if ((was === 'below' || was === 'above') && (now === 'in' || now === 'near')) {
        messages.push({ key, kind: 'back', priority: 3, tags: ['white_check_mark'], title: `${where} 回到区间`,
          message: `${eth}，回到 ${at(r.low)}–${at(r.high)} 之内，又开始赚利息。` })
      }
    }

    {
      const key = `${row.scope}:unpriced`, was = prev[key] ?? ''
      const list = row.unpriced ?? [], now = list.map((t) => t.address).join(',')
      state[key] = now
      const fresh = list.filter((t) => !was.split(',').includes(t.address))
      if (!quiet && fresh.length) {
        const names = fresh.map((t) => `${t.symbol ?? '未知代币'}（${t.address.slice(0, 6)}…${t.address.slice(-4)}）`).join('、')
        messages.push({ key, kind: 'unpriced', priority: 4, tags: ['warning'], title: `${who} 有没有价格的代币`,
          message: `${names}：它在池子和手续费里的部分被按 $0 算，看板上的现值、盈亏和利息都不完整，需要先给它加上价格来源。` })
      }
    }

    {
      // Every transaction to check, not only the newest ones listed, so settling one does not bring an
      // older one back as new.
      const key = `${row.scope}:check`, was = (prev[key] ?? '').split(',')
      const list = row.to_check ?? [], all = row.to_check_txs ?? [...new Set(list.map((x) => x.tx))]
      state[key] = all.join(',')
      const freshTx = all.filter((h) => !was.includes(h)), shown = list.find((x) => freshTx.includes(x.tx))
      if (!quiet && freshTx.length) {
        messages.push({ key, kind: 'check', priority: 4, tags: ['mag'], title: `${who} 有交易需要确认`,
          message: `${freshTx.length} 笔新的${shown ? `，最新一笔：${shown.time_cst} ${shown.text}` : ''}。规则判断不了，投入和盈亏可能不准，看板「赚了多少」下面有明细。` })
      }
    }

    {
      // The options already said in this run of leads, each kept while its own lead over what the money
      // earns now stays at least half the gap, so two options trading places are not said again and again.
      const key = `${row.scope}:switch`, pc = row.pool_compare, sw = pc?.switch
      const told = (prev[key] ?? '').split(',').filter((x) => x && x !== 'none')
      if (!pc?.complete) state[key] = prev[key] ?? 'none' // pools not all read: hold, say nothing
      else {
        // The best option meeting every condition (src/run.mjs picks it: switch.steady).
        const st = sw?.steady, opt = st ? `${st.to.chain}:${st.to.label}:${st.to.mode}` : null
        const ok = Boolean(st && !st.here && st.stable && st.to.days >= SWITCH.days && st.gap >= SWITCH.gap && st.payback_days != null && st.payback_days <= SWITCH.payback)
        // An option's lead over the money now, judged as the pick is: the lower of the usual and the last day's.
        const leadOf = (o) => {
          const [c, l, m] = o.split(':'), r = pc.pools?.find((q) => q.chain === c && q.label === l)?.[m]
          if (r?.median == null || sw?.current == null) return -Infinity
          return Math.min(r.median - sw.current, (r.recent ?? r.median) - (sw.current_recent ?? sw.current))
        }
        const kept = told.filter((o) => leadOf(o) >= SWITCH.gap / 2)
        // A new option is said only when it clearly beats those already said (by half the gap).
        const fresh = ok && !told.includes(opt) && kept.every((o) => leadOf(o) + SWITCH.gap / 2 <= st.gap)
        state[key] = [...new Set([...kept, ...(fresh || (ok && told.includes(opt)) ? [opt] : [])])].join(',') || 'none'
        if (!quiet && fresh) {
        const mode = (m) => (m === 'staked' ? '质押' : '不质押')
        const from = [...new Set(sw.from.filter((f) => f.label).map((f) => `${f.chain_label} ${f.label} ${mode(f.mode)}`))].join('、')
        messages.push({ key, kind: 'switch', priority: 3, tags: ['chart_with_upwards_trend'], title: `${who}：${st.to.chain_label} ${st.to.label} ${mode(st.to.mode)}收益更高`,
          message: `按你现在仓位的宽度算，近 ${st.to.days} 天每天年化的中位数 ${pct(st.to.median)}，差的日子也有 ${pct(st.to.p25)}；你现在的仓位约 ${pct(sw.current ?? 0)}${from ? `（${from}）` : ''}。` +
            `按现在的钱每天多约 ${usd(st.extra_day_usd)}，换过去的成本约 ${usd(st.cost_usd)}，${st.payback_days < 0.1 ? '不到 0.1 天' : `约 ${st.payback_days.toFixed(1)} 天`}回本。` +
            (st.to.tracked ? '' : `看板现在只追踪 Base 和以太坊上的仓位，换到 ${st.to.chain_label} 后要先加上这条链，盈亏才算得准。`) })
        }
      }
    }

    // The cost price that applies while the ETH is held out of range: all below, or already withdrawn. A
    // range against another coin says nothing about that: it can stay in range whatever the dollar price does.
    // Whether its ETH is held out of range is the wallet's own matter, also when its price is a combined view's.
    const key = `${row.scope}:cost`, was = prev[key]
    const held = row.curve?.positions ?? []
    const side = held.some((p) => p.quote) ? sideState(held.filter((p) => !p.quote)) : row.range_state
    // Held out of range by the wallet itself: a combined view's price counts the others' ETH too, so it holds
    // only while the wallet has some (the 0.05 ETH its own price needs); its own price is null without it.
    const outside = (side === 'below' || side === 'none') && (!(co.via || co.lost) || row.eth_units_now >= 0.05)
    // Its combined view missing from this summary (another address of it left out of this update): while it
    // holds ETH out of range, held as it was, rather than judged on a price that counts this wallet alone; out
    // of range since it was last judged in range, it is told on the view's price once the view is back (the
    // 跌出 message gave none). In range, or without ETH of its own, it needs no price: 'na' as in any update.
    if (co.lost) { state[key] = !outside ? 'na' : was === 'na' ? `below@${co.on}` : was ?? 'na'; continue }
    const cost = co.cost
    // The state says what it was judged against when that is not the wallet's own price as ever ('below@g1',
    // 'above@own'). Judged against another price now (a view asked for, or gone), it starts afresh from where
    // ETH is, without the old price's REARM band: once judged, it is told if ETH is above the new price.
    const [wasSide, wasOn = ''] = String(was ?? '').split('@')
    const before = wasOn === co.on ? wasSide : wasSide === 'below' || wasSide === 'above' ? 'below' : undefined
    let now = 'na'
    if (outside && cost > 0) {
      now = row.eth_usd >= cost || (before === 'above' && row.eth_usd >= cost * (1 - REARM)) ? 'above' : 'below'
    }
    state[key] = now !== 'na' && co.on ? `${now}@${co.on}` : now
    if (!first && before === 'below' && now === 'above') {
      messages.push({ key, kind: 'cost', priority: 4, tags: ['moneybag'], title: `${who} ETH 涨到成本价以上`,
        message: co.via ? `ETH ${usd(row.eth_usd)}，不低于和 ${co.mates} 合在一起算的成本价 ${usd(cost)}。现在一起撤出、把 ETH 全卖掉，本金不亏、利息全拿。`
          : co.own ? `ETH ${usd(row.eth_usd)}，不低于它自己的成本价 ${usd(cost)}。但这只按它自己的账算：它和 ${co.mates} 之间转过钱，转账的币按当时的价算，那边之前的盈亏不在里面。` + (co.hint ? `${co.hint}，就按合在一起的成本价提醒。` : '')
          : `ETH ${usd(row.eth_usd)}，不低于成本价 ${usd(cost)}。现在卖掉 ETH，本金不亏、利息全拿。` })
    }
  }
  return { messages, state }
}
