/**
 * 盘口小窗的渲染端（票 79 / 票 81 / 票 82）。
 *
 * 它只做三件事：把宿主推来的盘口视图画成卡片（K 线、下单、持仓、历史、周盈亏、真人周榜）；
 * 每秒本地递减收盘倒计时（到 0 请宿主结这一根并重推一拍）；
 * 把「开仓 / 止损 / 平仓」当**申请**交给主进程。
 * 价格、硬币、盈亏、能不能下单全部由宿主算，成功与否也等宿主回执——
 * 窗口不自己改状态、不自己算钱，也不自己算价（K 线几何在 `trading-view.js` 里，
 * 这里只把 view 给的坐标画成 SVG 元素）。
 *
 * 键盘：Tab 顺序就是 DOM 顺序（作物页签 → 方向 → 保证金 → 杠杆 → 开一手 → 每手仓位
 * 的止损/平仓）；Enter/Space 是原生按钮行为；Esc 关窗。窗口失焦**不**关窗
 * （macOS 中文输入法候选窗会抢焦点，农场窗踩过这个坑）。
 */
'use strict'

const api = window.dshZooBoard
const view = window.dshZooBoardView
const SVG_NS = 'http://www.w3.org/2000/svg'

const titleEl = document.getElementById('board-title')
const subtitleEl = document.getElementById('board-subtitle')
const weekPnlEl = document.getElementById('week-pnl')
const weekPctEl = document.getElementById('week-pct')
const countdownEl = document.getElementById('countdown')
const coinsAvailableEl = document.getElementById('coins-available')
const coinsTotalEl = document.getElementById('coins-total')
const cropTabsEl = document.getElementById('crop-tabs')
const chartPriceEl = document.getElementById('chart-price')
const chartChangeEl = document.getElementById('chart-change')
const windEl = document.getElementById('wind')
const chartEl = document.getElementById('chart')
const chartEmptyEl = document.getElementById('chart-empty')
const legendEl = document.getElementById('legend')
const slotNoteEl = document.getElementById('slot-note')
const orderCropEl = document.getElementById('order-crop')
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
const limitBandEl = document.getElementById('limit-band')
const limitHintEl = document.getElementById('limit-hint')
const limitPlaceEl = document.getElementById('limit-place')
const ordersEl = document.getElementById('orders')
const ordersMetaEl = document.getElementById('orders-meta')
const ordersEmptyEl = document.getElementById('orders-empty')
const positionsEl = document.getElementById('positions')
const positionsMetaEl = document.getElementById('positions-meta')
const positionsEmptyEl = document.getElementById('positions-empty')
const historyEl = document.getElementById('history')
const historyMetaEl = document.getElementById('history-meta')
const historyEmptyEl = document.getElementById('history-empty')
const leagueEl = document.getElementById('league')
const leagueCountEl = document.getElementById('league-count')
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

/** 宿主推来的最后一份视图；null = 还没收到（窗口先画空态）。 */
let payload = null
/** 当前选择（只活在窗口里，开仓成功后保持不变，方便连做）。 */
let side = 'long'
let margin = 50
let leverage = 1
let crop = null
/** 票 83：保证金选的是不是「全下」（金额每包按可用硬币现算，所以只记这个布尔）。 */
let allIn = false
/** 到价面板开没开；关着时输入框和挂单按钮不出现（SPEC：下单区只在点开「到价」时出现）。 */
let limitOpen = false
/** 玩家在目标价输入框里打的原文；空 = 用现价当默认值。 */
let targetText = ''
/** 有申请在飞：连点不会串单（主进程也会挡，这里只是立刻反馈）。 */
let pending = false
/** 这一根的收盘时刻（本地倒计时基线，每次宿主推包都重置）。 */
let barEnd = 0
/** 这一根已经问过「到点了，重推一拍」没有；每根只问一次。 */
let refreshAsked = false
/** 第一次收到数据时把焦点放到第一个控件上（窗口刚弹出，键盘就能用）。 */
let focusedOnce = false

function setTone (element, tone) {
  element.dataset.tone = tone
}

function svgEl (tag, attrs = {}) {
  const element = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value))
  return element
}

function renderHeader (board) {
  const header = board.header
  titleEl.textContent = header.cropName === '—' ? '盘口' : '盘口 · ' + header.cropName
  subtitleEl.textContent = '15 分钟合约 · 收盘自动结算'
  countdownEl.textContent = header.countdownText
  coinsAvailableEl.textContent = header.coinsAvailableText
  coinsTotalEl.textContent = header.coinsTotalText
  weekPnlEl.textContent = board.week.pnlText
  setTone(weekPnlEl, board.week.pnlTone)
  weekPctEl.textContent = board.week.pctText
  orderCropEl.textContent = board.order.cropName
}

function renderChart (board) {
  const chart = board.chart
  cropTabsEl.textContent = ''
  for (const choice of board.crops) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'crop-tab'
    button.dataset.crop = choice.id ?? ''
    button.setAttribute('aria-pressed', choice.active ? 'true' : 'false')
    button.textContent = choice.label
    cropTabsEl.append(button)
  }
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

  legendEl.textContent = ''
  for (const entry of chart.legend) {
    const item = document.createElement('span')
    const mark = document.createElement('i')
    mark.className = entry.tone
    const value = document.createElement('b')
    value.textContent = entry.text
    item.append(mark, document.createTextNode(entry.label + ' '), value)
    legendEl.append(item)
  }

  // K 线：view 给的已经是 viewBox 坐标，这里只建元素，不做任何换算。
  chartEl.textContent = ''
  chartEmptyEl.hidden = chart.hasChart
  chartEl.hidden = !chart.hasChart
  const geometry = chart.geometry
  if (geometry === null) {
    chartEmptyEl.textContent = chart.emptyText
    return
  }
  chartEl.setAttribute('viewBox', '0 0 ' + geometry.width + ' ' + geometry.height)
  for (const y of geometry.grid) {
    chartEl.append(svgEl('line', {
      class: 'grid',
      x1: geometry.plot.left,
      x2: geometry.plot.left + geometry.plot.width,
      y1: y,
      y2: y,
      'vector-effect': 'non-scaling-stroke'
    }))
  }
  for (const line of geometry.lines) {
    if (line.visible !== true) continue
    chartEl.append(svgEl('line', {
      class: 'ref',
      'data-key': line.key,
      x1: geometry.plot.left,
      x2: geometry.plot.left + geometry.plot.width,
      y1: line.y,
      y2: line.y,
      'vector-effect': 'non-scaling-stroke'
    }))
  }
  if (geometry.priceLine !== null) {
    chartEl.append(svgEl('line', {
      class: 'price-line',
      x1: geometry.plot.left,
      x2: geometry.plot.left + geometry.plot.width,
      y1: geometry.priceLine.y,
      y2: geometry.priceLine.y,
      'vector-effect': 'non-scaling-stroke'
    }))
  }
  const candles = geometry.forming === null ? geometry.bars : geometry.bars.concat([geometry.forming])
  for (const candle of candles) {
    const tone = candle.up ? 'up' : 'down'
    chartEl.append(svgEl('line', {
      class: 'wick ' + tone,
      x1: candle.centerX,
      x2: candle.centerX,
      y1: candle.wickTop,
      y2: candle.wickBottom,
      'vector-effect': 'non-scaling-stroke'
    }))
    const body = svgEl('rect', {
      class: 'body ' + tone + (candle === geometry.forming ? ' forming' : ''),
      x: candle.x,
      y: candle.bodyTop,
      width: candle.width,
      height: candle.bodyHeight,
      rx: 1
    })
    chartEl.append(body)
  }
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
  previewEl.textContent = order.preview
  // 强平价单独一行（US7）：预览句保持 SPEC v10 的原文不动。
  liquidationEl.textContent = order.liquidationText
  submitEl.textContent = pending ? '下单中…' : order.submitLabel
  submitEl.dataset.side = order.side
  submitEl.disabled = pending || !order.canSubmit
  orderHintEl.textContent = order.hint

  // 到价（票 83）：关着时只留一颗开关；点开后才出现目标价和挂单按钮。
  const limit = order.limit
  limitToggleEl.textContent = limit.toggleLabel
  limitToggleEl.setAttribute('aria-pressed', limitOpen ? 'true' : 'false')
  limitNoteEl.textContent = limitOpen ? '开：到价才成交，收盘没成交自动撤' : '关：直接按现价开仓'
  limitBoxEl.hidden = !limitOpen
  limitBandEl.textContent = limit.bandText === '' ? '' : '可挂 ' + limit.bandText
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
 * 到价挂单列表（票 83）：方向/作物/杠杆、目标价、保证金、距收盘的剩余时间 + 撤单。
 * 剩余时间每秒由 `tick()` 按 `data-until` 重算，重画整张列表会把焦点弄丢。
 */
function renderOrders (board) {
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
  ordersEmptyEl.hidden = board.orders.length > 0
  ordersEmptyEl.textContent = board.hints.orders
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
    pnl.textContent = card.pnlText
    const stop = document.createElement('button')
    stop.type = 'button'
    stop.className = 'ghost stop'
    stop.dataset.stop = card.id
    stop.dataset.nextStop = String(card.nextStopLevel)
    stop.setAttribute('aria-pressed', card.stopLevel === 0 ? 'false' : 'true')
    stop.disabled = !card.canStop
    stop.textContent = card.stopTitle
    stop.title = '点一下切到下一档：关 / −25% / −50% / −100% 保证金'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ghost'
    close.dataset.close = card.id
    close.disabled = !card.canClose
    close.textContent = card.closeLabel
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
  positionsMetaEl.textContent = board.positionsMetaText
  positionsEmptyEl.hidden = board.positions.length > 0
  positionsEmptyEl.textContent = board.hints.positions
}

function renderHistory (board) {
  historyEl.textContent = ''
  for (const row of board.history) {
    const line = document.createElement('div')
    line.className = 'row'

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
    pnl.textContent = row.pnlText

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
    title.textContent = row.me ? row.nickname + '（我）' : row.nickname
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
    const pnl = document.createElement('b')
    pnl.className = 'pnl'
    pnl.dataset.tone = row.pnlTone
    pnl.textContent = row.pnlText
    const pct = document.createElement('span')
    pct.className = 'league-pct'
    pct.dataset.tone = row.pctTone
    pct.textContent = row.pctText
    score.append(pnl, pct)

    line.append(main, score)
    leagueEl.append(line)
  }
  leagueCountEl.textContent = league.countText
  sentimentEl.textContent = league.sentiment.text
  sentimentEl.dataset.tone = league.sentiment.tone
  // 只有自己：榜照画（自己那行），下面补一句「还没有邻居上线…行情照走」。
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
  if (element === limitToggleEl) return 'limit-toggle'
  if (element === limitInputEl) return 'limit-input'
  if (element === limitPlaceEl) return 'limit-place'
  const data = element.dataset ?? {}
  if (data.crop !== undefined) return 'crop:' + data.crop
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

/** 焦点身份 → 回到哪个容器里找同名的按钮（`crop:tomato` → 页签组里的 tomato）。 */
const FOCUS_ROOTS = {
  crop: cropTabsEl,
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

function render () {
  const focused = focusKeyOf(document.activeElement)
  const board = view.boardView(payload, {
    now: Date.now(),
    side,
    margin,
    leverage,
    crop,
    limitOpen,
    targetText,
    allIn
  })
  lastBoard = board
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
  crop = board.chart.crop
  // Tab 顺序按纯视图给的逻辑顺序落到 tabindex（DOM 已全部建好）。
  applyTabOrder(payload)
  if (!focusedOnce && payload !== null) {
    focusedOnce = true
    const first = cropTabsEl.querySelector('[data-crop]')
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
  render()
  api.submit(action)
}

cropTabsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-crop]')
  if (button === null || button.dataset.crop === '') return
  crop = button.dataset.crop
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

limitToggleEl.addEventListener('click', () => {
  limitOpen = !limitOpen
  render()
  // 点开就聚焦到目标价：键盘用户少按一次 Tab（输入框此前是 hidden，焦点本来也不在那儿）。
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

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  api?.close()
})

api?.onState((next) => {
  if (next === null || typeof next !== 'object') return
  payload = next
  // 倒计时基线：宿主给的是 epoch，窗口只减法算剩余；没有就退回 remainingMs。
  const end = Number(next.bar?.end)
  barEnd = Number.isFinite(end) && end > 0
    ? end
    : Date.now() + Math.max(0, Number(next.bar?.remainingMs) || 0)
  refreshAsked = false
  render()
})

api?.onResult((result) => {
  pending = false
  if (result === null || typeof result !== 'object') {
    render()
    return
  }
  if (result.ok === true) {
    const notice = typeof result.notice === 'string' && result.notice.trim() !== ''
      ? result.notice
      : '完成了。'
    render()
    // 成功不关窗：宿主紧接着会推一份新视图（硬币/持仓都变了）。
    showToast(notice)
    return
  }
  render()
  const notice = typeof result.notice === 'string' && result.notice.trim() !== ''
    ? result.notice
    : (RESULT_CODE_TEXT[result.code] ?? '这次没有完成，稍后再试。')
  showToast(notice, 'error')
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
