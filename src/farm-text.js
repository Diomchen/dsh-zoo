/**
 * 农场/交易所失败的「错误码 → 人话」唯一文案表（ticket 40 / 41）。
 *
 * 三条路共用这一份：
 *   - `POST /dsh-zoo/action` 的失败（HTTP 客户端自己决定怎么显示，但文案同源）；
 *   - 桌面控件/农场小窗的 action-result（宿主给的 notice 优先，这一份是兜底）；
 *   - 渲染端拿不到宿主 notice 时按 code 兜底（`desktop/farm.js` 自己再抄一份短表）。
 *
 * 纪律和 `visit-copy.js` / `gift-text.js` 一样：不出现错误码、堆栈或磁盘细节，
 * 每句话都要告诉用户**下一步能做什么**。未知错误码返回 null，由调用方兜底。
 */

const FARM_ERROR_TEXT = Object.freeze({
  // 宿主/窗口传输层
  starting: '农场还在准备中，稍等一下再试。',
  'desktop-off': '桌面层没有在运行，开不了农场小窗。',
  disposed: '桌面正在关闭，这次操作没有完成。',
  timeout: '桌面宿主没有回应，这次操作可能没有生效。',
  'host-unavailable': '桌面宿主没有连接，这次操作没有完成。',
  'action-failed': '这次操作没有完成，稍后再试。',
  'bad-farm-action': '这个操作缺少地块或作物，再试一次。',
  // 农场规则（SPEC v5「状态出口与动作」的错误码）
  'bad-plot': '这块地不在了，刷新后再试。',
  'bad-crop': '这种作物种不了，换一种吧。',
  'plot-occupied': '这块地已经种上了，先收掉再种。',
  'not-mature': '还没熟呢，再等一会儿。',
  'no-seed': '没有这种种子了，先去交易所买。',
  'no-coin': '硬币不够，先去卖点作物。',
  'bad-qty': '数量要在 1–99 之间。',
  cap: '仓库装不下了，先卖掉一点再来。',
  'market-busy': '交易所这会儿太忙了（每分钟最多 10 笔），等一下再试。',
  'no-dew': '露水不够，先让宠物待机攒一会儿。',
  'already-watered': '这株已经浇过水了。',
  'already-fertilized': '这株已经施过肥了。'
})

export const FARM_ERROR_CODES = Object.freeze(Object.keys(FARM_ERROR_TEXT))

/** 错误码 → 一句人话；认不出的错误码返回 null（调用方用自己的兜底句）。 */
export function farmErrorText (error) {
  return typeof error === 'string' && Object.prototype.hasOwnProperty.call(FARM_ERROR_TEXT, error)
    ? FARM_ERROR_TEXT[error]
    : null
}
