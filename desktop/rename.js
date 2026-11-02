/**
 * 改名小窗的渲染端。它只做输入与校验，不判断「能不能改」——
 * 那是宿主的事（装了 dsh-pet 要写它的配置，见 ADR-0007）。
 *
 * 校验刻意不做静默截断：超过上限就明说，别让用户以为自己改成了。
 */
'use strict'

const api = window.localPetRename
const form = document.getElementById('form')
const input = document.getElementById('name')
const errorEl = document.getElementById('error')
const limitEl = document.getElementById('limit')
const cancelButton = document.getElementById('cancel')

let maxLength = 32
let busy = false

function showError (text) {
  errorEl.textContent = typeof text === 'string' ? text : ''
}

function fail (text) {
  busy = false
  showError(text)
  input.focus()
  input.select()
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  if (busy) return
  const trimmed = input.value.trim()
  if (trimmed === '') {
    showError('名字不能是空的。')
    return
  }
  // 按码点计数：emoji 算一个字，和宿主那边的上限口径一致。
  if (Array.from(trimmed).length > maxLength) {
    showError('最多 ' + maxLength + ' 个字。')
    return
  }
  busy = true
  showError('')
  api?.submit(trimmed)
})

cancelButton.addEventListener('click', () => api?.cancel())

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  api?.cancel()
})

api?.onInit((payload) => {
  if (typeof payload?.maxLength === 'number' && payload.maxLength > 0) {
    maxLength = Math.floor(payload.maxLength)
  }
  limitEl.textContent = String(maxLength)
  input.value = typeof payload?.name === 'string' ? payload.name : ''
  busy = false
  showError('')
  input.focus()
  input.select()
})

api?.onResult((result) => {
  if (result?.ok === true) return
  const notice = typeof result?.notice === 'string' && result.notice.trim() !== ''
    ? result.notice
    : '改名没有生效。'
  fail(notice)
})

api?.ready()
