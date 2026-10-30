// Hand-made transactions for situations the real history has not hit yet.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLedger, owedPrincipal, positionsAt, gaugesAt } from '../lib/ledger.mjs'
import { escrowAt, cowOrder } from '../lib/orders.mjs'
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

test('a position first seen arriving from outside is money in; one returned by a gauge or sent by the other wallet is not', () => {
  const L = ledgerOf([
    { hash: '0x21', logs: [nft(EOA, WA, 31)] }, // minted before the scanned history, by someone else
    { hash: '0x22', from: WA, logs: [nft(GAUGE, WA, 32)] }, // the wallet's own position, unstaked
    { hash: '0x23', from: WB, logs: [nft(WB, WA, 33)] }, // from the other wallet
    { hash: '0x24', from: WA, logs: [nft(WA, EOA, 31)] },
  ])
  const moves = (k, h) => L[k].events.find((e) => e.hash === h)?.nftMoves.map((m) => [m.dir, m.cls, m.cp]) ?? []
  assert.deepEqual(moves('a', '0x21'), [['in', 'transfer', EOA]])
  assert.deepEqual(moves('a', '0x22'), [])
  assert.deepEqual(moves('a', '0x23'), [['in', 'between', WB]])
  assert.deepEqual(moves('b', '0x23'), [['out', 'between', WA]])
  assert.deepEqual(moves('a', '0x24'), [['out', 'transfer', EOA]])
})

test('an outsider collecting and then sending a position in one transaction: money in, and the collect is not our fee', () => {
  const L = ledgerOf([
    { hash: '0x26', logs: [collect(34, EOA, 5n, 7n), nft(EOA, WA, 34)] },
    { hash: '0x27', from: WA, logs: [collect(34, WA, 0n, 9_000000n), transfer(USDC, POOL, WA, 9_000000n)] },
  ])
  assert.deepEqual(L.a.events.find((e) => e.hash === '0x26').nftMoves.map((m) => [m.dir, m.cls]), [['in', 'transfer']])
  assert.deepEqual(L.a.events.flatMap((e) => e.fees).map((f) => [f.amount0, f.amount1]), [[0n, 9_000000n]])
})

test('unpriced tokens: an order filled by a settlement contract counts, airdrop spam and fake sends do not', () => {
  const NV = '0xb20000000000000000000078ee7ce2fe4908108c', SPAM = '0x00000000000000000000000000000000000005aa'
  const SETTLE = '0x2ad5004c60e16e54d5007c80ce329adde5b51ef5' // 1inch settlement, in STRATEGY
  const L = ledgerOf([
    { hash: '0x31', logs: [transfer(NV, SETTLE, WA, 25n * 10n ** 8n)] }, // someone else's transaction fills WA's order
    { hash: '0x32', logs: [transfer(SPAM, FAKE, WA, 10n ** 21n)] },
    { hash: '0x33', logs: [transfer(SPAM, WA, FAKE, 10n ** 21n)] }, // a fake "sent from you"
  ])
  assert.deepEqual(L.a.unpriced, [NV])
  assert.deepEqual(L.a.warnings.map((w) => w.hash), ['0x31'])
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

// Native-ETH limit orders: the ETH sits in a contract made for the order until a fill or a refund.
const FACTORY = '0xe12e0f117d23a5ccc57f8935cd8c4e80cd91ff01'
const ORDER = '0x00000000000000000000000000000000000c1013'
const RESOLVER = '0x00000000000000000000000000000000000ad3b6'
const TAKER = '0x0000000000000000000000000000000000007a4e'
const SETTLEMENT = '0x2ad5004c60e16e54d5007c80ce329adde5b51ef5'
const ETH2 = 2n * 10n ** 18n
const ethLeg = (w, cp, v) => ({ [w]: { delta: v.toString(), legs: [{ cp, value: v.toString() }] } })
const wethDeposit = (dst, amt) => ({ address: WETH, topics: [TOPIC.WethDeposit, pad(dst)], data: num(amt) })
const wethWithdrawal = (src, amt) => ({ address: WETH, topics: [TOPIC.WethWithdrawal, pad(src)], data: num(amt) })
const orderCreated = (factory, maker, order, amt) => ({ address: factory, topics: [TOPIC.NativeOrderCreated], data: words(maker, 0xabcn, order, amt) })
const createOrder = (hash, factory = FACTORY, maker = WA) => ({ hash, from: WA, to: factory, eth: ethLeg(WA, factory, -ETH2), logs: [wethDeposit(ORDER, ETH2), orderCreated(factory, maker, ORDER, ETH2)] })

test('a native-ETH order filled later: both sides are moves inside the strategy, and the ETH waiting counts as held', () => {
  const L = ledgerOf([
    createOrder('0x71'),
    { hash: '0x72', from: EOA, to: SETTLEMENT, logs: [transfer(WETH, ORDER, TAKER, ETH2), transfer(USDC, SETTLEMENT, WA, 5000_000000n)] },
  ])
  assert.deepEqual(legsOf(L, 'a', '0x71'), [`ETH:${-ETH2}:internal`])
  assert.deepEqual(legsOf(L, 'a', '0x72'), ['0x8335:5000000000:internal'])
  assert.equal(escrowAt(L.a.escrow, 99), 0n)
  assert.equal(escrowAt(L.a.escrow, 100), ETH2)
  assert.equal(escrowAt(L.a.escrow, 101), 0n)
  assert.deepEqual(L.b.escrow, [])
})

test('a native-ETH order refunded by a resolver or cancelled by the wallet: the ETH coming back is not money in', () => {
  const L = ledgerOf([
    createOrder('0x73'),
    { hash: '0x74', from: EOA, to: RESOLVER, eth: ethLeg(WA, RESOLVER, ETH2 - 10n ** 15n), logs: [wethWithdrawal(ORDER, ETH2)] },
  ])
  assert.deepEqual(legsOf(L, 'a', '0x74'), [`ETH:${ETH2 - 10n ** 15n}:internal`])
  assert.equal(escrowAt(L.a.escrow, 101), 0n)
  const M = ledgerOf([createOrder('0x75'), { hash: '0x76', from: WA, to: ORDER, eth: ethLeg(WA, ORDER, ETH2), logs: [wethWithdrawal(ORDER, ETH2)] }])
  assert.deepEqual(legsOf(M, 'a', '0x76'), [`ETH:${ETH2}:internal`])
})

test('an order contract counts only from the real factory and for its maker', () => {
  for (const tx of [createOrder('0x77', FAKE), createOrder('0x77', FACTORY, WB)]) {
    const L = ledgerOf([tx, { hash: '0x78', from: EOA, to: RESOLVER, eth: ethLeg(WA, RESOLVER, ETH2), logs: [wethWithdrawal(ORDER, ETH2)] }])
    assert.deepEqual(legsOf(L, 'a', '0x78'), [`ETH:${ETH2}:transfer:review`])
    assert.equal(escrowAt(L.a.escrow, 100), 0n)
  }
})

test('a CoW order of native ETH and its fill are moves inside the strategy', () => {
  const ETHFLOW = '0xba3cb449bd2b4adddbc894d8697f5170800eadec', GPV2 = '0x9008d19f58aabd9ed0d60971565aa8510560ab41'
  const L = ledgerOf([
    { hash: '0x79', from: WA, to: ETHFLOW, eth: ethLeg(WA, ETHFLOW, -ETH2), logs: [] },
    { hash: '0x7a', from: EOA, to: GPV2, logs: [transfer(USDC, GPV2, WA, 5000_000000n)] },
    { hash: '0x7b', from: EOA, to: ETHFLOW, eth: ethLeg(WA, ETHFLOW, ETH2), logs: [] },
  ])
  assert.deepEqual(['0x79', '0x7a', '0x7b'].map((h) => legsOf(L, 'a', h)), [[`ETH:${-ETH2}:internal`], ['0x8335:5000000000:internal'], [`ETH:${ETH2}:internal`]])
})

test('a position is read for the blocks it exists in, with the gauges it could be in by then', () => {
  const L = ledgerOf([
    { hash: '0x81', block: 100, from: WA, logs: [nft(ZERO, WA, 9), increase(9, 1000, 1n, 1n)] },
    { hash: '0x82', block: 102, from: WA, logs: [nft(WA, GAUGE, 9), deposit(GAUGE, WA, 9)] },
    { hash: '0x83', block: 105, from: WA, logs: [nft(GAUGE, WA, 9), decrease(9, 1000, 1n, 1n), collect(9, WA, 1n, 1n), nft(WA, ZERO, 9)] },
    // Already staked before the scan: handed back by the gauge, so read from the start.
    { hash: '0x84', block: 103, from: WB, logs: [nft(GAUGE, WB, 10)] },
    // Bought from an outsider: nobody's here before it arrived.
    { hash: '0x85', block: 104, from: EOA, logs: [nft(EOA, WB, 11)] },
  ])
  const ids = (k, b) => positionsAt(L[k].positions, b).map((p) => `${p.tokenId}:${p.gauges.length}`)
  assert.deepEqual([99, 100, 101, 102, 104, 105].map((b) => ids('a', b)), [[], ['9:0'], ['9:0'], ['9:1'], ['9:1'], []])
  assert.deepEqual([50, 103, 104].map((b) => ids('b', b)), [['10:1'], ['10:1'], ['10:1', '11:0']])
})

test('a native-ETH order filled by a resolver that pays the wallet itself: the proceeds are not money in', () => {
  const L = ledgerOf([
    createOrder('0x91'),
    { hash: '0x92', from: EOA, to: RESOLVER, logs: [transfer(WETH, ORDER, RESOLVER, ETH2), transfer(USDC, RESOLVER, WA, 5000_000000n)] },
  ])
  assert.deepEqual(legsOf(L, 'a', '0x92'), ['0x8335:5000000000:internal'])
  assert.equal(escrowAt(L.a.escrow, 101), 0n)
})

test('a native-ETH order paid out to someone else is money leaving: a bridge for a cross-chain order, flagged otherwise', () => {
  const ESCROW = '0x00000000000000000000000000000000000e5c01', XFACTORY = '0x03a25b3215a0e5c15cf23ac4d2e5cf86c0ff7efa'
  const cross = { address: XFACTORY, topics: ['0x1140dcf80f027f65ebd1c2e98c33e3ebf7ef025d944a079256037cd55271bf98'], data: words(WA) }
  const L = ledgerOf([createOrder('0x93'), { hash: '0x94', from: EOA, to: RESOLVER, logs: [transfer(WETH, ORDER, ESCROW, ETH2), cross] }])
  assert.deepEqual(legsOf(L, 'a', '0x94'), [`0x4200:${-ETH2}:bridge`])
  assert.equal(escrowAt(L.a.escrow, 101), 0n)
  const M = ledgerOf([createOrder('0x95'), { hash: '0x96', from: EOA, to: RESOLVER, logs: [transfer(WETH, ORDER, ESCROW, ETH2)] }])
  assert.deepEqual(legsOf(M, 'a', '0x96'), [`0x4200:${-ETH2}:transfer:review`])
})

test('a token without a price bought by a native-ETH order is reported, not taken for spam', () => {
  const ODD = '0x00000000000000000000000000000000000000dd'
  const L = ledgerOf([createOrder('0x97'), { hash: '0x98', from: EOA, to: RESOLVER, logs: [transfer(WETH, ORDER, RESOLVER, ETH2), transfer(ODD, RESOLVER, WA, 7n)] }])
  assert.deepEqual(L.a.unpriced, [ODD])
  assert.equal(L.a.warnings.filter((w) => w.kind === 'unpriced').length, 1)
})

// A CoW order of native ETH: placed with EthFlow, filled (or refunded) by others, followed by its id.
const ETHFLOW = '0xba3cb449bd2b4adddbc894d8697f5170800eadec', GPV2 = '0x9008d19f58aabd9ed0d60971565aa8510560ab41'
const SELL = '0xf3b277728b3fee749481eb3e0b3b48980dbbab78658fc419025cb16eee346775', ERC20 = '0x5a28e9363bb942b639270062aa6bb295f434bcdfc42c97267bf003f272060dc9'
const placement = { address: ETHFLOW, topics: [TOPIC.CowOrderPlacement, pad(WA)], data: words(WETH, USDC, WA, ETH2, 5000_000000n, 0xffffffffn, 0n, 0n, SELL, 0n, ERC20, ERC20) }
const uidBytes = (uid) => (uid.slice(2) + '0'.repeat(128 - (uid.length - 2)))
const cowTrade = (uid, sold) => ({ address: GPV2, topics: [TOPIC.CowTrade, pad(ETHFLOW)], data: words(WETH, USDC, sold, 1n, 0n, 0xc0n, 56n) + uidBytes(uid) })
const cowRefund = (uid) => ({ address: ETHFLOW, topics: [TOPIC.CowOrderRefund, pad(EOA)], data: words(0x20n, 56n) + uidBytes(uid) })

test('a CoW order of native ETH counts as held until it is filled or refunded', () => {
  const { uid, amount } = cowOrder(placement)
  assert.equal(amount, ETH2)
  assert.equal(uid.length, 2 + 112)
  const L = ledgerOf([
    { hash: '0xa1', from: WA, to: ETHFLOW, eth: ethLeg(WA, ETHFLOW, -ETH2), logs: [placement] },
    { hash: '0xa2', from: EOA, to: GPV2, logs: [cowTrade(uid, ETH2 / 2n), transfer(USDC, GPV2, WA, 2500_000000n)] },
    { hash: '0xa3', from: EOA, to: ETHFLOW, eth: ethLeg(WA, ETHFLOW, ETH2 / 2n), logs: [cowRefund(uid)] },
  ])
  assert.deepEqual([99, 100, 101, 102].map((b) => escrowAt(L.a.escrow, b)), [0n, ETH2, ETH2 / 2n, 0n])
  assert.deepEqual(['0xa1', '0xa2', '0xa3'].map((h) => legsOf(L, 'a', h)), [[`ETH:${-ETH2}:internal`], ['0x8335:2500000000:internal'], [`ETH:${ETH2 / 2n}:internal`]])
  // Someone else's order with the same EthFlow is not the wallet's.
  const other = { ...placement, topics: [TOPIC.CowOrderPlacement, pad(EOA)] }
  assert.deepEqual(ledgerOf([{ hash: '0xa4', from: EOA, to: ETHFLOW, logs: [other] }]).a.escrow, [])
})

test('the gauges a wallet\'s positions had joined stay listed after the positions are burned', () => {
  const L = ledgerOf([
    { hash: '0xb1', block: 100, from: WA, logs: [nft(ZERO, WA, 12), increase(12, 1000, 1n, 1n)] },
    { hash: '0xb2', block: 101, from: WA, logs: [nft(WA, GAUGE, 12), deposit(GAUGE, WA, 12)] },
    { hash: '0xb3', block: 102, from: WA, logs: [nft(GAUGE, WA, 12), decrease(12, 1000, 1n, 1n), collect(12, WA, 1n, 1n), nft(WA, ZERO, 12)] },
  ])
  assert.deepEqual([100, 101, 102, 200].map((b) => gaugesAt(L.a.positions, b)), [[], [GAUGE], [GAUGE], [GAUGE]])
  assert.deepEqual(positionsAt(L.a.positions, 102), [])
})
