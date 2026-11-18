import test from 'node:test'
import assert from 'node:assert/strict'
import { attachOutSince } from '../lib/outclock.mjs'
import { evaluate } from '../lib/alerts.mjs'

// Invented wallets, ranges and times. Positions as src/run.mjs publishes them: a wallet's own row names its
// positions by its label, as a total or a combined view does.
const T0 = Date.UTC(2031, 4, 6, 7), H = 3600e3
const pos = (wallet, low, high, extra = {}) => ({ wallet, low, high, pool: low * 0.97, in_range: false, chain: 'base', pool_address: '0x00000000000000000000000000000000000000b1', ...extra })
const keys = { 甲: 'w1', 乙: 'w2', 网页名: 'x0a1b2c3d' }
const keyOf = (label) => keys[label] ?? null
const sinces = (row) => row.curve.positions.map((p) => p.out_since ?? null)

test('a wallet\'s own row takes the clock of each of its ranges out of bounds, on Base and on Ethereum', () => {
  const rows = [{ scope: 'w1', scope_label: '甲', curve: { positions: [
    pos('甲', 2101.5, 2186.25),
    pos('甲', 2050, 2133.75, { chain: 'eth', invert: true }),
    pos('甲', 1880.4, 1957.1, { pool: 1900, in_range: true }),
  ] } }]
  const state = { 'w1:2101.5-2186.25': 'below', 'w1:2101.5-2186.25:out': `${T0}`, 'w1:eth:2050-2133.75': 'below', 'w1:eth:2050-2133.75:out': `${T0 + 2 * H}:sent`, 'w1:1880.4-1957.1': 'in', update: 'ok' }
  assert.equal(attachOutSince(rows, state, keyOf), rows)
  assert.deepEqual(sinces(rows[0]), [T0, T0 + 2 * H, null])
  assert.ok(!('out_since' in rows[0].curve.positions[2]))
})

test('a total or a combined view finds each position\'s wallet by its label', () => {
  const total = { scope: 'total', scope_label: '合计', curve: { positions: [pos('甲', 2101.5, 2186.25), pos('乙', 2101.5, 2186.25), pos('丙', 2101.5, 2186.25)] } }
  const group = { scope: 'g3', scope_label: '合计', group: true, curve: { positions: [pos('乙', 2101.5, 2186.25), pos('网页名', 1990, 2071.2, { chain: 'eth' })] } }
  const state = { 'w1:2101.5-2186.25:out': `${T0}`, 'w2:2101.5-2186.25:out': `${T0 + H}:sent`, 'x0a1b2c3d:eth:1990-2071.2:out': `${T0 + 3 * H}`,
    // Clocks kept for the views themselves would not be read: the alerts keep none.
    'total:2101.5-2186.25:out': `${T0 - H}`, 'g3:2101.5-2186.25:out': `${T0 - H}` }
  attachOutSince([total, group], state, keyOf)
  // 丙 is no wallet the build knows: its position gets nothing.
  assert.deepEqual(sinces(total), [T0, T0 + H, null])
  assert.deepEqual(sinces(group), [T0 + H, T0 + 3 * H])
})

test('back inside the bounds (\'in\'), in range, or another wallet\'s range with the same bounds: nothing', () => {
  const rows = [{ scope: 'w1', scope_label: '甲', curve: { positions: [pos('甲', 2101.5, 2186.25), pos('甲', 2200, 2289.6, { in_range: true }), pos('甲', 2300, 2394.1)] } }]
  const state = { 'w1:2101.5-2186.25:out': 'in', 'w1:2200-2289.6:out': `${T0}`, 'w2:2300-2394.1:out': `${T0}`, 'w1:2300-2394.1:out': 'garbage' }
  attachOutSince(rows, state, keyOf)
  assert.deepEqual(sinces(rows[0]), [null, null, null])
})

test('no alert state (a missing or unreadable file) attaches nothing, and an earlier stamp does not stay', () => {
  for (const state of [null, undefined, 'not json', 42, ['w1:2101.5-2186.25:out']]) {
    const rows = [{ scope: 'w1', scope_label: '甲', curve: { positions: [{ ...pos('甲', 2101.5, 2186.25), out_since: T0 }] } }, { scope: 'w2', scope_label: '乙' }]
    assert.equal(attachOutSince(rows, state, keyOf), rows)
    assert.deepEqual(sinces(rows[0]), [null])
  }
  assert.deepEqual(attachOutSince(undefined, {}, keyOf), undefined)
})

test('a WETH/cbBTC range is keyed on its bounds in the coin, as the alerts key it', () => {
  const coin = pos('甲', 2210.4, 2390.7, { quote: { symbol: 'cbBTC', usd: 79000, low: 0.02798, high: 0.03026 } })
  const rows = [{ scope: 'w1', scope_label: '甲', curve: { positions: [coin] } }, { scope: 'total', scope_label: '合计', curve: { positions: [{ ...coin }] } }]
  attachOutSince(rows, { 'w1:0.02798-0.03026:out': `${T0}`, 'w1:2210.4-2390.7:out': `${T0 - 5 * H}` }, keyOf)
  assert.deepEqual([sinces(rows[0]), sinces(rows[1])], [[T0], [T0]])
})

test('the page gets the clock the alerts keep: from the first update that found the range out, until it is back', () => {
  // A wallet with a Base and an Ethereum range, alone and in the total, as the summary has it each hour.
  const at = (base, eth) => {
    const ps = [pos('甲', 2101.5, 2186.25, { pool: base, in_range: base >= 2101.5 && base < 2186.25 }), pos('甲', 2050, 2133.75, { chain: 'eth', pool: eth, in_range: eth >= 2050 && eth < 2133.75 })]
    return [{ scope: 'w1', scope_label: '甲', curve: { positions: ps } }, { scope: 'total', scope_label: '合计', curve: { positions: ps.map((p) => ({ ...p })) } }]
  }
  let state = null
  const page = (base, eth, h) => {
    const rows = at(base, eth)
    state = evaluate(rows, state, { now: T0 + h * H }).state
    attachOutSince(rows, JSON.parse(JSON.stringify(state)), keyOf)
    return rows.map(sinces)
  }
  assert.deepEqual(page(2150, 2100, 0), [[null, null], [null, null]])
  assert.deepEqual(page(2050, 2100, 1), [[T0 + H, null], [T0 + H, null]])
  assert.deepEqual(page(2040, 2140, 2), [[T0 + H, T0 + 2 * H], [T0 + H, T0 + 2 * H]])
  // A day on: the alert is sent, the clock is the same.
  assert.deepEqual(page(2030, 2150, 26), [[T0 + H, T0 + 2 * H], [T0 + H, T0 + 2 * H]])
  // The Base range back in its bounds: its clock is gone; still out on Ethereum.
  assert.deepEqual(page(2120, 2150, 27), [[null, T0 + 2 * H], [null, T0 + 2 * H]])
})
