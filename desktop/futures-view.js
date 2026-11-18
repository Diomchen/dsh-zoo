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

  /** 交割价与四根收盘价：保留四位，方便用户自己加总复核到分。 */
  function formatDeliveryPrice (value) {
    const num = finite(value)
    return num === null ? '—' : num.toFixed(4)
  }

  /** 时间戳 → HH:mm；无效值写「—」（成交表与挂单表共用）。 */
  function formatClock (value) {
    const num = finite(value)
    if (num === null) return '—'
    const date = new Date(num)
    return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
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

  /**
   * 票 109：交割倒计时。所有报价共用同一张日合约，取其中最早的 `expireAt`。
   * 收盘前 30 分钟开始提醒——想收货就点「转」，过了 20:00 只能现金结算。
   */
  const EXPIRE_WARN_MS = 30 * 60 * 1000
  function expiryOf (view, now) {
    const stamp = finite(now)
    let at = null
    const quotes = view?.quotes !== null && typeof view?.quotes === 'object' && !Array.isArray(view?.quotes)
      ? Object.values(view.quotes)
      : []
    for (const quote of quotes) {
      const expireAt = finite(quote?.contract?.expireAt)
      if (expireAt === null || expireAt <= 0) continue
      if (at === null || expireAt < at) at = expireAt
    }
    if (at === null || stamp === null) return { at, urgent: false, text: null }
    const left = at - stamp
    if (left <= 0) return { at, urgent: true, text: '这张合约已到期，只能现金结算了。' }
    if (left > EXPIRE_WARN_MS) return { at, urgent: false, text: null }
    const minutes = Math.max(1, Math.ceil(left / 60000))
    return {
      at,
      urgent: true,
      text: '距交割还有 ' + minutes + ' 分钟：想收货就点「转」按公允价买现货，到期后只能现金结算。'
    }
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

  /** 顶部：可用余额 / 占用保证金 / 总权益 / 本周盈亏与收益率 / 保险基金 / 欠账。 */
  function header (view) {
    const balance = round2(view?.balance) ?? 0
    const marginUsed = round2(view?.marginUsed) ?? 0
    const equity = round2(view?.equity) ?? round2(balance + marginUsed) ?? 0
    const weekPnl = round2(view?.week?.pnl) ?? 0
    // 票 96 的两个兜底数：宿主还没下发时按 0 画，别显示成「—」像丢了数据。
    const insurance = round2(view?.insurance) ?? 0
    const shortfall = round2(view?.shortfall) ?? 0
    // 1.12.4：做市商净盈亏。负 = 系统净付出（玩家整体赢了多少），正 = 系统净收。
    const house = round2(view?.house) ?? 0
    // 收益率的分母用「本周开始时的权益」近似：现在权益 − 本周盈亏。
    const base = equity - weekPnl
    const weekPct = base > 0 ? weekPnl / base : null
    return {
      balance: formatCoin(balance),
      marginUsed: formatCoin(marginUsed),
      equity: formatCoin(equity),
      weekPnl: formatSigned(weekPnl),
      weekPct: weekPct === null ? '—' : formatPct(weekPct),
      weekTone: weekPnl > 0 ? 'up' : weekPnl < 0 ? 'down' : 'flat',
      insurance: formatCoin(insurance),
      shortfall: formatCoin(shortfall),
      house: formatSigned(house),
      houseTone: house > 0 ? 'up' : house < 0 ? 'down' : 'flat',
      mode: modeOf(view)
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
    const wanted = round2(margin * leverage) ?? 0
    const lots = Math.max(1, Math.floor(wanted / (price * lotSize)))
    // 名义是「真实张数 × 一张多少单位 × 价」：保证金太小、张数被抬到 1 张时，
    // 名义会比「保证金 × 杠杆」大得多（1 张 15.54 的蓝莓 = 1,554 名义，不是 100）。
    const notionalReal = round2(lots * lotSize * price) ?? 0
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
      notional: notionalReal,
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
        // 底部三栏只有 760 宽，画合约代号会被裁掉；代号留在 `title` 里，单元格画作物名。
        label: cropNameOf(view, position?.crop) ?? (typeof position?.contract === 'string' ? position.contract : '—'),
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

  /** 作物展示名：优先用宿主下发的目录，没有目录时退回 id。 */
  function cropNameOf (view, cropId) {
    if (typeof cropId !== 'string' || cropId === '') return null
    const crops = Array.isArray(view?.crops) ? view.crops : []
    for (const crop of crops) {
      if (crop?.id !== cropId) continue
      return typeof crop.label === 'string' && crop.label !== '' ? crop.label : cropId
    }
    return cropId
  }

  /**
   * 我的挂单（票 95）：合约 / 方向 / 限价 / 张数 / 剩余 / 冻结保证金。
   * 价格与张数照账本原样；冻结是「还压着的钱」，两位小数。
   */
  function orderRows (view) {
    const orders = Array.isArray(view?.orders) ? view.orders : []
    const rows = []
    for (const order of orders) {
      const price = round2(order?.price)
      const lots = finite(order?.lots)
      if (price === null || price <= 0 || lots === null || lots < 1) continue
      const contract = typeof order?.contract === 'string' && order.contract !== '' ? order.contract : null
      const name = cropNameOf(view, order?.crop) ?? contract
      rows.push({
        id: typeof order?.id === 'string' ? order.id : null,
        label: name ?? '—',
        side: order?.side === 'short' ? '空' : '多',
        sideText: order?.side === 'short' ? '做空' : '做多',
        price: formatPrice(price),
        lots: String(lots),
        lotsLeft: String(finite(order?.lotsLeft) ?? 0),
        marginFrozen: formatCoin(order?.marginFrozen ?? 0),
        at: formatClock(order?.at)
      })
    }
    return rows
  }

  /** 成交记录：最近 20 条，最新在前。票 96 的交割/转现货/强平也要说清楚。 */
  function tradeRows (view) {
    const trades = Array.isArray(view?.trades) ? view.trades : []
    const kindText = { open: '开', close: '平', delivery: '交', convert: '转', liquidation: '强' }
    return trades.slice(0, 20).map((trade) => {
      return {
        time: formatClock(trade?.at),
        label: cropNameOf(view, trade?.crop) ?? (typeof trade?.contract === 'string' ? trade.contract : '—'),
        contract: typeof trade?.contract === 'string' ? trade.contract : '—',
        side: trade?.side === 'short' ? '空' : '多',
        sideKey: trade?.side === 'short' ? 'short' : 'long',
        kind: kindText[trade?.kind] ?? '开',
        price: formatPrice(trade?.price),
        lots: String(finite(trade?.lots) ?? 0),
        fee: formatCoin(trade?.fee ?? 0)
      }
    })
  }

  /**
   * 到期日交割窗口（票 96）一句话：交割价 + 四根收盘价，带各自的时刻。
   * 四根缺一或缺价就返回 null（残缺窗口不硬画一个复核不了的数）。
   */
  function deliveryLine (view) {
    const delivery = view?.delivery
    if (delivery === null || typeof delivery !== 'object' || Array.isArray(delivery)) return null
    const price = finite(delivery.price)
    const closes = Array.isArray(delivery.closes) ? delivery.closes.map((value) => finite(value)) : []
    if (price === null || price <= 0 || closes.length !== 4 || closes.some((value) => value === null)) return null
    const at = finite(delivery.at)
    const parts = closes.map((value, index) => {
      if (at === null) return formatDeliveryPrice(value)
      return formatClock(at - (3 - index) * SLOT_MS) + ' ' + formatDeliveryPrice(value)
    })
    return '交割价 ' + formatDeliveryPrice(price) + '（' + parts.join(' / ') + '）'
  }

  /** 交易阶段提示：交易中不打扰，到期/周末才贴一行。 */
  function sessionLine (view) {
    const session = view?.session
    if (session === null || typeof session !== 'object' || Array.isArray(session)) return null
    if (session.kind === 'trading') return null
    return typeof session.text === 'string' && session.text !== '' ? session.text : null
  }

  /**
   * 状态：没就绪 / 没钱 / 正常三种。
   * 文案在这里定，渲染页只负责贴上去——「服务未就绪」和「还没充钱」长得不一样。
   */
  function statusOf (view) {
    if (view === null || view === undefined) {
      return { kind: 'starting', text: '期货市场还没就绪，稍等一拍。', action: null }
    }
    // 票 98：关掉/回滚过时先报关闭——这时候没有报价、没有托管，说别的都像 bug。
    const mode = modeOf(view)
    if (mode.kind === 'off') return { kind: 'off', text: mode.text, action: null }
    if (view.ready === false) {
      // 对端没升级时房主的账户发不过来，界面得说清楚是谁的问题。
      if (view.peer !== undefined && view.peer !== null && view.peer.ready === false) {
        return { kind: 'starting', text: view.peer.text ?? '对端未升级，期货不可用。', action: null }
      }
      return { kind: 'starting', text: '期货市场还没就绪，稍等一拍。', action: null }
    }
    // 自己是 peer 时窗口照常可看，但要有「等房主」的底注，不能显示成空账户。
    if (view.peer !== undefined && view.peer !== null && view.peer.ready === false) {
      return { kind: 'starting', text: view.peer.text ?? '对端未升级，期货不可用。', action: null }
    }
    // 票 96：账本说已到期/周末时，哪怕余额为空也先报「收盘」，文案用宿主给的那句。
    const session = view.session
    if (session !== null && typeof session === 'object' && (session.kind === 'expired' || session.kind === 'weekend')) {
      const text = typeof session.text === 'string' && session.text !== '' ? session.text : '今天已收盘。'
      return { kind: 'closed', text, action: null }
    }
    // 票 98：影子模式没有报价也要说清楚是「只记账」，不能落成「周末休市」。
    if (session !== null && typeof session === 'object' && session.kind === 'shadow') {
      const text = typeof session.text === 'string' && session.text !== '' ? session.text : mode.text
      return { kind: 'shadow', text, action: null }
    }
    const balance = round2(view.balance) ?? 0
    const marginUsed = round2(view.marginUsed) ?? 0
    const hasTrades = Array.isArray(view.trades) && view.trades.length > 0
    if (balance <= 0 && marginUsed <= 0 && !hasTrades) {
      return { kind: 'no-funds', text: '托管账户还是空的：先从农场硬币充一点进来。', action: 'deposit' }
    }
    const quotes = view.quotes ?? {}
    if (Object.keys(quotes).length === 0) {
      return { kind: 'closed', text: '周末休市：周一 00:00 开今天这张合约。', action: null }
    }
    return { kind: 'ok', text: '', action: null }
  }

  /**
   * 1.12.0：暂停是**每个人自己的事**。房主按下去只停自己那本账，停不了别人的市；
   * 所以窗口里不再有「关市」，只有「暂停 / 继续」和「退出」（只退自己）。
   */
  function pauseOf (view) {
    if (view?.disabled === true) {
      return { paused: false, label: '已退出', text: '', toggleLabel: null }
    }
    if (view?.paused === true) {
      return {
        paused: true,
        label: '暂停中',
        text: '你暂停了：新仓、挂单都停下，已开的仓和余额完好，提现和转现货照常。',
        toggleLabel: '继续交易'
      }
    }
    return { paused: false, label: '交易中', text: '', toggleLabel: '暂停交易' }
  }

  /**
   * 票 98：市场闸门。房主只留「关市 / 开市」这一道；档位（真钱/纸面）是每个账户
   * 自己的事，见 `accountModeOf`。存档里 `disabled === true`（回滚过）一律当 `off`。
   */
  function modeOf (view) {
    if (view?.disabled === true) return { kind: 'off', label: '已退出', text: '退回过：这个账户的期货已关闭，托管余额已退回你自己的农场。' }
    const mode = view?.mode
    if (mode === 'off') return { kind: 'off', label: '未开放', text: '期货未开放：房主还没打开这一层。' }
    return { kind: 'open', label: '开市', text: '' }
  }

  /**
   * 1.10.0：这本账自己的档位——自己决定跟不跟真钱玩，房主管不着。
   * 纸面不是看客：它有独立的一本账、独立盈亏，只是只跟做市商成交。
   */
  function accountModeOf (view) {
    if (view?.accountMode === 'live') {
      return {
        kind: 'live',
        label: '真钱',
        text: '这本账用真硬币：充值/提现都动农场，盈亏也是真的。',
        toggleLabel: '切到纸面',
        next: 'shadow'
      }
    }
    return {
      kind: 'shadow',
      label: '纸面',
      text: '这本账是纸面的：撮合与结算照跑，但不动农场硬币，只跟做市商成交。',
      toggleLabel: '切到真钱',
      next: 'live'
    }
  }

  /** 敞口限额一行：今日已用 / 上限，持仓名义已用 / 上限；影子模式写「日额 0」。 */
  function capsLine (view) {
    const dayCap = finite(view?.dayCap)
    const positionCap = finite(view?.positionCap)
    if (dayCap === null && positionCap === null) return null
    const day = round2(view?.dayNotional) ?? 0
    const used = round2(view?.positionNotional) ?? 0
    const parts = []
    if (dayCap !== null) parts.push('今日 ' + formatCoin(day) + ' / ' + formatCoin(dayCap))
    if (positionCap !== null) parts.push('持仓名义 ' + formatCoin(used) + ' / ' + formatCoin(positionCap))
    return parts.join(' · ')
  }

  /** 托管账里待提取的钱（农场硬币撞上限时留下的那部分）。 */
  function pendingLine (view) {
    const pending = round2(view?.pending) ?? 0
    if (pending <= 0) return null
    return '待提取 ' + formatCoin(pending) + '：农场硬币到上限了，下次提现会先补这一笔。'
  }

  /** 窗口标题：今天这张合约的日期 + 倒计时（宿主没给就只写「期货」）。 */
  function title (view) {
    const week = weekOf(view)
    const end = slotEndOf(view)
    const tick = countdown(end, finite(view?.now))
    const left = tick.text === '—' ? '' : ' · 本根还剩 ' + tick.text
    return week === null ? '期货' + left : '期货 · ' + week + left
  }

  /** 合约的日期/周号（取第一个有报价的合约，`crop-20261117` → `20261117`，旧的 `crop-2026W47` → `2026W47`）。 */
  function weekOf (view) {
    const quotes = view?.quotes ?? {}
    for (const key of Object.keys(quotes)) {
      const id = quotes[key]?.contract?.id
      if (typeof id === 'string') {
        const match = /-(\d{8}|\d{4}W\d{2})$/.exec(id)
        if (match !== null) return match[1]
      }
    }
    return null
  }

  /** 房主才有切档 / 回滚按钮：peer 视图带 `peer` 字段，房主视图没有。 */
  function isHostOf (view) {
    return view?.peer === undefined || view?.peer === null
  }

  /** 一屏要用的全部东西（渲染页调一次就够）。 */
  function build (view, draft, now) {
    const stamp = finite(now) ?? finite(view?.now)
    const end = slotEndOf(view)
    const tick = countdown(end, stamp)
    const preview = orderPreview(view, draft)
    const orders = orderRows(view)
    const mode = modeOf(view)
    const pause = pauseOf(view)
    const positions = positionRows(view)
    const expiry = expiryOf(view, stamp)
    // 「能不能下单」= 市场开着 + 自己没暂停。暂停只锁新仓，不平仓不锁提现。
    const open = mode.kind !== 'off'
    const live = open && pause.paused !== true
    return {
      status: statusOf(view),
      title: title({ ...view, now: stamp, slotEnd: end }),
      countdown: tick,
      header: header(view),
      mode,
      pause,
      account: accountModeOf(view),
      /** 房主才能关市 / 回滚；peer 只读。 */
      isHost: isHostOf(view),
      /** 1.10.0：档位是每个人自己的，只有退出后才不能动。 */
      canSwitchAccount: open,
      canTrade: live,
      canPause: open,
      capsLine: capsLine(view),
      pendingLine: pendingLine(view),
      quotes: quoteRows(view),
      positions,
      /** 票 109：一次把全部持仓转成现货；暂停也能转（那是减风险）。 */
      canConvertAll: positions.length > 0 && open && expiry.at !== null,
      expiry,
      orders,
      orderCount: orders.length,
      deliveryLine: deliveryLine(view),
      sessionLine: sessionLine(view),
      trades: tradeRows(view),
      preview,
      previewText: previewText(preview),
      canSubmit: preview.ok === true && live,
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
    formatDeliveryPrice,
    formatClock,
    countdown,
    slotEndOf,
    expiryOf,
    limitsOf,
    header,
    quoteRows,
    orderPreview,
    previewText,
    positionRows,
    orderRows,
    tradeRows,
    deliveryLine,
    sessionLine,
    modeOf,
    pauseOf,
    accountModeOf,
    capsLine,
    pendingLine,
    isHostOf,
    statusOf,
    title,
    weekOf,
    build
  }
})
