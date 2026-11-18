/**
 * 盘口 LAN 真人资金流（SPEC v12 / 票 107）：纯规则。
 *
 * 这一层不读时钟、不碰磁盘、不联网：一条事件只由 `(deviceId, at, crop, action, side, notional, source)`
 * 描述，影响由 `impactOf()` 现算；同一组事件在任何机器得到同一个资金流水平。
 *
 * 三条产品约束写死在这里：
 *   1. 单笔冲击 = `K × dir × sqrt(notional / UNIT)`，封顶 0.6%；
 *   2. 资金流水平按 **2 小时半衰期** 衰减，每作物累计夹在 ±1.5%；
 *   3. 冲击不能自套：成交价含一半自身冲击（在 `trading.js` 里），
 *      且单设备单根/单日有上限，`mergeFlowEvents()` 会在接收端再算一遍，不信发送端。
 *
 * 「事件带」是最终一致的：正常 1–2 秒内所有机器看到同一笔流水；迟到/丢包靠
 * `board-flow-sync` 补。A 期没有这一层，B 期才接（ADR-0038）。
 */

export const FLOW_K = 0.003
/** 冲击公式的参考名义：500 币 → 0.30%。 */
export const FLOW_UNIT = 500
/** 计入冲击的名义上限：再大的单也只按 5,000 算。 */
export const FLOW_MAX_NOTIONAL = 5000
/** 单笔冲击上限：±0.6%。 */
export const FLOW_MAX_SINGLE = 0.006
/** 资金流半衰期（分钟）：2 小时。 */
export const FLOW_HALF_LIFE_MINUTES = 120
/** 每作物资金流水平上限：±1.5%。 */
export const FLOW_MAX_LEVEL = 0.015
/** 单设备单根（同一作物）累计 |u| 上限：1.2%。 */
export const FLOW_SLOT_CAP = 0.012
/** 单设备单日（跨作物）累计 |u| 上限：4%。 */
export const FLOW_DAY_CAP = 0.04
/** 实时事件只接受这个窗口内的 `at`（毫秒）：太老会回头改历史 K 线。 */
export const FLOW_LIVE_WINDOW_MS = 15 * 1000
/** 同步事件允许回溯 24 小时；更老的折进本地水平，不再逐条保留。 */
export const FLOW_SYNC_WINDOW_MS = 24 * 60 * 60 * 1000
/** 事件带最多留 500 条（24 小时量级）。 */
export const FLOW_MAX_TAPE = 500
/** 一包最多 16 条；协议层另有 4 KiB 上限。 */
export const FLOW_MAX_BATCH = 16
/** 一次同步最多回 64 条（分 4 包发）；再老的已经衰减到看不见。 */
export const FLOW_SYNC_MAX = 64
/** 单设备限速：6 条/分钟、40 条/根。 */
export const FLOW_RATE_PER_MINUTE = 6
export const FLOW_RATE_PER_SLOT = 40
export const FLOW_SLOT_MS = 15 * 60 * 1000
export const FLOW_MINUTE_MS = 60 * 1000
const FLOW_DAY_MS = 24 * 60 * 60 * 1000
/** 市场时间固定 UTC+8：与 `board-news.js` 同一条，日上限按市场日算。 */
const FLOW_TZ_OFFSET_MS = 8 * 60 * 60 * 1000
const FLOW_ACTIONS = Object.freeze(['open', 'close'])
const FLOW_REASONS = Object.freeze(['manual', 'settle', 'liquidate', 'stop'])
const FLOW_SOURCES = Object.freeze(['board', 'futures', 'farm'])
/** 跨系统来源的权重：B 期只有 board；C 期再接期货/农场。 */
const SOURCE_WEIGHT = Object.freeze({ board: 1, futures: 0.5, farm: 0.25 })

function finiteNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function clampNumber (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** 开多/平空 = 买（+1）；开空/平多 = 卖（−1）。方向只由 `action + side` 决定，不信发送端。 */
export function flowDirectionOf ({ action, side } = {}) {
  if (!FLOW_ACTIONS.includes(action) || (side !== 'long' && side !== 'short')) return 0
  if (action === 'open') return side === 'long' ? 1 : -1
  return side === 'long' ? -1 : 1
}

/**
 * 单笔资金流冲击（对数价格）：`0.003 × dir × sqrt(min(notional,5000)/500) × sourceWeight`，
 * 再夹到 ±0.6%。参数坏掉返回 0——资金流不该因为一条坏事件变成 NaN。
 */
export function impactOf ({ action, side, notional, source = 'board' } = {}) {
  const direction = flowDirectionOf({ action, side })
  const amount = finiteNumber(notional)
  if (direction === 0 || amount === null || amount <= 0) return 0
  const weight = SOURCE_WEIGHT[source] ?? SOURCE_WEIGHT.board
  const capped = Math.min(amount, FLOW_MAX_NOTIONAL)
  const raw = FLOW_K * direction * Math.sqrt(capped / FLOW_UNIT) * weight
  return clampNumber(raw, -FLOW_MAX_SINGLE, FLOW_MAX_SINGLE)
}

/** 事件的分钟桶：资金流按 1 分钟格点落价，和 K 线/结算同一条时间轴。 */
export function flowMinuteOf (at) {
  const stamp = finiteNumber(at)
  return stamp === null ? null : Math.floor(stamp / FLOW_MINUTE_MS)
}

/** 事件的市场日序号（UTC+8）：单设备单日上限用。 */
export function flowDayOf (at) {
  const stamp = finiteNumber(at)
  return stamp === null ? null : Math.floor((stamp + FLOW_TZ_OFFSET_MS) / FLOW_DAY_MS)
}

function isCropId (value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value)
}

function isDeviceId (value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

/**
 * 一条资金流事件的白名单归一化：坏一条返回 null，不抛。
 * `id` 由发送端生成（本机是 `${deviceId}:${seq}`），接收端只用来去重，不解析含义。
 */
export function normalizeFlowEvent (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const id = typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128 ? value.id : null
  const deviceId = isDeviceId(value.deviceId) ? value.deviceId : null
  const at = finiteNumber(value.at)
  const crop = isCropId(value.crop) ? value.crop : null
  const action = FLOW_ACTIONS.includes(value.action) ? value.action : null
  const side = value.side === 'long' || value.side === 'short' ? value.side : null
  const notional = finiteNumber(value.notional)
  if (id === null || deviceId === null || at === null || at <= 0 || crop === null || action === null || side === null) return null
  if (notional === null || notional <= 0 || notional > 1_000_000) return null
  const reason = FLOW_REASONS.includes(value.reason) ? value.reason : 'manual'
  const source = FLOW_SOURCES.includes(value.source) ? value.source : 'board'
  return {
    id,
    deviceId,
    at: Math.round(at),
    crop,
    action,
    side,
    reason,
    notional: Math.round(notional),
    source
  }
}

/** 事件在 `minute` 时的剩余权重：2 小时半衰期。 */
function decayOf (eventMinute, minute) {
  const age = minute - eventMinute
  if (age < 0) return 0
  return Math.pow(0.5, age / FLOW_HALF_LIFE_MINUTES)
}

/**
 * 某作物在 `minute`（绝对分钟）的资金流水平 `F`，夹在 ±1.5%。
 * `events` 只需要是 `normalizeFlowEvent()` 的数组；按时间乱序也能算，但通常已排序。
 */
export function flowLevelAt ({ events, crop, minute } = {}) {
  if (!Array.isArray(events) || typeof crop !== 'string') return 0
  const value = finiteNumber(minute)
  if (value === null) return 0
  const target = Math.floor(value)
  let level = 0
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (event.crop !== crop) continue
    const eventMinute = flowMinuteOf(event.at)
    if (eventMinute === null || eventMinute > target) continue
    level += impactOf(event) * decayOf(eventMinute, target)
  }
  return clampNumber(level, -FLOW_MAX_LEVEL, FLOW_MAX_LEVEL)
}

/**
 * 一条新事件在现有水平上的**有效贡献**：`clamp(level + u) - level`。
 * 资金流水平撞到 ±1.5% 时，新事件只补到帽子上；发送端和接收端用同一条规则。
 */
export function effectiveImpactOf ({ events, crop, minute, event } = {}) {
  if (event === null || typeof event !== 'object') return 0
  const before = flowLevelAt({ events, crop, minute })
  const raw = impactOf(event)
  if (raw === 0) return 0
  const after = clampNumber(before + raw, -FLOW_MAX_LEVEL, FLOW_MAX_LEVEL)
  return after - before
}

function absImpactOf (event) {
  return Math.abs(impactOf(event))
}

function eventsOfDevice (tape, deviceId) {
  return tape.filter((event) => event !== null && typeof event === 'object' && event.deviceId === deviceId)
}

/** 单设备在 `[from, to)` 内的累计 |u|（可按作物过滤）；上限检查用。 */
export function deviceImpactBetween (tape, deviceId, from, to, crop = null) {
  const start = finiteNumber(from)
  const end = finiteNumber(to)
  if (!Array.isArray(tape) || typeof deviceId !== 'string' || start === null || end === null) return 0
  let total = 0
  for (const event of eventsOfDevice(tape, deviceId)) {
    if (event.at < start || event.at >= end) continue
    if (crop !== null && event.crop !== crop) continue
    total += absImpactOf(event)
  }
  return total
}

/** 事件所属的 slot 起点（毫秒）：单设备单根上限用。 */
export function flowSlotOf (at) {
  const stamp = finiteNumber(at)
  return stamp === null ? null : Math.floor(stamp / FLOW_SLOT_MS)
}

function rateAllows (tape, deviceId, at) {
  const minuteStart = Math.floor(at / FLOW_MINUTE_MS) * FLOW_MINUTE_MS
  const slotStart = Math.floor(at / FLOW_SLOT_MS) * FLOW_SLOT_MS
  let minuteCount = 0
  let slotCount = 0
  for (const event of eventsOfDevice(tape, deviceId)) {
    if (event.at >= minuteStart && event.at < minuteStart + FLOW_MINUTE_MS) minuteCount += 1
    if (event.at >= slotStart && event.at < slotStart + FLOW_SLOT_MS) slotCount += 1
  }
  return minuteCount < FLOW_RATE_PER_MINUTE && slotCount < FLOW_RATE_PER_SLOT
}

function tooOldForLive (event, now) {
  return event.at < now - FLOW_LIVE_WINDOW_MS || event.at > now + 5 * 1000
}

/**
 * 合并一批事件（接收端/同步共用）：
 *   - 白名单归一化，坏一条丢一条；
 *   - 按 id 去重；
 *   - `live` 只收 `[now−15s, now+5s]`；`sync` 允许 24 小时内；
 *   - 单设备限速、单根/单日 |u| 上限超了就丢这一条（不阻塞别的）；
 *   - 只留最近 24 小时、最多 `FLOW_MAX_TAPE` 条。
 *
 * 返回新数组（不原地改 tape）；`accepted` 是真正收下的归一化事件，调用方据此广播/重画。
 */
export function mergeFlowEvents ({ tape = [], incoming = [], now, mode = 'live' } = {}) {
  const stamp = finiteNumber(now)
  if (stamp === null) return { tape: cloneTape(tape), accepted: [], rejected: 0 }
  const base = cloneTape(tape)
  const seen = new Set(base.map((event) => event.id))
  const accepted = []
  let rejected = 0
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const event = normalizeFlowEvent(raw)
    if (event === null || seen.has(event.id)) {
      rejected += 1
      continue
    }
    // 未来时间两种模式都不收：否则一条「明天的流水」会提前埋进价格。
    if (event.at > stamp + 5 * 1000) {
      rejected += 1
      continue
    }
    if (mode === 'live' && tooOldForLive(event, stamp)) {
      rejected += 1
      continue
    }
    if (event.at < stamp - FLOW_SYNC_WINDOW_MS) {
      rejected += 1
      continue
    }
    // 限速只管实时流；同步补历史时一次几十条是正常的。
    if (mode !== 'sync' && !rateAllows(base.concat(accepted), event.deviceId, event.at)) {
      rejected += 1
      continue
    }
    const slotStart = flowSlotOf(event.at)
    const slotImpact = deviceImpactBetween(base.concat(accepted), event.deviceId,
      slotStart * FLOW_SLOT_MS, (slotStart + 1) * FLOW_SLOT_MS, event.crop)
    if (slotImpact + absImpactOf(event) > FLOW_SLOT_CAP) {
      rejected += 1
      continue
    }
    const day = flowDayOf(event.at)
    const dayStart = day * FLOW_DAY_MS - FLOW_TZ_OFFSET_MS
    const dayImpact = deviceImpactBetween(base.concat(accepted), event.deviceId,
      dayStart, dayStart + FLOW_DAY_MS)
    if (dayImpact + absImpactOf(event) > FLOW_DAY_CAP) {
      rejected += 1
      continue
    }
    seen.add(event.id)
    accepted.push(event)
  }
  const merged = pruneTape(base.concat(accepted), stamp)
  return { tape: merged, accepted, rejected }
}

/** 保留最近 24 小时，最多 `FLOW_MAX_TAPE` 条；按时间正序。 */
export function pruneTape (tape, now) {
  const stamp = finiteNumber(now)
  const floor = stamp === null ? null : stamp - FLOW_SYNC_WINDOW_MS
  const kept = []
  for (const event of Array.isArray(tape) ? tape : []) {
    if (event === null || typeof event !== 'object') continue
    if (floor !== null && event.at < floor) continue
    kept.push(event)
  }
  kept.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
  return kept.length > FLOW_MAX_TAPE ? kept.slice(kept.length - FLOW_MAX_TAPE) : kept
}

function cloneTape (tape) {
  return Array.isArray(tape) ? tape.slice() : []
}

/** 同步请求的响应：`since` 之后的事件，最多 `limit` 条（默认 16）。 */
export function flowEventsSince ({ tape, since, limit = FLOW_MAX_BATCH, crop = null } = {}) {
  const start = finiteNumber(since) ?? 0
  const max = Number.isInteger(limit) ? Math.max(1, Math.min(FLOW_SYNC_MAX, limit)) : FLOW_MAX_BATCH
  const rows = []
  for (const event of Array.isArray(tape) ? tape : []) {
    if (event === null || typeof event !== 'object') continue
    if (event.at < start) continue
    if (crop !== null && event.crop !== crop) continue
    rows.push(event)
  }
  rows.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
  return rows.slice(0, max)
}

/** 窗口展示：某作物在 `[from, to)` 的资金流事件（最新在前，最多 limit 条）。 */
export function flowEventsForView ({ tape, crop, from, to, limit = 20 } = {}) {
  const start = finiteNumber(from)
  const end = finiteNumber(to)
  const max = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20
  if (!Array.isArray(tape) || typeof crop !== 'string' || start === null || end === null) return []
  const rows = []
  for (const event of tape) {
    if (event === null || typeof event !== 'object') continue
    if (event.crop !== crop || event.at < start || event.at >= end) continue
    rows.push(event)
  }
  rows.sort((left, right) => right.at - left.at || right.id.localeCompare(left.id))
  return rows.slice(0, max)
}

/** 本根净流（Σu，不衰减）：窗口「资金流 +0.42%」用。 */
export function flowNetBetween ({ tape, crop, from, to } = {}) {
  const start = finiteNumber(from)
  const end = finiteNumber(to)
  if (!Array.isArray(tape) || typeof crop !== 'string' || start === null || end === null) return 0
  let total = 0
  for (const event of tape) {
    if (event === null || typeof event !== 'object') continue
    if (event.crop !== crop || event.at < start || event.at >= end) continue
    total += impactOf(event)
  }
  return total
}

/** 单设备在某根里的有效冲击（给 `trading.js` 判断「本根影响力是否用尽」）。 */
export function deviceSlotImpact ({ tape, deviceId, crop, at } = {}) {
  const slot = flowSlotOf(at)
  if (slot === null) return 0
  return deviceImpactBetween(tape, deviceId, slot * FLOW_SLOT_MS, (slot + 1) * FLOW_SLOT_MS, crop)
}

/** 展示用：把一条事件压成窗口需要的字段（名字由 service 补）。 */
export function flowEventView (event) {
  if (event === null || typeof event !== 'object') return null
  const impact = impactOf(event)
  return {
    id: event.id,
    at: event.at,
    deviceId: event.deviceId,
    action: event.action,
    side: event.side,
    reason: event.reason,
    notional: event.notional,
    source: event.source,
    impact
  }
}
