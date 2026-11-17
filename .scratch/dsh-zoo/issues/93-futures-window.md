# 93: 期货窗——看盘、吃价下单、持仓与成交

**What to build:** 从桌面右键或农场窗打开一扇 760×700 的期货窗，能看见 15 个作物本周合约的买卖报价与偏离、下一手要多少保证金和强平价在哪、自己的持仓和最近成交，并能直接下单和平仓。关窗不影响后台结算。

**Blocked by:** 92 (单机期货核心)

**Status:** done

- [x] 独立 focusable 窗口，尺寸与位置沿用盘口窗的做法（位置存盘、越界回收）；关窗后市场照常运转。
  - `desktop/main.js` 的 `openFuturesWindow()` 走 `windowBounds.pickBounds` + `FUTURES_WIDTH=760`/`FUTURES_HEIGHT=700`，位置存 `userData/futures-window.json`（`window-bounds.js` 的 `FUTURES_POSITION_FILE`），拖动 250ms 防抖落盘；`frame:false` + `skipTaskbar` + `focusable:true`，关窗只清窗口状态，`futures.settleDue()` 的 15 秒定时器与状态无关。
  - 窗口开着再点「期货」是 focus 而不是新开；点窗外 `closeFuturesWindow('hide')`；helper 重启后 `src/desktop.js` 的 `resetWindowState()` 会清掉 `futuresWindowOpen`，不会出现"记着开着其实没开"。
- [x] 报价区：每作物一行——合约代号、买一/卖一、价差、公允价相对现货指数的偏离、点差百分比。
  - `desktop/futures-view.js` 的 `quoteRows()`：`bid`/`ask`/`spread`（两位小数）、`deviation`（`fair / index - 1`，`formatPct` 带符号）、`spreadPct`（`spreadRate * 2`）；没有报价的作物 `tone: 'closed'`、数字显示 `—`。
- [x] 本根倒计时：显示距下一次撮合/结算还有多久，到点自动刷新。
  - 宿主下发 `slotEnd`（`(ceil(now / SLOT_MS)) * SLOT_MS`），`countdown()` 画 `mm:ss` 并在 `atEnd` 时置真；`desktop/futures.js` 每秒只重画倒计时，到点调 `futures-refresh`（5 秒最多一次），宿主结算后把新视图推回来。
- [x] 下单区：做多/做空、1×/3×/10×/20×、张数与保证金额度；下单前实时显示「保证金 / 名义价值 / 强平价 / 手续费」四个数，任一为空则禁用提交。
  - `orderPreview()` 先校验 方向 → 整数保证金 → 杠杆白名单 → 作物报价，再算 `lots = max(1, floor(保证金 × 杠杆 / (价格 × 100)))`、`margin = lots × 100 × 价格 / 杠杆`、`fee = 名义 × 0.1%`、`liquidation = 价格 ∓ 1/杠杆`；`canSubmit` 由 `preview.ok` 决定，禁用的是"任一为空"，不是"钱不够"（钱不够由宿主回 `no-balance`）。
  - 五个数都在 `#preview` 里实时重画，空值是 `—`。
- [x] 持仓区：合约、方向、张数、入场价、保证金、强平价、浮盈亏；浮亏接近强平线时整行变红；可一键平仓。
  - `positionRows()`：`liquidation` 按 `1 / leverage` 从入场价推；`danger = -unrealized / margin >= 0.8`（`DANGER_RATIO`），窗口里 `tr.danger` 整行红；「平」按钮只发 `futures-close` + `positionId`。
- [x] 成交记录最近 20 条：时间、合约、方向、价格、张数、手续费。
  - 账本 `futures.json` 新增 `trades`（盘上留 50 条、视图给 20 条，`FUTURES_TRADE_LIMIT` / `FUTURES_VIEW_TRADES`），`open()` 与 `close()` 各记一条 `{at, crop, contract, side, lots, price, fee, kind}`；`tradeRows()` 画成 `HH:MM` + 开/平。
- [x] 顶部展示可用余额、占用保证金、本周盈亏与收益率。
  - 账本新增 `week: {start, pnl}`：`#bookPnl()` 在跨周时先把上周的滚掉，`#weekPnl()` 只在同周内累计；视图 `header()` 画 `balance` / `marginUsed` / `equity` / `weekPnl` / `weekPct`，正负用颜色与符号区分。
- [x] 空态（没充钱）、加载态、错误态（服务未就绪 / 合约已到期）都有明确文案。
  - `statusOf()` 四态：`starting`（还没就绪）/ `no-funds`（托管账户是空的）/ `closed`（周末休市，周一 00:00 开新合约）/ `ok`；下单失败时宿主回的中文 `notice` 原样贴在 `#pReason` 上；已到期合约在 `quoteOf()` 就返回 `null`，窗口显示"这张合约现在不能交易"。
- [x] IPC 走白名单，渲染层不 import 规则层；窗口刷新或重开不丢状态、不重复下单。
  - `desktop/futures-preload.js` 的 `FIELDS` 白名单：`futures-open` 只放 `side/margin/leverage/cropId`，`futures-close` 只放 `positionId`，充值/提现只放 `coins`；`desktop/shared.js` 的 `normalizeFuturesAction()` 在 helper 侧再校验一遍（杠杆白名单、整数保证金、UUID）。
  - 渲染层只 `require` 不到任何 `src/` 模块（`futures-view.js` 是 UMD，常量与宿主同值，靠 `test/futures-window.test.js` 的 drift 断言对齐）。
  - 提交时按钮 `busy` 3 秒，helper 侧 `futuresPending` 非空直接丢；重开窗从 `futuresState` 重画，不重新下单。
- [x] 关窗不影响后台结算：`futures-refresh` 只在窗口开着时推；结算由 15 秒定时器与 `/state` 一起走，关窗不改账。

**验收证据**

- `node --test test/futures-window.test.js` → 10 条全绿（视图模型、预览 drift、危险行、四态、白名单、开/关/重开、`desktop-off`、`futures-refresh`、payload < 64 KiB）。
- `node scripts/run-tests.mjs` → 1095 用例 / 1094 通过 / 1 跳过（全量）。
- 手工：`POST /dsh-zoo/action {"action":"futures-window"}` → `{ok:true, window:'opened'}`；再发一次 → `{ok:true, window:'closed'}`。
