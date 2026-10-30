// Block numbers and times. Base has made one block every 2 seconds since genesis, so for as long as
// that holds a block's time is arithmetic on its number. The Denim hard fork (mainnet planned for
// November 2026) moves to 200 ms blocks, five to a second, timestamps still in whole seconds:
// createTimeline() checks the arithmetic against the chain, finds the last block it holds for, and
// past that block reads real timestamps instead, finding each day's last block by binary search.
// What is found is kept in a cache file between runs: the fork block and each finished day's end.
import fs from 'node:fs'

export const BASE_GENESIS_TS = 1686789347
export const formulaTs = (block) => BASE_GENESIS_TS + 2 * Number(block)

// Days are Beijing calendar days (UTC+8).
const CST = 8 * 3600
export const cstDay = (ts) => new Date((ts + CST) * 1000).toISOString().slice(0, 10)
export const cstDayStartTs = (day) => Date.parse(`${day}T00:00:00Z`) / 1000 - CST
export const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10)
export const prevDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86400e3).toISOString().slice(0, 10)

export function daysBetween(first, last) {
  const out = []
  for (let d = first; d <= last; d = nextDay(d)) out.push(d)
  return out
}

// `client` needs only getBlock({ blockNumber }). `head` must be final (the safe head), since what is
// read is cached for good.
export async function createTimeline(client, head, cacheFile) {
  let cache = {}
  try { if (cacheFile && fs.existsSync(cacheFile)) cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch { cache = {} }
  const real = new Map(Object.entries(cache.ts ?? {}).map(([b, t]) => [Number(b), t]))
  const dayEnds = new Map(Object.entries(cache.dayEnds ?? {}).filter(([, b]) => b <= head))
  const keep = new Set(dayEnds.values()) // blocks whose timestamps are worth caching
  const fetchTs = async (b) => {
    if (!real.has(b)) real.set(b, Number((await client.getBlock({ blockNumber: BigInt(b) })).timestamp))
    return real.get(b)
  }

  // The head is always read: every run needs its time.
  const headTs = await fetchTs(head)
  // The last block the arithmetic holds for: the head while nothing has changed; once something has,
  // the block before the first that breaks it (found once, then cached: it cannot move).
  let exactTo = head
  if (cache.exactTo != null && cache.exactTo < head) exactTo = cache.exactTo
  else if (headTs !== formulaTs(head)) {
    let lo = Math.min(cache.checkedTo ?? 0, head), hi = head
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if ((await fetchTs(mid)) === formulaTs(mid)) lo = mid
      else hi = mid
    }
    exactTo = lo
  }

  const tsOf = (block) => {
    const b = Number(block)
    if (b <= exactTo) return formulaTs(b)
    if (real.has(b)) return real.get(b)
    throw new Error(`no timestamp read for block ${b}`)
  }
  // Read the timestamps of blocks past the arithmetic, so tsOf() can answer for them.
  async function ensure(blocks) {
    const todo = [...new Set(blocks.map(Number))].filter((b) => b > exactTo && b <= head)
    for (const b of todo) keep.add(b)
    const missing = todo.filter((b) => !real.has(b))
    for (let i = 0; i < missing.length; i += 8) await Promise.all(missing.slice(i, i + 8).map(fetchTs))
  }
  // The last block whose timestamp is before ts, at most the head; `from` is a block known to be
  // earlier, to narrow the search.
  async function blockBefore(ts, from = exactTo) {
    const guess = Math.floor((ts - 1 - BASE_GENESIS_TS) / 2)
    if (guess < exactTo) return Math.max(0, guess)
    if (headTs < ts) return head
    let lo = Math.max(exactTo, from), hi = head
    if (lo > exactTo && (await fetchTs(lo)) >= ts) lo = exactTo // `from` was not earlier after all
    while (hi - lo > 1) { // ts(lo) < ts <= ts(hi); timestamps never decrease
      const mid = Math.floor((lo + hi) / 2)
      if ((await fetchTs(mid)) < ts) lo = mid
      else hi = mid
    }
    return lo
  }
  // A Beijing day's last block. A finished day past the arithmetic is searched once, from the day
  // before's end, and remembered.
  async function dayEndBlock(day) {
    if (dayEnds.has(day)) return dayEnds.get(day)
    const T = cstDayStartTs(nextDay(day))
    const before = dayEnds.get(prevDay(day))
    const b = await blockBefore(T, before ?? exactTo)
    if (b > exactTo && headTs >= T) { dayEnds.set(day, b); keep.add(b) }
    return b
  }

  function save() {
    if (!cacheFile) return
    const ts = Object.fromEntries([...keep].filter((b) => b > exactTo && b <= head && real.has(b)).map((b) => [b, real.get(b)]))
    fs.writeFileSync(cacheFile + '.tmp', JSON.stringify({ exactTo: exactTo < head ? exactTo : undefined, checkedTo: exactTo, dayEnds: Object.fromEntries(dayEnds), ts }))
    fs.renameSync(cacheFile + '.tmp', cacheFile)
  }
  return { head, exactTo, tsOf, ensure, blockBefore, dayEndBlock, save }
}
