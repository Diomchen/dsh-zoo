/**
 * 票 93：期货小窗（不开 Electron）。
 *
 * 覆盖：
 *   1. 纯视图模型：金额/百分比/倒计时排版，下单预览与 `src/futures-rules.js` 同源
 *      （张数、保证金、手续费、强平价不 drift），持仓的危险行，四种状态文案；
 *   2. `desktop/shared.js` 的白名单：期货五个动作只收白名单字段，坏杠杆/非整数保证金
 *      整条拒；`futures-window` 命令与 `futures-window-state` 事件；
 *   3. 宿主侧：`futures-window` 开窗下发整份视图；再点一次关窗；用户 × 之后能重开；
 *      没有桌面层是 `desktop-off`；`futures-refresh` 回一拍新视图；这条命令 < 64 KiB。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { FARM_FILE } from '../src/farm.js'
import { createService } from '../src/service.js'
import {
  FUTURES_LEVERAGES,
  LOT_SIZE,
  MM_SPREAD,
  SLOT_MS,
  TAKER_FEE_RATE,
  lotsFor,
  marginOf,
  notionalOf,
  takerFeeOf
} from '../src/futures-rules.js'

const require = createRequire(import.meta.url)
// 渲染页与 Node 测试共用同一份纯视图模型（desktop/ 是 CommonJS）。
const view = require('../desktop/futures-view.js')

// 2026-11-17 是周二：周合约在 24/7 交易窗内，报价一定存在。
const TUESDAY = new Date(2026, 10, 17, 10, 0, 0, 0).getTime()

/** 一份最小可用的窗口视图：番茄有报价，其余从略。 */
function sampleView (overrides = {}) {
  const price = 5
  return {
    ready: true,
    epoch: 'epoch-1',
    balance: 300,
    marginUsed: 25,
    equity: 305,
    closed: 2,
    positionCount: 1,
    positions: [],
    trades: [],
    week: { start: TUESDAY - 9 * 60 * 60 * 1000, pnl: 5 },
    quotes: {
      tomato: {
        contract: { id: 'tomato-2026W47', crop: 'tomato', openAt: TUESDAY, expireAt: TUESDAY + 4 * 86400000 },
        fair: price,
        bid: price * (1 - MM_SPREAD),
        ask: price * (1 + MM_SPREAD)
      }
    },
    crops: [{ id: 'tomato', label: '番茄', index: price, contract: 'tomato-2026W47' }],
    limits: { leverages: FUTURES_LEVERAGES.slice(), lotSize: LOT_SIZE, takerFeeRate: TAKER_FEE_RATE, spreadRate: MM_SPREAD },
    now: TUESDAY,
    slotEnd: TUESDAY + SLOT_MS / 2,
    ...overrides
  }
}

test('视图模型：金额、百分比与倒计时按窗口口径排版', () => {
  assert.equal(view.formatPrice(12.345), '12.35')
  assert.equal(view.formatPrice(null), '—')
  assert.equal(view.formatCoin(-3.5), '−3.50')
  assert.equal(view.formatCoin(0), '0.00')
  assert.equal(view.formatPct(0.0123), '+1.23%')
  assert.equal(view.formatPct(-0.0123), '−1.23%')
  assert.equal(view.formatPct(null), '—')

  const end = TUESDAY + 90 * 1000
  const early = view.countdown(end, TUESDAY)
  assert.equal(early.text, '01:30')
  assert.equal(early.atEnd, false)
  const late = view.countdown(end, end)
  assert.equal(late.text, '00:00')
  assert.equal(late.atEnd, true)
  assert.equal(view.slotEndOf({ slotEnd: end }), end)
  assert.equal(view.slotEndOf({ now: TUESDAY }), Math.floor(TUESDAY / SLOT_MS) * SLOT_MS + SLOT_MS)
})

test('下单预览与 src/futures-rules.js 同源：张数/保证金/手续费/强平价不 drift', () => {
  const sample = sampleView()
  const ask = sample.quotes.tomato.ask
  for (const side of ['long', 'short']) {
    for (const leverage of FUTURES_LEVERAGES) {
      for (const margin of [50, 250, 1000]) {
        const preview = view.orderPreview(sample, { side, margin, leverage, cropId: 'tomato' })
        assert.equal(preview.ok, true, side + ' ' + leverage + '× ' + margin)
        const price = side === 'long' ? ask : sample.quotes.tomato.bid
        const notional = notionalOf({ lots: 0, price })
        void notional
        // 张数：名义 = 保证金 × 杠杆，向下取整，至少一张。
        const lots = Math.max(1, Math.floor((margin * leverage) / (price * LOT_SIZE)))
        assert.equal(preview.lots, lots)
        assert.equal(lotsFor({ notional: margin * leverage, price }), lots)
        // 保证金与手续费都按「实际张数 × 100 × 价格」重算，并到分。
        assert.equal(preview.margin, Math.round(marginOf({ lots, price, leverage }) * 100) / 100)
        assert.equal(preview.fee, Math.round(takerFeeOf(lots * LOT_SIZE * price) * 100) / 100)
        // 强平价就是「反向走 1/杠杆」。
        const move = 1 / leverage
        const liquidation = Math.round((side === 'long' ? price * (1 - move) : price * (1 + move)) * 100) / 100
        assert.equal(preview.liquidation, liquidation)
        assert.equal(preview.cost, Math.round((preview.margin + preview.fee) * 100) / 100)
      }
    }
  }
  // 缺一项就禁用，并给人话。
  assert.equal(view.orderPreview(sample, { side: null, margin: 50, leverage: 20, cropId: 'tomato' }).reason, '选方向')
  assert.equal(view.orderPreview(sample, { side: 'long', margin: 0, leverage: 20, cropId: 'tomato' }).reason, '保证金要是整数币')
  assert.equal(view.orderPreview(sample, { side: 'long', margin: 50, leverage: 5, cropId: 'tomato' }).reason, '选杠杆')
  assert.equal(view.orderPreview(sample, { side: 'long', margin: 50, leverage: 20, cropId: null }).reason, '选作物')
  assert.equal(view.orderPreview(sample, { side: 'long', margin: 50, leverage: 20, cropId: 'pea' }).reason, '这张合约现在不能交易')
})

test('持仓表：浮亏吃到八成保证金就把整行标红', () => {
  const base = { id: 'p1', crop: 'tomato', contract: 'tomato-2026W47', side: 'long', lots: 1, entry: 5, margin: 25, leverage: 20 }
  const calm = view.positionRows(sampleView({ positions: [{ ...base, unrealized: -5 }] }))[0]
  assert.equal(calm.danger, false)
  assert.equal(calm.liquidation, view.formatPrice(5 * (1 - 1 / 20)))
  assert.equal(calm.unrealized, '−5.00')

  const red = view.positionRows(sampleView({ positions: [{ ...base, unrealized: -20.5 }] }))[0]
  assert.equal(red.danger, true)
  // 空头的强平价在入场价上方。
  const short = view.positionRows(sampleView({ positions: [{ ...base, side: 'short', unrealized: 1 }] }))[0]
  assert.equal(short.liquidation, view.formatPrice(5 * (1 + 1 / 20)))
  assert.equal(short.side, '空')
})

test('状态四态：没就绪、没充钱、周末收盘、正常', () => {
  assert.equal(view.statusOf(sampleView({ ready: false })).kind, 'starting')
  assert.equal(view.statusOf(sampleView({ balance: 0, marginUsed: 0, equity: 0, positions: [], trades: [], quotes: {} })).kind, 'no-funds')
  assert.equal(view.statusOf(sampleView({ quotes: {} })).kind, 'closed')
  assert.equal(view.statusOf(sampleView()).kind, 'ok')

  const built = view.build(sampleView(), { side: 'long', margin: 50, leverage: 20, cropId: 'tomato' }, TUESDAY)
  assert.equal(built.countdown.atEnd, false)
  assert.equal(built.canSubmit, true)
  assert.equal(built.header.balance, '300.00')
  assert.equal(built.quotes.length, 1)
  assert.equal(built.quotes[0].tone, 'flat')
  assert.match(built.title, /期货/)
  assert.match(built.title, /2026W47/)
})

test('shared：期货动作只收白名单字段，坏杠杆/非整数保证金整条拒', () => {
  const good = shared.normalizeFuturesAction({ action: 'futures-open', side: 'long', margin: 50, leverage: 20, cropId: 'tomato', price: 999 })
  assert.deepEqual(good, { action: 'futures-open', side: 'long', margin: 50, leverage: 20, cropId: 'tomato' })

  assert.equal(shared.normalizeFuturesAction({ action: 'futures-open', side: 'long', margin: 50, leverage: 5, cropId: 'tomato' }), null)
  assert.equal(shared.normalizeFuturesAction({ action: 'futures-open', side: 'long', margin: 50.5, leverage: 20, cropId: 'tomato' }), null)
  assert.equal(shared.normalizeFuturesAction({ action: 'futures-open', side: 'up', margin: 50, leverage: 20, cropId: 'tomato' }), null)
  assert.deepEqual(shared.normalizeFuturesAction({ action: 'futures-deposit', coins: 100 }), { action: 'futures-deposit', coins: 100 })
  assert.deepEqual(shared.normalizeFuturesAction({ action: 'futures-withdraw', coins: 40 }), { action: 'futures-withdraw', coins: 40 })
  assert.deepEqual(shared.normalizeFuturesAction({ action: 'futures-close', positionId: '0b7c1f0e-1f2a-4a4b-9a3e-1d2c3b4a5f60' }), {
    action: 'futures-close',
    positionId: '0b7c1f0e-1f2a-4a4b-9a3e-1d2c3b4a5f60'
  })
  assert.deepEqual(shared.normalizeFuturesAction({ action: 'futures-refresh' }), { action: 'futures-refresh' })

  // helper 事件：五个期货动作走 futures 分支，窗口命令走窄口。
  assert.equal(shared.normalizeHelperEvent({ type: 'action', id: 'a1', action: 'futures-open', side: 'long', margin: 50, leverage: 20, cropId: 'tomato' }).event.action, 'futures-open')
  assert.equal(shared.normalizeHelperEvent({ type: 'action', id: 'a2', action: 'futures-open', side: 'long', margin: 50, leverage: 5, cropId: 'tomato' }).error, 'bad-futures-action')
  assert.equal(shared.normalizeHelperEvent({ type: 'action', id: 'a3', action: 'futures-window' }).event.action, 'futures-window')
  assert.deepEqual(shared.normalizeHelperEvent({ type: 'futures-window-state', id: 'w1', open: true }).event, {
    type: 'futures-window-state',
    id: 'w1',
    open: true
  })
})

test('shared：futures-window 命令带整份视图，缺字段有默认', () => {
  const command = shared.normalizeHostCommand({ type: 'futures-window', id: 'c1', open: true, state: sampleView() })
  assert.equal(command.ok, true)
  assert.equal(command.command.type, 'futures-window')
  assert.equal(command.command.open, true)
  assert.equal(command.command.state.ready, true)
  assert.deepEqual(command.command.state.limits.leverages, FUTURES_LEVERAGES)

  const bare = shared.normalizeHostCommand({ type: 'futures-window', id: 'c2' })
  assert.equal(bare.ok, true)
  assert.equal(bare.command.open, false)
  // 刷新命令必须带状态；不带就是 null，窗口那边按「还没收到一拍」处理。
  assert.equal(bare.command.state, null)
  const empty = shared.normalizeFuturesView({})
  assert.equal(empty.ready, false)
  assert.equal(empty.positionCount, 0)
  assert.deepEqual(empty.limits.leverages, FUTURES_LEVERAGES)
})

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

function fakeCtx () {
  const routes = []
  const warnings = []
  return {
    warnings,
    ctx: {
      webServer: {
        register (options) {
          routes.push(options)
          return () => {}
        }
      },
      logger: { info () {}, warn (line) { warnings.push(line) } }
    },
    routes
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-window-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, options = {}) {
  const { ctx, routes, warnings } = fakeCtx()
  const service = createService(ctx, {
    network: false,
    petBridge: false,
    skinServer: false,
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

function callAction (service, body) {
  return call(service, '/dsh-zoo/action', { method: 'POST', body })
}

/** 只记录窗口命令的桌面替身；不 spawn Electron。 */
function desktopDouble () {
  const calls = { scenes: [], futures: [], results: [] }
  let onEvent = null
  let futuresOpen = false
  return {
    calls,
    factory (factoryOptions) {
      onEvent = factoryOptions.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update (scene) { calls.scenes.push(scene); return true },
        resync (scene) { calls.scenes.push(scene); return true },
        status () { return { farmOpen: false, boardOpen: false } },
        farmWindow () { return true },
        boardWindow () { return true },
        futuresWindow (payload) {
          calls.futures.push(payload)
          if (payload.close === true) futuresOpen = false
          else if (payload.open === true) futuresOpen = true
          return true
        },
        lastCommandFailure () { return null },
        actionResult (id, result) { calls.results.push({ id, result }) },
        dispose () {}
      }
    },
    ready (workArea = { x: 0, y: 30, width: 1000, height: 700 }) {
      onEvent?.({ type: 'ready', pid: 4242, workArea, displays: [{ id: 1, bounds: workArea, workArea, scaleFactor: 1, primary: true }] })
    },
    emit (event) { onEvent?.(event) },
    /** 用户点 × / Esc：helper 关窗并回报真实状态。 */
    userCloseFutures () {
      futuresOpen = false
      onEvent?.({ type: 'futures-window-state', open: false })
    },
    isFuturesOpen () { return futuresOpen }
  }
}

test('futures-window：开窗下发整份视图；再点一次关闭；× 之后能重开', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins: 500 }), 'utf8')
  const clock = { value: TUESDAY }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value,
    marketNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  const opened = await callAction(service, { action: 'futures-window' })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.ok, true)
  assert.equal(opened.body.window, 'opened')
  assert.equal(desktop.calls.futures.length, 1)
  const command = desktop.calls.futures[0]
  assert.equal(command.open, true)
  assert.equal('close' in command, false)
  const state = command.state
  assert.equal(state.ready, true)
  assert.deepEqual(state.limits, {
    leverages: FUTURES_LEVERAGES.slice(),
    lotSize: LOT_SIZE,
    takerFeeRate: TAKER_FEE_RATE,
    spreadRate: MM_SPREAD
  })
  assert.equal(state.crops.length >= 10, true)
  assert.equal(state.slotEnd, Math.floor(TUESDAY / SLOT_MS) * SLOT_MS + SLOT_MS)
  assert.equal(state.now, TUESDAY)
  // 一份视图能直接交给纯视图模型画出来。
  const painted = view.build(state, { side: 'long', margin: 50, leverage: 20, cropId: state.crops[0].id }, TUESDAY)
  assert.equal(painted.status.kind, 'no-funds')
  assert.equal(painted.quotes.length >= 10, true)

  // 再点一次「期货」= 关窗。
  const toggled = await callAction(service, { action: 'futures-window' })
  assert.equal(toggled.body.ok, true)
  assert.equal(toggled.body.window, 'closed')
  const closeCommand = desktop.calls.futures.at(-1)
  assert.equal(closeCommand.open, false)
  assert.equal(closeCommand.close, true)
  assert.equal(desktop.isFuturesOpen(), false)

  // 用户点 ×（helper 回报 open:false）之后，再点「期货」必须重新打开。
  desktop.userCloseFutures()
  const reopened = await callAction(service, { action: 'futures-window' })
  assert.equal(reopened.body.window, 'opened')
  assert.equal(desktop.calls.futures.at(-1).open, true)
})

test('futures-window：没有桌面层是 desktop-off，说人话', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktop: false
  })
  await service.ready
  const offline = await callAction(service, { action: 'futures-window' })
  assert.equal(offline.status, 409)
  assert.equal(offline.body.error, 'desktop-off')
  assert.ok(offline.body.notice.length > 0)
})

test('futures-refresh：回一拍新视图，不重复下单也不关窗', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins: 500 }), 'utf8')
  const clock = { value: TUESDAY }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value,
    marketNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)
  await callAction(service, { action: 'futures-window' })

  const before = desktop.calls.futures.length
  clock.value += 60 * 1000
  const refreshed = await callAction(service, { action: 'futures-refresh' })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.ok, true)
  assert.equal(refreshed.body.state.ready, true)
  assert.equal(refreshed.body.state.now, TUESDAY + 60 * 1000)
  // 刷新不等于开/关窗。
  assert.equal(desktop.calls.futures.length, before)
})

test('futures-window 这一包 < 64 KiB（helper 单行不是瓶颈）', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins: 500 }), 'utf8')
  const clock = { value: TUESDAY }
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    farmNow: () => clock.value,
    marketNow: () => clock.value
  })
  await service.ready
  const state = service.futuresWindow()
  const line = shared.encodeMessage({ type: 'futures-window', open: true, state: shared.normalizeFuturesView(state) })
  assert.notEqual(line, null)
  assert.ok(Buffer.byteLength(line, 'utf8') < 64 * 1024)
})
