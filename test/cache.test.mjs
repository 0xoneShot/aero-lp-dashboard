// scripts/cache-crypt.mjs as the job runs it, in working directories of its own with made-up files: what is
// sealed into the Actions cache opens again as it was, and its size (which is public) moves only in whole steps.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash, createCipheriv, randomBytes } from 'node:crypto'

const SCRIPT = fileURLToPath(new URL('../scripts/cache-crypt.mjs', import.meta.url))
// A made-up configuration: the key is derived from it, nothing else of it is read.
const run = (cwd, arg, config = '{"wallets":[]}') => spawnSync(process.execPath, [SCRIPT, arg], { cwd, env: { PATH: process.env.PATH, AERO_CONFIG: config }, encoding: 'utf8' })
const MiB = 1024 * 1024, HEAD = 12 + 16 // the iv and the cipher's tag come before the text
// A word no path holds: what is sealed carries it, and nothing printed may (not even its first letters, which
// is all JSON.parse's own message would quote).
const MARK = 'zq-sealed-marker', MARKED = /zq-sealed/
// A text sealed as the script seals it, with the made-up configuration's key (scripts/cache-crypt.mjs).
function sealText(text, config = '{"wallets":[]}') {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', createHash('sha256').update(`aero-lp-dashboard cache v1\n${config}`).digest(), iv)
  const ct = Buffer.concat([c.update(Buffer.from(text)), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), ct])
}

test('the sealed cache grows only by whole steps, and opens to the files it was sealed from', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-cache-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-cache-'))
  try {
    const dir = path.join(a, 'data/cache')
    fs.mkdirSync(dir, { recursive: true })
    const files = {
      'scan.json': JSON.stringify({ version: 1, scannedTo: 1000, mark: MARK, txs: { made: 'up 一二三 "q" \\' } }),
      'alerts.json': '{"w1:2000-2500":"in"}',
      'extras.json': JSON.stringify({ v: 1, gen: 2, next: { g: 1 }, extras: [], groups: [], inbox: {}, letGo: [], log: [] }),
      'secret.json': '{"v":1,"made":"up"}',
    }
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text)
    fs.writeFileSync(path.join(dir, 'not-json.log'), 'left out')
    const sizes = () => ['cache.enc', 'requests.enc'].map((f) => fs.statSync(path.join(a, f)).size)
    for (const arg of ['seal', 'seal-requests']) assert.equal(run(a, arg).status, 0)
    assert.deepEqual(sizes(), [HEAD + MiB, HEAD + 16 * 1024])
    // More inside a step changes no size; a step crossed adds a whole one.
    fs.writeFileSync(path.join(dir, 'more.json'), JSON.stringify({ rows: 'x'.repeat(5000) }))
    assert.equal(run(a, 'seal').status, 0)
    assert.deepEqual(sizes(), [HEAD + MiB, HEAD + 16 * 1024])
    fs.writeFileSync(path.join(dir, 'more.json'), JSON.stringify({ rows: 'x'.repeat(MiB) }))
    assert.equal(run(a, 'seal').status, 0)
    assert.equal(sizes()[0], HEAD + 2 * MiB)
    files['more.json'] = fs.readFileSync(path.join(dir, 'more.json'), 'utf8')
    // Opened elsewhere: every file as it was, and nothing else.
    for (const f of ['cache.enc', 'requests.enc']) fs.copyFileSync(path.join(a, f), path.join(b, f))
    const opened = run(b, 'open')
    assert.equal(opened.status, 0, opened.stderr.slice(0, 300))
    assert.deepEqual(fs.readdirSync(path.join(b, 'data/cache')).sort(), Object.keys(files).sort())
    for (const [f, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(b, 'data/cache', f), 'utf8'), text)
    // With another configuration's key it does not open, and says nothing of what is inside.
    const other = run(b, 'open', '{"wallets":[{"made":"up"}]}')
    assert.notEqual(other.status, 0)
    assert.doesNotMatch(other.stderr + other.stdout, MARKED)
  } finally { for (const d of [a, b]) fs.rmSync(d, { recursive: true, force: true }) }
})

test('a cache that opens with its key but does not read as files fails without quoting what is in it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-cache-'))
  try {
    // Not JSON at all: JSON.parse's own message would quote the text where it stopped.
    fs.writeFileSync(path.join(dir, 'cache.enc'), sealText(`${MARK} 0xabc`))
    const r = run(dir, 'open')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /cache\.enc opened, but what is in it does not read as the files sealed into it/)
    assert.doesNotMatch(r.stderr + r.stdout, MARKED)
    assert.equal(fs.existsSync(path.join(dir, 'data/cache/scan.json')), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
