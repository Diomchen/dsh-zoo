/**
 * 票 67/74：四季「季候来客」纯规则。
 *
 * 来客按季节查表；出现窗口由当天 start + id 稳定算出，持续 3 小时。
 * 这里只测规则，不碰 farm.json/season.json。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { HOUR_MS } from '../src/season-rules.js'
import {
  OMEN_WINDOW_MS,
  freshOmen,
  normalizeOmen,
  omenFor,
  omenView,
  resolveOmen
} from '../src/season-omens.js'

const DAY = 24 * HOUR_MS
const AUTUMN = { id: 'autumn', start: 1_700_000_000_000, end: 1_700_000_000_000 + DAY }

test('四季各有一位来客；未知季节没有', () => {
  const expected = {
    spring: ['spring-frog-rain', '蛙雨', '🐸'],
    summer: ['summer-wildfire', '野火', '🔥'],
    autumn: ['autumn-bearger', '熊獾', '🐻'],
    winter: ['winter-deerclops', '巨鹿', '🦌']
  }
  for (const [season, [id, name, emoji]] of Object.entries(expected)) {
    const meta = omenFor(season)
    assert.equal(meta.id, id)
    assert.equal(meta.name, name)
    assert.equal(meta.emoji, emoji)
    assert.equal(meta.season, season)
    assert.equal(meta.windowMs, OMEN_WINDOW_MS)
    assert.equal(meta.choices.length, 2)
  }
  assert.equal(omenFor('monsoon'), null)
})

test('freshOmen：熊獾固定本地 15:00 出现、持续 3 小时', () => {
  const first = freshOmen(AUTUMN)
  const second = freshOmen(AUTUMN)
  assert.deepEqual(first, second)
  assert.equal(first.day, AUTUMN.start)
  assert.equal(first.season, 'autumn')
  assert.equal(first.id, 'autumn-bearger')
  assert.equal(first.resolved, false)
  assert.equal(first.choice, null)
  assert.equal(first.end - first.start, OMEN_WINDOW_MS)
  const fixed = new Date(AUTUMN.start)
  fixed.setHours(15, 0, 0, 0)
  assert.equal(first.start, fixed.getTime())
  assert.equal(new Date(first.start).getHours(), 15)
  assert.equal(new Date(first.end).getHours(), 18)
  assert.ok(first.start >= AUTUMN.start)
  assert.ok(first.end <= AUTUMN.end)
})

test('蛙雨/野火窗口随机，熊獾/巨鹿固定在 15:00', () => {
  const spring = { id: 'spring', start: AUTUMN.start, end: AUTUMN.end }
  const summer = { id: 'summer', start: AUTUMN.start, end: AUTUMN.end }
  const winter = { id: 'winter', start: AUTUMN.start, end: AUTUMN.end }
  for (const season of [spring, summer]) {
    const omen = freshOmen(season)
    assert.equal(omen.end - omen.start, OMEN_WINDOW_MS)
    assert.ok(omen.start >= season.start)
    assert.ok(omen.start <= season.end - OMEN_WINDOW_MS)
    assert.notEqual(omen.start, new Date(season.start).setHours(15, 0, 0, 0))
  }
  const deer = freshOmen(winter)
  const fixed = new Date(winter.start)
  fixed.setHours(15, 0, 0, 0)
  assert.equal(deer.start, fixed.getTime())
  assert.equal(deer.end - deer.start, OMEN_WINDOW_MS)
})

test('normalizeOmen：只认同一天、同一来客、同一窗口；坏数据丢弃', () => {
  const raw = freshOmen(AUTUMN)
  raw.resolved = true
  raw.choice = 'feed'
  raw.result = { success: true }
  assert.deepEqual(normalizeOmen(raw, AUTUMN), raw)
  assert.equal(normalizeOmen({ ...raw, day: raw.day + 1 }, AUTUMN), null)
  assert.equal(normalizeOmen({ ...raw, id: 'winter-deerclops' }, AUTUMN), null)
  assert.equal(normalizeOmen({ ...raw, start: raw.start + 60_000 }, AUTUMN), null)
  assert.equal(normalizeOmen(null, AUTUMN), null)
  assert.equal(normalizeOmen(raw, { id: 'winter', start: AUTUMN.start, end: AUTUMN.end }), null)
})

test('omenView：窗口前/窗口内/窗口后，remainingMs 与 active 正确', () => {
  const omen = freshOmen(AUTUMN)
  assert.equal(omenView(omen, omen.start - 1).active, false)
  assert.equal(omenView(omen, omen.start).active, true)
  assert.equal(omenView(omen, omen.end - 1).active, true)
  assert.equal(omenView(omen, omen.end).active, false)
  assert.equal(omenView(omen, omen.start).remainingMs, OMEN_WINDOW_MS)
  assert.equal(omenView(null), null)
})

test('守夜：低于守卫值成功，奖励 70 硬币 + 5 露水 + 1 颗稻种；高于则失败搬 5 个作物', () => {
  const omen = freshOmen(AUTUMN)
  const now = omen.start + HOUR_MS
  const success = resolveOmen('guard', { guard: 0.3, random: () => 0.1, now, omen })
  assert.equal(success.ok, true)
  assert.equal(success.success, true)
  assert.deepEqual(success.loss, { crops: 0, witherPlots: 0, freezePlots: 0, matureOnly: false })
  assert.deepEqual(success.reward, { coins: 70, dew: 5, seeds: { rice: 1 } })

  const fail = resolveOmen('guard', { guard: 0.3, random: () => 0.9, now, omen })
  assert.equal(fail.ok, true)
  assert.equal(fail.success, false)
  assert.deepEqual(fail.loss, { crops: 5, witherPlots: 0, freezePlots: 0, matureOnly: false })
  assert.equal(fail.reward.coins, 0)
  assert.equal(fail.reward.dew, 0)
})

test('投喂：稳过，扣 3 个仓库作物，换 1 颗稻种 + 2 露水', () => {
  const omen = freshOmen(AUTUMN)
  const result = resolveOmen('feed', { now: omen.start + 1, omen })
  assert.equal(result.ok, true)
  assert.equal(result.success, true)
  assert.deepEqual(result.loss, { crops: 0, witherPlots: 0, freezePlots: 0, matureOnly: false })
  assert.deepEqual(result.consume, { crops: 3, dew: 0, coins: 0 })
  assert.equal(result.reward.dew, 2)
  assert.equal(result.reward.seeds.rice, 1)
})

test('临时守卫可以把守卫率推到 1.0，骰子再高也成功', () => {
  const omen = freshOmen(AUTUMN)
  const now = omen.start + HOUR_MS
  const result = resolveOmen('guard', { guard: 1, random: () => 0.99, now, omen })
  assert.equal(result.ok, true)
  assert.equal(result.success, true)
  assert.deepEqual(result.loss, { crops: 0, witherPlots: 0, freezePlots: 0, matureOnly: false })
})

test('窗口外不能结算；坏选择被拒绝', () => {
  const omen = freshOmen(AUTUMN)
  assert.deepEqual(resolveOmen('run', { omen }), { ok: false, code: 'bad-choice' })
  assert.deepEqual(
    resolveOmen('guard', { now: omen.start - 1, omen }),
    { ok: false, code: 'omen-inactive' }
  )
  assert.deepEqual(
    resolveOmen('feed', { now: omen.end, omen }),
    { ok: false, code: 'omen-inactive' }
  )
})

test('四季赌注：蛙雨引水、野火只烧成熟、巨鹿生火要露水+硬币', () => {
  const spring = omenFor('spring')
  assert.deepEqual(spring.stakes.feedCost, { crops: 0, dew: 1, coins: 0 })
  assert.deepEqual(spring.stakes.ignoreLoss, { crops: 0, witherPlots: 1, freezePlots: 0, matureOnly: false })
  assert.equal(spring.choices.find((choice) => choice.id === 'guard').label, '赶走')

  const summer = omenFor('summer')
  assert.equal(summer.stakes.failWither, 2)
  assert.equal(summer.stakes.failMatureOnly, true)

  const winter = omenFor('winter')
  assert.deepEqual(winter.stakes.feedCost, { crops: 0, dew: 2, coins: 10 })
  assert.equal(winter.stakes.failWither, 0)
  assert.equal(winter.stakes.failFreeze, 3)
  assert.equal(winter.choices.find((choice) => choice.id === 'feed').label, '生火')
})
