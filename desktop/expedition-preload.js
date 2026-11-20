/**
 * 出远门小窗的 preload（票 112）。
 *
 * 和期货窗同一套纪律：渲染端只能发白名单里的动作，字段由 `pick` 显式拷贝，
 * 不能把任意对象塞给主进程。陈列架（票 115）只多开四个字段。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/** 动作 → 允许过桥的字段。`start` 只带路线 id；陈列架带格号与特产 id。 */
const FIELDS = {
  'expedition-start': ['routeId'],
  'expedition-step': [],
  'expedition-back': [],
  'expedition-refresh': [],
  'expedition-lantern': [],
  'expedition-shelf': ['slot', 'itemId', 'moveFrom', 'moveTo']
}

function pick (action, raw) {
  const allowed = FIELDS[action]
  const out = { action }
  if (allowed === undefined) return out
  for (const key of allowed) {
    if (raw !== null && typeof raw === 'object' && raw[key] !== undefined) out[key] = raw[key]
  }
  return out
}

function submit (payload) {
  if (payload === null || typeof payload !== 'object') return false
  const action = typeof payload.action === 'string' ? payload.action.trim().toLowerCase() : ''
  if (!Object.prototype.hasOwnProperty.call(FIELDS, action)) return false
  ipcRenderer.send('dsh-zoo:expedition-submit', pick(action, payload))
  return true
}

function subscribe (channel, listener) {
  if (typeof listener !== 'function') return () => {}
  const wrapped = (_event, value) => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('dshZooExpedition', {
  ready: () => ipcRenderer.send('dsh-zoo:expedition-ready'),
  submit,
  close: () => ipcRenderer.send('dsh-zoo:expedition-close'),
  onState: (listener) => subscribe('dsh-zoo:expedition-state', listener),
  onResult: (listener) => subscribe('dsh-zoo:expedition-result', listener)
})
