/**
 * 盘口小窗的纯视图模型（票 79 / 票 81 / 票 82 / 票 83 / 票 89）。
 *
 * 这层只做「宿主推来的盘口 view → 标题/K 线几何/作物条/下单区/到价挂单/持仓卡/历史/真人周榜/空态」的
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
   * 票 89：版面重做后图是「作物条下面的一条横带」。窗口 760×700、纸卡贴边（2px 墨线），
   * 图占满整宽（viewBox 720 宽）；图高按 760×700 下留出两列列表的余量定，
   * 轴/字/十字线仍是票 87 那一套。`BOARD_WIDTH/BOARD_HEIGHT` 是窗口尺寸，不是图。
   */
  const BOARD_WIDTH = 760
  const BOARD_HEIGHT = 700
  const CHART_WIDTH = 720
  /** 票 106：图高从 228 让 16px 给快讯条；卡片总高 268 不变。 */
  const CHART_HEIGHT = 212
  const CHART_PADDING = Object.freeze({ top: 8, right: 4, bottom: 6, left: 4 })
  /** 右侧价格轴 + 底部时间轴的留白；文字不套滤镜，所以轴标签不会被画出锯齿。 */
  const CHART_AXIS_PADDING = Object.freeze({ top: 14, right: 62, bottom: 26, left: 10 })
  /**
   * 票 91 的固定版面（760×700，页面不滚）：
   *   顶栏 50 → 作物条 40 → 图卡 268（图头 + 手绘图）→ 下单横条 104 → 底部剩余（760×700 下 196）。
   * 下半区两列：左 minmax(0,1fr) = 持仓（滚）+ 最近结算 88（滚）；右 300 = 真人周榜（滚）。
   * 下单从 300px 的窄列里搬出来，成为图下的整宽横条——拥挤感就是这么消掉的。
   * 这些数字是窗口 CSS 与测试共用的唯一来源；改版面时两边一起改。
   */
  const HEADER_HEIGHT = 50
  const CROP_STRIP_HEIGHT = 40
  const CHART_CARD_HEIGHT = 268
  /** 图头下的快讯条高度；窗口 CSS 与测试共用。 */
  const TICKER_HEIGHT = 16
  const LEAGUE_COLUMN_WIDTH = 300
  /** 下单横条：整宽，两行（方向/保证金/杠杆/主按钮 + 预览/到价/短提示），不滚不裁。 */
  const ORDER_BAR_HEIGHT = 104
  const ORDER_BAR_CONTROL_HEIGHT = 32
  const ORDER_BAR_SUBMIT_WIDTH = 132
  const ORDER_BAR_SUBMIT_HEIGHT = 36
  const ORDER_BAR_GAP = 10
  const HISTORY_HEIGHT = 88
  /**
   * 作物条一屏大概放得下 6 颗 chip（718px 宽减去左右箭头与 4 档周期）。
   * 只是「初始窗口」的估算：真实滚动位置由 DOM 量出来，纯视图用它算箭头初始禁用态。
   */
  const CROP_STRIP_VISIBLE = 6
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
  /** 版面：图卡独占一行，图下是整宽下单横条，再下面两列（左持仓/结算，右周榜）。 */
  const LAYOUT = Object.freeze({
    board: Object.freeze({ width: BOARD_WIDTH, height: BOARD_HEIGHT }),
    headerHeight: HEADER_HEIGHT,
    cropStripHeight: CROP_STRIP_HEIGHT,
    chartCardHeight: CHART_CARD_HEIGHT,
    tickerHeight: TICKER_HEIGHT,
    orderBarHeight: ORDER_BAR_HEIGHT,
    chart: Object.freeze({
      width: CHART_WIDTH,
      height: CHART_HEIGHT,
      fullWidth: true
    }),
    columns: Object.freeze({
      left: Object.freeze(['positions', 'history']),
      right: Object.freeze(['league'])
    }),
    // 下单横条的几何契约：窗口 CSS 按这些数排，测试盯着它们别把控件挤回 300px 宽。
    orderBar: Object.freeze({
      height: ORDER_BAR_HEIGHT,
      controlHeight: ORDER_BAR_CONTROL_HEIGHT,
      submitWidth: ORDER_BAR_SUBMIT_WIDTH,
      submitHeight: ORDER_BAR_SUBMIT_HEIGHT,
      gap: ORDER_BAR_GAP,
      rows: 2,
      marginColumns: 4,
      leverageColumns: 3
    }),
    bottom: Object.freeze({
      // 右列只剩周榜，宽度仍是 300（真人周榜的盈亏/收益率按它排）。
      rightWidth: LEAGUE_COLUMN_WIDTH,
      historyHeight: HISTORY_HEIGHT
    })
  })
  /**
   * 票 91：显示偏好（图表类型 / 配色）只活在本机窗口里，宿主完全不知道。
   * 存储键固定成 `dsh-zoo-board-prefs`，读写失败一律静默退默认——file:// 页面在
   * 某些策略下 localStorage 会直接抛，盘口不能因为存不了偏好就打不开。
   */
  const DISPLAY_STORAGE_KEY = 'dsh-zoo-board-prefs'
  const CHART_TYPES = Object.freeze(['candle', 'line'])
  const THEMES = Object.freeze(['color', 'mono'])
  const DISPLAY_DEFAULTS = Object.freeze({ chartType: 'candle', theme: 'color' })
  const CHART_TYPE_LABELS = Object.freeze({ candle: '蜡烛', line: '折线' })
  const THEME_LABELS = Object.freeze({ color: '彩色', mono: '黑白' })
  /** 折线面积填充的不透明度（12%）：看得出趋势，又不抢走坐标轴/参考线的注意力。 */
  const LINE_AREA_OPACITY = 0.12
  /** 快捷键只吃字母键：输入框聚焦时窗口不拦（board.js 判断焦点）。 */
  const DISPLAY_SHORTCUTS = Object.freeze({ chartType: 'l', theme: 'm' })
  /** 黑白模式下给数字补的方向记号：去掉颜色以后，▲▼ 是第二眼就能读的信号。 */
  const MONO_MARKS = Object.freeze({ up: '▲', down: '▼', flat: '' })
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
  /** 切到别的周期时的那句提示（票 89 瘦身成最短口径：结算仍只认 15 分钟收盘）。 */
  const SETTLE_NOTE_TEXT = '15 分钟结算'
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

  /**
   * 产品文案里的负数用 U+2212（`−`），不用 ASCII 连字符（票 89）。
   * 只给「句子里的数字」用（周盈亏胶囊/收益率）；持仓/榜单的裸数字仍走 `formatSigned`，
   * 这样表格里正负号宽度一致，也不影响既有断言。
   */
  function formatSignedMinus (value, digits = 1) {
    const text = formatSigned(value, digits)
    return text.startsWith('-') ? MINUS + text.slice(1) : text
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

  // ---------------------------------------------------------------------------
  // 票 91：显示偏好（蜡烛/折线、彩色/黑白）——纯函数，存储由调用方注入
  // ---------------------------------------------------------------------------

  /**
   * 把任意来源（localStorage / 调用参数）夹成合法偏好。
   * 认不出的值一律退回默认（蜡烛 + 彩色），不把坏偏好带进渲染；
   * 返回新对象，调用方可以安全地写回存储。
   */
  function displayPrefs (raw) {
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    return {
      chartType: CHART_TYPES.includes(source.chartType)
        ? source.chartType
        : DISPLAY_DEFAULTS.chartType,
      theme: THEMES.includes(source.theme) ? source.theme : DISPLAY_DEFAULTS.theme
    }
  }

  /**
   * 从注入的 storage 读偏好（Node 测试塞假 storage，窗口传 localStorage）：
   * 没有、坏 JSON、getItem 抛错都静默退默认——偏好不值得让盘口打不开。
   */
  function readDisplayPrefs (storage) {
    if (storage === null || typeof storage !== 'object' || typeof storage.getItem !== 'function') {
      return { ...DISPLAY_DEFAULTS }
    }
    try {
      const raw = storage.getItem(DISPLAY_STORAGE_KEY)
      if (typeof raw !== 'string' || raw === '') return { ...DISPLAY_DEFAULTS }
      return displayPrefs(JSON.parse(raw))
    } catch {
      return { ...DISPLAY_DEFAULTS }
    }
  }

  /** 写偏好：只写两个白名单键；存不了（隐私模式/配额满）就返回 false，不抛。 */
  function writeDisplayPrefs (storage, prefs) {
    if (storage === null || typeof storage !== 'object' || typeof storage.setItem !== 'function') {
      return false
    }
    try {
      storage.setItem(DISPLAY_STORAGE_KEY, JSON.stringify(displayPrefs(prefs)))
      return true
    } catch {
      return false
    }
  }

  /** 快捷键 `L` / 菜单点「折线」：在两种图表之间来回，返回新偏好（不改入参）。 */
  function toggleChartType (prefs) {
    const current = displayPrefs(prefs)
    return {
      ...current,
      chartType: current.chartType === 'candle' ? 'line' : 'candle'
    }
  }

  /** 快捷键 `M` / 菜单点「黑白」：在彩色与黑白之间来回，返回新偏好（不改入参）。 */
  function toggleTheme (prefs) {
    const current = displayPrefs(prefs)
    return {
      ...current,
      theme: current.theme === 'color' ? 'mono' : 'color'
    }
  }

  /**
   * 显示偏好的渲染视图：`board.js` 只照着设属性、画按钮，不在渲染端判断。
   * `body` 为空对象 = 彩色；黑白时是 `{'data-mono':'1'}`（窗口把它落到 body 属性上）。
   */
  function displayView (prefs) {
    const normalized = displayPrefs(prefs)
    const mono = normalized.theme === 'mono'
    const line = normalized.chartType === 'line'
    return {
      ...normalized,
      mono,
      line,
      body: mono ? { 'data-mono': '1' } : {},
      labels: {
        toggle: '显示',
        chartType: CHART_TYPE_LABELS[normalized.chartType],
        theme: THEME_LABELS[normalized.theme],
        chartGroup: '图表',
        themeGroup: '配色'
      },
      // 弹层里的两组分段控件：文案/顺序/选中态都由纯视图给，DOM 只负责画。
      chartOptions: CHART_TYPES.map((id) => ({
        id,
        label: CHART_TYPE_LABELS[id],
        active: id === normalized.chartType
      })),
      themeOptions: THEMES.map((id) => ({
        id,
        label: THEME_LABELS[id],
        active: id === normalized.theme
      }))
    }
  }

  /** 黑白模式下给盈亏数字补 ▲/▼；彩色模式原样返回（第二眼才需要记号）。 */
  function monoNumber (text, tone) {
    const mark = MONO_MARKS[tone] ?? ''
    return mark === '' ? text : mark + ' ' + text
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

  /** 选中的作物：显式选择 > 推包里带图的那一种 > 白名单里第一张有图的 > 第一个作物。 */
  function pickCrop (payload, crop) {
    const ids = cropIdsOf(payload)
    if (typeof crop === 'string' && ids.includes(crop)) return crop
    // 票 90：按需包只带当前那一种作物的图。没有显式选择时（窗口刚打开/重开）要跟着
    // 推包走——否则会默认白名单第一种，再去为一张宿主根本没发的图发 trading-charts。
    const carried = chartsCropOf(payload)
    if (carried !== null && ids.includes(carried)) return carried
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

  // ---------------------------------------------------------------------------
  // 票 90：盘口图按需拉取（切作物先看本地缓存，没有再向宿主请求）
  // ---------------------------------------------------------------------------

  /** 窗口本地最多缓存几位作物的图：切回来不再发 IPC，也不至于把整份盘口都搬进内存。 */
  const CHART_CACHE_LIMIT = 4

  /**
   * 推包里带的是哪一种作物的图（票 90）。
   *
   * 新宿主按需只发当前选中的那一种 → 返回它；老宿主的全量包（每种都有）返回 null：
   * 分不清「只有一种」和「只有这一种能画」，所以不猜，交给 `hasCropCharts()` 逐个判断。
   */
  function chartsCropOf (payload) {
    const charts = timeframeChartsOf(payload, CONTRACT_TIMEFRAME)
    if (charts === null) return null
    const keys = Object.keys(charts)
    return keys.length === 1 ? keys[0] : null
  }

  /**
   * 推包里有没有这一种作物的图（票 90）：新宿主按需包只有一种，老宿主每种都有。
   * 只看 15 分块——四个周期是同一次生成的；缺的周期由视图画空态，不必整块重拉。
   */
  function hasCropCharts (payload, crop) {
    if (typeof crop !== 'string' || crop === '') return false
    const charts = timeframeChartsOf(payload, CONTRACT_TIMEFRAME)
    if (charts === null) return false
    const chart = charts[crop]
    return chart !== null && typeof chart === 'object'
  }

  /**
   * 从推包里挑出某一种作物的四个周期与风向（票 90）：`{ timeframes, hint }`。
   * 推包里没有它就返回 null——窗口据此决定要不要发 `trading-charts`。
   * 老宿主只有 `charts`（15 分）时，这里只会得到 15 分一块，其它周期由视图画空态。
   */
  function chartsFromPayload (payload, crop) {
    if (!hasCropCharts(payload, crop)) return null
    const source = payload !== null && typeof payload === 'object' && payload.timeframes !== null &&
      typeof payload.timeframes === 'object'
      ? payload.timeframes
      : {}
    const ids = Object.keys(source)
    if (ids.length === 0) ids.push(CONTRACT_TIMEFRAME)
    const timeframes = {}
    for (const id of ids) {
      const block = timeframeChartsOf(payload, id)
      const chart = block === null ? null : block[crop]
      if (chart === null || typeof chart !== 'object') continue
      timeframes[id] = { [crop]: chart }
    }
    if (Object.keys(timeframes).length === 0) return null
    const hints = payload !== null && typeof payload === 'object' ? payload.hint : null
    const hint = {}
    if (hints !== null && typeof hints === 'object' && hints[crop] !== null &&
      typeof hints[crop] === 'object') {
      hint[crop] = hints[crop]
    }
    return { timeframes, hint }
  }

  /**
   * 最近看过的作物图缓存（票 90）：LRU，最多 `CHART_CACHE_LIMIT` 种。
   * 值是 `{ timeframes, hint }`（与 `chartsFromPayload()` 同形）；`get` 会把它挪到
   * 最近使用，切回刚看过的作物不需要再发 IPC。
   */
  function createChartCache (options = {}) {
    const entries = new Map()
    const requested = toNumber(options.limit)
    const limit = requested === null ? CHART_CACHE_LIMIT : Math.max(1, Math.floor(requested))
    return {
      get (crop) {
        if (typeof crop !== 'string' || !entries.has(crop)) return null
        const value = entries.get(crop)
        entries.delete(crop)
        entries.set(crop, value)
        return value
      },
      has (crop) {
        return typeof crop === 'string' && entries.has(crop)
      },
      set (crop, charts) {
        if (typeof crop !== 'string' || crop === '') return null
        const value = charts !== null && typeof charts === 'object' ? charts : {}
        entries.delete(crop)
        entries.set(crop, value)
        while (entries.size > limit) {
          const oldest = entries.keys().next().value
          if (oldest === undefined) break
          entries.delete(oldest)
        }
        return value
      },
      size () {
        return entries.size
      }
    }
  }

  /**
   * 这一屏当前这一种作物该用的图（票 90）：本地缓存优先，其次推包本身。
   *
   * 返回 `{ crop, timeframes, hint, from }`：
   *   - `from:'cache'`/`'payload'` → 直接画；
   *   - `from:null` → 窗口显示「正在加载」并提交 `trading-charts { cropId }`。
   * 从推包取到时会顺手进缓存（同一包不重复搬），缓存命中后不会再发第二次请求。
   */
  function chartsFor (payload, cache, crop) {
    if (typeof crop !== 'string' || crop === '') {
      return { crop, timeframes: null, hint: null, from: null }
    }
    if (cache !== null && typeof cache === 'object' && typeof cache.get === 'function') {
      const cached = cache.get(crop)
      if (cached !== null && typeof cached === 'object' && cached.timeframes !== null &&
        typeof cached.timeframes === 'object') {
        return { crop, timeframes: cached.timeframes, hint: cached.hint ?? null, from: 'cache' }
      }
    }
    const fromPayload = chartsFromPayload(payload, crop)
    if (fromPayload === null) return { crop, timeframes: null, hint: null, from: null }
    if (cache !== null && typeof cache === 'object' && typeof cache.set === 'function') {
      cache.set(crop, fromPayload)
    }
    return { crop, timeframes: fromPayload.timeframes, hint: fromPayload.hint, from: 'payload' }
  }

  /**
   * 把按需拉来的图并进本地 payload（票 90）：只加/替换这一种作物的
   * `timeframes[*][crop]` 与 `hint[crop]`，钱、持仓、榜、别的作物一概不动。
   *
   * 不直接改 `payload`（宿主推来的那份还要当倒计时基线/下一包合并的底），
   * 坏回执原样返回 payload——窗口宁可停在空态，也不拿半截图去画。
   */
  function withCropCharts (payload, charts) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
    if (charts === null || typeof charts !== 'object') return payload
    const crop = typeof charts.crop === 'string' && charts.crop !== '' ? charts.crop : null
    const blocks = charts.timeframes
    if (crop === null || blocks === null || typeof blocks !== 'object') return payload
    const timeframes = payload.timeframes !== null && typeof payload.timeframes === 'object'
      ? { ...payload.timeframes }
      : {}
    let changed = false
    for (const id of Object.keys(blocks)) {
      const block = blocks[id]
      if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
      const chart = block[crop]
      if (chart === null || typeof chart !== 'object') continue
      const target = timeframes[id] !== null && typeof timeframes[id] === 'object'
        ? { ...timeframes[id] }
        : {}
      target[crop] = chart
      timeframes[id] = target
      changed = true
    }
    if (!changed) return payload
    const next = { ...payload, timeframes }
    const hintEntry = charts.hint !== null && typeof charts.hint === 'object' ? charts.hint[crop] : null
    if (hintEntry !== null && typeof hintEntry === 'object') {
      next.hint = {
        ...(payload.hint !== null && typeof payload.hint === 'object' ? payload.hint : {}),
        [crop]: hintEntry
      }
    }
    return next
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

  /** 作物页签：任意数量都可切；没图的作物也画出来（切过去是空态，不是消失）。 */
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
   * 作物条（票 89）：单行横向滚动，一屏放 `visible` 颗 chip，左右箭头按「当前窗口」禁用。
   *
   * 纯函数只估算**初始窗口**：选中项尽量居中；真实滚动位置由 `board.js` 量 DOM 再校正。
   * 测试用 10 种作物断言「首尾箭头禁用态 + 选中索引」，窗口用同一份 items。
   */
  function cropStripView (payload, crop, { visible = CROP_STRIP_VISIBLE } = {}) {
    const items = cropsView(payload, crop)
    const count = Math.max(1, Math.floor(toNumber(visible) ?? CROP_STRIP_VISIBLE))
    const selectedIndex = Math.max(0, items.findIndex((item) => item.active))
    const maxStart = Math.max(0, items.length - count)
    const windowStart = Math.min(maxStart, Math.max(0, selectedIndex - Math.floor(count / 2)))
    const overflow = items.length > count
    return {
      items,
      selectedIndex,
      count: items.length,
      visibleCount: count,
      overflow,
      windowStart,
      arrows: {
        prev: {
          enabled: windowStart > 0,
          label: '上一组作物',
          disabledReason: '已经是第一组'
        },
        next: {
          enabled: windowStart < maxStart,
          label: '下一组作物',
          disabledReason: '已经是最后一组'
        }
      }
    }
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
    // 票 90：`bar` 只描述一种作物（新宿主的按需包里就是当前选择）。切到另一种、图还没到时
    // 不能拿它的价格冒充——价格显示「—」；倒计时仍按同一根走（bar 的 end 是全局的）。
    const barCrop = bar !== null && typeof bar.crop === 'string' ? bar.crop : null
    const barPrice = bar !== null && (barCrop === null || barCrop === selected) ? bar : null
    const price = current === null
      ? (barPrice === null ? null : toNumber(barPrice.price))
      : toNumber(current.price)
    const open = current === null
      ? (barPrice === null ? null : toNumber(barPrice.open))
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
   *
   * 票 89 瘦身：顶栏只留一颗胶囊 `本周 −1.0 (−4.6%)`——盈亏一位小数、收益率一位小数
   * 放在括号里，负号用 U+2212。`pnlText`/`pctText` 保留旧口径给榜单/旧测试用，
   * 窗口顶栏读 `pnlMinusText` + `pctParenText`。
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
    const pnlMinusText = formatSignedMinus(total)
    const pctParenText = pct === null ? '(—)' : '(' + formatSignedMinus(pct, 1) + '%)'
    return {
      pnl: total,
      realized,
      unrealized,
      base,
      pnlText: formatSigned(total),
      pnlTone: toneOf(total),
      pnlMinusText,
      // 票 91：黑白模式下顶栏数字补 ▲/▼（颜色没了，方向还得读得出来）。
      pnlMonoText: monoNumber(pnlMinusText, toneOf(total)),
      pctText: pct === null ? '—' : formatSigned(pct, 2) + '%',
      pctParenText,
      pctTone: toneOf(pct, 2),
      // 顶栏胶囊的完整文案：`本周 −1.0 (−4.6%)`。
      pillText: '本周 ' + pnlMinusText + ' ' + pctParenText,
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
      const up = close >= open
      return {
        index,
        slot,
        open,
        close,
        centerX,
        x: centerX - bodyWidth / 2,
        width: bodyWidth,
        openY,
        closeY,
        bodyTop: Math.min(openY, closeY),
        bodyHeight: Math.max(1, Math.abs(closeY - openY)),
        up,
        // 票 89：跌蜡烛画空心（纸色填充 + 玫红描边），不只靠颜色区分涨跌。
        hollow: !up,
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
        wickBottom: yOf(bar.low),
        news: Array.isArray(bar.news) ? bar.news : []
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
          tick: toNumber(current.tick) ?? 0,
          news: Array.isArray(current.news) ? current.news : []
        }
    // 票 106：把每根的关键消息变成一个小标记；最多 3 个，超出由 hover 便签写「还有 N 条」。
    const newsMarks = []
    const markNews = (candle, news) => {
      const list = Array.isArray(news) ? news.slice(0, 3) : []
      for (let index = 0; index < list.length; index += 1) {
        const item = list[index]
        const tone = item.tone === 'down' ? 'down' : item.tone === 'up' ? 'up' : 'vol'
        const y = tone === 'down'
          ? Math.min(plot.top + plot.height - 2, candle.wickBottom + 6 + index * 5)
          : Math.max(plot.top + 2, candle.wickTop - 6 - index * 5)
        newsMarks.push({
          id: item.id,
          at: item.at,
          title: item.title,
          tone,
          rarity: toNumber(item.rarity) ?? 0,
          x: candle.centerX,
          y,
          barIndex: candle.index
        })
      }
    }
    for (const candle of scaled) markNews(candle, candle.news)
    if (forming !== null) markNews(forming, forming.news)
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
    // 票 89：参考线标签也在这里算好 y。底价/入场/强平挨得近时（比如入场离底价 1%），
    // 三个标签不能叠在一起；按 y 排序后每个至少错开 13px，并夹在绘图区里。
    const visibleLines = lines.filter((line) => line.visible).sort((left, right) => left.y - right.y)
    let previousLabelY = -Infinity
    for (const line of visibleLines) {
      let labelY = Math.max(line.y - 4, plot.top + 10, previousLabelY + 13)
      labelY = Math.min(labelY, plot.top + plot.height - 4)
      line.labelY = labelY
      previousLabelY = labelY
    }
    for (const line of lines) {
      if (line.visible !== true) line.labelY = null
    }
    const geometry = {
      width,
      height,
      plot,
      domain: { min, max },
      timeframe,
      slotWidth,
      bars: scaled,
      forming,
      newsMarks,
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
   * 折线图几何（票 91）：与蜡烛共用同一份 `chartGeometry`（坐标轴/参考线/十字线/现价胶囊
   * 全部不变），只把「每根的收盘价」连成一条手绘折线，并给 12% 面积与现价圆点。
   *
   * 为什么从几何里取而不是重算价格：定义域、绘图区、y 映射只有一份；收盘价在
   * `chartGeometry` 里已经算成 `closeY`（形成中的那根是现价），窗口照着画就不会和
   * 蜡烛/胶囊/十字线对不上。
   */
  function lineSeries (geometry) {
    if (geometry === null || typeof geometry !== 'object') return null
    // 坏几何（空对象/缺 bars）不造 NaN 路径：没有蜡烛就返回 null，窗口画空态。
    const bars = Array.isArray(geometry.bars) ? geometry.bars : []
    const forming = geometry.forming !== null && typeof geometry.forming === 'object'
      ? geometry.forming
      : null
    const candles = forming === null ? bars : bars.concat([forming])
    if (candles.length === 0) return null
    const plot = geometry.plot
    if (plot === null || typeof plot !== 'object') return null
    const bottom = plot.top + plot.height
    const points = candles.map((candle) => {
      const isForming = forming === candle
      return {
        index: candle.index,
        slot: candle.slot,
        x: candle.centerX,
        y: candle.closeY,
        close: isForming ? candle.price : candle.close,
        tone: candle.up ? 'up' : 'down',
        forming: isForming
      }
    })
    const first = points[0]
    const last = points[points.length - 1]
    const segments = points.map((point) => point.x + ' ' + point.y)
    return {
      points,
      // 折线本体：M/L 连到尾点；面积从首点落到绘图区底、沿底走到末点再收口。
      path: 'M ' + segments.join(' L '),
      area: 'M ' + first.x + ' ' + bottom + ' L ' + segments.join(' L ') +
        ' L ' + last.x + ' ' + bottom + ' Z',
      areaOpacity: LINE_AREA_OPACITY,
      // 现价圆点：坐标已在绘图区里（收盘价映射）；窗口只画，不再夹取。
      dot: {
        x: last.x,
        y: last.y,
        radius: 4.2,
        value: last.close,
        tone: last.tone
      },
      firstX: first.x,
      lastX: last.x,
      bottom
    }
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
    // 票 91：图 228 后绘图区约 188px，5 档每档约 47px，保留 5 档更好读。
    const count = plot.height >= 150 ? 5 : 4
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
    // 票 89：轴字 11px，胶囊跟着放宽/放高一点，价格读起来不挤。
    const width = Math.max(44, text.length * 7.2 + 16)
    const height = 22
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
    // 票 106：便签下半区放这个时间点的消息；最多 2 条，更多写「还有 N 条」。
    const news = Array.isArray(nearest.news) ? nearest.news.slice(0, 2) : []
    const newsRows = news.map((item) => {
      const mag = toNumber(item.mag) ?? 0
      const off = toNumber(item.off)
      const when = geometry.timeframe === CONTRACT_TIMEFRAME && off !== null
        ? '第' + (Math.floor(off) + 1) + '分钟 '
        : ''
      const impact = item.tone === 'vol' ? '波动放大' : formatSigned(mag * 100, 1) + '%'
      return {
        id: item.id,
        tone: item.tone,
        text: when + item.title + ' · ' + impact,
        icon: item.tone === 'down' ? '▼' : item.tone === 'up' ? '▲' : '≈'
      }
    })
    const totalNews = Array.isArray(nearest.news) ? nearest.news.length : 0
    const newsMore = totalNews > newsRows.length
      ? '还有 ' + (totalNews - newsRows.length) + ' 条，点开看'
      : ''
    const text = timeText + ' 开 ' + formatPrice(values.open) + ' 高 ' + formatPrice(values.high) +
      ' 低 ' + formatPrice(values.low) + ' 收 ' + formatPrice(values.close) +
      (newsRows.length > 0 ? '；' + newsRows.map((row) => row.text).join('；') : '')
    // 票 89：轴/便签字号提到 11px 后，便签要宽一点、高一点才不挤；仍整体夹在绘图区里。
    // 票 106：有消息时加高到 300×122 左右；无消息仍是 210×78。
    const cardWidth = Math.min(300, Math.max(210, plot.width - 8))
    const newsBlock = newsRows.length > 0 ? 14 + newsRows.length * 15 + (newsMore === '' ? 0 : 12) : 0
    const cardHeight = Math.min(Math.max(40, plot.height - 8), 78 + newsBlock)
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
      newsRows,
      newsMore,
      text,
      card: {
        left,
        top,
        width: cardWidth,
        height: cardHeight,
        timeText,
        rows,
        newsRows,
        newsMore,
        newsTop: top + 76,
        newsLineHeight: 15,
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
   * 票 106：图头下的快讯条。优先最近一条已经发生的消息；还没发生就显示最近的一条预告。
   * 没有消息时给一句「今日暂无消息，行情照走」；窗口只照着画。
   */
  function tickerView (payload, now = null) {
    const items = payload !== null && typeof payload === 'object' &&
      payload.news !== null && typeof payload.news === 'object' &&
      Array.isArray(payload.news.items)
      ? payload.news.items
      : []
    if (items.length === 0) {
      return {
        hasNews: false,
        id: null,
        at: null,
        tone: 'flat',
        title: '',
        text: '今日暂无消息，行情照走'
      }
    }
    const stamp = toNumber(now)
    let item = items[0]
    if (stamp !== null) {
      const past = items
        .filter((entry) => (toNumber(entry.at) ?? 0) <= stamp)
        .sort((left, right) => (toNumber(right.at) ?? 0) - (toNumber(left.at) ?? 0))
      const future = items
        .filter((entry) => (toNumber(entry.at) ?? 0) > stamp)
        .sort((left, right) => (toNumber(left.at) ?? 0) - (toNumber(right.at) ?? 0))
      item = past[0] ?? future[0] ?? items[0]
    }
    const at = toNumber(item.at)
    const mag = toNumber(item.mag) ?? 0
    const impact = item.tone === 'vol' ? '波动放大' : formatSigned(mag * 100, 1) + '%'
    const timeText = at === null ? '—' : formatClock(at)
    return {
      hasNews: true,
      id: item.id,
      at,
      tone: item.tone,
      title: item.title,
      text: timeText + ' ' + item.title + ' · ' + impact
    }
  }

  /** 票 106：今日日程（5 条），窗口按本机时钟倒计时；已公布写「已公布」。 */
  function calendarView (payload, now = null) {
    const rows = payload !== null && typeof payload === 'object' &&
      payload.news !== null && typeof payload.news === 'object' &&
      Array.isArray(payload.news.calendar)
      ? payload.news.calendar
      : []
    const stamp = toNumber(now) ?? Date.now()
    return rows.map((row) => {
      const at = toNumber(row.at)
      const diff = at === null ? 0 : at - stamp
      const done = diff <= 0
      return {
        at,
        done,
        cropName: row.cropName,
        title: row.title,
        tone: row.tone,
        text: (at === null ? '—' : formatClock(at)) + ' ' + row.title,
        countdown: done ? '已公布' : formatCountdown(diff)
      }
    })
  }

  /** 票 106：详情卡取一条消息的全文；找不到返回 null（老宿主/坏 id 不编内容）。 */
  function newsDetailView (payload, id) {
    if (typeof id !== 'string' || id === '') return null
    const items = payload !== null && typeof payload === 'object' &&
      payload.news !== null && typeof payload.news === 'object' &&
      Array.isArray(payload.news.items)
      ? payload.news.items
      : []
    const item = items.find((entry) => entry !== null && typeof entry === 'object' && entry.id === id)
    if (item === undefined) return null
    const at = toNumber(item.at)
    const mag = toNumber(item.mag) ?? 0
    return {
      id: item.id,
      at,
      timeText: at === null ? '—' : formatClock(at),
      title: item.title,
      body: item.body ?? '',
      source: item.source ?? '',
      tone: item.tone,
      magText: item.tone === 'vol' ? '波动放大' : formatSigned(mag * 100, 1) + '%',
      cropName: cropNameOf(payload, item.crop)
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
    height = CHART_HEIGHT,
    loading = false,
    chartType = DISPLAY_DEFAULTS.chartType,
    now = null
  } = {}) {
    const selected = pickCrop(payload, crop)
    const period = pickTimeframe(payload, timeframe)
    const onContractBar = period === CONTRACT_TIMEFRAME
    const label = limitsOf(payload).timeframes.find((entry) => entry.id === period)?.label ?? period
    const display = displayView({ chartType })
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
      // 票 106：快讯条 + 详情卡的数据（老宿主没有 news 时是空表）。
      ticker: tickerView(payload, now),
      news: payload !== null && typeof payload === 'object' && payload.news !== null && typeof payload.news === 'object'
        ? { items: Array.isArray(payload.news.items) ? payload.news.items : [], calendar: Array.isArray(payload.news.calendar) ? payload.news.calendar : [] }
        : { items: [], calendar: [] },
      // 票 90：切到还没拉图的作物时画「正在加载」，和「宿主没发/坏了」区分开。
      loading: loading === true && geometry === null,
      // 票 89：空态一行；「K 线一分钟才动一格」这类解释不再挂在窗口上。
      emptyText: loading === true && geometry === null ? '正在加载这张图…' : '行情还在算',
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
      // 票 91：图表类型是窗口本地偏好；折线的几何与蜡烛共用同一份坐标轴。
      chartType: display.chartType,
      chartTypeLabel: display.labels.chartType,
      line: display.chartType === 'line' ? lineSeries(geometry) : null,
      ariaLabel: display.chartType === 'line'
        ? label + ' 折线：收盘价走势' + (onContractBar ? '，底价、入场、强平参考线' : '，只画底价线') +
          '；右侧价格轴、底部时间轴，悬停看每根 OHLC'
        : label + ' K 线：' + (onContractBar ? '底价、入场、强平参考线' : '只画底价线，看趋势') +
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
    // 票 89：禁用原因压成一句「差 N 硬币」；0 硬币时按钮本身就是「去种地」。
    if (coins.available <= 0) {
      canSubmit = false
      hint = '去种地'
    } else if (coins.available < chosenMargin) {
      canSubmit = false
      hint = '差 ' + formatCoins(Math.ceil(chosenMargin - coins.available)) + ' 硬币'
    }

    const marginChoices = limits.margins.map((candidate) => {
      const shortfall = Math.max(0, Math.ceil(candidate - coins.available))
      return {
        margin: candidate,
        label: String(candidate),
        allIn: false,
        active: !chosenAllIn && candidate === chosenMargin,
        disabled: candidate > coins.available,
        // 票 89：禁用 chip 的可见理由（title），和下方 order-hint 同一句。
        disabledReason: shortfall > 0 ? '差 ' + formatCoins(shortfall) + ' 硬币' : ''
      }
    })
    if (limits.allIn === true) {
      marginChoices.push({
        margin: allInAmount,
        label: '全下',
        allIn: true,
        active: chosenAllIn,
        // 0 硬币时「全下」也没有钱可下：和预设一样禁用。
        disabled: allInAmount < 1,
        disabledReason: allInAmount < 1 ? '去种地' : ''
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
    // 票 101：预留 5% 维持保证金，强平线从 (1 - 1/杠杆) 抬到 (1 - 0.95/杠杆)。
    const liquidationRatio = 0.95 / chosenLeverage
    const liquidationPrice = price === null || chosenLeverage <= 1
      ? null
      : chosenSide === 'long'
        ? price * (1 - liquidationRatio)
        : price * (1 + liquidationRatio)
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
      if (coins.available <= 0) limitHint = '去种地'
      else if (coins.available < chosenMargin) {
        limitHint = '差 ' + formatCoins(Math.ceil(chosenMargin - coins.available)) + ' 硬币'
      } else if (!targetInBand) {
        limitHint = bandText === ''
          ? '目标价要大于 0'
          : '目标价要在 ' + bandText + ' 之间'
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
      // 票 91：下单横条第二行只放这一句（不写杠杆/保证金——上面两排 chip 已经选着了）；
      // 强平价由 `liquidationText` 接在后面，窗口用 · 连成一行。
      previewShort: '涨 1% +' + formatTrim(preview.perPercent) +
        ' · 跌 1% ' + MINUS + formatTrim(preview.perPercent),
      previewParts: preview,
      // 下单前的强平价（US7）：数字给 drift 测试，文案给窗口。
      liquidationPrice,
      liquidationText,
      // 0 硬币时按钮本身就是「去种地」——盘口不给救济，这是唯一的下一步。
      // 票 101：手续费必须让下单的人看见——「开平各 0.2%」，不是藏进结算里。
      feeText: '开平各 ' + formatTrim(limits.feeRate * 100) + '%',
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
        // 票 89：到价行只留一句状态提示。开：可挂价格带；关：不写（「关：直接按现价开仓」已删）。
        noteText: limitOpen ? (bandText === '' ? '到价才成交' : '可挂 ' + bandText) : '',
        // 方向与自动撤单放 title，不再占一屏小字。
        noteTitle: (chosenSide === 'long' ? '价格跌到目标价才成交' : '价格涨到目标价才成交') +
          '；收盘没成交自动撤单'
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
        // 票 91：黑白模式用 ▲/▼ + 正负号代替涨跌颜色。
        pnlMonoText: monoNumber(formatSigned(pnl), toneOf(pnl)),
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
        // 票 91：黑白模式用 ▲/▼ 补上被去掉的颜色语义。
        pnlMonoText: monoNumber(formatSigned(pnl), toneOf(pnl)),
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

  /**
   * 空态文案（票 89）：一行就够，不再解释「收盘或手动平仓后会出现在这里」。
   * 每一块只回答「现在是什么状态」；怎么操作由旁边的按钮自己说。
   */
  function emptyHints () {
    return {
      positions: '还没有持仓',
      history: '还没有结算',
      orders: '没有挂单',
      // 榜上只有自己时也只用这一句（旧版本邻居有单独一句，见 `leagueView`）。
      neighbors: '等邻居上线'
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
      const pnlText = formatSigned(weekPnl, 0)
      const pnlTone = toneOf(weekPnl)
      const pctText = pct === null ? '—' : formatSigned(pct * 100, 2) + '%'
      const pctTone = pct === null ? 'flat' : toneOf(pct * 100, 2)
      rows.push({
        // 票 102：榜按收益率排，名次由宿主给的顺序决定（这里不重排，只编号）。
        rank: rows.length + 1,
        nickname,
        me: entry.me === true,
        pnlText,
        pnlTone,
        // 票 91：黑白榜同样靠 ▲/▼ 读方向，不靠红绿。
        pnlMonoText: monoNumber(pnlText, pnlTone),
        pctText,
        pctTone,
        pctMonoText: pct === null ? '—' : monoNumber(pctText, pctTone),
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
   * Tab 顺序（票 81 / 评审 P2 / 票 89 / 票 91）：返回窗口控件的逻辑顺序，`board.js` 按它写 tabindex。
   *
   * 顺序 = DOM 顺序（行为不变）：显示弹层（开关 + 两组分段；收起时被 display:none 跳过）→
   * ×（顶栏）→ 作物条左右箭头 → 作物 chip → 周期页签 → 方向 → 保证金（预设 + 全下）→
   * 杠杆 → 到价开关 → 目标价 → 挂单 → 开一手 → 挂单卡的撤单 → 持仓卡的止损/平仓。
   * 每项都是 `board.js` 的 `focusKeyOf` 能认出的键，且**不重复**（tabindex 只能给一个元素）。
   * 纯函数：不碰 DOM，测试能直接断言；老/坏 payload 退回兜底白名单，不抛。
   */
  function focusOrder (payload) {
    const limits = limitsOf(payload)
    // 票 91：顶栏「显示」在 × 左边；弹层里的四个选项紧跟开关（收起时不可聚焦）。
    // 票 89：左右箭头是作物条的滚动助手，排在作物 chip 两边（DOM 里也是这样）。
    const order = [
      'display-toggle',
      'chart-type:candle',
      'chart-type:line',
      'theme:color',
      'theme:mono',
      'close-button',
      'crop-prev'
    ]
    for (const crop of limits.crops) {
      if (crop !== null && typeof crop === 'object' && typeof crop.id === 'string') {
        order.push('crop:' + crop.id)
      }
    }
    order.push('crop-next')
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
    chartsLoading = false,
    chartType = DISPLAY_DEFAULTS.chartType,
    theme = DISPLAY_DEFAULTS.theme,
    width = CHART_WIDTH,
    height = CHART_HEIGHT
  } = {}) {
    const safe = payload !== null && typeof payload === 'object' ? payload : null
    // 票 91：图表类型/配色是窗口本地偏好——只影响画法，不碰价格、持仓、结算。
    const display = displayView({ chartType, theme })
    const cropStrip = cropStripView(safe, crop)
    const crops = cropStrip.items
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
      cropStrip,
      chart: chartView(safe, {
        crop: selected,
        timeframe,
        width,
        height,
        loading: chartsLoading === true,
        chartType: display.chartType,
        now
      }),
      news: safe !== null && typeof safe === 'object' && safe.news !== null && typeof safe.news === 'object'
        ? safe.news
        : { items: [], calendar: [] },
      // 票 91：显示弹层的按钮/文案/黑白标记都来自这里；`board.js` 只照着画。
      display,
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
    CHART_CACHE_LIMIT,
    CROP_STRIP_VISIBLE,
    ORDER_BAR_HEIGHT,
    DISPLAY_STORAGE_KEY,
    DISPLAY_DEFAULTS,
    DISPLAY_SHORTCUTS,
    CHART_TYPES,
    THEMES,
    LINE_AREA_OPACITY,
    LAYOUT,
    SKETCH,
    formatCoins,
    formatCountdown,
    formatPrice,
    formatSigned,
    formatSignedMinus,
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
    lineSeries,
    chartAxes,
    priceTagOf,
    crosshairAt,
    tickerView,
    calendarView,
    newsDetailView,
    candleSketchOf,
    chartView,
    displayPrefs,
    displayView,
    readDisplayPrefs,
    writeDisplayPrefs,
    toggleChartType,
    toggleTheme,
    monoNumber,
    previewView,
    orderView,
    focusOrder,
    orderRows,
    positionCards,
    historyRows,
    leagueView,
    emptyHints,
    cropsView,
    cropStripView,
    chartsCropOf,
    hasCropCharts,
    chartsFromPayload,
    createChartCache,
    chartsFor,
    withCropCharts,
    boardView
  }
})
