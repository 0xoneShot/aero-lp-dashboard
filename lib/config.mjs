// Everything the pipeline needs to know about the wallets and the Base contracts it reads.
// Addresses are lowercase.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Which wallets to track is kept out of the code: the AERO_CONFIG environment variable (a GitHub
// secret in the hourly job) or, on a local machine, config/wallets.local.json (not committed).
// { startDay, scanFromBlock, wallets: [{ key, label, address }], labels: { address: name } }
function loadWallets() {
  const raw = process.env.AERO_CONFIG ?? (fs.existsSync(LOCAL_CONFIG) ? fs.readFileSync(LOCAL_CONFIG, 'utf8') : null)
  if (!raw) return { wallets: [], labels: {} }
  const c = JSON.parse(raw)
  return { ...c, wallets: (c.wallets ?? []).map((w) => ({ ...w, address: w.address.toLowerCase() })), labels: Object.fromEntries(Object.entries(c.labels ?? {}).map(([a, l]) => [a.toLowerCase(), l])) }
}
const LOCAL_CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config/wallets.local.json')
const CONFIG = loadWallets()
// Optional per-chain start, for replaying other wallets: { chains: { eth: { scanFromBlock, startTs } } }.
const CHAIN_STARTS = CONFIG.chains ?? {}

export const WALLETS = CONFIG.wallets

// First Beijing day to report (YYYY-MM-DD); what the wallets held at the end of the day before
// counts as opening capital.
export const START_DAY = CONFIG.startDay

// Logs before this block are not scanned; pick a block before the wallets' first relevant activity.
export const SCAN_FROM_BLOCK = CONFIG.scanFromBlock

if (WALLETS.length && !(START_DAY && Number.isInteger(SCAN_FROM_BLOCK))) throw new Error('AERO_CONFIG needs startDay and scanFromBlock')

// Tokens the pipeline values. Anything else a wallet receives is reported as unpriced.
// price: 'usd' = $1 (USDC is the unit; the other dollar stablecoins are taken at par),
// 'eth' = ETH/USD, 'aero' = AERO/USD, or a Chainlink USD feed.
export const TOKENS = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6, price: 'usd' },
  '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, price: 'eth' },
  '0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee': { symbol: 'AERO', decimals: 18, price: 'aero' },
  '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT', decimals: 6, price: 'usd' },
  '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { symbol: 'USDbC', decimals: 6, price: 'usd' },
  '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18, price: 'usd' },
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': { symbol: 'cbBTC', decimals: 8, price: 'feed:0x07da0e54543a844a80abe69c8a12f22b3aa59f9d' },
  '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { symbol: 'cbETH', decimals: 18, price: 'feed:0xd7818272b9e248357d13057aab0b417af31e817d' },
}
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
export const WETH = '0x4200000000000000000000000000000000000006'
export const AERO = '0x3f5bf3edac59d650d8fdf9657a71f2f904a3a4ee'
export const ZERO = '0x0000000000000000000000000000000000000000'

// Concentrated-liquidity position managers the wallets have used.
export const NPMS = {
  '0x4857db576ee0e45f10525ec59527bfd10beec60b': { label: 'Aero V3', factory: '0x9cb220581b91b0c83223012fe69688b92ad07a76' },
  '0xe1f8cd9ac4e4a65f54f38a5cdafca44f6dd68b53': { label: 'Slipstream v1', factory: '0xf8f2eb4940cfe7d13603dddd87f123820fc061ef' },
}

// Gauges are accepted only as EIP-1167 clones of these implementations (Aero V3 CL, Slipstream v1),
// so a contract that merely emits gauge-shaped events cannot add positions or rewards.
export const GAUGE_IMPLS = {
  '0x89e91a960154b1ed6c093039a8f0725ab67d14e0': 'Aero V3 CL gauge',
  '0x434bccab043311a20b16021c137ea81702790f7b': 'Slipstream v1 gauge',
}

// Contracts the strategy trades and provides liquidity through. A one-way transfer between a wallet
// and one of these is a move inside the strategy (an order and its fill, a wrap); a one-way transfer
// with any other contract is treated as money in or out and flagged for review.
export const STRATEGY = {
  '0x4200000000000000000000000000000000000006': 'WETH',
  '0x0fef9e88a7b76bcdbf451780c6774fe32965ee98': 'Aero Metarouter',
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap',
  '0x8f10b468b06c6fd214b65f87778827f7d113f996': 'KyberSwap executor',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch',
  '0x111116058b9828cdcdd810c502b925c14f34ca11': '1inch executor',
  '0x2ad5004c60e16e54d5007c80ce329adde5b51ef5': '1inch settlement',
  '0xa8c1c98aaf99a5dfc907d61b892b2ad624901185': '1inch resolver',
  '0xe12e0f117d23a5ccc57f8935cd8c4e80cd91ff01': '1inch native order factory',
  '0xba3cb449bd2b4adddbc894d8697f5170800eadec': 'CoW ETH order',
  '0x04501b9b1d52e67f6862d157e00d13419d2d6e95': 'CoW ETH order',
  '0x9008d19f58aabd9ed0d60971565aa8510560ab41': 'CoW settlement',
  '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110': 'CoW vault relayer',
  '0x67d03631fe51b741c0c00c4e16eb662ac84381df': 'OKX DEX router',
  '0x411d2c093e4c2e69bf0d8e94be1bf13dadd879c6': 'OKX DEX adapter',
  '0x7da6cde2354dd295554aa2127d8ec3d31f6d91aa': 'OKX DEX adapter',
  '0x22eef0c15678c482dcac05c0d102363fc31f8c81': 'DEX settlement',
  '0x3fe04a59ebd38cf06080a6f60a98d124eb59392a': 'Slipstream v1 WETH/USDC pool',
  '0x2a430bebd2082d8e05d56d64dede8944279bbc24': 'Aero V3 WETH/USDC pool',
}

// Native-ETH limit orders, whose ETH waits in a contract until the order is filled, or cancelled or
// expired and refunded (lib/ledger.mjs): 1inch makes one contract per order through these factories;
// CoW keeps every order's ETH in EthFlow, and its settlement contract reports the fills.
export const ORDER_FACTORIES = {
  '0xe12e0f117d23a5ccc57f8935cd8c4e80cd91ff01': '1inch native order factory',
}
export const ETHFLOW = {
  '0xba3cb449bd2b4adddbc894d8697f5170800eadec': 'CoW EthFlow',
  '0x04501b9b1d52e67f6862d157e00d13419d2d6e95': 'CoW EthFlow (staging)',
}
export const COW_SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41'

// Price sources, read with archive eth_call at the block being valued.
export const PRICE = {
  // Uniswap v3 WETH/USDC 0.05%: deep for the whole period (token0 WETH, token1 USDC).
  ethPool: '0xd0b53d9277642d899df5c87a3966a349a798f224',
  // New AERO: median of three Aero V3 pools (token0 AERO in all of them).
  aeroVamm: '0xf634058dc94e6bf8e828e27621320c423bc8b18e', // vAMM AERO/USDC
  aeroClUsdc: '0xd0acf293547457fb4fe9ee32ca93e89497626816', // CL200 AERO/USDC
  aeroClWeth: '0xc85d5cb72d1aad6f152a8decad228ae4a59ac9b3', // CL200 AERO/WETH
  aeroMarketFromBlock: 52_919_310, // first AERO swap; no price before it
}

// Any log emitted by one of these marks a transaction as a cross-chain transfer,
// so value moving between it and a wallet is money coming in or going out.
export const BRIDGES = {
  '0x09aea4b2242abc8bb4bb78d537a67a245a7bec64': 'Across',
  '0x81d40f21f12a8f0e3252bccb954d722d4c464b64': 'CCTP',
  '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d': 'CCTP',
  '0xad09780d193884d503182ad4588450c416d6f9d4': 'CCTP',
  '0x1682ae6375c4e4a97e4b583bc394c861a46d8962': 'CCTP',
  '0xef4fb24ad0916217251f553c0596f8edc630eb66': 'deBridge',
  '0xe7351fd770a37282b91d153ee690b63579d6dd7f': 'deBridge',
  '0xa5f565650890fba1824ee0f21ebbbf660a179934': 'Relay',
  '0x4200000000000000000000000000000000000007': 'Base 官方桥',
  '0x4200000000000000000000000000000000000010': 'Base 官方桥',
  '0x27a16dc786820b16e5c9028b75b99f6f604b5d26': 'Stargate',
  '0xdc181bd607330aeebef6ea62e03e5e1fb4b6f7c7': 'Stargate',
  '0x1a44076050125825900e736c501f859c50fe728c': 'LayerZero',
  '0x03a25b3215a0e5c15cf23ac4d2e5cf86c0ff7efa': '1inch',
  '0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a': '1inch',
  '0x4cd00e387622c35bddb9b4c962c136462338bc31': 'Relay',
  '0x4200000000000000000000000000000000000016': 'Base 官方桥',
}

// Known senders, for readable flow descriptions only.
export const LABELS = CONFIG.labels

// Hand corrections for transactions the rules cannot classify: { "<tx hash>": { "<wallet key>": "internal" | "transfer" } }.
export const OVERRIDES_FILE = 'config/overrides.json'

export const RPC = {
  archive: 'https://mainnet.base.org',
  // Address-free topic filters, 1,000 blocks per request.
  logs: ['https://base.gateway.tenderly.co', 'https://gateway.tenderly.co/public/base'],
  trace: 'https://base.drpc.org',
}

// The chains the wallets are tracked on. lib/scan.mjs, lib/ledger.mjs, lib/orders.mjs and lib/snapshot.mjs
// work on one chain at a time; src/run.mjs folds the chains into the same wallets. Base is where the
// strategy started and whose pools price everything; on each other chain the same addresses are tracked
// from that chain's start block, what they held there counting as money put in at the time.
export const CHAINS = {
  base: {
    key: 'base', label: 'Base', id: 8453,
    tokens: TOKENS, npms: NPMS, gaugeImpls: GAUGE_IMPLS, strategy: STRATEGY, bridges: BRIDGES,
    orderFactories: ORDER_FACTORIES, ethflow: ETHFLOW, cowSettlement: COW_SETTLEMENT,
    weth: WETH, usdc: USDC, rewardToken: AERO, rewardPayers: [ZERO],
    // A transaction carrying one of these logs is cross-chain too: Hyperlane delivering a message, as
    // when xAERO redeemed on Ethereum arrives as AERO (the Mailbox is used only for messages between chains).
    bridgeLogs: [
      { address: '0xea87ae93fa0019a82a727bfd3ebd1cfca8f64f1d', topic0: '0x0d381c2a574ae8f04e213db7cfb4df8df712cdbd427d9868ffef380660ca6574', label: 'Hyperlane' },
      // A message sent from Base, unless Aero's own adapter sends it (Aero's messages to its other chains).
      { address: '0xea87ae93fa0019a82a727bfd3ebd1cfca8f64f1d', topic0: '0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814', notTopic1: '0x0c54028e2aefdf6e740513655dce88ae63df96c9', label: 'Hyperlane' },
    ],
    rpc: RPC, scanFromBlock: SCAN_FROM_BLOCK, safeTag: 'safe',
    files: { scan: 'data/cache/scan.json', timeline: 'data/cache/timeline.json' },
    // Block times are arithmetic until a change of block time (lib/time.mjs).
    formulaTs: (block) => 1686789347 + 2 * Number(block),
    beforeTs: (ts) => Math.floor((ts - 1 - 1686789347) / 2),
  },

  // Ethereum mainnet, since Aero launched there (2026-10-21). The same wallet addresses are tracked from
  // the start of 2026-10-31 Beijing time: what they held then counts as money put in at that moment.
  // Token order differs from Base (USDC is token0 of the WETH/USDC pool) and staked positions earn
  // xAERO, which redeems 1:1 into AERO on Base (lib/crosschain.mjs pairs the two).
  eth: {
    key: 'eth', label: '以太坊', id: 1,
    tokens: {
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18, price: 'eth', canon: 'ETH' },
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6, price: 'usd', canon: USDC },
      '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6, price: 'usd', canon: '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2' },
      '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18, price: 'usd', canon: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb' },
      '0x9e148c5716b5aadcfd3b71ceae9ee7a9e22c29e2': { symbol: 'xAERO', decimals: 18, price: 'aero', canon: AERO },
      // The same token at the same address as on Base, priced by Base's feed.
      '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': TOKENS['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'],
    },
    npms: { '0x4857db576ee0e45f10525ec59527bfd10beec60b': { label: 'Aero V3', factory: '0xf4fd2e6c5b60c5b365cd1b96dd6245e6d60414c2' } },
    gaugeImpls: { '0x89e91a960154b1ed6c093039a8f0725ab67d14e0': 'Aero V3 CL gauge' },
    strategy: {
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
      '0x0fef9e88a7b76bcdbf451780c6774fe32965ee98': 'Aero Metarouter',
      '0x9ee35bf1bd69a03c6f0393582030fce8bb93d418': 'Aero SwapRouter',
      '0xd661623947ef2ead12d577b47021c167d163b0c5': 'Aero WETH/USDC pool',
      '0xba9abfdfb7c28e232d853d85c619e4248971aa31': 'Aero WETH/USDT pool',
      '0x111111125421ca6dc452d289314280a0f8842a65': '1inch',
      '0x111116058b9828cdcdd810c502b925c14f34ca11': '1inch executor',
      '0x399740157391a9f1bf4e9921a8834f9bc8f2678e': '1inch settlement',
      '0x2ad5004c60e16e54d5007c80ce329adde5b51ef5': '1inch settlement',
      '0xc0dfdb9e7a392c3dbbe7c6fbe8fbc1789c9fe05e': '1inch fee taker',
      '0xa8c1c98aaf99a5dfc907d61b892b2ad624901185': '1inch resolver',
      '0xe12e0f117d23a5ccc57f8935cd8c4e80cd91ff01': '1inch native order factory',
      '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap',
      '0x8f10b468b06c6fd214b65f87778827f7d113f996': 'KyberSwap executor',
      '0x8feab81d36e7576107d5de0758c1b839be31b4f6': 'OKX DEX router',
      '0xa875fb2204ce71679be054d97f7faffeb6536d67': 'OKX DEX router',
      '0x40aa958dd87fc8305b97f2ba922cddca374bcd7f': 'OKX token approve',
      '0x70cbb871e8f30fc8ce23609e9e0ea87b6b222f58': 'OKX token approve',
      '0xcaf0beadeaefc66fef60ac6526ab566d58c8647a': 'OKX DEX adapter',
      '0x6747bcaf9bd5a5f0758cbe08903490e45ddfacb5': 'OKX DEX adapter',
      '0x0000000000001ff3684f28c67538d4d072c22734': '0x',
      '0xaddc26a3854feabfd20d6bf658254088d83a425a': '0x settler',
      '0x0cef320d0c5793ade37964e2661a033771e53cd5': '0x settler',
      '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap',
      '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap',
      '0xef1c6e67703c7bd7107eed8303fbe6ec2554bf6b': 'Uniswap',
      '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap',
      '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
      '0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251': 'deBridge router',
      '0xba3cb449bd2b4adddbc894d8697f5170800eadec': 'CoW ETH order',
      '0x04501b9b1d52e67f6862d157e00d13419d2d6e95': 'CoW ETH order',
      '0x40a50cf069e992aa4536211b23f286ef88752187': 'CoW ETH order',
      '0x9008d19f58aabd9ed0d60971565aa8510560ab41': 'CoW settlement',
      '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110': 'CoW vault relayer',
    },
    bridges: {
      '0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5': 'Across',
      '0xa5f565650890fba1824ee0f21ebbbf660a179934': 'Relay',
      '0x4cd00e387622c35bddb9b4c962c136462338bc31': 'Relay',
      '0xbd3fa81b58ba92a82136038b25adec7066af3155': 'CCTP',
      '0x0a992d191deec32afe36203ad87d7d289a738f81': 'CCTP',
      '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d': 'CCTP',
      '0x81d40f21f12a8f0e3252bccb954d722d4c464b64': 'CCTP',
      '0x3154cf16ccdb4c6d922629664174b904d80f2c35': 'Base 官方桥',
      '0x49048044d57e1c92a77f79988d21fa8faf74e97e': 'Base 官方桥',
      '0x866e82a600a1414e583f7f13623f1ac5d58b0afa': 'Base 官方桥',
      '0x77b2043768d28e9c9ab44e1abfc95944bce57931': 'Stargate',
      '0xc026395860db2d07ee33e05fe50ed7bd583189c7': 'Stargate',
      '0x933597a323eb81cae705c5bc29985172fd5a3973': 'Stargate',
      '0x1a44076050125825900e736c501f859c50fe728c': 'LayerZero',
      '0xef4fb24ad0916217251f553c0596f8edc630eb66': 'deBridge',
      '0xe7351fd770a37282b91d153ee690b63579d6dd7f': 'deBridge',
      '0x03a25b3215a0e5c15cf23ac4d2e5cf86c0ff7efa': '1inch',
      '0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a': '1inch',
    },
    // Redeeming xAERO: LeafVoter burns it and sends a Hyperlane message that mints AERO on Base; its
    // Redeemed event marks it. Other Hyperlane messages (a token sent to Base through a warp route, as the
    // Metarouter's cross-chain swaps do) are marked by the Mailbox's Dispatch, unless Aero's own adapter
    // sends it: those are Aero's internal messages.
    bridgeLogs: [
      { address: '0x382409fad8503fbcdbb27a4211551fa03e884078', topic0: '0x27d4634c833b7622a0acddbf7f746183625f105945e95c723ad1d5a9f2a0b6fc', label: 'Aero 赎回' },
      { address: '0xc005dc82818d67af737725bd4bf75435d065d239', topic0: '0x769f711d20c679153d382254f59892613b58a97cc876b249134ac25c80f9c814', notTopic1: '0x4aaff8cfb43e2cefbbbf4c133c934db6ba7e4c14', label: 'Hyperlane' },
      { address: '0xc005dc82818d67af737725bd4bf75435d065d239', topic0: '0x0d381c2a574ae8f04e213db7cfb4df8df712cdbd427d9868ffef380660ca6574', label: 'Hyperlane' },
    ],
    orderFactories: { '0xe12e0f117d23a5ccc57f8935cd8c4e80cd91ff01': '1inch native order factory' },
    ethflow: {
      '0xba3cb449bd2b4adddbc894d8697f5170800eadec': 'CoW EthFlow',
      '0x04501b9b1d52e67f6862d157e00d13419d2d6e95': 'CoW EthFlow (staging)',
      '0x40a50cf069e992aa4536211b23f286ef88752187': 'CoW EthFlow (legacy)',
    },
    cowSettlement: COW_SETTLEMENT,
    weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    // xAERO is minted to the emissions handler, which pays it on in the claim transaction.
    rewardToken: '0x9e148c5716b5aadcfd3b71ceae9ee7a9e22c29e2', rewardPayers: [ZERO, '0xfc6ad3a6512d5d4906525e55c618da8dffd837e8'],
    // Archive state and receipts on MEV Blocker (drpc as a fallback, small batches), topic-only logs on
    // Tenderly, call traces on drpc. Tenderly's 'safe' tag answers latest, so the safe head is read from
    // the archive endpoint.
    rpc: { archive: 'https://rpc.mevblocker.io', fallbacks: [{ url: 'https://eth.drpc.org', batch: 3 }], logs: ['https://mainnet.gateway.tenderly.co', 'https://gateway.tenderly.co/public/mainnet', 'https://rpc.mevblocker.io'], trace: 'https://eth.drpc.org' },
    scanFromBlock: CHAIN_STARTS.eth?.scanFromBlock ?? 26306626, startTs: CHAIN_STARTS.eth?.startTs ?? 1793376000, safeTag: 'safe',
    files: { scan: 'data/cache/scan-eth.json', timeline: 'data/cache/timeline-eth.json' },
    formulaTs: null, // a slot can go without a block: every time is read
  },
}

// Every chain's tokens in one map, for valuing an amount by its token address (lib/prices.mjs usdOf).
// The same address on two chains must be the same token (cbBTC is), so one entry serves both.
export const ALL_TOKENS = Object.assign({}, ...Object.values(CHAINS).map((c) => c.tokens))
