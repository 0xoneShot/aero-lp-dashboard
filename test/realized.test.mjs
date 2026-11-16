import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRealized, unsent, realizedFrom, latestRealized, freshRealized, feedAnswer, LEVELS, REARM, DOWN_MS, RP_MAX_AGE } from '../lib/realized.mjs'

const H = 3600e3, T0 = Date.parse('2026-11-16T15:00:00Z')
// Prices as multiples of a realized price of 50,000 (BTC) and 2,000 (ETH); null: not read.
const q = (b, e = 0.9) => ({
  btc: { price: b == null ? null : b * 50000, rp: 50000, rpDate: '2026-11-15' },
  eth: { price: e == null ? null : e * 2000, rp: 2000, rpDate: '2026-11-14' },
})
// Runs the multiples hour by hour from `state`; returns each run's messages and the last state.
const run = (state, steps, t = T0) => {
  const out = []
  for (const s of steps) { const r = evaluateRealized(s, state, { now: (t += H) }); out.push(r.messages); state = r.state }
  return { out, state, t }
}
const kinds = (out) => out.map((ms) => ms.map((m) => `${m.key}:${m.kind}`))

test('the first run says where both coins stand and what will be told, and only records each level', () => {
  const { messages, state } = evaluateRealized(q(1.2155, 0.881), null, { now: T0 })
  assert.deepEqual(messages.map((m) => m.kind), ['open'])
  const m = messages[0]
  assert.ok(m.message.includes('BTC $60,775，是全网持仓成本 $50,000 的 1.21 倍；'), m.message)
  assert.ok(m.message.includes('ETH $1,762，是全网持仓成本 $2,000 的 0.88 倍，已经在它下面'), m.message)
  assert.ok(m.message.includes('BTC 0.8、0.7、0.5 倍，ETH 0.75、0.7、0.55、0.4、0.3 倍') && m.message.includes('回到成本上方 3% 也提醒'), m.message)
  assert.deepEqual(state.levels.btc, { 1: 'above', 0.8: 'above', 0.7: 'above', 0.5: 'above' })
  assert.deepEqual(state.levels.eth, { 1: 'below', 0.75: 'above', 0.7: 'above', 0.55: 'above', 0.4: 'above', 0.3: 'above' })
  assert.equal(state.opened, true)
  // Opened once: the next run is quiet.
  assert.deepEqual(evaluateRealized(q(1.2, 0.88), state, { now: T0 + H }).messages, [])
})

test('the realized price itself is told both ways, each once per crossing, with a band against a price hovering at it', () => {
  const start = evaluateRealized(q(1.1), null, { now: T0 }).state
  const { out } = run(start, [q(0.99), q(0.98), q(1.01), q(0.995), q(1.029), q(1.031), q(1.02), q(0.999)])
  assert.deepEqual(kinds(out), [['btc:break'], [], [], [], [], ['btc:back'], [], ['btc:break']])
  const brk = out[0][0], back = out[5][0]
  assert.equal(brk.title, 'BTC 跌破全网持仓成本')
  assert.ok(brk.message.includes('BTC $49,500，全网持仓成本 $50,000（Coin Metrics，11 月 15 日的数），现在是它的 0.990 倍。'), brk.message)
  assert.ok(brk.message.includes('2011 年 9 月到 12 月、2015 年 1 月到 10 月（最长）、2018 年 12 月到 2019 年 3 月、2022 年 6 月到 12 月，BTC 大部分时间在它下面。下一档 0.8 倍，现在是 $40,000。'), brk.message)
  assert.equal(back.title, 'BTC 回到全网持仓成本上方')
  assert.ok(back.message.includes('高 3.1%'), back.message)
})

test('a lower level is told once per crossing and re-armed quietly once the price is REARM above it', () => {
  const start = evaluateRealized(q(0.85), null, { now: T0 }).state
  const { out } = run(start, [q(0.79), q(0.81), q(0.79), q(0.8 * (1 + REARM) + 1e-9), q(0.79)])
  assert.deepEqual(kinds(out), [['btc:break'], [], [], [], ['btc:break']])
  const m = out[0][0]
  assert.equal(m.title, 'BTC 跌破全网持仓成本的 0.8 倍')
  assert.ok(m.message.includes('2022 年 6 月和 11 月两次见底在 0.78 和 0.75 倍') && m.message.includes('下一档 0.7 倍，现在是 $35,000。'), m.message)
})

test('levels crossed together make one message, named by the lowest; the lowest level says no lower one is told', () => {
  const start = evaluateRealized(q(1.05, 0.9), null, { now: T0 }).state
  const { out } = run(start, [q(0.69, 0.5), q(0.4, 0.29)])
  assert.deepEqual(kinds(out), [['btc:break', 'eth:break'], ['btc:break', 'eth:break']])
  const [btc, eth] = out[0]
  assert.equal(btc.title, 'BTC 跌破全网持仓成本的 0.7 倍')
  assert.ok(btc.message.includes('（这次一起跌破了 1、0.8、0.7 倍）') && btc.message.includes('下一档 0.5 倍'), btc.message)
  assert.equal(eth.title, 'ETH 跌破全网持仓成本的 0.55 倍')
  assert.ok(eth.message.includes('（这次一起跌破了 0.75、0.7、0.55 倍）') && eth.message.includes('2022 年 6 月见底 0.53 倍'), eth.message)
  assert.ok(out[1][0].message.includes('这是最低一档，再往下不再提醒。'), out[1][0].message)
  assert.ok(out[1][1].title.endsWith('0.3 倍') && out[1][1].message.includes('这是最低一档'), out[1][1].message)
})

test('a price just under a level never reads as at it', () => {
  const start = evaluateRealized(q(0.81), null, { now: T0 }).state
  const m = evaluateRealized(q(0.79996), start, { now: T0 + H }).messages[0]
  assert.ok(m.message.includes('现在是它的 0.799 倍'), m.message)
})

test('the next level named is the first one under the price, also from a state that lacks some levels', () => {
  // A level added since the state was written is only recorded; the level named next is still under the price.
  const partial = { opened: true, levels: { btc: { 1: 'above' }, eth: { 1: 'below' } }, down: {} }
  const { messages, state } = evaluateRealized(q(0.69), partial, { now: T0 })
  assert.deepEqual(messages.map((m) => m.title), ['BTC 跌破全网持仓成本'])
  assert.ok(messages[0].message.includes('下一档 0.5 倍，现在是 $25,000。'), messages[0].message)
  assert.deepEqual(state.levels.btc, { 1: 'below', 0.8: 'below', 0.7: 'below', 0.5: 'above' })
})

test('what each ETH level says happened there', () => {
  const start = evaluateRealized(q(1.1, 1.1), null, { now: T0 }).state
  const at = (e) => evaluateRealized(q(1.1, e), start, { now: T0 + H }).messages[0].message
  assert.ok(at(0.99).includes('2018 年 8 月到 2020 年 5 月（最长，将近两年）、2022 年 6 月到 12 月、2025 年 3 月到 4 月、2026 年 2 月到 8 月，ETH 大部分时间在它下面。'), at(0.99))
  assert.ok(at(0.69).includes('2022 年 11 月见底 0.70 倍，是 2022 年 7 月以后最低的一次。'), at(0.69))
})

test('a coin not judged keeps its state; half a day of it is told once, and its return with what crossed meanwhile', () => {
  const start = evaluateRealized(q(1.1, 0.9), null, { now: T0 }).state
  const hours = Array.from({ length: 13 }, () => q(null, 0.9))
  const { out, state } = run(start, [...hours, q(null, 0.9), q(0.95, 0.9)])
  // The first run without it begins the gap: twelve hours later it is told.
  assert.deepEqual(kinds(out).slice(0, 12).flat(), [])
  assert.deepEqual(kinds(out)[12], ['down:down'])
  // It names the coin not judged and why, says the other one is still watched, and what its return makes up for.
  assert.equal(out[12][0].title, 'BTC 全网持仓成本提醒暂停')
  assert.ok(out[12][0].message.startsWith('BTC 取不到价格（Chainlink 和 Coinbase），已经 12 小时没法判断，这期间跌破不会提醒（ETH 照常）。'), out[12][0].message)
  assert.ok(out[12][0].message.endsWith('恢复后会告诉你，到时还在下面的档位会补发，中间跌破又涨回来的会漏掉。'), out[12][0].message)
  assert.deepEqual(kinds(out)[13], [])
  // Back: the crossing while it was not judged is told, and so is the return.
  assert.deepEqual(kinds(out)[14], ['btc:break', 'up:up'])
  assert.equal(out[14][1].title, 'BTC 全网持仓成本提醒恢复')
  assert.ok(out[14][1].message.includes('BTC $47,500，是全网持仓成本 $50,000 的 0.95 倍，已经在它下面'), out[14][1].message)
  assert.deepEqual(state.down, {})
  // The run after its return is quiet.
  assert.deepEqual(evaluateRealized(q(0.95, 0.9), state, { now: T0 + 16 * H }).messages, [])
  // A realized price too old (the last one read is used for RP_MAX_AGE), rather than a price, is named as such.
  const old = q(1.1, 0.9); old.eth.rp = null
  const r = run(start, Array.from({ length: 13 }, () => old)).out
  assert.equal(r[12][0].title, 'ETH 全网持仓成本提醒暂停')
  assert.ok(r[12][0].message.startsWith('ETH 取不到 4 天以内的全网持仓成本（Coin Metrics），已经 12 小时没法判断，这期间跌破不会提醒（BTC 照常）。'), r[12][0].message)
})

test('both coins not judged make one message naming each with what it lacks; each is told back on its own', () => {
  const start = evaluateRealized(q(1.1, 0.9), null, { now: T0 }).state
  const none = q(null, null); none.eth.rp = null
  const { out, state, t } = run(start, Array.from({ length: 13 }, () => none))
  assert.deepEqual(kinds(out)[12], ['down:down'])
  assert.equal(out[12][0].title, 'BTC/ETH 全网持仓成本提醒暂停')
  assert.ok(out[12][0].message.startsWith('BTC 取不到价格（Chainlink 和 Coinbase）；ETH 取不到价格（Chainlink 和 Coinbase）和 4 天以内的全网持仓成本（Coin Metrics），已经 12 小时没法判断，这期间跌破不会提醒。'), out[12][0].message)
  assert.deepEqual(out[12][0].coins, ['btc', 'eth'])
  // The same lack is said once for both.
  const same = run(start, Array.from({ length: 13 }, () => q(null, null))).out[12][0]
  assert.ok(same.message.startsWith('BTC、ETH 取不到价格（Chainlink 和 Coinbase），已经 12 小时没法判断'), same.message)
  // BTC back while ETH is still not judged: BTC alone is told back, then nothing, then ETH on its own.
  const back = run(state, [q(1.1, null), q(1.1, null), q(1.1, 0.9), q(1.1, 0.9)], t)
  assert.deepEqual(kinds(back.out), [['up:up'], [], ['up:up'], []])
  assert.equal(back.out[0][0].title, 'BTC 全网持仓成本提醒恢复')
  assert.deepEqual(back.out[0][0].coins, ['btc'])
  assert.equal(back.out[2][0].title, 'ETH 全网持仓成本提醒恢复')
  assert.deepEqual(back.state.down, {})
})

test('a level crossed and regained while a coin was not judged is not told: only where it stands on its return', () => {
  const start = evaluateRealized(q(1.1, 0.9), null, { now: T0 }).state
  // Whatever BTC did in the day it was not judged, it is back above every level.
  const { out } = run(start, [...Array.from({ length: 24 }, () => q(null)), q(1.05)])
  assert.deepEqual(kinds(out).flat(), ['down:down', 'up:up'])
  assert.ok(out[24][0].message.includes('BTC $52,500，是全网持仓成本 $50,000 的 1.05 倍。'), out[24][0].message)
})

test('before the opening message a coin told as not judged is still told back, and the opening message stands in for it once both are judged', () => {
  // ETH has never been judged: half a day of it is told.
  const { out, state, t } = run(null, Array.from({ length: 13 }, () => q(1.1, null)), T0 - H)
  assert.deepEqual(kinds(out).flat(), ['down:down'])
  assert.equal(state.opened, false)
  // Back while BTC is not judged: told back; back with both judged: the opening message says where both stand.
  assert.deepEqual(kinds(run(state, [q(null, 0.9)], t).out), [['up:up']])
  assert.deepEqual(kinds(run(state, [q(1.1, 0.9), q(1.1, 0.9)], t).out), [['open:open'], []])
  // That opening message not sent: ETH is still to be told back, on its own if BTC is not judged next time,
  // and half a day more of it not judged is not told a second time.
  const open = evaluateRealized(q(1.1, 0.9), state, { now: t + H })
  assert.deepEqual(open.messages[0].coins, ['eth'])
  const kept = unsent(open.state, state, open.messages[0])
  assert.equal(kept.opened, false)
  assert.equal(kept.down.eth.told, true)
  assert.deepEqual(kinds(run(JSON.parse(JSON.stringify(kept)), [q(null, 0.9), q(null, 0.9)], t + H).out), [['up:up'], []])
  assert.deepEqual(kinds(run(JSON.parse(JSON.stringify(kept)), [q(1.1, 0.9), q(1.1, 0.9)], t + H).out), [['open:open'], []])
  assert.deepEqual(kinds(run(JSON.parse(JSON.stringify(kept)), Array.from({ length: 14 }, () => q(1.1, null)), t + H).out).flat(), [])
  // A message without its coins (never one of this module's own) changes nothing rather than throw.
  assert.doesNotThrow(() => unsent({ levels: {}, opened: true, down: {} }, {}, { key: 'down' }))
})

test('a gap shorter than half a day says nothing, and a crossing in it is told on return', () => {
  const start = evaluateRealized(q(1.1), null, { now: T0 }).state
  const { out } = run(start, [q(null), q(null), q(0.9)])
  assert.deepEqual(kinds(out), [[], [], ['btc:break']])
})

test('a message not sent is sent again next run', () => {
  const start = evaluateRealized(q(1.1), null, { now: T0 }).state
  const prev = JSON.parse(JSON.stringify(start))
  const a = evaluateRealized(q(0.9), prev, { now: T0 + H })
  assert.deepEqual(a.messages.map((m) => m.kind), ['break'])
  const kept = unsent(a.state, prev, a.messages[0])
  const b = evaluateRealized(q(0.9), kept, { now: T0 + 2 * H })
  assert.deepEqual(b.messages.map((m) => m.kind), ['break'])
  // Sent this time: the run after is quiet.
  assert.deepEqual(evaluateRealized(q(0.9), b.state, { now: T0 + 3 * H }).messages, [])
  // Back above the realized price.
  const c = evaluateRealized(q(1.05), b.state, { now: T0 + 4 * H })
  assert.deepEqual(c.messages.map((m) => m.kind), ['back'])
  const d = evaluateRealized(q(1.05), unsent(c.state, b.state, c.messages[0]), { now: T0 + 5 * H })
  assert.deepEqual(d.messages.map((m) => m.kind), ['back'])
  assert.deepEqual(evaluateRealized(q(1.05), d.state, { now: T0 + 6 * H }).messages, [])
  // The opening message, the gap and the return.
  const first = evaluateRealized(q(1.1), null, { now: T0 })
  assert.deepEqual(evaluateRealized(q(1.1), unsent(first.state, null, first.messages[0]), { now: T0 + H }).messages.map((m) => m.kind), ['open'])
  let s = start
  for (let i = 1; i <= 12; i++) s = evaluateRealized(q(null), s, { now: T0 + i * H }).state
  const down = evaluateRealized(q(null), s, { now: T0 + 13 * H })
  assert.deepEqual(down.messages.map((m) => m.kind), ['down'])
  const downKept = unsent(down.state, s, down.messages[0])
  const again = evaluateRealized(q(null), downKept, { now: T0 + 14 * H })
  assert.deepEqual(again.messages.map((m) => m.kind), ['down'])
  assert.deepEqual(evaluateRealized(q(null), again.state, { now: T0 + 15 * H }).messages, [])
  const up = evaluateRealized(q(1.1), again.state, { now: T0 + 15 * H })
  assert.deepEqual(up.messages.map((m) => m.kind), ['up'])
  const upAgain = evaluateRealized(q(1.1), unsent(up.state, again.state, up.messages[0]), { now: T0 + 16 * H })
  assert.deepEqual(upAgain.messages.map((m) => m.kind), ['up'])
  assert.deepEqual(evaluateRealized(q(1.1), upAgain.state, { now: T0 + 17 * H }).messages, [])
})

test('the opening message waits until both coins are judged; an unreadable state starts over', () => {
  const a = evaluateRealized(q(1.1, null), null, { now: T0 })
  assert.deepEqual(a.messages, [])
  const b = evaluateRealized(q(0.9, 0.9), a.state, { now: T0 + H })
  // BTC was recorded on the first run, so its crossing is told; the opening message comes with it.
  assert.deepEqual(b.messages.map((m) => m.kind), ['break', 'open'])
  for (const bad of ['x', [], 7]) assert.deepEqual(evaluateRealized(q(1.1), bad, { now: T0 }).messages.map((m) => m.kind), ['open'])
})

test('the realized price is Coin Metrics\' price over its MVRV, from the latest day with both', () => {
  const rows = [
    { asset: 'btc', time: '2026-11-14T00:00:00.000000000Z', PriceUSD: '63820.73', CapMVRVCur: '1.1878' },
    { asset: 'btc', time: '2026-11-15T00:00:00.000000000Z', PriceUSD: '65189.11', CapMVRVCur: '1.2144' },
    { asset: 'eth', time: '2026-11-14T00:00:00.000000000Z', PriceUSD: '1755.52', CapMVRVCur: '0.8369' },
    { asset: 'eth', time: '2026-11-15T00:00:00.000000000Z', PriceUSD: '1831.45', CapMVRVCur: null },
    { asset: 'sol', time: '2026-11-15T00:00:00.000000000Z', PriceUSD: '1', CapMVRVCur: '1' },
    { asset: 'btc', time: 'bad', PriceUSD: '1', CapMVRVCur: '1' },
  ]
  const r = realizedFrom(rows)
  assert.deepEqual(Object.keys(r), ['btc', 'eth'])
  assert.equal(r.btc.date, '2026-11-15')
  assert.ok(Math.abs(r.btc.rp - 65189.11 / 1.2144) < 1e-6)
  assert.equal(r.eth.date, '2026-11-14')
  assert.deepEqual(realizedFrom(null), {})
  // Kept and read: the later day of each; a broken kept value is dropped.
  const kept = { btc: { rp: 53000, date: '2026-11-16' }, eth: { rp: 'x', date: '2026-11-15' } }
  assert.deepEqual(latestRealized(kept, r), { btc: kept.btc, eth: r.eth })
  assert.deepEqual(latestRealized(undefined, {}), {})
  // Used up to RP_MAX_AGE after its day began.
  assert.equal(freshRealized({ date: '2026-11-14' }, Date.parse('2026-11-14T00:00:00Z') + RP_MAX_AGE), true)
  assert.equal(freshRealized({ date: '2026-11-14' }, Date.parse('2026-11-14T00:00:00Z') + RP_MAX_AGE + 1), false)
})

test('a Chainlink answer is read with 8 decimals, and a malformed one is not taken', () => {
  const word = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0')
  const hex = (answer, at) => '0x' + [1, answer, at - 30, at, 1].map(word).join('')
  assert.deepEqual(feedAnswer(hex(6527320240081, 1794847402)), { price: 65273.20240081, at: 1794847402000 })
  assert.equal(feedAnswer(hex(-1, 1794847402)), null)
  assert.equal(feedAnswer(hex(100, 0)), null)
  assert.equal(feedAnswer('0x'), null)
  assert.equal(feedAnswer(undefined), null)
})

test('each coin\'s levels start at the realized price itself and go down, each with what happened there', () => {
  for (const a of ['btc', 'eth']) {
    assert.equal(LEVELS[a][0].m, 1)
    LEVELS[a].forEach((l, i) => { assert.ok(l.note.length > 0); if (i) assert.ok(l.m < LEVELS[a][i - 1].m) })
  }
  assert.ok(DOWN_MS >= 6 * H)
})
