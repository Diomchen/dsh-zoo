import { NEIGHBOR_TTL_MS, normalizeNickname } from './protocol.js'

/**
 * 宠物「自己出门」的**纯**策略：喂它现在的时间、本机活动、上次出门时间和邻居表，
 * 它告诉你「去不去、去谁家、为什么不去」。
 *
 * 这一层没有时钟、没有 socket、没有磁盘，也没有随机源：所有输入都由调用方给，
 * `random` 也只是注入的函数。room 负责保存状态，service 负责执行动作。
 *
 * 四条闸门必须**同时**满足（SPEC v2 / ADR-0006）：
 *   1. switch：总开关打开（默认关，持久化在 settings.json）
 *   2. activity：本机最近 10 分钟有活动（session/event 优先，桌面指针兜底）
 *   3. cooldown：距上次出门 ≥ 15 分钟（从「开始出门」算，含请求中）
 *   4. neighbor：随机挑中的邻居在线且已放行我
 *
 * 另外，宠物已经在外面时不会再出门（already-out）；这不是第四条之外的第五条闸门，
 * 而是一次串门本来就只有一个 `self.out`。
 */

/** 本机活动窗口：10 分钟没有活动，宠物就不会自己出门。 */
export const ACTIVITY_WINDOW_MS = 10 * 60 * 1000
/** 两次自发出门之间的最短间隔；手动出门也计入这个冷却。 */
export const DEPARTURE_COOLDOWN_MS = 15 * 60 * 1000

/** 策略结果的 reason 是固定枚举，客户端/日志可以依赖它。 */
export const VISIT_POLICY_REASONS = Object.freeze([
  'disabled',
  'already-out',
  'no-activity',
  'cooldown',
  'no-neighbor',
  'ready'
])

const REASON_SET = new Set(VISIT_POLICY_REASONS)
const MAX_DEVICE_ID = 64

function ageOf (now, then) {
  if (!Number.isFinite(then)) return null
  return Math.max(0, now - then)
}

/**
 * 从 room 快照的邻居表里挑出「可以出门去找」的邻居：**我也放行了它**（status allowed）
 * 且**它放行了我**（收到过它的心跳，heartbeatAt 新鲜）且在线（lastSeen 新鲜）。
 *
 * 心跳只发给发送方自己的放行名单，所以“收到心跳”就是“对方放行了我”的本地证据；
 * 光有广播只能证明它在线。这份表是策略与手动「串门」共用的唯一筛选规则。
 *
 * @param {Array<{deviceId?:string,nickname?:string,status?:string,lastSeen?:number,heartbeatAt?:number}>} neighbors
 * @param {{now?:number, neighborTtlMs?:number}} [options]
 * @returns {Array<{deviceId:string,nickname:string}>}
 */
export function eligibleVisitTargets (neighbors, { now = Date.now(), neighborTtlMs = NEIGHBOR_TTL_MS } = {}) {
  const at = Number.isFinite(now) ? now : Date.now()
  const ttl = Number.isFinite(neighborTtlMs) && neighborTtlMs > 0 ? neighborTtlMs : NEIGHBOR_TTL_MS
  const targets = []
  const seen = new Set()
  if (!Array.isArray(neighbors)) return targets

  for (const neighbor of neighbors) {
    if (neighbor === null || typeof neighbor !== 'object') continue
    if (neighbor.status !== 'allowed') continue
    if (typeof neighbor.deviceId !== 'string') continue
    const deviceId = neighbor.deviceId.trim()
    if (deviceId === '' || deviceId.length > MAX_DEVICE_ID || seen.has(deviceId)) continue

    // 没有 lastSeen 或已经过了邻居 TTL 的，不算在线：不把宠物派去一个没人应答的地方。
    if (!Number.isFinite(neighbor.lastSeen)) continue
    if (at - neighbor.lastSeen > ttl) continue

    // 没有心跳 = 对方没有放行我（或已经失联）：不能把请求送过去等一句 deny。
    if (!Number.isFinite(neighbor.heartbeatAt)) continue
    if (at - neighbor.heartbeatAt > ttl) continue

    seen.add(deviceId)
    targets.push({
      deviceId,
      nickname: normalizeNickname(neighbor.nickname) ?? '邻居'
    })
  }
  return targets
}

function pickIndex (length, random) {
  if (length <= 0) return -1
  let value = 0
  try {
    const raw = random()
    if (Number.isFinite(raw)) value = raw
  } catch {
    value = 0
  }
  // random() 约定是 [0,1)；坏实现（1、负数、NaN）也夹回合法范围，绝不返回 undefined。
  const normalized = Math.min(Math.max(value, 0), 0.999999999999)
  return Math.floor(normalized * length)
}

/** 手动「串门」用：从在线且互相放行的邻居里随机挑一位；没有就返回 null。 */
export function pickVisitTarget (neighbors, {
  now = Date.now(),
  neighborTtlMs = NEIGHBOR_TTL_MS,
  random = Math.random
} = {}) {
  const targets = eligibleVisitTargets(neighbors, { now, neighborTtlMs })
  const index = pickIndex(targets.length, random)
  return index < 0 ? null : targets[index]
}

/**
 * 四条闸门 + 「已经在外面」的唯一判定。
 *
 * @param {object} input
 * @param {number} [input.now] 判定时刻（ms）
 * @param {boolean} [input.enabled] 总开关；只有 true 才可能出门
 * @param {number|null} [input.lastActivityAt] 最近一次本机活动（session 或指针）
 * @param {number|null} [input.lastDepartureAt] 最近一次开始出门
 * @param {Array<object>} [input.neighbors] room 邻居表（含 status/lastSeen/heartbeatAt）
 * @param {number} [input.neighborTtlMs] 邻居在线判定窗口
 * @param {boolean} [input.alreadyOut] 是否已有一次出门（请求中/已抵达）
 * @param {() => number} [input.random] 随机源，测试可注入
 * @returns {{
 *   go: boolean,
 *   reason: string,
 *   gate: 'switch'|'out'|'activity'|'cooldown'|'neighbor'|null,
 *   candidate: {deviceId:string,nickname:string}|null,
 *   candidates: number,
 *   activityAgeMs: number|null,
 *   sinceDepartureMs: number|null
 * }}
 */
export function planSpontaneousVisit ({
  now = Date.now(),
  enabled = false,
  lastActivityAt = null,
  lastDepartureAt = null,
  neighbors = [],
  neighborTtlMs = NEIGHBOR_TTL_MS,
  alreadyOut = false,
  random = Math.random
} = {}) {
  const at = Number.isFinite(now) ? now : Date.now()
  const activityAgeMs = ageOf(at, lastActivityAt)
  const sinceDepartureMs = ageOf(at, lastDepartureAt)
  const targets = eligibleVisitTargets(neighbors, { now: at, neighborTtlMs })

  const result = {
    go: false,
    reason: 'disabled',
    gate: 'switch',
    candidate: null,
    candidates: targets.length,
    activityAgeMs,
    sinceDepartureMs
  }

  // 顺序就是排障时的优先级：先看最外层的开关，再看宠物在不在家。
  if (enabled !== true) return result
  if (alreadyOut === true) return { ...result, reason: 'already-out', gate: 'out' }
  if (activityAgeMs === null || activityAgeMs > ACTIVITY_WINDOW_MS) {
    return { ...result, reason: 'no-activity', gate: 'activity' }
  }
  if (sinceDepartureMs !== null && sinceDepartureMs < DEPARTURE_COOLDOWN_MS) {
    return { ...result, reason: 'cooldown', gate: 'cooldown' }
  }
  if (targets.length === 0) {
    return { ...result, reason: 'no-neighbor', gate: 'neighbor' }
  }

  const index = pickIndex(targets.length, random)
  return {
    ...result,
    go: true,
    reason: 'ready',
    gate: null,
    candidate: targets[index]
  }
}

/** 只是给调用方一个便宜的合法性检查，避免快照里出现未知 reason。 */
export function isVisitPolicyReason (value) {
  return typeof value === 'string' && REASON_SET.has(value)
}
