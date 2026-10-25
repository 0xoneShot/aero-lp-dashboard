// Keeps tracked wallet addresses out of anything printed: the hourly job's logs are public.
import { WALLETS } from './config.mjs'

const patterns = WALLETS.map((w) => [new RegExp(w.address.slice(2), 'gi'), `<${w.key}>`])

export const redact = (text) => patterns.reduce((s, [re, rep]) => s.replace(re, rep), String(text))

export function redactConsole() {
  for (const m of ['log', 'error', 'warn', 'info']) {
    const orig = console[m].bind(console)
    console[m] = (...args) => orig(...args.map((a) => (typeof a === 'string' ? redact(a) : a instanceof Error ? redact(a.stack ?? a.message) : a)))
  }
}
