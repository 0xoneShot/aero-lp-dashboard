// Hand-made transactions for situations the real history has not hit yet.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLedger, owedPrincipal } from '../lib/ledger.mjs'
import { TOPIC } from '../lib/abi.mjs'
import { USDC, WETH, AERO, ZERO } from '../lib/config.mjs'

// Two made-up wallets; the real ones are never named in the code.
const WA = '0x00000000000000000000000000000000000000a1'
const WB = '0x00000000000000000000000000000000000000b2'
const WALLETS = [{ key: 'a', label: 'A', address: WA }, { key: 'b', label: 'B', address: WB }]
const NPM = '0x4857db576ee0e45f10525ec59527bfd10beec60b'
const GAUGE = '0x14018f5afaeca44bb49d5036267d836723b57c91'
const FAKE = '0x000000000000000000000000000000000000dead'
const EOA = '0x00000000000000000000000000000000000000e0'
const POOL = '0x2a430bebd2082d8e05d56d64dede8944279bbc24'

const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0')
const num = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0')
const words = (...xs) => '0x' + xs.map((x) => (typeof x === 'string' ? pad(x) : num(x)).slice(2)).join('')
const transfer = (token, from, to, amt) => ({ address: token, topics: [TOPIC.Transfer, pad(from), pad(to)], data: num(amt) })
const nft = (from, to, id) => ({ address: NPM, topics: [TOPIC.Transfer, pad(from), pad(to), num(id)], data: '0x' })
const increase = (id, liq, a0, a1) => ({ address: NPM, topics: [TOPIC.IncreaseLiquidityV3, num(id)], data: words(liq, a0, a1, 0, 0) })
const decrease = (id, liq, a0, a1) => ({ address: NPM, topics: [TOPIC.DecreaseLiquidity, num(id)], data: words(liq, a0, a1) })
const collect = (id, to, a0, a1) => ({ address: NPM, topics: [TOPIC.Collect, num(id)], data: words(to, a0, a1) })
const claim = (gauge, account, id, recipient, amt) => ({ address: gauge, topics: [TOPIC.EmissionsClaimed, pad(account), num(id), pad(recipient)], data: num(amt) })
const deferredClaim = (account, recipient, amt) => ({ address: GAUGE, topics: [TOPIC.DeferredEmissionsClaimed, pad(account), pad(recipient)], data: num(amt) })
const deposit = (gauge, user, id) => ({ address: gauge, topics: [TOPIC.GaugeDeposit, pad(EOA), pad(user), num(id)], data: num(1) })

function ledgerOf(txs, { eoas = [], overrides = {} } = {}) {
  const state = {
    wallets: { a: { openingBlock: 0, openingEth: '0' }, b: { openingBlock: 0, openingEth: '0' } },
    txs: Object.fromEntries(txs.map((t, i) => [t.hash, { block: t.block ?? 100 + i, index: 0, ts: 0, from: t.from ?? EOA, to: t.to ?? EOA, selector: '0x12345678', value: '0', status: 'success', gasCost: '0', eth: {}, ...t, logs: t.logs.map((l, j) => ({ ...l, logIndex: j })) }])),
  }
  const eoa = new Set(eoas)
  return buildLedger(state, (a) => (eoa.has(a) ? 'eoa' : 'contract'), { gaugeOk: (a) => a === GAUGE, overrides, wallets: WALLETS })
}
const legsOf = (L, k, hash) => L[k].events.find((e) => e.hash === hash)?.legs.map((g) => `${g.asset === 'ETH' ? 'ETH' : g.asset.slice(0, 6)}:${g.amount}:${g.cls}${g.review ? ':review' : ''}`) ?? []

test('principal removed in one transaction and collected in a later one is not a fee', () => {
  const L = ledgerOf([
    { hash: '0x01', from: WB, logs: [nft(ZERO, WB, 7), increase(7, 1000, 10n ** 18n, 2000_000000n)] },
    { hash: '0x02', from: WB, logs: [decrease(7, 1000, 10n ** 18n, 2000_000000n)] },
    { hash: '0x03', from: WB, logs: [collect(7, WB, 10n ** 18n + 5n, 2000_000000n + 3_000000n), transfer(WETH, POOL, WB, 10n ** 18n + 5n), transfer(USDC, POOL, WB, 2003_000000n)] },
  ])
  const fees = L.b.events.flatMap((e) => e.fees)
  assert.deepEqual(fees.map((f) => [f.amount0, f.amount1]), [[5n, 3_000000n]])
  assert.deepEqual(owedPrincipal(L.owedAt, NPM, '7', 101), { block: 101, owed0: 10n ** 18n, owed1: 2000_000000n })
  assert.equal(owedPrincipal(L.owedAt, NPM, '7', 102).owed0, 0n)
})

test('a position moved between the wallets is a transfer between them, and later fees belong to the new owner', () => {
  const L = ledgerOf([
    { hash: '0x11', from: WA, logs: [nft(ZERO, WA, 8), increase(8, 1000, 1n, 1n)] },
    { hash: '0x12', from: WA, logs: [nft(WA, WB, 8)] },
    { hash: '0x13', from: WB, logs: [collect(8, WB, 0n, 25_000000n), transfer(USDC, POOL, WB, 25_000000n)] },
  ])
  assert.deepEqual(L.a.events.find((e) => e.hash === '0x12').nftMoves.map((m) => [m.dir, m.cls]), [['out', 'between']])
  assert.deepEqual(L.b.events.find((e) => e.hash === '0x12').nftMoves.map((m) => [m.dir, m.cls]), [['in', 'between']])
  assert.equal(L.a.events.flatMap((e) => e.fees).length, 0)
  assert.deepEqual(L.b.events.flatMap((e) => e.fees).map((f) => f.amount1), [25_000000n])
})

test('a reward event without the AERO actually paid is ignored', () => {
  const L = ledgerOf([{ hash: '0x21', logs: [claim(GAUGE, WA, 1, WA, 10n ** 30n)] }])
  assert.equal(L.a.events.flatMap((e) => e.rewards).length, 0)
  assert.equal(L.a.warnings.length, 1)
})

test('reward events from a contract that is not a gauge are ignored', () => {
  const L = ledgerOf([{ hash: '0x22', logs: [claim(FAKE, WA, 1, WA, 5n), transfer(AERO, ZERO, WA, 5n)] }])
  assert.equal(L.a.events.flatMap((e) => e.rewards).length, 0)
})

test('deferred rewards paid later count as claimed', () => {
  const L = ledgerOf([{ hash: '0x23', from: WA, logs: [deferredClaim(WA, WA, 40n * 10n ** 18n), transfer(AERO, ZERO, WA, 40n * 10n ** 18n)] }])
  assert.deepEqual(L.a.events[0].rewards.map((r) => r.amount), [40n * 10n ** 18n])
  assert.deepEqual(legsOf(L, 'a', '0x23'), [`0x3f5b:${40n * 10n ** 18n}:reward`])
})

test('a reward claimed to the other wallet is earned by the claimer and moved between them', () => {
  const A = 7n * 10n ** 18n
  const L = ledgerOf([{ hash: '0x24', from: WA, logs: [claim(GAUGE, WA, 1, WB, A), transfer(AERO, ZERO, WB, A)] }])
  assert.deepEqual(L.a.events[0].rewards.map((r) => r.amount), [A])
  assert.deepEqual(legsOf(L, 'a', '0x24'), [`0x3f5b:${-A}:between`])
  assert.deepEqual(legsOf(L, 'b', '0x24'), [`0x3f5b:${A}:between`])
})

test('a fake gauge cannot add a position', () => {
  const L = ledgerOf([{ hash: '0x31', logs: [nft(EOA, FAKE, 999), deposit(FAKE, WA, 999)] }])
  assert.equal(L.a.positions.length, 0)
})

test('money in from an unknown contract counts as money in and is flagged', () => {
  const L = ledgerOf([{ hash: '0x41', logs: [transfer(USDC, FAKE, WB, 10_000_000000n)] }])
  assert.deepEqual(legsOf(L, 'b', '0x41'), ['0x8335:10000000000:transfer:review'])
  assert.equal(L.b.events[0].review, true)
})

test('money from an exchange account is money in; a swap with a market maker is not', () => {
  const L = ledgerOf([
    { hash: '0x42', logs: [transfer(USDC, EOA, WB, 1500_000000n)] },
    { hash: '0x43', from: WB, logs: [transfer(WETH, WB, EOA, 10n ** 18n), transfer(USDC, EOA, WB, 2300_000000n)] },
  ], { eoas: [EOA] })
  assert.deepEqual(legsOf(L, 'b', '0x42'), ['0x8335:1500000000:transfer'])
  assert.deepEqual(legsOf(L, 'b', '0x43'), [`0x4200:${-(10n ** 18n)}:internal`, '0x8335:2300000000:internal'])
})

test('a one-way transfer through a known router is a move inside the strategy', () => {
  const L = ledgerOf([{ hash: '0x44', from: WA, logs: [transfer(USDC, '0x2ad5004c60e16e54d5007c80ce329adde5b51ef5', WA, 10664_683864n)] }])
  assert.deepEqual(legsOf(L, 'a', '0x44'), ['0x8335:10664683864:internal'])
})

test('a hand correction overrides the rules', () => {
  const L = ledgerOf([{ hash: '0x45', logs: [transfer(USDC, FAKE, WB, 5n)] }], { overrides: { '0x45': { b: 'internal' } } })
  assert.deepEqual(legsOf(L, 'b', '0x45'), ['0x8335:5:internal'])
})

test('native ETH legs: a tagged send to a wallet with no code names the sender', () => {
  const L = ledgerOf([{ hash: '0x51', from: EOA, to: WB, eth: { [WB]: { delta: '2000000000000000000', legs: [{ cp: EOA, value: '2000000000000000000' }] } }, logs: [] }], { eoas: [EOA] })
  assert.deepEqual(legsOf(L, 'b', '0x51'), ['ETH:2000000000000000000:transfer'])
})

import { assignEth } from '../lib/scan.mjs'

test('ETH split: a tagged send to an account with no code needs no trace', async () => {
  const rec = { hash: '0x61', block: 1, from: EOA, to: WB, selector: '0x7a290ba4', value: '2000', status: 'success', gasCost: '0', eth: {} }
  await assignEth([rec], WB, 2000n, false)
  assert.deepEqual(rec.eth[WB], { delta: '2000', legs: [{ cp: EOA, value: '2000' }] })
})

test('ETH split: a reverted own transaction only pays gas', async () => {
  const rec = { hash: '0x62', block: 1, from: WB, to: POOL, selector: '0x12345678', value: '500', status: 'reverted', gasCost: '7', eth: {} }
  await assignEth([rec], WB, -7n, false)
  assert.deepEqual(rec.eth[WB], { delta: '-7', legs: [] })
})
