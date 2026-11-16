/**
 * 「带派」小窗的渲染端（ticket 24）。
 *
 * 它只做三件事：写一张字条 / 请主进程选一个文件 / 把「放进背包」或「撤掉」当**申请**
 * 交给主进程。背包里有什么、还能不能放、文件存不存在，全部由宿主算好后再推回来。
 *
 * 文件选择刻意不在这里做：Electron 的渲染进程拿不到本机路径，
 * 所以「选文件」按钮只是请主进程开系统对话框（`submit({pick:true})`），
 * 选完的路径由主进程通过 `onInit` 推回来，且提交时主进程还会再核对一次。
 */
'use strict'

const api = window.dshZooGift
const form = document.getElementById('form')
const textEl = document.getElementById('text')
const counterEl = document.getElementById('counter')
const countEl = document.getElementById('count')
// 数量胶囊里还有一个小背包图标：只改文字节点，别把图标一起抹掉。
const countTextEl = document.getElementById('count-text') ?? countEl
const itemsEl = document.getElementById('items')
const pickedEl = document.getElementById('picked')
const clearPickedButton = document.getElementById('clear-picked')
const pickButton = document.getElementById('pick')
const errorEl = document.getElementById('error')
const submitButton = document.getElementById('submit')
const cancelButton = document.getElementById('cancel')
const textPanel = document.getElementById('text-panel')
const packetPanel = document.getElementById('packet-panel')
const modeTextButton = document.getElementById('mode-text')
const modePacketButton = document.getElementById('mode-packet')
const packetLeftEl = document.getElementById('packet-left')
const packetCoinsEl = document.getElementById('packet-coins')
const packetCoinsHintEl = document.getElementById('packet-coins-hint')
const packetCropsEl = document.getElementById('packet-crops')
const packetSeedsEl = document.getElementById('packet-seeds')
const packetCounterEl = document.getElementById('packet-counter')
const packetNoteEl = document.getElementById('packet-note')
const packetSummaryEl = document.getElementById('packet-summary')

let state = {
  items: [],
  maxItems: 2,
  maxTextLength: 500,
  maxFileBytes: 0,
  picked: null,
  packet: null
}
let busy = false
let focused = false
// 「字条」还是「红包」。文件不占页签：选文件那一行两种模式下都在。
let mode = 'text'
// 红包里已经挑好的数量：`{crops:{tomato:2}, seeds:{rice:1}}`。
const packetPick = { crops: {}, seeds: {} }

/**
 * 主进程只会用错误码回传它自己的传输失败（超时/管道断）；宿主给的 notice 已经是人话，
 * 优先显示它。这些码不是产品文案，只是窗口的兜底。
 */
const RESULT_CODE_TEXT = {
  timeout: '桌面宿主没有回应，这次没有完成。',
  'host-unavailable': '桌面宿主没有连接，这次没有完成。',
  'bad-gift': '这件东西没有准备好，再试一次。',
  'pick-failed': '打不开文件选择器，换个方式再试。',
  'no-such-file': '这个文件不在了，换一个吧。'
}

function showError (text) {
  errorEl.textContent = typeof text === 'string' ? text : ''
}

function codepoints (value) {
  return Array.from(typeof value === 'string' ? value : '').length
}

function updateCounter () {
  const used = codepoints(textEl.value.trim())
  const limit = Number.isInteger(state.maxTextLength) && state.maxTextLength > 0
    ? state.maxTextLength
    : 500
  counterEl.textContent = used + '/' + limit
  // 默认色在样式表里；超限才写内联色，清回空串就回到默认。
  counterEl.style.color = used > limit ? '#b5645b' : ''
}

function formatSize (bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return ''
  if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB'
  if (value >= 1024) return Math.round(value / 1024) + ' KB'
  return value + ' B'
}

function itemName (item) {
  if (item.kind === 'file') {
    return typeof item.name === 'string' && item.name !== '' ? item.name : '文件'
  }
  const text = typeof item.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : ''
  return text === '' ? '（空字条）' : text
}

/** 给屏幕阅读器/悬浮提示的完整说明：图标只是装饰，kind 不能丢。 */
function itemLabel (item) {
  const prefix = item.kind === 'file' ? '文件：' : item.kind === 'packet' ? '红包：' : '字条：'
  return prefix + itemName(item)
}

function renderItems () {
  itemsEl.textContent = ''
  const items = Array.isArray(state.items) ? state.items : []
  if (items.length === 0) {
    const row = document.createElement('li')
    row.className = 'empty-row'
    row.textContent = '背包空空的，放一件吧。'
    itemsEl.appendChild(row)
    return
  }
  for (const item of items) {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string') continue
    const row = document.createElement('li')
    // 图标由 CSS 按 kind 画出来；这里只写 kind，不往文案里塞符号。
    row.dataset.kind = item.kind === 'file' ? 'file' : item.kind === 'packet' ? 'packet' : 'text'
    row.setAttribute('aria-label', itemLabel(item))
    const label = document.createElement('span')
    label.className = 'item-text'
    label.textContent = itemName(item)
    label.title = itemLabel(item)
    row.appendChild(label)

    if (item.state === 'out') {
      const out = document.createElement('span')
      out.className = 'item-out'
      out.textContent = '正在路上'
      row.appendChild(out)
    }

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'btn remove'
    remove.textContent = '撤掉'
    // `out` 中的东西可能已经在对方磁盘上了，撤掉按钮明确禁用（不是点了没反应）。
    remove.disabled = busy || item.state === 'out'
    remove.addEventListener('click', () => {
      if (busy || item.state === 'out') return
      busy = true
      render()
      showError('')
      api?.remove(item.id)
    })
    row.appendChild(remove)
    itemsEl.appendChild(row)
  }
}

function renderPicked () {
  const picked = state.picked
  if (picked === null || typeof picked !== 'object' || typeof picked.path !== 'string') {
    pickedEl.textContent = '也可以带一个文件（≤16 MB）'
    pickedEl.classList.add('empty')
    clearPickedButton.hidden = true
    return
  }
  const size = formatSize(picked.size)
  const tooBig = Number.isFinite(state.maxFileBytes) && state.maxFileBytes > 0 &&
    Number(picked.size) > state.maxFileBytes
  pickedEl.textContent = (picked.name || '文件') + (size === '' ? '' : '（' + size + '）') +
    (tooBig ? ' · 超过 16 MB' : '')
  pickedEl.classList.remove('empty')
  clearPickedButton.hidden = false
}

function packetLimits () {
  const limits = state.packet?.limits ?? {}
  const pick = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback)
  return {
    maxCoins: pick(limits.maxCoins, 200),
    maxPerCrop: pick(limits.maxPerCrop, 20),
    maxKinds: pick(limits.maxKinds, 5),
    maxNoteChars: pick(limits.maxNoteChars, 60)
  }
}

/** 红包里目前有几样东西（按“种”算，一个 0 数量不算）。 */
function packetKindCount (kind) {
  return Object.values(packetPick[kind]).filter((qty) => qty > 0).length
}

/** 把 `{crops,seeds}` 里挑好的数量拼成协议要的 `{coins,crops,seeds}`；空的返回 null。 */
function packetContents () {
  const limits = packetLimits()
  const coins = Math.max(0, Math.min(limits.maxCoins, Number(packetCoinsEl.value) || 0))
  const stacks = (kind) => {
    const out = {}
    for (const [id, qty] of Object.entries(packetPick[kind])) {
      if (Number.isInteger(qty) && qty > 0) out[id] = Math.min(qty, limits.maxPerCrop)
    }
    return out
  }
  const crops = stacks('crops')
  const seeds = stacks('seeds')
  if (coins === 0 && Object.keys(crops).length === 0 && Object.keys(seeds).length === 0) return null
  return { coins, crops, seeds }
}

function packetSummaryText (packet) {
  if (packet === null) return '还什么都没放'
  const parts = []
  if (packet.coins > 0) parts.push(packet.coins + ' 硬币')
  for (const [id, qty] of Object.entries(packet.crops)) parts.push(id + ' ×' + qty)
  for (const [id, qty] of Object.entries(packet.seeds)) parts.push(id + ' 种子 ×' + qty)
  return parts.join(' · ')
}

function renderPacketRows (container, kind, rows) {
  container.textContent = ''
  if (rows.length === 0) {
    const empty = document.createElement('span')
    empty.className = 'packet-empty'
    empty.textContent = kind === 'crops' ? '仓库里还没有作物。' : '种子袋里还没有种子。'
    container.appendChild(empty)
    return
  }
  const limits = packetLimits()
  for (const row of rows) {
    const picked = packetPick[kind][row.id] ?? 0
    const max = Math.min(row.have, limits.maxPerCrop)
    const wrap = document.createElement('div')
    wrap.className = 'packet-row'
    wrap.dataset.crop = row.id
    const name = document.createElement('span')
    name.className = 'packet-name'
    name.textContent = row.name
    const have = document.createElement('span')
    have.className = 'packet-have'
    have.textContent = '有 ' + row.have
    const minus = document.createElement('button')
    minus.type = 'button'
    minus.textContent = '−'
    minus.setAttribute('aria-label', '少放一个 ' + row.name)
    const qtyEl = document.createElement('span')
    qtyEl.className = 'packet-qty'
    qtyEl.textContent = String(picked)
    const plus = document.createElement('button')
    plus.type = 'button'
    plus.textContent = '+'
    plus.setAttribute('aria-label', '多放一个 ' + row.name)
    const setQty = (next) => {
      const value = Math.max(0, Math.min(max, next))
      // 种类上限只拦「从 0 变成 1」，已经在里面的可以继续加减。
      if (value > 0 && picked === 0 && packetKindCount(kind) >= limits.maxKinds) {
        showError('红包里最多放 ' + limits.maxKinds + ' 种' + (kind === 'crops' ? '作物' : '种子') + '。')
        return
      }
      packetPick[kind][row.id] = value
      render()
    }
    minus.disabled = busy || picked <= 0
    plus.disabled = busy || picked >= max
    minus.addEventListener('click', () => setQty(picked - 1))
    plus.addEventListener('click', () => setQty(picked + 1))
    wrap.appendChild(name)
    wrap.appendChild(have)
    wrap.appendChild(minus)
    wrap.appendChild(qtyEl)
    wrap.appendChild(plus)
    container.appendChild(wrap)
  }
}

function renderPacket () {
  const setup = state.packet
  if (setup === null) {
    packetLeftEl.textContent = ''
    packetCoinsHintEl.textContent = ''
    packetCropsEl.textContent = ''
    packetSeedsEl.textContent = ''
    packetSummaryEl.textContent = '宿主还没把红包底数推过来'
    packetSummaryEl.classList.add('empty')
    return
  }
  const limits = packetLimits()
  packetLeftEl.textContent = '今天还能寄 ' + setup.left + ' 只 · 最多 ' + limits.maxKinds + ' 种'
  packetCoinsEl.max = String(Math.min(limits.maxCoins, setup.coins))
  packetCoinsHintEl.textContent = '最多 ' + limits.maxCoins + '，钱包有 ' + setup.coins
  renderPacketRows(packetCropsEl, 'crops', setup.crops)
  renderPacketRows(packetSeedsEl, 'seeds', setup.seeds)
  const note = packetNoteEl.value.replace(/\s+/g, ' ').trim()
  packetCounterEl.textContent = Array.from(note).length + '/' + limits.maxNoteChars
  const contents = packetContents()
  packetSummaryEl.textContent = packetSummaryText(contents)
  packetSummaryEl.classList.toggle('empty', contents === null)
}

function setMode (next) {
  mode = next === 'packet' ? 'packet' : 'text'
  textPanel.hidden = mode !== 'text'
  packetPanel.hidden = mode !== 'packet'
  modeTextButton.setAttribute('aria-selected', mode === 'text' ? 'true' : 'false')
  modePacketButton.setAttribute('aria-selected', mode === 'packet' ? 'true' : 'false')
  showError('')
  render()
}

function submitPacket () {
  const setup = state.packet
  if (setup === null) {
    showError('红包底数还没到，稍等一下。')
    return
  }
  if (setup.left <= 0) {
    showError('今天已经寄出 3 只红包了，明天再来。')
    return
  }
  const contents = packetContents()
  if (contents === null) {
    showError('红包里先放点东西：硬币、作物或种子。')
    return
  }
  const limits = packetLimits()
  const note = packetNoteEl.value.trim()
  if (Array.from(note).length > limits.maxNoteChars) {
    showError('祝福语最多 ' + limits.maxNoteChars + ' 个字。')
    packetNoteEl.focus()
    return
  }
  busy = true
  showError('')
  render()
  api?.submit({ kind: 'packet', packet: contents, note })
}

function render () {
  const items = Array.isArray(state.items) ? state.items : []
  const max = Number.isInteger(state.maxItems) && state.maxItems > 0 ? state.maxItems : 2
  countTextEl.textContent = '背包 ' + items.length + '/' + max
  const full = items.length >= max
  // 背包满了就收起右下角的「慢递」邮戳（CSS 只认这个数，不猜 DOM）。
  form.dataset.count = String(items.length)
  const pickedTooBig = state.picked !== null && typeof state.picked === 'object' &&
    Number.isFinite(state.maxFileBytes) && state.maxFileBytes > 0 &&
    Number(state.picked.size) > state.maxFileBytes
  // 红包页：内容是硬币/作物/种子，背包满不影响它；但「什么都没放」时不能提交。
  const isPacket = mode === 'packet'
  const packetReady = isPacket && packetContents() !== null
  submitButton.disabled = busy || full || pickedTooBig || (isPacket && !packetReady)
  pickButton.disabled = busy
  cancelButton.disabled = false
  textEl.disabled = full
  updateCounter()
  renderItems()
  renderPicked()
  renderPacket()
}

function submitCurrent () {
  if (busy) return
  if (mode === 'packet') {
    submitPacket()
    return
  }
  const items = Array.isArray(state.items) ? state.items : []
  const max = Number.isInteger(state.maxItems) && state.maxItems > 0 ? state.maxItems : 2
  if (items.length >= max) {
    showError('背包已经有两件了，先撤掉一件再放。')
    return
  }
  // 选了文件就带文件；否则带字条。两种形态一次只有一种，和协议一致。
  if (state.picked !== null && typeof state.picked.path === 'string') {
    busy = true
    showError('')
    render()
    api?.submit({ kind: 'file', path: state.picked.path })
    return
  }
  const text = textEl.value.trim()
  if (text === '') {
    showError('写一张字条，或者选一个文件。')
    textEl.focus()
    return
  }
  const limit = Number.isInteger(state.maxTextLength) && state.maxTextLength > 0
    ? state.maxTextLength
    : 500
  if (codepoints(text) > limit) {
    // 不静默截断：截一半比不带更糟（和协议层的 sanitizeNote 同一套理由）。
    showError('字条最多 ' + limit + ' 个字。')
    textEl.focus()
    return
  }
  busy = true
  showError('')
  render()
  api?.submit({ kind: 'text', text })
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  submitCurrent()
})

pickButton.addEventListener('click', () => {
  if (busy) return
  showError('')
  // 「选文件」不是提交：请主进程打开系统对话框，选完用 onInit 把名字/大小推回来。
  api?.submit({ pick: true })
})

clearPickedButton.addEventListener('click', () => {
  state = { ...state, picked: null }
  render()
})

cancelButton.addEventListener('click', () => api?.cancel())

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || busy) return
  event.preventDefault()
  api?.cancel()
})

textEl.addEventListener('input', updateCounter)

modeTextButton.addEventListener('click', () => {
  if (!busy) setMode('text')
})

modePacketButton.addEventListener('click', () => {
  if (!busy) setMode('packet')
})

packetCoinsEl.addEventListener('input', () => {
  const limits = packetLimits()
  const max = Math.min(limits.maxCoins, Number(state.packet?.coins ?? limits.maxCoins))
  const value = Number(packetCoinsEl.value)
  if (Number.isFinite(value) && value > max) packetCoinsEl.value = String(max)
  render()
})

packetNoteEl.addEventListener('input', () => {
  const limits = packetLimits()
  const note = packetNoteEl.value
  if (Array.from(note).length > limits.maxNoteChars) {
    packetNoteEl.value = Array.from(note).slice(0, limits.maxNoteChars).join('')
  }
  render()
})

api?.onInit((payload) => {
  if (payload === null || typeof payload !== 'object') return
  state = {
    items: Array.isArray(payload.items) ? payload.items : [],
    maxItems: Number.isInteger(payload.maxItems) ? payload.maxItems : state.maxItems,
    maxTextLength: Number.isInteger(payload.maxTextLength) ? payload.maxTextLength : state.maxTextLength,
    maxFileBytes: Number.isFinite(payload.maxFileBytes) ? payload.maxFileBytes : state.maxFileBytes,
    picked: payload.picked !== null && typeof payload.picked === 'object' ? payload.picked : null,
    packet: payload.packet !== null && typeof payload.packet === 'object' ? payload.packet : null
  }
  busy = false
  showError('')
  // 面板状态每次推送都重新对一遍：宿主可能刚把红包底数换了（换季/买种子）。
  textPanel.hidden = mode !== 'text'
  packetPanel.hidden = mode !== 'packet'
  modeTextButton.setAttribute('aria-selected', mode === 'text' ? 'true' : 'false')
  modePacketButton.setAttribute('aria-selected', mode === 'packet' ? 'true' : 'false')
  render()
  if (!focused) {
    focused = true
    textEl.focus()
  }
})

api?.onResult((result) => {
  busy = false
  if (result === null || typeof result !== 'object') {
    render()
    return
  }
  if (result.ok === true) {
    // bring 成功时窗口会被主进程直接关掉；unbring 成功靠列表刷新作反馈。
    showError('')
    render()
    return
  }
  const notice = typeof result.notice === 'string' && result.notice.trim() !== ''
    ? result.notice
    : (RESULT_CODE_TEXT[result.code] ?? '这次没有完成。')
  showError(notice)
  render()
})

api?.ready()
