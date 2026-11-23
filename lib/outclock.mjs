// How long each published range has been out of its bounds, for the page. The phone alerts keep that clock
// (lib/alerts.mjs, out24) in data/cache/alerts.json: `<wallet key>:[chain:]<low>-<high>:out` holds '<ms>' or
// '<ms>:sent', the time of the first update that found the range out ('in' once it is back inside its
// bounds while its side still reads out: not yet BACK away, or its 回到 not sent yet; 'order' for an order,
// which is never counted as out; no key while it is in range otherwise). scripts/build-site.mjs, which runs
// after the alert step, copies that time onto each position of the summary rows it publishes as `out_since`
// (ms since the epoch), inside the encrypted views.
// Pure: the caller reads the state.
import { outKeyOf } from './alerts.mjs'

// rows: summary rows, changed in place and returned. state: the alert state, or anything else when it could
// not be read, and then nothing is attached. keyOf(label): the key of the wallet that a position of a total
// or a combined view belongs to (those rows name it by its label), or null.
export function attachOutSince(rows, state, keyOf) {
  const ok = state != null && typeof state === 'object' && !Array.isArray(state)
  for (const row of rows ?? []) {
    // A wallet's own row is keyed by its scope; a total or a combined view repeats its wallets' ranges.
    const own = row.scope !== 'total' && !row.group
    for (const p of row.curve?.positions ?? []) {
      delete p.out_since
      // The alerts keep a clock only while the range is out of its bounds, as this row has it too.
      if (!ok || p.in_range !== false) continue
      const key = own ? row.scope : keyOf?.(p.wallet)
      if (typeof key !== 'string' || !key) continue
      const k = outKeyOf(key, p), since = sinceOf(Object.hasOwn(state, k) ? state[k] : null)
      if (since != null) p.out_since = since
    }
  }
  return rows
}

// When a clock started: '<ms>' or '<ms>:sent'. 'in' (back inside the bounds) or anything else is none.
function sinceOf(v) {
  if (typeof v !== 'string') return null
  const n = Number(v.split(':')[0])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
