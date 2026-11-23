// What anyone can see of the job, beyond the pages it publishes: its log, when each line was printed, and how
// long each step took. None of it may tell when a tracked wallet did something, or how much. Nothing here
// reads the configuration (scripts/alerts.mjs must run without it).

// Whether what is printed can be read by anyone: the job's log (GitHub Actions sets GITHUB_ACTIONS). There
// nothing says how much a tracked wallet did in a run, or where: a count against the last run's, or a
// block, would point at it on a block explorer.
export const PUBLIC_LOG = process.env.GITHUB_ACTIONS === 'true'

// How many ms something that has run `ran` ms still waits so as to end on its padded time: `floor` seconds
// after it began, or past that the next whole `step` seconds, so a run that had a wallet's transactions to
// read ends when one that had none does. No floor, no wait.
export const PAD_STEP = 15
export function padFor(ran, floor, step = PAD_STEP) {
  if (!(floor > 0) || !(ran >= 0)) return 0
  const at = ran <= floor * 1000 ? floor * 1000 : floor * 1000 + Math.ceil((ran - floor * 1000) / (step * 1000)) * step * 1000
  return at - ran
}

// A check on the wallets' own data, for the job's public log: when it fails there, which check failed is
// said, not the figures it compared (a transaction hash, a balance, a position's bounds would point at the
// wallet). Elsewhere the check fails as it is written, figures and all.
const figures = /0x[0-9a-fA-F]+|\d+\.\d+|\d{3,}/g
export const hushed = (check, hush = PUBLIC_LOG) => (!hush ? check : async (...args) => {
  try { return await check(...args) } catch (e) { throw new Error(String(e?.message ?? e).split('\n')[0].replace(figures, '…')) }
})

// The alert step's one line at its end (scripts/alerts.mjs). In the public log: whether everything went, and
// why the first message that did not go failed (`why`, in whyNotSent's words), never how many there were: an
// hour with nothing to send reads as one that sent everything. Elsewhere, the counts.
export function alertsLine({ pub = PUBLIC_LOG, topic, sent, total, left = 0, why = '', updated = true }) {
  const told = pub
    ? (topic ? `alerts: ${sent === total ? 'done' : `not all sent${left ? ' (out of time: the rest goes next run)' : ''}${why ? ` (${why})` : ''}`}` : 'alerts: off')
    : (topic ? `alerts: ${sent} of ${total} sent${left ? ` (${left} left for the next run: out of time)` : ''}` : `alerts: off (${total} would have been sent)`)
  return `${updated ? '' : '(from the last good data) '}${told}`
}
// Why a message to ntfy did not go, in fixed words that can be public: what it answered (three digits), that it
// took too long, or that it was not reached. Of what an error carries only two things get through, each by its
// shape: that status, and after "not reached" the code of the error's cause when it is a bare name of 3 to 40
// capitals and underscores (ECONNREFUSED: the runtime's word for what failed; no digit fits in it, so no figure,
// address or hash). Nothing of a message (which names a wallet) is in any of these.
export const whyNotSent = (e) => (/^ntfy answered \d{3}$/.test(e?.message ?? '') ? e.message : e?.name === 'TimeoutError' ? 'ntfy timed out' : `ntfy not reached${/^[A-Z_]{3,40}$/.test(e?.cause?.code ?? '') ? `: ${e.cause.code}` : ''}`)
