/**
 * 票 67：熊獾纯规则。守夜概率复用守卫值，投喂稳过；
 * 这里只测规则，不碰 farm.json/season.json。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OMEN_FAIL_LOSS,
  OMEN_FEED_COST,
  OMEN_FEED_REWARD,
  OMEN_GUARD_REWARD,
  OMEN_IGNORE_LOSS,
  freshOmen,
  normalizeOmen,
  omenFor,
  omenView,
  resolveOmen
} from '../src/season-omens.js'

const AUTUMN = { id: 'autumn', start: 1000, end: 2000 }

test('来客只在秋天出现；freshOmen 带当天 start 且未处理', () => {
  assert.equal(omenFor('spring'), null)
  const omen = omenFor('autumn')
  assert.equal(omen.id, 'autumn-bearger')
  assert.equal(omen.name, '熊獾')
  assert.deepEqual(freshOmen(AUTUMN), {
    start: 1000,
    id: 'autumn-bearger',
    resolved: false,
    choice: null,
    result: null
  })
  assert.equal(freshOmen({ id: 'winter', start: 1 }), null)
})

test('守夜：随机低于守卫值成功，奖励硬币/露水；高于则失败扣 3 作物', () => {
  const success = resolveOmen('guard', { guard: 0.3, random: () => 0.1 })
  assert.equal(success.ok, true)
  assert.equal(success.success, true)
  assert.equal(success.loss, 0)
  assert.deepEqual(success.reward, { ...OMEN_GUARD_REWARD, seeds: {} })

  const fail = resolveOmen('guard', { guard: 0.3, random: () => 0.9 })
  assert.equal(fail.success, false)
  assert.equal(fail.loss, OMEN_FAIL_LOSS)
  assert.equal(fail.reward.coins, 0)
  assert.equal(fail.reward.dew, 0)
})

test('投喂：稳过，消耗 3 个仓库作物，换 1 颗稻种 + 2 露水', () => {
  const result = resolveOmen('feed', { random: () => 0 })
  assert.equal(result.ok, true)
  assert.equal(result.success, true)
  assert.equal(result.loss, 0)
  assert.equal(result.consume, OMEN_FEED_COST)
  assert.equal(result.reward.dew, OMEN_FEED_REWARD.dew)
  assert.equal(result.reward.seeds.rice, 1)
})

test('坏选择被拒绝；视图带选择、赌注与忽略损失', () => {
  assert.deepEqual(resolveOmen('run'), { ok: false, code: 'bad-choice' })
  const view = omenView(freshOmen(AUTUMN))
  assert.equal(view.id, 'autumn-bearger')
  assert.equal(view.resolved, false)
  assert.equal(view.choices.length, 2)
  assert.equal(view.stakes.failLoss, OMEN_FAIL_LOSS)
  assert.equal(view.stakes.ignoreLoss, OMEN_IGNORE_LOSS)
  assert.equal(omenView(null), null)
})

test('normalizeOmen：只留今年秋天同一天的来客；坏数据当没来过', () => {
  const raw = { start: 1000, id: 'autumn-bearger', resolved: true, choice: 'feed', result: { success: true } }
  assert.deepEqual(normalizeOmen(raw, AUTUMN), raw)
  assert.equal(normalizeOmen({ ...raw, start: 999 }, AUTUMN), null)
  assert.equal(normalizeOmen({ ...raw, id: 'other' }, AUTUMN), null)
  assert.equal(normalizeOmen(raw, { id: 'winter', start: 2000 }), null)
  assert.equal(normalizeOmen(null, AUTUMN), null)
})
