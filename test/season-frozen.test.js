/**
 * 票 75：冬季冻住的地块。
 *
 * 冻结只暂停生长，不毁作物；必须花 2 露水 + 5 硬币生火解冻。
 * 到换季还没解冻才会变成枯萎——和“冬天没熬过去”是同一件事。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFarmStore } from '../src/farm.js'
import { CROPS, HOUR_MS, MINUTE_MS, THAW_COST, plotStage } from '../src/farm-rules.js'
import { seasonAt } from '../src/season-rules.js'

function localNoon (year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0).getTime()
}

const WINTER = localNoon(2026, 11, 18)

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-frozen-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function clockAt (start) {
  let value = start
  return {
    now: () => value,
    advance (ms) { value += ms }
  }
}

function fakeMarket () {
  return {
    applyTrade ({ side, cropId, qty }) {
      const crop = CROPS[cropId]
      const unit = side === 'buy' ? crop.seedPrice : crop.base
      return { ok: true, total: unit * qty, unit, persisted: true }
    }
  }
}

test('冻结：停止生长，不能收/浇/施肥/重种；解冻后继续长', async (t) => {
  const dir = await tempDir(t)
  const clock = clockAt(WINTER)
  const store = await createFarmStore(dir, { now: clock.now, market: fakeMarket() })
  await store.buySeed('radish', 1)
  assert.equal((await store.plant('p1', 'radish')).ok, true)

  const frozen = await store.freezePlots(1)
  assert.equal(frozen.ok, true)
  assert.equal(frozen.qty, 1)
  const plot = store.snapshot().plots[0]
  assert.equal(plot.frozen, true)
  assert.equal(plot.withered, undefined)
  assert.equal(plotStage(plot), 'frozen')
  const grownAtFreeze = plot.grownMs

  clock.advance(30 * MINUTE_MS)
  assert.equal(store.snapshot().plots[0].grownMs, grownAtFreeze, '冻住期间不长')
  assert.equal((await store.harvest('p1')).error, 'frozen')
  assert.equal((await store.water('p1')).error, 'frozen')
  assert.equal((await store.fertilize('p1')).error, 'frozen')
  assert.equal((await store.plant('p1', 'radish')).error, 'frozen')

  const thawed = await store.thaw('p1')
  assert.equal(thawed.ok, true)
  assert.deepEqual(thawed.cost, { dew: 2, coins: 5 })
  assert.equal(thawed.plot.frozen, undefined)
  assert.equal(thawed.plot.crop, 'radish')

  clock.advance(90 * MINUTE_MS)
  const harvested = await store.harvest('p1')
  assert.equal(harvested.ok, true)
  assert.equal(harvested.qty, CROPS.radish.yield)
})

test('冻结：到了换季还没解冻就冻死成枯萎，不能直接重种以外的操作', async (t) => {
  const dir = await tempDir(t)
  const clock = clockAt(new Date(2026, 10, 18, 23, 50, 0).getTime())
  const store = await createFarmStore(dir, { now: clock.now, market: fakeMarket() })
  await store.buySeed('radish', 1)
  assert.equal((await store.plant('p1', 'radish')).ok, true)
  assert.equal((await store.freezePlots(1)).ok, true)

  clock.advance(20 * MINUTE_MS) // 次日 00:10，入春
  const plot = store.snapshot().plots[0]
  assert.equal(seasonAt(clock.now()).id, 'spring')
  assert.equal(plot.withered, true)
  assert.equal(plot.frozen, undefined)
  assert.equal((await store.thaw('p1')).error, 'not-frozen')
  assert.equal((await store.harvest('p1')).error, 'withered')
})

test('冻结：只挑有作物的地，成熟地优先保护，最多冻 qty 块', async (t) => {
  const dir = await tempDir(t)
  const clock = clockAt(WINTER)
  const store = await createFarmStore(dir, { now: clock.now, market: fakeMarket() })
  await store.buySeed('radish', 1)
  await store.plant('p1', 'radish')
  await store.plant('p2', 'radish') // 初始只有 1 颗萝卜种子，第二块会 no-seed
  const result = await store.freezePlots(3)
  assert.equal(result.ok, true)
  assert.equal(result.qty, 1, '只有一块有作物')
  assert.equal(result.plots[0], 'p1')
})

test('铲除：冻住的地可以直接清空，不付解冻费', async (t) => {
  const dir = await tempDir(t)
  const clock = clockAt(WINTER)
  const store = await createFarmStore(dir, { now: clock.now, market: fakeMarket() })
  await store.buySeed('radish', 1)
  await store.plant('p1', 'radish')
  assert.equal((await store.freezePlots(1)).ok, true)
  const before = store.snapshot()

  const cleared = await store.clear('p1')
  assert.equal(cleared.ok, true)
  assert.equal(cleared.crop, 'radish')
  assert.equal(cleared.plot.crop, null)
  assert.equal(cleared.dew, before.dew, '不扣解冻露水')
  assert.equal(cleared.coins, before.coins, '不扣解冻硬币')
  assert.equal(cleared.seeds.radish, before.seeds.radish, '不退种子')
  assert.equal((await store.clear('p1')).error, 'plot-empty')
})
