import test from 'node:test'
import assert from 'node:assert/strict'
import { overrideLookup, overrideSecret, overrideKey, unmatchedOverrides } from '../lib/overrides.mjs'

const A = ['0x' + '1'.repeat(40), '0x' + '2'.repeat(40)]
const tx = '0x' + 'ab'.repeat(32), other = '0x' + 'cd'.repeat(32)

test('a keyed entry is found by its transaction hash, and the file holds no hash', () => {
  const key = overrideKey(overrideSecret(A), tx)
  const raw = { [key]: { w1: 'transfer' } }
  assert.ok(!JSON.stringify(raw).includes(tx.slice(2)))
  const o = overrideLookup(raw, A)
  assert.deepEqual(o[tx], { w1: 'transfer' })
  assert.deepEqual(o[tx.toUpperCase().replace('0X', '0x')], { w1: 'transfer' })
  assert.equal(o[other], undefined)
})

test('the key depends on every tracked address, in any order or case', () => {
  const k = overrideKey(overrideSecret(A), tx)
  assert.equal(overrideKey(overrideSecret([A[1].toUpperCase().replace('0X', '0x'), A[0]]), tx), k)
  assert.notEqual(overrideKey(overrideSecret([A[0]]), tx), k)
})

test('plain hash keys still work, and a malformed file stops the run', () => {
  assert.deepEqual(overrideLookup({ [tx]: { w2: 'internal' } }, A)[tx], { w2: 'internal' })
  assert.throws(() => overrideLookup({ nothash: { w1: 'transfer' } }, A))
  assert.throws(() => overrideLookup({ [tx]: { w1: 'gift' } }, A))
})

test('an entry no transaction looked up is reported, by its key only', () => {
  const key = overrideKey(overrideSecret(A), tx)
  const o = overrideLookup({ [key]: { w1: 'transfer' } }, A)
  assert.deepEqual(unmatchedOverrides(o), [key])
  void o[tx]
  assert.deepEqual(unmatchedOverrides(o), [])
  // Another set of wallets re-keys it: it no longer matches, and says so.
  const other = overrideLookup({ [key]: { w1: 'transfer' } }, [A[0]])
  assert.equal(other[tx], undefined)
  assert.deepEqual(unmatchedOverrides(other), [key])
})
