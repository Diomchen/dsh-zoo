/**
 * 农场小窗的渲染端（ticket 40 / 41）。
 *
 * 它只做三件事：把宿主推来的完整 farm view 画成 4 块地；每秒本地递减倒计时；
 * 把「种 / 收 / 浇 / 施肥 / 买种 / 卖作物」当**申请**交给主进程。仓库、硬币、成熟与否、
 * 单价与总价全部由宿主算，成功与否也等宿主回执——窗口不自己改状态。
 */
'use strict'

const api = window.dshZooFarm
const plotsEl = document.getElementById('plots')
const inventoryEl = document.getElementById('inventory')
const logEl = document.getElementById('log')
const marketRowsEl = document.getElementById('market-rows')
const tradesEl = document.getElementById('trades')
const marketWalletEl = document.getElementById('market-wallet')
const farmPageEl = document.getElementById('page-farm')
const marketPageEl = document.getElementById('page-market')
const tabs = Array.from(document.querySelectorAll('.tab[data-tab]'))
const subtitleEl = document.getElementById('subtitle')
const toastEl = document.getElementById('toast')
const closeButton = document.getElementById('close')

const CROP_META = {
  tomato: { name: '小番茄', emoji: '🍅', seedPrice: 6, base: 5 },
  carrot: { name: '胡萝卜', emoji: '🥕', seedPrice: 14, base: 6 },
  pumpkin: { name: '南瓜', emoji: '🎃', seedPrice: 36, base: 30 }
}
const CROP_IDS = Object.keys(CROP_META)
const PLOT_LABEL = { 1: '地块 1', 2: '地块 2', 3: '地块 3', 4: '地块 4' }
const WATER_COST = 1
const FERTILIZE_COST = 5
const MIN_TRADE_QTY = 1
const MAX_TRADE_QTY = 99

/**
 * 主进程只会用错误码回传传输层失败（超时/管道断/坏形状）；宿主给的 notice 已经是人话，
 * 优先显示它。这些码不是产品文案，只是窗口的兜底。
 */
const RESULT_CODE_TEXT = {
  timeout: '桌面宿主没有回应，这次操作可能没有生效。',
  'host-unavailable': '桌面宿主没有连接，这次没有完成。',
  'bad-farm-action': '这个操作缺少地块或作物，再试一次。',
  'bad-plot': '这块地不在了，刷新后再试。',
  'bad-crop': '这种作物种不了，换一种吧。',
  'bad-qty': '数量要在 1–99 之间。',
  'plot-occupied': '这块地已经种上了，先收掉再种。',
  'not-mature': '还没熟呢，再等一会儿。',
  'no-seed': '没有这种种子或作物了。',
  'no-coin': '硬币不够，先去卖点作物。',
  cap: '仓库装不下了，先卖掉一点再来。',
  'market-busy': '交易所这会儿太忙了，等一下再试。',
  'no-dew': '露水不够，先让宠物待机攒一会儿。',
  'already-watered': '这株已经浇过水了。',
  'already-fertilized': '这株已经施过肥了。'
}
const LOG_TEXT = {
  plant: '种下',
  harvest: '收获',
  steal: '被偷',
  help: '帮忙',
  hire: '雇工',
  settle: '结算'
}
const MARKET_SIDE_TEXT = { buy: '买种', sell: '卖出' }

let farm = null
let market = null
let selectedPlot = null
let busy = false
let toastTimer = null
let activeTab = 'farm'
/** 每种作物上一次输入的数量；宿主刷新价目时不把用户刚填的数字吞掉。 */
const marketQty = { tomato: 1, carrot: 1, pumpkin: 1 }
/** plotId → 倒计时节点；tick 只改文本，不重建按钮（重建会打断用户点击）。 */
const countdowns = new Map()

function cropMeta (cropId) {
  return CROP_META[cropId] ?? null
}

function plotName (plot) {
  const index = Number(String(plot.id).replace(/^p/, ''))
  return PLOT_LABEL[index] ?? '地块'
}

function formatRemaining (ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000))
  if (total <= 0) return '马上就好'
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return hours + ' 时 ' + minutes + ' 分'
  if (minutes > 0) return minutes + ' 分 ' + seconds + ' 秒'
  return seconds + ' 秒'
}

function formatTime (at) {
  const value = Number(at)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number) => String(number).padStart(2, '0')
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function showToast (text, tone = 'ok') {
  if (typeof text !== 'string' || text.trim() === '') return
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastEl.textContent = text.trim()
  toastEl.dataset.tone = tone
  toastEl.hidden = false
  toastTimer = setTimeout(() => {
    toastEl.hidden = true
    toastTimer = null
  }, tone === 'error' ? 4200 : 2400)
}

function hideToast () {
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = null
  toastEl.hidden = true
}

function button (label, options = {}) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'btn' + (options.className === undefined ? '' : ' ' + options.className)
  el.textContent = label
  el.dataset.plotId = options.plotId ?? ''
  el.dataset.plotAction = options.action ?? ''
  if (options.cropId !== undefined) el.dataset.cropId = options.cropId
  if (options.disabled === true) {
    el.disabled = true
    el.title = options.reason ?? ''
  }
  return el
}

function renderPlots () {
  plotsEl.textContent = ''
  countdowns.clear()
  if (farm === null) {
    const message = document.createElement('p')
    message.className = 'empty'
    message.textContent = '农场数据还没到，等宿主推过来…'
    plotsEl.appendChild(message)
    return
  }
  const plots = Array.isArray(farm.plots) ? farm.plots : []
  for (const plot of plots) {
    const meta = cropMeta(plot.crop)
    const card = document.createElement('article')
    card.className = 'plot'
    card.dataset.stage = plot.stage
    card.dataset.plot = plot.id
    if (plot.id === selectedPlot) card.dataset.selected = 'true'

    const head = document.createElement('div')
    head.className = 'plot-head'
    const name = document.createElement('span')
    name.textContent = plotName(plot)
    head.appendChild(name)
    const badge = document.createElement('span')
    badge.className = 'badge' + (plot.stage === 'mature' ? ' mature' : '')
    badge.textContent = plot.stage === 'mature' ? '熟了' : plot.stage === 'growing' ? '生长中' : '空地'
    head.appendChild(badge)
    card.appendChild(head)

    const body = document.createElement('div')
    body.className = 'plot-body'
    const icon = document.createElement('span')
    icon.className = 'crop-icon' + (plot.stage === 'empty' ? ' empty' : ' growing')
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = meta === null ? '🟫' : meta.emoji
    body.appendChild(icon)

    const info = document.createElement('div')
    info.className = 'plot-info'
    const headline = document.createElement('strong')
    headline.textContent = meta === null ? '空地' : meta.name
    info.appendChild(headline)
    const detail = document.createElement('span')
    if (plot.stage === 'empty') {
      detail.textContent = '选一种种子种下'
    } else if (plot.stage === 'mature') {
      detail.textContent = '已经成熟，可以收了'
    } else {
      detail.textContent = '还要 '
      const countdown = document.createElement('span')
      countdown.className = 'countdown'
      countdown.textContent = formatRemaining(plot.remainingMs)
      detail.appendChild(countdown)
      countdowns.set(plot.id, countdown)
    }
    info.appendChild(detail)
    body.appendChild(info)
    card.appendChild(body)

    const actions = document.createElement('div')
    actions.className = 'plot-actions'
    if (plot.stage === 'empty') {
      for (const cropId of CROP_IDS) {
        const seeds = Number(farm.seeds?.[cropId]) || 0
        actions.appendChild(button(
          CROP_META[cropId].emoji + ' ' + CROP_META[cropId].name,
          {
            plotId: plot.id,
            cropId,
            action: 'plant',
            className: 'primary',
            disabled: busy || seeds <= 0,
            reason: seeds <= 0 ? '没有这种种子了' : ''
          }
        ))
      }
    } else if (plot.stage === 'mature') {
      actions.appendChild(button('收获', {
        plotId: plot.id,
        action: 'harvest',
        className: 'harvest',
        disabled: busy
      }))
      actions.appendChild(button('施肥', {
        plotId: plot.id,
        action: 'fertilize',
        disabled: busy || plot.fertilized === true || (Number(farm.dew) || 0) < FERTILIZE_COST,
        reason: plot.fertilized === true
          ? '已经施过肥了'
          : '露水不够（需要 ' + FERTILIZE_COST + '）'
      }))
    } else {
      actions.appendChild(button('浇水', {
        plotId: plot.id,
        action: 'water',
        disabled: busy || plot.waterings >= 1 || (Number(farm.dew) || 0) < WATER_COST,
        reason: plot.waterings >= 1
          ? '这株已经浇过水了'
          : '露水不够（需要 ' + WATER_COST + '）'
      }))
      actions.appendChild(button('施肥', {
        plotId: plot.id,
        action: 'fertilize',
        disabled: busy || plot.fertilized === true || (Number(farm.dew) || 0) < FERTILIZE_COST,
        reason: plot.fertilized === true
          ? '已经施过肥了'
          : '露水不够（需要 ' + FERTILIZE_COST + '）'
      }))
    }
    card.appendChild(actions)
    plotsEl.appendChild(card)
  }
}

function renderInventory () {
  inventoryEl.textContent = ''
  if (farm === null) return
  const row = (label, value) => {
    const rowEl = document.createElement('div')
    rowEl.className = 'row'
    const labelEl = document.createElement('span')
    labelEl.className = 'label'
    labelEl.textContent = label
    rowEl.appendChild(labelEl)
    for (const [name, count] of value) {
      const valueEl = document.createElement('span')
      valueEl.className = 'value'
      valueEl.textContent = name + ' ' + count
      rowEl.appendChild(valueEl)
    }
    inventoryEl.appendChild(rowEl)
  }
  row('种子', CROP_IDS.map((cropId) => [CROP_META[cropId].name, Number(farm.seeds?.[cropId]) || 0]))
  row('作物', CROP_IDS.map((cropId) => [CROP_META[cropId].name, Number(farm.crops?.[cropId]) || 0]))
  row('钱包', [['🪙 硬币', Number(farm.coins) || 0], ['💧 露水', Number(farm.dew) || 0]])
  if (farm.worker !== null && typeof farm.worker === 'object') {
    row('雇工', [[String(farm.worker.nickname ?? '邻居'), '打工中']])
  }
}

function renderLog () {
  logEl.textContent = ''
  const entries = farm === null || !Array.isArray(farm.log) ? [] : farm.log.slice(0, 8)
  if (entries.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = '还没有记录。'
    logEl.appendChild(empty)
    return
  }
  for (const entry of entries) {
    const item = document.createElement('li')
    const text = document.createElement('span')
    const crop = cropMeta(entry.crop)
    const kind = LOG_TEXT[entry.kind] ?? '动作'
    text.textContent = kind + (crop === null ? '' : ' ' + crop.name) +
      (Number(entry.qty) > 0 && entry.kind !== 'plant' ? ' ×' + entry.qty : '')
    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = formatTime(entry.at)
    item.appendChild(text)
    item.appendChild(when)
    logEl.appendChild(item)
  }
}

function readMarketQty (cropId) {
  const value = Number(marketQty[cropId])
  if (!Number.isInteger(value) || value < MIN_TRADE_QTY || value > MAX_TRADE_QTY) return null
  return value
}

function marketEntry (cropId) {
  const entry = market?.prices?.[cropId]
  return entry !== null && typeof entry === 'object' ? entry : null
}

function bidOf (entry) {
  const bid = Number(entry?.bid)
  if (Number.isFinite(bid) && bid >= 0) return Math.round(bid)
  const price = Number(entry?.price)
  return Number.isFinite(price) ? Math.round(price * 0.9) : 0
}

function latestTrade (cropId) {
  if (!Array.isArray(market?.history)) return null
  return market.history.find((entry) => entry.crop === cropId) ?? null
}

/** 局域网指数（ticket 42）：宿主已经按自己的时钟判好 stale，窗口只画。 */
function marketIndexEntry (cropId) {
  const entry = market?.index?.[cropId]
  return entry !== null && typeof entry === 'object' ? entry : null
}

function formatMarketPrice (value) {
  const price = Number(value)
  if (!Number.isFinite(price)) return '—'
  return String(Math.round(price * 10) / 10)
}

function updateMarketTotals (row, cropId) {
  if (row === null) return
  const input = row.querySelector('input[data-crop-qty]')
  const totalEl = row.querySelector('[data-total]')
  const buyButton = row.querySelector('button[data-market-action="buy"]')
  const sellButton = row.querySelector('button[data-market-action="sell"]')
  const qty = Number(input?.value)
  const valid = Number.isInteger(qty) && qty >= MIN_TRADE_QTY && qty <= MAX_TRADE_QTY
  const meta = CROP_META[cropId]
  const entry = marketEntry(cropId)
  const bid = bidOf(entry)
  if (!valid) {
    if (totalEl !== null) totalEl.textContent = '数量 1–99'
    if (buyButton !== null) buyButton.disabled = true
    if (sellButton !== null) sellButton.disabled = true
    return
  }
  const seedTotal = meta.seedPrice * qty
  if (totalEl !== null) {
    totalEl.textContent = '买 ' + seedTotal + ' · 卖 ' + (bid * qty)
  }
  const coins = Number(farm?.coins) || 0
  const seeds = Number(farm?.seeds?.[cropId]) || 0
  const crops = Number(farm?.crops?.[cropId]) || 0
  // 服务端仍会再验一遍；这里只把明显不可能的按钮灰掉，少一次失败 toast。
  if (buyButton !== null) buyButton.disabled = busy || coins < seedTotal || seeds + qty > 999
  if (sellButton !== null) sellButton.disabled = busy || crops < qty
}

function renderMarket () {
  marketRowsEl.textContent = ''
  tradesEl.textContent = ''
  marketWalletEl.textContent = '🪙 ' + (Number(farm?.coins) || 0) + ' · 永远有流动性'
  if (market === null) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = '交易所数据还没到，等宿主推过来…'
    marketRowsEl.appendChild(empty)
    return
  }

  for (const cropId of CROP_IDS) {
    const meta = CROP_META[cropId]
    const entry = marketEntry(cropId) ?? { base: meta.base, price: meta.base }
    const last = latestTrade(cropId)
    const row = document.createElement('article')
    row.className = 'market-row'
    row.dataset.cropId = cropId

    const head = document.createElement('div')
    head.className = 'market-row-head'
    const emoji = document.createElement('span')
    emoji.className = 'emoji'
    emoji.setAttribute('aria-hidden', 'true')
    emoji.textContent = meta.emoji
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = meta.name
    const lastEl = document.createElement('span')
    lastEl.className = 'last'
    lastEl.textContent = last === null
      ? '还没成交'
      : MARKET_SIDE_TEXT[last.side] + ' ×' + last.qty + ' · ' + formatTime(last.at)
    head.appendChild(emoji)
    head.appendChild(name)
    head.appendChild(lastEl)
    row.appendChild(head)

    const stats = document.createElement('div')
    stats.className = 'market-stats'
    const stat = (label, value, className = '') => {
      const span = document.createElement('span')
      if (className !== '') span.className = className
      span.textContent = label + ' '
      const strong = document.createElement('b')
      strong.textContent = String(value)
      span.appendChild(strong)
      stats.appendChild(span)
    }
    stat('底价', entry.base ?? '—')
    stat('本机卖价', bidOf(entry))
    // 交易所页的「局域网指数」列：没有邻居样本时明确写「本机行情」；
    // 有样本但超过 2 分钟没更新时灰掉（值仍是最后一次算出的中位数）。
    const indexEntry = marketIndexEntry(cropId)
    if (indexEntry === null) {
      stat('局域网指数', '本机行情', 'index-local')
    } else {
      const samples = Number(indexEntry.samples)
      const suffix = Number.isFinite(samples) && samples > 0 ? ' · ' + Math.floor(samples) + ' 份' : ''
      stat(
        '局域网指数',
        formatMarketPrice(indexEntry.price) + suffix,
        indexEntry.stale === true ? 'index-stale' : 'index-live'
      )
    }
    stat('种子价', meta.seedPrice)
    stat('成交量', entry.volume24h ?? 0)
    row.appendChild(stats)

    const trade = document.createElement('div')
    trade.className = 'market-trade'
    const label = document.createElement('span')
    label.className = 'qty-label'
    label.textContent = '数量'
    const input = document.createElement('input')
    input.type = 'number'
    input.min = String(MIN_TRADE_QTY)
    input.max = String(MAX_TRADE_QTY)
    input.step = '1'
    input.inputMode = 'numeric'
    input.dataset.cropQty = cropId
    input.value = String(marketQty[cropId] ?? 1)
    input.setAttribute('aria-label', meta.name + '数量')
    const total = document.createElement('span')
    total.className = 'total'
    total.dataset.total = cropId
    const buy = document.createElement('button')
    buy.type = 'button'
    buy.className = 'btn buy'
    buy.dataset.marketAction = 'buy'
    buy.dataset.cropId = cropId
    buy.textContent = '买种'
    const sell = document.createElement('button')
    sell.type = 'button'
    sell.className = 'btn sell'
    sell.dataset.marketAction = 'sell'
    sell.dataset.cropId = cropId
    sell.textContent = '卖出'
    trade.appendChild(label)
    trade.appendChild(input)
    trade.appendChild(buy)
    trade.appendChild(sell)
    trade.appendChild(total)
    row.appendChild(trade)
    marketRowsEl.appendChild(row)
    updateMarketTotals(row, cropId)
  }

  const history = Array.isArray(market.history) ? market.history.slice(0, 8) : []
  if (history.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = '还没有成交。'
    tradesEl.appendChild(empty)
    return
  }
  for (const entry of history) {
    const meta = cropMeta(entry.crop)
    const item = document.createElement('li')
    const text = document.createElement('span')
    text.textContent = (meta === null ? '作物' : meta.name) + ' ' +
      (MARKET_SIDE_TEXT[entry.side] ?? '成交') + ' ×' + entry.qty +
      (Number.isFinite(Number(entry.price)) ? ' @' + entry.price : '')
    const when = document.createElement('span')
    when.className = 'when'
    when.textContent = formatTime(entry.at)
    item.appendChild(text)
    item.appendChild(when)
    tradesEl.appendChild(item)
  }
}

function renderSubtitle () {
  if (farm === null) {
    subtitleEl.textContent = '正在等宿主把地块送过来…'
    return
  }
  const parts = [
    '🪙 ' + (Number(farm.coins) || 0),
    '💧 ' + (Number(farm.dew) || 0)
  ]
  if (selectedPlot !== null) parts.push('已选 ' + selectedPlot)
  subtitleEl.textContent = parts.join(' · ')
}

function render () {
  renderSubtitle()
  renderPlots()
  renderInventory()
  renderLog()
  renderMarket()
}

function tick () {
  if (farm === null) return
  let needsRender = false
  for (const plot of farm.plots) {
    if (plot.stage !== 'growing') continue
    plot.remainingMs = Math.max(0, Number(plot.remainingMs) - 1000)
    if (plot.remainingMs === 0) {
      plot.stage = 'mature'
      plot.mature = true
      needsRender = true
      continue
    }
    const node = countdowns.get(plot.id)
    if (node !== undefined) node.textContent = formatRemaining(plot.remainingMs)
  }
  if (needsRender) render()
}

function submit (payload) {
  if (busy || farm === null || api === null || typeof api?.submit !== 'function') return
  busy = true
  hideToast()
  render()
  try {
    api.submit(payload)
  } catch {
    busy = false
    showToast('窗口没有把这次操作交出去，再试一次。', 'error')
    render()
  }
}

plotsEl.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const buttonEl = target.closest('button[data-plot-action]')
  if (buttonEl === null || buttonEl.disabled) return
  const plotId = buttonEl.dataset.plotId
  const action = buttonEl.dataset.plotAction
  if (typeof plotId !== 'string' || plotId === '') return
  if (action === 'plant') {
    submit({ action: 'farm-plant', plotId, cropId: buttonEl.dataset.cropId })
    return
  }
  if (action === 'harvest' || action === 'water' || action === 'fertilize') {
    submit({ action: 'farm-' + action, plotId })
  }
})

function selectTab (name) {
  activeTab = name === 'market' ? 'market' : 'farm'
  for (const tab of tabs) {
    const active = tab.dataset.tab === activeTab
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', active ? 'true' : 'false')
  }
  farmPageEl.hidden = activeTab !== 'farm'
  marketPageEl.hidden = activeTab !== 'market'
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab))
}

marketRowsEl.addEventListener('input', (event) => {
  const target = event.target
  if (!(target instanceof Element) || !target.matches('input[data-crop-qty]')) return
  const cropId = target.dataset.cropQty
  if (!Object.prototype.hasOwnProperty.call(CROP_META, cropId)) return
  marketQty[cropId] = target.value
  updateMarketTotals(target.closest('.market-row'), cropId)
})

marketRowsEl.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const buttonEl = target.closest('button[data-market-action]')
  if (buttonEl === null || buttonEl.disabled) return
  const cropId = buttonEl.dataset.cropId
  const row = buttonEl.closest('.market-row')
  const input = row?.querySelector('input[data-crop-qty]')
  if (input !== null && input !== undefined) marketQty[cropId] = input.value
  const qty = readMarketQty(cropId)
  if (qty === null) {
    showToast('数量要在 1–99 之间。', 'error')
    return
  }
  const side = buttonEl.dataset.marketAction
  submit({
    action: side === 'buy' ? 'farm-buy-seed' : 'farm-sell-crop',
    cropId,
    qty
  })
})

closeButton.addEventListener('click', () => api?.close())

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  api?.close()
})

api?.onState((payload) => {
  if (payload === null || typeof payload !== 'object') return
  farm = payload.farm !== null && typeof payload.farm === 'object' ? payload.farm : null
  market = payload.market !== null && typeof payload.market === 'object' ? payload.market : null
  selectedPlot = typeof payload.plotId === 'string' && payload.plotId !== '' ? payload.plotId : null
  busy = false
  // 不在这里 hideToast：动作成功后宿主紧接着会推新状态，toast 不能被这次刷新抹掉。
  render()
})

api?.onResult((result) => {
  busy = false
  if (result === null || typeof result !== 'object') {
    render()
    return
  }
  if (result.ok === true) {
    render()
    // 成功不关窗：收完还要接着种。宿主紧接着会推新的 farm-state。
    showToast(typeof result.notice === 'string' && result.notice.trim() !== '' ? result.notice : '完成了。')
    return
  }
  render()
  const notice = typeof result.notice === 'string' && result.notice.trim() !== ''
    ? result.notice
    : (RESULT_CODE_TEXT[result.code] ?? '这次没有完成，稍后再试。')
  showToast(notice, 'error')
})

selectTab('farm')
render()
setInterval(tick, 1000)
api?.ready()
