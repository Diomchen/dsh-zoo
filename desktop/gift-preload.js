/**
 * 「带派」小窗的桥（ticket 24）：只暴露六个原语，没有任何 Node 能力外泄。
 *
 *   - ready() / onInit：告诉主进程「监听器已就位」，然后收背包内容与限额；
 *   - submit(gift)：把要放进背包的东西交上去；`{pick:true}` 是请主进程开文件选择器
 *     （渲染进程拿不到本机路径，文件只能由主进程选）；
 *   - remove(giftId)：撤掉背包里某一件（只有 idle 能撤，主进程/宿主再判断一次）；
 *   - cancel() / onResult：关窗与宿主的答复。
 *
 * 和主窗的 preload 是两份文件：这扇窗能收键盘、能提交物品，但同样**不能**自己改状态。
 */
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('localPetGift', {
  /** 监听器就位：主进程可以把当前背包推过来了。 */
  ready () {
    ipcRenderer.send('local-pet:gift-ready')
  },
  submit (gift) {
    if (gift === null || typeof gift !== 'object' || Array.isArray(gift)) return
    // 字段由主进程按 shared.normalizeBringGift 再白名单一遍；这里只挡明显不是对象的东西。
    ipcRenderer.send('local-pet:gift-submit', {
      kind: gift.kind,
      text: gift.text,
      path: gift.path,
      pick: gift.pick === true
    })
  },
  remove (giftId) {
    if (typeof giftId !== 'string') return
    ipcRenderer.send('local-pet:gift-remove', { giftId })
  },
  cancel () {
    ipcRenderer.send('local-pet:gift-cancel')
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
    ipcRenderer.on('local-pet:gift-init', listener)
    return () => ipcRenderer.removeListener('local-pet:gift-init', listener)
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
    ipcRenderer.on('local-pet:gift-result', listener)
    return () => ipcRenderer.removeListener('local-pet:gift-result', listener)
  }
})
