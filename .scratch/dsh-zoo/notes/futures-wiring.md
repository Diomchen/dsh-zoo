# 期货市场（futures）规格 v1

> 本文件是设计定稿，代码实现以此为准。所有决策在 2026-11-17 的对话中逐条确认过。
> 前置事实与量化依据见工作区 `zoo-board-1.7.0-review.md` 第九节。

## 0. 定位

- 新增 `src\futures.js`（账本/撮合/结算）与 `src\futures-rules.js`（纯函数，不读时钟）。
- 新增窗口 `desktop\futures.html` + `desktop\futures.js` + `desktop\futures-preload.js`，独立于盘口窗。
- 独立存储 `futures.json`，与 `trading.json`、`market.json` 互不写入。
- **不改** `src\trading.js`、`src\trading-rules.js`；现有盘口原样保留（它负责刺激，期货负责经营）。
- 渲染层只吃 payload、不 import 规则层（沿用 1.7.0 的做法）。

## 1. 合约

| 项 | 值 |
| --- | --- |
| 标的 | 目录驱动的全部作物（当前 15 个，`CROP_IDS` 过滤无底价者） |
| 合约代号 | `<crop>-<YYYY>W<WW>`，例 `corn-2026W47` |
| 上市 | 周一 00:00（本地时间） |
| 到期 | 周五 20:00（本地时间） |
| 交割价 | 最后 4 根 15 分钟 `slotClosePrice` 的算术平均（19:00–20:00） |
| 交割 | 默认现金；玩家可随时"转现货" |
| 合约乘数 | **1 张 = 100 个作物** |
| 交易时段 | 24/7（到期日照常交易到 20:00） |
| 到期后 | 合约 `status:'settled'`，持仓清零，下周一开新合约 |

"转现货"= 原子两步：按当前公允价买入（多头）或卖出（空头）N 个作物现货，同时平掉等量合约。到期未平的仓位按交割价现金结算；空头拿不出货的情形不存在（转现货是主动行为，到期强制现金）。

## 2. 价格与撮合

- 现货指数：有 peer 时用 `market.js` 的 LAN 加权指数（`observeDigest` 那套）；单机用本地现货价。
- 公允价 `fair = index × exp(ou)`：
  - `ou` 是均值回归过程，σ = 0.4%，半衰期 30 分钟，每 15 秒更新一次；
  - 实现：`ou += -ln(2)/30min × dt × ou + σ × sqrt(dt) × normal()`，用 FNV 散列派生 normal（保持可复现、不依赖 `Math.random`）。
- 做市商双边报价：`bid = fair × (1 - 0.2%)`、`ask = fair × (1 + 0.2%)`，数量上限由风控参数控制，随时可吃。
- 玩家限价单进队列；**每 15 分钟批量撮合一次**（价格优先、同价按 `placedAt` 时间优先）。
- 撮合结果只由房主产生；客户端只发意图。

## 3. 账本 `futures.json` v1

```json
{
  "version": 1,
  "epoch": "uuid",                  // 每次交易所重启换新，用于结算幂等
  "host": "deviceId",
  "accounts": { "<deviceId>": { "balance": 0, "marginUsed": 0, "updatedAt": 0 } },
  "contracts": [{ "id": "corn-2026W47", "crop": "corn", "expiry": 0,
                  "status": "open|settled", "settlePrice": 0 }],
  "positions": [{ "id": "uuid", "deviceId": "", "contract": "corn-2026W47",
                  "side": "long|short", "qty": 1, "entry": 0, "margin": 0,
                  "leverage": 1, "openedAt": 0 }],
  "orders": [{ "id": "uuid", "deviceId": "", "contract": "", "side": "buy|sell",
               "price": 0, "qty": 1, "margin": 0, "placedAt": 0, "status": "open" }],
  "trades": [{ "id": "uuid", "contract": "", "price": 0, "qty": 1,
               "taker": "", "maker": "", "at": 0 }],
  "insurance": 0,
  "seq": 0,                          // 每根结算 +1
  "weekStats": { "start": null, "volume": 0, "fees": 0 }
}
```

- `trades` 硬截 500 条；`history` 概念并入 `trades`。
- 余额在 `accounts.balance`（托管），与 `farm.json` 的 coins 隔离。
- 原子写：`<file>.tmp-<uuid>` + `rename()`，沿用 `trading.js` 的 `#persist`；30 秒节流；坏文件按空交易所运行且不写回。
- 不存强平价（由 `entry/leverage` 派生）。

## 4. 资金

- 充值：`farm.spendCoins(n)` → `accounts[me].balance += n`；提现反向，按 1e6 上限分批，核对 `addCoins` 返回的实收 `qty`。
- 开仓：扣 `margin`（从 `balance` 划入 `marginUsed`），名义 = `margin × leverage`，`qty = floor(名义 / (price × 100))`，最少 1 张。
- 平仓：按当前价结算，`pnl` 加回 `balance`，`marginUsed` 释放。
- 只动托管账，不逐笔动 `farm.json`。
- 杠杆档位：**1× / 3× / 10× / 20×**。

## 5. 费用

| 项 | 费率 | 收取方 |
| --- | --- | --- |
| taker | 名义价值 0.1% | 吃单方 |
| 价差 | 公允价两侧各 0.2% | 做市商（系统） |
| 交割 | 名义价值 0.1% | 到期双方 |

费用去向：**90% 销毁、10% 进 `insurance`**。

## 6. 风险与强平

- 强平线 = `1/leverage`（1× 不设强平；3× 33.3%；10× 10%；20× 5%）。
- 每根 tick 按"触发价顺序、同价按建仓时间"依次执行强平。
- 亏损以保证金为限；超出部分先由 `insurance` 补，基金不足则系统记账，不追债（延续现有"强平不为负"）。
- 到期结算价与强平检查都用房主时钟；peer 的 `at` 只用于展示。

## 7. 协议（`src\protocol.js` 新增 5 种 kind）

| kind | 方向 | 载荷 | 约束 |
| --- | --- | --- | --- |
| `futures-hello` | peer → host | `{deviceId, version}` | 请求开户/同步 epoch |
| `futures-order` | peer → host | `{id, contract, side, price, qty, margin, leverage, placedAt}` | 幂等键 `(deviceId, id)` |
| `futures-cancel` | peer → host | `{id}` | 幂等 |
| `futures-settle` | host → peer | `{epoch, seq, balance, marginUsed, delta, trades[]}` | 接收端按 `(epoch, seq)` 去重 |
| `futures-sync` | peer → host | `{epoch, lastSeq}` | 每 30 秒；host 补发缺的 delta 或回快照 |

工程约束（来自 LAN 调查）：

- 单包 ≤ 4 KiB（`MAX_PACKET_BYTES`），无 ack、无重传、无序号、无去重 → 自建 `(epoch, seq)` 幂等 + 拉取补洞。
- deviceId 可伪造 → host 在 `admit` 时把 deviceId 绑到源地址，之后的订单只认该地址；钱只在 host 账本上算。
- 旧端遇未知 type 静默丢整包 → 新模块必须独立降级（对端不支持时窗口显示"对端未升级"，不影响农场与盘口）。
- 改 `protocol.js` 需同步：`PACKET_TYPES`（:288）、`buildPacket`（:817-1076）、`parsePacket`（:1350-1837）、新增 `encodeXxx`（:1140-1307）、常量区；另同步 `test\protocol.test.js:696` 快照与 `docs\protocol.md:83`。

## 8. 权限与防作弊

- **任何局域网玩家都可开户**（不设批准制）。补偿性风控：
  - 单账户日交易额上限 5,000 币（影子阶段 0）；
  - 单账户同时持仓名义上限 20,000 币；
  - host 对同一源地址的订单限速（沿用 discovery 的 20 包/10 秒）。
- 客户端只发意图；价格、成交、余额全部 host 算。
- 不做 hash 链审计（host 能改文件，没有真实约束力）。

## 9. 失败路径

| 场景 | 处理 |
| --- | --- |
| host 掉线 | 市场冻结（挂单挂起、仓位保留）；10 分钟未回 → 按最后公允价强制平仓，托管余额退回各自 `farm.json` |
| 结算包丢失 | peer 30 秒 `futures-sync` 拉取补洞；差距过大回快照 |
| 重复/乱序包 | `(epoch, seq)` 幂等；`seq` 回退丢弃 |
| 托管余额不足 | 拒单，返回 `no-balance` |
| `addCoins` 撞 1e6 | 分批提现 + 核对实收；差额留在托管账并告警 |
| 合约到期时有挂单 | 全部撤单，保证金回托管 |
| 存档损坏 | 空交易所运行，不写回，窗口提示 |

## 10. 上线顺序

1. **影子模式**：撮合、结算全跑，钱只在托管账里动，不落 `farm.json`；对账无误（建议跑满一周）。
2. **现金结算**：开真钱，单账户日交易额上限 5,000 币。
3. **实物交割**：开"转现货"与到期交割。
- 回滚开关：关窗口 + 托管余额原路退回 + `futures.json` 打 `disabled` 标记（不删数据）。

## 11. 测试

- 纯函数：公允价 OU 的均值回归与边界、撮合优先级、强平顺序、费用拆分、交割价（4 根均价）。
- 单机 e2e：开户/充值/开仓/强平/到期交割/提现，全部用假时钟与内存 farm。
- 双机 e2e：照抄 `test\trading-e2e.test.js:158-179` 的 `connectedPair()`（真 UDP 绑 127.0.0.1）；覆盖丢包补洞、乱序、重放、deviceId 冒用、host 掉线强制平仓。
- 目标：新增用例 ≥ 60，全部并入 `node scripts/run-tests.mjs`。
- 现有 1044 用例必须保持全绿。

## 12. 接入点（照抄现有模板）

- `src\service.js:367` 模块变量 → `:4631` store 创建（try/catch 降级）→ `:4790` 报文分派（**不能落到 else**，else 是 `room.observeBeacon`）→ `:6296` tick 注册 → `:7352` dispose 置 null。
- `desktop\main.js:2716` 宿主命令 → `:2336` openBoardWindow 模板 → `:2365` preload → `:1599-1609` IPC → `:2286 boardBounds` / `:2304 boardPositionFile` / `:2315 saveBoardPosition` → `:544 pluginWindows()`。
- `src\desktop.js:716` 推送 `desktop.boardWindow(payload)` 的模式照抄。
