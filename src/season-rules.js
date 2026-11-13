/**
 * 季节纯规则（票 63）：1 个本地自然日 = 1 季，4 天一轮。
 *
 * 这一层不读盘、不碰 `farm.json`，时间只从参数进来。季节不存进存档：
 * 今天是什么季完全由本地日期算出来，所以改系统时间/换时区会换季，
 * 但老存档不会因为升级而错位。持久化的只有节日进度和来客（票 65/67）。
 */

export const MINUTE_MS = 60 * 1000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

export const SEASON_ORDER = Object.freeze(['spring', 'summer', 'autumn', 'winter'])

export const SEASONS = Object.freeze({
  spring: Object.freeze({ id: 'spring', name: '春', emoji: '🌱' }),
  summer: Object.freeze({ id: 'summer', name: '夏', emoji: '☀️' }),
  autumn: Object.freeze({ id: 'autumn', name: '秋', emoji: '🍂' }),
  winter: Object.freeze({ id: 'winter', name: '冬', emoji: '❄️' })
})

/** 锚点：2026-10-26 是春的第一天（本地日）。 */
export const SEASON_ANCHOR = '2026-10-26'

const ANCHOR_PARTS = SEASON_ANCHOR.split('-').map(Number)
const ANCHOR_UTC = Date.UTC(ANCHOR_PARTS[0], ANCHOR_PARTS[1] - 1, ANCHOR_PARTS[2])

/** 一次最多切 64 段；离线很久时只保留最后 64 段（农场只补 12 小时，够用）。 */
export const MAX_SEASON_SEGMENTS = 64

/** 四种四季作物只认内置 id；运行时目录里的自定义作物一律中性。 */
export const SEASONAL_CROPS = Object.freeze({
  pea: 'spring',
  watermelon: 'summer',
  rice: 'autumn',
  radish: 'winter'
})

/**
 * 节日表：每天一个，全天有效，本地 00:00 结束。
 * `requirement.kind` 与 `season-store.note()` 的 kind 一一对应。
 */
export const SEASON_EVENTS = Object.freeze({
  spring: Object.freeze({
    id: 'spring-sow',
    name: '播种节',
    season: 'spring',
    requirement: Object.freeze({ kind: 'plant', qty: 8 }),
    reward: Object.freeze({ coins: 30, dew: 3 })
  }),
  summer: Object.freeze({
    id: 'summer-market',
    name: '夜市',
    season: 'summer',
    requirement: Object.freeze({ kind: 'sell', qty: 8 }),
    reward: Object.freeze({ coins: 40, dew: 3 })
  }),
  autumn: Object.freeze({
    id: 'autumn-harvest',
    name: '丰收祭',
    season: 'autumn',
    requirement: Object.freeze({ kind: 'harvest', qty: 15 }),
    reward: Object.freeze({ coins: 50, dew: 4 })
  }),
  winter: Object.freeze({
    id: 'winter-hearth',
    name: '围炉节',
    season: 'winter',
    requirement: Object.freeze({ kind: 'water', qty: 5 }),
    reward: Object.freeze({ coins: 35, dew: 6 })
  })
})

function pad (value, width = 2) {
  return String(value).padStart(width, '0')
}

function asDate (at) {
  const date = at instanceof Date ? new Date(at.getTime()) : new Date(Number(at))
  return Number.isNaN(date.getTime()) ? null : date
}

/** 本地日 key `YYYY-MM-DD`；`season.json` 的 `start` 也用它。 */
export function seasonDayKey (at) {
  const date = asDate(at)
  if (date === null) return null
  return String(date.getFullYear()).padStart(4, '0') + '-' +
    pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

/** 本地 00:00 的 Date。用日期分量构造，跨 DST 也落在当天零点。 */
function localMidnight (at) {
  const date = asDate(at)
  if (date === null) return null
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/**
 * 当前季：`{ id, name, emoji, start, end, remainingMs }`。
 * `start` / `end` 是本地 00:00 的毫秒时间戳；不返回 `day` / `daysLeft`。
 */
export function seasonAt (now) {
  const date = asDate(now)
  if (date === null) return null
  const startDate = localMidnight(date)
  const endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 1)
  const dayKeyUtc = Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate())
  const days = Math.round((dayKeyUtc - ANCHOR_UTC) / DAY_MS)
  const index = ((days % SEASON_ORDER.length) + SEASON_ORDER.length) % SEASON_ORDER.length
  const id = SEASON_ORDER[index]
  const meta = SEASONS[id]
  return {
    id,
    name: meta.name,
    emoji: meta.emoji,
    start: startDate.getTime(),
    end: endDate.getTime(),
    remainingMs: Math.max(0, endDate.getTime() - date.getTime())
  }
}

/**
 * 把 [from, to) 切成交替的季节段，返回 `[{ season, start, end, ms }]`，按时间正序。
 * `season` 是季节 id（不是对象），方便农场直接取生长系数。
 *
 * 从 `to` 往回切，最多 64 段，所以超长区间天然只保留最后 64 段；不需要先算天数。
 * 跨 DST 时每段长度可能不是整 24 小时，但 `start`/`end` 都是真实时间戳。
 */
export function seasonSegments (from, to) {
  const startMs = Number(from)
  const endMs = Number(to)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return []

  const segments = []
  let cursor = endMs
  while (cursor > startMs && segments.length < MAX_SEASON_SEGMENTS) {
    const current = seasonAt(cursor - 1)
    if (current === null) break
    const segmentStart = Math.max(startMs, current.start)
    if (cursor > segmentStart) {
      segments.push({
        season: current.id,
        start: segmentStart,
        end: cursor,
        ms: cursor - segmentStart
      })
    }
    if (segmentStart <= startMs) break
    cursor = segmentStart
  }

  segments.reverse()
  return segments
}

/** 四季作物的季节；旧六种/自定义作物返回 null。 */
export function cropSeason (cropId) {
  return typeof cropId === 'string' &&
    Object.prototype.hasOwnProperty.call(SEASONAL_CROPS, cropId)
    ? SEASONAL_CROPS[cropId]
    : null
}

export function isSeasonalCrop (cropId) {
  return cropSeason(cropId) !== null
}

/** 当季四季作物 +10%，其余（含旧六种、自定义作物、错误季）为 1。 */
export function seasonGrowthFactor (cropId, seasonId) {
  return cropSeason(cropId) !== null && cropSeason(cropId) === seasonId ? 1.1 : 1
}

/**
 * 四格日历：`today` 是当前季，`past` 是本轮已经过去的季。
 * 无效季节返回四格但全部 false（UI 不会因此崩）。
 */
export function calendarFor (seasonId) {
  const currentIndex = SEASON_ORDER.indexOf(seasonId)
  return SEASON_ORDER.map((id, index) => {
    const meta = SEASONS[id]
    const event = SEASON_EVENTS[id]
    return {
      id,
      name: meta.name,
      emoji: meta.emoji,
      today: currentIndex >= 0 && index === currentIndex,
      past: currentIndex >= 0 && index < currentIndex,
      festival: event.name
    }
  })
}

/** 当季节日；无效季节返回 null。 */
export function eventFor (seasonId) {
  return Object.prototype.hasOwnProperty.call(SEASON_EVENTS, seasonId)
    ? SEASON_EVENTS[seasonId]
    : null
}
