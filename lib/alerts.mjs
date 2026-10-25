// Which phone alerts the latest summary calls for, given what was already sent. Pure: takes the
// summary rows and the previous state, returns the messages and the next state.
//
// Per wallet and per range (a wallet's positions with the same bounds count as one):
//   near   the pool price came within NEAR of the lower bound (re-armed once it is REARM away again)
//   below  the price left the range downwards: the position is all ETH and earns nothing
//   above  the price left the range upwards: all USDC
//   back   the price came back into the range
// Per wallet, while it holds its ETH out of range (all below, or withdrawn):
//   cost   ETH rose to the cost price, where selling keeps the money put in and all the interest
//          (re-armed once ETH is REARM below it again)
// The first run only records the state, so turning alerts on sends nothing until something changes.

export const NEAR = 0.01, REARM = 0.02

const usd = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)
const pct = (v) => `${(Math.abs(v) * 100).toFixed(1)}%`

function ranges(row) {
  const out = []
  for (const p of row.curve?.positions ?? []) {
    const same = out.find((q) => q.low === p.low && q.high === p.high)
    if (same) same.in_range ||= p.in_range
    else out.push({ low: p.low, high: p.high, pool: p.pool, in_range: p.in_range })
  }
  return out
}

function sideOf(r, prev) {
  if (!r.in_range) return r.pool < (r.low + r.high) / 2 ? 'below' : 'above'
  const dist = (r.pool - r.low) / r.pool
  return dist <= NEAR || (prev === 'near' && dist <= REARM) ? 'near' : 'in'
}

export function evaluate(summary, prev) {
  const state = {}, messages = []
  const first = !prev
  prev ??= {}
  for (const row of summary.filter((r) => r.scope !== 'total')) {
    const who = row.scope_label
    for (const r of ranges(row)) {
      const key = `${row.scope}:${r.low}-${r.high}`
      const was = prev[key], now = sideOf(r, was)
      state[key] = now
      if (first || !was || was === now) continue
      const bounds = `${usd(r.low)}–${usd(r.high)}`
      if (now === 'near' && was === 'in') {
        messages.push({ key, kind: 'near', priority: 4, tags: ['eyes'], title: `${who} 快到区间下沿`,
          message: `ETH ${usd(r.pool)}，离下沿 ${usd(r.low)} 还差 ${pct((r.pool - r.low) / r.pool)}。跌破后仓位会全部变成 ETH，不再赚利息。` })
      } else if (now === 'below') {
        const cost = row.cost_eth_price
        messages.push({ key, kind: 'below', priority: 5, tags: ['warning'], title: `${who} 跌出区间`,
          message: `ETH ${usd(r.pool)}，低于下沿 ${usd(r.low)}，仓位全部变成了 ETH，现在不赚利息。` +
            (cost > 0 ? `撤出后 ETH 成本价 ${usd(Math.ceil(cost))}：涨到这个价以上再卖，本金不亏、利息全拿。` : '') })
      } else if (now === 'above') {
        messages.push({ key, kind: 'above', priority: 4, tags: ['warning'], title: `${who} 涨出区间`,
          message: `ETH ${usd(r.pool)}，高于上沿 ${usd(r.high)}，仓位全部变成了 USDC，现在不赚利息。` })
      } else if ((was === 'below' || was === 'above') && (now === 'in' || now === 'near')) {
        messages.push({ key, kind: 'back', priority: 3, tags: ['white_check_mark'], title: `${who} 回到区间`,
          message: `ETH ${usd(r.pool)}，回到 ${bounds} 之内，又开始赚利息。` })
      }
    }

    // The cost price that applies while the ETH is held out of range: all below, or already withdrawn.
    const key = `${row.scope}:cost`, was = prev[key]
    const cost = row.now_cost_eth_price
    let now = 'na'
    if ((row.range_state === 'below' || row.range_state === 'none') && cost > 0) {
      now = row.eth_usd >= cost || (was === 'above' && row.eth_usd >= cost * (1 - REARM)) ? 'above' : 'below'
    }
    state[key] = now
    if (!first && was === 'below' && now === 'above') {
      messages.push({ key, kind: 'cost', priority: 4, tags: ['moneybag'], title: `${who} ETH 涨到成本价以上`,
        message: `ETH ${usd(row.eth_usd)}，高于成本价 ${usd(Math.ceil(cost))}。现在卖掉 ETH，本金不亏、利息全拿。` })
    }
  }
  return { messages, state }
}
