import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTimeline, formulaTs, cstDayStartTs, nextDay } from '../lib/time.mjs'

// A chain of 2-second blocks that switches to 200 ms blocks (five per second, whole-second
// timestamps) after block FORK.
const FORK = 60_000_000
const tsAt = (b) => (b <= FORK ? formulaTs(b) : formulaTs(FORK) + Math.floor((b - FORK) / 5))
const fakeClient = () => {
  const calls = { n: 0 }
  return { calls, getBlock: async ({ blockNumber }) => { calls.n++; return { timestamp: BigInt(tsAt(Number(blockNumber))) } } }
}
// The last block before ts, by brute force over the right neighbourhood.
const lastBefore = (ts, head) => {
  let b = ts <= formulaTs(FORK) ? Math.floor((ts - 1 - formulaTs(0)) / 2) : FORK + (ts - formulaTs(FORK)) * 5 - 1
  while (b + 1 <= head && tsAt(b + 1) < ts) b++
  while (tsAt(b) >= ts) b--
  return b
}

test('before a change of block time, one block is read and day ends are arithmetic', async () => {
  const c = fakeClient(), head = FORK - 1000
  const t = await createTimeline(c, head)
  assert.equal(t.exactTo, head)
  assert.equal(c.calls.n, 1)
  const day = '2026-10-20'
  assert.equal(await t.dayEndBlock(day), Math.floor((cstDayStartTs(nextDay(day)) - 1 - formulaTs(0)) / 2))
  assert.equal(c.calls.n, 1)
})

test('after the change, the fork is found and day ends and times come from the chain', async () => {
  const c = fakeClient(), head = FORK + 5 * 86400 * 3 // three days of 200 ms blocks
  const t = await createTimeline(c, head)
  assert.equal(t.exactTo, FORK)
  const forkDay = new Date((formulaTs(FORK) + 8 * 3600) * 1000).toISOString().slice(0, 10)
  for (let d = forkDay, i = 0; i < 3; d = nextDay(d), i++) {
    const end = await t.dayEndBlock(d), T = cstDayStartTs(nextDay(d))
    assert.equal(end, lastBefore(T, head), d)
    assert.ok(t.tsOf(end) < T && tsAt(end + 1) >= T, d)
  }
  await t.ensure([FORK + 12345])
  assert.equal(t.tsOf(FORK + 12345), tsAt(FORK + 12345))
  assert.equal(t.tsOf(FORK - 7), formulaTs(FORK - 7))
  assert.throws(() => t.tsOf(FORK + 999), /no timestamp/)
})

test('what was found is cached for the next run', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-')), 'timeline.json')
  const head = FORK + 5 * 86400
  const first = await createTimeline(fakeClient(), head, file)
  const end = await first.dayEndBlock(new Date((formulaTs(FORK) + 8 * 3600) * 1000).toISOString().slice(0, 10))
  first.save()
  const c = fakeClient()
  const again = await createTimeline(c, head, file)
  assert.equal(again.exactTo, FORK)
  assert.equal(again.tsOf(end), tsAt(end))
  assert.equal(c.calls.n, 0)
})
