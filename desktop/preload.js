/**
 * 渲染进程与主进程之间唯一的桥：只读/只写原语，没有任何 Node 能力外泄。
 * - ready()：告诉主进程「监听器已就位，可以推场景了」，消除首帧竞态；
 * - reportHover(inside)：悬停确认 + 心跳（主进程只把它当申请，最终按真实光标裁定）；
 * - reportRects(rects)：渲染端本地物理算出的宠物命中矩形（窗口局部 DIP）。主进程只认这一份，
 *   过期就当没有命中区——位置是渲染端拥有的，主进程不猜；
 * - reportOverlayRects(rects)：弹层/放行卡/召回胶囊的命中矩形。它们不参与物理，但必须让主进程
 *   在光标真的落在按钮上时接管鼠标；同样按时间戳过期，渲染端死了就 fail-closed；
 * - setBusy(busy)：拖拽/弹层期间持有的输入租约。拖拽时宠物落后于光标、弹层与宠物之间有间隙，
 *   光标可能离开命中矩形，主进程在此期间不得翻回穿透；租约靠心跳续期，pointerup/cancel/blur、
 *   弹层关闭/超时由渲染端主动释放；
 * - requestAction(payload)：把一次按钮点击作为**申请**交给宿主（visit/recall/end-visit/admit/
 *   reject/dismiss/rename/gift-*），渲染端永远不直接改状态；礼物动作只带 giftId，
 *   文件的绝对路径不会出现在渲染进程里；
 * - onActionResult(handler)：宿主对某次申请的答复（ok + 人话 notice）；失败必须能冒泡；
 * - onScene(handler)：接收宿主下发的场景 v3（已经过 desktop/shared.js 归一化，含 menu）。
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
  reportOverlayRects (rects) {
    ipcRenderer.send('local-pet:overlay-rects', Array.isArray(rects) ? rects : [])
  },
  setBusy (busy) {
    ipcRenderer.send('local-pet:busy', { busy: busy === true })
  },
  /** 素材诊断：当前在播哪一段、失败集合；只进主进程内存，供宿主排查用。 */
  reportMedia (payload) {
    if (payload === null || typeof payload !== 'object') return
    ipcRenderer.send('local-pet:media', {
      clip: typeof payload.clip === 'string' ? payload.clip : null,
      source: typeof payload.source === 'string' ? payload.source : null,
      failed: Array.isArray(payload.failed) ? payload.failed : []
    })
  },
  requestAction (payload) {
    if (payload === null || typeof payload !== 'object') return
    ipcRenderer.send('local-pet:action', {
      id: payload.id,
      action: payload.action,
      deviceId: payload.deviceId,
      // 动作点播要带名字（右键菜单的「动作」那一支）；其它动作这里是 undefined。
      name: payload.name,
      nickname: payload.nickname,
      // 礼物四动作只带 giftId（UUID）；路径与磁盘操作全在宿主/主进程那边。
      giftId: payload.giftId
    })
  },
  /**
   * 打开改名小窗。主窗 `focusable:false`，收不到键盘，所以输入只能单开一扇窗
   * ——ADR-0005 的安全约定一个字都不动。这里只发一句「请开窗」，开不开由主进程决定。
   */
  openRename () {
    ipcRenderer.send('local-pet:rename-open')
  },
  /**
   * 主进程开不了改名窗时（渲染端还没就绪）的回话。
   * 没有这条，弹层已经关掉了，用户点了个「改名」什么都不会发生。
   */
  onRenameUnavailable (handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = () => {
      try {
        handler()
      } catch {
        // 一个坏处理器不能影响后续提示
      }
    }
    ipcRenderer.on('local-pet:rename-unavailable', listener)
    return () => ipcRenderer.removeListener('local-pet:rename-unavailable', listener)
  },
  onActionResult (handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, result) => {
      try {
        handler(result)
      } catch {
        // 一个坏处理器不能让后续结果全部丢失
      }
    }
    ipcRenderer.on('local-pet:action-result', listener)
    return () => ipcRenderer.removeListener('local-pet:action-result', listener)
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
