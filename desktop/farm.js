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
const visitorBannerEl = document.getElementById('visitor-banner')
const inventoryEl = document.getElementById('inventory')
const logEl = document.getElementById('log')
const marketRowsEl = document.getElementById('market-rows')
const tradesEl = document.getElementById('trades')
const marketWalletEl = document.getElementById('market-wallet')
const farmPageEl = document.getElementById('page-farm')
const marketPageEl = document.getElementById('page-market')
const hirePageEl = document.getElementById('page-hire')
const contractsEl = document.getElementById('contracts')
const listingsEl = document.getElementById('listings')
const hireFormEl = document.getElementById('hire-form')
const hireEnabledEl = document.getElementById('hire-enabled')
const hireWageEl = document.getElementById('hire-wage')
const hireMinEl = document.getElementById('hire-min')
const hireMaxEl = document.getElementById('hire-max')
const hireSaveEl = document.getElementById('hire-save')
const hireHintEl = document.getElementById('hire-hint')
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
/** 雇佣（ticket 44）的窄口：与宿主 src/contracts-rules.js 同源。 */
const HIRE_WAGE_MIN = 1
const HIRE_WAGE_MAX = 100
const HIRE_HOURS_MIN = 2
const HIRE_HOURS_MAX = 8
const HIRE_FEE_RATE = 0.05

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
  'already-fertilized': '这株已经施过肥了。',
  // 雇佣（ticket 44）
  'own-pet': '不能雇自己的宠物。',
  'worker-unavailable': '这只宠物现在不能来打工。',
  'already-working': '宠物正在打工，合同结束前不能再接活。',
  'already-hired': '家里已经有一位雇工了。',
  'bad-wage': '时薪要在 1–100 之间。',
  'bad-hours': '时段要在 2–8 小时之间（最短不能超过最长）。',
  'bad-enabled': '挂牌开关的取值不对。',
  'contract-not-found': '找不到这份合同。',
  'contract-ended': '这份合同已经结束了。',
  'contract-busy': '这份合同正在结算。',
  busy: '上一笔雇佣还在联系中。'
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
/** 访客模式的固定错误码 → 窗口兜底文案（宿主 notice 优先，这里是拿不到 notice 时）。 */
const VISIT_ERROR_TEXT = {
  'no-port': '对方没开局域网端口，看不到他家的农场。',
  timeout: '主人家的宠物没回应，稍后再试。',
  gone: '这次串门已经结束了。',
  'bad-shape': '对方发来的农场数据不对。',
  'bad-json': '对方发来的农场数据坏了。',
  'too-large': '对方的农场数据太大了。',
  refused: '对方没有回应。'
}

let farm = null
let market = null
/** 雇工页（ticket 44）：合同/邻居挂牌/在飞状态，全部由宿主 push。 */
let contracts = null
/** 用户在挂牌表单里改过、还没保存：宿主刷新时不覆盖他刚填的数字。 */
let hireDirty = false
/** 访客模式（ticket 43）：宿主决定模式；窗口只画 visit 块，不自己联网。 */
let mode = 'owner'
let visit = null
let selectedPlot = null
let busy = false
let toastTimer = null
let activeTab = 'farm'
/** 每种作物上一次输入的数量；宿主刷新价目时不把用户刚填的数字吞掉。 */
const marketQty = { tomato: 1, carrot: 1, pumpkin: 1 }
/** plotId → 倒计时节点；tick 只改文本，不重建按钮（重建会打断用户点击）。 */
const countdowns = new Map()
/** contractId → { node, remaining, text }；合同倒计时同理。 */
const contractCountdowns = new Map()

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

function visitLimit (kind) {
  const entry = visit?.limits?.[kind]
  return entry !== null && typeof entry === 'object' ? entry : null
}

function visitCapReached (kind) {
  const limit = visitLimit(kind)
  if (limit === null) return false
  const used = Number(limit.usedInVisit) || 0
  const perVisit = Number(limit.perVisit) || 0
  const total = Number(limit.usedOnFarm) || 0
  const perFarm = Number(limit.perFarm) || 0
  const today = Number(limit.usedToday) || 0
  const perDay = Number(limit.perDay) || 0
  return (perVisit > 0 && used >= perVisit) ||
    (perFarm > 0 && total >= perFarm) ||
    (perDay > 0 && today >= perDay)
}

/** 访客模式的顶部说明：谁家、守卫、今天还能偷/帮几次、loading/error/ended 的原因。 */
function renderVisitorBanner () {
  if (visitorBannerEl === null) return
  if (mode !== 'visitor' || visit === null) {
    visitorBannerEl.hidden = true
    visitorBannerEl.textContent = ''
    return
  }
  const state = typeof visit.state === 'string' ? visit.state : 'error'
  const nickname = typeof visit.nickname === 'string' && visit.nickname !== '' ? visit.nickname : '邻居'
  visitorBannerEl.hidden = false
  visitorBannerEl.dataset.state = state
  if (state === 'loading') {
    visitorBannerEl.textContent = '正在看「' + nickname + '」家的农场…'
    return
  }
  if (state === 'ended') {
    visitorBannerEl.textContent = '这次串门已经结束了；下面留的是最后一次快照，不能再偷/帮。'
    return
  }
  if (state === 'error') {
    const reason = VISIT_ERROR_TEXT[visit.error] ?? '暂时看不到他家的农场。'
    visitorBannerEl.textContent = '看不到「' + nickname + '」家的农场：' + reason
    return
  }
  const guard = Math.round((Number(visit.guard) || 0) * 100)
  const steal = visitLimit('steal')
  const help = visitLimit('help')
  const stealText = steal === null
    ? ''
    : ' · 偷 ' + (Number(steal.usedInVisit) || 0) + '/' + (Number(steal.perVisit) || 0)
  const helpText = help === null
    ? ''
    : ' · 帮 ' + (Number(help.usedInVisit) || 0) + '/' + (Number(help.perVisit) || 0)
  visitorBannerEl.textContent = '在「' + nickname + '」家 · 守卫 ' + guard + '%' + stealText + helpText
}

function renderVisitPlots () {
  const plots = visit !== null && Array.isArray(visit.plots) ? visit.plots : []
  if (plots.length === 0) {
    const message = document.createElement('p')
    message.className = 'empty'
    message.textContent = visit?.state === 'loading'
      ? '正在等主人家的农场快照…'
      : '这次串门没有可看的地块。'
    plotsEl.appendChild(message)
    return
  }
  const ready = visit?.state === 'ready'
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
    if (plot.stolenByMe === true) detail.textContent = '这一轮已经偷过了'
    else if (plot.helpedByMe === true) detail.textContent = '这一轮已经帮过了'
    else if (plot.stage === 'mature') detail.textContent = '成熟了，可以偷 1 个'
    else if (plot.stage === 'growing') {
      detail.textContent = '还要 '
      const countdown = document.createElement('span')
      countdown.className = 'countdown'
      countdown.textContent = formatRemaining(plot.remainingMs)
      detail.appendChild(countdown)
      countdowns.set(plot.id, countdown)
    } else detail.textContent = '还空着'
    info.appendChild(detail)
    body.appendChild(info)
    card.appendChild(body)

    const actions = document.createElement('div')
    actions.className = 'plot-actions'
    if (plot.stage === 'mature' && plot.stolenByMe !== true) {
      actions.appendChild(button('偷 1 个', {
        plotId: plot.id,
        action: 'steal',
        className: 'harvest',
        disabled: busy || !ready || visitCapReached('steal'),
        reason: !ready ? '这次串门已经结束' : '今天的次数用完了'
      }))
    }
    if (plot.stage === 'growing' && plot.helpedByMe !== true) {
      actions.appendChild(button('帮忙 +10%', {
        plotId: plot.id,
        action: 'help',
        className: 'primary',
        disabled: busy || !ready || visitCapReached('help') || (Number(farm?.dew) || 0) < 1,
        reason: !ready ? '这次串门已经结束' : '露水不够或次数用完了'
      }))
    }
    if (plot.stolenByMe === true) actions.appendChild(button('已偷过', { plotId: plot.id, disabled: true }))
    else if (plot.helpedByMe === true) actions.appendChild(button('已帮过', { plotId: plot.id, disabled: true }))
    card.appendChild(actions)
    plotsEl.appendChild(card)
  }
}

function renderPlots () {
  plotsEl.textContent = ''
  countdowns.clear()
  renderVisitorBanner()
  if (mode === 'visitor' && visit !== null) {
    renderVisitPlots()
    return
  }
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
  if (mode === 'visitor' && visit !== null) {
    const row = (label, values) => {
      const rowEl = document.createElement('div')
      rowEl.className = 'row'
      const labelEl = document.createElement('span')
      labelEl.className = 'label'
      labelEl.textContent = label
      rowEl.appendChild(labelEl)
      for (const [name, count] of values) {
        const valueEl = document.createElement('span')
        valueEl.className = 'value'
        valueEl.textContent = count === '' ? name : name + ' ' + count
        rowEl.appendChild(valueEl)
      }
      inventoryEl.appendChild(rowEl)
    }
    const nickname = typeof visit.nickname === 'string' && visit.nickname !== '' ? visit.nickname : '邻居'
    row('访客', [['在「' + nickname + '」家', '']])
    row('钱包', [['🪙 硬币', Number(farm?.coins) || 0], ['💧 露水', Number(farm?.dew) || 0]])
    const steal = visitLimit('steal')
    const help = visitLimit('help')
    if (steal !== null || help !== null) {
      row('次数', [
        ['偷', steal === null ? '—' : (Number(steal.usedInVisit) || 0) + '/' + (Number(steal.perVisit) || 0)],
        ['帮', help === null ? '—' : (Number(help.usedInVisit) || 0) + '/' + (Number(help.perVisit) || 0)]
      ])
    }
    return
  }
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
    const who = typeof entry.who === 'string' && entry.who !== '' ? '「' + entry.who + '」' : ''
    if (entry.kind === 'steal' && Number(entry.qty) === 0) {
      text.textContent = who === '' ? '被抓住了' : who + '被抓住了'
    } else if ((entry.kind === 'steal' || entry.kind === 'help') && who !== '') {
      text.textContent = who + (entry.kind === 'steal' ? '偷了 ' : '帮了 ') +
        (crop === null ? '1 个作物' : '1 个' + crop.name)
    } else {
      text.textContent = kind + (crop === null ? '' : ' ' + crop.name) +
        (Number(entry.qty) > 0 && entry.kind !== 'plant' ? ' ×' + entry.qty : '')
    }
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


/** 合同剩余时间：窗口本地每秒递减（宿主只给那一刻的 remainingMs）。 */
function contractRemainingText (contract) {
  const remaining = Math.max(0, Number(contract.remainingMs) || 0)
  if (contract.status === 'pending') return '正在联系雇主…'
  if (contract.status !== 'active') {
    return contract.settled === true ? '已结算' : contract.status === 'cancelled' ? '已取消' : '已结束'
  }
  return '还剩 ' + formatRemaining(remaining)
}

function hireFee (total) {
  return Math.max(1, Math.ceil(Number(total) * HIRE_FEE_RATE))
}

/** 总价 = 时薪 × 时长 + ceil(5%)；窗口只显示，真正扣钱仍由宿主算。 */
function hireQuote (listing, hours) {
  const count = Number(hours)
  if (!Number.isInteger(count) || count < HIRE_HOURS_MIN || count > HIRE_HOURS_MAX) return null
  const wage = Math.max(0, Math.round(Number(listing.wagePerHour) || 0)) * count
  const fee = hireFee(wage)
  return { wage, fee, total: wage + fee }
}

function updateHireQuote (input) {
  const row = input.closest('.hire-row')
  const quoteEl = row?.querySelector('[data-hire-quote]')
  if (quoteEl === null || quoteEl === undefined) return
  const listing = (contracts?.listings ?? []).find((entry) => entry.deviceId === row.dataset.deviceId)
  if (listing === undefined) return
  const quote = hireQuote(listing, input.value)
  quoteEl.textContent = quote === null ? '时长 2–8 小时' : '总价 ' + quote.total + '（含手续费 ' + quote.fee + '）'
}

function hireDraftOf () {
  return {
    enabled: hireEnabledEl.checked === true,
    wagePerHour: Number(hireWageEl.value),
    minHours: Number(hireMinEl.value),
    maxHours: Number(hireMaxEl.value)
  }
}

function hireFormValid (draft) {
  return Number.isInteger(draft.wagePerHour) && draft.wagePerHour >= HIRE_WAGE_MIN && draft.wagePerHour <= HIRE_WAGE_MAX &&
    Number.isInteger(draft.minHours) && Number.isInteger(draft.maxHours) &&
    draft.minHours >= HIRE_HOURS_MIN && draft.maxHours <= HIRE_HOURS_MAX && draft.minHours <= draft.maxHours
}

/** 宿主刷新时填挂牌表单；用户正在编辑就不覆盖。 */
function syncHireForm () {
  if (hireFormEl.contains(document.activeElement) || hireDirty) return
  const hire = farm?.hire
  if (hire === null || typeof hire !== 'object') return
  hireEnabledEl.checked = hire.enabled === true
  hireWageEl.value = String(hire.wagePerHour)
  hireMinEl.value = String(hire.minHours)
  hireMaxEl.value = String(hire.maxHours)
}

function contractRow (contract, side) {
  const row = document.createElement('div')
  row.className = 'hire-row'
  row.dataset.contractId = contract.id
  row.dataset.side = side
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = side === 'outgoing'
    ? '雇工：' + (contract.workerNickname ?? '邻居')
    : '雇主：' + (contract.employerNickname ?? '邻居')
  const meta = document.createElement('span')
  meta.className = 'meta'
  meta.dataset.contractMeta = contract.id
  const money = side === 'outgoing'
    ? '托管 ' + contract.wage + ' · 手续费 ' + contract.fee
    : '预计 ' + (contract.earned || 0) + '/' + contract.wage
  meta.textContent = contractRemainingText(contract) + ' · ' + money
  row.appendChild(name)
  row.appendChild(meta)
  if (contract.status === 'active') {
    const action = side === 'outgoing' ? 'end-contract' : 'recall-worker'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn'
    btn.dataset.hireAction = action
    btn.dataset.contractId = contract.id
    btn.textContent = side === 'outgoing' ? '结束' : '召回'
    btn.disabled = busy
    row.appendChild(btn)
    contractCountdowns.set(contract.id, {
      node: meta,
      remaining: Math.max(0, Number(contract.remainingMs) || 0),
      text: money
    })
  } else {
    contractCountdowns.delete(contract.id)
  }
  return row
}

function renderHire () {
  if (hirePageEl === null) return
  syncHireForm()
  contractCountdowns.clear()

  contractsEl.textContent = ''
  const outgoing = Array.isArray(contracts?.outgoing) ? contracts.outgoing : []
  const incoming = Array.isArray(contracts?.incoming) ? contracts.incoming : []
  const rows = [...outgoing.map((contract) => contractRow(contract, 'outgoing')),
    ...incoming.map((contract) => contractRow(contract, 'incoming'))]
  if (rows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'hire-empty'
    empty.textContent = '还没有合同。'
    contractsEl.appendChild(empty)
  } else {
    for (const row of rows) contractsEl.appendChild(row)
  }

  listingsEl.textContent = ''
  const listings = Array.isArray(contracts?.listings) ? contracts.listings : []
  if (listings.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'hire-empty'
    empty.textContent = '还没收到邻居的挂牌（每 30 秒随行情广播一次）。'
    listingsEl.appendChild(empty)
  }
  const pending = contracts?.pendingHire === true
  for (const listing of listings) {
    const row = document.createElement('div')
    row.className = 'hire-row'
    row.dataset.deviceId = listing.deviceId
    row.dataset.stale = listing.stale === true || listing.available !== true ? 'true' : 'false'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = listing.nickname ?? '邻居'
    const meta = document.createElement('span')
    meta.className = 'meta'
    const reasonText = listing.stale === true
      ? '行情过期'
      : listing.available !== true
        ? (listing.reason === 'working' ? '在打工' : listing.reason === 'visiting' ? '在串门' : listing.reason === 'off' ? '没挂牌' : '现在不能雇')
        : listing.wagePerHour + ' 硬币/时 · ' + listing.minHours + '–' + listing.maxHours + ' 小时'
    meta.textContent = reasonText
    row.appendChild(name)
    row.appendChild(meta)
    if (listing.available === true && listing.stale !== true) {
      const hours = document.createElement('input')
      hours.type = 'number'
      hours.min = String(listing.minHours)
      hours.max = String(listing.maxHours)
      hours.step = '1'
      hours.value = String(listing.minHours)
      hours.inputMode = 'numeric'
      hours.dataset.hireHours = listing.deviceId
      hours.setAttribute('aria-label', '雇佣时长')
      const quote = document.createElement('span')
      quote.className = 'meta'
      quote.dataset.hireQuote = listing.deviceId
      const initialQuote = hireQuote(listing, hours.value)
      quote.textContent = initialQuote === null
        ? '时长 2–8 小时'
        : '总价 ' + initialQuote.total + '（含手续费 ' + initialQuote.fee + '）'
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn primary'
      btn.dataset.hireAction = 'hire'
      btn.dataset.deviceId = listing.deviceId
      btn.textContent = pending ? '联系中…' : '雇佣'
      btn.disabled = busy || pending
      row.appendChild(hours)
      row.appendChild(quote)
      row.appendChild(btn)
    }
    listingsEl.appendChild(row)
  }

  const guard = Number(farm?.guard)
  hireHintEl.textContent = '时薪 1–100，时段 2–8 小时；手续费 5%（最低 1 硬币，烧掉）。' +
    (Number.isFinite(guard) ? ' 自家守卫 ' + Math.round(guard * 100) + '%。' : '') +
    (pending ? ' 正在联系雇主…' : '')
}

function submitHireListing () {
  const draft = hireDraftOf()
  if (hireFormValid(draft) !== true) {
    showToast('时薪 1–100，时段 2–8 小时（最短不能超过最长）。', 'error')
    return
  }
  hireDirty = false
  submit({
    action: 'hire-listing',
    enabled: draft.enabled,
    wagePerHour: draft.wagePerHour,
    minHours: draft.minHours,
    maxHours: draft.maxHours
  })
}

/** 雇工页的倒计时只改文本：每 1 秒一次，合同归零时重画一次。 */
function tickContracts () {
  if (activeTab !== 'hire' || contracts === null) return false
  let needsRender = false
  for (const [id, entry] of contractCountdowns) {
    entry.remaining = Math.max(0, entry.remaining - 1000)
    if (entry.remaining === 0) {
      needsRender = true
      continue
    }
    entry.node.textContent = '还剩 ' + formatRemaining(entry.remaining) + ' · ' + entry.text
  }
  if (needsRender) renderHire()
  return needsRender
}

function renderSubtitle () {
  if (mode === 'visitor' && visit !== null) {
    const nickname = typeof visit.nickname === 'string' && visit.nickname !== '' ? visit.nickname : '邻居'
    const guard = Math.round((Number(visit.guard) || 0) * 100)
    subtitleEl.textContent = '「' + nickname + '」家 · 守卫 ' + guard + '% · 🪙 ' +
      (Number(farm?.coins) || 0) + ' · 💧 ' + (Number(farm?.dew) || 0)
    return
  }
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
  if (activeTab === 'hire') renderHire()
}

function tick () {
  if (activeTab === 'hire') {
    tickContracts()
    return
  }
  let needsRender = false
  if (mode === 'visitor' && visit !== null && Array.isArray(visit.plots)) {
    for (const plot of visit.plots) {
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
    return
  }
  if (farm === null) return
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
  const ready = farm !== null || (mode === 'visitor' && visit !== null && visit.state === 'ready')
  if (busy || !ready || api === null || typeof api?.submit !== 'function') return
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
    return
  }
  // 访客模式（ticket 43）：只发 plotId；visitId/requestId 由宿主生成并复用。
  if (action === 'steal' || action === 'help') {
    submit({ action: 'farm-' + action, plotId })
  }
})

function selectTab (name) {
  activeTab = name === 'market' ? 'market' : name === 'hire' ? 'hire' : 'farm'
  for (const tab of tabs) {
    const active = tab.dataset.tab === activeTab
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', active ? 'true' : 'false')
  }
  farmPageEl.hidden = activeTab !== 'farm'
  marketPageEl.hidden = activeTab !== 'market'
  if (hirePageEl !== null) hirePageEl.hidden = activeTab !== 'hire'
  if (activeTab === 'hire') renderHire()
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

// 雇工页（ticket 44）：保存挂牌 / 雇佣 / 召回 / 结束。只发窄字段，总价由宿主算。
hireSaveEl?.addEventListener('click', () => submitHireListing())
hireFormEl?.addEventListener('input', () => {
  hireDirty = true
  const draft = hireDraftOf()
  const valid = hireFormValid(draft)
  hireWageEl.setAttribute('aria-invalid', valid ? 'false' : 'true')
  hireMinEl.setAttribute('aria-invalid', valid ? 'false' : 'true')
  hireMaxEl.setAttribute('aria-invalid', valid ? 'false' : 'true')
})

hirePageEl?.addEventListener('input', (event) => {
  const target = event.target
  if (!(target instanceof Element) || !target.matches('input[data-hire-hours]')) return
  updateHireQuote(target)
})

hirePageEl?.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const buttonEl = target.closest('button[data-hire-action]')
  if (buttonEl === null || buttonEl.disabled) return
  const action = buttonEl.dataset.hireAction
  if (action === 'hire') {
    const deviceId = buttonEl.dataset.deviceId
    const row = buttonEl.closest('.hire-row')
    const hoursInput = row?.querySelector('input[data-hire-hours]')
    const hours = Number(hoursInput?.value)
    if (typeof deviceId !== 'string' || !Number.isInteger(hours) || hours < HIRE_HOURS_MIN || hours > HIRE_HOURS_MAX) {
      showToast('雇佣时长要在 2–8 小时之间。', 'error')
      return
    }
    submit({ action: 'hire', deviceId, hours })
    return
  }
  const contractId = buttonEl.dataset.contractId
  if (typeof contractId !== 'string' || contractId === '') return
  if (action === 'recall-worker' || action === 'end-contract') {
    submit({ action, contractId })
  }
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
  contracts = payload.contracts !== null && typeof payload.contracts === 'object' ? payload.contracts : null
  mode = payload.mode === 'visitor' ? 'visitor' : 'owner'
  visit = mode === 'visitor' && payload.visit !== null && typeof payload.visit === 'object'
    ? payload.visit
    : null
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
