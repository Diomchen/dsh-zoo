# 84: 盘口 K 线周期（15 分 / 1 时 / 1 日 / 1 周）

**Blocked by:** 79–83（已合并）

**Status:** done

## 问题

盘口图只有 15 分钟一根，图上还印着 `第 1994249 根`——那是自 1970 起的 slot 绝对序号，
是确定性行情的内部标识，玩家看不懂。想看趋势只能盯 15 分钟线。

## 要做的

- 图表加周期切换：**15 分 / 1 时 / 1 日 / 1 周**，每个周期都画最近 24 根 + 当前一根。
- 15 分沿用现有 `barsFor`（精确到 1 分钟 tick）；其余周期由**同一条** `boardPrice()` 路径聚合：
  - 1 时 = 4 个 slot，每 5 分钟采样；
  - 1 日 = 本地自然日（本地 00:00 对齐），每小时采样；
  - 1 周 = 本地周一 00:00 对齐（复用 `weekStartOf`），每 6 小时采样。
  - 采样只用于画图（显示用近似）；合约结算**仍然只认 15 分钟收盘**，不受周期影响。
- 去掉绝对根号：15 分显示 `11:30–11:45 · 第 11/15 分钟`；1 时 `14:00–15:00`；
  1 日 `11月16日`；1 周 `11月10日–11月16日`。
- 入场/强平参考线只在 15 分周期画（仓位只活一根）；其它周期只画底价线，图例对应显示 `—`。
- payload 增加 `timeframes: { '15m'|'1h'|'1d'|'1w': { crop: { base, bars, current } } }`，
  `charts` 保持 15 分（旧窗口/旧测试不破）；`shared.js` 白名单必须放行 `timeframes` 与
  新增的 `start/end` 字段（票 83 踩过的「字段被削」坑）。

## 验收

- [x] 四个周期可切；每个周期 24 根 + 当前一根，OHLC 由 `boardPrice()` 聚合，确定性可断言。 ✅ 2026-11-17
- [x] 1 日按本地自然日、1 周按本地周一 00:00 对齐。 ✅ 2026-11-17
- [x] 图上不再出现绝对根号；四种周期的时间标签正确。 ✅ 2026-11-17
- [x] 入场/强平线只在 15 分显示；切周期不影响合约结算、持仓、硬币。 ✅ 2026-11-17
- [x] `shared.js` 白名单放行 `timeframes`（板窗测试断言未被削）；`npm run check` 全绿。 ✅ 2026-11-17

## 实现记录（回给 lead / 票 85）

- **规则**（`src/trading-rules.js`，只增）：
  - `BOARD_TIMEFRAMES = [{id:'15m',label:'15分'},{id:'1h',label:'1时'},{id:'1d',label:'1日'},{id:'1w',label:'1周'}]`
    —— 周期清单/文案的唯一来源，`limits.timeframes` 直接由它下发。
  - `barsForTimeframe({ crop, now, timeframe = '15m', count = 24 })`：`15m` 原样转 `barsFor()`；
    `1h`（纪元整点、4 slot 一根、每 5 分采样 13 点）、`1d`（本地 00:00、每小时 25 点）、
    `1w`（本地周一 00:00、每 6 小时 29 点）都只用 `markPrice()` 采样，OHLC = 首/末/最值。
    粗周期 `current.tick = null`。
  - `barsFor()` / `barAt()` 每根多带 `start`/`end` 毫秒边界，语义不变（15 分仍 1 分钟 tick）。
  - 结算是另一条路：`slotClosePrice()` / `settlementOf()` / `pathScan()` 一行没改。
- **payload**（`src/service.js` 的 `tradingWindowView()`，`/state.trading` 同一份）：
  `timeframes: {'15m'|'1h'|'1d'|'1w': { crop: { base, bars:[{slot,start,end,open,high,low,close}], current:{slot,start,end,open,high,low,price,tick,remainingMs} } }}`；
  `charts`（15 分）与 `bar` 原样保留（`timeframes['15m']` 就是同一份数据，不重复算）；
  `limits.timeframes: [{ id, label }]`。
- **白名单**（`desktop/shared.js`）：`BOARD_TIMEFRAME_IDS`（drift 断言盯 `BOARD_TIMEFRAMES`）、
  `normalizeBoardTimeframes()`（只放行四个 id，每周期复用 `normalizeBoardCharts()` 的作物/根数上限）、
  每根 `start`/`end`、`limits.timeframes`、`current.tick: null` 全部原样过。
- **view**（`desktop/trading-view.js`）：`chartView(payload, { crop, timeframe })` 选
  `payload.timeframes[timeframe]`，旧包退回 `payload.charts`；返回 `timeframe/timeframeLabel/timeframes`
  （`{id,label,active,disabled}`）、时间标签 `slotText`（15分 `11:30–11:45 · 第 11/15 分钟`、
  1时 `14:00–15:00`、1日 `11月16日`、1周 `11月10日–11月16日`，全按本地时区）、
  `settleNote { text, visible }`（非 15 分显示「合约仍按 15 分钟收盘结算；其它周期只看趋势」）；
  非 15 分的入场/强平为 `null`（图例写「—」、几何里不画线）；`focusOrder` 增加 `timeframe:<id>`。
- **窗口**（`desktop/board.html` / `board.js`）：图表卡里加四个周期页签（作物页签下一行）、
  切周期只本地重画、不重开窗/不发 IPC；`aria-label` 跟着周期走；settle 提示用 `visibility` 占位不跳版。
- **测试**：`test/trading-rules.test.js`（分桶/采样/确定性/结算不变）、`test/trading-view.test.js`
  （四档标签/页签/回退/参考线/提示/键盘顺序）、`test/board-window.test.js`（板窗白名单放行 + 夹取）、
  `test/board-e2e.test.js`（/state 四周期 + 切周期不动钱 + 15 分结算）、
  `test/farm-constants-drift.test.js`（周期 id 同源）。`npm run check`：991 条全绿。
