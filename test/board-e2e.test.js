/**
 * 票 79：盘口的 host e2e（本地 HTTP + 假时钟，不联网）。
 *
 * 走的就是真实玩家路径：`GET /dsh-zoo/state` 看价 → `POST /dsh-zoo/action`
 * 开一手 → 时钟推到收盘 → `trading-refresh` 结算 → 硬币/历史/`trading.json` 对账。
 * 不 sleep：等 15 分钟就是改一个变量。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FARM_FILE } from '../src/farm.js'
import { resetCropCatalog } from '../src/farm-rules.js'
import { createService } from '../src/service.js'
import { SLOT_MS, TICK_MS, settlementOf, slotClosePrice, slotIndexAt, weekStartOf } from '../src/trading-rules.js'
import { TRADING_FILE } from '../src/trading.js'

const SLOT_EDGE = 1763308800000
const OPEN_AT = SLOT_EDGE + 5 * TICK_MS

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-board-e2e-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

async function seedFarm (dir, coins) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins }), 'utf8')
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

function state (service) {
  return call(service, '/dsh-zoo/state')
}

function action (service, body) {
  return call(service, '/dsh-zoo/action', { method: 'POST', body })
}

async function readTrading (dir) {
  return JSON.parse(await readFile(join(dir, TRADING_FILE), 'utf8'))
}

test('票 79 e2e：看价 → 开一手 → 收盘结算 → 硬币/历史/存档对得上，重启不丢', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: OPEN_AT }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  // 1) 看价：一根 15 分钟，开盘/现价/倒计时都由宿主算好。
  const before = await state(service)
  assert.equal(before.body.farm.coins, 500)
  assert.equal(before.body.trading.coins.available, 500)
  assert.equal(before.body.trading.coins.locked, 0)
  assert.equal(before.body.trading.bar.crop, 'tomato')
  assert.equal(before.body.trading.bar.slot, slotIndexAt(OPEN_AT))
  assert.equal(before.body.trading.bar.end - before.body.trading.bar.start, SLOT_MS)
  assert.equal(before.body.trading.bar.remainingMs, SLOT_MS - 5 * TICK_MS)
  assert.ok(before.body.trading.bar.price > 0)
  assert.deepEqual(before.body.trading.limits.margins, [50, 100])
  assert.deepEqual(before.body.trading.limits.leverages, [1, 5, 20])
  assert.equal(before.body.trading.week.start, weekStartOf(OPEN_AT))
  assert.equal(before.body.trading.week.base, 500)

  // 2) 开一手做多 50：硬币当场扣，持仓卡有入场/现价/浮盈亏。
  const opened = await action(service, {
    action: 'trading-open-position',
    side: 'long',
    margin: 50,
    leverage: 1,
    cropId: 'tomato'
  })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.ok, true)
  const afterOpen = await state(service)
  assert.equal(afterOpen.body.farm.coins, 450)
  assert.equal(afterOpen.body.trading.coins.available, 450)
  assert.equal(afterOpen.body.trading.coins.locked, 50)
  assert.equal(afterOpen.body.trading.positions.length, 1)
  const position = afterOpen.body.trading.positions[0]
  assert.equal(position.side, 'long')
  assert.equal(position.margin, 50)
  assert.equal(position.entry, afterOpen.body.trading.bar.price, '成交价就是那一刻的现价')
  assert.equal(Number.isFinite(position.pnl), true)

  // 3) 时钟推到收盘之后：trading-refresh 让宿主结这一根，用这一根的收盘价。
  const closeAt = SLOT_EDGE + SLOT_MS + 1000
  clock.value = closeAt
  const refreshed = await action(service, { action: 'trading-refresh' })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.ok, true)
  const expected = settlementOf({
    side: 'long',
    margin: 50,
    leverage: 1,
    entry: position.entry,
    mark: slotClosePrice('tomato', position.slot)
  })
  const settled = await state(service)
  assert.equal(settled.body.trading.positions.length, 0)
  assert.equal(settled.body.trading.history.length, 1)
  assert.equal(settled.body.trading.history[0].reason, 'settle')
  assert.equal(settled.body.trading.history[0].exit, slotClosePrice('tomato', position.slot))
  assert.equal(settled.body.trading.history[0].pnl, expected.pnl)
  assert.equal(settled.body.farm.coins, 450 + expected.credit, '退回 保证金+盈亏')
  assert.equal(settled.body.trading.week.pnl, expected.pnl)
  assert.equal(settled.body.trading.coins.locked, 0)
  // 没有手续费：硬币只被这一笔的盈亏改过。
  assert.equal(settled.body.trading.coins.total, settled.body.farm.coins)

  // 4) 存档就是契约形状；硬币余额不在盘口文件里。
  const file = await readTrading(dir)
  assert.equal(file.version, 1)
  assert.equal(file.week.start, weekStartOf(OPEN_AT))
  assert.deepEqual(file.positions, [])
  assert.deepEqual(file.orders, [])
  assert.equal(file.history.length, 1)
  assert.equal('coins' in file, false)

  // 5) 重启：历史、本周盈亏、硬币都还在。
  service.dispose()
  const restarted = makeService(t, dir, { farmNow: () => clock.value })
  await restarted.ready
  const afterRestart = await state(restarted)
  assert.equal(afterRestart.body.trading.history.length, 1)
  assert.equal(afterRestart.body.trading.history[0].pnl, expected.pnl)
  assert.equal(afterRestart.body.trading.week.pnl, expected.pnl)
  assert.equal(afterRestart.body.farm.coins, 450 + expected.credit)
})

test('票 79 e2e：坏 trading.json 按空盘口运行、只告警一次；硬币一分不动', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  await writeFile(join(dir, TRADING_FILE), '{ 这不是 JSON', 'utf8')
  const clock = { value: OPEN_AT }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready
  const snapshot = await state(service)
  assert.deepEqual(snapshot.body.trading.positions, [])
  assert.deepEqual(snapshot.body.trading.history, [])
  assert.equal(snapshot.body.trading.coins.available, 500)
  assert.equal(snapshot.body.farm.coins, 500)
  assert.equal(service.warnings.filter((line) => /盘口/.test(line)).length, 1)
  // 空盘口不是死盘：照样能开仓（这就是「按空盘口运行」）。
  const opened = await action(service, { action: 'trading-open-position', side: 'short', margin: 100 })
  assert.equal(opened.body.ok, true)
  assert.equal((await state(service)).body.farm.coins, 400)
})

test('票 79 e2e：硬币不够（含 0 硬币）拒绝开仓，硬币不为负', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 30)
  const service = makeService(t, dir, { farmNow: () => OPEN_AT })
  await service.ready
  const refused = await action(service, { action: 'trading-open-position', side: 'long', margin: 50 })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'no-coin')
  assert.equal((await state(service)).body.farm.coins, 30)
  // 方向/保证金不在白名单里也拒绝，且不碰硬币。
  assert.equal((await action(service, { action: 'trading-open-position', side: 'up', margin: 50 })).body.error, 'bad-side')
  assert.equal((await action(service, { action: 'trading-open-position', side: 'long', margin: 250 })).body.error, 'bad-margin')
  assert.equal((await action(service, { action: 'trading-open-position', side: 'long', margin: 50, leverage: 2 })).body.error, 'bad-leverage')
  assert.equal((await action(service, { action: 'trading-close-position', positionId: 'nope' })).body.error, 'no-position')
  assert.equal((await state(service)).body.farm.coins, 30)
})
