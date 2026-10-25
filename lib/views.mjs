// Each published data file can only be found and read by someone who already knows the wallet
// address(es) it covers: its file name and its AES-GCM key are both derived from the addresses
// with a deliberately slow PBKDF2, so the site does not reveal which wallets it tracks.
// The browser runs the same derivation (site/shell.html); keep the two in step.
const ITERATIONS = 200_000
const SALT = 'aero-lp-dashboard/v1'
const enc = new TextEncoder()

export const normalizeSet = (addresses) => [...new Set(addresses.map((a) => a.trim().toLowerCase()))].sort().join(',')

const b64 = (buf) => Buffer.from(buf).toString('base64')
const hex = (buf) => Buffer.from(buf).toString('hex')

export async function deriveView(addresses) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizeSet(addresses)), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: ITERATIONS }, base, 384))
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { name: hex(bits.slice(32, 48)), key }
}

export async function encryptView(addresses, payload) {
  const { name, key } = await deriveView(addresses)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)))
  return { name, body: JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) }) }
}

export async function decryptView(addresses, body) {
  const { key } = await deriveView(addresses)
  const { iv, ct } = JSON.parse(body)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, key, Buffer.from(ct, 'base64'))
  return JSON.parse(new TextDecoder().decode(pt))
}
