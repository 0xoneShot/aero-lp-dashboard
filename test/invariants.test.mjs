// Checks on the scan caches that hold for any wallets: run after `npm run update`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { WALLETS, CHAINS } from '../lib/config.mjs'
import { clientOf } from '../lib/rpc.mjs'

// Every chain whose cache exists (lib/config.mjs CHAINS; Base's always does after an update).
const scans = Object.values(CHAINS).filter((c) => c.key === 'base' || fs.existsSync(c.files.scan))
  .map((c) => ({ chain: c, state: JSON.parse(fs.readFileSync(c.files.scan, 'utf8')) }))

test('wallets are configured', () => {
  assert.ok(WALLETS.length > 0, 'set AERO_CONFIG or config/wallets.local.json')
})

// An address added on the page is checked too, but its trouble is only reported, by key, with no
// transaction or amount (the job's log is public), and never holds back the configured wallets' publish.
const fails = (t, w, ok, what) => { if (!ok && w.extra) t.diagnostic(`${w.key}: ${what}`); return !ok && !w.extra }

test('every transaction ETH split adds up to its own delta', (t) => {
  for (const { chain, state } of scans) {
    for (const w of WALLETS) {
      for (const rec of Object.values(state.txs)) {
        const e = rec.eth?.[w.address]
        if (!e) continue
        const legs = e.legs.reduce((a, g) => a + BigInt(g.value), 0n)
        const gas = rec.from === w.address ? BigInt(rec.gasCost) : 0n
        if (fails(t, w, legs - gas === BigInt(e.delta), `${chain.key}: a transaction's ETH does not add up`)) assert.equal(legs - gas, BigInt(e.delta), `${chain.key} ${w.key} ${rec.hash}`)
      }
    }
  }
})

test('the scan ends on the archive balance', async (t) => {
  for (const { chain, state } of scans) {
    for (const w of WALLETS) {
      // An address added on the page and still being caught up (lib/scan.mjs) stands where its own
      // catching up has got to; it is left out of the datasets until it reaches the others.
      const rec = state.wallets[w.key]
      if (!rec) continue
      const at = rec.behind ? rec.behind.cursor ?? rec.openingBlock : state.scannedTo
      let bal
      try { bal = await clientOf(chain).getBalance({ address: w.address, blockNumber: BigInt(at) }) } catch (e) { if (!w.extra) throw e; t.diagnostic(`${w.key}: ${chain.key} balance not read`); continue }
      if (fails(t, w, rec.eth === bal.toString(), `${chain.key}: the scan does not end on the archive balance`)) assert.equal(rec.eth, bal.toString(), `${chain.key} ${w.key}`)
    }
  }
})
