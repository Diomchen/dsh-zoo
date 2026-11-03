import { isDeviceId, isVisitId } from './protocol.js'

/**
 * 入站礼物的频率限额（SPEC v4「存储与限额」，ticket 27）：
 * 同一个邻居 **≤10 件/小时、≤50 件/天**，超了 `refused`（原因 `rate`），
 * 不落盘、也不回执。字条与文件两条接收路径共用这一个门卫。
 *
 * 为什么不用 `protocol.createRateLimiter`：那个只算单个滑动窗口；这里要同时守住
 * 一小时与一天两个窗口，还要把**同一件礼物的重试**认出来。`visit-request` 会重发
 * 三次，如果每次重试都算一件，10 件/小时实际只剩 3 件。
 *
 * 状态只活在本次运行的内存里（与 room 的「扔掉」黑名单同一层）：重启就清空。
 * 只记 deviceId、礼物 id 与时间戳，不记正文、不记文件名。
 */
export const GIFT_RATE_PER_HOUR = 10
export const GIFT_RATE_PER_DAY = 50
export const GIFT_RATE_HOUR_MS = 60 * 60 * 1000
export const GIFT_RATE_DAY_MS = 24 * GIFT_RATE_HOUR_MS
/** 内存里最多同时记多少个邻居；超了挤掉最久没有动静的那个。 */
export const MAX_GIFT_RATE_SOURCES = 256

export function createGiftRateLimiter ({
  perHour = GIFT_RATE_PER_HOUR,
  perDay = GIFT_RATE_PER_DAY,
  maxSources = MAX_GIFT_RATE_SOURCES,
  now = () => Date.now()
} = {}) {
  const hourLimit = Number.isInteger(perHour) && perHour > 0 ? perHour : GIFT_RATE_PER_HOUR
  const dayLimit = Number.isInteger(perDay) && perDay > 0 ? perDay : GIFT_RATE_PER_DAY
  const sourceCap = Number.isInteger(maxSources) && maxSources > 0 ? maxSources : MAX_GIFT_RATE_SOURCES
  /** deviceId → { accepted: number[], seen: Map<giftId, number>, last: number }。 */
  const buckets = new Map()

  function bucketOf (deviceId, at) {
    let bucket = buckets.get(deviceId)
    if (bucket !== undefined) return bucket
    if (buckets.size >= sourceCap) {
      let oldestKey
      let oldestAt = Infinity
      for (const [key, candidate] of buckets) {
        if (candidate.last < oldestAt) {
          oldestAt = candidate.last
          oldestKey = key
        }
      }
      if (oldestKey !== undefined) buckets.delete(oldestKey)
    }
    bucket = { accepted: [], seen: new Map(), last: at }
    buckets.set(deviceId, bucket)
    return bucket
  }

  function prune (bucket, at) {
    const dayCutoff = at - GIFT_RATE_DAY_MS
    while (bucket.accepted.length > 0 && bucket.accepted[0] <= dayCutoff) bucket.accepted.shift()
    // seen 按插入时间有序；过了一天之后再出现同一个 giftId 就当一件新礼物重新计数。
    for (const [giftId, stamp] of bucket.seen) {
      if (stamp > dayCutoff) break
      bucket.seen.delete(giftId)
    }
  }

  return {
    /**
     * 放行一件礼物。返回 false = 这个邻居这一小时/这一天的额度用完了。
     *
     * 同一件礼物（同一 giftId）**重试不重复计数**，且在被拒期间也保持拒绝：
     * 调用方拿到 false 后只需要把卡片标成 `refused/rate`，不必自己记住“这件问过没有”。
     */
    allow (rawDeviceId, rawGiftId, at = now()) {
      if (!isDeviceId(rawDeviceId) || !isVisitId(rawGiftId)) return false
      const deviceId = rawDeviceId.toLowerCase()
      const giftId = rawGiftId.toLowerCase()
      const stamp = Number.isFinite(at) ? at : now()
      const bucket = bucketOf(deviceId, stamp)
      bucket.last = stamp
      prune(bucket, stamp)
      if (bucket.seen.has(giftId)) return true
      const hourCutoff = stamp - GIFT_RATE_HOUR_MS
      let hourCount = 0
      for (const acceptedAt of bucket.accepted) {
        if (acceptedAt > hourCutoff) hourCount += 1
      }
      if (hourCount >= hourLimit || bucket.accepted.length >= dayLimit) return false
      bucket.accepted.push(stamp)
      bucket.seen.set(giftId, stamp)
      return true
    },
    size () {
      return buckets.size
    },
    clear () {
      buckets.clear()
    }
  }
}
