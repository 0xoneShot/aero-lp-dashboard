// Tells GitHub Actions to mask every form of the tracked wallet addresses in this job's logs: the
// configured ones (AERO_CONFIG), and with `extras`, once the cache is open, the ones added on the page
// (data/cache/extras.json, lib/requests.mjs).
import fs from 'node:fs'
import { getAddress } from 'viem'

const config = JSON.parse(process.env.AERO_CONFIG ?? '{"wallets":[]}')
let addresses = (config.wallets ?? []).map((w) => w.address)
if (process.argv[2] === 'extras') {
  let store = null
  try { store = JSON.parse(fs.readFileSync('data/cache/extras.json', 'utf8')) } catch {}
  addresses = (store?.extras ?? []).map((x) => x.address).filter((a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))
}
for (const address of addresses) {
  const lower = address.toLowerCase()
  for (const v of new Set([lower, getAddress(lower), lower.slice(2), getAddress(lower).slice(2)])) console.log(`::add-mask::${v}`)
}
