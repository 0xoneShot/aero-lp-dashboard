// Native-ETH limit orders. Selling native ETH through a limit order parks the ETH in a contract until
// the order is filled, or cancelled or expired and refunded; meanwhile it is still the wallet's money.
//  - 1inch: the ETH goes to a factory (lib/config.mjs ORDER_FACTORIES), which wraps it into WETH held
//    by a contract made for that one order. Fills take the WETH from there; a cancel or an expiry
//    unwraps what is left and sends it back. Each order contract is known from the factory's event
//    naming a wallet as maker, and followed through WETH logs.
//  - CoW: EthFlow keeps every order's ETH. Its OrderPlacement event names the wallet and the order; the
//    order's id (its EIP-712 digest, EthFlow and the validity) is what the settlement's Trade events and
//    EthFlow's refund events carry.
// lib/scan.mjs keeps WETH logs, EthFlow's events and the settlement's EthFlow trades in every scanned
// transaction, fetches every transaction that moves WETH into or out of a known 1inch order contract,
// and the fills of CoW orders paying another receiver, so fills and refunds sent by someone else are
// seen too.
import { hashTypedData, keccak256, toHex } from 'viem'
import { TOPIC } from './abi.mjs'
import { CHAINS } from './config.mjs'

const topicAddr = (t) => '0x' + t.slice(26).toLowerCase()
const word = (data, i) => '0x' + data.slice(2 + 64 * i, 2 + 64 * (i + 1))

// Every function works on one chain's transactions (lib/config.mjs CHAINS; Base by default).

// 1inch order contracts made for the wallets: order contract -> maker.
export function nativeOrderContracts(txs, walletAddrs, chain = CHAINS.base) {
  const owner = new Map()
  for (const rec of txs) {
    for (const l of rec.logs) {
      if (chain.orderFactories[l.address] && l.topics[0] === TOPIC.NativeOrderCreated && l.data.length >= 2 + 64 * 3) {
        const maker = topicAddr(word(l.data, 0)), order = topicAddr(word(l.data, 2))
        if (walletAddrs.has(maker)) owner.set(order, maker)
      }
    }
  }
  return owner
}

const COW_NAMES = Object.fromEntries(['sell', 'buy', 'erc20', 'external', 'internal'].map((s) => [keccak256(toHex(s)), s]))
const COW_ORDER = [['sellToken', 'address'], ['buyToken', 'address'], ['receiver', 'address'], ['sellAmount', 'uint256'], ['buyAmount', 'uint256'],
  ['validTo', 'uint32'], ['appData', 'bytes32'], ['feeAmount', 'uint256'], ['kind', 'string'], ['partiallyFillable', 'bool'],
  ['sellTokenBalance', 'string'], ['buyTokenBalance', 'string']].map(([name, type]) => ({ name, type }))

// The id of the order an EthFlow OrderPlacement event placed, and the ETH it holds.
export function cowOrder(l, chain = CHAINS.base) {
  const w = (i) => word(l.data, i), a = (i) => topicAddr(w(i))
  const message = {
    sellToken: a(0), buyToken: a(1), receiver: a(2), sellAmount: BigInt(w(3)), buyAmount: BigInt(w(4)), validTo: Number(BigInt(w(5))),
    appData: w(6), feeAmount: BigInt(w(7)), kind: COW_NAMES[w(8)], partiallyFillable: BigInt(w(9)) === 1n,
    sellTokenBalance: COW_NAMES[w(10)], buyTokenBalance: COW_NAMES[w(11)],
  }
  if (!message.kind || !message.sellTokenBalance || !message.buyTokenBalance) return null
  const digest = hashTypedData({ domain: { name: 'Gnosis Protocol', version: 'v2', chainId: chain.id, verifyingContract: chain.cowSettlement }, types: { Order: COW_ORDER }, primaryType: 'Order', message })
  return { uid: (digest + l.address.slice(2) + message.validTo.toString(16).padStart(8, '0')).toLowerCase(), amount: message.sellAmount + message.feeAmount, receiver: message.receiver }
}

// A `bytes` argument of an event whose offset word is the `at`-th.
function bytesArg(data, at) {
  const off = 2 + Number(BigInt(word(data, at))) * 2
  const len = Number(BigInt('0x' + data.slice(off, off + 64)))
  return ('0x' + data.slice(off + 64, off + 64 + len * 2)).toLowerCase()
}

// For the transactions in order: per wallet, the WETH moved into (+) or out of (-) its open orders;
// the transactions in which one of its orders paid out (a fill or a refund, whoever sent it); what an
// order paid to someone else than an order contract or the wallet (a 1inch order's WETH, or a CoW fill
// for another receiver: matched by what the wallet got back in the same transaction, if anything); and
// WETH coming back into a 1inch order contract from outside (a cancelled cross-chain order).
export function orderEscrows(txs, walletAddrs, chain = CHAINS.base) {
  const owner = nativeOrderContracts(txs, walletAddrs, chain)
  const { weth: WETH, ethflow: ETHFLOW, cowSettlement: COW_SETTLEMENT } = chain
  const cow = new Map() // order id -> { wallet, left, receiver }
  const moves = new Map() // wallet -> [{ block, amount, hash }]
  const settled = new Map() // tx hash -> wallets
  const drains = new Map() // tx hash -> Map wallet -> [{ amount, to }]
  const returns = new Map() // tx hash -> Map wallet -> [{ amount, from }]
  const move = (w, rec, amount) => {
    moves.set(w, [...(moves.get(w) ?? []), { block: rec.block, amount, hash: rec.hash, asset: WETH }])
    if (amount < 0n) settled.set(rec.hash, new Set([...(settled.get(rec.hash) ?? []), w]))
  }
  const note = (map, rec, w, x) => {
    const m = map.get(rec.hash) ?? new Map()
    m.set(w, [...(m.get(w) ?? []), x])
    map.set(rec.hash, m)
  }
  for (const rec of txs) {
    for (const l of rec.logs) {
      const t0 = l.topics[0]
      if (l.address === WETH) {
        if ((t0 === TOPIC.WethDeposit || t0 === TOPIC.WethWithdrawal) && l.topics.length === 2 && owner.has(topicAddr(l.topics[1]))) {
          move(owner.get(topicAddr(l.topics[1])), rec, t0 === TOPIC.WethDeposit ? BigInt(l.data) : -BigInt(l.data))
        } else if (t0 === TOPIC.Transfer && l.topics.length === 3) {
          const from = topicAddr(l.topics[1]), to = topicAddr(l.topics[2]), amount = BigInt(l.data)
          if (from === to || !amount) continue
          if (owner.has(from)) {
            move(owner.get(from), rec, -amount)
            if (!owner.has(to) && !walletAddrs.has(to)) note(drains, rec, owner.get(from), { amount, to })
          }
          if (owner.has(to)) {
            move(owner.get(to), rec, amount)
            if (!owner.has(from) && !walletAddrs.has(from)) note(returns, rec, owner.get(to), { amount, from })
          }
        }
      } else if (ETHFLOW[l.address] && t0 === TOPIC.CowOrderPlacement && l.topics.length === 2 && walletAddrs.has(topicAddr(l.topics[1]))) {
        const o = cowOrder(l, chain)
        if (o) { cow.set(o.uid, { wallet: topicAddr(l.topics[1]), left: o.amount, receiver: o.receiver }); move(topicAddr(l.topics[1]), rec, o.amount) }
      } else if (l.address === COW_SETTLEMENT && t0 === TOPIC.CowTrade && l.topics.length === 2 && ETHFLOW[topicAddr(l.topics[1])]) {
        const o = cow.get(bytesArg(l.data, 5)), sold = BigInt(word(l.data, 2))
        if (o && o.left > 0n) {
          const x = sold < o.left ? sold : o.left
          o.left -= x
          move(o.wallet, rec, -x)
          if (o.receiver !== o.wallet) note(drains, rec, o.wallet, { amount: x, to: o.receiver, receiver: true })
        }
      } else if (ETHFLOW[l.address] && (t0 === TOPIC.CowOrderRefund || t0 === TOPIC.CowOrderInvalidation)) {
        const o = cow.get(bytesArg(l.data, 0))
        if (o && o.left > 0n) { move(o.wallet, rec, -o.left); o.left = 0n }
      }
    }
  }
  return { owner, cow, moves, settled, drains, returns }
}

// WETH a wallet had waiting in its open orders at the end of block b.
export function escrowAt(moves, b) {
  let x = 0n
  for (const m of moves ?? []) if (m.block <= b) x += m.amount
  return x > 0n ? x : 0n
}
