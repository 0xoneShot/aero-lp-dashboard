// src/update.mjs from end to end, without a chain: the pipeline and the checks on a fresh pass are stood in
// for (fixtures/), everything else is the entry point as the job runs it, in a working directory of its own
// with made-up wallets. Run with `npm run test:e2e` after changing src/update.mjs or lib/fresh.mjs: these
// start processes and wait out padded times, so they are kept out of `npm test`, which the job runs before
// every publish.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../../lib/scan.mjs'

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const UPDATE = here('../../src/update.mjs')
const A = '0x' + '11'.repeat(20), X = '0x' + '22'.repeat(20)
const NONE = JSON.stringify({ wallets: [] })
const ONE = JSON.stringify({ startDay: '2026-01-01', scanFromBlock: 1, wallets: [{ key: 'w1', label: 'one', address: A }] })

// A working directory with a kept cache, as the hourly pass leaves it. Each is removed when its test is through
// (done below), and whatever a failed test left when the file is.
const made = new Set()
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })
function workdir({ version = VERSION, scannedTo = 1000, extras = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-update-'))
  made.add(dir)
  fs.mkdirSync(path.join(dir, 'data/cache'), { recursive: true })
  for (const f of ['scan.json', 'scan-eth.json']) fs.writeFileSync(path.join(dir, 'data/cache', f), JSON.stringify({ version, scannedTo, wallets: {}, txs: {} }))
  fs.writeFileSync(path.join(dir, 'data/cache/alerts.json'), '{"kept":true}')
  if (extras) fs.writeFileSync(path.join(dir, 'data/cache/extras.json'), JSON.stringify({ v: 1, next: { g: 1 }, extras: [{ key: 'x0000abcd', address: X, label: 'added' }], groups: [], inbox: {}, letGo: [], log: [] }))
  return dir
}
const cacheOf = (dir) => Object.fromEntries(fs.readdirSync(path.join(dir, 'data/cache')).sort().map((f) => [f, fs.readFileSync(path.join(dir, 'data/cache', f), 'utf8')]))
// Runs the entry point there; resolves to its exit code, what it printed, how long it took, whether anything
// it started was still running when it ended (`left`), and the copies of the cache it left in its temporary
// directory (`kept`: the working directory). It runs as the leader of a process group of its own, so whatever
// it leaves behind can be found and ended: a child left running holds this test's pipes open, and the suite
// would never end. One that does not end by itself is ended after `limit` ms. It is told to end (SIGTERM)
// once it has printed `signalAfter`, or once `signalWhen()` holds.
function update(dir, env = {}, { signalAfter, signalWhen, limit = 60_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const base = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: dir, AERO_CONFIG: NONE, AERO_TEST_PIPELINE: here('./fixtures/pipeline.mjs'), AERO_TEST_CHECK: here('./fixtures/check.test.mjs'), GITHUB_ACTIONS: '' }
    const p = spawn(process.execPath, [UPDATE], { cwd: dir, env: { ...base, ...env }, detached: true })
    const group = (sig) => { try { process.kill(-p.pid, sig); return true } catch { return false } }
    const timer = setTimeout(() => group('SIGKILL'), limit)
    const watch = signalWhen ? setInterval(() => { if (signalWhen()) { clearInterval(watch); p.kill('SIGTERM') } }, 20) : null
    const closed = new Promise((r) => p.once('close', r))
    let out = ''
    p.stdout.on('data', (d) => { out += d; if (signalAfter && out.includes(signalAfter)) { signalAfter = null; p.kill('SIGTERM') } })
    p.stderr.on('data', (d) => { out += d })
    p.on('exit', async (code, signal) => {
      clearTimeout(timer); clearInterval(watch)
      const ms = Date.now() - t0
      // A process told to end as the entry point went is gone some ms after it: only what is still there a
      // second later was left running.
      for (let i = 0; i < 100 && group(0); i++) await new Promise((r) => setTimeout(r, 10))
      const left = group(0)
      if (left) group('SIGKILL')
      // All it printed has been read once its pipes are closed.
      await Promise.race([closed, new Promise((r) => setTimeout(r, 2000))])
      resolve({ code, signal, out, ms, left, kept: fs.readdirSync(dir).filter((f) => f.startsWith('aero-kept-')) })
    })
  })
}
const runsIn = (dir) => (fs.existsSync(path.join(dir, 'runs')) ? Number(fs.readFileSync(path.join(dir, 'runs'), 'utf8')) : 0)
const envsIn = (dir) => fs.readFileSync(path.join(dir, 'envs'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const done = (dir) => fs.rmSync(dir, { recursive: true, force: true })
// What a fresh pass says in the job, and all it says: with a kept scan to start from, WENT, FAILED, or AGAIN
// and then one of the two; without one, NOSCAN alone (which tells of the cache, not of a wallet).
const WENT = '[update] the fresh pass went through\n', AGAIN = '[update] the fresh pass failed: once more\n', FAILED = '[update] the fresh pass failed: nothing of it is published\n'
const NOSCAN = '[update] no kept scan to start from yet: the fresh pass waits for the hourly one\n'
// The floor of a padded update in these tests, in seconds (the job's are a minute and more).
const PAD = 3

test('the hourly pass runs the pipeline here and keeps what it wrote', async () => {
  const dir = workdir()
  const r = await update(dir)
  assert.equal(r.code, 0, r.out)
  assert.equal(JSON.parse(cacheOf(dir)['scan.json']).scannedTo, 1100)
  assert.ok('written-by-the-pass.json' in cacheOf(dir))
  assert.deepEqual(envsIn(dir), [{ fresh: null, pause: null, child: null, step: null, catchUp: null }])
  // One that fails ends with 1, and says why (here, where nothing is public, in full).
  const bad = await update(dir, { STUB: 'fail' })
  assert.equal(bad.code, 1)
  assert.match(bad.out, /stub: the pass failed at block 99999999 with 0xabcdef0123456789/)
  done(dir)
})

test('a fresh pass publishes its data and leaves the cache exactly as it found it', async () => {
  const dir = workdir(), before = cacheOf(dir)
  const r = await update(dir, { AERO_FRESH: '1' })
  assert.equal(r.code, 0, r.out)
  // Its data is there, read past where the kept scan stood...
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out/summary.json'), 'utf8')), [{ scope: 'total', run: 1, scanned: 1100 }])
  // ...its scan was checked while it still stood (test/fixtures/check.test.mjs fails otherwise)...
  assert.equal(fs.readFileSync(path.join(dir, 'checks'), 'utf8'), 'x')
  // ...and nothing of it is kept.
  assert.deepEqual(cacheOf(dir), before)
  // In a child, told it is a fresh pass, with no time for catching anyone up and a limit of its own, from
  // the pass's start, for the scan of an added address in step.
  assert.deepEqual(envsIn(dir), [{ fresh: '1', pause: null, child: '1', step: '3', catchUp: '0' }])
  // The next one starts from the same kept scan, not from where this one got to.
  await update(dir, { AERO_FRESH: '1' })
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out/summary.json'), 'utf8'))[0].scanned, 1100)
  assert.deepEqual(cacheOf(dir), before)
  done(dir)
})

test('a fresh pass that fails is tried once more from the same kept cache; failing again, it ends with 1 and the cache as it was', async () => {
  const dir = workdir(), before = cacheOf(dir)
  const once = await update(dir, { AERO_FRESH: '1', STUB: 'fail-once' })
  assert.equal(once.code, 0, once.out)
  assert.equal(runsIn(dir), 2)
  assert.match(once.out, /the fresh pass failed: once more/)
  // The second try read from the kept scan again (1000), not from what the failed one left (1100).
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out/summary.json'), 'utf8'))[0].scanned, 1100)
  assert.deepEqual(cacheOf(dir), before)
  const twice = await update(dir, { AERO_FRESH: '1', STUB: 'fail' })
  assert.equal(twice.code, 1)
  assert.equal(runsIn(dir), 4) // two more, and no third
  assert.match(twice.out, /the fresh pass failed: nothing of it is published/)
  assert.deepEqual(cacheOf(dir), before)
  done(dir)
})

test('a fresh pass whose scan does not pass the checks is not published', async () => {
  const dir = workdir(), before = cacheOf(dir)
  const r = await update(dir, { AERO_FRESH: '1', CHECK: 'fail' })
  assert.equal(r.code, 1)
  assert.equal(runsIn(dir), 2) // tried once more
  assert.deepEqual(cacheOf(dir), before)
  // On one's own machine it says which check, and why.
  assert.match(r.out, /the checks were told to fail/)
  done(dir)
})

test('without a finished kept scan of this version on every chain a fresh pass does not start', async () => {
  const makes = [
    () => workdir({ version: VERSION - 1 }),
    // A chain whose first scan was stopped before it was through: every fresh pass would read its whole history.
    () => workdir({ scannedTo: null }),
    () => { const d = workdir(); fs.rmSync(path.join(d, 'data/cache/scan-eth.json')); return d },
    () => { const d = workdir(); fs.rmSync(path.join(d, 'data/cache'), { recursive: true }); return d },
  ]
  // On one's own machine and in the job alike: that one line, and the pipeline never started.
  for (const make of makes) for (const job of ['', 'true']) {
    const dir = make()
    const r = await update(dir, { AERO_FRESH: '1', GITHUB_ACTIONS: job })
    assert.equal(r.code, 1)
    assert.equal(runsIn(dir), 0)
    assert.equal(r.out, NOSCAN)
    done(dir)
  }
})

test('in the job a failed hourly pass says what failed without its figures', async () => {
  const dir = workdir()
  // The words and where in the code, no block or hash; the whole text goes into the cache.
  const hourly = await update(dir, { STUB: 'fail', GITHUB_ACTIONS: 'true' })
  assert.equal(hourly.code, 1)
  assert.match(hourly.out, /stub: the pass failed at block … with 0x…/)
  assert.match(hourly.out, /at .*fixtures\/pipeline\.mjs:\d+:\d+/) // a place in the code keeps its numbers
  assert.doesNotMatch(hourly.out, /99999999|abcdef0123456789/)
  assert.match(JSON.parse(cacheOf(dir)['last-error.json']).text, /99999999/)
  done(dir)
})

test('in the job a fresh pass says only whether it went through: nothing the pass or its checks print', async () => {
  const JOB = { AERO_FRESH: '1', GITHUB_ACTIONS: 'true' }
  const dir = workdir(), before = cacheOf(dir)
  // One that goes well: one line, though the pass and its checks did their work.
  const well = await update(dir, JOB)
  assert.equal(well.code, 0, well.out)
  assert.equal(well.out, WENT)
  assert.equal(fs.readFileSync(path.join(dir, 'checks'), 'utf8'), 'x')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out/summary.json'), 'utf8'))[0].scanned, 1100)
  // One whose pass fails, and one whose checks fail, read the same: not how far the pass got (the line the
  // stand-in prints before it throws), not the error, not which check or why. Nothing is kept of the error.
  // Nor does the step's exit code, which the job's log shows too, say how the pass's process ended: with a
  // code of its own, or Node's for an await that never settles.
  for (const env of [{ STUB: 'fail' }, { STUB: 'exit' }, { STUB: 'unsettled' }, { CHECK: 'fail' }]) {
    const r = await update(dir, { ...JOB, ...env })
    assert.equal(r.code, 1, JSON.stringify(env))
    assert.equal(r.out, AGAIN + FAILED, JSON.stringify(env))
    assert.deepEqual(cacheOf(dir), before)
  }
  // One that failed and then went through.
  fs.rmSync(path.join(dir, 'runs'))
  const second = await update(dir, { ...JOB, STUB: 'fail-once' })
  assert.equal(second.code, 0)
  assert.equal(second.out, AGAIN + WENT)
  // One that ran out of its time, in the pass or in the checks: the sentence of any failure (how long the
  // step took shows it anyway).
  for (const env of [{ STUB: 'hang' }, { CHECK: 'hang' }]) {
    const late = await update(dir, { ...JOB, ...env, FRESH_MINUTES: '0.05' }, { limit: 20_000 })
    assert.equal(late.code, 1, JSON.stringify(env))
    assert.equal(late.out, FAILED, JSON.stringify(env))
    assert.equal(late.left, false, 'something the pass started was still running')
    assert.deepEqual(late.kept, [])
    assert.deepEqual(cacheOf(dir), before)
  }
  done(dir)
})

test('a fresh pass whose cache cannot be set aside ends like any failed one, on its padded time', async () => {
  const dir = workdir(), before = cacheOf(dir), nowhere = path.join(dir, 'not-there')
  // Nowhere to keep the copy of the cache (lib/fresh.mjs leaveAsFound): the pass does not start.
  const r = await update(dir, { AERO_FRESH: '1', GITHUB_ACTIONS: 'true', AERO_PAD_SECONDS: String(PAD), TMPDIR: nowhere })
  assert.equal(r.code, 1)
  assert.equal(r.out, FAILED)
  assert.ok(r.ms >= PAD * 1000, `ended after ${r.ms} ms, before its padded time`)
  assert.equal(runsIn(dir), 0)
  assert.deepEqual(cacheOf(dir), before)
  // On one's own machine it says why as well.
  const local = await update(dir, { AERO_FRESH: '1', TMPDIR: nowhere })
  assert.equal(local.code, 1)
  assert.match(local.out, /ENOENT[^\n]*mkdtemp/)
  assert.match(local.out, /\[update\] the fresh pass failed: nothing of it is published\n/)
  done(dir)
})

test('an update ends on its padded time, whether it had much to do or failed at once', async () => {
  const dir = workdir()
  // Never before the floor; and on it, unless this machine is so slow that the work itself took longer (then
  // on a later step, which still passes here).
  for (const env of [{}, { STUB: 'fail' }, { AERO_FRESH: '1' }, { AERO_FRESH: '1', STUB: 'fail' }, { AERO_FRESH: '1', STUB: 'fail', GITHUB_ACTIONS: 'true' }]) {
    const r = await update(dir, { ...env, AERO_PAD_SECONDS: String(PAD) })
    assert.ok(r.ms >= PAD * 1000, `${JSON.stringify(env)} ended after ${r.ms} ms, before its padded time`)
    assert.ok(r.ms < (PAD + 15 + 5) * 1000, `${JSON.stringify(env)} took ${r.ms} ms`)
  }
  // Without a floor it does not wait at all (a padded step would be 15 s).
  const t = await update(dir)
  assert.ok(t.ms < 10_000, `without a floor it took ${t.ms} ms`)
  done(dir)
})

test('a fresh pass stopped from outside ends its child and still puts the cache back', async () => {
  const dir = workdir(), before = cacheOf(dir)
  const r = await update(dir, { AERO_FRESH: '1', STUB: 'hang' }, { signalAfter: '[stub] hanging' })
  assert.equal(r.code, 143)
  assert.deepEqual(cacheOf(dir), before)
  // The child is gone. One left behind is ended here (it would hold this test's pipes open).
  const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'))
  let alive = true
  try { process.kill(pid, 0) } catch (e) { alive = e.code !== 'ESRCH' }
  if (alive) try { process.kill(pid, 'SIGKILL') } catch {}
  assert.ok(!alive, 'the pass\'s child was left running')
  assert.equal(r.left, false, 'something the pass started was still running')
  assert.deepEqual(r.kept, [])
  done(dir)
})

test('a fresh pass stopped from outside during its checks ends them, test process and all, and still puts the cache back', async () => {
  // On one's own machine and in the job. The stand-in check leaves `checks` just before it hangs: by then the
  // checks' runner (node --test) and the process it started for the test file are both running.
  for (const env of [{}, { GITHUB_ACTIONS: 'true' }]) {
    const dir = workdir(), before = cacheOf(dir)
    const r = await update(dir, { AERO_FRESH: '1', CHECK: 'hang', ...env }, { signalWhen: () => fs.existsSync(path.join(dir, 'checks')), limit: 20_000 })
    assert.equal(r.code, 143, JSON.stringify(env) + r.out)
    assert.deepEqual(cacheOf(dir), before)
    assert.equal(r.left, false, 'something the pass started was still running')
    assert.deepEqual(r.kept, [])
    done(dir)
  }
})

test('a fresh pass that never ends is stopped at its own time limit, not tried again, and the cache is put back', async () => {
  // In the pipeline, and in the checks on what it scanned.
  for (const env of [{ STUB: 'hang' }, { CHECK: 'hang' }]) {
    const dir = workdir(), before = cacheOf(dir)
    const r = await update(dir, { AERO_FRESH: '1', FRESH_MINUTES: '0.05', ...env }, { limit: 20_000 })
    assert.equal(r.code, 1, JSON.stringify(env) + r.out)
    assert.equal(runsIn(dir), 1)
    assert.match(r.out, /the fresh pass ran out of time: nothing of it is published/)
    assert.deepEqual(cacheOf(dir), before)
    assert.equal(r.left, false, 'something the pass started was still running')
    assert.deepEqual(r.kept, [])
    done(dir)
  }
})

test('with under a minute of its time left a fresh pass that failed is not tried again', async () => {
  const dir = workdir(), before = cacheOf(dir)
  const r = await update(dir, { AERO_FRESH: '1', STUB: 'fail', FRESH_MINUTES: '0.5' })
  assert.equal(r.code, 1)
  assert.equal(runsIn(dir), 1)
  assert.match(r.out, /the fresh pass failed: nothing of it is published/)
  assert.deepEqual(cacheOf(dir), before)
  done(dir)
})

test('with an address added on the page, the hourly pass runs with it in a child, and again without it when that fails', async () => {
  const dir = workdir({ extras: true })
  const ok = await update(dir, { AERO_CONFIG: ONE })
  assert.equal(ok.code, 0, ok.out)
  assert.deepEqual(envsIn(dir).map((e) => [e.child, e.pause]), [['1', null]])
  assert.equal(JSON.parse(cacheOf(dir)['extras-health.json']).runs.at(-1).ok, true)
  fs.rmSync(path.join(dir, 'envs'))
  // Failing with it: once more without it, and the trouble is recorded as the added address's.
  fs.rmSync(path.join(dir, 'runs'))
  const twice = await update(dir, { AERO_CONFIG: ONE, STUB: 'fail-once' })
  assert.equal(twice.code, 0, twice.out)
  assert.deepEqual(envsIn(dir).map((e) => [e.child, e.pause]), [['1', null], ['1', '1']])
  assert.match(twice.out, /running it again without them/)
  const last = JSON.parse(cacheOf(dir)['extras-health.json']).runs.at(-1)
  assert.deepEqual([last.ok, last.why], [false, 'error'])
  // In the job too both runs say their own lines, and the one that failed says why, without its figures: only a
  // fresh pass is hushed there (src/update.mjs HUSH), and why an hourly pass failed is looked for in this log.
  fs.rmSync(path.join(dir, 'runs'))
  const job = await update(dir, { AERO_CONFIG: ONE, STUB: 'fail-once', GITHUB_ACTIONS: 'true' })
  assert.equal(job.code, 0, job.out)
  assert.match(job.out, /\[stub\] pass 1 read to/)
  assert.match(job.out, /stub: the pass failed at block … with 0x…/)
  assert.doesNotMatch(job.out, /99999999|abcdef0123456789/)
  assert.match(job.out, /\[stub\] wrote out\//)
  // A fresh pass with it: one child, no run without it, no record of how it went, the cache as it was.
  const before = cacheOf(dir)
  fs.rmSync(path.join(dir, 'envs'))
  const fresh = await update(dir, { AERO_CONFIG: ONE, AERO_FRESH: '1', STUB: 'fail' })
  assert.equal(fresh.code, 1)
  assert.deepEqual(envsIn(dir).map((e) => [e.fresh, e.pause]), [['1', null], ['1', null]])
  assert.deepEqual(cacheOf(dir), before)
  done(dir)
})
