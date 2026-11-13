/**
 * 票 63：季节纯规则（`src/season-rules.js`）。
 *
 * 全部用本地日期构造用例；不依赖真实当前时间，也不 sleep。
 * 重点：锚点、4 天循环、本地午夜、跨月/跨年/闰年、区间切段、四季作物映射。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HOUR_MS,
  MINUTE_MS,
  SEASON_ANCHOR,
  SEASON_ORDER,
  SEASONS,
  SEASON_EVENTS,
  SEASONAL_CROPS,
  calendarFor,
  cropSeason,
  eventFor,
  isSeasonalCrop,
  seasonAt,
  seasonDayKey,
  seasonGrowthFactor,
  seasonSegments
} from '../src/season-rules.js'

function local (year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

// ---------------------------------------------------------------------------
// 锚点与 4 天循环
// ---------------------------------------------------------------------------

test('锚点：2026-10-26 是春，之后夏/秋/冬/春', () => {
  assert.equal(SEASON_ANCHOR, '2026-10-26')
  const expected = ['spring', 'summer', 'autumn', 'winter', 'spring']
  for (let index = 0; index < expected.length; index++) {
    const day = new Date(2026, 9, 26 + index, 12, 0, 0, 0)
    const season = seasonAt(day)
    assert.equal(season.id, expected[index], seasonDayKey(day))
    assert.equal(season.name, SEASONS[expected[index]].name)
    assert.equal(season.emoji, SEASONS[expected[index]].emoji)
  }
})

test('2026-11-13 是秋，11-14 00:00 变冬；本地午夜切日', () => {
  const lateAutumn = seasonAt(local(2026, 11, 13, 23, 59))
  assert.equal(lateAutumn.id, 'autumn')
  assert.ok(
    Math.abs(lateAutumn.remainingMs - MINUTE_MS) < 2 * MINUTE_MS,
    '23:59 距换季应约 1 分钟，实际 ' + lateAutumn.remainingMs
  )

  const winterStart = local(2026, 11, 14, 0, 0)
  const winter = seasonAt(winterStart)
  assert.equal(winter.id, 'winter')
  assert.equal(winter.start, winterStart, 'start 必须是本地 00:00')
  assert.equal(winter.remainingMs, winter.end - winterStart)
  assert.equal(seasonDayKey(winterStart), '2026-11-14')

  // start 是当天 00:00，不是"当前时刻"。
  const afternoon = seasonAt(local(2026, 11, 14, 15, 30))
  assert.equal(afternoon.start, winterStart)
  assert.equal(afternoon.end, new Date(2026, 10, 15, 0, 0, 0, 0).getTime())
  assert.equal(afternoon.remainingMs, afternoon.end - local(2026, 11, 14, 15, 30))
})

test('跨月：10-31 夏、11-01 秋、11-02 冬', () => {
  assert.equal(seasonAt(local(2026, 10, 31)).id, 'summer')
  assert.equal(seasonAt(local(2026, 11, 1)).id, 'autumn')
  assert.equal(seasonAt(local(2026, 11, 2)).id, 'winter')
})

test('跨年：2026-12-31 秋、2027-01-01 冬、2027-01-02 春', () => {
  assert.equal(seasonAt(local(2026, 12, 31)).id, 'autumn')
  assert.equal(seasonAt(local(2027, 1, 1)).id, 'winter')
  assert.equal(seasonAt(local(2027, 1, 2)).id, 'spring')
})

test('闰年：2/28、2/29、3/1 连续三天各进一季', () => {
  const days = [
    local(2028, 2, 28),
    local(2028, 2, 29),
    local(2028, 3, 1)
  ]
  const ids = days.map((day) => seasonAt(day).id)
  assert.equal(new Set(ids).size, 3, '连续三天应跨三季')
  const indexes = ids.map((id) => SEASON_ORDER.indexOf(id))
  assert.deepEqual(indexes, [0, 1, 2].map((offset) => (indexes[0] + offset) % 4))
  assert.equal(seasonDayKey(days[1]), '2028-02-29')
})

test('无效时间返回 null，不抛', () => {
  assert.equal(seasonAt('not-a-date'), null)
  assert.equal(seasonAt(undefined), null)
  assert.equal(seasonAt(new Date(NaN)), null)
  assert.equal(seasonDayKey('not-a-date'), null)
})

// ---------------------------------------------------------------------------
// 区间切段
// ---------------------------------------------------------------------------

test('seasonSegments：22:00 到次日 02:00 切成秋/冬两段', () => {
  const from = local(2026, 11, 13, 22, 0)
  const to = local(2026, 11, 14, 2, 0)
  const midnight = local(2026, 11, 14, 0, 0)
  const segments = seasonSegments(from, to)

  assert.equal(segments.length, 2)
  assert.deepEqual(segments.map((segment) => segment.season), ['autumn', 'winter'])
  assert.deepEqual(segments[0], {
    season: 'autumn',
    start: from,
    end: midnight,
    ms: midnight - from
  })
  assert.deepEqual(segments[1], {
    season: 'winter',
    start: midnight,
    end: to,
    ms: to - midnight
  })
  assert.equal(
    segments.reduce((total, segment) => total + segment.ms, 0),
    to - from
  )
})

test('seasonSegments：空区间/倒置区间/坏时间返回空数组', () => {
  assert.deepEqual(seasonSegments(100, 100), [])
  assert.deepEqual(seasonSegments(200, 100), [])
  assert.deepEqual(seasonSegments(NaN, 100), [])
  assert.deepEqual(seasonSegments(100, NaN), [])
})

test('seasonSegments：超长区间只保留最后 64 段，终点仍是 to', () => {
  const from = local(2026, 1, 1, 0, 0)
  const to = local(2026, 12, 31, 23, 59)
  const segments = seasonSegments(from, to)

  assert.equal(segments.length, 64)
  assert.equal(segments[segments.length - 1].end, to)
  assert.ok(segments[0].start > from, '超长区间应从中间开始，而不是从 1 月 1 日')
  for (let index = 1; index < segments.length; index++) {
    assert.equal(segments[index].start, segments[index - 1].end, '段与段必须首尾相接')
    assert.ok(segments[index].ms > 0)
  }
  assert.ok(segments.every((segment, index) => index === 0 || segment.start > segments[index - 1].start))
})

// ---------------------------------------------------------------------------
// 四季作物
// ---------------------------------------------------------------------------

test('SEASONAL_CROPS：四种四季作物的季节映射', () => {
  assert.deepEqual(SEASONAL_CROPS, {
    pea: 'spring',
    watermelon: 'summer',
    rice: 'autumn',
    radish: 'winter'
  })
  assert.equal(cropSeason('pea'), 'spring')
  assert.equal(cropSeason('watermelon'), 'summer')
  assert.equal(cropSeason('rice'), 'autumn')
  assert.equal(cropSeason('radish'), 'winter')
  assert.equal(isSeasonalCrop('pea'), true)
  assert.equal(isSeasonalCrop('tomato'), false)
  assert.equal(isSeasonalCrop('alien'), false)
})

test('旧六种与自定义作物没有季节，生长系数恒为 1', () => {
  for (const cropId of ['tomato', 'strawberry', 'carrot', 'corn', 'pumpkin', 'grape', 'alien']) {
    assert.equal(cropSeason(cropId), null, cropId)
    assert.equal(isSeasonalCrop(cropId), false, cropId)
    for (const seasonId of SEASON_ORDER) {
      assert.equal(seasonGrowthFactor(cropId, seasonId), 1, cropId + ' in ' + seasonId)
    }
  }
})

test('当季四季作物 +10%，错误季为 1', () => {
  assert.equal(seasonGrowthFactor('pea', 'spring'), 1.1)
  assert.equal(seasonGrowthFactor('pea', 'summer'), 1)
  assert.equal(seasonGrowthFactor('watermelon', 'summer'), 1.1)
  assert.equal(seasonGrowthFactor('rice', 'autumn'), 1.1)
  assert.equal(seasonGrowthFactor('radish', 'winter'), 1.1)
  assert.equal(seasonGrowthFactor('pea', null), 1)
  assert.equal(seasonGrowthFactor('pea', 'unknown'), 1)
})

// ---------------------------------------------------------------------------
// 日历与节日
// ---------------------------------------------------------------------------

test('calendarFor：四格、今天高亮、过去的季标记 past', () => {
  const calendar = calendarFor('autumn')
  assert.equal(calendar.length, 4)
  assert.deepEqual(calendar, [
    { id: 'spring', name: '春', emoji: '🌱', today: false, past: true, festival: '播种节' },
    { id: 'summer', name: '夏', emoji: '☀️', today: false, past: true, festival: '夜市' },
    { id: 'autumn', name: '秋', emoji: '🍂', today: true, past: false, festival: '丰收祭' },
    { id: 'winter', name: '冬', emoji: '❄️', today: false, past: false, festival: '围炉节' }
  ])
})

test('calendarFor：春天没有 past，冬天四季全 past', () => {
  const spring = calendarFor('spring')
  assert.deepEqual(spring.map((cell) => cell.past), [false, false, false, false])
  assert.deepEqual(spring.map((cell) => cell.today), [true, false, false, false])

  const winter = calendarFor('winter')
  assert.deepEqual(winter.map((cell) => cell.past), [true, true, true, false])
  assert.deepEqual(winter.map((cell) => cell.today), [false, false, false, true])
})

test('eventFor：四个节日与 SPEC v8 一致', () => {
  assert.deepEqual(eventFor('spring'), {
    id: 'spring-sow',
    name: '播种节',
    season: 'spring',
    requirement: { kind: 'plant', qty: 8 },
    reward: { coins: 30, dew: 3 }
  })
  assert.deepEqual(eventFor('summer'), {
    id: 'summer-market',
    name: '夜市',
    season: 'summer',
    requirement: { kind: 'sell', qty: 8 },
    reward: { coins: 40, dew: 3 }
  })
  assert.deepEqual(eventFor('autumn'), {
    id: 'autumn-harvest',
    name: '丰收祭',
    season: 'autumn',
    requirement: { kind: 'harvest', qty: 15 },
    reward: { coins: 50, dew: 4 }
  })
  assert.deepEqual(eventFor('winter'), {
    id: 'winter-hearth',
    name: '围炉节',
    season: 'winter',
    requirement: { kind: 'water', qty: 5 },
    reward: { coins: 35, dew: 6 }
  })
  assert.equal(eventFor('unknown'), null)
  assert.equal(Object.keys(SEASON_EVENTS).length, 4)
})
