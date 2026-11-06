/**
 * 票 39：农场 store（`<dataDir>/farm.json`）。
 *
 * 只回答四件事：初始农场长什么样、坏文件怎么降级、生长/露水怎么推进、
 * 四个动作怎么扣种子/硬币/露水并落盘。全部用真磁盘（tmpdir），不起 service/网络。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_HIRE,
  FARM_FILE,
  FARM_VERSION,
  MAX_COINS,
  MAX_FARM_LOG,
  MAX_STACK,
  PLOT_IDS,
  START_COINS,
  START_SEEDS,
  createFarmStore,
  emptyPlot,
  initialFarmState,
  normalizeFarmFile
} from '../src/farm.js'
import {
  CROPS,
  HOUR_MS,
  MAX_DEW,
  MINUTE_MS,
  isMature,
  localDayKey
} from '../src/farm-rules.js'

const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()
const TODAY = localDayKey(NOON)

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-farm-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function logSink () {
  const warnings = []
  return { warnings, log: { warn (line) { warnings.push(line) } } }
}

function makeClock (start = NOON) {
  let value = start
  return {
    now: () => value,
    set (next) { value = next },
    advance (ms) { value += ms }
  }
}

function plantedPlot (id, crop, overrides = {}) {
  return {
    id,
    crop,
    plantedAt: NOON,
    grownMs: 0,
    growMs: CROPS[crop].growMs,
    waterings: 0,
    fertilized: false,
    stolenBy: [],
    helpedBy: [],
    ...overrides
  }
}

function farmFile (overrides = {}) {
  return {
    version: FARM_VERSION,
    coins: START_COINS,
    seeds: { ...START_SEEDS },
    crops: {},
    dew: 0,
    dewEarned: 0,
    dewAt: NOON,
    dewDay: TODAY,
    dewDayEarned: TODAY,
    lastTickAt: NOON,
    plots: PLOT_IDS.map(emptyPlot),
    hire: { ...DEFAULT_HIRE },
    log: [],
    ...overrides
  }
}

async function writeFarm (dir, value) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify(value), 'utf8')
}

async function readFarm (dir) {
  return JSON.parse(await readFile(join(dir, FARM_FILE), 'utf8'))
}

// ---------------------------------------------------------------------------
// 初始 / 归一化
// ---------------------------------------------------------------------------

test('初始农场：4 空地、30 硬币、2 番茄种子；缺文件不告警、不落盘', async (t) => {
  const dir = await tempDir(t)
  const { warnings, log } = logSink()
  const store = await createFarmStore(dir, { log, now: makeClock().now })
  const view = store.snapshot()

  assert.deepEqual(view.plots.map((plot) => plot.id), ['p1', 'p2', 'p3', 'p4'])
  for (const plot of view.plots) {
    assert.equal(plot.crop, null)
    assert.equal(plot.grownMs, 0)
    assert.equal(plot.growMs, 0)
    assert.deepEqual(plot.stolenBy, [])
    assert.deepEqual(plot.helpedBy, [])
  }
  assert.equal(view.coins, 30)
  assert.deepEqual(view.seeds, { tomato: 2 })
  assert.deepEqual(view.crops, {})
  assert.equal(view.dew, 0)
  assert.equal(view.dewEarned, 0)
  assert.deepEqual(view.hire, DEFAULT_HIRE)
  assert.deepEqual(view.log, [])
  assert.deepEqual(warnings, [])
  // 没有动作/ tick 之前不写文件：和 backpack.json 同一条约定。
  await assert.rejects(readFile(join(dir, FARM_FILE), 'utf8'), /ENOENT/)
})

test('initialFarmState：每次都是全新的数组/对象，改一份不会污染下一份', () => {
  const first = initialFarmState()
  first.plots[0].stolenBy.push('a')
  first.seeds.tomato = 99
  first.hire.enabled = true
  const second = initialFarmState()
  assert.deepEqual(second.plots[0].stolenBy, [])
  assert.deepEqual(second.seeds, { tomato: 2 })
  assert.equal(second.hire.enabled, false)
})

test('normalizeFarmFile：损坏整份 → 初始农场；字段/地块/日志各自夹取并计数', () => {
  for (const bad of [null, 42, 'x', [], { version: 2 }]) {
    const normalized = normalizeFarmFile(bad)
    assert.equal(normalized.corrupt, true, JSON.stringify(bad))
    assert.equal(normalized.farm.coins, START_COINS)
    assert.equal(normalized.farm.plots.length, 4)
    assert.deepEqual(normalized.farm.seeds, { tomato: 2 })
  }

  const normalized = normalizeFarmFile({
    version: FARM_VERSION,
    coins: 5_000_000,
    seeds: { tomato: 5000, carrot: -2, pumpkin: 'x', alien: 3 },
    crops: { tomato: 1200, carrot: 0 },
    dew: 99,
    dewEarned: 99,
    dewAt: 0,
    dewDay: '2026/05/06',
    dewDayEarned: '2026/05/06',
    lastTickAt: 'nope',
    plots: [
      null,
      { id: 'p1', crop: 'alien' },
      plantedPlot('p2', 'tomato', {
        grownMs: 99 * HOUR_MS,
        waterings: 9,
        stolenBy: ['a', 'a', 42],
        helpedBy: []
      }),
      plantedPlot('p3', 'carrot', { fertilized: 'yes', growMs: 999 * 24 * HOUR_MS }),
      plantedPlot('p4', 'pumpkin')
    ],
    hire: { enabled: true, wagePerHour: 999, minHours: 9, maxHours: 1 },
    log: Array.from({ length: MAX_FARM_LOG + 10 }, (_, index) => ({
      at: NOON + index,
      kind: 'harvest',
      crop: 'tomato',
      qty: 1
    }))
  })

  assert.equal(normalized.corrupt, false)
  assert.ok(normalized.repaired > 0)
  assert.equal(normalized.farm.coins, MAX_COINS)
  assert.deepEqual(normalized.farm.seeds, { tomato: MAX_STACK })
  assert.deepEqual(normalized.farm.crops, { tomato: MAX_STACK })
  assert.equal(normalized.farm.dew, MAX_DEW)
  assert.equal(normalized.farm.dewEarned, MAX_DEW)
  assert.equal(normalized.farm.dewAt, null)
  assert.equal(normalized.farm.dewDay, null)
  assert.equal(normalized.farm.dewDayEarned, null)
  assert.equal(normalized.farm.lastTickAt, null)
  assert.deepEqual(normalized.farm.plots.map((plot) => plot.id), ['p1', 'p2', 'p3', 'p4'])
  assert.equal(normalized.farm.plots[0].crop, null, '坏作物整块回空地')
  assert.equal(normalized.farm.plots[1].crop, 'tomato')
  assert.equal(normalized.farm.plots[1].grownMs, CROPS.tomato.growMs, 'grownMs 夹到 growMs')
  assert.equal(normalized.farm.plots[1].waterings, 1, '每株只浇一次')
  assert.deepEqual(normalized.farm.plots[1].stolenBy, ['a'])
  assert.equal(normalized.farm.plots[2].fertilized, false, '非布尔 true 不算施肥')
  assert.equal(normalized.farm.hire.enabled, true)
  assert.equal(normalized.farm.hire.wagePerHour, 100)
  assert.equal(normalized.farm.hire.minHours, 8)
  assert.equal(normalized.farm.hire.maxHours, 8, 'max 不能小于 min')
  assert.equal(normalized.farm.log.length, MAX_FARM_LOG)
  assert.equal(normalized.farm.log[0].at, NOON + MAX_FARM_LOG + 9, '日志最新在前')
})

test('normalizeFarmFile：旧文件没有 dewEarned 时，当前余额计进今天已挣', () => {
  const normalized = normalizeFarmFile({ version: FARM_VERSION, dew: 10 })
  assert.equal(normalized.corrupt, false)
  assert.equal(normalized.farm.dew, 10)
  assert.equal(normalized.farm.dewEarned, 10)
})

// ---------------------------------------------------------------------------
// 动作：种 / 收 / 浇 / 施肥
// ---------------------------------------------------------------------------

test('种 → 等 → 收 → 再种：种子/作物对得上，写入是 tmp+rename', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const store = await createFarmStore(dir, { log: logSink().log, now: clock.now })

  const planted = await store.plant('p1', 'tomato')
  assert.equal(planted.ok, true)
  assert.equal(planted.action, 'plant')
  assert.deepEqual(planted.seeds, { tomato: 1 })
  assert.equal(planted.crop, 'tomato')
  assert.equal(planted.persisted, true)

  const file = await readFarm(dir)
  assert.equal(file.version, FARM_VERSION)
  assert.equal(file.seeds.tomato, 1)
  assert.equal(file.plots[0].crop, 'tomato')
  assert.equal(file.plots[0].growMs, CROPS.tomato.growMs)
  assert.equal(file.plots[0].grownMs, 0)
  // tmp + rename：目录里只留最终文件，没有 .tmp-*。
  assert.deepEqual(await readdir(dir), [FARM_FILE])

  clock.advance(29 * MINUTE_MS)
  assert.equal((await store.harvest('p1')).error, 'not-mature')
  clock.advance(MINUTE_MS)

  const harvested = await store.harvest('p1')
  assert.equal(harvested.ok, true)
  assert.equal(harvested.qty, 3)
  assert.deepEqual(harvested.crops, { tomato: 3 })
  assert.equal(harvested.plot.crop, null)
  assert.equal(store.snapshot().plots[0].crop, null)
  assert.equal(store.snapshot().log[0].kind, 'harvest')

  const replanted = await store.plant('p1', 'tomato')
  assert.equal(replanted.ok, true)
  assert.deepEqual(replanted.seeds, {})
  assert.equal(replanted.crops.tomato, 3)
  assert.equal((await store.plant('p2', 'tomato')).error, 'no-seed')

  const fileAfter = await readFarm(dir)
  assert.deepEqual(fileAfter.seeds, {})
  assert.deepEqual(fileAfter.crops, { tomato: 3 })
  assert.equal(fileAfter.plots[0].crop, 'tomato')
  assert.equal(fileAfter.log.length, 3, 'plant / harvest / plant')
})

test('动作错误码：bad-plot / plot-occupied / bad-crop / no-seed / not-mature / no-dew', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const store = await createFarmStore(dir, { log: logSink().log, now: clock.now })

  assert.equal((await store.plant('p9', 'tomato')).error, 'bad-plot')
  assert.equal((await store.plant('p1', 'alien')).error, 'bad-crop')
  assert.equal((await store.plant('p1', 'pumpkin')).error, 'no-seed')
  assert.equal((await store.plant('p1', 'tomato')).ok, true)
  assert.equal((await store.plant('p1', 'carrot')).error, 'plot-occupied')
  assert.equal((await store.harvest('p1')).error, 'not-mature')

  // 种下那一刻 dewAt 被重置：0 露水时浇水/施肥都明确 no-dew。
  assert.equal((await store.water('p1')).error, 'no-dew')
  assert.equal((await store.fertilize('p1')).error, 'no-dew')

  // 待机 10 分钟攒 1 点：浇一次成功，第二次 already-watered。
  clock.advance(10 * MINUTE_MS)
  const watered = await store.water('p1')
  assert.equal(watered.ok, true)
  assert.equal(watered.dew, 0)
  assert.equal(watered.plot.waterings, 1)
  assert.equal((await store.water('p1')).error, 'already-watered')
  assert.equal((await store.water('p2')).error, 'bad-plot', '空地不可浇')

  // 5 小时后作物已成熟，但施肥仍可用（收获前最后一个加成）。
  clock.advance(5 * HOUR_MS)
  await store.tick()
  const fertilized = await store.fertilize('p1')
  assert.equal(fertilized.ok, true)
  assert.equal(fertilized.dew, 25)
  assert.equal(fertilized.plot.fertilized, true)
  assert.equal((await store.fertilize('p1')).error, 'already-fertilized')
  assert.equal((await store.water('p1')).error, 'bad-plot', '成熟地不可浇')

  clock.advance(30 * MINUTE_MS)
  const harvested = await store.harvest('p1')
  assert.equal(harvested.qty, 4, '3 + 施肥 1')
})

test('收获被偷扣减、最低 0；仓库到 999 就夹取，不出现负数', async (t) => {
  const dir = await tempDir(t)
  const matured = plantedPlot('p1', 'tomato', {
    grownMs: CROPS.tomato.growMs,
    stolenBy: ['a', 'b', 'c', 'd'],
    helpedBy: ['a']
  })
  await writeFarm(dir, farmFile({
    crops: { tomato: 998 },
    plots: [matured, emptyPlot('p2'), emptyPlot('p3'), emptyPlot('p4')]
  }))
  const store = await createFarmStore(dir, { log: logSink().log, now: makeClock().now })

  const harvested = await store.harvest('p1')
  assert.equal(harvested.ok, true)
  assert.equal(harvested.qty, 0, '被偷 4 > 产量 3')
  assert.deepEqual(store.snapshot().crops, { tomato: 998 }, '0 产量不改变仓库')

  const matured2 = plantedPlot('p1', 'tomato', { grownMs: CROPS.tomato.growMs })
  await writeFarm(dir, farmFile({
    crops: { tomato: 998 },
    plots: [matured2, emptyPlot('p2'), emptyPlot('p3'), emptyPlot('p4')]
  }))
  const store2 = await createFarmStore(dir, { log: logSink().log, now: makeClock().now })
  const harvested2 = await store2.harvest('p1')
  assert.equal(harvested2.qty, 3)
  assert.deepEqual(store2.snapshot().crops, { tomato: MAX_STACK })
})

test('并发动作串行落盘：两块地同时种下不会互相写掉', async (t) => {
  const dir = await tempDir(t)
  const store = await createFarmStore(dir, { log: logSink().log, now: makeClock().now })
  const [first, second] = await Promise.all([
    store.plant('p1', 'tomato'),
    store.plant('p2', 'tomato')
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual(store.snapshot().seeds, {})

  const file = await readFarm(dir)
  assert.equal(file.plots[0].crop, 'tomato')
  assert.equal(file.plots[1].crop, 'tomato')
  assert.deepEqual(file.seeds, {})
})

// ---------------------------------------------------------------------------
// 生长 / 露水 / 离线
// ---------------------------------------------------------------------------

test('tick：每 10 分钟 +1 露水，8 小时到 48 封顶；跨本地午夜归零', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const store = await createFarmStore(dir, { log: logSink().log, now: clock.now })
  assert.equal(store.snapshot().dew, 0)

  clock.advance(10 * MINUTE_MS)
  await store.tick()
  assert.equal(store.snapshot().dew, 1)
  assert.equal(store.snapshot().dewEarned, 1)

  clock.advance(8 * HOUR_MS)
  await store.tick()
  assert.equal(store.snapshot().dew, MAX_DEW)
  assert.equal(store.snapshot().dewEarned, MAX_DEW)

  clock.advance(2 * HOUR_MS)
  await store.tick()
  assert.equal(store.snapshot().dew, MAX_DEW, '到顶后不再涨')

  // 跨日：23:50 开始，00:10 这一拍把余额清掉，再从 0 重新攒。
  const secondDir = await tempDir(t)
  const late = new Date(2026, 4, 6, 23, 50, 0).getTime()
  const lateClock = makeClock(late)
  const lateStore = await createFarmStore(secondDir, { log: logSink().log, now: lateClock.now })
  lateClock.advance(20 * MINUTE_MS)
  await lateStore.tick()
  assert.equal(lateStore.snapshot().dew, 0, '跨本地午夜归零')
  lateClock.advance(10 * MINUTE_MS)
  await lateStore.tick()
  assert.equal(lateStore.snapshot().dew, 1)
})

test('露水日上限按已挣算：余额花光也不补；跨本地日才恢复', async (t) => {
  const dir = await tempDir(t)
  await writeFarm(dir, farmFile({
    dew: 0,
    dewEarned: MAX_DEW,
    dewAt: NOON,
    dewDay: TODAY,
    dewDayEarned: TODAY,
    lastTickAt: NOON
  }))
  const clock = makeClock(NOON)
  const store = await createFarmStore(dir, { log: logSink().log, now: clock.now })

  clock.advance(10 * MINUTE_MS)
  await store.tick()
  assert.equal(store.snapshot().dew, 0, '今天已挣满 48，花光也刷不出新的')
  assert.equal(store.snapshot().dewEarned, MAX_DEW)
  const raw = await readFarm(dir)
  assert.equal(raw.dewEarned, MAX_DEW, 'dewEarned 跟 farm.json 一起落盘')
  assert.equal(raw.dewDayEarned, TODAY)

  const nextNoon = new Date(2026, 4, 7, 12, 0, 0).getTime()
  clock.set(nextNoon)
  await store.tick()
  assert.equal(store.snapshot().dew, 0, '跨日这一拍只重置')
  assert.equal(store.snapshot().dewEarned, 0)

  clock.advance(10 * MINUTE_MS)
  await store.tick()
  assert.equal(store.snapshot().dew, 1)
  assert.equal(store.snapshot().dewEarned, 1)
})

test('离线生长：补 min(now − lastTickAt, 12h)，成熟即停，不枯萎；离线不攒露水', async (t) => {
  const dir = await tempDir(t)
  // 手写一块 24h 的南瓜地：12h 上限才能和「一次补 24h」区分开。
  await writeFarm(dir, farmFile({
    dew: 0,
    dewAt: NOON,
    dewDay: TODAY,
    lastTickAt: NOON,
    plots: [
      plantedPlot('p1', 'pumpkin', { growMs: 24 * HOUR_MS }),
      emptyPlot('p2'),
      emptyPlot('p3'),
      emptyPlot('p4')
    ]
  }))
  const clock = makeClock(NOON + 24 * HOUR_MS)
  const store = await createFarmStore(dir, { log: logSink().log, now: clock.now })

  const plot = store.snapshot().plots[0]
  assert.equal(plot.grownMs, 12 * HOUR_MS, '离线最多补 12h')
  assert.equal(isMature(plot), false)
  assert.equal(store.snapshot().dew, 0, '关掉 DSH 的时间不算待机')

  const file = await readFarm(dir)
  assert.equal(file.plots[0].grownMs, 12 * HOUR_MS, '补出来的生长立刻落盘')
  assert.equal(file.lastTickAt, NOON + 24 * HOUR_MS)

  // 重新打开后待机从这一刻算：10 分钟才 +1。
  clock.advance(10 * MINUTE_MS)
  await store.tick()
  assert.equal(store.snapshot().dew, 1)
})

test('离线跨日：dewDay 不同 → 露水归零；成熟地块再过多久都不掉产量', async (t) => {
  const dir = await tempDir(t)
  const mature = plantedPlot('p1', 'tomato', { grownMs: CROPS.tomato.growMs })
  await writeFarm(dir, farmFile({
    dew: 20,
    dewAt: NOON,
    dewDay: TODAY,
    lastTickAt: NOON,
    plots: [mature, emptyPlot('p2'), emptyPlot('p3'), emptyPlot('p4')]
  }))
  const tomorrow = NOON + 24 * HOUR_MS
  const store = await createFarmStore(dir, { log: logSink().log, now: makeClock(tomorrow).now })
  assert.equal(store.snapshot().dew, 0)
  assert.equal(store.snapshot().plots[0].grownMs, CROPS.tomato.growMs)
  assert.equal(store.snapshot().plots[0].crop, 'tomato')
  const file = await readFarm(dir)
  assert.equal(file.dewDay, localDayKey(tomorrow))
  assert.equal(file.dew, 0)
})

test('重启：种下的地/种子/日志都在；离线那段时间按 12h 规则补', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const first = await createFarmStore(dir, { log: logSink().log, now: clock.now })
  await first.plant('p1', 'tomato')
  clock.advance(10 * MINUTE_MS)

  const second = await createFarmStore(dir, { log: logSink().log, now: clock.now })
  assert.equal(second.snapshot().plots[0].crop, 'tomato')
  assert.equal(second.snapshot().plots[0].grownMs, 10 * MINUTE_MS)
  assert.deepEqual(second.snapshot().seeds, { tomato: 1 })
  assert.equal(second.snapshot().log[0].kind, 'plant')
  assert.equal(second.snapshot().dew, 0, '重启不补离线露水')
})

// ---------------------------------------------------------------------------
// 坏文件 / 告警只一次
// ---------------------------------------------------------------------------

test('坏 JSON：初始农场 + 只告警一次；之后动作仍写出合法文件', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, FARM_FILE), '{ 不是 JSON', 'utf8')
  const { warnings, log } = logSink()
  const clock = makeClock()
  const store = await createFarmStore(dir, { log, now: clock.now })

  assert.deepEqual(store.snapshot().plots.map((plot) => plot.crop), [null, null, null, null])
  assert.equal(store.snapshot().coins, START_COINS)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /农场/)

  assert.equal((await store.plant('p1', 'tomato')).ok, true)
  assert.equal(warnings.length, 1, '同一个原因不重复告警')
  const file = await readFarm(dir)
  assert.equal(file.version, FARM_VERSION)
  assert.equal(file.plots[0].crop, 'tomato')
})

test('形状不对：坏字段/坏地块/坏日志只修不崩，且只告警一次', async (t) => {
  const dir = await tempDir(t)
  await writeFarm(dir, farmFile({
    coins: 'oops',
    seeds: { tomato: 'x' },
    plots: [null, { id: 'p9', crop: 'tomato' }, { id: 'p1', crop: 'alien' }],
    log: [null, { at: 0, kind: 'harvest' }, { at: NOON, kind: 'unknown' }]
  }))
  const { warnings, log } = logSink()
  const store = await createFarmStore(dir, { log, now: makeClock().now })

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /农场里有 \d+ 处/)
  assert.equal(store.snapshot().coins, START_COINS)
  assert.deepEqual(store.snapshot().seeds, {}, '坏计数丢掉，不白送种子')
  assert.deepEqual(store.snapshot().plots.map((plot) => plot.id), ['p1', 'p2', 'p3', 'p4'])
  assert.deepEqual(store.snapshot().log, [])
})

// ---------------------------------------------------------------------------
// ticket 43：访客相关的仓库动作、偷/帮落账、每日计数
// ---------------------------------------------------------------------------

const VISITOR_A = '11111111-1111-4111-8111-111111111111'
const VISITOR_B = '22222222-2222-4222-8222-222222222222'

test('访客仓库：addCrop / addCoins / spendDew / refundDew 都落盘并夹上限', async (t) => {
  const dir = await tempDir(t)
  const store = await createFarmStore(dir, { now: makeClock().now })

  assert.deepEqual(await store.addCrop('tomato', 2), {
    ok: true, action: 'add-crop', crop: 'tomato', qty: 2,
    crops: { tomato: 2 }, persisted: true
  })
  assert.deepEqual((await store.addCrop('tomato', 999)).crops, { tomato: MAX_STACK })
  assert.equal((await store.addCrop('alien', 1)).error, 'bad-crop')

  const coins = await store.addCoins(5)
  assert.equal(coins.ok, true)
  assert.equal(coins.coins, START_COINS + 5)
  assert.equal((await readFarm(dir)).coins, START_COINS + 5)

  // 露水不够不扣；够则扣；退款封顶 48。
  assert.equal((await store.spendDew(1)).error, 'no-dew')
  await store.addCoins(1)
  await store.refundDew(3)
  assert.equal(store.snapshot().dew, 3)
  assert.equal((await store.spendDew(2)).dew, 1)
  await store.refundDew(99)
  assert.equal(store.snapshot().dew, MAX_DEW)
})

test('markStolen：成熟才可偷、同一访客同一块只一次、日志带 who、stolenBy 让收获 −1', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const mature = plantedPlot('p1', 'tomato', { grownMs: CROPS.tomato.growMs })
  await writeFarm(dir, farmFile({ plots: [mature, ...PLOT_IDS.slice(1).map(emptyPlot)] }))
  const store = await createFarmStore(dir, { now: clock.now })

  // 未成熟 / 空地 → not-mature / bad-plot。
  assert.equal((await store.markStolen('p2', VISITOR_A)).error, 'bad-plot')
  // 成功。
  const stolen = await store.markStolen('p1', VISITOR_A, { who: '  楼上的 柯基 ' })
  assert.equal(stolen.ok, true)
  assert.equal(stolen.crop, 'tomato')
  assert.equal(stolen.qty, 1)
  assert.equal(stolen.yield, CROPS.tomato.yield - 1)
  assert.deepEqual(stolen.plot.stolenBy, [VISITOR_A])
  assert.equal(store.snapshot().log[0].kind, 'steal')
  assert.equal(store.snapshot().log[0].who, '楼上的 柯基')
  assert.equal((await readFarm(dir)).plots[0].stolenBy[0], VISITOR_A)

  // 同一访客同一块地：already-stolen；换个访客可以继续偷。
  assert.equal((await store.markStolen('p1', VISITOR_A)).error, 'already-stolen')
  const second = await store.markStolen('p1', VISITOR_B)
  assert.equal(second.ok, true)
  assert.equal(second.yield, CROPS.tomato.yield - 2)
  // 同一访客在不同地块：仍可偷（本块地判定与日限额是两件事）。
})

test('markStolen 日限额：3/访客/农场、5/农场；被抓只写日志不占次数', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const plots = PLOT_IDS.map((id) => plantedPlot(id, 'tomato', { grownMs: CROPS.tomato.growMs }))
  await writeFarm(dir, farmFile({ plots }))
  const store = await createFarmStore(dir, { now: clock.now })

  // 被抓：不标 stolenBy、不占次数，但日志有 qty 0 + who。
  const caught = await store.markStolen('p1', VISITOR_A, { who: '阿蟹', caught: true })
  assert.deepEqual(caught, { ok: false, error: 'guard', caught: true, crop: 'tomato', qty: 0, persisted: true })
  assert.deepEqual(store.snapshot().plots[0].stolenBy, [])
  assert.equal(store.snapshot().log[0].qty, 0)
  assert.equal(store.snapshot().log[0].who, '阿蟹')

  // 3 次成功（p1/p2/p3）后这位访客在第 4 块地被 cap。
  assert.equal((await store.markStolen('p1', VISITOR_A)).ok, true)
  assert.equal((await store.markStolen('p2', VISITOR_A)).ok, true)
  assert.equal((await store.markStolen('p3', VISITOR_A)).ok, true)
  assert.equal((await store.markStolen('p4', VISITOR_A)).error, 'cap')

  // 农场总上限 5：B 偷两块后到 5，C 也被 cap。
  assert.equal((await store.markStolen('p4', VISITOR_B)).ok, true)
  assert.equal((await store.markStolen('p3', VISITOR_B)).ok, true)
  assert.equal((await store.markStolen('p2', '33333333-3333-4333-8333-333333333333')).error, 'cap')

  const limits = store.visitLimits(VISITOR_A)
  assert.equal(limits.steal.perVisit, 3)
  assert.equal(limits.steal.usedInVisit, 3)
  assert.equal(limits.steal.usedOnFarm, 5)
})

test('markHelped：生长中才可帮、+10% 不改 waterings、每块地一次、日志带 who', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const growing = plantedPlot('p1', 'tomato', { grownMs: 1000 })
  const mature = plantedPlot('p2', 'tomato', { grownMs: CROPS.tomato.growMs })
  const empty = emptyPlot('p3')
  await writeFarm(dir, farmFile({ plots: [growing, mature, empty, emptyPlot('p4')] }))
  const store = await createFarmStore(dir, { now: clock.now })

  const helped = await store.markHelped('p1', VISITOR_A, { who: '阿蟹' })
  assert.equal(helped.ok, true)
  const plot = store.snapshot().plots[0]
  assert.equal(plot.grownMs, 1000 + Math.floor(CROPS.tomato.growMs * 0.1))
  assert.equal(plot.waterings, 0)
  assert.deepEqual(plot.helpedBy, [VISITOR_A])
  assert.equal(store.snapshot().log[0].kind, 'help')
  assert.equal(store.snapshot().log[0].who, '阿蟹')

  assert.equal((await store.markHelped('p1', VISITOR_A)).error, 'already-helped')
  assert.equal((await store.markHelped('p2', VISITOR_A)).error, 'bad-plot')
  assert.equal((await store.markHelped('p3', VISITOR_A)).error, 'bad-plot')
})

test('访客本机日计数：偷 10 / 帮 5 封顶，跨本地日重置', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const store = await createFarmStore(dir, { now: clock.now })

  for (let i = 1; i <= 10; i += 1) {
    assert.equal((await store.noteVisitAction('steal')).ok, true, String(i))
  }
  assert.equal((await store.noteVisitAction('steal')).error, 'cap')
  for (let i = 1; i <= 5; i += 1) {
    assert.equal((await store.noteVisitAction('help')).ok, true, String(i))
  }
  assert.equal((await store.noteVisitAction('help')).error, 'cap')
  assert.equal(store.visitActionUsed('steal'), 10)
  assert.equal(store.visitActionUsed('help'), 5)

  // 跨本地日：计数归零（写动作会先 #advance 到新的一天）。
  clock.advance(24 * HOUR_MS)
  assert.equal(store.visitActionUsed('steal'), 0)
  assert.equal((await store.noteVisitAction('steal')).ok, true)
})
