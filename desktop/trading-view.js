/**
 * 盘口小窗的纯视图模型（票 79）。
 *
 * 这层只做「宿主推来的盘口 view → 标题/倒计时/下单区/持仓卡/历史」的纯计算，
 * 不碰 window、document、IPC，也不改任何数据。渲染页把它当普通 script 加载
 * （`window.dshZooBoardView`），Node 测试用 `require` 同一份文件；DOM 由
 * `desktop/board.js` 建。
 *
 * 为什么单独一层（和 `farm-view.js` 同一条纪律）：窗口只画，判断（能不能下单、
 * 为什么不能、一句话文案）必须能在 Node 里断言，不能只靠真 Electron 冒烟。
 * 数字口径全在这里统一：价格两位小数、盈亏一位小数、倒计时 mm:ss。
 */
(function (root, factory) {
  'use strict'
  const api = factory()
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api
  if (root !== null && typeof root === 'object') root.dshZooBoardView = api
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict'

  const MINUTE_MS = 60 * 1000
  const HOUR_MS = 60 * MINUTE_MS
  const DAY_MS = 24 * HOUR_MS
  /** 兜底白名单：宿主每一包都会带 `limits`，这里只在极端情况下（老宿主/坏包）用。 */
  const FALLBACK_LIMITS = Object.freeze({
    margins: Object.freeze([50, 100]),
    leverages: Object.freeze([1]),
    crops: Object.freeze([{ id: 'tomato', name: '小番茄' }]),
    historyLimit: 50
  })
  const SIDE_LABELS = Object.freeze({ long: '做多', short: '做空' })
  const SIDE_SHORT = Object.freeze({ long: '多', short: '空' })
  const REASON_LABELS = Object.freeze({
    close: '手动平仓',
    settle: '收盘结算',
    // 票 80 才会写这两种；先认出来，老窗口不会把原因画成空白。
    liquidate: '强平',
    stop: '止损'
  })

  /** 数字口径与宿主 `finiteNumber` 一致：null/空串/布尔都当「没有」，不是 0。 */
  function toNumber (value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string' && value.trim() !== '') {
      const num = Number(value)
      return Number.isFinite(num) ? num : null
    }
    return null
  }

  /** 硬币：整数 + 千分位。不用 toLocaleString（它跟系统语言，测试会飘）。 */
  function formatCoins (value) {
    const num = toNumber(value)
    if (num === null) return '0'
    return String(Math.round(num)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  /** 盘口价：两位小数。 */
  function formatPrice (value) {
    const num = toNumber(value)
    return num === null ? '—' : num.toFixed(2)
  }

  /** 盈亏：带符号的一位小数（展示口径；入账由宿主取整）。 */
  function formatSigned (value, digits = 1) {
    const num = toNumber(value)
    if (num === null) return '—'
    const rounded = Number(num.toFixed(digits))
    const text = Math.abs(rounded).toFixed(digits)
    if (rounded > 0) return '+' + text
    if (rounded < 0) return '-' + text
    return text
  }

  /** 倒计时 mm:ss：向上取整，刚开一根就是 15:00。 */
  function formatCountdown (ms) {
    const num = toNumber(ms)
    if (num === null || num <= 0) return '00:00'
    const total = Math.ceil(num / 1000)
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
  }

  /** 多久以前：只按差值算，不依赖系统时区（历史行在哪个时区都读得通）。 */
  function formatAgo (at, now) {
    const stamp = toNumber(at)
    const current = toNumber(now)
    if (stamp === null || current === null) return ''
    const diff = Math.max(0, current - stamp)
    if (diff < MINUTE_MS) return '刚刚'
    if (diff < HOUR_MS) return Math.floor(diff / MINUTE_MS) + ' 分钟前'
    if (diff < DAY_MS) return Math.floor(diff / HOUR_MS) + ' 小时前'
    return Math.floor(diff / DAY_MS) + ' 天前'
  }

  function sideLabel (side) {
    return SIDE_LABELS[side] ?? '—'
  }

  function reasonText (reason) {
    return REASON_LABELS[reason] ?? '结算'
  }

  function limitsOf (payload) {
    const limits = payload !== null && typeof payload === 'object' ? payload.limits : null
    if (limits === null || typeof limits !== 'object') return FALLBACK_LIMITS
    return {
      margins: Array.isArray(limits.margins) && limits.margins.length > 0
        ? limits.margins
        : FALLBACK_LIMITS.margins,
      leverages: Array.isArray(limits.leverages) && limits.leverages.length > 0
        ? limits.leverages
        : FALLBACK_LIMITS.leverages,
      crops: Array.isArray(limits.crops) && limits.crops.length > 0
        ? limits.crops
        : FALLBACK_LIMITS.crops,
      historyLimit: Number.isInteger(limits.historyLimit) ? limits.historyLimit : FALLBACK_LIMITS.historyLimit
    }
  }

  function cropNameOf (payload, cropId) {
    for (const crop of limitsOf(payload).crops) {
      if (crop !== null && typeof crop === 'object' && crop.id === cropId) {
        return typeof crop.name === 'string' && crop.name !== '' ? crop.name : cropId
      }
    }
    return typeof cropId === 'string' ? cropId : '—'
  }

  function coinsOf (payload) {
    const coins = payload !== null && typeof payload === 'object' ? payload.coins : null
    const available = coins !== null && typeof coins === 'object' ? toNumber(coins.available) : null
    const locked = coins !== null && typeof coins === 'object' ? toNumber(coins.locked) : null
    const total = coins !== null && typeof coins === 'object' ? toNumber(coins.total) : null
    return {
      available: available === null ? 0 : available,
      locked: locked === null ? 0 : locked,
      total: total === null ? (available === null ? 0 : available) : total
    }
  }

  /**
   * 顶部：当前价格、本根涨跌、倒计时、硬币。
   * 倒计时优先用 `now` 现算（窗口每秒重画一次），没有 `now` 就退回宿主给的 remainingMs。
   */
  function headerView (payload, now) {
    const bar = payload !== null && typeof payload === 'object' ? payload.bar : null
    const coins = coinsOf(payload)
    const safeBar = bar !== null && typeof bar === 'object' ? bar : null
    const price = safeBar === null ? null : toNumber(safeBar.price)
    const open = safeBar === null ? null : toNumber(safeBar.open)
    const end = safeBar === null ? null : toNumber(safeBar.end)
    const nowMs = toNumber(now)
    const current = nowMs === null ? null : nowMs
    // 窗口每秒把 now 传进来重算；只有「还没有 now」时才退回宿主给的 remainingMs。
    const fallback = safeBar === null ? 0 : (toNumber(safeBar.remainingMs) ?? 0)
    const remaining = end === null || current === null ? fallback : end - current
    const change = price === null || open === null || open <= 0 ? null : (price / open - 1) * 100
    return {
      crop: safeBar === null ? null : safeBar.crop ?? null,
      cropName: safeBar === null ? '—' : cropNameOf(payload, safeBar.crop),
      priceText: formatPrice(price),
      openText: formatPrice(open),
      changeText: change === null ? '—' : formatSigned(change, 2) + '%',
      tone: change === null || Number(change.toFixed(2)) === 0 ? 'flat' : change > 0 ? 'up' : 'down',
      countdownText: formatCountdown(Math.max(0, remaining)),
      countdownMs: Math.max(0, remaining),
      coinsAvailableText: formatCoins(coins.available),
      coinsTotalText: formatCoins(coins.total),
      coinsLockedText: formatCoins(coins.locked)
    }
  }

  /**
   * 下单区：方向、保证金、能不能点、为什么不能。
   * 「0 硬币 → 去种地」是 SPEC 的明确口径：盘口不给救济，农场是唯一退路。
   */
  function orderView (payload, { side = 'long', margin = 50 } = {}) {
    const limits = limitsOf(payload)
    const coins = coinsOf(payload)
    const chosenSide = SIDE_LABELS[side] === undefined ? 'long' : side
    const chosenMargin = limits.margins.includes(margin) ? margin : limits.margins[0]
    const leverage = limits.leverages[0]
    const perPercent = (chosenMargin * leverage) / 100

    let canSubmit = true
    let hint = ''
    if (coins.available <= 0) {
      canSubmit = false
      hint = '硬币不够了，先去种地。'
    } else if (coins.available < chosenMargin) {
      canSubmit = false
      hint = '硬币不够，选小一点的保证金或先去卖点作物。'
    }
    return {
      side: chosenSide,
      margin: chosenMargin,
      sides: Object.keys(SIDE_LABELS).map((candidate) => ({
        side: candidate,
        label: SIDE_LABELS[candidate],
        active: candidate === chosenSide
      })),
      margins: limits.margins.map((candidate) => ({
        margin: candidate,
        label: String(candidate),
        active: candidate === chosenMargin,
        disabled: coins.available < candidate
      })),
      canSubmit,
      hint,
      preview: '涨 1% = ' + formatSigned(perPercent) + ' 币；跌 1% = ' +
        formatSigned(-perPercent) + ' 币；强平 —',
      submitLabel: canSubmit ? sideLabel(chosenSide) + ' ' + chosenMargin : '去种地'
    }
  }

  /** 持仓卡：方向/作物/盈亏/保证金/入场/现价；收盘会自动结算。 */
  function positionCards (payload) {
    const positions = payload !== null && typeof payload === 'object' && Array.isArray(payload.positions)
      ? payload.positions
      : []
    const cards = []
    for (const position of positions) {
      if (position === null || typeof position !== 'object') continue
      if (typeof position.id !== 'string' || position.id === '') continue
      const pnl = toNumber(position.pnl)
      const settling = position.settling === true
      cards.push({
        id: position.id,
        side: position.side === 'short' ? 'short' : 'long',
        sideLabel: sideLabel(position.side),
        cropName: cropNameOf(payload, position.crop),
        title: sideLabel(position.side) + ' · ' + cropNameOf(payload, position.crop) +
          ' · ' + Math.max(1, Math.round(toNumber(position.leverage) ?? 1)) + '×',
        pnlText: formatSigned(pnl),
        pnlTone: pnl === null || Number(pnl.toFixed(1)) === 0 ? 'flat' : pnl > 0 ? 'up' : 'down',
        marginText: formatCoins(position.margin),
        entryText: formatPrice(position.entry),
        markText: formatPrice(position.mark),
        settling,
        statusText: settling ? '结算中…' : '收盘自动结算',
        closeLabel: settling ? '结算中' : '平仓',
        canClose: !settling
      })
    }
    return cards
  }

  /** 最近结算：一行一笔，写明原因（收盘/手动，票 80 再加强平/止损）。 */
  function historyRows (payload, now) {
    const history = payload !== null && typeof payload === 'object' && Array.isArray(payload.history)
      ? payload.history
      : []
    const rows = []
    for (const entry of history) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.id !== 'string' || entry.id === '') continue
      const pnl = toNumber(entry.pnl)
      rows.push({
        id: entry.id,
        title: sideLabel(entry.side) + ' · ' + cropNameOf(payload, entry.crop) +
          ' · ' + Math.max(1, Math.round(toNumber(entry.leverage) ?? 1)) + '×',
        pnlText: formatSigned(pnl),
        pnlTone: pnl === null || Number(pnl.toFixed(1)) === 0 ? 'flat' : pnl > 0 ? 'up' : 'down',
        entryText: formatPrice(entry.entry),
        exitText: formatPrice(entry.exit),
        reasonText: reasonText(entry.reason),
        atText: formatAgo(entry.at, now)
      })
    }
    return rows
  }

  /** 空态文案：三块都要说清「现在能做什么」，不是一句「暂无数据」。 */
  function emptyHints (payload) {
    const coins = coinsOf(payload)
    return {
      positions: coins.available <= 0
        ? '还没有持仓。硬币不够开仓时，先去种地。'
        : '还没有持仓。选好方向和保证金，一键开一手。',
      history: '还没有结算记录。收盘或手动平仓后会出现在这里。'
    }
  }

  /** 窗口要的全部内容（`board.js` 只负责把它画成 DOM）。 */
  function boardView (payload, { now = Date.now(), side = 'long', margin = 50 } = {}) {
    const safe = payload !== null && typeof payload === 'object' ? payload : null
    return {
      header: headerView(safe, now),
      order: orderView(safe, { side, margin }),
      positions: positionCards(safe),
      history: historyRows(safe, now),
      hints: emptyHints(safe)
    }
  }

  return {
    formatCoins,
    formatCountdown,
    reasonText,
    cropNameOf,
    headerView,
    orderView,
    positionCards,
    historyRows,
    emptyHints,
    boardView
  }
})
