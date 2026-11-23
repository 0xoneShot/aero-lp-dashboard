// lib/scan.mjs scan() as a fresh pass and as the hourly pass, without a chain. Each pass runs in a process of
// its own (AERO_FRESH is read when lib/scan.mjs loads), in a working directory of its own with a kept scan and
// made-up wallets, and with fetch replaced by a quiet chain: no transaction, every balance zero, every request
// recorded. The passes read no configured wallet, cache or node; this process loads the configuration only for
// VERSION and CHAINS. A test's passes run side by side.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../lib/scan.mjs'
import { CHAINS } from '../lib/config.mjs'

const lib = (f) => fileURLToPath(new URL(`../lib/${f}`, import.meta.url))
const A = '0x' + '11'.repeat(20), B = '0x' + '33'.repeat(20), X = '0x' + '22'.repeat(20)
const wallet = (key, address) => ({ key, label: key, address })
const config = (...wallets) => JSON.stringify({ startDay: '2026-01-01', scanFromBlock: 1, wallets })
const EXTRAS = JSON.stringify({ v: 1, next: { g: 1 }, extras: [{ key: 'x0000abcd', address: X, label: 'added' }], groups: [], inbox: {}, letGo: [], log: [] })
// A wallet's record in step with a kept scan that stands at block 1000.
const rec = (address) => ({ address, nonce: 0, eth: '0', openingBlock: 1, openingEth: '0' })

// The pass itself. DEAF: an address no request naming it is answered for (an error viem does not retry); with
// DEAF_AT, only at that block (a node that will not read it there, and reads it anywhere else). FRESH_LOGS:
// the chain names log gateways for a fresh pass, apart from the ones every pass may ask. Each request is
// recorded with its host, its method and which of the made-up addresses it names.
const code = `
  const asked = [], deaf = (process.env.DEAF ?? '').slice(2), deafAt = process.env.DEAF_AT, names = ${JSON.stringify({ A: A.slice(2), B: B.slice(2), X: X.slice(2) })}
  const quiet = { eth_getBalance: '0x0', eth_getTransactionCount: '0x0', eth_getCode: '0x', eth_getLogs: [] }
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body), list = Array.isArray(body) ? body : [body]
    const answer = list.map((r) => {
      const params = JSON.stringify(r.params).toLowerCase()
      asked.push([new URL(url).host, r.method, Object.keys(names).filter((k) => params.includes(names[k])).join('')])
      if (deaf && params.includes(deaf) && (!deafAt || params.includes('"' + deafAt + '"'))) return { jsonrpc: '2.0', id: r.id, error: { code: -32602, message: 'this address is not answered for' } }
      if (!(r.method in quiet)) return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'not in this test' } }
      return { jsonrpc: '2.0', id: r.id, result: quiet[r.method] }
    })
    return new Response(JSON.stringify(Array.isArray(body) ? answer : answer[0]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { scan } = await import(${JSON.stringify(lib('scan.mjs'))})
  const { CHAINS } = await import(${JSON.stringify(lib('config.mjs'))})
  const chain = { ...CHAINS.base, rpc: { ...CHAINS.base.rpc, logs: ['https://logs.test'], ...(process.env.FRESH_LOGS ? { freshLogs: ['https://fresh.test'] } : {}) } }
  let state = null, error = null
  try { state = await scan({ head: Number(process.env.HEAD), chain }) } catch (e) { error = String(e.message) }
  console.log(JSON.stringify({ asked, error, wallets: state?.wallets ?? null, unopened: state?.unopened ?? null, scannedTo: state?.scannedTo ?? null }))
  process.exit(0)`
// One pass over a kept scan that stands at `scannedTo`, whose wallets' records are `wallets`; `env` says which
// kind and what the chain does. Resolves to what the pass returned and whether the kept scan is as it was.
function pass({ wallets = {}, scannedTo = 1000, configured = [wallet('w1', A)], extras = false, head = 1001, ...env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-scan-'))
  fs.mkdirSync(path.join(dir, 'data/cache'), { recursive: true })
  const kept = JSON.stringify({ version: VERSION, scannedTo, wallets, txs: {} })
  fs.writeFileSync(path.join(dir, 'data/cache/scan.json'), kept)
  if (extras) fs.writeFileSync(path.join(dir, 'data/cache/extras.json'), EXTRAS)
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, env: { PATH: process.env.PATH, AERO_CONFIG: config(...configured), HEAD: String(head), ...env }, timeout: 60_000, killSignal: 'SIGKILL' })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', reject)
    p.on('close', (status) => {
      try {
        assert.equal(status, 0, err)
        resolve({ ...JSON.parse(out.trim().split('\n').pop()), same: fs.readFileSync(path.join(dir, 'data/cache/scan.json'), 'utf8') === kept })
      } catch (e) { reject(e) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
    })
  })
}
const FRESH = { AERO_FRESH: '1' }

test('a fresh pass opens and catches up nobody: no request, no record, the kept scan untouched', async () => {
  const behindX = { w1: rec(A), x0000abcd: { ...rec(X), behind: { cursor: 500, attempts: 0 } } }
  const [fresh, hourly, deafHourly, deafFresh, behind] = await Promise.all([
    pass({ ...FRESH, head: 1000 }), pass({ head: 1000 }), pass({ head: 1000, DEAF: A }), pass({ ...FRESH, head: 1000, DEAF: A }),
    pass({ ...FRESH, wallets: behindX, extras: true }),
  ])
  assert.deepEqual([fresh.asked, fresh.wallets, fresh.unopened, fresh.same], [[], {}, null, true])
  // The hourly pass opens it at the chain's start and catches it up (nothing happened to it: one step).
  assert.ok(hourly.asked.some(([, m, who]) => m === 'eth_getBalance' && who === 'A'))
  assert.equal(hourly.wallets.w1.openingBlock, 1)
  assert.equal(hourly.wallets.w1.behind, undefined)
  // One that cannot be opened is counted, by the hourly pass alone.
  assert.deepEqual(deafHourly.unopened, { w1: 1 })
  assert.equal(deafFresh.unopened, null)
  // One the hourly pass left behind is not caught up by a fresh pass: its record as it was, and no request names it.
  assert.deepEqual([behind.error, behind.scannedTo, behind.wallets.x0000abcd.behind, behind.asked.filter(([, , who]) => who === 'X')], [null, 1001, { cursor: 500, attempts: 0 }, []])
})

test('a fresh pass leaves a configured wallet the kept scan does not know out; the hourly pass opens it at the chain\'s start', async () => {
  // With blocks to read (the kept scan at 1000, the head at 1001): never opened where the kept scan stands,
  // which would put it into the datasets without its history.
  const configured = [wallet('w1', A), wallet('w2', B)], wallets = { w1: rec(A) }
  const [fresh, hourly] = await Promise.all([pass({ ...FRESH, configured, wallets }), pass({ configured, wallets })])
  assert.deepEqual([fresh.error, fresh.scannedTo, fresh.wallets.w2 ?? null, fresh.asked.filter(([, , who]) => who === 'B')], [null, 1001, null, []])
  assert.deepEqual([hourly.error, hourly.scannedTo, hourly.wallets.w2.openingBlock, hourly.wallets.w2.behind], [null, 1001, 1, undefined])
})

test('a wallet the hourly pass could not open at the chain\'s start stays out: only a chain\'s first scan opens where the scan starts', async () => {
  // The node reads w2 anywhere but at the chain's start (block 1). Opened where the kept scan stands instead,
  // it would be in step at once and join the datasets without its history, for good.
  const configured = [wallet('w1', A), wallet('w2', B)], wallets = { w1: rec(A) }
  const [hourly, first] = await Promise.all([pass({ configured, wallets, DEAF: B, DEAF_AT: '0x1' }), pass({ configured, scannedTo: null })])
  assert.deepEqual([hourly.error, hourly.scannedTo, hourly.wallets.w2 ?? null, hourly.unopened], [null, 1001, null, { w2: 1 }])
  assert.deepEqual(hourly.asked.filter(([, , who]) => who === 'B').map(([, m]) => m), ['eth_getBalance'])
  // A chain's first scan (nothing scanned yet) is where the configured wallets open: at the chain's start.
  assert.deepEqual([first.error, first.scannedTo, first.wallets.w1.openingBlock, first.wallets.w2.openingBlock, first.wallets.w2.behind], [null, 1001, 1, 1, undefined])
})

test('a pass with nobody in step asks no gateway for logs: an empty list of addresses reads as any address', async () => {
  const logs = (r) => r.asked.filter(([, m]) => m === 'eth_getLogs')
  // Blocks to read (the kept scan at 1000, the head at 1001) and nobody to read them for: the kept scan knows
  // none of the configured wallets, and a fresh pass opens nobody. Or its only configured wallet is behind and
  // stays so: a fresh pass catches nobody up, and this hourly pass has no time to.
  const wallets = { w1: { ...rec(A), behind: { cursor: 500, attempts: 0 } } }
  const [unknown, ...stuck] = await Promise.all([pass({ ...FRESH }), ...[FRESH, { CATCH_UP_MINUTES: '0', STEP_EXTRA_MINUTES: '0' }].map((env) => pass({ ...env, wallets }))])
  assert.deepEqual([unknown.error, unknown.asked, unknown.wallets, unknown.scannedTo], [null, [], {}, 1001])
  for (const r of stuck) assert.deepEqual([r.error, logs(r), r.wallets.w1.behind.cursor, r.scannedTo], [null, [], 500, 1001])
})

test('a fresh pass asks for logs only where the chain says a fresh pass may', async () => {
  const hosts = (r) => [...new Set(r.asked.filter(([, m]) => m === 'eth_getLogs').map(([h]) => h))]
  const wallets = { w1: rec(A) }
  // The last: a chain read to its safe head by every pass names none, and a fresh pass asks all its gateways.
  const got = await Promise.all([pass({ ...FRESH, wallets, FRESH_LOGS: '1' }), pass({ wallets, FRESH_LOGS: '1' }), pass({ ...FRESH, wallets })])
  assert.deepEqual(got.map(hosts), [['fresh.test'], ['logs.test'], ['logs.test']])
})

test('a fresh pass that cannot read an added address in step fails as a whole; the hourly pass leaves it behind', async () => {
  const wallets = { w1: rec(A), x0000abcd: rec(X) }
  const [fresh, hourly, ...ok] = await Promise.all([
    pass({ ...FRESH, wallets, extras: true, DEAF: X }), pass({ wallets, extras: true, DEAF: X }),
    ...[FRESH, {}].map((env) => pass({ ...env, wallets, extras: true })),
  ])
  assert.match(fresh.error, /^x0000abcd: not read in step/)
  assert.equal(hourly.error, null)
  assert.equal(hourly.scannedTo, 1001)
  assert.deepEqual([hourly.wallets.x0000abcd.behind.cursor, hourly.wallets.x0000abcd.behind.attempts], [1000, 1])
  // Read without trouble, both passes take it along.
  for (const r of ok) assert.deepEqual([r.error, r.scannedTo, r.wallets.x0000abcd.behind], [null, 1001, undefined])
})

test('only a chain read fresh names gateways for a fresh pass, each one of its log gateways and not its archive node', () => {
  for (const c of Object.values(CHAINS)) {
    if (!c.freshSecs) { assert.equal(c.rpc.freshLogs, undefined, c.key); continue }
    assert.ok(c.rpc.freshLogs?.length > 0, c.key)
    for (const u of c.rpc.freshLogs) assert.ok(c.rpc.logs.includes(u) && u !== c.rpc.archive, `${c.key} ${u}`)
  }
})
