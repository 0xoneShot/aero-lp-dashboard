// Hand corrections of transactions the rules could not settle (config/overrides.json):
// { key: { walletKey: cls } }. A key is a transaction hash, or "h:" and a keyed hash of it: the public
// repository must not hold a tracked wallet's transaction hashes, since one is enough to find the wallet
// on a block explorer. The key of the hashed form comes from all the tracked addresses (AERO_CONFIG in
// the workflow, config/wallets.local.json locally), as the page's data files do, so only someone who
// already knows the wallets can tell which transaction an entry is about.
// Add one with: node scripts/override.mjs <walletKey> <cls> <tx hash>
import { createHash, createHmac } from 'node:crypto'

export const CLASSES = new Set(['transfer', 'internal', 'bridge', 'between', 'reward'])

export function overrideSecret(addresses) {
  const list = [...new Set(addresses.map((a) => a.trim().toLowerCase()))].sort().join(',')
  return createHash('sha256').update(`aero-lp-dashboard overrides v1\n${list}`).digest()
}

export const overrideKey = (secret, hash) => `h:${createHmac('sha256', secret).update(String(hash).toLowerCase()).digest('hex').slice(0, 40)}`

const hits = new WeakMap()

// The entries no transaction looked up so far (by their keys, which name no transaction): after the
// ledgers are built, one left over means a wrong hash, or the tracked wallets changed (that re-keys every
// keyed entry, so each has to be added again with scripts/override.mjs).
export const unmatchedOverrides = (lookup) => { const h = hits.get(lookup); return h ? h.keys.filter((k) => !h.seen.has(k)) : [] }

// The lookup the ledger reads (overrides[hash][walletKey]): plain keys first, then the keyed form.
export function overrideLookup(raw, addresses) {
  for (const [k, v] of Object.entries(raw)) {
    if (!/^(0x[0-9a-f]{64}|h:[0-9a-f]{40})$/.test(k)) throw new Error(`overrides: bad key ${k.slice(0, 12)}…`)
    for (const [w, cls] of Object.entries(v)) if (!CLASSES.has(cls)) throw new Error(`overrides: bad class ${cls} for ${w}`)
  }
  const hashed = Object.keys(raw).some((k) => k.startsWith('h:'))
  const secret = hashed ? overrideSecret(addresses) : null
  const seen = new Set()
  const lookup = new Proxy(raw, {
    get(target, hash) {
      if (typeof hash !== 'string') return undefined
      const k = Object.hasOwn(target, hash) ? hash : secret ? overrideKey(secret, hash) : null
      if (k == null || !Object.hasOwn(target, k)) return undefined
      seen.add(k)
      return target[k]
    },
  })
  hits.set(lookup, { keys: Object.keys(raw), seen })
  return lookup
}
