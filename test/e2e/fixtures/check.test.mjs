// Stands in for test/invariants.test.mjs in test/e2e/update.test.mjs: looks at what the pass left in the cache
// (it runs before a fresh pass's caches are put back), fails when CHECK=fail and never ends when CHECK=hang.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('the pass\'s scan is still there to be checked', async () => {
  assert.ok(fs.existsSync('data/cache/written-by-the-pass.json'), 'the caches were put back before the checks ran')
  fs.appendFileSync('checks', 'x')
  if (process.env.CHECK === 'hang') await new Promise(() => { setInterval(() => {}, 1000) })
  assert.notEqual(process.env.CHECK, 'fail', 'the checks were told to fail')
})
