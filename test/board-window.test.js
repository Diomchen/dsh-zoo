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
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { FARM_FILE } from '../src/farm.js'
import { resetCropCatalog } from '../src/farm-rules.js'
import { createService } from '../src/service.js'
import { BOARD_CROPS, SLOT_MS, TICK_MS, TRADING_LEVERAGES, markPrice, settlementOf } from '../src/trading-rules.js'

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
  assert.equal(state.bar.crop, 'tomato')
  assert.equal(state.bar.end - state.bar.start, SLOT_MS)
  assert.equal(state.bar.price, markPrice({ crop: 'tomato', now: clock.value }))
  assert.equal(state.bar.remainingMs, SLOT_MS - 3 * TICK_MS)
  assert.deepEqual(state.positions, [])
  assert.deepEqual(state.history, [])
  assert.deepEqual(state.orders, [])
  assert.deepEqual(state.limits, {
    margins: [50, 100],
    // 杠杆与作物白名单都与纯规则同源：票 80 把杠杆换成 [1,5,20] 时这里不用改。
    leverages: TRADING_LEVERAGES.slice(),
    crops: BOARD_CROPS.map((id) => ({ id, name: boardView.cropNameOf(state, id) })),
    historyLimit: 50
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

  // 失败也要冒一句人话：250 不在白名单里。
  desktop.emit({ type: 'action', id: 'board-3', action: 'trading-open-position', side: 'long', margin: 250, leverage: 1, cropId: 'tomato' })
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
        margins: [50, 100, 100, 'x'],
        leverages: [1],
        crops: [{ id: 'tomato', name: '小番茄' }, { id: 'nope', name: '假' }],
        historyLimit: 50
      },
      positions: [{ id: 'p1', crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5, mark: 5.1, pnl: 1, secret: 1 }],
      history: [],
      secret: 1
    }
  })
  assert.equal(normalized.command.state.coins.available, 120)
  assert.equal('secret' in normalized.command.state, false)
  assert.equal('secret' in normalized.command.state.bar, false)
  assert.deepEqual(normalized.command.state.limits.margins, [50, 100])
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
  // 窗口与 helper 的止损四档是同一组数（改档位时三处一起改）。
  assert.deepEqual(shared.BOARD_STOP_LEVELS, boardView.stopLevels())
  for (const bad of [
    null,
    'x',
    { action: 'farm-plant', plotId: 'p1' },
    { action: 'trading-open-position', side: 'up', margin: 50, leverage: 1, cropId: 'tomato' },
    { action: 'trading-open-position', side: 'long', margin: 50.5, leverage: 1, cropId: 'tomato' },
    { action: 'trading-open-position', side: 'long', margin: 50, leverage: 5, cropId: 'nope' },
    { action: 'trading-close-position' },
    { action: 'trading-close-position', positionId: 'p1' }
  ]) {
    assert.equal(shared.normalizeBoardAction(bad), null, JSON.stringify(bad))
  }
  // 读盘归一化（窗口形状）也不认多余字段。
  assert.deepEqual(shared.normalizeBoardView(null), null)
})

test('票 81：整份 payload 带三作物 K 线 + 风向，并能穿过 helper 的白名单', async (t) => {
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
  // 三个作物各一张图：24 根整根 + 当前一根（1 分钟 tick）。
  assert.deepEqual(Object.keys(state.charts), ['tomato', 'carrot', 'pumpkin'])
  for (const crop of BOARD_CROPS) {
    const chart = state.charts[crop]
    assert.equal(chart.bars.length, 24, crop + ' 应该有 24 根')
    assert.equal(chart.current.slot, state.bar.slot)
    assert.equal(chart.current.tick, 4)
    assert.equal(chart.current.price, markPrice({ crop, now: clock.value }))
    assert.ok(chart.base > 0)
  }
  // 风向：三作物各一份，置信度落在 55–68%。
  assert.deepEqual(Object.keys(state.hint), ['tomato', 'carrot', 'pumpkin'])
  for (const crop of BOARD_CROPS) {
    assert.ok(['up', 'down', 'flat'].includes(state.hint[crop].direction))
    assert.ok(state.hint[crop].confidence >= 0.55 && state.hint[crop].confidence <= 0.68)
  }
  // 票 79 的窗口还认 `payload.bar`：它是第一个作物的当前一根。
  assert.equal(state.bar.crop, 'tomato')
  assert.equal(state.bar.price, state.charts.tomato.current.price)

  // 窗口拿到的是 helper 白名单之后的形状：charts/hint 不能被削掉（§9.4 的老坑）。
  const hop = shared.normalizeHostCommand({ type: 'board-window', open: false, state })
  assert.equal(hop.ok, true)
  assert.deepEqual(Object.keys(hop.command.state.charts), ['tomato', 'carrot', 'pumpkin'])
  assert.equal(hop.command.state.charts.tomato.bars.length, 24)
  assert.deepEqual(hop.command.state.charts.tomato.bars[0],
    state.charts.tomato.bars[0])
  assert.equal(hop.command.state.hint.tomato.confidence, state.hint.tomato.confidence)
  assert.equal(hop.command.state.charts.tomato.current.tick, 4)

  // 窗口的纯视图能直接吃这一包：K 线、图例、风向都画得出来。
  const board = boardView.boardView(hop.command.state, { now: clock.value })
  assert.equal(board.chart.hasChart, true)
  assert.equal(board.chart.geometry.bars.length, 24)
  assert.equal(board.chart.geometry.forming.slot, state.bar.slot)
  assert.equal(board.chart.legend[0].text, state.charts.tomato.base.toFixed(2))
  assert.equal(board.hint.note, '不是保证')
  assert.equal(board.crops.length, 3)
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
  assert.equal(before.state.charts.tomato.current.tick, 2)

  // 过一分钟：宿主 tick 一次，把 tick=3 的成形 K 线推给已经开着的窗。
  clock.value += TICK_MS
  await waitFor(() => {
    const pushed = desktop.calls.board.at(-1)
    return pushed.open === false && pushed.state?.charts?.tomato?.current?.tick === 3
  })
  const pushed = desktop.calls.board.at(-1)
  assert.equal('close' in pushed, false, '刷新不能关窗')
  assert.equal(pushed.state.bar.price, markPrice({ crop: 'tomato', now: clock.value }))
  assert.equal(pushed.state.charts.tomato.current.remainingMs, SLOT_MS - 3 * TICK_MS)
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
