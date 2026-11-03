/**
 * 邻居街：桌面上那排小房子读的唯一数据（ticket 20）。
 *
 * 纯函数：喂快照原料，出行；不碰时钟、网络、磁盘。
 * 这里只管「此刻这条街上有谁、他在干什么、我能不能去」，画成什么样是渲染端的事。
 *
 * 一条铁律：`canVisit` 不在这里重新判断。调用方把 `visitTargets` 传进来，
 * 这份名单就永远和「点下去会不会被拒」是同一个判定（`visit-policy.js` 里那套）。
 */

import {
  NEIGHBOR_TTL_MS,
  normalizeAnimation,
  normalizeNickname,
  normalizeSay
} from './protocol.js'

/** 一屏之外还能记住多少户；再多就只是把 DOM 撑大。 */
export const MAX_STREET = 16

/** 掉线的邻居在街上灰着留多久。邻居表 30 秒就清人，灰态靠 recentSeen 记着。 */
export const STALE_KEEP_MS = 10 * 60 * 1000

/** 去不了的理由。`peer-offline` 沿用 visit-copy.js 里同一个词，不另造一个 offline。 */
export const BLOCKED_REASONS = Object.freeze(['not-admitted', 'not-mutual', 'peer-offline'])

const BLOCKED_REASON_SET = new Set(BLOCKED_REASONS)

export function isBlockedReason (value) {
  return typeof value === 'string' && BLOCKED_REASON_SET.has(value)
}

const FALLBACK_NICKNAME = '邻居'

function byDeviceId (list) {
  const by = new Map()
  if (!Array.isArray(list)) return by
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.deviceId !== 'string' || item.deviceId === '') continue
    by.set(item.deviceId, item)
  }
  return by
}

/** 最后见面到现在，还在某个窗口内吗。窗口不同、形状相同，所以只写一份。 */
function within (lastSeen, windowMs, at) {
  return Number.isFinite(lastSeen) && at - lastSeen <= windowMs
}

/**
 * @param {object} input
 * @param {number} [input.now]
 * @param {Array<{deviceId:string,nickname:string}>} [input.targets] 能去的邻居（visitTargets）
 * @param {Array<object>} [input.neighbors] 邻居表（30 秒 TTL）
 * @param {Array<object>} [input.guests] 心跳影子：此刻的动作
 * @param {Array<object>} [input.recentSeen] 10 分钟内的最后一面（带最后知道的 status）
 * @returns {Array<object>} 街上的每一户
 */
export function streetFrom ({
  now = Date.now(),
  targets = [],
  neighbors = [],
  guests = [],
  recentSeen = []
} = {}) {
  const at = Number.isFinite(now) ? now : Date.now()
  const guestBy = byDeviceId(guests)
  const neighborBy = byDeviceId(neighbors)
  const targetBy = byDeviceId(targets)

  // 谁在这条街上：邻居表（最新鲜）+ 最近十分钟见过但已掉出表的。
  const candidates = new Map()
  for (const [deviceId, neighbor] of neighborBy) {
    if (!within(neighbor.lastSeen, STALE_KEEP_MS, at)) continue
    candidates.set(deviceId, {
      nickname: neighbor.nickname,
      lastSeen: neighbor.lastSeen,
      status: neighbor.status
    })
  }
  for (const [deviceId, seen] of byDeviceId(recentSeen)) {
    if (!within(seen.lastSeen, STALE_KEEP_MS, at)) continue
    const existing = candidates.get(deviceId)
    if (existing === undefined) {
      candidates.set(deviceId, {
        nickname: seen.nickname,
        lastSeen: seen.lastSeen,
        status: seen.status
      })
      continue
    }
    if (Number.isFinite(seen.lastSeen) && seen.lastSeen > existing.lastSeen) {
      existing.lastSeen = seen.lastSeen
      if (existing.nickname === undefined) existing.nickname = seen.nickname
    }
  }
  // 目标是权威：万一它还没进任何一张表（放行名单里但没收到广播），也要在街上。
  for (const [deviceId, target] of targetBy) {
    if (!candidates.has(deviceId)) {
      candidates.set(deviceId, { nickname: target.nickname, lastSeen: at, status: 'allowed' })
    }
  }

  const rows = []
  for (const [deviceId, candidate] of candidates) {
    const guest = guestBy.get(deviceId)
    const isTarget = targetBy.has(deviceId)
    const status = candidate.status ?? 'pending'
    rows.push({
      deviceId,
      nickname: normalizeNickname(targetBy.get(deviceId)?.nickname ?? candidate.nickname) ??
        FALLBACK_NICKNAME,
      action: normalizeAnimation(guest?.action),
      say: normalizeSay(guest?.say, at),
      anim: normalizeAnimation(guest?.anim),
      canVisit: isTarget,
      blockedReason: isTarget ? null : blockedReasonFor(status, candidate.lastSeen, at),
      lastSeen: candidate.lastSeen
    })
  }

  // 能去的在前，各自按「最后见面的时刻」倒序；同一时刻用 deviceId 兜底，顺序才可复现。
  rows.sort((left, right) =>
    (Number(right.canVisit) - Number(left.canVisit)) ||
    (right.lastSeen - left.lastSeen) ||
    (left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0))

  return rows.slice(0, MAX_STREET)
}

/**
 * 去不了的三条理由，按顺序判：
 *   还没放行 → 掉线了 → 放行了但它没放行我（或还没证明）。
 * 「掉线」优先于「没互相放行」：人都走了，就别再追问他让不让我进门。
 */
function blockedReasonFor (status, lastSeen, at) {
  if (status !== 'allowed') return 'not-admitted'
  if (!within(lastSeen, NEIGHBOR_TTL_MS, at)) return 'peer-offline'
  return 'not-mutual'
}
