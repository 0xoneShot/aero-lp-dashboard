import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from 'viem'

// True only when a call failed because there is nothing there: the contract returned no data
// (not deployed yet) or the node itself reported a revert (JSON-RPC code 3). Rate limits, timeouts
// and other transport errors are not "absent" and must fail the run instead of reading as zero.
export function absent(e) {
  if (!(e instanceof BaseError)) return false
  if (e.walk((x) => x instanceof ContractFunctionZeroDataError)) return true
  return Boolean(e.walk((x) => x instanceof ContractFunctionRevertedError)) && Boolean(e.walk((x) => x?.code === 3))
}

export const tryRead = (p) => p.catch((e) => { if (absent(e)) return undefined; throw e })
