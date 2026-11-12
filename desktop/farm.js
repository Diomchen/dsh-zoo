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
const hireStatusEl = document.getElementById('hire-status')
const hireFormStatusEl = document.getElementById('hire-form-status')
const hireContractCountEl = document.getElementById('hire-contract-count')
const hireListingCountEl = document.getElementById('hire-listing-count')
const hireWageErrorEl = document.getElementById('hire-wage-error')
const hireMinErrorEl = document.getElementById('hire-min-error')
const hireMaxErrorEl = document.getElementById('hire-max-error')
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
const unlockModalEl = document.getElementById('unlock-modal')
const unlockBackdropEl = document.getElementById('unlock-backdrop')
const unlockTitleEl = document.getElementById('unlock-title')
const unlockSubEl = document.getElementById('unlock-sub')
const unlockBodyEl = document.getElementById('unlock-body')
const unlockConfirmEl = document.getElementById('unlock-confirm')
const unlockCloseEl = document.getElementById('unlock-modal-close')
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
  'max-plots': '已经到 50 块地了，没有可解锁的地块。',
  reserve: '解锁后至少要留一点种子钱，先卖点作物吧。',
  stale: '农场刚刚变过，刷新后再试。',
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
  settle: '结算',
  unlock: '解锁'
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
const MAX_TOASTS = 1

let farm = null
let market = null
/** 雇工页（ticket 44）：合同/邻居挂牌/在飞状态，全部由宿主 push。 */
let contracts = null
/** 用户在挂牌表单里改过、还没保存：宿主刷新时不覆盖他刚填的数字。 */
let hireDirty = false
/** 访客模式（ticket 43）：宿主决定模式；窗口只画 visit 块，不自己联网。 */
let mode = 'owner'
let visit = null
/** 票 52：只读查看邻居农场时的视图（`mode:'look'`）。 */
let look = null
/** 票 55：窗口里的邻居切换器（只含广告过 `look` 的邻居）。 */
let neighborChips = []
/** 票 56：邻居多时那个下拉是否展开。 */
let nnOpen = false
let selectedPlot = null
let busy = false
/** 正在飞的那一条申请（action + cropId）；按钮据此画「成交中…」。 */
let pending = null
let activeTab = 'farm'
/** 播种弹窗当前对应的地块；null = 弹窗关闭。 */
let plantTarget = null
/** 解锁弹窗当前的地价卡；null = 弹窗关闭。ticket 49。 */
let unlockTarget = null
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
/** 挂牌「可雇/过期」的签名：每秒比一次，跨过 expiresAt 时重画雇工页。 */
let listingStaleKey = ''
/** 到点确认的节流：一秒最多请宿主推一次，避免本地贴着 0 时刷屏。 */
let refreshPending = false
let refreshAt = 0

function cropMeta (cropId) {
  return view.cropMeta(cropId)
}

/** 当前空地数：交易所「买满」用；owner 视图里 plots 只含已解锁地块。 */
function emptyPlotCount (source) {
  if (source === null || typeof source !== 'object' || !Array.isArray(source.plots)) return 0
  return source.plots.filter((plot) => plot !== null && typeof plot === 'object' && plot.stage === 'empty').length
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
  // 一次只留一条：批量动作逐条覆盖，最新的一条永远在，页签内容不被一摞气泡盖住。
  while (toastsEl.childElementCount >= MAX_TOASTS) {
    const oldest = toastsEl.firstElementChild
    if (oldest === null) break
    oldest.remove()
  }
  toastsEl.appendChild(toast)
  setTimeout(() => {
    toast.remove()
  }, tone === 'error' ? 4800 : 3200)
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
  if (mode === 'look' && look !== null) {
    visitorBannerEl.hidden = false
    visitorBannerEl.dataset.state = 'ready'
    const guard = Math.round((Number(look.guard) || 0) * 100)
    visitorBannerEl.textContent = '「' + look.nickname + '」的农场 · 守卫 ' + guard + '%' +
      ' · 这趟最多 ' + (look.quotas?.perTrip ?? 0) + ' 块'
    return
  }
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
    if (mode === 'look' && look !== null) {
      titleEl.textContent = '「' + look.nickname + '」的农场'
      titleEl.title = titleEl.textContent
    } else if (mode === 'visitor' && visit !== null) {
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
    const statsFarm = mode === 'look' && look !== null && Array.isArray(look.plots)
      ? { plots: look.plots }
      : mode === 'visitor' && visit !== null && Array.isArray(visit.plots)
        ? { plots: visit.plots }
        : farm
    plantedCountEl.textContent = view.headerStats(statsFarm).text
  }
  if (coinValueEl !== null) coinValueEl.textContent = String(Number(farm?.coins) || 0)
  if (dewValueEl !== null) dewValueEl.textContent = String(Number(farm?.dew) || 0)
}

function renderBatchBar () {
  if (batchBarEl === null) return
  // 一键种满/收割只属于农场页：在交易所/雇工页也占一行会把列表挤下去，
  // 而且点了会开始收割——和当前页签完全无关。访客模式整行隐藏。
  const visible = mode === 'owner' && farm !== null && activeTab === 'farm'
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
      art: meta === null ? '' : meta.art,
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

/**
 * 票 52：只读查看邻居的农场。和访客视图同一张卡，但**没有任何单块按钮**——
 * 只有一个「派它去偷」，那是一次行程（票 53），不是在这里点着偷。
 */
function renderLookPlots () {
  const plots = look !== null && Array.isArray(look.plots) ? look.plots : []
  if (plots.length === 0) {
    const message = document.createElement('p')
    message.className = 'plots-empty'
    message.textContent = '他家的农场还没长东西。'
    plotsEl.appendChild(message)
    return
  }
  for (let index = 0; index < plots.length; index += 1) {
    const plot = plots[index]
    const meta = cropMeta(plot.crop)
    const stage = plot.stage === 'mature' ? 'mature' : plot.stage === 'growing' ? 'growing' : 'empty'
    let detailText = '还空着'
    let countdownText = ''
    if (plot.stolenByMe === true) detailText = '这一轮你已经偷过了'
    else if (stage === 'mature') detailText = '熟了，这一趟可以偷'
    else if (stage === 'growing') {
      detailText = '还要'
      countdownText = formatRemaining(plot.remainingMs)
    }
    const built = view.createPlotCard(document, {
      plotId: plot.id,
      label: plotName(plot, index),
      stage,
      crop: plot.crop,
      cropName: meta === null ? '空地' : meta.name,
      emoji: meta === null ? '＋' : meta.emoji,
      art: meta === null ? '' : meta.art,
      badge: stage === 'mature' ? '可收割' : stage === 'growing' ? '生长中' : '空地',
      mature: stage === 'mature',
      progress: view.progressOf(plot),
      detailText,
      countdownText,
      openPlant: false,
      selected: false,
      actions: []
    })
    plotsEl.appendChild(built.element)
    if (built.countdown !== null) countdowns.set(plot.id, built.countdown)
    if (built.progress !== null) progressBars.set(plot.id, built.progress)
  }

  const bar = document.createElement('div')
  bar.className = 'look-bar'
  const left = look.quotas?.perTripLeft ?? 0
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'primary'
  button.id = 'look-raid'
  button.textContent = left > 0 ? '派它去偷（这趟最多 ' + (look.quotas?.perTrip ?? 0) + ' 块）' : '这趟额度用完了'
  button.disabled = busy || left <= 0
  button.addEventListener('click', () => {
    if (look === null) return
    submit({ action: 'farm-raid', deviceId: look.deviceId })
  })
  bar.appendChild(button)
  plotsEl.appendChild(bar)
}

/**
 * 票 55：农场窗里的邻居切换器。第一颗永远是「我的农场」——切回来发 `farm-refresh`，
 * 宿主会按 `self.out` 重算模式（没出门就是 owner）。其余每颗对应一位邻居，点了发 `farm-look`。
 */
/**
 * 票 55/56：农场窗里的邻居切换器。
 * 邻居 ≤3 铺一排圆片（一眼全见）；更多就收进「当前视图」胶囊后面的列表——
 * 形状由 `view.neighborSwitch()` 决定，这里只画。
 */
function renderNeighborChips () {
  if (plotsEl === null) return
  const model = view.neighborSwitch(neighborChips, look === null ? null : look.deviceId)
  if (model.items.length === 0 && mode !== 'look') return

  const row = document.createElement('div')
  row.className = 'nn-switch'
  row.id = 'nn-switch'

  if (model.mode === 'menu') {
    row.dataset.mode = 'menu'
    const capsule = document.createElement('button')
    capsule.type = 'button'
    capsule.className = 'nn-chip nn-capsule'
    capsule.id = 'nn-capsule'
    capsule.setAttribute('aria-haspopup', 'listbox')
    capsule.setAttribute('aria-expanded', String(nnOpen))
    capsule.textContent = (mode === 'look' ? model.currentLabel : '我的农场') +
      (model.stealable > 0 ? ' · 可偷 ' + model.stealable : '') + ' ▾'
    capsule.disabled = busy
    capsule.addEventListener('click', () => {
      nnOpen = nnOpen !== true
      renderPlots()
    })
    row.appendChild(capsule)
    if (nnOpen) row.appendChild(buildNeighborMenu(model))
  } else {
    row.dataset.mode = 'chips'
    const me = document.createElement('button')
    me.type = 'button'
    me.className = 'nn-chip'
    me.dataset.own = 'true'
    me.textContent = '我的农场'
    me.setAttribute('aria-pressed', mode === 'look' ? 'false' : 'true')
    me.disabled = busy
    me.addEventListener('click', () => {
      if (mode === 'look') submit({ action: 'farm-refresh' })
    })
    row.appendChild(me)
    for (const item of model.items) row.appendChild(neighborChipButton(item))
  }
  plotsEl.appendChild(row)
}

function buildNeighborMenu (model) {
  const list = document.createElement('div')
  list.className = 'nn-menu'
  list.id = 'nn-menu'
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', '切换看哪家的农场')

  const own = document.createElement('button')
  own.type = 'button'
  own.className = 'nn-item'
  own.dataset.own = 'true'
  own.setAttribute('role', 'option')
  own.setAttribute('aria-selected', String(mode !== 'look'))
  own.disabled = busy
  own.textContent = '我的农场'
  own.addEventListener('click', () => {
    nnOpen = false
    if (mode === 'look') submit({ action: 'farm-refresh' })
    else renderPlots()
  })
  list.appendChild(own)

  for (const item of model.items) {
    const entry = document.createElement('button')
    entry.type = 'button'
    entry.className = 'nn-item'
    entry.dataset.device = item.deviceId
    entry.dataset.old = item.old ? 'true' : 'false'
    entry.setAttribute('role', 'option')
    entry.setAttribute('aria-selected', String(item.active))
    entry.disabled = busy || item.old
    const name = document.createElement('span')
    name.className = 'nn-item-name'
    name.textContent = item.label
    const sub = document.createElement('span')
    sub.className = 'nn-item-sub'
    sub.textContent = item.sub
    entry.appendChild(name)
    entry.appendChild(sub)
    entry.addEventListener('click', () => {
      nnOpen = false
      if (!item.old) submit({ action: 'farm-look', deviceId: item.deviceId })
      else renderPlots()
    })
    list.appendChild(entry)
  }
  return list
}

function neighborChipButton (item) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'nn-chip'
  button.dataset.device = item.deviceId
  button.textContent = item.label
  button.setAttribute('aria-pressed', String(item.active))
  button.title = item.sub
  button.disabled = busy || item.active || item.old
  button.addEventListener('click', () => {
    if (!item.old) submit({ action: 'farm-look', deviceId: item.deviceId })
  })
  return button
}

function renderPlots () {
  plotsEl.textContent = ''
  countdowns.clear()
  progressBars.clear()
  renderNeighborChips()
  renderVisitorBanner()
  if (mode === 'look' && look !== null) {
    renderLookPlots()
    return
  }
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
  const unlock = view.unlockCard(farm)
  const total = cards.length + (unlock === null ? 0 : 1)
  plotsEl.setAttribute('aria-label', '地块，共 ' + total + ' 块')
  for (const card of cards) {
    const built = view.createPlotCard(document, card)
    plotsEl.appendChild(built.element)
    if (built.countdown !== null) countdowns.set(card.plotId, built.countdown)
    if (built.progress !== null) progressBars.set(card.plotId, built.progress)
  }
  // 末尾一张「下一块」锁定卡：到 50 块就自动消失。
  if (unlock !== null) plotsEl.appendChild(view.createUnlockCard(document, unlock).element)
}

function stackChip (meta, count, kind, cropId) {
  const chip = document.createElement('span')
  chip.className = 'stack-chip' + (count <= 0 ? ' muted' : '')
  chip.dataset.stackKind = kind
  chip.dataset.crop = cropId
  const emoji = view.cropEmblem(document, meta, 'stack-emoji')
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
  // 记录页（ticket 45/48）：宿主给最近 100 条；列表自己滚动，不把窗口撑高。
  const entries = farm === null || !Array.isArray(farm.log) ? [] : farm.log.slice(0, 100)
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
    } else if (entry.kind === 'unlock') {
      const cost = Number(entry.cost)
      const plot = Number(entry.plot) || Number(entry.qty)
      text.textContent = '解锁了第 ' + (plot || '?') + ' 块地' +
        (Number.isFinite(cost) && cost > 0 ? ' · ' + cost + ' 硬币' : '')
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
      item.appendChild(view.cropEmblem(document, crop, 'carried-art'))
      item.appendChild(document.createTextNode(' ' + (crop === null ? '作物' : crop.name) +
        ' ×' + (Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1) + ' · 在驮包里'))
    } else {
      continue
    }
    carriedItemsEl.appendChild(item)
  }
  carriedEl.hidden = carriedItemsEl.childElementCount === 0
}

function marketEntry (cropId) {
  const entry = market?.prices?.[cropId]
  return entry !== null && typeof entry === 'object' ? entry : null
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

/** 当前这笔申请是不是这个作物/这条边（买 or 卖）：给按钮画「成交中…」。 */
function isTrading (side, cropId) {
  if (pending === null || pending.cropId !== cropId) return false
  return side === 'buy' ? pending.action === 'farm-buy-seed' : pending.action === 'farm-sell-crop'
}

/**
 * 把一行交易所的状态重新算一遍：数量、总价、按钮能不能点、为什么不能点。
 *
 * 以前这里只把按钮 disabled 掉；CSS 又让灰掉的买卖按钮和可点的长得一样，
 * 于是「硬币不够」时点下去什么都不发生——这一步就是把原因写到按钮下面。
 */
function applyTradeState (row, cropId) {
  if (row === null) return
  const input = row.querySelector('input[data-crop-qty]')
  const buy = row.querySelector('button[data-market-action="buy"]')
  const sell = row.querySelector('button[data-market-action="sell"]')
  const hintEl = row.querySelector('[data-trade-hint]')
  const quickBuy = row.querySelector('button[data-fill-buy]')
  const quickSell = row.querySelector('button[data-fill-sell]')
  const minus = row.querySelector('button[data-qty-step="-1"]')
  const plus = row.querySelector('button[data-qty-step="1"]')
  const quote = view.tradeView(farm, market, cropId, input?.value)
  if (quote === null) return
  const pendingHere = pending !== null
  if (input !== null && input !== undefined) {
    input.setAttribute('aria-invalid', quote.valid ? 'false' : 'true')
    input.disabled = pendingHere
  }
  const qtyNow = quote.valid ? quote.qty : MIN_TRADE_QTY
  if (minus !== null) minus.disabled = pendingHere || qtyNow <= MIN_TRADE_QTY
  if (plus !== null) plus.disabled = pendingHere || qtyNow >= MAX_TRADE_QTY
  if (buy !== null) {
    buy.disabled = pendingHere || !quote.canBuy
    buy.textContent = isTrading('buy', cropId)
      ? '成交中…'
      : quote.canBuy ? '买种 · ' + quote.seedTotal : quote.buyShort
    buy.title = quote.canBuy
      ? '买 ' + quote.qty + ' 颗' + quote.name + '种子，花 ' + quote.seedTotal + ' 硬币'
      : quote.buyHint
    buy.setAttribute('aria-label', quote.canBuy
      ? '买 ' + quote.qty + ' 颗' + quote.name + '种子，花 ' + quote.seedTotal + ' 硬币'
      : '买种不可用：' + quote.buyHint)
    buy.setAttribute('aria-busy', isTrading('buy', cropId) ? 'true' : 'false')
  }
  if (sell !== null) {
    sell.disabled = pendingHere || !quote.canSell
    sell.textContent = isTrading('sell', cropId)
      ? '成交中…'
      : quote.canSell ? '卖出 +' + quote.sellTotal : quote.sellShort
    sell.title = quote.canSell
      ? '卖 ' + quote.qty + ' 个' + quote.name + '，得 ' + quote.sellTotal + ' 硬币'
      : quote.sellHint
    sell.setAttribute('aria-label', quote.canSell
      ? '卖 ' + quote.qty + ' 个' + quote.name + '，得 ' + quote.sellTotal + ' 硬币'
      : '卖出不可用：' + quote.sellHint)
    sell.setAttribute('aria-busy', isTrading('sell', cropId) ? 'true' : 'false')
  }
  if (quickBuy !== null) {
    const empty = emptyPlotCount(farm)
    const want = Math.min(empty, quote.maxBuy)
    quickBuy.textContent = '买满 ' + want
    quickBuy.hidden = empty === 0 || want <= 0
    quickBuy.disabled = pendingHere || want <= 0
    quickBuy.title = empty === 0
      ? '没有空地了；等收一茬再来买种'
      : '把数量填成还能买的 ' + want + ' 颗（硬币/上限内）'
  }
  if (quickSell !== null) {
    quickSell.textContent = '全卖 ' + quote.maxSell
    quickSell.hidden = quote.maxSell <= 0
    quickSell.disabled = pendingHere || quote.maxSell <= 0
    quickSell.title = '把数量填成仓库里的 ' + quote.maxSell + ' 个'
  }
  if (hintEl !== null) {
    const buyHint = quote.buyHint
    const sellHint = quote.sellHint
    if (buyHint !== '' || sellHint !== '') {
      hintEl.dataset.tone = 'warn'
      hintEl.firstElementChild.textContent = [
        buyHint === '' ? '' : '买：' + buyHint,
        sellHint === '' ? '' : '卖：' + sellHint
      ].filter((text) => text !== '').join(' · ')
    } else {
      hintEl.dataset.tone = 'ok'
      hintEl.firstElementChild.textContent = '最多买 ' + quote.maxBuy + ' 颗 · 最多卖 ' + quote.maxSell + ' 个'
    }
  }
  row.setAttribute('aria-busy', pendingHere ? 'true' : 'false')
}

function renderMarket () {
  marketRowsEl.textContent = ''
  tradesEl.textContent = ''
  marketWalletEl.textContent = '🪙 ' + (Number(farm?.coins) || 0)
  if (market === null) {
    const empty = document.createElement('div')
    empty.className = 'market-empty'
    const title = document.createElement('b')
    title.textContent = '交易所还没开门'
    const body = document.createElement('span')
    body.textContent = '行情由宿主推过来，通常一两秒；没有邻居也能买种、卖作物。'
    empty.appendChild(title)
    empty.appendChild(body)
    marketRowsEl.appendChild(empty)
    return
  }

  for (const cropId of CROP_IDS) {
    const meta = CROP_META[cropId]
    const entry = marketEntry(cropId) ?? { base: meta.base, price: meta.base }
    const bid = Number(entry?.bid)
    const bidValue = Number.isFinite(bid) && bid >= 0
      ? Math.max(0, Math.round(bid))
      : Math.max(0, Math.round(Number(entry.price) * 0.9))
    const last = latestTrade(cropId)
    const row = document.createElement('article')
    row.className = 'market-row'
    row.dataset.cropId = cropId

    const head = document.createElement('div')
    head.className = 'market-row-head'
    const emoji = view.cropEmblem(document, meta, 'emoji')
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

    // 一行价目：卖出价（最该被看见的数）、种子价、局域网指数。
    const prices = document.createElement('div')
    prices.className = 'market-prices'
    const main = document.createElement('span')
    main.className = 'price-main'
    main.appendChild(document.createTextNode('卖价 '))
    const mainValue = document.createElement('b')
    mainValue.textContent = String(bidValue)
    main.appendChild(mainValue)
    const mainUnit = document.createElement('span')
    mainUnit.className = 'unit'
    mainUnit.textContent = '硬币/个'
    main.appendChild(mainUnit)
    main.title = '本机卖价：现在卖掉 1 个' + meta.name + '能拿到 ' + bidValue + ' 硬币'
    prices.appendChild(main)

    const seed = document.createElement('span')
    seed.className = 'price-sub'
    seed.appendChild(document.createTextNode('种子 '))
    const seedValue = document.createElement('b')
    seedValue.textContent = String(meta.seedPrice)
    seed.appendChild(seedValue)
    prices.appendChild(seed)

    // 局域网指数（ticket 42）：没有邻居样本时写「本机行情」，不画成有邻居的指数。
    const indexEntry = marketIndexEntry(cropId)
    const samples = Number(indexEntry?.samples)
    const index = document.createElement('span')
    index.className = 'price-sub'
    if (indexEntry === null || !Number.isFinite(samples) || samples <= 0) {
      index.classList.add('index-local')
      index.textContent = '本机行情'
    } else {
      index.classList.add(indexEntry.stale === true ? 'index-stale' : 'index-live')
      const label = document.createElement('span')
      label.textContent = indexEntry.stale === true ? '指数 过期 ' : '指数 '
      const value = document.createElement('b')
      value.textContent = formatMarketPrice(indexEntry.price)
      const unit = document.createElement('span')
      unit.className = 'unit'
      unit.textContent = ' · ' + Math.floor(samples) + ' 份'
      index.appendChild(label)
      index.appendChild(value)
      index.appendChild(unit)
      index.title = indexEntry.stale === true
        ? '局域网指数超过 2 分钟没更新，显示的是最后一次的中位数'
        : '局域网里 ' + Math.floor(samples) + ' 份报价的中位数'
    }
    prices.appendChild(index)
    row.appendChild(prices)

    const trade = document.createElement('div')
    trade.className = 'market-trade'
    const stepper = document.createElement('div')
    stepper.className = 'qty-stepper'
    stepper.setAttribute('role', 'group')
    stepper.setAttribute('aria-label', meta.name + '数量')
    const minus = document.createElement('button')
    minus.type = 'button'
    minus.dataset.qtyStep = '-1'
    minus.dataset.cropId = cropId
    minus.textContent = '−'
    minus.setAttribute('aria-label', '减少' + meta.name + '数量')
    const input = document.createElement('input')
    input.type = 'number'
    input.min = String(MIN_TRADE_QTY)
    input.max = String(MAX_TRADE_QTY)
    input.step = '1'
    input.inputMode = 'numeric'
    input.dataset.cropQty = cropId
    input.value = String(marketQty[cropId] ?? 1)
    input.setAttribute('aria-label', meta.name + '数量（1–99）')
    input.setAttribute('aria-describedby', 'trade-hint-' + cropId)
    const plus = document.createElement('button')
    plus.type = 'button'
    plus.dataset.qtyStep = '1'
    plus.dataset.cropId = cropId
    plus.textContent = '+'
    plus.setAttribute('aria-label', '增加' + meta.name + '数量')
    stepper.appendChild(minus)
    stepper.appendChild(input)
    stepper.appendChild(plus)

    const actions = document.createElement('div')
    actions.className = 'trade-actions'
    const buy = document.createElement('button')
    buy.type = 'button'
    buy.className = 'btn buy'
    buy.dataset.marketAction = 'buy'
    buy.dataset.cropId = cropId
    buy.textContent = '买种'
    buy.setAttribute('aria-describedby', 'trade-hint-' + cropId)
    const sell = document.createElement('button')
    sell.type = 'button'
    sell.className = 'btn sell'
    sell.dataset.marketAction = 'sell'
    sell.dataset.cropId = cropId
    sell.textContent = '卖出'
    sell.setAttribute('aria-describedby', 'trade-hint-' + cropId)
    actions.appendChild(buy)
    actions.appendChild(sell)
    trade.appendChild(stepper)
    trade.appendChild(actions)
    row.appendChild(trade)

    // 解释行：能点时显示「最多买/卖」，不能点时写明差多少；高度固定，不跳。
    const hint = document.createElement('p')
    hint.className = 'trade-hint'
    hint.id = 'trade-hint-' + cropId
    hint.dataset.tradeHint = cropId
    const hintText = document.createElement('span')
    hintText.className = 'hint-text'
    const quick = document.createElement('span')
    quick.className = 'quick'
    const quickBuy = document.createElement('button')
    quickBuy.type = 'button'
    quickBuy.dataset.fillBuy = cropId
    quickBuy.textContent = '买满'
    const quickSell = document.createElement('button')
    quickSell.type = 'button'
    quickSell.dataset.fillSell = cropId
    quickSell.textContent = '全卖'
    quick.appendChild(quickBuy)
    quick.appendChild(quickSell)
    hint.appendChild(hintText)
    hint.appendChild(quick)
    row.appendChild(hint)

    marketRowsEl.appendChild(row)
    applyTradeState(row, cropId)
  }

  const history = Array.isArray(market.history) ? market.history.slice(0, 8) : []
  if (history.length === 0) {
    const empty = document.createElement('li')
    empty.className = 'empty'
    empty.textContent = '还没有成交。买一包种子就是第一笔。'
    tradesEl.appendChild(empty)
    return
  }
  for (const entry of history) {
    const meta = cropMeta(entry.crop)
    const item = document.createElement('li')
    const text = document.createElement('span')
    const sideText = MARKET_SIDE_TEXT[entry.side]
    text.textContent = (meta === null ? '作物' : meta.name) + ' ' +
      (sideText === '买种' ? '买入' : sideText === '卖出' ? '卖出' : '成交') + ' ×' + entry.qty +
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
  quoteEl.textContent = quote === null
    ? '时长 ' + HIRE_HOURS_MIN + '–' + HIRE_HOURS_MAX + ' 小时'
    : '总价 ' + quote.total + '（含手续费 ' + quote.fee + '）'
  quoteEl.dataset.tone = quote === null ? 'error' : 'ok'
  input.setAttribute('aria-invalid', quote === null ? 'true' : 'false')
}

function hireDraftOf () {
  return {
    enabled: hireEnabledEl.checked === true,
    wagePerHour: Number(hireWageEl.value),
    minHours: Number(hireMinEl.value),
    maxHours: Number(hireMaxEl.value)
  }
}

/** 每个字段各自的错误文案：就地显示，不再只丢一条 toast。 */
function hireFieldErrors (draft) {
  const errors = { wagePerHour: '', minHours: '', maxHours: '' }
  if (!Number.isInteger(draft.wagePerHour) || draft.wagePerHour < HIRE_WAGE_MIN || draft.wagePerHour > HIRE_WAGE_MAX) {
    errors.wagePerHour = HIRE_WAGE_MIN + '–' + HIRE_WAGE_MAX
  }
  if (!Number.isInteger(draft.minHours) || draft.minHours < HIRE_HOURS_MIN || draft.minHours > HIRE_HOURS_MAX) {
    errors.minHours = HIRE_HOURS_MIN + '–' + HIRE_HOURS_MAX
  }
  if (!Number.isInteger(draft.maxHours) || draft.maxHours < HIRE_HOURS_MIN || draft.maxHours > HIRE_HOURS_MAX) {
    errors.maxHours = HIRE_HOURS_MIN + '–' + HIRE_HOURS_MAX
  }
  if (errors.minHours === '' && errors.maxHours === '' && draft.minHours > draft.maxHours) {
    errors.minHours = '不能超过最长'
    errors.maxHours = '不能短于最短'
  }
  return errors
}

function markHireField (input, errorEl, message) {
  if (input === null || input === undefined) return
  input.setAttribute('aria-invalid', message === '' ? 'false' : 'true')
  if (errorEl !== null && errorEl !== undefined) errorEl.textContent = message
}

/** 表单的就地状态：每个输入自己的错误、保存按钮可不可点、有没有未保存的改动。 */
function renderHireFormState () {
  if (hireFormEl === null) return
  const draft = hireDraftOf()
  const errors = hireFieldErrors(draft)
  markHireField(hireWageEl, hireWageErrorEl, errors.wagePerHour)
  markHireField(hireMinEl, hireMinErrorEl, errors.minHours)
  markHireField(hireMaxEl, hireMaxErrorEl, errors.maxHours)
  const valid = errors.wagePerHour === '' && errors.minHours === '' && errors.maxHours === ''
  const saving = pending !== null && pending.action === 'hire-listing'
  if (hireSaveEl !== null) {
    hireSaveEl.disabled = busy || !valid
    hireSaveEl.textContent = saving ? '保存中…' : '保存挂牌'
    hireSaveEl.setAttribute('aria-busy', saving ? 'true' : 'false')
  }
  if (hireFormStatusEl !== null) {
    if (!valid) {
      hireFormStatusEl.dataset.tone = 'error'
      hireFormStatusEl.textContent = '先把标红的数字改到范围内。'
    } else if (saving) {
      hireFormStatusEl.dataset.tone = 'ok'
      hireFormStatusEl.textContent = '正在把挂牌交给宿主…'
    } else if (hireDirty) {
      hireFormStatusEl.dataset.tone = 'warn'
      hireFormStatusEl.textContent = '改过了，按「保存挂牌」生效。'
    } else {
      hireFormStatusEl.dataset.tone = 'ok'
      hireFormStatusEl.textContent = ''
    }
  }
}

/** 宿主刷新时填挂牌表单；用户正在编辑就不覆盖。 */
function syncHireForm () {
  if (hireFormEl === null) return
  const focused = document.activeElement
  if ((focused !== null && hireFormEl.contains(focused)) || hireDirty) {
    renderHireFormState()
    return
  }
  const hire = farm?.hire
  if (hire !== null && typeof hire === 'object') {
    hireEnabledEl.checked = hire.enabled === true
    hireWageEl.value = String(hire.wagePerHour)
    hireMinEl.value = String(hire.minHours)
    hireMaxEl.value = String(hire.maxHours)
  }
  renderHireFormState()
}

function contractStatusText (contract) {
  if (contract.status === 'active') return '进行中'
  if (contract.status === 'pending') return '联系中'
  if (contract.status === 'cancelled') return '已取消'
  return contract.settled === true ? '已结算' : '已结束'
}

function contractStatusTone (contract) {
  if (contract.status === 'active') return 'ok'
  return 'off'
}

function contractRow (contract, side) {
  const row = document.createElement('div')
  row.className = 'hire-row'
  row.dataset.contractId = contract.id
  row.dataset.side = side
  const head = document.createElement('div')
  head.className = 'hire-row-head'
  const avatar = document.createElement('span')
  avatar.className = 'avatar'
  avatar.setAttribute('aria-hidden', 'true')
  avatar.textContent = side === 'outgoing' ? '👷' : '🏠'
  const grow = document.createElement('div')
  grow.className = 'grow'
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
    : '已挣 ' + (contract.earned || 0) + '/' + contract.wage
  meta.textContent = contractRemainingText(contract) + ' · ' + money
  grow.appendChild(name)
  grow.appendChild(meta)
  head.appendChild(avatar)
  head.appendChild(grow)
  const pill = document.createElement('span')
  pill.className = 'hire-pill'
  pill.dataset.tone = contractStatusTone(contract)
  pill.textContent = contractStatusText(contract)
  head.appendChild(pill)
  if (contract.status === 'active') {
    const action = side === 'outgoing' ? 'end-contract' : 'recall-worker'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn danger'
    btn.dataset.hireAction = action
    btn.dataset.contractId = contract.id
    btn.textContent = side === 'outgoing' ? '结束' : '召回'
    btn.disabled = busy
    head.appendChild(btn)
    contractCountdowns.set(contract.id, {
      node: meta,
      remaining: Math.max(0, Number(contract.remainingMs) || 0),
      text: money
    })
  } else {
    contractCountdowns.delete(contract.id)
  }
  row.appendChild(head)
  return row
}

function hireReasonText (listing, stale) {
  if (stale === true) return '行情过期，等下一轮广播'
  // 不能雇的邻居也把价钱写出来：右边的小圆片负责说「为什么不能雇」，
  // 这一行不用再重复一遍「在打工」。
  const wage = Number(listing.wagePerHour)
  const min = Number(listing.minHours)
  const max = Number(listing.maxHours)
  if (Number.isFinite(wage) && Number.isFinite(min) && Number.isFinite(max)) {
    return wage + ' 硬币/时 · ' + min + '–' + max + ' 小时'
  }
  if (listing.reason === 'off') return '没挂牌'
  return '现在不能雇'
}

function hirePillTone (listing, stale) {
  if (stale === true) return 'off'
  return listing.available === true ? 'ok' : 'off'
}

function hireInitial (nickname) {
  const name = typeof nickname === 'string' && nickname.trim() !== '' ? nickname.trim() : '邻居'
  return Array.from(name)[0]
}

function listingRow (listing, pendingHire, stale) {
  const row = document.createElement('div')
  row.className = 'hire-row'
  row.dataset.deviceId = listing.deviceId
  row.dataset.stale = stale === true || listing.available !== true ? 'true' : 'false'
  const head = document.createElement('div')
  head.className = 'hire-row-head'
  const avatar = document.createElement('span')
  avatar.className = 'avatar'
  avatar.setAttribute('aria-hidden', 'true')
  avatar.textContent = hireInitial(listing.nickname)
  const grow = document.createElement('div')
  grow.className = 'grow'
  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = listing.nickname ?? '邻居'
  const meta = document.createElement('span')
  meta.className = 'meta'
  meta.textContent = hireReasonText(listing, stale)
  grow.appendChild(name)
  grow.appendChild(meta)
  head.appendChild(avatar)
  head.appendChild(grow)
  const pill = document.createElement('span')
  pill.className = 'hire-pill'
  pill.dataset.tone = hirePillTone(listing, stale)
  pill.textContent = stale === true
    ? '行情过期'
    : listing.available === true
      ? '可雇'
      : listing.reason === 'working'
        ? '在打工'
        : listing.reason === 'visiting'
          ? '在串门'
          : listing.reason === 'off' ? '没挂牌' : '不能雇'
  head.appendChild(pill)
  row.appendChild(head)

  if (listing.available === true && stale !== true) {
    const foot = document.createElement('div')
    foot.className = 'hire-row-foot'
    const hoursLabel = document.createElement('label')
    hoursLabel.className = 'hire-hours'
    hoursLabel.textContent = '时长'
    const hours = document.createElement('input')
    hours.type = 'number'
    hours.min = String(listing.minHours)
    hours.max = String(listing.maxHours)
    hours.step = '1'
    hours.value = String(listing.minHours)
    hours.inputMode = 'numeric'
    hours.dataset.hireHours = listing.deviceId
    hours.setAttribute('aria-label', (listing.nickname ?? '邻居') + '的雇佣时长（小时）')
    const unit = document.createElement('span')
    unit.textContent = '时'
    hoursLabel.appendChild(hours)
    hoursLabel.appendChild(unit)
    const quote = document.createElement('span')
    quote.className = 'hire-quote'
    quote.dataset.hireQuote = listing.deviceId
    const initialQuote = hireQuote(listing, hours.value)
    quote.textContent = initialQuote === null
      ? '时长 ' + HIRE_HOURS_MIN + '–' + HIRE_HOURS_MAX + ' 小时'
      : '总价 ' + initialQuote.total + '（含手续费 ' + initialQuote.fee + '）'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn primary'
    btn.dataset.hireAction = 'hire'
    btn.dataset.deviceId = listing.deviceId
    btn.textContent = pendingHire ? '联系中…' : '雇佣'
    btn.disabled = busy || pendingHire
    btn.setAttribute('aria-busy', pendingHire ? 'true' : 'false')
    foot.appendChild(hoursLabel)
    foot.appendChild(quote)
    foot.appendChild(btn)
    row.appendChild(foot)
  }
  return row
}

function renderHire () {
  if (hirePageEl === null) return
  syncHireForm()
  contractCountdowns.clear()

  const hire = farm?.hire
  const listed = hire !== null && typeof hire === 'object' && hire.enabled === true
  if (hireStatusEl !== null) {
    hireStatusEl.dataset.on = listed ? 'true' : 'false'
    hireStatusEl.textContent = listed ? '接单中' : '休息中'
  }

  contractsEl.textContent = ''
  const outgoing = Array.isArray(contracts?.outgoing) ? contracts.outgoing : []
  const incoming = Array.isArray(contracts?.incoming) ? contracts.incoming : []
  const rows = [...outgoing.map((contract) => contractRow(contract, 'outgoing')),
    ...incoming.map((contract) => contractRow(contract, 'incoming'))]
  if (hireContractCountEl !== null) hireContractCountEl.textContent = rows.length + ' 份'
  if (rows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'hire-empty'
    const title = document.createElement('b')
    title.textContent = '还没有合同'
    const body = document.createElement('span')
    body.textContent = '在下面的「邻居挂牌」里雇一位，或打开上面的开关让邻居雇你。'
    empty.appendChild(title)
    empty.appendChild(body)
    contractsEl.appendChild(empty)
  } else {
    for (const row of rows) contractsEl.appendChild(row)
  }

  listingsEl.textContent = ''
  const listings = Array.isArray(contracts?.listings) ? contracts.listings : []
  if (hireListingCountEl !== null) hireListingCountEl.textContent = listings.length + ' 位'
  const pendingHire = contracts?.pendingHire === true || (pending !== null && pending.action === 'hire')
  const now = Date.now()
  if (listings.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'hire-empty'
    const title = document.createElement('b')
    title.textContent = '还没收到邻居的挂牌'
    const body = document.createElement('span')
    body.textContent = '挂牌每 30 秒随行情广播一次；先打开上面的开关，下一轮别人才看得见你。'
    empty.appendChild(title)
    empty.appendChild(body)
    listingsEl.appendChild(empty)
  } else {
    for (const listing of listings) {
      listingsEl.appendChild(listingRow(listing, pendingHire, view.listingIsStale(listing, now)))
    }
  }
  listingStaleKey = listingStaleSignature(now)

  const guard = Number(farm?.guard)
  if (hireHintEl !== null) {
    hireHintEl.textContent = '手续费 5%（最低 1 硬币，烧掉）。' +
      (Number.isFinite(guard) ? ' 自家守卫 ' + Math.round(guard * 100) + '%。' : '') +
      (pendingHire ? ' 正在联系雇主…' : '')
  }
  renderHireFormState()
}

function submitHireListing () {
  const draft = hireDraftOf()
  const errors = hireFieldErrors(draft)
  if (errors.wagePerHour !== '' || errors.minHours !== '' || errors.maxHours !== '') {
    renderHireFormState()
    // 把焦点放到第一个坏字段：键盘用户不用自己找。
    const target = errors.wagePerHour !== '' ? hireWageEl : errors.minHours !== '' ? hireMinEl : hireMaxEl
    if (target !== null && target !== undefined && typeof target.focus === 'function') target.focus()
    return
  }
  submit({
    action: 'hire-listing',
    enabled: draft.enabled,
    wagePerHour: draft.wagePerHour,
    minHours: draft.minHours,
    maxHours: draft.maxHours
  })
}

/** 挂牌的新鲜度签名：只比「哪些户过期了」，变了才整页重画。 */
function listingStaleSignature (now = Date.now()) {
  const listings = Array.isArray(contracts?.listings) ? contracts.listings : []
  return listings
    .map((listing) => listing.deviceId + ':' + (view.listingIsStale(listing, now) ? '1' : '0'))
    .join('|')
}

/** 雇工页的倒计时只改文本：每 1 秒一次；合同归零或挂牌跨过 expiresAt 时重画一次。 */
function tickContracts () {
  if (contracts === null) return false
  let needsRender = false
  const key = listingStaleSignature(Date.now())
  if (key !== listingStaleKey) {
    listingStaleKey = key
    needsRender = true
  }
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
    const emoji = view.cropEmblem(document, meta, 'seed-emoji')
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

/** 解锁确认（ticket 49）：价格、余额、解锁后余额、接下来 5 块的价格都摆出来。 */
function openUnlockModal () {
  if (mode !== 'owner' || farm === null || busy || batch !== null) return
  const card = view.unlockCard(farm)
  if (card === null) return
  unlockTarget = card
  if (unlockTitleEl !== null) unlockTitleEl.textContent = '解锁' + card.label
  if (unlockSubEl !== null) {
    unlockSubEl.textContent = '价格 ' + card.priceText + ' · 余额 ' + card.coins + ' 硬币'
  }
  if (unlockBodyEl !== null) {
    unlockBodyEl.textContent = ''
    const line = document.createElement('p')
    const after = card.coins - card.nextCost
    line.textContent = '解锁后余额 ' + after + ' 硬币，至少留 ' + card.reserve + ' 硬币买种子。' +
      (card.affordable ? '' : '（' + card.shortText + '）')
    unlockBodyEl.appendChild(line)
    if (card.ladder.length > 1) {
      const title = document.createElement('h4')
      title.textContent = '接下来'
      unlockBodyEl.appendChild(title)
      const list = document.createElement('ul')
      // 第 0 项就是当前这块，标题里已经有了；这里只列后面的。
      for (let index = 1; index < card.ladder.length; index += 1) {
        const item = document.createElement('li')
        item.textContent = '地块 ' + (card.plotNumber + index) + ' · ' + card.ladder[index] + ' 硬币'
        list.appendChild(item)
      }
      unlockBodyEl.appendChild(list)
    }
  }
  if (unlockConfirmEl !== null) {
    unlockConfirmEl.textContent = '解锁 · ' + card.priceText
    unlockConfirmEl.disabled = card.affordable !== true
  }
  if (unlockModalEl !== null) unlockModalEl.hidden = false
  const focusEl = card.affordable === true ? unlockConfirmEl : unlockCloseEl
  if (focusEl !== null && typeof focusEl.focus === 'function') focusEl.focus()
}

function closeUnlockModal () {
  unlockTarget = null
  if (unlockModalEl !== null) unlockModalEl.hidden = true
  if (unlockBodyEl !== null) unlockBodyEl.textContent = ''
}

function confirmUnlock () {
  if (unlockTarget === null || farm === null || busy || batch !== null) return
  // 用弹窗打开时看到的数字，而不是此刻的 farm.unlocked：宿主那边的乐观锁才有意义。
  const expected = unlockTarget.plotNumber - 1
  closeUnlockModal()
  submit({ action: 'farm-unlock', expectedUnlocked: expected })
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

/** 收到宿主 state 时记下每块地的倒计时基线；tick 用 Date.now() 算真实经过时间。 */
function primeCountdowns (plots) {
  if (!Array.isArray(plots)) return
  const at = Date.now()
  for (const plot of plots) {
    if (plot === null || typeof plot !== 'object' || plot.stage !== 'growing') continue
    const remaining = Number(plot.remainingMs)
    plot.baseRemainingMs = Number.isFinite(remaining) ? remaining : 0
    plot.baseAt = at
  }
}

/** 本地到 0 时请宿主重推 state：成熟与否只认宿主的 stage，窗口不自己标 mature。 */
function requestFarmRefresh () {
  const now = Date.now()
  if (refreshPending || now - refreshAt < 1000) return
  if (api === null || typeof api.submit !== 'function') return
  refreshPending = true
  refreshAt = now
  try {
    api.submit({ action: 'farm-refresh' })
  } catch {
    refreshPending = false
  }
}

/**
 * 每秒推进：倒计时 = 基线 − (Date.now() − 基线时刻)。
 *
 * 不再“每次 interval 减 1s”：Electron 的 interval 会被后台/渲染忙延迟，减 1s 会累积误差；
 * 种下一块触发 state 刷新时，老卡片就会跳。按真实时间算，延迟多久下一次 tick 都能追上。
 * 到 0 也不本地标 mature——请宿主确认，避免本地时钟早几毫秒时收获被回 not-mature。
 */
function tickPlots () {
  const plots = mode === 'visitor' && visit !== null && Array.isArray(visit.plots)
    ? visit.plots
    : (farm !== null && Array.isArray(farm.plots) ? farm.plots : null)
  if (plots === null) return
  const now = Date.now()
  for (const plot of plots) {
    if (plot.stage !== 'growing') continue
    try {
      const base = Number.isFinite(Number(plot.baseRemainingMs))
        ? Number(plot.baseRemainingMs)
        : Number(plot.remainingMs)
      const baseAt = Number.isFinite(Number(plot.baseAt)) ? Number(plot.baseAt) : now
      plot.remainingMs = Math.max(0, base - (now - baseAt))
      if (plot.remainingMs === 0) {
        // 先把这张卡停在「马上就好」，再请宿主确认；不直接标 mature。
        const done = countdowns.get(plot.id)
        if (done !== undefined) done.textContent = formatRemaining(0)
        const full = progressBars.get(plot.id)
        if (full !== undefined) full.style.width = '100%'
        requestFarmRefresh()
        continue
      }
      const node = countdowns.get(plot.id)
      if (node !== undefined) node.textContent = formatRemaining(plot.remainingMs)
      const fill = progressBars.get(plot.id)
      if (fill !== undefined) fill.style.width = Math.round(view.progressOf(plot) * 100) + '%'
    } catch {
      // 一张坏卡不能拖住其它地块的倒计时（ticket 47.1）。
    }
  }
}

function tick () {
  if (activeTab === 'hire') tickContracts()
  tickPlots()
}

/** 真正把一次申请交给主进程；批量队列在两条申请之间复用这条窄口。 */
function dispatch (payload) {
  busy = true
  pending = { action: payload?.action ?? '', cropId: payload?.cropId ?? null }
  render()
  try {
    api.submit(payload)
  } catch {
    busy = false
    pending = null
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

/**
 * 一键种满（ticket 49）：按空地与种子库存排一条队列，逐条发 farm-plant。
 * 原来只种第一块，50 块地靠手点不现实；现在和收割共用同一条串行队列。
 */
function startBatchPlant () {
  if (busy || batch !== null || farm === null) return
  const targets = view.batchPlantTargets(farm)
  if (targets.length === 0) {
    showToast(emptyPlotCount(farm) > 0 ? '种子袋空了，去交易所买种吧。' : '没有空地了，先收一块吧。', 'info')
    return
  }
  batch = { kind: 'plant', queue: targets, done: 0, total: targets.length, inFlight: false }
  sendNextBatch()
}

/** 批量队列的公共推进：种满与收割都走这里，逐条等回执再发下一条。 */
function sendNextBatch () {
  if (batch === null) return
  const item = batch.queue.shift()
  if (item === undefined) {
    const done = batch.done
    const kind = batch.kind
    batch = null
    busy = false
    render()
    showToast(kind === 'plant'
      ? '一键种满完成：种了 ' + done + ' 块地。'
      : '一键收割完成：收了 ' + done + ' 块地。', 'reward')
    return
  }
  batch.inFlight = true
  if (batch.kind === 'plant') dispatch({ action: 'farm-plant', plotId: item.plotId, cropId: item.cropId })
  else dispatch({ action: 'farm-harvest', plotId: item.plotId })
}

/** 一键收割：按当前顺序把所有成熟地块排进队列，逐条等回执。 */
function startBatchHarvest () {
  if (busy || batch !== null || farm === null) return
  const targets = view.batchHarvestTargets(farm)
  if (targets.length === 0) {
    showToast('没有成熟的地块，再等等吧。', 'info')
    return
  }
  batch = {
    kind: 'harvest',
    queue: targets.map((plotId) => ({ plotId })),
    done: 0,
    total: targets.length,
    inFlight: false
  }
  sendNextBatch()
}

plotsEl.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  // 锁定卡（ticket 49）：按钮不带 plotId，先于地块按钮判断。
  const unlockEl = target.closest('button[data-land-action="unlock"]')
  if (unlockEl !== null) {
    if (unlockEl.disabled) return
    openUnlockModal()
    return
  }
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

if (unlockConfirmEl !== null) unlockConfirmEl.addEventListener('click', confirmUnlock)
if (unlockCloseEl !== null) unlockCloseEl.addEventListener('click', closeUnlockModal)
if (unlockBackdropEl !== null) unlockBackdropEl.addEventListener('click', closeUnlockModal)
if (batchPlantEl !== null) batchPlantEl.addEventListener('click', startBatchPlant)
if (batchHarvestEl !== null) batchHarvestEl.addEventListener('click', startBatchHarvest)

function selectTab (name) {
  // 票 52：看田只有一页（地块 + 「派它去偷」），页签与其余三页整块藏起来。
  const looking = mode === 'look'
  const tabList = document.querySelector('.tabs')
  if (tabList !== null) tabList.style.display = looking ? 'none' : ''
  activeTab = looking
    ? 'farm'
    : name === 'market' ? 'market' : name === 'hire' ? 'hire' : name === 'log' ? 'log' : 'farm'
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
  applyTradeState(target.closest('.market-row'), cropId)
})

/** 数量只改输入框；成交仍要用户按「买种 / 卖出」。 */
function setTradeQty (row, cropId, next) {
  const input = row?.querySelector('input[data-crop-qty]')
  if (input === null || input === undefined) return
  const value = Math.min(MAX_TRADE_QTY, Math.max(MIN_TRADE_QTY, Math.round(Number(next) || MIN_TRADE_QTY)))
  input.value = String(value)
  marketQty[cropId] = input.value
  applyTradeState(row, cropId)
}

marketRowsEl.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const row = target.closest('.market-row')
  if (row === null) return
  const cropId = row.dataset.cropId
  if (typeof cropId !== 'string' || !Object.prototype.hasOwnProperty.call(CROP_META, cropId)) return
  const input = row.querySelector('input[data-crop-qty]')
  const current = Number(input?.value)

  // − / +：一步一颗；到 1 或 99 就停。
  const stepEl = target.closest('button[data-qty-step]')
  if (stepEl !== null) {
    if (stepEl.disabled) return
    // 输入框被清空/写了小数时，第一次点 ± 先回到 1，而不是从 1 再加一步。
    const next = Number.isInteger(current) ? current + Number(stepEl.dataset.qtyStep) : MIN_TRADE_QTY
    setTradeQty(row, cropId, next)
    return
  }

  // 买满空地：只把数量填成「还能买且种得下」的颗数，不直接成交。
  const fillBuy = target.closest('button[data-fill-buy]')
  if (fillBuy !== null) {
    if (fillBuy.disabled) return
    const quote = view.tradeView(farm, market, cropId, 1)
    const empty = emptyPlotCount(farm)
    const want = Math.min(empty, quote?.maxBuy ?? 0)
    if (want > 0) {
      setTradeQty(row, cropId, want)
    } else {
      showToast(empty === 0 ? '没有空地了；等收一茬再来买种。' : '硬币不够买一颗种子。', 'info')
    }
    return
  }

  // 全卖：把数量填成仓库里的数，不直接成交。
  const fillSell = target.closest('button[data-fill-sell]')
  if (fillSell !== null) {
    if (fillSell.disabled) return
    const quote = view.tradeView(farm, market, cropId, 1)
    const want = quote?.maxSell ?? 0
    if (want > 0) setTradeQty(row, cropId, want)
    else showToast('仓库里还没有' + CROP_META[cropId].name + '。', 'info')
    return
  }

  const buttonEl = target.closest('button[data-market-action]')
  if (buttonEl === null) return
  if (input !== null && input !== undefined) marketQty[cropId] = input.value
  const quote = view.tradeView(farm, market, cropId, marketQty[cropId])
  if (quote === null) return
  const side = buttonEl.dataset.marketAction
  if (buttonEl.disabled) {
    // 原生 disabled 收不到 click；万一收到（脚本/样式改动），也把原因说出来。
    const reason = side === 'buy' ? quote.buyHint : quote.sellHint
    if (reason !== '') showToast(reason, 'info')
    return
  }
  if (busy) return
  submit({
    action: side === 'buy' ? 'farm-buy-seed' : 'farm-sell-crop',
    cropId,
    qty: quote.qty
  })
})

// 雇工页（ticket 44）：保存挂牌 / 雇佣 / 召回 / 结束。只发窄字段，总价由宿主算。
hireSaveEl?.addEventListener('click', () => submitHireListing())
hireFormEl?.addEventListener('input', () => {
  hireDirty = true
  renderHireFormState()
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
  if (unlockTarget !== null) {
    closeUnlockModal()
    return
  }
  api?.close()
})

api?.onState((payload) => {
  if (payload === null || typeof payload !== 'object') return
  // 票 59：作物目录随每一包下发（内置六种 + `<dataDir>/crops.json` 里手写的）。
  // 先换目录再画，不然新作物会被当成未知 id 画成空地。
  view.setCrops(payload.crops)
  farm = payload.farm !== null && typeof payload.farm === 'object' ? payload.farm : null
  market = payload.market !== null && typeof payload.market === 'object' ? payload.market : null
  contracts = payload.contracts !== null && typeof payload.contracts === 'object' ? payload.contracts : null
  mode = payload.mode === 'look' ? 'look' : payload.mode === 'visitor' ? 'visitor' : 'owner'
  visit = mode === 'visitor' && payload.visit !== null && typeof payload.visit === 'object'
    ? payload.visit
    : null
  look = mode === 'look' && payload.look !== null && typeof payload.look === 'object'
    ? payload.look
    : null
  neighborChips = Array.isArray(payload.neighbors) ? payload.neighbors : []
  // 票 57：**别在这里把 nnOpen 关掉**。宿主每推一包（行情摘要/邻居动作）都会走到这儿，
  // 菜单就会"点开→瞬间消失"。开合只由用户操作决定（点胶囊/点条目/Esc）。
  // 看田只有地块这一页：页签整块藏起来（`selectTab` 里也做了一次，这里管状态推送这条路径）。
  // `.tabs` 是 `display:flex`，光设 `hidden` 会被 CSS 盖掉：显式改 display。
  const tabList = document.querySelector('.tabs')
  if (tabList !== null) tabList.style.display = mode === 'look' ? 'none' : ''
  selectedPlot = typeof payload.plotId === 'string' && payload.plotId !== '' ? payload.plotId : null
  // ticket 47.1：每次宿主 state 都是新的倒计时基线；重置“到点确认”的在飞标记。
  primeCountdowns(farm?.plots)
  primeCountdowns(visit?.plots)
  refreshPending = false
  if (mode !== 'owner') {
    // 访客模式没有一键种满/收割，也没有播种/解锁弹窗；正在跑的批量队列立刻停。
    batch = null
    closePlantModal()
    closeUnlockModal()
  }
  // 不在这里把 busy 复位：宿主会在 action-result 之前推一份新 farm-state，
  // 这时动作还在飞，提前解锁会让用户点到一条会被主进程静默丢掉的动作。
  render()
})

api?.onResult((result) => {
  // ticket 47.1：到点确认不是用户动作，不弹 toast，也不碰 busy/批量队列。
  if (result !== null && typeof result === 'object' && result.action === 'farm-refresh') {
    refreshPending = false
    return
  }
  const wasBatch = batch !== null && batch.inFlight === true
  const finished = pending
  busy = false
  pending = null
  if (wasBatch) batch.inFlight = false
  if (result === null || typeof result !== 'object') {
    if (batch !== null) batch = null
    render()
    return
  }
  // 挂牌真的保存成功之后才放开「未保存」标记；失败时保留用户改过的数字，好让他再试。
  if (result.ok === true && finished !== null && finished.action === 'hire-listing') hireDirty = false
  if (result.ok === true) {
    const notice = typeof result.notice === 'string' && result.notice.trim() !== ''
      ? result.notice
      : '完成了。'
    if (wasBatch) {
      batch.done += 1
      render()
      // 批量里不再逐条弹 toast：一次只留一条气泡时，逐条弹只会闪；
      // 地块已经在逐块变，收完由 sendNextBatch 给一条汇总。
      sendNextBatch()
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

// 切走/失焦后 interval 可能被节流；回来先按真实时间补一帧。
// 不在这里请宿主重推：focus 在冒烟/真实输入里很频繁，会和用户动作争同一条动作管道。
window.addEventListener('focus', () => {
  tick()
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  tick()
})

setInterval(tick, 1000)
api?.ready()
