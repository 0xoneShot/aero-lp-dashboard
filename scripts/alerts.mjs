// Sends the phone alerts lib/alerts.mjs asks for to the ntfy topic in NTFY_TOPIC (a secret: anyone
// who knows it can read the alerts). Run after `npm run update`; the state is kept in
// data/cache/alerts.json, which travels with the encrypted scan cache. Without NTFY_TOPIC it only
// keeps the state up to date. `--test` sends one test message.
// Only counts are printed: the hourly job's logs are public, and the alerts name the wallets.
import fs from 'node:fs'
import { evaluate } from '../lib/alerts.mjs'

const topic = process.env.NTFY_TOPIC?.trim()
const STATE = 'data/cache/alerts.json', SITE = 'https://0xoneshot.github.io/aero-lp-dashboard/'

async function send(m) {
  const r = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic, title: m.title, message: m.message, priority: m.priority, tags: m.tags, click: SITE }),
  })
  if (!r.ok) throw new Error(`ntfy answered ${r.status}`)
}

if (process.argv[2] === '--test') {
  if (!topic) throw new Error('NTFY_TOPIC is not set')
  await send({ title: 'Aero LP 价格提醒已开启', message: '快到区间下沿、跌出或涨出区间、回到区间，以及跌出区间后 ETH 涨回成本价时，会在这里提醒你。', priority: 3, tags: ['bell'] })
  console.log('alerts: test sent')
  process.exit(0)
}

const summary = JSON.parse(fs.readFileSync('out/summary.json', 'utf8'))
// An unreadable state starts over (records only), rather than stopping the alerts for good.
let prev = null
try { if (fs.existsSync(STATE)) prev = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { console.log('alerts: state unreadable, starting over') }
const { messages, state } = evaluate(summary, prev)
let sent = 0
if (topic) {
  for (const m of messages) {
    try { await send(m); sent++ } catch (e) {
      // Keep the previous state for what was not sent, so the next run tries again.
      if (prev && m.key in prev) state[m.key] = prev[m.key]
      console.log(`alerts: one message failed (${e.message})`)
    }
  }
}
fs.mkdirSync('data/cache', { recursive: true })
fs.writeFileSync(STATE, JSON.stringify(state))
console.log(topic ? `alerts: ${sent} of ${messages.length} sent` : `alerts: off (${messages.length} would have been sent)`)
