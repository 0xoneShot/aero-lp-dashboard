import test from 'node:test'
import assert from 'node:assert/strict'
import { hodlHeld } from '../lib/hodl.mjs'

const E = 10n ** 18n, U = 10n ** 6n
const key = (a) => (a === 'WETH' ? 'ETH' : a)
const value = (k, raw, p) => (k === 'ETH' ? (Number(raw) / 1e18) * p.eth : k === 'USDC' ? Number(raw) / 1e6 : null)
const held = (flows) => Object.fromEntries(hodlHeld(flows, key, value))

test('money taken out of a coin that was put in comes out of that coin', () => {
  // 1 ETH in at $2,000; 0.5 ETH out at $3,000: what was just held is the other 0.5 ETH, whatever ETH does later.
  assert.deepEqual(held([
    { asset: 'ETH', amount: E, usd: 2000, prices: { eth: 2000 } },
    { asset: 'WETH', amount: -E / 2n, usd: -1500, prices: { eth: 3000 } },
  ]), { ETH: E / 2n })
})

test('money taken out in a coin that was not held comes out of everything held, pro rata', () => {
  // 1 ETH ($3,000) and 1,000 USDC held when $400 of something else goes out: keep 1 - 400/4000 of each.
  const h = held([
    { asset: 'ETH', amount: E, usd: 2000, prices: { eth: 2000 } },
    { asset: 'USDC', amount: 1000n * U, usd: 1000, prices: { eth: 2000 } },
    { asset: 'AERO', amount: -500n * E, usd: -400, prices: { eth: 3000 } },
  ])
  assert.equal(h.ETH, (E * 9n) / 10n)
  assert.equal(h.USDC, 900n * U)
})

test('taking out more than is held empties the holdings and goes no further', () => {
  const h = held([
    { asset: 'USDC', amount: 100n * U, usd: 100, prices: { eth: 2000 } },
    { asset: 'USDC', amount: -300n * U, usd: -300, prices: { eth: 2000 } },
    { asset: 'ETH', amount: E, usd: 2000, prices: { eth: 2000 } },
  ])
  assert.deepEqual(h, { USDC: 0n, ETH: E })
})
