// Entry point for npm run update: runs the pipeline with wallet addresses kept out of the output.
//
// While addresses added on the page are tracked, the pipeline runs with them in a child process for at
// most EXTRAS_MINUTES (its own budgets end before that: catching up, and the pool samples at
// AERO_SOFT_END). If it fails or runs out of time, it is stopped and runs again at once without them, as
// the configured wallets alone (lib/config.mjs AERO_PAUSE_EXTRAS: the added ones' progress is kept), so
// whatever an added address does, the configured wallets are updated this hour. What became of the run with
// them is recorded (lib/requests.mjs readHealth) for scripts/requests.mjs, which lets go of the ones to
// blame when it keeps happening. Without added addresses the pipeline runs here, as it always has.
//
// AERO_FRESH=1 asks for a fresh pass instead (src/run.mjs FRESH; the job runs one after the hourly pass and
// alone every ten minutes in between): the same pipeline, to a little behind the latest block where a
// chain's safe head is minutes old, for the page only. It runs in a child, with the added addresses the
// hourly pass had in step and no others (lib/scan.mjs), and is tried once more if it fails, all within
// FRESH_MINUTES; there is no run without the added addresses and no record of how it went. What it scanned
// is checked (test/invariants.test.mjs), and then the caches are put back exactly as they were: the next
// pass, fresh or not, starts from what the last hourly pass kept, so nothing read from blocks that may still
// change is ever built on, and a pass that failed leaves no trace.
//
// What the job shows is public, down to when each line was printed and how long each step took:
// - AERO_PAD_SECONDS (the job sets it): the update ends no sooner than that many seconds after it began, and
//   past that only in whole steps (lib/public.mjs padFor), so how long it took does not tell whether a
//   tracked wallet had done anything for it to read. The job prints what the update said only once it has
//   ended (.github/workflows/refresh.yml), so the lines' own times tell no more.
// - In the job a fresh pass says nothing of what it read (HUSH below): not the lines of the pass, not those
//   of the checks on its scan, only whether it went through, failed and was tried once more, or failed for
//   good; or, before it starts, that the cache holds no kept scan to start from (the cache's state, nothing
//   a wallet did). Every failure ends with the same exit code. It reads just the minutes since the last
//   hourly pass, and comes every ten: how far it got before it failed, which check did not pass or for which
//   wallet, would say that a wallet had a transaction in those minutes. So a fresh pass that keeps failing is
//   looked into by running one on one's own machine (AERO_FRESH=1 npm run update), where everything is said;
//   the hourly pass reads the same transactions an hour at a time and says what failed (without figures) in
//   its own log.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { redact, redactConsole, quiet } from '../lib/redact.mjs'
import { padFor, PUBLIC_LOG } from '../lib/public.mjs'
import { EXTRA_WALLETS, PAUSED_WALLETS, CHAINS } from '../lib/config.mjs'
import { readHealth, writeHealth, recordRun } from '../lib/requests.mjs'
import { leaveAsFound } from '../lib/fresh.mjs'
import { VERSION as SCAN_VERSION } from '../lib/scan.mjs'

const log = (...a) => console.log('[update]', ...a)
const started = performance.timeOrigin
const CHILD = process.env.AERO_UPDATE_CHILD === '1'
const FRESH = process.env.AERO_FRESH === '1'
// A fresh pass in the job's public log (above): what it and its checks print goes nowhere.
const HUSH = FRESH && PUBLIC_LOG
// For test/e2e/update.test.mjs alone, which runs this file without a chain to read: another module in place of the
// pipeline, and another test file in place of the checks on what a fresh pass scanned.
const PIPELINE = process.env.AERO_TEST_PIPELINE ? pathToFileURL(path.resolve(process.env.AERO_TEST_PIPELINE)).href : './run.mjs'
const FRESH_CHECK = process.env.AERO_TEST_CHECK ?? 'test/invariants.test.mjs'
// The child process running now, if any (child() below), and whether the pass is being stopped from outside
// (stopChild below): the code under these lines runs before anything declared further down the file exists,
// so what it uses is declared here or as a function.
let running = null, stopping = false
// Ends the process with `code` once its padded time is up (lib/public.mjs padFor; a child is not padded: its
// parent is). Whatever a request still under way throws meanwhile is nobody's any more, and is not printed.
function end(code) {
  for (const ev of ['unhandledRejection', 'uncaughtException']) process.on(ev, () => {})
  setTimeout(() => process.stdout.write('', () => process.exit(code)), CHILD ? 0 : padFor(Date.now() - started, Number(process.env.AERO_PAD_SECONDS)))
}
redactConsole()
// Whatever the fresh pass's own work here throws (lib/fresh.mjs: the cache could not be set aside, or not put
// back) ends like any failure of the pass, on its padded time: Node's own report of an error nobody caught is
// none of the sentences above. On one's own machine it is printed as well. Not tried again: after a failed
// put-back the cache may be gone.
if (!CHILD && FRESH) end(await freshPass().catch((e) => { if (!HUSH) console.error(redact(e?.stack ?? e)); log('the fresh pass failed: nothing of it is published'); return 1 }))
else if (!CHILD && EXTRA_WALLETS.length) end(await withFallback())
else await here()

async function here() {
  try {
    await import(PIPELINE)
    // Done: calls given up on (a request still being retried) do not keep it waiting.
    end(0)
  } catch (e) {
    const text = redact(e?.stack ?? e)
    // In the job's public log, and wherever addresses added on the page are tracked, the whole text (which
    // may name a wallet's blocks or positions) goes only into the encrypted cache; the log gets it without
    // numbers. A fresh pass keeps nothing, its error neither; in the job it says nothing at all (HUSH: its
    // parent says that it failed).
    if (HUSH) return end(1)
    if (PUBLIC_LOG || EXTRA_WALLETS.length || PAUSED_WALLETS.length) {
      console.error(quiet(text).split('\n').slice(0, 12).join('\n'))
      if (!FRESH) {
        try {
          fs.mkdirSync(path.resolve('data/cache'), { recursive: true })
          fs.writeFileSync(path.resolve('data/cache/last-error.json'), JSON.stringify({ at: new Date().toISOString(), text }) + '\n')
          console.error('(the whole text is in the encrypted cache: data/cache/last-error.json)')
        } catch {}
      }
    } else console.error(text)
    end(1)
  }
}

// Runs the pipeline in a child process with `env` added; stopped at `stop` (ms) if still running. Every
// cache file is written whole (to a temporary name, then renamed), so one stopped mid-run leaves each
// file as it was or as it became.
// `args`: another script to run instead (the checks on what a fresh pass scanned). What it prints is shown,
// but for a fresh pass in the job (HUSH).
function child(env, stop, args = [fileURLToPath(import.meta.url)]) {
  return new Promise((resolve) => {
    // Being stopped from outside, the pass starts nothing more: a child that ended well in that very moment
    // would otherwise have the next one started on the way out, and left running.
    if (stopping) return resolve({ code: 1, late: false })
    const p = spawn(process.execPath, args, { env: { ...process.env, ...env, AERO_UPDATE_CHILD: '1' }, stdio: HUSH ? 'ignore' : 'inherit' })
    running = p
    let late = false, hard = null
    const timer = Number.isFinite(stop) ? setTimeout(() => { late = true; p.kill('SIGTERM'); hard = setTimeout(() => p.kill('SIGKILL'), 15_000) }, Math.max(0, stop - Date.now())) : null
    const done = (code) => { clearTimeout(timer); clearTimeout(hard); if (running === p) running = null; resolve({ code, late }) }
    p.on('error', () => done(1))
    p.on('exit', (code) => done(code ?? 1))
  })
}
// Ends the child still running, if any, and waits until it is gone. It is told to end first: the checks'
// runner (node --test) then ends the process it started for the test file, which it cannot do when it is
// killed outright. One that has not gone two seconds later is killed.
function stopChild() {
  stopping = true
  return new Promise((resolve) => {
    const p = running
    if (!p) return resolve()
    const hard = setTimeout(() => p.kill('SIGKILL'), 2000)
    p.once('exit', () => { clearTimeout(hard); resolve() })
    p.kill('SIGTERM')
  })
}

// The added addresses the last run had caught up on every chain (lib/scan.mjs): those in its datasets; and
// the others, still being caught up.
function caughtUp() {
  const states = Object.values(CHAINS).filter((c) => c.key === 'base' || fs.existsSync(c.files.scan)).map((c) => {
    try { return JSON.parse(fs.readFileSync(c.files.scan, 'utf8')) } catch { return null }
  })
  const done = EXTRA_WALLETS.filter((w) => states.every((st) => st?.wallets?.[w.key] && !st.wallets[w.key].behind)).map((w) => w.key)
  return { done, behind: EXTRA_WALLETS.map((w) => w.key).filter((k) => !done.includes(k)) }
}

// The fresh pass, with the caches left as they were before it (lib/fresh.mjs). One that fails (and did not
// run out of time) is tried once more from the same kept caches: a node a block behind the others, seconds
// from the latest block, is the likeliest reason, and gone a moment later.
async function freshPass() {
  const dir = path.resolve('data/cache')
  // Every chain's scan as the hourly pass keeps it now: without one there is nothing to start from, and
  // another version's, or one whose first scan never finished, would be read anew by every fresh pass
  // (reading a whole history is the hourly pass's).
  const kept = Object.values(CHAINS).every((c) => { try { const s = JSON.parse(fs.readFileSync(path.resolve(c.files.scan), 'utf8')); return s.version === SCAN_VERSION && s.scannedTo != null } catch { return false } })
  if (!kept) { log('no kept scan to start from yet: the fresh pass waits for the hourly one'); return 1 }
  const stop = Date.now() + Number(process.env.FRESH_MINUTES ?? 4) * 60_000
  for (let attempt = 1; ; attempt++) {
    const { code, late } = await leaveAsFound(dir, async () => {
      // An added address in step with the others is read with them (or the pass fails, lib/scan.mjs), within
      // this many minutes of the pass's start (the limit counts from the end of the time for catching up,
      // which a fresh pass has none of); one the hourly pass left behind stays out: catching up is not this
      // pass's.
      const run = await child({ AERO_FRESH: '1', CATCH_UP_MINUTES: '0', STEP_EXTRA_MINUTES: process.env.FRESH_STEP_MINUTES ?? '3' }, stop)
      if (run.code !== 0) return run
      // What it scanned, checked while it still stands (the job's own checks come after the caches are back,
      // and so see the hourly pass's scan): every transaction's ETH adds up, and each wallet's scan ends on
      // its balance on the chain, read again now.
      return child({}, stop, ['--test', FRESH_CHECK])
    }, { stop: stopChild })
    if (code === 0) { if (HUSH) log('the fresh pass went through'); return 0 }
    // In the job one sentence for every failure: that one ran out of time shows in how long the step took.
    // One exit code too (the job's log shows the step's): 1, not the child's own, which would say how it ended.
    if (late || attempt === 2 || Date.now() > stop - 60_000) { log(`the fresh pass ${late && !HUSH ? 'ran out of time' : 'failed'}: nothing of it is published`); return 1 }
    log('the fresh pass failed: once more')
  }
}

async function withFallback() {
  const started = Date.now()
  const stop = started + Number(process.env.EXTRAS_MINUTES ?? 13) * 60_000
  const first = await child({
    AERO_SOFT_END: String(stop - 60_000),
    CATCH_UP_MINUTES: process.env.CATCH_UP_MINUTES ?? '6',
    STEP_EXTRA_MINUTES: process.env.STEP_EXTRA_MINUTES ?? '3',
  }, stop)
  const { done, behind } = caughtUp()
  if (first.code === 0) {
    writeHealth(recordRun(readHealth(), { at: started, ok: true }, done))
    return 0
  }
  log(`the update with the added addresses ${first.late ? 'ran out of time' : 'failed'}: running it again without them`)
  // The pool samples stop in time for the step's limit (.github/workflows/refresh.yml).
  const second = await child({ AERO_PAUSE_EXTRAS: '1', AERO_SOFT_END: String(started + 29 * 60_000) }, Infinity)
  // Only when the configured wallets alone went through is the trouble the added addresses'.
  if (second.code === 0) writeHealth(recordRun(readHealth(), { at: started, ok: false, why: first.late ? 'time' : 'error', tried: done, behind }))
  return second.code
}
