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

/** 露水：每 10 分钟待机 +1，每天余额上限 48（SPEC v5「待机、露水与离线生长」）。 */
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

/** UI 用的阶段：empty / growing / mature（ticket 40 的地块条与状态出口共用）。 */
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
 * - 同一本地日：每满 10 分钟 +1，余额封顶 48；不足 10 分钟的零头留在 `dewAt` 里。
 * - 跨本地日：`dew` 归零、`dewAt` 从 `now` 重新计时（午夜正好重置，不补前一天）。
 * - `dewAt` 缺失/倒退：从 `now` 重新计时，不产生负增长或瞬间满额。
 *
 * 关掉 DSH 的离线时间**不**在这里补：那是离线生长的事，露水只奖励「开着但没在玩」。
 * 调用方在加载时把 `dewAt` 设成 now 即可把这条规则写死。
 */
export function advanceDew (state, now) {
  const current = Number(now)
  const balance = clampDew(state?.dew)
  const oldDay = typeof state?.dewDay === 'string' && state.dewDay !== '' ? state.dewDay : null
  const oldAt = Number(state?.dewAt)

  if (!Number.isFinite(current)) {
    return {
      dew: balance,
      dewAt: Number.isFinite(oldAt) && oldAt > 0 ? oldAt : null,
      dewDay: oldDay,
      gained: 0,
      reset: false
    }
  }

  const day = localDayKey(current)
  if (oldDay !== null && day !== null && oldDay !== day) {
    return { dew: 0, dewAt: current, dewDay: day, gained: 0, reset: true }
  }

  const anchor = Number.isFinite(oldAt) && oldAt > 0 && oldAt <= current ? oldAt : current
  if (balance >= MAX_DEW) {
    return { dew: balance, dewAt: current, dewDay: day, gained: 0, reset: false }
  }

  const intervals = Math.floor((current - anchor) / DEW_INTERVAL_MS)
  if (intervals <= 0) {
    return { dew: balance, dewAt: anchor, dewDay: day, gained: 0, reset: false }
  }

  const gained = Math.min(intervals, MAX_DEW - balance)
  const nextDew = balance + gained
  return {
    dew: nextDew,
    // 到顶就把锚点推到 now：满额期间不再攒「下次可兑现」的整数间隔。
    dewAt: nextDew >= MAX_DEW ? current : anchor + intervals * DEW_INTERVAL_MS,
    dewDay: day,
    gained,
    reset: false
  }
}

function clampDew (value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.min(MAX_DEW, Math.max(0, Math.floor(num)))
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
  const dice = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : Math.random()
  return dice >= safeGuard
}
