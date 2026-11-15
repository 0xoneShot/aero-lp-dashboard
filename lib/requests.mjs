// Addresses the dashboard tracks on request, beside the configured ones (AERO_CONFIG): someone who can
// open a wallet's data on the page asks, through that wallet's inbox (lib/views.mjs), for another
// address to be tracked, or for one it added earlier to be dropped, and for the wallets to be shown
// together. The hourly job reads the inboxes (scripts/requests.mjs) and keeps what was asked in
// data/cache/extras.json, inside the encrypted cache, never in this public repository.
//
// The store:
//   { v: 1, gen, next: { g },                           // gen: counts every write (scripts/cache-crypt.mjs keeps the newer copy)
//     extras: [{ key, address, label, by, addedTs, req }], // key: random (newKey); by: key of the wallet whose inbox asked; req: its request
//     groups: [{ key: 'g1', members: ['w1', 'x1'], by, addedTs, usedTs }],
//     inbox:  { seen: { <ntfy message id>: ts }, seenCt: { <sha256 of a sealed request>: ts } },
//     letGo:  [{ address, reason, ts }],                 // let go by the job, or stopped from its own view: not taken back for a while
//     log:    [{ ts, req, by, op, tail, state, reason }] }   // what became of each request, newest last
// and beside it data/cache/extras-health.json (readHealth below): what became of the updates run with them.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { newJobKeys } from './views.mjs'

export const STORE_FILE = path.resolve('data/cache/extras.json')
// A store that could not be read is set aside under this name, inside the encrypted cache like the rest.
export const BAD_STORE_FILE = path.resolve('data/cache/extras.bad.json')
// The job's key pair for requests (lib/views.mjs): its public half goes into the page.
export const KEYS_FILE = path.resolve('data/cache/secret.json')

export const LIMITS = {
  extras: 8, // addresses tracked on request, all together
  extrasPerInbox: 4, // of them added through one wallet's inbox
  groups: 20, // combined views asked for, all together
  groupsPerInbox: 8, // of them asked through one wallet's inbox
  groupSize: 6, // addresses in one combined view
  adds: 3, // new addresses in one request
  name: 16, // characters of a name
  maxAgeMs: 48 * 3600_000, // a request older than this is ignored (it may be a replay)
  futureMs: 10 * 60_000, // a request dated this far ahead of the job's clock is ignored
  log: 120, // log entries kept
  logPerInbox: 40, // of them about one inbox's requests: one inbox cannot push out the others' answers
  letGoMs: 7 * 86400_000, // an address the job let go is not taken back for this long
  letGo: 40, // of them remembered
  txs: 5000, // transactions an added address may bring in, all chains together: past it, it is let go ('too busy')
}

// Remembers an address the job let go (its history unreadable, or the update kept failing with it), or one
// stopped from its own view, so a page still waiting on it does not bring it straight back.
export function letGo(store, address, reason, now) {
  store.letGo = [...(store.letGo ?? []).filter((x) => x.address !== address && now - x.ts < LIMITS.letGoMs), { address, reason, ts: now }].slice(-LIMITS.letGo)
}

// Adds an entry to the store's log, within the limits.
export function pushLog(store, entry) {
  store.log.push(entry)
  const mine = store.log.filter((x) => x.by === entry.by)
  if (mine.length > LIMITS.logPerInbox) { const drop = new Set(mine.slice(0, mine.length - LIMITS.logPerInbox)); store.log = store.log.filter((x) => !drop.has(x)) }
  if (store.log.length > LIMITS.log) store.log.splice(0, store.log.length - LIMITS.log)
}

const ADDR = /^0x[0-9a-f]{40}$/
export const isAddress = (a) => typeof a === 'string' && ADDR.test(a)
export const tail = (a) => a.slice(-4)

export const emptyStore = () => ({ v: 1, next: { g: 1 }, extras: [], groups: [], inbox: {}, letGo: [], log: [] })

// Whether a parsed store is one this code reads (scripts/cache-crypt.mjs never lets another replace it).
export const storeOk = (s) => s?.v === 1 && Array.isArray(s.extras ?? []) && Array.isArray(s.groups ?? []) && Array.isArray(s.log ?? []) &&
  (s.extras ?? []).every((x) => x && typeof x.key === 'string' && typeof x.address === 'string') && (s.groups ?? []).every((g) => g && Array.isArray(g.members))

export function readStore(file = STORE_FILE) {
  if (!fs.existsSync(file)) return emptyStore()
  let s = null
  try {
    s = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (storeOk(s)) return { ...emptyStore(), ...s, next: { ...emptyStore().next, ...(s.next ?? {}) }, inbox: { ...(s.inbox ?? {}) }, letGo: Array.isArray(s.letGo) ? s.letGo.filter((x) => x && typeof x.address === 'string' && Number.isFinite(x.ts)) : [] }
  } catch {}
  // Kept aside (and sealed into the cache with it) rather than lost, and the run goes on without the added
  // addresses: a broken store must never stop the configured wallets' update. The new one counts on from the
  // one set aside, so an older copy of that one (scripts/cache-crypt.mjs keeps the newer) never comes back.
  fs.renameSync(file, file === STORE_FILE ? BAD_STORE_FILE : `${file}.bad`)
  console.error(`[requests] ${path.basename(file)} unreadable, set aside`)
  return { ...emptyStore(), gen: Number.isFinite(s?.gen) ? s.gen : 0 }
}

export function writeStore(store, file = STORE_FILE) {
  store.gen = (store.gen ?? 0) + 1
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(store, null, 1) + '\n')
  fs.renameSync(file + '.tmp', file)
}

// The job's key pair for requests, made the first time it is needed (`create`), or null.
export async function jobKeys({ create = false, file = KEYS_FILE } = {}) {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (k?.v === 1 && k.jwk && typeof k.pub === 'string') return k
  } catch {}
  if (!create) return null
  const k = await newJobKeys()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(k) + '\n')
  fs.renameSync(file + '.tmp', file)
  return k
}

// ---- whether the added addresses keep the update from finishing ----
// src/update.mjs runs the update with them first, for a limited time, and when that fails or runs out of
// time it runs again at once without them, so the configured wallets never wait on them. It records each
// run with them: { runs: [{ at, ok, why: 'error' | 'time', tried: [key], behind: [key] }], ok: [key] },
// newest last; `tried` are the added addresses that were caught up (in the datasets, or about to be) in a
// run that failed, `behind` those still being caught up, `ok` those that have been in a run that finished.
// Inside the encrypted cache.
export const HEALTH_FILE = path.resolve('data/cache/extras-health.json')
export const HEALTH = {
  errors: 3, // runs in a row that failed with them (and then worked without them) before some are let go
  late: 8, // or that failed in any way, running out of time included: a long history may take a few runs
  keep: 12, // runs remembered
}
export function readHealth(file = HEALTH_FILE) {
  try {
    const h = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(h?.runs)) return { runs: h.runs.filter((r) => r && typeof r === 'object'), ok: Array.isArray(h.ok) ? h.ok.filter((k) => typeof k === 'string') : [] }
  } catch {}
  return { runs: [], ok: [] }
}
export function writeHealth(h, file = HEALTH_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', JSON.stringify(h) + '\n')
  fs.renameSync(file + '.tmp', file)
}
// Adds one run with the added addresses; one that finished vouches for those it had caught up (`shown`).
export function recordRun(h, run, shown = []) {
  return { runs: [...h.runs, run].slice(-HEALTH.keep), ok: run.ok ? [...new Set([...h.ok, ...shown])] : h.ok }
}
// Which added addresses to let go, or null: after HEALTH.errors runs in a row that failed with them
// ('broke'), or HEALTH.late that failed in any way ('failed'), the ones the failed runs had caught up and
// that never were in a run that finished (new in the datasets); else the ones they were still catching up
// (the catching up itself); else those caught up; else every added address, since nothing else set those
// runs apart. When the ones to blame are no longer tracked, nobody else is.
export function suspects(h, extras) {
  const fails = []
  for (const r of [...h.runs].reverse()) { if (r.ok) break; fails.push(r) }
  const reason = fails.length >= HEALTH.errors && fails.slice(0, HEALTH.errors).every((r) => r.why === 'error') ? 'broke' : fails.length >= HEALTH.late ? 'failed' : null
  if (!reason) return null
  const tracked = new Set(extras.map((x) => x.key))
  const of = (f) => [...new Set(fails.flatMap((r) => (Array.isArray(r[f]) ? r[f] : [])))]
  const named = [...of('tried'), ...of('behind')]
  if (named.length && !named.some((k) => tracked.has(k))) return null
  const tried = of('tried').filter((k) => tracked.has(k)), behind = of('behind').filter((k) => tracked.has(k) && !tried.includes(k))
  const fresh = tried.filter((k) => !h.ok.includes(k))
  const keys = fresh.length ? fresh : behind.length ? behind : tried.length ? tried : [...tracked]
  return keys.length ? { keys, reason } : null
}

// A new address's key: random, so the public logs, which print keys, say nothing about the address.
export function newKey(taken) {
  for (;;) {
    const k = `x${randomBytes(4).toString('hex')}`
    if (!taken.has(k)) return k
  }
}

// A name as the page shows it and the phone alerts print it: Chinese characters, Latin letters, digits
// and a few marks (no look-alike letters from other scripts, no markup).
export function cleanName(s) {
  if (typeof s !== 'string') return ''
  return [...s.normalize('NFKC').replace(/[^\p{Script=Han}\p{Script=Latin}\p{N} ._·()-]/gu, '').trim()].slice(0, LIMITS.name).join('').trim()
}

const uniq = (xs) => [...new Set(xs)]

// A decrypted request, checked; { error } when it is not one the job acts on.
//   { type: 'aero-request', v: 1, ts, group: [address], add: [{ address, name }], drop: [address] }
// `inboxOf` is the address whose inbox it arrived in: it has to be in the group, so a request can
// only speak for views its sender can open. The one exception: an address can ask through its own inbox
// to stop being tracked (group [it], drop [it], nothing added).
export function checkRequest(p, inboxOf, now) {
  if (!p || typeof p !== 'object' || p.type !== 'aero-request' || p.v !== 1) return { error: 'not a request' }
  if (!Number.isFinite(p.ts) || p.ts < now - LIMITS.maxAgeMs || p.ts > now + LIMITS.futureMs) return { error: 'stale' }
  const group = Array.isArray(p.group) ? uniq(p.group.map((a) => String(a).toLowerCase())) : []
  const add = Array.isArray(p.add) ? p.add.map((x) => ({ address: String(x?.address ?? '').toLowerCase(), name: cleanName(x?.name) })) : []
  const drop = Array.isArray(p.drop) ? uniq(p.drop.map((a) => String(a).toLowerCase())) : []
  if (!group.length || group.length > LIMITS.groupSize || !group.every(isAddress)) return { error: 'bad group' }
  if (!group.includes(inboxOf)) return { error: 'not the sender\'s view' }
  if (add.length > LIMITS.adds || !add.every((x) => isAddress(x.address) && group.includes(x.address))) return { error: 'bad add' }
  if (uniq(add.map((x) => x.address)).length !== add.length) return { error: 'bad add' }
  const self = group.length === 1 && !add.length && drop.includes(inboxOf)
  if (drop.length > LIMITS.groupSize || !drop.every(isAddress) || drop.some((a) => group.includes(a) && !self)) return { error: 'bad drop' }
  return { ts: p.ts, group, add, drop }
}

// Applies a checked request. `base` is the configured wallets [{ key, address }]; `admit(address)`
// resolves to null when an address may be tracked, else the reason it may not (a busy account);
// `keyFor(address)` names a new one (newKey).
// Returns the addresses the job starts tracking. Every outcome is logged for the page to show.
export async function applyRequest(store, req, by, now, { base, admit, keyFor }) {
  const all = () => [...base, ...store.extras]
  const keyOf = (a) => all().find((w) => w.address === a)?.key
  const note = (op, address, state, reason = null) => pushLog(store, { ts: now, req: req.ts, by, op, tail: address ? tail(address) : null, state, reason })
  const added = []

  // Drops first: a request may swap one address for another. Whoever can see an added address (knows it
  // and a tracked wallet's address, or just it, through its own inbox) can stop it being tracked; the
  // configured wallets cannot be dropped.
  for (const a of req.drop) {
    const x = store.extras.find((w) => w.address === a)
    if (!x) { note('drop', a, 'ignored', base.some((w) => w.address === a) ? 'configured' : 'unknown'); continue }
    store.extras = store.extras.filter((w) => w !== x)
    store.groups = store.groups.filter((g) => !g.members.includes(x.key))
    note('drop', a, 'done')
    // Stopped from its own view: not taken back for a while, whoever asks.
    const self = x.key === by
    if (self) letGo(store, a, 'stopped', now)
    // Told where it was asked for too, filed under the request that added it: that page may still wait on it.
    if (x.by !== by) pushLog(store, { ts: now, req: x.req ?? null, by: x.by, op: 'add', tail: tail(a), state: 'rejected', reason: self ? 'stopped' : 'dropped' })
  }
  if (req.drop.includes(req.group[0]) && req.group.length === 1) return added // a self-drop asks for nothing else

  const fresh = req.add.filter((x) => !keyOf(x.address))
  for (const x of req.add.filter((y) => !fresh.includes(y))) note('add', x.address, 'exists')
  // Every other member must already be tracked: a request cannot pull in an address it does not add.
  const unknown = req.group.filter((a) => !keyOf(a) && !fresh.some((x) => x.address === a))
  if (unknown.length) {
    for (const a of unknown) note('group', a, 'rejected', 'not tracked')
    for (const x of fresh) note('add', x.address, 'rejected', 'not tracked')
    return added
  }
  const mine = store.extras.filter((w) => w.by === by).length
  if (store.extras.length + fresh.length > LIMITS.extras || mine + fresh.length > LIMITS.extrasPerInbox) { for (const x of fresh) note('add', x.address, 'rejected', 'too many'); return added }
  for (const x of fresh) {
    const gone = (store.letGo ?? []).find((y) => y.address === x.address && now - y.ts < LIMITS.letGoMs)
    if (gone) { for (const y of fresh) note('add', y.address, 'rejected', y === x ? gone.reason : 'with a refused one'); return added }
  }
  for (const x of fresh) {
    const why = await admit(x.address)
    if (why) { for (const y of fresh) note('add', y.address, 'rejected', y === x ? why : 'with a refused one'); return added }
  }
  for (const x of fresh) {
    const key = keyFor(x.address)
    store.extras.push({ key, address: x.address, label: x.name || `地址 ${tail(x.address)}`, by, addedTs: now, req: req.ts })
    added.push(x.address)
    note('add', x.address, 'accepted')
  }

  if (req.group.length > 1) {
    const members = req.group.map(keyOf).sort()
    const same = (g) => g.length === members.length && g.every((k, i) => k === members[i])
    const baseAll = base.map((w) => w.key).sort()
    const known = store.groups.find((g) => same(g.members))
    if (same(baseAll)) note('group', null, 'exists')
    else if (known) { known.usedTs = now; note('group', null, 'exists') }
    else {
      // Full: the view asked for least recently gives way (of this inbox's, else of all), so a view left
      // behind by an address added later or removed never blocks a new one. It can be asked for again.
      const used = (g) => g.usedTs ?? g.addedTs ?? 0
      const oldest = (gs) => gs.reduce((a, g) => (a && used(a) <= used(g) ? a : g), null)
      const mineG = store.groups.filter((g) => g.by === by)
      const gone = mineG.length >= LIMITS.groupsPerInbox ? oldest(mineG) : store.groups.length >= LIMITS.groups ? oldest(store.groups) : null
      if (gone) store.groups = store.groups.filter((g) => g !== gone)
      // Its key is kept apart from every wallet's (a configured one may be called g1) and from 'total'.
      const taken = new Set([...all().map((w) => w.key), ...store.groups.map((g) => g.key), 'total'])
      let key = `g${store.next.g++}`
      while (taken.has(key)) key = `g${store.next.g++}`
      store.groups.push({ key, members, by, addedTs: now, usedTs: now })
      note('group', null, 'accepted')
    }
  }
  return added
}
