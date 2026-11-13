/**
 * 四季作物平衡回归：它们只能在当季种，净收益不能输给常驻速生作物。
 *
 * 只比较内置作物，按 base 价（bid = round(0.9 × price)）算理想日收益：
 * 一天 24 小时、当季 1.1×、每茬都卖、不算交易所冲击。自定义作物
 * （berry / bluemaid 之类）不参与，否则等于拿用户手填的数值当平衡目标。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_CROPS } from '../src/farm-rules.js'
import { cropSeason, seasonGrowthFactor } from '../src/season-rules.js'

const DAY_MS = 24 * 60 * 60 * 1000

function dailyNet (crop, priceRatio = 1) {
  const factor = cropSeason(crop.id) === null ? 1 : seasonGrowthFactor(crop.id, cropSeason(crop.id))
  const cycles = Math.floor(DAY_MS / (crop.growMs / factor))
  const price = Math.max(1, Math.round(crop.base * priceRatio * 0.9))
  return cycles * (crop.yield * price - crop.seedPrice)
}

test('四季作物：当季按 base 价的日收益不低于草莓', () => {
  const strawberry = dailyNet(BUILTIN_CROPS.strawberry)
  for (const id of ['pea', 'watermelon', 'rice', 'radish']) {
    assert.ok(
      dailyNet(BUILTIN_CROPS[id]) >= strawberry,
      `${id} 当季日收益 ${dailyNet(BUILTIN_CROPS[id])} 低于草莓 ${strawberry}`
    )
  }
})

test('四季作物：价格跌到地板时也不低于草莓', () => {
  const strawberry = dailyNet(BUILTIN_CROPS.strawberry, 0.5)
  for (const id of ['pea', 'watermelon', 'rice', 'radish']) {
    assert.ok(
      dailyNet(BUILTIN_CROPS[id], 0.5) >= strawberry,
      `${id} 地板价日收益 ${dailyNet(BUILTIN_CROPS[id], 0.5)} 低于草莓 ${strawberry}`
    )
  }
})

test('旧六种作物的数值保持原样', () => {
  const expected = {
    tomato: [30 * 60 * 1000, 6, 3, 5],
    strawberry: [45 * 60 * 1000, 9, 4, 7],
    carrot: [2 * 60 * 60 * 1000, 14, 5, 6],
    corn: [4 * 60 * 60 * 1000, 22, 6, 9],
    pumpkin: [8 * 60 * 60 * 1000, 36, 3, 30],
    grape: [12 * 60 * 60 * 1000, 52, 5, 24]
  }
  for (const [id, [growMs, seedPrice, yield_, base]] of Object.entries(expected)) {
    const crop = BUILTIN_CROPS[id]
    assert.equal(crop.growMs, growMs, id)
    assert.equal(crop.seedPrice, seedPrice, id)
    assert.equal(crop.yield, yield_, id)
    assert.equal(crop.base, base, id)
  }
})
