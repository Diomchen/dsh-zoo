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

import shared from '../desktop/shared.js'
import { FARM_FILE } from '../src/farm.js'
import { resetCropCatalog } from '../src/farm-rules.js'
import { createService } from '../src/service.js'
import {
  BOARD_TIMEFRAMES,
  SLOT_MS,
  SLOT_TICKS,
  TICK_MS,
  TRADING_LEVERAGES,
  boardCrops,
  boardPrice,
  liquidationPriceOf,
  markPrice,
  settlementOf,
  slotClosePrice,
  tradingFeeOf,
  slotIndexAt,
  weekStartOf
} from '../src/trading-rules.js'
import { createRequire } from 'node:module'
import { TRADING_FILE } from '../src/trading.js'

const require = createRequire(import.meta.url)
// 窗口的纯视图：e2e 要确认 /state 下发的包真的画得出来（0 硬币写「去种地」）。
const boardView = require('../desktop/trading-view.js')

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
    // 这些用例钉的是 v5 结算口径；B 期资金流另有专门用例。
    tradingFlow: false,
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
  // 票 88：`payload.bar` 是目录第一个作物（目录顺序 pea 打头），不再是写死的 tomato。
  assert.equal(before.body.trading.bar.crop, boardCrops()[0])
  assert.equal(before.body.trading.bar.slot, slotIndexAt(OPEN_AT))
  assert.equal(before.body.trading.bar.end - before.body.trading.bar.start, SLOT_MS)
  assert.equal(before.body.trading.bar.remainingMs, SLOT_MS - 5 * TICK_MS)
  assert.ok(before.body.trading.bar.price > 0)
  // 票 83：三档预设 + 全下；目标价带随包下发（窗口不抄宿主比例）。
  assert.deepEqual(before.body.trading.limits.margins, [50, 100, 250])
  assert.equal(before.body.trading.limits.allIn, true)
  assert.deepEqual(before.body.trading.limits.targetRatio, { floor: 0.55, ceil: 1.75 })
  assert.deepEqual(before.body.trading.orders, [])
  // 杠杆白名单与纯规则同源：票 80 换成 [1,5,20] 时这里不用改。
  assert.deepEqual(before.body.trading.limits.leverages, TRADING_LEVERAGES.slice())
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
  // 这一手显式选的是 tomato；`payload.bar` 是目录第一个作物（pea），两者各算各的现价。
  assert.equal(position.entry, markPrice({ crop: 'tomato', now: OPEN_AT }), '成交价就是那一刻的现价')
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
  assert.equal(file.version, 2)
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
  // 方向/保证金不合法也拒绝，且不碰硬币（票 83：250 是合法预设，坏值换成 0/小数）。
  assert.equal((await action(service, { action: 'trading-open-position', side: 'up', margin: 50 })).body.error, 'bad-side')
  assert.equal((await action(service, { action: 'trading-open-position', side: 'long', margin: 0 })).body.error, 'bad-margin')
  assert.equal((await action(service, { action: 'trading-open-position', side: 'long', margin: 50.5 })).body.error, 'bad-margin')
  assert.equal((await action(service, { action: 'trading-open-position', side: 'long', margin: 50, leverage: 2 })).body.error, 'bad-leverage')
  assert.equal((await action(service, { action: 'trading-close-position', positionId: 'nope' })).body.error, 'no-position')
  assert.equal((await state(service)).body.farm.coins, 30)
})

/**
 * 票 80 的那一根：tick 5 开仓，之后**第一次**跌穿 −5% 在 `TICK_80`（20× 的强平线，
 * 也正好是 5× 的 −25% 止损线），收盘还在更下面，所以「平在撞线那一刻」和
 * 「按收盘价结」拿到的价不一样。
 *
 * 票 86 把价格盐升到 board-v2 后行情全变，这一根按新行情现找（20× 需要单根 5% 的
 * 波动，不是每根都有），不再写死「下一根 / tick 12」。
 */
function breachBar (fromSlot, ratio = 0.95) {
  for (let slot = fromSlot; slot < fromSlot + 20000; slot += 1) {
    const prices = []
    for (let tick = 0; tick <= SLOT_TICKS; tick += 1) {
      prices.push(boardPrice({ crop: 'tomato', slot, tick }))
    }
    const entry = prices[5]
    let breachTick = -1
    for (let tick = 6; tick <= 14; tick += 1) {
      if (prices[tick] <= entry * ratio) {
        breachTick = tick
        break
      }
    }
    if (breachTick < 0) continue
    if (prices[SLOT_TICKS] >= prices[breachTick]) continue
    if (Math.min(...prices.slice(5)) <= entry * 0.8) continue
    return { slot, breachTick }
  }
  throw new Error('找不到「tick 5 开仓、之后跌穿 −5%、收盘更低」的行情（行情规则改了？）')
}
const BAR_80 = breachBar(Math.floor(SLOT_EDGE / SLOT_MS) + 1)
const OPEN_80 = BAR_80.slot * SLOT_MS + 5 * TICK_MS
const AFTER_80 = (BAR_80.slot + 1) * SLOT_MS + 1000
const TICK_80 = BAR_80.breachTick
const EXIT_80 = boardPrice({ crop: 'tomato', slot: BAR_80.slot, tick: TICK_80 })

// 票 101/2026-11-18：下单杠杆 1×/5×/20×/100×；盘上 20× 仓位的强平线是
// (1 − 5%) / 20 = 0.9525，比原来的 −100% 保证金线早一点点，所以单独挑一根行情。
const BAR_LEGACY = breachBar(Math.floor(SLOT_EDGE / SLOT_MS) + 1, 1 - 0.95 / 20)
const OPEN_LEGACY = BAR_LEGACY.slot * SLOT_MS + 5 * TICK_MS
const AFTER_LEGACY = (BAR_LEGACY.slot + 1) * SLOT_MS + 1000
const TICK_LEGACY = BAR_LEGACY.breachTick
const EXIT_LEGACY = boardPrice({ crop: 'tomato', slot: BAR_LEGACY.slot, tick: TICK_LEGACY })

test('票 80 e2e：杠杆白名单是 [1,5,20,50,100]；盘上 20× 仓位照旧强平，只亏保证金', async (t) => {
  const dir = await tempDir(t)
  // 保证金在开仓那一刻就扣过了，所以农场先记 450。
  await seedFarm(dir, 450)
  const entry = markPrice({ crop: 'tomato', now: OPEN_LEGACY })
  await writeFile(join(dir, TRADING_FILE), JSON.stringify({
    version: 1,
    week: { start: weekStartOf(OPEN_LEGACY), pnl: 0, base: 450 },
    positions: [{
      id: 'legacy-20',
      crop: 'tomato',
      side: 'long',
      margin: 50,
      leverage: 20,
      entry,
      openedAt: OPEN_LEGACY,
      stopLoss: 0
    }],
    orders: [],
    history: []
  }), 'utf8')
  const clock = { value: OPEN_LEGACY }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  // 1) 白名单：宿主下发 1×/5×/20×/100× 与四档止损，窗口不自己复制一份。
  const before = await state(service)
  assert.deepEqual(before.body.trading.limits.leverages, [1, 5, 20, 50, 100])
  assert.equal(before.body.farm.coins, 450)
  // 老仓位读得回来，杠杆保持 20，强平价按 5% 维持保证金算。
  const legacy = before.body.trading.positions[0]
  assert.equal(legacy.leverage, 20)
  assert.equal(legacy.liquidation, liquidationPriceOf({
    side: 'long',
    entry: legacy.entry,
    leverage: 20
  }))

  // 2) 现在想开不在白名单里的 10×：拒单，硬币一分不动。
  const rejected = await action(service, {
    action: 'trading-open-position',
    side: 'long',
    margin: 50,
    leverage: 10,
    cropId: 'tomato'
  })
  assert.equal(rejected.body.ok, false)
  assert.equal(rejected.body.error, 'bad-leverage')
  assert.equal((await state(service)).body.farm.coins, 450)

  // 3) 时钟跳过这一根：老仓在 TICK_LEGACY 撞上 0.9525 的强平线。
  clock.value = AFTER_LEGACY
  const refreshed = await action(service, { action: 'trading-refresh' })
  assert.equal(refreshed.status, 200)
  const settled = await state(service)
  assert.equal(settled.body.trading.positions.length, 0)
  assert.equal(settled.body.trading.history.length, 1)
  const row = settled.body.trading.history[0]
  // 票 102：强平按**强平线**成交（不是撞线那一分钟的插针价），否则 20× 的跳空会穿透好几个点。
  const liquidation = liquidationPriceOf({ side: 'long', entry, leverage: 20 })
  const expected = settlementOf({
    side: 'long',
    margin: 50,
    leverage: 20,
    entry,
    mark: liquidation,
    fee: tradingFeeOf({ margin: 50, leverage: 20 }) * 2
  })
  assert.equal(row.reason, 'liquidate')
  assert.equal(row.exit, liquidation, '按强平线成交，不是插针价')
  assert.equal(row.pnl, expected.pnl)
  assert.equal(row.fee, expected.fee)
  assert.equal(settled.body.farm.coins, 450, '回款被亏损和手续费吃干净，一分钱不退回')
  assert.equal(settled.body.trading.coins.locked, 0)
  assert.equal(settled.body.trading.week.pnl, expected.pnl - expected.fee, '本周盈亏按净额记')

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

  // 时钟跳过这一根：−25% 保证金（−5% 价格）在 TICK_80 撞到，按那一刻的价平。
  clock.value = AFTER_80
  assert.equal((await action(service, { action: 'trading-refresh' })).body.ok, true)
  const settled = await state(service)
  assert.equal(settled.body.trading.positions.length, 0)
  const row = settled.body.trading.history[0]
  // 票 101：开平各 0.2%，结算时一次扣清（保证金只扣一次，手续费合计 0.4% 名义）。
  const fee = tradingFeeOf({ margin: 50, leverage: 5 }) * 2
  const expected = settlementOf({ side: 'long', margin: 50, leverage: 5, entry, mark: EXIT_80, fee })
  assert.equal(row.reason, 'stop')
  assert.equal(row.exit, EXIT_80)
  assert.equal(row.pnl, expected.pnl)
  assert.equal(row.fee, fee)
  assert.equal(settled.body.farm.coins, 450 + expected.credit)
  assert.equal(settled.body.trading.week.pnl, expected.pnl - fee)
  // 硬币口径：可用 = 农场硬币；锁定清零。
  assert.equal(settled.body.trading.coins.available, settled.body.farm.coins)
  assert.equal(settled.body.trading.coins.locked, 0)
  assert.equal(settled.body.trading.coins.total, settled.body.farm.coins)
})

test('票 81/88/90 e2e：当前作物 K 线 + 风向随 /state 下发；成形那根随时钟前进', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: OPEN_AT }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  const before = await state(service)
  const trading = before.body.trading
  // 票 88/90：15 分图只下发在 `timeframes['15m']`，而且只带当前选中的那一种作物。
  const crops = boardCrops()
  const only = crops[0]
  assert.equal('charts' in trading, false)
  assert.deepEqual(Object.keys(trading.timeframes['15m']), [only])
  const view = shared.normalizeBoardView(trading)
  {
    const chart = view.timeframes['15m'][only]
    assert.equal(chart.bars.length, 24, only + ' 最近 24 根')
    assert.equal(chart.current.slot, trading.bar.slot)
    assert.equal(chart.current.price, markPrice({ crop: only, now: clock.value }))
    // 每根的高低点都要夹住开收（图上的影线不能比实体短）。
    for (const bar of chart.bars) {
      assert.ok(bar.high >= Math.max(bar.open, bar.close), only + ' 高点越界：' + bar.slot)
      assert.ok(bar.low <= Math.min(bar.open, bar.close), only + ' 低点越界：' + bar.slot)
    }
    assert.ok(trading.hint[only].confidence >= 0.55 && trading.hint[only].confidence <= 0.68)
  }
  // `payload.bar` 是当前作物的当前一根（票 90：和同一包里的图同一种）。
  assert.equal(trading.bar.crop, only)
  assert.equal(trading.bar.price, trading.timeframes['15m'][only].current.price)
  // 窗口的纯视图吃得下这一包：图例、风向「不是保证」、完整作物条。
  const board = boardView.boardView(view, { now: clock.value })
  assert.equal(board.chart.geometry.bars.length, 24)
  assert.equal(board.chart.legend[0].text, view.timeframes['15m'][only].base.toFixed(2))
  assert.equal(board.hint.note, '不是保证')
  assert.equal(board.crops.length, crops.length)

  // 过两分钟：tick 前进两格，价格与剩余时间都跟着走（不是等 15 分钟才结算）。
  clock.value = OPEN_AT + 2 * TICK_MS
  assert.equal((await action(service, { action: 'trading-refresh' })).body.ok, true)
  const after = await state(service)
  {
    const current = after.body.trading.timeframes['15m'][only].current
    assert.equal(current.slot, before.body.trading.timeframes['15m'][only].current.slot)
    assert.equal(current.tick, 7)
    assert.equal(current.price, markPrice({ crop: only, now: clock.value }))
    assert.equal(current.remainingMs, SLOT_MS - 7 * TICK_MS)
  }
  assert.notEqual(after.body.trading.timeframes['15m'][only].current.price,
    before.body.trading.timeframes['15m'][only].current.price)
})

test('票 84/90 e2e：当前作物的四周期随 /state 下发；切周期不改持仓/硬币/周盈亏，结算仍按 15 分', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: OPEN_AT }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  // 先开一手：切换周期时这手仓位、硬币、周盈亏都不许动。
  const opened = await action(service, {
    action: 'trading-open-position', side: 'long', margin: 50, leverage: 1, cropId: 'tomato'
  })
  assert.equal(opened.body.ok, true)
  // 票 90：切到番茄再读 /state——按需包只带这一种作物的四个周期。
  assert.equal((await action(service, { action: 'trading-charts', cropId: 'tomato' })).body.ok, true)
  const before = (await state(service)).body.trading
  const ids = BOARD_TIMEFRAMES.map(({ id }) => id)
  const crops = boardCrops()
  const only = 'tomato'
  assert.ok(crops.includes(only))
  assert.deepEqual(Object.keys(before.timeframes), ids)
  assert.deepEqual(before.limits.timeframes, BOARD_TIMEFRAMES.map(({ id, label }) => ({ id, label })))
  for (const { id } of BOARD_TIMEFRAMES) {
    assert.deepEqual(Object.keys(before.timeframes[id]), [only], id + ' 只带当前作物')
    {
      const chart = before.timeframes[id][only]
      assert.equal(chart.bars.length, 24, id + ' / ' + only + ' 最近 24 根')
      assert.ok(chart.current.start <= clock.value && clock.value < chart.current.end)
      assert.equal(chart.current.tick === null, id !== '15m', id + ' 的 tick 口径')
      // 票 88：紧凑数组 [slot, start, end, open, high, low, close]。
      for (const bar of chart.bars) assert.ok(bar[2] > bar[1], id + ' 每根都有 start/end')
    }
  }
  // 15 分就是 `timeframes['15m']`（旧 `charts` 不再重复下发）。
  assert.equal('charts' in before, false)
  assert.equal(before.bar.crop, only)
  assert.equal(before.bar.price, before.timeframes['15m'][only].current.price)

  // 窗口切周期是纯视图换图：同一份 payload 里硬币/持仓/周盈亏一个字不动。
  const view = shared.normalizeBoardView(before)
  const money = JSON.stringify({ coins: before.coins, positions: before.positions, week: before.week })
  for (const id of ids) {
    const board = boardView.boardView(view, { now: clock.value, timeframe: id })
    assert.equal(board.chart.timeframe, id)
    assert.equal(board.chart.hasChart, true)
    assert.equal(board.chart.settleNote.visible, id !== '15m')
    assert.equal(JSON.stringify({ coins: before.coins, positions: before.positions, week: before.week }), money)
  }

  // 时钟推到这一根收盘之后：结算仍用 15 分钟收盘价，跟窗口正在看哪个周期无关。
  const position = before.positions[0]
  clock.value = SLOT_EDGE + SLOT_MS + 1000
  assert.equal((await action(service, { action: 'trading-refresh' })).body.ok, true)
  const afterState = await state(service)
  const settled = afterState.body.trading
  const expected = settlementOf({
    side: 'long',
    margin: 50,
    leverage: 1,
    entry: position.entry,
    mark: slotClosePrice('tomato', position.slot)
  })
  assert.equal(settled.positions.length, 0)
  assert.equal(settled.history.length, 1)
  assert.equal(settled.history[0].reason, 'settle')
  assert.equal(settled.history[0].exit, slotClosePrice('tomato', position.slot))
  assert.equal(settled.history[0].pnl, expected.pnl)
  assert.equal(settled.week.pnl, expected.pnl)
  assert.equal(afterState.body.farm.coins, 450 + expected.credit)
  // 结算之后新一包仍然带四个周期（窗口不用重开）。
  assert.deepEqual(Object.keys(settled.timeframes), ids)
})

test('票 81 e2e：周一 00:00 清零的是本周盈亏，不是硬币', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  // 星期天晚上：先做出一笔已实现盈亏，落在「本周」。
  const sunday = new Date(2026, 10, 22, 23, 30, 0, 0).getTime()
  const clock = { value: sunday }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready
  const opened = await action(service, {
    action: 'trading-open-position', side: 'long', margin: 50, leverage: 1, cropId: 'tomato'
  })
  assert.equal(opened.body.ok, true)
  clock.value = sunday + TICK_MS
  assert.equal((await action(service, { action: 'trading-close-position', positionId: opened.body.position.id })).body.ok, true)
  const sundayState = await state(service)
  const pnl = sundayState.body.trading.week.pnl
  const coins = sundayState.body.farm.coins
  assert.equal(sundayState.body.trading.history.length, 1)
  assert.equal(sundayState.body.trading.week.start, weekStartOf(sunday))
  assert.equal(sundayState.body.trading.week.base, 500)

  // 周一 00:00:30：分数清零、base 换成此刻的硬币，硬币与历史一分不动。
  const monday = new Date(2026, 10, 23, 0, 0, 30, 0, 0).getTime()
  clock.value = monday
  assert.equal((await action(service, { action: 'trading-refresh' })).body.ok, true)
  const mondayState = await state(service)
  assert.equal(mondayState.body.trading.week.pnl, 0, '本周盈亏清零')
  assert.equal(mondayState.body.trading.week.total, 0)
  assert.equal(mondayState.body.trading.week.start, weekStartOf(monday), '换周起点')
  assert.equal(mondayState.body.trading.week.base, mondayState.body.farm.coins, '新一周的收益率分母')
  assert.equal(mondayState.body.farm.coins, coins, '硬币不清零')
  assert.equal(mondayState.body.trading.history.length, 1, '历史不清零')
  assert.equal(mondayState.body.trading.history[0].pnl, pnl)
  // 窗口顶部显示的是新一周的 0 与「—」（base 有了，收益率是 0.00%）。
  const week = boardView.boardView(mondayState.body.trading, { now: monday }).week
  assert.equal(week.pnlText, '0.0')
  assert.equal(week.pctText, '0.00%')
})

test('票 82 e2e：/state 带真人周榜；只有自己时「观望」，开仓后持仓跟着进榜', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: OPEN_AT }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  // 没有邻居：榜上只有本机一行；空仓 = 观望（SPEC「没有仓位写观望」）。
  const alone = await state(service)
  const league = alone.body.trading.league
  assert.equal(league.rows.length, 1)
  assert.equal(league.rows[0].me, true)
  assert.equal(league.rows[0].weekPnl, 0)
  assert.equal(league.rows[0].weekPnlPct, 0, '本周还没做单：0 / 周起点硬币')
  assert.deepEqual(league.rows[0].positions, [])
  assert.deepEqual(league.sentiment, { long: 0, short: 0, flat: 1 })
  assert.deepEqual(league.self, { weekPnl: 0, weekPnlPct: 0 })
  const empty = boardView.boardView(alone.body.trading, { now: clock.value })
  assert.equal(empty.league.sentiment.text, '观望')
  assert.equal(empty.league.hasPeers, false)
  assert.equal(empty.league.empty, '等邻居上线')

  // 开一手 5× 空南瓜（票 101 之后的白名单上限）：榜里自己那行出现持仓，情绪变「多 0 · 空 1」。
  const opened = await action(service, {
    action: 'trading-open-position', side: 'short', margin: 100, leverage: 5, cropId: 'pumpkin'
  })
  assert.equal(opened.body.ok, true, JSON.stringify(opened.body))
  const after = (await state(service)).body.trading
  assert.deepEqual(after.league.rows[0].positions, [{ crop: 'pumpkin', side: 'short', leverage: 5 }])
  // 行里只有三个公开字段：保证金/入场价不出本机。
  assert.deepEqual(Object.keys(after.league.rows[0].positions[0]), ['crop', 'side', 'leverage'])
  assert.deepEqual(after.league.sentiment, { long: 0, short: 1, flat: 0 })
  // 分数与收益率跟顶部同一个口径：取整后的本周盈亏、total / base。
  assert.equal(after.league.self.weekPnl, Math.round(after.week.total))
  assert.equal(after.league.self.weekPnlPct, after.week.total / after.week.base)
  const rendered = boardView.boardView(after, { now: clock.value })
  assert.equal(rendered.league.rows[0].me, true)
  assert.equal(rendered.league.rows[0].positionsText, '多 0 · 空 1')
  assert.equal(rendered.league.sentiment.text, '多 0 · 空 1')
})

test('票 81 e2e：0 硬币时按钮写「去种地」，下单被拒绝且硬币不为负', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 0)
  const clock = { value: OPEN_AT }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  const broke = await state(service)
  assert.equal(broke.body.farm.coins, 0)
  assert.equal(broke.body.trading.coins.available, 0)
  const board = boardView.boardView(broke.body.trading, { now: clock.value })
  assert.equal(board.order.canSubmit, false)
  assert.equal(board.order.submitLabel, '去种地')
  assert.equal(board.order.hint, '去种地')
  assert.equal(board.hints.positions, '还没有持仓')

  const refused = await action(service, {
    action: 'trading-open-position', side: 'long', margin: 50, leverage: 1, cropId: 'tomato'
  })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'no-coin')
  assert.equal((await state(service)).body.farm.coins, 0)
  assert.deepEqual((await state(service)).body.trading.positions, [])
})

test('票 83 e2e：挂单锁币 → 到价成交（entry = 目标价）→ 撤单退回；/state 与存档对得上', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  // 价格是随机的（票 102）：现场找一根「开盘价高于后面某个低点」的行情，
  // 目标价 = 那一根的最低点，成交时刻 = 第一次摸到它的那一分钟。
  let bar = null
  for (let attempt = 0; attempt < 200 && bar === null; attempt += 1) {
    const slot = Math.floor(SLOT_EDGE / SLOT_MS) + attempt
    const start = slot * SLOT_MS
    const prices = []
    for (let tick = 0; tick <= SLOT_TICKS; tick += 1) {
      prices.push(markPrice({ crop: 'tomato', now: start + tick * TICK_MS }))
    }
    const low = Math.min(...prices.slice(1))
    const dipTick = prices.findIndex((price, index) => index > 0 && price <= low)
    if (dipTick > 0 && prices[0] > low) bar = { start, low, dipTick }
  }
  assert.ok(bar, '找不到「开盘价高于后面某个低点」的行情')
  const clock = { value: bar.start }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready

  // 开盘挂一张做多：目标价 = 这一根的最低点，第一次越价就在 dipTick。
  const target = bar.low
  const placed = await action(service, {
    action: 'trading-place-order',
    side: 'long',
    margin: 100,
    leverage: 5,
    cropId: 'tomato',
    target
  })
  assert.equal(placed.status, 200)
  assert.equal(placed.body.ok, true, JSON.stringify(placed.body))
  const afterPlace = await state(service)
  assert.equal(afterPlace.body.farm.coins, 400, '挂单当场锁保证金')
  assert.equal(afterPlace.body.trading.coins.locked, 100)
  assert.equal(afterPlace.body.trading.orders.length, 1)
  assert.equal(afterPlace.body.trading.orders[0].target, target)
  const orderId = afterPlace.body.trading.orders[0].id
  const file = await readTrading(dir)
  assert.equal(file.orders.length, 1)
  assert.equal(file.orders[0].id, orderId)

  // 时钟推到成交那一分钟：trading-refresh 让宿主撮合；成交价是目标价。
  clock.value = bar.start + bar.dipTick * TICK_MS
  assert.equal((await action(service, { action: 'trading-refresh' })).body.ok, true)
  const afterFill = await state(service)
  assert.deepEqual(afterFill.body.trading.orders, [])
  assert.equal(afterFill.body.trading.positions.length, 1)
  const position = afterFill.body.trading.positions[0]
  assert.equal(position.entry, target)
  assert.equal(position.margin, 100)
  assert.equal(position.leverage, 5)
  assert.equal(position.openedAt, bar.start + bar.dipTick * TICK_MS)
  assert.equal(afterFill.body.farm.coins, 400, '成交时不再动钱')
  assert.equal((await readTrading(dir)).positions.length, 1)

  // 再挂一张做空，然后手动撤单：硬币回到 400 + 50。
  const second = await action(service, {
    action: 'trading-place-order',
    side: 'short',
    margin: 50,
    leverage: 1,
    cropId: 'tomato',
    target: target + 0.2
  })
  assert.equal(second.body.ok, true, JSON.stringify(second.body))
  assert.equal((await state(service)).body.farm.coins, 350)
  const cancelled = await action(service, {
    action: 'trading-cancel-order',
    orderId: second.body.order.id
  })
  assert.equal(cancelled.body.ok, true, JSON.stringify(cancelled.body))
  const afterCancel = await state(service)
  assert.equal(afterCancel.body.farm.coins, 400)
  assert.deepEqual(afterCancel.body.trading.orders, [])
  assert.equal(afterCancel.body.trading.history.length, 0, '撤单不进历史')
})
