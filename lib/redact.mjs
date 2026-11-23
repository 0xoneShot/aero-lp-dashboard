// Keeps tracked wallet addresses, and what they did when, out of what anyone can see of the job: its logs
// are public, and so is how long each of its steps took.
import { WALLETS, PAUSED_WALLETS } from './config.mjs'

const patterns = [...WALLETS, ...PAUSED_WALLETS].map((w) => [new RegExp(w.address.slice(2), 'gi'), `<${w.key}>`])

export const redact = (text) => patterns.reduce((s, [re, rep]) => s.replace(re, rep), String(text))

// What the public log may say about a failure: no hashes, blocks, token ids or amounts (any of them points
// at a wallet on a block explorer), only the words and where in the code it happened.
// A stack line ("at fn (file:line:col)") keeps its numbers: they are places in this code, not on a chain.
export const quiet = (text) => String(text).split('\n').map((l) => (/^\s*at /.test(l) ? l : l.replace(/0x[0-9a-fA-F]+/g, '0x…').replace(/\d{4,}/g, '…'))).join('\n')

export function redactConsole() {
  for (const m of ['log', 'error', 'warn', 'info']) {
    const orig = console[m].bind(console)
    console[m] = (...args) => orig(...args.map((a) => (typeof a === 'string' ? redact(a) : a instanceof Error ? redact(a.stack ?? a.message) : a)))
  }
}
