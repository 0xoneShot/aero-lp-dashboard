// Each published data file can only be found and read by someone who already knows the wallet
// address(es) it covers: its file name and its AES-GCM key are both derived from the addresses
// with a deliberately slow PBKDF2, so the site does not reveal which wallets it tracks.
// The browser runs the same derivation (site/shell.html); keep the two in step.
//
// The same derivation names the inbox (an ntfy topic) where the page asks the hourly job to track
// another address (lib/requests.mjs): only someone who knows a tracked wallet's address can find its
// inbox. The request itself is sealed to the job's own key pair (jobKeys below; the page carries the
// public half), so reading the inbox, which anyone who knows that one address can, shows nothing: the
// other addresses a request names stay between the page and the job.
const ITERATIONS = 200_000
const SALT = 'aero-lp-dashboard/v1'
// Additional data that keeps a sealed request from being read as anything else, or moved to another inbox.
export const REQUEST_AAD = 'aero-lp-dashboard/request/v2'
const enc = new TextEncoder()

export const normalizeSet = (addresses) => [...new Set(addresses.map((a) => a.trim().toLowerCase()))].sort().join(',')

const b64 = (buf) => Buffer.from(buf).toString('base64')
const hex = (buf) => Buffer.from(buf).toString('hex')

// 512 bits: the first 384 are what they always were (key, file name), so existing files keep their
// names; the rest names the inbox. PBKDF2 computes its second block in full either way, so the extra
// bits cost nothing.
export async function deriveView(addresses) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizeSet(addresses)), 'PBKDF2', false, ['deriveBits'])
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: ITERATIONS }, base, 512))
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt'])
  return { name: hex(bits.slice(32, 48)), key, topic: `aero-${hex(bits.slice(48, 64))}` }
}

// A view's size is public (the file, the site's upload in the job's log), and a view grows when its wallet
// opens a position: the text is filled with spaces to a whole number of VIEW_STEP bytes before it is
// encrypted, so a file's size changes only when a step is crossed, not with every change of what is in it.
// Spaces after the JSON read as nothing, in the browser as here.
export const VIEW_STEP = 32 * 1024
export async function encryptView(addresses, payload) {
  const { name, key } = await deriveView(addresses)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const text = enc.encode(JSON.stringify(payload))
  const padded = new Uint8Array(Math.ceil(text.length / VIEW_STEP) * VIEW_STEP).fill(0x20)
  padded.set(text)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, padded)
  return { name, body: JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) }) }
}

export async function decryptView(addresses, body) {
  const { key } = await deriveView(addresses)
  const { iv, ct } = JSON.parse(body)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, key, Buffer.from(ct, 'base64'))
  return JSON.parse(new TextDecoder().decode(pt))
}

// The job's key pair for requests: made once, kept in the encrypted cache (lib/requests.mjs jobKeys).
export async function newJobKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  return { v: 1, jwk: await crypto.subtle.exportKey('jwk', pair.privateKey), pub: b64(await crypto.subtle.exportKey('raw', pair.publicKey)) }
}

// The AES key for one request: ECDH between a key pair made for that request alone and the job's, then
// HKDF over the request's public half.
async function requestKey(priv, pubRaw, epk, use) {
  const pub = await crypto.subtle.importKey('raw', pubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256)
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: enc.encode(REQUEST_AAD) }, hk, { name: 'AES-GCM', length: 256 }, false, [use])
}

// A request as the page seals it (site/shell.html does the same in the browser), for the tests and tools:
// to the job's public key (base64, raw), for the inbox `topic`.
export async function sealRequest(jobPub, topic, payload) {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))
  const key = await requestKey(eph.privateKey, Buffer.from(jobPub, 'base64'), epk, 'encrypt')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${REQUEST_AAD}\n${topic}`) }, key, enc.encode(JSON.stringify(payload)))
  return JSON.stringify({ v: 2, epk: b64(epk), iv: b64(iv), ct: b64(ct) })
}

// The request inside a message body found in inbox `topic`, or null when it was not sealed to the job's
// key for that inbox (garbage, another inbox's, a data file posted back): nothing about a body that fails
// is trusted. `keys`: jobKeys().
export async function openRequest(keys, topic, body) {
  let msg
  try { msg = JSON.parse(body) } catch { return null }
  if (!msg || msg.v !== 2 || typeof msg.epk !== 'string' || typeof msg.iv !== 'string' || typeof msg.ct !== 'string' || msg.ct.length > 8000 || msg.epk.length > 100) return null
  try {
    keys.priv ??= await crypto.subtle.importKey('jwk', keys.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
    const epk = Buffer.from(msg.epk, 'base64')
    const key = await requestKey(keys.priv, epk, epk, 'decrypt')
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(msg.iv, 'base64'), additionalData: enc.encode(`${REQUEST_AAD}\n${topic}`) }, key, Buffer.from(msg.ct, 'base64'))
    return JSON.parse(new TextDecoder().decode(pt))
  } catch { return null }
}
