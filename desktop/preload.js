/**
 * 渲染进程与主进程之间唯一的桥：三个只读/只写原语，没有任何 Node 能力外泄。
 * - ready()：告诉主进程「监听器已就位，可以推场景了」，消除首帧竞态；
 * - reportHover(inside)：命中判定的结果 + 心跳（主进程只把它当申请，最终按真实光标裁定）；
 * - onScene(handler)：接收宿主下发的场景（已经过 desktop/shared.js 归一化）。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('localPetDesktop', {
  ready () {
    ipcRenderer.send('local-pet:renderer-ready')
  },
  reportHover (inside) {
    ipcRenderer.send('local-pet:hover', { inside: inside === true })
  },
  onScene (handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, scene) => {
      try {
        handler(scene)
      } catch {
        // 渲染错误不能让整个窗口停摆：下一次场景更新还会再来
      }
    }
    ipcRenderer.on('local-pet:scene', listener)
    return () => ipcRenderer.removeListener('local-pet:scene', listener)
  }
})
