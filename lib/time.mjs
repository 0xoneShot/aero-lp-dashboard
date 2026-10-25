// Base produces one block every 2 seconds from genesis, so block <-> time is arithmetic.
export const BASE_GENESIS_TS = 1686789347
export const blockAt = (ts) => Math.floor((ts - BASE_GENESIS_TS) / 2)
export const tsOfBlock = (block) => BASE_GENESIS_TS + 2 * Number(block)

// Days are Beijing calendar days (UTC+8).
const CST = 8 * 3600
export const cstDay = (ts) => new Date((ts + CST) * 1000).toISOString().slice(0, 10)
export const cstDayStartTs = (day) => Date.parse(`${day}T00:00:00Z`) / 1000 - CST
export const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400e3).toISOString().slice(0, 10)

// Last block of a Beijing day: the block just before the next day starts.
export const dayEndBlock = (day) => blockAt(cstDayStartTs(nextDay(day)) - 1)

export function daysBetween(first, last) {
  const out = []
  for (let d = first; d <= last; d = nextDay(d)) out.push(d)
  return out
}
