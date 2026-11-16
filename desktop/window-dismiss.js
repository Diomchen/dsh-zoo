/**
 * 点窗口外面收起全部插件窗（ADR-0029 / 票 85）：纯判定，单独一份、可单测。
 *
 * 为什么要单独抽：200ms 计时器和 `BrowserWindow` 只有 Electron 里才有，但“这次失焦该不该
 * 收起”是一张判断表；放在这里，Node 测试能逐格覆盖，main.js 只负责采集现场状态。
 *
 * 判定顺序就是旧约定的边界：正在输入法合成、冒烟/原生对话框锁、应用正在退出都不收；
 * 然后必须已经等过 `DISMISS_DELAY_MS`（躲开“打开另一扇插件窗”的瞬时失焦），并且焦点
 * 没有落回任何还在开着的插件窗（含刚失焦的这扇）。
 */

'use strict'

/** 失焦后等这么久（毫秒）再收：跨窗口点击时旧窗先 blur、新窗随后才 focus。 */
const DISMISS_DELAY_MS = 200

/**
 * @param {object} state
 * @param {number|null} state.focusedId 系统焦点所在插件窗的 webContents id；不在插件窗里为 null
 * @param {number[]} state.pluginIds 仍然开着的插件窗 webContents id
 * @param {boolean} state.composing 任一插件窗正在输入法合成（compositionstart..compositionend）
 * @param {boolean} state.locked 冒烟 blur 锁 / 原生文件选择器等“这次失焦不算数”
 * @param {boolean} state.quitting 应用正在退出
 * @param {number} state.blurAgeMs 从失焦到现在过了多久
 * @returns {boolean} true = 收起全部插件窗
 */
function shouldDismissOnBlur ({ focusedId, pluginIds, composing, locked, quitting, blurAgeMs } = {}) {
  if (locked === true) return false
  if (quitting === true) return false
  if (composing === true) return false
  if (typeof blurAgeMs !== 'number' || !Number.isFinite(blurAgeMs) || blurAgeMs < DISMISS_DELAY_MS) {
    return false
  }
  const openIds = Array.isArray(pluginIds)
    ? pluginIds.filter((id) => typeof id === 'number' && Number.isInteger(id))
    : []
  // 一扇插件窗都没开：没有可收的东西，也别让空计时器留下“关了点什么”的错觉。
  if (openIds.length === 0) return false
  // 焦点还在任一插件窗里（刚点进来的那扇）就不收：从盘口点到农场不算“点外面”。
  if (typeof focusedId === 'number' && openIds.includes(focusedId)) return false
  return true
}

module.exports = {
  DISMISS_DELAY_MS,
  shouldDismissOnBlur
}
