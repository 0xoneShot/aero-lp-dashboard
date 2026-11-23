import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, withLivePrices, costLinks, costSource, costSources, costSourcesFor, putBackRates, STALE_MS, OUT_MS } from '../lib/alerts.mjs'
import { recentre, splitShare } from '../lib/curve.mjs'

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
  const kinds = [], said = []
  for (const h of [1, 2.5, 3, 5]) {
    const r = evaluate([stamped(row(2200)), total], prev, { now: at + h * 3600e3 })
    kinds.push(r.messages.map((m) => m.kind)); said.push(...r.messages); prev = r.state
  }
  assert.deepEqual(kinds, [[], ['stale'], [], []])
  const back = evaluate([{ ...stamped(row(2200)), as_of: new Date(at + 5 * 3600e3).toISOString() }, total], prev, { now: at + 5 * 3600e3 + 60e3 })
  assert.deepEqual(back.messages.map((m) => m.kind), ['fresh'])
  assert.ok(STALE_MS === 2 * 3600e3)
  // It speaks for the alerts' own data (the hourly update's), not for the page, which a fresh pass may have
  // kept newer: it names the hourly update, and sends the reader to the page's own time.
  assert.equal(said[0].title, '整点更新 2 小时没成功了')
  assert.match(said[0].message, /^手机提醒用的数据停在 2026-10-30 12:00（北京时间）。/)
  assert.ok(said[0].message.endsWith('看板有没有跟着停，看它顶上“数据截至”或“数据停在”后面的时间。'), said[0].message)
  assert.doesNotMatch(said[0].message, /看板上的现值|先别按它做决定/)
  assert.equal(back.messages[0].title, '整点更新恢复了')
  assert.match(back.messages[0].message, /^手机提醒用的数据已更新到 /)
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

test('a day above a range says all USDC, and sets its pool\'s 平常 against the loss line when the table has both', () => {
  const pc = { fixed_label: '±3.5%', cost_line: { days: 7, vol: 0.55, rate: 2.15 }, pools: [{ chain: 'base', pool_address: '0xabc', fixed: { staked: { median: 4.05 } } }] }
  const withPool = (pool) => { const x = row(pool, { pool_compare: pc }); x.curve.positions = x.curve.positions.map((p) => ({ ...p, pool_address: '0xABC' })); return x }
  let prev = null
  const kinds = []
  let last
  for (const [pool, h] of [[2200, 0], [2600, 1], [2600, 25]]) { const e = evaluate([withPool(pool), total], prev, { now: h * 3600e3 }); prev = e.state; kinds.push(e.messages.map((m) => m.kind)); last = e.messages }
  assert.deepEqual(kinds, [[], ['above'], ['out24']])
  assert.ok(last[0].message.includes('全是 USDC') && last[0].message.includes('看板表格里你那一行：平常 405%，高过损耗线 215%。'), last[0].message)
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
  assert.ok(last[0].message.includes('看板表格里你那一行：平常 404%，高过损耗线 215%。'), last[0].message)
})

// A day out of a WETH/USDC range published from its ticks (src/run.mjs): where a range as wide lies around the
// price now, and what to swap. Invented ranges: 400 ticks on a spacing of 100 (Base, WETH first) and 300 on
// 50 (Ethereum, USDC first); the range holds `eth` ETH below it, split over `positions` positions.
const tickUsd = (t, invert) => (invert ? 1e12 / 1.0001 ** t : 1e12 * 1.0001 ** t)
const cents = (v) => Math.round(v * 100) / 100
const ticked = ({ lower = -199200, upper = -198800, invert = false, chain = 'base', address = '0x00000000000000000000000000000000000000b1', label = 'CL100',
  table = address, eth = 2.5, positions = 1, usual = 1.8, fee = 0.3, line = 1.1, here, stopped, pos = {} } = {}) => (P) => {
  const low = tickUsd(invert ? upper : lower, invert), high = tickUsd(invert ? lower : upper, invert)
  const sa = Math.sqrt(low * 1e-12), sb = Math.sqrt(high * 1e-12), L = (eth * 1e18) / (1 / sa - 1 / sb) / positions
  const in_range = P >= low && P < high
  const p = { wallet: 'A', low: cents(low), high: cents(high), pool: P, in_range, pool_address: address, tick_lower: lower, tick_upper: upper, L, sa, sb, chain, invert, ...pos }
  return { scope: 'a', scope_label: 'A', eth_usd: P, range_state: in_range ? 'in' : P < low ? 'below' : 'above', now_cost_eth_price: null,
    curve: { eth: 0, usd: 0, positions: Array.from({ length: positions }, () => ({ ...p })) },
    pool_compare: { fixed_label: '±3.5%', cost_line: line == null ? null : { days: 7, vol: 0.6, rate: line },
      pools: [{ chain, pool_address: table, ...(label ? { label } : {}), ...(here ? { here } : {}), ...(stopped != null ? { stopped } : {}),
        fixed: { staked: { median: usual }, fee: { median: fee } } }] } }
}
// The day-out message once the range has been out at P for a day, after being in at `inside`.
const dayOut = (rowAt, inside, P) => {
  let prev = null, last = []
  for (const [x, h] of [[inside, 0], [P, 1], [P, 25]]) { const e = evaluate([rowAt(x), total], prev, { now: h * 3600e3 }); prev = e.state; last = e.messages }
  const m = last.find((x) => x.kind === 'out24')
  assert.ok(m, JSON.stringify(last))
  return m
}
const num = (s) => Number(s.replace(/[$,]/g, ''))
const PUT_UP = /要按现价重挂、宽度不变的话：(\$[\d,.]+) – (\$[\d,.]+)；撤出后约 (\$[\d,.]+) USDC，先把约 (\$[\d,.]+) USDC 换成 ETH。/
const PUT_DOWN = /要按现价重挂、宽度不变的话：(\$[\d,.]+) – (\$[\d,.]+)；撤出后约 ([\d,.]+) ETH，先把约 ([\d,.]+) ETH 换成 USDC。/

test('a day above a range on its pool\'s grid: the same width around the price, all the USDC out, its ETH share swapped', () => {
  const rowAt = ticked(), P = 2447.5
  const m = dayOut(rowAt, 2280, P)
  assert.ok(m.message.includes('看板表格里你那一行：平常 180%，高过损耗线 110%。'), m.message)
  const [, a, b, out, swap] = PUT_UP.exec(m.message) ?? assert.fail(m.message)
  const nb = recentre({ tick_lower: -199200, tick_upper: -198800 }, P, 100)
  assert.ok(Math.abs(num(a) - nb.low) <= 0.5 && Math.abs(num(b) - nb.high) <= 0.5, m.message)
  assert.ok(num(a) < P && P < num(b) && Math.abs(num(b) / num(a) - 1.0001 ** 400) < 1e-3, m.message)
  // Only the liquidity: the range's USDC above it, and the share of it the new range holds in ETH at P (about half).
  const p = rowAt(P).curve.positions[0], usdc = (p.L * (p.sb - p.sa)) / 1e6, share = splitShare(nb.low, nb.high, P)
  assert.ok(Math.abs(num(out) - usdc) <= 0.5 && Math.abs(num(swap) - usdc * share) <= 0.5, `${m.message} ${usdc} ${share}`)
  assert.ok(share > 0.35 && share < 0.65, `${share}`)
  assert.ok(m.message.indexOf('平常') < m.message.indexOf('重挂'), m.message)
})

test('a day below a range: all the ETH out, its dollar share swapped into USDC', () => {
  const rowAt = ticked(), P = 2128.4
  const m = dayOut(rowAt, 2280, P)
  assert.ok(m.message.includes('低于下沿') && m.message.includes('全是 ETH'), m.message)
  const [, a, b, out, swap] = PUT_DOWN.exec(m.message) ?? assert.fail(m.message)
  const nb = recentre({ tick_lower: -199200, tick_upper: -198800 }, P, 100)
  assert.ok(Math.abs(num(a) - nb.low) <= 0.5 && Math.abs(num(b) - nb.high) <= 0.5 && num(a) < P && P < num(b), m.message)
  assert.equal(num(out), 2.5)
  assert.ok(Math.abs(num(swap) - 2.5 * (1 - splitShare(nb.low, nb.high, P))) <= 0.005, m.message)
})

test('positions of one range are put back together: their liquidity adds up', () => {
  const m = dayOut(ticked({ positions: 3 }), 2280, 2128.4)
  assert.equal(num(PUT_DOWN.exec(m.message)?.[3] ?? 'none'), 2.5, m.message)
})

test('a day out of an Ethereum range (USDC first): its ticks are read the other way round, the bounds come out the same way', () => {
  const pos = { tick_lower: 198550, tick_upper: 198850, invert: true }
  const rowAt = ticked({ lower: pos.tick_lower, upper: pos.tick_upper, invert: true, chain: 'eth', address: '0x00000000000000000000000000000000000000e1', label: 'CL50' })
  const { low, high } = rowAt(2350).curve.positions[0]
  assert.ok(low < 2350 && 2350 < high, `${low}-${high}`)
  for (const [P, re] of [[2462.2, PUT_UP], [2241.7, PUT_DOWN]]) {
    const m = dayOut(rowAt, 2350, P)
    assert.match(m.title, /^A（以太坊） 出区间已满 24 小时/)
    const [, a, b] = re.exec(m.message) ?? assert.fail(m.message)
    const nb = recentre(pos, P, 50)
    assert.ok(nb.tick_lower > 0 && Math.abs(num(a) - nb.low) <= 0.5 && Math.abs(num(b) - nb.high) <= 0.5, `${m.message} ${nb.low}-${nb.high}`)
    assert.ok(num(a) < P && P < num(b) && Math.abs(num(b) / num(a) - 1.0001 ** 300) < 1e-3, m.message)
  }
})

test('a pool in the table without its CL{n}: the same width around the price, off the grid', () => {
  const P = 2447.5, r = 1.0001 ** 400
  for (const rowAt of [ticked({ label: null }), ticked({ label: 'CLx' })]) {
    const m = dayOut(rowAt, 2280, P)
    const [, a, b] = PUT_UP.exec(m.message) ?? assert.fail(m.message)
    assert.ok(Math.abs(num(a) - P / Math.sqrt(r)) <= 0.5 && Math.abs(num(b) - P * Math.sqrt(r)) <= 0.5, m.message)
  }
})

test('a pool not in the table: nothing is known of its rate, so no range is put back', () => {
  const m = dayOut(ticked({ table: '0x00000000000000000000000000000000000000d1' }), 2280, 2447.5)
  assert.ok(m.message.endsWith('不赚利息。') && !m.message.includes('重挂') && !m.message.includes('平常'), m.message)
})

test('a range published without its liquidity still gets the bounds, but no amounts', () => {
  const m = dayOut(ticked({ pos: { L: undefined, sa: undefined, sb: undefined } }), 2280, 2447.5)
  assert.match(m.message, /要按现价重挂、宽度不变的话：\$[\d,]+ – \$[\d,]+。$/)
  assert.ok(!m.message.includes('撤出后'), m.message)
})

test('平常 below the loss line: said so, and no range to put back', () => {
  const m = dayOut(ticked({ usual: 0.85, line: 1.2 }), 2280, 2447.5)
  assert.ok(m.message.endsWith('看板表格里你那一行：平常 85%，已经低于损耗线 120%，放回去不划算。'), m.message)
  assert.ok(!m.message.includes('重挂'), m.message)
})

test('平常 and the loss line get a decimal when they would read the same', () => {
  const said = (usual, line) => dayOut(ticked({ usual, line }), 2280, 2128.4).message
  assert.ok(said(0.952, 0.948).includes('平常 95.2%，高过损耗线 94.8%。'), said(0.952, 0.948))
  assert.ok(said(0.948, 0.952).includes('平常 94.8%，已经低于损耗线 95.2%，放回去不划算。'), said(0.948, 0.952))
  assert.ok(said(1.234, 0.871).includes('平常 123%，高过损耗线 87%。'), said(1.234, 0.871))
})

test('without 平常 or the loss line no rate is said, and no range is put back', () => {
  for (const opts of [{ line: null }, { usual: null }, { usual: null, line: null }]) {
    const m = dayOut(ticked(opts), 2280, 2447.5)
    assert.ok(m.message.endsWith('不赚利息。') && !m.message.includes('平常') && !m.message.includes('损耗线') && !m.message.includes('重挂'), m.message)
  }
})

test('a stopped gauge: said so instead of a rate, and no range is put back', () => {
  const m = dayOut(ticked({ usual: null, stopped: true }), 2280, 2447.5)
  assert.ok(m.message.endsWith('不赚利息。看板表格里这个池子的质押奖励已停。'), m.message)
  // Not staked there: the fee column is its 平常, which a stopped gauge does not touch.
  const fee = dayOut(ticked({ usual: null, stopped: true, here: 'unstaked', fee: 1.5 }), 2280, 2447.5)
  assert.ok(fee.message.includes('平常 150%，高过损耗线 110%。') && PUT_UP.test(fee.message), fee.message)
})

test('平常 is the column the money is held in: the fee column when none of it is staked there', () => {
  const unstaked = dayOut(ticked({ here: 'unstaked', usual: 1.8, fee: 0.5 }), 2280, 2447.5)
  assert.ok(unstaked.message.endsWith('看板表格里你那一行：平常 50%，已经低于损耗线 110%，放回去不划算。'), unstaked.message)
  const staked = dayOut(ticked({ here: 'staked', usual: 1.8, fee: 0.5 }), 2280, 2447.5)
  assert.ok(staked.message.includes('平常 180%，高过损耗线 110%。') && PUT_UP.test(staked.message), staked.message)
})

test('putBackRates: staked unless none of the money is, both numbers or nothing, a stopped gauge only when its 平常 is the staked one', () => {
  const line = { rate: 1.1 }
  const pool = (o = {}) => ({ fixed: { staked: { median: 1.8 }, fee: { median: 0.5 } }, ...o })
  assert.deepEqual(putBackRates(pool(), line), { both: true, under: false, usual: 1.8, line: 1.1, stopped: false })
  assert.deepEqual(putBackRates(pool({ here: 'staked' }), line), { both: true, under: false, usual: 1.8, line: 1.1, stopped: false })
  assert.deepEqual(putBackRates(pool({ here: 'unstaked' }), line), { both: true, under: true, usual: 0.5, line: 1.1, stopped: false })
  assert.equal(putBackRates(pool(), { rate: 1.8 }).under, false) // equal is not below
  assert.equal(putBackRates(null, line).both, false)
  assert.equal(putBackRates(pool(), null).both, false)
  assert.equal(putBackRates({ ...pool(), fixed: undefined }, line).both, false)
  const stopped = { stopped: true, fixed: { staked: { median: null }, fee: { median: 0.5 } } }
  assert.deepEqual(putBackRates(stopped, line), { both: false, under: false, usual: null, line: 1.1, stopped: true })
  assert.equal(putBackRates({ ...stopped, here: 'unstaked' }, line).stopped, false)
})

test('a day out of a WETH/cbBTC range is not put back', () => {
  const m = dayOut((x) => btcRow(x), 0.0295, 0.032)
  assert.ok(m.message.includes('全是 cbBTC') && !m.message.includes('重挂'), m.message)
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

// What scripts/alerts.mjs keeps of a run whose messages of `kinds` failed to send: their previous state.
const unsent = (e, prev, kinds) => {
  const state = { ...e.state }
  for (const m of e.messages) if (kinds.includes(m.kind) && m.key in prev) state[m.key] = prev[m.key]
  return state
}

test('a 回到 held for fresh data, or not sent, still ends the clock: out again, the day counts from the new exit', () => {
  const at = (h) => Date.UTC(2026, 10, 15) + h * 3600e3
  let said = null
  for (const [pool, h] of [[2200, 0], [1900, 1], [1900, 25]]) said = evaluate([row(pool), total], said, { now: at(h) }).state
  assert.match(said['a:2000-2500:out'], /:sent$/)
  // Back in at hour 30, from the last good data (the 回到 waits) or with a 回到 that failed; out again from 31.
  const held = evaluate([row(2200), total], said, { now: at(30), lastGood: true })
  assert.deepEqual(held.messages.map((m) => m.kind), [])
  const back = evaluate([row(2200), total], said, { now: at(30) })
  assert.deepEqual(back.messages.map((m) => m.kind), ['back'])
  for (const start of [held.state, unsent(back, said, ['back'])]) {
    assert.equal(start['a:2000-2500'], 'below')
    assert.equal(start['a:2000-2500:out'], 'in')
    let prev = start
    const kinds = []
    for (const h of [31, 54, 55]) { const e = evaluate([row(1900), total], prev, { now: at(h) }); prev = e.state; kinds.push(e.messages.map((m) => m.kind)) }
    assert.deepEqual(kinds, [[], [], ['out24']])
    assert.equal(prev['a:2000-2500:out'], `${at(31)}:sent`)
  }
})

test('a 跌出 that failed to send is tried again without restarting the clock: the day counts from the first update that found it out', () => {
  const at = (h) => Date.UTC(2026, 10, 15) + h * 3600e3
  let prev = evaluate([row(2200), total], null, { now: at(0) }).state
  const kinds = []
  for (const [h, fails] of [[1, true], [2, true], [3, true], [4, false], [24.5, false], [25, false]]) {
    const e = evaluate([row(1900), total], prev, { now: at(h) })
    kinds.push(e.messages.map((m) => m.kind))
    prev = fails ? unsent(e, prev, ['below']) : e.state
  }
  assert.deepEqual(kinds, [['below'], ['below'], ['below'], ['below'], [], ['out24']])
  assert.equal(prev['a:2000-2500:out'], `${at(1)}:sent`)
})

test('the day out never comes ahead of the 跌出 or 涨出 it follows: a run that sends one leaves the day out to the next', () => {
  const at = (h) => Date.UTC(2026, 10, 15) + h * 3600e3
  // Every send fails for a day (hours 1 to 24); the 跌出 goes at 25, the day out an hour after it.
  let prev = evaluate([row(2200), total], null, { now: at(0) }).state
  const kinds = []
  for (let h = 1; h <= 26; h++) {
    const e = evaluate([row(1900), total], prev, { now: at(h) })
    if (h >= 25) kinds.push(e.messages.map((m) => [m.kind, m.title]))
    prev = h <= 24 ? unsent(e, prev, ['below', 'out24']) : e.state
  }
  assert.deepEqual(kinds, [[['below', 'A 跌出区间']], [['out24', 'A 出区间已满 25 小时']]])
  assert.equal(prev['a:2000-2500:out'], `${at(1)}:sent`)
  // One 跌出 that failed, and no run until a day later.
  prev = evaluate([row(2200), total], null, { now: at(0) }).state
  let e = evaluate([row(1900), total], prev, { now: at(1) })
  prev = unsent(e, prev, ['below'])
  const late = []
  for (const h of [26, 27]) { e = evaluate([row(1900), total], prev, { now: at(h) }); prev = e.state; late.push(e.messages.map((m) => m.kind)) }
  assert.deepEqual(late, [['below'], ['out24']])
  // Out below for a day and then straight above it in one hour: the 涨出 first, the day out (all USDC) next.
  const jump = timed([[2200, 0], [1900, 1], [1900, 23], [2600, 25], [2600, 26]])
  assert.deepEqual(jump.map((x) => x.kinds), [[], ['below'], [], ['above'], ['out24']])
  assert.ok(jump[4].messages[0].message.includes('全是 USDC'), jump[4].messages[0].message)
})

test('without live prices, or for a range whose pool had no live quote, no clock starts on the old data', () => {
  const at = (h) => Date.UTC(2026, 10, 15) + h * 3600e3
  const prev = evaluate([row(2200), total], null, { now: at(0) }).state
  const blind = evaluate([row(1900), total], prev, { now: at(1), noPrices: true })
  assert.deepEqual(blind.messages, [])
  assert.equal(blind.state['a:2000-2500'], 'in')
  assert.ok(!('a:2000-2500:out' in blind.state), JSON.stringify(blind.state))
  const unquoted = row(1900)
  unquoted.curve.positions = unquoted.curve.positions.map((p) => ({ ...p, pool_address: '0xabc', held: true }))
  const held = evaluate([unquoted, total], prev, { now: at(1), lastGood: true })
  assert.deepEqual(held.messages, [])
  assert.equal(held.state['a:2000-2500'], 'in')
  assert.ok(!('a:2000-2500:out' in held.state), JSON.stringify(held.state))
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

test('an added wallet missing for an hour (its update ran without it) keeps its state: back, a change meanwhile is told', () => {
  const added = (p) => ({ ...row(p), scope: 'x1', scope_label: '新', added: true })
  const tracked = new Set(['a', 'x1'])
  // Both seen before, both in range.
  let { state } = evaluate([row(2200), added(2200), total], { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:2000-2500': 'in', 'x1:cost': 'na', update: 'ok' }, { tracked })
  // An hour without it: its state stays, the configured wallet's goes on as ever.
  const gap = evaluate([row(1990), total], state, { tracked })
  assert.deepEqual(gap.messages.map((m) => [m.key, m.kind]), [['a:2000-2500', 'below']])
  assert.equal(gap.state['x1:2000-2500'], 'in')
  assert.equal(gap.state['x1:cost'], 'na')
  // Back, and out of range meanwhile: told now, as it would have been.
  const back = evaluate([row(1990), added(1990), total], gap.state, { tracked })
  assert.deepEqual(back.messages.map((m) => [m.key, m.kind]), [['x1:2000-2500', 'below']])
  assert.equal(back.messages[0].title, '网页加的·新 跌出区间')
  // One no longer tracked is forgotten; and without the list of tracked wallets nothing is kept, as before.
  assert.ok(!Object.keys(evaluate([row(1990), total], state, { tracked: new Set(['a']) }).state).some((k) => k.startsWith('x1:')))
  assert.ok(!Object.keys(evaluate([row(1990), total], state).state).some((k) => k.startsWith('x1:')))
})

test('a wallet let go since the last good data is not alerted for: the alerts from it while the update fails', () => {
  const added = (p) => ({ ...row(p), scope: 'x1', scope_label: '新', added: true })
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:2000-2500': 'in', 'x1:cost': 'na', update: 'ok' }
  // Removed on the page this hour, while the last good summary still holds it.
  const gone = evaluate([row(1990), added(1990), total], prev, { lastGood: true, tracked: new Set(['a']) })
  assert.deepEqual(gone.messages.map((m) => [m.key, m.kind]), [['a:2000-2500', 'below']])
  assert.ok(!Object.keys(gone.state).some((k) => k.startsWith('x1:')))
  // Still tracked: alerted as before.
  const kept = evaluate([row(1990), added(1990), total], prev, { lastGood: true, tracked: new Set(['a', 'x1']) })
  assert.deepEqual(kept.messages.map((m) => [m.key, m.kind]).sort(), [['a:2000-2500', 'below'], ['x1:2000-2500', 'below']])
})

// ETH moved from wallet A to an address added on the page (x1) that holds it idle; A and x1 together are a
// combined view asked for on the page (g1). x1's own cost price counts what it got at its price on arrival,
// while the gain or loss A made on it before stays in A's books; the view's counts the money as A put it in.
// Made-up figures.
const idle = (p, extra = {}) => ({ scope: 'x1', scope_label: '新', added: true, eth_usd: p, range_state: 'none', now_cost_eth_price: 1700,
  eth_units_now: 10, curve: { eth: 10, usd: 0, positions: [] }, cost_from: { scope: 'g1', with: ['a'] }, ...extra })
const both = (p, extra = {}) => ({ ...row(p), scope: 'g1', scope_label: '合计', group: true, now_cost_eth_price: 2400, ...extra })
// A second added address (x2), named in x1's alerts as one added on the page.
const second = () => ({ ...row(2100), scope: 'x2', scope_label: '二', added: true })

test('an added wallet that moved money with another takes its cost price from the combined view holding both', () => {
  // Recorded under its own cost price before (as 1.18.0 judged it): above it.
  let prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'above', update: 'ok' }
  const step = (p) => { const r = evaluate([row(p), idle(p), both(p), total], prev); prev = r.state; return r.messages }
  // Above its own 1700 but below the view's 2400: nothing is said, and it counts as below the view's price.
  assert.deepEqual(step(2100), [])
  assert.equal(prev['x1:cost'], 'below@g1')
  assert.deepEqual(step(2200), [])
  const up = step(2410)
  assert.deepEqual(up.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  assert.equal(up[0].title, '网页加的·新 ETH 涨到成本价以上')
  assert.equal(up[0].message, 'ETH $2,410.00，不低于和 A 合在一起算的成本价 $2,400.00。现在一起撤出、把 ETH 全卖掉，本金不亏、利息全拿。')
  // The configured wallet's own state is as it would be without it.
  assert.equal(prev['a:cost'], 'na')
  // Re-armed below the view's price (2% under 2400 is 2352), not its own.
  assert.deepEqual([step(2360), prev['x1:cost']], [[], 'above@g1'])
  assert.deepEqual([step(2340), prev['x1:cost']], [[], 'below@g1'])
})

test('the 跌出 message of an added wallet counted with another quotes the combined view\'s cost price, for withdrawing both', () => {
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:2000-2500': 'in', 'x1:cost': 'na', update: 'ok' }
  const lp = (p, from = { scope: 'g1', with: ['a'] }) => ({ ...row(p), scope: 'x1', scope_label: '新', added: true, now_cost_eth_price: 1700, eth_units_now: 10, cost_from: from })
  const { messages } = evaluate([row(1990), lp(1990), both(1990), total], prev)
  assert.deepEqual(messages.map((m) => [m.key, m.kind]), [['a:2000-2500', 'below'], ['x1:2000-2500', 'below']])
  // The configured wallet's message is its own, as before.
  assert.equal(messages[0].message, 'ETH $1,990.00，低于下沿 $2,000.00，这个仓位全部变成了 ETH，现在不赚利息。现在撤出的话 ETH 成本价 $2,300.00：涨到这个价以上再卖，本金不亏、利息全拿。')
  assert.equal(messages[1].message, 'ETH $1,990.00，低于下沿 $2,000.00，这个仓位全部变成了 ETH，现在不赚利息。和 A 合在一起算，现在一起撤出的话 ETH 成本价 $2,400.00：涨到这个价以上把 ETH 全卖掉，本金不亏、利息全拿。')
  // ETH already above the view's price.
  const over = evaluate([row(1990), lp(1990), both(1990, { now_cost_eth_price: 1900 }), total], prev).messages[1]
  assert.ok(over.message.endsWith('和 A 合在一起算，现在一起撤出的话 ETH 成本价 $1,900.00，ETH $1,990.00 已经高于它：这个价以上把 ETH 全卖掉，本金不亏、利息全拿。'), over.message)
  // With no such view, its own price, said to count it alone, with no advice on it and where to add it.
  const alone = evaluate([row(1990), lp(1990, { scope: null, with: ['a'] }), total], prev).messages[1]
  assert.ok(alone.message.endsWith('现在撤出的话，只按它自己的账算 ETH 成本价 $1,700.00：它和 A 之间转过钱，转账的币按当时的价算，那边之前的盈亏不在里面。在 A 的看板上点「加地址」加它，就按合在一起的成本价算。'), alone.message)
  assert.ok(!alone.message.includes('本金不亏'), alone.message)
  // Its view missing from this update: no cost price, and no advice.
  const gap = evaluate([row(1990), lp(1990), total], prev).messages[1]
  assert.ok(gap.message.endsWith('和它合在一起算成本价的地址这一小时有没读完的，成本价先不算。'), gap.message)
  assert.ok(!gap.message.includes('本金不亏') && !gap.message.includes('$1,700') && !gap.message.includes('$2,400'), gap.message)
})

test('an added wallet counted with another added address names it as one added on the page', () => {
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'below@g1', 'x2:2000-2500': 'in', 'x2:cost': 'na', update: 'ok' }
  const via = evaluate([row(2410), idle(2410, { cost_from: { scope: 'g1', with: ['a', 'x2'] } }), second(), both(2410), total], prev).messages
  assert.deepEqual(via.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  assert.ok(via[0].message.includes('不低于和 A、网页加的·二 合在一起算的成本价 $2,400.00'), via[0].message)
  // Counted alone: where to add it names every wallet it has to be viewed with.
  const own = evaluate([row(1710), idle(1710, { cost_from: { scope: null, with: ['a', 'x2'] } }), second(), total], { ...prev, 'a:2000-2500': 'below', 'a:cost': 'below', 'x1:cost': 'below@own' }).messages
  assert.deepEqual(own.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  assert.equal(own[0].message, 'ETH $1,710.00，不低于它自己的成本价 $1,700.00。但这只按它自己的账算：它和 A、网页加的·二 之间转过钱，转账的币按当时的价算，那边之前的盈亏不在里面。在同时含有 A、网页加的·二 的看板上点「加地址」加它，就按合在一起的成本价提醒。')
})

test('while its combined view is missing from an update, an added wallet\'s cost state waits rather than count it alone', () => {
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'below@g1', update: 'ok' }
  // Above its own cost price and the view's, but the view is not in this summary (another address of it left out).
  const gap = evaluate([row(2450), idle(2450), total], prev)
  assert.deepEqual(gap.messages, [])
  assert.equal(gap.state['x1:cost'], 'below@g1')
  const back = evaluate([row(2450), idle(2450), both(2450), total], gap.state)
  assert.deepEqual(back.messages.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  // Never seen before and its view missing: nothing is said, and it starts with no cost state.
  const fresh = evaluate([row(2450), idle(2450), total], { 'a:2000-2500': 'in', 'a:cost': 'na', update: 'ok' })
  assert.deepEqual([fresh.messages, fresh.state['x1:cost']], [[], 'na'])
})

test('a change of the price an added wallet\'s cost state is judged against starts afresh, and tells it when ETH is already above the new price', () => {
  // Said above its own price (no view held it and A), then the view is asked for: below the view's, quietly,
  // and the view's own crossing is told.
  let prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'above@own', update: 'ok' }
  const A = row(2100) // in its range throughout
  const step = (rows) => { const r = evaluate(rows, prev); prev = r.state; return r.messages }
  assert.deepEqual(step([A, idle(2380), both(2380), total]), [])
  assert.equal(prev['x1:cost'], 'below@g1')
  assert.deepEqual(step([A, idle(2410), both(2410), total]).map((m) => m.kind), ['cost'])
  // The view gone (no longer asked for): its own price, above it already, so told at once, said to count it alone.
  const gone = step([A, idle(2300, { cost_from: { scope: null, with: ['a'] } }), total])
  assert.deepEqual(gone.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  assert.ok(gone[0].message.startsWith('ETH $2,300.00，不低于它自己的成本价 $1,700.00。但这只按它自己的账算'), gone[0].message)
  assert.equal(prev['x1:cost'], 'above@own')
  // No longer tied to another wallet: its own price as ever, plain.
  assert.deepEqual(step([A, idle(1650, { cost_from: undefined }), total]), [])
  assert.equal(prev['x1:cost'], 'below')
  const plain = step([A, idle(1720, { cost_from: undefined }), total])
  assert.deepEqual(plain.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  assert.equal(plain[0].message, 'ETH $1,720.00，不低于成本价 $1,700.00。现在卖掉 ETH，本金不亏、利息全拿。')
})

test('with no combined view holding it and the wallet it moved money with, an added wallet keeps its own cost price, said to count it alone', () => {
  const alone = (p) => idle(p, { cost_from: { scope: null, with: ['a'] } })
  // A out of its range and below its own cost price: quiet.
  const prev = { 'a:2000-2500': 'below', 'a:cost': 'below', 'x1:cost': 'below@own', update: 'ok' }
  const { messages } = evaluate([row(1710), alone(1710), total], prev)
  assert.deepEqual(messages.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  assert.equal(messages[0].message, 'ETH $1,710.00，不低于它自己的成本价 $1,700.00。但这只按它自己的账算：它和 A 之间转过钱，转账的币按当时的价算，那边之前的盈亏不在里面。在 A 的看板上点「加地址」加它，就按合在一起的成本价提醒。')
})

test('a configured wallet\'s cost price is always its own', () => {
  const prev = { 'a:2000-2500': 'below', 'a:cost': 'below', update: 'ok' }
  const odd = { ...row(1950, { now_cost_eth_price: 1900 }), cost_from: { scope: 'g1', with: ['x1'] } }
  const { messages, state } = evaluate([odd, both(1950), total], prev)
  assert.deepEqual(messages.map((m) => [m.key, m.kind]), [['a:cost', 'cost']])
  assert.equal(messages[0].message, 'ETH $1,950.00，不低于成本价 $1,900.00。现在卖掉 ETH，本金不亏、利息全拿。')
  assert.equal(state['a:cost'], 'above')
})

test('from the last good data, an added wallet\'s cost state waits when its combined view had a range without a live quote', () => {
  const heldPos = (p) => ({ low: 2000, high: 2500, pool: p, in_range: true, held: true, pool_address: '0xabc' })
  const a = { ...row(2450), curve: { positions: [heldPos(2450)] } }
  const g = { ...both(2450), curve: { positions: [heldPos(2450)] } }
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'below@g1', update: 'ok' }
  const r = evaluate([a, idle(2450), g, total], prev, { lastGood: true })
  assert.deepEqual([r.messages, r.state['x1:cost']], [[], 'below@g1'])
  // Its view read live: it goes out.
  const live = evaluate([row(2450), idle(2450), both(2450), total], prev, { lastGood: true })
  assert.deepEqual(live.messages.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
})

test('the view an added wallet takes its cost price from holds it and every wallet its money moved through: the smallest, then the first asked for', () => {
  assert.equal(costSource('x', [], [{ key: 'g1', wallets: ['a', 'x'] }]), null)
  assert.deepEqual(costSource('x', ['a'], []), { scope: null, with: ['a'] })
  // Views without it, or without one of the wallets it moved money with, do not count.
  assert.deepEqual(costSource('x', ['a'], [{ key: 'g1', wallets: ['a', 'b'] }, { key: 'g2', wallets: ['b', 'x'] }]), { scope: null, with: ['a'] })
  assert.deepEqual(costSource('x', ['a', 'y'], [{ key: 'g1', wallets: ['a', 'x'] }, { key: 'g2', wallets: ['x', 'y'] }]), { scope: null, with: ['a', 'y'] })
  assert.deepEqual(costSource('x', ['a', 'y'], [{ key: 'g1', wallets: ['a', 'x'] }, { key: 'g2', wallets: ['a', 'b', 'x', 'y'] }]), { scope: 'g2', with: ['a', 'b', 'y'] })
  assert.deepEqual(costSource('x', ['a'], [{ key: 'g1', wallets: ['a', 'b', 'x'] }, { key: 'g2', wallets: ['a', 'x'] }]), { scope: 'g2', with: ['a'] })
  assert.deepEqual(costSource('x', ['a'], [{ key: 'g1', wallets: ['a', 'x'] }, { key: 'g2', wallets: ['x', 'a'] }]), { scope: 'g1', with: ['a'] })
})

test('the wallets an address moved money with: flows booked between tracked wallets, and transfers with one left out of this update, in the wallets\' order', () => {
  const keyAt = { '0xa': 'a', '0xb': 'b', '0xd': 'd', '0xx': 'x' }
  const flows = [{ kind: 'between', cp: '0xb' }, { kind: 'transfer', cp: '0xa' }, { kind: 'between', cp: '0xc' }, { kind: 'between', cp: '0xx' },
    { kind: 'opening', cp: null }, { kind: 'between', cp: '0xa' }, { kind: 'between', cp: '0xb' }, { kind: 'between', cp: 'constructor' }, { kind: 'transfer', cp: '0xd' }]
  assert.deepEqual(costLinks(flows, keyAt, 'x', ['a', 'b', 'd', 'x']), ['a', 'b'])
  assert.deepEqual(costLinks([], keyAt, 'x', ['a', 'b', 'd', 'x']), [])
  // A transfer with a tracked wallet counts when that wallet is left out of this update (its books then book
  // it so); one corrected to 'transfer' by hand does not.
  assert.deepEqual(costLinks(flows, keyAt, 'x', ['a', 'b', 'd', 'x'], { present: new Set(['a', 'b', 'd', 'x']) }), ['a', 'b'])
  assert.deepEqual(costLinks(flows, keyAt, 'x', ['a', 'b', 'd', 'x'], { present: new Set(['a', 'b', 'x']) }), ['a', 'b', 'd'])
  assert.deepEqual(costLinks([{ kind: 'transfer', cp: '0xd', forced: true }], keyAt, 'x', ['d', 'x'], { present: new Set(['x']) }), [])
  // With no single move up to the floor a wallet is not tied in: gas top-ups, however many, or a test sent
  // and sent back. One move of capital is.
  const usd = [{ kind: 'between', cp: '0xa', usd: 60 }, { kind: 'between', cp: '0xa', usd: -60 }, { kind: 'between', cp: '0xa', usd: 45 },
    { kind: 'between', cp: '0xb', usd: 3.5 }, { kind: 'between', cp: '0xb', usd: -106 }, { kind: 'between', cp: '0xd', usd: null }, { kind: 'between', cp: '0xd', usd: NaN }]
  assert.deepEqual(costLinks(usd, keyAt, 'x', ['a', 'b', 'd', 'x'], { floor: 100 }), ['b'])
  assert.deepEqual(costLinks(usd, keyAt, 'x', ['a', 'b', 'd', 'x'], { floor: 106 }), ['b'])
  assert.deepEqual(costLinks(usd, keyAt, 'x', ['a', 'b', 'd', 'x'], { floor: 107 }), [])
  assert.deepEqual(costLinks(usd, keyAt, 'x', ['a', 'b', 'd', 'x']), ['a', 'b', 'd'])
  // One move of capital ties them, whatever smaller moves came after it.
  assert.deepEqual(costLinks([{ kind: 'between', cp: '0xa', usd: 5000 }, { kind: 'between', cp: '0xa', usd: 20 }], keyAt, 'x', ['a', 'x'], { floor: 100 }), ['a'])
})

test('cost sources follow the money on through other added addresses, chosen among every view asked for', () => {
  const W = [{ key: 'a', address: '0xa' }, { key: 'b', address: '0xb' }, { key: 'x1', address: '0x1', extra: true }, { key: 'x2', address: '0x2', extra: true }, { key: 'x3', address: '0x3', extra: true }]
  const all = new Set(W.map((w) => w.key))
  // A sent ETH to x1, x1 sent part of it on to x2; B sent x2 only gas; x3 moved nothing with anyone tracked.
  const books = {
    x1: [{ kind: 'between', cp: '0xa', usd: 20000 }, { kind: 'between', cp: '0x2', usd: -9000 }],
    x2: [{ kind: 'between', cp: '0x1', usd: 9000 }, { kind: 'between', cp: '0xb', usd: 4 }],
    x3: [{ kind: 'transfer', cp: '0xe', usd: 5000 }],
  }
  // A configured wallet's books are never asked for: the trail ends there.
  const flowsOf = (k) => { if (!(k in books)) throw new Error(`asked for ${k}`); return books[k] }
  const views = [{ key: 'g1', wallets: ['a', 'x1'] }, { key: 'g2', wallets: ['x1', 'x2'] }, { key: 'g3', wallets: ['a', 'x1', 'x2'] }, { key: 'g4', wallets: ['a', 'b', 'x1', 'x2'] }]
  const full = costSources({ wallets: W, present: all, flowsOf, groups: views })
  assert.deepEqual(full.sources, { x1: { scope: 'g3', with: ['a', 'x2'] }, x2: { scope: 'g3', with: ['a', 'x1'] }, x3: null })
  // The links found are kept, by address, for an update that leaves one of them out.
  assert.deepEqual(full.links, { '0x1': ['0xa', '0x2'], '0x2': ['0x1'], '0x3': [] })
  // With only the two-address view, x2 is counted alone: that view leaves out what A lost on the coins.
  assert.deepEqual(costSources({ wallets: W, present: all, flowsOf, groups: views.slice(0, 2) }).sources.x2, { scope: null, with: ['a', 'x1'] })
  // x1 left out of this update: x2's books book its coins from x1 as a transfer, and x1's books are not
  // built. The links kept from before follow the trail on through x1 to A, so the view named is the one of
  // every update, holding x1 and missing from this one too: the alert waits.
  const behind = { ...books, x2: [{ kind: 'transfer', cp: '0x1', usd: 9000 }, { kind: 'between', cp: '0xb', usd: 4 }] }
  const flowsBehind = (k) => { if (k === 'x1' || !(k in behind)) throw new Error(`asked for ${k}`); return behind[k] }
  const out = costSources({ wallets: W, present: new Set(['a', 'b', 'x2', 'x3']), flowsOf: flowsBehind, groups: views, seen: full.links })
  assert.deepEqual(out.sources, { x2: { scope: 'g3', with: ['a', 'x1'] }, x3: null })
  // What x1 is linked to is kept as it was; x2's links found now (x1 still among them) replace its own.
  assert.deepEqual(out.links, full.links)
  // With nothing kept (a first update, or the cache started over), the trail ends at x1.
  assert.deepEqual(costSources({ wallets: W, present: new Set(['a', 'b', 'x2', 'x3']), flowsOf: flowsBehind, groups: views }).sources.x2, { scope: 'g2', with: ['x1'] })
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x2:cost': 'below@g3', update: 'ok' }
  const x2 = { ...idle(2450), scope: 'x2', scope_label: '二', cost_from: out.sources.x2 }
  const held = evaluate([row(2450), x2, total], prev)
  assert.deepEqual([held.messages, held.state['x2:cost']], [[], 'below@g3'])
})

test('the links kept from before stand in for a wallet left out of an update, whose reward claim or order the others\' books cannot name', () => {
  const W = [{ key: 'a', address: '0xa' }, { key: 'x0', address: '0x0a', extra: true }, { key: 'x1', address: '0x1a', extra: true }]
  const views = [{ key: 'g1', wallets: ['x0', 'x1'] }, { key: 'g2', wallets: ['a', 'x1'] }]
  // x0's order paid x1: booked between them while both are read; with x0 left out, x1's books book the fill
  // from the settlement contract (internal, not a flow at all), and a reward x0 claimed to x1 from the reward
  // contract. Either way x1's flows no longer name x0. x1 also got coins straight from A.
  const inStep = { x0: [{ kind: 'between', cp: '0x1a', usd: -5000 }], x1: [{ kind: 'between', cp: '0x0a', usd: 5000 }, { kind: 'between', cp: '0xa', usd: 3000 }] }
  const first = costSources({ wallets: W, present: new Set(['a', 'x0', 'x1']), flowsOf: (k) => inStep[k], groups: views })
  assert.deepEqual(first.sources.x1, { scope: null, with: ['a', 'x0'] })
  const alone = { x1: [{ kind: 'transfer', cp: '0x0000000000000000000000000000000000000000', usd: 500 }, { kind: 'between', cp: '0xa', usd: 3000 }] }
  // Hour after hour while x0 stays left out: each update keeps the link for the next.
  let seen = first.links
  for (let hour = 1; hour <= 3; hour++) {
    const later = costSources({ wallets: W, present: new Set(['a', 'x1']), flowsOf: (k) => alone[k], groups: views, seen })
    assert.deepEqual(later.sources.x1, { scope: null, with: ['a', 'x0'] }, `hour ${hour}`)
    assert.deepEqual(later.links, { '0x0a': ['0x1a'], '0x1a': ['0xa', '0x0a'] }, `hour ${hour}`)
    seen = later.links
  }
  // Without them, x1 would take the view with A alone, which leaves out x0's money.
  assert.deepEqual(costSources({ wallets: W, present: new Set(['a', 'x1']), flowsOf: (k) => alone[k], groups: views }).sources.x1, { scope: 'g2', with: ['a'] })
  // A link is read both ways: x0 read alone after its order (x1 left out, so x0's books book the payment as a
  // transfer to it), then x1 read alone: x1 still waits for x0, though it was never kept from x1's side.
  const payer = costSources({ wallets: W, present: new Set(['a', 'x0']), flowsOf: (k) => ({ x0: [{ kind: 'transfer', cp: '0x1a', usd: -5000 }] })[k], groups: views })
  assert.deepEqual(payer.links, { '0x0a': ['0x1a'] })
  assert.deepEqual(costSources({ wallets: W, present: new Set(['a', 'x1']), flowsOf: (k) => alone[k], groups: views, seen: payer.links }).sources.x1, { scope: null, with: ['a', 'x0'] })
  // Kept links count only for a wallet left out: between two wallets read now, the links are found afresh,
  // and an address no longer tracked (or anything else in the file) is passed over.
  const stale = { '0x1a': ['0x0a', '0xa', '0xdead', { toString: 1 }, ['0x0a'], 7, null], '0x0a': 'junk', __proto__: null }
  const now = costSources({ wallets: W, present: new Set(['a', 'x0', 'x1']), flowsOf: (k) => ({ x0: [], x1: [] })[k], groups: views, seen: stale })
  assert.deepEqual(now.sources, { x0: null, x1: null })
  assert.deepEqual(now.links, { '0x1a': [], '0x0a': [] })
  assert.deepEqual(costSources({ wallets: W, present: new Set(['a', 'x1']), flowsOf: (k) => alone[k], groups: views, seen: { '0x1a': [{ toString: 1 }, ['0x0a']] } }).sources.x1, { scope: 'g2', with: ['a'] })
  assert.deepEqual(costSources({ wallets: W, present: new Set(['a', 'x0', 'x1']), flowsOf: (k) => inStep[k], groups: views, seen: ['junk'] }).sources, first.sources)
  // An update run without the added addresses keeps what is kept for them.
  assert.deepEqual(costSources({ wallets: W.slice(0, 1), present: new Set(['a']), flowsOf: () => [], groups: [], seen: first.links }), { sources: {}, links: first.links })
})

test('the trail is followed to its end, however long, and along every branch', () => {
  const W = ['c', 'c1', 'c2'].map((k) => ({ key: k, address: `0x${k}` })).concat(['x1', 'x2', 'x3', 'y1', 'y2', 'x'].map((k) => ({ key: k, address: `0x${k}`, extra: true })))
  const all = new Set(W.map((w) => w.key))
  const between = (...cps) => cps.map((cp) => ({ kind: 'between', cp: `0x${cp}`, usd: 5000 }))
  // C to x1 to x2 to x3, each passing most of its ETH on; and a fork, C1 to y1 to x and C2 to y2 to x.
  const books = { x1: between('c', 'x2'), x2: between('x1', 'x3'), x3: between('x2'), y1: between('c1', 'x'), y2: between('c2', 'x'), x: between('y1', 'y2') }
  const views = [{ key: 'g1', wallets: ['c', 'x1', 'x2', 'x3'] }, { key: 'g2', wallets: ['x1', 'x2', 'x3'] }, { key: 'g3', wallets: ['c1', 'c2', 'y1', 'y2', 'x'] }, { key: 'g4', wallets: ['c2', 'y1', 'y2', 'x'] }]
  const { sources } = costSources({ wallets: W, present: all, flowsOf: (k) => books[k], groups: views })
  assert.deepEqual(sources.x3, { scope: 'g1', with: ['c', 'x1', 'x2'] })
  assert.deepEqual(sources.x, { scope: 'g3', with: ['c1', 'c2', 'y1', 'y2'] })
})

test('run.mjs\'s inputs: every tracked wallet and every view asked for, also those left out of this update', () => {
  const base = [{ key: 'a', address: '0xa' }], extra = [{ key: 'x0', address: '0x0a', extra: true }, { key: 'x1', address: '0x1a', extra: true }]
  // Members in any order, as the store keeps them; x0 left out of this update.
  const groups = [{ key: 'g1', members: ['x1', 'a', 'x0'] }, { key: 'g2', members: ['x1', 'a'] }]
  const flows = { x1: [{ kind: 'between', cp: '0xa', usd: 3000 }, { kind: 'transfer', cp: '0x0a', usd: 2000 }] }
  const out = costSourcesFor({ base, extra, present: new Set(['a', 'x1']), groups, flowsOf: (k) => flows[k] })
  assert.deepEqual(out.sources, { x1: { scope: 'g1', with: ['a', 'x0'] } })
  assert.deepEqual(out.links, { '0x1a': ['0xa', '0x0a'] })
  // The kept links reach costSources: with x1's flows no longer naming x0 (its reward claim, or order), x1
  // still waits for the view holding x0.
  const later = { x1: [{ kind: 'between', cp: '0xa', usd: 3000 }] }
  const kept = costSourcesFor({ base, extra, present: new Set(['a', 'x1']), groups, flowsOf: (k) => later[k], seen: { '0x1a': ['0xa', '0x0a'], '0x0a': ['0x1a'] } })
  assert.deepEqual(kept.sources, { x1: { scope: 'g1', with: ['a', 'x0'] } })
  assert.deepEqual(kept.links, { '0x1a': ['0xa', '0x0a'], '0x0a': ['0x1a'] })
})

// x1 with a range of its own (2000-2500), as row() publishes one.
const lpx = (p, extra = {}) => ({ ...row(p), scope: 'x1', scope_label: '新', added: true, now_cost_eth_price: 1700, eth_units_now: 10, cost_from: { scope: 'g1', with: ['a'] }, ...extra })

test('an added wallet with no ETH of its own is not told to sell on a combined view\'s price', () => {
  // x1 sent its ETH back to A, or sold it for USDC: no positions, and too little ETH for a price of its own.
  let prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'na', update: 'ok' }
  const step = (rows) => { const r = evaluate(rows, prev); prev = r.state; return r.messages }
  const empty = (p, extra = {}) => idle(p, { eth_units_now: 0.01, now_cost_eth_price: null, curve: { eth: 0.01, usd: 3000, positions: [] }, ...extra })
  for (const p of [2300, 2390, 2410, 2300, 2450]) assert.deepEqual(step([row(2100), empty(p), both(p), total]), [])
  assert.equal(prev['x1:cost'], 'na')
  // 0.05 ETH of its own is enough, less is not.
  for (const eth of [0.05, 1, 4]) {
    const r = evaluate([row(2100), idle(2410, { eth_units_now: eth }), both(2410), total], { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'below@g1', update: 'ok' })
    assert.deepEqual(r.messages.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']], String(eth))
  }
  const dust = evaluate([row(2100), idle(2410, { eth_units_now: 0.049 }), both(2410), total], { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'below@g1', update: 'ok' })
  assert.deepEqual([dust.messages, dust.state['x1:cost']], [[], 'na'])
  // A range of dust falling out quotes no price it will never be told on.
  const fell = evaluate([row(2100), lpx(1990, { eth_units_now: 0.01 }), both(1990), total], { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:2000-2500': 'in', 'x1:cost': 'na', update: 'ok' })
  assert.equal(fell.messages.find((m) => m.key === 'x1:2000-2500').message, 'ETH $1,990.00，低于下沿 $2,000.00，这个仓位全部变成了 ETH，现在不赚利息。')
  assert.deepEqual(step([row(2100), empty(2450, { now_cost_eth_price: 0 }), both(2450), total]), [])
  assert.equal(prev['x1:cost'], 'na')
  // ETH back in it: judged on the view's price, from where ETH is.
  assert.deepEqual(step([row(2100), idle(2380), both(2380), total]), [])
  assert.equal(prev['x1:cost'], 'below@g1')
  assert.deepEqual(step([row(2100), idle(2410), both(2410), total]).map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
})

test('an added wallet whose combined view is asked for while ETH is above the view\'s price already is told at once; a new view\'s price starts without the old band', () => {
  // Out of range and counted alone (its own price 2400, above ETH), the hint followed: the view asked for
  // counts the coins as A bought them (1700), and ETH is above that already.
  let prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'below@own', update: 'ok' }
  const step = (rows) => { const r = evaluate(rows, prev); prev = r.state; return r.messages }
  assert.deepEqual(step([row(2050), idle(2050, { now_cost_eth_price: 2400, cost_from: { scope: null, with: ['a'] } }), total]), [])
  const told = step([row(2050), idle(2050, { now_cost_eth_price: 2400 }), both(2050, { now_cost_eth_price: 1700 }), total])
  assert.deepEqual(told.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  assert.equal(told[0].message, 'ETH $2,050.00，不低于和 A 合在一起算的成本价 $1,700.00。现在一起撤出、把 ETH 全卖掉，本金不亏、利息全拿。')
  assert.deepEqual([step([row(2080), idle(2080, { now_cost_eth_price: 2400 }), both(2080, { now_cost_eth_price: 1700 }), total]), prev['x1:cost']], [[], 'above@g1'])
  // A smaller view asked for later (g2 at 2140): ETH 2100 is within 2% under it, but the new price starts
  // without g1's band: below it, quietly, and told when ETH passes it.
  const g2 = (p) => ({ ...both(p), scope: 'g2', now_cost_eth_price: 2140 })
  const on2 = (p) => idle(p, { cost_from: { scope: 'g2', with: ['a'] } })
  assert.deepEqual(step([row(2100), on2(2100), both(2100, { now_cost_eth_price: 1700 }), g2(2100), total]), [])
  assert.equal(prev['x1:cost'], 'below@g2')
  assert.deepEqual(step([row(2200), on2(2200), both(2200, { now_cost_eth_price: 1700 }), g2(2200), total]).map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
})

test('an added wallet whose combined view is gone while ETH is between its own price and the view\'s is told on its own price, said to count it alone', () => {
  // Waiting for the view's 2400 at 2300; the view is no longer asked for (dropped for the newer ones).
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'below@g1', update: 'ok' }
  const { messages, state } = evaluate([row(2300), idle(2300, { cost_from: { scope: null, with: ['a'] } }), total], prev)
  assert.deepEqual(messages.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  assert.equal(messages[0].message, 'ETH $2,300.00，不低于它自己的成本价 $1,700.00。但这只按它自己的账算：它和 A 之间转过钱，转账的币按当时的价算，那边之前的盈亏不在里面。在 A 的看板上点「加地址」加它，就按合在一起的成本价提醒。')
  assert.equal(state['x1:cost'], 'above@own')
})

test('an added wallet out of range in an hour its combined view is missing is told on the view\'s price once the view is back', () => {
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:2000-2500': 'in', 'x1:cost': 'na', update: 'ok' }
  const fall = evaluate([row(1990), lpx(1990), total], prev)
  const x1 = fall.messages.find((m) => m.key === 'x1:2000-2500')
  assert.ok(x1.message.endsWith('和它合在一起算成本价的地址这一小时有没读完的，成本价先不算。'), x1.message)
  assert.equal(fall.state['x1:cost'], 'below@g1')
  const back = evaluate([row(1990), lpx(1990), both(1990, { now_cost_eth_price: 1900 }), total], fall.state)
  assert.deepEqual(back.messages.filter((m) => m.key.startsWith('x1')).map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  assert.equal(back.messages.find((m) => m.key === 'x1:cost').message, 'ETH $1,990.00，不低于和 A 合在一起算的成本价 $1,900.00。现在一起撤出、把 ETH 全卖掉，本金不亏、利息全拿。')
  // In range when the view went missing, it stays unjudged.
  assert.equal(evaluate([row(2100), lpx(2100), total], prev).state['x1:cost'], 'na')
})

test('from the last good data, an added wallet\'s cost state judged on a view keeps it when its old range looks back in range', () => {
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:2000-2500': 'below', 'x1:cost': 'below@g1', update: 'ok' }
  const r = evaluate([row(2100), lpx(2100), both(2100), total], prev, { lastGood: true })
  assert.equal(r.state['x1:cost'], 'below@g1')
  // Fresh data: it had been withdrawn, and ETH is above the view's price.
  const fresh = evaluate([row(2450), idle(2450), both(2450), total], r.state)
  assert.deepEqual(fresh.messages.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
})

test('an added wallet counted alone names a wallet left out of this update, and points to no view that would leave it out', () => {
  const prev = { 'a:2000-2500': 'below', 'a:cost': 'below', 'x1:cost': 'below@own', 'x1:2000-2500': 'in', update: 'ok' }
  const alone = { scope: null, with: ['a', 'x0'] }
  const { messages } = evaluate([row(1710), idle(1710, { cost_from: alone }), total], prev)
  assert.deepEqual(messages.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  assert.equal(messages[0].message, 'ETH $1,710.00，不低于它自己的成本价 $1,700.00。但这只按它自己的账算：它和 A、1 个这一小时没读完的地址 之间转过钱，转账的币按当时的价算，那边之前的盈亏不在里面。')
  const fell = evaluate([row(1990), lpx(1990, { cost_from: alone }), total], { ...prev, 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'na' }).messages.find((m) => m.key === 'x1:2000-2500')
  assert.ok(fell.message.endsWith('现在撤出的话，只按它自己的账算 ETH 成本价 $1,700.00：它和 A、1 个这一小时没读完的地址 之间转过钱，转账的币按当时的价算，那边之前的盈亏不在里面。'), fell.message)
  // Every one of them is counted.
  const two = evaluate([row(1710), idle(1710, { cost_from: { scope: null, with: ['a', 'x0', 'x2'] } }), total], prev).messages
  assert.ok(two[0].message.includes('它和 A、2 个这一小时没读完的地址 之间转过钱'), two[0].message)
})

test('a change between two views, from a 1.18.0 state, or into the plain basis is told at once when ETH is already above the new price; a state never judged starts quiet', () => {
  const A = row(2100)
  const was = (state) => ({ 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': state, update: 'ok' })
  const kinds = (r) => r.messages.map((m) => [m.key, m.kind])
  // Waiting for g1's 2400 at 2300, a smaller view (g2 at 2200) is asked for.
  const g2 = (p) => ({ ...both(p), scope: 'g2', now_cost_eth_price: 2200 })
  const views = evaluate([A, idle(2300, { cost_from: { scope: 'g2', with: ['a'] } }), both(2300), g2(2300), total], was('below@g1'))
  assert.deepEqual(kinds(views), [['x1:cost', 'cost']])
  assert.equal(views.messages[0].message, 'ETH $2,300.00，不低于和 A 合在一起算的成本价 $2,200.00。现在一起撤出、把 ETH 全卖掉，本金不亏、利息全拿。')
  assert.equal(views.state['x1:cost'], 'above@g2')
  // A state 1.18.0 wrote (its own price as ever), on the first update with a view: below it or above it.
  for (const [state, own] of [['below', 2500], ['above', 1700]]) {
    const r = evaluate([A, idle(2300, { now_cost_eth_price: own }), both(2300, { now_cost_eth_price: 2200 }), total], was(state))
    assert.deepEqual([kinds(r), r.state['x1:cost']], [[['x1:cost', 'cost']], 'above@g1'], state)
  }
  // No links left (the wallet it moved money with let go): its own price as ever, on the plain text.
  const plain = evaluate([A, idle(2300, { cost_from: null }), total], was('below@g1'))
  assert.deepEqual(kinds(plain), [['x1:cost', 'cost']])
  assert.equal(plain.messages[0].message, 'ETH $2,300.00，不低于成本价 $1,700.00。现在卖掉 ETH，本金不亏、利息全拿。')
  assert.equal(plain.state['x1:cost'], 'above')
  // Never judged: an address just caught up, or one in range last hour and withdrawn now. Quiet, as a
  // configured wallet is.
  const fresh = evaluate([A, idle(2450), both(2450), total], { 'a:2000-2500': 'in', 'a:cost': 'na', update: 'ok' })
  assert.deepEqual([kinds(fresh), fresh.state['x1:cost']], [[], 'above@g1'])
  const out = evaluate([A, idle(2450), both(2450), total], was('na'))
  assert.deepEqual([kinds(out), out.state['x1:cost']], [[], 'above@g1'])
})

test('in an hour its combined view is missing, an added wallet in range needs no price: out of range again, it is told on the view\'s price', () => {
  // Told on g1 already ('above@g1'); its ETH goes into a new 2000-2500 range while another address of g1 is behind.
  let prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:cost': 'above@g1', update: 'ok' }
  const step = (rows) => { const r = evaluate(rows, prev); prev = r.state; return r.messages.filter((m) => m.key.startsWith('x1')) }
  step([row(2100), lpx(2100), total])
  assert.equal(prev['x1:cost'], 'na')
  const fell = step([row(1990), lpx(1990), total])
  assert.ok(fell[0].message.endsWith('成本价先不算。'), fell[0].message)
  assert.equal(prev['x1:cost'], 'below@g1')
  assert.deepEqual(step([row(1990), lpx(1990), both(1990, { now_cost_eth_price: 1900 }), total]).map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
  // One unjudged hour in range, then read out of it just under the view's price (within its 2% band):
  // below it, and told when ETH passes it.
  prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:2000-2500': 'in', 'x1:cost': 'above@g1', update: 'ok' }
  step([row(2100), lpx(2100), total])
  assert.equal(prev['x1:cost'], 'na')
  step([row(1940), lpx(1940), both(1940, { now_cost_eth_price: 1950 }), total])
  assert.equal(prev['x1:cost'], 'below@g1')
  assert.deepEqual(step([row(1960), lpx(1960), both(1960, { now_cost_eth_price: 1950 }), total]).map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
})

test('from the last good data, an added wallet\'s ETH follows the live pools: a range it fell through is judged on its view\'s price', () => {
  // x1's last good row: ETH 2600, above its 2000-2500 range, so all USDC and no ETH; counted with A in g1, at 1950.
  const x1 = { ...outage, scope: 'x1', scope_label: '新', added: true, eth_usd: 2600, range_state: 'above', eth_units_now: 0, cost_from: { scope: 'g1', with: ['a'] },
    curve: { ...outage.curve, positions: [{ ...outage.curve.positions[0], pool: 2600, in_range: false }] } }
  const live = (price, tick) => withLivePrices([row(2100), x1, both(2100, { now_cost_eth_price: 1950 }), total], { [`base:${pool}`]: { tick, price } }, price)
  const prev = { 'a:2000-2500': 'in', 'a:cost': 'na', 'x1:2000-2500': 'above', 'x1:cost': 'na', update: 'ok' }
  const fell = evaluate(live(1900, -201000), prev, { lastGood: true })
  assert.ok(fell.messages.find((m) => m.key === 'x1:2000-2500').message.endsWith('和 A 合在一起算，现在一起撤出的话 ETH 成本价 $1,950.00：涨到这个价以上把 ETH 全卖掉，本金不亏、利息全拿。'))
  assert.equal(fell.state['x1:cost'], 'below@g1')
  const up = evaluate(live(1960, -200600), fell.state, { lastGood: true })
  assert.deepEqual(up.messages.map((m) => [m.key, m.kind]), [['x1:cost', 'cost']])
})
