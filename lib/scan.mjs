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
import { clientOf, getLogs, traceTx, rawRpc, pmap } from './rpc.mjs'
import { TOPIC, erc20Abi, npmAbi } from './abi.mjs'
import { WALLETS, PAUSED_WALLETS, CHAINS } from './config.mjs'
import { nativeOrderContracts, orderEscrows } from './orders.mjs'

// One cache per chain (lib/config.mjs CHAINS); Base's keeps its old name.
const VERSION = 6
const pad = (a) => '0x' + a.toLowerCase().slice(2).padStart(64, '0')
const lc = (a) => (a ? a.toLowerCase() : a)
const log = (...a) => console.error('[scan]', ...a)
const WALLET_SET = new Set(WALLETS.map((w) => w.address))
// Catching up a wallet added after the scan began: blocks per step, time per run and chain, and how
// many log requests run at once (more than the hourly scan's few, over a long range).
const CATCH_UP_STEP = 400_000
const CATCH_UP_CONC = 6
// One budget for the whole run, every chain together, counted from when the update started. src/update.mjs
// sets a shorter one when it gives the run with the added addresses a time limit.
const CATCH_UP_UNTIL = Date.now() + Number(process.env.CATCH_UP_MINUTES ?? 12) * 60_000
// An added address's own scan of the hour's blocks, and the catching up of one only hours behind (one it
// could not finish in step, or a run without it), may go on this much longer.
const STEP_UNTIL = CATCH_UP_UNTIL + Number(process.env.STEP_EXTRA_MINUTES ?? 10) * 60_000
// Runs in a row in which catching a wallet up failed (not merely ran out of time), made no progress, or
// got it no closer to the others than it had been, before it is given up; or in which it could not even be
// opened at the chain's start (`state.unopened`).
export const CATCH_UP_TRIES = 24
export const givenUp = (rec) => ['attempts', 'stalls', 'flat'].some((k) => (rec?.behind?.[k] ?? 0) >= CATCH_UP_TRIES)
export const notOpened = (state, key) => (state?.unopened?.[key] ?? 0) >= CATCH_UP_TRIES
// Whether a stored transaction names any of the addresses, as the scan finds a wallet's transactions (phase 3).
const names = (r, as) => as.some((W) => r.from === W || r.to === W || r.ethHint?.includes(W) || (r.logs ?? []).some((l) => l.topics.slice(1).some((t) => t.toLowerCase() === pad(W))))
// The transactions in a chain's scan state brought in for added addresses only (marked x), counted for each
// of the given addresses that one names: what an added address costs every run to load.
export function addedTxCounts(state, addresses) {
  const out = new Map(addresses.map((a) => [a, 0]))
  for (const r of Object.values(state?.txs ?? {})) if (r?.x) for (const a of addresses) if (names(r, [a])) out.set(a, out.get(a) + 1)
  return out
}
class OutOfTime extends Error {}
// What the public log may say about an added address's trouble: no hashes, blocks or amounts, which
// would point at it on a block explorer. The whole message stays in the encrypted cache.
const quiet = (e) => String(e?.message ?? e).replace(/0x[0-9a-fA-F]+/g, '0x…').replace(/\d{4,}/g, '…').slice(0, 160)
// Catching up also skips the stretches where nothing happened to the wallet: where it sent no transaction
// and every tracked balance (ETH, each token, each position manager's NFTs) is the same at both ends,
// split down to stretches of this many blocks. Only for an account without code (one with code, or with
// EIP-7702 delegation, can move coins without sending a transaction; delegating itself changes the nonce).
// What it can miss: a token arriving and the same amount leaving again inside one stretch, pulled by
// someone the wallet had approved, with no transaction of its own: no change of what it holds, at most the
// coin's price drift between the two.
const QUIET_SPAN = 20_000
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11'
const NEEDLES = WALLETS.map((w) => w.address.slice(2))

function save(state, chain) {
  const file = path.resolve(chain.files.scan)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(state))
  fs.renameSync(file + '.tmp', file)
}

// Logs worth keeping: anything naming a wallet, position-manager events (they name a token id,
// not a wallet), bridge events (they mark a transaction as cross-chain), and what follows a wallet's
// native-ETH orders through fills and refunds sent by others (lib/orders.mjs): WETH events, EthFlow's
// events and the settlement's trades of EthFlow orders. A wallet's own transactions keep every log.
// Airdrop spam can carry a thousand logs and none of them matter.
function trim(rec, chain) {
  if (WALLET_SET.has(rec.from)) return rec
  const cowTrade = (l) => l.address === chain.cowSettlement && l.topics.length === 2 && chain.ethflow['0x' + l.topics[1].slice(26).toLowerCase()]
  rec.logs = rec.logs.filter((l) => chain.npms[l.address] || chain.bridges[l.address] || (chain.bridgeLogs ?? []).some((x) => x.address === l.address) || l.address === chain.weth || chain.ethflow[l.address] || cowTrade(l) ||
    NEEDLES.some((n) => l.data.toLowerCase().includes(n) || l.topics.some((t) => t.toLowerCase().includes(n))))
  return rec
}

const logsOf = (rc) => rc.logs.map((l) => ({ address: lc(l.address), topics: l.topics, data: l.data, logIndex: l.logIndex }))

function load(chain) {
  const file = path.resolve(chain.files.scan)
  if (!fs.existsSync(file)) return { version: VERSION, scannedTo: null, wallets: {}, txs: {}, pending: null }
  const state = JSON.parse(fs.readFileSync(file, 'utf8'))
  const was = state.version ?? 1
  if (was < VERSION) {
    for (const rec of Object.values(state.txs)) trim(rec, chain)
    // Versions 4 to 6 keep more of other people's transactions' logs than before (6: cross-chain markers
    // and more bridges): read them again.
    if (was < 6) state.relog = Object.values(state.txs).filter((r) => !WALLET_SET.has(r.from)).map((r) => r.hash)
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

async function fetchTx(hash, chain) {
  const client = clientOf(chain)
  const [tx, rc] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })])
  const block = Number(rc.blockNumber)
  // The block's own timestamp: block numbers stop being 2 seconds apart at the Denim hard fork.
  const { timestamp } = await client.getBlock({ blockNumber: rc.blockNumber })
  return trim({
    hash, block, ts: Number(timestamp), index: rc.transactionIndex,
    from: lc(tx.from), to: lc(tx.to), selector: tx.input.slice(0, 10), value: tx.value.toString(),
    status: rc.status,
    gasCost: (rc.gasUsed * rc.effectiveGasPrice + (rc.l1Fee ?? 0n)).toString(),
    logs: logsOf(rc),
    eth: {}, // wallet -> { delta, legs: [{ cp, value }] }
  }, chain)
}

// Native ETH a transaction moved for one wallet (gas included), once reconciled.
export function ethDelta(rec, addr) {
  return BigInt(rec.eth?.[addr]?.delta ?? 0)
}

async function ownTxBlocks(client, addr, fromBlock, toBlock, nonceFrom, nonceTo, conc = 4) {
  // A few nonce reads at a time: a busy wallet's bisection would otherwise trip the node's rate limit.
  const cache = new Map()
  let active = 0
  const waiters = []
  const slot = async (f) => {
    while (active >= conc) await new Promise((r) => waiters.push(r))
    active++
    try { return await f() } finally { active--; waiters.shift()?.() }
  }
  const nonceAt = (b) => {
    if (!cache.has(b)) cache.set(b, slot(() => client.getTransactionCount({ address: addr, blockNumber: BigInt(b) })))
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
// whose logs mention it anywhere (a bridge fill names its recipient in the event data). Failing
// that, someone else's call paid it from inside a contract (a refund of an expired order names
// nobody): the likeliest transactions are traced first (an unwrap of WETH, a known order or router
// contract at work), then the whole block, then, if the node will not trace a whole block, each
// remaining transaction. `delta` is the block's ETH change no known transaction explains: what the
// likely ones paid is trusted when a trace failed only if it explains all of it.
async function candidatesIn(block, addr, known, delta, chain, { say = log, check = () => {} } = {}) {
  const client = clientOf(chain), trace = (h) => { check(); return traceTx(h, chain.rpc.trace) }
  const blk = await client.getBlock({ blockNumber: BigInt(block), includeTransactions: true })
  const hits = new Set(blk.transactions.filter((tx) => lc(tx.to) === addr || lc(tx.from) === addr).map((tx) => tx.hash))
  const needle = addr.slice(2)
  // Through the chain's client: its retries and fallback endpoints.
  const receipts = await client.request({ method: 'eth_getBlockReceipts', params: ['0x' + block.toString(16)] })
  for (const r of receipts) if (r.logs.some((l) => l.data.toLowerCase().includes(needle) || l.topics.some((t) => t.toLowerCase().includes(needle)))) hits.add(r.transactionHash)
  const fresh = [...hits].filter((h) => !known(h))
  if (fresh.length) return fresh
  const pays = async (hashes) => (await pmap(hashes, 4, async (h) => (valueTransfers(await trace(h)).some((x) => x.to === addr || x.from === addr) ? h : null))).filter(Boolean)
  const likely = receipts.filter((r) => r.logs.some((l) => (lc(l.address) === chain.weth ? l.topics[0] === TOPIC.WethWithdrawal : chain.strategy[lc(l.address)])))
    .map((r) => r.transactionHash).filter((h) => !known(h))
  let failed = null
  const found = (await pmap(likely, 4, async (h) => {
    try {
      const vt = valueTransfers(await trace(h)).filter((x) => (x.to === addr) !== (x.from === addr))
      return vt.length ? { h, v: vt.reduce((a, x) => a + (x.to === addr ? x.value : -x.value), 0n) } : null
    } catch (e) { failed ??= e; return null }
  })).filter(Boolean)
  if (found.length && (!failed || found.reduce((a, x) => a + x.v, 0n) === delta)) return found.map((x) => x.h)
  if (failed) throw failed
  try {
    check()
    const traces = await rawRpc(chain.rpc.trace, 'debug_traceBlockByNumber', ['0x' + block.toString(16), { tracer: 'callTracer' }], 120_000)
    return traces.filter((t) => valueTransfers(t.result).some((x) => x.to === addr || x.from === addr)).map((t) => t.txHash).filter((h) => !known(h))
  } catch (e) {
    if (e instanceof OutOfTime) throw e
    say(`block ${block}: no block trace (${e.message.slice(0, 80)}); tracing its transactions one by one`)
    return pays(receipts.map((r) => r.transactionHash).filter((h) => !known(h) && !likely.includes(h)))
  }
}

// Split a block's ETH change for one wallet across that block's transactions. `trace` reads a call tree
// (Base's node by default).
export async function assignEth(recs, addr, blockDelta, hasCode, trace = traceTx) {
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
    const vt = valueTransfers(await trace(r.hash)).filter((t) => (t.to === addr) !== (t.from === addr))
    const legs = vt.map((t) => ({ cp: t.to === addr ? t.from : t.to, value: t.to === addr ? t.value : -t.value }))
    const delta = legs.reduce((a, g) => a + g.value, 0n) - (r.from === addr ? BigInt(r.gasCost) : 0n)
    r.eth[addr] = { delta: delta.toString(), legs: legs.map((g) => ({ cp: g.cp, value: g.value.toString() })), traced: true }
    total += delta
  }
  if (total !== blockDelta) throw Object.assign(new Error(`ETH at block ${recs[0].block} does not add up: traced ${total}, balance moved ${blockDelta}`), { unexplained: blockDelta - total })
}

// What a wallet holds and has sent at a block, as far as the ledger can tell: native ETH, the nonce, every
// tracked token and every position manager's NFT count; and whether it has code.
async function fingerprint({ chain, client }, address, block) {
  const blockNumber = BigInt(block)
  const tokens = Object.keys(chain.tokens ?? {}), npms = Object.keys(chain.npms ?? {})
  const [eth, nonce, code, held] = await Promise.all([
    client.getBalance({ address, blockNumber }),
    client.getTransactionCount({ address, blockNumber }),
    client.getCode({ address, blockNumber }),
    client.multicall({ multicallAddress: MULTICALL, allowFailure: true, blockNumber, contracts: [
      ...tokens.map((t) => ({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [address] })),
      ...npms.map((n) => ({ address: n, abi: npmAbi, functionName: 'balanceOf', args: [address] })),
    ] }),
  ])
  // A call that failed is read as nothing held only where the token had no code yet; any other failure
  // makes the stretch count as active (scanned in full), never as quiet.
  const ids = [eth, nonce]
  let unsure = false
  for (const [i, r] of held.entries()) {
    if (r.status === 'success') { ids.push(r.result); continue }
    const at = i < tokens.length ? tokens[i] : npms[i - tokens.length]
    const c = await client.getCode({ address: at, blockNumber })
    if (c && c !== '0x') unsure = true
    ids.push('none')
  }
  return { code: Boolean(code && code !== '0x'), unsure, id: ids.join(',') }
}

// The stretches of (from, to] a catching-up wallet needs scanned in full: all of it for an account with
// code; otherwise halved down to QUIET_SPAN blocks, keeping only halves whose two ends differ.
// Stretches are scanned (and the wallet's record saved) QUIET_SPAN blocks at a time, so a busy account
// still makes progress run after run.
const pieces = (from, to) => { const out = []; for (let a = from; a < to; a += QUIET_SPAN) out.push([a, Math.min(a + QUIET_SPAN, to)]); return out }
// An order of its own that may still be open (lib/orders.mjs: a 1inch native-ETH order contract, a CoW
// EthFlow order not yet filled): its fill or refund can pay someone else, or come back later, with
// nothing the wallet holds changing. While one is, the wallet is scanned in full.
const ordersOpen = ({ state, chain }, w) => {
  const txs = Object.values(state.txs), mine = new Set([w.address])
  return nativeOrderContracts(txs, mine, chain).size > 0 || [...orderEscrows(txs, mine, chain).cow.values()].some((o) => o.left > 0n)
}
async function activeSpans(ctx, w, from, to) {
  const ends = new Map()
  const fp = (b) => { if (!ends.has(b)) ends.set(b, fingerprint(ctx, w.address, b)); return ends.get(b) }
  const [a, z] = await Promise.all([fp(from), fp(to)])
  if (a.code || z.code) return pieces(from, to)
  const out = []
  async function split(lo, hi) {
    const [x, y] = await Promise.all([fp(lo), fp(hi)])
    if (x.id === y.id && !x.unsure && !y.unsure) return
    if (hi - lo <= QUIET_SPAN) { out.push([lo, hi]); return }
    if (x.code || y.code || x.unsure || y.unsure) { out.push(...pieces(lo, hi)); return }
    const mid = Math.floor((lo + hi) / 2)
    await split(lo, mid)
    await split(mid, hi)
  }
  await split(from, to)
  return out
}

export async function scan({ head, chain = CHAINS.base } = {}) {
  const client = clientOf(chain), urls = chain.rpc.logs
  const log = (...a) => console.error(`[scan${chain.key === 'base' ? '' : ' ' + chain.key}]`, ...a)
  const state = load(chain)
  if (state.relog?.length) {
    await pmap(state.relog, 4, async (h) => { const rec = state.txs[h]; if (rec) { rec.logs = logsOf(await client.getTransactionReceipt({ hash: h })); trim(rec, chain) } })
    log(`read the logs of ${state.relog.length} transactions again`)
    delete state.relog
    save(state, chain)
  }
  const to = head ?? Number((await client.getBlock({ blockTag: chain.safeTag })).number)
  const ctx = { state, chain, client, urls, log }
  // A record belongs to one address: one no longer tracked (an added address dropped again) goes, and
  // one whose key now names another address is started over, so stale figures are never built on. A paused
  // address (lib/config.mjs PAUSED_WALLETS) keeps its record: one in step stands where this run starts, and
  // catches up from there once it is back.
  const dropped = []
  for (const [k, rec] of Object.entries(state.wallets)) {
    const w = WALLETS.find((x) => x.key === k) ?? PAUSED_WALLETS.find((x) => x.key === k)
    if (!w || (rec.address && rec.address !== w.address)) { delete state.wallets[k]; if (rec.address) dropped.push(rec.address); log(`${k}: record dropped (${w ? 'other address' : 'no longer tracked'})`) }
    else {
      rec.address ??= w.address
      if (!WALLETS.includes(w) && !rec.behind && state.scannedTo != null) rec.behind = { cursor: state.scannedTo, attempts: 0 }
    }
  }
  for (const k of Object.keys(state.unopened ?? {})) if (!WALLETS.some((x) => x.key === k) && !PAUSED_WALLETS.some((x) => x.key === k)) delete state.unopened[k]
  // What only addresses no longer tracked had brought in goes with them: nothing else's books read it, and it
  // would only grow what every run loads. Only what names one of them and no tracked wallet (as the scan
  // finds a wallet's transactions, phase 3): one naming nobody (an order's fill) may serve another.
  if (dropped.length) {
    const left = [...WALLETS, ...PAUSED_WALLETS].map((x) => x.address)
    let gone = 0
    for (const [h, r] of Object.entries(state.txs)) if (r.x && names(r, dropped) && !names(r, left)) { delete state.txs[h]; gone++ }
    if (gone) log(`${gone} transactions only addresses no longer tracked had brought in were let go`)
    save(state, chain)
  }

  // A wallet tracked after this chain's scan began (an address added on the page, lib/requests.mjs)
  // opens at the chain's start like the others and is caught up to where they are before the scan
  // moves on. One that cannot be caught up this run stays behind (and out of the datasets, src/run.mjs)
  // without holding the others back; the next run tries again.
  if (state.scannedTo != null) {
    for (const w of WALLETS) {
      if (state.wallets[w.key]) continue
      try {
        const b = BigInt(chain.scanFromBlock)
        const eth = (await client.getBalance({ address: w.address, blockNumber: b })).toString()
        state.wallets[w.key] = { address: w.address, nonce: await client.getTransactionCount({ address: w.address, blockNumber: b }), eth, openingBlock: chain.scanFromBlock, openingEth: eth, behind: { attempts: 0 } }
        if (state.unopened) delete state.unopened[w.key]
        save(state, chain)
      } catch (e) {
        // Next run; it stays out of this one. Counted: one that never opens is given up too.
        state.unopened = { ...state.unopened, [w.key]: (state.unopened?.[w.key] ?? 0) + 1 }
        save(state, chain)
        log(`${w.key}: not opened yet: ${quiet(e)}`)
      }
    }
    // Step by step, each step saved, within the run's time budget: a long history (Base makes about
    // 430,000 blocks a day) takes several runs rather than one run longer than the job may take. One only
    // hours behind goes first and is done even once the budget is spent (STEP_UNTIL); the others take turns,
    // the one that waited longest first, so a slow one never keeps the rest waiting run after run.
    const cursorOf = (rec) => rec.behind?.cursor ?? chain.scanFromBlock
    const near = (rec) => state.scannedTo - cursorOf(rec) <= QUIET_SPAN
    const behind = WALLETS.filter((x) => state.wallets[x.key]?.behind).sort((a, b) => {
      const ra = state.wallets[a.key], rb = state.wallets[b.key]
      return near(rb) - near(ra) || (ra.behind.turnAt ?? 0) - (rb.behind.turnAt ?? 0) || cursorOf(rb) - cursorOf(ra)
    })
    for (const w of behind) {
      const rec = state.wallets[w.key]
      // One that keeps failing, or makes no progress run after run, is given up (scripts/requests.mjs then
      // drops it and tells the page).
      if (givenUp(rec)) continue
      if (Date.now() >= (near(rec) ? STEP_UNTIL : CATCH_UP_UNTIL)) continue
      rec.behind.turnAt = Date.now()
      save(state, chain)
      const total = Math.max(1, state.scannedTo - chain.scanFromBlock)
      const startedAt = cursorOf(rec)
      const until = () => (state.scannedTo - cursorOf(rec) <= QUIET_SPAN ? STEP_UNTIL : CATCH_UP_UNTIL)
      try {
        while (rec.behind && Date.now() < until()) {
          const at = cursorOf(rec)
          const end = Math.min(state.scannedTo, at + (chain.catchUpStep ?? CATCH_UP_STEP))
          const limit = until()
          // The stretches of this step where something happened, each scanned in full; the wallet's record
          // stands at each one's end, and nothing it holds changes in between. An order placed in one of
          // them makes the rest of the step count in full.
          let full = ordersOpen(ctx, w)
          const spans = end <= at ? [] : full ? pieces(at, end) : await activeSpans(ctx, w, at, end)
          while (spans.length) {
            const [x, y] = spans.shift()
            await scanRange(ctx, [w], x + 1, y, { get: () => rec.behind.pending, set: (p) => { rec.behind.pending = p } }, { reread: true, conc: CATCH_UP_CONC, until: limit })
            rec.behind.cursor = y
            rec.behind.pending = null
            save(state, chain)
            if (!full && ordersOpen(ctx, w)) { full = true; spans.splice(0, spans.length, ...pieces(y, end)) }
          }
          rec.behind.cursor = end
          rec.behind.error = null
          rec.behind.attempts = 0
          if (end >= state.scannedTo) { delete rec.behind; log(`${w.key}: caught up from the start of tracking`) }
          // An added address's progress, step by step, would profile its activity in the public log.
          else if (!w.extra) log(`${w.key}: caught up ${Math.floor(((end - chain.scanFromBlock) / total) * 100)}%`)
          save(state, chain)
        }
        if (rec.behind) log(`${w.key}: still catching up, goes on next run`)
      } catch (e) {
        if (e instanceof OutOfTime) {
          rec.behind.stalls = cursorOf(rec) > startedAt ? 0 : (rec.behind.stalls ?? 0) + 1
          log(`${w.key}: out of time this run, goes on next run`)
        } else {
          rec.behind.attempts = (rec.behind.attempts ?? 0) + 1
          rec.behind.error = String(e?.message ?? e).slice(0, 300)
          log(`${w.key}: not caught up yet (attempt ${rec.behind.attempts}): ${w.extra ? quiet(e) : rec.behind.error.slice(0, 160)}`)
        }
        save(state, chain)
      }
    }
    // Whether each one is closer to the others than it has ever been: one that is not, run after run (its
    // turns too short for the chain's pace, or none at all), is given up rather than kept waiting for good.
    for (const w of behind) {
      const rec = state.wallets[w.key]
      if (!rec?.behind) continue
      const gap = state.scannedTo - cursorOf(rec)
      if (rec.behind.best == null || gap < rec.behind.best) { rec.behind.best = gap; rec.behind.flat = 0 }
      else rec.behind.flat = (rec.behind.flat ?? 0) + 1
    }
    if (behind.length) save(state, chain)
  }

  const from = (state.scannedTo ?? chain.scanFromBlock) + 1
  if (from > to) return state
  log(`blocks ${from}..${to}`)
  // On a chain's first scan the configured wallets open where it starts. An added address opens only at
  // the chain's start (above): one that could not be opened has no record and stays out of this run.
  for (const w of WALLETS) {
    if (state.wallets[w.key] || w.extra) continue
    const b = BigInt(from - 1)
    const eth = (await client.getBalance({ address: w.address, blockNumber: b })).toString()
    state.wallets[w.key] = { address: w.address, nonce: await client.getTransactionCount({ address: w.address, blockNumber: b }), eth, openingBlock: from - 1, openingEth: eth }
  }
  // The configured wallets together, exactly as before, and their progress saved at once. Then each added
  // address in step on its own: it counts as behind at the range's start until its own scan of the range
  // is done, so a transaction it cannot account for, or a run stopped meanwhile, leaves it to catching up
  // and never touches the others.
  const inStep = WALLETS.filter((w) => state.wallets[w.key] && !state.wallets[w.key].behind)
  await scanRange(ctx, inStep.filter((w) => !w.extra), from, to, { get: () => state.pending, set: (p) => { state.pending = p } })
  const added = inStep.filter((w) => w.extra)
  for (const w of added) state.wallets[w.key].behind = { cursor: from - 1, attempts: 0 }
  state.scannedTo = to
  state.pending = null
  save(state, chain)
  for (const w of added) {
    const rec = state.wallets[w.key]
    try {
      await scanRange(ctx, [w], from, to, { get: () => rec.behind.pending, set: (p) => { rec.behind.pending = p } }, { until: STEP_UNTIL })
      delete rec.behind
    } catch (e) {
      rec.behind = { cursor: from - 1, attempts: e instanceof OutOfTime ? 0 : 1, error: String(e?.message ?? e).slice(0, 300) }
      log(`${w.key}: fell behind${e instanceof OutOfTime ? ' (out of time)' : `: ${quiet(e)}`}`)
    }
    save(state, chain)
  }
  return state
}

// Every transaction that changed `wallets` in blocks from..to, and the native ETH each one moved for
// them, with their records brought to block `to` (in memory: the caller saves them). The list of
// transactions to fetch is kept through `slot` (the shared scan's state.pending, or a wallet's own while it
// is behind), so an interrupted run resumes. `reread`: transactions already stored for other wallets may
// have had these wallets' logs trimmed away (they were not tracked then); read those again. `until`: the
// time by which it gives up (OutOfTime), checked between requests.
async function scanRange({ state, chain, client, urls, log }, wallets, from, to, slot, { reread = false, conc, until } = {}) {
  const inTime = () => { if (until && Date.now() > until) throw new OutOfTime() }
  inTime()
  // An added address's scan says nothing in the public log but what failed: its counts per range, or the
  // block of an ETH change, would point at it on a block explorer.
  const extra = wallets.some((w) => w.extra)
  const note = extra ? () => {} : log
  // What only an added address's scan fetched is marked: the configured wallets' books leave it out
  // (src/run.mjs books), exactly as before anyone was added. Their own scan finding it too clears the mark.
  // A fetch still under way when another ran out of time is not stored: the scan has returned by then, and
  // the caller has read the transactions it holds.
  const fetchAll = async (hashes) => {
    const all = [...new Set(hashes)]
    const missing = all.filter((h) => !state.txs[h])
    let over = false
    try {
      await pmap(missing, 4, async (h) => { inTime(); const rec = await fetchTx(h, chain); if (over) return; if (extra) rec.x = 1; state.txs[h] = rec })
    } finally { over = true }
    if (!extra) for (const h of all) delete state.txs[h].x
    return missing.length
  }
  const label = wallets.length === 1 ? `${wallets[0].key} ` : ''
  // Phases 1 and 2 are saved as a list of transactions to fetch, so an interrupted run resumes.
  let pending = slot.get()
  const keys = wallets.map((w) => w.key).join(',')
  if (!pending || pending.to !== to || pending.from !== from || (pending.keys ?? keys) !== keys) {
    const want = new Set()
    const nonces = {}
    for (const w of wallets) {
      const ws = state.wallets[w.key]
      const nonceTo = await client.getTransactionCount({ address: w.address, blockNumber: BigInt(to) })
      nonces[w.key] = nonceTo
      if (nonceTo === ws.nonce) continue
      const blocks = await ownTxBlocks(client, w.address, from - 1, to, ws.nonce, nonceTo)
      await pmap(blocks, 4, async (b) => {
        const blk = await client.getBlock({ blockNumber: BigInt(b), includeTransactions: true })
        for (const tx of blk.transactions) if (lc(tx.from) === w.address) want.add(tx.hash)
      })
      note(`${w.key}: ${blocks.length} blocks with own txs`)
    }
    const addrs = wallets.map((w) => pad(w.address))
    const progress = (what) => (d, n) => { inTime(); if (d % 200 === 0 || d === n) note(`${label}${what} ${d}/${n}`) }
    const a = await getLogs({ topics: [[TOPIC.Transfer, TOPIC.WethDeposit, TOPIC.WethWithdrawal, TOPIC.EmissionsClaimed, TOPIC.DeferredEmissionsClaimed], addrs], fromBlock: from, toBlock: to, urls, conc, onProgress: progress('logs naming a wallet first') })
    const b = await getLogs({ topics: [[TOPIC.Transfer, TOPIC.GaugeDeposit, TOPIC.GaugeWithdraw], null, addrs], fromBlock: from, toBlock: to, urls, conc, onProgress: progress('logs naming a wallet second') })
    for (const l of [...a, ...b]) want.add(l.transactionHash)
    pending = { from, to, keys, hashes: [...want], nonces }
    slot.set(pending)
    save(state, chain)
  }
  if (reread && !pending.reread) {
    // Kept whole only when sent by a wallet that was tracked then; everything else was cut down to the
    // logs naming the wallets tracked at the time.
    const whole = new Set(WALLETS.filter((w) => state.wallets[w.key] && !state.wallets[w.key].behind).map((w) => w.address))
    const again = [...new Set(pending.hashes)].filter((h) => state.txs[h] && !whole.has(state.txs[h].from))
    await pmap(again, 4, async (h) => { const rec = state.txs[h]; rec.logs = logsOf(await client.getTransactionReceipt({ hash: h })); trim(rec, chain) })
    if (again.length) note(`${label}read the logs of ${again.length} stored transactions again`)
    pending.reread = true
    save(state, chain)
  }

  inTime()
  note(`${label}fetched ${await fetchAll(pending.hashes)} transactions`)
  // What names no wallet but moves a wallet's order (lib/orders.mjs): WETH into or out of its 1inch order
  // contracts (a fill paying the wallet nothing in that transaction, a cancelled cross-chain order coming
  // back), looked up by contract; and the fills of its open CoW orders paying another receiver.
  const mine = new Set(wallets.map((w) => w.address))
  const orderContracts = [...nativeOrderContracts(Object.values(state.txs), mine, chain).keys()].map(pad)
  if (orderContracts.length) {
    const moved = [
      ...await getLogs({ address: chain.weth, topics: [[TOPIC.Transfer, TOPIC.WethWithdrawal], orderContracts], fromBlock: from, toBlock: to, urls }),
      ...await getLogs({ address: chain.weth, topics: [TOPIC.Transfer, null, orderContracts], fromBlock: from, toBlock: to, urls }),
    ]
    note(`${label}fetched ${await fetchAll(moved.map((l) => l.transactionHash))} transactions moving order WETH`)
  }
  // Fills paying a wallet scanned here are found by its own logs; any other receiver's are looked up.
  const cowOut = [...orderEscrows(Object.values(state.txs), mine, chain).cow.entries()].filter(([, o]) => o.left > 0n && !mine.has(o.receiver)).map(([uid]) => uid.slice(2))
  if (cowOut.length) {
    const trades = await getLogs({ address: chain.cowSettlement, topics: [TOPIC.CowTrade, Object.keys(chain.ethflow).map(pad)], fromBlock: from, toBlock: to, urls })
    note(`${label}fetched ${await fetchAll(trades.filter((l) => cowOut.some((u) => l.data.includes(u))).map((l) => l.transactionHash))} fills of orders paying another receiver`)
  }
  save(state, chain)

  // Phase 3: native ETH, block by block, against the archive balance.
  for (const w of wallets) {
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
    // Find the transactions of someone else's that moved the wallet's ETH in a block, and count them from now on.
    const learnPayers = async (block, delta) => {
      const hits = await candidatesIn(block, W, (h) => state.txs[h] && touches(state.txs[h]), delta, chain, { say: note, check: inTime })
      await fetchAll(hits)
      for (const h of hits) state.txs[h].ethHint = [...new Set([...(state.txs[h].ethHint ?? []), W])]
      index = byBlock()
      return hits
    }
    let expected = BigInt(state.wallets[w.key].eth)
    let cursor = from - 1
    let done = false
    for (let guard = 0; guard < 100_000 && !done; guard++) {
      inTime()
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
        const hits = await learnPayers(hi, (await bal(hi)) - expected)
        note(`${w.key}: ETH changed at block ${hi} with no known tx; found ${hits.length}`)
        if (!hits.length) throw new Error(`${w.key}: ETH balance changed at block ${hi} but no transaction explains it`)
        continue // re-plan from the same cursor with the new transaction known
      }
      if (!Number.isFinite(next)) { done = true; break }
      const recs = index.get(next).sort((x, y) => x.index - y.index)
      const after = await bal(next)
      try {
        await assignEth(recs, W, after - expected, hasCode, (h) => traceTx(h, chain.rpc.trace))
      } catch (e) {
        // The wallet's own transactions do not explain the block: someone else's in the same block paid it
        // too, from inside a contract (a relayer's call, naming the wallet only in its log data).
        if (e.unexplained == null) throw e
        const hits = await learnPayers(next, e.unexplained)
        note(`${w.key}: ETH at block ${next} not explained by its known txs; found ${hits.length} more`)
        if (!hits.length) throw e
        continue // plan this block again with the new transaction known
      }
      expected = after
      cursor = next
    }
    if (!done) throw new Error(`${w.key}: ETH reconciliation did not finish; rerun to continue`)
    // The same check the tests make, before anything is saved: a scan that does not end on the archive
    // balance (a node that answered inconsistently) is redone by the next run instead of built on.
    const end = await bal(to)
    if (end !== expected) throw new Error(`${w.key}: the scan does not end on the archive balance at block ${to}; rerun`)
    state.wallets[w.key].eth = expected.toString()
    state.wallets[w.key].nonce = pending.nonces[w.key] ?? state.wallets[w.key].nonce
  }
}
