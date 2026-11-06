/**
 * 农场小窗的渲染端（ticket 40）。
 *
 * 它只做三件事：把宿主推来的完整 farm view 画成 4 块地；每秒本地递减倒计时；
 * 把「种 / 收 / 浇 / 施肥」当**申请**交给主进程。仓库、硬币、成熟与否全部由宿主算，
 * 成功与否也等宿主回执——窗口不自己改状态。
 */
'use strict'

const api = window.dshZooFarm
const plotsEl = document.getElementById('plots')
const inventoryEl = document.getElementById('inventory')
const logEl = document.getElementById('log')
const subtitleEl = document.getElementById('subtitle')
const toastEl = document.getElementById('toast')
const closeButton = document.getElementById('close')

const CROP_META = {
  tomato: { name: '小番茄', emoji: '🍅' },
  carrot: { name: '胡萝卜', emoji: '🥕' },
  pumpkin: { name: '南瓜', emoji: '🎃' }
}
const CROP_IDS = Object.keys(CROP_META)
const PLOT_LABEL = { 1: '地块 1', 2: '地块 2', 3: '地块 3', 4: '地块 4' }
const WATER_COST = 1
const FERTILIZE_COST = 5

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
  'plot-occupied': '这块地已经种上了，先收掉再种。',
  'not-mature': '还没熟呢，再等一会儿。',
  'no-seed': '没有这种种子了，先去交易所买。',
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

let farm = null
let selectedPlot = null
let busy = false
let toastTimer = null
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
  const date = new Date(Number(at))
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
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

closeButton.addEventListener('click', () => api?.close())

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  api?.close()
})

api?.onState((payload) => {
  if (payload === null || typeof payload !== 'object') return
  farm = payload.farm !== null && typeof payload.farm === 'object' ? payload.farm : null
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

render()
setInterval(tick, 1000)
api?.ready()
