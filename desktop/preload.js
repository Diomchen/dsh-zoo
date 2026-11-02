/**
 * 渲染进程与主进程之间唯一的桥：只读/只写原语，没有任何 Node 能力外泄。
 * - ready()：告诉主进程「监听器已就位，可以推场景了」，消除首帧竞态；
 * - reportHover(inside)：悬停确认 + 心跳（主进程只把它当申请，最终按真实光标裁定）；
 * - reportRects(rects)：渲染端本地物理算出的命中矩形（窗口局部 DIP）。主进程只认这一份，
 *   过期就当没有命中区——位置是渲染端拥有的，主进程不猜；
 * - setBusy(busy)：拖拽/弹层期间持有的输入租约。拖拽时宠物落后于光标，光标可能离开命中矩形，
 *   主进程在此期间不得翻回穿透；租约靠心跳续期，pointerup/cancel/blur 由渲染端主动释放；
 * - onScene(handler)：接收宿主下发的场景 v2（已经过 desktop/shared.js 归一化）。
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
  reportRects (rects) {
    ipcRenderer.send('local-pet:rects', Array.isArray(rects) ? rects : [])
  },
  setBusy (busy) {
    ipcRenderer.send('local-pet:busy', { busy: busy === true })
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
