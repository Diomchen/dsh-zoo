/**
 * 票 64：四季作物的种/买季节门。
 *
 * 只测宿主规则，不碰窗口：当季能种能买，错季明确 `out-of-season`；
 * 卖旧季收成不受限；旧六种哪个季节都能种。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFarmStore } from '../src/farm.js'
import { CROPS, HOUR_MS, MINUTE_MS } from '../src/farm-rules.js'
import { seasonAt } from '../src/season-rules.js'

function localNoon (year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0).getTime()
}

const SPRING = localNoon(2026, 11, 15)
const AUTUMN = localNoon(2026, 11, 17)
const WINTER = localNoon(2026, 11, 18)

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-season-farm-'))
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

// farm store 的买卖要一个同步交易所；这里只关心季节门，价格用表里的数。
function fakeMarket () {
  return {
    applyTrade ({ side, cropId, qty }) {
      const crop = CROPS[cropId]
      const unit = side === 'buy' ? crop.seedPrice : crop.base
      return { ok: true, total: unit * qty, unit, persisted: true }
    }
  }
}

test('春季：能买/能种豌豆，不能买/不能种西瓜；旧六种照常', async (t) => {
  assert.equal(seasonAt(SPRING).id, 'spring')
  const dir = await tempDir(t)
  const clock = clockAt(SPRING)
  const store = await createFarmStore(dir, { now: clock.now, market: fakeMarket() })

  assert.equal((await store.buySeed('watermelon', 1)).error, 'out-of-season')
  assert.equal((await store.plant('p1', 'watermelon')).error, 'out-of-season')

  const bought = await store.buySeed('pea', 1)
  assert.equal(bought.ok, true)
  assert.equal(bought.seeds.pea, 1)
  assert.equal((await store.plant('p1', 'pea')).ok, true)
  assert.equal((await store.plant('p2', 'tomato')).ok, true, '旧六种不受季节限制')
  assert.equal((await store.plant('p3', 'pepper')).error, 'bad-crop', '自定义作物没有季节归属')

  clock.advance(25 * MINUTE_MS)
  const pea = await store.harvest('p1')
  assert.equal(pea.ok, true)
  assert.equal(pea.qty, CROPS.pea.yield)
})

test('秋/冬：四季作物按各自季节放行，旧六种不受影响', async (t) => {
  const autumnDir = await tempDir(t)
  const autumn = await createFarmStore(autumnDir, { now: () => AUTUMN, market: fakeMarket() })
  assert.equal((await autumn.buySeed('rice', 1)).ok, true)
  assert.equal((await autumn.buySeed('pea', 1)).error, 'out-of-season')
  assert.equal((await autumn.plant('p1', 'rice')).ok, true)

  const winterDir = await tempDir(t)
  const winter = await createFarmStore(winterDir, { now: () => WINTER, market: fakeMarket() })
  assert.equal((await winter.buySeed('radish', 1)).ok, true)
  assert.equal((await winter.buySeed('rice', 1)).error, 'out-of-season')
  assert.equal((await winter.plant('p1', 'radish')).ok, true)
  assert.equal((await winter.plant('p2', 'grape')).error, 'no-seed', '旧六种只受种子限制')
})

test('卖旧季收成不受季节限制；买种子才受限', async (t) => {
  const dir = await tempDir(t)
  const store = await createFarmStore(dir, { now: () => AUTUMN, market: fakeMarket() })
  await store.addCrop('watermelon', 2)

  const sold = await store.sellCrop('watermelon', 2)
  assert.equal(sold.ok, true)
  assert.equal(sold.crops.watermelon ?? 0, 0)
  assert.equal((await store.buySeed('watermelon', 1)).error, 'out-of-season')
})

test('跨季生长：种下的四季作物不会因为换季改变 growMs，只有窗口阶段会变', async (t) => {
  const dir = await tempDir(t)
  const clock = clockAt(SPRING)
  const store = await createFarmStore(dir, { now: clock.now, market: fakeMarket() })
  await store.buySeed('pea', 1)
  await store.plant('p1', 'pea')
  const before = store.snapshot().plots[0]
  assert.equal(before.growMs, CROPS.pea.growMs)

  clock.advance(24 * HOUR_MS) // 入夏
  const after = store.snapshot().plots[0]
  assert.equal(after.crop, 'pea')
  assert.equal(after.growMs, CROPS.pea.growMs, '换季不改已种作物的生长时长')
  assert.equal(after.grownMs >= before.grownMs, true)
})

test('换季枯萎：春天没熟的豌豆入夏变 withered，不能收/浇/施肥，但能重种', async (t) => {
  const dir = await tempDir(t)
  const clock = clockAt(new Date(2026, 10, 15, 23, 50, 0).getTime())
  const store = await createFarmStore(dir, { now: clock.now, market: fakeMarket() })
  await store.buySeed('pea', 1)
  assert.equal((await store.plant('p1', 'pea')).ok, true)

  assert.equal(store.snapshot().plots[0].withered, undefined)
  clock.advance(20 * MINUTE_MS) // 次日 00:10，入夏
  const plot = store.snapshot().plots[0]
  assert.equal(plot.withered, true)
  assert.equal(plot.crop, 'pea')

  assert.equal((await store.harvest('p1')).error, 'withered')
  assert.equal((await store.water('p1')).error, 'withered')
  assert.equal((await store.fertilize('p1')).error, 'withered')

  // 枯萎地可以重种：夏天能买西瓜，旧作物不收也不退种子。
  await store.addCoins(100)
  assert.equal((await store.buySeed('watermelon', 1)).ok, true)
  const replanted = await store.plant('p1', 'watermelon')
  assert.equal(replanted.ok, true)
  assert.equal(replanted.plot.crop, 'watermelon')
  assert.equal(replanted.plot.withered, undefined)
})

test('换季枯萎：已成熟的四季作物保留，旧六种永不枯萎', async (t) => {
  const dir = await tempDir(t)
  const clock = clockAt(localNoon(2026, 11, 15))
  const store = await createFarmStore(dir, { now: clock.now, market: fakeMarket() })
  await store.buySeed('pea', 1)
  await store.buySeed('tomato', 1)
  await store.plant('p1', 'pea')
  await store.plant('p2', 'tomato')

  clock.advance(30 * MINUTE_MS) // 豌豆已熟，番茄还差一点
  const ripe = store.snapshot().plots[0]
  assert.equal(ripe.withered, undefined)
  assert.equal((await store.harvest('p1')).ok, true, '成熟豌豆换季前可收')

  clock.advance(24 * HOUR_MS) // 入夏：番茄跨季但属旧六种
  const tomato = store.snapshot().plots[1]
  assert.equal(tomato.crop, 'tomato')
  assert.equal(tomato.withered, undefined)
  clock.advance(2 * HOUR_MS)
  assert.equal((await store.harvest('p2')).ok, true)
})

test('离线跨季：重开时补算生长，未熟四季作物枯萎，成熟的不枯', async (t) => {
  const dir = await tempDir(t)
  const spring = clockAt(localNoon(2026, 11, 15))
  const first = await createFarmStore(dir, { now: spring.now, market: fakeMarket() })
  spring.advance(11 * HOUR_MS + 55 * MINUTE_MS) // 23:55
  await first.buySeed('pea', 1)
  await first.plant('p1', 'pea')
  await first.buySeed('tomato', 1)
  await first.plant('p2', 'tomato')

  // 23:55 种下，次日 00:10 才重新打开：只补 15 分钟，豌豆没熟。
  const reopened = await createFarmStore(dir, {
    now: () => new Date(2026, 10, 16, 0, 10, 0).getTime(),
    market: fakeMarket()
  })
  const plots = reopened.snapshot().plots
  assert.equal(plots[0].withered, true)
  assert.equal(plots[0].grownMs, 15.5 * MINUTE_MS, '离线补算仍按分段：最后 5 分钟在春天有 1.1 倍')
  assert.equal(plots[1].withered, undefined, '旧六种不枯')
})
