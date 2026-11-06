/**
 * 票 40：农场小窗 + 桌面地块的宿主侧集成。
 *
 * 覆盖三件事，全部走真实的 service / 磁盘（桌面层用只记录命令的替身）：
 *   1. `farm-open` → `desktop.farmWindow({open:true, farm, plotId})`，窗口拿到完整视图
 *      （阶段/remainingMs/种子/作物/日志），而场景里的 `controls.farm` 只有摘要；
 *   2. 窗口提交（helper 事件）`farm-plant` → 39 的 store → action-result；日志/地块/仓库跟着变；
 *   3. 失败码（bad-plot）回一句人话；没有桌面层时 `farm-open` 是 `desktop-off`。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { PLOT_IDS } from '../src/farm.js'
import { MINUTE_MS } from '../src/farm-rules.js'
import { MARKET_FILE, MARKET_VERSION } from '../src/market.js'
import { createService } from '../src/service.js'

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
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function makeService (t, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    petBridge: false,
    skinServer: false,
    ...options
  })
  service.routes = routes
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

/** 只记录场景/窗口命令/action-result 的桌面替身；不 spawn Electron。 */
function desktopDouble () {
  const calls = { scenes: [], windows: [], results: [] }
  let onEvent = null
  return {
    calls,
    factory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update (scene) { calls.scenes.push(scene); return true },
        resync (scene) { calls.scenes.push(scene); return true },
        farmWindow (payload) {
          calls.windows.push(payload)
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
    }
  }
}

test('farm-open：窗口拿完整农场（含 remainingMs/种子/日志），场景只拿摘要', async (t) => {
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

  // 场景里的摘要：4 块空地 + 30 硬币；没有 seeds/crops/log（完整视图不进场景）。
  const scene = desktop.calls.scenes.at(-1)
  assert.equal(scene.controls.farm.plots.length, PLOT_IDS.length)
  assert.deepEqual(scene.controls.farm.plots[0], { id: 'p1', crop: null, stage: 'empty', mature: false })
  assert.equal(scene.controls.farm.coins, 30)
  assert.equal('seeds' in scene.controls.farm, false)
  assert.equal('log' in scene.controls.farm, false)

  // `/state.farm` 仍是 39 的全量形状（原始地块 + guard/hire/log），不是窗口形状。
  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.farm.plots.length, 4)
  assert.equal(state.body.farm.plots[0].id, 'p1')
  assert.equal('remainingMs' in state.body.farm.plots[0], false)
  assert.equal('stage' in state.body.farm.plots[0], false)
  assert.equal(state.body.farm.guard, 0)

  // 菜单/地块点击 → 宿主发 farm-window，窗口拿到完整视图 + 预选地块。
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
  assert.deepEqual(window.farm.seeds, { tomato: 2, carrot: 0, pumpkin: 0 })
  assert.deepEqual(window.farm.crops, { tomato: 0, carrot: 0, pumpkin: 0 })
  assert.equal(window.farm.coins, 30)
  assert.equal(window.farm.dew, 0)
  assert.deepEqual(window.farm.log, [])

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
})

test('窗口动作：farm-plant → 39 的 store → action-result；下一帧 controls.farm 跟着变', async (t) => {
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
  await waitFor(() => {
    const farm = desktop.calls.scenes.at(-1).controls.farm
    return farm.plots[0].crop === 'tomato' && farm.plots[0].stage === 'growing'
  })
  const planted = desktop.calls.scenes.at(-1).controls.farm
  assert.equal(planted.plots[0].mature, false)
  // 种子扣了 1，作物还没收。
  const state = await call(service, '/dsh-zoo/state')
  assert.equal(state.body.farm.seeds.tomato, 1)

  // 农场窗口的完整视图也应该是新的一份（重新打开时宿主现算）。
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

  // 开窗：完整视图里带交易所，且交易所不混进场景的 controls.farm。
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
  assert.deepEqual(window.market.index, {})
  assert.equal('market' in desktop.calls.scenes.at(-1).controls.farm, false)

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
  assert.deepEqual(refreshed.farm.seeds, { tomato: 4, carrot: 0, pumpkin: 0 })
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
  assert.deepEqual(soldWindow.farm.crops, { tomato: 0, carrot: 0, pumpkin: 0 })
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
  clock.value += 2 * MINUTE_MS + 1
  assert.equal((await callAction(service, { action: 'farm-open' })).body.ok, true)
  const stale = desktop.calls.windows.at(-1).market
  assert.equal(stale.index.tomato.stale, true)
  assert.equal(stale.prices.tomato.bid, 9, '本机 10 → bid 9')
})
