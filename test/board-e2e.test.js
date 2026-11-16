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
import {
  SLOT_MS,
  TICK_MS,
  boardPrice,
  liquidationPriceOf,
  settlementOf,
  slotClosePrice,
  slotIndexAt,
  weekStartOf
} from '../src/trading-rules.js'
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

/**
 * 票 80 的那一根：`SLOT_EDGE + SLOT_MS`（下一根）在 tick 5 开仓，之后一路跌到收盘。
 * 20× 做多在这里 tick 12 撞强平线（−5%），5× 做多 + −25% 止损也在 tick 12 撞线；
 * 收盘价离得更远，所以「平在撞线那一刻」和「按收盘价结」拿到的价不一样。
 */
const OPEN_80 = SLOT_EDGE + SLOT_MS + 5 * TICK_MS
const AFTER_80 = SLOT_EDGE + 2 * SLOT_MS + 1000
const TICK_80 = 12
const EXIT_80 = boardPrice({ crop: 'tomato', slot: slotIndexAt(OPEN_80), tick: TICK_80 })

test('票 80 e2e：20× 开仓 → 跳过时钟 → 强平；只亏保证金，杠杆白名单是 [1,5,20]', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: OPEN_80 }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  // 1) 白名单：宿主下发 1×/5×/20× 与四档止损，窗口不自己复制一份。
  const before = await state(service)
  assert.deepEqual(before.body.trading.limits.leverages, [1, 5, 20])
  assert.equal(before.body.farm.coins, 500)

  // 2) 20× 开仓：硬币当场扣，持仓卡带强平价（= entry × (1 − 1/20)）与默认关的止损。
  const opened = await action(service, {
    action: 'trading-open-position',
    side: 'long',
    margin: 50,
    leverage: 20,
    cropId: 'tomato'
  })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.ok, true)
  const afterOpen = await state(service)
  assert.equal(afterOpen.body.farm.coins, 450)
  const position = afterOpen.body.trading.positions[0]
  assert.equal(position.leverage, 20)
  assert.equal(position.stopLoss, 0)
  assert.equal(position.liquidation, liquidationPriceOf({
    side: 'long',
    entry: position.entry,
    leverage: 20
  }))

  // 3) 时钟跳过这一根：强平线在 tick 12 就被跌穿，收盘价还在更下面。
  clock.value = AFTER_80
  const refreshed = await action(service, { action: 'trading-refresh' })
  assert.equal(refreshed.status, 200)
  const settled = await state(service)
  assert.equal(settled.body.trading.positions.length, 0)
  assert.equal(settled.body.trading.history.length, 1)
  const row = settled.body.trading.history[0]
  assert.equal(row.reason, 'liquidate')
  assert.equal(row.exit, EXIT_80, '平在撞线那一刻，不是收盘价')
  assert.equal(row.pnl, -50, '亏损封顶保证金')
  assert.equal(settled.body.farm.coins, 450, '硬币 = 开仓后 − 0：没有一分钱退回来')
  assert.equal(settled.body.trading.coins.locked, 0)
  assert.equal(settled.body.trading.week.pnl, -50)

  // 4) 重启：钱和记录都不变（不重复结算、不重复退款）。
  service.dispose()
  const restarted = makeService(t, dir, { farmNow: () => clock.value })
  await restarted.ready
  const afterRestart = await state(restarted)
  assert.equal(afterRestart.body.trading.history.length, 1)
  assert.equal(afterRestart.body.trading.history[0].reason, 'liquidate')
  assert.equal(afterRestart.body.farm.coins, 450)
})

test('票 80 e2e：一键止损 → /state 反映档位 → 到线平，原因「止损」', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: OPEN_80 }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  const opened = await action(service, {
    action: 'trading-open-position',
    side: 'long',
    margin: 50,
    leverage: 5,
    cropId: 'tomato'
  })
  assert.equal(opened.body.ok, true)
  const opened2 = await state(service)
  const id = opened2.body.trading.positions[0].id
  const entry = opened2.body.trading.positions[0].entry
  assert.equal(opened2.body.farm.coins, 450)

  // 循环档位：−25% → 关 → −25%；每次 /state 都反映得出来。
  const quarter = await action(service, { action: 'trading-set-stop', positionId: id, level: 0.25 })
  assert.equal(quarter.status, 200)
  assert.equal(quarter.body.ok, true)
  assert.equal(quarter.body.notice, '止损已设为 −25% 保证金。')
  assert.equal((await state(service)).body.trading.positions[0].stopLoss, 0.25)
  assert.equal((await action(service, { action: 'trading-set-stop', positionId: id, level: 0 })).body.ok, true)
  assert.equal((await state(service)).body.trading.positions[0].stopLoss, 0)
  const back = await action(service, { action: 'trading-set-stop', positionId: id, level: 0.25 })
  assert.equal(back.body.ok, true)

  // 坏档位/坏仓位：稳定错误码 + 中文人话，且不改档位。
  const bad = await action(service, { action: 'trading-set-stop', positionId: id, level: 0.3 })
  assert.equal(bad.status, 409)
  assert.equal(bad.body.error, 'bad-stop')
  assert.equal((await state(service)).body.trading.positions[0].stopLoss, 0.25)
  assert.equal((await action(service, { action: 'trading-set-stop', positionId: 'nope', level: 0.5 })).body.error, 'no-position')

  // 时钟跳过这一根：−25% 保证金（−5% 价格）在 tick 12 撞到，按那一刻的价平。
  clock.value = AFTER_80
  assert.equal((await action(service, { action: 'trading-refresh' })).body.ok, true)
  const settled = await state(service)
  assert.equal(settled.body.trading.positions.length, 0)
  const row = settled.body.trading.history[0]
  const expected = settlementOf({ side: 'long', margin: 50, leverage: 5, entry, mark: EXIT_80 })
  assert.equal(row.reason, 'stop')
  assert.equal(row.exit, EXIT_80)
  assert.equal(row.pnl, expected.pnl)
  assert.equal(settled.body.farm.coins, 450 + expected.credit)
  assert.equal(settled.body.trading.week.pnl, expected.pnl)
  // 硬币口径：可用 = 农场硬币；锁定清零；没有手续费。
  assert.equal(settled.body.trading.coins.available, settled.body.farm.coins)
  assert.equal(settled.body.trading.coins.locked, 0)
  assert.equal(settled.body.trading.coins.total, settled.body.farm.coins)
})
