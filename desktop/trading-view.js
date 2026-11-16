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
 *
 * 票 84 的周期切换同样只吃 payload：`payload.timeframes[period]` 已经是宿主算好的
 * 粗周期 K 线（1 时/1 日/1 周），窗口只负责选图、写时间标签（本地时区）与提示
 * 「合约仍按 15 分钟收盘结算」。周期清单来自 `limits.timeframes`——窗口不硬编码
 * 「15分/1时/1日/1周」，也不自己把粗周期的采样当成结算价。
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
  /**
   * 票 87：图占满窗口宽度（盘口窗固定 760×700，左右各留 8px 外框 + 12px 内边距），
   * 1 单位≈1px。`CHART_PADDING` 仍是纯价格映射的旧默认值（老测试/调用直接量 viewBox 时用它），
   * 轴与价格标签的留白由 `CHART_AXIS_PADDING` 在 `chartView` 里显式传入。
   */
  const BOARD_WIDTH = 760
  const BOARD_HEIGHT = 700
  const CHART_WIDTH = 720
  const CHART_HEIGHT = 280
  const CHART_PADDING = Object.freeze({ top: 8, right: 4, bottom: 6, left: 4 })
  /** 右侧价格轴 + 底部时间轴的留白；文字不套滤镜，所以轴标签不会被画出锯齿。 */
  const CHART_AXIS_PADDING = Object.freeze({ top: 14, right: 62, bottom: 26, left: 10 })
  /**
   * 手绘笔触：`feTurbulence` 出噪声、`feDisplacementMap` 把线条轻微推歪。
   * 种子/幅度固定（不随重画变化），所以同一张图每次截图都一样；文字不进这层滤镜。
   */
  const SKETCH = Object.freeze({
    filterId: 'sketch-ink',
    seed: 7,
    scale: 1.7,
    baseFrequency: '0.02 0.032',
    numOctaves: 2,
    lineCap: 'round'
  })
  /** 版面：图表独占一行，下面两列（左持仓/结算，右下单/周榜）。DOM 顺序仍按 Tab 顺序。 */
  const LAYOUT = Object.freeze({
    board: Object.freeze({ width: BOARD_WIDTH, height: BOARD_HEIGHT }),
    chart: Object.freeze({
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      fullWidth: true
    }),
    columns: Object.freeze({
      left: Object.freeze(['positions', 'history']),
      right: Object.freeze(['order', 'league'])
    })
  })
  /** 兜底白名单：宿主每一包都会带 `limits`，这里只在极端情况下（老宿主/坏包）用。 */
  const FALLBACK_LIMITS = Object.freeze({
    margins: Object.freeze([50, 100, 250]),
    leverages: Object.freeze([1]),
    crops: Object.freeze([{ id: 'tomato', name: '小番茄' }]),
    // 老宿主没有周期清单：只有 15 分一档（它的图就是 `payload.charts`）。
    timeframes: Object.freeze([Object.freeze({ id: '15m', label: '15分' })]),
    historyLimit: 50,
    // 老宿主没有「全下」，也没有目标价带；窗口就不画这两样（照样能开仓）。
    allIn: false,
    targetRatio: null
  })
  /**
   * 合约本身的周期 id（票 84）：入场/强平线、`第 m/15 分钟`、收盘倒计时都只属于它。
   * 其余周期是看趋势用的粗桶，结算口径不变。
   */
  const CONTRACT_TIMEFRAME = '15m'
  /** 切到别的周期时的那句提示（产品文案：结算仍只认 15 分钟收盘）。 */
  const SETTLE_NOTE_TEXT = '合约仍按 15 分钟收盘结算；其它周期只看趋势'
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
      // 票 84：周期页签的顺序与文案全由宿主下发（唯一来源在 `src/trading-rules.js`），
      // 窗口不硬编码「15分/1时/1日/1周」；坏包退回只有 15 分一档。
      timeframes: timeframeEntriesOf(limits.timeframes),
      historyLimit: Number.isInteger(limits.historyLimit) ? limits.historyLimit : FALLBACK_LIMITS.historyLimit,
      // 旧宿主没有这两个字段：不画「全下」、不显示目标价带（宿主照样会校验/拒绝）。
      allIn: limits.allIn === true,
      targetRatio: floor === null || ceil === null || floor <= 0 || ceil <= floor
        ? null
        : { floor, ceil }
    }
  }

  /** `limits.timeframes` 的形状夹取：`{id,label}`、id 不重复；没有就退回 15 分一档。 */
  function timeframeEntriesOf (raw) {
    if (!Array.isArray(raw)) return FALLBACK_LIMITS.timeframes
    const entries = []
    for (const candidate of raw) {
      if (candidate === null || typeof candidate !== 'object') continue
      if (typeof candidate.id !== 'string' || candidate.id === '') continue
      if (entries.some((entry) => entry.id === candidate.id)) continue
      entries.push({
        id: candidate.id,
        label: typeof candidate.label === 'string' && candidate.label !== ''
          ? candidate.label
          : candidate.id
      })
    }
    return entries.length > 0 ? entries : FALLBACK_LIMITS.timeframes
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

  /**
   * 某周期的 `{ crop: chart }` 块（票 84）：优先 `payload.timeframes[id]`；
   * 没有 `timeframes` 的旧包（票 81 的 payload）只有 15 分，就退回 `payload.charts`。
   * 认不出这个周期返回 null：页签画 disabled，切过去也是空态，不会白屏。
   */
  function timeframeChartsOf (payload, timeframe) {
    if (payload === null || typeof payload !== 'object') return null
    const timeframes = payload.timeframes
    if (timeframes !== null && typeof timeframes === 'object') {
      const block = timeframes[timeframe]
      if (block !== null && typeof block === 'object') return block
    }
    if (timeframe === CONTRACT_TIMEFRAME) {
      const charts = payload.charts
      if (charts !== null && typeof charts === 'object') return charts
    }
    return null
  }

  /** 选中的周期：白名单里有、且宿主真的发了这个周期的图；否则退回第一个有图的周期。 */
  function pickTimeframe (payload, timeframe) {
    const entries = limitsOf(payload).timeframes
    if (typeof timeframe === 'string' && entries.some((entry) => entry.id === timeframe) &&
      timeframeChartsOf(payload, timeframe) !== null) {
      return timeframe
    }
    const available = entries.find((entry) => timeframeChartsOf(payload, entry.id) !== null)
    return available?.id ?? entries[0]?.id ?? CONTRACT_TIMEFRAME
  }

  function chartOf (payload, crop, timeframe = CONTRACT_TIMEFRAME) {
    const charts = timeframeChartsOf(payload, timeframe)
    if (charts === null) return null
    const chart = charts[crop]
    return chart !== null && typeof chart === 'object' ? chart : null
  }

  /** 周期页签：`active` = 当前这一档；`disabled` = 宿主根本没发这个周期的图（旧包只有 15 分）。 */
  function timeframesView (payload, timeframe) {
    const selected = pickTimeframe(payload, timeframe)
    return limitsOf(payload).timeframes.map((entry) => ({
      id: entry.id,
      label: entry.label,
      active: entry.id === selected,
      disabled: timeframeChartsOf(payload, entry.id) === null
    }))
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

  /** 当前这一根是「形成中」的 K 线：有开高低和现价（没有 close，收盘价要等结算）。 */
  function isFormingBarLike (current) {
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
    const current = isFormingBarLike(chart.current) ? chart.current : null
    const base = toNumber(chart.base)
    if (bars.length === 0 && current === null) return null
    const width = Math.max(80, toNumber(options.width) ?? CHART_WIDTH)
    const height = Math.max(60, toNumber(options.height) ?? CHART_HEIGHT)
    const timeframe = typeof options.timeframe === 'string' ? options.timeframe : CONTRACT_TIMEFRAME
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
    const slotWidth = plot.width / Math.max(1, total)
    const toBody = (open, close, slot, index) => {
      const bodyWidth = Math.max(2, Math.min(14, slotWidth * 0.62))
      const centerX = plot.left + slotWidth * (index + 0.5)
      const openY = yOf(open)
      const closeY = yOf(close)
      return {
        index,
        slot,
        open,
        close,
        centerX,
        x: centerX - bodyWidth / 2,
        width: bodyWidth,
        bodyTop: Math.min(openY, closeY),
        bodyHeight: Math.max(1, Math.abs(closeY - openY)),
        up: close >= open,
        // 票 87：每根蜡烛的墨水参数（粗细/圆角/倾斜）都由确定性哈希给出。
        sketch: candleSketchOf(index, slot)
      }
    }
    const scaled = bars.map((bar, index) => {
      const body = toBody(bar.open, bar.close, bar.slot, index)
      return {
        ...body,
        start: toNumber(bar.start),
        end: toNumber(bar.end),
        high: bar.high,
        low: bar.low,
        wickTop: yOf(bar.high),
        wickBottom: yOf(bar.low)
      }
    })
    const forming = current === null
      ? null
      : {
          ...toBody(current.open, current.price, current.slot, bars.length),
          start: toNumber(current.start),
          end: toNumber(current.end),
          high: current.high,
          low: current.low,
          wickTop: yOf(current.high),
          wickBottom: yOf(current.low),
          price: current.price,
          tick: toNumber(current.tick) ?? 0
        }
    const lineLabels = { base: '底价', entry: '入场', liquidation: '强平' }
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
        label: lineLabels[line.key],
        text: formatPrice(line.value),
        y: visible ? y : null,
        visible
      }
    })
    const geometry = {
      width,
      height,
      plot,
      domain: { min, max },
      timeframe,
      slotWidth,
      bars: scaled,
      forming,
      lines,
      priceLine: current === null ? null : { value: current.price, y: yOf(current.price) },
      grid: [plot.top, plot.top + plot.height / 2, plot.top + plot.height],
      sketch: {
        ...SKETCH,
        // 让 DOM 只引用一次 `url(#sketch-ink)`：滤镜只套在网格/参考线/蜡烛这一层。
        filter: 'url(#' + SKETCH.filterId + ')'
      }
    }
    geometry.axes = chartAxes(geometry, timeframe)
    geometry.priceTicks = geometry.axes.price
    geometry.timeTicks = geometry.axes.time
    geometry.priceTag = priceTagOf(geometry)
    return geometry
  }

  /**
   * 参考线（底价/入场/强平）与图例：没有持仓时入场/强平显示「—」。
   * 票 84：`withPosition:false`（非 15 分周期）时入场/强平一律不画也不给数——
   * 仓位只活一根，粗周期图上的那条线没有意义；图例照旧写「—」。
   */
  function chartReferences (payload, crop, { withPosition = true, timeframe = CONTRACT_TIMEFRAME } = {}) {
    const positions = withPosition && payload !== null && typeof payload === 'object' &&
      Array.isArray(payload.positions)
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
        {
          key: 'base',
          label: '底价',
          text: formatPrice(chartBaseOf(payload, crop, timeframe)),
          tone: 'base'
        },
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

  function chartBaseOf (payload, crop, timeframe = CONTRACT_TIMEFRAME) {
    const chart = chartOf(payload, crop, timeframe)
    return chart === null ? null : toNumber(chart.base)
  }

  function pad2 (value) {
    return String(value).padStart(2, '0')
  }

  /** 本地 `HH:MM`：用 Date 的本地字段，不用 toLocaleString（它跟系统语言，测试会飘）。 */
  function formatClock (ms) {
    const date = new Date(ms)
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  }

  /** 本地 `M月D日`。 */
  function formatMonthDay (ms) {
    const date = new Date(ms)
    return (date.getMonth() + 1) + '月' + date.getDate() + '日'
  }

  /**
   * 一根的时间标签（票 84）：15 分/1 时是「起–止」，1 日是自然日，1 周是「周一起–周日」。
   * 全部由宿主给的 `start`/`end` 毫秒按**本地时区**格式化，替掉原来那个
   * `第 1994249 根`——那是自 1970 起的 slot 序号，只有确定性行情的内部实现认得。
   * 老宿主没有 `start`/`end` 时画「—」，不再退回绝对根号。
   */
  function timeLabelOf (timeframe, start, end) {
    const startMs = toNumber(start)
    if (startMs === null) return '—'
    const endMs = toNumber(end)
    if (timeframe === '1d') return formatMonthDay(startMs)
    if (timeframe === '1w') {
      // 周桶的 end 是下周一 00:00：减 1 毫秒才是这一周的周日。
      return formatMonthDay(startMs) + '–' + formatMonthDay((endMs ?? startMs) - 1)
    }
    if (endMs === null) return formatClock(startMs)
    return formatClock(startMs) + '–' + formatClock(endMs)
  }

  /**
   * 时间轴的刻度文案（票 87）：比便签/标题更短，3–5 个才排得下。
   * 15 分写「11:30–11:45」（一根的完整区间，和工单示例一致）；1 时只写起点
   * 「14:00」；1 日/1 周写「11月16日」。四档都不是绝对根号，换时区也不会漂。
   */
  function timeTickLabelOf (timeframe, start, end) {
    const startMs = toNumber(start)
    if (startMs === null) return '—'
    if (timeframe === '1h') return formatClock(startMs)
    if (timeframe === '1d' || timeframe === '1w') return formatMonthDay(startMs)
    return timeLabelOf(timeframe, start, end)
  }

  /**
   * 手绘用的确定性抖动量（票 87）：只吃根序号/slot，不读随机数、不读时钟。
   * 这样同一张图每次重画/截图都完全一样，Node 测试也能断言「笔触有变化但可复现」。
   * 用 Math.imul 做 32 位乘法，避免大数在 JS 里丢精度。
   */
  function sketchHashOf (index, slot) {
    let hash = Math.imul(index + 1, 0x9e3779b1)
    if (Number.isFinite(slot)) hash = Math.imul(hash ^ (Math.floor(slot) & 0xffff), 0x85ebca6b)
    hash ^= hash >>> 13
    hash = Math.imul(hash, 0xc2b2ae35)
    hash ^= hash >>> 16
    return hash >>> 0
  }

  /** 一根蜡烛的「墨水参数」：影线粗细、实体圆角、轻微倾斜。范围写死在测试里。 */
  function candleSketchOf (index, slot) {
    const hash = sketchHashOf(index, slot)
    return {
      // 1.3–1.9px：同一张图里有粗有细，像不同力度落笔，但不至于断线。
      wickWidth: Number((1.3 + (hash % 7) * 0.1).toFixed(2)),
      // 2–3px 圆角：卡通手绘的实体不是直角方块。
      bodyRadius: 2 + (hash % 2),
      // ±0.6°：只歪一点点，横排看仍是一条时间轴。
      tilt: Number(((((hash >>> 3) % 9) - 4) * 0.15).toFixed(2)),
      bodyStrokeWidth: Number((0.7 + ((hash >>> 5) % 3) * 0.15).toFixed(2))
    }
  }

  /**
   * 价格轴（票 87）：4–5 档，包含最高/最低（y 与 plot 顶/底重合）。
   * 文案统一走 `formatPrice`，与图例、持仓卡的数字口径一致。
   */
  function priceTicksOf (plot, domain) {
    const count = plot.height >= 240 ? 5 : 4
    const ticks = []
    for (let index = 0; index < count; index += 1) {
      const ratio = index / (count - 1)
      const value = domain.max - (domain.max - domain.min) * ratio
      ticks.push({
        value,
        y: plot.top + plot.height * ratio,
        text: formatPrice(value)
      })
    }
    return ticks
  }

  /**
   * 时间轴（票 87）：从有 `start` 的蜡烛里等距挑 3–5 根，取实体中心 x。
   * 老宿主没有 start/end 时整条轴留空（不画「—」占位）——图还能看，只是没有时间刻度。
   */
  function timeTicksOf (plot, candles, timeframe) {
    const timed = candles.filter((candle) => toNumber(candle.start) !== null)
    if (timed.length === 0) return []
    const desired = plot.width >= 560 ? 5 : 4
    const count = Math.min(desired, timed.length)
    if (count <= 0) return []
    const ticks = []
    for (let index = 0; index < count; index += 1) {
      const position = count === 1
        ? 0
        : Math.round((index * (timed.length - 1)) / (count - 1))
      const candle = timed[position]
      const x = candle.centerX
      if (ticks.some((tick) => Math.abs(tick.x - x) < 1)) continue
      ticks.push({
        x,
        text: timeTickLabelOf(timeframe, candle.start, candle.end),
        index: candle.index,
        // 首尾刻度贴边：DOM 用 text-anchor 让标签留在画布内。
        anchor: index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle'
      })
    }
    return ticks
  }

  /** 轴刻度的公开入口：DOM 只读，不在窗口里重算价格/时间格式。 */
  function chartAxes (geometry, timeframe = CONTRACT_TIMEFRAME) {
    if (geometry === null || typeof geometry !== 'object') return { price: [], time: [] }
    const candles = geometry.forming === null ? geometry.bars : geometry.bars.concat([geometry.forming])
    return {
      price: priceTicksOf(geometry.plot, geometry.domain),
      time: timeTicksOf(geometry.plot, candles, timeframe)
    }
  }

  /**
   * 现价胶囊（票 87）：贴在右侧价格轴里，跟随**最后一根**的收盘/现价。
   * 画在轴槽里，不压 K 线；引线从最后一根实体指向胶囊，像贴纸被人用笔连过去。
   * 轴槽只有 62px 宽，胶囊宽度按 `formatPrice` 的实际字符数收窄/放宽。
   */
  function priceTagOf (geometry) {
    if (geometry === null || typeof geometry !== 'object') return null
    const candles = geometry.forming === null ? geometry.bars : geometry.bars.concat([geometry.forming])
    const last = candles[candles.length - 1]
    if (last === undefined) return null
    const value = geometry.forming === null ? last.close : geometry.forming.price
    if (!Number.isFinite(value)) return null
    const span = geometry.domain.max - geometry.domain.min
    const y = span <= 0
      ? geometry.plot.top + geometry.plot.height / 2
      : geometry.plot.top + ((geometry.domain.max - value) / span) * geometry.plot.height
    const text = formatPrice(value)
    const width = Math.max(42, text.length * 6.2 + 14)
    const height = 19
    const left = Math.min(
      geometry.width - width - 3,
      geometry.plot.left + geometry.plot.width + 5
    )
    const top = Math.max(
      geometry.plot.top,
      Math.min(geometry.plot.top + geometry.plot.height - height, y - height / 2)
    )
    return {
      value,
      text,
      tone: last.up ? 'up' : 'down',
      x: left,
      y: top,
      width,
      height,
      centerY: top + height / 2,
      // 引线从左端出发，落到最后一根实体/影线的中段（看起来像手画的指引）。
      leader: {
        x1: last.centerX,
        y1: Math.max(last.wickTop, Math.min(last.wickBottom, y)),
        x2: left,
        y2: top + height / 2
      }
    }
  }

  function clampNumber (value, min, max) {
    return Math.max(min, Math.min(max, value))
  }

  /**
   * 十字线（票 87）：x 吸附最近一根蜡烛；y 跟指针但夹在绘图区里。
   * 返回便签的全部内容（时间 + 开/高/低/收）与已经夹进 plot 的坐标，
   * 窗口只按这些字段画线/画卡，不再做命中或排版计算。
   */
  function crosshairAt (geometry, x, y = null) {
    if (geometry === null || typeof geometry !== 'object') return null
    const pointerX = toNumber(x)
    if (pointerX === null) return null
    const plot = geometry.plot
    if (pointerX < plot.left || pointerX > plot.left + plot.width) return null
    const candles = geometry.forming === null ? geometry.bars : geometry.bars.concat([geometry.forming])
    if (candles.length === 0) return null
    let nearest = candles[0]
    let nearestIndex = 0
    for (let index = 1; index < candles.length; index += 1) {
      if (Math.abs(candles[index].centerX - pointerX) < Math.abs(nearest.centerX - pointerX)) {
        nearest = candles[index]
        nearestIndex = index
      }
    }
    const pointerY = toNumber(y)
    const crosshairY = pointerY === null
      ? clampNumber(nearest.bodyTop + nearest.bodyHeight / 2, plot.top, plot.top + plot.height)
      : clampNumber(pointerY, plot.top, plot.top + plot.height)
    const forming = geometry.forming !== null && nearestIndex === candles.length - 1
    const close = forming ? geometry.forming.price : nearest.close
    const values = {
      open: nearest.open,
      high: nearest.high,
      low: nearest.low,
      close
    }
    const timeText = timeLabelOf(geometry.timeframe, nearest.start, nearest.end)
    const rows = [
      { key: 'open', label: '开', text: formatPrice(values.open) },
      { key: 'high', label: '高', text: formatPrice(values.high) },
      { key: 'low', label: '低', text: formatPrice(values.low) },
      { key: 'close', label: '收', text: formatPrice(values.close) }
    ]
    const text = timeText + ' 开 ' + formatPrice(values.open) + ' 高 ' + formatPrice(values.high) +
      ' 低 ' + formatPrice(values.low) + ' 收 ' + formatPrice(values.close)
    const cardWidth = Math.min(188, Math.max(96, plot.width - 8))
    const cardHeight = Math.min(66, Math.max(40, plot.height - 8))
    // 便签放指针右上方；靠右就翻到左边，靠上就翻到下面，最后再整体夹进绘图区。
    let left = nearest.centerX + 12
    if (left + cardWidth > plot.left + plot.width - 4) left = nearest.centerX - cardWidth - 12
    left = clampNumber(left, plot.left + 4, plot.left + plot.width - cardWidth - 4)
    let top = crosshairY - cardHeight - 10
    if (top < plot.top + 4) top = crosshairY + 12
    top = clampNumber(top, plot.top + 4, plot.top + plot.height - cardHeight - 4)
    return {
      index: nearestIndex,
      slot: nearest.slot,
      forming,
      x: nearest.centerX,
      y: crosshairY,
      candle: nearest,
      timeText,
      title: timeText + (forming ? ' · 进行中' : ''),
      rows,
      text,
      card: {
        left,
        top,
        width: cardWidth,
        height: cardHeight,
        timeText,
        rows,
        text
      },
      highlight: {
        x: nearest.x - 2,
        y: nearest.wickTop - 2,
        width: nearest.width + 4,
        height: Math.max(4, nearest.wickBottom - nearest.wickTop + 4)
      }
    }
  }

  /**
   * 一张图的全部内容：作物/周期页签、价格、图例、时间标签与几何。
   * `hasChart:false` 时 `geometry:null` + 一句空态（老宿主/坏包不会白屏）。
   *
   * 票 84：`timeframe` 选周期，没传就是合约的 15 分；没有 `payload.timeframes`
   * 的旧包退回 `charts`（15 分）。入场/强平参考线只在 15 分画，其余周期只画底价线，
   * 并给一句「合约仍按 15 分钟收盘结算」的提示——看图和结算是两件事。
   */
  function chartView (payload, {
    crop = null,
    timeframe = CONTRACT_TIMEFRAME,
    width = CHART_WIDTH,
    height = CHART_HEIGHT
  } = {}) {
    const selected = pickCrop(payload, crop)
    const period = pickTimeframe(payload, timeframe)
    const onContractBar = period === CONTRACT_TIMEFRAME
    const label = limitsOf(payload).timeframes.find((entry) => entry.id === period)?.label ?? period
    const chart = chartOf(payload, selected, period)
    const current = chart !== null && isFormingBarLike(chart.current) ? chart.current : null
    const references = chartReferences(payload, selected, {
      withPosition: onContractBar,
      timeframe: period
    })
    const tick = onContractBar && current !== null ? toNumber(current.tick) : null
    const geometry = chart === null
      ? null
      : chartGeometry(chart, {
        width,
        height,
        // 轴/价格胶囊的留白只属于窗口版式；直接调 chartGeometry 的纯映射保持旧默认。
        padding: CHART_AXIS_PADDING,
        timeframe: period,
        entry: references.entry,
        liquidation: references.liquidation
      })
    const minute = tick === null ? null : Math.min(15, Math.floor(tick) + 1)
    const timeText = current === null ? '—' : timeLabelOf(period, current.start, current.end)
    // 老宿主没有 start/end 时时间标签是「—」：宁可不写，也别拼出「— · 第 6/15 分钟」。
    const parts = []
    if (timeText !== '—') parts.push(timeText)
    if (minute !== null) parts.push('第 ' + minute + '/15 分钟')
    return {
      crop: selected,
      cropName: cropNameOf(payload, selected),
      timeframe: period,
      timeframeLabel: label,
      timeframes: timeframesView(payload, period),
      hasChart: geometry !== null,
      emptyText: '行情还在算，稍等一下。K 线一分钟才动一格。',
      base: chartBaseOf(payload, selected, period),
      baseText: formatPrice(chartBaseOf(payload, selected, period)),
      priceText: formatPrice(current === null ? null : current.price),
      highText: formatPrice(current === null ? null : current.high),
      lowText: formatPrice(current === null ? null : current.low),
      slot: current === null ? null : toNumber(current.slot),
      // 15 分才带「第 m/15 分钟」：粗周期没有「本根第几分钟」这件事。
      slotText: parts.length === 0 ? '—' : parts.join(' · '),
      settleNote: {
        text: SETTLE_NOTE_TEXT,
        visible: !onContractBar
      },
      ariaLabel: label + ' K 线：' + (onContractBar ? '底价、入场、强平参考线' : '只画底价线，看趋势') +
        '；右侧价格轴、底部时间轴，悬停看每根 OHLC',
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
    const price = chart !== null && isFormingBarLike(chart.current)
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
      const chips = []
      for (const position of Array.isArray(entry.positions) ? entry.positions : []) {
        if (position === null || typeof position !== 'object') continue
        const positionSide = position.side === 'long'
          ? 'long'
          : position.side === 'short' ? 'short' : null
        if (positionSide === null) continue
        if (positionSide === 'long') long += 1
        else short += 1
        // US19：邻居的「当前持仓」不能只有一个计数；作物 + 多/空 + 杠杆一眼能读。
        // 作物名来自 payload.limits.crops；杠杆坏了按 1× 兜底，不画 NaN。
        const positionLeverage = Math.max(1, Math.round(toNumber(position.leverage) ?? 1))
        chips.push({
          text: cropNameOf(safe, position.crop) + (positionSide === 'long' ? '多' : '空') +
            ' ' + positionLeverage + '×',
          tone: positionSide
        })
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
        positionsText: long === 0 && short === 0 ? '观望' : '多 ' + long + ' · 空 ' + short,
        // US19：一屏最多画 3 条持仓；多出来的写「+N」，摘要仍保留完整计数。
        chips: chips.slice(0, 3),
        chipOverflowText: chips.length > 3 ? '+' + (chips.length - 3) : ''
      })
    }
    const counts = league.sentiment !== null && typeof league.sentiment === 'object'
      ? league.sentiment
      : {}
    const long = Math.max(0, Math.round(toNumber(counts.long) ?? 0))
    const short = Math.max(0, Math.round(toNumber(counts.short) ?? 0))
    // 旧版本邻居（评审 P1）：宿主说「有人在线、但一条周报都没发」时，空态要明说
    // 「旧版本」——「还没有邻居上线」会让人以为是自己网络坏了。
    const watchersRaw = league.watchers !== null && typeof league.watchers === 'object'
      ? league.watchers
      : {}
    const countOf = (value) => Math.max(0, Math.round(toNumber(value) ?? 0))
    const watchers = {
      online: countOf(watchersRaw.online),
      reported: countOf(watchersRaw.reported)
    }
    const oldVersion = watchers.online > 0 && watchers.reported === 0
    return {
      rows,
      // 只有自己一行：窗口要在榜下面补一句「还没有邻居上线…行情照走」。
      hasPeers: rows.some((row) => !row.me),
      countText: rows.length + ' 人',
      watchers,
      sentiment: {
        long,
        short,
        // 全场一条仓位都没有 = 观望（SPEC：「没有仓位写观望」），不画「多 0 · 空 0」。
        text: long === 0 && short === 0 ? '观望' : '多 ' + long + ' · 空 ' + short,
        tone: long === 0 && short === 0 ? 'flat' : long >= short ? 'long' : 'short'
      },
      empty: oldVersion
        ? '邻居是旧版本，还没有周报'
        : emptyHints(safe).neighbors
    }
  }

  /**
   * Tab 顺序（票 81 / 评审 P2）：返回窗口控件的逻辑顺序，`board.js` 按它写 tabindex。
   *
   * 顺序 = DOM 顺序（行为不变）：×（顶栏）→ 作物页签 → 周期页签 → 方向 → 保证金
   * （预设 + 全下）→ 杠杆 → 到价开关 → 目标价 → 挂单 → 开一手 → 挂单卡的撤单 →
   * 持仓卡的止损/平仓。
   * 每项都是 `board.js` 的 `focusKeyOf` 能认出的键，且**不重复**（tabindex 只能给一个元素）。
   * 纯函数：不碰 DOM，测试能直接断言；老/坏 payload 退回兜底白名单，不抛。
   */
  function focusOrder (payload) {
    const limits = limitsOf(payload)
    const order = ['close-button']
    for (const crop of limits.crops) {
      if (crop !== null && typeof crop === 'object' && typeof crop.id === 'string') {
        order.push('crop:' + crop.id)
      }
    }
    // 票 84：周期页签紧跟在作物页签后面（DOM 里也是这样），键盘能直接切周期。
    for (const timeframe of limits.timeframes) order.push('timeframe:' + timeframe.id)
    for (const side of Object.keys(SIDE_LABELS)) order.push('side:' + side)
    for (const margin of limits.margins) order.push('margin:' + margin)
    // 「全下」按钮的金额每包变，用语义键 `margin:all-in`（focusKeyOf 认 data-all-in）。
    if (limits.allIn) order.push('margin:all-in')
    for (const leverage of limits.leverages) order.push('leverage:' + leverage)
    order.push('limit-toggle', 'limit-input', 'limit-place', 'submit')
    const orders = payload !== null && typeof payload === 'object' && Array.isArray(payload.orders)
      ? payload.orders
      : []
    for (const entry of orders) {
      if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '') {
        order.push('cancel:' + entry.id)
      }
    }
    const positions = payload !== null && typeof payload === 'object' && Array.isArray(payload.positions)
      ? payload.positions
      : []
    for (const position of positions) {
      if (position === null || typeof position !== 'object') continue
      if (typeof position.id !== 'string' || position.id === '') continue
      order.push('stop:' + position.id, 'close:' + position.id)
    }
    return order
  }

  /**
   * 列表头（评审 P1）：`持仓 240 · 显示最近 200`。
   * `shown` 是窗口真正收到的条数（宿主按最新在前下发，上限在 `desktop/shared.js`），
   * 合计来自 payload 的 `positionsTotal`/`ordersTotal`。这样截断时玩家知道还有更早的，
   * 而不是以为账本里只有画出来的这些。老宿主没有 total 时退回 `shown`，不编数。
   */
  function listMetaText (label, shown, total) {
    const count = Math.max(shown, Math.round(toNumber(total) ?? shown))
    return count > shown ? label + ' ' + count + ' · 显示最近 ' + shown : label + ' ' + count
  }

  /** 窗口要的全部内容（`board.js` 只负责把它画成 DOM）。 */
  function boardView (payload, {
    now = Date.now(),
    side = 'long',
    margin = 50,
    leverage = 1,
    crop = null,
    timeframe = CONTRACT_TIMEFRAME,
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
    const orders = orderRows(safe, now)
    const positions = positionCards(safe)
    return {
      header: headerView(safe, now, selected),
      week: weekView(safe),
      hint: hintView(safe, selected),
      crops,
      chart: chartView(safe, { crop: selected, timeframe, width, height }),
      order,
      orders,
      ordersMetaText: listMetaText('挂单', orders.length, safe === null ? null : safe.ordersTotal),
      positions,
      positionsMetaText: listMetaText('持仓', positions.length, safe === null ? null : safe.positionsTotal),
      history: historyRows(safe, now),
      league: leagueView(safe),
      hints: emptyHints(safe)
    }
  }

  return {
    BOARD_WIDTH,
    BOARD_HEIGHT,
    CHART_WIDTH,
    CHART_HEIGHT,
    CHART_PADDING,
    CHART_AXIS_PADDING,
    LAYOUT,
    SKETCH,
    formatCoins,
    formatCountdown,
    formatPrice,
    formatSigned,
    formatTrim,
    reasonText,
    cropNameOf,
    timeLabelOf,
    timeTickLabelOf,
    stopLevels,
    stopLabel,
    nextStopLevel,
    weekView,
    hintView,
    headerView,
    chartGeometry,
    chartAxes,
    priceTagOf,
    crosshairAt,
    candleSketchOf,
    chartView,
    previewView,
    orderView,
    focusOrder,
    orderRows,
    positionCards,
    historyRows,
    leagueView,
    emptyHints,
    cropsView,
    boardView
  }
})
