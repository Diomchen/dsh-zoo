/**
 * 盘口失败的「错误码 → 人话」唯一文案表（票 79/80）。
 *
 * 三条路共用这一份：`POST /dsh-zoo/action` 的失败、盘口小窗的 action-result
 * （宿主给的 notice 优先，这份是兜底）、以及渲染端拿不到 notice 时的兜底。
 *
 * 纪律和 `farm-text.js` / `gift-text.js` 一样：不出现错误码、堆栈或磁盘细节，
 * 每句话都告诉用户**下一步能做什么**。未知错误码返回 null，由调用方兜底。
 */

const TRADING_ERROR_TEXT = Object.freeze({
  // 宿主/窗口传输层
  starting: '盘口还在准备中，稍等一下再试。',
  'desktop-off': '桌面层没有在运行，开不了盘口窗。',
  disposed: '桌面正在关闭，这次操作没有完成。',
  timeout: '桌面宿主没有回应，这次操作可能没有生效。',
  'host-unavailable': '桌面宿主没有连接，这次操作没有完成。',
  'action-failed': '这次操作没有完成，稍后再试。',
  'bad-board-action': '这个操作缺少方向或保证金，再试一次。',
  // 盘口规则（票 79 的白名单）
  'bad-crop': '这种作物暂时没有盘口。',
  'bad-side': '方向只有做多和做空。',
  'bad-margin': '保证金只有 50 和 100 两档。',
  'bad-leverage': '这档杠杆还没开放（只有 1× / 5× / 20×）。',
  // 一键止损（票 80）：0 / −25% / −50% / −100% 四档，别的值一律不认。
  'bad-stop': '止损只有 关 / −25% / −50% / −100% 四档。',
  'no-coin': '硬币不够，先去种地或卖点作物。',
  'no-position': '这个仓位已经平掉了，刷新一下就好。',
  settling: '这个仓位正在结算，等一下再看。'
})

/**
 * 结算原因 → 中文（票 80）：`close` 手动 / `settle` 收盘 / `liquidate` 强平 / `stop` 止损。
 *
 * 枚举本身住在 `src/trading.js`（账本形状的唯一真相），这里只负责说人话。
 * 窗口（票 81）是 UMD 纯视图、拿不到这里的 ESM，它自己那份由 drift 测试盯着；
 * 宿主这一份给 `/state` 之外的文字场合用（toast、日志、将来的通知）。
 */
const TRADING_REASON_TEXT = Object.freeze({
  close: '手动平仓',
  settle: '收盘结算',
  liquidate: '强平',
  stop: '止损'
})

export const TRADING_ERROR_CODES = Object.freeze(Object.keys(TRADING_ERROR_TEXT))
export const TRADING_REASON_CODES = Object.freeze(Object.keys(TRADING_REASON_TEXT))

/** 错误码 → 一句人话；认不出的错误码返回 null（调用方用自己的兜底句）。 */
export function tradingErrorText (error) {
  return typeof error === 'string' && Object.prototype.hasOwnProperty.call(TRADING_ERROR_TEXT, error)
    ? TRADING_ERROR_TEXT[error]
    : null
}

/** 结算原因 → 一句人话；认不出的原因返回 null（调用方用自己的兜底句）。 */
export function tradingReasonText (reason) {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(TRADING_REASON_TEXT, reason)
    ? TRADING_REASON_TEXT[reason]
    : null
}
