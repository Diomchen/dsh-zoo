/**
 * 票 39：农场纯规则（`src/farm-rules.js`）。
 *
 * 这一层不碰时钟/磁盘/网络：时间从参数进来，随机源可注入。
 * 覆盖作物表、生长/成熟、浇水/施肥、收获扣减、离线 12h 上限、露水与守卫。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CROPS,
  HOUR_MS,
  MAX_DEW,
  MINUTE_MS,
  OFFLINE_GROWTH_CAP_MS,
  advanceDew,
  advanceGrowth,
  canFertilize,
  canWater,
  cropOf,
  fertilizePlot,
  growMsOf,
  guardValue,
  harvestYield,
  isCropId,
  isMature,
  localDayKey,
  offlineElapsed,
  plotRemainingMs,
  plotStage,
  stealSucceeds,
  waterPlot
} from '../src/farm-rules.js'

const T0 = new Date(2026, 4, 6, 12, 0, 0).getTime()
const TODAY = localDayKey(T0)

function tomatoPlot (overrides = {}) {
  return {
    id: 'p1',
    crop: 'tomato',
    plantedAt: T0,
    grownMs: 0,
    growMs: CROPS.tomato.growMs,
    waterings: 0,
    fertilized: false,
    stolenBy: [],
    helpedBy: [],
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 作物表 / 生长 / 成熟
// ---------------------------------------------------------------------------

test('作物表：三种作物的生长、种子价、产量、底价与 SPEC v5 一致', () => {
  assert.deepEqual(Object.keys(CROPS), ['tomato', 'carrot', 'pumpkin'])
  assert.deepEqual(
    { growMs: CROPS.tomato.growMs, seedPrice: CROPS.tomato.seedPrice, yield: CROPS.tomato.yield, base: CROPS.tomato.base },
    { growMs: 30 * MINUTE_MS, seedPrice: 6, yield: 3, base: 5 }
  )
  assert.deepEqual(
    { growMs: CROPS.carrot.growMs, seedPrice: CROPS.carrot.seedPrice, yield: CROPS.carrot.yield, base: CROPS.carrot.base },
    { growMs: 2 * HOUR_MS, seedPrice: 14, yield: 5, base: 6 }
  )
  assert.deepEqual(
    { growMs: CROPS.pumpkin.growMs, seedPrice: CROPS.pumpkin.seedPrice, yield: CROPS.pumpkin.yield, base: CROPS.pumpkin.base },
    { growMs: 8 * HOUR_MS, seedPrice: 36, yield: 3, base: 30 }
  )
  assert.equal(isCropId('tomato'), true)
  assert.equal(isCropId('Tomato'), false)
  assert.equal(isCropId('alien'), false)
  assert.equal(cropOf('carrot'), CROPS.carrot)
  assert.equal(cropOf('alien'), null)
  assert.equal(growMsOf('pumpkin'), 8 * HOUR_MS)
  assert.equal(growMsOf('alien'), 0)
})

test('生长：按真实时间推进，到 growMs 就停；成熟后再过多久都不枯萎', () => {
  const empty = { crop: null, grownMs: 0, growMs: 0 }
  assert.equal(advanceGrowth(empty, 10 * HOUR_MS), empty)

  const half = advanceGrowth(tomatoPlot(), 15 * MINUTE_MS)
  assert.equal(half.grownMs, 15 * MINUTE_MS)
  assert.equal(isMature(half), false)
  assert.equal(plotStage(half), 'growing')
  assert.equal(plotRemainingMs(half), 15 * MINUTE_MS)

  const mature = advanceGrowth(half, 15 * MINUTE_MS)
  assert.equal(mature.grownMs, CROPS.tomato.growMs)
  assert.equal(isMature(mature), true)
  assert.equal(plotStage(mature), 'mature')
  assert.equal(plotRemainingMs(mature), 0)

  // 成熟后不再生长，也不掉产量：回来晚了只是晚收，不会少收（被偷除外）。
  assert.equal(advanceGrowth(mature, 10 * HOUR_MS), mature)
  assert.equal(harvestYield(advanceGrowth(mature, 10 * HOUR_MS)), 3)

  // 一次给超大 elapsed 也只封顶到 growMs。
  assert.equal(advanceGrowth(tomatoPlot(), 100 * HOUR_MS).grownMs, CROPS.tomato.growMs)
})

test('浇水：+10% 生长、每株一次、花 1 露水；空地/成熟地不可浇', () => {
  assert.equal(canWater(tomatoPlot()), true)
  const watered = waterPlot(tomatoPlot())
  assert.equal(watered.waterings, 1)
  assert.equal(watered.grownMs, Math.floor(CROPS.tomato.growMs * 0.1))
  assert.equal(canWater(watered), false)
  assert.equal(waterPlot(watered), null)

  // 浇到成熟：grownMs 封顶在 growMs，不会超过。
  const nearly = waterPlot(tomatoPlot({ grownMs: CROPS.tomato.growMs - 1 }))
  assert.equal(nearly.grownMs, CROPS.tomato.growMs)
  assert.equal(isMature(nearly), true)

  assert.equal(canWater({ crop: null, grownMs: 0, growMs: 0 }), false)
  assert.equal(canWater(tomatoPlot({ grownMs: CROPS.tomato.growMs })), false)
})

test('施肥：每株一次、+1 产量；成熟后仍可施（收获前最后一个加成）', () => {
  assert.equal(canFertilize(tomatoPlot()), true)
  const fertilized = fertilizePlot(tomatoPlot())
  assert.equal(fertilized.fertilized, true)
  assert.equal(canFertilize(fertilized), false)
  assert.equal(fertilizePlot(fertilized), null)
  assert.equal(fertilizePlot(tomatoPlot({ grownMs: CROPS.tomato.growMs })).fertilized, true)
  assert.equal(canFertilize({ crop: null }), false)
})

// ---------------------------------------------------------------------------
// 收获
// ---------------------------------------------------------------------------

test('收获产量：表里的产量 + 施肥 1 − 被偷数量，最低 0', () => {
  assert.equal(harvestYield(tomatoPlot()), 3)
  assert.equal(harvestYield(tomatoPlot({ crop: 'carrot' })), 5)
  assert.equal(harvestYield(tomatoPlot({ crop: 'pumpkin' })), 3)
  assert.equal(harvestYield(tomatoPlot({ fertilized: true })), 4)
  assert.equal(harvestYield(tomatoPlot({ stolenBy: ['a'] })), 2)
  assert.equal(harvestYield(tomatoPlot({ fertilized: true, stolenBy: ['a', 'b'] })), 2)
  // 偷超过产量：最低 0，不出现负库存。
  assert.equal(harvestYield(tomatoPlot({ stolenBy: ['a', 'b', 'c', 'd'] })), 0)
  assert.equal(harvestYield(tomatoPlot({ fertilized: true, stolenBy: ['a', 'b', 'c', 'd'] })), 0)
  assert.equal(harvestYield({ crop: null }), 0)
})

// ---------------------------------------------------------------------------
// 离线补算 / 露水
// ---------------------------------------------------------------------------

test('离线补算：min(now − lastTickAt, 12h)；时钟倒退/缺时间戳按 0', () => {
  assert.equal(OFFLINE_GROWTH_CAP_MS, 12 * HOUR_MS)
  assert.equal(offlineElapsed(T0, T0 + HOUR_MS), HOUR_MS)
  assert.equal(offlineElapsed(T0, T0 + 24 * HOUR_MS), 12 * HOUR_MS)
  assert.equal(offlineElapsed(T0, T0 - HOUR_MS), 0)
  assert.equal(offlineElapsed(null, T0), 0)
  assert.equal(offlineElapsed(undefined, T0), 0)
  assert.equal(offlineElapsed(T0, T0 + 24 * HOUR_MS, 2 * HOUR_MS), 2 * HOUR_MS)
})

test('露水：10 分钟 +1、零头保留、余额封顶 48、跨本地午夜归零', () => {
  const start = { dew: 0, dewAt: T0, dewDay: TODAY }
  const nine = advanceDew(start, T0 + 9 * MINUTE_MS)
  assert.deepEqual(nine, {
    dew: 0,
    dewEarned: 0,
    dewAt: T0,
    dewDay: TODAY,
    dewDayEarned: TODAY,
    gained: 0,
    reset: false
  })

  const ten = advanceDew(start, T0 + 10 * MINUTE_MS)
  assert.equal(ten.dew, 1)
  assert.equal(ten.gained, 1)
  assert.equal(ten.dewAt, T0 + 10 * MINUTE_MS)

  // 15 分钟只给 1 点，零头留到下一次；25 分钟给 2 点。
  const fifteen = advanceDew({ dew: 1, dewAt: T0 + 10 * MINUTE_MS, dewDay: TODAY }, T0 + 25 * MINUTE_MS)
  assert.equal(fifteen.dew, 2)
  assert.equal(fifteen.dewAt, T0 + 20 * MINUTE_MS)

  // 8 小时正好 48，再多也不涨。
  const full = advanceDew(start, T0 + 8 * HOUR_MS)
  assert.equal(full.dew, MAX_DEW)
  assert.equal(full.dewAt, T0 + 8 * HOUR_MS)
  const over = advanceDew(full, T0 + 10 * HOUR_MS)
  assert.equal(over.dew, MAX_DEW)
  assert.equal(over.gained, 0)

  // 跨本地午夜：余额归零，锚点从午夜之后重新算。
  const late = new Date(2026, 4, 6, 23, 50, 0).getTime()
  const lateDay = localDayKey(late)
  const beforeMidnight = advanceDew({ dew: 12, dewAt: late, dewDay: lateDay }, late + 5 * MINUTE_MS)
  assert.equal(beforeMidnight.dew, 12)
  const afterMidnight = advanceDew(
    { dew: 12, dewAt: late, dewDay: lateDay },
    late + 20 * MINUTE_MS
  )
  assert.equal(afterMidnight.dew, 0)
  assert.equal(afterMidnight.reset, true)
  assert.equal(afterMidnight.dewAt, late + 20 * MINUTE_MS)
  assert.equal(afterMidnight.dewDay, localDayKey(late + 20 * MINUTE_MS))
  const nextPoint = advanceDew(afterMidnight, late + 30 * MINUTE_MS)
  assert.equal(nextPoint.dew, 1)
})

test('露水每日上限按「已挣」算：挣满 48、花光后再等 10 分钟也不再涨；跨日恢复', () => {
  const spentAll = {
    dew: 0,
    dewEarned: MAX_DEW,
    dewAt: T0 + 10 * MINUTE_MS,
    dewDay: TODAY,
    dewDayEarned: TODAY
  }
  const noRefill = advanceDew(spentAll, T0 + 20 * MINUTE_MS)
  assert.equal(noRefill.dew, 0)
  assert.equal(noRefill.dewEarned, MAX_DEW)
  assert.equal(noRefill.gained, 0, '花掉的余额不释放当天的额度')

  // 还剩 1 点没花也一样：只要「今天已挣」到 48，就不再产生新的露水。
  const partlySpent = advanceDew({ ...spentAll, dew: 1 }, T0 + 20 * MINUTE_MS)
  assert.equal(partlySpent.dew, 1)
  assert.equal(partlySpent.dewEarned, MAX_DEW)
  assert.equal(partlySpent.gained, 0)

  // 次日：先跨日归零（这一拍只重置），再等 10 分钟恢复 +1。
  const nextNoon = new Date(2026, 4, 7, 12, 0, 0).getTime()
  const nextDay = advanceDew(noRefill, nextNoon)
  assert.equal(nextDay.dew, 0)
  assert.equal(nextDay.dewEarned, 0)
  assert.equal(nextDay.reset, true)
  assert.equal(nextDay.dewDayEarned, localDayKey(nextNoon))

  const resumed = advanceDew(nextDay, nextNoon + 10 * MINUTE_MS)
  assert.equal(resumed.dew, 1)
  assert.equal(resumed.dewEarned, 1)
  assert.equal(resumed.gained, 1)
})

test('露水：时钟倒退/锚点缺失不产生负增长或瞬间满额', () => {
  const now = T0
  const backwards = advanceDew({ dew: 3, dewAt: now + HOUR_MS, dewDay: TODAY }, now)
  assert.equal(backwards.dew, 3)
  assert.equal(backwards.gained, 0)
  assert.equal(backwards.dewAt, now)

  const missing = advanceDew({ dew: 3, dewAt: null, dewDay: null }, now)
  assert.equal(missing.dew, 3)
  assert.equal(missing.gained, 0)
  assert.equal(missing.dewAt, now)
  assert.equal(missing.dewDay, TODAY)
})

test('本地日期键用本地时间，不用 UTC', () => {
  assert.equal(localDayKey(T0), '2026-05-06')
  const late = new Date(2026, 4, 6, 23, 59, 59).getTime()
  assert.equal(localDayKey(late), '2026-05-06')
  assert.equal(localDayKey(late + 1000), '2026-05-07')
  assert.equal(localDayKey('nope'), null)
})

// ---------------------------------------------------------------------------
// 守卫（43/44 复用；随机源可注入）
// ---------------------------------------------------------------------------

test('守卫：主人在家 0.3 + 雇工 0.5，封顶 0.8；成功率 1 − 守卫（注入随机）', () => {
  assert.equal(guardValue(), 0)
  assert.equal(guardValue({ ownerHome: true }), 0.3)
  assert.equal(guardValue({ worker: true }), 0.5)
  assert.equal(guardValue({ ownerHome: true, worker: true }), 0.8)

  assert.equal(stealSucceeds(0.3, () => 0.1), false, '落在守卫区间内 = 被抓住')
  assert.equal(stealSucceeds(0.3, () => 0.2), false)
  assert.equal(stealSucceeds(0.3, () => 0.3), true)
  assert.equal(stealSucceeds(0.3, () => 0.9), true)
  assert.equal(stealSucceeds(0, () => 0), true)
  assert.equal(stealSucceeds(0.8, () => 0.5), false)
  assert.equal(stealSucceeds(2, () => 0.7), false, '超过 0.8 的值按 0.8 夹取')
  // 随机源坏了不能回落到全局 Math.random：按 0 处理（守卫 > 0 时必被抓），判定仍是确定的。
  assert.equal(stealSucceeds(0.3, () => 'x'), false)
  assert.equal(stealSucceeds(0.3, () => Number.NaN), false)
  assert.equal(stealSucceeds(0, () => Number.NaN), true)
})
