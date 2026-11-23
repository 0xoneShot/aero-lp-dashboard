// scripts/alerts.mjs from end to end, without ntfy: the script as the job runs it, in a working directory of
// its own with made-up wallets, and with fetch replaced by a module loaded before it (--import), so nothing is
// sent anywhere. Run with `npm run test:e2e` after changing scripts/alerts.mjs: the job's cases each wait out
// the step's padded 20 s (side by side), so like update.test.mjs this is kept out of `npm test`, which the job
// runs before every publish.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate } from '../../lib/alerts.mjs'

const ALERTS = fileURLToPath(new URL('../../scripts/alerts.mjs', import.meta.url))
const CONFIG = JSON.stringify({ startDay: '2026-01-01', scanFromBlock: 1, wallets: [['a', '11'], ['b', '33'], ['c', '22']].map(([key, b]) => ({ key, label: key.toUpperCase(), address: '0x' + b.repeat(20) })) })
// Three invented wallets with an invented 2000-2500 range each: inside it at 2200, below it at 1900.
const row = (scope, pool) => {
  const in_range = pool >= 2000 && pool < 2500
  return { scope, scope_label: scope.toUpperCase(), eth_usd: pool, range_state: in_range ? 'in' : 'below', cost_eth_price: 2300, now_cost_eth_price: 2300, as_of: new Date(Date.now() - 60e3).toISOString(), as_of_cst: 'made-up', curve: { positions: [0, 1].map(() => ({ low: 2000, high: 2500, pool, in_range })) } }
}
const rows = (pool) => [...['a', 'b', 'c'].map((k) => row(k, pool)), { scope: 'total', scope_label: '合计', curve: { positions: [] } }]
// Stands in for fetch in the script's process. What each send does, by its order (the last one repeats):
// ok | a status | named (an error whose text and code name a wallet and a price). Anything but a message to
// ntfy fails.
const STUB = `
  const acts = process.env.STUB.split(','); let n = 0
  globalThis.fetch = async (url, init) => {
    const act = acts[Math.min(n++, acts.length - 1)]
    if (new URL(url).host !== 'ntfy.sh' || !JSON.parse(init.body).topic) throw new Error('not in this test')
    if (act === 'ok') return new Response('{}', { status: 200 })
    if (/^\\d+$/.test(act)) return new Response('{}', { status: Number(act) })
    throw Object.assign(new TypeError('fetch failed for A at 1234.5'), { cause: { code: 'A 0xabc 1234' } })
  }`
// Runs the script after an hour that left every range inside (the kept state) on a summary at `pool`;
// resolves to its exit code, all it printed, when it first printed anything and how long it took.
function alerts({ pool = 1900, stub = 'ok', job = true, topic = 'made-up-topic' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-test-'))
  fs.mkdirSync(path.join(dir, 'data/cache'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'out'))
  fs.writeFileSync(path.join(dir, 'data/cache/alerts.json'), JSON.stringify(evaluate(rows(2200), null).state))
  fs.writeFileSync(path.join(dir, 'out/summary.json'), JSON.stringify(rows(pool)))
  fs.writeFileSync(path.join(dir, 'stub.mjs'), STUB)
  return new Promise((resolve) => {
    const t0 = Date.now(), said = []
    const p = spawn(process.execPath, ['--import', pathToFileURL(path.join(dir, 'stub.mjs')).href, ALERTS],
      { cwd: dir, env: { PATH: process.env.PATH, AERO_CONFIG: CONFIG, NTFY_TOPIC: topic, STUB: stub, GITHUB_ACTIONS: job ? 'true' : '' }, timeout: 90_000, killSignal: 'SIGKILL' })
    for (const s of [p.stdout, p.stderr]) s.on('data', (d) => said.push([Date.now() - t0, String(d)]))
    // 'close', not 'exit': everything it printed has been read by then (it starts nothing that could hold the pipes).
    p.on('close', (code) => { fs.rmSync(dir, { recursive: true, force: true }); resolve({ code, out: said.map(([, d]) => d).join(''), first: said[0]?.[0], ms: Date.now() - t0 }) })
  })
}

test('in the job the alert step says one line at its padded end, with the first failure\'s reason from the closed set', async () => {
  const [sent, none, refused, named, off, local] = await Promise.all([
    alerts(), alerts({ pool: 2200 }), alerts({ stub: 'ok,429,503' }), alerts({ stub: 'named' }), alerts({ topic: '' }), alerts({ stub: 'ok,429,ok', job: false }),
  ])
  for (const r of [sent, none, refused, named, off, local]) assert.equal(r.code, 0, r.out)
  // Three messages sent and nothing to send read the same...
  assert.equal(sent.out, 'alerts: done\n')
  assert.equal(none.out, 'alerts: done\n')
  // ...two that ntfy refused are not said as they happen, and only what it answered the first is said (a list
  // of answers would say there were at least so many messages)...
  assert.equal(refused.out, 'alerts: not all sent (ntfy answered 429)\n')
  // ...nothing of what an error carried...
  assert.equal(named.out, 'alerts: not all sent (ntfy not reached)\n')
  assert.equal(off.out, 'alerts: off\n')
  // ...and nothing at all before the padded time is up, whatever there was to send.
  for (const r of [sent, none, refused, named, off]) assert.ok(r.first >= 20_000, `said something after ${r.first} ms`)
  // On one's own machine: at once, each failure as it happens, and the counts.
  assert.equal(local.out, 'alerts: one message failed (ntfy answered 429)\nalerts: 2 of 3 sent\n')
  assert.ok(local.ms < 15_000, `took ${local.ms} ms`)
})
