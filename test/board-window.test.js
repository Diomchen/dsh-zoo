/**
 * 票 79：盘口小窗的宿主侧集成（不开 Electron）。
 *
 * 覆盖：
 *   1. `trading-open` → `desktop.boardWindow({open:true, state})`，窗口拿到完整视图
 *      （价格/倒计时/硬币/持仓/历史 + 按钮白名单）；场景里没有 `controls.trading`；
 *   2. 再点一次「盘口」/ `trading-close` → `board-window {open:false, close:true}`；
 *      ×/Esc 关窗后再点「盘口」会重新打开；没有桌面层时是 `desktop-off`；
 *   3. 窗口提交（helper 事件）开仓/平仓 → 79 的 store → action-result，硬币与历史跟着变；
 *   4. `desktop/shared.js` 的新跳白名单：board-window 命令、board-submit、status、菜单 id。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { FARM_FILE } from '../src/farm.js'
import { applyCropCatalog, resetCropCatalog } from '../src/farm-rules.js'
import { createService } from '../src/service.js'
import { TRADING_FILE } from '../src/trading.js'
import { MAX_WEEK_PNL, MAX_WEEK_PNL_PCT } from '../src/protocol.js'
import { buildLeague } from '../src/trading-league.js'
import {
  BOARD_TIMEFRAMES,
  SLOT_MS,
  TICK_MS,
  PRICE_CEIL_RATIO,
  PRICE_FLOOR_RATIO,
  TRADING_LEVERAGES,
  TRADING_STOP_LEVELS,
  boardCrops,
  markPrice,
  settlementOf,
  slotIndexAt,
  weekStartOf
} from '../src/trading-rules.js'

const require = createRequire(import.meta.url)
// 渲染页和 Node 测试共用同一份纯视图模型（desktop/ 是 CommonJS）。
const boardView = require('../desktop/trading-view.js')

const SLOT_EDGE = 1763308800000

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
  return {
    ctx: {
      webServer: {
        register (options) {
          routes.push(options)
          return () => {}
        }
      },
      logger: { info () {}, warn () {} }
    },
    routes
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-board-window-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/** 盘口要花硬币：先写一份有 500 硬币的农场存档（默认农场只有 30）。 */
async function seedFarm (dir, coins = 500) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins }), 'utf8')
}

function makeService (t, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    network: false,
    petBridge: false,
    skinServer: false,
    ...options
  })
  service.routes = routes
  t.after(() => service.dispose())
  t.after(() => resetCropCatalog())
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

/** 只记录场景/窗口命令/action-result 的桌面替身；不 spawn Electron。 */
function desktopDouble () {
  const calls = { scenes: [], windows: [], board: [], results: [] }
  let onEvent = null
  let farmOpen = false
  let boardOpen = false
  return {
    calls,
    factory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update (scene) { calls.scenes.push(scene); return true },
        resync (scene) { calls.scenes.push(scene); return true },
        status () { return { farmOpen, boardOpen } },
        farmWindow (payload) {
          calls.windows.push(payload)
          if (payload.close === true) farmOpen = false
          else if (payload.open === true) farmOpen = true
          return true
        },
        boardWindow (payload) {
          calls.board.push(payload)
          if (payload.close === true) boardOpen = false
          else if (payload.open === true) boardOpen = true
          return true
        },
        actionResult (id, result) {
          calls.results.push({ id, result })
        },
        dispose () {}
      }
    },
    ready (workArea = { x: 0, y: 30, width: 1000, height: 700 }) {
      onEvent?.({ type: 'ready', pid: 4242, workArea, displays: [{ id: 1, bounds: workArea, workArea, scaleFactor: 1, primary: true }] })
    },
    emit (event) {
      onEvent?.(event)
    },
    /** 模拟用户在窗口里点 × / 按 Esc：helper 关窗，并把真实状态回报宿主。 */
    userCloseBoard () {
      boardOpen = false
      onEvent?.({ type: 'board-window-state', open: false })
    },
    isBoardOpen () { return boardOpen }
  }
}

test('trading-open：窗口拿完整盘口视图；场景没有 trading 控件；再点一次关闭', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir)
  const clock = { value: SLOT_EDGE + 3 * TICK_MS }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  // 桌面场景不放盘口摘要：它是独立窗口，和农场一样只走 board-window 命令。
  const scene = desktop.calls.scenes.at(-1)
  assert.equal('trading' in scene.controls, false)

  const opened = await callAction(service, { action: 'trading-open' })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.ok, true)
  assert.equal(opened.body.window, 'opened')
  assert.equal(desktop.calls.board.length, 1)
  const command = desktop.calls.board[0]
  assert.equal(command.open, true)
  assert.equal('close' in command, false)
  const state = command.state
  assert.equal(state.coins.available, 500)
  assert.equal(state.coins.locked, 0)
  assert.equal(state.coins.total, 500)
  // 票 88：`payload.bar` 是目录里**第一个**作物的当前一根（目录顺序 pea 打头）。
  assert.equal(state.bar.crop, boardCrops()[0])
  assert.equal(state.bar.end - state.bar.start, SLOT_MS)
  assert.equal(state.bar.price, markPrice({ crop: boardCrops()[0], now: clock.value }))
  assert.equal(state.bar.remainingMs, SLOT_MS - 3 * TICK_MS)
  assert.deepEqual(state.positions, [])
  assert.deepEqual(state.history, [])
  assert.deepEqual(state.orders, [])
  // 没有邻居时 watchers 是 0/0：窗口照旧画「等邻居上线」。
  assert.deepEqual(state.league.watchers, { online: 0, reported: 0 })
  assert.deepEqual(state.limits, {
    margins: [50, 100, 250],
    // 杠杆与作物白名单都与纯规则同源：票 80 把杠杆换成 [1,5,20] 时这里不用改。
    leverages: TRADING_LEVERAGES.slice(),
    crops: boardCrops().map((id) => ({ id, name: boardView.cropNameOf(state, id) })),
    // 票 84：周期清单同样只有 `src/trading-rules.js` 一份来源。
    timeframes: BOARD_TIMEFRAMES.map(({ id, label }) => ({ id, label })),
    historyLimit: 50,
    // 票 83：「全下」与目标价带都随包下发，窗口不抄宿主常量。
    allIn: true,
    targetRatio: { floor: PRICE_FLOOR_RATIO, ceil: PRICE_CEIL_RATIO }
  })
  // 这一包能直接喂给窗口的纯视图（窗口只画）。
  const board = boardView.boardView(state, { now: clock.value })
  assert.equal(board.header.priceText, state.bar.price.toFixed(2))
  assert.equal(board.order.preview, '1× · 50 保证金：涨 1% = +0.5；跌 1% = −0.5；强平 —')

  // 再点一次「盘口」= 关窗；宿主按 helper 报的真实窗口状态决定。
  const toggled = await callAction(service, { action: 'trading-open' })
  assert.equal(toggled.body.ok, true)
  assert.equal(toggled.body.window, 'closed')
  const closeCommand = desktop.calls.board.at(-1)
  assert.equal(closeCommand.open, false)
  assert.equal(closeCommand.close, true)
  assert.equal(desktop.isBoardOpen(), false)

  // HTTP 的 `trading-close` 走同一个出口；已经关着也幂等成功。
  const explicit = await callAction(service, { action: 'trading-close' })
  assert.equal(explicit.body.ok, true)
  assert.equal(explicit.body.action, 'trading-close')
  assert.equal(explicit.body.window, 'closed')

  // 用户点 ×/Esc 关窗（helper 回报 open:false）之后，再点「盘口」必须重新打开。
  desktop.userCloseBoard()
  const reopened = await callAction(service, { action: 'trading-open' })
  assert.equal(reopened.body.window, 'opened')
  assert.equal(desktop.calls.board.at(-1).open, true)
  assert.equal(desktop.isBoardOpen(), true)

  // 没有桌面层：明确失败 + 人话，不静默。
  const offline = makeService(t, {
    dataDir: await tempDir(t),
    petConfigPath: join(dir, 'missing.jsonc'),
    desktop: false
  })
  await offline.ready
  const noDesktop = await callAction(offline, { action: 'trading-open' })
  assert.equal(noDesktop.status, 409)
  assert.equal(noDesktop.body.error, 'desktop-off')
  assert.match(noDesktop.body.notice, /桌面层/)
  const noDesktopClose = await callAction(offline, { action: 'trading-close' })
  assert.equal(noDesktopClose.body.error, 'desktop-off')
})

test('窗口动作：开仓/平仓走 79 的 store；硬币与历史跟着变；开着的窗自动刷新', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir)
  const clock = { value: SLOT_EDGE + 2 * TICK_MS }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)
  assert.equal((await callAction(service, { action: 'trading-open' })).body.window, 'opened')

  // 窗口提交做多 50：宿主当场扣硬币，回 action-result，再推一份新盘面。
  desktop.emit({ type: 'action', id: 'board-1', action: 'trading-open-position', side: 'long', margin: 50, leverage: 1, cropId: 'tomato' })
  await waitFor(() => desktop.calls.results.length === 1)
  assert.equal(desktop.calls.results[0].result.ok, true)
  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.farm.coins, 450, '开仓当场扣掉保证金')
  assert.equal(state.body.trading.positions.length, 1)
  assert.equal(state.body.trading.positions[0].margin, 50)
  assert.equal(state.body.trading.coins.available, 450)
  assert.equal(state.body.trading.coins.locked, 50)
  assert.equal(state.body.trading.coins.total, 500 + Math.round(state.body.trading.positions[0].pnl))
  const pushed = desktop.calls.board.at(-1)
  assert.equal(pushed.open, false, '刷新不能关窗/新开窗')
  assert.equal('close' in pushed, false)
  assert.equal(pushed.state.positions.length, 1)

  // 窗口平仓：按现价结算，硬币退回 保证金+盈亏。
  const position = state.body.trading.positions[0]
  const closeAt = SLOT_EDGE + 9 * TICK_MS
  clock.value = closeAt
  const expected = settlementOf({
    side: 'long',
    margin: 50,
    leverage: 1,
    entry: position.entry,
    mark: markPrice({ crop: 'tomato', now: closeAt })
  })
  desktop.emit({ type: 'action', id: 'board-2', action: 'trading-close-position', positionId: position.id })
  await waitFor(() => desktop.calls.results.length === 2)
  assert.equal(desktop.calls.results[1].result.ok, true)
  const closed = await call(service, '/dsh-zoo/state')
  assert.equal(closed.body.farm.coins, 450 + expected.credit)
  assert.equal(closed.body.trading.positions.length, 0)
  assert.equal(closed.body.trading.history.length, 1)
  assert.equal(closed.body.trading.history[0].reason, 'close')
  assert.equal(closed.body.trading.history[0].pnl, expected.pnl)
  assert.equal(closed.body.trading.week.pnl, expected.pnl)

  // 失败也要冒一句人话：0 保证金 / 带外目标价都不行（票 83 起 250 是合法预设）。
  desktop.emit({ type: 'action', id: 'board-3', action: 'trading-open-position', side: 'long', margin: 0, leverage: 1, cropId: 'tomato' })
  await waitFor(() => desktop.calls.results.length === 3)
  const refused = desktop.calls.results[2].result
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'bad-margin')
  assert.match(refused.notice, /保证金/)

  // 倒计时到 0 时窗口请宿主重推一拍：这条动作不需要桌面状态也能成功。
  desktop.emit({ type: 'action', id: 'board-4', action: 'trading-refresh' })
  await waitFor(() => desktop.calls.results.length === 4)
  assert.equal(desktop.calls.results[3].result.ok, true)
})

test('shared 白名单：board-window 命令、board-submit、status 字段、菜单 id 都在', () => {
  // 菜单：右键「盘口」与农场窗里的「盘口」按钮都能发出来。
  assert.equal(shared.MENU_TOOL_IDS.includes('trading'), true)
  assert.equal(shared.MENU_ACTION_IDS.includes('trading-open'), true)
  assert.equal(shared.FARM_ACTIONS.includes('trading-open'), true)
  assert.deepEqual(shared.normalizeFarmAction({ action: 'trading-open' }), { action: 'trading-open' })
  assert.equal(shared.normalizeFarmAction({ action: 'trading-open', plotId: '../p1' }).plotId, undefined)

  // 宿主 → helper：board-window 的三种语义，以及坏 state 变 null（窗口画空态）。
  const open = shared.normalizeHostCommand({ type: 'board-window', open: true, state: { coins: {}, limits: {} } })
  assert.equal(open.ok, true)
  assert.equal(open.command.type, 'board-window')
  assert.equal(open.command.open, true)
  assert.equal('close' in open.command, false)
  assert.equal(shared.normalizeHostCommand({ type: 'board-window', close: true }).command.close, true)
  assert.equal(shared.normalizeHostCommand({ type: 'board-window', open: true, state: 42 }).command.state, null)
  const normalized = shared.normalizeHostCommand({
    type: 'board-window',
    open: true,
    state: {
      coins: { available: 120, locked: 50, total: 172, secret: 1 },
      bar: { crop: 'tomato', price: 5, open: 4.9, end: 1, start: 0, slot: 2, remainingMs: 10, secret: 1 },
      limits: {
        margins: [50, 100, 100, 250, 'x'],
        leverages: [1],
        // 票 88：目录外但形状合法的 id 会当「新作物」放行；形状不合法才丢。
        crops: [{ id: 'tomato', name: '小番茄' }, { id: 'Not A Crop!', name: '假' }],
        historyLimit: 50,
        allIn: true,
        targetRatio: { floor: 0.55, ceil: 1.75 }
      },
      positions: [{ id: 'p1', crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5, mark: 5.1, pnl: 1, secret: 1 }],
      history: [],
      secret: 1
    }
  })
  assert.equal(normalized.command.state.coins.available, 120)
  assert.equal('secret' in normalized.command.state, false)
  assert.equal('secret' in normalized.command.state.bar, false)
  assert.deepEqual(normalized.command.state.limits.margins, [50, 100, 250])
  assert.equal(normalized.command.state.limits.allIn, true)
  assert.deepEqual(normalized.command.state.limits.targetRatio,
    { floor: PRICE_FLOOR_RATIO, ceil: PRICE_CEIL_RATIO })
  assert.deepEqual(normalized.command.state.limits.crops, [{ id: 'tomato', name: '小番茄' }])
  assert.equal('secret' in normalized.command.state.positions[0], false)
  assert.equal(normalized.command.state.positions[0].id, 'p1')
  // 票 81：强平价与止损档位过白名单；1× 的 null 必须还是 null（窗口显示「—」）。
  const pinned = shared.normalizeBoardView({
    positions: [{ id: 'p1', crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5, liquidation: null, stopLoss: 0.5 }]
  })
  assert.equal(pinned.positions[0].liquidation, null)
  assert.equal(pinned.positions[0].stopLoss, 0.5)
  const noStop = shared.normalizeBoardView({
    positions: [{ id: 'p2', crop: 'tomato', side: 'long', margin: 50, leverage: 5, entry: 5, liquidation: 4.1 }]
  })
  assert.equal(noStop.positions[0].stopLoss, 0, '没有字段就是关')
  assert.equal(noStop.positions[0].liquidation, 4.1)
  // 认不出的止损档位退成「关」，不替玩家猜一档。
  assert.equal(shared.normalizeBoardView({
    positions: [{ id: 'p3', crop: 'tomato', side: 'long', margin: 50, leverage: 5, entry: 5, stopLoss: 0.3 }]
  }).positions[0].stopLoss, 0)

  // helper → 宿主：status 与窗口开关事件。
  const status = shared.normalizeHelperEvent({
    type: 'status', boardOpen: true, boardVisible: true, boardFocused: false
  })
  assert.equal(status.event.status.boardOpen, true)
  assert.equal(status.event.status.boardVisible, true)
  assert.equal(status.event.status.boardFocused, false)
  assert.deepEqual(shared.normalizeHelperEvent({ type: 'board-window-state', open: false }).event,
    { type: 'board-window-state', id: null, open: false })

  // 冒烟：截图与失焦模拟都认得这扇窗。
  assert.equal(shared.normalizeHostCommand({ type: 'shot', path: '/tmp/a.png', window: 'board' }).command.window, 'board')
  assert.equal(shared.normalizeHostCommand({ type: 'debug-blur', window: 'board' }).command.window, 'board')

  // 窗口提交的唯一白名单。
  const positionId = '3f0f2a1c-1d2e-4b3a-8c9d-0e1f2a3b4c5d'
  assert.deepEqual(
    shared.normalizeBoardAction({ action: 'trading-open-position', side: 'long', margin: 50, leverage: 1, cropId: 'tomato' }),
    { action: 'trading-open-position', side: 'long', margin: 50, leverage: 1, cropId: 'tomato' }
  )
  assert.deepEqual(shared.normalizeBoardAction({ action: 'trading-close-position', positionId }),
    { action: 'trading-close-position', positionId })
  assert.deepEqual(shared.normalizeBoardAction({ action: 'trading-refresh' }), { action: 'trading-refresh' })
  // 票 81：止损循环只认四档；档位缺一个或不在表里，整条拒绝。
  for (const level of [0, 0.25, 0.5, 1]) {
    assert.deepEqual(shared.normalizeBoardAction({ action: 'trading-set-stop', positionId, level }),
      { action: 'trading-set-stop', positionId, level })
  }
  for (const bad of [
    { action: 'trading-set-stop', positionId, level: 0.3 },
    { action: 'trading-set-stop', positionId, level: -25 },
    { action: 'trading-set-stop', positionId, level: 'x' },
    { action: 'trading-set-stop', positionId: 'p1', level: 0.5 },
    { action: 'trading-set-stop', level: 0.5 }
  ]) {
    assert.equal(shared.normalizeBoardAction(bad), null, JSON.stringify(bad))
  }
  // 窗口 / helper / 宿主三处的止损四档是同一组数（改档位时一起改）。
  assert.deepEqual(shared.BOARD_STOP_LEVELS, boardView.stopLevels())
  assert.deepEqual(shared.BOARD_STOP_LEVELS, TRADING_STOP_LEVELS)
  // 杠杆的形状上限也同源（helper 不再各写一个 20）。
  assert.equal(shared.BOARD_MAX_LEVERAGE, 20)
  // 票 83：到价挂单 / 撤单的字段白名单。
  assert.deepEqual(
    shared.normalizeBoardAction({
      action: 'trading-place-order', side: 'short', margin: 250, leverage: 20, cropId: 'tomato', target: 5.5
    }),
    { action: 'trading-place-order', side: 'short', margin: 250, leverage: 20, cropId: 'tomato', target: 5.5 }
  )
  assert.deepEqual(shared.normalizeBoardAction({ action: 'trading-cancel-order', orderId: positionId }),
    { action: 'trading-cancel-order', orderId: positionId })
  for (const bad of [
    { action: 'trading-place-order', side: 'short', margin: 250, leverage: 20, cropId: 'tomato' },
    // 2× 是形状合法、宿主按白名单拒（和开仓同一条分工）；这里只测形状。
    { action: 'trading-place-order', side: 'short', margin: 0, cropId: 'tomato', target: 5.5 },
    { action: 'trading-place-order', side: 'short', margin: 250, cropId: 'tomato', target: 'x' },
    { action: 'trading-place-order', side: 'short', margin: 250, cropId: 'tomato', target: -1 },
    { action: 'trading-cancel-order' },
    { action: 'trading-cancel-order', orderId: 'p1' }
  ]) {
    assert.equal(shared.normalizeBoardAction(bad), null, JSON.stringify(bad))
  }
  // helper → 宿主这一跳也要保留盘口字段：以前落到农场窄口，side/target/orderId 会被削掉。
  assert.deepEqual(
    shared.normalizeHelperEvent({
      type: 'action',
      id: 'board-9',
      action: 'trading-place-order',
      side: 'long',
      margin: 250,
      leverage: 5,
      cropId: 'tomato',
      target: 5.5
    }).event,
    {
      type: 'action',
      id: 'board-9',
      action: 'trading-place-order',
      side: 'long',
      margin: 250,
      leverage: 5,
      cropId: 'tomato',
      target: 5.5
    }
  )
  assert.deepEqual(
    shared.normalizeHelperEvent({ type: 'action', id: 'board-10', action: 'trading-cancel-order', orderId: positionId }).event,
    { type: 'action', id: 'board-10', action: 'trading-cancel-order', orderId: positionId }
  )
  assert.equal(shared.normalizeHelperEvent({
    type: 'action', id: 'board-11', action: 'trading-place-order', side: 'up', margin: 50, leverage: 1, cropId: 'tomato', target: 5
  }).ok, false)
  // 盘口动作在 helper → 宿主的动作白名单里（少了这组，窗口的申请会被整条丢掉）。
  for (const action of ['trading-place-order', 'trading-cancel-order', 'trading-open-position']) {
    assert.equal(shared.DESKTOP_ACTIONS.includes(action), true, action)
  }

  for (const bad of [
    null,
    'x',
    { action: 'farm-plant', plotId: 'p1' },
    { action: 'trading-open-position', side: 'up', margin: 50, leverage: 1, cropId: 'tomato' },
    { action: 'trading-open-position', side: 'long', margin: 50.5, leverage: 1, cropId: 'tomato' },
    // 票 88：盘口 id 只守形状，未知但同形的作物交给宿主按目录拒（这里用非法形状）。
    { action: 'trading-open-position', side: 'long', margin: 50, leverage: 5, cropId: 'Not A Crop!' },
    { action: 'trading-close-position' },
    { action: 'trading-close-position', positionId: 'p1' }
  ]) {
    assert.equal(shared.normalizeBoardAction(bad), null, JSON.stringify(bad))
  }
  // 票 82：真人周榜穿过 helper 白名单——嵌套的 rows/positions 一个字段都不能被削掉
  // （§9.4 的老坑：宿主发了、窗口收不到，界面看起来只是「没有邻居」）。
  const leagueDeviceId = positionId
  const leaguePeerId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f2a3b4c5d'
  const league = shared.normalizeBoardView({
    league: {
      rows: [
        {
          deviceId: leagueDeviceId,
          nickname: '小米',
          weekPnl: 12,
          weekPnlPct: 0.035,
          positions: [{ crop: 'tomato', side: 'long', leverage: 5, margin: 50, entry: 5, secret: 1 }],
          me: true,
          secret: 1
        },
        // 同一个 deviceId 只留第一行。
        { deviceId: leagueDeviceId, nickname: '重影', weekPnl: 999, positions: [], me: false },
        { deviceId: 'not-a-uuid', nickname: '假', weekPnl: 1, positions: [], me: false },
        {
          deviceId: leaguePeerId,
          nickname: '邻居',
          weekPnl: -3,
          positions: [
            { crop: 'Not A Crop!', side: 'long', leverage: 5 },
            { crop: 'tomato', side: 'up', leverage: 5 },
            { crop: 'pumpkin', side: 'short', leverage: 20 }
          ]
        }
      ],
      sentiment: { long: 1, short: 1, flat: 0, secret: 1 },
      self: { weekPnl: 12, weekPnlPct: 0.035, coins: 999, secret: 1 },
      // 旧版本邻居的可见计数（评审 P1）：只认两个非负整数。
      watchers: { online: 2, reported: 1, secret: 1 },
      secret: 1
    }
  }).league
  assert.deepEqual(Object.keys(league), ['rows', 'sentiment', 'self', 'watchers'])
  assert.equal(league.rows.length, 2)
  assert.deepEqual(league.rows.map((row) => row.nickname), ['小米', '邻居'])
  assert.equal(league.rows[0].me, true)
  assert.deepEqual(Object.keys(league.rows[0]),
    ['deviceId', 'nickname', 'weekPnl', 'weekPnlPct', 'positions', 'me'])
  assert.deepEqual(league.rows[0].positions, [{ crop: 'tomato', side: 'long', leverage: 5 }])
  assert.deepEqual(league.rows[1].positions, [{ crop: 'pumpkin', side: 'short', leverage: 20 }])
  assert.equal(league.rows[1].weekPnlPct, null, '邻居没报收益率就是 null（窗口画「—」）')
  assert.deepEqual(league.sentiment, { long: 1, short: 1, flat: 0 })
  assert.deepEqual(league.self, { weekPnl: 12, weekPnlPct: 0.035 })
  assert.deepEqual(league.watchers, { online: 2, reported: 1 })
  // 缺/坏 watchers 归零，而不是把 NaN 画到窗口上。
  assert.deepEqual(shared.normalizeBoardView({}).league.watchers, { online: 0, reported: 0 })
  assert.deepEqual(
    shared.normalizeBoardView({ league: { watchers: { online: 'x', reported: -1 } } }).league.watchers,
    { online: 0, reported: 0 }
  )

  // 评审 P1：持仓/挂单最多过 200 条；宿主没给 totals 时用收到条数兜底（不是被截后的 200）。
  const manyPositions = Array.from({ length: 240 }, (_, index) => ({
    id: 'p' + index, crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5
  }))
  const capped = shared.normalizeBoardView({ positions: manyPositions })
  assert.equal(capped.positions.length, 200)
  assert.equal(capped.positionsTotal, 240)
  assert.equal(shared.normalizeBoardView({ positions: manyPositions, positionsTotal: 260 }).positionsTotal, 260)
  const manyOrders = Array.from({ length: 240 }, (_, index) => ({
    id: 'o' + index, crop: 'tomato', side: 'long', target: 5, margin: 50, leverage: 1,
    placedAt: 1763308800000, slot: 1959232
  }))
  const cappedOrders = shared.normalizeBoardView({ orders: manyOrders })
  assert.equal(cappedOrders.orders.length, 200)
  assert.equal(cappedOrders.ordersTotal, 240)
  // 老宿主/坏包没有这两块：总数就是 0，表头写「持仓 0 / 挂单 0」。
  assert.equal(shared.normalizeBoardView({}).positionsTotal, 0)
  assert.equal(shared.normalizeBoardView({}).ordersTotal, 0)

  // 票 83：到价挂单穿过 helper 白名单——§9.4 的老坑：宿主发了、窗口永远收不到。
  const orderId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f2a3b4c5d'
  const orderView = shared.normalizeBoardView({
    orders: [
      {
        id: orderId,
        crop: 'tomato',
        side: 'short',
        target: 5.5,
        margin: 250,
        leverage: 20,
        placedAt: 1763308800000,
        slot: 1959232,
        remainingMs: 600000,
        secret: 1
      },
      { id: 'not-a-uuid', crop: 'tomato', side: 'long', target: 5.5, margin: 50, leverage: 1, placedAt: 1, slot: 1 },
      { id: orderId, crop: 'Not A Crop!', side: 'long', target: 5.5, margin: 50, leverage: 1, placedAt: 1, slot: 1 }
    ]
  })
  assert.equal(orderView.orders.length, 2, '坏行只丢自己（crop 不合法）')
  assert.deepEqual(Object.keys(orderView.orders[0]),
    ['id', 'crop', 'side', 'target', 'margin', 'leverage', 'placedAt', 'slot', 'remainingMs'])
  assert.equal(orderView.orders[0].target, 5.5)
  assert.equal(orderView.orders[1].id, 'not-a-uuid')
  // 老宿主/坏包没有 orders：空数组，不是 undefined。
  assert.deepEqual(shared.normalizeBoardView({}).orders, [])
  assert.equal(shared.normalizeBoardView({ limits: { allIn: 'yes' } }).limits.allIn, false)
  assert.equal(shared.normalizeBoardView({ limits: { targetRatio: { floor: 0, ceil: 1 } } }).limits.targetRatio, null)

  // 读盘归一化（窗口形状）也不认多余字段。
  assert.deepEqual(shared.normalizeBoardView(null), null)
})

test('评审 P1：40 手持仓按最新在前下发，总数不丢，最新一手可平', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir)
  const clock = { value: SLOT_EDGE + 5 * TICK_MS }
  const id = (index) => '00000000-0000-4000-8000-' + String(index).padStart(12, '0')
  const positions = []
  for (let index = 0; index < 40; index += 1) {
    positions.push({
      id: id(index),
      crop: 'tomato',
      side: 'long',
      margin: 50,
      leverage: 1,
      entry: 5,
      // 都在当前这一根里；越早开的下标越大。最新 = id(0)。
      openedAt: clock.value - index * 1000,
      stopLoss: 0
    })
  }
  // 挂单也按 placedAt 最新在前（目标价在带内、这一根里不会成交）。
  const orders = [0, 1, 2].map((index) => ({
    id: id(900 + index),
    crop: 'tomato',
    side: 'long',
    target: 2.75,
    margin: 50,
    leverage: 1,
    placedAt: clock.value - index * 1000,
    slot: slotIndexAt(clock.value)
  }))
  await writeFile(join(dir, TRADING_FILE), JSON.stringify({
    version: 1,
    positions,
    orders,
    history: []
  }), 'utf8')

  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)
  assert.equal((await callAction(service, { action: 'trading-open' })).body.window, 'opened')

  const state = desktop.calls.board[0].state
  assert.equal(state.positions.length, 40)
  assert.equal(state.positionsTotal, 40)
  assert.equal(state.positions[0].id, id(0), '最新开的一手排第一')
  assert.equal(state.positions[39].id, id(39), '最早开的一手排最后')
  assert.equal(state.orders.length, 3)
  assert.equal(state.ordersTotal, 3)
  assert.equal(state.orders[0].id, id(900), '最新挂的单排第一')

  // 白名单 + 纯视图：第一张卡就是最新一手，而且真的能点平仓。
  const normalized = shared.normalizeBoardView(state)
  assert.equal(normalized.positionsTotal, 40)
  const board = boardView.boardView(normalized, { now: clock.value })
  assert.equal(board.positions[0].id, id(0))
  assert.equal(board.positions[0].canClose, true)
  assert.equal(board.positionsMetaText, '持仓 40')
  assert.equal(board.ordersMetaText, '挂单 3')

  // 平掉最新一手：账本剩 39 手，窗口的第一张卡换成第二新的那一手。
  clock.value += TICK_MS
  desktop.emit({
    type: 'action',
    id: 'board-close-newest',
    action: 'trading-close-position',
    positionId: id(0)
  })
  await waitFor(() => desktop.calls.results.length === 1)
  assert.equal(desktop.calls.results[0].result.ok, true,
    JSON.stringify(desktop.calls.results[0].result))
  const after = shared.normalizeBoardView(desktop.calls.board.at(-1).state)
  assert.equal(after.positionsTotal, 39)
  assert.equal(after.positions.length, 39)
  assert.equal(after.positions[0].id, id(1), '平掉最新的之后，第二新的排第一')
  assert.equal(after.ordersTotal, 3)
})

test('票 81/88：整份 payload 带目录全部作物 K 线 + 风向，并能穿过 helper 的白名单', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir)
  const clock = { value: SLOT_EDGE + 4 * TICK_MS }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)
  assert.equal((await callAction(service, { action: 'trading-open' })).body.window, 'opened')

  const state = desktop.calls.board[0].state
  const crops = boardCrops()
  // 票 88：目录里十种作物各一张图：24 根整根 + 当前一根（1 分钟 tick）。
  // 15 分图只下发在 `timeframes['15m']`；旧的 `charts` 字段不再重复一份（payload 体积）。
  assert.equal('charts' in state, false)
  assert.deepEqual(Object.keys(state.timeframes['15m']), crops)
  for (const crop of crops) {
    const chart = state.timeframes['15m'][crop]
    assert.equal(chart.bars.length, 24, crop + ' 应该有 24 根')
    // 票 88 的传输形：一根是 7 个数字的数组 [slot, start, end, open, high, low, close]。
    assert.equal(chart.bars[0].length, 7, crop + ' 的 K 线是紧凑数组')
    assert.equal(chart.current.slot, state.bar.slot)
    assert.equal(chart.current.tick, 4)
    assert.equal(chart.current.price, markPrice({ crop, now: clock.value }))
    assert.ok(chart.base > 0)
  }
  // 风向：目录里每一种作物各一份，置信度落在 55–68%。
  assert.deepEqual(Object.keys(state.hint), crops)
  for (const crop of crops) {
    assert.ok(['up', 'down', 'flat'].includes(state.hint[crop].direction))
    assert.ok(state.hint[crop].confidence >= 0.55 && state.hint[crop].confidence <= 0.68)
  }
  // 票 79 的窗口还认 `payload.bar`：它是目录第一个作物的当前一根（票 88：顺序同目录）。
  assert.equal(state.bar.crop, crops[0])
  assert.equal(state.bar.price, state.timeframes['15m'][crops[0]].current.price)

  // 窗口拿到的是 helper 白名单之后的形状：charts/hint 不能被削掉（§9.4 的老坑）。
  const hop = shared.normalizeHostCommand({ type: 'board-window', open: false, state })
  assert.equal(hop.ok, true)
  // 旧字段从 `timeframes['15m']` 补回；十种作物一张不少（白名单不再是 8）。
  assert.deepEqual(Object.keys(hop.command.state.charts), crops)
  assert.equal(hop.command.state.charts.tomato.bars.length, 24)
  // 紧凑数组在 helper 里还原成对象：窗口视图只认对象形。
  const rawBar = state.timeframes['15m'].tomato.bars[0]
  assert.deepEqual(hop.command.state.charts.tomato.bars[0], {
    slot: rawBar[0],
    start: rawBar[1],
    end: rawBar[2],
    open: rawBar[3],
    high: rawBar[4],
    low: rawBar[5],
    close: rawBar[6]
  })
  assert.equal(hop.command.state.hint.tomato.confidence, state.hint.tomato.confidence)
  assert.equal(hop.command.state.charts.tomato.current.tick, 4)

  // 窗口的纯视图能直接吃这一包：K 线、图例、风向都画得出来。
  const board = boardView.boardView(hop.command.state, { now: clock.value })
  assert.equal(board.chart.hasChart, true)
  assert.equal(board.chart.geometry.bars.length, 24)
  assert.equal(board.chart.geometry.forming.slot, state.bar.slot)
  assert.equal(board.chart.legend[0].text, hop.command.state.charts[crops[0]].base.toFixed(2))
  assert.equal(board.hint.note, '不是保证')
  assert.equal(board.crops.length, crops.length)
})

test('票 84：payload 带四周期 × 目录全部作物 K 线（含 start/end），穿过 helper 白名单不被削', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir)
  const clock = { value: SLOT_EDGE + 4 * TICK_MS }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)
  assert.equal((await callAction(service, { action: 'trading-open' })).body.window, 'opened')

  const state = desktop.calls.board[0].state
  const ids = BOARD_TIMEFRAMES.map(({ id }) => id)
  const crops = boardCrops()
  assert.deepEqual(Object.keys(state.timeframes), ids)
  for (const { id } of BOARD_TIMEFRAMES) {
    assert.deepEqual(Object.keys(state.timeframes[id]), crops, id + ' 带目录全部作物')
    for (const crop of crops) {
      const chart = state.timeframes[id][crop]
      assert.equal(chart.bars.length, 24, id + ' / ' + crop + ' 最近 24 根')
      assert.ok(chart.current.start <= clock.value && clock.value < chart.current.end)
      assert.equal(chart.current.price, markPrice({ crop, now: clock.value }))
      for (const bar of chart.bars) {
        // 票 88：紧凑数组 [slot, start, end, open, high, low, close]；
        // 每根仍带真实的毫秒边界（窗口的时间标签靠它）。
        assert.equal(bar.length, 7, id + ' / ' + crop + ' 的 bar 是紧凑数组')
        assert.equal(Number.isInteger(bar[1]), true)
        assert.equal(Number.isInteger(bar[2]), true)
        assert.ok(bar[2] > bar[1])
      }
      // 粗周期没有「本根第几分钟」：宿主发 null，白名单不许改成 0。
      if (id === '15m') assert.equal(typeof chart.current.tick, 'number')
      else assert.equal(chart.current.tick, null)
    }
  }
  // 票 88：15 分图不再重复下发到 `charts`（payload 体积），helper 会从 timeframes 补回。
  assert.equal('charts' in state, false)
  // 桶对齐：1 时 = 纪元整点；1 日 = 本地 00:00；1 周 = 本地周一 00:00。
  assert.equal(state.timeframes['1h'].tomato.current.start, Math.floor(clock.value / (60 * 60 * 1000)) * 60 * 60 * 1000)
  const dayStart = new Date(clock.value)
  dayStart.setHours(0, 0, 0, 0)
  assert.equal(state.timeframes['1d'].tomato.current.start, dayStart.getTime())
  assert.equal(state.timeframes['1w'].tomato.current.start, weekStartOf(clock.value))
  assert.deepEqual(state.limits.timeframes, BOARD_TIMEFRAMES.map(({ id, label }) => ({ id, label })))

  // §9.4 的老坑：helper 白名单必须放行 timeframes、limits.timeframes 与每根的 start/end。
  const hop = shared.normalizeHostCommand({ type: 'board-window', open: false, state })
  assert.equal(hop.ok, true)
  assert.deepEqual(Object.keys(hop.command.state.timeframes), ids)
  assert.deepEqual(hop.command.state.limits.timeframes, state.limits.timeframes)
  for (const id of ids) {
    const before = state.timeframes[id].tomato
    const after = hop.command.state.timeframes[id].tomato
    // 紧凑数组被还原成对象；字段一个不少（§9.4 的老坑）。
    const rawBar = before.bars[0]
    assert.deepEqual(after.bars[0], {
      slot: rawBar[0],
      start: rawBar[1],
      end: rawBar[2],
      open: rawBar[3],
      high: rawBar[4],
      low: rawBar[5],
      close: rawBar[6]
    }, id + ' 的 bar 没被削字段')
    assert.equal(after.current.start, before.current.start)
    assert.equal(after.current.end, before.current.end)
    assert.equal(after.current.tick, before.current.tick)
  }
  assert.equal(hop.command.state.timeframes['1w'].tomato.current.tick, null)

  // 窗口纯视图：四个周期都画得出来；切周期只是本地换图。
  for (const id of ids) {
    const board = boardView.boardView(hop.command.state, { now: clock.value, timeframe: id })
    assert.equal(board.chart.timeframe, id)
    assert.equal(board.chart.hasChart, true)
    assert.equal(board.chart.geometry.bars.length, 24)
    assert.equal(board.chart.timeframes.length, 4)
    assert.deepEqual(board.chart.timeframes.map((entry) => entry.active),
      ids.map((candidate) => candidate === id))
  }
})

test('票 84：timeframes 白名单——未知周期/坏数字/超量都不抛，start/end 原样放行', () => {
  const sample = (index) => ({
    slot: index,
    start: index * SLOT_MS,
    end: (index + 1) * SLOT_MS,
    open: 5,
    high: 5.1,
    low: 4.9,
    close: 5
  })
  const normalized = shared.normalizeBoardView({
    timeframes: {
      '15m': {
        tomato: {
          base: 5,
          bars: Array.from({ length: 100 }, (_, index) => sample(index)),
          current: null
        }
      },
      '1h': '坏块',
      '1d': { tomato: { base: 5, bars: [{ ...sample(0), start: 'x', end: {} }], current: null } },
      '1w': {
        tomato: {
          base: 5,
          bars: [sample(0)],
          current: {
            slot: 0,
            start: 1,
            end: 2,
            open: 5,
            high: 5,
            low: 5,
            price: 5,
            tick: null,
            remainingMs: 0
          }
        }
      },
      // 不在白名单里的周期（以及多出来的键）直接丢。
      '5m': { tomato: { base: 5, bars: [sample(0)] } },
      secret: 1
    },
    limits: {
      timeframes: [
        null,
        'x',
        { id: 'nope', label: '假' },
        { id: '1h', label: '1时' },
        { id: '1h', label: '重复' },
        { id: '1d', label: '1日' }
      ]
    }
  })
  assert.deepEqual(Object.keys(normalized.timeframes), ['15m', '1d', '1w'])
  // 每张图沿用 charts 的根数上限（宿主给 24，白名单留 40 的余量）。
  assert.equal(normalized.timeframes['15m'].tomato.bars.length, 40)
  // 坏的 start/end 变 null，不因为少一个标签丢掉整根。
  assert.equal(normalized.timeframes['1d'].tomato.bars[0].start, null)
  assert.equal(normalized.timeframes['1d'].tomato.bars[0].end, null)
  assert.equal(normalized.timeframes['1w'].tomato.current.tick, null)
  assert.deepEqual(normalized.limits.timeframes,
    [{ id: '1h', label: '1时' }, { id: '1d', label: '1日' }])
  // 坏到不成形状：空对象/空数组，绝不抛。
  for (const bad of [null, undefined, 42, 'x', [], { timeframes: 42 }]) {
    assert.doesNotThrow(() => shared.normalizeBoardView(bad))
  }
  assert.deepEqual(shared.normalizeBoardView({ timeframes: [] }).timeframes, {})
  assert.deepEqual(shared.normalizeBoardView({ limits: { timeframes: 42 } }).limits.timeframes, [])
})

/**
 * 票 88 / ADR-0031：helper 的盘口白名单按「运行时目录」放行作物，而且不再截到 8。
 * 这里用合成的 payload 把边界钉死：10 种全保留、40 种截到 32、同形新 id 也认。
 */
test('票 88：helper 白名单——10 种作物不截断、上限 32、目录外的新 id 同形放行', () => {
  const chart = { base: 5, bars: [], current: null }
  const chartsOf = (count) => {
    const charts = {}
    for (let index = 0; index < count; index += 1) {
      charts['crop' + String(index).padStart(2, '0')] = chart
    }
    return charts
  }
  // 旧上限是 8：十种作物的 payload 会被削掉第 9/10 种，正好是票 88 的问题。
  assert.equal(Object.keys(shared.normalizeBoardView({ charts: chartsOf(10) }).charts).length, 10)
  assert.equal(Object.keys(shared.normalizeBoardView({ charts: chartsOf(40) }).charts).length, 32)
  const crops = Array.from({ length: 40 }, (_, index) => ({
    id: 'crop' + String(index).padStart(2, '0'),
    name: '作物' + index
  }))
  assert.equal(shared.normalizeBoardView({ limits: { crops } }).limits.crops.length, 32)

  // 目录里还没有、但形状合法的新作物（LAN 同步刚下来的）：payload 本身是权威清单，
  // 图/风向/limits/持仓都要认，不能因为 helper 的 CROP_IDS 还没刷新就削掉。
  const custom = shared.normalizeBoardView({
    limits: { crops: [{ id: 'blueberry', name: '蓝莓' }] },
    charts: { blueberry: { base: 12, bars: [[1, 2, 3, 12, 12.5, 11.5, 12.1]], current: null } },
    hint: { blueberry: { direction: 'up', confidence: 0.6 } },
    positions: [{ id: 'p1', crop: 'blueberry', side: 'long', margin: 50, leverage: 1, entry: 12 }]
  })
  assert.deepEqual(custom.limits.crops, [{ id: 'blueberry', name: '蓝莓' }])
  assert.deepEqual(Object.keys(custom.charts), ['blueberry'])
  // 紧凑 K 线在 helper 里还原成对象（窗口只认对象形）。
  assert.deepEqual(custom.charts.blueberry.bars[0],
    { slot: 1, start: 2, end: 3, open: 12, high: 12.5, low: 11.5, close: 12.1 })
  assert.deepEqual(custom.hint.blueberry, { direction: 'up', confidence: 0.6 })
  assert.equal(custom.positions[0].crop, 'blueberry')
  // 形状不对的 id 仍然丢：放行的是「同形新作物」，不是任意字符串。
  assert.deepEqual(shared.normalizeBoardView({ charts: { 'Bad Id!': chart } }).charts, {})
})

/**
 * 票 88：运行时新增一种作物（目录重载 / LAN 同步走的就是 `applyCropCatalog()`）后，
 * 不重启、不改代码就能上盘口、开仓、出图；坏底价作物在所有入口都被忽略。
 * `makeService` 已经注册了 `resetCropCatalog()`，这个用例不把目录留给别人。
 */
test('票 88：运行时新增作物上盘口、可下单、可出图；坏底价作物被忽略', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const clock = { value: SLOT_EDGE + 4 * TICK_MS }
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    farmNow: () => clock.value
  })
  await service.ready

  // 运行时加一种（5 小时，底价 12）和一种坏底价作物；下一次构造 payload 就该看到。
  applyCropCatalog([
    { id: 'blueberry', name: '蓝莓', growMs: 5 * 60 * 60 * 1000, seedPrice: 40, yield: 4, base: 12 },
    { id: 'bad-base', name: '坏底价', growMs: 5 * 60 * 60 * 1000, seedPrice: 10, yield: 1, base: 0 }
  ])
  const state = service.tradingWindow()
  const crops = boardCrops()
  assert.ok(crops.includes('blueberry'))
  assert.ok(!crops.includes('bad-base'))
  // limits.crops 与每个周期图的键都同目录顺序（10 内置 + 蓝莓 = 11）。
  assert.deepEqual(state.limits.crops.map((entry) => entry.id), crops)
  for (const { id } of BOARD_TIMEFRAMES) {
    assert.deepEqual(Object.keys(state.timeframes[id]), crops, id + ' 带新作物')
  }
  assert.ok(state.timeframes['15m'].blueberry.base > 0)
  assert.ok(state.hint.blueberry !== undefined)
  // 坏底价作物：一张空图都不给，风向也没有。
  assert.equal('bad-base' in state.timeframes['15m'], false)
  assert.equal('bad-base' in state.hint, false)

  // 可下单：显式指定新作物也走得通（不传作物时默认用目录第一个，票 88 起是 pea）。
  const opened = await callAction(service, {
    action: 'trading-open-position', side: 'long', margin: 50, leverage: 5, cropId: 'blueberry'
  })
  assert.equal(opened.body.ok, true, JSON.stringify(opened.body))
  assert.equal(opened.body.position.crop, 'blueberry')
  const after = (await call(service, '/dsh-zoo/state')).body.trading
  assert.equal(after.positions[0].crop, 'blueberry')
  assert.ok(after.timeframes['15m'].blueberry)
  // 坏底价作物下单被拒（价格算不出来）。
  const refused = await callAction(service, {
    action: 'trading-open-position', side: 'long', margin: 50, leverage: 1, cropId: 'bad-base'
  })
  assert.equal(refused.body.ok, false)
  assert.equal(refused.body.error, 'bad-crop')
})

/** 票 88 的体积上限：最坏一包要能被 IPC 吃下，且给未来的作物留出可见的余量。 */
const BOARD_PAYLOAD_BUDGET_BYTES = 200 * 1024

/**
 * 票 88：payload 体积实测（10 种作物 × 4 周期 × 24 根 + 200 持仓 + 50 历史 + 32 榜行）。
 *
 * 盘口窗走 Electron IPC + JSON 序列化：对象形的 K 线 + 重复的 15 分图，在 10 种作物时
 * 光「图 + 风向」就约 200 KiB（实测 204,016 B），再加 200 持仓/50 历史/32 榜行会超。
 * 所以传输层用紧凑数组并且不再重复下发 15 分图（`timeframes['15m']` 就是旧 `charts`）。
 * 这条断言是**上限**：将来作物目录爆炸 / 有人把对象形加回来，会在这里响亮地失败。
 */
test('票 88：10 作物最坏 payload < 200 KiB（紧凑 K 线 + 不重复 15 分图）', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir, 500)
  const now = SLOT_EDGE + 5 * TICK_MS
  const crops = boardCrops()
  assert.equal(crops.length, 10)
  // 直接写 trading.json：200 手未平仓（窗口上限）+ 50 条历史（视图上限），
  // 比跑 250 次 HTTP 动作稳定，也不依赖 store 的写盘时序。
  const positions = []
  for (let index = 0; index < 200; index += 1) {
    positions.push({
      id: 'pos-' + String(index).padStart(3, '0'),
      crop: crops[index % crops.length],
      side: index % 2 === 0 ? 'long' : 'short',
      margin: 250,
      leverage: 20,
      entry: 12.345678901234567,
      openedAt: now,
      stopLoss: index % 4 === 0 ? 0.5 : 0
    })
  }
  const history = []
  for (let index = 0; index < 50; index += 1) {
    history.push({
      id: 'his-' + String(index).padStart(3, '0'),
      crop: crops[index % crops.length],
      side: 'long',
      margin: 250,
      leverage: 20,
      entry: 12.345678901234567,
      exit: 13.456789012345678,
      pnl: 999,
      reason: 'close',
      at: now - index * 1000
    })
  }
  await writeFile(join(dir, TRADING_FILE), JSON.stringify({
    version: 1,
    week: { start: weekStartOf(now), pnl: 0, base: 500 },
    positions,
    history
  }), 'utf8')

  const clock = { value: now }
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    farmNow: () => clock.value
  })
  await service.ready
  const payload = service.tradingWindow()
  assert.equal(payload.positions.length, 200)
  assert.equal(payload.history.length, 50)
  assert.equal(Object.keys(payload.timeframes['15m']).length, 10)

  // 32 行周榜（本机 + 31 位邻居，每行 8 条持仓、昵称顶格）：榜不随作物数长，
  // 但它也是「最坏一包」的一部分，用真实的 buildLeague() 造，形状和宿主发的一致。
  const peers = []
  for (let index = 0; index < 31; index += 1) {
    peers.push({
      deviceId: '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
      nickname: '一二三四五六七八九十一二三四五六七八九十一二',
      weekPnl: -MAX_WEEK_PNL,
      weekPnlPct: -MAX_WEEK_PNL_PCT,
      positions: crops.slice(0, 8).map((crop, position) => ({
        crop,
        side: position % 2 === 0 ? 'long' : 'short',
        leverage: 20
      })),
      seenAt: now
    })
  }
  payload.league = buildLeague({
    self: {
      deviceId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f2a3b4c5d',
      nickname: '我',
      weekPnl: 0,
      weekPnlPct: 0,
      weekBase: 500,
      positions: []
    },
    peers,
    now,
    watchers: { online: 31, reported: 31 }
  })
  assert.equal(payload.league.rows.length, 32)

  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  assert.ok(bytes < BOARD_PAYLOAD_BUDGET_BYTES,
    '盘口 payload ' + bytes + ' B 超过 ' + BOARD_PAYLOAD_BUDGET_BYTES + ' B 上限')
  // helper 的白名单要原样收下这一包（200/50/32/10 都不截）。
  const view = shared.normalizeBoardView(payload)
  assert.equal(view.positions.length, 200)
  assert.equal(view.history.length, 50)
  assert.equal(view.league.rows.length, 32)
  assert.equal(Object.keys(view.timeframes['15m']).length, 10)
  assert.equal('charts' in payload, false, '15 分图不重复下发')
})

test('票 82：payload 带真人周榜（只有自己 → 观望），并能穿过 helper 白名单', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir)
  const clock = { value: SLOT_EDGE + 4 * TICK_MS }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)
  assert.equal((await callAction(service, { action: 'trading-open' })).body.window, 'opened')

  // 没有邻居：榜上只有自己一行；全场空仓 → 观望。
  const state = desktop.calls.board[0].state
  assert.equal(state.league.rows.length, 1)
  assert.equal(state.league.rows[0].me, true)
  assert.equal(typeof state.league.rows[0].nickname, 'string')
  assert.ok(state.league.rows[0].nickname.length > 0)
  assert.equal(state.league.rows[0].weekPnl, 0)
  assert.deepEqual(state.league.rows[0].positions, [])
  assert.deepEqual(state.league.sentiment, { long: 0, short: 0, flat: 1 })
  assert.deepEqual(state.league.self, { weekPnl: 0, weekPnlPct: 0 })
  // 行里没有硬币/保证金/入场价：榜只认分数和持仓。
  assert.deepEqual(Object.keys(state.league.rows[0]),
    ['deviceId', 'nickname', 'weekPnl', 'weekPnlPct', 'positions', 'me'])

  // helper 白名单不能把 league 削掉（§9.4 的老坑），窗口的纯视图能直接画。
  const hop = shared.normalizeHostCommand({ type: 'board-window', open: false, state })
  assert.equal(hop.ok, true)
  assert.deepEqual(hop.command.state.league.rows, state.league.rows)
  assert.deepEqual(hop.command.state.league.sentiment, state.league.sentiment)
  assert.deepEqual(hop.command.state.league.self, state.league.self)
  const board = boardView.boardView(hop.command.state, { now: clock.value })
  assert.equal(board.league.rows.length, 1)
  assert.equal(board.league.rows[0].me, true)
  assert.equal(board.league.rows[0].positionsText, '观望')
  assert.equal(board.league.sentiment.text, '观望')
  assert.equal(board.league.hasPeers, false)
  assert.match(board.league.empty, /等邻居上线/)

  // 开一手：下一包 payload 的榜自己那行就有一条多单，情绪变「多 1 · 空 0」。
  const opened = await callAction(service, {
    action: 'trading-open-position', side: 'long', margin: 50, leverage: 5, cropId: 'tomato'
  })
  assert.equal(opened.body.ok, true)
  const after = await call(service, '/dsh-zoo/state')
  assert.deepEqual(after.body.trading.league.rows[0].positions,
    [{ crop: 'tomato', side: 'long', leverage: 5 }])
  assert.deepEqual(after.body.trading.league.sentiment, { long: 1, short: 0, flat: 0 })
  const rendered = boardView.boardView(after.body.trading, { now: clock.value })
  assert.equal(rendered.league.rows[0].positionsText, '多 1 · 空 0')
  assert.equal(rendered.league.sentiment.text, '多 1 · 空 0')
})

test('票 81：一分钟一拍会把新的成形 K 线推到窗口（不用重开窗）', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir)
  const clock = { value: SLOT_EDGE + 2 * TICK_MS }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value,
    farmTickMs: 15
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)
  assert.equal((await callAction(service, { action: 'trading-open' })).body.window, 'opened')
  const before = desktop.calls.board.at(-1)
  assert.equal(before.open, true)
  assert.equal(before.state.timeframes['15m'].tomato.current.tick, 2)

  // 过一分钟：宿主 tick 一次，把 tick=3 的成形 K 线推给已经开着的窗。
  clock.value += TICK_MS
  await waitFor(() => {
    const pushed = desktop.calls.board.at(-1)
    return pushed.open === false && pushed.state?.timeframes?.['15m']?.tomato?.current?.tick === 3
  })
  const pushed = desktop.calls.board.at(-1)
  assert.equal('close' in pushed, false, '刷新不能关窗')
  assert.equal(pushed.state.bar.price, markPrice({ crop: boardCrops()[0], now: clock.value }))
  assert.equal(pushed.state.timeframes['15m'].tomato.current.remainingMs, SLOT_MS - 3 * TICK_MS)
})

test('票 81：trading-set-stop 过白名单并到宿主（成败由票 80 的 store 决定）', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir)
  const clock = { value: SLOT_EDGE + 2 * TICK_MS }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)
  assert.equal((await callAction(service, { action: 'trading-open' })).body.window, 'opened')
  assert.equal((await callAction(service, {
    action: 'trading-open-position', side: 'long', margin: 50, leverage: 1, cropId: 'tomato'
  })).body.ok, true)
  const position = (await call(service, '/dsh-zoo/state')).body.trading.positions[0]

  // 窗口发出来的形状（preload → main → helper 白名单 → 宿主分发）。
  desktop.emit({
    type: 'action',
    id: 'board-stop-1',
    action: 'trading-set-stop',
    positionId: position.id,
    level: 0.5
  })
  await waitFor(() => desktop.calls.results.length === 1)
  const result = desktop.calls.results[0].result
  // 不能是「helper 白名单不认识」（bad-board-action）或「宿主不认识这条动作」（not-implemented）。
  assert.equal(result.ok === true || ['action-failed', 'no-position'].includes(result.error), true,
    '止损申请应该到宿主，实际：' + JSON.stringify(result))
  // HTTP 那条路同样认得出这个动作名。
  const replied = await callAction(service, {
    action: 'trading-set-stop', positionId: position.id, level: 0.25
  })
  assert.notEqual(replied.body.error, 'bad-board-action')
  assert.notEqual(replied.body.error, 'not-implemented')
  // 坏档位在 helper 就被挡掉，根本到不了宿主。
  assert.equal(shared.normalizeBoardAction({ action: 'trading-set-stop', positionId: position.id, level: 0.3 }), null)
})

test('票 83：到价挂单/撤单穿过 helper 白名单到宿主；payload 带 orders + limits.allIn，窗口画得出来', async (t) => {
  const dir = await tempDir(t)
  await seedFarm(dir)
  const clock = { value: SLOT_EDGE + 3 * TICK_MS }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)
  assert.equal((await callAction(service, { action: 'trading-open' })).body.window, 'opened')

  // 窗口发出来的形状（preload → main IPC → shared.normalizeBoardAction → helper 事件白名单 → 宿主）。
  const placedEvent = shared.normalizeHelperEvent({
    type: 'action',
    id: 'board-order-1',
    action: 'trading-place-order',
    side: 'long',
    margin: 100,
    leverage: 5,
    cropId: 'tomato',
    target: 5.5
  })
  assert.equal(placedEvent.ok, true, JSON.stringify(placedEvent))
  desktop.emit(placedEvent.event)
  await waitFor(() => desktop.calls.results.length === 1)
  const placed = desktop.calls.results[0].result
  assert.equal(placed.ok, true, JSON.stringify(placed))
  assert.match(placed.notice, /到价/)

  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.farm.coins, 400, '挂单当场锁掉保证金')
  assert.equal(state.body.trading.coins.available, 400)
  assert.equal(state.body.trading.coins.locked, 100, '挂单的保证金也算「含锁定」')
  assert.equal(state.body.trading.orders.length, 1)
  const order = state.body.trading.orders[0]
  assert.equal(order.crop, 'tomato')
  assert.equal(order.side, 'long')
  assert.equal(order.target, 5.5)
  assert.equal(order.margin, 100)
  assert.equal(order.leverage, 5)
  assert.equal(order.remainingMs, SLOT_MS - 3 * TICK_MS)
  assert.equal(state.body.trading.limits.allIn, true)
  assert.deepEqual(state.body.trading.limits.margins, [50, 100, 250])

  // 开着的窗收到刷新包：orders 真的过了 shared 白名单（不是永远空数组）。
  const pushed = desktop.calls.board.at(-1)
  assert.equal(pushed.open, false)
  const normalized = shared.normalizeBoardView(pushed.state)
  assert.equal(normalized.orders.length, 1)
  assert.equal(normalized.orders[0].target, 5.5)
  assert.equal(normalized.limits.allIn, true)
  const board = boardView.boardView(normalized, { now: clock.value, limitOpen: true })
  assert.equal(board.orders.length, 1)
  assert.equal(board.orders[0].targetText, '5.50')
  assert.equal(board.order.limit.canPlace, true)

  // 撤单：同一条真实 hop，保证金退回，窗口刷新成空列表。
  const cancelEvent = shared.normalizeHelperEvent({
    type: 'action', id: 'board-order-2', action: 'trading-cancel-order', orderId: order.id
  })
  assert.equal(cancelEvent.ok, true)
  desktop.emit(cancelEvent.event)
  await waitFor(() => desktop.calls.results.length === 2)
  const cancelled = desktop.calls.results[1].result
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  assert.match(cancelled.notice, /撤单/)
  const after = await call(service, '/dsh-zoo/state')
  assert.equal(after.body.farm.coins, 500)
  assert.deepEqual(after.body.trading.orders, [])
  assert.equal(after.body.trading.coins.locked, 0)
  assert.equal(desktop.calls.board.at(-1).state.orders.length, 0)

  // HTTP 那条路也认这两个动作名（脚本/测试用），坏目标价在 store 被拒。
  const refused = await callAction(service, {
    action: 'trading-place-order', side: 'long', margin: 50, leverage: 1, cropId: 'tomato', target: 99
  })
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error, 'bad-target')
})

test('评审 P1：shot 命令支持盘口窗（关着回 not-ready，不误拍主窗）', async () => {
  // helper 需要 Electron 才能真跑，这里盯源码接线：`board` 必须落到 boardWin，
  // 且命令分支把它和 bring/farm 放在同一组（关窗走统一的 not-ready）。
  const main = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')
  assert.match(main, /command\.window === 'board'/)
  assert.match(main, /target === 'board' \? boardWin/)
  assert.match(main, /command\.window === 'bring' \|\| command\.window === 'farm' \|\| command\.window === 'board'/)
})

test('票 85：盘口窗可拖动，位置记在 userData/board-window.json（静态窄口）', async () => {
  const main = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')
  const open = main.slice(main.indexOf('function openBoardWindow'), main.indexOf('function closeBoardWindow'))
  assert.match(open, /movable: true/, '盘口窗要可拖动')
  assert.match(open, /created\.on\('moved'/, '松手后要记位置')
  assert.match(main, /BOARD_POSITION_SAVE_MS = 250/, '位置落盘要防抖，不是每帧写')
  assert.match(main, /boardPositionFile/)
  assert.match(main, /windowBounds\.readPosition/)
  assert.match(main, /windowBounds\.writePosition/)

  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  assert.match(html, /\.topbar \{[\s\S]*?-webkit-app-region:\s*drag/)
  // 只有标题栏是拖动区；交互子元素都要退出，否则点 × 会变成拖窗口。
  assert.match(html, /\.topbar button,[\s\S]*?-webkit-app-region:\s*no-drag/)
  assert.match(html, /drag-grip/)
  assert.equal((html.match(/-webkit-app-region:\s*drag/g) ?? []).length, 1, '拖动区只能有一处（标题栏）')
  assert.doesNotMatch(html, /\.(?:body|card|chart-card)[^{]*\{[^}]*-webkit-app-region:\s*drag/)
})

test('票 87 / 票 89：盘口版面上图带 + 下两列，图 720×198，手绘/十字线接线齐全', async () => {
  // 版面是纯静态的：图带 286（作物条 42 + 图头 30 + 图 198 + 边框/内边距），下面两列左持仓/结算、右下单/周榜。
  const html = await readFile(new URL('../desktop/board.html', import.meta.url), 'utf8')
  assert.match(html, /grid-template-rows: 286px minmax\(0, 1fr\)/)
  assert.match(html, /grid-template-columns: minmax\(0, 1fr\) 300px/)
  assert.match(html, /\.crop-strip \{[\s\S]*?height: 42px/)
  assert.match(html, /viewBox="0 0 720 198"/)
  assert.match(html, /\.chart-svg \{[\s\S]*?height: 198px/)
  assert.doesNotMatch(html, /viewBox="0 0 384 188"/)
  // 760×700 内不整页滚动：页面本身 overflow hidden，只有列表内部滚。
  assert.match(html, /html,\s*\n\s*body \{[\s\S]*?overflow: hidden/)
  // 票 89 的硬要求：下单卡不滚动、不裁切；每行 label 40 + 控件 minmax(0,1fr)。
  assert.doesNotMatch(html, /order-scroll/)
  const fieldRow = /\.field-row \{([\s\S]*?)\}/.exec(html)
  assert.ok(fieldRow, '下单区应有 .field-row 两列行')
  assert.match(fieldRow[1], /grid-template-columns: 40px minmax\(0, 1fr\)/)
  assert.match(html, /repeat\(4, minmax\(0, 1fr\)\)/)
  assert.match(html, /repeat\(3, minmax\(0, 1fr\)\)/)
  const orderCard = /\.order-card \{([\s\S]*?)\}/.exec(html)
  assert.ok(orderCard, '应有 .order-card 规则')
  assert.match(orderCard[1], /overflow: visible/)
  assert.doesNotMatch(orderCard[1], /overflow-y: auto|overflow: auto/)
  assert.match(html, /class="order-actions"/)
  assert.match(html, /id="submit"/)
  // 焦点环/禁用态/数字等宽：票 89 的三条硬规则。
  assert.match(html, /:focus-visible \{[\s\S]*?outline: 2px dashed var\(--ink\)/)
  assert.match(html, /button:disabled,[\s\S]*?opacity: 0\.45/)
  assert.match(html, /\.pnl \{[\s\S]*?font-size: 18px/)
  assert.match(html, /font-variant-numeric: tabular-nums/)
  // 作物条：单行横滚容器 + 左右箭头 + 渐隐；不换行、不撑高。
  assert.match(html, /id="crop-scroll"/)
  assert.match(html, /id="crop-prev"/)
  assert.match(html, /id="crop-next"/)
  const cropScroll = /\.crop-scroll \{([\s\S]*?)\}/.exec(html)
  assert.ok(cropScroll, '应有 .crop-scroll 规则')
  assert.match(cropScroll[1], /overflow-x: auto/)
  assert.match(cropScroll[1], /overflow-y: hidden/)
  // 到价挂单跟持仓在左列同一个滚动区里（票 89）：右列只剩 下单 + 周榜，
  // 下单卡不会因为挂单卡片而溢出 760×700。
  assert.match(html, /id="blotter"[\s\S]*?id="orders-wrap"[\s\S]*?id="positions"/)
  assert.doesNotMatch(html, /orders-card/)
  // 票 84 的周期提示与页签没有在这次改版里丢。
  assert.match(html, /id="timeframe-tabs"/)
  assert.match(html, /id="chart-settle-hint"/)

  // 手绘滤镜只定义/引用一次；文字在独立清晰层，指针事件画十字线。
  const script = await readFile(new URL('../desktop/board.js', import.meta.url), 'utf8')
  assert.match(script, /feTurbulence/)
  assert.match(script, /feDisplacementMap/)
  assert.match(script, /filter: geometry\.sketch\.filter/)
  assert.match(script, /class: 'chart-ink'/)
  assert.match(script, /class: 'chart-crisp'/)
  assert.match(script, /view\.crosshairAt/)
  assert.match(script, /pointermove/)
  assert.match(script, /pointerleave/)
  // 票 89：作物条的箭头/滚轮/键盘/选中项滚进视野都接上了。
  assert.match(script, /updateCropArrows/)
  assert.match(script, /ensureCropVisible/)
  assert.match(script, /cropScrollEl\.addEventListener\('wheel'/)
  assert.match(script, /cropTabsEl\.addEventListener\('keydown'/)
  assert.match(script, /'data-hollow': candle\.hollow/)
  assert.match(script, /ordersWrapEl\.hidden/)
  assert.doesNotMatch(script, /console\.log/)

  // 纯视图的尺寸与列归属是公开常量，Node 测试和窗口吃同一份。
  assert.equal(boardView.BOARD_WIDTH, 760)
  assert.equal(boardView.BOARD_HEIGHT, 700)
  assert.equal(boardView.CHART_WIDTH, 720)
  assert.equal(boardView.CHART_HEIGHT, 198)
  assert.equal(boardView.LAYOUT.headerHeight, 52)
  assert.equal(boardView.LAYOUT.cropStripHeight, 42)
  assert.equal(boardView.LAYOUT.chartCardHeight, 286)
  assert.equal(boardView.LAYOUT.bottom.rightWidth, 300)
  assert.deepEqual(boardView.LAYOUT.columns.left, ['positions', 'history'])
  assert.deepEqual(boardView.LAYOUT.columns.right, ['order', 'league'])
})
