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
  'out-of-season': '这个季节种不了它，下季再来吧。',
  withered: '换季了，这株没来得及熟，重种一株吧。',
  'not-enough-crops': '仓库里的作物不够。',
  'omen-resolved': '这位来客已经打发走了。',
  'bad-choice': '这个应对方式不成立。',
  'stale-season': '节日/来客已经换了一天，刷新后再试。',
  'event-inactive': '今天没有可领的节日。',
  'event-not-ready': '节日任务还没完成，再忙一会儿。',
  'event-claimed': '今天的节日奖励已经领过了。',
  'plot-occupied': '这块地已经种上了，先收掉再种。',
  'not-mature': '还没熟呢，再等一会儿。',
  'no-seed': '没有这种种子了，先去交易所买。',
  'no-crop': '没有这种作物了，先种一点再来卖。',
  'no-coin': '硬币不够，先去卖点作物。',
  'bad-qty': '数量要在 1–99 之间。',
  cap: '仓库装不下了，先卖掉一点再来。',
  'market-busy': '交易所这会儿太忙了（每分钟最多 10 笔），等一下再试。',
  'no-dew': '露水不够，先让宠物待机攒一会儿。',
  'already-watered': '这株已经浇过水了。',
  'already-fertilized': '这株已经施过肥了。',
  // 地块解锁（ticket 48）
  'max-plots': '已经到 50 块地了，没有可解锁的地块。',
  reserve: '解锁后至少要留一点种子钱，先卖点作物吧。',
  stale: '农场刚刚变过，刷新后再试。',
  // 雇佣合同（ticket 44）
  'own-pet': '不能雇自己的宠物。',
  'worker-unavailable': '这只宠物现在不能来打工：可能不在家、在串门，或者已经接了别的活。',
  'already-working': '宠物正在打工，合同结束前不能再接别的活。',
  'already-hired': '家里已经有一位雇工了，先结束现有合同。',
  'bad-wage': '时薪要在 1–100 硬币之间。',
  'bad-hours': '合同时长要在 2–8 小时之间（最短不能超过最长）。',
  'bad-enabled': '挂牌开关的取值不对。',
  'contract-not-found': '找不到这份合同，可能已经结束了。',
  'contract-ended': '这份合同已经结束了。',
  'contract-busy': '这份合同正在结算，等一下再看。',
  busy: '上一笔雇佣还在联系中，等一下再试。',
  // 访客动作（ticket 43）
  'no-visit': '这次串门已经结束了。',
  'no-port': '对方没开局域网端口，看不到他家的农场。',
  // 票 54：对面是 1.2 及更早的版本，既没有只读视图也没有免放行的偷。
  'old-neighbor': '对方的版本太老，还不支持远程看田和派它去偷。',
  'already-stolen': '这块地这一轮已经被你偷过了。',
  'already-helped': '这块地这一轮已经帮过了。',
  guard: '被抓住了，这次白跑（没有罚款）。'
})

export const FARM_ERROR_CODES = Object.freeze(Object.keys(FARM_ERROR_TEXT))

/** 错误码 → 一句人话；认不出的错误码返回 null（调用方用自己的兜底句）。 */
export function farmErrorText (error) {
  return typeof error === 'string' && Object.prototype.hasOwnProperty.call(FARM_ERROR_TEXT, error)
    ? FARM_ERROR_TEXT[error]
    : null
}

/**
 * 访客动作（偷/帮）的结果文案。成功两句要说出“拿到了什么”，失败按固定枚举翻人话；
 * `cap` 在访客语境里不是“仓库满”，而是“今天的次数用完了”。
 */
const VISIT_ERROR_TEXT = Object.freeze({
  'no-visit': '这次串门已经结束了，偷不了啦。',
  'no-port': '对方没开局域网端口，偷不了啦。',
  timeout: '主人家的宠物没回应，这次可能白跑。',
  'not-mature': '这块地还没熟。',
  'already-stolen': '这块地这一轮已经被你偷过了。',
  'already-helped': '这块地这一轮已经帮过了。',
  cap: '今天的次数用完了，明天再来。',
  guard: '被抓住了，这次白跑（没有罚款）。',
  'no-dew': '露水不够，帮不了忙。',
  'bad-plot': '这块地不能这么做。',
  starting: '农场还在准备中，稍等一下再试。',
  'bad-shape': '对方发来的农场数据不对，这次没偷成。',
  'bad-json': '对方发来的农场数据坏了，这次没偷成。',
  'too-large': '对方的农场数据太大了，这次没偷成。',
  refused: '对方没有回应，这次可能白跑。',
  gone: '这次串门已经结束了。'
})

const CROP_NAMES = Object.freeze({
  pea: '豌豆',
  tomato: '小番茄',
  strawberry: '草莓',
  radish: '白萝卜',
  carrot: '胡萝卜',
  rice: '稻米',
  corn: '玉米',
  watermelon: '西瓜',
  pumpkin: '南瓜',
  grape: '葡萄'
})

export function farmActionResultText ({ action, ok, error, crop } = {}) {
  if (ok === true) {
    const name = CROP_NAMES[crop] ?? '作物'
    if (action === 'help') return '帮上了忙：这块地长得快了一点，+1 硬币。'
    return '偷到了 1 个' + name + '！'
  }
  return typeof error === 'string' && Object.prototype.hasOwnProperty.call(VISIT_ERROR_TEXT, error)
    ? VISIT_ERROR_TEXT[error]
    : '这次没有完成，稍后再试。'
}
