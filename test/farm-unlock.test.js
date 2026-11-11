/**
 * 票 48：地块解锁（ADR-0017）。
 *
 * 只回答四件事：地价曲线是不是单调且锚点对得上、解锁的四种失败、旧存档/锁着的地块
 * 怎么退化、以及卖价冲击的分母随规模放大。全部用真磁盘（tmpdir），不起 service/网络。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  FARM_FILE,
  FARM_VERSION,
  PLOT_IDS,
  START_COINS,
  createFarmStore,
  emptyPlot,
  initialFarmState,
  normalizeFarmFile
} from '../src/farm.js'
import {
  MAX_PLOTS,
  START_PLOTS,
  plotUnlockCost,
  visitLimitsFor
} from '../src/farm-rules.js'
import { createMarketStore, sellImpactPrice } from '../src/market.js'

const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-unlock-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

async function makeStore (dir, now = () => NOON) {
  return createFarmStore(dir, { now, log: { warn () {} } })
}

test('地价：60 起步、每块 ×1.10、取整到 5；总计 47,500，末块 4,375', () => {
  assert.equal(plotUnlockCost(START_PLOTS), 60)
  assert.equal(plotUnlockCost(9), 95)
  assert.equal(plotUnlockCost(19), 250)
  assert.equal(plotUnlockCost(29), 650)
  assert.equal(plotUnlockCost(39), 1685)
  assert.equal(plotUnlockCost(49), 4375)
  assert.equal(plotUnlockCost(MAX_PLOTS), null, '到 50 块没有下一块')
  assert.equal(plotUnlockCost(START_PLOTS - 1), null, '低于起始数不是合法输入')

  let total = 0
  let previous = 0
  for (let unlocked = START_PLOTS; unlocked < MAX_PLOTS; unlocked += 1) {
    const cost = plotUnlockCost(unlocked)
    assert.ok(Number.isInteger(cost) && cost > 0)
    assert.equal(cost % 5, 0, '地价取整到 5')
    assert.ok(cost >= previous, '地价只增不减')
    previous = cost
    total += cost
  }
  assert.equal(total, 47_500)
})

test('限额随地块放大：4 块是 3/5/10 与 3/5/5，50 块是 7/14/14 与 7/14/9', () => {
  assert.deepEqual(visitLimitsFor(4), {
    steal: { perVisitorFarm: 3, perFarmDay: 5, perVisitorDay: 10 },
    help: { perVisitorFarm: 3, perFarmDay: 5, perVisitorDay: 5 }
  })
  assert.deepEqual(visitLimitsFor(50), {
    steal: { perVisitorFarm: 7, perFarmDay: 14, perVisitorDay: 14 },
    help: { perVisitorFarm: 7, perFarmDay: 14, perVisitorDay: 9 }
  })
  // 坏值按起点算，不会把上限算成 NaN。
  assert.deepEqual(visitLimitsFor('nope').steal, visitLimitsFor(4).steal)
})

test('解锁：扣钱、加地块、写 unlock 日志；stale / no-coin / reserve / max-plots', async (t) => {
  const dir = await tempDir(t)
  const store = await makeStore(dir)

  let view = store.snapshot()
  assert.equal(view.unlocked, 4)
  assert.equal(view.maxPlots, 50)
  assert.equal(view.nextCost, 60)
  assert.deepEqual(view.plots.map((plot) => plot.id), ['p1', 'p2', 'p3', 'p4'])

  assert.equal((await store.unlockPlot(4)).error, 'no-coin', '开局 30 硬币买不起 60 的地')

  await store.addCoins(100) // 130
  const first = await store.unlockPlot(4)
  assert.equal(first.ok, true)
  assert.equal(first.unlocked, 5)
  assert.equal(first.cost, 60)
  assert.equal(first.coins, 70)
  assert.equal(first.nextCost, 65)
  assert.equal(first.plot.id, 'p5')
  view = store.snapshot()
  assert.equal(view.plots.length, 5)
  assert.equal(view.log[0].kind, 'unlock')
  assert.equal(view.log[0].cost, 60)
  assert.equal(view.log[0].plot, 5, '第几块地进 plot，不塞进 qty')
  assert.equal(view.log[0].qty, 1)

  // 第二次拿旧的 expected 来：农场已经变过，回 stale，不重复扣钱。
  const stale = await store.unlockPlot(4)
  assert.equal(stale.error, 'stale')
  assert.equal(store.snapshot().coins, 70)

  // 70 − 65 = 5 < 6：解锁后不够买一颗种子，回 reserve。
  const reserve = await store.unlockPlot(5)
  assert.equal(reserve.error, 'reserve')
  assert.equal(store.snapshot().unlocked, 5)

  await store.addCoins(1000)
  const second = await store.unlockPlot(5)
  assert.equal(second.ok, true)
  assert.equal(second.unlocked, 6)
  assert.equal(store.visitDailyLimit('steal'), 10, '6 块时跨农场偷额度仍是 10')
  assert.equal(store.visitDailyLimit('help'), 5)

  // 一路买到 50：到顶后 nextCost 为 null、再买回 max-plots。
  await store.addCoins(1_000_000)
  while (store.snapshot().unlocked < MAX_PLOTS) {
    const result = await store.unlockPlot()
    assert.equal(result.ok, true, '解锁第 ' + (store.snapshot().unlocked + 1) + ' 块')
  }
  view = store.snapshot()
  assert.equal(view.unlocked, 50)
  assert.equal(view.plots.length, 50)
  assert.equal(view.nextCost, null)
  assert.equal((await store.unlockPlot()).error, 'max-plots')
})

test('解锁落盘；旧文件没有 unlocked 时按 4 块；unlocked 大于 plots 时补齐', async (t) => {
  const dir = await tempDir(t)
  const store = await makeStore(dir)
  await store.addCoins(200)
  assert.equal((await store.unlockPlot(4)).ok, true)
  assert.equal((await store.unlockPlot(5)).ok, true)

  const reloaded = await makeStore(dir)
  assert.equal(reloaded.snapshot().unlocked, 6)
  assert.equal(reloaded.snapshot().plots.length, 6)

  // 旧文件：没有 unlocked，plots 只有 p1–p4。
  const old = initialFarmState()
  delete old.unlocked
  old.plots = PLOT_IDS.slice(0, 4).map(emptyPlot)
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ ...old, version: FARM_VERSION }), 'utf8')
  const legacy = await makeStore(dir)
  assert.equal(legacy.snapshot().unlocked, 4)
  assert.equal(legacy.snapshot().plots.length, 4)

  // 手改文件：unlocked=10，但 plots 只有 4 块 → 补齐到 10 块，前 4 块保留。
  await writeFile(join(dir, FARM_FILE), JSON.stringify({
    ...old,
    version: FARM_VERSION,
    unlocked: 10,
    plots: PLOT_IDS.slice(0, 4).map(emptyPlot)
  }), 'utf8')
  const wide = await makeStore(dir)
  assert.equal(wide.snapshot().unlocked, 10)
  assert.deepEqual(wide.snapshot().plots.map((plot) => plot.id), PLOT_IDS.slice(0, 10))
})

test('锁着的地块不能种；解锁后才能种', async (t) => {
  const dir = await tempDir(t)
  const store = await makeStore(dir)
  assert.equal((await store.plant('p5', 'tomato')).error, 'bad-plot')
  await store.addCoins(100)
  assert.equal((await store.unlockPlot()).ok, true)
  const planted = await store.plant('p5', 'tomato')
  assert.equal(planted.ok, true)
  assert.equal(planted.plotId, 'p5')
})

test('卖价冲击的分母随规模放大：50 块卖 99 个只跌 4.8%，4 块的旧手感不变', () => {
  // 4 块：卖 12 个跌 7.2%，和 ticket 41 的手感一致。
  const four = sellImpactPrice(5, 5, 12, 5 * 4)
  assert.ok(Math.abs(four - 4.64) < 1e-9)
  // 50 块：一次最多卖 99 个（单笔上限），分母 250 → 只跌 4.75%。
  const fifty = sellImpactPrice(30, 30, 99, 5 * 50)
  assert.ok(Math.abs(fifty - 28.5744) < 1e-9)
  assert.ok(fifty > 15, '不触底')
  // 同样 99 个在 4 块的深度下会砸到底价 15。
  assert.equal(sellImpactPrice(30, 30, 99, 20), 15)
  // 不传 depth 的旧调用仍是 20，行为不变。
  assert.equal(sellImpactPrice(5, 5, 12), four)
})

test('农场卖货把 5×已解锁 传给交易所：10 块时同一笔 99 个跌得更少', async (t) => {
  const makeFarm = async (unlocked) => {
    const dir = await tempDir(t)
    const state = {
      ...initialFarmState(),
      version: FARM_VERSION,
      unlocked,
      coins: 0,
      crops: { pumpkin: 99 },
      plots: PLOT_IDS.slice(0, unlocked).map(emptyPlot),
      lastTickAt: NOON,
      dewAt: NOON
    }
    await writeFile(join(dir, FARM_FILE), JSON.stringify(state), 'utf8')
    const market = await createMarketStore(dir, { now: () => NOON, log: { warn () {} } })
    const farm = await createFarmStore(dir, { now: () => NOON, log: { warn () {} }, market })
    return { farm, market }
  }

  const four = await makeFarm(4)
  const fourSold = await four.farm.sellCrop('pumpkin', 99)
  assert.equal(fourSold.ok, true)
  assert.equal(fourSold.price, 15, '4 块的深度 20：99 个直接砸到底价')

  const ten = await makeFarm(10)
  const tenSold = await ten.farm.sellCrop('pumpkin', 99)
  assert.equal(tenSold.ok, true)
  assert.ok(Math.abs(tenSold.price - 22.872) < 1e-9, '10 块的深度 50：只跌到 22.872')
  assert.ok(tenSold.price > fourSold.price)
})

test('坏 unlocked 修补回 4：越界、非整数、null 都只算一处坏值', () => {
  for (const bad of [2, 3, 51, 4.5, 'x', null]) {
    const normalized = normalizeFarmFile({ ...initialFarmState(), unlocked: bad })
    assert.equal(normalized.farm.unlocked, 4, 'unlocked=' + String(bad))
    assert.ok(normalized.repaired > 0, 'unlocked=' + String(bad) + ' 应计一次修补')
  }
})

test('锁着的地块：收/偷/帮都回 bad-plot，不只是种', async (t) => {
  const dir = await tempDir(t)
  const store = await makeStore(dir)
  assert.equal((await store.harvest('p5')).error, 'bad-plot')
  assert.equal((await store.markStolen('p5', 'device-a')).error, 'bad-plot')
  assert.equal((await store.markHelped('p5', 'device-a')).error, 'bad-plot')
  assert.equal((await store.water('p5')).error, 'bad-plot')
  assert.equal((await store.fertilize('p5')).error, 'bad-plot')
})

test('解锁算一次农场动作：重置待机锚点并落盘', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const store = await makeStore(dir, () => clock.value)
  await store.addCoins(200)
  clock.value += 10 * 60 * 1000
  assert.equal((await store.unlockPlot(4)).ok, true)
  const file = JSON.parse(await readFile(join(dir, FARM_FILE), 'utf8'))
  assert.equal(file.dewAt, clock.value)
})

test('50 块一茬全卖分两笔：相对 4 块的深度只跌约 7–9%', () => {
  const first = sellImpactPrice(30, 30, 99, 250)
  const second = sellImpactPrice(first, 30, 51, 250)
  const drop = 1 - second / 30
  assert.ok(drop > 0.07 && drop < 0.09, '跌 ' + (drop * 100).toFixed(2) + '%')
  assert.ok(second > 15, '不触底')
})
