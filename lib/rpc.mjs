import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { RPC, WALLETS } from './config.mjs'

export const ADDRS = Object.fromEntries(WALLETS.map((w) => [w.key, w.address]))

// Archive node: eth_call / balances / nonces at any historical block.
export const client = createPublicClient({
  chain: base,
  transport: http(RPC.archive, { batch: { batchSize: 20, wait: 10 }, retryCount: 6, retryDelay: 400 }),
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const hex = (n) => '0x' + BigInt(n).toString(16)

export async function rawRpc(url, method, params, timeoutMs = 60_000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const text = await res.text()
    let j
    try { j = JSON.parse(text) } catch { throw new Error(`${url} ${res.status}: ${text.slice(0, 160)}`) }
    if (j.error) throw new Error(`${url}: ${JSON.stringify(j.error).slice(0, 200)}`)
    if (!('result' in j)) throw new Error(`${url}: an answer with no result`)
    return j.result
  } finally {
    clearTimeout(t)
  }
}

// eth_getLogs over [from, to] in 1,000-block windows on the public Tenderly gateways,
// which accept address-free topic filters on archive data.
export async function getLogs({ address, topics, fromBlock, toBlock, step = 1000, conc = 3, onProgress }) {
  const ranges = []
  for (let a = fromBlock; a <= toBlock; a += step) ranges.push([a, Math.min(a + step - 1, toBlock)])
  const out = []
  let next = 0, done = 0
  async function one(a, b) {
    const filter = { topics, fromBlock: hex(a), toBlock: hex(b) }
    if (address) filter.address = address
    let lastErr
    for (let attempt = 0; attempt < 8; attempt++) {
      try { return await rawRpc(RPC.logs[attempt % RPC.logs.length], 'eth_getLogs', [filter]) }
      catch (e) { lastErr = e; await sleep(300 * 2 ** Math.min(attempt, 5)) }
    }
    throw new Error(`getLogs ${a}-${b} failed: ${lastErr.message}`)
  }
  await Promise.all(Array.from({ length: Math.min(conc, ranges.length) }, async () => {
    while (next < ranges.length) {
      const [a, b] = ranges[next++]
      out.push(...await one(a, b))
      done++
      onProgress?.(done, ranges.length)
    }
  }))
  return out.sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)))
}

// Call tree of a transaction, used to see native ETH moved by contracts.
export async function traceTx(hash) {
  let lastErr
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await rawRpc(RPC.trace, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }], 90_000) }
    catch (e) { lastErr = e; await sleep(500 * 2 ** attempt) }
  }
  throw lastErr
}

export async function pmap(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k) }
  }))
  return out
}
