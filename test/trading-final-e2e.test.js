/**
 * 票 83：SPEC v10 的最终验收入口（本地 HTTP + 假时钟 + 桌面替身，不联网、不 sleep）。
 *
 * 一条主流程把整层盘口串起来：
 *   开窗 → 5× 开仓 → 设止损 → 到价挂单（锁保证金）→ 推时钟到价成交（entry = 目标价）
 *   → 收盘结算 → 硬币/历史/本周盈亏/存档对账 → 榜上只有自己（没有 NPC）。
 * 另外两条降级：坏 trading.json / 0 硬币；离线补算；旧/未知报文在协议边界静默丢掉。
 *
 * 行情是 board-v4 的分钟级随机游走（同一分钟内价格恒定）：主流程用的那一根
 * （tick 2 开仓、tick `FILL_TICK` 第一次到价、收盘前不撞止损/强平线）由 `e2eBar()`
 * 现场扫出来，不写死 tick / 价格。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRequire } from 'node:module'

import { FARM_FILE } from '../src/farm.js'
import { parsePacket, PROTOCOL_VERSION } from '../src/protocol.js'
import { createService } from '../src/service.js'
import { TRADING_FILE } from '../src/trading.js'
import {
  SLOT_MS,
  SLOT_TICKS,
  TICK_MS,
  boardPrice,
  liquidationPriceOf,
  markPrice,
  settlementOf,
  slotClosePrice,
  tradingFeeOf,
  weekStartOf
} from '../src/trading-rules.js'

const require = createRequire(import.meta.url)
// 窗口的纯视图：确认 0 硬币时按钮真的写「去种地」。
const boardView = require('../desktop/trading-view.js')

const BASE_SLOT = 1763308800000 / SLOT_MS

/** 一根里 0..15 分钟的价格（tick 15 就是收盘价）。 */
function pricesOf (slot) {
  const prices = []
  for (let tick = 0; tick <= SLOT_TICKS; tick += 1) {
    prices.push(boardPrice({ crop: 'tomato', slot, tick }))
  }
  return prices
}

/**
 * 主流程用的那一根：tick 2 开仓（entry = 那一分钟的价），挂单目标取 tick 4..13 里
 * 第一次跌到的最低价（`FILL_TICK` ≥ 4）——从 tick 3 起第一次越价就在那一分钟。
 * 两个额外约束保证收盘前不先撞线：−50% 止损（5× 下 = −10% 价格）不触发，
 * 5× 的强平线（−19%）也不碰。价格是随机的，所以现场扫，不写死。
 */
function e2eBar (fromSlot) {
  for (let slot = fromSlot; slot < fromSlot + 4000; slot += 1) {
    const prices = pricesOf(slot)
    const entry = prices[2]
    let fillTick = 4
    let target = prices[4]
    for (let tick = 5; tick <= 13; tick += 1) {
      if (prices[tick] < target) {
        target = prices[tick]
        fillTick = tick
      }
    }
    // 必须是**第一次**越价：成交那一分钟之前没有更低的价。
    if (prices.slice(3, fillTick).some((price) => price <= target)) continue
    const afterOpen = Math.min(...prices.slice(3))
    if (afterOpen <= entry * 0.9) continue
    if (afterOpen <= liquidationPriceOf({ side: 'long', entry, leverage: 5 })) continue
    if (Math.min(...prices.slice(fillTick)) <= liquidationPriceOf({ side: 'long', entry: target, leverage: 5 })) continue
    return { slot, fillTick }
  }
  throw new Error('找不到「tick 2 开仓、tick 4..13 第一次到价、收盘前不撞线」的行情（行情规则改了？）')
}
const { slot: SLOT, fillTick: FILL_TICK } = e2eBar(BASE_SLOT)
/** 这一根的价格是随机的：tick 2 开仓、tick `FILL_TICK` 到价、收盘结算。 */
const SLOT_EDGE = SLOT * SLOT_MS
const OPEN_AT = SLOT_EDGE + 2 * TICK_MS
const FILL_AT = SLOT_EDGE + FILL_TICK * TICK_MS
const CLOSE_AT = SLOT_EDGE + SLOT_MS

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor (predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(15)
  }
  throw new Error('waitFor timeout')
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-trading-final-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

async function seedFarm (dir, coins) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins }), 'utf8')
}

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

function makeService (t, dir, options = {}) {
  const { ctx, routes, warnings } = fakeCtx()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    petBridge: false,
    // 有桌面替身时才走 helper；其余用例明确 desktop:false（不 spawn Electron）。
    ...(options.desktopFactory === undefined ? { desktop: false } : {}),
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

async function readTradingOrNull (dir) {
  try {
    return JSON.parse(await readFile(join(dir, TRADING_FILE), 'utf8'))
  } catch {
    return null
  }
}

/** 只记录盘口窗命令的桌面替身；不 spawn Electron（与测试里的其它替身同款）。 */
function desktopDouble () {
  const calls = { scenes: [], board: [] }
  let onEvent = null
  let boardOpen = false
  return {
    calls,
    factory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update (scene) { calls.scenes.push(scene); return true },
        resync (scene) { calls.scenes.push(scene); return true },
        status () { return { farmOpen: false, boardOpen } },
        farmWindow () { return true },
        boardWindow (payload) {
          calls.board.push(payload)
          if (payload.close === true) boardOpen = false
          else if (payload.open === true) boardOpen = true
          return true
        },
        actionResult () {},
        dispose () {}
      }
    },
    ready (workArea = { x: 0, y: 30, width: 1000, height: 700 }) {
      onEvent?.({ type: 'ready', pid: 4242, workArea, displays: [{ id: 1, bounds: workArea, workArea, scaleFactor: 1, primary: true }] })
    }
  }
}

test('票 83 最终 e2e：开窗 → 5× 开仓 → 设止损 → 到价成交 → 收盘结算 → 硬币/历史/周盈亏/榜', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: OPEN_AT }
  const desktop = desktopDouble()
  const service = makeService(t, dir, {
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  // 1) 开窗：宿主把整份视图交给窗口（窗口读不到 /state）。
  assert.equal((await action(service, { action: 'trading-open' })).body.window, 'opened')
  const opened = desktop.calls.board[0]
  assert.equal(opened.open, true)
  assert.equal(opened.state.limits.allIn, true)
  assert.deepEqual(opened.state.limits.margins, [50, 100, 250])
  assert.deepEqual(opened.state.orders, [])

  // 2) 5× 做多 100：硬币当场扣，入场 = 此刻现价；再设 −50% 止损。
  const openedPosition = await action(service, {
    action: 'trading-open-position', side: 'long', margin: 100, leverage: 5, cropId: 'tomato'
  })
  assert.equal(openedPosition.body.ok, true, JSON.stringify(openedPosition.body))
  const entry = markPrice({ crop: 'tomato', now: OPEN_AT })
  assert.equal(openedPosition.body.position.entry, entry)
  const stop = await action(service, {
    action: 'trading-set-stop', positionId: openedPosition.body.position.id, level: 0.5
  })
  assert.equal(stop.body.ok, true)
  assert.equal(stop.body.position.stopLoss, 0.5)
  assert.equal((await state(service)).body.farm.coins, 400)

  // 3) 到价挂单：目标价取 tick 4..13 里第一次越价的低点（现场扫出来的那一分钟）。
  const target = markPrice({ crop: 'tomato', now: FILL_AT })
  const placed = await action(service, {
    action: 'trading-place-order', side: 'long', margin: 100, leverage: 5, cropId: 'tomato', target
  })
  assert.equal(placed.body.ok, true, JSON.stringify(placed.body))
  let snapshot = await state(service)
  assert.equal(snapshot.body.farm.coins, 300, '挂单当场锁掉第二笔保证金')
  assert.equal(snapshot.body.trading.orders.length, 1)
  assert.equal(snapshot.body.trading.coins.locked, 200, '一手仓位 + 一张挂单')
  assert.equal(snapshot.body.trading.week.start, weekStartOf(OPEN_AT))

  // 4) 推时钟到成交那一分钟：刷新让宿主撮合，成交价 = 目标价，硬币不再动。
  clock.value = FILL_AT
  assert.equal((await action(service, { action: 'trading-refresh' })).body.ok, true)
  snapshot = await state(service)
  assert.deepEqual(snapshot.body.trading.orders, [])
  assert.equal(snapshot.body.trading.positions.length, 2)
  const filled = snapshot.body.trading.positions.find((position) => position.margin === 100 && position.entry === target)
  assert.ok(filled, '应该有一手按目标价成交的仓位')
  assert.equal(filled.openedAt, FILL_AT)
  assert.equal(filled.slot, SLOT)
  assert.equal(filled.leverage, 5)
  assert.equal(snapshot.body.farm.coins, 300)

  // 5) 收盘：两笔都按这一根的收盘价结算（止损 −50% 在这条路径上没触发）。
  clock.value = CLOSE_AT + 1000
  assert.equal((await action(service, { action: 'trading-refresh' })).body.ok, true)
  const settled = await state(service)
  assert.equal(settled.body.trading.positions.length, 0)
  assert.equal(settled.body.trading.orders.length, 0)
  assert.equal(settled.body.trading.history.length, 2)
  assert.deepEqual(settled.body.trading.history.map((row) => row.reason), ['settle', 'settle'])
  const exit = slotClosePrice('tomato', SLOT)
  // 手续费在结算时一次扣清：一手 100×5 的单边 = round(100 × 5 × 0.002) = 1，开平两侧共 2。
  const fee = tradingFeeOf({ margin: 100, leverage: 5 }) * 2
  const expectedStop = settlementOf({ side: 'long', margin: 100, leverage: 5, entry, mark: exit, fee })
  const expectedFill = settlementOf({ side: 'long', margin: 100, leverage: 5, entry: target, mark: exit, fee })
  const pnl = expectedStop.pnl + expectedFill.pnl
  const net = (expectedStop.pnl - expectedStop.fee) + (expectedFill.pnl - expectedFill.fee)
  const credited = expectedStop.credit + expectedFill.credit
  assert.deepEqual(settled.body.trading.history.map((row) => row.fee), [fee, fee])
  assert.equal(settled.body.farm.coins, 300 + credited, '两手回款 = 保证金 + 盈亏 − 手续费')
  assert.equal(settled.body.trading.week.pnl, net, '本周盈亏是净额（已扣手续费）')
  assert.equal(settled.body.trading.week.total, net)
  assert.equal(settled.body.trading.coins.locked, 0)
  // 硬币 = 本金 500 + 两笔盈亏 − 两笔手续费，一分不多一分不少。
  assert.equal(settled.body.trading.coins.total, 500 + pnl - fee * 2)
  assert.equal(settled.body.trading.coins.total, 300 + credited)
  assert.equal(settled.body.trading.coins.available, settled.body.farm.coins)

  // 6) 榜上只有自己（没有 NPC）；结算后没有持仓 → 观望。
  assert.equal(settled.body.trading.league.rows.length, 1)
  assert.equal(settled.body.trading.league.rows[0].me, true)
  assert.deepEqual(settled.body.trading.league.sentiment, { long: 0, short: 0, flat: 1 })

  // 7) 存档：挂单空、仓位空、历史两条、没有余额字段。
  const file = await readTradingOrNull(dir)
  assert.equal(file.version, 1)
  assert.deepEqual(file.orders, [])
  assert.deepEqual(file.positions, [])
  assert.equal(file.history.length, 2)
  assert.equal(file.history[0].fee, fee)
  assert.equal('coins' in file, false)

  // 8) 关窗后再开：历史还在，窗口拿到的是同一份结算结果。
  assert.equal((await action(service, { action: 'trading-close' })).body.window, 'closed')
  assert.equal((await action(service, { action: 'trading-open' })).body.window, 'opened')
  const reopened = desktop.calls.board.at(-1)
  assert.equal(reopened.state.history.length, 2)
  assert.equal(reopened.state.week.pnl, net)
})

test('票 83 降级：坏 trading.json = 空盘口 + 一次告警；0 硬币 = 开仓/挂单都拒，硬币不动', async (t) => {
  // 坏文件：读不出来就按空盘口跑，farm.json 的硬币一分不动（锁定中的保证金算坏账）。
  const badDir = await tempDir(t)
  await seedFarm(badDir, 500)
  await writeFile(join(badDir, TRADING_FILE), '{ 这不是 JSON', 'utf8')
  const badService = makeService(t, badDir, { farmNow: () => OPEN_AT })
  await badService.ready
  const empty = await state(badService)
  assert.deepEqual(empty.body.trading.positions, [])
  assert.deepEqual(empty.body.trading.orders, [])
  assert.deepEqual(empty.body.trading.history, [])
  assert.equal(empty.body.farm.coins, 500)
  assert.equal(badService.warnings.filter((line) => /盘口/.test(line)).length, 1)
  // 空盘口不是死盘：挂单/开仓照常可用。
  assert.equal((await action(badService, {
    action: 'trading-place-order', side: 'long', margin: 50, leverage: 1, cropId: 'tomato', target: 5
  })).body.ok, true)
  assert.equal((await state(badService)).body.farm.coins, 450)

  // 0 硬币：开仓与挂单都是 no-coin，硬币保持 0；窗口的空态写「去种地」。
  const brokeDir = await tempDir(t)
  await seedFarm(brokeDir, 0)
  const broke = makeService(t, brokeDir, { farmNow: () => OPEN_AT })
  await broke.ready
  const brokeState = await state(broke)
  assert.equal(brokeState.body.trading.coins.available, 0)
  const refusedOpen = await action(broke, {
    action: 'trading-open-position', side: 'long', margin: 50, leverage: 1, cropId: 'tomato'
  })
  assert.equal(refusedOpen.body.error, 'no-coin')
  const refusedOrder = await action(broke, {
    action: 'trading-place-order', side: 'long', margin: 50, leverage: 1, cropId: 'tomato', target: 5
  })
  assert.equal(refusedOrder.body.error, 'no-coin')
  assert.equal((await state(broke)).body.farm.coins, 0)
  const board = boardView.boardView(brokeState.body.trading, { now: OPEN_AT, limitOpen: true })
  assert.equal(board.order.submitLabel, '去种地')
  assert.equal(board.order.canSubmit, false)
  assert.equal(board.order.limit.canPlace, false)
  assert.match(board.order.limit.hint, /种地/)
})

test('票 83 降级：离线跨过收盘会补结算；未知/旧报文在协议边界静默丢掉', async (t) => {
  // 离线补算：开一手 + 挂一张，关掉 DSH 半小时再回来。
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: OPEN_AT }
  const service = makeService(t, dir, { farmNow: () => clock.value })
  await service.ready
  const opened = await action(service, {
    action: 'trading-open-position', side: 'long', margin: 100, leverage: 1, cropId: 'tomato'
  })
  assert.equal(opened.body.ok, true)
  // 挂一张这一根绝不会成交的目标价（做多、目标价在这根所有 tick 之下），离线期间应该到期退回。
  // 目标价由行情现算（写死价格会被随机行情当场越价成交）。
  let noFillTarget = Infinity
  for (let tick = 0; tick <= SLOT_TICKS; tick += 1) {
    noFillTarget = Math.min(noFillTarget, boardPrice({ crop: 'tomato', slot: SLOT, tick }))
  }
  noFillTarget *= 0.999
  const placed = await action(service, {
    action: 'trading-place-order', side: 'long', margin: 50, leverage: 1, cropId: 'tomato', target: noFillTarget
  })
  assert.equal(placed.body.ok, true)
  assert.equal((await state(service)).body.farm.coins, 350)
  service.dispose()

  // 两小时后回来：仓位按那一根的收盘价结，挂单按到期退回，都只发生一次。
  clock.value = SLOT_EDGE + 2 * 60 * 60 * 1000
  const restarted = makeService(t, dir, { farmNow: () => clock.value })
  await restarted.ready
  const caughtUp = await state(restarted)
  assert.equal(caughtUp.body.trading.positions.length, 0)
  assert.deepEqual(caughtUp.body.trading.orders, [])
  assert.equal(caughtUp.body.trading.history.length, 1)
  assert.equal(caughtUp.body.trading.history[0].reason, 'settle')
  // 100×1 的单边手续费 round(0.2) = 0，但口径照旧现算，不写死「没有手续费」。
  const fee = tradingFeeOf({ margin: 100, leverage: 1 }) * 2
  const expected = settlementOf({
    side: 'long',
    margin: 100,
    leverage: 1,
    entry: opened.body.position.entry,
    mark: slotClosePrice('tomato', SLOT),
    fee
  })
  assert.equal(caughtUp.body.farm.coins, 400 + expected.credit, '挂单的 50 退回 + 仓位的 100+盈亏')
  assert.equal(caughtUp.body.trading.week.pnl, expected.pnl - expected.fee, '本周盈亏是净额')
  // 再重启一次：不重复结算、不重复退款。
  restarted.dispose()
  const again = makeService(t, dir, { farmNow: () => clock.value })
  await again.ready
  assert.equal((await state(again)).body.farm.coins, 400 + expected.credit)
  assert.equal((await state(again)).body.trading.history.length, 1)

  // 旧端/未知报文：解析层直接拒绝，发现层静默丢包；不会碰硬币、仓位或榜。
  const base = {
    v: PROTOCOL_VERSION,
    type: 'trading-digest',
    deviceId: '00000000-0000-4000-8000-000000000001',
    at: Date.now(),
    weekPnl: 1,
    positions: []
  }
  const frame = (patch) => Buffer.from(JSON.stringify({ ...base, ...patch }), 'utf8')
  assert.deepEqual(parsePacket(frame({ v: PROTOCOL_VERSION + 1 })), { ok: false, reason: 'version' })
  assert.deepEqual(parsePacket(frame({ type: 'trading-digest-v2' })), { ok: false, reason: 'type' })
  assert.deepEqual(parsePacket(frame({ weekPnl: 1e12 })), { ok: false, reason: 'week-pnl' })
  assert.equal((await state(again)).body.trading.league.rows.length, 1, '榜里还是只有自己')
})
