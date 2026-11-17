/**
 * 期货小窗的 preload（票 93）：只暴露窗口需要的五件事。
 *
 * 与 `board-preload.js` 同一套纪律：
 *   - 渲染端拿不到 ipcRenderer、fs、require，只能调这里列出的函数；
 *   - `submit()` 按动作**显式拷贝字段**——价格、硬币、盈亏、张数一律不过桥，
 *     窗口只能表达意图（「做多 tomato，保证金 50，20×」），算账全在宿主；
 *   - 输入法合成期上报（ADR-0029）：合成中不收起窗口，避免中文输入被打断。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/** 每种动作允许过桥的字段；多一个都不带（白名单在宿主那边还有一份）。 */
const FIELDS = {
  'futures-deposit': ['coins'],
  'futures-withdraw': ['coins'],
  'futures-open': ['side', 'margin', 'leverage', 'cropId'],
  'futures-close': ['positionId'],
  // 限价挂单只说「哪边、什么价、几张、几倍」——冻多少保证金由房主按名义算。
  'futures-place': ['side', 'cropId', 'price', 'lots', 'leverage'],
  'futures-cancel': ['orderId'],
  'futures-convert': ['positionId', 'lots'],
  // 票 98：切档与回滚只有房主按得动，宿主还会再判一次。
  'futures-mode': ['mode'],
  'futures-rollback': [],
  'futures-refresh': []
}

function pick (action, raw) {
  const allowed = FIELDS[action]
  if (allowed === undefined) return null
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = { action }
  for (const key of allowed) {
    const value = raw[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * 窗口 → helper：窗口自己报一次「我加载好了」（宿主据此推第一拍）。
 * 这是唯一不带动作的信道，helper 用它区分「重开」和「刷新」。
 */
contextBridge.exposeInMainWorld('dshZooFutures', {
  ready: () => ipcRenderer.send('dsh-zoo:futures-ready'),

  /** 下单/平仓/充提：返回是否被接受（true = 已交给宿主等回执）。 */
  submit: (raw) => {
    const action = typeof raw?.action === 'string' ? raw.action : ''
    const payload = pick(action, raw ?? {})
    if (payload === null) return false
    ipcRenderer.send('dsh-zoo:futures-submit', payload)
    return true
  },

  close: () => ipcRenderer.send('dsh-zoo:futures-close'),

  /** 宿主推来的整份视图（不落盘、不拼路径）。 */
  onState: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, view) => handler(view)
    ipcRenderer.on('dsh-zoo:futures-state', listener)
    return () => ipcRenderer.removeListener('dsh-zoo:futures-state', listener)
  },

  /** 一次提交的结果（成功不关窗，失败写一句人话）。 */
  onResult: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, result) => handler(result)
    ipcRenderer.on('dsh-zoo:futures-result', listener)
    return () => ipcRenderer.removeListener('dsh-zoo:futures-result', listener)
  },

  /** 输入法合成期（ADR-0029）：合成中窗口不收起。 */
  onComposing: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, flag) => handler(flag === true)
    ipcRenderer.on('dsh-zoo:composing', listener)
    return () => ipcRenderer.removeListener('dsh-zoo:composing', listener)
  },

  composing: (flag) => ipcRenderer.send('dsh-zoo:composing', flag === true)
})
