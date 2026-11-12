/**
 * 票 59：从 `crops.json` 到能种能卖，走真实 service 启动顺序。
 *
 * 这条测试盯的是**顺序**：目录必须在交易所和农场读盘之前应用。晚一步，
 * 两种 store 都会把新作物当成未知 id 丢掉（地块归一成空地、行情里没有它），
 * 而单测各自造 store 是看不出这个问题的。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resetCropCatalog } from '../src/farm-rules.js'
import { createService } from '../src/service.js'

const MINUTE = 60 * 1000
const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()

const BLUEBERRY = {
  version: 1,
  crops: [
    { id: 'blueberry', name: '蓝莓', growMs: 90 * MINUTE, seedPrice: 30, yield: 4, base: 18 }
  ]
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-crops-e2e-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function fakeCtx () {
  const routes = []
  const logs = []
  return {
    logs,
    ctx: {
      webServer: {
        register (options) {
          routes.push(options)
          return () => {}
        }
      },
      logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) }
    },
    routes
  }
}

function makeService (t, options = {}) {
  const { ctx, routes, logs } = fakeCtx()
  const service = createService(ctx, {
    petBridge: false,
    skinServer: false,
    network: false,
    ...options
  })
  // 运行时作物表是进程级状态（生产里一个进程一个 service）：每个用例用完必须复位，
  // 否则上一条用例的 crops.json 会漏给下一条。
  t.after(() => resetCropCatalog())
  service.routes = routes
  service.logs = logs
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

const act = (service, body) => call(service, '/dsh-zoo/action', { method: 'POST', body })

test('crops.json 里的作物：启动后进行情、能买种、能种、能收', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'crops.json'), JSON.stringify(BLUEBERRY))
  const clock = { value: NOON }
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    farmNow: () => clock.value,
    marketNow: () => clock.value
  })
  await service.ready

  // 行情：新作物的底价来自 crops.json，不是内置表。
  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.market.prices.blueberry.base, 18)
  assert.equal(state.body.market.prices.blueberry.price, 18)

  // 日志里能看见"新增了几种"，出问题时不用猜。
  assert.ok(service.logs.some((line) => line.includes('本机作物目录新增 1 种：blueberry')))

  // 买种子 → 种下。
  const bought = await act(service, { action: 'farm-buy-seed', cropId: 'blueberry', qty: 1 })
  assert.equal(bought.status, 200)
  assert.equal(bought.body.ok, true, JSON.stringify(bought.body))

  const planted = await act(service, { action: 'farm-plant', plotId: 'p1', cropId: 'blueberry' })
  assert.equal(planted.body.ok, true, JSON.stringify(planted.body))

  // 快进 90 分钟：收获产量来自 crops.json（4 个），不是内置表的数字。
  clock.value += 90 * MINUTE
  const harvested = await act(service, { action: 'farm-harvest', plotId: 'p1' })
  assert.equal(harvested.body.ok, true, JSON.stringify(harvested.body))

  const after = await call(service, '/dsh-zoo/state')
  assert.equal(after.body.farm.log[0].crop, 'blueberry')
  assert.equal(after.body.farm.crops.blueberry, 4)

  // 卖得掉：交易所认这个 id，价格在 [base×0.5, base×2] 里。
  const sold = await act(service, { action: 'farm-sell-crop', cropId: 'blueberry', qty: 2 })
  assert.equal(sold.body.ok, true, JSON.stringify(sold.body))
  const final = await call(service, '/dsh-zoo/state')
  assert.equal(final.body.farm.crops.blueberry, 2)
  assert.ok(final.body.market.prices.blueberry.price < 18)
})

test('crops.json 写坏了：只用内置六种照常启动，日志留一条', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'crops.json'), '{ 不是 json')
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready
  const state = await call(service, '/dsh-zoo/state')
  assert.equal('blueberry' in state.body.market.prices, false)
  assert.deepEqual(Object.keys(state.body.market.prices).sort(),
    ['carrot', 'corn', 'grape', 'pumpkin', 'strawberry', 'tomato'])
  assert.ok(service.logs.some((line) => line.includes('crops.json')))

  // 内置作物照常能种。
  const planted = await act(service, { action: 'farm-plant', plotId: 'p1', cropId: 'tomato' })
  assert.equal(planted.body.ok, true, JSON.stringify(planted.body))
})
