// What a fresh pass needs (src/update.mjs, src/run.mjs FRESH): a pass over the pipeline for the page alone,
// to a little behind the latest block where a chain's safe head is minutes old, that keeps nothing of what
// it read.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// The newest block at least `secs` behind a chain's latest one, by the pace of its last `span` blocks: a
// little behind the tip, so the public nodes agree on it. `client` needs getBlock() (the latest block) and
// getBlock({ blockNumber }). A node whose latest block is over `maxAge` seconds old by this machine's clock
// (`now`, in seconds) has fallen behind the chain: its answer is refused rather than taken for fresh.
export async function freshHead(client, secs, { span = 200, now = Date.now() / 1000, maxAge = 120 } = {}) {
  const tip = await client.getBlock()
  const n = Number(tip.number), from = Math.max(0, n - span)
  if (now - Number(tip.timestamp) > maxAge) throw new Error('the latest block the node gave is minutes old: nothing fresh to read from it')
  const back = n > from ? await client.getBlock({ blockNumber: BigInt(from) }) : tip
  const pace = n > from ? (Number(tip.timestamp) - Number(back.timestamp)) / (n - from) : 0
  // At least two blocks back whatever the pace reads as (several blocks can carry one timestamp), and never
  // further than the pace could explain.
  const behind = pace > 0 ? Math.ceil(secs / pace) : span
  return Math.max(0, n - Math.max(2, Math.min(behind, span * 50)))
}

// The block a pass reads a chain to. Its safe head, final, since what a pass reads is kept for good
// (lib/scan.mjs, lib/time.mjs). A fresh pass (`fresh`), which keeps nothing, reads a chain with freshSecs to a
// little behind its latest block instead: never short of the safe head, whatever a node behind the others
// says the latest block is. Any other pass, and any chain without freshSecs, never asks for the latest block.
export async function headOf(client, chain, fresh) {
  const safe = Number((await client.getBlock({ blockTag: chain.safeTag })).number)
  return fresh && chain.freshSecs ? Math.max(safe, await freshHead(client, chain.freshSecs)) : safe
}

// Runs fn and then puts the directory back exactly as it was found (its files as they were, anything new
// gone), whether fn returned or threw: what fn's work wrote there is never kept. Returns what fn returned.
// Stopped from outside meanwhile (Ctrl-C, a step's time limit): `stop` ends what fn started, the directory is
// put back all the same, and the process ends; once a signal is heard nothing goes back to the caller,
// however long `stop` takes. A signal that arrives while the directory is being put back waits until it is
// whole again. A process killed outright (SIGKILL, the power) leaves the copy of how the directory was found
// in the system's temporary directory (aero-kept-*), and the directory as the work had it; one stopped while
// that copy is still being made leaves the directory untouched and the copy half made.
export async function leaveAsFound(dir, fn, { stop } = {}) {
  const kept = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-kept-'))
  const there = fs.existsSync(dir)
  // A copy that could not be made whole is not left behind.
  if (there) try { fs.cpSync(dir, kept, { recursive: true }) } catch (e) { fs.rmSync(kept, { recursive: true, force: true }); throw e }
  let back = () => {
    back = () => {}
    fs.rmSync(dir, { recursive: true, force: true })
    if (there) fs.cpSync(kept, dir, { recursive: true })
    fs.rmSync(kept, { recursive: true, force: true })
  }
  // Once a signal is heard the process ends in its handler. One heard after the work has ended has nothing
  // left to stop. A directory that cannot be put back is said so (its copy stays in the temporary directory).
  let heard = false, over = false
  const onSignal = async (sig) => {
    heard = true
    try { if (!over) await stop?.() } catch {}
    try { back() } catch (e) { console.error(e) }
    process.exit(sig === 'SIGINT' ? 130 : 143)
  }
  const signals = ['SIGINT', 'SIGTERM']
  for (const s of signals) process.on(s, onSignal)
  try {
    return await fn()
  } finally {
    // A signal heard while the work ran is still being heeded: its handler puts the directory back once `stop`
    // is through, and ends the process. Nothing goes back to the caller meanwhile.
    if (heard) await new Promise(() => {})
    over = true
    // Put back first, the handlers still on: without them a signal would end the process in the middle of the
    // copy. Two turns of the event loop then let one that came meanwhile be heard, and the process ends as
    // asked (two, not one: where fn ended from an I/O callback, as on a child's exit in src/update.mjs, the
    // first setImmediate runs before the loop has read the signal).
    try { back(); await new Promise((r) => setImmediate(() => setImmediate(r))) } finally { for (const s of signals) process.off(s, onSignal) }
  }
}
