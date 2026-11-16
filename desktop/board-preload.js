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
 * 这里和农场窗一样不在**输入法合成**时收起窗口（ADR-0029）：主进程按本文件上报的
 * `compositionstart` / `compositionend` 跳过这次失焦。真正点窗口外面会收起所有插件窗。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * 输入法合成期间不收起（ADR-0029）：候选窗抢焦点会触发 blur，但用户还在打中文。
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

contextBridge.exposeInMainWorld('dshZooBoard', {
  /** 监听器就位：主进程可以把当前盘口推过来了。 */
  ready () {
    ipcRenderer.send('dsh-zoo:board-ready')
  },
  submit (action) {
    if (action === null || typeof action !== 'object' || Array.isArray(action)) return
    // 字段由主进程按 shared.normalizeBoardAction 再白名单一遍；这里只挡明显不是对象的东西。
    // 字段按动作显式拷贝：开仓（side/margin/leverage/cropId）、平仓/止损（positionId）、
    // 止损再带一档 level（0 / 0.25 / 0.5 / 1）、到价挂单（target，合起来是
    // action/side/margin/leverage/cropId/target）、撤单（orderId）。
    // 硬币、价格、盈亏、总价一概不传——全部由宿主算。
    ipcRenderer.send('dsh-zoo:board-submit', {
      action: action.action,
      side: action.side,
      margin: action.margin,
      leverage: action.leverage,
      cropId: action.cropId,
      positionId: action.positionId,
      level: action.level,
      target: action.target,
      orderId: action.orderId
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
