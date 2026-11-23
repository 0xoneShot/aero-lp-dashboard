import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveView, encryptView, decryptView, sealRequest, openRequest, normalizeSet, newJobKeys, VIEW_STEP } from '../lib/views.mjs'
import { checkRequest, applyRequest, emptyStore, cleanName, newKey, pushLog, letGo, recordRun, suspects, HEALTH, LIMITS } from '../lib/requests.mjs'
import { addedTxCounts } from '../lib/scan.mjs'

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), X = '0x' + 'a'.repeat(39) + 'b', Y = '0x' + 'c'.repeat(40)
const enc = new TextEncoder()

test('the inbox bits come after the old ones: existing data files keep their names and keys', async () => {
  // The derivation as it was (384 bits), computed here independently.
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizeSet([A, B])), 'PBKDF2', false, ['deriveBits'])
  const old = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('aero-lp-dashboard/v1'), iterations: 200_000 }, base, 384))
  const d = await deriveView([B, A])
  assert.equal(d.name, Buffer.from(old.slice(32, 48)).toString('hex'))
  const oldKey = await crypto.subtle.importKey('raw', old.slice(0, 32), 'AES-GCM', false, ['decrypt'])
  const { body } = await encryptView([A, B], { hello: 1 })
  const { iv, ct } = JSON.parse(body)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, oldKey, Buffer.from(ct, 'base64'))
  assert.deepEqual(JSON.parse(new TextDecoder().decode(pt)), { hello: 1 })
  // The inbox: a valid ntfy topic (up to 64 characters of [-_A-Za-z0-9]), not the public file name.
  assert.match(d.topic, /^aero-[0-9a-f]{32}$/)
  assert.ok(!d.topic.includes(d.name))
  assert.notEqual((await deriveView([A])).topic, d.topic)
})

test('a view file grows only by whole steps, whatever is added inside one, and reads back the same', async () => {
  // The encrypted bytes of a view (the 16 after the text are the cipher's tag).
  const size = async (p) => Buffer.from(JSON.parse((await encryptView([A], p)).body).ct, 'base64').length
  const small = { rows: ['一'] }, more = { rows: ['一', 'b'.repeat(700)] }
  assert.equal(await size(small), VIEW_STEP + 16)
  assert.equal(await size(more), await size(small))
  // Counted in bytes, not characters: three bytes a character here, just over one step.
  const wide = { rows: ['一'.repeat(Math.ceil(VIEW_STEP / 3))] }
  assert.equal(await size(wide), 2 * VIEW_STEP + 16)
  // Exactly one step of text is not padded further.
  const exact = { r: 'c'.repeat(VIEW_STEP - '{"r":""}'.length) }
  assert.equal(await size(exact), VIEW_STEP + 16)
  for (const p of [small, more, wide, exact]) assert.deepEqual(await decryptView([A], (await encryptView([A], p)).body), p)
  // The page reads the text the same way: JSON with spaces after it.
  const { key } = await deriveView([A]), { iv, ct } = JSON.parse((await encryptView([A], more)).body)
  const text = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, key, Buffer.from(ct, 'base64')))
  assert.match(text, /^\{.*\} +$/s)
  assert.deepEqual(JSON.parse(text), more)
})

test('a request opens only with the job\'s key, only in the inbox it was sent to, and a data file is never read as one', async () => {
  const keys = await newJobKeys(), other = await newJobKeys()
  const { topic, key } = await deriveView([A])
  const p = { type: 'aero-request', v: 1, ts: 1, group: [A, X], add: [{ address: X, name: 'n' }], drop: [] }
  const body = await sealRequest(keys.pub, topic, p)
  assert.ok(body.length < 4095, 'fits an ntfy message')
  assert.deepEqual(await openRequest(keys, topic, body), p)
  // Someone who knows A (and so its inbox and its view key) cannot read it; nor can another key pair.
  assert.equal(await openRequest({ jwk: other.jwk }, topic, body), null)
  assert.ok(!body.includes(X.slice(2)) && !body.includes(A.slice(2)))
  const m = JSON.parse(body)
  await assert.rejects(crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(m.iv, 'base64') }, key, Buffer.from(m.ct, 'base64')))
  // Copied into another inbox, it does not open there.
  assert.equal(await openRequest(keys, (await deriveView([B])).topic, body), null)
  // A view file posted to the inbox is not a request.
  const { body: file } = await encryptView([A], p)
  assert.equal(await openRequest(keys, topic, file), null)
  assert.equal(await decryptView([A], file).then((x) => x.type), 'aero-request')
  // Tampered, truncated, or not JSON at all.
  const flip = Buffer.from(m.ct, 'base64'); flip[0] ^= 1
  assert.equal(await openRequest(keys, topic, JSON.stringify({ ...m, ct: flip.toString('base64') })), null)
  assert.equal(await openRequest(keys, topic, 'triggered'), null)
  assert.equal(await openRequest(keys, topic, JSON.stringify({ v: 1, iv: m.iv, ct: m.ct })), null)
  // A new address's key is random and says nothing about the address.
  const k = newKey(new Set(['w1']))
  assert.match(k, /^x[0-9a-f]{8}$/)
  assert.notEqual(newKey(new Set()), newKey(new Set()))
})

test('a request is checked before anything is done with it', () => {
  const now = 1_800_000_000_000
  const ok = { type: 'aero-request', v: 1, ts: now - 60_000, group: [A, X], add: [{ address: X, name: ' 我的 ETH <b> ' }], drop: [] }
  const r = checkRequest(ok, A, now)
  assert.equal(r.error, undefined)
  assert.deepEqual(r.add, [{ address: X, name: '我的 ETH b' }])
  assert.equal(checkRequest({ ...ok, ts: now - LIMITS.maxAgeMs - 1 }, A, now).error, 'stale')
  assert.equal(checkRequest({ ...ok, ts: now + LIMITS.futureMs + 1 }, A, now).error, 'stale')
  assert.equal(checkRequest({ ...ok, type: 'x' }, A, now).error, 'not a request')
  // The inbox's own wallet must be in the group: a request speaks only for views its sender can open.
  assert.equal(checkRequest(ok, B, now).error, 'not the sender\'s view')
  assert.equal(checkRequest({ ...ok, add: [{ address: Y }] }, A, now).error, 'bad add')
  assert.equal(checkRequest({ ...ok, group: [A, 'nope'] }, A, now).error, 'bad group')
  assert.equal(checkRequest({ ...ok, drop: [X] }, A, now).error, 'bad drop')
  // An address asking through its own inbox to stop being tracked, and nothing else.
  const self = { type: 'aero-request', v: 1, ts: now, group: [X], add: [], drop: [X] }
  assert.deepEqual(checkRequest(self, X, now).drop, [X])
  assert.equal(checkRequest({ ...self, group: [X, A] }, X, now).error, 'bad drop')
  assert.equal(checkRequest({ ...self, group: [A], drop: [A] }, X, now).error, 'not the sender\'s view')
  assert.equal(checkRequest({ ...ok, group: [A, ...Array.from({ length: LIMITS.groupSize }, (_, i) => '0x' + String(i + 3).repeat(40)), X] }, A, now).error, 'bad group')
  assert.equal(checkRequest({ ...ok, group: [A.toUpperCase().replace('0X', '0x'), X] }, A, now).error, undefined)
})

test('names are plain text and short', () => {
  assert.equal(cleanName('<img src=x onerror=alert(1)>'), 'img srcx onerroralert(1)'.slice(0, LIMITS.name))
  assert.equal(cleanName('ETH 账户\u0000‮'), 'ETH 账户')
  assert.equal(cleanName(42), '')
  assert.equal([...cleanName('一二三四五六七八九十一二三四五六七八')].length, LIMITS.name)
})

const base = [{ key: 'w1', address: A }, { key: 'w2', address: B }]
const keyFor = (a) => `x${a.slice(-8)}`
const ctx = (admit = async () => null) => ({ base, admit, keyFor })
const req = (o) => ({ ts: 5, group: [A, X], add: [{ address: X, name: '' }], drop: [], ...o })

test('adding an address tracks it, under its own key, and asks for the combined view once', async () => {
  const s = emptyStore()
  assert.deepEqual(await applyRequest(s, req({}), 'w1', 100, ctx()), [X])
  assert.deepEqual(s.extras, [{ key: keyFor(X), address: X, label: `地址 ${X.slice(-4)}`, by: 'w1', addedTs: 100, req: 5 }])
  assert.deepEqual(s.groups, [{ key: 'g1', members: [keyFor(X), 'w1'].sort(), by: 'w1', addedTs: 100, usedTs: 100 }])
  // The same request again (the page asking again while it waits) changes nothing.
  assert.deepEqual(await applyRequest(s, req({ ts: 6 }), 'w1', 200, ctx()), [])
  assert.equal(s.extras.length, 1)
  assert.equal(s.groups.length, 1)
  assert.deepEqual(s.log.map((x) => [x.op, x.state]), [['add', 'accepted'], ['group', 'accepted'], ['add', 'exists'], ['group', 'exists']])
  assert.ok(s.log.every((x) => x.tail === null || x.tail.length === 4), 'the log names an address by its last four characters only')
})

test('an address the job let go is not taken back for a while, nor the request that brings it', async () => {
  const s = emptyStore()
  letGo(s, X, 'broke', 1000)
  assert.deepEqual(await applyRequest(s, req({ group: [A, X, Y], add: [{ address: X, name: '' }, { address: Y, name: '' }] }), 'w1', 2000, ctx()), [])
  assert.deepEqual(s.log.map((x) => [x.tail, x.state, x.reason]), [[X.slice(-4), 'rejected', 'broke'], [Y.slice(-4), 'rejected', 'with a refused one']])
  assert.deepEqual(await applyRequest(s, req({}), 'w1', 1000 + LIMITS.letGoMs + 1, ctx()), [X])
  // Remembered once, the latest reason, and only for a while.
  letGo(s, X, 'failed', 5000); letGo(s, X, 'broke', 6000)
  assert.deepEqual(s.letGo, [{ address: X, reason: 'broke', ts: 6000 }])
  letGo(s, Y, 'failed', 6000 + LIMITS.letGoMs)
  assert.deepEqual(s.letGo.map((x) => x.address), [Y])
})

test('a combined view\'s key never stands for a wallet too', async () => {
  const s = emptyStore()
  const named = { base: [{ key: 'g1', address: A }, { key: 'g2', address: B }], admit: async () => null, keyFor }
  await applyRequest(s, req({}), 'g1', 1, named)
  assert.equal(s.groups.length, 1)
  assert.ok(!['g1', 'g2', 'total', keyFor(X)].includes(s.groups[0].key))
})

test('the configured wallets together are never asked for again, and a member must be tracked or added', async () => {
  const s = emptyStore()
  await applyRequest(s, req({ group: [A, B], add: [] }), 'w1', 1, ctx())
  assert.deepEqual(s.groups, [])
  await applyRequest(s, req({ group: [A, Y], add: [] }), 'w1', 1, ctx())
  assert.deepEqual(s.extras, [])
  assert.equal(s.log.at(-1).reason, 'not tracked')
})

test('a busy address is refused, and so is the request that brings it', async () => {
  const s = emptyStore()
  const out = await applyRequest(s, req({ group: [A, X, Y], add: [{ address: X, name: '' }, { address: Y, name: '' }] }), 'w1', 1, ctx(async (a) => (a === Y ? 'busy' : null)))
  assert.deepEqual(out, [])
  assert.deepEqual(s.extras, [])
  assert.deepEqual(s.log.map((x) => x.reason), ['with a refused one', 'busy'])
})

test('there is a limit to the addresses tracked on request', async () => {
  const s = emptyStore()
  for (let i = 0; i < LIMITS.extras; i++) s.extras.push({ key: `x${i}`, address: '0x' + String(i).repeat(40), label: '', by: 'w1', addedTs: 0 })
  assert.deepEqual(await applyRequest(s, req({}), 'w1', 1, ctx()), [])
  assert.equal(s.log.at(-1).reason, 'too many')
})

test('dropping an address stops tracking it and its combined views; a configured wallet cannot be dropped', async () => {
  const s = emptyStore()
  await applyRequest(s, req({}), 'w1', 1, ctx())
  await applyRequest(s, { ts: 7, group: [A], add: [], drop: [X, B] }, 'w1', 2, ctx())
  assert.deepEqual(s.extras, [])
  assert.deepEqual(s.groups, [])
  assert.deepEqual(s.log.slice(-2).map((x) => [x.op, x.state, x.reason]), [['drop', 'done', null], ['drop', 'ignored', 'configured']])
})

test('whoever can see an added address can stop it being tracked: through any inbox, or its own', async () => {
  const s = emptyStore()
  await applyRequest(s, req({}), 'w1', 1, ctx())
  await applyRequest(s, { ts: 8, group: [B], add: [], drop: [X] }, 'w2', 2, ctx())
  assert.equal(s.extras.length, 0, 'through another wallet\'s inbox')
  // Done, and told where it was added, under the request that added it.
  assert.deepEqual(s.log.slice(-2).map((x) => [x.by, x.req, x.op, x.state, x.reason]), [['w2', 8, 'drop', 'done', null], ['w1', 5, 'add', 'rejected', 'dropped']])
  await applyRequest(s, req({ ts: 9 }), 'w1', 3, ctx())
  const self = checkRequest({ type: 'aero-request', v: 1, ts: 10, group: [X], add: [], drop: [X] }, X, 10)
  assert.deepEqual(await applyRequest(s, self, keyFor(X), 11, ctx()), [])
  assert.deepEqual([s.extras, s.groups], [[], []], 'through its own inbox')
  // Stopped from its own view: the adding view is told so, and it is not taken back for a while.
  assert.deepEqual([s.log.at(-1).by, s.log.at(-1).reason], ['w1', 'stopped'])
  assert.deepEqual(await applyRequest(s, req({ ts: 12 }), 'w1', 12, ctx()), [])
  assert.equal(s.log.at(-1).reason, 'stopped')
  assert.deepEqual(await applyRequest(s, req({ ts: 13 }), 'w1', 11 + LIMITS.letGoMs, ctx()), [X])
})

test('an address already tracked is noted before a refusal, and a member not tracked refuses the adds too', async () => {
  const s = emptyStore()
  await applyRequest(s, req({}), 'w1', 1, ctx())
  await applyRequest(s, req({ ts: 6, group: [A, X, Y], add: [{ address: X, name: '' }, { address: Y, name: '' }] }), 'w1', 2, ctx(async () => 'contract'))
  assert.deepEqual(s.log.slice(-2).map((e) => [e.op, e.tail, e.state, e.reason]), [['add', X.slice(-4), 'exists', null], ['add', Y.slice(-4), 'rejected', 'contract']])
  const Z = '0x' + 'd'.repeat(40)
  await applyRequest(s, req({ ts: 7, group: [A, Y, Z], add: [{ address: Y, name: '' }] }), 'w1', 3, ctx())
  assert.deepEqual(s.log.slice(-2).map((e) => [e.op, e.tail, e.state, e.reason]), [['group', Z.slice(-4), 'rejected', 'not tracked'], ['add', Y.slice(-4), 'rejected', 'not tracked']])
  assert.equal(s.extras.length, 1)
})

test('a full inbox\'s least recently asked combined view gives way to a new one', async () => {
  const s = emptyStore()
  const xs = Array.from({ length: LIMITS.extrasPerInbox }, (_, i) => '0x' + (i + 3).toString(16).repeat(40))
  for (const a of xs) s.extras.push({ key: keyFor(a), address: a, label: '', by: 'w1', addedTs: 0 })
  // Views of A with every non-empty subset of the added addresses, more than the inbox may keep.
  const sets = Array.from({ length: 2 ** xs.length - 1 }, (_, m) => xs.filter((_, i) => ((m + 1) >> i) & 1)).slice(0, LIMITS.groupsPerInbox + 1)
  const same = (g, set) => g.members.length === set.length + 1 && set.every((a) => g.members.includes(keyFor(a)))
  for (const [i, set] of sets.entries()) {
    await applyRequest(s, { ts: i, group: [A, ...set], add: [], drop: [] }, 'w1', 10 + i, ctx())
    if (i === 1) await applyRequest(s, { ts: 50, group: [A, ...sets[0]], add: [], drop: [] }, 'w1', 11.5, ctx()) // the first asked again
  }
  assert.equal(s.groups.filter((g) => g.by === 'w1').length, LIMITS.groupsPerInbox)
  assert.ok(s.groups.some((g) => same(g, sets[0])), 'asked again: kept')
  assert.ok(!s.groups.some((g) => same(g, sets[1])), 'the least recently asked went')
  assert.ok(s.groups.some((g) => same(g, sets.at(-1))), 'the new one is there')
  assert.ok(s.log.every((e) => e.reason !== 'too many'))
})

test('one inbox cannot use up the room for everyone', async () => {
  const s = emptyStore()
  for (let i = 0; i < LIMITS.extrasPerInbox; i++) s.extras.push({ key: `x${i}`, address: '0x' + String(i + 3).repeat(40), label: '', by: 'w1', addedTs: 0 })
  assert.deepEqual(await applyRequest(s, req({}), 'w1', 1, ctx()), [])
  assert.equal(s.log.at(-1).reason, 'too many')
  assert.deepEqual(await applyRequest(s, req({ group: [B, X] }), 'w2', 1, ctx()), [X], 'another inbox still can')
})

test('a name cannot pass for another script\'s letters or the combined view', () => {
  assert.equal(cleanName('сс'), '') // Cyrillic look-alikes of "cc"
  assert.equal(cleanName('Ian 的钱包'), 'Ian 的钱包')
})

test('an inbox\'s answers cannot be pushed out of the log by another inbox', () => {
  const store = emptyStore()
  pushLog(store, { by: 'w1', req: 1, op: 'add', state: 'accepted' })
  for (let i = 0; i < 500; i++) pushLog(store, { by: 'x1', req: 100 + i, op: 'add', state: 'rejected' })
  assert.equal(store.log.filter((e) => e.by === 'x1').length, LIMITS.logPerInbox)
  assert.ok(store.log.some((e) => e.by === 'w1' && e.req === 1))
  assert.ok(store.log.length <= LIMITS.log)
})

test('added addresses that keep the update from finishing are let go, the ones to blame first', () => {
  const extras = ['xa', 'xb', 'xc'].map((key) => ({ key }))
  const fail = (why, tried) => ({ at: 1, ok: false, why, tried })
  let h = { runs: [], ok: [] }
  assert.equal(suspects(h, extras), null)
  // A run that finished vouches for what it had caught up.
  h = recordRun(h, { at: 0, ok: true }, ['xa'])
  assert.deepEqual(h.ok, ['xa'])
  for (let i = 1; i < HEALTH.errors; i++) h = recordRun(h, fail('error', ['xa', 'xb']))
  assert.equal(suspects(h, extras), null, 'not yet')
  h = recordRun(h, fail('error', ['xa', 'xb']))
  // xa worked before; xb never has: only xb is let go.
  assert.deepEqual(suspects(h, extras), { keys: ['xb'], reason: 'broke' })
  // A run that finished in between starts the count over.
  h = recordRun(h, { at: 2, ok: true }, ['xa'])
  assert.equal(suspects(h, extras), null)
  // Every one tried had worked before: all those tried.
  for (let i = 0; i < HEALTH.errors; i++) h = recordRun(h, fail('error', ['xa']))
  assert.deepEqual(suspects(h, extras), { keys: ['xa'], reason: 'broke' })
  // Runs that did not say what they had caught up: every added address.
  let u = { runs: [], ok: [] }
  for (let i = 0; i < HEALTH.errors; i++) u = recordRun(u, fail('error', null))
  assert.deepEqual(suspects(u, extras), { keys: ['xa', 'xb', 'xc'], reason: 'broke' })
  // Running out of time (a long history read over a few runs) takes longer to count, then counts as failing.
  let t = { runs: [], ok: [] }
  for (let i = 1; i < HEALTH.late; i++) t = recordRun(t, fail(i % 2 ? 'time' : 'error', ['xc']))
  assert.equal(suspects(t, extras), null)
  t = recordRun(t, fail('time', ['xc']))
  assert.deepEqual(suspects(t, extras), { keys: ['xc'], reason: 'failed' })
  // When the ones to blame are no longer tracked, nobody else is; one no longer tracked is never named.
  assert.equal(suspects(t, extras.filter((x) => x.key !== 'xc')), null)
  t = recordRun(t, fail('time', ['xb', 'xc']))
  assert.deepEqual(suspects(t, extras.filter((x) => x.key !== 'xc')), { keys: ['xb'], reason: 'failed' })
  // Failed runs with nothing caught up: nothing but the added addresses set them apart.
  let n = { runs: [], ok: ['xa'] }
  for (let i = 0; i < HEALTH.errors; i++) n = recordRun(n, fail('error', []))
  assert.deepEqual(suspects(n, extras), { keys: ['xa', 'xb', 'xc'], reason: 'broke' })
  // Those caught up all worked before, one was still being caught up: the catching up is to blame, not them.
  let c = { runs: [], ok: ['xa', 'xb'] }
  for (let i = 0; i < HEALTH.errors; i++) c = recordRun(c, { ...fail('error', ['xa', 'xb']), behind: ['xc'] })
  assert.deepEqual(suspects(c, extras), { keys: ['xc'], reason: 'broke' })
  // But one new in the datasets goes first.
  c = recordRun({ runs: [], ok: ['xa'] }, { ...fail('error', ['xa', 'xb']), behind: ['xc'] })
  for (let i = 1; i < HEALTH.errors; i++) c = recordRun(c, { ...fail('error', ['xa', 'xb']), behind: ['xc'] })
  assert.deepEqual(suspects(c, extras), { keys: ['xb'], reason: 'broke' })
  assert.ok(t.runs.length <= HEALTH.keep)
})

test('what an added address brought in is counted for it alone: sent, received or named in a log, marked ones only', () => {
  const pad = (a) => '0x' + a.slice(2).padStart(64, '0')
  const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', Z = '0x' + '4'.repeat(40)
  const state = {
    txs: {
      h1: { x: 1, from: X, to: Y, logs: [] }, // sent by it
      h2: { x: 1, from: Y, to: '0x' + '3'.repeat(40), logs: [{ topics: [T, pad(Y), pad(X)] }] }, // a token to it
      h3: { x: 1, from: Y, to: Y, ethHint: [X], logs: [] }, // ETH to it inside a contract call
      h4: { from: X, to: A, logs: [] }, // a configured wallet's too: not marked, not counted
      h5: { x: 1, from: Y, to: B, logs: [] }, // names neither
    },
  }
  const n = addedTxCounts(state, [X, Z])
  assert.equal(n.get(X), 3)
  assert.equal(n.get(Z), 0)
  assert.equal(addedTxCounts(null, [X]).get(X), 0)
  assert.ok(LIMITS.txs >= 1000, 'an ordinary wallet stays well under it')
})
