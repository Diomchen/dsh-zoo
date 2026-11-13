/**
 * 农场小窗的桥（ticket 40 / 41）：只暴露五个原语，没有任何 Node 能力外泄。
 *
 *   - ready() / onState：告诉主进程「监听器已就位」，然后收完整农场与交易所视图
 *     （地块 + remainingMs + 种子/作物/硬币/露水/日志 + 价目/成交；窗口自己读不到 /state）；
 *   - submit(action)：把「种/收/浇/施肥/买种/卖作物/解锁」当**申请**交上去，
 *     只带 action/plotId/cropId/qty/expectedUnlocked，单价与总价一概不传，全部由宿主算；
 *   - close()：显式关窗（Esc / 右上角 ×）；
 *   - setPinned()/onPinned：右上角图钉的置顶开关，只发一个布尔值，窗口层级由主进程改；
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
    // 字段按动作族显式拷贝：地块（plotId/cropId）、交易所（cropId/qty）、
    // 雇佣（deviceId/hours/contractId/wagePerHour/minHours/maxHours/enabled）、
    // 解锁（expectedUnlocked，只是乐观锁，不是钱）。
    // 硬币、总价、服务时长一概不传——全部由宿主算。
    ipcRenderer.send('dsh-zoo:farm-submit', {
      action: action.action,
      plotId: action.plotId,
      cropId: action.cropId,
      qty: action.qty,
      expectedUnlocked: action.expectedUnlocked,
      deviceId: action.deviceId,
      // 票 53：派它去偷时要去哪几块；数组里的每个值主进程还会再白名单一遍。
      plots: Array.isArray(action.plots) ? action.plots.slice(0, 50) : undefined,
      // 票 70：节日/来客的乐观锁和二选一也要过桥，否则会被当成缺地块的普通动作。
      expectedStart: action.expectedStart,
      choice: action.choice,
      hours: action.hours,
      contractId: action.contractId,
      wagePerHour: action.wagePerHour,
      minHours: action.minHours,
      maxHours: action.maxHours,
      enabled: action.enabled
    })
  },
  close () {
    ipcRenderer.send('dsh-zoo:farm-close')
  },
  /** 窗口置顶开关：主进程负责真正 setAlwaysOnTop，并记住这次选择。 */
  setPinned (pinned) {
    ipcRenderer.send('dsh-zoo:farm-pin', pinned === true)
  },
  onPinned (handler) {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, pinned) => {
      try {
        handler(pinned === true)
      } catch {
        // 同 onState：坏处理器不能把窗口带崩
      }
    }
    ipcRenderer.on('dsh-zoo:farm-pinned', listener)
    return () => ipcRenderer.removeListener('dsh-zoo:farm-pinned', listener)
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
