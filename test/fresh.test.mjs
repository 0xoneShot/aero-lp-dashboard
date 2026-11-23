import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { freshHead, headOf, leaveAsFound } from '../lib/fresh.mjs'
import { padFor, PAD_STEP, hushed, alertsLine, whyNotSent } from '../lib/public.mjs'

// A chain whose block b has the timestamp tsAt(b); the latest block is `tip`.
const chain = (tip, tsAt) => ({ getBlock: async ({ blockNumber } = {}) => { const b = blockNumber == null ? tip : Number(blockNumber); return { number: BigInt(b), timestamp: BigInt(tsAt(b)) } } })
// The moment a chain's latest block was made: the machine's clock a few seconds on.
const at = (c, tip, tsAt, secs, opts = {}) => freshHead(c ?? chain(tip, tsAt), secs, { now: tsAt(tip) + 5, ...opts })

test('a fresh head is the asked seconds behind the latest block, by the chain\'s own pace', async () => {
  // Five blocks a second, timestamps in whole seconds: 30 seconds are 150 blocks.
  assert.equal(await at(null, 9_000_000, (b) => 1_700_000_000 + Math.floor(b / 5), 30), 9_000_000 - 150)
  // A block every 12 seconds: 36 seconds are 3 blocks.
  assert.equal(await at(null, 500_000, (b) => 1_700_000_000 + 12 * b, 36), 500_000 - 3)
  // A block every 2 seconds: 30 seconds are 15 blocks.
  assert.equal(await at(null, 700_000, (b) => 1_700_000_000 + 2 * b, 30), 700_000 - 15)
})

test('slots without a block slow the pace read, never push the head closer to the tip', async () => {
  // Every tenth 12-second slot has no block: 200 blocks take 222 slots.
  const tsAt = (b) => 1_700_000_000 + 12 * (b + Math.floor(b / 9))
  const head = await at(null, 90_000, tsAt, 36)
  assert.equal(head, 90_000 - 3)
  assert.ok(tsAt(90_000) - tsAt(head) >= 36)
})

test('a fresh head is at least two blocks back, and never below the first block', async () => {
  // Blocks that all carry one timestamp say nothing of the pace.
  assert.equal(await at(null, 5_000, () => 1_700_000_000, 30), 5_000 - 200)
  // A pace far slower than the margin: still two blocks back.
  assert.equal(await at(null, 5_000, (b) => 1_700_000_000 + 600 * b, 30), 5_000 - 2)
  // A chain shorter than the look-back.
  assert.equal(await at(null, 1, (b) => 1_700_000_000 + 12 * b, 36), 0)
  assert.equal(await at(null, 0, () => 1_700_000_000, 36), 0)
})

test('a node whose latest block is minutes old is refused, not taken for fresh', async () => {
  const tsAt = (b) => 1_700_000_000 + 12 * b
  // Two slots without a block are still fresh; a node that stopped five minutes ago is not.
  assert.equal(await freshHead(chain(500_000, tsAt), 36, { now: tsAt(500_000) + 36 }), 500_000 - 3)
  await assert.rejects(freshHead(chain(500_000, tsAt), 36, { now: tsAt(500_000) + 300 }), /minutes old/)
  // By the machine's own clock when none is given: a block of years ago.
  await assert.rejects(freshHead(chain(500_000, tsAt), 36), /minutes old/)
})

// A node whose latest block `tip` was made `age` seconds ago, one block every 12 seconds, whose safe head is
// `safe`; `asked` lists what it was asked for.
function node(tip, safe, age = 5) {
  const now = Math.floor(Date.now() / 1000), asked = []
  const getBlock = async ({ blockNumber, blockTag } = {}) => {
    asked.push(blockTag ?? (blockNumber == null ? 'latest' : Number(blockNumber)))
    const b = blockTag ? safe : blockNumber == null ? tip : Number(blockNumber)
    return { number: BigInt(b), timestamp: BigInt(now - age - 12 * (tip - b)) }
  }
  return { asked, getBlock }
}

test('a pass reads a chain to its safe head; a fresh pass to seconds behind the latest block where the chain says so, never short of the safe head', async () => {
  const eth = { safeTag: 'safe', freshSecs: 36 }, base = { safeTag: 'safe' }
  // The hourly pass: the safe head, and the latest block is not even asked for.
  let n = node(500_000, 499_950)
  assert.equal(await headOf(n, eth, false), 499_950)
  assert.deepEqual(n.asked, ['safe'])
  // A fresh pass: three blocks behind the latest.
  assert.equal(await headOf(node(500_000, 499_950), eth, true), 499_997)
  // A node whose latest block is behind its own safe head (two nodes behind one address): the safe head.
  assert.equal(await headOf(node(499_940, 499_950), eth, true), 499_950)
  // A chain without freshSecs is read to its safe head by a fresh pass too.
  n = node(500_000, 499_990)
  assert.equal(await headOf(n, base, true), 499_990)
  assert.deepEqual(n.asked, ['safe'])
  // A node that stopped minutes ago: a fresh pass fails rather than quietly reading to the safe head (the page
  // would say it was fresh); the hourly pass, which never asks for the latest block, reads on.
  await assert.rejects(headOf(node(500_000, 499_950, 300), eth, true), /minutes old/)
  assert.equal(await headOf(node(500_000, 499_950, 300), eth, false), 499_950)
})

// src/run.mjs runs the whole pipeline when it is loaded, so no test runs it (test/e2e stands in for it). How it
// uses what is tested here is held as text: its code without the comments, which may name anything.
const runCode = fs.readFileSync(new URL('../src/run.mjs', import.meta.url), 'utf8').replace(/(^|\s)\/\/.*$/gm, '')
const runSays = (text) => assert.ok(runCode.includes(text), `src/run.mjs no longer says: ${text}`)

test('every chain\'s head is read before anything is scanned, and each scan is given its own', () => {
  // By headOf, told which kind of pass this is. A head read after another chain's scan would tell how long that
  // scan took (src/run.mjs).
  runSays('for (const c of Object.values(CHAINS)) heads[c.key] = await headOf(clientOf(c), c, FRESH)')
  assert.ok(runCode.lastIndexOf('await headOf(') < runCode.indexOf('await scan('), 'src/run.mjs reads a head after a scan has begun')
  // A scan given no head reads the safe head itself (lib/scan.mjs): after the scans before it, and never a fresh one.
  for (const text of ['const baseHead = heads.base', 'await scan({ head: baseHead })', 'h = heads[c.key]', 'await scan({ head: h, chain: c })']) runSays(text)
  assert.ok(!runCode.includes('blockTag'), 'src/run.mjs asks a node for a tagged block itself')
})

test('the stock samples\' age is counted from the pass\'s own head, whatever moment its rates are read as of', () => {
  // lib/stocks.mjs stockRows takes ageTs (test/stocks.test.mjs); src/run.mjs has to pass it.
  runSays('ageTs: tsOfBlock(head)')
})

test('in the job a fresh pass and its checks print nothing, and no other pass is hushed', () => {
  // Held as text: what src/update.mjs does is run from end to end by test/e2e alone, which the job does not run.
  const src = fs.readFileSync(new URL('../src/update.mjs', import.meta.url), 'utf8')
  assert.match(src, /^const HUSH = FRESH && PUBLIC_LOG$/m)
  // Every process it starts goes through the one spawn, which is silent exactly then.
  assert.deepEqual([...src.matchAll(/\bspawn\(.*$/gm)].map((m) => m[0].match(/stdio: (.*) \}\)$/)?.[1]), ["HUSH ? 'ignore' : 'inherit'"])
})

test('a directory is left as it was found, whatever was done to it meanwhile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-test-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), 'one')
    fs.mkdirSync(path.join(dir, 'sub'))
    fs.writeFileSync(path.join(dir, 'sub', 'b.json'), 'two')
    const got = await leaveAsFound(dir, async () => {
      fs.writeFileSync(path.join(dir, 'a.json'), 'changed')
      fs.rmSync(path.join(dir, 'sub'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'new.json'), 'new')
      return 7
    })
    assert.equal(got, 7)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a.json', 'sub'])
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'one')
    assert.equal(fs.readFileSync(path.join(dir, 'sub', 'b.json'), 'utf8'), 'two')
    // Thrown out of: put back all the same, and the error passed on.
    await assert.rejects(leaveAsFound(dir, async () => { fs.writeFileSync(path.join(dir, 'a.json'), 'changed'); throw new Error('stopped') }), /stopped/)
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'one')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a directory that was not there is gone again afterwards', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aero-test-')), 'cache')
  await leaveAsFound(dir, async () => { fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'x.json'), 'x') })
  assert.equal(fs.existsSync(dir), false)
  fs.rmSync(path.dirname(dir), { recursive: true, force: true })
})

for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`stopped from outside (${sig}), what was started is stopped first and the directory is still put back`, async () => {
    // The directory, a temporary directory for the process alone, and a note its stop leaves outside both.
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-test-')), dir = path.join(top, 'cache'), tmp = path.join(top, 'tmp'), seen = path.join(top, 'seen')
    let p
    try {
      for (const d of [dir, tmp]) fs.mkdirSync(d)
      fs.writeFileSync(path.join(dir, 'a.json'), 'one')
      const lib = fileURLToPath(new URL('../lib/fresh.mjs', import.meta.url))
      // A process that changes the directory and then waits for ever, as a pass that hangs would. Its stop
      // takes a moment, as ending a child does, and notes what it found in the directory.
      const script = `import fs from 'node:fs'; import { leaveAsFound } from ${JSON.stringify(lib)};
        await leaveAsFound(${JSON.stringify(dir)}, async () => { fs.writeFileSync(${JSON.stringify(path.join(dir, 'a.json'))}, 'changed'); fs.writeFileSync(${JSON.stringify(path.join(dir, 'new.json'))}, 'x'); console.log('changed'); await new Promise(() => { setInterval(() => {}, 1000) }) },
          { stop: async () => { await new Promise((r) => setTimeout(r, 50)); fs.writeFileSync(${JSON.stringify(seen)}, fs.readFileSync(${JSON.stringify(path.join(dir, 'a.json'))}, 'utf8')); fs.writeFileSync(${JSON.stringify(path.join(dir, 'stopped.json'))}, 'while stopping') } })`
      // Its own TMPDIR; and one that does not end when told to is ended after 20 s, so the test fails on its
      // exit code instead of waiting for ever. One that ends before its first line (it could not start, or those
      // 20 s ran out first) fails the test there and then: nothing else would ever end that wait.
      p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: tmp }, timeout: 20_000, killSignal: 'SIGKILL' })
      await new Promise((resolve, reject) => { p.stdout.once('data', resolve); p.once('exit', (c, s) => reject(new Error(`ended before it had changed anything (${c ?? s})`))) })
      assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'changed')
      const exit = new Promise((resolve) => p.once('exit', (c) => resolve(c)))
      p.kill(sig)
      assert.equal(await exit, code)
      // Stopped first, and to the end: the stop found the directory as the pass had left it.
      assert.equal(fs.existsSync(seen) && fs.readFileSync(seen, 'utf8'), 'changed')
      // As it was found: what the pass and its stopping wrote is gone, and so is the copy it was put back from.
      assert.deepEqual(fs.readdirSync(dir), ['a.json'])
      assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'one')
      assert.deepEqual(fs.readdirSync(tmp), [])
    } finally { p?.kill('SIGKILL'); fs.rmSync(top, { recursive: true, force: true }) }
  })
}

// Two moments a signal can come at once the work is done: as the work's last act, and in the middle of the
// put-back itself (the copy back into the directory is where it is raised). The work ends from an I/O callback
// (fs.stat here; a child's exit in src/update.mjs): the first setImmediate after one runs before the loop has
// read a signal, so waiting a single turn of the loop would lose it. Handlers taken off before the put-back
// would let the signal end the process in the middle of the copy; taken off right after it, before the loop
// has had its turns, the signal would be lost and the process would go on as if never told.
const DIR_MARK = '__DIR__'
for (const [when, setup, last] of [
  ['just as the work ends', '', "process.kill(process.pid, 'SIGTERM')"],
  ['while the directory is being put back', `const cp = fs.cpSync; fs.cpSync = (...a) => { if (a[1] === ${DIR_MARK}) process.kill(process.pid, 'SIGTERM'); return cp(...a) }`, ''],
]) {
  test(`a signal that comes ${when} waits until the directory is back, and is then heeded`, async () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-test-')), dir = path.join(top, 'cache'), tmp = path.join(top, 'tmp')
    try {
      for (const d of [dir, tmp]) fs.mkdirSync(d)
      fs.writeFileSync(path.join(dir, 'a.json'), 'one')
      const lib = fileURLToPath(new URL('../lib/fresh.mjs', import.meta.url)), DIR = JSON.stringify(dir)
      const script = `import fs from 'node:fs'; import { leaveAsFound } from ${JSON.stringify(lib)};
        ${setup.replaceAll(DIR_MARK, DIR)}
        await leaveAsFound(${DIR}, async () => { fs.writeFileSync(${JSON.stringify(path.join(dir, 'a.json'))}, 'changed'); fs.writeFileSync(${JSON.stringify(path.join(dir, 'new.json'))}, 'x'); await new Promise((r) => fs.stat(${DIR}, r)); ${last} })
        console.log('went on')`
      const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: tmp }, timeout: 20_000, killSignal: 'SIGKILL' })
      let out = ''
      p.stdout.on('data', (d) => { out += d })
      const [code, signal] = await new Promise((resolve) => p.once('exit', (c, s) => resolve([c, s])))
      assert.deepEqual([code, signal, out], [143, null, ''])
      assert.deepEqual(fs.readdirSync(dir), ['a.json'])
      assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'one')
      assert.deepEqual(fs.readdirSync(tmp), [])
    } finally { fs.rmSync(top, { recursive: true, force: true }) }
  })
}

// Heard just as the work ends, and heard while it runs with the work ending before the stop is through. In both
// the stop takes a moment and then writes into the directory, as something still being ended might.
for (const when of ['just as the work ends', 'while the work runs, which ends before the stop is through']) {
  test(`a signal heard ${when}: a stop that takes its time never lets the caller go on`, async () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-test-')), dir = path.join(top, 'cache'), tmp = path.join(top, 'tmp')
    let p
    try {
      for (const d of [dir, tmp]) fs.mkdirSync(d)
      fs.writeFileSync(path.join(dir, 'a.json'), 'one')
      const lib = fileURLToPath(new URL('../lib/fresh.mjs', import.meta.url))
      const a = JSON.stringify(path.join(dir, 'a.json')), stopped = JSON.stringify(path.join(dir, 'stopped.json'))
      const work = when === 'just as the work ends'
        // The work changes the directory and, as its last act, the process is told to end.
        ? `async () => { fs.writeFileSync(${a}, 'changed'); console.log('changed'); process.kill(process.pid, 'SIGTERM') }`
        // The work changes the directory and runs until it is stopped; the test sends the signal.
        : `async () => { fs.writeFileSync(${a}, 'changed'); console.log('changed'); await new Promise((r) => { end = r; setInterval(() => {}, 1000) }) }`
      // A caller that goes on after the work (as src/update.mjs does, to its second try) says so.
      const script = `import fs from 'node:fs'; import { leaveAsFound } from ${JSON.stringify(lib)};
        let end = () => {}
        await leaveAsFound(${JSON.stringify(dir)}, ${work},
          { stop: async () => { end(); await new Promise((r) => setTimeout(r, 50)); fs.writeFileSync(${stopped}, 'while stopping') } })
        console.log('went on')`
      p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: tmp }, timeout: 20_000, killSignal: 'SIGKILL' })
      let out = ''
      const exit = new Promise((resolve) => p.once('exit', (c, s) => resolve([c, s])))
      await new Promise((resolve, reject) => { p.stdout.on('data', (d) => { out += d; resolve() }); p.once('exit', (c, s) => reject(new Error(`ended before it had changed anything (${c ?? s})`))) })
      if (when !== 'just as the work ends') p.kill('SIGTERM')
      assert.deepEqual([...await exit, out], [143, null, 'changed\n'])
      assert.deepEqual(fs.readdirSync(dir), ['a.json'])
      assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'one')
      assert.deepEqual(fs.readdirSync(tmp), [])
    } finally { p?.kill('SIGKILL'); fs.rmSync(top, { recursive: true, force: true }) }
  })
}

test('an update ends on its padded time: the floor, then whole steps', () => {
  const floor = 60, s = 1000
  // Any run within the floor ends on it: one that read nothing and one that had something to read alike.
  for (const ran of [0, 1, 18 * s, 41 * s, 59_999, 60 * s]) assert.equal(ran + padFor(ran, floor), 60 * s)
  // Past the floor, on the next whole step.
  assert.equal(60_001 + padFor(60_001, floor), (60 + PAD_STEP) * s)
  assert.equal((60 + PAD_STEP) * s + padFor((60 + PAD_STEP) * s, floor), (60 + PAD_STEP) * s)
  assert.equal(100 * s + padFor(100 * s, floor), (60 + 3 * PAD_STEP) * s)
  // It never ends earlier than it would have, and never waits a whole step for nothing.
  for (let ran = 0; ran < 200 * s; ran += 777) { const w = padFor(ran, floor); assert.ok(w >= 0 && (ran <= floor * s || w < PAD_STEP * s)) }
  // No floor (a local run): no wait.
  for (const f of [0, undefined, NaN, -5]) assert.equal(padFor(30 * s, f), 0)
})

test('a check that fails in the public log says which check, not the figures it compared', async () => {
  const check = () => { assert.equal(1234567n, 1234568n, 'base w1: a transaction\'s ETH does not add up 0x' + 'ab'.repeat(32)) }
  // As written, elsewhere: the figures are in the failure.
  assert.throws(hushed(check, false), (e) => e.actual === 1234567n && /0xabab/.test(e.message))
  // In the public log: the words only.
  await assert.rejects(hushed(check, true)(), (e) => {
    assert.equal(e.message, 'base w1: a transaction\'s ETH does not add up …')
    assert.ok(!('actual' in e) && !('expected' in e))
    return true
  })
  await assert.rejects(hushed(() => { assert.ok(false, 'total: value: 1234.56 vs 1234.5 at 0.5-999') }, true)(), /^Error: total: value: … vs … at …-…$/)
  // Whole amounts of three digits go too; a wallet's key keeps its number (which check failed is still said).
  await assert.rejects(hushed(() => { assert.ok(false, 'base w12: value: 512 vs 498') }, true)(), /^Error: base w12: value: … vs …$/)
  // A check that passes is left alone, with what it returns.
  assert.equal(await hushed(async () => 5, true)(), 5)
})

test('in the public log the alert step says whether everything went, never how many', () => {
  const said = new Set()
  for (const topic of ['t', undefined]) for (const updated of [true, false]) for (let total = 0; total <= 40; total++) for (let sent = 0; sent <= total; sent++) for (const left of [0, total - sent]) {
    const line = alertsLine({ pub: true, topic, sent, total, left, updated })
    assert.doesNotMatch(line, /\d/, line)
    said.add(line)
  }
  // An hour with nothing to send reads as one that sent everything.
  assert.equal(alertsLine({ pub: true, topic: 't', sent: 0, total: 0 }), alertsLine({ pub: true, topic: 't', sent: 7, total: 7 }))
  assert.equal(alertsLine({ pub: true, topic: undefined, sent: 0, total: 9 }), 'alerts: off')
  assert.deepEqual([...said].sort(), ['(from the last good data) alerts: done', '(from the last good data) alerts: not all sent', '(from the last good data) alerts: not all sent (out of time: the rest goes next run)', '(from the last good data) alerts: off', 'alerts: done', 'alerts: not all sent', 'alerts: not all sent (out of time: the rest goes next run)', 'alerts: off'])
  // Why the first message that did not go failed is said in fixed words; of what an error carries only ntfy's
  // three-digit status and the cause's code get through, the code only as a bare name (capitals, underscores).
  assert.equal(alertsLine({ pub: true, topic: 't', sent: 1, total: 3, why: 'ntfy answered 429' }), 'alerts: not all sent (ntfy answered 429)')
  assert.equal(alertsLine({ pub: true, topic: 't', sent: 3, total: 3, why: 'ntfy answered 429' }), 'alerts: done')
  assert.equal(whyNotSent(new Error('ntfy answered 429')), 'ntfy answered 429')
  assert.equal(whyNotSent(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), 'ntfy timed out')
  assert.equal(whyNotSent(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })), 'ntfy not reached: ECONNREFUSED')
  assert.equal(whyNotSent(new TypeError('fetch failed')), 'ntfy not reached')
  for (const e of [new Error('ntfy answered 429 for w1 at 1234.5'), Object.assign(new Error('x'), { cause: { code: 'w1 0xabc 1234' } }), 'w1: 1234', null]) assert.equal(whyNotSent(e), 'ntfy not reached')
  for (const code of ['E2BIG', 'ERR_HTTP2_ERROR', 'Econnrefused', 'AB', 'A'.repeat(41), 'ECONNREFUSED\n', 1234]) assert.equal(whyNotSent(Object.assign(new TypeError('fetch failed'), { cause: { code } })), 'ntfy not reached')
  // Elsewhere, the counts as before.
  assert.equal(alertsLine({ pub: false, topic: 't', sent: 2, total: 3, left: 1 }), 'alerts: 2 of 3 sent (1 left for the next run: out of time)')
  assert.equal(alertsLine({ pub: false, topic: undefined, sent: 0, total: 3 }), 'alerts: off (3 would have been sent)')
})
