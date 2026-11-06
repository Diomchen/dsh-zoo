/**
 * 农场小窗的桥（ticket 40 / 41）：只暴露五个原语，没有任何 Node 能力外泄。
 *
 *   - ready() / onState：告诉主进程「监听器已就位」，然后收完整农场与交易所视图
 *     （地块 + remainingMs + 种子/作物/硬币/露水/日志 + 价目/成交；窗口自己读不到 /state）；
 *   - submit(action)：把「种/收/浇/施肥/买种/卖作物」当**申请**交上去，
 *     只带 action/plotId/cropId/qty，单价与总价一概不传，全部由宿主算；
 *   - close()：显式关窗（Esc / 右上角 ×）；
 *   - onResult：宿主的 action-result；成功不关窗（toast 一下，继续种/继续买）。
 *
 * 和主窗/带派窗的 preload 是三份文件：这扇窗能收键盘，但同样**不能**自己改状态。
 * 这里刻意**不**在失焦时关窗（主进程也没有 blur 处理器）：macOS 中文输入法候选窗会
 * 抢焦点，blur 关窗会变成「打中文时窗消失」。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshZooFarm', {
  /** 监听器就位：主进程可以把当前农场推过来了。 */
  ready () {
    ipcRenderer.send('dsh-zoo:farm-ready')
  },
  submit (action) {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) return
    // 字段由主进程按 shared.normalizeFarmAction 再白名单一遍；这里只挡明显不是对象的东西。
    ipcRenderer.send('dsh-zoo:farm-submit', {
      action: action.action,
      plotId: action.plotId,
      cropId: action.cropId,
      qty: action.qty
    })
  },
  close () {
    ipcRenderer.send('dsh-zoo:farm-close')
  },
  onState (handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, payload) => {
      try {
        handler(payload)
      } catch {
        // 一个坏处理器不能让窗口卡住
      }
    }
    ipcRenderer.on('dsh-zoo:farm-state', listener)
    return () => ipcRenderer.removeListener('dsh-zoo:farm-state', listener)
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
    ipcRenderer.on('dsh-zoo:farm-result', listener)
    return () => ipcRenderer.removeListener('dsh-zoo:farm-result', listener)
  }
})
