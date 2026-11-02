/**
 * 改名小窗的桥：只暴露四个原语，没有任何 Node 能力外泄。
 *
 * 和主窗的 preload 是两份文件，因为两扇窗的权限完全不同：这扇能收键盘、能提交一个字符串，
 * 但同样**不能**自己改状态——它只把申请交给主进程，主进程再交给宿主。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('localPetRename', {
  /** 告诉主进程「监听器已就位，可以发初始名字了」。 */
  ready () {
    ipcRenderer.send('local-pet:rename-ready')
  },
  submit (nickname) {
    if (typeof nickname !== 'string') return
    ipcRenderer.send('local-pet:rename-submit', { nickname })
  },
  cancel () {
    ipcRenderer.send('local-pet:rename-cancel')
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
    ipcRenderer.on('local-pet:rename-init', listener)
    return () => ipcRenderer.removeListener('local-pet:rename-init', listener)
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
    ipcRenderer.on('local-pet:rename-result', listener)
    return () => ipcRenderer.removeListener('local-pet:rename-result', listener)
  }
})
