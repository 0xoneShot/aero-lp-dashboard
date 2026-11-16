// BTC and ETH against their realized price ("全网持仓成本"): the price each coin last moved at, averaged over
// the supply, as Coin Metrics works it out (PriceUSD / CapMVRVCur: the community API gives no realized cap
// itself). Below it the coins out there are worth less, on the whole, than they were last bought for. Pure:
// the rules, and reading the sources' answers; scripts/realized-alerts.mjs fetches, sends and keeps the state.
//
// Per coin and level (a multiple of the realized price, LEVELS):
//   break  the price fell below the level: once per crossing, re-armed once the price is REARM above the level
//          again (so a price hovering at it does not send every hour). Levels crossed together (a crash, or
//          data back after a gap) make one message, named by the lowest.
//   back   the price is back above the realized price itself (1x) by REARM: the one level told both ways.
// For both coins:
//   open   the first time both are judged: where they stand, and what will be told. A level with no state yet
//          is only recorded, as with the wallet alerts, so a first run tells nothing else.
//   down   a coin could not be judged (no price, or no realized price fresh enough) for DOWN_MS: told once.
//   up     that coin is judged again. A level it is below by then, and was not before, is told as well; one
//          crossed and regained in between is not (there were no prices to see it by).
// The levels are where past bear markets bottomed: each one's daily low over the realized price that day
// (BTC's lows from Bitstamp, ETH's from Binance, the realized price from Coin Metrics, checked 2026-11-16).
// The alert divides by the realized price published by then, a day or two older for BTC and two or three for
// ETH, which in a crash is the higher one: on that scale the bottoms read a little lower (README.md).
// The spans named at 1x run from the first to the last month in which most days closed below the realized
// price (Coin Metrics' CapMVRVCur under 1); a month inside a span may not be (BTC 2022-08; ETH 2019-06,
// 2020-02, 2026-04), and a single such month on its own is not named (BTC 2012-03, ETH 2016-12).

export const ASSETS = ['btc', 'eth']
export const NAMES = { btc: 'BTC', eth: 'ETH' }
export const LEVELS = {
  btc: [
    { m: 1, note: '2011 年 9 月到 12 月、2015 年 1 月到 10 月（最长）、2018 年 12 月到 2019 年 3 月、2022 年 6 月到 12 月，BTC 大部分时间在它下面' },
    { m: 0.8, note: '2022 年 6 月和 11 月两次见底在 0.78 和 0.75 倍' },
    { m: 0.7, note: '2018 年 12 月和 2020 年 3 月两次见底在 0.68 和 0.69 倍' },
    { m: 0.5, note: '2015 年 1 月见底 0.49 倍，2011 年最深到 0.39 倍' },
  ],
  eth: [
    { m: 1, note: '2018 年 8 月到 2020 年 5 月（最长，将近两年）、2022 年 6 月到 12 月、2025 年 3 月到 4 月、2026 年 2 月到 8 月，ETH 大部分时间在它下面' },
    { m: 0.75, note: '2025 年 4 月、2026 年 2 月和 6 月三次见底在 0.73–0.75 倍' },
    { m: 0.7, note: '2022 年 11 月见底 0.70 倍，是 2022 年 7 月以后最低的一次' },
    { m: 0.55, note: '2022 年 6 月见底 0.53 倍' },
    { m: 0.4, note: '2020 年 3 月见底 0.40 倍' },
    { m: 0.3, note: '2018 年 12 月见底 0.29 倍，是有记录以来最低' },
  ],
}
// REARM: 3%, about an average day's high-to-low range of BTC; DOWN_MS: half a day without a coin judged before saying
// so (Coin Metrics publishes once a day, and the last realized price is used for RP_MAX_AGE meanwhile);
// PRICE_MAX_AGE: a Chainlink answer older than this is not taken (the feeds on Base update every 20 minutes
// or so, more often when the price moves).
export const REARM = 0.03, DOWN_MS = 12 * 3600e3, RP_MAX_AGE = 4 * 86400e3, PRICE_MAX_AGE = 3 * 3600e3

const usd = (v) => `$${Math.round(v).toLocaleString('en-US')}`
const dayOf = (d) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`
const levelName = (m) => (m === 1 ? '全网持仓成本' : `全网持仓成本的 ${m} 倍`)
const rpText = (q) => `全网持仓成本 ${usd(q.rp)}（Coin Metrics，${dayOf(q.rpDate)}的数）`
// A multiple, floored: a price just under a level never reads as at it.
const times = (x, d) => (Math.floor(x * 10 ** d) / 10 ** d).toFixed(d)
const status = (a, q) => {
  const x = q.price / q.rp
  return `${NAMES[a]} ${usd(q.price)}，是全网持仓成本 ${usd(q.rp)} 的 ${times(x, 2)} 倍${x < 1 ? '，已经在它下面' : ''}`
}
const judged = (q) => Boolean(q && q.price > 0 && q.rp > 0 && typeof q.rpDate === 'string')

// Each coin's realized price from Coin Metrics' rows ({ asset, time, PriceUSD, CapMVRVCur }): the latest day
// with both (ETH's CapMVRVCur often comes a day after its price). { btc: { rp, date }, ... }.
export function realizedFrom(rows) {
  const out = {}
  for (const x of Array.isArray(rows) ? rows : []) {
    const a = x?.asset, p = Number(x?.PriceUSD), mv = Number(x?.CapMVRVCur), d = String(x?.time ?? '').slice(0, 10)
    if (!ASSETS.includes(a) || !(p > 0) || !(mv > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    if (!out[a] || d > out[a].date) out[a] = { rp: p / mv, date: d }
  }
  return out
}

// The realized prices kept from earlier runs, updated with those just read: per coin, the later day.
export function latestRealized(kept, read) {
  const out = {}
  for (const a of ASSETS) {
    const ok = (v) => v && Number.isFinite(v.rp) && v.rp > 0 && typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date)
    const k = ok(kept?.[a]) ? kept[a] : null, r = ok(read?.[a]) ? read[a] : null
    const best = k && r ? (r.date >= k.date ? r : k) : k ?? r
    if (best) out[a] = { rp: best.rp, date: best.date }
  }
  return out
}

// A realized price still fit to judge by at `now`: its day began less than RP_MAX_AGE ago.
export const freshRealized = (v, now) => Boolean(v && now - Date.parse(`${v.date}T00:00:00Z`) <= RP_MAX_AGE)

// A Chainlink feed's latestRoundData() answer (hex) with 8 decimals: { price, at (ms) }, or null.
export function feedAnswer(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{320}$/.test(hex)) return null
  const word = (i) => BigInt('0x' + hex.slice(2 + 64 * i, 66 + 64 * i))
  const price = Number(BigInt.asIntN(256, word(1))) / 1e8, at = Number(word(3)) * 1000
  return price > 0 && at > 0 ? { price, at } : null
}

// quotes: { btc: { price, rp, rpDate }, eth: ... } (price or rp null when not read); prev: the last state, or
// null. Returns the messages and the next state: { levels: { btc: { '1': 'above' | 'below', ... } }, opened,
// down: { eth: { since, told } } (the coins not judged, since when, and whether that was said) }.
export function evaluateRealized(quotes, prev, { now = Date.now() } = {}) {
  prev = prev && typeof prev === 'object' && !Array.isArray(prev) ? prev : {}
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
  const levels = { ...obj(prev.levels) }, wasDown = obj(prev.down)
  const state = { levels, opened: Boolean(prev.opened), down: {} }
  const messages = [], tell = [], back = []
  for (const a of ASSETS) {
    const q = quotes?.[a]
    if (!judged(q)) {
      // Not judged this run: its levels stay as they were, and one it is below once it is back is told then.
      const since = Number.isFinite(wasDown[a]?.since) ? wasDown[a].since : now, told = Boolean(wasDown[a]?.told)
      state.down[a] = { since, told: told || now - since >= DOWN_MS }
      if (!told && now - since >= DOWN_MS) tell.push(a)
      continue
    }
    if (wasDown[a]?.told) back.push(a)
    const x = q.price / q.rp, was = obj(levels[a])
    const next = {}, broke = [], rose = []
    for (const { m } of LEVELS[a]) {
      const k = String(m), w = was[k]
      const s = w === 'below' ? (x >= m * (1 + REARM) ? 'above' : 'below') : x < m ? 'below' : 'above'
      next[k] = s
      // A level with no state yet (the first run, or one added since) is only recorded.
      if (w === 'above' && s === 'below') broke.push(m)
      if (w === 'below' && s === 'above') rose.push(m)
    }
    levels[a] = next
    if (broke.length) {
      const low = Math.min(...broke), lv = LEVELS[a].find((l) => l.m === low), after = LEVELS[a].find((l) => l.m < x)
      messages.push({ key: a, kind: 'break', priority: 4, tags: ['chart_with_downwards_trend'], title: `${NAMES[a]} 跌破${levelName(low)}`,
        message: `${NAMES[a]} ${usd(q.price)}，${rpText(q)}，现在是它的 ${times(x, 3)} 倍` + (broke.length > 1 ? `（这次一起跌破了 ${broke.join('、')} 倍）` : '') + `。${lv.note}。` +
          (after ? `下一档 ${after.m} 倍，现在是 ${usd(after.m * q.rp)}。` : '这是最低一档，再往下不再提醒。') })
    } else if (rose.includes(1)) {
      messages.push({ key: a, kind: 'back', priority: 3, tags: ['chart_with_upwards_trend'], title: `${NAMES[a]} 回到全网持仓成本上方`,
        message: `${NAMES[a]} ${usd(q.price)}，比${rpText(q)}高 ${(Math.round((x - 1) * 1000) / 10).toFixed(1)}%。再跌破它会再提醒。` })
    }
  }
  if (tell.length) {
    // What each coin lacks: a price, or a realized price of the last RP_MAX_AGE (the last one read is used until then).
    const why = (a) => {
      const q = quotes?.[a], noPrice = !(q?.price > 0), noRp = !(q?.rp > 0)
      const rp = `${RP_MAX_AGE / 86400e3} 天以内的全网持仓成本（Coin Metrics）`
      return noPrice && noRp ? `取不到价格（Chainlink 和 Coinbase）和 ${rp}` : noPrice ? '取不到价格（Chainlink 和 Coinbase）' : `取不到 ${rp}`
    }
    const reasons = [...new Set(tell.map(why))]
    const what = reasons.map((r) => `${tell.filter((a) => why(a) === r).map((a) => NAMES[a]).join('、')} ${r}`).join('；')
    const hours = Math.floor((now - Math.min(...tell.map((a) => state.down[a].since))) / 3600e3)
    const rest = ASSETS.filter((a) => judged(quotes?.[a])).map((a) => NAMES[a])
    messages.push({ key: 'down', kind: 'down', coins: tell, priority: 4, tags: ['warning'], title: `${tell.map((a) => NAMES[a]).join('/')} 全网持仓成本提醒暂停`,
      message: `${what}，已经 ${hours} 小时没法判断，这期间跌破不会提醒${rest.length ? `（${rest.join('、')} 照常）` : ''}。恢复后会告诉你，到时还在下面的档位会补发，中间跌破又涨回来的会漏掉。` })
  }
  const judgedAll = ASSETS.every((a) => judged(quotes?.[a]))
  const now_ = (coins) => coins.map((a) => status(a, quotes[a])).join('；') + '。'
  if (judgedAll && !state.opened) {
    // Where both stand now: also what a coin back from a gap would have said (`coins`: those it stands in for).
    state.opened = true
    const list = (a) => LEVELS[a].filter((l) => l.m !== 1).map((l) => l.m).join('、')
    messages.push({ key: 'open', kind: 'open', coins: back, priority: 3, tags: ['bell'], title: 'BTC/ETH 全网持仓成本提醒已开启',
      message: `现在 ${now_(ASSETS)}跌破全网持仓成本时提醒，跌破这些倍数也提醒：BTC ${list('btc')} 倍，ETH ${list('eth')} 倍（历史上几轮熊市见底的位置）；回到成本上方 ${REARM * 100}% 也提醒。` +
        '价格每小时看一次（Chainlink），全网持仓成本每天更新一次，用 Coin Metrics 的算法（别的网站算法不同，ETH 的可能高 10% 左右）。' })
  } else if (back.length) {
    messages.push({ key: 'up', kind: 'up', coins: back, priority: 3, tags: ['white_check_mark'], title: `${back.map((a) => NAMES[a]).join('/')} 全网持仓成本提醒恢复`, message: `现在 ${now_(back)}` })
  }
  return { messages, state }
}

// The state to keep when message `m` could not be sent, so the next run sends it again.
export function unsent(state, prev, m) {
  prev = prev && typeof prev === 'object' ? prev : {}
  if (ASSETS.includes(m.key)) state.levels[m.key] = prev.levels?.[m.key]
  // The opening message not sent: a coin it would have told back is still to be told (by it, or on its own).
  else if (m.key === 'open') { state.opened = false; for (const a of m.coins ?? []) state.down[a] = prev.down?.[a] }
  else if (m.key === 'down') for (const a of m.coins ?? []) state.down[a] = { ...state.down[a], told: false }
  else if (m.key === 'up') for (const a of m.coins ?? []) state.down[a] = prev.down?.[a]
  return state
}
