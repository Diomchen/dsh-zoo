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

/**
 * 结束原因，给 116 的日志写正文用：
 * - `wipeout` 继续走时翻车；
 * - `timeout` 决策窗 20 秒没人管，自己折返。
 * 正常折返/走满不带原因。
 */
export const ENDED_REASONS = Object.freeze(['wipeout', 'timeout'])

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

/** murmur3 的尾混合：让末位的一个字符也能把整个 32 位搅乱。 */
function fmix32 (value) {
  let hash = value >>> 0
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}

/**
 * 由参数派生的确定性随机数，落在 [0,1)。
 *
 * 必须先过 fmix32：FNV-1a 对「只差最后一个字符」的两个串（`…|danger|2` /
 * `…|danger|3`）输出只差一个常数，不搅一遍的话「上一段没翻车」会把下一段
 * 的翻车率压低一个量级，`dangerOf` 的递增就形同虚设。
 */
export function roll01 (...parts) {
  return fmix32(hash32(...parts)) / 4294967296
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
    endedAt: null,
    reason: null
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

/**
 * 目标段会不会翻车：从 runId 派生，同一趟同一段永远同一个结果。
 * 已经走过 leg 段，下一段的危险度是 dangerOf(route, leg + 1)。
 */
export function wipedOut (run, leg) {
  const route = routeOf(run?.routeId)
  if (route === null || !Number.isInteger(leg)) return false
  return roll01(run.id, 'danger', leg) < dangerOf(route, leg)
}

/**
 * 「继续走」：只有决策窗合法；段数 +1，重新走 20 秒。
 *
 * 迈步前先掷一次翻车（基础 5% + 每已走段 3%）：翻了就地回家，
 * `leg` 不动（这段没走成），`loot` 不动（已捡的硬币照给），盘缠不退。
 */
export function stepRun (run, now) {
  if (!isActiveRun(run) || run.phase !== 'deciding') return null
  if (!Number.isFinite(now)) return null
  const nextLeg = run.leg + 1
  if (wipedOut(run, nextLeg)) {
    return { ...run, phase: null, until: null, ended: 'failed', endedAt: now, reason: 'wipeout' }
  }
  return { ...run, phase: 'walking', leg: nextLeg, until: now + LEG_MS, reason: null }
}

/**
 * 决策窗超时：没人按「继续」也没按「见好就收」，自己折返。
 * 只有 deciding 且真到点才动，返回新 run；否则 null。
 */
export function expireRun (run, now) {
  if (!isActiveRun(run) || run.phase !== 'deciding') return null
  if (!Number.isFinite(now) || now < run.until) return null
  return { ...run, phase: null, until: null, ended: 'back', endedAt: now, reason: 'timeout' }
}

/**
 * 读档续走：只推进到「下一个节点」，不补算错过的段数、不补掷。
 *
 * - 还没到点 → null（原样留着，到点由 tick 接上）。
 * - walking 到点 → 走完这一段，进决策窗；新窗口从读档时刻起算，
 *   而不是 `until + DECISION_MS`，所以离线再久也只多走一段。
 * - deciding 到点 → 按超时折返，不再掷翻车。
 *
 * 返回 `{ run, coins }`（coins 是这一段该入账的钱）；不推进返回 null。
 */
export function resumeRun (run, now) {
  if (!isActiveRun(run) || !Number.isFinite(now)) return null
  if (now < run.until) return null
  if (run.phase === 'walking') {
    const event = advanceRun(run, now)
    return event === null ? null : { run: event.run, coins: event.coins }
  }
  const home = expireRun(run, now)
  return home === null ? null : { run: home, coins: 0 }
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
    ended: run?.ended ?? null,
    reason: ENDED_REASONS.includes(run?.reason) ? run.reason : null
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
    endedAt: active ? null : (Number.isFinite(raw.endedAt) ? raw.endedAt : null),
    reason: active ? null : (ENDED_REASONS.includes(raw.reason) ? raw.reason : null)
  }
}
