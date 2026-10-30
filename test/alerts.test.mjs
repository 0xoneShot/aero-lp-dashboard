import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, withLivePrices, STALE_MS } from '../lib/alerts.mjs'

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
