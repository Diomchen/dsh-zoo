/**
 * 票 120：出远门的公开视图与串门视图（不开 Electron、不开端口）。
 *
 * 覆盖：
 *   1. 公开视图里远征块的口径（图鉴件数 / 前 8 格 / 最近三篇标题），且**一个字正文都没有**；
 *   2. 没玩过的邻居拿到的零值形状；
 *   3. 串门视图（`/dsh-zoo-farm/<visitId>`）在公开内容之外多给日志正文；
 *   4. 两条只读路由都拒绝写动作（405），公开视图不因为写请求而改变。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { publicExpeditionBlock } from '../src/farm-open.js'
import { startLanServer } from '../src/lan-server.js'
import { EXPEDITION_FILE } from '../src/expedition-store.js'
import { TRIP_LOG_TITLE_MAX } from '../src/expedition.js'
import { FARM_FILE } from '../src/farm.js'
import { createService } from '../src/service.js'

const T0 = 1_700_000_000_000
const VIEWER = '22222222-2222-4222-8222-222222222222'
const PEER = '33333333-3333-4333-8333-333333333333'
const VISIT_ID = '44444444-4444-4444-8444-444444444444'

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-expedition-open-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

async function makeService (t, dir, seedExpedition = true) {
  const { ctx } = fakeCtx()
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins: 620 }), 'utf8')
  if (seedExpedition) {
    await writeFile(join(dir, EXPEDITION_FILE), JSON.stringify({
      version: 1,
      run: null,
      shelf: { slots: 8, items: ['herb', null, 'oddstone'] },
      codex: { herb: T0, oddstone: T0 + 1 },
      upgrades: { lantern: false },
      trips: { backhill: 2 },
      logs: [
        { at: T0 - 1000, routeId: 'backhill', legs: 6, ended: 'back', title: '第一趟', body: '正文秘密甲' },
        { at: T0 - 2000, routeId: 'backhill', legs: 8, ended: 'complete', title: '第二趟', body: '正文秘密乙' },
        { at: T0 - 3000, routeId: 'backhill', legs: 4, ended: 'back', title: '第三趟', body: '正文秘密丙' },
        { at: T0 - 4000, routeId: 'backhill', legs: 3, ended: 'back', title: '第四趟', body: '正文秘密丁' }
      ]
    }), 'utf8')
  }
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    petBridge: false,
    skinServer: false,
    farmNow: () => T0,
    expeditionNow: () => T0
  })
  t.after(() => service.dispose())
  await service.ready
  return service
}

test('公开视图：没玩过出远门的邻居拿到零值远征块，不报错', async (t) => {
  const dir = await tempDir(t)
  const service = await makeService(t, dir, false)
  const view = service.openFarm(VIEWER)
  assert.ok(view !== null, '公开视图本身照常给')
  assert.deepEqual(view.expedition, {
    codex: { owned: 0, total: 32 },
    shelf: Array.from({ length: 8 }, () => null),
    logs: []
  })
  assert.equal(JSON.stringify(view).includes('正文'), false)
})

test('公开视图：图鉴件数、前 8 格与最近三篇标题；正文一个字都不出现', async (t) => {
  const dir = await tempDir(t)
  const service = await makeService(t, dir)
  const view = service.openFarm(VIEWER)
  assert.deepEqual(view.expedition.codex, { owned: 2, total: 32 })
  assert.equal(view.expedition.shelf.length, 8)
  assert.deepEqual(view.expedition.shelf[0], { id: 'herb', name: '草药', emoji: '🌿' })
  assert.equal(view.expedition.shelf[1], null)
  assert.deepEqual(view.expedition.shelf[2], { id: 'oddstone', name: '怪石', emoji: '🪨' })
  assert.deepEqual(view.expedition.logs, [
    { title: '第一趟', at: T0 - 1000 },
    { title: '第二趟', at: T0 - 2000 },
    { title: '第三趟', at: T0 - 3000 }
  ])
  const json = JSON.stringify(view)
  assert.equal(json.includes('正文秘密'), false, '公开视图不能带日志正文')
  assert.equal(json.includes('backhill'), false, '公开视图不能带路线 id')
  assert.equal(json.includes('第四趟'), false, '只给最近三篇')
})

test('串门视图：公开块之外还能拿到日志正文', async (t) => {
  const dir = await tempDir(t)
  const service = await makeService(t, dir)
  service.room.observeBeacon({ deviceId: PEER, nickname: '甲', port: 40001 }, T0)
  service.room.admit(PEER)
  const admission = service.room.observeVisitRequest({
    deviceId: PEER,
    visitId: VISIT_ID,
    purpose: 'steal'
  }, T0 + 10)
  assert.equal(admission.reply, 'ack')

  const visit = service.visitFarm(VISIT_ID)
  assert.ok(visit !== null, '串门视图应该给')
  assert.equal(visit.expedition.logs.length, 3)
  assert.equal(visit.expedition.logs[0].body, '正文秘密甲')
  assert.deepEqual(visit.expedition.logs[0], { title: '第一趟', at: T0 - 1000, body: '正文秘密甲' })
  assert.deepEqual(visit.expedition.codex, { owned: 2, total: 32 })
  assert.deepEqual(visit.expedition.shelf[0], { id: 'herb', name: '草药', emoji: '🌿' })

  // 公开视图仍然是干净的那一份：串门不会把正文漏过去。
  assert.equal(JSON.stringify(service.openFarm(VIEWER)).includes('正文秘密'), false)
})

/** 假 server：不 listen，只把 handler 抠出来直接调（票 62 之后不开端口）。 */
function fakeServerFactory (captured) {
  return (handler) => {
    captured.handler = handler
    return {
      once () { return this },
      listen (_port, _host, callback) {
        if (typeof callback === 'function') callback()
        return this
      },
      address () { return { port: 45899 } },
      close () {}
    }
  }
}

function fakeResponse () {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead (status, headers) {
      this.statusCode = status
      for (const [key, value] of Object.entries(headers ?? {})) this.headers[String(key).toLowerCase()] = value
      return this
    },
    setHeader (key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    end (chunk) {
      if (chunk !== undefined && chunk !== null) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      return this
    }
  }
}

async function startFake (readonly) {
  const captured = {}
  const server = await startLanServer({
    port: 0,
    host: '127.0.0.1',
    createServer: fakeServerFactory(captured),
    lookupOpenFarm: () => readonly.open,
    lookupFarm: () => readonly.visit,
    log: { warn () {} }
  })
  assert.ok(server !== null && server !== undefined)
  const call = async (url, { method = 'GET' } = {}) => {
    const response = fakeResponse()
    await captured.handler({ method, url }, response)
    return response
  }
  return { call }
}

test('路由：公开视图是只读的，任何写动作都拒（405），内容不变', async () => {
  const readonly = {
    open: { v: 1, deviceId: 'host', expedition: { codex: { owned: 1, total: 32 }, shelf: [], logs: [] } },
    visit: { v: 1, visitId: VISIT_ID, expedition: { codex: { owned: 1, total: 32 }, shelf: [], logs: [] } }
  }
  const { call } = await startFake(readonly)
  const before = JSON.stringify(readonly)

  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const open = await call('/dsh-zoo-farm/open/' + VIEWER, { method })
    assert.equal(open.statusCode, 405, method + ' 对公开视图必须是 405')
    const visit = await call('/dsh-zoo-farm/' + VISIT_ID, { method })
    assert.equal(visit.statusCode, 405, method + ' 对串门视图必须是 405')
  }

  const read = await call('/dsh-zoo-farm/open/' + VIEWER)
  assert.equal(read.statusCode, 200)
  assert.deepEqual(JSON.parse(read.body.toString('utf8')), readonly.open)
  assert.equal(read.headers['cache-control'], 'no-store')
  assert.equal(JSON.stringify(readonly), before, '写请求不能改动任何视图')
})

/** 记农场窗下发的桌面替身（只用到 farmWindow 与 ready）。 */
function desktopDouble () {
  const calls = { farm: [], expedition: [] }
  let onEvent = null
  return {
    calls,
    factory (factoryOptions) {
      onEvent = factoryOptions.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update () { return true },
        resync () { return true },
        status () { return { ready: true, farmOpen: false, expeditionOpen: false } },
        farmWindow (payload) { calls.farm.push(payload); return true },
        expeditionWindow (payload) { calls.expedition.push(payload); return true },
        bringWindow () { return true },
        lastCommandFailure () { return null },
        actionResult () {},
        dispose () {}
      }
    },
    ready (workArea = { x: 0, y: 30, width: 1000, height: 700 }) {
      onEvent?.({ type: 'ready', pid: 4242, workArea, displays: [{ id: 1, bounds: workArea, workArea, scaleFactor: 1, primary: true }] })
    }
  }
}

async function makeDesktopService (t, dir, seedExpedition) {
  const { ctx, routes } = fakeCtx()
  await writeFile(join(dir, FARM_FILE), JSON.stringify({ version: 1, coins: 620 }), 'utf8')
  if (seedExpedition) {
    await writeFile(join(dir, EXPEDITION_FILE), JSON.stringify({
      version: 1,
      run: null,
      shelf: { slots: 8, items: ['herb', null, 'oddstone'] },
      codex: { herb: T0, oddstone: T0 + 1 },
      upgrades: { lantern: false },
      logs: [
        { at: T0 - 1000, routeId: 'backhill', legs: 6, ended: 'back', title: '第一趟', body: '正文秘密甲' }
      ]
    }), 'utf8')
  }
  const desktop = desktopDouble()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    petBridge: false,
    skinServer: false,
    desktopFactory: desktop.factory,
    farmNow: () => T0,
    expeditionNow: () => T0
  })
  t.after(() => service.dispose())
  await service.ready
  desktop.ready()
  return { service, desktop, routes }
}

/** 存进 routes 里的 POST /dsh-zoo/action。 */
async function callAction (service, body, routes) {
  const route = routes.find((candidate) => candidate.path === '/dsh-zoo/action')
  assert.ok(route, '应该注册 /dsh-zoo/action')
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (payload) { this.payload = payload }
  }
  const req = {
    method: 'POST',
    _listeners: {},
    on (event, fn) { this._listeners[event] = fn; return this },
    destroy () {}
  }
  const pending = route.handler(req, res)
  queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body))))
  queueMicrotask(() => req._listeners.end?.())
  await pending
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}

test('农场页宿主数据：自己看自己，陈列架 N 与公开视图同一口径', async (t) => {
  const dir = await tempDir(t)
  const { service, desktop, routes } = await makeDesktopService(t, dir, true)
  const opened = await callAction(service, { action: 'farm-open' }, routes)
  assert.equal(opened.status, 200)
  const farm = desktop.calls.farm.at(-1).farm
  // 评审 B4：字段叫 `expeditionCodexOwned`——它给的是**图鉴已集齐件数**，不是已开格数。
  assert.deepEqual(farm.expeditionCodexOwned, { owned: 2, total: 32 })
  assert.equal(JSON.stringify(farm).includes('正文秘密'), false, '农场页拿不到日志正文')
})

test('农场页宿主数据：没玩过也是一行零值，不报错', async (t) => {
  const dir = await tempDir(t)
  const { service, desktop, routes } = await makeDesktopService(t, dir, false)
  const opened = await callAction(service, { action: 'farm-open' }, routes)
  assert.equal(opened.status, 200)
  assert.deepEqual(desktop.calls.farm.at(-1).farm.expeditionCodexOwned, { owned: 0, total: 32 })
})

test('白名单：农场窗与邻居视图都只留陈列架计数，缺省零值', () => {
  const farm = shared.normalizeFarm({
    expeditionCodexOwned: { owned: 5, total: 99, extra: '丢掉' }
  })
  assert.deepEqual(farm.expeditionCodexOwned, { owned: 5, total: 32 })
  assert.deepEqual(shared.normalizeFarm({}).expeditionCodexOwned, { owned: 0, total: 32 })

  const look = shared.normalizeFarmLook({
    deviceId: '11111111-1111-4111-8111-111111111111',
    expedition: {
      codex: { owned: 7, total: 32 },
      shelf: [{ id: 'herb', name: '草药', emoji: '🌿' }],
      logs: [{ title: '第一趟', at: T0, body: '公开视图不该有正文' }]
    }
  })
  assert.equal(look.expedition.codex.owned, 7)
  assert.equal(JSON.stringify(look).includes('正文'), false)
  const empty = shared.normalizeFarmLook({ deviceId: '11111111-1111-4111-8111-111111111111' })
  assert.deepEqual(empty.expedition.codex, { owned: 0, total: 32 })
  assert.equal(empty.expedition.shelf.length, 8)
  assert.deepEqual(empty.expedition.logs, [])
})

async function readDesktop (name) {
  return readFile(new URL('../desktop/' + name, import.meta.url), 'utf8')
}

test('农场页入口行：顶栏「陈列架 N/32 · 点开看」，点开落陈列架页', async () => {
  const html = await readDesktop('farm.html')
  const entry = html.indexOf('id="expedition-entry"')
  const board = html.indexOf('id="board"')
  assert.ok(entry > 0, '农场页要有陈列架入口')
  assert.ok(board > 0 && entry > board, '入口紧挨「盘口」，排在它后面')
  assert.match(html.slice(entry - 300, entry + 600), /点开看/)
  assert.match(html.slice(entry - 300, entry + 600), /32/)

  const farmJs = await readDesktop('farm.js')
  assert.match(farmJs, /function renderExpeditionEntry \(/)
  assert.match(farmJs, /expeditionCodexOwned/)
  assert.match(farmJs, /submit\(\{ action: 'expedition-open', tab: 'shelf' \}\)/)
})

test('开窗落点：tab 从农场窗一路带到出远门窗口，只认已知页签', async (t) => {
  // 农场动作白名单：只放行 shelf/log/codex，夹带别的值就当普通开窗。
  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'expedition-open', tab: 'shelf' }),
    { action: 'expedition-open', tab: 'shelf' }
  )
  assert.deepEqual(
    shared.normalizeFarmAction({ action: 'expedition-open', tab: 'log' }),
    { action: 'expedition-open', tab: 'log' }
  )
  assert.deepEqual(shared.normalizeFarmAction({ action: 'expedition-open', tab: 'travel' }), { action: 'expedition-open' })
  assert.deepEqual(shared.normalizeFarmAction({ action: 'expedition-open', tab: 'shelf', title: '夹带' }),
    { action: 'expedition-open', tab: 'shelf' })

  // 宿主命令白名单：tab 跟着 state 一起到 helper。
  assert.equal(shared.normalizeExpeditionWindow({ open: true, tab: 'shelf', state: {} }).tab, 'shelf')
  assert.equal(shared.normalizeExpeditionWindow({ open: true, tab: 'log', state: {} }).tab, 'log')
  assert.equal('tab' in shared.normalizeExpeditionWindow({ open: true, tab: 'nope', state: {} }), false)

  // 宿主：把 tab 原样交给 desktop.expeditionWindow。
  const dir = await tempDir(t)
  const { service, desktop, routes } = await makeDesktopService(t, dir, true)
  const opened = await callAction(service, { action: 'expedition-open', tab: 'shelf' }, routes)
  assert.equal(opened.status, 200)
  assert.equal(desktop.calls.expedition.at(-1).tab, 'shelf')
  assert.equal(desktop.calls.expedition.at(-1).open, true)

  const plain = await tempDir(t)
  const second = await makeDesktopService(t, plain, true)
  await callAction(second.service, { action: 'expedition-open' }, second.routes)
  assert.equal('tab' in second.desktop.calls.expedition.at(-1), false)
})

test('开窗落点的接线：命令、helper、窗口三处都认 tab', async () => {
  const desktopSrc = await readFile(new URL('../src/desktop.js', import.meta.url), 'utf8')
  assert.match(desktopSrc, /payload\?\.tab === 'shelf'/)
  assert.match(desktopSrc, /payload\?\.tab === 'log'/)

  const mainSrc = await readDesktop('main.js')
  assert.match(mainSrc, /command\.tab === 'shelf'/)
  assert.match(mainSrc, /command\.tab === 'log'/)
  assert.match(mainSrc, /expeditionTab/)

  const windowJs = await readDesktop('expedition.js')
  assert.match(windowJs, /next\.tab === 'shelf'/)
  assert.match(windowJs, /next\.tab === 'log'/)
  assert.match(windowJs, /setTab\(next\.tab\)/)

  const farmPreload = await readDesktop('farm-preload.js')
  assert.match(farmPreload, /tab: action\.tab/)
})

test('日志标题上限：公开视图与窗口都截到 80 码点（三处同一口径）', async (t) => {
  // 评审 B1：以前宿主写 80、公开视图（farm-open）与窗口（farm-fetch / shared）各截 120。
  // 现在三处都读同一个 `TRIP_LOG_TITLE_MAX`。
  assert.equal(TRIP_LOG_TITLE_MAX, 80)
  const long = '远'.repeat(200)
  const dir = await tempDir(t)
  await writeFile(join(dir, EXPEDITION_FILE), JSON.stringify({
    version: 1,
    run: null,
    shelf: { slots: 8, items: [] },
    codex: { herb: T0 },
    upgrades: { lantern: false },
    logs: [
      { at: T0 - 1000, routeId: 'backhill', legs: 6, ended: 'back', title: long, body: long }
    ]
  }), 'utf8')
  const service = await makeService(t, dir, false)
  const published = service.openFarm(VIEWER).expedition.logs[0]
  assert.equal(Array.from(published.title).length, TRIP_LOG_TITLE_MAX)

  // 桌面侧同一份上限：长标题到了窗口也不会画成两屏。
  const window = shared.normalizePublicExpedition({
    codex: { owned: 1, total: 32 },
    shelf: [],
    logs: [{ title: long, at: T0 }]
  })
  assert.equal(Array.from(window.logs[0].title).length, TRIP_LOG_TITLE_MAX)
})

test('公开远征块：宿主与桌面的白名单 key 集合逐字一致（评审 B3）', () => {
  // 白名单重建过三份（farm-open / farm-fetch / desktop shared）。src 侧已经并成
  // `publicExpeditionBlock` 一份，桌面侧留自己那份，字段必须逐字对齐——多一个少一个都是漂移。
  const raw = {
    codex: { owned: 1, herb: T0 },
    shelf: { slots: 8, items: ['herb', null] },
    logs: [{ at: T0, routeId: 'backhill', legs: 6, ended: 'back', title: '第一趟', body: '正文秘密甲' }]
  }
  const host = publicExpeditionBlock(raw)
  // 桌面侧吃的是**线上块**（shelf 已经是 8 个格子），不是快照。
  const window = shared.normalizePublicExpedition(host)
  assert.deepEqual(Object.keys(host).sort(), Object.keys(window).sort())
  assert.deepEqual(Object.keys(host.codex).sort(), Object.keys(window.codex).sort())
  assert.deepEqual(Object.keys(host.logs[0]).sort(), Object.keys(window.logs[0]).sort())
  assert.deepEqual(Object.keys(host.shelf[0]).sort(), Object.keys(window.shelf[0]).sort())
  assert.equal(host.shelf.length, window.shelf.length)
  assert.equal(host.shelf[1], window.shelf[1], '空格子两边都是 null')
})

test('公开视图不泄漏：没有正文、没有未开格内容、没有图鉴时间戳（评审 E2）', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, EXPEDITION_FILE), JSON.stringify({
    version: 1,
    run: null,
    // 明明只开了 8 格却塞了 12 件：第 9 件往后属于「未开格」，公开视图一件都不该带出去。
    shelf: {
      slots: 8,
      items: ['herb', null, 'oddstone', null, null, null, null, null, 'amber', 'feather', 'ore', 'reed']
    },
    codex: { herb: T0, oddstone: T0 + 1, amber: T0 + 2 },
    upgrades: { lantern: false },
    logs: [{ at: T0 - 1000, routeId: 'backhill', legs: 6, ended: 'back', title: '第一趟', body: '正文秘密甲' }]
  }), 'utf8')
  const service = await makeService(t, dir, false)
  const block = service.openFarm(VIEWER).expedition
  const wire = JSON.stringify(block)
  assert.equal('body' in block.logs[0], false, '公开日志没有正文')
  assert.equal(wire.includes('正文秘密甲'), false)
  assert.equal(block.shelf.length, 8, '公开视图只发前 8 格')
  assert.equal(wire.includes('amber'), false, '未开格的件不能出现在公开视图')
  assert.deepEqual(Object.keys(block.codex).sort(), ['owned', 'total'], '图鉴只发件数，不发时间戳')
  assert.equal(wire.includes(String(T0)), false, '图鉴时间戳不外泄')
})
