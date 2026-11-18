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
  // 1.11.0：持仓表头的「全部转」——只报「转哪几笔、各几张」，价格与余额全在宿主算。
  'futures-convert-all': ['positions'],
  // 1.10.0：账户自己的档位；房主那边只剩「开市/关市」的兜底入口 `futures-mode`。
  'futures-account-mode': ['accountMode'],
  // 1.12.0：自己的暂停；退出（回滚）也只退自己。
  'futures-pause': ['paused'],
  'futures-mode': ['mode'],
  'futures-rollback': [],
  'futures-refresh': []
}

/** 「全部转」最多报 8 笔，每笔只留 id 与张数；别的一律不过桥（宿主还会再校验一次）。 */
const CONVERT_ALL_LIMIT = 8

function convertAllPositions (raw) {
  if (!Array.isArray(raw)) return null
  if (raw.length < 1 || raw.length > CONVERT_ALL_LIMIT) return null
  const out = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 64) return null
    if (!Number.isInteger(item.lots) || item.lots < 1 || item.lots > 100000) return null
    out.push({ id: item.id, lots: item.lots })
  }
  return out
}

function pick (action, raw) {
  const allowed = FIELDS[action]
  if (allowed === undefined) return null
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = { action }
  for (const key of allowed) {
    const value = raw[key]
    // 数组字段不能「缺省就跳过」：缺了 positions 的「全部转」等于空操作，得整条拒。
    if (key === 'positions') {
      const positions = convertAllPositions(value)
      if (positions === null) return null
      out.positions = positions
      continue
    }
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
