import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, withLivePrices, STALE_MS, OUT_MS } from '../lib/alerts.mjs'

// One wallet with two positions of the same range, as the summary publishes them.
const row = (pool, extra = {}) => {
  const in_range = pool >= 2000 && pool < 2500
  const side = in_range ? 'in' : pool < 2250 ? 'below' : 'above'
  return {
    scope: 'a', scope_label: 'A', eth_usd: pool, range_state: side, cost_eth_price: 2300, now_cost_eth_price: side === 'below' ? 2300 : 2350,
    curve: { positions: [0, 1].map(() => ({ low: 2000, high: 2500, pool, in_range })) },
    ...extra,
  }
}
const total = { scope: 'total', scope_label: '合计', curve: { positions: [] } }
const run = (states, rows) => {
  const out = []
  let prev = states
  for (const r of rows) { const { messages, state } = evaluate([r, total], prev); out.push(messages.map((m) => m.kind)); prev = state }
  return { out, prev }
}

// A WETH/cbBTC position as the summary publishes it: dollars per ETH at the coin's price of that update,
// and its bounds in the coin. Only the price of ETH in cbBTC moves it.
const btcRow = (ratio, btc = 80000, extra = {}) => {
  const low = 0.028, high = 0.031, in_range = ratio >= low && ratio < high
  return {
    scope: 'a', scope_label: 'A', eth_usd: ratio * btc, range_state: in_range ? 'in' : ratio < 0.0295 ? 'below' : 'above', now_cost_eth_price: 2400,
    curve: { eth: 0, usd: 0, positions: [{ low: low * btc, high: high * btc, pool: ratio * btc, in_range, pool_address: '0xbbb', scale: 1e10 * btc, tick_lower: -270000, tick_upper: -269000, L: 1, sa: 1, sb: 2, quote: { symbol: 'cbBTC', usd: btc, low, high } }] },
    ...extra,
  }
}

test('a WETH/cbBTC range is said in cbBTC, and the coin\'s price moving its dollar bounds sends nothing', () => {
  // cbBTC moves every update; the ratio stays inside the range.
  const { out, prev } = run(null, [btcRow(0.0295, 80000), btcRow(0.0295, 81000), btcRow(0.0295, 79000)])
  assert.deepEqual(out, [[], [], []])
  assert.deepEqual(Object.keys(prev).filter((k) => /^a:[\d.]+-[\d.]+$/.test(k)), ['a:0.028-0.031'])
  const sent = (rows) => { let s = null, last = []; for (const r of rows) { const e = evaluate([r, total], s); s = e.state; last = e.messages } return last }
  const near = sent([btcRow(0.0295), btcRow(0.0282)])[0]
  assert.equal(near.kind, 'near')
  assert.ok(near.title.includes('WETH/cbBTC'), near.title)
  assert.ok(near.message.includes('1 ETH = 0.028200 cbBTC') && near.message.includes('0.028000 cbBTC'), near.message)
  const below = sent([btcRow(0.0295), btcRow(0.0275)])[0]
  assert.equal(below.kind, 'below')
  assert.ok(below.message.includes('全部变成了 ETH'), below.message)
  const above = sent([btcRow(0.0295), btcRow(0.032)])[0]
  assert.equal(above.kind, 'above')
  assert.ok(above.message.includes('全部变成了 cbBTC') && !above.message.includes('USDC'), above.message)
  const back = sent([btcRow(0.0295), btcRow(0.032), btcRow(0.0295)])[0]
  assert.equal(back.kind, 'back')
  assert.ok(back.message.includes('0.028000 cbBTC–0.031000 cbBTC'), back.message)
  // Just past a bound it still reads as past it.
  const past = sent([btcRow(0.0295), btcRow(0.027996)])[0]
  assert.ok(past.message.includes('1 ETH = 0.027996 cbBTC') && past.message.includes('0.028000 cbBTC'), past.message)
})

test('out of a WETH/cbBTC range with ETH above its cost price already, the alert does not say to wait for it', () => {
  const sent = (rows) => { let s = null, last = []; for (const r of rows) { const e = evaluate([r, total], s); s = e.state; last = e.messages } return last }
  const m = sent([btcRow(0.0295, 100000), btcRow(0.0275, 102000, { now_cost_eth_price: 2100 })])[0]
  assert.equal(m.kind, 'below')
  assert.ok(m.message.includes('已经高于它') && !m.message.includes('涨到这个价以上再卖'), m.message)
  const lower = sent([btcRow(0.0295), btcRow(0.0275, 80000, { now_cost_eth_price: 2500 })])[0]
  assert.ok(lower.message.includes('涨到这个价以上再卖') && !lower.message.includes('已经高于它'), lower.message)
})

test('the cost alert follows the dollar ranges: a WETH/cbBTC position in range does not silence it', () => {
  const usdPos = (P) => ({ low: 2000, high: 2500, pool: P, in_range: P >= 2000 && P < 2500 })
  const mixed = (P, ratio = 0.0295) => {
    const b = btcRow(ratio, P / ratio)
    return { scope: 'a', scope_label: 'A', eth_usd: P, range_state: P < 2000 ? 'part' : 'in', now_cost_eth_price: 1900, curve: { ...b.curve, positions: [usdPos(P), ...b.curve.positions] } }
  }
  const { out } = run(null, [mixed(2100), mixed(1800), mixed(1850), mixed(1905)])
  assert.deepEqual(out, [[], ['below'], [], ['cost']])
  // Only a WETH/cbBTC position left: as after withdrawing, the ETH cost price still applies.
  const alone = (P, ratio = 0.0295) => ({ ...btcRow(ratio, P / ratio), now_cost_eth_price: 2400 })
  assert.deepEqual(run(null, [alone(2300), alone(2390), alone(2410)]).out, [[], [], ['cost']])
})

test('while the update fails, the cost price moves the coin with its pool, unless that pool had no quote', () => {
  // Above its range, so all cbBTC: worth $20 at the published $80,000. ETH and cbBTC are then both up 10%, the ratio unchanged.
  const sa = Math.sqrt(2000e-12), sb = Math.sqrt(2200e-12), L = 20e6 / (sb - sa)
  const held = { scope: 'a', scope_label: 'A', eth_usd: 2400, invested_usd: 50, earn_total_usd: 0, range_state: 'above', now_cost_eth_price: 30,
    curve: { eth: 1, usd: 0, positions: [{ low: 2000, high: 2200, pool: 2400, in_range: false, pool_address: '0xbbb', tick_lower: 1, tick_upper: 2, L, sa, sb, quote: { symbol: 'cbBTC', usd: 80000, low: 0.025, high: 0.0275 } }] } }
  const [live] = withLivePrices([held], { 'base:0xbbb': { tick: 3, price: 2400 } }, 2640)
  assert.ok(Math.abs(live.now_cost_eth_price - 28) < 0.01, `${live.now_cost_eth_price}`)
  const [none] = withLivePrices([held], {}, 2640)
  assert.ok(Math.abs(none.now_cost_eth_price - 30) < 0.01, `${none.now_cost_eth_price}`)
})

test('live prices move a WETH/cbBTC range through its dollar scale', () => {
  const [row1] = withLivePrices([btcRow(0.0295)], { 'base:0xbbb': { tick: -272000, price: 0.0275 * 80000 } }, 2200)
  assert.equal(row1.curve.positions[0].pool, 0.0275 * 80000)
  assert.equal(row1.curve.positions[0].in_range, false)
  assert.equal(row1.range_state, 'below')
})

test('the first run only records the state', () => {
  const { messages, state } = evaluate([row(1990), total], null)
  assert.deepEqual(messages, [])
  assert.equal(state['a:2000-2500'], 'below')
})

test('near, out and back are each sent once per change', () => {
  const { out } = run(null, [row(2200), row(2015), row(2018), row(2030), row(1990), row(1980), row(2280), row(2290), row(2210), row(2600), row(2300)])
  assert.deepEqual(out, [[], ['near'], [], [], ['below'], [], ['back'], [], [], ['above'], ['back']])
})

test('near is re-armed only once the price is well away from the bound', () => {
  const { out } = run(null, [row(2200), row(2015), row(2035), row(2015), row(2100), row(2015)])
  assert.deepEqual(out, [[], ['near'], [], [], [], ['near']])
})

test('a price hovering at a bound does not send out-and-back every hour', () => {
  const { out } = run(null, [row(2200), row(2015), row(1999), row(2001), row(1999.5), row(2004), row(1998), row(2015), row(1999)])
  assert.deepEqual(out, [[], ['near'], ['below'], [], [], [], [], ['back'], ['below']])
})

test('the cost alert fires when ETH held below the range rises past the cost price', () => {
  // Below the range the pool price and ETH price move together; a cost price under the range low.
  const below = (p) => row(p, { now_cost_eth_price: 1900, cost_eth_price: 1900 })
  const { out } = run(null, [row(2100), below(1800), below(1850), below(1905), below(1880), below(1950), below(1840), below(1910)])
  assert.deepEqual(out, [[], ['below'], [], ['cost'], [], [], [], ['cost']])
})

test('after withdrawing, the cost alert still follows the wallet', () => {
  const gone = (p) => ({ scope: 'a', scope_label: 'A', eth_usd: p, range_state: 'none', now_cost_eth_price: 2400, curve: { positions: [] } })
  const { out } = run(null, [gone(2300), gone(2390), gone(2410), gone(2380), gone(2300), gone(2401)])
  assert.deepEqual(out, [[], [], ['cost'], [], [], ['cost']])
})

test('a token without a price is reported once per new token', () => {
  const nv = { address: '0xb20000000000000000000078ee7ce2fe4908108c', symbol: 'NVDAc' }, other = { address: '0x1111111111111111111111111111111111111111', symbol: null }
  const { out } = run(null, [row(2200), row(2200, { unpriced: [nv] }), row(2201, { unpriced: [nv] }), row(2202, { unpriced: [nv, other] }), row(2203, { unpriced: [] }), row(2204, { unpriced: [nv] })])
  assert.deepEqual(out, [[], ['unpriced'], [], ['unpriced'], [], ['unpriced']])
  const { messages } = evaluate([row(2200, { unpriced: [nv] }), total], { 'a:2000-2500': 'in', 'a:cost': 'na', 'a:unpriced': '' })
  assert.match(messages[0].message, /^NVDAc（0xb200…108c）/)
})

test('messages name the wallet, never an address', () => {
  const { messages } = evaluate([row(1990), total], { 'a:2000-2500': 'in', 'a:cost': 'na' })
  assert.equal(messages.length, 1)
  assert.match(messages[0].title, /^A /)
  assert.ok(!/0x[0-9a-f]{6}/i.test(messages[0].title + messages[0].message))
  assert.match(messages[0].message, /\$2,300/)
})

test('a transaction to check is reported once, and again only when a new one appears', () => {
  const c1 = { time_cst: '2026-10-30 12:00', tx: '0xaa', text: '收到 2 ETH，对方是不认识的合约 0xad3b…67bc，暂按资金转入计', usd: 5000 }
  const c2 = { ...c1, tx: '0xbb', time_cst: '2026-10-31 09:00' }
  const { out } = run(null, [row(2200), row(2200, { to_check: [c1] }), row(2201, { to_check: [c1] }), row(2202, { to_check: [c2, c1] }), row(2203, { to_check: [c2, c1] })])
  assert.deepEqual(out, [[], ['check'], [], ['check'], []])
  const { messages } = evaluate([row(2200, { to_check: [c2, c1] }), total], { 'a:2000-2500': 'in', 'a:cost': 'na', 'a:check': '0xaa' })
  assert.match(messages[0].message, /^1 笔新的，最新一笔：2026-10-31 09:00/)
})

test('data the hourly update has not refreshed for a while is reported once, and so is its return', () => {
  const at = Date.parse('2026-10-30T04:00:00Z')
  const stamped = (r) => ({ ...r, as_of: '2026-10-30T04:00:00.000Z', as_of_cst: '2026-10-30 12:00' })
  let prev = evaluate([stamped(row(2200)), total], null, { now: at }).state
  const kinds = []
  for (const h of [1, 2.5, 3, 5]) {
    const r = evaluate([stamped(row(2200)), total], prev, { now: at + h * 3600e3 })
    kinds.push(r.messages.map((m) => m.kind)); prev = r.state
  }
  assert.deepEqual(kinds, [[], ['stale'], [], []])
  const back = evaluate([{ ...stamped(row(2200)), as_of: new Date(at + 5 * 3600e3).toISOString() }, total], prev, { now: at + 5 * 3600e3 + 60e3 })
  assert.deepEqual(back.messages.map((m) => m.kind), ['fresh'])
  assert.ok(STALE_MS === 2 * 3600e3)
})

// A 2000–2500 range holding exactly 1 ETH below it, $2,300 put in and nothing earned yet.
const pool = '0x2a430bebd2082d8e05d56d64dede8944279bbc24'
const sa = Math.sqrt(2000e-12), sb = Math.sqrt(2500e-12), L = 1e18 / (1 / sa - 1 / sb)
const outage = { ...row(2200), invested_usd: 2300, earn_total_usd: 0, cost_eth_price: 2300, now_cost_eth_price: 2350,
  curve: { eth: 0, usd: 0, positions: [{ low: 2000, high: 2500, pool: 2200, in_range: true, pool_address: pool, tick_lower: -200311, tick_upper: -198080, L, sa, sb }] } }

test('while the update fails, ranges and the cost price follow live pool prices', () => {
  const [below] = withLivePrices([outage], { [`base:${pool}`]: { tick: -201000, price: 1900 } }, 1901)
  assert.deepEqual([below.range_state, below.eth_usd, below.curve.positions[0].in_range, below.curve.positions[0].pool, below.now_cost_eth_price], ['below', 1901, false, 1900, 2300])
  // Inside the range the cost price is worked out on the curve at the pool's price, as src/run.mjs does.
  const [inside] = withLivePrices([outage], { [`base:${pool}`]: { tick: -199134, price: 2250 } }, 2251)
  const r = Math.sqrt(2250e-12), e = (L * (1 / r - 1 / sb)) / 1e18, u = (L * (r - sa)) / 1e6
  assert.deepEqual([inside.range_state, inside.now_cost_eth_price], ['in', Math.round(((2300 - u) / e) * 100) / 100])
  const { messages } = evaluate([below, total], { 'a:2000-2500': 'in', 'a:cost': 'na' })
  assert.deepEqual(messages.map((m) => m.kind), ['below'])
  assert.match(messages[0].message, /\$2,300\.00/)
})

test('from the last good data, a range coming back waits for fresh data; without live prices nothing price-driven moves', () => {
  const prev = { 'a:2000-2500': 'below', 'a:cost': 'below' }
  const [back] = withLivePrices([outage], { [`base:${pool}`]: { tick: -199134, price: 2250 } }, 2251)
  const r = evaluate([back, total], prev, { lastGood: true })
  assert.deepEqual([r.messages.map((m) => m.kind), r.state['a:2000-2500'], r.state['a:cost']], [[], 'below', 'below'])
  const n = evaluate([outage, total], prev, { lastGood: true, noPrices: true })
  assert.deepEqual([n.messages.map((m) => m.kind), n.state['a:2000-2500'], n.state['a:cost']], [[], 'below', 'below'])
  // Still falling: the alert goes out at live prices.
  const [down] = withLivePrices([outage], { [`base:${pool}`]: { tick: -201000, price: 1900 } }, 1901)
  assert.deepEqual(evaluate([down, total], { 'a:2000-2500': 'in', 'a:cost': 'na' }, { lastGood: true }).messages.map((m) => m.kind), ['below'])
})

test('settling one of many transactions to check does not bring an older one back as new', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ time_cst: `2026-10-${String(30 - i).padStart(2, '0')} 10:00`, tx: `0x${i}`, text: `item ${i}` }))
  const at = (list) => row(2200, { to_check: list.slice(0, 20), to_check_txs: list.map((x) => x.tx) })
  const settled = items.slice(1).filter((x) => x.tx !== '0x7')
  const { out } = run(null, [row(2200), at(items), at(items), at(items.slice(1)), at(settled), at([{ ...items[0], tx: '0xnew' }, ...settled])])
  assert.deepEqual(out, [[], ['check'], [], [], [], ['check']])
})

test('a range on another chain is kept apart and named by its chain', () => {
  const both = { ...outage, curve: { ...outage.curve, positions: [outage.curve.positions[0], { ...outage.curve.positions[0], chain: 'eth', pool_address: '0xd661623947ef2ead12d577b47021c167d163b0c5', pool: 1900, in_range: false }] } }
  const { messages, state } = evaluate([both, total], { 'a:2000-2500': 'in', 'a:eth:2000-2500': 'in', 'a:cost': 'na' })
  assert.deepEqual(messages.map((m) => [m.key, m.kind]), [['a:eth:2000-2500', 'below']])
  assert.match(messages[0].title, /^A（以太坊） 跌出区间/)
  assert.equal(state['a:2000-2500'], 'in')
})

test('from the last good data, a range whose chain could not be read waits; the other chain still alerts', () => {
  const ethPos = { ...outage.curve.positions[0], chain: 'eth', pool_address: '0xd661623947ef2ead12d577b47021c167d163b0c5' }
  const both = { ...outage, curve: { ...outage.curve, positions: [outage.curve.positions[0], ethPos] } }
  // Only Base answered: its range falls below, Ethereum's keeps its published state and waits.
  const [live] = withLivePrices([both], { [`base:${pool}`]: { tick: -201000, price: 1900 } }, 1901)
  assert.equal(live.curve.positions[1].held, true)
  const r = evaluate([live, total], { 'a:2000-2500': 'in', 'a:eth:2000-2500': 'in', 'a:cost': 'na' }, { lastGood: true })
  assert.deepEqual(r.messages.map((m) => m.key), ['a:2000-2500'])
  assert.deepEqual([r.state['a:eth:2000-2500'], r.state['a:cost']], ['in', 'na'])
})

// A day out of a range: said once per time out, counted from the first update that found it out.
const timed = (steps) => {
  let prev = null
  return steps.map(([pool, h, opts = {}]) => { const e = evaluate([row(pool, opts.extra), total], prev, { now: Date.UTC(2026, 10, 15) + h * 3600e3, ...opts.o }); prev = e.state; return { kinds: e.messages.map((m) => m.kind), messages: e.messages, state: e.state } })
}

test('a range out for a day is said once, then again only after it has been back in', () => {
  const r = timed([[2200, 0], [1900, 1], [1900, 12], [1900, 24.9], [1900, 25], [1900, 40], [2200, 41], [1900, 42], [1900, 66]])
  assert.deepEqual(r.map((x) => x.kinds), [[], ['below'], [], [], ['out24'], [], ['back'], ['below'], ['out24']])
  const m = r[4].messages[0]
  assert.ok(m.title.includes('出区间已满 24 小时'), m.title)
  assert.ok(m.message.includes('全是 ETH') && m.message.includes('不赚利息'), m.message)
  assert.ok(!/0x[0-9a-f]{6}/i.test(m.title + m.message), 'no address in the message')
})

test('a day above a range says all USDC, and names the fixed-width rate of its pool when the table has it', () => {
  const pc = { fixed_label: '±3.5%', pools: [{ chain: 'base', pool_address: '0xabc', fixed: { staked: { median: 4.05 } } }] }
  const withPool = (pool) => { const x = row(pool, { pool_compare: pc }); x.curve.positions = x.curve.positions.map((p) => ({ ...p, pool_address: '0xABC' })); return x }
  let prev = null
  const kinds = []
  let last
  for (const [pool, h] of [[2200, 0], [2600, 1], [2600, 25]]) { const e = evaluate([withPool(pool), total], prev, { now: h * 3600e3 }); prev = e.state; kinds.push(e.messages.map((m) => m.kind)); last = e.messages }
  assert.deepEqual(kinds, [[], ['above'], ['out24']])
  assert.ok(last[0].message.includes('全是 USDC') && last[0].message.includes('±3.5% 区间质押的“平常”年化是 405%'), last[0].message)
})

test('a range already out on the first run starts its day from then, and sends nothing on that run', () => {
  const r = timed([[1900, 0], [1900, 23], [1900, 24]])
  assert.deepEqual(r.map((x) => x.kinds), [[], [], ['out24']])
})

test('a range already out when the clock first appears (state from before it existed) is not said a day later', () => {
  const old = { 'a:2000-2500': 'below', update: 'ok' }
  let prev = old
  const kinds = []
  for (const h of [1, 25, 50]) { const e = evaluate([row(1900), total], prev, { now: h * 3600e3 }); prev = e.state; kinds.push(e.messages.map((m) => m.kind)) }
  assert.deepEqual(kinds, [[], [], []])
  // Once it comes back and goes out again, the next day out is said.
  const later = []
  for (const [pool, h] of [[2200, 51], [1900, 52], [1900, 76]]) { const e = evaluate([row(pool), total], prev, { now: h * 3600e3 }); prev = e.state; later.push(e.messages.map((m) => m.kind)) }
  assert.deepEqual(later, [['back'], ['below'], ['out24']])
})

test('a price back just inside the bound (within BACK) ends the clock, and no day-out is said while it stays there', () => {
  // 1990 is out; 2005 is inside but within BACK of the lower bound, so the side stays "below".
  const r = timed([[2200, 0], [1990, 1], [2005, 2], [2005, 30], [1990, 31], [1990, 54], [1990, 55]])
  assert.deepEqual(r.map((x) => x.kinds), [[], ['below'], [], [], [], [], ['out24']])
})

test('the day-out message quotes the loss line next to the rate when the table has both', () => {
  const pc = { fixed_label: '±3.5%', cost_line: { days: 7, vol: 0.55, rate: 2.15 }, pools: [{ chain: 'base', pool_address: '0xabc', fixed: { staked: { median: 4.04 } } }] }
  const withPool = (pool) => { const x = row(pool, { pool_compare: pc }); x.curve.positions = x.curve.positions.map((p) => ({ ...p, pool_address: '0xabc' })); return x }
  let prev = null, last
  for (const [pool, h] of [[2200, 0], [1900, 1], [1900, 25]]) { const e = evaluate([withPool(pool), total], prev, { now: h * 3600e3 }); prev = e.state; last = e.messages }
  assert.equal(last[0].kind, 'out24')
  assert.ok(last[0].message.includes('年化是 404%') && last[0].message.includes('少赚约 215%'), last[0].message)
})

test('from the last good data a day out waits, and without live prices its clock is kept as it was', () => {
  let prev = null
  for (const [pool, h] of [[2200, 0], [1900, 1], [1900, 10]]) prev = evaluate([row(pool), total], prev, { now: h * 3600e3 }).state
  const stale = evaluate([row(1900), total], prev, { now: 30 * 3600e3, lastGood: true })
  assert.deepEqual(stale.messages.map((m) => m.kind), [])
  assert.equal(stale.state['a:2000-2500:out'], prev['a:2000-2500:out'])
  const blind = evaluate([row(1900), total], prev, { now: 30 * 3600e3, noPrices: true })
  assert.deepEqual(blind.messages.map((m) => m.kind), [])
  assert.equal(blind.state['a:2000-2500:out'], prev['a:2000-2500:out'])
  const fresh = evaluate([row(1900), total], prev, { now: 30 * 3600e3 })
  assert.deepEqual(fresh.messages.map((m) => m.kind), ['out24'])
  assert.ok(OUT_MS === 24 * 3600e3)
})

test('a combined view asked for on the page repeats its wallets\' ranges: it never alerts on its own', () => {
  const group = { ...row(1990), scope: 'g1', scope_label: '合计', group: true }
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'g1:2000-2500': 'in', 'g1:cost': 'na' }
  const { messages, state } = evaluate([row(1990), group, total], prev)
  assert.deepEqual(messages.map((m) => [m.key, m.kind]), [['a:2000-2500', 'below']])
  assert.ok(!Object.keys(state).some((k) => k.startsWith('g1:')), 'no state is kept for it')
})

test('a wallet seen for the first time (an address just added) starts quiet, then alerts like any other', () => {
  const c1 = { time_cst: '2026-10-30 12:00', tx: '0xaa', text: '收到 2 ETH，对方是不认识的合约 0xad3b…67bc，暂按资金转入计', usd: 5000 }
  const nv = { address: '0xb20000000000000000000078ee7ce2fe4908108c', symbol: 'NVDAc' }
  const added = (p, extra) => ({ ...row(p, extra), scope: 'x1', scope_label: '新' })
  // An update has run before (prev holds the other wallet), but never with this one.
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', update: 'ok' }
  const first = evaluate([row(2200), added(1990, { to_check: [c1], unpriced: [nv] }), total], prev)
  assert.deepEqual(first.messages, [])
  assert.equal(first.state['x1:2000-2500'], 'below')
  const next = evaluate([row(2200), added(2210, { to_check: [c1, { ...c1, tx: '0xbb' }], unpriced: [nv] }), total], first.state)
  assert.deepEqual(next.messages.map((m) => [m.key, m.kind]).sort(), [['x1:2000-2500', 'back'], ['x1:check', 'check']])
})

test('an address added on the page is named as such: its name cannot pass for a configured wallet\'s', () => {
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:2000-2500': 'in', 'x1:cost': 'na', update: 'ok' }
  const { messages } = evaluate([row(1990), { ...row(1990), scope: 'x1', scope_label: 'A', added: true }, total], prev)
  assert.deepEqual(messages.map((m) => m.title), ['A 跌出区间', '网页加的·A 跌出区间'])
})
