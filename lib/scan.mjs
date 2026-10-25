// Finds every transaction that changed either wallet, incrementally, and caches what is needed
// to account for it: logs, gas paid and the native ETH each one moved.
//
// Three nets catch transactions:
//   1. nonce bisection finds every transaction a wallet sent;
//   2. topic-filtered logs find token, NFT, gauge and reward events naming a wallet, whoever sent them;
//   3. native ETH is reconciled against the archive balance block by block; a change no known
//      transaction explains is bisected down to its block and matched to the transaction behind it.
// Native ETH per transaction comes from archive balance differences. Call traces are used whenever
// that is ambiguous: several of a wallet's transactions in one block, or an EIP-7702 account
// executing calls. If a needed trace cannot be fetched the run fails rather than guess.
// Only blocks up to Base's "safe" head are scanned, so a reorg cannot leave phantom transactions.
import fs from 'node:fs'
import path from 'node:path'
import { client, getLogs, traceTx, rawRpc, pmap } from './rpc.mjs'
import { TOPIC } from './abi.mjs'
import { WALLETS, SCAN_FROM_BLOCK, RPC, NPMS, BRIDGES } from './config.mjs'

const CACHE = path.resolve('data/cache/scan.json')
const VERSION = 3
const pad = (a) => '0x' + a.toLowerCase().slice(2).padStart(64, '0')
const lc = (a) => (a ? a.toLowerCase() : a)
const log = (...a) => console.error('[scan]', ...a)
const WALLET_SET = new Set(WALLETS.map((w) => w.address))
const NEEDLES = WALLETS.map((w) => w.address.slice(2))

function save(state) {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true })
  fs.writeFileSync(CACHE + '.tmp', JSON.stringify(state))
  fs.renameSync(CACHE + '.tmp', CACHE)
}

// Logs worth keeping: anything naming a wallet, position-manager events (they name a token id,
// not a wallet) and bridge events (they mark a transaction as cross-chain). A wallet's own
// transactions keep every log. Airdrop spam can carry a thousand logs and none of them matter.
function trim(rec) {
  if (WALLET_SET.has(rec.from)) return rec
  rec.logs = rec.logs.filter((l) => NPMS[l.address] || BRIDGES[l.address] ||
    NEEDLES.some((n) => l.data.toLowerCase().includes(n) || l.topics.some((t) => t.toLowerCase().includes(n))))
  return rec
}

function load() {
  if (!fs.existsSync(CACHE)) return { version: VERSION, scannedTo: null, wallets: {}, txs: {}, pending: null }
  const state = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
  if ((state.version ?? 1) < VERSION) {
    for (const rec of Object.values(state.txs)) trim(rec)
    state.version = VERSION
  }
  return state
}

// Native ETH transfers that actually happened, from a callTracer tree.
function valueTransfers(frame, out = []) {
  if (!frame || frame.error) return out
  const v = frame.value ? BigInt(frame.value) : 0n
  if (v > 0n && frame.type !== 'DELEGATECALL' && frame.type !== 'STATICCALL') out.push({ from: lc(frame.from), to: lc(frame.to), value: v })
  for (const c of frame.calls ?? []) valueTransfers(c, out)
  return out
}

async function fetchTx(hash) {
  const [tx, rc] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })])
  const block = Number(rc.blockNumber)
  return trim({
    hash, block, ts: 1686789347 + 2 * block, index: rc.transactionIndex,
    from: lc(tx.from), to: lc(tx.to), selector: tx.input.slice(0, 10), value: tx.value.toString(),
    status: rc.status,
    gasCost: (rc.gasUsed * rc.effectiveGasPrice + (rc.l1Fee ?? 0n)).toString(),
    logs: rc.logs.map((l) => ({ address: lc(l.address), topics: l.topics, data: l.data, logIndex: l.logIndex })),
    eth: {}, // wallet -> { delta, legs: [{ cp, value }] }
  })
}

// Native ETH a transaction moved for one wallet (gas included), once reconciled.
export function ethDelta(rec, addr) {
  return BigInt(rec.eth?.[addr]?.delta ?? 0)
}

async function ownTxBlocks(addr, fromBlock, toBlock, nonceFrom, nonceTo) {
  const cache = new Map()
  const nonceAt = (b) => {
    if (!cache.has(b)) cache.set(b, client.getTransactionCount({ address: addr, blockNumber: BigInt(b) }))
    return cache.get(b)
  }
  const blocks = []
  async function split(lo, hi, nlo, nhi) {
    if (nlo === nhi) return
    if (hi - lo === 1) { blocks.push(hi); return }
    const mid = Math.floor((lo + hi) / 2)
    const nm = await nonceAt(mid)
    await Promise.all([split(lo, mid, nlo, nm), split(mid, hi, nm, nhi)])
  }
  await split(fromBlock, toBlock, nonceFrom, nonceTo)
  return blocks.sort((a, b) => a - b)
}

// Transactions in a block that could have moved the wallet's ETH: sent by it, sent to it, or
// whose logs mention it anywhere (a bridge fill names its recipient in the event data).
async function candidatesIn(block, addr, known) {
  const blk = await client.getBlock({ blockNumber: BigInt(block), includeTransactions: true })
  const hits = new Set(blk.transactions.filter((tx) => lc(tx.to) === addr || lc(tx.from) === addr).map((tx) => tx.hash))
  const needle = addr.slice(2)
  const receipts = await rawRpc(RPC.archive, 'eth_getBlockReceipts', ['0x' + block.toString(16)])
  for (const r of receipts) if (r.logs.some((l) => l.data.toLowerCase().includes(needle) || l.topics.some((t) => t.toLowerCase().includes(needle)))) hits.add(r.transactionHash)
  const fresh = [...hits].filter((h) => !known(h))
  if (fresh.length) return fresh
  const traces = await rawRpc(RPC.trace, 'debug_traceBlockByNumber', ['0x' + block.toString(16), { tracer: 'callTracer' }], 120_000)
  return traces.filter((t) => valueTransfers(t.result).some((x) => x.to === addr || x.from === addr)).map((t) => t.txHash).filter((h) => !known(h))
}

// Split a block's ETH change for one wallet across that block's transactions.
export async function assignEth(recs, addr, blockDelta, hasCode) {
  const sent = (r) => (r.status === 'success' && r.to !== addr ? BigInt(r.value) : 0n) // reverted or self-sent value goes nowhere
  const ownCost = (r) => (r.from === addr ? -sent(r) - BigInt(r.gasCost) : 0n)
  const predicted = recs.reduce((a, r) => a + ownCost(r), 0n)
  const rest = blockDelta - predicted
  // An account with code (EIP-7702) can move ETH from inside any call made to it; so can a self-call.
  const opaque = recs.some((r) => r.to === addr && (hasCode || r.from === addr) && r.selector !== '0x')
  const base = (r) => ({ delta: ownCost(r), legs: r.from === addr && sent(r) > 0n ? [{ cp: r.to, value: -sent(r) }] : [] })

  if (rest === 0n && !opaque) {
    for (const r of recs) { const b = base(r); r.eth[addr] = { delta: b.delta.toString(), legs: b.legs.map((g) => ({ cp: g.cp, value: g.value.toString() })) } }
    return
  }
  if (recs.length === 1 && !opaque) {
    // One transaction paid the wallet (or took from it) inside a call: a swap to ETH, a bridge fill,
    // a plain or tagged send. The counterparty is the sender when the wallet is the target.
    const r = recs[0], b = base(r)
    const cp = r.to === addr ? r.from : r.to
    r.eth[addr] = { delta: (b.delta + rest).toString(), legs: [...b.legs, { cp, value: rest }].map((g) => ({ cp: g.cp, value: g.value.toString() })) }
    return
  }
  // Ambiguous: trace every transaction in the block and take each one's own transfers.
  let total = 0n
  for (const r of recs) {
    const vt = valueTransfers(await traceTx(r.hash)).filter((t) => (t.to === addr) !== (t.from === addr))
    const legs = vt.map((t) => ({ cp: t.to === addr ? t.from : t.to, value: t.to === addr ? t.value : -t.value }))
    const delta = legs.reduce((a, g) => a + g.value, 0n) - (r.from === addr ? BigInt(r.gasCost) : 0n)
    r.eth[addr] = { delta: delta.toString(), legs: legs.map((g) => ({ cp: g.cp, value: g.value.toString() })), traced: true }
    total += delta
  }
  if (total !== blockDelta) throw new Error(`ETH at block ${recs[0].block} does not add up: traced ${total}, balance moved ${blockDelta}`)
}

export async function scan({ head } = {}) {
  const state = load()
  const to = head ?? Number((await client.getBlock({ blockTag: 'safe' })).number)
  const from = (state.scannedTo ?? SCAN_FROM_BLOCK) + 1
  if (from > to) return state
  log(`blocks ${from}..${to}`)

  for (const w of WALLETS) {
    if (state.wallets[w.key]) continue
    const b = BigInt(from - 1)
    const eth = (await client.getBalance({ address: w.address, blockNumber: b })).toString()
    state.wallets[w.key] = { nonce: await client.getTransactionCount({ address: w.address, blockNumber: b }), eth, openingBlock: from - 1, openingEth: eth }
  }

  // Phases 1 and 2 are saved as a list of transactions to fetch, so an interrupted run resumes.
  if (!state.pending || state.pending.to !== to || state.pending.from !== from) {
    const want = new Set()
    const nonces = {}
    for (const w of WALLETS) {
      const ws = state.wallets[w.key]
      const nonceTo = await client.getTransactionCount({ address: w.address, blockNumber: BigInt(to) })
      nonces[w.key] = nonceTo
      if (nonceTo === ws.nonce) continue
      const blocks = await ownTxBlocks(w.address, from - 1, to, ws.nonce, nonceTo)
      await pmap(blocks, 4, async (b) => {
        const blk = await client.getBlock({ blockNumber: BigInt(b), includeTransactions: true })
        for (const tx of blk.transactions) if (lc(tx.from) === w.address) want.add(tx.hash)
      })
      log(`${w.key}: ${blocks.length} blocks with own txs`)
    }
    const addrs = WALLETS.map((w) => pad(w.address))
    const progress = (label) => (d, n) => { if (d % 200 === 0 || d === n) log(`${label} ${d}/${n}`) }
    const a = await getLogs({ topics: [[TOPIC.Transfer, TOPIC.WethDeposit, TOPIC.WethWithdrawal, TOPIC.EmissionsClaimed, TOPIC.DeferredEmissionsClaimed], addrs], fromBlock: from, toBlock: to, onProgress: progress('logs naming a wallet first') })
    const b = await getLogs({ topics: [[TOPIC.Transfer, TOPIC.GaugeDeposit, TOPIC.GaugeWithdraw], null, addrs], fromBlock: from, toBlock: to, onProgress: progress('logs naming a wallet second') })
    for (const l of [...a, ...b]) want.add(l.transactionHash)
    state.pending = { from, to, hashes: [...want], nonces }
    save(state)
  }

  const fetchAll = async (hashes) => {
    const missing = [...new Set(hashes)].filter((h) => !state.txs[h])
    await pmap(missing, 4, async (h) => { state.txs[h] = await fetchTx(h) })
    return missing.length
  }
  log(`fetched ${await fetchAll(state.pending.hashes)} transactions`)
  save(state)

  // Phase 3: native ETH, block by block, against the archive balance.
  for (const w of WALLETS) {
    const W = w.address
    const code = await client.getCode({ address: W, blockNumber: BigInt(to) })
    const hasCode = Boolean(code && code !== '0x')
    const bal = (b) => client.getBalance({ address: W, blockNumber: BigInt(b) })
    const touches = (r) => r.from === W || r.to === W || r.ethHint?.includes(W) || r.logs.some((l) => l.topics.slice(1).some((t) => t.toLowerCase() === pad(W)))
    const byBlock = () => {
      const m = new Map()
      for (const r of Object.values(state.txs)) if (r.block >= from && r.block <= to && touches(r)) m.set(r.block, [...(m.get(r.block) ?? []), r])
      return m
    }
    let index = byBlock()
    let expected = BigInt(state.wallets[w.key].eth)
    let cursor = from - 1
    let done = false
    for (let guard = 0; guard < 100_000 && !done; guard++) {
      const next = Math.min(...[...index.keys()].filter((b) => b > cursor), Infinity)
      const end = Number.isFinite(next) ? next - 1 : to
      if (end > cursor && (await bal(end)) !== expected) {
        // An ETH change no known transaction explains: find its block and the transaction.
        let lo = cursor, hi = end
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2)
          if ((await bal(mid)) === expected) lo = mid
          else hi = mid
        }
        const isKnown = (h) => state.txs[h] && touches(state.txs[h])
        const hits = await candidatesIn(hi, W, isKnown)
        log(`${w.key}: ETH changed at block ${hi} with no known tx; found ${hits.length}`)
        if (!hits.length) throw new Error(`${w.key}: ETH balance changed at block ${hi} but no transaction explains it`)
        await fetchAll(hits)
        for (const h of hits) state.txs[h].ethHint = [...new Set([...(state.txs[h].ethHint ?? []), W])]
        index = byBlock()
        continue // re-plan from the same cursor with the new transaction known
      }
      if (!Number.isFinite(next)) { done = true; break }
      const recs = index.get(next).sort((x, y) => x.index - y.index)
      const after = await bal(next)
      await assignEth(recs, W, after - expected, hasCode)
      expected = after
      cursor = next
    }
    if (!done) throw new Error(`${w.key}: ETH reconciliation did not finish; rerun to continue`)
    state.wallets[w.key].eth = expected.toString()
    state.wallets[w.key].nonce = state.pending.nonces[w.key] ?? state.wallets[w.key].nonce
  }

  state.scannedTo = to
  state.pending = null
  save(state)
  return state
}
