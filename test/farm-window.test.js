/**
 * 票 40/46：农场小窗的宿主侧集成（桌面不再有地块条）。
 *
 * 覆盖：
 *   1. `farm-open` → `desktop.farmWindow({open:true, farm, plotId})`，窗口拿到完整视图
 *      （阶段/remainingMs/种子/作物/日志）；场景里没有 `controls.farm`；
 *   2. 再点一次「农场」/ `farm-close` → `farm-window {open:false, close:true}`；×/Esc 关窗后
 *      再点「农场」会重新打开；
 *   3. 窗口提交（helper 事件）`farm-plant` → 39 的 store → action-result；日志/地块/仓库跟着变；
 *   4. 失败码（bad-plot）回一句人话；没有桌面层时 `farm-open` / `farm-close` 都是 `desktop-off`。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { FARM_FILE, FARM_VERSION, initialFarmState } from '../src/farm.js'
import { MINUTE_MS, resetCropCatalog } from '../src/farm-rules.js'
import { MARKET_FILE, MARKET_VERSION } from '../src/market.js'
import { createService } from '../src/service.js'

const require = createRequire(import.meta.url)
// ticket 47：渲染页和 Node 测试共用同一份纯视图模型（desktop/ 是 CommonJS）。
const farmView = require('../desktop/farm-view.js')

const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-farm-window-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    // 窗口用例不需要 UDP：默认关网，避免临时身份把 beacon 发到正式端 45871，
    // 在真实街景里留下“inateck-arthur”测试邻居。需要组网的用例显式传 network:true。
    network: false,
    petBridge: false,
    skinServer: false,
    ...options
  })
  service.routes = routes
  t.after(() => service.dispose())
  // 票 59：运行时作物表是进程级状态（生产里一个进程一个 service）。
  // 用例之间必须复位，否则上一条用例写进 crops.json 的作物会漏给下一条。
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
  const calls = { scenes: [], windows: [], results: [] }
  let onEvent = null
  let farmOpen = false
  return {
    calls,
    factory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update (scene) { calls.scenes.push(scene); return true },
        resync (scene) { calls.scenes.push(scene); return true },
        // ticket 46：宿主读这个数决定右键「农场」是开还是关。
        status () { return { farmOpen } },
        farmWindow (payload) {
          calls.windows.push(payload)
          if (payload.close === true) farmOpen = false
          else if (payload.open === true) farmOpen = true
          return true
        },
        bringWindow () { return true },
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
    userCloseFarm () {
      farmOpen = false
      onEvent?.({ type: 'farm-window-state', open: false })
    },
    isFarmOpen () { return farmOpen }
  }
}

test('farm-open：窗口拿完整农场；场景没有 controls.farm；再点一次关闭', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  // ticket 46：桌面没有农场摘要/地块条；宠物场景里只有 room 的控件。
  const scene = desktop.calls.scenes.at(-1)
  assert.equal('farm' in scene.controls, false)
  assert.equal('farm' in shared.emptyControls(), false)

  // `/state.farm` 仍是 39 的全量形状（原始地块 + guard/hire/log），不是窗口形状。
  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.farm.plots.length, 4)
  assert.equal(state.body.farm.plots[0].id, 'p1')
  assert.equal('remainingMs' in state.body.farm.plots[0], false)
  assert.equal('stage' in state.body.farm.plots[0], false)
  assert.equal(state.body.farm.guard, 0.3)

  // 菜单点击 → 宿主发 farm-window，窗口拿到完整视图 + 预选地块。
  const opened = await callAction(service, { action: 'farm-open', plotId: 'p2' })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.ok, true)
  assert.equal(opened.body.window, 'opened')
  assert.equal(desktop.calls.windows.length, 1)
  const window = desktop.calls.windows[0]
  assert.equal(window.open, true)
  assert.equal(window.plotId, 'p2')
  assert.equal(window.farm.plots.length, 4)
  assert.deepEqual(window.farm.plots[0], {
    id: 'p1',
    crop: null,
    stage: 'empty',
    mature: false,
    remainingMs: 0,
    waterings: 0,
    fertilized: false
  })
  assert.deepEqual(window.farm.seeds, {
    tomato: 2, strawberry: 0, carrot: 0, corn: 0, pumpkin: 0, grape: 0
  })
  assert.deepEqual(window.farm.crops, {
    tomato: 0, strawberry: 0, carrot: 0, corn: 0, pumpkin: 0, grape: 0
  })
  assert.equal(window.farm.coins, 30)
  assert.equal(window.farm.dew, 0)
  assert.deepEqual(window.farm.log, [])

  // ticket 46：再点一次「农场」= 关窗；宿主按 helper 报的真实窗口状态决定。
  const toggled = await callAction(service, { action: 'farm-open' })
  assert.equal(toggled.status, 200)
  assert.equal(toggled.body.ok, true)
  assert.equal(toggled.body.action, 'farm-open')
  assert.equal(toggled.body.window, 'closed')
  const closeCommand = desktop.calls.windows.at(-1)
  assert.equal(closeCommand.open, false)
  assert.equal(closeCommand.close, true)
  assert.equal(desktop.isFarmOpen(), false)

  // HTTP/脚本的 `farm-close` 走同一个出口；已经关着也幂等成功。
  const explicit = await callAction(service, { action: 'farm-close' })
  assert.equal(explicit.status, 200)
  assert.equal(explicit.body.ok, true)
  assert.equal(explicit.body.action, 'farm-close')
  assert.equal(explicit.body.window, 'closed')
  assert.equal(desktop.calls.windows.at(-1).close, true)

  // 用户点 ×/Esc 关窗（helper 回报 open:false）之后，再点「农场」必须重新打开。
  desktop.userCloseFarm()
  const reopened = await callAction(service, { action: 'farm-open' })
  assert.equal(reopened.status, 200)
  assert.equal(reopened.body.window, 'opened')
  assert.equal(desktop.calls.windows.at(-1).open, true)
  assert.equal(desktop.isFarmOpen(), true)

  // 没有桌面层：明确失败 + 人话，不静默。
  const offline = makeService(t, {
    dataDir: await tempDir(t),
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktop: false
  })
  await offline.ready
  const noDesktop = await callAction(offline, { action: 'farm-open' })
  assert.equal(noDesktop.status, 409)
  assert.equal(noDesktop.body.error, 'desktop-off')
  assert.match(noDesktop.body.notice, /桌面层/)
  const noDesktopClose = await callAction(offline, { action: 'farm-close' })
  assert.equal(noDesktopClose.status, 409)
  assert.equal(noDesktopClose.body.error, 'desktop-off')
})

test('窗口动作：farm-plant → 39 的 store → action-result；开着的窗口自动刷新', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  // 窗口提交种地：宿主走和 HTTP 相同的 farm.plant，成功回 action-result。
  desktop.emit({ type: 'action', id: 'farm-1', action: 'farm-plant', plotId: 'p1', cropId: 'tomato' })
  await waitFor(() => desktop.calls.results.length === 1)
  assert.deepEqual(desktop.calls.results[0], {
    id: 'farm-1',
    result: { ok: true, notice: null, error: null }
  })
  // 种子扣了 1，作物还没收。
  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.farm.seeds.tomato, 1)
  assert.equal(state.body.farm.plots[0].crop, 'tomato')

  // 农场窗口的完整视图是新的一份（重新打开时宿主现算）。
  const reopened = await callAction(service, { action: 'farm-open' })
  assert.equal(reopened.body.ok, true)
  const farm = desktop.calls.windows.at(-1).farm
  assert.equal(farm.plots[0].crop, 'tomato')
  assert.equal(farm.plots[0].remainingMs, 30 * MINUTE_MS)
  assert.equal(farm.seeds.tomato, 1)
  assert.equal(farm.log[0].kind, 'plant')

  // 时间推进 30 分钟：无 tick 也能在动作入口补算；收菜成功、地块清空、作物 +3。
  clock.value = NOON + 30 * MINUTE_MS
  desktop.emit({ type: 'action', id: 'farm-2', action: 'farm-harvest', plotId: 'p1' })
  await waitFor(() => desktop.calls.results.length === 2)
  assert.equal(desktop.calls.results[1].result.ok, true)
  const harvested = await call(service, '/dsh-zoo/state')
  assert.equal(harvested.body.farm.crops.tomato, 3)
  assert.equal(harvested.body.farm.plots[0].crop, null)
  assert.equal(harvested.body.farm.log[0].kind, 'harvest')
  // 开着的窗口不能停在旧地块：refreshFarmWindow 推一份新数据（open:false，不关窗）。
  const refreshed = desktop.calls.windows.at(-1)
  assert.equal(refreshed.open, false)
  assert.equal('close' in refreshed, false)
  assert.equal(refreshed.farm.crops.tomato, 3)
  assert.equal(refreshed.farm.plots[0].crop, null)

  // 空地再浇一次：39 的 bad-plot 必须变成一句人话（不是 code）。
  desktop.emit({ type: 'action', id: 'farm-3', action: 'farm-water', plotId: 'p1' })
  await waitFor(() => desktop.calls.results.length === 3)
  assert.equal(desktop.calls.results[2].result.ok, false)
  assert.equal(desktop.calls.results[2].result.error, 'bad-plot')
  assert.match(desktop.calls.results[2].result.notice, /这块地不在了/)

  // 窗口连点两次：第二次在第一次结果回来前不会串 id（main 会挡，宿主这边只验 id 对得上）。
  assert.equal(desktop.calls.results.length, 3)
})

test('交易所页：farm-window 带 market；买种/卖作物走同一 store 并自动刷新窗口', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  // 小窗页签与动作白名单：交易所页必须真的存在，窗口只能发 cropId + qty。
  const html = await readFile(new URL('../desktop/farm.html', import.meta.url), 'utf8')
  assert.match(html, /data-tab="market"/)
  assert.match(html, /id="market-rows"/)
  const renderer = await readFile(new URL('../desktop/farm.js', import.meta.url), 'utf8')
  assert.match(renderer, /farm-buy-seed/)
  assert.match(renderer, /farm-sell-crop/)
  // 交易所页必须真的画出「局域网指数 / 样本」与「本机行情」。
  assert.match(renderer, /局域网指数/)
  assert.match(renderer, /本机行情/)
  assert.match(renderer, /index-stale/)
  const preload = await readFile(new URL('../desktop/farm-preload.js', import.meta.url), 'utf8')
  assert.match(preload, /qty: action\.qty/)
  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'farm-buy-seed', cropId: 'tomato', qty: 2 }),
    { action: 'farm-buy-seed', cropId: 'tomato', qty: 2 }
  )
  assert.equal(shared.normalizeFarmAction({ action: 'farm-sell-crop', cropId: 'tomato', qty: 0 }), null)
  const event = shared.normalizeHelperEvent({
    type: 'action', id: 'm0', action: 'farm-sell-crop', cropId: 'carrot', qty: 3
  })
  assert.equal(event.ok, true)
  assert.equal(event.event.qty, 3)
  assert.equal(event.event.cropId, 'carrot')
  assert.equal(shared.FARM_ACTIONS.includes('farm-buy-seed'), true)
  // helper 侧同样夹价格/重算 bid：宿主多给一个字段也不会让窗口画错价。
  const normalizedWindow = shared.normalizeFarmWindow({
    open: true,
    market: {
      prices: {
        tomato: { base: 999, price: 999, volume24h: 'x', at: 0, bid: 1 },
        carrot: null
      },
      history: [{ crop: 'tomato', side: 'sell', qty: 2, price: 5, at: NOON }],
      index: { tomato: { price: 999, at: NOON, samples: 2 }, alien: { price: 1 } }
    }
  })
  assert.equal(normalizedWindow.market.prices.tomato.base, 5)
  assert.equal(normalizedWindow.market.prices.tomato.price, 10)
  assert.equal(normalizedWindow.market.prices.tomato.bid, 9)
  assert.equal(normalizedWindow.market.prices.carrot.price, 6)
  assert.deepEqual(normalizedWindow.market.history, [
    { crop: 'tomato', side: 'sell', qty: 2, price: 5, at: NOON }
  ])
  assert.equal(normalizedWindow.market.index.tomato.price, 10)
  assert.equal('alien' in normalizedWindow.market.index, false)

  // 开窗：完整视图里带交易所；桌面场景里没有农场（ticket 46）。
  const opened = await callAction(service, { action: 'farm-open' })
  assert.equal(opened.body.ok, true)
  const window = desktop.calls.windows.at(-1)
  assert.deepEqual(window.market.prices.tomato, {
    base: 5,
    price: 5,
    volume24h: 0,
    at: NOON,
    bid: 5
  })
  assert.deepEqual(window.market.history, [])
  // 没有 peer：指数仍是完整形状，但每条都是「本机价 / samples 0」。
  assert.deepEqual(window.market.index, {
    tomato: { price: 5, at: NOON, samples: 0, stale: false },
    strawberry: { price: 7, at: NOON, samples: 0, stale: false },
    carrot: { price: 6, at: NOON, samples: 0, stale: false },
    corn: { price: 9, at: NOON, samples: 0, stale: false },
    pumpkin: { price: 30, at: NOON, samples: 0, stale: false },
    grape: { price: 24, at: NOON, samples: 0, stale: false }
  })
  assert.equal('farm' in desktop.calls.scenes.at(-1).controls, false)

  // 窗口提交买 2 颗番茄种子：宿主回人话，并推一份新的完整窗口状态（open:false）。
  desktop.emit({ type: 'action', id: 'market-1', action: 'farm-buy-seed', cropId: 'tomato', qty: 2 })
  await waitFor(() => desktop.calls.results.length === 1)
  assert.deepEqual(desktop.calls.results[0], {
    id: 'market-1',
    result: { ok: true, notice: '买了 2 颗小番茄种子，花了 12 硬币。', error: null }
  })
  await waitFor(() => desktop.calls.windows.at(-1).open === false)
  const refreshed = desktop.calls.windows.at(-1)
  assert.equal(refreshed.farm.coins, 18)
  assert.deepEqual(refreshed.farm.seeds, {
    tomato: 4, strawberry: 0, carrot: 0, corn: 0, pumpkin: 0, grape: 0
  })
  assert.equal(refreshed.market.prices.tomato.volume24h, 2)
  assert.equal(refreshed.market.history[0].side, 'buy')

  // 种下并等 30 分钟：收 3 个番茄，再卖给交易所。
  desktop.emit({ type: 'action', id: 'farm-1', action: 'farm-plant', plotId: 'p1', cropId: 'tomato' })
  await waitFor(() => desktop.calls.results.length === 2)
  assert.equal(desktop.calls.results[1].result.ok, true)
  clock.value += 30 * MINUTE_MS
  desktop.emit({ type: 'action', id: 'farm-2', action: 'farm-harvest', plotId: 'p1' })
  await waitFor(() => desktop.calls.results.length === 3)
  assert.equal(desktop.calls.results[2].result.ok, true)

  const beforeSell = desktop.calls.windows.length
  desktop.emit({ type: 'action', id: 'market-2', action: 'farm-sell-crop', cropId: 'tomato', qty: 3 })
  await waitFor(() => desktop.calls.results.length === 4)
  assert.deepEqual(desktop.calls.results[3], {
    id: 'market-2',
    result: { ok: true, notice: '卖了 3 个小番茄，得到 15 硬币。', error: null }
  })
  await waitFor(() => desktop.calls.windows.length > beforeSell)
  const soldWindow = desktop.calls.windows.at(-1)
  assert.equal(soldWindow.farm.coins, 33)
  assert.deepEqual(soldWindow.farm.crops, {
    tomato: 0, strawberry: 0, carrot: 0, corn: 0, pumpkin: 0, grape: 0
  })
  assert.equal(soldWindow.market.history[0].side, 'sell')
  assert.equal(soldWindow.market.history[0].price, 5)
  assert.ok(soldWindow.market.prices.tomato.price < 5)

  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.farm.coins, 33)
  assert.equal(state.body.market.history.length, 2)
  assert.deepEqual(state.body.market.history.map((entry) => entry.side), ['sell', 'buy'])
  assert.equal('bid' in state.body.market.prices.tomato, false, '/state 保持 SPEC 的 prices 形状')

  // 数量非法时窗口那层会先挡（shared），服务端也会再挡一次。
  desktop.emit({ type: 'action', id: 'market-3', action: 'farm-sell-crop', cropId: 'tomato', qty: 0 })
  await waitFor(() => desktop.calls.results.length === 5)
  assert.equal(desktop.calls.results[4].result.ok, false)
  assert.equal(desktop.calls.results[4].result.error, 'bad-qty')
  assert.match(desktop.calls.results[4].result.notice, /1–99/)
})


test('交易所页的局域网指数：新鲜时混进 bid，过期后标 stale 并退回本机价', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, MARKET_FILE), JSON.stringify({
    version: MARKET_VERSION,
    prices: {
      tomato: { base: 5, price: 10, volume24h: 0, at: NOON },
      carrot: { base: 6, price: 6, volume24h: 0, at: NOON },
      pumpkin: { base: 30, price: 30, volume24h: 0, at: NOON }
    },
    history: [],
    index: { tomato: { price: 5, at: NOON, samples: 3 } }
  }), 'utf8')
  const clock = { value: NOON }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory,
    farmNow: () => clock.value,
    marketNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  assert.equal((await callAction(service, { action: 'farm-open' })).body.ok, true)
  const fresh = desktop.calls.windows.at(-1).market
  assert.deepEqual(fresh.index.tomato, { price: 5, at: NOON, samples: 3, stale: false })
  // (0.85×10 + 0.15×5) × 0.9 = 7.7625 → 8
  assert.equal(fresh.prices.tomato.bid, 8)

  // 2 分钟后：指数不再参与 bid，窗口拿到 stale:true 画灰。
  // 重新开窗拿一份新数据（ticket 46：再点一次「农场」是关窗，不会刷新）。
  clock.value += 2 * MINUTE_MS + 1
  assert.equal((await callAction(service, { action: 'farm-close' })).body.ok, true)
  assert.equal((await callAction(service, { action: 'farm-open' })).body.window, 'opened')
  const stale = desktop.calls.windows.at(-1).market
  assert.equal(stale.index.tomato.stale, true)
  assert.equal(stale.prices.tomato.bid, 9, '本机 10 → bid 9')
})

// ---------------------------------------------------------------------------
// ticket 43：访客模式的窗口载荷与动作窄口
// ---------------------------------------------------------------------------

test('访客动作：shared 只放行 farm-steal/farm-help + plotId；helper 事件同样带 plotId', () => {
  assert.equal(shared.FARM_ACTIONS.includes('farm-steal'), true)
  assert.equal(shared.FARM_ACTIONS.includes('farm-help'), true)
  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'farm-steal', plotId: 'p2', visitId: 'ignored' }),
    { action: 'farm-steal', plotId: 'p2' }
  )
  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'farm-help', plotId: 'P4' }),
    { action: 'farm-help', plotId: 'p4' }
  )
  assert.equal(shared.normalizeFarmAction({ action: 'farm-steal' }), null)
  // ticket 48：p1–p50 都是合法地块；p51 越界。
  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'farm-steal', plotId: 'p9' }),
    { action: 'farm-steal', plotId: 'p9' }
  )
  assert.equal(shared.normalizeFarmAction({ action: 'farm-steal', plotId: 'p51' }), null)

  const steal = shared.normalizeHelperEvent({
    type: 'action', id: 'f1', action: 'farm-steal', plotId: 'p1'
  })
  assert.equal(steal.ok, true)
  assert.equal(steal.event.action, 'farm-steal')
  assert.equal(steal.event.plotId, 'p1')
  const help = shared.normalizeHelperEvent({
    type: 'action', id: 'f2', action: 'farm-help', plotId: 'p3'
  })
  assert.equal(help.ok, true)
  assert.equal(help.event.plotId, 'p3')
  // 缺 plotId 整条丢，不猜一块地。
  assert.equal(shared.normalizeHelperEvent({
    type: 'action', id: 'f3', action: 'farm-steal'
  }).ok, false)
})

test('farm-window：mode/visit 白名单只留布尔与 pN 地块；坏地块/坏状态退化', () => {
  const other = '99999999-9999-4999-8999-999999999999'
  const command = shared.normalizeHostCommand({
    type: 'farm-window',
    id: 'w1',
    open: true,
    mode: 'visitor',
    farm: { plots: [], coins: 30, seeds: {}, crops: {}, dew: 1 },
    visit: {
      state: 'ready',
      nickname: '  楼上的 柯基 ',
      guard: 9,
      plots: [
        { id: 'p1', crop: 'tomato', stage: 'mature', mature: true, stolenByMe: true, stolenBy: [other] },
        { id: 'p2', crop: 'carrot', stage: 'growing', remainingMs: -1, helpedByMe: true, helpedBy: [other] },
        { id: 'p9', crop: 'tomato' },
        { id: 'p3', crop: 'alien' }
      ],
      limits: {
        steal: { perVisit: 3, usedInVisit: 1, perFarm: 5, usedOnFarm: 2, perDay: 10, usedToday: 1 },
        help: { perVisit: 3, usedInVisit: 0, perFarm: 5, usedOnFarm: 0, perDay: 5, usedToday: 0 }
      },
      at: 1700000000000
    }
  })
  assert.equal(command.ok, true)
  assert.equal(command.command.mode, 'visitor')
  assert.equal(command.command.visit.state, 'ready')
  assert.equal(command.command.visit.guard, 0.8)
  assert.equal(command.command.visit.nickname, '楼上的 柯基')
  // ticket 47：地块 id 不再只认 p1–p4；p9 是合法 pN，未知作物（p3）才整块丢。
  assert.deepEqual(command.command.visit.plots, [
    { id: 'p1', crop: 'tomato', stage: 'mature', mature: true, remainingMs: 0, stolenByMe: true, helpedByMe: false },
    { id: 'p2', crop: 'carrot', stage: 'growing', mature: false, remainingMs: 0, stolenByMe: false, helpedByMe: true },
    { id: 'p9', crop: 'tomato', stage: 'growing', mature: false, remainingMs: 0, stolenByMe: false, helpedByMe: false }
  ])
  const text = JSON.stringify(command.command)
  assert.equal(text.includes(other), false, '别的访客 deviceId 不进 helper')
  assert.equal(text.includes('"stolenBy"'), false)
  assert.equal(text.includes('"helpedBy"'), false)
  assert.deepEqual(command.command.visit.limits.steal, {
    perVisit: 3, usedInVisit: 1, perFarm: 5, usedOnFarm: 2, perDay: 10, usedToday: 1
  })

  // 没有 visit 时就是 owner 模式（老宿主/老窗口照常）。
  const owner = shared.normalizeHostCommand({
    type: 'farm-window', id: 'w2', open: false, farm: { plots: [], coins: 0 }
  })
  assert.equal(owner.command.mode, 'owner')
  assert.equal('visit' in owner.command, false)

  // 坏状态退化成 error；坏 error 码丢掉；loading 时地块为空。
  const broken = shared.normalizeFarmWindow({
    mode: 'visitor',
    visit: { state: 'nope', error: '../secret', plots: 'nope' }
  })
  assert.equal(broken.visit.state, 'error')
  assert.equal(broken.visit.error, null)
  assert.deepEqual(broken.visit.plots, [])
})

test('主人日志的「谁」：完整视图保留 who（≤32 码点），且不带 owner 摘要字段', () => {
  const normalized = shared.normalizeFarm({
    plots: [],
    coins: 30,
    dew: 1,
    log: [
      { at: NOON, kind: 'steal', crop: 'tomato', qty: 1, who: '  阿蟹  ' },
      { at: NOON, kind: 'steal', crop: 'tomato', qty: 0, who: '喵'.repeat(40) },
      { at: NOON, kind: 'help', crop: 'carrot', qty: 1 },
      { at: NOON, kind: 'hire', who: '阿蟹', hours: 4, wage: 40 },
      { at: NOON, kind: 'settle', who: '阿蟹', wage: 40, earned: 18 }
    ],
    carried: [
      { kind: 'crop', crop: 'tomato', qty: 2, at: NOON, until: NOON + 1000 },
      { kind: 'wage', amount: 12, contractId: '11111111-1111-4111-8111-111111111111', at: NOON },
      { kind: 'crop', crop: 'alien', qty: 1 },
      { kind: 'wage', amount: -1 }
    ]
  })
  assert.equal(normalized.log[0].who, '阿蟹')
  assert.equal(Array.from(normalized.log[1].who).length, 32)
  assert.equal('who' in normalized.log[2], false)
  assert.deepEqual(normalized.log[3], { at: NOON, kind: 'hire', qty: 0, who: '阿蟹', hours: 4, wage: 40 })
  assert.deepEqual(normalized.log[4], { at: NOON, kind: 'settle', qty: 0, who: '阿蟹', wage: 40, earned: 18 })
  assert.deepEqual(normalized.carried, [
    { kind: 'crop', crop: 'tomato', qty: 2, at: NOON, until: NOON + 1000 },
    { kind: 'wage', amount: 12, contractId: '11111111-1111-4111-8111-111111111111', at: NOON }
  ], '坏驮包条目只丢自己')
  // ticket 46：`owner.presence` 只服务已删的地块条，不再出现在任何农场视图里。
  assert.equal('owner' in normalized, false)
})

test('访客窗口的渲染端/预加载/主进程都走同一条动作线（静态窄口检查）', async () => {
  const renderer = await readFile(new URL('../desktop/farm.js', import.meta.url), 'utf8')
  assert.match(renderer, /action === 'steal' \|\| action === 'help'/)
  assert.match(renderer, /action: 'farm-' \+ action/)
  assert.match(renderer, /visitor-banner/)
  assert.match(renderer, /stolenByMe/)
  assert.match(renderer, /helpedByMe/)
  const preload = await readFile(new URL('../desktop/farm-preload.js', import.meta.url), 'utf8')
  assert.match(preload, /plotId: action\.plotId/)
  const main = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')
  assert.match(main, /farmVisit/)
  assert.match(main, /command\.mode === 'visitor'/)
  assert.match(main, /farmPending/)
})

test('记录页：窗口拿 100 条、/state 只给 20 条；hire/settle 日志字段齐全', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const entries = Array.from({ length: 105 }, (_, index) => {
    if (index === 0) return { at: NOON, kind: 'hire', who: '阿蟹', hours: 2, wage: 20 }
    if (index === 1) return { at: NOON - 1, kind: 'settle', who: '阿蟹', wage: 20, earned: 5 }
    return { at: NOON - 2 - index, kind: index % 2 === 0 ? 'plant' : 'harvest', crop: 'tomato', qty: 1 }
  })
  const farmState = {
    ...initialFarmState(),
    version: FARM_VERSION,
    lastTickAt: NOON,
    log: entries
  }
  await writeFile(join(dir, FARM_FILE), JSON.stringify(farmState), 'utf8')
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  const opened = await callAction(service, { action: 'farm-open' })
  assert.equal(opened.body.ok, true)
  const window = desktop.calls.windows.at(-1)
  assert.equal(window.farm.log.length, 100, '窗口记录页给最近 100 条')
  assert.equal(window.farm.log[0].kind, 'hire')
  assert.equal(window.farm.log[0].wage, 20)
  assert.equal(window.farm.log[1].kind, 'settle')
  assert.equal(window.farm.log[1].earned, 5)

  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.farm.log.length, 20, '/state.farm.log 仍按 SPEC 只给 20 条')
  assert.equal('carried' in state.body.farm, false, '驮包只进窗口，不混进 /state')

  // 记录页签是真页签（可点击），日志有自己的滚动容器。
  const html = await readFile(new URL('../desktop/farm.html', import.meta.url), 'utf8')
  assert.match(html, /data-tab="log"/)
  assert.match(html, /id="page-log"/)
  assert.equal(html.includes('记录还没开放'), false)
  const renderer = await readFile(new URL('../desktop/farm.js', import.meta.url), 'utf8')
  assert.match(renderer, /slice\(0, 100\)/)
  assert.match(renderer, /page-log/)
  assert.match(renderer, /carried/)
})

test('×/Esc 关窗仍由小窗自己发 farm-close；宿主只负责打开/刷新', async () => {
  const renderer = await readFile(new URL('../desktop/farm.js', import.meta.url), 'utf8')
  // × 按钮与 Esc 都只调用桥的 close()，不自己改数据、不自己销毁窗口。
  assert.match(renderer, /closeButton\.addEventListener\('click', \(\) => api\?\.close\(\)\)/)
  assert.match(renderer, /event\.key !== 'Escape'/)
  assert.match(renderer, /api\?\.close\(\)/)
  const preload = await readFile(new URL('../desktop/farm-preload.js', import.meta.url), 'utf8')
  assert.match(preload, /ipcRenderer\.send\('dsh-zoo:farm-close'\)/)
  const main = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')
  assert.match(main, /ipcMain\.on\('dsh-zoo:farm-close'/)
  assert.match(main, /closeFarmWindow\('close'\)/)
})

// ---------------------------------------------------------------------------
// ticket 47：治愈系卡片农场外壳、播种弹窗、批量动作与「未来 20 块地」
// ---------------------------------------------------------------------------

/** 只够 `farm-view.createPlotCard` 用的最小 document/element 替身（不跑整页脚本）。 */
function fakeElement (tag) {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    dataset: {},
    style: {},
    children: [],
    attributes: {},
    hidden: false,
    disabled: false,
    title: '',
    textContent: '',
    type: '',
    appendChild (child) {
      this.children.push(child)
      return child
    },
    setAttribute (name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute (name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
    }
  }
}

function collectCards (node, out = []) {
  const classes = typeof node.className === 'string' ? node.className.split(' ') : []
  if (classes.includes('plot-card')) out.push(node)
  for (const child of node.children) collectCards(child, out)
  return out
}

test('20 块地的 farm-window：标题按 plots.length、渲染 20 张卡，不写死 4', async () => {
  const plots = Array.from({ length: 20 }, (_, index) => ({
    id: 'p' + (index + 1),
    crop: index % 2 === 0 ? 'tomato' : null,
    stage: index % 4 === 0 ? 'growing' : index % 4 === 1 ? 'mature' : 'empty',
    remainingMs: index % 4 === 0 ? 12 * 60 * 1000 : 0,
    waterings: 0,
    fertilized: false
  }))
  // 走真实 helper 窄口：20 块地不能被 normalizeFarm 截成 4 块。
  const payload = shared.normalizeFarmWindow({
    open: true,
    farm: {
      plots,
      seeds: { tomato: 2, carrot: 0, pumpkin: 0 },
      crops: { tomato: 0, carrot: 0, pumpkin: 0 },
      coins: 30,
      dew: 5
    }
  })
  assert.equal(payload.farm.plots.length, 20)
  const stats = farmView.headerStats(payload.farm)
  assert.equal(stats.total, 20)
  assert.equal(stats.planted, 10)
  assert.equal(stats.text, '10/20 已种植')
  assert.match(stats.text, /20/)

  const cards = farmView.plotCards(payload.farm, { dew: 5, busy: false })
  assert.equal(cards.length, 20)
  assert.equal(cards[0].label, '地块 1')
  assert.equal(cards[19].label, '地块 20')
  assert.equal(cards[19].plotId, 'p20')

  const documentDouble = { createElement: (tag) => fakeElement(tag) }
  const root = fakeElement('div')
  for (const card of cards) root.appendChild(farmView.createPlotCard(documentDouble, card).element)
  assert.equal(collectCards(root).length, 20, '20 块地必须建出 20 张 plot-card')

  // 网格按数量自适应；标签/计数没有 PLOT_LABEL 这种写死 1–4 的表。
  const html = await readFile(new URL('../desktop/farm.html', import.meta.url), 'utf8')
  assert.match(html, /grid-template-columns: repeat\(auto-fill, minmax\(150px, 1fr\)\)/)
  assert.match(html, /<script src="farm-view\.js"><\/script>/)
  const renderer = await readFile(new URL('../desktop/farm.js', import.meta.url), 'utf8')
  assert.equal(renderer.includes('PLOT_LABEL'), false)
  assert.match(renderer, /view\.headerStats\(/)
  assert.match(renderer, /view\.plotCards\(farm/)
})

test('50 块与锁定卡：header 显示 x/50、下一块地价、种满队列', () => {
  const plots = Array.from({ length: 50 }, (_, index) => ({
    id: 'p' + (index + 1),
    stage: index < 2 ? 'empty' : 'empty'
  }))
  const full = {
    plots,
    seeds: { tomato: 2, carrot: 1, pumpkin: 0 },
    coins: 100,
    unlocked: 50,
    maxPlots: 50,
    nextCost: null
  }
  assert.equal(farmView.headerStats(full).text, '0/50 已种植 · 地块 50/50')
  assert.equal(farmView.unlockCard(full), null, '到 50 块没有锁定卡')

  const five = {
    ...full,
    plots: plots.slice(0, 5),
    unlocked: 5,
    nextCost: 65,
    unlockLadder: [65, 75, 80, 90, 95]
  }
  assert.equal(farmView.headerStats(five).text, '0/5 已种植 · 地块 5/50 · 下一块 65')
  const card = farmView.unlockCard(five)
  assert.equal(card.label, '地块 6')
  assert.equal(card.nextCost, 65)
  assert.equal(card.affordable, true, '100 ≥ 65 + 6')
  assert.deepEqual(card.ladder, [65, 75, 80, 90, 95])
  const poor = farmView.unlockCard({ ...five, coins: 68 })
  assert.equal(poor.affordable, false, '68 − 65 = 3 < 6，留不出种子钱')

  const documentDouble = { createElement: (tag) => fakeElement(tag) }
  const built = farmView.createUnlockCard(documentDouble, card)
  assert.ok(built.element.className.includes('locked'))
  assert.equal(built.button.dataset.landAction, 'unlock')
  assert.equal(built.button.disabled, false)
  // 买不起时按钮仍可点：确认弹层要能打开，让用户看到还差多少和后续价格；
  // 真正该禁用是弹层里的「解锁 · 65 硬币」确认键。
  const openable = farmView.createUnlockCard(documentDouble, poor)
  assert.equal(openable.button.disabled, false)
  assert.equal(openable.element.dataset.affordable, 'false')
  assert.equal(openable.button.title, '留 6 硬币买种子')

  // 种满：按空地与种子库存排队；种子用完就停。
  assert.deepEqual(farmView.batchPlantTargets(five), [
    { plotId: 'p1', cropId: 'tomato' },
    { plotId: 'p2', cropId: 'tomato' },
    { plotId: 'p3', cropId: 'carrot' }
  ])
  assert.deepEqual(farmView.batchPlantTargets({ plots: [], seeds: {} }), [])
})

test('农场窗静态窄口：解锁动作、锁定卡、种满与 100 条日志', async () => {
  const html = await readFile(new URL('../desktop/farm.html', import.meta.url), 'utf8')
  assert.match(html, /id="unlock-modal"/)
  assert.match(html, /id="unlock-confirm"/)
  assert.match(html, /id="unlock-modal-close"/)
  assert.match(html, /一键种满/)
  assert.match(html, /最近 100 条/)

  const renderer = await readFile(new URL('../desktop/farm.js', import.meta.url), 'utf8')
  assert.match(renderer, /farm-unlock/)
  assert.match(renderer, /expectedUnlocked/)
  assert.match(renderer, /data-land-action="unlock"/)
  assert.match(renderer, /sendNextBatch/)
  assert.match(renderer, /slice\(0, 100\)/)
  assert.match(renderer, /view\.unlockCard\(farm\)/)
  assert.match(renderer, /view\.batchPlantTargets\(farm\)/)
  assert.match(renderer, /emptyPlotCount\(farm\)/)
  assert.match(renderer, /解锁后余额 /, '确认弹层要显示解锁后余额（买不起也要显示）')
  // ticket 49/UI：买满空地仍然只改数量；现在拆成「买满」与「全卖」两个快捷量。
  assert.match(renderer, /data-fill-buy/)
  assert.match(renderer, /data-fill-sell/)
  // visitor 模式整块不画锁定卡/解锁入口。
  assert.match(renderer, /if \(mode === 'visitor' && visit !== null\)/)

  const preload = await readFile(new URL('../desktop/farm-preload.js', import.meta.url), 'utf8')
  assert.match(preload, /expectedUnlocked: action\.expectedUnlocked/, 'preload 必须把乐观锁带下去')

  assert.equal(shared.FARM_ACTIONS.includes('farm-unlock'), true)
  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'farm-unlock', expectedUnlocked: 7 }),
    { action: 'farm-unlock', expectedUnlocked: 7 }
  )
  assert.deepEqual(shared.normalizeFarmAction({ action: 'farm-unlock' }), { action: 'farm-unlock' })
  assert.equal(shared.normalizeFarmAction({ action: 'farm-unlock', expectedUnlocked: 0 }), null)
  assert.equal(shared.normalizeFarmAction({ action: 'farm-unlock', expectedUnlocked: 3 }), null)
  assert.equal(shared.normalizeFarmAction({ action: 'farm-unlock', expectedUnlocked: 51 }), null)
  // 窗口契约与宿主同源：unlocked 最少 4，不是 1。
  assert.equal(shared.normalizeFarm({ plots: [], unlocked: 3 }).unlocked, 4)
  assert.equal(shared.normalizeFarm({ plots: [], unlocked: 1 }).unlocked, 4)
  assert.equal(shared.normalizeFarm({ plots: [], unlocked: 50 }).unlocked, 50)
})

test('farm-unlock：扣钱、加地块、stale；窗口推新视图与地价梯子', async (t) => {
  const dir = await tempDir(t)
  const farmState = {
    ...initialFarmState(),
    version: FARM_VERSION,
    coins: 500,
    lastTickAt: NOON,
    dewAt: NOON
  }
  await writeFile(join(dir, FARM_FILE), JSON.stringify(farmState), 'utf8')
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory,
    farmNow: () => NOON
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  const opened = await callAction(service, { action: 'farm-open' })
  assert.equal(opened.body.ok, true)
  let window = desktop.calls.windows.at(-1)
  assert.equal(window.farm.unlocked, 4)
  assert.equal(window.farm.maxPlots, 50)
  assert.equal(window.farm.plots.length, 4)
  assert.equal(window.farm.nextCost, 60)
  assert.deepEqual(window.farm.unlockLadder, [60, 65, 75, 80, 90, 95])

  const unlocked = await callAction(service, { action: 'farm-unlock', expectedUnlocked: 4 })
  assert.equal(unlocked.status, 200)
  assert.equal(unlocked.body.ok, true)
  assert.equal(unlocked.body.unlocked, 5)
  assert.equal(unlocked.body.cost, 60)
  assert.equal(unlocked.body.coins, 440)
  assert.equal(unlocked.body.nextCost, 65)
  assert.match(unlocked.body.notice, /解锁了第 5 块地/)
  window = desktop.calls.windows.at(-1)
  assert.equal(window.farm.unlocked, 5)
  assert.equal(window.farm.plots.length, 5)
  assert.equal(window.farm.nextCost, 65)
  assert.equal(window.farm.log[0].kind, 'unlock')

  // 连点：第二次带旧的 expectedUnlocked 来，宿主回 stale，不重复扣钱。
  const stale = await callAction(service, { action: 'farm-unlock', expectedUnlocked: 4 })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.error, 'stale')
  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.farm.unlocked, 5)
  assert.equal(state.body.farm.coins, 440)
})

test('一键播种/一键收割：第一个空地 + 第一份有库存的种子；成熟地块按序入队', () => {
  const farm = {
    plots: [
      { id: 'p1', stage: 'mature' },
      { id: 'p2', stage: 'growing' },
      { id: 'p3', stage: 'empty' },
      { id: 'p5', stage: 'mature' },
      { id: 'p6', stage: 'empty' }
    ],
    seeds: { tomato: 0, carrot: 2, pumpkin: 1 }
  }
  assert.deepEqual(farmView.batchPlantTargets(farm), [
    { plotId: 'p3', cropId: 'carrot' },
    { plotId: 'p6', cropId: 'carrot' }
  ])
  assert.deepEqual(farmView.batchHarvestTargets(farm), ['p1', 'p5'])
  assert.deepEqual(
    farmView.batchPlantTargets({ plots: [{ id: 'p1', stage: 'empty' }], seeds: {} }),
    []
  )
  assert.deepEqual(
    farmView.batchPlantTargets({ plots: [{ id: 'p1', stage: 'mature' }], seeds: { tomato: 1 } }),
    []
  )
  assert.deepEqual(farmView.batchHarvestTargets({ plots: [{ id: 'p1', stage: 'growing' }] }), [])

  // 进度条：生长中按 remainingMs 推，成熟恒为 100%，空地 0。
  assert.equal(farmView.progressOf({ stage: 'growing', crop: 'tomato', remainingMs: 15 * MINUTE_MS }), 0.5)
  assert.equal(farmView.progressOf({ stage: 'mature', crop: 'tomato', remainingMs: 0 }), 1)
  assert.equal(farmView.progressOf({ stage: 'empty', crop: null, remainingMs: 0 }), 0)
})

test('播种弹窗与批量条：三份种子库存/生长/产量、0 禁用、去交易所；没有随机买种', async () => {
  const html = await readFile(new URL('../desktop/farm.html', import.meta.url), 'utf8')
  assert.match(html, /id="plant-modal"/)
  assert.match(html, /id="seed-list"/)
  assert.match(html, /id="plant-modal-close"/)
  assert.match(html, /id="plant-go-market"/)
  assert.match(html, /id="batch-plant"/)
  assert.match(html, /id="batch-harvest"/)
  assert.match(html, /一键种满/)
  assert.match(html, /一键收割/)
  assert.match(html, /id="seed-bag"/)
  assert.match(html, /id="crop-warehouse"/)
  assert.match(html, /id="toasts"/)
  assert.match(html, /我的农场/)

  const renderer = await readFile(new URL('../desktop/farm.js', import.meta.url), 'utf8')
  // 三份种子逐个建行；0 库存禁用；显示生长时长与产量；「去交易所」只是切页签。
  assert.match(renderer, /for \(const cropId of CROP_IDS\)/)
  assert.match(renderer, /row\.disabled = busy \|\| count <= 0/)
  assert.match(renderer, /view\.formatGrowTime\(meta\.growMs\)/)
  assert.match(renderer, /meta\.yield/)
  assert.match(renderer, /selectTab\('market'\)/)
  assert.equal(renderer.includes('Math.random'), false, '不做随机买种')
  assert.equal(renderer.includes('buyRandomSeed'), false)
  // 动作名与窄口不变：种/收是字面量，浇/施肥走同一条 `farm-` 前缀。
  for (const action of ['farm-plant', 'farm-harvest']) {
    assert.match(renderer, new RegExp(action))
  }
  assert.match(renderer, /action === 'harvest' \|\| action === 'water' \|\| action === 'fertilize'/)
  assert.match(renderer, /action: 'farm-' \+ action/)
  // 批量 guard：busy / batch / 顺序等回执。
  assert.match(renderer, /batch !== null/)
  assert.match(renderer, /sendNextBatch/)
  assert.match(renderer, /batch\.queue\.shift\(\)/)
})

test('新外壳与配色：header/tabs/可滚动页/footer/toast/系统字体，没有远程资源', async () => {
  const html = await readFile(new URL('../desktop/farm.html', import.meta.url), 'utf8')
  for (const token of ['id="farm-title"', 'id="planted-count"', 'id="coin-value"', 'id="dew-value"', 'id="close"']) {
    assert.ok(html.includes(token), '新外壳应该有 ' + token)
  }
  assert.equal((html.match(/data-tab="/g) ?? []).length, 4)
  assert.match(html, /data-tab="farm"/)
  assert.match(html, /data-tab="market"/)
  assert.match(html, /data-tab="hire"/)
  assert.match(html, /data-tab="log"/)
  assert.match(html, /#faf8f5/i)
  assert.match(html, /--emerald:/)
  assert.match(html, /--amber:/)
  assert.match(html, /--sky:/)
  assert.match(html, /border-radius: 22px/)
  assert.match(html, /@keyframes mature-bounce/)
  assert.match(html, /::-webkit-scrollbar-thumb/)
  assert.equal(html.includes('https://'), false, '不加载远程资源')
  assert.equal(html.includes('fonts.googleapis'), false)
  assert.equal(html.includes('cdn.tailwindcss'), false)
  assert.equal(html.includes('lucide'), false)
  // 窗宽仍是 420×560，外壳靠 flex + 滚动适配，不改窗口尺寸。
  const main = await readFile(new URL('../desktop/main.js', import.meta.url), 'utf8')
  assert.match(main, /const FARM_WIDTH = 420/)
  assert.match(main, /const FARM_HEIGHT = 560/)
})

test('farm-open：两个地块时倒计时从当前时刻算，不用上一次 tick 的旧快照', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory,
    farmNow: () => clock.value,
    farmTickMs: 60 * 60 * 1000
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  const planted = await callAction(service, { action: 'plant', plotId: 'p1', cropId: 'tomato' })
  assert.equal(planted.body.ok, true)
  const planted2 = await callAction(service, { action: 'plant', plotId: 'p2', cropId: 'tomato' })
  assert.equal(planted2.body.ok, true)

  // 5 分钟没有 farm tick：窗口打开时必须从「现在」算，不是上一次 tick 的 30:00/2h。
  clock.value += 5 * 60 * 1000
  const opened = await callAction(service, { action: 'farm-open' })
  assert.equal(opened.body.ok, true)
  const window = desktop.calls.windows.at(-1)
  const p1 = window.farm.plots.find((plot) => plot.id === 'p1')
  const p2 = window.farm.plots.find((plot) => plot.id === 'p2')
  assert.equal(p1.remainingMs, 25 * 60 * 1000)
  assert.equal(p2.remainingMs, 25 * 60 * 1000)
})

test('farm-refresh：到点确认只重推当前窗口，不关窗', async (t) => {
  const dir = await tempDir(t)
  const clock = { value: NOON }
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory,
    farmNow: () => clock.value
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  const opened = await callAction(service, { action: 'farm-open' })
  assert.equal(opened.body.ok, true)
  const before = desktop.calls.windows.length
  const refreshed = await callAction(service, { action: 'farm-refresh' })
  assert.equal(refreshed.status, 200)
  assert.equal(refreshed.body.ok, true)
  assert.equal(refreshed.body.action, 'farm-refresh')
  assert.equal(desktop.calls.windows.length, before + 1)
  const payload = desktop.calls.windows.at(-1)
  assert.equal(payload.open, false)
  assert.equal(payload.close, undefined)
  assert.equal(payload.farm.plots.length, 4)
  assert.equal(desktop.isFarmOpen(), true)
})

test('窗口载荷永远带一份邻居切换器（没有邻居时是空数组）', async (t) => {
  const dir = await tempDir(t)
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  const opened = await callAction(service, { action: 'farm-open' })
  assert.equal(opened.body.ok, true)
  const payload = desktop.calls.windows.at(-1)
  assert.ok(Array.isArray(payload.neighbors), 'neighbors 必须是数组')
  assert.deepEqual(payload.neighbors, [], '没有邻居时是空的，不是 undefined')
})

test('从"看田"切回「我的农场」：farm-refresh 推回 owner 模式，不带 look', async (t) => {
  const dir = await tempDir(t)
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  await callAction(service, { action: 'farm-open' })
  assert.equal(desktop.isFarmOpen(), true)

  // 窗口里点「我的农场」→ 只发一次 farm-refresh；宿主按 self.out 重算，没出门就是 owner。
  const refreshed = await callAction(service, { action: 'farm-refresh' })
  assert.equal(refreshed.body.ok, true)

  const payload = desktop.calls.windows.at(-1)
  assert.equal(payload.mode, 'owner')
  assert.equal(payload.look, undefined, '不能把上一次的邻居视图带回来')
  assert.ok(Array.isArray(payload.neighbors), '切回来之后切换器还在')
})

test('邻居切换器的形状：少就圆片，多就胶囊，排序看熟地', () => {
  const three = farmView.neighborSwitch([
    { deviceId: 'a', nickname: '一飞', ripePlots: 0, guard: 0.3 },
    { deviceId: 'b', nickname: '鱼姐', ripePlots: 2, guard: 0.8 },
    { deviceId: 'c', nickname: '吾鲸', old: true }
  ], null)
  assert.equal(three.mode, 'chips')
  assert.deepEqual(three.items.map((item) => item.label), ['鱼姐', '吾鲸', '一飞'])
  assert.equal(three.stealable, 1)
  assert.equal(three.items[1].old, true)

  const many = farmView.neighborSwitch(Array.from({ length: 6 }, (_, index) => ({
    deviceId: 'd' + index,
    nickname: '邻居' + index,
    ripePlots: index % 3,
    guard: 0.3
  })), 'd4')
  assert.equal(many.mode, 'menu')
  assert.equal(many.currentLabel, '邻居4')
  assert.equal(many.items.find((item) => item.active)?.label, '邻居4')
  // 能偷的排最前
  assert.ok(many.items.slice(0, 2).every((item) => item.ripePlots === 2))
})

// ---------------------------------------------------------------------------
// 票 58：作物外观是包内 SVG，emoji 只做兜底
// ---------------------------------------------------------------------------

test('作物图：有 art 就给 <img>，没 art 才退回 emoji', () => {
  const documentDouble = { createElement: (tag) => fakeElement(tag) }

  const withArt = farmView.cropEmblem(documentDouble, { art: 'crops/corn.svg', emoji: '🌽' }, 'seed-emoji')
  assert.equal(withArt.className, 'seed-emoji')
  assert.equal(withArt.textContent, '')
  assert.equal(withArt.children.length, 1)
  const img = withArt.children[0]
  assert.equal(img.tagName, 'IMG')
  assert.equal(img.getAttribute('src'), 'crops/corn.svg')
  // 装饰图：名字在旁边的文字里，读屏只念一次。
  assert.equal(img.getAttribute('alt'), '')

  // 空地（art 为空）和未知作物（null）都走 emoji/文本这一支，格子不会空着。
  const noArt = farmView.cropEmblem(documentDouble, { art: '', emoji: '＋' }, 'crop-emoji')
  assert.equal(noArt.children.length, 0)
  assert.equal(noArt.textContent, '＋')
  const unknown = farmView.cropEmblem(documentDouble, null, 'crop-emoji')
  assert.equal(unknown.children.length, 0)
  assert.equal(unknown.textContent, '')
})

test('地块卡模型：认识六种作物，每种都带图路径', () => {
  const plots = Object.keys(farmView.CROP_META).map((cropId, index) => ({
    id: 'p' + (index + 1),
    crop: cropId,
    stage: 'growing',
    remainingMs: 60 * 1000,
    waterings: 0,
    fertilized: false
  }))
  const cards = farmView.plotCards({ plots, dew: 0 }, {})
  assert.deepEqual(cards.map((card) => card.crop), Object.keys(farmView.CROP_META))
  for (const card of cards) {
    assert.equal(card.art, 'crops/' + card.crop + '.svg')
    assert.equal(JSON.stringify(card.emoji).length > 2, true)
  }
})

// ---------------------------------------------------------------------------
// 票 59：作物目录随每一包下发，窗口按目录画
// ---------------------------------------------------------------------------

test('crops.json 里的作物：窗口拿到目录，地块卡画名字而不是空地', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'crops.json'), JSON.stringify({
    version: 1,
    crops: [{ id: 'blueberry', name: '蓝莓', growMs: 90 * MINUTE_MS, seedPrice: 30, yield: 4, base: 18 }]
  }))
  const clock = { value: NOON }
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

  // 种一种新作物：宿主要真的认它。
  const bought = await callAction(service, { action: 'farm-buy-seed', cropId: 'blueberry', qty: 1 })
  assert.equal(bought.body.ok, true, JSON.stringify(bought.body))
  const planted = await callAction(service, { action: 'farm-plant', plotId: 'p1', cropId: 'blueberry' })
  assert.equal(planted.body.ok, true, JSON.stringify(planted.body))

  await callAction(service, { action: 'farm-open' })
  const window = desktop.calls.windows.at(-1)
  const catalog = window.crops
  assert.ok(Array.isArray(catalog), '窗口必须收到作物目录')
  assert.deepEqual(catalog.map((entry) => entry.id).sort(),
    ['blueberry', 'carrot', 'corn', 'grape', 'pumpkin', 'strawberry', 'tomato'])
  assert.deepEqual(catalog.find((entry) => entry.id === 'blueberry'),
    { id: 'blueberry', name: '蓝莓', growMs: 90 * MINUTE_MS, yield: 4, seedPrice: 30, base: 18 })
  // 仓库里也有这个键（不然窗口会把它当成未知作物）。
  assert.equal(window.farm.seeds.blueberry, 0)
  assert.equal(window.farm.plots[0].crop, 'blueberry')

  // 视图层照目录画：名字是「蓝莓」，不是「空地」。窗口里是 farm.js 在每一包开头调
  // `view.setCrops(payload.crops)`；这里照同一条路径走，用完复位（模块级状态）。
  farmView.setCrops(window.crops)
  t.after(() => farmView.setCrops(null))
  const card = farmView.plotCards(window.farm, { dew: 0 })[0]
  assert.equal(card.cropName, '蓝莓')
  assert.equal(card.art, '', '还没画图：走 emoji 兜底')
  assert.equal(card.emoji, '🌱')
})

test('自定义作物带图（票 59）：宿主落 <hash>.<ext>，窗口拿到 dshzoo://crops/...', async (t) => {
  const dir = await tempDir(t)
  await mkdir(join(dir, 'crops'), { recursive: true })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>'
  await writeFile(join(dir, 'crops', 'kiwi.svg'), svg)
  await writeFile(join(dir, 'crops.json'), JSON.stringify({
    version: 1,
    crops: [{ id: 'kiwi', name: '猕猴桃', growMs: 2 * 60 * MINUTE_MS, seedPrice: 20, yield: 5, base: 12 }]
  }))
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory
  })
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  await callAction(service, { action: 'farm-open' })
  const catalog = desktop.calls.windows.at(-1).crops
  const kiwi = catalog.find((entry) => entry.id === 'kiwi')
  assert.match(kiwi.art, /^dshzoo:\/\/crops\/[0-9a-f]{16}\.svg$/)
  // 内置六种没有 art 字段：窗口按 id 回落到包里的 SVG。
  assert.equal('art' in catalog.find((entry) => entry.id === 'tomato'), false)

  // 图真落盘了，而且名字就是 URL 里那个哈希。
  const name = kiwi.art.replace('dshzoo://crops/', '')
  const bytes = await readFile(join(dir, 'crop-art', name), 'utf8')
  assert.equal(bytes, svg)

  // 视图层认这个 URL：整份目录换进去以后，猕猴桃有图、不是 🌱。
  farmView.setCrops(catalog)
  t.after(() => farmView.setCrops(null))
  assert.equal(farmView.CROP_META.kiwi.art, kiwi.art)
  assert.equal(farmView.CROP_META.tomato.art, 'crops/tomato.svg')
})

test('热加载（票 59）：改 crops.json 不重启，窗口自己多出一种作物', async (t) => {
  const dir = await tempDir(t)
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory,
    cropPollMs: 20
  })
  t.after(() => resetCropCatalog())
  await service.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  await callAction(service, { action: 'farm-open' })
  assert.equal((desktop.calls.windows.at(-1).crops ?? []).some((entry) => entry.id === 'kiwi'), false)

  // 用户把文件写进去，不重启、不点任何东西。
  await writeFile(join(dir, 'crops.json'), JSON.stringify({
    version: 1,
    crops: [{ id: 'kiwi', name: '猕猴桃', growMs: 2 * 60 * MINUTE_MS, seedPrice: 20, yield: 5, base: 12 }]
  }))

  await waitFor(() => (desktop.calls.windows.at(-1).crops ?? []).some((entry) => entry.id === 'kiwi'))
  const entry = desktop.calls.windows.at(-1).crops.find((candidate) => candidate.id === 'kiwi')
  assert.equal(entry.base, 12)
  assert.equal(entry.growMs, 2 * 60 * MINUTE_MS)
  // 宿主认了，地块卡才能画名字；这条顺手确认运行时表也更新了。
  assert.equal(desktop.calls.windows.at(-1).farm.seeds.kiwi, 0)
})
