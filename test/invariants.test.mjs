// Checks on the scan cache that hold for any wallets: run after `npm run update`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { WALLETS } from '../lib/config.mjs'
import { client } from '../lib/rpc.mjs'

const state = JSON.parse(fs.readFileSync('data/cache/scan.json', 'utf8'))

test('wallets are configured', () => {
  assert.ok(WALLETS.length > 0, 'set AERO_CONFIG or config/wallets.local.json')
})

test('every transaction ETH split adds up to its own delta', () => {
  for (const w of WALLETS) {
    for (const rec of Object.values(state.txs)) {
      const e = rec.eth?.[w.address]
      if (!e) continue
      const legs = e.legs.reduce((a, g) => a + BigInt(g.value), 0n)
      const gas = rec.from === w.address ? BigInt(rec.gasCost) : 0n
      assert.equal(legs - gas, BigInt(e.delta), `${w.key} ${rec.hash}`)
    }
  }
})

test('the scan ends on the archive balance', async () => {
  for (const w of WALLETS) {
    const bal = await client.getBalance({ address: w.address, blockNumber: BigInt(state.scannedTo) })
    assert.equal(state.wallets[w.key].eth, bal.toString(), w.key)
  }
})
