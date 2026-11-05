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

let state = {
  items: [],
  maxItems: 2,
  maxTextLength: 500,
  maxFileBytes: 0,
  picked: null
}
let busy = false
let focused = false

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
  return (item.kind === 'file' ? '文件：' : '字条：') + itemName(item)
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
    row.dataset.kind = item.kind === 'file' ? 'file' : 'text'
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
  submitButton.disabled = busy || full || pickedTooBig
  pickButton.disabled = busy
  cancelButton.disabled = false
  textEl.disabled = full
  updateCounter()
  renderItems()
  renderPicked()
}

function submitCurrent () {
  if (busy) return
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

api?.onInit((payload) => {
  if (payload === null || typeof payload !== 'object') return
  state = {
    items: Array.isArray(payload.items) ? payload.items : [],
    maxItems: Number.isInteger(payload.maxItems) ? payload.maxItems : state.maxItems,
    maxTextLength: Number.isInteger(payload.maxTextLength) ? payload.maxTextLength : state.maxTextLength,
    maxFileBytes: Number.isFinite(payload.maxFileBytes) ? payload.maxFileBytes : state.maxFileBytes,
    picked: payload.picked !== null && typeof payload.picked === 'object' ? payload.picked : null
  }
  busy = false
  showError('')
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
