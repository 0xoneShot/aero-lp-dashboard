// Stands in for src/run.mjs in test/e2e/update.test.mjs: does to the working directory what a pass does (writes
// under data/cache and out/), then ends as STUB says. Nothing here reads a chain.
//   STUB=ok        ends well
//   STUB=fail      throws
//   STUB=fail-once throws the first time it runs in this working directory, ends well after
//   STUB=hang      never ends (its process id is left in the file `pid`, so a test can tell whether it was ended)
//   STUB=exit      ends the process itself, with a code of its own (7)
//   STUB=unsettled waits for what never comes, with nothing left to do (Node ends such a process with 13)
import fs from 'node:fs'

const mode = process.env.STUB ?? 'ok'
fs.mkdirSync('data/cache', { recursive: true })
fs.mkdirSync('out', { recursive: true })
// What the pass leaves in the cache: a scan moved on, and a file that was not there.
const scan = JSON.parse(fs.readFileSync('data/cache/scan.json', 'utf8'))
fs.writeFileSync('data/cache/scan.json', JSON.stringify({ ...scan, scannedTo: (scan.scannedTo ?? 0) + 100 }))
fs.writeFileSync('data/cache/written-by-the-pass.json', '{}')
// A count of the runs, kept outside the cache (which a fresh pass puts back).
const runs = (fs.existsSync('runs') ? Number(fs.readFileSync('runs', 'utf8')) : 0) + 1
fs.writeFileSync('runs', String(runs))
fs.appendFileSync('envs', JSON.stringify({ fresh: process.env.AERO_FRESH ?? null, pause: process.env.AERO_PAUSE_EXTRAS ?? null, child: process.env.AERO_UPDATE_CHILD ?? null, step: process.env.STEP_EXTRA_MINUTES ?? null, catchUp: process.env.CATCH_UP_MINUTES ?? null }) + '\n')
console.error(`[stub] pass ${runs} read to ${scan.scannedTo + 100}`)
if (mode === 'hang') { fs.writeFileSync('pid', String(process.pid)); console.log('[stub] hanging'); await new Promise(() => { setInterval(() => {}, 1000) }) }
if (mode === 'exit') process.exit(7)
if (mode === 'unsettled') await new Promise(() => {})
if (mode === 'fail' || (mode === 'fail-once' && runs === 1)) throw new Error('stub: the pass failed at block 99999999 with 0xabcdef0123456789')
fs.writeFileSync('out/summary.json', JSON.stringify([{ scope: 'total', run: runs, scanned: scan.scannedTo + 100 }]))
console.error('[stub] wrote out/')
