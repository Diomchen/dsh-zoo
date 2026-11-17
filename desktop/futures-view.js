/**
 * 期货小窗的纯视图模型（票 93）。
 *
 * 这层只做「宿主推来的期货 view → 顶部账户条 / 报价表 / 下单预览 / 持仓表 / 成交表 /
 * 空态文案」的纯计算：不碰 window、document、IPC，也不改任何数据。渲染页把它当普通
 * script 加载（`window.dshZooFuturesView`），Node 测试用 `require` 同一份文件。
 *
 * 为什么单独一层（与 `trading-view.js`、`farm-view.js` 同一条纪律）：窗口只画，
 * 「一手要多少保证金」「强平价在哪」「这一行要不要变红」「现在该显示哪句空态」
 * 必须能在 Node 里断言，不能只靠真 Electron 冒烟。
 *
 * 数字口径全在这里统一：价格两位小数、币两位小数、百分比两位带符号、倒计时 mm:ss。
 * 下面几个常量与 `src/futures-rules.js` 是**同一套数**（`test/futures-window.test.js`
 * 有 drift 断言盯着）：一根 15 分钟、一张 100 个作物、吃单费千分之一、做市价差千分之二。
 * 杠杆清单、作物清单、费率**不复制**：一律从 payload 的 `limits` 读。
 */
(function (root, factory) {
  'use strict'
  const api = factory()
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api
  if (root !== null && typeof root === 'object') root.dshZooFuturesView = api
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict'

  const MINUTE_MS = 60 * 1000
  /** 与 `src/futures-rules.js` 的 `SLOT_MS` 同值：一根 15 分钟。 */
  const SLOT_MS = 15 * MINUTE_MS
  /** 与 `LOT_SIZE` 同值：一张 = 100 个作物。 */
  const LOT_SIZE = 100
  /** 与 `TAKER_FEE_RATE` / `MM_SPREAD` 同值，仅在宿主没下发 `limits` 时兜底。 */
  const TAKER_FEE_RATE = 0.001
  const MM_SPREAD = 0.002
  /** 浮亏吃掉保证金的这个比例，整行标红（强平线是 100%）。 */
  const DANGER_RATIO = 0.8

  const WIDTH = 760
  const HEIGHT = 700

  function finite (value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  function round2 (value) {
    const num = finite(value)
    if (num === null) return null
    const rounded = Math.round(num * 100) / 100
    return rounded === 0 ? 0 : rounded
  }

  /** 价格：两位小数；无效值写「—」，不写 NaN。 */
  function formatPrice (value) {
    const num = round2(value)
    return num === null ? '—' : num.toFixed(2)
  }

  /** 币：两位小数；负数带 −，正数不带 +（余额、保证金不需要正号）。 */
  function formatCoin (value) {
    const num = round2(value)
    if (num === null) return '—'
    return (num < 0 ? '−' : '') + Math.abs(num).toFixed(2)
  }

  /** 盈亏：正数带 +，负数带 −；零写 0.00（不带符号，免得像涨了）。 */
  function formatSigned (value) {
    const num = round2(value)
    if (num === null) return '—'
    if (num === 0) return '0.00'
    return (num < 0 ? '−' : '+') + Math.abs(num).toFixed(2)
  }

  /** 百分比：入参是比率（0.0123 → +1.23%）。 */
  function formatPct (value) {
    const num = finite(value)
    if (num === null) return '—'
    const pct = num * 100
    if (Math.abs(pct) < 0.005) return '0.00%'
    return (pct < 0 ? '−' : '+') + Math.abs(pct).toFixed(2) + '%'
  }

  /** 倒计时 mm:ss；到点后显示 00:00 并把 `atEnd` 置真，窗口据此请宿主再推一拍。 */
  function countdown (at, now) {
    const target = finite(at)
    const stamp = finite(now)
    if (target === null || stamp === null) return { text: '—', atEnd: false, ms: 0 }
    const ms = Math.max(0, target - stamp)
    const total = Math.floor(ms / 1000)
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return {
      text: String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0'),
      atEnd: ms <= 0,
      ms
    }
  }

  /** 这一根的收盘时刻（下一根开盘）；宿主没给 `slotEnd` 时自己按 15 分钟算。 */
  function slotEndOf (view) {
    const given = finite(view?.slotEnd)
    if (given !== null) return given
    const now = finite(view?.now)
    if (now === null) return null
    return (Math.floor(now / SLOT_MS) + 1) * SLOT_MS
  }

  function limitsOf (view) {
    const limits = view?.limits ?? {}
    const leverages = Array.isArray(limits.leverages) && limits.leverages.length > 0
      ? limits.leverages.filter((item) => finite(item) !== null && item > 0)
      : [1, 3, 10, 20]
    return {
      leverages,
      lotSize: finite(limits.lotSize) ?? LOT_SIZE,
      takerFeeRate: finite(limits.takerFeeRate) ?? TAKER_FEE_RATE,
      spreadRate: finite(limits.spreadRate) ?? MM_SPREAD
    }
  }

  /** 顶部：可用余额 / 占用保证金 / 总权益 / 本周盈亏与收益率。 */
  function header (view) {
    const balance = round2(view?.balance) ?? 0
    const marginUsed = round2(view?.marginUsed) ?? 0
    const equity = round2(view?.equity) ?? round2(balance + marginUsed) ?? 0
    const weekPnl = round2(view?.week?.pnl) ?? 0
    // 收益率的分母用「本周开始时的权益」近似：现在权益 − 本周盈亏。
    const base = equity - weekPnl
    const weekPct = base > 0 ? weekPnl / base : null
    return {
      balance: formatCoin(balance),
      marginUsed: formatCoin(marginUsed),
      equity: formatCoin(equity),
      weekPnl: formatSigned(weekPnl),
      weekPct: weekPct === null ? '—' : formatPct(weekPct),
      weekTone: weekPnl > 0 ? 'up' : weekPnl < 0 ? 'down' : 'flat'
    }
  }

  /**
   * 报价表：每种作物一行。
   * 合约代号、买一/卖一、价差（绝对）、相对现货指数的偏离、点差百分比。
   */
  function quoteRows (view) {
    const quotes = view?.quotes ?? {}
    const crops = Array.isArray(view?.crops) ? view.crops : []
    const { spreadRate } = limitsOf(view)
    const rows = []
    for (const crop of crops) {
      const id = typeof crop?.id === 'string' ? crop.id : null
      if (id === null) continue
      const quote = quotes[id] ?? null
      const bid = round2(quote?.bid)
      const ask = round2(quote?.ask)
      const fair = round2(quote?.fair)
      const index = round2(crop?.index)
      const label = typeof crop?.label === 'string' && crop.label !== '' ? crop.label : id
      if (bid === null || ask === null || fair === null) {
        rows.push({
          cropId: id,
          label,
          contract: typeof crop?.contract === 'string' ? crop.contract : '—',
          bid: '—',
          ask: '—',
          spread: '—',
          deviation: '—',
          spreadPct: '—',
          tone: 'closed'
        })
        continue
      }
      const deviation = index !== null && index > 0 ? fair / index - 1 : null
      rows.push({
        cropId: id,
        label,
        contract: typeof quote?.contract?.id === 'string' ? quote.contract.id : '—',
        bid: formatPrice(bid),
        ask: formatPrice(ask),
        spread: formatPrice(ask - bid),
        deviation: deviation === null ? '—' : formatPct(deviation),
        spreadPct: formatPct(spreadRate * 2),
        tone: deviation === null ? 'flat' : deviation > 0 ? 'up' : deviation < 0 ? 'down' : 'flat'
      })
    }
    return rows
  }

  /**
   * 下单预览：保证金 / 名义价值 / 张数 / 强平价 / 手续费。
   *
   * 与宿主 `futures-rules.js` 的算法一致（`lotsFor` → `marginOf` → `takerFeeOf`，
   * 全部到分），但这里**只用于展示**；真正的成交价、张数、扣款由宿主算。
   */
  function orderPreview (view, draft) {
    const { lotSize, takerFeeRate } = limitsOf(view)
    const side = draft?.side === 'short' ? 'short' : draft?.side === 'long' ? 'long' : null
    const margin = finite(draft?.margin)
    const leverage = finite(draft?.leverage)
    const cropId = typeof draft?.cropId === 'string' ? draft.cropId : null
    const quote = cropId === null ? null : view?.quotes?.[cropId] ?? null
    const base = { lots: null, notional: null, margin: null, fee: null, liquidation: null, price: null }
    if (side === null) return { ok: false, reason: '选方向', ...base }
    if (margin === null || margin <= 0 || !Number.isInteger(margin)) return { ok: false, reason: '保证金要是整数币', ...base }
    if (leverage === null || !limitsOf(view).leverages.includes(leverage)) return { ok: false, reason: '选杠杆', ...base }
    if (cropId === null) return { ok: false, reason: '选作物', ...base }
    const price = round2(side === 'long' ? quote?.ask : quote?.bid)
    if (price === null || price <= 0) return { ok: false, reason: '这张合约现在不能交易', ...base }
    const notional = round2(margin * leverage) ?? 0
    const lots = Math.max(1, Math.floor(notional / (price * lotSize)))
    const usedMargin = round2((lots * lotSize * price) / leverage) ?? 0
    const fee = round2(lots * lotSize * price * takerFeeRate) ?? 0
    const move = 1 / leverage
    const liquidation = round2(side === 'long' ? price * (1 - move) : price * (1 + move)) ?? 0
    return {
      ok: true,
      reason: null,
      side,
      cropId,
      leverage,
      price,
      lots,
      notional,
      margin: usedMargin,
      fee,
      liquidation,
      cost: round2(usedMargin + fee) ?? usedMargin
    }
  }

  /** 下单区要显示的五个数（未就绪时全是「—」）。 */
  function previewText (preview) {
    if (preview === null || preview.ok !== true) {
      return {
        lots: '—',
        notional: '—',
        margin: '—',
        fee: '—',
        liquidation: '—',
        price: '—'
      }
    }
    return {
      lots: String(preview.lots),
      notional: formatCoin(preview.notional),
      margin: formatCoin(preview.margin),
      fee: formatCoin(preview.fee),
      liquidation: formatPrice(preview.liquidation),
      price: formatPrice(preview.price)
    }
  }

  /**
   * 持仓表：合约、方向、张数、入场价、保证金、强平价、浮盈亏。
   * 浮亏吃掉 80% 保证金时整行标红（`danger`），强平线是 100%。
   */
  function positionRows (view) {
    const { lotSize } = limitsOf(view)
    const positions = Array.isArray(view?.positions) ? view.positions : []
    const rows = []
    for (const position of positions) {
      const leverage = finite(position?.leverage)
      const entry = round2(position?.entry)
      const margin = round2(position?.margin)
      const unrealized = round2(position?.unrealized)
      if (leverage === null || leverage <= 0 || entry === null || entry <= 0) continue
      const move = 1 / leverage
      const liquidation = round2(position.side === 'long' ? entry * (1 - move) : entry * (1 + move)) ?? 0
      const used = margin !== null && margin > 0 && unrealized !== null ? -unrealized / margin : 0
      rows.push({
        id: typeof position?.id === 'string' ? position.id : null,
        contract: typeof position?.contract === 'string' ? position.contract : '—',
        side: position?.side === 'short' ? '空' : '多',
        sideKey: position?.side === 'short' ? 'short' : 'long',
        lots: String(finite(position?.lots) ?? 0),
        lotsValue: finite(position?.lots) ?? 0,
        lotSize,
        entry: formatPrice(entry),
        margin: formatCoin(margin),
        liquidation: formatPrice(liquidation),
        unrealized: formatSigned(unrealized),
        tone: unrealized === null ? 'flat' : unrealized > 0 ? 'up' : unrealized < 0 ? 'down' : 'flat',
        danger: used >= DANGER_RATIO,
        liquidationPrice: liquidation
      })
    }
    return rows
  }

  /** 成交记录：最近 20 条，最新在前。 */
  function tradeRows (view) {
    const trades = Array.isArray(view?.trades) ? view.trades : []
    return trades.slice(0, 20).map((trade) => {
      const at = finite(trade?.at)
      const date = at === null ? null : new Date(at)
      return {
        time: date === null
          ? '—'
          : String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0'),
        contract: typeof trade?.contract === 'string' ? trade.contract : '—',
        side: trade?.side === 'short' ? '空' : '多',
        sideKey: trade?.side === 'short' ? 'short' : 'long',
        kind: trade?.kind === 'close' ? '平' : '开',
        price: formatPrice(trade?.price),
        lots: String(finite(trade?.lots) ?? 0),
        fee: formatCoin(trade?.fee ?? 0)
      }
    })
  }

  /**
   * 状态：没就绪 / 没钱 / 正常三种。
   * 文案在这里定，渲染页只负责贴上去——「服务未就绪」和「还没充钱」长得不一样。
   */
  function statusOf (view) {
    if (view === null || view === undefined) {
      return { kind: 'starting', text: '期货市场还没就绪，稍等一拍。', action: null }
    }
    if (view.ready === false) {
      return { kind: 'starting', text: '期货市场还没就绪，稍等一拍。', action: null }
    }
    const balance = round2(view.balance) ?? 0
    const marginUsed = round2(view.marginUsed) ?? 0
    const hasTrades = Array.isArray(view.trades) && view.trades.length > 0
    if (balance <= 0 && marginUsed <= 0 && !hasTrades) {
      return { kind: 'no-funds', text: '托管账户还是空的：先从农场硬币充一点进来。', action: 'deposit' }
    }
    const quotes = view.quotes ?? {}
    if (Object.keys(quotes).length === 0) {
      return { kind: 'closed', text: '周末休市：下周一 00:00 开新一周的合约。', action: null }
    }
    return { kind: 'ok', text: '', action: null }
  }

  /** 窗口标题：本周合约的周号 + 倒计时（宿主没给就只写「期货」）。 */
  function title (view) {
    const week = weekOf(view)
    const end = slotEndOf(view)
    const tick = countdown(end, finite(view?.now))
    const left = tick.text === '—' ? '' : ' · 本根还剩 ' + tick.text
    return week === null ? '期货' + left : '期货 · ' + week + left
  }

  /** 本周合约的周号（取第一个有报价的合约，`crop-2026W47` → `2026W47`）。 */
  function weekOf (view) {
    const quotes = view?.quotes ?? {}
    for (const key of Object.keys(quotes)) {
      const id = quotes[key]?.contract?.id
      if (typeof id === 'string') {
        const match = /-(\d{4}W\d{2})$/.exec(id)
        if (match !== null) return match[1]
      }
    }
    return null
  }

  /** 一屏要用的全部东西（渲染页调一次就够）。 */
  function build (view, draft, now) {
    const stamp = finite(now) ?? finite(view?.now)
    const end = slotEndOf(view)
    const tick = countdown(end, stamp)
    const preview = orderPreview(view, draft)
    return {
      status: statusOf(view),
      title: title({ ...view, now: stamp, slotEnd: end }),
      countdown: tick,
      header: header(view),
      quotes: quoteRows(view),
      positions: positionRows(view),
      trades: tradeRows(view),
      preview,
      previewText: previewText(preview),
      canSubmit: preview.ok === true,
      limits: limitsOf(view),
      epoch: typeof view?.epoch === 'string' ? view.epoch : ''
    }
  }

  return {
    SLOT_MS,
    LOT_SIZE,
    TAKER_FEE_RATE,
    MM_SPREAD,
    DANGER_RATIO,
    WIDTH,
    HEIGHT,
    formatPrice,
    formatCoin,
    formatSigned,
    formatPct,
    countdown,
    slotEndOf,
    limitsOf,
    header,
    quoteRows,
    orderPreview,
    previewText,
    positionRows,
    tradeRows,
    statusOf,
    title,
    weekOf,
    build
  }
})
