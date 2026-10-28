import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate } from '../lib/alerts.mjs'

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
