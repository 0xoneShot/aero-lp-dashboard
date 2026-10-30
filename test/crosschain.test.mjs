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
    [ev('0x3', 'base', 1000, 100, 'weth-base', -2n * E), ev('0x4', 'base', 1100, 150, 'weth-base', 2n * E)], // same chain
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
