import { parseAbi, toEventSelector } from 'viem'

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
])

// Aero V3 and Slipstream v1 position managers return tickSpacing where Uniswap has fee.
export const npmAbi = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
])

export const factoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, int24 tickSpacing) view returns (address)',
  'function allPoolsLength() view returns (uint256)',
  'function allPools(uint256) view returns (address)',
])

export const clPoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function gauge() view returns (address)',
  'function stakedLiquidity() view returns (uint128)',
])

export const uniV3PoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
])

export const vammAbi = parseAbi([
  'function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)',
])

export const gaugeAbi = parseAbi([
  'function pool() view returns (address)',
  'function earned(address account, uint256[] tokenIds) view returns (uint256)',
  'function deferredEmissions(address) view returns (uint256)',
  'function stakedContains(address depositor, uint256 tokenId) view returns (bool)',
  'function stakedValues(address depositor) view returns (uint256[])',
])

// Event signatures the scanner reads.
export const TOPIC = {
  Transfer: toEventSelector('event Transfer(address indexed from, address indexed to, uint256 value)'),
  WethDeposit: toEventSelector('event Deposit(address indexed dst, uint256 wad)'),
  WethWithdrawal: toEventSelector('event Withdrawal(address indexed src, uint256 wad)'),
  GaugeDeposit: toEventSelector('event Deposit(address indexed caller, address indexed user, uint256 indexed tokenId, uint128 liquidity)'),
  GaugeWithdraw: toEventSelector('event Withdraw(address indexed caller, address indexed user, uint256 indexed tokenId, uint128 liquidity)'),
  EmissionsClaimed: toEventSelector('event EmissionsClaimed(address indexed account, uint256 indexed tokenId, address indexed recipient, uint256 amount)'),
  // Rewards a gauge could not pay at withdrawal are paid later under this event instead.
  DeferredEmissionsClaimed: toEventSelector('event DeferredEmissionsClaimed(address indexed account, address indexed recipient, uint256 amount)'),
  // Uniswap-style IncreaseLiquidity (4 fields, Slipstream v1) and Aero V3's 6-field variant.
  IncreaseLiquidity: toEventSelector('event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'),
  IncreaseLiquidityV3: toEventSelector('event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1, int24 tickLower, int24 tickUpper)'),
  DecreaseLiquidity: toEventSelector('event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'),
  Collect: toEventSelector('event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)'),
  // 1inch native-ETH order factory: the contract made to hold one order's ETH (as WETH).
  NativeOrderCreated: toEventSelector('event NativeOrderCreated(address maker, bytes32 orderHash, address clone, uint256 value)'),
  // CoW native-ETH orders: placed with EthFlow, filled by the settlement contract, refunded by EthFlow.
  CowOrderPlacement: toEventSelector('event OrderPlacement(address indexed sender, (address,address,address,uint256,uint256,uint32,bytes32,uint256,bytes32,bool,bytes32,bytes32) order, (uint8,bytes) signature, bytes data)'),
  CowTrade: toEventSelector('event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)'),
  CowOrderRefund: toEventSelector('event OrderRefund(bytes orderUid, address indexed refunder)'),
  CowOrderInvalidation: toEventSelector('event OrderInvalidation(bytes orderUid)'),
}
