/**
 * 票 41：交易所的 HTTP 集成。
 *
 * `network:false` 起一个 service，只走 `GET /dsh-zoo/state` 与
 * `POST /dsh-zoo/action`；用注入的时钟把「等 30 分钟」变成改一个变量。
 * 主流程：买种 → 种 → 收 → 卖 → 再买，硬币不为负，重启价格/历史不丢。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MARKET_FILE } from '../src/market.js'
import { MINUTE_MS } from '../src/farm-rules.js'
import { createService } from '../src/service.js'

const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-market-http-'))
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

test('HTTP：买种 → 种 → 收 → 卖 → 再买；硬币/种子/作物/行情对得上，重启不丢', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const service = makeService(t, dir, { farmNow: () => clock.value })

  // store 还没读出来时也要是完整形状，不能是 undefined。
  const early = await state(service)
  assert.equal(early.body.market.prices.tomato.base, 5)
  assert.equal(early.body.market.prices.tomato.price, 5)
  assert.deepEqual(early.body.market.history, [])
  assert.deepEqual(early.body.market.index, {})

  await service.ready
  const initial = await state(service)
  assert.equal(initial.status, 200)
  assert.equal(initial.body.market.prices.carrot.price, 6)
  assert.equal(initial.body.farm.coins, 30)

  const bought = await action(service, { action: 'buy-seed', cropId: 'tomato', qty: 1 })
  assert.equal(bought.status, 200)
  assert.equal(bought.body.ok, true)
  assert.equal(bought.body.action, 'buy-seed')
  assert.equal(bought.body.total, 6)
  assert.equal(bought.body.coins, 24)
  assert.deepEqual(bought.body.seeds, { tomato: 3 })
  assert.equal(bought.body.price, 5, '买种子不影响作物价')
  assert.match(bought.body.notice, /买了 1 颗小番茄种子/)

  const planted = await action(service, { action: 'plant', plotId: 'p1', cropId: 'tomato' })
  assert.equal(planted.body.ok, true)
  assert.deepEqual(planted.body.seeds, { tomato: 2 })

  clock.value += 30 * MINUTE_MS
  const harvested = await action(service, { action: 'harvest', plotId: 'p1' })
  assert.equal(harvested.body.ok, true)
  assert.equal(harvested.body.qty, 3)
  assert.deepEqual(harvested.body.crops, { tomato: 3 })

  const sold = await action(service, { action: 'sell-crop', cropId: 'tomato', qty: 3 })
  assert.equal(sold.body.ok, true)
  assert.equal(sold.body.unitPrice, 5, '初始价 5 → bid 5')
  assert.equal(sold.body.total, 15)
  assert.equal(sold.body.coins, 39)
  assert.deepEqual(sold.body.crops, {})
  assert.ok(sold.body.price < 5, '卖 3 个之后价格下跌')

  const rebought = await action(service, { action: 'buy-seed', cropId: 'tomato', qty: 2 })
  assert.equal(rebought.body.ok, true)
  assert.equal(rebought.body.coins, 27)
  assert.deepEqual(rebought.body.seeds, { tomato: 4 })
  assert.ok(rebought.body.coins >= 0, '硬币永远不为负')

  const after = await state(service)
  assert.equal(after.body.farm.coins, 27)
  assert.deepEqual(after.body.farm.seeds, { tomato: 4 })
  assert.deepEqual(after.body.farm.crops, {})
  assert.ok(Math.abs(after.body.market.prices.tomato.price - sold.body.price) < 1e-9)
  assert.equal(after.body.market.prices.tomato.volume24h, 6, '买 1 + 卖 3 + 买 2')
  assert.deepEqual(
    after.body.market.history.map((entry) => entry.side + ':' + entry.qty),
    ['buy:2', 'sell:3', 'buy:1'],
    '最近成交最新在前'
  )
  assert.equal(after.body.market.history.length, 3)

  const marketFile = JSON.parse(await readFile(join(dir, MARKET_FILE), 'utf8'))
  assert.equal(marketFile.version, 1)
  assert.equal(marketFile.history.length, 3)
  assert.ok(Math.abs(marketFile.prices.tomato.price - sold.body.price) < 1e-9)

  // 失败码原样从 action 返回；失败不扣钱。
  const badQty = await action(service, { action: 'buy-seed', cropId: 'tomato', qty: 100 })
  assert.equal(badQty.status, 409)
  assert.equal(badQty.body.error, 'bad-qty')
  const noCrop = await action(service, { action: 'sell-crop', cropId: 'carrot', qty: 1 })
  assert.equal(noCrop.body.error, 'no-seed')
  const noCoin = await action(service, { action: 'buy-seed', cropId: 'pumpkin', qty: 1 })
  assert.equal(noCoin.body.error, 'no-coin')
  assert.equal((await state(service)).body.farm.coins, 27)

  // 重启：同一个数据目录，价格/历史/仓库都还在。
  service.dispose()
  const restarted = makeService(t, dir, { farmNow: () => clock.value })
  await restarted.ready
  const afterRestart = await state(restarted)
  assert.equal(afterRestart.body.farm.coins, 27)
  assert.deepEqual(afterRestart.body.farm.seeds, { tomato: 4 })
  assert.equal(afterRestart.body.market.history.length, 3)
  assert.ok(Math.abs(afterRestart.body.market.prices.tomato.price - sold.body.price) < 1e-9)
})

test('HTTP：market.json 坏掉不拖垮 service；初始价 + 一条警告，成交后写出合法文件', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, MARKET_FILE), '{ 不是 JSON', 'utf8')
  const clock = { value: NOON }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  assert.equal(
    service.warnings.some((line) => line.includes('交易所')),
    true,
    '坏文件应该有一条交易所警告'
  )
  const initial = await state(service)
  assert.equal(initial.body.market.prices.tomato.price, 5)

  const bought = await action(service, { action: 'farm-buy-seed', cropId: 'tomato', qty: 1 })
  assert.equal(bought.body.ok, true, '桌面小窗的 farm-* 别名也能走 HTTP')
  const file = JSON.parse(await readFile(join(dir, MARKET_FILE), 'utf8'))
  assert.equal(file.version, 1)
  assert.equal(file.history.length, 1)
})

test('HTTP：农场 tick 也推进交易所均值回归（每 10 分钟向 base 拉 3%）', async (t) => {
  const dir = await tempDir(t)
  const now = NOON
  await writeFile(join(dir, MARKET_FILE), JSON.stringify({
    version: 1,
    prices: {
      tomato: { base: 5, price: 10, volume24h: 0, at: now },
      carrot: { base: 6, price: 6, volume24h: 0, at: now },
      pumpkin: { base: 30, price: 30, volume24h: 0, at: now }
    },
    history: [],
    index: {}
  }))
  const clock = { value: now }
  const service = makeService(t, dir, { farmNow: () => clock.value, farmTickMs: 15 })
  await service.ready
  assert.equal((await state(service)).body.market.prices.tomato.price, 10)

  clock.value += 10 * MINUTE_MS
  const deadline = Date.now() + 1000
  while (service.snapshot().market.prices.tomato.price === 10 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const price = service.snapshot().market.prices.tomato.price
  assert.ok(Math.abs(price - 9.85) < 1e-9, 'tick 应该把 10 拉回 9.85，实际 ' + price)

  // tick 的写盘是异步的：等到文件也变成回归后的价格，而不是读到上一版。
  let file = null
  const fileDeadline = Date.now() + 1000
  while (Date.now() < fileDeadline) {
    file = JSON.parse(await readFile(join(dir, MARKET_FILE), 'utf8'))
    if (Math.abs(file.prices.tomato.price - 9.85) < 1e-9) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(Math.abs(file.prices.tomato.price - 9.85) < 1e-9, '回归结果落盘')

  // 让最后几拍 tick 的异步写盘落完，避免和 tmp 目录清理抢。
  service.dispose()
  await new Promise((resolve) => setTimeout(resolve, 50))
})
