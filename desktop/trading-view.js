/**
 * 盘口小窗的纯视图模型（票 79 / 票 81 / 票 82 / 票 83）。
 *
 * 这层只做「宿主推来的盘口 view → 标题/K 线几何/下单区/到价挂单/持仓卡/历史/真人周榜/空态」的
 * 纯计算，不碰 window、document、IPC，也不改任何数据。渲染页把它当普通 script 加载
 * （`window.dshZooBoardView`），Node 测试用 `require` 同一份文件；DOM 由
 * `desktop/board.js` 建。
 *
 * 为什么单独一层（和 `farm-view.js` 同一条纪律）：窗口只画，判断（能不能下单、
 * 为什么不能、K 线怎么画、一句话文案）必须能在 Node 里断言，不能只靠真 Electron 冒烟。
 * 数字口径全在这里统一：价格两位小数、盈亏一位小数、倒计时 mm:ss、图表用 viewBox 坐标。
 *
 * 复制了宿主规则的地方都有注释标出来：15 分钟一根（算倒数第二根的时间轴）、
 * 止损四档（按钮循环）、下单前的强平价（与 `liquidationPriceOf` 同一条公式，只作展示，
 * `test/trading-view.test.js` 有 drift 断言），以及下单杠杆/保证金/作物白名单
 * （**不复制**，只吃 payload）。票 83 的到价目标价带（0.55–1.75× 底价）也只从
 * payload 的 `chart.base` 读，不在窗口里再写一遍 `PRICE_FLOOR_RATIO`。
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
  /**
   * 一根 15 分钟（与 `src/trading-rules.js` 的 `SLOT_MS` 同值）。
   * 只用来把「当前这一根的 slot」换算成收盘时刻；宿主下发的 `bar.end` 是权威值，
   * 三个作物共用同一根，所以倒计时其实只用 `bar.end`，这里只兜底老 payload。
   */
  const SLOT_MS = 15 * MINUTE_MS
  /** K 线的 viewBox 尺寸：窗口 760×700 时左栏卡片内宽约 384px、图高 188px，1 单位≈1px。 */
  const CHART_WIDTH = 384
  const CHART_HEIGHT = 188
  const CHART_PADDING = Object.freeze({ top: 8, right: 4, bottom: 6, left: 4 })
  /** 兜底白名单：宿主每一包都会带 `limits`，这里只在极端情况下（老宿主/坏包）用。 */
  const FALLBACK_LIMITS = Object.freeze({
    margins: Object.freeze([50, 100, 250]),
    leverages: Object.freeze([1]),
    crops: Object.freeze([{ id: 'tomato', name: '小番茄' }]),
    historyLimit: 50,
    // 老宿主没有「全下」，也没有目标价带；窗口就不画这两样（照样能开仓）。
    allIn: false,
    targetRatio: null
  })
  const SIDE_LABELS = Object.freeze({ long: '做多', short: '做空' })
  const REASON_LABELS = Object.freeze({
    close: '手动平仓',
    settle: '收盘结算',
    liquidate: '强平',
    stop: '止损'
  })
  /** 中文文案里的减号用 U+2212（预览句与止损档位都是产品文案，不用 ASCII 连字符）。 */
  const MINUS = '\u2212'
  /**
   * 止损四档（与 `src/trading-rules.js` 的档位、`desktop/shared.js` 的
   * `BOARD_STOP_LEVELS` 同值）：0 = 关，其余是「亏掉保证金的这个比例就平」。
   * `test/board-window.test.js` 有一致性断言，改档位时三处要一起改。
   */
  const STOP_LEVELS = Object.freeze([0, 0.25, 0.5, 1])
  const STOP_LABELS = Object.freeze({
    0: '关',
    0.25: MINUS + '25%',
    0.5: MINUS + '50%',
    1: MINUS + '100%'
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

  /** 预览句里的小额：5 → '5'，0.5 → '0.5'，0.25 → '0.25'（不画多余的 0）。 */
  function formatTrim (value, digits = 2) {
    const num = toNumber(value)
    if (num === null) return '0'
    return num.toFixed(digits).replace(/\.?0+$/, '') || '0'
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

  /** 涨/跌/平：按**显示精度**判，避免 -0.004 显示成 "0.0" 却染红。 */
  function toneOf (value, digits = 1) {
    const num = toNumber(value)
    if (num === null) return 'flat'
    const rounded = Number(num.toFixed(digits))
    if (rounded > 0) return 'up'
    if (rounded < 0) return 'down'
    return 'flat'
  }

  function stopLevels () {
    return STOP_LEVELS
  }

  /** 认不出的档位当「关」：宁可少一道自动平仓，也不替玩家猜一档。 */
  function stopLevelOf (value) {
    return STOP_LEVELS.includes(value) ? value : 0
  }

  function stopLabel (level) {
    return STOP_LABELS[stopLevelOf(level)]
  }

  /** 按钮点一下到下一档：关 → −25% → −50% → −100% → 关。 */
  function nextStopLevel (level) {
    const index = STOP_LEVELS.indexOf(stopLevelOf(level))
    return STOP_LEVELS[(index + 1) % STOP_LEVELS.length]
  }

  function limitsOf (payload) {
    const limits = payload !== null && typeof payload === 'object' ? payload.limits : null
    if (limits === null || typeof limits !== 'object') return FALLBACK_LIMITS
    const ratio = limits.targetRatio !== null && typeof limits.targetRatio === 'object'
      ? limits.targetRatio
      : null
    const floor = ratio === null ? null : toNumber(ratio.floor)
    const ceil = ratio === null ? null : toNumber(ratio.ceil)
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
      historyLimit: Number.isInteger(limits.historyLimit) ? limits.historyLimit : FALLBACK_LIMITS.historyLimit,
      // 旧宿主没有这两个字段：不画「全下」、不显示目标价带（宿主照样会校验/拒绝）。
      allIn: limits.allIn === true,
      targetRatio: floor === null || ceil === null || floor <= 0 || ceil <= floor
        ? null
        : { floor, ceil }
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

  /** 白名单里的作物 id（页签顺序就是这里的顺序）。 */
  function cropIdsOf (payload) {
    return limitsOf(payload).crops
      .filter((crop) => crop !== null && typeof crop === 'object' && typeof crop.id === 'string')
      .map((crop) => crop.id)
  }

  /** 选中的作物：白名单里有就用它，否则退回第一张图 / 第一个作物。 */
  function pickCrop (payload, crop) {
    const ids = cropIdsOf(payload)
    if (typeof crop === 'string' && ids.includes(crop)) return crop
    const charts = payload !== null && typeof payload === 'object' ? payload.charts : null
    if (charts !== null && typeof charts === 'object') {
      for (const id of ids) {
        if (charts[id] !== null && typeof charts[id] === 'object') return id
      }
    }
    return ids[0] ?? FALLBACK_LIMITS.crops[0].id
  }

  function chartOf (payload, crop) {
    const charts = payload !== null && typeof payload === 'object' ? payload.charts : null
    if (charts === null || typeof charts !== 'object') return null
    const chart = charts[crop]
    return chart !== null && typeof chart === 'object' ? chart : null
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

  /** 作物页签：三作物可切；没图的作物也画出来（切过去是空态，不是消失）。 */
  function cropsView (payload, crop) {
    const selected = pickCrop(payload, crop)
    return limitsOf(payload).crops.map((entry) => {
      const id = entry !== null && typeof entry === 'object' ? entry.id : null
      const name = entry !== null && typeof entry === 'object' && typeof entry.name === 'string'
        ? entry.name
        : id
      return {
        id,
        name,
        label: name,
        active: id === selected,
        hasChart: chartOf(payload, id) !== null
      }
    })
  }

  /**
   * 顶部：当前价格、本根涨跌、倒计时、硬币。
   * 价格取**选中作物**的当前一根；倒计时取 `bar.end`——三个作物共用同一根，
   * 所以切页签不会让倒计时跳。没有 `now` 时退回宿主给的 remainingMs（第一帧）。
   */
  function headerView (payload, now, crop) {
    const selected = pickCrop(payload, crop)
    const chart = chartOf(payload, selected)
    const current = chart !== null && chart.current !== null && typeof chart.current === 'object'
      ? chart.current
      : null
    const bar = payload !== null && typeof payload === 'object' && payload.bar !== null &&
      typeof payload.bar === 'object'
      ? payload.bar
      : null
    const coins = coinsOf(payload)
    const price = current === null
      ? (bar === null ? null : toNumber(bar.price))
      : toNumber(current.price)
    const open = current === null
      ? (bar === null ? null : toNumber(bar.open))
      : toNumber(current.open)
    const slot = current === null
      ? (bar === null ? null : toNumber(bar.slot))
      : toNumber(current.slot)
    const end = bar === null ? null : toNumber(bar.end)
    const nowMs = toNumber(now)
    // 窗口每秒把 now 传进来重算；只有「还没有 now」时才退回宿主给的 remainingMs。
    const fallback = current === null
      ? (bar === null ? 0 : (toNumber(bar.remainingMs) ?? 0))
      : (toNumber(current.remainingMs) ?? 0)
    let remaining = fallback
    if (nowMs !== null) {
      if (end !== null) remaining = end - nowMs
      // 老 payload（没有 bar.end）用 slot 现算收盘时刻。
      else if (slot !== null) remaining = (slot + 1) * SLOT_MS - nowMs
    }
    const change = price === null || open === null || open <= 0 ? null : (price / open - 1) * 100
    return {
      crop: selected,
      cropName: cropNameOf(payload, selected),
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
   * 本周盈亏（票 81）：显示「已实现 + 未实现」，收益率 = 合计 / 周起点硬币。
   * `base` 是 0（新账本/坏文件）时收益率画「—」：除零没有意义，不编一个 0%。
   */
  function weekView (payload) {
    const week = payload !== null && typeof payload === 'object' && payload.week !== null &&
      typeof payload.week === 'object'
      ? payload.week
      : {}
    const realized = toNumber(week.pnl) ?? 0
    const unrealized = toNumber(week.unrealized) ?? 0
    const total = toNumber(week.total) ?? realized + unrealized
    const base = toNumber(week.base)
    const pct = base === null || base <= 0 ? null : (total / base) * 100
    return {
      pnl: total,
      realized,
      unrealized,
      base,
      pnlText: formatSigned(total),
      pnlTone: toneOf(total),
      pctText: pct === null ? '—' : formatSigned(pct, 2) + '%',
      pctTone: toneOf(pct, 2),
      baseText: formatCoins(base ?? 0),
      hasBase: base !== null && base > 0
    }
  }

  const HINT_LABELS = Object.freeze({ up: '偏多', down: '偏空', flat: '横盘' })

  /**
   * 风向（票 81）：慢趋势方向 + 55–68% 置信度。
   * `note` 是产品硬要求：SPEC 说快噪声会把弱信号打反，UI 必须写「不是保证」。
   */
  function hintView (payload, crop) {
    const selected = pickCrop(payload, crop)
    const hints = payload !== null && typeof payload === 'object' ? payload.hint : null
    const hint = hints !== null && typeof hints === 'object' ? hints[selected] : null
    if (hint === null || typeof hint !== 'object') {
      return { direction: 'flat', label: '—', confidenceText: '—', note: '不是保证', tone: 'flat' }
    }
    const direction = hint.direction === 'up' || hint.direction === 'down' ? hint.direction : 'flat'
    const confidence = toNumber(hint.confidence) ?? 0
    return {
      direction,
      label: HINT_LABELS[direction],
      confidenceText: Math.round(confidence * 100) + '%',
      note: '不是保证',
      tone: direction
    }
  }

  function isBarLike (bar) {
    if (bar === null || typeof bar !== 'object') return false
    return toNumber(bar.open) !== null && toNumber(bar.high) !== null &&
      toNumber(bar.low) !== null && toNumber(bar.close) !== null
  }

  function isCurrentLike (current) {
    if (current === null || typeof current !== 'object') return false
    return toNumber(current.open) !== null && toNumber(current.high) !== null &&
      toNumber(current.low) !== null && toNumber(current.price) !== null
  }

  /**
   * K 线几何（纯数学，viewBox 坐标）：把「价格」映射成「像素」，窗口只管照坐标画。
   *
   * 纵向定义域 = 所有 K 线的高低点 + 底价；入场/强平线只要不离得太远（±3 个高度）
   * 就一起进定义域，这样 5×/20× 的强平线看得见，而不会被一根远在天边的线把图压扁。
   * 进不了定义域的线仍然返回价格（图例要显示数字），但 `visible:false`，不画。
   */
  function chartGeometry (chart, options = {}) {
    if (chart === null || typeof chart !== 'object') return null
    const bars = (Array.isArray(chart.bars) ? chart.bars : []).filter(isBarLike)
    const current = isCurrentLike(chart.current) ? chart.current : null
    const base = toNumber(chart.base)
    if (bars.length === 0 && current === null) return null
    const width = Math.max(80, toNumber(options.width) ?? CHART_WIDTH)
    const height = Math.max(60, toNumber(options.height) ?? CHART_HEIGHT)
    const padding = { ...CHART_PADDING, ...(options.padding ?? {}) }
    const plot = {
      left: padding.left,
      top: padding.top,
      width: Math.max(1, width - padding.left - padding.right),
      height: Math.max(1, height - padding.top - padding.bottom)
    }
    const entry = toNumber(options.entry)
    const liquidation = toNumber(options.liquidation)
    let min = Infinity
    let max = -Infinity
    const consider = (value) => {
      if (!Number.isFinite(value)) return
      if (value < min) min = value
      if (value > max) max = value
    }
    for (const bar of bars) {
      consider(bar.low)
      consider(bar.high)
    }
    if (current !== null) {
      consider(current.low)
      consider(current.high)
      consider(current.price)
    }
    consider(base)
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null
    let span = max - min
    // 全平的图（一根都没波动）：给一个最小高度，别让 NaN/除零把窗口打崩。
    if (span <= 0) {
      const pad = Math.max(0.01, Math.abs(max) * 0.005)
      min -= pad
      max += pad
      span = max - min
    }
    const margin = span * 3
    for (const value of [entry, liquidation]) {
      if (!Number.isFinite(value)) continue
      if (value >= min - margin && value <= max + margin) {
        consider(value)
      }
    }
    span = max - min
    const yOf = (value) => plot.top + ((max - value) / span) * plot.height
    // 一根蜡烛 = 一根影线（高→低）+ 一个实体（开→收）；实体至少 1px，否则平盘那根会消失。
    const total = bars.length + (current === null ? 0 : 1)
    const toBody = (open, close, slot, index) => {
      const slotWidth = plot.width / Math.max(1, total)
      const bodyWidth = Math.max(2, Math.min(14, slotWidth * 0.62))
      const centerX = plot.left + slotWidth * (index + 0.5)
      const openY = yOf(open)
      const closeY = yOf(close)
      return {
        slot,
        centerX,
        x: centerX - bodyWidth / 2,
        width: bodyWidth,
        bodyTop: Math.min(openY, closeY),
        bodyHeight: Math.max(1, Math.abs(closeY - openY)),
        up: close >= open
      }
    }
    const scaled = bars.map((bar, index) => {
      const body = toBody(bar.open, bar.close, bar.slot, index)
      return {
        ...body,
        wickTop: yOf(bar.high),
        wickBottom: yOf(bar.low)
      }
    })
    const forming = current === null
      ? null
      : {
          ...toBody(current.open, current.price, current.slot, bars.length),
          wickTop: yOf(current.high),
          wickBottom: yOf(current.low),
          price: current.price,
          tick: toNumber(current.tick) ?? 0
        }
    const lines = [
      { key: 'base', value: Number.isFinite(base) ? base : null },
      { key: 'entry', value: entry },
      { key: 'liquidation', value: liquidation }
    ].map((line) => {
      if (line.value === null) return { ...line, y: null, visible: false }
      const y = yOf(line.value)
      const visible = line.value >= min && line.value <= max
      return {
        ...line,
        y: visible ? y : null,
        visible
      }
    })
    return {
      width,
      height,
      plot,
      domain: { min, max },
      bars: scaled,
      forming,
      lines,
      priceLine: current === null ? null : { value: current.price, y: yOf(current.price) },
      grid: [plot.top, plot.top + plot.height / 2, plot.top + plot.height]
    }
  }

  /** 参考线（底价/入场/强平）与图例：没有持仓时入场/强平显示「—」。 */
  function chartReferences (payload, crop) {
    const positions = payload !== null && typeof payload === 'object' && Array.isArray(payload.positions)
      ? payload.positions
      : []
    let reference = null
    for (const position of positions) {
      if (position === null || typeof position !== 'object') continue
      if (position.crop !== crop) continue
      // 多手同作物时只画**最新**那一手：一堆入场线会糊成一团，图例也没处写。
      reference = position
    }
    const entry = reference === null ? null : toNumber(reference.entry)
    const liquidation = reference === null ? null : toNumber(reference.liquidation)
    return {
      reference,
      entry,
      liquidation,
      legend: [
        { key: 'base', label: '底价', text: formatPrice(chartBaseOf(payload, crop)), tone: 'base' },
        { key: 'entry', label: '入场', text: entry === null ? '—' : formatPrice(entry), tone: 'entry' },
        {
          key: 'liquidation',
          label: '强平',
          // 1× 没有强平（SPEC）→「—」；有仓位但强平值是 null 也画「—」。
          text: reference === null || liquidation === null ? '—' : formatPrice(liquidation),
          tone: 'liquidation'
        }
      ]
    }
  }

  function chartBaseOf (payload, crop) {
    const chart = chartOf(payload, crop)
    return chart === null ? null : toNumber(chart.base)
  }

  /**
   * 一张图的全部内容：页签、价格、风向徽章、图例、slot 说明与几何。
   * `hasChart:false` 时 `geometry:null` + 一句空态（老宿主/坏包不会白屏）。
   */
  function chartView (payload, { crop = null, width = CHART_WIDTH, height = CHART_HEIGHT } = {}) {
    const selected = pickCrop(payload, crop)
    const chart = chartOf(payload, selected)
    const current = chart !== null && isCurrentLike(chart.current) ? chart.current : null
    const references = chartReferences(payload, selected)
    const tick = current === null ? null : toNumber(current.tick)
    const geometry = chart === null
      ? null
      : chartGeometry(chart, {
        width,
        height,
        entry: references.entry,
        liquidation: references.liquidation
      })
    const minute = tick === null ? null : Math.min(15, Math.floor(tick) + 1)
    return {
      crop: selected,
      cropName: cropNameOf(payload, selected),
      hasChart: geometry !== null,
      emptyText: '行情还在算，稍等一下。K 线一分钟才动一格。',
      base: chartBaseOf(payload, selected),
      baseText: formatPrice(chartBaseOf(payload, selected)),
      priceText: formatPrice(current === null ? null : current.price),
      highText: formatPrice(current === null ? null : current.high),
      lowText: formatPrice(current === null ? null : current.low),
      slot: current === null ? null : toNumber(current.slot),
      slotText: current === null
        ? '第 — 根'
        : '第 ' + current.slot + ' 根' + (minute === null ? '' : ' · 第 ' + minute + '/15 分钟'),
      reference: references.reference,
      entry: references.entry,
      liquidation: references.liquidation,
      legend: references.legend,
      geometry
    }
  }

  /**
   * 下单预览（产品硬文案）：`5× · 100 保证金：涨 1% = +5；跌 1% = −5；强平 −100`。
   * 涨跌 1% 的盈亏 = 保证金 × 杠杆 / 100；强平时亏掉的就是保证金（1× 没有强平）。
   * 这个数必须与 `src/trading-rules.js` 的 `pnlOf()` 在 ±1% 上一致，
   * `test/trading-view.test.js` 有一条漂移断言盯着它。
   */
  function previewView ({ margin, leverage = 1 } = {}) {
    const marginValue = Math.max(0, toNumber(margin) ?? 0)
    const leverageValue = Math.max(1, Math.round(toNumber(leverage) ?? 1))
    const perPercent = (marginValue * leverageValue) / 100
    const minus = MINUS + formatTrim(perPercent)
    const text = leverageValue + '× · ' + formatTrim(marginValue) + ' 保证金：涨 1% = +' +
      formatTrim(perPercent) + '；跌 1% = ' + minus + '；强平 ' +
      (leverageValue > 1 ? MINUS + formatTrim(marginValue) : '—')
    return {
      text,
      perPercent,
      liquidationLoss: leverageValue > 1 ? marginValue : null
    }
  }

  /**
   * 下单区：方向、保证金（50/100/250 + 全下）、杠杆、到价开关、能不能点、为什么不能。
   * 杠杆/保证金白名单**只从 payload 拿**（票 80 把 leverages 换成 [1,5,20] 时窗口不用改）；
   * 老 payload 没有 leverages 时退回 [1]。
   * 「0 硬币 → 去种地」是 SPEC 的明确口径：盘口不给救济，农场是唯一退路。
   *
   * 票 83 的到价挂单也在这里算：只有 `limitOpen` 为真时才给输入框/挂单按钮出文案；
   * 目标价带来自 payload 的 `limits.targetRatio × chart.base`（不抄宿主常量）。
   * `allIn` 是窗口自己的选择态（点过「全下」），金额永远 = 此刻的可用硬币。
   */
  function orderView (payload, {
    side = 'long',
    margin = 50,
    leverage = 1,
    crop = null,
    limitOpen = false,
    targetText = '',
    allIn = false
  } = {}) {
    const limits = limitsOf(payload)
    const coins = coinsOf(payload)
    const chosenSide = SIDE_LABELS[side] === undefined ? 'long' : side
    const chosenLeverage = limits.leverages.includes(leverage) ? leverage : limits.leverages[0]
    const chosenCrop = pickCrop(payload, crop)
    // 「全下」的金额每包现算（可用硬币），0 硬币时不可选。
    const allInAmount = Math.floor(coins.available)
    const allInSupported = limits.allIn === true && allInAmount >= 1
    const chosenAllIn = allIn === true && allInSupported
    const chosenMargin = chosenAllIn
      ? allInAmount
      : (limits.margins.includes(margin) ? margin : limits.margins[0])
    const preview = previewView({ margin: chosenMargin, leverage: chosenLeverage })

    let canSubmit = true
    let hint = ''
    if (coins.available <= 0) {
      canSubmit = false
      hint = '硬币不够了，先去种地。'
    } else if (coins.available < chosenMargin) {
      canSubmit = false
      hint = '硬币不够，选小一点的保证金或先去卖点作物。'
    }

    const marginChoices = limits.margins.map((candidate) => ({
      margin: candidate,
      label: String(candidate),
      allIn: false,
      active: !chosenAllIn && candidate === chosenMargin,
      disabled: candidate > coins.available
    }))
    if (limits.allIn === true) {
      marginChoices.push({
        margin: allInAmount,
        label: '全下',
        allIn: true,
        active: chosenAllIn,
        // 0 硬币时「全下」也没有钱可下：和预设一样禁用。
        disabled: allInAmount < 1
      })
    }

    // 目标价：输入框空着时用当前现价当默认值；只在「到价」打开时才显示。
    const chart = chartOf(payload, chosenCrop)
    const price = chart !== null && isCurrentLike(chart.current)
      ? toNumber(chart.current.price)
      : null
    const base = chart === null ? null : toNumber(chart.base)
    const ratio = limits.targetRatio
    const band = base === null || ratio === null
      ? null
      : { min: base * ratio.floor, max: base * ratio.ceil }
    // 强平价（SPEC v10 US7）：用 payload 的现价当入场价，下单前就告诉玩家会从哪里被平。
    // 1× 没有强平线（价格有底价，跌不到 0），显示「—」。这是纯展示：公式与宿主
    // `liquidationPriceOf()` 相同，`test/trading-view.test.js` 的 drift 断言盯着两边。
    const liquidationPrice = price === null || chosenLeverage <= 1
      ? null
      : chosenSide === 'long'
        ? price * (1 - 1 / chosenLeverage)
        : price * (1 + 1 / chosenLeverage)
    const liquidationText = liquidationPrice === null
      ? '强平价 —'
      : '强平价 ' + formatPrice(liquidationPrice) + ' · ' +
        (chosenSide === 'long' ? '跌到就平' : '涨到就平')
    const defaultTargetText = price === null ? '' : formatPrice(price)
    const rawTarget = typeof targetText === 'string' ? targetText.trim() : ''
    const effectiveTargetText = rawTarget === '' ? defaultTargetText : rawTarget
    const target = toNumber(effectiveTargetText)
    const targetInBand = target !== null && target > 0 &&
      (band === null || (target >= band.min && target <= band.max))
    const bandText = band === null
      ? ''
      : formatPrice(band.min) + '–' + formatPrice(band.max)
    let limitHint = ''
    if (limitOpen) {
      if (coins.available <= 0) limitHint = '硬币不够了，先去种地。'
      else if (coins.available < chosenMargin) limitHint = '硬币不够，选小一点的保证金或先去卖点作物。'
      else if (!targetInBand) {
        limitHint = bandText === ''
          ? '目标价要填一个大于 0 的数字。'
          : '目标价要在 ' + bandText + ' 之间。'
      }
    }
    const canPlace = limitOpen && targetInBand && coins.available > 0 && coins.available >= chosenMargin

    return {
      side: chosenSide,
      margin: chosenMargin,
      allIn: chosenAllIn,
      leverage: chosenLeverage,
      crop: chosenCrop,
      cropName: cropNameOf(payload, chosenCrop),
      sides: Object.keys(SIDE_LABELS).map((candidate) => ({
        side: candidate,
        label: SIDE_LABELS[candidate],
        active: candidate === chosenSide
      })),
      margins: marginChoices,
      leverages: limits.leverages.map((candidate) => ({
        leverage: candidate,
        label: candidate + '×',
        active: candidate === chosenLeverage
      })),
      canSubmit,
      hint,
      preview: preview.text,
      previewParts: preview,
      // 下单前的强平价（US7）：数字给 drift 测试，文案给窗口。
      liquidationPrice,
      liquidationText,
      // 0 硬币时按钮本身就是「去种地」——盘口不给救济，这是唯一的下一步。
      submitLabel: coins.available <= 0 ? '去种地' : '开一手',
      limit: {
        enabled: limitOpen,
        toggleLabel: '到价',
        targetText: effectiveTargetText,
        target,
        bandText,
        canPlace,
        hint: limitHint,
        placeLabel: coins.available <= 0 ? '去种地' : '挂单',
        // 说清做多/做空分别等哪个方向越价，不用玩家自己推。
        note: chosenSide === 'long'
          ? '到价成交：价格跌到目标价时做多；收盘没成交自动撤单。'
          : '到价成交：价格涨到目标价时做空；收盘没成交自动撤单。'
      }
    }
  }

  /**
   * 持仓卡：方向/杠杆、作物、盈亏、保证金、入场、现价、强平、止损、平仓。
   * 强平 1× 是「—」；止损按钮显示**当前**档位，点一下提交下一档。
   */
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
      const leverage = Math.max(1, Math.round(toNumber(position.leverage) ?? 1))
      const level = stopLevelOf(position.stopLoss)
      const liquidation = position.liquidation === null || position.liquidation === undefined
        ? null
        : toNumber(position.liquidation)
      cards.push({
        id: position.id,
        side: position.side === 'short' ? 'short' : 'long',
        sideLabel: sideLabel(position.side),
        cropName: cropNameOf(payload, position.crop),
        leverage,
        title: sideLabel(position.side) + ' · ' + cropNameOf(payload, position.crop) + ' · ' + leverage + '×',
        pnlText: formatSigned(pnl),
        pnlTone: toneOf(pnl),
        marginText: formatCoins(position.margin),
        entryText: formatPrice(position.entry),
        markText: formatPrice(position.mark),
        liqText: liquidation === null ? '—' : formatPrice(liquidation),
        stopLevel: level,
        stopLabel: stopLabel(level),
        stopTitle: '止损 ' + stopLabel(level),
        nextStopLevel: nextStopLevel(level),
        canStop: !settling,
        settling,
        statusText: settling ? '结算中…' : '收盘自动结算',
        closeLabel: settling ? '结算中' : '平仓',
        canClose: !settling
      })
    }
    return cards
  }

  /** 最近结算：一行一笔，写明原因（收盘/手动/强平/止损）。 */
  function historyRows (payload, now) {
    const history = payload !== null && typeof payload === 'object' && Array.isArray(payload.history)
      ? payload.history
      : []
    const rows = []
    for (const entry of history) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.id !== 'string' || entry.id === '') continue
      const pnl = toNumber(entry.pnl)
      const leverage = Math.max(1, Math.round(toNumber(entry.leverage) ?? 1))
      rows.push({
        id: entry.id,
        title: sideLabel(entry.side) + ' · ' + cropNameOf(payload, entry.crop) + ' · ' + leverage + '×',
        pnlText: formatSigned(pnl),
        pnlTone: toneOf(pnl),
        entryText: formatPrice(entry.entry),
        exitText: formatPrice(entry.exit),
        reasonText: reasonText(entry.reason),
        atText: formatAgo(entry.at, now)
      })
    }
    return rows
  }

  /**
   * 到价挂单列表（票 83）：一行一张，写明方向/作物/杠杆、目标价、保证金和「还有多久」。
   * 剩余时间取 `slot + 1` 的收盘时刻（挂单只活一根）；宿主也会带 `remainingMs`，
   * 只有缺 slot 的老包才退回它。`canCancel` 永远为真——退款幂等在宿主。
   */
  function orderRows (payload, now) {
    const orders = payload !== null && typeof payload === 'object' && Array.isArray(payload.orders)
      ? payload.orders
      : []
    const current = toNumber(now)
    const rows = []
    for (const order of orders) {
      if (order === null || typeof order !== 'object') continue
      if (typeof order.id !== 'string' || order.id === '') continue
      const slot = toNumber(order.slot)
      // 有 now 且知道 slot 就现算；否则退回宿主给的 remainingMs（第一帧/老包）。
      const remaining = current === null || slot === null
        ? toNumber(order.remainingMs) ?? 0
        : Math.max(0, (slot + 1) * SLOT_MS - current)
      const leverage = Math.max(1, Math.round(toNumber(order.leverage) ?? 1))
      rows.push({
        id: order.id,
        title: sideLabel(order.side) + ' · ' + cropNameOf(payload, order.crop) + ' · ' + leverage + '×',
        targetText: formatPrice(order.target),
        marginText: formatCoins(order.margin),
        remainingMs: remaining,
        remainingText: '剩 ' + formatCountdown(remaining),
        canCancel: true,
        cancelLabel: '撤单'
      })
    }
    return rows
  }

  /** 空态文案：每一块都要说清「现在能做什么」，不是一句「暂无数据」。 */
  function emptyHints (payload) {
    const coins = coinsOf(payload)
    return {
      positions: coins.available <= 0
        ? '还没有持仓。硬币不够开仓时，先去种地。'
        : '还没有持仓。选好方向和保证金，一键开一手。',
      history: '还没有结算记录。收盘或手动平仓后会出现在这里。',
      // 票 83：到价是可选工具，空态顺便教一次怎么用；收盘没成交自动撤。
      orders: coins.available <= 0
        ? '没有挂单。硬币不够，先去种地。'
        : '没有挂单。点开「到价」设一个目标价，到价自动成交；收盘没成交自动撤单。',
      // 票 82：榜上只有自己时用这一句（空态也要说清「现在能做什么」）。
      neighbors: '还没有邻居上线。等邻居打开 DSH 就会出现在这里；行情照走，一个人也能做单。'
    }
  }

  /**
   * 真人周榜 + LAN 情绪（票 82）。
   *
   * 排序、新鲜度、计数全部由宿主算好（`src/trading-league.js` 是纯函数的那一层），
   * 这里只把数字画成文案：本周盈亏 `+12` / `-8`、收益率 `+3.50%` 或 `—`、
   * 持仓摘要 `多 2 · 空 1`，一条仓位都没有就是「观望」。
   * 收益率是**比率**（0.035 = +3.5%，与 SPEC 的 `weekPnl / weekBase` 同口径），
   * 所以显示时乘 100；邻居没报就是 null → 「—」，不拿 0% 冒充。
   */
  function leagueView (payload) {
    const safe = payload !== null && typeof payload === 'object' ? payload : null
    const league = safe !== null && safe.league !== null && typeof safe.league === 'object'
      ? safe.league
      : {}
    const rows = []
    for (const entry of Array.isArray(league.rows) ? league.rows : []) {
      if (entry === null || typeof entry !== 'object') continue
      const weekPnl = toNumber(entry.weekPnl)
      if (weekPnl === null) continue
      const pct = toNumber(entry.weekPnlPct)
      let long = 0
      let short = 0
      for (const position of Array.isArray(entry.positions) ? entry.positions : []) {
        if (position === null || typeof position !== 'object') continue
        if (position.side === 'long') long += 1
        else if (position.side === 'short') short += 1
      }
      const nickname = typeof entry.nickname === 'string' && entry.nickname.trim() !== ''
        ? entry.nickname.trim()
        : '邻居'
      rows.push({
        nickname,
        me: entry.me === true,
        pnlText: formatSigned(weekPnl, 0),
        pnlTone: toneOf(weekPnl),
        pctText: pct === null ? '—' : formatSigned(pct * 100, 2) + '%',
        pctTone: pct === null ? 'flat' : toneOf(pct * 100, 2),
        positionsText: long === 0 && short === 0 ? '观望' : '多 ' + long + ' · 空 ' + short
      })
    }
    const counts = league.sentiment !== null && typeof league.sentiment === 'object'
      ? league.sentiment
      : {}
    const long = Math.max(0, Math.round(toNumber(counts.long) ?? 0))
    const short = Math.max(0, Math.round(toNumber(counts.short) ?? 0))
    return {
      rows,
      // 只有自己一行：窗口要在榜下面补一句「还没有邻居上线…行情照走」。
      hasPeers: rows.some((row) => !row.me),
      countText: rows.length + ' 人',
      sentiment: {
        long,
        short,
        // 全场一条仓位都没有 = 观望（SPEC：「没有仓位写观望」），不画「多 0 · 空 0」。
        text: long === 0 && short === 0 ? '观望' : '多 ' + long + ' · 空 ' + short,
        tone: long === 0 && short === 0 ? 'flat' : long >= short ? 'long' : 'short'
      },
      empty: emptyHints(safe).neighbors
    }
  }

  /** 窗口要的全部内容（`board.js` 只负责把它画成 DOM）。 */
  function boardView (payload, {
    now = Date.now(),
    side = 'long',
    margin = 50,
    leverage = 1,
    crop = null,
    limitOpen = false,
    targetText = '',
    allIn = false,
    width = CHART_WIDTH,
    height = CHART_HEIGHT
  } = {}) {
    const safe = payload !== null && typeof payload === 'object' ? payload : null
    const crops = cropsView(safe, crop)
    const selected = crops.find((entry) => entry.active)?.id ?? pickCrop(safe, crop)
    const order = orderView(safe, {
      side,
      margin,
      leverage,
      crop: selected,
      limitOpen,
      targetText,
      allIn
    })
    return {
      header: headerView(safe, now, selected),
      week: weekView(safe),
      hint: hintView(safe, selected),
      crops,
      chart: chartView(safe, { crop: selected, width, height }),
      order,
      orders: orderRows(safe, now),
      positions: positionCards(safe),
      history: historyRows(safe, now),
      league: leagueView(safe),
      hints: emptyHints(safe)
    }
  }

  return {
    CHART_WIDTH,
    CHART_HEIGHT,
    formatCoins,
    formatCountdown,
    formatPrice,
    formatSigned,
    formatTrim,
    reasonText,
    cropNameOf,
    stopLevels,
    stopLabel,
    nextStopLevel,
    weekView,
    hintView,
    headerView,
    chartGeometry,
    chartView,
    previewView,
    orderView,
    orderRows,
    positionCards,
    historyRows,
    leagueView,
    emptyHints,
    cropsView,
    boardView
  }
})
