// What the job's workflows must keep true (they cannot be run here): read as text, step by step.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (name) => fs.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
// The steps of a workflow's only job, each as its own text: a step starts at "      - " under "steps:".
function stepsOf(text) {
  const body = text.slice(text.indexOf('\n    steps:\n') + '\n    steps:\n'.length)
  const out = []
  for (const line of body.split('\n')) {
    if (line.startsWith('      - ')) out.push(line)
    else if (out.length) out[out.length - 1] += '\n' + line
  }
  // Comment lines belong to the step after them; they are not the step's own words, and neither are blank
  // lines after it.
  return out.map((s) => s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').trimEnd())
}
const refresh = stepsOf(read('refresh.yml'))
const at = (re, from = 0) => { const i = refresh.findIndex((s, k) => k >= from && re.test(s)); assert.ok(i >= 0, `no step matching ${re}`); return i }
// A step's own if:, whole inside ${{ }} or with none at all (the same to GitHub), without the comment after
// it. Written any other way it is '' here and counts for nothing: going on in the next line, starting with
// "!" outside ${{ }} (YAML reads a tag), or with ${{ }} around a part of it (GitHub then reads a text, which
// is always true).
const ifOf = (s) => {
  const line = (s.match(/^\s+(?:- )?if: (.*?)(?: +#.*)?$(?!\n+ {9})/m)?.[1] ?? '').trim()
  const cond = line.match(/^\$\{\{\s*(.*?)\s*\}\}$/)?.[1] ?? (line.startsWith('!') ? '' : line)
  return /\$\{\{|\}\}/.test(cond) ? '' : cond
}
// Whether a step is taken in a full run only: by its own if:, as a term every other term is and-ed with at
// the top level. The words in its continue-on-error or env, behind an "or", or inside a negated group do not
// count.
const fullOnly = (s) => {
  let top = ifOf(s), was
  do { was = top; top = top.replace(/\([^()]*\)/g, '_') } while (top !== was)
  return top.split(' && ').includes("env.FULL == 'true'") && !top.includes('||')
}

test('only a run asked for as quick is quick: the schedule and a push have no inputs', () => {
  const text = read('refresh.yml')
  assert.match(text, /\n      FULL: \$\{\{ inputs\.mode != 'quick' \}\}\n/)
  assert.match(text, /options: \[full, quick\]\n\s+default: full/)
})

test('what the hourly pass does is left out of a quick run: requests, the update that is kept, alerts, the seal and the saves', () => {
  const only = [/scripts\/requests\.mjs/, /cache-crypt\.mjs seal-requests/, /key: requests-/, /id: update\n/, /id: test\n/, /scripts\/alerts\.mjs/, /scripts\/realized-alerts\.mjs/, /cache-crypt\.mjs seal$/m, /actions\/cache\/save@v4[\s\S]*key: scan-cache-/]
  for (const re of only) {
    const hits = refresh.filter((s) => re.test(s) && !/actions\/cache\/restore/.test(s))
    assert.ok(hits.length >= 1, `no step matching ${re}`)
    for (const s of hits) assert.ok(fullOnly(s), `a quick run would do: ${s.split('\n')[0]}`)
  }
  // Nothing is ever saved by a step a quick run takes: no seal, no save, and no cache action that saves by
  // itself when the job ends (actions/cache does; restore and save each do one thing).
  for (const s of refresh) if (/actions\/cache\/save|cache-crypt\.mjs seal/.test(s)) assert.ok(fullOnly(s), s)
  for (const s of refresh) if (/uses: actions\/cache/.test(s)) assert.match(s, /uses: actions\/cache\/(restore|save)@/)
  // The steps a full run alone takes, counted: one more or fewer is a change made on purpose, here too. (A
  // step a quick run needs that gained the condition would leave it publishing nothing, without a word.)
  assert.equal(refresh.filter(fullOnly).length, 14)
  // And no if: names FULL (or the mode it comes from) in a way this file does not read, which the count would
  // pass over.
  for (const s of refresh) if (/^\s+(?:- )?if: [^#\n]*(?:env\.FULL|inputs\.mode)/m.test(s)) assert.ok(fullOnly(s), `an if: on FULL not read here: ${s.split('\n')[0]}`)
})

test('the fresh pass comes after the cache is sealed and saved, and nothing is sealed or saved after it', () => {
  const seal = at(/cache-crypt\.mjs seal$/m), save = at(/actions\/cache\/save@v4[\s\S]*key: scan-cache-/), fresh = at(/id: fresh\n/)
  assert.ok(seal < save && save < fresh)
  for (const s of refresh.slice(fresh)) assert.doesNotMatch(s, /actions\/cache\/save|cache-crypt\.mjs seal/)
  assert.match(refresh[fresh], /AERO_FRESH: 1/)
  assert.match(refresh[fresh], /run: npm run update /)
  // The one fresh pass of a run: no other step, and not the job's own env, asks for one.
  assert.equal(read('refresh.yml').split('\n').filter((l) => !l.trim().startsWith('#') && /AERO_FRESH/.test(l)).length, 1)
  // The alerts ran before it: they never see what a fresh pass read.
  assert.ok(at(/scripts\/alerts\.mjs/) < fresh)
})

test('a fresh pass that fails publishes the hourly pass\'s data in a full run, and nothing in a quick run', () => {
  const aside = at(/cp -R out out\.safe/), fresh = at(/id: fresh\n/), check = at(/id: freshtest\n/), back = at(/mv out\.safe out/), build = at(/npm run build:site/)
  assert.ok(aside < fresh && fresh < check && check < back && back < build)
  assert.ok(fullOnly(refresh[aside]))
  // Only in a full run may the job go on past a failed fresh pass or failed checks.
  for (const i of [fresh, check]) assert.match(refresh[i], /continue-on-error: \$\{\{ env\.FULL == 'true' \}\}/)
  // Each with a time limit of its own, minutes not hours: a quick run must be over well before the hour.
  for (const i of [fresh, check]) assert.match(refresh[i], /\n\s+timeout-minutes: [1-9]\n/)
  assert.match(refresh[check], /if: \$\{\{ steps\.fresh\.outcome == 'success' \}\}/)
  assert.match(refresh[check], /run: npm test > \/dev\/null 2>&1$/)
  assert.match(refresh[back], /env\.FULL == 'true' && \(steps\.fresh\.outcome != 'success' \|\| steps\.freshtest\.outcome != 'success'\)/)
  // The hourly pass's data is put in the place of the fresh pass's, not beside it (out/ is still there).
  assert.match(refresh[back], /run: rm -rf out && mv out\.safe out$/)
  // What is set aside for that went through the hourly pass and its checks: neither may fail and be passed over.
  for (const id of ['update', 'test']) assert.doesNotMatch(refresh[at(new RegExp(`id: ${id}\\n`))], /continue-on-error/)
  assert.match(refresh[at(/id: test\n/)], /run: npm test$/)
  // With a time limit of its own: a step that runs out of time fails, and the alerts, the seal and the save still
  // run; a job that runs out of time is cancelled, and they do not.
  assert.match(refresh[at(/id: test\n/)], /\n\s+timeout-minutes: [1-9]\n/)
  // The site is built and published only when everything before it went through: no condition of their own
  // on the build, the upload and the first try of the deployment, and no always() or !cancelled() after.
  for (const re of [/npm run build:site/, /configure-pages/, /upload-pages-artifact/, /id: deploy\n/]) assert.doesNotMatch(refresh[at(re)], /\bif:/)
  for (const s of refresh.slice(build)) if (/build:site|configure-pages|upload-pages-artifact|deploy-pages/.test(s)) assert.doesNotMatch(s, /always\(\)|cancelled\(\)/)
})

test('both passes end on a padded time, and say nothing until then', () => {
  for (const [id, file, pad] of [['update', 'update.log', 75], ['fresh', 'fresh.log', 60]]) {
    const i = at(new RegExp(`id: ${id}\\n`))
    // The floors chosen from how long passes have taken (a pass that had nothing to read ends well inside).
    assert.match(refresh[i], new RegExp(`AERO_PAD_SECONDS: ${pad}\\n`))
    // Every line of the log carries the moment it was printed: the pass prints none of its own.
    assert.ok(refresh[i].endsWith(`run: npm run update > "$RUNNER_TEMP/${file}" 2>&1`), refresh[i])
    // The next step prints them, whatever became of the pass, and cannot fail the job itself.
    assert.match(refresh[i + 1], new RegExp(`run: cat "\\$RUNNER_TEMP/${file}" \\|\\| true$`))
    assert.match(refresh[i + 1], new RegExp(`!cancelled\\(\\) .*steps\\.${id}\\.outcome != 'skipped'`))
  }
  // What a fresh pass says in the job is src/update.mjs's to keep to itself (test/e2e): no step shows the
  // checks on its data either.
  assert.match(refresh[at(/id: freshtest\n/)], /run: npm test > \/dev\/null 2>&1$/)
})

test('the deployment waits for the artifact and is tried three times; only the last try may fail the job', () => {
  const upload = at(/upload-pages-artifact/), d1 = at(/id: deploy\n/), d2 = at(/id: deploy2\n/), d3 = at(/id: deploy3\n/)
  assert.ok(upload < d1 && d1 < d2 && d2 < d3)
  assert.match(refresh[upload + 1], /run: sleep \d+/)
  for (const i of [d1, d2]) assert.match(refresh[i], /continue-on-error: true/)
  // Each try gives up after two minutes, not the action's ten: a run stuck here keeps the hourly run waiting.
  for (const i of [d1, d2, d3]) assert.match(refresh[i], /with:\n\s+timeout: 120000$/)
  assert.doesNotMatch(refresh[d3], /continue-on-error/)
  assert.match(refresh[d2], /if: \$\{\{ steps\.deploy\.outcome == 'failure' \}\}/)
  assert.match(refresh[d3], /if: \$\{\{ steps\.deploy2\.outcome == 'failure' \}\}/)
  assert.match(read('refresh.yml'), /url: \$\{\{ steps\.deploy3\.outputs\.page_url \|\| steps\.deploy2\.outputs\.page_url \|\| steps\.deploy\.outputs\.page_url \}\}/)
})

test('a quick run cannot keep the hourly run waiting long, and every full run starts the quick refreshes', () => {
  const text = read('refresh.yml')
  assert.match(text, /\n    timeout-minutes: \$\{\{ inputs\.mode == 'quick' && 10 \|\| 58 \}\}\n/)
  // The first step, in a full run only; failing to start them does not stop the run.
  assert.match(refresh[0], /gh workflow run quick\.yml --ref main$/)
  assert.ok(fullOnly(refresh[0]))
  assert.match(refresh[0], /continue-on-error: true/)
  assert.equal(refresh.filter((s) => /gh workflow run quick\.yml/.test(s)).length, 1)
  // The hourly chain itself is left as it was: the next tick, then the refresh, and nothing else.
  const tick = stepsOf(read('tick.yml')).join('\n')
  assert.deepEqual(tick.match(/gh workflow run \S+/g), ['gh workflow run tick.yml', 'gh workflow run refresh.yml'])
  assert.doesNotMatch(tick, /refresh\.yml --ref main -f/)
  // One refresh at a time, and one under way is never cut short by the next (its cache save, its alerts).
  assert.match(text, /\nconcurrency:\n  group: refresh\n  cancel-in-progress: false\n/)
})

test('the quick refreshes come at fixed times, are quick, and never queue behind another refresh', () => {
  const text = read('quick.yml'), run = stepsOf(text).join('\n')
  // Started by hand or by the tick only: nothing a wallet does starts one.
  assert.match(text, /\non:\n  workflow_dispatch:\n\npermissions:/)
  assert.doesNotMatch(text, /environment:/)
  assert.match(text, /group: quick\n  cancel-in-progress: true/)
  assert.match(run, /gh workflow run refresh\.yml --ref main -f mode=quick/)
  assert.equal(run.match(/gh workflow run/g).length, 1)
  // Asked first whether a refresh is queued, waiting or running; started only when none is.
  assert.ok(run.indexOf('gh run list --workflow refresh.yml') < run.indexOf('gh workflow run refresh.yml'))
  assert.match(run, /if \[ "\$busy" = 0 \]; then\n\s+timeout 60 gh workflow run refresh\.yml/)
  // A list that could not be read counts as busy.
  assert.match(run, /busy=\$\(timeout 60 gh run list [^\n]* \|\| echo unknown\)/)
  // Five in the 59 minutes until the next tick, the last ending well before it.
  const every = Number(text.match(/EVERY: (\d+)/)[1]), times = Number(text.match(/TIMES: (\d+)/)[1]), limit = Number(text.match(/timeout-minutes: (\d+)/)[1])
  assert.ok(every * times <= 55 * 60 && every * times < limit * 60)
  // Every ten minutes, as the page says, each waited for from the loop's own start (not one after another).
  assert.deepEqual([every, times], [600, 5])
  assert.match(run, /wait=\$\(\( start \+ i \* EVERY - \$\(date \+%s\) \)\)\n\s+if \[ "\$wait" -gt 0 \]; then sleep "\$wait"; fi\n/)
})
