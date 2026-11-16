# 82: 真邻居 trading-digest + 周榜/情绪

**What to build:** 让榜单上出现真邻居：每个 peer 每 30 秒上报 `trading-digest`（本周盈亏 + 当前持仓），本机合并成本周真人榜 + LAN 情绪；没有 NPC；邻居不报硬币余额；旧邻居静默忽略；坏包/过期包/超频包丢弃。

**Blocked by:** 81

**Status:** done

**Spec:** [SPEC v10](../SPEC-v10.md)

## 关键决定

- `trading-digest`：`{ v: 1, type, deviceId, at, weekPnl, weekPnlPct?, positions: [{ crop, side, leverage }] }`；只发已放行邻居；不包含硬币/保证金/入场/历史。
- 接收：已放行、`at` ≤2 分钟、同 peer 30 秒 ≤1 条、`positions` ≤8；坏字段整包丢；旧版本静默忽略。
- 榜按 `weekPnl` 降序；收益率只展示（邻居自报 `weekPnlPct` 或本机 `weekPnl / weekBase`）；无邻居就自己。
- 情绪 = 本机 + 邻居当前 positions 的多空计数。
- 不做强防作弊；伪造 digest 不改本机硬币。

## 验收

- [x] 30 秒/peer 发送；只发已放行；白名单/新鲜度/限流/坏包丢弃；旧邻居忽略。 ✅ 2026-11-16
- [x] 榜显示本机 + 邻居，按 `weekPnl`；收益率列；LAN 情绪；没邻居只自己。 ✅ 2026-11-16
- [x] 邻居只报盈亏 + 持仓，不报硬币；伪造 digest 不改本机硬币。 ✅ 2026-11-16
- [x] 两台假 peer e2e；`npm run check`。 ✅ 2026-11-16

## 实现记录（回给 lead / 票 83）

- **协议**（`src/protocol.js`，只增）：
  - 常量：`TRADING_DIGEST_INTERVAL_MS = 30_000`、`TRADING_DIGEST_FRESH_MS = 2 分钟`、
    `MAX_TRADING_POSITIONS = 8`、`MAX_WEEK_PNL = 1_000_000`、`MAX_WEEK_PNL_PCT = 1000`。
  - `PACKET_TYPES` 里 `'trading-digest'` 紧跟 `'market-digest'`（不进 `VISIT_TYPES`）。
  - 窄入口 `encodeTradingDigest({ deviceId, at, weekPnl, weekPnlPct, positions })`；
    编解码共用校验 `normalizeWeeklyPnl` / `normalizeWeeklyPnlPct` / `normalizeTradingPositions`
    （作物/方向/杠杆白名单来自 `src/trading-rules.js` 的 `isBoardCrop/isBoardSide/isTradingLeverage`）。
  - 线上形状：`{ v, type, deviceId, at, weekPnl[, weekPnlPct], positions }`；`weekPnlPct` 是**比率**
    （0.035 = +3.5%，SPEC「收益率 = weekPnl / weekBase」），缺省就不带这个键；坏字段整包丢
    （`reason`：`at` / `week-pnl` / `week-pnl-pct` / `positions`）。
- **host**（`src/service.js`，盘口/榜接线）：
  - 选项 `tradingDigestMs`（默认 30 秒，最小 10ms，测试注入）；发送在 1 秒 neighbor tick 里
    （`sendTradingDigest()`，只按 due 发，不学行情的「变了就发」）。
  - 接收 `handleTradingDigest(packet)` 四道门：`room.mayTalkTo` → `isFreshMarketSample(at, now)`
    （2 分钟）→ `tradingDigestLimiter`（同 peer 一窗口 1 条）→ 协议白名单。
    通过后只写 `tradingDigests`（内存 `Map`，键 deviceId；不落盘、不碰硬币/仓位/`trading.json`）。
  - `tradingWindowView()` 新增 `league: { rows, sentiment, self: { weekPnl, weekPnlPct } }`
    （`/state.trading` 与窗口 payload 同一份）；digest 到达时 `refreshTradingWindow()` 重推一拍。
  - `forgetPeerDigest` 一并删榜上那一行；`dispose` 清限速桶 + Map + 节拍。
  - 测试缝：返回对象新增 `sendTradingDigest`。
- **纯榜**（`src/trading-league.js`，新）：`buildLeague({ self, peers, now })` → `{ rows, sentiment, self }`。
  行形状 `{ deviceId, nickname, weekPnl, weekPnlPct, positions, me }`；按 `weekPnl` 降序、
  并列先昵称再 deviceId（不用 `localeCompare`，顺序不随系统语言变）；2 分钟没再听到的邻居整行不出现；
  `sentiment = { long, short, flat }`（long/short 数仓位，flat 数「零仓位的人」）；坏行整行丢掉。
  本机收益率优先用 service 给的 `total / base`（未取整），缺省退回 `weekPnl / weekBase`。
- **窗口**（`desktop/trading-view.js` + `board.js` + `board.html`）：`leagueView(payload)` 画
  分数（`+12` / `-8`，整数金币）、收益率（比率 ×100，没报是 `—`）、持仓摘要（`多 2 · 空 1` / `观望`）；
  「LAN 情绪」行与「真人周榜」卡；本机行高亮 `（我）`；只有自己时保留
  「还没有邻居上线…行情照走」空态。`desktop/shared.js` 的 `normalizeBoardView` 增加
  `league` 白名单（rows/positions/sentiment/self，重复 deviceId 只留第一行）。
- **测试**：`test/protocol-trading.test.js`、`test/trading-league.test.js`、`test/trading-e2e.test.js`（回环 UDP 两台）；
  扩 `test/trading-view.test.js`、`test/board-window.test.js`、`test/board-e2e.test.js`；
  `test/protocol.test.js` 的 `PACKET_TYPES` 精确数组与「任何报文都不含坐标」的遍历各加一条（加新类型的必然改动）。
- **没做（留给票 83）**：`docs/protocol.md` 的 `trading-digest` 节与限额表、README/CONTEXT 的周榜词条、
  ADR-0028 转 accepted、release notes；限价单。
