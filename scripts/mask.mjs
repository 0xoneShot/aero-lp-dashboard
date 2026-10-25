// Tells GitHub Actions to mask every form of the tracked wallet addresses in this job's logs.
import { getAddress } from 'viem'

const config = JSON.parse(process.env.AERO_CONFIG ?? '{"wallets":[]}')
for (const w of config.wallets ?? []) {
  const lower = w.address.toLowerCase()
  for (const v of new Set([lower, getAddress(lower), lower.slice(2), getAddress(lower).slice(2)])) console.log(`::add-mask::${v}`)
}
