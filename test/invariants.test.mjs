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

test('every transaction ETH split adds up to its own delta', () => {
  for (const { chain, state } of scans) {
    for (const w of WALLETS) {
      for (const rec of Object.values(state.txs)) {
        const e = rec.eth?.[w.address]
        if (!e) continue
        const legs = e.legs.reduce((a, g) => a + BigInt(g.value), 0n)
        const gas = rec.from === w.address ? BigInt(rec.gasCost) : 0n
        assert.equal(legs - gas, BigInt(e.delta), `${chain.key} ${w.key} ${rec.hash}`)
      }
    }
  }
})

test('the scan ends on the archive balance', async () => {
  for (const { chain, state } of scans) {
    for (const w of WALLETS) {
      const bal = await clientOf(chain).getBalance({ address: w.address, blockNumber: BigInt(state.scannedTo) })
      assert.equal(state.wallets[w.key].eth, bal.toString(), `${chain.key} ${w.key}`)
    }
  }
})
