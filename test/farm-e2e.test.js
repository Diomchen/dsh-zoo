/**
 * 票 39：农场的 HTTP 集成。
 *
 * `network:false` 起一个 service，只走 `GET /dsh-zoo/state` 与
 * `POST /dsh-zoo/action`；用注入的时钟把「等 30 分钟」变成改一个变量。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_HIRE,
  FARM_FILE,
  FARM_VERSION,
  PLOT_IDS,
  emptyPlot
} from '../src/farm.js'
import { CROPS, MINUTE_MS, localDayKey } from '../src/farm-rules.js'
import { createService } from '../src/service.js'

const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()
const TODAY = localDayKey(NOON)

function fakeCtx () {
  const routes = []
  const warnings = []
  return {
    ctx: {
      webServer: {
        register (options) {
          routes.push(options)
          return () => {}
        }
      },
      logger: { info () {}, warn (line) { warnings.push(line) } }
    },
    routes,
    warnings
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-farm-http-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, dir, options = {}) {
  const { ctx, routes, warnings } = fakeCtx()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktop: false,
    petBridge: false,
    ...options
  })
  service.routes = routes
  service.warnings = warnings
  t.after(() => service.dispose())
  return service
}

async function call (service, path, { method = 'GET', body } = {}) {
  const route = service.routes.find((candidate) => candidate.path === path)
  assert.ok(route, '应该注册 ' + path)
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (payload) { this.payload = payload }
  }
  const req = {
    method,
    _listeners: {},
    on (event, fn) {
      this._listeners[event] = fn
      return this
    },
    destroy () {}
  }
  const pending = route.handler(req, res)
  if (body !== undefined) {
    queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body))))
    queueMicrotask(() => req._listeners.end?.())
  }
  await pending
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}

function action (service, body) {
  return call(service, '/dsh-zoo/action', { method: 'POST', body })
}

function state (service) {
  return call(service, '/dsh-zoo/state')
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writeFarm (dir, value) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify(value), 'utf8')
}

async function readFarm (dir) {
  return JSON.parse(await readFile(join(dir, FARM_FILE), 'utf8'))
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

test('HTTP：初始农场 → 种 → 等 → 收 → 再种；硬币/种子/作物对得上，重启不丢', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const service = makeService(t, dir, { farmNow: () => clock.value })

  // store 还没读出来时也要是完整形状，不能是 undefined。
  const early = await state(service)
  assert.deepEqual(early.body.farm.plots.map((plot) => plot.id), [...PLOT_IDS])
  assert.equal(early.body.farm.coins, 30)
  assert.deepEqual(early.body.farm.seeds, { tomato: 2 })
  assert.deepEqual(early.body.farm.log, [])

  await service.ready
  const initial = await state(service)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.farm.coins, 30)
  assert.deepEqual(initial.body.farm.seeds, { tomato: 2 })
  assert.deepEqual(initial.body.farm.crops, {})
  assert.equal(initial.body.farm.dew, 0)
  assert.equal(initial.body.farm.dewEarned, 0)
  assert.deepEqual(initial.body.farm.hire, DEFAULT_HIRE)
  assert.deepEqual(initial.body.farm.plots.map((plot) => plot.crop), [null, null, null, null])
  assert.equal(initial.body.farm.guard, 0.3)
  assert.equal(initial.body.farm.worker, null)

  const planted = await action(service, { action: 'plant', plotId: 'p1', cropId: 'tomato' })
  assert.equal(planted.status, 200)
  assert.equal(planted.body.ok, true)
  assert.equal(planted.body.action, 'plant')
  assert.deepEqual(planted.body.seeds, { tomato: 1 })
  assert.equal(planted.body.plot.crop, 'tomato')
  assert.equal(planted.body.plot.grownMs, 0)
  assert.equal(planted.body.plot.growMs, CROPS.tomato.growMs)

  clock.value += 29 * MINUTE_MS
  const tooEarly = await action(service, { action: 'harvest', plotId: 'p1' })
  assert.deepEqual(tooEarly.body, { ok: false, error: 'not-mature', persisted: false })

  clock.value += MINUTE_MS
  const harvested = await action(service, { action: 'harvest', plotId: 'p1' })
  assert.equal(harvested.body.ok, true)
  assert.equal(harvested.body.qty, 3)
  assert.deepEqual(harvested.body.crops, { tomato: 3 })
  assert.equal(harvested.body.plot.crop, null)
  assert.equal(harvested.body.dew, 3, '30 分钟待机攒 3 点露水')

  const replanted = await action(service, { action: 'plant', plotId: 'p1', cropId: 'tomato' })
  assert.equal(replanted.body.ok, true)
  assert.deepEqual(replanted.body.seeds, {})
  assert.deepEqual(replanted.body.crops, { tomato: 3 })

  const noSeed = await action(service, { action: 'plant', plotId: 'p2', cropId: 'tomato' })
  assert.deepEqual(noSeed.body, { ok: false, error: 'no-seed', persisted: false })

  clock.value += 30 * MINUTE_MS
  const secondHarvest = await action(service, { action: 'harvest', plotId: 'p1' })
  assert.equal(secondHarvest.body.ok, true)
  assert.equal(secondHarvest.body.qty, 3)
  assert.deepEqual(secondHarvest.body.crops, { tomato: 6 })

  const final = await state(service)
  assert.equal(final.body.farm.coins, 30, '这一票没有买卖，硬币不动')
  assert.deepEqual(final.body.farm.seeds, {})
  assert.deepEqual(final.body.farm.crops, { tomato: 6 })
  assert.equal(final.body.farm.dew, 6)
  assert.equal(final.body.farm.dewEarned, 6, '今天已挣的露水跟着累计')
  assert.deepEqual(final.body.farm.plots.map((plot) => plot.crop), [null, null, null, null])
  assert.deepEqual(
    final.body.farm.log.map((entry) => entry.kind),
    ['harvest', 'plant', 'harvest', 'plant'],
    '日志最新在前'
  )

  const file = await readFarm(dir)
  assert.equal(file.version, FARM_VERSION)
  assert.equal(file.coins, 30)
  assert.deepEqual(file.seeds, {})
  assert.deepEqual(file.crops, { tomato: 6 })

  // 重启：同一个数据目录，作物/硬币/日志都还在。
  service.dispose()
  const restarted = makeService(t, dir, { farmNow: () => clock.value })
  await restarted.ready
  const afterRestart = await state(restarted)
  assert.equal(afterRestart.body.farm.coins, 30)
  assert.deepEqual(afterRestart.body.farm.seeds, {})
  assert.deepEqual(afterRestart.body.farm.crops, { tomato: 6 })
  assert.deepEqual(afterRestart.body.farm.plots.map((plot) => plot.crop), [null, null, null, null])
  assert.equal(afterRestart.body.farm.log.length, 4)
})

test('HTTP：六个错误码都能从 action 原样拿到', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  const badPlot = await action(service, { action: 'plant', plotId: 'p9', cropId: 'tomato' })
  assert.equal(badPlot.body.error, 'bad-plot')
  const badCrop = await action(service, { action: 'plant', plotId: 'p1', cropId: 'alien' })
  assert.equal(badCrop.body.error, 'bad-crop')
  const noSeed = await action(service, { action: 'plant', plotId: 'p1', cropId: 'pumpkin' })
  assert.equal(noSeed.body.error, 'no-seed')

  assert.equal((await action(service, { action: 'plant', plotId: 'p1', cropId: 'tomato' })).body.ok, true)
  const occupied = await action(service, { action: 'plant', plotId: 'p1', cropId: 'carrot' })
  assert.equal(occupied.body.error, 'plot-occupied')

  const notMature = await action(service, { action: 'harvest', plotId: 'p1' })
  assert.equal(notMature.body.error, 'not-mature')
  const emptyHarvest = await action(service, { action: 'harvest', plotId: 'p2' })
  assert.equal(emptyHarvest.body.error, 'not-mature')

  const noDewWater = await action(service, { action: 'water', plotId: 'p1' })
  assert.equal(noDewWater.body.error, 'no-dew')
  const noDewFertilize = await action(service, { action: 'fertilize', plotId: 'p1' })
  assert.equal(noDewFertilize.body.error, 'no-dew')

  const badWater = await action(service, { action: 'water', plotId: 'p9' })
  assert.equal(badWater.body.error, 'bad-plot')
  const badFertilize = await action(service, { action: 'fertilize', plotId: 'p9' })
  assert.equal(badFertilize.body.error, 'bad-plot')
})

test('HTTP：浇水/施肥花露水、每株一次；成熟后施肥，收获按 3+1 结算', async (t) => {
  const dir = await tempDir(t)
  const plot = {
    id: 'p1',
    crop: 'tomato',
    plantedAt: NOON,
    grownMs: 0,
    growMs: CROPS.tomato.growMs,
    waterings: 0,
    fertilized: false,
    stolenBy: [],
    helpedBy: []
  }
  await writeFarm(dir, {
    version: FARM_VERSION,
    coins: 30,
    seeds: { tomato: 1 },
    crops: {},
    dew: 10,
    dewEarned: 10,
    dewAt: NOON,
    dewDay: TODAY,
    dewDayEarned: TODAY,
    lastTickAt: NOON,
    plots: [plot, emptyPlot('p2'), emptyPlot('p3'), emptyPlot('p4')],
    hire: { ...DEFAULT_HIRE },
    log: []
  })

  const clock = { value: NOON }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  const watered = await action(service, { action: 'water', plotId: 'p1' })
  assert.equal(watered.body.ok, true)
  assert.equal(watered.body.dew, 9)
  assert.equal(watered.body.plot.waterings, 1)
  assert.equal(watered.body.plot.grownMs, Math.floor(CROPS.tomato.growMs * 0.1))

  const twice = await action(service, { action: 'water', plotId: 'p1' })
  assert.equal(twice.body.error, 'already-watered', '每株只能浇一次')

  const fertilized = await action(service, { action: 'fertilize', plotId: 'p1' })
  assert.equal(fertilized.body.ok, true)
  assert.equal(fertilized.body.dew, 4)
  assert.equal(fertilized.body.plot.fertilized, true)

  const twiceFertilize = await action(service, { action: 'fertilize', plotId: 'p1' })
  assert.equal(twiceFertilize.body.error, 'already-fertilized', '每株只能施一次')

  clock.value += 30 * MINUTE_MS
  const harvested = await action(service, { action: 'harvest', plotId: 'p1' })
  assert.equal(harvested.body.ok, true)
  assert.equal(harvested.body.qty, 4)
  assert.deepEqual(harvested.body.crops, { tomato: 4 })
})

test('HTTP：farm.log 最多 50 条，状态出口只给最近 20 条', async (t) => {
  const dir = await tempDir(t)
  const log = Array.from({ length: 25 }, (_, index) => ({
    at: NOON + index,
    kind: 'harvest',
    crop: 'tomato',
    qty: 1
  }))
  await writeFarm(dir, {
    version: FARM_VERSION,
    coins: 30,
    seeds: { tomato: 2 },
    crops: {},
    dew: 0,
    dewEarned: 0,
    dewAt: NOON,
    dewDay: TODAY,
    dewDayEarned: TODAY,
    lastTickAt: NOON,
    plots: [emptyPlot('p1'), emptyPlot('p2'), emptyPlot('p3'), emptyPlot('p4')],
    hire: { ...DEFAULT_HIRE },
    log
  })

  const service = makeService(t, dir, { farmNow: () => NOON })
  await service.ready
  const farm = (await state(service)).body.farm
  assert.equal(farm.log.length, 20)
  assert.equal(farm.log[0].at, NOON + 24, '最新在前')
  assert.equal(farm.log.at(-1).at, NOON + 5)
})

test('HTTP：坏 farm.json 不拖垮 service；初始农场 + 一条警告，动作后写出合法文件', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, FARM_FILE), '{ 不是 JSON', 'utf8')
  const clock = { value: NOON }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  assert.equal(
    service.warnings.some((line) => line.includes('农场')),
    true,
    '坏文件应该有一条农场警告'
  )
  const stateAfter = await state(service)
  assert.equal(stateAfter.body.farm.coins, 30)
  assert.deepEqual(stateAfter.body.farm.seeds, { tomato: 2 })

  const planted = await action(service, { action: 'plant', plotId: 'p1', cropId: 'tomato' })
  assert.equal(planted.body.ok, true)
  const file = await readFarm(dir)
  assert.equal(file.version, FARM_VERSION)
  assert.equal(file.plots[0].crop, 'tomato')
})

test('HTTP：60 秒 tick 的接线（测试用 15ms 节拍）会推进生长与露水', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const service = makeService(t, dir, { farmNow: () => clock.value, farmTickMs: 15 })
  await service.ready
  assert.equal((await action(service, { action: 'plant', plotId: 'p1', cropId: 'tomato' })).body.ok, true)

  clock.value += 10 * MINUTE_MS
  const deadline = Date.now() + 1000
  while (service.snapshot().farm.dew < 1 && Date.now() < deadline) await delay(10)

  const farm = service.snapshot().farm
  assert.equal(farm.dew, 1)
  assert.equal(farm.dewEarned, 1)
  assert.equal(farm.plots[0].grownMs, 10 * MINUTE_MS)

  // 让最后几拍 tick 的异步写盘落完，避免和 tmp 目录清理抢。
  service.dispose()
  await delay(50)
})
