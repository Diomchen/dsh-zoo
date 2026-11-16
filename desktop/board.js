/**
 * 盘口小窗的渲染端（票 79）。
 *
 * 它只做三件事：把宿主推来的盘口视图画成卡片；每秒本地递减倒计时（到 0 请宿主重推
 * 一拍）；把「开仓 / 平仓」当**申请**交给主进程。价格、硬币、盈亏、能不能下单全部
 * 由宿主算，成功与否也等宿主回执——窗口不自己改状态、不自己算钱。
 *
 * 票 81 会在这里加 K 线、三作物切换与周榜；票 79 只做最小的一屏。
 */
'use strict'

const api = window.dshZooBoard
const view = window.dshZooBoardView

const titleEl = document.getElementById('board-title')
const subtitleEl = document.getElementById('board-subtitle')
const priceEl = document.getElementById('price')
const changeEl = document.getElementById('change')
const countdownEl = document.getElementById('countdown')
const coinsAvailableEl = document.getElementById('coins-available')
const coinsTotalEl = document.getElementById('coins-total')
const orderCropEl = document.getElementById('order-crop')
const sideRowEl = document.getElementById('side-row')
const marginRowEl = document.getElementById('margin-row')
const previewEl = document.getElementById('preview')
const submitEl = document.getElementById('submit')
const orderHintEl = document.getElementById('order-hint')
const positionsEl = document.getElementById('positions')
const positionsMetaEl = document.getElementById('positions-meta')
const positionsEmptyEl = document.getElementById('positions-empty')
const historyEl = document.getElementById('history')
const historyMetaEl = document.getElementById('history-meta')
const historyEmptyEl = document.getElementById('history-empty')
const closeButton = document.getElementById('close')
const toastsEl = document.getElementById('toasts')

/**
 * 主进程只会用错误码回传传输层失败（超时/管道断/坏形状）；宿主给的 notice 已经是人话，
 * 优先显示它。这些码不是产品文案，只是窗口的兜底。
 */
const RESULT_CODE_TEXT = {
  timeout: '桌面宿主没有回应，这次操作可能没有生效。',
  'host-unavailable': '桌面宿主没有连接，这次没有完成。',
  'bad-board-action': '这个操作缺少方向或保证金，再试一次。',
  'bad-crop': '这种作物暂时没有盘口。',
  'bad-side': '方向只有做多和做空。',
  'bad-margin': '保证金只有 50 和 100 两档。',
  'bad-leverage': '这档杠杆还没开放。',
  'no-coin': '硬币不够，先去种地或卖点作物。',
  'no-position': '这个仓位已经平掉了。',
  settling: '这个仓位正在结算，等一下再看。',
  starting: '盘口还在准备中，稍等一下再试。'
}

/** 宿主推来的最后一份视图；null = 还没收到（窗口先画空态）。 */
let payload = null
/** 当前选择（只活在窗口里，开仓成功后保持不变，方便连做）。 */
let side = 'long'
let margin = 50
/** 有申请在飞：连点不会串单（主进程也会挡，这里只是立刻反馈）。 */
let pending = false
/** 这一根的收盘时刻（本地倒计时基线，每次宿主推包都重置）。 */
let barEnd = 0
/** 这一根已经问过「到点了，重推一拍」没有；每根只问一次。 */
let refreshAsked = false

function setTone (element, tone) {
  element.dataset.tone = tone
}

function renderHeader (board) {
  const header = board.header
  titleEl.textContent = header.cropName === '—' ? '盘口' : '盘口 · ' + header.cropName
  subtitleEl.textContent = '15 分钟合约 · 收盘自动结算'
  priceEl.textContent = header.priceText
  setTone(priceEl, header.tone)
  changeEl.textContent = header.changeText
  setTone(changeEl, header.tone)
  countdownEl.textContent = header.countdownText
  coinsAvailableEl.textContent = header.coinsAvailableText
  coinsTotalEl.textContent = header.coinsTotalText
  orderCropEl.textContent = header.cropName
}

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
    button.className = 'chip'
    button.dataset.margin = String(choice.margin)
    button.setAttribute('aria-pressed', choice.active ? 'true' : 'false')
    button.disabled = choice.disabled
    button.textContent = choice.label
    marginRowEl.append(button)
  }
  previewEl.textContent = order.preview
  submitEl.textContent = pending ? '下单中…' : order.submitLabel
  submitEl.dataset.side = order.side
  submitEl.disabled = pending || !order.canSubmit
  orderHintEl.textContent = order.hint
}

function renderPositions (board) {
  positionsEl.textContent = ''
  for (const card of board.positions) {
    const row = document.createElement('div')
    row.className = 'position'

    const main = document.createElement('div')
    main.className = 'position-main'
    const title = document.createElement('div')
    title.className = 'position-title'
    title.textContent = card.title
    const meta = document.createElement('div')
    meta.className = 'position-meta'
    meta.textContent = '入场 ' + card.entryText + ' · 现价 ' + card.markText +
      ' · 保证金 ' + card.marginText + ' · ' + card.statusText
    main.append(title, meta)

    const right = document.createElement('div')
    right.className = 'position-side'
    const pnl = document.createElement('b')
    pnl.className = 'pnl'
    pnl.dataset.tone = card.pnlTone
    pnl.textContent = card.pnlText
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ghost'
    close.dataset.close = card.id
    close.disabled = !card.canClose
    close.textContent = card.closeLabel
    right.append(pnl, close)

    row.append(main, right)
    positionsEl.append(row)
  }
  positionsMetaEl.textContent = board.positions.length + ' 手'
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

function render () {
  const board = view.boardView(payload, { now: Date.now(), side, margin })
  renderHeader(board)
  renderOrder(board)
  renderPositions(board)
  renderHistory(board)
  // 选择的按钮可能被新一包换掉（白名单变了）：记住真实生效的值。
  side = board.order.side
  margin = board.order.margin
}

function tick () {
  if (payload === null || barEnd <= 0) return
  const remaining = Math.max(0, barEnd - Date.now())
  countdownEl.textContent = view.formatCountdown(remaining)
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

sideRowEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-side]')
  if (button === null || button.disabled) return
  side = button.dataset.side === 'short' ? 'short' : 'long'
  render()
})

marginRowEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-margin]')
  if (button === null || button.disabled) return
  const chosen = Number(button.dataset.margin)
  if (Number.isFinite(chosen)) margin = chosen
  render()
})

submitEl.addEventListener('click', () => {
  if (submitEl.disabled) return
  submitAction({ action: 'trading-open-position', side, margin, leverage: 1, cropId: payload?.bar?.crop })
})

positionsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-close]')
  if (button === null || button.disabled) return
  submitAction({ action: 'trading-close-position', positionId: button.dataset.close })
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
  const effective = view.orderView(next, { side, margin })
  side = effective.side
  margin = effective.margin
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
