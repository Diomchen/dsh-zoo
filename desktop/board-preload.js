/**
 * 盘口小窗的桥（票 79）：只暴露五个原语，没有任何 Node 能力外泄。
 *
 *   - ready() / onState：告诉主进程「监听器已就位」，然后收整份盘口视图
 *     （价格/倒计时/硬币/持仓/历史 + 按钮白名单）；窗口自己读不到 /state。
 *   - submit(action)：把「开仓 / 平仓 / 止损 / 重推一拍」当**申请**交上去。只带
 *     action/side/margin/leverage/cropId/positionId/level——价格、硬币、盈亏全由宿主算；
 *   - close()：显式关窗（Esc / 右上角 ×）；
 *   - onResult：宿主的 action-result；成功不关窗（toast 一下，继续做下一单）。
 *
 * 这里和农场窗一样**不**在失焦时关窗（主进程也没有 blur 处理器）：macOS 中文输入法
 * 候选窗会抢焦点，blur 关窗会变成「打中文时窗消失」。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshZooBoard', {
  /** 监听器就位：主进程可以把当前盘口推过来了。 */
  ready () {
    ipcRenderer.send('dsh-zoo:board-ready')
  },
  submit (action) {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) return
    // 字段由主进程按 shared.normalizeBoardAction 再白名单一遍；这里只挡明显不是对象的东西。
    // 字段按动作显式拷贝：开仓（side/margin/leverage/cropId）、平仓/止损（positionId）、
    // 止损再带一档 level（0 / 0.25 / 0.5 / 1）。
    // 硬币、价格、盈亏、总价一概不传——全部由宿主算。
    ipcRenderer.send('dsh-zoo:board-submit', {
      action: action.action,
      side: action.side,
      margin: action.margin,
      leverage: action.leverage,
      cropId: action.cropId,
      positionId: action.positionId,
      level: action.level
    })
  },
  close () {
    ipcRenderer.send('dsh-zoo:board-close')
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
    ipcRenderer.on('dsh-zoo:board-state', listener)
    return () => ipcRenderer.removeListener('dsh-zoo:board-state', listener)
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
    ipcRenderer.on('dsh-zoo:board-result', listener)
    return () => ipcRenderer.removeListener('dsh-zoo:board-result', listener)
  }
})
