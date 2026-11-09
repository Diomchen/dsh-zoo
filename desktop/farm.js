/**
 * 农场小窗的渲染端（ticket 40 / 41 / 43 / 44 / 46 / 47）。
 *
 * 它只做三件事：把宿主推来的完整 farm view 画成卡片；每秒本地递减倒计时/推进进度条；
 * 把「种 / 收 / 浇 / 施肥 / 买种 / 卖作物」当**申请**交给主进程。仓库、硬币、成熟与否、
 * 单价与总价全部由宿主算，成功与否也等宿主回执——窗口不自己改状态。
 *
 * 布局不写死 4 块地：卡片由 `farm-view.js` 按 `farm.plots` 生成，标题计数也从
 * `farm.plots.length` 推；未来宿主发 20 块，这里不用改。
 */
'use strict'

const api = window.dshZooFarm
const view = window.dshZooFarmView
const CROP_META = view.CROP_META
const CROP_IDS = view.CROP_IDS

const plotsEl = document.getElementById('plots')
const visitorBannerEl = document.getElementById('visitor-banner')
const seedBagEl = document.getElementById('seed-bag')
const cropWarehouseEl = document.getElementById('crop-warehouse')
const logEl = document.getElementById('log')
const marketRowsEl = document.getElementById('market-rows')
const tradesEl = document.getElementById('trades')
const marketWalletEl = document.getElementById('market-wallet')
const farmPageEl = document.getElementById('page-farm')
const marketPageEl = document.getElementById('page-market')
const hirePageEl = document.getElementById('page-hire')
const logPageEl = document.getElementById('page-log')
const carriedEl = document.getElementById('carried')
const carriedItemsEl = document.getElementById('carried-items')
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
const titleEl = document.getElementById('farm-title')
const plantedCountEl = document.getElementById('planted-count')
const coinValueEl = document.getElementById('coin-value')
const dewValueEl = document.getElementById('dew-value')
const batchBarEl = document.getElementById('batch-bar')
const batchPlantEl = document.getElementById('batch-plant')
const batchHarvestEl = document.getElementById('batch-harvest')
const toastsEl = document.getElementById('toasts')
const plantModalEl = document.getElementById('plant-modal')
const plantBackdropEl = document.getElementById('plant-backdrop')
const plantTitleEl = document.getElementById('plant-title')
const seedListEl = document.getElementById('seed-list')
const plantCloseEl = document.getElementById('plant-modal-close')
const plantGoMarketEl = document.getElementById('plant-go-market')
const closeButton = document.getElementById('close')

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
  'no-seed': '没有这种种子了，先去交易所买。',
  'no-crop': '没有这种作物了，先种一点再来卖。',
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

const MIN_TRADE_QTY = 1
const MAX_TRADE_QTY = 99
const MAX_TOASTS = 4

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
let activeTab = 'farm'
/** 播种弹窗当前对应的地块；null = 弹窗关闭。 */
let plantTarget = null
/** 一键收割的串行队列：一次只发一个 farm-harvest，等回执再发下一条。 */
let batch = null
/** 每种作物上一次输入的数量；宿主刷新价目时不把用户刚填的数字吞掉。 */
const marketQty = { tomato: 1, carrot: 1, pumpkin: 1 }
/** plotId → 倒计时节点；tick 只改文本，不重建按钮（重建会打断用户点击）。 */
const countdowns = new Map()
/** plotId → 进度条填充节点；tick 原地改 width。 */
const progressBars = new Map()
/** contractId → { node, remaining, text }；合同倒计时同理。 */
const contractCountdowns = new Map()

function cropMeta (cropId) {
  return view.cropMeta(cropId)
}

function plotName (plot, index) {
  return view.plotLabel(plot, index)
}

function formatRemaining (ms) {
  return view.formatRemaining(ms)
}

function formatTime (at) {
  const value = Number(at)
  if (!Number.isFinite(value) || value <= 0) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (number) => String(number).padStart(2, '0')
  return pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/** toast 栈：批量动作逐条提示，最多留 4 条，不互相覆盖。 */
function showToast (text, tone = 'ok') {
  if (typeof text !== 'string' || text.trim() === '') return
  if (toastsEl === null) return
  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.dataset.tone = tone
  toast.textContent = text.trim()
  toastsEl.appendChild(toast)
  while (toastsEl.childElementCount > MAX_TOASTS) {
    const oldest = toastsEl.firstElementChild
    if (oldest === null) break
    oldest.remove()
  }
  setTimeout(() => {
    toast.remove()
  }, tone === 'error' ? 4200 : 2400)
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

function renderHeader () {
  if (titleEl !== null) {
    if (mode === 'visitor' && visit !== null) {
      const nickname = typeof visit.nickname === 'string' && visit.nickname !== '' ? visit.nickname : '邻居'
      titleEl.textContent = '「' + nickname + '」的农场'
      titleEl.title = titleEl.textContent
    } else {
      titleEl.textContent = '我的农场'
      titleEl.title = '我的农场'
    }
  }
  if (plantedCountEl !== null) {
    // 访客模式看的是主人家的地：计数跟着 visit.plots；自己的仓库/钱包仍由 header 右侧显示。
    const statsFarm = mode === 'visitor' && visit !== null && Array.isArray(visit.plots)
      ? { plots: visit.plots }
      : farm
    plantedCountEl.textContent = view.headerStats(statsFarm).text
  }
  if (coinValueEl !== null) coinValueEl.textContent = String(Number(farm?.coins) || 0)
  if (dewValueEl !== null) dewValueEl.textContent = String(Number(farm?.dew) || 0)
}

function renderBatchBar () {
  if (batchBarEl === null) return
  // 批量按钮是外壳的一部分：主人模式跨页签都在；访客模式整行隐藏。
  const visible = mode === 'owner' && farm !== null
  batchBarEl.hidden = !visible
  if (!visible) return
  const locked = busy || batch !== null
  if (batchPlantEl !== null) batchPlantEl.disabled = locked
  if (batchHarvestEl !== null) batchHarvestEl.disabled = locked
}

/** 访客模式的地块：沿用同一张卡，但按钮只可能是偷/帮与「已偷过/已帮过」。 */
function renderVisitorPlots () {
  const plots = visit !== null && Array.isArray(visit.plots) ? visit.plots : []
  if (plots.length === 0) {
    const message = document.createElement('p')
    message.className = 'plots-empty'
    message.textContent = visit?.state === 'loading'
      ? '正在等主人家的农场快照…'
      : '这次串门没有可看的地块。'
    plotsEl.appendChild(message)
    return
  }
  const ready = visit?.state === 'ready'
  const dew = Number(farm?.dew) || 0
  for (let index = 0; index < plots.length; index += 1) {
    const plot = plots[index]
    const meta = cropMeta(plot.crop)
    const stage = plot.stage === 'mature' ? 'mature' : plot.stage === 'growing' ? 'growing' : 'empty'
    const actions = []
    if (stage === 'mature' && plot.stolenByMe !== true) {
      actions.push({
        action: 'steal',
        plotId: plot.id,
        label: '偷 1 个',
        className: 'harvest',
        disabled: busy || !ready || visitCapReached('steal'),
        reason: !ready ? '这次串门已经结束' : '今天的次数用完了'
      })
    }
    if (stage === 'growing' && plot.helpedByMe !== true) {
      actions.push({
        action: 'help',
        plotId: plot.id,
        label: '帮忙 +10%',
        className: 'primary',
        disabled: busy || !ready || visitCapReached('help') || dew < 1,
        reason: !ready ? '这次串门已经结束' : '露水不够或次数用完了'
      })
    }
    if (plot.stolenByMe === true) {
      actions.push({ action: '', plotId: plot.id, label: '已偷过', disabled: true })
    } else if (plot.helpedByMe === true) {
      actions.push({ action: '', plotId: plot.id, label: '已帮过', disabled: true })
    }

    let detailText = '还空着'
    let countdownText = ''
    if (plot.stolenByMe === true) detailText = '这一轮已经偷过了'
    else if (plot.helpedByMe === true) detailText = '这一轮已经帮过了'
    else if (stage === 'mature') detailText = '成熟了，可以偷 1 个'
    else if (stage === 'growing') {
      detailText = '还要'
      countdownText = formatRemaining(plot.remainingMs)
    }

    const card = {
      plotId: plot.id,
      label: plotName(plot, index),
      stage,
      crop: plot.crop,
      cropName: meta === null ? '空地' : meta.name,
      emoji: meta === null ? '＋' : meta.emoji,
      badge: stage === 'mature' ? '可收割' : stage === 'growing' ? '生长中' : '空地',
      mature: stage === 'mature',
      progress: view.progressOf(plot),
      detailText,
      countdownText,
      openPlant: false,
      selected: plot.id === selectedPlot,
      actions
    }
    const built = view.createPlotCard(document, card)
    plotsEl.appendChild(built.element)
    if (built.countdown !== null) countdowns.set(plot.id, built.countdown)
    if (built.progress !== null) progressBars.set(plot.id, built.progress)
  }
}

function renderPlots () {
  plotsEl.textContent = ''
  countdowns.clear()
  progressBars.clear()
  renderVisitorBanner()
  if (mode === 'visitor' && visit !== null) {
    renderVisitorPlots()
    return
  }
  if (farm === null) {
    const message = document.createElement('p')
    message.className = 'plots-empty'
    message.textContent = '农场数据还没到，等宿主推过来…'
    plotsEl.appendChild(message)
    return
  }
  const cards = view.plotCards(farm, { dew: farm.dew, busy, selectedPlot })
  plotsEl.setAttribute('aria-label', '地块，共 ' + cards.length + ' 块')
  for (const card of cards) {
    const built = view.createPlotCard(document, card)
    plotsEl.appendChild(built.element)
    if (built.countdown !== null) countdowns.set(card.plotId, built.countdown)
    if (built.progress !== null) progressBars.set(card.plotId, built.progress)
  }
}

function stackChip (meta, count, kind, cropId) {
  const chip = document.createElement('span')
  chip.className = 'stack-chip' + (count <= 0 ? ' muted' : '')
  chip.dataset.stackKind = kind
  chip.dataset.crop = cropId
  const emoji = document.createElement('span')
  emoji.setAttribute('aria-hidden', 'true')
  emoji.textContent = meta.emoji
  const name = document.createElement('span')
  name.textContent = meta.name
  const value = document.createElement('b')
  value.textContent = String(count)
  chip.appendChild(emoji)
  chip.appendChild(name)
  chip.appendChild(value)
  return chip
}

/** 常驻 footer：种子背包 / 收获仓库，跨页签都看得到；空库存也保留位置。 */
function renderInventory () {
  if (seedBagEl === null || cropWarehouseEl === null) return
  seedBagEl.textContent = ''
  cropWarehouseEl.textContent = ''
  if (farm === null) {
    for (const holder of [seedBagEl, cropWarehouseEl]) {
      const chip = document.createElement('span')
      chip.className = 'stack-chip muted'
      chip.textContent = '等宿主…'
      holder.appendChild(chip)
    }
    return
  }
  for (const cropId of CROP_IDS) {
    const meta = CROP_META[cropId]
    seedBagEl.appendChild(stackChip(meta, Number(farm.seeds?.[cropId]) || 0, 'seed', cropId))
    cropWarehouseEl.appendChild(stackChip(meta, Number(farm.crops?.[cropId]) || 0, 'crop', cropId))
  }
}

function renderLog () {
  logEl.textContent = ''
  // 记录页（ticket 45）：宿主给最近 50 条；列表自己滚动，不把窗口撑高。
  const entries = farm === null || !Array.isArray(farm.log) ? [] : farm.log.slice(0, 50)
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
    if (entry.kind === 'hire') {
      const hours = Number(entry.hours)
      const wage = Number(entry.wage)
      text.textContent = (who === '' ? '' : who + ' ') + '雇工' +
        (Number.isFinite(hours) && hours > 0 ? ' ' + hours + ' 小时' : '') +
        (Number.isFinite(wage) && wage > 0 ? ' · ' + wage + ' 硬币' : '')
    } else if (entry.kind === 'settle') {
      const earned = Number(entry.earned)
      text.textContent = (who === '' ? '' : who + ' ') + '结算' +
        (Number.isFinite(earned) ? ' · ' + earned + ' 硬币' : '')
    } else if (entry.kind === 'steal' && Number(entry.qty) === 0) {
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

/**
 * 驮包（ticket 43/44）：只画宿主给的 carried 列表；
 * 偷来的作物「在驮包里」到串门结束，工资在合同结算前显示。没有条目就整块隐藏。
 */
function renderCarried () {
  if (carriedEl === null || carriedItemsEl === null) return
  const items = farm === null || !Array.isArray(farm.carried) ? [] : farm.carried
  carriedItemsEl.textContent = ''
  if (items.length === 0) {
    carriedEl.hidden = true
    return
  }
  carriedEl.hidden = false
  for (const entry of items) {
    const item = document.createElement('li')
    if (entry !== null && typeof entry === 'object' && entry.kind === 'wage') {
      const amount = Number(entry.amount)
      item.textContent = '🪙 约 ' + (Number.isFinite(amount) ? Math.floor(amount) : 0) +
        ' 硬币 · 工资在驮包里'
    } else if (entry !== null && typeof entry === 'object' && entry.kind === 'crop') {
      const crop = cropMeta(entry.crop)
      const qty = Number(entry.qty)
      item.textContent = (crop === null ? '作物' : crop.emoji + ' ' + crop.name) +
        ' ×' + (Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1) + ' · 在驮包里'
    } else {
      continue
    }
    carriedItemsEl.appendChild(item)
  }
  carriedEl.hidden = carriedItemsEl.childElementCount === 0
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
    const samples = Number(indexEntry?.samples)
    if (indexEntry === null || !Number.isFinite(samples) || samples <= 0) {
      // samples 0 = 没有 peer 报价，指数就是本机价；不能画成「有邻居的指数」。
      stat('局域网指数', '本机行情', 'index-local')
    } else {
      stat(
        '局域网指数',
        formatMarketPrice(indexEntry.price) + ' · ' + Math.floor(samples) + ' 份',
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
  if (contracts === null) return false
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

/** 播种弹窗：三种种子的库存、生长时长/产量；库存 0 禁用；不做随机买种。 */
function renderPlantModal () {
  if (plantModalEl === null) return
  if (plantTarget === null || mode !== 'owner' || farm === null) {
    plantModalEl.hidden = true
    return
  }
  const index = farm.plots.findIndex((plot) => plot.id === plantTarget)
  const plot = index >= 0 ? farm.plots[index] : null
  if (plot === null || plot.stage !== 'empty') {
    plantTarget = null
    plantModalEl.hidden = true
    return
  }
  plantModalEl.hidden = false
  plantTitleEl.textContent = '播种 · ' + plotName(plot, index)
  seedListEl.textContent = ''
  for (const cropId of CROP_IDS) {
    const meta = CROP_META[cropId]
    const count = Number(farm.seeds?.[cropId]) || 0
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'seed-row'
    row.dataset.plotAction = 'plant'
    row.dataset.plotId = plantTarget
    row.dataset.cropId = cropId
    row.disabled = busy || count <= 0
    if (count <= 0) row.title = '没有这种种子了'
    row.setAttribute('aria-label', meta.name + '，库存 ' + count)
    const emoji = document.createElement('span')
    emoji.className = 'seed-emoji'
    emoji.setAttribute('aria-hidden', 'true')
    emoji.textContent = meta.emoji
    const info = document.createElement('span')
    info.className = 'seed-info'
    const name = document.createElement('strong')
    name.textContent = meta.name
    const detail = document.createElement('span')
    detail.className = 'seed-meta'
    detail.textContent = '生长 ' + view.formatGrowTime(meta.growMs) + ' · 收获 ' + meta.yield + ' 个'
    info.appendChild(name)
    info.appendChild(detail)
    const stock = document.createElement('span')
    stock.className = 'seed-stock'
    stock.dataset.seedStock = cropId
    stock.textContent = '×' + count
    row.appendChild(emoji)
    row.appendChild(info)
    row.appendChild(stock)
    seedListEl.appendChild(row)
  }
}

function openPlantModal (plotId) {
  if (mode !== 'owner' || farm === null) return
  if (typeof plotId !== 'string' || plotId === '') return
  const plot = farm.plots.find((candidate) => candidate.id === plotId)
  if (plot === undefined || plot.stage !== 'empty') return
  plantTarget = plotId
  renderPlantModal()
  if (plantModalEl.hidden === false) {
    const first = seedListEl.querySelector('button:not(:disabled)')
    if (first !== null) first.focus()
    else if (plantCloseEl !== null) plantCloseEl.focus()
  }
}

function closePlantModal () {
  plantTarget = null
  if (plantModalEl !== null) plantModalEl.hidden = true
  if (seedListEl !== null) seedListEl.textContent = ''
}

/** 只重画农场页/常驻外壳：tick 让作物成熟时不能顺手重建雇工页（合同倒计时会跳回去）。 */
function renderFarmSurface () {
  renderHeader()
  renderBatchBar()
  renderPlots()
  renderInventory()
  renderCarried()
  renderPlantModal()
}

function render () {
  renderFarmSurface()
  renderLog()
  if (activeTab === 'market') renderMarket()
  if (activeTab === 'hire') renderHire()
}

/** 每秒本地推进：倒计时文本 + 进度条；成熟那一刻重画整页。 */
function tickPlots () {
  const plots = mode === 'visitor' && visit !== null && Array.isArray(visit.plots)
    ? visit.plots
    : (farm !== null && Array.isArray(farm.plots) ? farm.plots : null)
  if (plots === null) return
  let needsRender = false
  for (const plot of plots) {
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
    const fill = progressBars.get(plot.id)
    if (fill !== undefined) fill.style.width = Math.round(view.progressOf(plot) * 100) + '%'
  }
  if (needsRender) renderFarmSurface()
}

function tick () {
  if (activeTab === 'hire') tickContracts()
  tickPlots()
}

/** 真正把一次申请交给主进程；批量队列在两条申请之间复用这条窄口。 */
function dispatch (payload) {
  busy = true
  render()
  try {
    api.submit(payload)
  } catch {
    busy = false
    batch = null
    showToast('窗口没有把这次操作交出去，再试一次。', 'error')
    render()
  }
}

/** 用户主动点的动作：busy / 批量进行中一律挡住。 */
function submit (payload) {
  const ready = farm !== null || (mode === 'visitor' && visit !== null && visit.state === 'ready')
  if (busy || batch !== null || !ready || api === null || typeof api?.submit !== 'function') return
  dispatch(payload)
}

/** 一键播种：第一个空地 + 第一种还有库存的种子，只发一条 farm-plant。 */
function startBatchPlant () {
  if (busy || batch !== null || farm === null) return
  const target = view.batchPlantTarget(farm)
  if (target.ok !== true) {
    showToast(target.reason === 'no-seed' ? '种子袋空了，去交易所买种吧。' : '没有空地了，先收一块吧。', 'info')
    return
  }
  submit({ action: 'farm-plant', plotId: target.plotId, cropId: target.cropId })
}

function sendNextHarvest () {
  if (batch === null) return
  const plotId = batch.queue.shift()
  if (plotId === undefined) {
    const done = batch.done
    batch = null
    busy = false
    render()
    showToast('一键收割完成：收了 ' + done + ' 块地。', 'reward')
    return
  }
  batch.inFlight = true
  dispatch({ action: 'farm-harvest', plotId })
}

/** 一键收割：按当前顺序把所有成熟地块排进队列，逐条等回执。 */
function startBatchHarvest () {
  if (busy || batch !== null || farm === null) return
  const targets = view.batchHarvestTargets(farm)
  if (targets.length === 0) {
    showToast('没有成熟的地块，再等等吧。', 'info')
    return
  }
  batch = { queue: targets, done: 0, total: targets.length, inFlight: false }
  sendNextHarvest()
}

plotsEl.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const buttonEl = target.closest('button[data-plot-action]')
  if (buttonEl !== null) {
    if (buttonEl.disabled) return
    const plotId = buttonEl.dataset.plotId
    if (typeof plotId !== 'string' || plotId === '') return
    const action = buttonEl.dataset.plotAction
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
    return
  }
  const cardEl = target.closest('.plot-card[data-open-plant="true"]')
  if (cardEl === null) return
  if (busy || mode !== 'owner') return
  openPlantModal(cardEl.dataset.plot)
})

plotsEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const target = event.target
  if (!(target instanceof Element)) return
  const cardEl = target.closest('.plot-card[data-open-plant="true"]')
  if (cardEl === null) return
  event.preventDefault()
  if (busy || mode !== 'owner') return
  openPlantModal(cardEl.dataset.plot)
})

if (plantCloseEl !== null) plantCloseEl.addEventListener('click', closePlantModal)
if (plantBackdropEl !== null) plantBackdropEl.addEventListener('click', closePlantModal)
if (plantGoMarketEl !== null) {
  plantGoMarketEl.addEventListener('click', () => {
    closePlantModal()
    selectTab('market')
  })
}

if (seedListEl !== null) {
  seedListEl.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element)) return
    const buttonEl = target.closest('button[data-plot-action="plant"]')
    if (buttonEl === null || buttonEl.disabled) return
    const plotId = buttonEl.dataset.plotId
    const cropId = buttonEl.dataset.cropId
    closePlantModal()
    submit({ action: 'farm-plant', plotId, cropId })
  })
}

if (batchPlantEl !== null) batchPlantEl.addEventListener('click', startBatchPlant)
if (batchHarvestEl !== null) batchHarvestEl.addEventListener('click', startBatchHarvest)

function selectTab (name) {
  activeTab = name === 'market' ? 'market' : name === 'hire' ? 'hire' : name === 'log' ? 'log' : 'farm'
  for (const tab of tabs) {
    const active = tab.dataset.tab === activeTab
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', active ? 'true' : 'false')
  }
  farmPageEl.hidden = activeTab !== 'farm'
  marketPageEl.hidden = activeTab !== 'market'
  hirePageEl.hidden = activeTab !== 'hire'
  logPageEl.hidden = activeTab !== 'log'
  if (activeTab !== 'farm') closePlantModal()
  renderBatchBar()
  if (activeTab === 'market') renderMarket()
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
  if (plantTarget !== null) {
    closePlantModal()
    return
  }
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
  if (mode !== 'owner') {
    // 访客模式没有一键播种/收割，也没有播种弹窗；正在跑的批量队列立刻停。
    batch = null
    closePlantModal()
  }
  // 不在这里把 busy 复位：宿主会在 action-result 之前推一份新 farm-state，
  // 这时动作还在飞，提前解锁会让用户点到一条会被主进程静默丢掉的动作。
  render()
})

api?.onResult((result) => {
  const wasBatch = batch !== null && batch.inFlight === true
  busy = false
  if (wasBatch) batch.inFlight = false
  if (result === null || typeof result !== 'object') {
    if (batch !== null) batch = null
    render()
    return
  }
  if (result.ok === true) {
    const notice = typeof result.notice === 'string' && result.notice.trim() !== ''
      ? result.notice
      : '完成了。'
    if (wasBatch) {
      batch.done += 1
      render()
      // 先 toast 这一条，再发下一条；批量收完时 sendNextHarvest 会追加一条汇总。
      showToast(notice)
      sendNextHarvest()
      return
    }
    render()
    // 成功不关窗：收完还要接着种。宿主紧接着会推新的 farm-state。
    showToast(notice)
    return
  }
  if (batch !== null) batch = null
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
