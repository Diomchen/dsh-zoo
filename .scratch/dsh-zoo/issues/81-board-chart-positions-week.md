# 81: 三作物 K 线 + 持仓/历史/本周盈亏 + 完整盘口窗

**What to build:** 把 79 的最小窗变成完整盘口：三个作物可切；24 根 K 线 + 当前一根（1 分钟 tick）、底价/入场/强平线；持仓列表、最近结算、本周交易盈亏/收益率；0 硬币/无持仓/无邻居空态；键盘/focus；760×700 窗口。

**Blocked by:** 79

**Status:** done

**Spec:** [SPEC v10](../SPEC-v10.md)

## 关键决定

- 图是最近 24 根 + 当前；1 分钟 tick；收盘价 = 结算价；图例解释底价/入场/强平。
- 本周盈亏：已实现 + 未实现；周一本地 00:00 清零分数，硬币不清零；收益率本机 `weekPnl / weekBase`。
- 0 硬币：下单禁用并写「去种地」；无持仓/无邻居有明确空态。
- 窗口 760×700；键盘 Tab 可下单/平仓；关窗 host 继续结算。

## 验收

- [x] 三作物切换；24 根 + 当前；tick 更新；底价/入场/强平线 + 图例。 ✅ 2026-11-16
- [x] 持仓/最近结算/本周盈亏/收益率；周一清零分数，硬币不动。 ✅ 2026-11-16
- [x] 0 硬币按钮禁用写「去种地」；无持仓/无邻居空态；键盘/focus。 ✅ 2026-11-16
- [x] view 纯函数测试；`npm run check`。 ✅ 2026-11-16

## 实现记录（回给 lead / 票 82 / 票 83）

- **规则**（`src/trading-rules.js`，只增）：`BOARD_BAR_COUNT = 24`、`BOARD_CROPS = ['tomato','carrot','pumpkin']`、
  `barsFor({ crop, now, count = 24 })` → `{ base, bars: [{ slot, open, high, low, close }], current: { slot, open, high, low, price, tick, remainingMs } }`、
  `hintOf({ crop, now })` → `{ direction: 'up'|'down'|'flat', confidence: 0.55–0.68 }`（只看慢趋势斜率，取本根起点，一根内不变）。
- **payload**（`src/service.js` 的 `tradingWindowView()`，`/state.trading` 同一份）：
  `coins{available,locked,total}`、`week{start,pnl,base,unrealized,total}`、`bar{crop,cropName,slot,start,end,remainingMs,open,price}`（第一个作物，票 79 兼容）、
  `charts{crop: {base,bars,current}}`、`hint{crop:{direction,confidence}}`、`positions[]`、`history[]`、`orders[]`、
  `limits{margins,leverages,crops[{id,name}],historyLimit}`。
- **view**（`desktop/trading-view.js`，UMD，Node 可测）：新增 `weekView`、`hintView`、`chartView`、`chartGeometry`、
  `previewView`、`stopLevels/stopLabel/nextStopLevel`、`cropsView`；`positionCards` 增 `liqText/stopLevel/stopLabel/stopTitle/nextStopLevel/canStop`；
  `orderView` 增 `leverage/leverages/crop/cropName/previewParts`；`emptyHints.neighbors`。
  导出常量 `CHART_WIDTH = 384`、`CHART_HEIGHT = 188`。
- **窗口尺寸**：`BOARD_WIDTH = 760` / `BOARD_HEIGHT = 700` 在 `desktop/main.js`（票 79 已定），本票不改 `main.js`，只把布局填满它。
- **止损**：窗口按钮循环 `关 → −25% → −50% → −100% → 关`，提交 `trading-set-stop { positionId, level }`
  （`desktop/shared.js` 白名单 + `board-preload.js` 转发 + `src/service.js` 分发到 `trading.setStop`）。
  **票 80 的 store 提供 `setStop`**；两票并行期间 `src/service.js` 里有一行 `typeof trading.setStop !== 'function'`
  的保护（返回 `action-failed`），合并后可以删掉；若票 80 也加了同一段分发，保留一份即可。
- **`src/service.js` 的 `handleDesktopAction` 多拷了一个 `level` 字段**（不加这一行，票 80 的 store 永远收到
  `undefined`）；这是唯一一处超出「payload 组装 + tick 刷新」的改动。
- **没做（留给后面）**：真人周榜 / LAN 情绪 / trading-digest（票 82，窗口右下已留「邻居」卡与
  「还没有邻居上线」空态）；限价单与文档（票 83）；杠杆 `[1,5,20]` 的下单白名单由票 80 在
  `TRADING_LEVERAGES` 改，本票的窗口只吃 payload，不用改。
