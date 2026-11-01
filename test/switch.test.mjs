import test from 'node:test'
import assert from 'node:assert/strict'
import { switchTo } from '../lib/switch.mjs'

// A pool card row: median and lower-quartile rates staked and unstaked, the same in both of its weeks.
// recentStaked / recentFee: the last 24 hours' rates (absent: not known, the median stands alone).
const row = (chain, label, staked, fee, { p25 = 0.85, days = 9, age = 0, weeks, recentStaked = null, recentFee = null } = {}) => ({
  chain, chain_label: { eth: '以太坊', arb: 'Arbitrum', base: 'Base' }[chain], label, pool_address: `${chain}:${label}`, days, age_h: age, stopped: false,
  staked: { median: staked, p25: staked * p25, recent: recentStaked }, fee: { median: fee, p25: fee * p25, recent: recentFee },
  weeks: weeks ?? ['2026-10-22', '2026-10-29'].map((start) => ({ start, hours: 100, staked, fee })),
})
const at = (chain, label, staked, usd) => ({ chain, pool: `${chain}:${label}`, staked, usd })
const run = (pools, positions, myUsd = 28900) => switchTo({ pools, positions, myUsd, gas: { base: { wei: 5e6, token: 'eth' }, eth: { wei: 2e8, token: 'eth' }, arb: { wei: 1e7, token: 'eth' } }, ethUsd: 2250, tracked: (c) => c === 'base' || c === 'eth' })
const name = (j) => j && `${j.to.chain}:${j.to.label}:${j.to.mode}`

test('a top option a few points ahead is a tie: staking where the money is suits better, and the alert names it too', () => {
  const pools = [row('arb', 'CL100', 1.63, 0.54), row('eth', 'CL50', 1.6, 0.58), row('base', 'CL100', 0.91, 0.78)]
  const sw = run(pools, [at('eth', 'CL50', false, 28800)])
  assert.equal(name(sw), 'arb:CL100:staked')
  assert.equal(name(sw.pick), 'eth:CL50:staked')
  assert.equal(name(sw.steady), 'eth:CL50:staked')
  assert.equal(sw.stay, false)
  assert.ok(sw.pick.cost_usd < 1 && sw.pick.extra_day_usd > 70)
})

test('money split between pools that are as good as the top stays put', () => {
  const pools = [row('arb', 'CL100', 1.8, 0.5), row('eth', 'CL50', 1.75, 0.6), row('base', 'CL100', 1.6, 0.7)]
  const sw = run(pools, [at('base', 'CL100', true, 28000), at('eth', 'CL50', true, 28000)], 56000)
  assert.equal(sw.stay, true)
  assert.equal(sw.steady, null)
  // Most of it in one pool and a little elsewhere: the same.
  const sw2 = run(pools, [at('base', 'CL100', true, 27900), at('base', 'CL100', false, 100)])
  assert.equal(sw2.stay, true)
})

test('a pool the money is in but that cannot be picked (data a day old) still counts for staying', () => {
  const pools = [row('arb', 'CL100', 1.5, 0.5), row('eth', 'CL50', 1.4, 0.6, { age: 30 }), row('base', 'CL100', 1.3, 0.7)]
  const sw = run(pools, [at('eth', 'CL50', true, 28800)])
  assert.equal(sw.stay, true)
})

test('when the pick meets every alert condition the alert names it, not another one further down', () => {
  // Arbitrum leads but has 5 days; Ethereum staked meets everything; Base staked meets everything too and
  // earns a little more over a week after costs, but it is not tied with the top.
  const pools = [row('arb', 'CL100', 2.0, 0.5, { days: 5 }), row('eth', 'CL50', 1.72, 0.6), row('base', 'CL100', 1.69, 0.6)]
  const sw = run(pools, [at('base', 'CL100', false, 28000)])
  assert.equal(name(sw.pick), 'eth:CL50:staked')
  assert.equal(name(sw.steady), 'eth:CL50:staked')
})

test('exactly 30 points below the top is not a tie: the card and the alert agree', () => {
  const pools = [row('eth', 'CL50', 1.0, 0.3), row('base', 'CL100', 0.7, 0.5)]
  const sw = run(pools, [at('base', 'CL100', true, 28800)])
  assert.equal(sw.stay, false)
  assert.equal(name(sw.pick), 'eth:CL50:staked')
  assert.ok(sw.pick.gap >= 0.3)
  assert.equal(name(sw.steady), 'eth:CL50:staked')
})

test('among tied options the dashboard tracks one first, then a week of earnings after costs', () => {
  const pools = [row('arb', 'CL100', 1.9, 0.5), row('eth', 'CL50', 1.85, 0.6), row('base', 'CL100', 1.0, 0.7)]
  const sw = run(pools, [at('base', 'CL100', true, 28800)])
  assert.equal(name(sw.pick), 'eth:CL50:staked')
  assert.equal(name(sw.steady), 'eth:CL50:staked')
})

test('with no position the money has only to go in; with a position in a pool not compared nothing is claimed', () => {
  const pools = [row('eth', 'CL50', 1.6, 0.58), row('base', 'CL100', 0.9, 0.78)]
  const idle = run(pools, [], 10000)
  assert.equal(name(idle.pick), 'eth:CL50:staked')
  assert.equal(idle.stay, false)
  assert.ok(idle.pick.cost_usd > 2) // a swap of half of it
  const odd = run(pools, [at('base', 'CL1', true, 28800)])
  assert.equal(odd.current, null)
  assert.equal(odd.pick.extra_day_usd, null)
  assert.equal(odd.steady, null)
})

test('an option is judged by the lower of its usual days and its last 24 hours: a fall shows at once, a spike does not', () => {
  // Liquidity piled into Ethereum CL50: staking fell from 160% to 62%, fees from 58% to 28%. The gain from
  // staking is what both agree on, not the usual days' 102 points.
  const pools = [row('eth', 'CL50', 1.6, 0.58, { recentStaked: 0.62, recentFee: 0.28 }), row('arb', 'CL100', 1.55, 0.48, { recentStaked: 0.7, recentFee: 0.3 }), row('base', 'CL100', 0.91, 0.78, { recentStaked: 0.3, recentFee: 0.2 })]
  const sw = run(pools, [at('eth', 'CL50', false, 28800)])
  assert.equal(name(sw), 'arb:CL100:staked') // the top by the lower rate
  assert.equal(name(sw.pick), 'eth:CL50:staked') // tied with it, and tracked
  assert.ok(Math.abs(sw.pick.gap - 0.34) < 1e-9 && Math.abs(sw.pick.extra_day_usd - 26.92) < 0.01, `${sw.pick.gap} ${sw.pick.extra_day_usd}`)
  assert.deepEqual([sw.pick.gap_usual, sw.pick.gap_now], [1.02, 0.34])
  assert.equal(sw.current_recent, 0.28)
  // A spike in another pool's last day does not lift it over where the money is.
  const spike = run([row('eth', 'CL50', 1.0, 0.5, { recentStaked: 5.0 }), row('base', 'CL100', 1.2, 0.7, { recentStaked: 1.1 })], [at('base', 'CL100', true, 28800)])
  assert.equal(spike.stay, true)
  assert.equal(name(spike.pick), 'base:CL100:staked')
})

test('the option holding most of the money is preferred only if moving the rest there loses nothing', () => {
  // Two wallets together: most of the money unstaked in Ethereum CL50 (58% usual, 53% now), the rest staked
  // in Base CL100 (105%, 37%). Staking in Ethereum CL50 is tied with the top; leaving everything unstaked
  // there, though it holds most of the money, would earn less than now.
  const pools = [row('eth', 'CL50', 1.56, 0.56, { recentStaked: 0.65, recentFee: 0.53 }), row('arb', 'CL100', 1.48, 0.45, { recentStaked: 0.81, recentFee: 0.14 }), row('base', 'CL100', 1.05, 0.8, { recentStaked: 0.37, recentFee: 0.2 })]
  const sw = run(pools, [at('eth', 'CL50', false, 29000), at('base', 'CL100', true, 15000)], 51500)
  assert.equal(sw.stay, false)
  assert.equal(name(sw.pick), 'eth:CL50:staked')
  assert.ok(sw.pick.gap > 0)
})
