// Reads what the page asked for (lib/requests.mjs) from the inboxes of the tracked wallets and keeps it in
// data/cache/extras.json, so this run's update tracks it. Runs in the hourly job after the cache is opened
// and before the update. Nothing it prints names an address: in the job, every address a request names is
// masked first (as scripts/mask.mjs does for the configured ones), and every line it prints has addresses
// cut out besides.
//   node scripts/requests.mjs
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { getAddress } from 'viem'
import { BASE_WALLETS, EXTRA_WALLETS, PAUSED_WALLETS, CHAINS } from '../lib/config.mjs'
import { deriveView, openRequest } from '../lib/views.mjs'
import { readStore, writeStore, checkRequest, applyRequest, isAddress, jobKeys, newKey, pushLog, letGo, readHealth, writeHealth, suspects, LIMITS } from '../lib/requests.mjs'
import { clientOf, getLogs, pmap } from '../lib/rpc.mjs'
import { TOPIC } from '../lib/abi.mjs'
import { givenUp, notOpened, addedTxCounts } from '../lib/scan.mjs'

const log = (...a) => console.log('[requests]', ...a.map((x) => String(x).replace(/0x[0-9a-fA-F]{40}/g, '0x…')))
const inJob = process.env.GITHUB_ACTIONS === 'true'
const masked = new Set()
function mask(address) {
  const a = String(address).toLowerCase()
  if (!inJob || masked.has(a) || !isAddress(a)) return
  masked.add(a)
  for (const v of new Set([a, getAddress(a), a.slice(2), getAddress(a).slice(2)])) console.log(`::add-mask::${v}`)
}
for (const w of [...EXTRA_WALLETS, ...PAUSED_WALLETS]) mask(w.address) // scripts/mask.mjs extras does it too; this run may add more

const INBOX = process.env.NTFY_INBOX_URL ?? 'https://ntfy.sh'
// Per run: requests that had an address judged (the chains asked whether it may be tracked; anything else
// costs next to nothing), all told and from one inbox, and time. The rest wait for the next run (12 hours in
// the inbox); the step itself is stopped at 5 minutes.
const BUDGET_MS = 3 * 60_000, MAX_REQUESTS = 12, PER_INBOX = 4
const started = Date.now(), now = started, deadline = started + BUDGET_MS
// The job's key for requests: made on the first run, kept in the encrypted cache; the page gets its
// public half (scripts/build-site.mjs). First, so the page can ask even if something below fails.
const keys = await jobKeys({ create: true })
let store = readStore()
// What the chains said about an address lately, kept across runs: a request held because its checks ran out
// of time picks up where it was next run, rather than starting over and running out of time again.
const ADMIT_MS = 6 * 3600_000
const admitted = Object.fromEntries(Object.entries(store.admitted && typeof store.admitted === 'object' ? store.admitted : {})
  .filter(([a, v]) => isAddress(a) && v && Number.isFinite(v.ts) && now - v.ts < ADMIT_MS && (v.why === null || typeof v.why === 'string')))
const save = () => { store.admitted = admitted; writeStore(store) }
const note = (entry) => pushLog(store, { ts: now, ...entry })
const acceptedFor = (x) => [...store.log].reverse().find((e) => e.op === 'add' && e.tail === x.address.slice(-4) && e.by === x.by && e.state === 'accepted')
// Dropping added addresses takes the combined views holding them with them, and only those. They are not
// taken back for a while (lib/requests.mjs letGo).
function dropExtras(gone, reason) {
  const keys = new Set(gone.map((x) => x.key))
  for (const x of gone) {
    note({ req: acceptedFor(x)?.req ?? null, by: x.by, op: 'add', tail: x.address.slice(-4), state: 'rejected', reason })
    letGo(store, x.address, reason, now)
  }
  store.extras = store.extras.filter((x) => !keys.has(x.key))
  store.groups = store.groups.filter((g) => !g.members.some((k) => keys.has(k)))
}

// ---- added addresses that keep the update with them from finishing ----
// src/update.mjs runs the update with the added addresses for a limited time and, when that fails or runs
// out of time, at once without them, so the configured wallets never wait on them; it records each run
// (lib/requests.mjs readHealth). After a few such runs in a row, the addresses to blame are let go and the
// page is told; the count starts over.
{
  const health = readHealth()
  const out = suspects(health, store.extras)
  if (out) {
    const gone = store.extras.filter((x) => out.keys.includes(x.key))
    log(`updates with added addresses kept failing: ${gone.map((x) => x.key).join(', ')} no longer tracked`)
    dropExtras(gone, out.reason)
    writeHealth({ runs: [], ok: health.ok.filter((k) => !out.keys.includes(k)) })
  }
}

// ---- added addresses whose history could not be read after many runs (lib/scan.mjs) are dropped ----
const states = []
for (const c of Object.values(CHAINS)) {
  let st = null
  try { st = JSON.parse(fs.readFileSync(c.files.scan, 'utf8')) } catch {}
  if (st) states.push(st)
  const gone = store.extras.filter((x) => givenUp(st?.wallets?.[x.key]) || notOpened(st, x.key))
  for (const x of gone) log(`${x.key}: its history could not be read on ${c.key}; no longer tracked`)
  if (gone.length) dropExtras(gone, 'failed')
}
// ---- and so are those that brought in more transactions than one may: every run loads them all ----
{
  const counts = new Map()
  for (const st of states) for (const [a, n] of addedTxCounts(st, store.extras.map((x) => x.address))) counts.set(a, (counts.get(a) ?? 0) + n)
  const gone = store.extras.filter((x) => (counts.get(x.address) ?? 0) > LIMITS.txs)
  for (const x of gone) log(`${x.key}: more transactions than an added address may have; no longer tracked`)
  if (gone.length) dropExtras(gone, 'too busy')
}
save()

// ---- the inboxes ----
const wallets = [...BASE_WALLETS, ...[...EXTRA_WALLETS, ...PAUSED_WALLETS].filter((w) => store.extras.some((x) => x.key === w.key))]
const inboxes = new Map()
for (const w of wallets) inboxes.set((await deriveView([w.address])).topic, { w })
// One poll per inbox, a few at a time, so one that fails does not hold back the others. ntfy keeps
// messages 12 hours; ask for a little more and drop what was handled (by message id), rather than trust a
// cursor that silently replays everything once it has expired.
const messages = []
await pmap([...inboxes.keys()], 4, async (topic) => {
  try {
    const r = await fetch(`${INBOX}/${topic}/json?poll=1&since=13h`, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    for (const line of (await r.text()).split('\n')) {
      let m = null
      try { m = JSON.parse(line) } catch {}
      if (m && m.event === 'message' && typeof m.message === 'string' && m.topic === topic && typeof m.id === 'string') messages.push(m)
    }
  } catch (e) { log(`an inbox could not be read this run: ${String(e.message).slice(0, 80)}`) }
})
const seen = store.inbox.seen ?? {}
const seenCt = store.inbox.seenCt ?? {}
// Everything new is opened first: what does not open (not sealed to this job for that inbox: junk, a
// replay into another inbox), a request already handled posted again, and one far too old to be anything
// but a replay are set aside at once and cost nothing. The rest is taken in the order the page made it
// (its own clock, not the inbox's whole seconds: a cancel never overtakes its add, even through another
// inbox), but never earlier than a few minutes before it reached the inbox: a request dated back does not
// jump the queue.
const todo = [], batch = new Set()
// The same request posted again, however it is written out: known by what it seals.
const sealOf = (body) => { const x = JSON.parse(body); return createHash('sha256').update(Buffer.from(String(x.epk), 'base64')).update(Buffer.from(String(x.iv), 'base64')).update(Buffer.from(String(x.ct), 'base64')).digest('hex') }
for (const m of messages.filter((x) => !seen[x.id])) {
  const p = keys ? await openRequest(keys, m.topic, m.message) : null
  if (!p || typeof p !== 'object') { seen[m.id] = now; continue }
  const ct = sealOf(m.message)
  if (seenCt[ct] || batch.has(ct) || (Number.isFinite(p.ts) && p.ts < now - LIMITS.maxAgeMs - 12 * 3600_000)) { seen[m.id] = now; continue }
  batch.add(ct)
  // Masked before anything else is done with them.
  const strings = (xs) => (Array.isArray(xs) ? xs.filter((a) => typeof a === 'string') : [])
  for (const a of [...strings(p.group), ...strings(p.drop), ...(Array.isArray(p.add) ? p.add : []).map((x) => x?.address)]) if (typeof a === 'string') mask(a)
  todo.push({ m, p, ct, ts: Number.isFinite(p.ts) ? Math.max(p.ts, m.time * 1000 - 10 * 60_000) : m.time * 1000 })
}
todo.sort((a, b) => a.ts - b.ts || a.m.time - b.m.time || a.m.id.localeCompare(b.m.id))

// What a request may wait on is given the time left: past it, the request is left for the next run.
const inTime = () => { if (Date.now() > deadline) throw new Error('out of time this run') }
const timed = (promise) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error('out of time this run')), Math.max(0, deadline - Date.now())).unref())])
// An address may be tracked unless it is a contract (an EIP-7702 account is a wallet), or too busy to scan
// (an exchange, a spammed account): judged by the transactions it sent and the token transfers it received
// lately, on every tracked chain.
async function admit(address) {
  for (const c of Object.values(CHAINS)) {
    const cl = clientOf(c)
    const code = await timed(cl.getCode({ address }))
    if (code && code !== '0x' && !code.startsWith('0xef0100')) return 'contract'
    if ((await timed(cl.getTransactionCount({ address }))) > 3000) return 'busy'
    const head = Number(await timed(cl.getBlockNumber()))
    const span = c.key === 'base' ? 200_000 : 7_200 // about 11 hours on Base (0.2 s blocks), a day on Ethereum
    const got = await timed(getLogs({ topics: [TOPIC.Transfer, null, '0x' + address.slice(2).padStart(64, '0')], fromBlock: head - span, toBlock: head, urls: c.rpc.logs, onProgress: inTime }))
    if (got.length > 300) return 'busy'
  }
  return null
}

const held = new Set() // inboxes with a request left for the next run: their later ones wait too, in order
let applied = 0, judged = 0, full = false, taken = 0
const judgedIn = new Map() // inbox -> requests judged from it this run: a pile in one does not hold back the others
const added = []
for (const { m, p, ct } of todo) {
  if (++taken > 200) { full = true; break } // however cheap: the rest next run
  if (held.has(m.topic)) continue
  const count = () => { judged++; judgedIn.set(m.topic, (judgedIn.get(m.topic) ?? 0) + 1) }
  // Past the limits a request that needs the chains asked waits for the next run (and its inbox's later ones
  // with it); one that does not (a drop, a combined view of tracked wallets) is still taken.
  const room = () => judged < MAX_REQUESTS && (judgedIn.get(m.topic) ?? 0) < PER_INBOX && Date.now() < deadline
  const { w } = inboxes.get(m.topic)
  try {
    const req = checkRequest(p, w.address, now)
    // Something sealed that is no request at all is set aside without a word: it would only crowd the log.
    if (req.error === 'not a request') log('a message was set aside: not a request')
    else if (req.error) {
      note({ req: Number.isFinite(p.ts) ? p.ts : null, by: w.key, op: 'request', tail: null, state: 'rejected', reason: req.error })
      log(`a request from ${w.key}'s view was refused: ${req.error}`)
    } else {
      // Applied to a copy, kept only once it went through: a request left for the next run changes nothing.
      const copy = structuredClone(store)
      let asked = false
      const judge = async (a) => {
        if (!asked && !room()) { full = true; throw new Error('more requests than this run takes') }
        asked = true
        if (admitted[a]) return admitted[a].why
        const why = await admit(a)
        admitted[a] = { why, ts: Date.now() }
        return why
      }
      try {
        added.push(...await applyRequest(copy, req, w.key, now, { base: BASE_WALLETS, admit: judge, keyFor: () => newKey(new Set([...BASE_WALLETS, ...copy.extras].map((x) => x.key))) }))
      } catch (e) {
        // A chain's RPC failing, or the time running out, while judging an address: this one and the
        // inbox's later ones wait.
        if (asked) count()
        held.add(m.topic)
        log(`a request was left for the next run: ${String(e.message).slice(0, 100)}`)
        continue
      }
      if (asked) count()
      store = copy
      applied++
    }
    seen[m.id] = now
    seenCt[ct] = now
  } catch (e) {
    // Never one malformed request to stop the others: it is set aside like a foreign one.
    seen[m.id] = now
    log(`a message was set aside: ${String(e.message).slice(0, 100)}`)
  }
  store.inbox = { seen, seenCt }
  save()
}
if (full) log('more requests than this run takes; the rest next run')
// Message ids outlive the inbox's 12 hours a little; sealed requests are remembered as long as one may be used.
for (const [k, t] of Object.entries(seen)) if (now - t > 14 * 3600_000) delete seen[k]
for (const [k, t] of Object.entries(seenCt)) if (now - t > LIMITS.maxAgeMs + 3600_000) delete seenCt[k]
store.inbox = { seen, seenCt }
save()
log(`${todo.length} new requests, ${judged} judged, ${applied} applied, ${added.length} addresses added, ${store.extras.length} tracked on request, ${store.groups.length} combined views`)
// Calls given up on above may still be retrying: the step is done.
process.exit(0)
