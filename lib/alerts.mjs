// Which phone alerts the latest summary calls for, given what was already sent. Pure: takes the
// summary rows and the previous state, returns the messages and the next state.
//
// Per wallet and per range (a wallet's positions with the same bounds count as one):
//   near   the pool price came within NEAR of the lower bound (re-armed once it is REARM away again)
//   below  the price left the range downwards: the position is all ETH and earns nothing
//   above  the price left the range upwards: all USDC
//   back   the price came back into the range, by more than BACK (so a price hovering at a bound
//          does not send 跌出/回到 every hour)
// Per wallet, while it holds its ETH out of range (all below, or withdrawn):
//   cost   ETH rose to the cost price, where selling keeps the money put in and all the interest
//          (re-armed once ETH is REARM below it again)
// Per wallet, once per new token or transaction:
//   unpriced  a position or fee holds a token with no price source, so the figures are incomplete
//   check     a transaction the rules could not settle (summary.to_check): a person has to look
// For the whole dashboard:
//   stale     the data is more than STALE_MS old: the hourly update keeps failing
//   fresh     it is up to date again
// The first run only records the state, so turning alerts on sends nothing until something changes.
// While the update fails, the alerts run on the last summary with live pool prices (withLivePrices).
// Its positions may have changed since (the owner may have withdrawn), so then a range coming back,
// and the cost state lapsing because the old ranges look in range again, wait for fresh data; without
// live prices nothing price-driven moves.

export const NEAR = 0.01, REARM = 0.02, BACK = 0.005, STALE_MS = 2 * 3600e3

// To the cent: an alert fires just past a threshold, where whole dollars could read as equal.
const usd = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)
const pct = (v) => `${(Math.abs(v) * 100).toFixed(2)}%`
const up = (v) => Math.ceil(v * 100) / 100 // a price to sell at or above, rounded up

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
// wallet's range state, the ETH price and the cost price for withdrawing now (each position paid out
// at its own pool's price, as src/run.mjs works it out) follow the pools; the rest stays as published.
// pools: { pool address: { tick, price } }, eth: the reference ETH price.
export function withLivePrices(summary, pools, eth) {
  return summary.map((row) => {
    if (!row.curve) return row
    const positions = row.curve.positions.map((p) => {
      const q = pools[p.pool_address]
      return q ? { ...p, pool: q.price, in_range: q.tick >= p.tick_lower && q.tick < p.tick_upper } : p
    })
    let cost = row.now_cost_eth_price
    if ([row.curve.eth, row.curve.usd, row.invested_usd, row.earn_total_usd].every(Number.isFinite) && positions.every((p) => [p.L, p.sa, p.sb, p.pool].every(Number.isFinite))) {
      const [e, u] = positions.reduce(([e, u], p) => { const [a, b] = amountsAt(p, p.pool); return [e + a, u + b] }, [row.curve.eth, row.curve.usd])
      const target = row.invested_usd + row.earn_total_usd
      cost = target <= u ? 0 : e < 0.05 ? null : Math.round(((target - u) / e) * 100) / 100
    }
    return { ...row, eth_usd: eth ?? row.eth_usd, range_state: sideState(positions), curve: { ...row.curve, positions }, now_cost_eth_price: cost }
  })
}

// Keys of the alert state that follow prices: a wallet's ranges and its cost state.
const priceKey = (k) => /:[\d.]+-[\d.]+$|:cost$/.test(k)

// Options, for the alerts run from the last good summary while the update fails: lastGood (its positions
// may be out of date), noPrices (no live prices could be read either).
export function evaluate(summary, prev, opts = {}) {
  const out = evaluateNow(summary, prev, opts)
  if (!prev || !(opts.lastGood || opts.noPrices)) return out
  let { messages, state } = out
  if (opts.noPrices) {
    for (const k of Object.keys(prev)) if (priceKey(k)) state[k] = prev[k]
    messages = messages.filter((m) => !priceKey(m.key))
  } else {
    messages = messages.filter((m) => { if (m.kind !== 'back') return true; state[m.key] = prev[m.key]; return false })
    for (const k of Object.keys(state)) if (k.endsWith(':cost') && state[k] === 'na' && prev[k]) state[k] = prev[k]
  }
  return { messages, state }
}

function evaluateNow(summary, prev, { now = Date.now() } = {}) {
  const state = {}, messages = []
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
        // The price for withdrawing now: other ranges of the wallet may still hold USDC.
        const cost = row.now_cost_eth_price
        messages.push({ key, kind: 'below', priority: 5, tags: ['warning'], title: `${who} 跌出区间`,
          message: `ETH ${usd(r.pool)}，低于下沿 ${usd(r.low)}，这个仓位全部变成了 ETH，现在不赚利息。` +
            (cost > 0 ? `现在撤出的话 ETH 成本价 ${usd(up(cost))}：涨到这个价以上再卖，本金不亏、利息全拿。` : '') })
      } else if (now === 'above') {
        messages.push({ key, kind: 'above', priority: 4, tags: ['warning'], title: `${who} 涨出区间`,
          message: `ETH ${usd(r.pool)}，高于上沿 ${usd(r.high)}，这个仓位全部变成了 USDC，现在不赚利息。` })
      } else if ((was === 'below' || was === 'above') && (now === 'in' || now === 'near')) {
        messages.push({ key, kind: 'back', priority: 3, tags: ['white_check_mark'], title: `${who} 回到区间`,
          message: `ETH ${usd(r.pool)}，回到 ${bounds} 之内，又开始赚利息。` })
      }
    }

    {
      const key = `${row.scope}:unpriced`, was = prev[key] ?? ''
      const list = row.unpriced ?? [], now = list.map((t) => t.address).join(',')
      state[key] = now
      const fresh = list.filter((t) => !was.split(',').includes(t.address))
      if (!first && fresh.length) {
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
      if (!first && freshTx.length) {
        messages.push({ key, kind: 'check', priority: 4, tags: ['mag'], title: `${who} 有交易需要确认`,
          message: `${freshTx.length} 笔新的${shown ? `，最新一笔：${shown.time_cst} ${shown.text}` : ''}。规则判断不了，投入和盈亏可能不准，看板顶部有明细。` })
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
        message: `ETH ${usd(row.eth_usd)}，不低于成本价 ${usd(cost)}。现在卖掉 ETH，本金不亏、利息全拿。` })
    }
  }
  return { messages, state }
}
