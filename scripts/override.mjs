// Records a hand correction for a transaction without putting its hash in the public repository
// (lib/overrides.mjs): node scripts/override.mjs <walletKey> <cls> <tx hash>
// cls: transfer (money in or out from outside), internal, bridge, between (the tracked wallets), reward.
import fs from 'node:fs'
import { WALLETS, BASE_WALLETS, OVERRIDES_FILE } from '../lib/config.mjs'
import { CLASSES, overrideSecret, overrideKey } from '../lib/overrides.mjs'

const [walletKey, cls, hash] = process.argv.slice(2)
if (!WALLETS.some((w) => w.key === walletKey)) throw new Error(`unknown wallet key ${walletKey}`)
if (!CLASSES.has(cls)) throw new Error(`cls must be one of ${[...CLASSES].join(', ')}`)
if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) throw new Error('a transaction hash (0x + 64 hex) is needed')
const raw = fs.existsSync(OVERRIDES_FILE) ? JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')) : {}
// Keyed from the configured wallets only (as src/run.mjs reads them): adding an address on the page
// never re-keys an entry.
const key = overrideKey(overrideSecret(BASE_WALLETS.map((w) => w.address)), hash)
raw[key] = { ...(raw[key] ?? {}), [walletKey]: cls }
fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(raw, null, 2) + '\n')
console.log(`recorded ${walletKey}: ${cls} as ${key.slice(0, 10)}…`)
