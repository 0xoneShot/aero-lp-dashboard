// Keeps tracked wallet addresses out of anything printed: the hourly job's logs are public.
import { WALLETS, PAUSED_WALLETS } from './config.mjs'

const patterns = [...WALLETS, ...PAUSED_WALLETS].map((w) => [new RegExp(w.address.slice(2), 'gi'), `<${w.key}>`])

export const redact = (text) => patterns.reduce((s, [re, rep]) => s.replace(re, rep), String(text))

// What the public log may say about a failure while addresses added on the page are tracked: no hashes,
// blocks, token ids or amounts (any of them points at a wallet on a block explorer), only the words and
// where in the code it happened.
export const quiet = (text) => String(text).replace(/0x[0-9a-fA-F]+/g, '0x…').replace(/\d{4,}/g, '…')

export function redactConsole() {
  for (const m of ['log', 'error', 'warn', 'info']) {
    const orig = console[m].bind(console)
    console[m] = (...args) => orig(...args.map((a) => (typeof a === 'string' ? redact(a) : a instanceof Error ? redact(a.stack ?? a.message) : a)))
  }
}
