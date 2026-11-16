/**
 * 改名小窗的桥：只暴露四个原语，没有任何 Node 能力外泄。
 *
 * 和主窗的 preload 是两份文件，因为两扇窗的权限完全不同：这扇能收键盘、能提交一个字符串，
 * 但同样**不能**自己改状态——它只把申请交给主进程，主进程再交给宿主。
 * 失焦策略见 ADR-0029：真正点窗口外面会收起所有插件窗；只有输入法合成期间例外，
 * 由下面的 composition 监听过桥给主进程。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * 输入法合成期间不收起（ADR-0029）：候选窗抢焦点会触发 blur，但用户还在打名字。
 * 只上报一个布尔，主进程不认任何其它字段；捕获阶段才能稳定收到从输入框冒上来的事件。
 */
let composing = false
window.addEventListener('compositionstart', () => {
  if (composing) return
  composing = true
  ipcRenderer.send('dsh-zoo:composing', true)
}, true)
window.addEventListener('compositionend', () => {
  if (!composing) return
  composing = false
  ipcRenderer.send('dsh-zoo:composing', false)
}, true)

contextBridge.exposeInMainWorld('dshZooRename', {
  /** 告诉主进程「监听器已就位，可以发初始名字了」。 */
  ready () {
    ipcRenderer.send('dsh-zoo:rename-ready')
  },
  submit (nickname) {
    if (typeof nickname !== 'string') return
    ipcRenderer.send('dsh-zoo:rename-submit', { nickname })
  },
  cancel () {
    ipcRenderer.send('dsh-zoo:rename-cancel')
  },
  onInit (handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, payload) => {
      try {
        handler(payload)
      } catch {
        // 一个坏处理器不能让窗口卡住
      }
    }
    ipcRenderer.on('dsh-zoo:rename-init', listener)
    return () => ipcRenderer.removeListener('dsh-zoo:rename-init', listener)
  },
  onResult (handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, result) => {
      try {
        handler(result)
      } catch {
        // 同上
      }
    }
    ipcRenderer.on('dsh-zoo:rename-result', listener)
    return () => ipcRenderer.removeListener('dsh-zoo:rename-result', listener)
  }
})
