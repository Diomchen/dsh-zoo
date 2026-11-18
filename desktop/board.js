/**
 * 盘口小窗的渲染端（票 79 / 票 81 / 票 82 / 票 89 / 票 91）。
 *
 * 它只做三件事：把宿主推来的盘口视图画成卡片（K 线/折线、下单横条、持仓、历史、周盈亏、
 * 真人周榜）；每秒本地递减收盘倒计时（到 0 请宿主结这一根并重推一拍）；
 * 把「开仓 / 止损 / 平仓」当**申请**交给主进程。
 * 价格、硬币、盈亏、能不能下单全部由宿主算，成功与否也等宿主回执——
 * 窗口不自己改状态、不自己算钱，也不自己算价（图表几何在 `trading-view.js` 里，
 * 这里只把 view 给的坐标画成 SVG 元素）。
 *
 * 票 89：作物条是单行横向滚动（10 种作物也不换行、不撑高）：左右箭头按实际滚动位置
 * 禁用、滚轮横滚、键盘 ←/→/Home/End 切作物、选中 chip 滚进视野；所有滚动都只发生在
 * 列表内部，页面本身不滚。
 *
 * 票 90：图按需拉取。宿主一包只带当前作物的四个周期；切作物先看本地缓存（最近 4 种），
 * 命中就本地换图，没有就先画「正在加载这张图…」再提交 `trading-charts { cropId }`，
 * 回执到了并进本地 state 重画。宿主的推送不会把用户正在看的作物打回默认。
 *
 * 票 91：下单从 300px 窄列搬到图下整宽横条（两排、不滚不裁，到价面板是浮层）；
 * 顶栏「显示」弹层切蜡烛/折线与彩色/黑白，`L`/`M` 是同一组快捷键；偏好只写本机
 * `localStorage['dsh-zoo-board-prefs']`（失败静默）。黑白模式只是 `body[data-mono='1']`
 * + CSS token 覆盖，数字补 ▲/▼——宿主与 payload 一个字段都没变。
 *
 * 键盘：Tab 顺序由 `view.focusOrder()` 落到 tabindex（显示开关/两组分段 → × → 箭头 →
 * 作物 chip → 周期 → 方向 → 保证金 → 杠杆 → 到价 → 开一手 → 挂单撤单 → 持仓止损/平仓）；
 * Enter/Space 是原生按钮行为；Esc 先收弹层、再关窗。失焦策略见 ADR-0029：
 * 点窗口外面会收起所有插件窗，输入法合成期间例外。
 */
'use strict'

const api = window.dshZooBoard
const view = window.dshZooBoardView
const SVG_NS = 'http://www.w3.org/2000/svg'

const titleEl = document.getElementById('board-title')
const weekPnlEl = document.getElementById('week-pnl')
const weekPctEl = document.getElementById('week-pct')
const countdownEl = document.getElementById('countdown')
const coinsAvailableEl = document.getElementById('coins-available')
const coinsLockedEl = document.getElementById('coins-locked')
const cropTabsEl = document.getElementById('crop-tabs')
const cropScrollEl = document.getElementById('crop-scroll')
const cropViewportEl = document.getElementById('crop-viewport')
const cropPrevEl = document.getElementById('crop-prev')
const cropNextEl = document.getElementById('crop-next')
const timeframeTabsEl = document.getElementById('timeframe-tabs')
const chartPriceEl = document.getElementById('chart-price')
const chartChangeEl = document.getElementById('chart-change')
const windEl = document.getElementById('wind')
const chartEl = document.getElementById('chart')
const chartEmptyEl = document.getElementById('chart-empty')
const chartSettleHintEl = document.getElementById('chart-settle-hint')
const slotNoteEl = document.getElementById('slot-note')
const tickerEl = document.getElementById('ticker')
const tickerTextEl = document.getElementById('ticker-text')
const newsPopEl = document.getElementById('news-pop')
const newsPopTimeEl = document.getElementById('news-pop-time')
const newsPopTitleEl = document.getElementById('news-pop-title')
const newsPopBodyEl = document.getElementById('news-pop-body')
const newsPopSourceEl = document.getElementById('news-pop-source')
const newsPopImpactEl = document.getElementById('news-pop-impact')
const newsPopCalendarEl = document.getElementById('news-pop-calendar')
const newsPopCloseEl = document.getElementById('news-pop-close')
const displayToggleEl = document.getElementById('display-toggle')
const displayPopEl = document.getElementById('display-pop')
const chartTypeOptionsEl = document.getElementById('chart-type-options')
const themeOptionsEl = document.getElementById('theme-options')
const sideRowEl = document.getElementById('side-row')
const marginRowEl = document.getElementById('margin-row')
const leverageRowEl = document.getElementById('leverage-row')
const previewEl = document.getElementById('preview')
const liquidationEl = document.getElementById('order-liquidation')
const submitEl = document.getElementById('submit')
const orderHintEl = document.getElementById('order-hint')
const limitToggleEl = document.getElementById('limit-toggle')
const limitNoteEl = document.getElementById('limit-note')
const limitBoxEl = document.getElementById('limit-box')
const limitInputEl = document.getElementById('limit-target')
const limitHintEl = document.getElementById('limit-hint')
const limitPlaceEl = document.getElementById('limit-place')
const ordersWrapEl = document.getElementById('orders-wrap')
const ordersEl = document.getElementById('orders')
const ordersMetaEl = document.getElementById('orders-meta')
const positionsEl = document.getElementById('positions')
const positionsMetaEl = document.getElementById('positions-meta')
const positionsEmptyEl = document.getElementById('positions-empty')
const historyEl = document.getElementById('history')
const historyMetaEl = document.getElementById('history-meta')
const historyEmptyEl = document.getElementById('history-empty')
const leagueEl = document.getElementById('league')
const sentimentEl = document.getElementById('sentiment')
const neighborEmptyEl = document.getElementById('neighbor-empty')
const closeButton = document.getElementById('close')
const toastsEl = document.getElementById('toasts')

/**
 * 主进程只会用错误码回传传输层失败（超时/管道断/坏形状）；宿主给的 notice 已经是人话，
 * 优先显示它。这些码不是产品文案，只是窗口的兜底。
 */
const RESULT_CODE_TEXT = {
  timeout: '桌面宿主没有回应，这次操作可能没有生效。',
  'host-unavailable': '桌面宿主没有连接，这次操作没有完成。',
  'bad-board-action': '这个操作缺少方向或保证金，再试一次。',
  'bad-crop': '这种作物暂时没有盘口。',
  'bad-side': '方向只有做多和做空。',
  'bad-margin': '保证金要是 1 到 1,000,000 之间的整数硬币。',
  'bad-leverage': '这档杠杆还没开放（只有 1× / 5× / 20×）。',
  'bad-target': '目标价超出这张图的价格范围，换一个价再挂。',
  'no-order': '这张挂单已经成交或撤掉了，刷新一下就好。',
  'no-coin': '硬币不够，先去种地或卖点作物。',
  'no-position': '这个仓位已经平掉了，刷新一下就好。',
  settling: '这个仓位正在结算，等一下再看。',
  starting: '盘口还在准备中，稍等一下再试。'
}

/**
 * 票 91：本机偏好的存储口。file:// 页面在某些隐私策略下连读 `window.localStorage`
 * 都会抛，所以这里自己 try 一次——拿不到就传 null，纯视图会退回默认偏好。
 */
function readPrefsStorage () {
  try {
    if (window.localStorage === null || typeof window.localStorage !== 'object') return null
    return window.localStorage
  } catch {
    return null
  }
}

/** 写偏好（纯视图里再 try/catch 一次）：失败静默，不影响这一屏的切换。 */
function saveDisplayPrefs (next) {
  displayPrefs = view.displayPrefs(next)
  view.writeDisplayPrefs(readPrefsStorage(), displayPrefs)
}

/** 宿主推来的最后一份视图；null = 还没收到（窗口先画空态）。 */
let payload = null
/**
 * 票 90：按需拉图的本地缓存（最近 4 种作物）。切作物先看它；命中就本地换图，
 * 不再发 IPC——宿主一包只带当前作物的四个周期。
 */
const chartCache = view.createChartCache()
/** 正在等哪一位作物的图（null = 没有在飞）；主进程一次只收一条申请。 */
let chartsPending = null
/** 当前屏缺图、正在等宿主：视图画「正在加载这张图…」。 */
let chartsLoading = false
/** 拉图失败过的那一种作物（同一屏不自动重试，等下一次推送或用户再点一下）。 */
let chartsFailed = null
/** 当前选择（只活在窗口里，开仓成功后保持不变，方便连做）。 */
let side = 'long'
let margin = 50
let leverage = 1
let crop = null
/** 票 84：选中的 K 线周期（只活在窗口里；切换不发 IPC，也不影响结算）。 */
let timeframe = '15m'
/** 票 83：保证金选的是不是「全下」（金额每包按可用硬币现算，所以只记这个布尔）。 */
let allIn = false
/** 到价面板开没开；关着时输入框和挂单按钮不出现（SPEC：下单区只在点开「到价」时出现）。 */
let limitOpen = false
/** 玩家在目标价输入框里打的原文；空 = 用现价当默认值。 */
let targetText = ''
/** 有申请在飞：连点不会串单（主进程也会挡，这里只是立刻反馈）。 */
let pending = false
/** 这条在飞的申请是什么动作（票 90：靠它把 `trading-charts` 的回执和图对上）。 */
let pendingAction = null
/**
 * 票 91：本机显示偏好（图表类型 / 配色）——只活在窗口里，从不发给宿主。
 * 启动时从 localStorage 读一次（失败静默退默认）；每次改动都写回，重开窗保持上一次。
 */
let displayPrefs = view.readDisplayPrefs(readPrefsStorage())
/** 顶栏「显示」弹层开没开；Esc/外点/再点一下都会关。 */
let displayOpen = false
/** 这一根的收盘时刻（本地倒计时基线，每次宿主推包都重置）。 */
let barEnd = 0
/** 这一根已经问过「到点了，重推一拍」没有；每根只问一次。 */
let refreshAsked = false
/** 第一次收到数据时把焦点放到第一个控件上（窗口刚弹出，键盘就能用）。 */
let focusedOnce = false

/** 便签/消息卡里的长标题按码点截断；SVG text 不会自动省略。 */
function clipText (value, max) {
  const chars = Array.from(String(value ?? ''))
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('') + '…'
}

function setTone (element, tone) {
  element.dataset.tone = tone
}

function svgEl (tag, attrs = {}) {
  const element = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value))
  return element
}

/** 轴/参考线标签/便签都是文字：单独建 text 节点，不套手绘滤镜，保证清晰。 */
function svgText (text, attrs = {}) {
  const element = svgEl('text', attrs)
  element.textContent = text
  return element
}

function renderHeader (board) {
  const header = board.header
  titleEl.textContent = header.cropName === '—' ? '盘口' : '盘口 · ' + header.cropName
  countdownEl.textContent = header.countdownText
  coinsAvailableEl.textContent = header.coinsAvailableText
  coinsLockedEl.textContent = header.coinsLockedText
  // 票 89：顶栏一颗胶囊，负号用 U+2212，收益率一位小数放括号里。
  // 票 91：黑白模式下前面补 ▲/▼（颜色没了，方向还得读得出来）。
  weekPnlEl.textContent = board.display.mono ? board.week.pnlMonoText : board.week.pnlMinusText
  weekPctEl.textContent = board.week.pctParenText
  setTone(weekPnlEl, board.week.pnlTone)
}

/**
 * 顶栏「显示」弹层（票 91）：两组分段的分段文案/选中态都来自纯视图，
 * 这里只画按钮、设 `hidden` 与 `aria-expanded`。
 *
 * 黑白标记落在 `body[data-mono]` 上：CSS 的花样全部挂在它下面，渲染端不判断颜色。
 */
function renderDisplay (display) {
  document.body.dataset.mono = display.mono ? '1' : '0'
  displayToggleEl.setAttribute('aria-expanded', displayOpen ? 'true' : 'false')
  displayToggleEl.setAttribute(
    'aria-label',
    '显示选项：' + display.labels.chartType + ' · ' + display.labels.theme
  )
  displayToggleEl.title = '显示：' + display.labels.chartType + ' · ' + display.labels.theme +
    '（L 切图 / M 切配色）'
  displayPopEl.hidden = !displayOpen
  chartTypeOptionsEl.textContent = ''
  for (const option of display.chartOptions) {
    chartTypeOptionsEl.append(segmentButton('chart-type', option))
  }
  themeOptionsEl.textContent = ''
  for (const option of display.themeOptions) {
    themeOptionsEl.append(segmentButton('theme', option))
  }
}

/** 分段控件里的一颗按钮：`data-chart-type` / `data-theme` 同时是焦点身份（重画后找回）。 */
function segmentButton (kind, option) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'seg'
  if (kind === 'chart-type') button.dataset.chartType = option.id
  else button.dataset.theme = option.id
  button.setAttribute('aria-pressed', option.active ? 'true' : 'false')
  button.textContent = option.label
  return button
}

/**
 * 当前图的几何快照（viewBox 坐标）与指针位置（票 87）。
 * 重画时按同一份几何重建十字线，鼠标不用再动一下；指针离开就清空。
 */
let chartGeometry = null
let chartPointer = null

/** 清掉旧十字线；`hit` 为空就只清不画。 */
function paintCrosshair (hit) {
  const previous = chartEl.querySelector('.chart-crosshair')
  if (previous !== null) previous.remove()
  if (hit === null || chartGeometry === null) return
  const plot = chartGeometry.plot
  const group = svgEl('g', { class: 'chart-crosshair' })
  group.append(svgEl('rect', {
    class: 'crosshair-highlight',
    x: hit.highlight.x,
    y: hit.highlight.y,
    width: hit.highlight.width,
    height: hit.highlight.height,
    rx: 4
  }))
  group.append(svgEl('line', {
    class: 'crosshair-line',
    x1: hit.x,
    y1: plot.top,
    x2: hit.x,
    y2: plot.top + plot.height
  }))
  group.append(svgEl('line', {
    class: 'crosshair-line',
    x1: plot.left,
    y1: hit.y,
    x2: plot.left + plot.width,
    y2: hit.y
  }))
  const card = hit.card
  group.append(svgEl('rect', {
    class: 'crosshair-card',
    x: card.left,
    y: card.top,
    width: card.width,
    height: card.height,
    rx: 9
  }))
  // 折角：便签右下角折一下，像真的被手贴上去。
  group.append(svgEl('path', {
    class: 'crosshair-fold',
    d: 'M ' + (card.left + card.width - 14) + ' ' + (card.top + card.height) +
      ' L ' + (card.left + card.width) + ' ' + (card.top + card.height - 14) +
      ' L ' + (card.left + card.width) + ' ' + (card.top + card.height) + ' Z'
  }))
  group.append(svgText(hit.title, {
    class: 'crosshair-title',
    x: card.left + 9,
    y: card.top + 18
  }))
  for (let index = 0; index < hit.rows.length; index += 1) {
    const row = hit.rows[index]
    const column = index % 2
    const line = Math.floor(index / 2)
    const x = card.left + 9 + column * (card.width / 2)
    const y = card.top + 34 + line * 16
    group.append(svgText(row.label, { class: 'crosshair-label', x, y }))
    group.append(svgText(row.text, { class: 'crosshair-value', x: x + 14, y }))
  }
  if (Array.isArray(card.newsRows) && card.newsRows.length > 0) {
    const ruleY = card.top + 66
    group.append(svgEl('line', {
      class: 'crosshair-rule',
      x1: card.left + 9,
      x2: card.left + card.width - 9,
      y1: ruleY,
      y2: ruleY
    }))
    for (let index = 0; index < card.newsRows.length; index += 1) {
      const row = card.newsRows[index]
      const y = card.newsTop + index * card.newsLineHeight
      group.append(svgText(row.icon, {
        class: 'crosshair-news-icon ' + row.tone,
        x: card.left + 9,
        y
      }))
      group.append(svgText(clipText(row.text, 24), {
        class: 'crosshair-news-text',
        x: card.left + 20,
        y
      }))
    }
    if (card.newsMore) {
      group.append(svgText(clipText(card.newsMore, 24), {
        class: 'crosshair-news-more',
        x: card.left + 20,
        y: card.newsTop + card.newsRows.length * card.newsLineHeight + 4
      }))
    }
  }
  chartEl.append(group)
}

/** 视口坐标 → viewBox 坐标（`preserveAspectRatio="none"` 时是线性缩放，直接乘）。 */
function chartPointOf (event) {
  if (chartGeometry === null) return null
  const rect = chartEl.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    x: ((event.clientX - rect.left) / rect.width) * chartGeometry.width,
    y: ((event.clientY - rect.top) / rect.height) * chartGeometry.height
  }
}

function renderChart (board) {
  const chart = board.chart
  // 票 89：作物 chip 支持任意数量；条本身横滚，不换行、不撑高（数量来自 payload）。
  cropTabsEl.textContent = ''
  for (const choice of board.cropStrip.items) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'crop-tab'
    button.dataset.crop = choice.id ?? ''
    button.setAttribute('aria-pressed', choice.active ? 'true' : 'false')
    button.title = choice.name
    button.textContent = choice.label
    cropTabsEl.append(button)
  }
  // 周期页签：清单/文案来自 payload（宿主唯一来源），这里只画。
  timeframeTabsEl.textContent = ''
  for (const choice of chart.timeframes) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'timeframe-tab'
    button.dataset.timeframe = choice.id
    button.setAttribute('aria-pressed', choice.active ? 'true' : 'false')
    button.disabled = choice.disabled
    // 禁用原因：老 payload 没有这个周期的图（新宿主四档都有）。
    if (choice.disabled) button.title = '这个周期还没有图'
    button.textContent = choice.label
    timeframeTabsEl.append(button)
  }
  chartSettleHintEl.textContent = chart.settleNote.text
  chartSettleHintEl.dataset.visible = chart.settleNote.visible ? 'true' : 'false'
  chartEl.setAttribute('aria-label', chart.ariaLabel)
  const header = board.header
  chartPriceEl.textContent = chart.priceText
  setTone(chartPriceEl, header.tone)
  chartChangeEl.textContent = header.changeText
  const hint = board.hint
  windEl.textContent = hint.direction === 'flat' && hint.label === '—'
    ? '风向 —'
    : '风向 ' + hint.label + ' ' + hint.confidenceText
  const note = document.createElement('small')
  note.textContent = hint.note
  windEl.append(note)
  // 视觉上「风向 偏多 62% 不是保证」；给读屏一句连起来的名字。
  windEl.setAttribute('aria-label', '风向 ' + hint.label + ' ' + hint.confidenceText + '，' + hint.note)
  setTone(windEl, hint.tone)
  slotNoteEl.textContent = chart.slotText
  // 票 106：快讯条只画 view 给的文本；没有消息时写「今日暂无消息」。
  const ticker = chart.ticker
  tickerEl.dataset.tone = ticker.tone
  tickerEl.dataset.hasNews = ticker.hasNews ? 'true' : 'false'
  tickerTextEl.textContent = ticker.text
  tickerEl.title = ticker.text
  tickerEl.setAttribute('aria-label', '快讯：' + ticker.text)
  // 票 89：没有独立的图例行；底价/入场/强平在图的右端各有标签，少一行小字。
  updateCropArrows()
  ensureCropVisible()

  // K 线：view 给的已经是 viewBox 坐标，这里只建元素，不做任何换算。
  chartEl.textContent = ''
  chartEmptyEl.hidden = chart.hasChart
  chartEl.hidden = !chart.hasChart
  const geometry = chart.geometry
  if (geometry === null) {
    chartGeometry = null
    chartPointer = null
    chartEmptyEl.textContent = chart.emptyText
    return
  }
  chartGeometry = geometry
  chartEl.setAttribute('viewBox', '0 0 ' + geometry.width + ' ' + geometry.height)
  const plot = geometry.plot
  const plotRight = plot.left + plot.width
  const plotBottom = plot.top + plot.height

  // 手绘滤镜只定义一次、只套在「墨迹层」；轴文字/参考线标签/便签是另一层，永远清晰。
  const defs = svgEl('defs', {})
  const filter = svgEl('filter', {
    id: geometry.sketch.filterId,
    x: '-6%',
    y: '-6%',
    width: '112%',
    height: '112%'
  })
  filter.append(svgEl('feTurbulence', {
    type: 'fractalNoise',
    baseFrequency: geometry.sketch.baseFrequency,
    numOctaves: geometry.sketch.numOctaves,
    seed: geometry.sketch.seed,
    result: 'ink-noise'
  }))
  filter.append(svgEl('feDisplacementMap', {
    in: 'SourceGraphic',
    in2: 'ink-noise',
    scale: geometry.sketch.scale,
    xChannelSelector: 'R',
    yChannelSelector: 'G'
  }))
  defs.append(filter)
  const clip = svgEl('clipPath', { id: 'plot-clip' })
  clip.append(svgEl('rect', {
    x: plot.left,
    y: plot.top,
    width: plot.width,
    height: plot.height
  }))
  defs.append(clip)
  chartEl.append(defs)

  chartEl.append(svgEl('rect', {
    class: 'chart-paper',
    x: 1,
    y: 1,
    width: geometry.width - 2,
    height: geometry.height - 2,
    rx: 12
  }))

  const ink = svgEl('g', {
    class: 'chart-ink',
    filter: geometry.sketch.filter
  })
  // 网格/参考线/蜡烛裁在绘图区里；价格胶囊画在右侧轴槽，不能被裁掉。
  const plotInk = svgEl('g', { 'clip-path': 'url(#plot-clip)' })
  for (const tick of geometry.priceTicks) {
    plotInk.append(svgEl('line', {
      class: 'grid',
      x1: plot.left,
      x2: plotRight,
      y1: tick.y,
      y2: tick.y,
      'vector-effect': 'non-scaling-stroke'
    }))
  }
  for (const tick of geometry.timeTicks) {
    plotInk.append(svgEl('line', {
      class: 'grid',
      x1: tick.x,
      x2: tick.x,
      y1: plot.top,
      y2: plotBottom,
      'vector-effect': 'non-scaling-stroke'
    }))
  }
  for (const line of geometry.lines) {
    if (line.visible !== true) continue
    plotInk.append(svgEl('line', {
      class: 'ref',
      'data-key': line.key,
      x1: plot.left,
      x2: plotRight,
      y1: line.y,
      y2: line.y,
      'vector-effect': 'non-scaling-stroke'
    }))
  }
  if (geometry.priceLine !== null) {
    plotInk.append(svgEl('line', {
      class: 'price-line',
      x1: plot.left,
      x2: plotRight,
      y1: geometry.priceLine.y,
      y2: geometry.priceLine.y,
      'vector-effect': 'non-scaling-stroke'
    }))
  }
  if (chart.chartType === 'line' && chart.line !== null) {
    // 票 91 折线：收盘价折线 + 12% 面积画在墨迹层（和蜡烛同一支手绘笔触）；
    // 现价圆点在清晰层画（见下面 crisp），免得被参考线标签压住。轴/参考线/十字线不变。
    plotInk.append(svgEl('path', {
      class: 'line-area',
      d: chart.line.area
    }))
    plotInk.append(svgEl('path', {
      class: 'line-path',
      d: chart.line.path,
      'vector-effect': 'non-scaling-stroke'
    }))
  } else {
    const candles = geometry.forming === null
      ? geometry.bars
      : geometry.bars.concat([geometry.forming])
    for (const candle of candles) {
      const tone = candle.up ? 'up' : 'down'
      plotInk.append(svgEl('line', {
        class: 'wick ' + tone,
        x1: candle.centerX,
        x2: candle.centerX,
        y1: candle.wickTop,
        y2: candle.wickBottom,
        'stroke-width': candle.sketch.wickWidth,
        'stroke-linecap': geometry.sketch.lineCap,
        'vector-effect': 'non-scaling-stroke'
      }))
      const body = svgEl('rect', {
        class: 'body ' + tone + (candle === geometry.forming ? ' forming' : ''),
        x: candle.x,
        y: candle.bodyTop,
        width: candle.width,
        height: candle.bodyHeight,
        rx: candle.sketch.bodyRadius,
        'stroke-width': candle.sketch.bodyStrokeWidth,
        // 票 89：跌蜡烛空心；属性同时给测试和 CSS 一个明确的钩子（不只靠 class/颜色）。
        'data-hollow': candle.hollow ? 'true' : 'false',
        transform: 'rotate(' + candle.sketch.tilt + ' ' + candle.centerX + ' ' +
          (candle.bodyTop + candle.bodyHeight / 2) + ')'
      })
      plotInk.append(body)
    }
  }
  ink.append(plotInk)

  // 现价胶囊：贴纸 + 手绘引线，画在右侧价格轴槽里，不挡 K 线。
  // 票 89：贴纸底画到清晰层（轴字之后），否则同一高度的轴刻度会从贴纸下面透出来（4.84 变成双影）。
  const tag = geometry.priceTag
  if (tag !== null) {
    ink.append(svgEl('path', {
      class: 'price-leader',
      d: 'M ' + tag.leader.x1 + ' ' + tag.leader.y1 +
        ' Q ' + ((tag.leader.x1 + tag.leader.x2) / 2) + ' ' + (tag.leader.y1 - 5) +
        ' ' + tag.leader.x2 + ' ' + tag.leader.y2
    }))
  }
  chartEl.append(ink)

  // 轴与标签：刻度线进墨迹层（会轻微抖），轴文字在清晰层（不抖）。
  const crisp = svgEl('g', { class: 'chart-crisp' })
  const ticksInk = svgEl('g', {})
  ticksInk.append(svgEl('line', {
    class: 'axis-line',
    x1: plotRight,
    x2: plotRight,
    y1: plot.top,
    y2: plotBottom,
    'vector-effect': 'non-scaling-stroke'
  }))
  ticksInk.append(svgEl('line', {
    class: 'axis-line',
    x1: plot.left,
    x2: plotRight,
    y1: plotBottom,
    y2: plotBottom,
    'vector-effect': 'non-scaling-stroke'
  }))
  for (const tick of geometry.priceTicks) {
    ticksInk.append(svgEl('line', {
      class: 'axis-tick',
      x1: plotRight,
      x2: plotRight + 4,
      y1: tick.y,
      y2: tick.y,
      'vector-effect': 'non-scaling-stroke'
    }))
    crisp.append(svgText(tick.text, {
      class: 'axis-text axis-price',
      x: plotRight + 8,
      y: tick.y + 3
    }))
  }
  for (const tick of geometry.timeTicks) {
    ticksInk.append(svgEl('line', {
      class: 'axis-tick',
      x1: tick.x,
      x2: tick.x,
      y1: plotBottom,
      y2: plotBottom + 3,
      'vector-effect': 'non-scaling-stroke'
    }))
    crisp.append(svgText(tick.text, {
      class: 'axis-text axis-time',
      x: tick.x,
      y: plotBottom + 15,
      'text-anchor': tick.anchor
    }))
  }
  // 参考线在右端写一次名字+价格：轴上看得出底价/入场/强平分别是哪条。
  for (const line of geometry.lines) {
    if (line.visible !== true) continue
    crisp.append(svgText(line.label + ' ' + line.text, {
      class: 'ref-label ref-label-' + line.key,
      'data-key': line.key,
      x: plotRight - 5,
      // 票 89：标签 y 由视图错开过，避免入场贴着底价时两行字叠在一起。
      y: line.labelY,
      'text-anchor': 'end'
    }))
  }
  // 票 91：折线的现价圆点画在清晰层（参考线标签之后、价格贴纸之前）——
  // 画在墨迹层会被「入场/底价」标签压住，看起来像少了这个点。
  if (chart.chartType === 'line' && chart.line !== null) {
    crisp.append(svgEl('circle', {
      class: 'line-dot',
      cx: chart.line.dot.x,
      cy: chart.line.dot.y,
      r: chart.line.dot.radius,
      'vector-effect': 'non-scaling-stroke'
    }))
  }
  if (tag !== null) {
    crisp.append(svgEl('rect', {
      class: 'price-tag ' + tag.tone,
      x: tag.x,
      y: tag.y,
      width: tag.width,
      height: tag.height,
      rx: 8,
      transform: 'rotate(-1.4 ' + (tag.x + tag.width / 2) + ' ' + tag.centerY + ')'
    }))
    crisp.append(svgText(tag.text, {
      class: 'price-tag-text ' + tag.tone,
      x: tag.x + tag.width / 2,
      y: tag.centerY + 3.5,
      'text-anchor': 'middle',
      transform: 'rotate(-1.4 ' + (tag.x + tag.width / 2) + ' ' + tag.centerY + ')'
    }))
  }
  // 票 106：消息标记画在清晰层的最上面；小圆点 + 大事件的方向箭头。
  if (Array.isArray(geometry.newsMarks) && geometry.newsMarks.length > 0) {
    const newsLayer = svgEl('g', { class: 'chart-news' })
    for (const mark of geometry.newsMarks) {
      newsLayer.append(svgEl('circle', {
        class: 'news-dot ' + mark.tone,
        cx: mark.x,
        cy: mark.y,
        r: mark.rarity >= 2 ? 3.4 : 2.4,
        'vector-effect': 'non-scaling-stroke'
      }))
      if (mark.rarity >= 2 || mark.tone === 'vol') {
        newsLayer.append(svgEl('circle', {
          class: 'news-ring ' + mark.tone,
          cx: mark.x,
          cy: mark.y,
          r: mark.rarity >= 3 ? 5.2 : 4.4,
          'vector-effect': 'non-scaling-stroke'
        }))
      }
    }
    crisp.append(newsLayer)
  }
  ink.append(ticksInk)
  chartEl.append(crisp)

  // 重画后按上一次的指针位置补回十字线（宿主每分钟推一包，鼠标不用重新动）。
  if (chartPointer !== null) {
    paintCrosshair(view.crosshairAt(geometry, chartPointer.x, chartPointer.y))
  }
}

/**
 * 票 106：消息详情卡。数据全部来自纯视图（标题/正文/来源/影响/今日日程）；
 * 这里只负责填 DOM 与显隐，不自己拼文案、不自己算影响。
 */
function hideNewsDetail () {
  if (newsPopEl === null) return
  newsPopEl.hidden = true
}

function showNewsDetail (id) {
  if (lastBoard === null || newsPopEl === null) return
  const detail = view.newsDetailView(lastBoard, id)
  if (detail === null) {
    hideNewsDetail()
    return
  }
  newsPopTimeEl.textContent = detail.timeText + (detail.cropName === '' ? '' : ' · ' + detail.cropName)
  newsPopTitleEl.textContent = detail.title
  newsPopBodyEl.textContent = detail.body === '' ? '这条消息没有更多正文。' : detail.body
  newsPopSourceEl.textContent = detail.source === '' ? '来源未注明' : detail.source
  newsPopImpactEl.textContent = detail.magText
  const calendar = view.calendarView(lastBoard, Date.now()).slice(0, 5)
  newsPopCalendarEl.textContent = ''
  for (const row of calendar) {
    const item = document.createElement('li')
    const left = document.createElement('span')
    left.textContent = row.text
    const right = document.createElement('span')
    right.textContent = row.countdown
    item.append(left, right)
    newsPopCalendarEl.append(item)
  }
  const calendarBox = newsPopCalendarEl.parentElement
  if (calendarBox !== null) calendarBox.hidden = calendar.length === 0
  newsPopEl.hidden = false
  newsPopCloseEl.focus({ preventScroll: true })
}

/** 最近一次渲染出来的 board view：点击挂单时拿 view 算好的 target/band，不再自己解析一遍。 */
let lastBoard = null

function renderOrder (board) {
  const order = board.order
  sideRowEl.textContent = ''
  for (const choice of order.sides) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'chip' + (choice.side === 'short' ? ' short' : '')
    button.dataset.side = choice.side
    button.setAttribute('aria-pressed', choice.active ? 'true' : 'false')
    button.textContent = choice.label
    sideRowEl.append(button)
  }
  marginRowEl.textContent = ''
  for (const choice of order.margins) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'chip' + (choice.allIn ? ' all-in' : '')
    // 全下的金额每包都会变（可用硬币），所以 data-margin 记金额、data-all-in 记语义。
    button.dataset.margin = String(choice.margin)
    if (choice.allIn) button.dataset.allIn = 'true'
    button.setAttribute('aria-pressed', choice.active ? 'true' : 'false')
    button.disabled = choice.disabled
    button.textContent = choice.label
    // 票 89：禁用态给一个看得见的理由（按钮 title + 下方 order-hint 的「差 N 硬币」）。
    button.title = choice.disabled ? (choice.disabledReason ?? '') : ''
    marginRowEl.append(button)
  }
  leverageRowEl.textContent = ''
  for (const choice of order.leverages) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'chip'
    button.dataset.leverage = String(choice.leverage)
    button.setAttribute('aria-pressed', choice.active ? 'true' : 'false')
    button.textContent = choice.label
    leverageRowEl.append(button)
  }
  // 票 101：手续费写在杠杆旁边——下单当场就要看见，不能等结算才知道。
  const feeNote = document.createElement('span')
  feeNote.className = 'chip-note'
  feeNote.textContent = order.feeText
  feeNote.title = '开仓和平仓各收名义价值（保证金 × 杠杆）的 0.2%，结算时一次扣清。'
  leverageRowEl.append(feeNote)
  // 票 91：横条第二行只放「涨 1% +0.5 · 跌 1% −0.5 · 强平价 —」这一句；
  // 完整预览句（带杠杆/保证金）仍在 `order.preview` 里，给旧调用方和测试。
  previewEl.textContent = order.previewShort
  liquidationEl.textContent = order.liquidationText
  submitEl.textContent = pending && chartsPending === null ? '下单中…' : order.submitLabel
  submitEl.dataset.side = order.side
  submitEl.disabled = pending || !order.canSubmit
  orderHintEl.textContent = order.hint

  // 到价（票 83）：关着时只留一颗开关；点开后才出现目标价和挂单按钮。
  const limit = order.limit
  limitToggleEl.textContent = limit.toggleLabel
  limitToggleEl.setAttribute('aria-pressed', limitOpen ? 'true' : 'false')
  // 到价面板是浮层：aria-expanded 让它对读屏也是「展开/收起」，不是页面多了一块。
  limitToggleEl.setAttribute('aria-expanded', limitOpen ? 'true' : 'false')
  // 票 89：关着不写提示；开着只写可挂价格带（方向/自动撤单在 title 里）。
  limitToggleEl.title = limit.noteTitle
  limitNoteEl.textContent = limit.noteText
  limitBoxEl.hidden = !limitOpen
  limitHintEl.textContent = limit.hint
  limitPlaceEl.textContent = limit.placeLabel
  limitPlaceEl.disabled = pending || !limit.canPlace
  // 输入框正在打字时不要每包重设它的值（宿主每分钟会推一包，会吃掉半个数字）。
  if (document.activeElement !== limitInputEl && limitInputEl.value !== limit.targetText) {
    limitInputEl.value = limit.targetText
  }

  renderOrders(board)
}

/**
 * 到价挂单列表（票 83 / 票 89）：方向/作物/杠杆、目标价、保证金、距收盘的剩余时间 + 撤单。
 * 票 89 把它从下单区里搬出来：挂单列表跟持仓在左列同一个滚动区，有单才出现。
 * 票 91 下单变成图下横条后这条不变——横条里没有列表，挂单仍只活在左列。
 * 剩余时间每秒由 `tick()` 按 `data-until` 重算，重画整张列表会把焦点弄丢。
 */
function renderOrders (board) {
  // 票 89/91：挂单跟持仓一起滚（左列），没有单时整块不占高度；下单横条因此永远不滚。
  ordersWrapEl.hidden = board.orders.length === 0
  ordersEl.textContent = ''
  for (const row of board.orders) {
    const line = document.createElement('div')
    line.className = 'order-row'

    const main = document.createElement('div')
    main.className = 'row-main'
    const title = document.createElement('div')
    title.className = 'row-title'
    title.textContent = row.title
    const meta = document.createElement('div')
    meta.className = 'row-meta'
    meta.textContent = '到价 ' + row.targetText + ' · 保证金 ' + row.marginText
    const remaining = document.createElement('b')
    remaining.className = 'order-remaining'
    remaining.dataset.until = String((Number(row.remainingMs) || 0) + Date.now())
    remaining.textContent = row.remainingText
    main.append(title, meta, remaining)

    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'ghost order-cancel'
    cancel.dataset.cancel = row.id
    cancel.disabled = pending || !row.canCancel
    cancel.textContent = row.cancelLabel
    cancel.title = '撤掉这张挂单，保证金立刻退回硬币'

    line.append(main, cancel)
    ordersEl.append(line)
  }
  ordersMetaEl.textContent = board.ordersMetaText
}

function renderPositions (board) {
  positionsEl.textContent = ''
  for (const card of board.positions) {
    const row = document.createElement('div')
    row.className = 'position'

    const head = document.createElement('div')
    head.className = 'position-head'
    const title = document.createElement('div')
    title.className = 'position-title'
    title.textContent = card.title

    const right = document.createElement('div')
    right.className = 'position-side'
    const pnl = document.createElement('b')
    pnl.className = 'pnl'
    pnl.dataset.tone = card.pnlTone
    // 票 91：黑白模式给盈亏补 ▲/▼（颜色没了，方向还要能读）。
    pnl.textContent = board.display.mono ? card.pnlMonoText : card.pnlText
    const stop = document.createElement('button')
    stop.type = 'button'
    stop.className = 'ghost stop'
    stop.dataset.stop = card.id
    stop.dataset.nextStop = String(card.nextStopLevel)
    stop.setAttribute('aria-pressed', card.stopLevel === 0 ? 'false' : 'true')
    stop.disabled = !card.canStop
    stop.textContent = card.stopTitle
    stop.title = card.canStop
      ? '点一下切到下一档：关 / −25% / −50% / −100% 保证金'
      : '结算中，等一下'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ghost'
    close.dataset.close = card.id
    close.disabled = !card.canClose
    close.textContent = card.closeLabel
    close.title = card.canClose ? '按现价平仓' : '结算中，等一下'
    right.append(pnl, stop, close)
    head.append(title, right)

    // 元信息单独占一行：入场 / 现价 / 强平 / 保证金都要看得到，塞进标题行会折行。
    const meta = document.createElement('div')
    meta.className = 'position-meta'
    meta.textContent = '入场 ' + card.entryText + ' · 现价 ' + card.markText +
      ' · 强平 ' + card.liqText + ' · 保证金 ' + card.marginText +
      (card.settling ? ' · ' + card.statusText : '')

    row.append(head, meta)
    positionsEl.append(row)
  }
  // 挂单数量在持仓卡里的「到价挂单」小标题上，卡头不重复写一遍。
  positionsMetaEl.textContent = board.positionsMetaText
  positionsEmptyEl.hidden = board.positions.length > 0
  positionsEmptyEl.textContent = board.hints.positions
}

function renderHistory (board) {
  historyEl.textContent = ''
  for (const row of board.history) {
    const line = document.createElement('div')
    // 票 89：结算行压成一行（标题 + 价格/原因/时间 + 盈亏）；票 91 卡片高 88，超出内部滚。
    line.className = 'row history-row'

    const main = document.createElement('div')
    main.className = 'row-main'
    const title = document.createElement('div')
    title.className = 'row-title'
    title.textContent = row.title
    const meta = document.createElement('div')
    meta.className = 'row-meta'
    meta.textContent = row.entryText + ' → ' + row.exitText + ' · ' + row.reasonText + ' · ' + row.atText
    main.append(title, meta)

    const pnl = document.createElement('b')
    pnl.className = 'pnl'
    pnl.dataset.tone = row.pnlTone
    pnl.textContent = board.display.mono ? row.pnlMonoText : row.pnlText

    line.append(main, pnl)
    historyEl.append(line)
  }
  historyMetaEl.textContent = board.history.length + ' 笔'
  historyEmptyEl.hidden = board.history.length > 0
  historyEmptyEl.textContent = board.hints.history
}

/**
 * 真人周榜（票 82）：本机那一行高亮，右边是本周盈亏与收益率（没有就「—」），
 * 下面一行是持仓摘要（`多 2 · 空 1` / `观望`）。只有自己时在榜下补空态文案。
 * 排序、新鲜度、计数都由宿主算好，这里只画。
 */
function renderLeague (board) {
  const league = board.league
  leagueEl.textContent = ''
  for (const row of league.rows) {
    const line = document.createElement('div')
    line.className = 'row league-row' + (row.me ? ' me' : '')

    const main = document.createElement('div')
    main.className = 'row-main'
    const title = document.createElement('div')
    title.className = 'row-title'
    // 票 102：名次写在昵称前——榜是按收益率排的，名次比金币绝对值更该被看见。
    title.textContent = row.rank + '. ' + (row.me ? row.nickname + '（我）' : row.nickname)
    const meta = document.createElement('div')
    meta.className = 'row-meta'
    meta.textContent = row.positionsText
    // US19：持仓摘要下面再画一排 chip（作物 + 多/空 + 杠杆），最多 3 条 + 「+N」。
    if (row.chips.length > 0) {
      const chips = document.createElement('div')
      chips.className = 'league-chips'
      for (const chip of row.chips) {
        const item = document.createElement('span')
        item.className = 'league-chip'
        item.dataset.tone = chip.tone
        item.textContent = chip.text
        chips.append(item)
      }
      if (row.chipOverflowText !== '') {
        const more = document.createElement('span')
        more.className = 'league-chip more'
        more.textContent = row.chipOverflowText
        chips.append(more)
      }
      meta.append(chips)
    }
    main.append(title, meta)

    const score = document.createElement('div')
    score.className = 'league-score'
    // 票 102：主数字是**收益率**（排序键），金币退成副标题——本金大小不再等于名次。
    const pct = document.createElement('b')
    pct.className = 'league-pct'
    pct.dataset.tone = row.pctTone
    pct.textContent = board.display.mono ? row.pctMonoText : row.pctText
    const pnl = document.createElement('span')
    pnl.className = 'league-pnl'
    pnl.dataset.tone = row.pnlTone
    pnl.textContent = board.display.mono ? row.pnlMonoText : row.pnlText
    score.append(pct, pnl)

    line.append(main, score)
    leagueEl.append(line)
  }
  // 票 89：卡片头只留「情绪 观望」；「1 人」这种计数不再挤在标题行。
  sentimentEl.textContent = league.sentiment.text
  sentimentEl.dataset.tone = league.sentiment.tone
  // 只有自己：榜照画（自己那行），下面补一句「等邻居上线」。
  neighborEmptyEl.hidden = league.hasPeers
  neighborEmptyEl.textContent = league.empty
}

/**
 * 重画会把按钮整个换掉，焦点跟着 DOM 一起没了：键盘用户切一档就掉回文档开头。
 * 所以在重画前记下焦点是谁，画完按同一个「身份」放回去（找不到就算了）。
 */
function focusKeyOf (element) {
  if (element === null || element === undefined) return null
  if (element === submitEl) return 'submit'
  if (element === closeButton) return 'close-button'
  if (element === displayToggleEl) return 'display-toggle'
  if (element === cropPrevEl) return 'crop-prev'
  if (element === cropNextEl) return 'crop-next'
  if (element === limitToggleEl) return 'limit-toggle'
  if (element === limitInputEl) return 'limit-input'
  if (element === limitPlaceEl) return 'limit-place'
  const data = element.dataset ?? {}
  // 票 91：显示弹层的两组分段（重画后按 id 找回同一颗）。
  if (data.chartType !== undefined) return 'chart-type:' + data.chartType
  if (data.theme !== undefined) return 'theme:' + data.theme
  if (data.crop !== undefined) return 'crop:' + data.crop
  if (data.timeframe !== undefined) return 'timeframe:' + data.timeframe
  if (data.side !== undefined) return 'side:' + data.side
  // 「全下」的金额每包都变，用语义键记住焦点，别和同金额的预设按钮撞车。
  if (data.allIn === 'true') return 'margin:all-in'
  if (data.margin !== undefined) return 'margin:' + data.margin
  if (data.leverage !== undefined) return 'leverage:' + data.leverage
  if (data.stop !== undefined) return 'stop:' + data.stop
  if (data.close !== undefined) return 'close:' + data.close
  if (data.cancel !== undefined) return 'cancel:' + data.cancel
  return null
}

/** 焦点身份 → 回到哪个容器里找同名的按钮（`crop:tomato` → 作物条组里的 tomato）。 */
const FOCUS_ROOTS = {
  'chart-type': chartTypeOptionsEl,
  theme: themeOptionsEl,
  crop: cropTabsEl,
  timeframe: timeframeTabsEl,
  side: sideRowEl,
  margin: marginRowEl,
  leverage: leverageRowEl,
  stop: positionsEl,
  close: positionsEl,
  cancel: ordersEl
}

/**
 * 焦点键 → 真实控件（重画后按「身份」找回同一个按钮；找不到就 null）。
 * `margin:all-in` 是语义键：金额每包都变，不能拿金额去找。
 */
function focusElementOf (key) {
  if (key === null || key === undefined) return null
  if (key === 'submit') return submitEl
  if (key === 'close-button') return closeButton
  if (key === 'display-toggle') return displayToggleEl
  if (key === 'ticker') return tickerEl
  if (key === 'crop-prev') return cropPrevEl
  if (key === 'crop-next') return cropNextEl
  if (key === 'limit-toggle') return limitToggleEl
  if (key === 'limit-input') return limitInputEl
  if (key === 'limit-place') return limitPlaceEl
  if (key === 'margin:all-in') return marginRowEl.querySelector('[data-all-in="true"]')
  const separator = key.indexOf(':')
  if (separator <= 0) return null
  const kind = key.slice(0, separator)
  const value = key.slice(separator + 1)
  const root = FOCUS_ROOTS[kind]
  if (root === undefined) return null
  return root.querySelector('[data-' + kind + '="' + value + '"]')
}

function focusByKey (key) {
  const element = focusElementOf(key)
  if (element !== null) element.focus({ preventScroll: true })
}

/**
 * 作物条（票 89）：左右箭头按**真实滚动位置**禁用，两端渐隐跟着亮灭。
 * 纯视图的 `cropStripView().arrows` 只给首帧估算；DOM 量出来后以这里为准。
 * 箭头被禁用时如果焦点正好在它身上，把焦点交给另一颗箭头（或当前 chip），
 * 否则 Chrome 会把焦点丢回 body。实时更新只做这件事，不抢别的焦点。
 */
function updateCropArrows () {
  const max = cropScrollEl.scrollWidth - cropScrollEl.clientWidth
  const canLeft = max > 1 && cropScrollEl.scrollLeft > 1
  const canRight = max > 1 && cropScrollEl.scrollLeft < max - 1
  cropViewportEl.dataset.canLeft = canLeft ? 'true' : 'false'
  cropViewportEl.dataset.canRight = canRight ? 'true' : 'false'
  cropPrevEl.disabled = !canLeft
  cropNextEl.disabled = !canRight
  cropPrevEl.title = canLeft ? '上一组作物' : '已经是第一组'
  cropNextEl.title = canRight ? '下一组作物' : '已经是最后一组'
  if (cropPrevEl.disabled && document.activeElement === cropPrevEl) {
    const fallback = cropNextEl.disabled ? cropTabsEl.querySelector('[data-crop]') : cropNextEl
    if (fallback !== null) fallback.focus({ preventScroll: true })
  } else if (cropNextEl.disabled && document.activeElement === cropNextEl) {
    const fallback = cropPrevEl.disabled ? cropTabsEl.querySelector('[data-crop]') : cropPrevEl
    if (fallback !== null) fallback.focus({ preventScroll: true })
  }
}

/** 选中的 chip 滚进视野（只动作物条，不碰页面/焦点）。 */
function ensureCropVisible () {
  const chip = cropTabsEl.querySelector('[data-crop][aria-pressed="true"]')
  if (chip === null || cropScrollEl.clientWidth <= 0) return
  const left = chip.offsetLeft
  const right = left + chip.offsetWidth
  const viewLeft = cropScrollEl.scrollLeft
  const viewRight = viewLeft + cropScrollEl.clientWidth
  if (left < viewLeft + 6) {
    cropScrollEl.scrollLeft = Math.max(0, left - 6)
  } else if (right > viewRight - 6) {
    cropScrollEl.scrollLeft = right - cropScrollEl.clientWidth + 6
  }
}

/** 箭头翻一页（约 70% 视口宽）；用户要求减少动态时不滑。 */
function scrollCropsBy (direction) {
  const max = cropScrollEl.scrollWidth - cropScrollEl.clientWidth
  if (max <= 1) return
  const step = Math.max(120, Math.round(cropScrollEl.clientWidth * 0.7))
  const reduced = typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  cropScrollEl.scrollBy({ left: direction * step, behavior: reduced ? 'auto' : 'smooth' })
}

/**
 * 把 `view.focusOrder()` 的次序落到真实 DOM（评审 P2）：Tab 顺序不再只靠
 * 「HTML 谁先写谁先被 tab」，纯函数在 Node 里能断言，窗口重画后也照同一份走。
 * 顺序表覆盖了窗口里所有可聚焦控件；找不到的键（老包/列表为空）跳过。
 */
function applyTabOrder (payload) {
  let index = 0
  for (const key of view.focusOrder(payload)) {
    const element = focusElementOf(key)
    if (element === null) continue
    index += 1
    element.tabIndex = index
  }
}

/**
 * 票 90：这一屏要画的 payload——把当前作物缓存的图并进宿主最后推来的那份。
 * 缓存/推包里都没有就原样返回（视图画「正在加载」或空态），绝不自己编图。
 */
function renderPayload () {
  if (payload === null || typeof crop !== 'string' || crop === '') return payload
  const charts = view.chartsFor(payload, chartCache, crop)
  if (charts.timeframes === null) return payload
  return view.withCropCharts(payload, charts)
}

/**
 * 票 90：当前作物缺图就去问宿主。主进程同一时间只收一条申请，
 * 所以有别的申请在飞时只是把状态留在「加载中」，等回执后 `followUpCharts()` 再补。
 */
function requestCharts (cropId) {
  if (typeof cropId !== 'string' || cropId === '') return
  if (chartsPending === cropId) return
  if (pending || chartsPending !== null) return
  if (api === undefined || typeof api.submit !== 'function') {
    chartsLoading = false
    return
  }
  chartsPending = cropId
  submitAction({ action: 'trading-charts', cropId })
}

/** 推包/切作物/回执之后统一算一次：有图就退出加载态，没图就拉（失败过的这一种不自动重试）。 */
function ensureCharts () {
  if (payload === null || typeof crop !== 'string' || crop === '') {
    chartsLoading = false
    return
  }
  if (view.chartsFor(payload, chartCache, crop).timeframes !== null) {
    chartsLoading = false
    return
  }
  if (chartsFailed === crop) {
    chartsLoading = false
    return
  }
  chartsLoading = true
  requestCharts(crop)
}

/** 一条回执结束后再看一眼：用户可能在这期间又切了一种作物。 */
function followUpCharts () {
  if (pending || chartsPending !== null) return
  ensureCharts()
}

function render () {
  const focused = focusKeyOf(document.activeElement)
  const board = view.boardView(renderPayload(), {
    now: Date.now(),
    side,
    margin,
    leverage,
    crop,
    timeframe,
    limitOpen,
    targetText,
    allIn,
    chartsLoading,
    // 票 91：显示偏好只影响画法，不进宿主 payload。
    chartType: displayPrefs.chartType,
    theme: displayPrefs.theme
  })
  lastBoard = board
  renderDisplay(board.display)
  renderHeader(board)
  renderChart(board)
  renderOrder(board)
  renderPositions(board)
  renderHistory(board)
  renderLeague(board)
  // 选择可能被新一包换掉（白名单变了）：记住真实生效的值。
  side = board.order.side
  margin = board.order.margin
  leverage = board.order.leverage
  allIn = board.order.allIn
  // 票 90：还没收到任何一包时 `boardView` 用的是兜底白名单（番茄…），不能把它当成
  // 用户的选择——否则首包一到，窗口会去请求一种宿主根本没在看的作物。
  if (payload !== null) crop = board.chart.crop
  timeframe = board.chart.timeframe
  // Tab 顺序按纯视图给的逻辑顺序落到 tabindex（DOM 已全部建好）。
  applyTabOrder(payload)
  if (!focusedOnce && payload !== null) {
    focusedOnce = true
    // 首帧把焦点放在**当前作物**上（不是第一颗）：键盘 ←/→ 从正在看的那一种开始。
    const first = cropTabsEl.querySelector('[data-crop][aria-pressed="true"]') ??
      cropTabsEl.querySelector('[data-crop]')
    if (first !== null) first.focus({ preventScroll: true })
    return
  }
  focusByKey(focused)
}

function tick () {
  if (payload === null || barEnd <= 0) return
  const now = Date.now()
  const remaining = Math.max(0, barEnd - now)
  countdownEl.textContent = view.formatCountdown(remaining)
  // 挂单的剩余时间只改文本，不重画列表（重画会把「撤单」的焦点弄丢）。
  for (const element of ordersEl.querySelectorAll('[data-until]')) {
    const until = Number(element.dataset.until)
    if (!Number.isFinite(until)) continue
    element.textContent = '剩 ' + view.formatCountdown(Math.max(0, until - now))
  }
  if (remaining > 0 || refreshAsked) return
  // 到点了：让宿主结这一根、重推一拍（窗口不自己算收盘价）。
  refreshAsked = true
  submitAction({ action: 'trading-refresh' })
}

function showToast (text, kind = 'info') {
  const item = document.createElement('div')
  item.className = 'toast' + (kind === 'error' ? ' error' : '')
  item.textContent = text
  toastsEl.append(item)
  setTimeout(() => item.remove(), 2600)
}

/**
 * 唯一的提交口：`pending` 挡连点，主进程再用它自己的 pending 挡一次。
 * 成功不关窗（还要接着做下一单），失败弹一句人话。
 */
function submitAction (action) {
  if (pending) return
  if (api === undefined || typeof api.submit !== 'function') {
    showToast('桌面宿主没有连接，这次没有完成。', 'error')
    return
  }
  pending = true
  pendingAction = action !== null && typeof action?.action === 'string' ? action.action : null
  render()
  api.submit(action)
}

// 票 87：十字线只改 SVG 里的一个覆盖层，不重画整窗、不触发任何 IPC。
chartEl.addEventListener('pointermove', (event) => {
  if (chartGeometry === null) return
  const point = chartPointOf(event)
  if (point === null) return
  chartPointer = point
  paintCrosshair(view.crosshairAt(chartGeometry, point.x, point.y))
})

chartEl.addEventListener('pointerleave', () => {
  chartPointer = null
  paintCrosshair(null)
})

// 票 106：点有消息的 K 线打开详情卡；没有消息就什么都不做（不挡原来的十字线）。
chartEl.addEventListener('click', (event) => {
  if (chartGeometry === null) return
  const point = chartPointOf(event)
  if (point === null) return
  const hit = view.crosshairAt(chartGeometry, point.x, point.y)
  if (hit === null || !Array.isArray(hit.newsRows) || hit.newsRows.length === 0) return
  showNewsDetail(hit.newsRows[0].id)
  // 别让同一次点击冒泡到「外点关闭」——否则详情卡刚开就被自己关掉。
  event.stopPropagation()
})

tickerEl.addEventListener('click', (event) => {
  event.stopPropagation()
  if (lastBoard === null) return
  const id = lastBoard.chart !== null && lastBoard.chart !== undefined &&
    lastBoard.chart.ticker !== null && lastBoard.chart.ticker !== undefined
    ? lastBoard.chart.ticker.id
    : null
  if (typeof id === 'string' && id !== '') showNewsDetail(id)
})

newsPopCloseEl.addEventListener('click', () => {
  hideNewsDetail()
})

cropTabsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-crop]')
  if (button === null || button.dataset.crop === '') return
  if (button.dataset.crop !== crop) chartsFailed = null
  crop = button.dataset.crop
  hideNewsDetail()
  ensureCharts()
  render()
})

// 票 89：键盘 ←/→/Home/End 直接切作物（不用先 Tab 到 chip 再按空格）。
cropTabsEl.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' &&
    event.key !== 'Home' && event.key !== 'End') return
  const buttons = Array.from(cropTabsEl.querySelectorAll('[data-crop]'))
  if (buttons.length === 0) return
  const current = buttons.findIndex((button) => button.dataset.crop === crop)
  const index = current < 0 ? 0 : current
  let next = index
  if (event.key === 'ArrowLeft') next = Math.max(0, index - 1)
  else if (event.key === 'ArrowRight') next = Math.min(buttons.length - 1, index + 1)
  else if (event.key === 'Home') next = 0
  else next = buttons.length - 1
  event.preventDefault()
  if (next === index) return
  const id = buttons[next].dataset.crop
  if (id !== crop) chartsFailed = null
  crop = id
  ensureCharts()
  render()
  // 重画把 chip 换掉了：把焦点放回**新的**那一颗（render 里的 focusByKey 只认得旧键）。
  const target = Array.from(cropTabsEl.querySelectorAll('[data-crop]'))
    .find((button) => button.dataset.crop === id)
  if (target !== undefined) target.focus({ preventScroll: true })
  ensureCropVisible()
})

cropPrevEl.addEventListener('click', () => scrollCropsBy(-1))
cropNextEl.addEventListener('click', () => scrollCropsBy(1))
cropScrollEl.addEventListener('scroll', updateCropArrows, { passive: true })
// 鼠标滚轮在作物条上横滚（页面本身不滚；只有条真的溢出时才接管）。
cropScrollEl.addEventListener('wheel', (event) => {
  if (cropScrollEl.scrollWidth <= cropScrollEl.clientWidth) return
  const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
  if (delta === 0) return
  event.preventDefault()
  cropScrollEl.scrollLeft += delta
}, { passive: false })
window.addEventListener('resize', updateCropArrows)

// 票 84：切周期只换本地图，不重开窗、不请宿主刷新；结算是另一条路。
timeframeTabsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-timeframe]')
  if (button === null || button.disabled) return
  timeframe = button.dataset.timeframe
  render()
})

sideRowEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-side]')
  if (button === null || button.disabled) return
  side = button.dataset.side === 'short' ? 'short' : 'long'
  render()
})

marginRowEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-margin]')
  if (button === null || button.disabled) return
  // 「全下」的金额每包按可用硬币现算，所以只记语义；预设记具体金额。
  if (button.dataset.allIn === 'true') {
    allIn = true
  } else {
    allIn = false
    const chosen = Number(button.dataset.margin)
    if (Number.isFinite(chosen)) margin = chosen
  }
  render()
})

leverageRowEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-leverage]')
  if (button === null || button.disabled) return
  const chosen = Number(button.dataset.leverage)
  if (Number.isFinite(chosen)) leverage = chosen
  render()
})

// 票 91：显示弹层（图表类型 / 配色）。两组分段都是重画出来的按钮，监听挂在容器上。
displayToggleEl.addEventListener('click', () => {
  displayOpen = !displayOpen
  // 两片浮层不同时开：显示选项优先，到价面板让位（反过来同理）。
  if (displayOpen) limitOpen = false
  render()
  if (!displayOpen) {
    displayToggleEl.focus({ preventScroll: true })
    return
  }
  // 键盘用户打开弹层就落在当前选中的那一档，少按一次 Tab。
  const current = chartTypeOptionsEl.querySelector('[aria-pressed="true"]') ??
    chartTypeOptionsEl.querySelector('.seg')
  if (current !== null) current.focus({ preventScroll: true })
})

chartTypeOptionsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-chart-type]')
  if (button === null) return
  // 分段按钮会被下一次 render 换掉：先挡住 document 的「外点关闭」，
  // 否则 target 已经离开 DOM，弹层会刚选完就自己合上。
  event.stopPropagation()
  saveDisplayPrefs({ ...displayPrefs, chartType: button.dataset.chartType })
  render()
})

themeOptionsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-theme]')
  if (button === null) return
  event.stopPropagation()
  saveDisplayPrefs({ ...displayPrefs, theme: button.dataset.theme })
  render()
})

/** 输入框/文本域/可编辑区里不抢字母键（ADR-0029 同一条：先让用户把字打完）。 */
function isTextEntry (element) {
  if (element === null || element === undefined) return false
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
    return true
  }
  return element.isContentEditable === true
}

/** 改显示偏好：写本机存储 + 重画；不重开窗、不发任何 IPC。 */
function setDisplayPrefs (next) {
  saveDisplayPrefs(next)
  render()
}

limitToggleEl.addEventListener('click', () => {
  limitOpen = !limitOpen
  if (limitOpen) displayOpen = false
  render()
  // 点开就聚焦到目标价：键盘用户少按一次 Tab。浮层不推页面，不用再把它推进视野。
  if (limitOpen) limitInputEl.focus({ preventScroll: true })
})

limitInputEl.addEventListener('input', () => {
  // 原样保留输入（包括输入到一半的「5.」）；解析和能不能挂由 view 判。
  targetText = limitInputEl.value
  render()
})

limitPlaceEl.addEventListener('click', () => {
  if (limitPlaceEl.disabled || lastBoard === null) return
  const limit = lastBoard.order.limit
  if (limit.target === null) {
    showToast(limit.hint === '' ? '目标价要填一个大于 0 的数字。' : limit.hint, 'error')
    return
  }
  submitAction({
    action: 'trading-place-order',
    side,
    margin,
    leverage,
    cropId: crop,
    target: limit.target
  })
})

submitEl.addEventListener('click', () => {
  if (submitEl.disabled) return
  submitAction({ action: 'trading-open-position', side, margin, leverage, cropId: crop })
})

ordersEl.addEventListener('click', (event) => {
  const cancel = event.target.closest('[data-cancel]')
  if (cancel === null || cancel.disabled) return
  submitAction({ action: 'trading-cancel-order', orderId: cancel.dataset.cancel })
})

positionsEl.addEventListener('click', (event) => {
  const stop = event.target.closest('[data-stop]')
  if (stop !== null && !stop.disabled) {
    // 档位由 payload 的当前值算出来（view 的 nextStopLevel），窗口不自己数。
    const level = Number(stop.dataset.nextStop)
    submitAction({ action: 'trading-set-stop', positionId: stop.dataset.stop, level })
    return
  }
  const close = event.target.closest('[data-close]')
  if (close === null || close.disabled) return
  submitAction({ action: 'trading-close-position', positionId: close.dataset.close })
})

closeButton.addEventListener('click', () => api?.close())

// 票 91：Esc 先收弹层（显示 → 到价），都没有才关窗；旧行为（Esc 关窗）保留在最后一步。
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (!newsPopEl.hidden) {
      hideNewsDetail()
      return
    }
    if (displayOpen) {
      displayOpen = false
      render()
      displayToggleEl.focus({ preventScroll: true })
      return
    }
    if (limitOpen) {
      limitOpen = false
      render()
      limitToggleEl.focus({ preventScroll: true })
      return
    }
    api?.close()
    return
  }
  // L 切蜡烛/折线、M 切彩色/黑白：输入法合成、组合键、输入框聚焦时都不拦。
  if (event.isComposing === true || event.metaKey || event.ctrlKey || event.altKey) return
  if (isTextEntry(event.target)) return
  const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
  if (key === view.DISPLAY_SHORTCUTS.chartType) {
    event.preventDefault()
    setDisplayPrefs(view.toggleChartType(displayPrefs))
    return
  }
  if (key === view.DISPLAY_SHORTCUTS.theme) {
    event.preventDefault()
    setDisplayPrefs(view.toggleTheme(displayPrefs))
  }
})

// 弹层外点一下关闭（票 91）。监听 click 而不是 pointerdown：先让被点的控件跑完自己的
// 动作，再收弹层——否则第一次点外面会被“重画”吃掉，看起来像点不动。
document.addEventListener('click', (event) => {
  const target = event.target
  if (!newsPopEl.hidden && !newsPopEl.contains(target) && !tickerEl.contains(target) && target !== tickerEl) {
    hideNewsDetail()
    return
  }
  if (displayOpen && !displayPopEl.contains(target) && !displayToggleEl.contains(target)) {
    displayOpen = false
    render()
    return
  }
  if (limitOpen && !limitBoxEl.contains(target) && !limitToggleEl.contains(target)) {
    limitOpen = false
    render()
  }
})

api?.onState((next) => {
  if (next === null || typeof next !== 'object') return
  payload = next
  // 票 90：推包里带的图先收进缓存——宿主沿用的选择、以及刚拉过的那一种，
  // 切回来都能本地换图；新一包也可能正好带来用户等着的那一种。
  const pushedCrop = view.chartsCropOf(next)
  if (pushedCrop !== null) {
    const charts = view.chartsFromPayload(next, pushedCrop)
    if (charts !== null) chartCache.set(pushedCrop, charts)
  }
  // 新数据到了：之前拉图失败的那一种可以再试（不是同一个死循环）。
  chartsFailed = null
  // 倒计时基线：宿主给的是 epoch，窗口只减法算剩余；没有就退回 remainingMs。
  const end = Number(next.bar?.end)
  barEnd = Number.isFinite(end) && end > 0
    ? end
    : Date.now() + Math.max(0, Number(next.bar?.remainingMs) || 0)
  refreshAsked = false
  ensureCharts()
  render()
})

api?.onResult((result) => {
  const sentAction = pendingAction
  pending = false
  pendingAction = null
  if (result === null || typeof result !== 'object') {
    followUpCharts()
    render()
    return
  }
  // 票 90：按需拉图的回执——把图并进缓存，当前屏再重画一次。
  if (sentAction === 'trading-charts') {
    chartsPending = null
    const cropId = typeof result.crop === 'string' ? result.crop : null
    if (result.ok === true && cropId !== null &&
      result.timeframes !== null && typeof result.timeframes === 'object') {
      chartCache.set(cropId, { timeframes: result.timeframes, hint: result.hint ?? null, news: result.news ?? null })
      chartsFailed = null
    } else {
      // 这一种拉不到（坏作物/超时）：先退出加载态，别让风扇一直转；用户再点一下可以重试。
      chartsFailed = cropId ?? crop
    }
    if (result.ok === true) {
      render()
      followUpCharts()
      return
    }
    render()
    const notice = typeof result.notice === 'string' && result.notice.trim() !== ''
      ? result.notice
      : (RESULT_CODE_TEXT[result.code] ?? '这张图没有拉下来，稍后再试。')
    showToast(notice, 'error')
    followUpCharts()
    render()
    return
  }
  if (result.ok === true) {
    const notice = typeof result.notice === 'string' && result.notice.trim() !== ''
      ? result.notice
      : '完成了。'
    render()
    followUpCharts()
    // 成功不关窗：宿主紧接着会推一份新视图（硬币/持仓都变了）。
    showToast(notice)
    return
  }
  render()
  const notice = typeof result.notice === 'string' && result.notice.trim() !== ''
    ? result.notice
    : (RESULT_CODE_TEXT[result.code] ?? '这次没有完成，稍后再试。')
  showToast(notice, 'error')
  followUpCharts()
  render()
})

// 切走/失焦后 interval 可能被节流；回来先按真实时间补一帧。
window.addEventListener('focus', () => {
  tick()
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  tick()
})

render()
setInterval(tick, 1000)
api?.ready()
