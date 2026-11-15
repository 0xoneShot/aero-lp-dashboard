// Entry point for npm run update: runs the pipeline with wallet addresses kept out of the output.
//
// While addresses added on the page are tracked, the pipeline runs with them in a child process for at
// most EXTRAS_MINUTES (its own budgets end before that: catching up, and the pool samples at
// AERO_SOFT_END). If it fails or runs out of time, it is stopped and runs again at once without them, as
// the configured wallets alone (lib/config.mjs AERO_PAUSE_EXTRAS: the added ones' progress is kept), so
// whatever an added address does, the configured wallets are updated this hour. What became of the run with
// them is recorded (lib/requests.mjs readHealth) for scripts/requests.mjs, which lets go of the ones to
// blame when it keeps happening. Without added addresses the pipeline runs here, as it always has.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { redact, redactConsole, quiet } from '../lib/redact.mjs'
import { EXTRA_WALLETS, PAUSED_WALLETS, CHAINS } from '../lib/config.mjs'
import { readHealth, writeHealth, recordRun } from '../lib/requests.mjs'

const log = (...a) => console.log('[update]', ...a)
redactConsole()
if (process.env.AERO_UPDATE_CHILD !== '1' && EXTRA_WALLETS.length) process.exit(await withFallback())

try {
  await import('./run.mjs')
  // Done: calls given up on (a request still being retried) do not keep it waiting.
  process.stdout.write('', () => process.exit(0))
} catch (e) {
  const text = redact(e?.stack ?? e)
  // While addresses added on the page are tracked, the whole text (which may name one's blocks or
  // positions) goes only into the encrypted cache; the public log gets it without numbers.
  if (EXTRA_WALLETS.length || PAUSED_WALLETS.length) {
    try {
      fs.mkdirSync(path.resolve('data/cache'), { recursive: true })
      fs.writeFileSync(path.resolve('data/cache/last-error.json'), JSON.stringify({ at: new Date().toISOString(), text }) + '\n')
    } catch {}
    console.error(quiet(text).split('\n').slice(0, 12).join('\n'))
    console.error('(the whole text is in the encrypted cache: data/cache/last-error.json)')
  } else console.error(text)
  process.exit(1)
}

// Runs the pipeline in a child process with `env` added; stopped at `stop` (ms) if still running. Every
// cache file is written whole (to a temporary name, then renamed), so one stopped mid-run leaves each
// file as it was or as it became.
function child(env, stop) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, ...env, AERO_UPDATE_CHILD: '1' }, stdio: 'inherit' })
    let late = false, hard = null
    const timer = Number.isFinite(stop) ? setTimeout(() => { late = true; p.kill('SIGTERM'); hard = setTimeout(() => p.kill('SIGKILL'), 15_000) }, Math.max(0, stop - Date.now())) : null
    const done = (code) => { clearTimeout(timer); clearTimeout(hard); resolve({ code, late }) }
    p.on('error', () => done(1))
    p.on('exit', (code) => done(code ?? 1))
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
