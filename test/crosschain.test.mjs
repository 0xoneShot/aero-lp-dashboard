import test from 'node:test'
import assert from 'node:assert/strict'
import { matchCrossChain, MATCH_SECONDS } from '../lib/crosschain.mjs'
import { escrowByAsset } from '../lib/orders.mjs'

const E = 10n ** 18n
const canon = (a) => (a === 'ETH' || a === 'weth-base' || a === 'weth-eth' ? 'ETH' : a === 'usdc-eth' ? 'usdc-base' : a)
const dec = (a) => (a.startsWith('usdc') ? 6 : 18)
const ev = (hash, chain, ts, block, asset, amount) => ({ hash, chain, ts, block, legs: [{ asset, amount, cls: 'bridge' }] })

test('a bridge out of one tracked chain and into another is a move inside the strategy, held on the way', () => {
  const out = ev('0x1', 'base', 1000, 100, 'weth-base', -2n * E), arrive = ev('0x2', 'eth', 1300, 250, 'ETH', 2n * E - 3n * 10n ** 15n)
  const transit = matchCrossChain([arrive, out], canon, dec)
  assert.deepEqual([out.legs[0].cls, arrive.legs[0].cls], ['internal', 'internal'])
  assert.deepEqual([99, 100, 249, 250].map((b) => escrowByAsset(transit, b).get('ETH') ?? 0n), [0n, 2n * E, 2n * E, 0n])
})

test('what does not match stays money in or out', () => {
  const cases = [
    [ev('0x3', 'base', 1000, 100, 'weth-base', -2n * E), ev('0x4', 'base', 1000 + 15 * 60 + 1, 550, 'weth-base', 2n * E)], // same chain, later than a fill
    [ev('0x5', 'base', 1000, 100, 'weth-base', -2n * E), ev('0x6', 'eth', 1000 + MATCH_SECONDS + 1, 900, 'ETH', 2n * E)], // too late
    [ev('0x7', 'base', 1000, 100, 'weth-base', -2n * E), ev('0x8', 'eth', 1200, 200, 'usdc-eth', 5000n * 10n ** 6n)], // another coin
    [ev('0x9', 'base', 1000, 100, 'weth-base', -2n * E), ev('0xa', 'eth', 1200, 200, 'ETH', 19n * E / 10n)], // lost more than 3%
    [ev('0xb', 'eth', 1200, 200, 'ETH', 2n * E), ev('0xc', 'base', 1300, 300, 'weth-base', -2n * E)], // arrived before it left
  ]
  for (const evs of cases) {
    assert.deepEqual(matchCrossChain(evs, canon, dec), [])
    assert.ok(evs.every((e) => e.legs[0].cls === 'bridge'))
  }
  // Dollar tokens match their own kind on the other chain; each arrival matches one departure.
  const a = ev('0xd', 'eth', 1000, 100, 'usdc-eth', -5000n * 10n ** 6n), b = ev('0xe', 'base', 1100, 200, 'usdc-base', 4999n * 10n ** 6n), c = ev('0xf', 'eth', 1150, 210, 'usdc-eth', -5000n * 10n ** 6n)
  matchCrossChain([a, b, c], canon, dec)
  assert.deepEqual([a, b, c].map((e) => e.legs[0].cls), ['internal', 'internal', 'bridge'])
})

test('transfers in flight together pair with the closest arrival', () => {
  // Two departures of 2 and 1 ETH; the 1 ETH arrival comes first. First-fit would take it for the 2 ETH one.
  const a = ev('0x21', 'base', 1000, 100, 'weth-base', -2n * E), b = ev('0x22', 'base', 1010, 101, 'weth-base', -1n * E)
  const one = ev('0x23', 'eth', 1100, 200, 'ETH', E - 10n ** 15n), two = ev('0x24', 'eth', 1200, 210, 'ETH', 2n * E - 2n * 10n ** 15n)
  const transit = matchCrossChain([a, b, one, two], canon, dec)
  assert.deepEqual([a, b, one, two].map((e) => e.legs[0].cls), ['internal', 'internal', 'internal', 'internal'])
  const pair = (h) => transit.find((m) => m.hash === h)
  assert.equal(pair('0x24').amount, -2n * E)
  assert.equal(pair('0x23').amount, -1n * E)
  assert.equal(pair('0x24').received, 2n * E - 2n * 10n ** 15n)
})

test('a transfer pairs with its own arrival, not with a later one that lost less', () => {
  const out = ev('0x31', 'base', 1000, 100, 'weth-base', -1n * E)
  const real = ev('0x32', 'eth', 1300, 200, 'ETH', 99n * E / 100n), other = ev('0x33', 'eth', 8200, 900, 'ETH', 999n * E / 1000n)
  matchCrossChain([out, real, other], canon, dec)
  assert.deepEqual([out, real, other].map((e) => e.legs[0].cls), ['internal', 'internal', 'bridge'])
})

test('a bridge out and in on the same chain moments apart is one move (a Relay fill)', () => {
  const out = ev('0x41', 'base', 1000, 100, 'weth-base', -2n * E), fill = ev('0x42', 'base', 1002, 101, 'ETH', 2n * E)
  matchCrossChain([out, fill], canon, dec)
  assert.deepEqual([out, fill].map((e) => e.legs[0].cls), ['internal', 'internal'])
})

test('an arrival from a payer no rule knows pairs with a bridge out on another chain, never on the same one', () => {
  const stray = (hash, chain, ts, block, asset, amount, extra = {}) => ({ hash, chain, ts, block, review: true, legs: [{ asset, amount, cls: 'transfer', review: true, ...extra }] })
  const out = ev('0x31', 'base', 1000, 100, 'weth-base', -10n * E), arrive = stray('0x32', 'eth', 1200, 210, 'ETH', 10n * E - 6n * 10n ** 15n)
  matchCrossChain([out, arrive], canon, dec)
  assert.deepEqual([out.legs[0].cls, arrive.legs[0].cls, arrive.legs[0].review, arrive.review], ['internal', 'internal', false, false])
  // The same chain, a leg a person set by hand, or more than left: untouched.
  for (const [o, i] of [
    [ev('0x33', 'base', 1000, 100, 'weth-base', -10n * E), stray('0x34', 'base', 1200, 210, 'weth-base', 10n * E - 10n ** 16n)],
    [ev('0x35', 'base', 1000, 100, 'weth-base', -10n * E), stray('0x36', 'eth', 1200, 210, 'ETH', 10n * E - 10n ** 16n, { overridden: true })],
    [ev('0x37', 'base', 1000, 100, 'weth-base', -10n * E), stray('0x38', 'eth', 1200, 210, 'ETH', 11n * E)],
  ]) {
    assert.deepEqual(matchCrossChain([o, i], canon, dec), [])
    assert.deepEqual([o.legs[0].cls, i.legs[0].cls], ['bridge', 'transfer'])
  }
  // A bridge arrival is taken before an unknown payer's.
  const o2 = ev('0x39', 'base', 1000, 100, 'weth-base', -2n * E), s2 = stray('0x3a', 'eth', 1100, 200, 'ETH', 2n * E - 10n ** 15n), b2 = ev('0x3b', 'eth', 1150, 205, 'ETH', 2n * E - 2n * 10n ** 15n)
  matchCrossChain([o2, s2, b2], canon, dec)
  assert.deepEqual([o2, s2, b2].map((e) => e.legs[0].cls), ['internal', 'transfer', 'internal'])
})

test('a bridge out that has not arrived is held on its way for six hours, then is money out', () => {
  const out = ev('0x41', 'base', 1000, 100, 'weth-base', -2n * E)
  const t = matchCrossChain([out], canon, dec, { headTs: 1000 + 600 })
  assert.deepEqual([out.legs[0].cls, out.legs[0].pending], ['internal', true])
  assert.deepEqual([99, 100, 500].map((b) => escrowByAsset(t, b).get('ETH') ?? 0n), [0n, 2n * E, 2n * E])
  const late = ev('0x42', 'base', 1000, 100, 'weth-base', -2n * E)
  assert.deepEqual(matchCrossChain([late], canon, dec, { headTs: 1000 + MATCH_SECONDS + 1 }), [])
  assert.equal(late.legs[0].cls, 'bridge')
  // Once it arrives it is an ordinary matched move.
  const out3 = ev('0x43', 'base', 1000, 100, 'weth-base', -2n * E), in3 = ev('0x44', 'eth', 1300, 250, 'ETH', 2n * E - 10n ** 15n)
  matchCrossChain([out3, in3], canon, dec, { headTs: 1400 })
  assert.deepEqual([out3.legs[0].pending, out3.legs[0].cls, in3.legs[0].cls], [undefined, 'internal', 'internal'])
})

test('a cross-chain swap between different coins pairs by dollar value, held in the coin that left until arrival', () => {
  const prices = { aero: 0.5, ETH: 2000, 'usdc-base': 1, 'usdc-eth': 1 }
  const usd = (g) => (Math.abs(Number(g.amount)) / 10 ** dec(g.asset)) * prices[canon(g.asset)]
  // 500 AERO ($250) leaving Base -> 249.2 USDC arriving on Ethereum moments later.
  const out = ev('0x51', 'base', 1000, 100, 'aero', -500n * E), arrive = ev('0x52', 'eth', 1030, 115, 'usdc-eth', 249_200000n)
  const transit = matchCrossChain([out, arrive], canon, dec, { usd })
  assert.deepEqual([out.legs[0].cls, out.legs[0].crossSwap, arrive.legs[0].cls, arrive.legs[0].crossSwap], ['internal', true, 'internal', true])
  assert.deepEqual([99, 100, 114, 115].map((b) => escrowByAsset(transit, b).get('aero') ?? 0n), [0n, 500n * E, 500n * E, 0n])
  // The arrival transit entry carries the arrived asset and amount so the block check cancels in its own decimals.
  const arr = transit.find((m) => m.hash === '0x52')
  assert.deepEqual([arr.asset, arr.amount, arr.receivedAsset, arr.received], ['aero', -500n * E, 'usdc-eth', 249_200000n])

  // Too little (<97%), more than a little extra (>100.5%), or later than 30 minutes stays unmatched.
  for (const [got, ts] of [[242_000000n, 1030], [252_000000n, 1030], [249_000000n, 1000 + 30 * 60 + 1]]) {
    const o = ev('0x53', 'base', 1000, 100, 'aero', -500n * E), i = ev('0x54', 'eth', ts, 115, 'usdc-eth', got)
    assert.deepEqual(matchCrossChain([o, i], canon, dec, { usd }), [])
    assert.deepEqual([o.legs[0].cls, i.legs[0].cls], ['bridge', 'bridge'])
  }

  // Same-coin bridges pair before cross-coin swaps when both are in flight.
  const aOut = ev('0x55', 'base', 1000, 100, 'usdc-base', -250_000000n)
  const bOut = ev('0x56', 'base', 1005, 102, 'aero', -500n * E)
  const uIn1 = ev('0x57', 'eth', 1020, 110, 'usdc-eth', 249_500000n)
  const uIn2 = ev('0x58', 'eth', 1040, 120, 'usdc-eth', 249_000000n)
  matchCrossChain([aOut, bOut, uIn1, uIn2], canon, dec, { usd })
  assert.deepEqual([aOut, uIn1, bOut, uIn2].map((x) => [x.legs[0].cls, x.legs[0].crossSwap]), [['internal', false], ['internal', false], ['internal', true], ['internal', true]])

  // One end unknown (a solver paying the arrival, or an unknown router handing to a known bridge), never both unknown.
  const strayIn = { hash: '0x59', chain: 'eth', ts: 1030, block: 115, review: true, legs: [{ asset: 'usdc-eth', amount: 248_000000n, cls: 'transfer', review: true }] }
  const bOut2 = { ...ev('0x5a', 'base', 1000, 100, 'aero', -500n * E), bridge: 'LI.FI' }
  matchCrossChain([bOut2, strayIn], canon, dec, { usd })
  assert.deepEqual([bOut2.legs[0].cls, strayIn.legs[0].cls, strayIn.legs[0].review, strayIn.review, strayIn.legs[0].bridge], ['internal', 'internal', false, false, 'LI.FI'])

  const strayOut = { hash: '0x5b', chain: 'base', ts: 1000, block: 100, review: true, legs: [{ asset: 'aero', amount: -500n * E, cls: 'transfer', review: true }] }
  const bIn2 = { ...ev('0x5c', 'eth', 1030, 115, 'usdc-eth', 248_000000n), bridge: 'Relay' }
  matchCrossChain([strayOut, bIn2], canon, dec, { usd })
  assert.deepEqual([strayOut.legs[0].cls, strayOut.legs[0].review, strayOut.review, bIn2.legs[0].cls, strayOut.legs[0].bridge], ['internal', false, false, 'internal', 'Relay'])

  const unkOut = { hash: '0x5d', chain: 'base', ts: 1000, block: 100, review: true, legs: [{ asset: 'aero', amount: -500n * E, cls: 'transfer', review: true }] }
  const unkIn = { hash: '0x5e', chain: 'eth', ts: 1030, block: 115, review: true, legs: [{ asset: 'usdc-eth', amount: 249_000000n, cls: 'transfer', review: true }] }
  assert.deepEqual(matchCrossChain([unkOut, unkIn], canon, dec, { usd }), [])
  assert.deepEqual([unkOut.review, unkIn.review], [true, true])
})
