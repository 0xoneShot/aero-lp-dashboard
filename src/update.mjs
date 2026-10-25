// Entry point for npm run update: runs the pipeline with wallet addresses kept out of the output.
import { redact, redactConsole } from '../lib/redact.mjs'

redactConsole()
try {
  await import('./run.mjs')
} catch (e) {
  console.error(redact(e?.stack ?? e))
  process.exit(1)
}
