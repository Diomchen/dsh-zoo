/**
 * 农场纯规则（ticket 39）：作物表、生长/成熟、收获产量、露水与守卫概率。
 *
 * 这一层不碰时钟、磁盘、网络：时间从参数进来，随机源可注入。`farm.json`
 * 的形状与 I/O 在 src/farm.js；这里只回答「过了这么久长到哪、收多少、露水攒多少」。
 */

export const MINUTE_MS = 60 * 1000
export const HOUR_MS = 60 * MINUTE_MS

/**
 * 三种作物（SPEC v5「农场与作物」）。
 * `growMs` 生长时长、`seedPrice` 种子价、`yield` 产量、`base` 交易所底价。
 */
export const CROPS = Object.freeze({
  tomato: Object.freeze({
    id: 'tomato',
    name: '小番茄',
    growMs: 30 * MINUTE_MS,
    seedPrice: 6,
    yield: 3,
    base: 5
  }),
  carrot: Object.freeze({
    id: 'carrot',
    name: '胡萝卜',
    growMs: 2 * HOUR_MS,
    seedPrice: 14,
    yield: 5,
    base: 6
  }),
  pumpkin: Object.freeze({
    id: 'pumpkin',
    name: '南瓜',
    growMs: 8 * HOUR_MS,
    seedPrice: 36,
    yield: 3,
    base: 30
  })
})

export const CROP_IDS = Object.freeze(Object.keys(CROPS))

/**
 * 地块解锁（ticket 48 / ADR-0017）：4 块起步、50 块封顶、只能按顺序买。
 * 地价 = round5(60 × 1.10^(已解锁数 − 4))；取整到 5，窗口与宿主用同一份纯函数。
 */
export const START_PLOTS = 4
export const MAX_PLOTS = 50
export const PLOT_UNLOCK_FIRST_COST = 60
export const PLOT_UNLOCK_RATE = 1.10
/** 解锁后至少留一颗最便宜种子的钱，避免「全空地 + 0 硬币 + 0 种子」的软锁。 */
export const PLOT_UNLOCK_RESERVE = Math.min(...CROP_IDS.map((id) => CROPS[id].seedPrice))

/** 地块数夹到 [START_PLOTS, MAX_PLOTS]；坏值按起点算。 */
export function clampPlotCount (value) {
  const count = Number(value)
  if (!Number.isInteger(count)) return START_PLOTS
  return Math.min(MAX_PLOTS, Math.max(START_PLOTS, count))
}

/** 下一块地的价格；已到上限返回 null。越界/坏值按 null（调用方不显示解锁入口）。 */
export function plotUnlockCost (unlocked) {
  const count = Number(unlocked)
  if (!Number.isInteger(count) || count < START_PLOTS || count >= MAX_PLOTS) return null
  const raw = PLOT_UNLOCK_FIRST_COST * Math.pow(PLOT_UNLOCK_RATE, count - START_PLOTS)
  return Math.round(raw / 5) * 5
}

/**
 * 偷/帮的每日上限：随已解锁地块数温和放大（ADR-0017）。
 * 跨农场的 `perVisitorDay` 用访客自己农场的大小算：两本账最终一致，额度随自家规模长。
 */
export function visitLimitsFor (unlocked) {
  const extra = Math.max(0, clampPlotCount(unlocked) - START_PLOTS)
  return {
    steal: {
      perVisitorFarm: 3 + Math.floor(extra / 10),
      perFarmDay: 5 + Math.floor(extra / 5),
      perVisitorDay: 10 + Math.floor(extra / 10)
    },
    help: {
      perVisitorFarm: 3 + Math.floor(extra / 10),
      perFarmDay: 5 + Math.floor(extra / 5),
      perVisitorDay: 5 + Math.floor(extra / 10)
    }
  }
}

/** 露水：每 10 分钟待机 +1，每天最多挣 48、余额也封顶 48（SPEC v5）。 */
export const DEW_INTERVAL_MS = 10 * MINUTE_MS
export const MAX_DEW = 48
/** 浇水 / 施肥的露水价（各一次）。 */
export const WATER_COST = 1
export const FERTILIZE_COST = 5

/** 一次离线最多补 12 小时生长；运行中按真实时间走，不设上限。 */
export const OFFLINE_GROWTH_CAP_MS = 12 * HOUR_MS

/** 守卫：主人宠物在家 0.3 + 雇工 0.5，相加封顶 0.8（SPEC v5「雇佣与看家」）。 */
export const OWNER_GUARD = 0.3
export const WORKER_GUARD = 0.5
export const MAX_GUARD = 0.8

/** 作物 id 的白名单判断；`farm.json`、协议和 UI 都从这里取同一份表。 */
export function isCropId (value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CROPS, value)
}

/** 作物表项；未知作物返回 null（调用方据此报 bad-crop / 归一成空地）。 */
export function cropOf (value) {
  return isCropId(value) ? CROPS[value] : null
}

/** 作物的基础生长时长；未知作物按 0，避免把 NaN 写进地块。 */
export function growMsOf (value) {
  return cropOf(value)?.growMs ?? 0
}

/** 地块成熟：`grownMs >= growMs`；空地永远不成熟。成熟后停止生长，也不枯萎。 */
export function isMature (plot) {
  if (!isCropId(plot?.crop)) return false
  const growMs = Number(plot.growMs)
  const grownMs = Number(plot.grownMs)
  if (!Number.isFinite(growMs) || growMs <= 0) return false
  return Number.isFinite(grownMs) && grownMs >= growMs
}

/** UI 用的阶段：empty / growing / mature（ticket 40 的农场小窗与状态出口共用）。 */
export function plotStage (plot) {
  if (!isCropId(plot?.crop)) return 'empty'
  return isMature(plot) ? 'mature' : 'growing'
}

/** 还差多少毫秒成熟；空地/成熟都是 0。 */
export function plotRemainingMs (plot) {
  if (!isCropId(plot?.crop) || isMature(plot)) return 0
  return Math.max(0, Number(plot.growMs) - Number(plot.grownMs))
}

/**
 * 推进一块地的生长：纯函数，返回新对象；没变化时返回原对象（调用方据此判断脏）。
 * 到 `growMs` 就停住——成熟后不再生长，也不会枯萎/掉产量。
 */
export function advanceGrowth (plot, elapsedMs) {
  if (!isCropId(plot?.crop) || isMature(plot)) return plot
  const elapsed = Number(elapsedMs)
  if (!Number.isFinite(elapsed) || elapsed <= 0) return plot
  const grownMs = Math.min(Number(plot.growMs), Math.max(0, Number(plot.grownMs) || 0) + elapsed)
  if (grownMs === plot.grownMs) return plot
  return { ...plot, grownMs }
}

/** 还能浇水吗：有作物、没成熟、这一株还没浇过。 */
export function canWater (plot) {
  if (!isCropId(plot?.crop) || isMature(plot)) return false
  return Number(plot.waterings) < 1
}

/**
 * 浇水：+10%（至少 1ms，短作物也能看见效果），记为一次。不可浇时返回 null。
 * 「+10% growMs」按当前地块的总生长时长算，加在 `grownMs` 上——加在 `growMs`
 * 上只会让作物更久成熟，与 SPEC 的「长得快」相反。
 */
export function waterPlot (plot) {
  if (!canWater(plot)) return null
  const bonus = Math.max(1, Math.floor(Number(plot.growMs) * 0.1))
  const grownMs = Math.min(Number(plot.growMs), Number(plot.grownMs) + bonus)
  return { ...plot, waterings: Number(plot.waterings) + 1, grownMs }
}

/**
 * 访客帮忙（ticket 43）：和主人的浇水走同一条 +10% 生长，但**不算** waterings。
 *
 * 主人的浇水和访客的帮忙是两件独立的事：同一位访客每块地只能帮一次（`helpedBy` 判），
 * 主人自己也仍能浇一次（`waterings` 判）。把帮忙记进 waterings 会让两者互相吃掉。
 * 空地/成熟地没有可帮的生长，返回 null。
 */
export function helpPlot (plot) {
  if (!isCropId(plot?.crop) || isMature(plot)) return null
  const bonus = Math.max(1, Math.floor(Number(plot.growMs) * 0.1))
  const grownMs = Math.min(Number(plot.growMs), Number(plot.grownMs) + bonus)
  return { ...plot, grownMs }
}

/** 还能施肥吗：有作物、这一株还没施过。成熟后仍可施（收获前最后一个加成）。 */
export function canFertilize (plot) {
  return isCropId(plot?.crop) && plot.fertilized !== true
}

/** 施肥：把 `fertilized` 置真，收获时 +1 产量；不可施时返回 null。 */
export function fertilizePlot (plot) {
  if (!canFertilize(plot)) return null
  return { ...plot, fertilized: true }
}

/**
 * 收获产量 = 作物表产量 + 施肥 1 − 被偷数量，最低 0。
 * `stolenBy` 按去重后的访客数算（每块地每轮每位访客只偷 1 个）。
 */
export function harvestYield (plot) {
  const crop = cropOf(plot?.crop)
  if (crop === null) return 0
  const stolen = Array.isArray(plot.stolenBy) ? plot.stolenBy.length : 0
  const bonus = plot.fertilized === true ? 1 : 0
  return Math.max(0, crop.yield + bonus - stolen)
}

/**
 * 离线补算的时长：`min(now − lastTickAt, 12h)`。
 * 时钟倒退、缺时间戳都按 0，绝不让坏文件把作物一次推到未来。
 */
export function offlineElapsed (lastTickAt, now, capMs = OFFLINE_GROWTH_CAP_MS) {
  const last = Number(lastTickAt)
  const current = Number(now)
  const cap = Number(capMs)
  if (!Number.isFinite(last) || last <= 0) return 0
  if (!Number.isFinite(current)) return 0
  const max = Number.isFinite(cap) && cap >= 0 ? cap : OFFLINE_GROWTH_CAP_MS
  return Math.min(max, Math.max(0, current - last))
}

function pad (value, width = 2) {
  return String(value).padStart(width, '0')
}

/** 本地日期键 `YYYY-MM-DD`：露水按本地午夜重置，不用 UTC（跨时区会早/晚 8 小时）。 */
export function localDayKey (at) {
  const date = at instanceof Date ? at : new Date(Number(at))
  if (Number.isNaN(date.getTime())) return null
  return String(date.getFullYear()).padStart(4, '0') + '-' +
    pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/**
 * 待机露水推进（纯函数）。
 *
 * - 同一本地日：每满 10 分钟 +1；**每天挣到的总量**封顶 48，余额也封顶 48。
 *   只有余额会被花掉，`dewEarned` 记账不随花费回退——花光不能再刷当天的额度。
 * - 跨本地日：`dew` / `dewEarned` 都归零、`dewAt` 从 `now` 重新计时
 *   （午夜正好重置，不补前一天）。
 * - `dewAt` 缺失/倒退：从 `now` 重新计时，不产生负增长或瞬间满额。
 * - 旧文件没有 `dewEarned` 时按 0 起算，但当前余额一定算进「今天已挣」，
 *   避免手改/旧版本凭空多出额度。
 *
 * 关掉 DSH 的离线时间**不**在这里补：那是离线生长的事，露水只奖励「开着但没在玩」。
 * 调用方在加载时把 `dewAt` 设成 now 即可把这条规则写死。
 */
export function advanceDew (state, now) {
  const current = Number(now)
  let balance = clampDew(state?.dew)
  let earned = clampDew(state?.dewEarned)
  const oldDay = dayOrNull(state?.dewDay)
  const oldEarnedDay = dayOrNull(state?.dewDayEarned) ?? oldDay
  const oldAt = Number(state?.dewAt)

  if (!Number.isFinite(current)) {
    return {
      dew: balance,
      dewEarned: Math.max(earned, balance),
      dewAt: Number.isFinite(oldAt) && oldAt > 0 ? oldAt : null,
      dewDay: oldDay,
      dewDayEarned: oldEarnedDay,
      gained: 0,
      reset: false
    }
  }

  const day = localDayKey(current)
  let reset = false
  if (oldDay !== null && day !== null && oldDay !== day) {
    balance = 0
    reset = true
  }
  if (oldEarnedDay !== null && day !== null && oldEarnedDay !== day) {
    earned = 0
    reset = true
  }
  // 余额里的每一滴都算今天已经挣到的：手改文件/旧版本不能凭空多出额度。
  earned = Math.max(earned, balance)

  if (reset) {
    // 跨日这一拍只做重置，不补午夜前后的零头；下一拍重新从 10 分钟起算。
    return {
      dew: balance,
      dewEarned: earned,
      dewAt: current,
      dewDay: day,
      dewDayEarned: day,
      gained: 0,
      reset: true
    }
  }

  const anchor = Number.isFinite(oldAt) && oldAt > 0 && oldAt <= current ? oldAt : current
  if (balance >= MAX_DEW || earned >= MAX_DEW) {
    return {
      dew: balance,
      dewEarned: earned,
      dewAt: current,
      dewDay: day,
      dewDayEarned: day,
      gained: 0,
      reset: false
    }
  }

  const intervals = Math.floor((current - anchor) / DEW_INTERVAL_MS)
  if (intervals <= 0) {
    return {
      dew: balance,
      dewEarned: earned,
      dewAt: anchor,
      dewDay: day,
      dewDayEarned: day,
      gained: 0,
      reset: false
    }
  }

  const gained = Math.min(intervals, MAX_DEW - balance, MAX_DEW - earned)
  const nextDew = balance + gained
  const nextEarned = earned + gained
  return {
    dew: nextDew,
    dewEarned: nextEarned,
    // 被日上限或余额上限截住时把锚点推到 now：攒不下的间隔不能留到以后兑现。
    dewAt: gained < intervals || nextDew >= MAX_DEW || nextEarned >= MAX_DEW
      ? current
      : anchor + intervals * DEW_INTERVAL_MS,
    dewDay: day,
    dewDayEarned: day,
    gained,
    reset: false
  }
}

function clampDew (value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.min(MAX_DEW, Math.max(0, Math.floor(num)))
}

function dayOrNull (value) {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 守卫值：主人宠物在家 0.3 + 有雇工 0.5，相加封顶 0.8。
 * 43（偷菜）与 44（雇工）共用；这里只算值，不决定谁在家。
 */
export function guardValue ({ ownerHome = false, worker = false } = {}) {
  const owner = ownerHome === true ? OWNER_GUARD : 0
  const hired = worker === true ? WORKER_GUARD : 0
  return Math.min(MAX_GUARD, owner + hired)
}

/**
 * 偷菜判定（纯函数，随机源可注入）：成功率 = 1 − 守卫。
 * `random` 返回 [0,1)，落在守卫区间内就是被抓住；返回 true 表示这次偷到了。
 */
export function stealSucceeds (guard, random = Math.random) {
  const value = Number(guard)
  const safeGuard = Number.isFinite(value) ? Math.min(MAX_GUARD, Math.max(0, value)) : 0
  const roll = typeof random === 'function' ? Number(random()) : Number.NaN
  // 随机源坏了也不能回落到全局 Math.random()（那不是注入的判定）：按 0 处理＝必被抓住。
  const dice = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0
  return dice >= safeGuard
}
