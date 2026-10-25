# Aero LP 收益看板

追踪 Base 上少数几个钱包在 Aero（原 Aerodrome）做 WETH/USDC 集中流动性并质押的每日收益与整体盈亏。

- 网站：<https://0xoneshot.github.io/aero-lp-dashboard/>。打开后输入钱包地址才显示数据；输入多个地址看合计。
- 数据全部来自 Base 链上：用存档节点读取每天北京时间 24:00 那个区块的状态，不依赖任何需要密钥的第三方接口。

## 隐私

链上数据本来就公开，这个网站只是不主动告诉别人它追踪了哪些钱包：

- 追踪哪些钱包、叫什么名字，不写在代码里：线上来自 GitHub 仓库密钥 `AERO_CONFIG`，本机来自不提交的 `config/wallets.local.json`。格式：
  ```json
  { "startDay": "YYYY-MM-DD", "scanFromBlock": 12345678,
    "wallets": [{ "key": "w1", "label": "名字", "address": "0x…" }], "labels": { "0x…": "对手方名称" } }
  ```
- 每份数据（每个钱包单独一份，所有钱包合在一起一份）都用 AES-GCM 加密，文件名和密钥都由对应的钱包地址经 PBKDF2（20 万次）派生（`lib/views.mjs`，浏览器端在 `site/shell.html`）。不知道地址就找不到文件，也解不开。
- 运行日志会把钱包地址替换成 `<w1>` 这样的代号，并且只打印条数，不打印金额；扫描缓存加密后才存进 Actions 缓存。

## 自动更新

`.github/workflows/refresh.yml` 大约每小时（以及每次推送到 `main`）运行：扫描新区块、重算数据、跑测试，测试通过后构建网站并发布到 GitHub Pages。GitHub 自带的定时任务在这个仓库一直没有触发，所以每小时由 `.github/workflows/tick.yml` 来启动：它在 `hourly` 环境里用 59 分钟的等待计时器排队（等待时不占机器），时间到了排好下一轮，再启动一次更新；这条链断了的话，下一次更新会把它重新接上。测试或数据读取失败时这一次不发布，网站保留上一次的数据，下一小时重试。缓存丢失时会从头扫描（约 15 分钟）。

在 GitHub 的 Actions 页面可以手动运行（Run workflow），也可以看每次运行的结果。`main` 是线上分支，日常改动在 `dev`。

## 更新数据

```sh
npm ci
npm run update      # 扫描新区块并重算，输出到 out/
npm test            # 合成场景测试和扫描结果的不变量检查
npm run test:local  # 本机另有对照人工核实历史账本的检查（不提交）
npm run build:site  # 把看板页面和数据构建成网站，输出到 public/
npm run serve       # 本地预览 http://localhost:4173
```

`npm run update` 是增量的：`data/cache/` 记住已经扫描过的区块、交易和已结束日子的快照，日常一次只需几十秒。删除 `data/cache/` 会从配置的起始区块重新全量扫描（约 15 分钟）。

`out/` 里是完整的计算结果。网站只发布其中的 `summary.json` 和 `daily.json`，按地址加密成 `data/*.json`；其余文件不发布，留在本机核对用：

| 文件 | 内容 |
| --- | --- |
| `summary.json` | 每个范围（每个钱包、合计）一行：净投入、现值、累计盈亏、LP 收益、年化等 |
| `daily.json` | 每天每个范围一行：当日 AERO 奖励与手续费、收盘现值、净投入、累计盈亏、价格 |
| `attribution.json` | 盈亏拆解：带入资产涨跌、AERO 奖励、手续费、AERO 价格变动、Gas、无常损失与调仓 |
| `positions.json` / `holdings.json` | 当前 LP 仓位和持仓明细 |
| `events.json` / `flows.json` | 资金流水和识别出的外部资金进出 |

## 口径

- **净投入**：从外部进到钱包的钱（跨链、交易所提现、别人转入）按到账区块的价格折成美元，减去转出的钱。开始追踪那天之前钱包里已有的东西（含仓位和待领奖励）按当时价格算作期初投入。被追踪钱包之间的互转（包括转移 LP 仓位）在合计里抵消。
- **累计盈亏** = 现值 − 净投入，即对比"每笔钱到账时就换成 USDC 一直拿着"。
- **对比拿着原币不动** = 现值 − 把带进来的币原样拿着的价值；转出的钱按转出时的美元价值扣除。
- **每日收益** = 当天新增的 AERO（已领取 + gauge `earned()` 待领取，含延期发放的部分）× 当日收盘 AERO 价，加上未质押期间新增的交易手续费（已收取 + 静态调用 `collect()` 得到的未收取部分）。撤出流动性后还没收取的本金不算手续费。质押中的仓位不拿手续费。
- **近 N 日年化** = 最近最多 7 个完整日的收益合计 ÷ 同期按时间加权的 LP 市值合计 × 365。当天中途加仓的钱只按它在池子里的时间计。
- **盈亏拆解**：净投入 → 带入资产涨跌（拿着原币不动的价值 − 净投入）→ AERO 奖励（赚到时的价值）→ 交易手续费 → AERO 价格变动（奖励从赚到时到现在或卖出时的变化）→ Gas → 无常损失与调仓（倒推的余项，可正可负）→ 现值。
- **价格**：ETH 取 Uniswap v3 WETH/USDC 0.05% 池；AERO 取 Aero 上 vAMM AERO/USDC、CL200 AERO/USDC、CL200 AERO/WETH 三个池的中位数；cbBTC、cbETH 取 Chainlink；USDC、USDT、USDbC、DAI 按 1 美元。
- **天**：北京时间自然日；今天按最新的 safe 区块计算，标为"今日至今"。

## 资金流水怎么识别

`lib/scan.mjs` 用三张网找出所有改变钱包的交易，只扫到 Base 的 `safe` 区块（约落后 20 秒），避免链重组留下幽灵交易：

1. nonce 二分找出钱包自己发出的每一笔交易；
2. 按主题过滤日志，找出任何人发出的、带钱包地址的代币转账、WETH 包装、gauge 质押和奖励领取（启用了 EIP-7702 的地址会有别人代发的交易）；
3. 原生 ETH 逐块对账到 1 wei：用存档余额差算出每笔交易让钱包的 ETH 变了多少，对不上就二分定位到区块再找交易。同一区块有多笔相关交易、或 7702 账户执行调用时，改用调用追踪逐笔拆分；追踪拿不到就让本次运行失败、下次重试，不做猜测。

`lib/ledger.mjs` 再逐笔分类：

- 带跨链桥事件（Across、CCTP、deBridge、Relay、Stargate、Base 官方桥）的算跨链进出；
- 单向、对手方是普通账户（交易所、个人）的算转入转出；
- 被追踪钱包之间的算互转；
- 有进有出（兑换）、带 LP 或奖励事件、或经过已知路由与结算合约（`lib/config.mjs` 的 `STRATEGY`）的，是策略内部的移动；
- 和其它合约的单向往来**按资金进出计**并标记为待确认（`out/events.json` 里 `flagged: true`）。
- 奖励只认真正 gauge（已知实现的克隆合约）发出、且 AERO 确实到账的事件；LP 事件按仓位当时的所有者记账。

每个区块内部操作的美元净额应接近零，偏差超过 25 美元且超过 2% 的也会标记。`npm run update` 结束时会打印待确认的笔数（Actions 日志里也有）；标记的交易如果判断错了，在 `config/overrides.json` 里按交易哈希和钱包代号写上 `internal` 或 `transfer` 修正，重跑即可：

```json
{ "0x交易哈希": { "w2": "internal" } }
```

已知局限：挂单（限价单）如果隔天才成交，挂单期间托管在合约里的币不计入现值，相关交易会被标记。

## 目录

- `lib/`：配置、RPC、链上读取、扫描、分类、定价、集中流动性数学
- `src/update.mjs`：主流程
- `dashboard/index.html`：看板页面
- `site/shell.html`、`scripts/build-site.mjs`：网站外壳和构建
- `.github/workflows/refresh.yml`：每小时刷新并发布
- `test/`：合成场景测试和不变量检查
- `config/overrides.json`：人工修正分类
