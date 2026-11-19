/**
 * 「出远门」的规则层（票 112）。
 *
 * 这里只有纯函数：路线表、段数、每段回币、危险度、状态迁移与结算。不读盘、不看系统时钟，
 * `now` 与随机都由调用方传进来——段数和抖动从 `runId` 派生，所以同一趟在重启后走的是同一条路。
 *
 * 112 只开后山一条路线；另外三条、翻车、特产与陈列架是 113 及以后的事，这里不预留会误导人的
 * 半成品字段。`loot` 现在只产生 `{ kind: 'coin', qty }`，以后掉特产时再加另一种 kind。
 */

/** 走一段的时间：20 秒（手册《出远门》的节奏）。 */
export const LEG_MS = 20000
/** 每段走完后的决策窗：20 秒。112 里到点不会自动折返，超时留给 113。 */
export const DECISION_MS = 20000

/**
 * 路线表。盘缠（fare）入场即扣、永不退；`coinRate` 是每段回币占盘缠的比例，
 * `coinJitter` 是乘在这个比例上的 ± 抖动。
 */
export const ROUTES = Object.freeze({
  backhill: Object.freeze({
    id: 'backhill',
    name: '后山',
    fare: 500,
    minLegs: 3,
    maxLegs: 4,
    coinRate: 0.03,
    coinJitter: 0.25,
    dangerBase: 0.05,
    dangerPerLeg: 0.03
  })
})

export const ROUTE_IDS = Object.freeze(Object.keys(ROUTES))

/** 112 只认「折返 / 走满」；`failed` 是 113 的翻车，读档时先容下。 */
const ENDED_KINDS = Object.freeze(['back', 'complete', 'failed'])

/** 规则层说人话的兜底文案；窗口/HTTP 只补宿主没说的那种。 */
export const EXPEDITION_ERROR_TEXT = Object.freeze({
  'already-away': '它正在出远门（或串门/打工），这一趟走不了。',
  'not-enough-coins': '硬币不够付盘缠，这趟走不了。',
  'no-route': '没有这条路线。',
  'not-walking': '这一趟现在不用做决定。',
  starting: '出远门还没准备好，稍等一下。',
  'save-failed': '存档写不进去，这趟没能出发。',
  'desktop-off': '桌面层没在运行，出远门的窗口开不了。'
})

/** 路线对象；未知 id 返回 null（不抛，读档时坏数据只降级）。 */
export function routeOf (routeId) {
  if (typeof routeId !== 'string') return null
  return Object.prototype.hasOwnProperty.call(ROUTES, routeId) ? ROUTES[routeId] : null
}

/**
 * 32 位 FNV-1a。只用它把 `runId` 派生成稳定的 [0,1) 随机数：
 * 同一趟、同一段永远重放同一个结果，重启不会「走另一条路」。
 */
export function hash32 (...parts) {
  let hash = 2166136261
  const text = parts.map((part) => String(part)).join('|')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 由参数派生的确定性随机数，落在 [0,1)。 */
export function roll01 (...parts) {
  return hash32(...parts) / 4294967296
}

/** 这一趟走几段：在路线的 [minLegs, maxLegs] 里按 runId 定。 */
export function legsFor (route, runId) {
  const span = route.maxLegs - route.minLegs + 1
  return route.minLegs + Math.floor(roll01(runId, 'legs') * span)
}

/** 每段回币的基数：round(盘缠 × 3%)——后山是 15。 */
export function baseLegCoins (route) {
  return Math.round(route.fare * route.coinRate)
}

/** 第 `leg` 段的回币：基数 × [1-jitter, 1+jitter]，四舍五入，至少 1 枚。 */
export function legCoins (route, runId, leg) {
  const factor = 1 - route.coinJitter + 2 * route.coinJitter * roll01(runId, 'coin', leg)
  return Math.max(1, Math.round(baseLegCoins(route) * factor))
}

/** 第 `leg` 段的危险度：基础 + 每段累加（只用于显示，翻车在 113）。 */
export function dangerOf (route, leg) {
  return Math.min(0.95, route.dangerBase + route.dangerPerLeg * (leg - 1))
}

/** 危险度的人话档位：低 / 中 / 高。 */
export function dangerLabel (rate) {
  if (rate < 0.08) return '低'
  if (rate < 0.15) return '中'
  return '高'
}

/** 一趟是否还在外面（有 phase 就还没回家）。 */
export function isActiveRun (run) {
  return run !== null && typeof run === 'object' && run.phase !== null && run.phase !== undefined
}

/** 出发：形状定死，`until` 由 now 推。未知路线返回 null。 */
export function startRun ({ routeId, runId, now } = {}) {
  const route = routeOf(routeId)
  if (route === null || typeof runId !== 'string' || runId.length === 0) return null
  if (!Number.isFinite(now)) return null
  return {
    id: runId,
    routeId: route.id,
    phase: 'walking',
    leg: 1,
    totalLegs: legsFor(route, runId),
    until: now + LEG_MS,
    loot: [],
    startedAt: now,
    ended: null,
    endedAt: null
  }
}

/**
 * 到点推进：走完当前段，掉一笔回币。
 *
 * - 没到点、不在 walking、或这一趟已结束 → null（调用方不用写盘）。
 * - 走的是最后一段 → 直接 `ended: 'complete'`，回家。
 * - 否则进决策窗，`until` 再给 20 秒。
 *
 * 返回 `{ run, leg, coins }`；`run` 是新对象，不改入参。
 */
export function advanceRun (run, now) {
  if (!isActiveRun(run) || run.phase !== 'walking') return null
  if (!Number.isFinite(now) || now < run.until) return null
  const route = routeOf(run.routeId)
  if (route === null) return null
  const coins = legCoins(route, run.id, run.leg)
  const loot = [...run.loot, { kind: 'coin', qty: coins }]
  const leg = run.leg
  if (leg >= run.totalLegs) {
    return {
      run: { ...run, phase: null, until: null, loot, ended: 'complete', endedAt: now },
      leg,
      coins
    }
  }
  return {
    run: { ...run, phase: 'deciding', until: now + DECISION_MS, loot },
    leg,
    coins
  }
}

/** 「继续走」：只有决策窗合法；段数 +1，重新走 20 秒。 */
export function stepRun (run, now) {
  if (!isActiveRun(run) || run.phase !== 'deciding') return null
  if (!Number.isFinite(now)) return null
  return { ...run, phase: 'walking', leg: run.leg + 1, until: now + LEG_MS }
}

/** 「见好就收」：只有决策窗合法；标记折返，回币由 settledOf 算。 */
export function backRun (run, now) {
  if (!isActiveRun(run) || run.phase !== 'deciding') return null
  if (!Number.isFinite(now)) return null
  return { ...run, phase: null, until: null, ended: 'back', endedAt: now }
}

/** 战利品里的硬币总数。 */
export function sumCoins (loot) {
  if (!Array.isArray(loot)) return 0
  let total = 0
  for (const item of loot) {
    if (item !== null && typeof item === 'object' && item.kind === 'coin' && Number.isInteger(item.qty)) {
      total += item.qty
    }
  }
  return total
}

/**
 * 回家结算：盘缠是沉没成本，只把已走段数掉出来的硬币带回去。
 * 112 没有特产，`items` 固定是空数组，但形状先留着给 113 填。
 */
export function settledOf (run) {
  const route = isActiveRun(run) || (run !== null && typeof run === 'object') ? routeOf(run.routeId) : null
  return {
    runId: run?.id ?? null,
    routeId: run?.routeId ?? null,
    fare: route === null ? 0 : route.fare,
    legs: Number.isInteger(run?.leg) ? run.leg : 0,
    coins: sumCoins(run?.loot),
    items: [],
    ended: run?.ended ?? null
  }
}

/**
 * 读档时的形状校验：坏 run 直接丢（当作没出门），不把半个状态带进内存。
 * 允许已结束的趟留在文件里，窗口重开时还能看见上一趟的结果。
 */
export function normalizeRun (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const route = routeOf(raw.routeId)
  if (route === null) return null
  if (typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 128) return null
  if (!Number.isInteger(raw.totalLegs)) return null
  if (raw.totalLegs < route.minLegs || raw.totalLegs > route.maxLegs) return null
  if (!Number.isInteger(raw.leg) || raw.leg < 1 || raw.leg > raw.totalLegs) return null
  if (!Number.isFinite(raw.startedAt)) return null

  const walking = raw.phase === 'walking'
  const deciding = raw.phase === 'deciding'
  const ended = ENDED_KINDS.includes(raw.ended) ? raw.ended : null
  if (walking || deciding) {
    if (ended !== null) return null
    if (!Number.isFinite(raw.until)) return null
  } else if (raw.phase === null || raw.phase === undefined) {
    if (ended === null) return null
  } else {
    return null
  }

  const loot = []
  if (!Array.isArray(raw.loot)) return null
  for (const item of raw.loot) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    if (item.kind !== 'coin') return null
    if (!Number.isInteger(item.qty) || item.qty < 1) return null
    loot.push({ kind: 'coin', qty: item.qty })
  }

  const active = walking || deciding
  return {
    id: raw.id,
    routeId: route.id,
    phase: active ? raw.phase : null,
    leg: raw.leg,
    totalLegs: raw.totalLegs,
    until: active ? raw.until : null,
    loot,
    startedAt: raw.startedAt,
    ended: active ? null : ended,
    endedAt: active ? null : (Number.isFinite(raw.endedAt) ? raw.endedAt : null)
  }
}
