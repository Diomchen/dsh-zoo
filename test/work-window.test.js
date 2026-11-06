/**
 * 票 44：农场小窗的雇工页 + 桌面动作（不 spawn Electron）。
 *
 * 宿主 push：`farm-window` 带 contracts，完整 farm view 带 hire/guard/worker；
 * 动作 `hire-listing` / `hire` / `end-contract` / `recall-worker` 走和用户点击同一条
 * helper event → handleDesktopAction → handleActionInner 的窄口。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { createService } from '../src/service.js'

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor (predicate, timeoutMs = 6000) {
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-work-window-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

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
      onEvent?.({
        type: 'ready',
        pid: 4242,
        workArea,
        displays: [{ id: 1, bounds: workArea, workArea, scaleFactor: 1, primary: true }]
      })
    },
    emit (event) {
      onEvent?.(event)
    }
  }
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

async function callAction (service, body) {
  const route = service.routes.find((candidate) => candidate.path === '/dsh-zoo/action')
  const res = {
    statusCode: 0,
    setHeader () {},
    end (payload) { this.payload = payload }
  }
  const req = {
    method: 'POST',
    _listeners: {},
    on (event, fn) {
      this._listeners[event] = fn
      return this
    },
    destroy () {}
  }
  const pending = route.handler(req, res)
  queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body))))
  queueMicrotask(() => req._listeners.end?.())
  await pending
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}

test('farm-window 带 contracts/hire/guard；雇工页动作走桌面窄口', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const desktop = desktopDouble()
  const base = {
    network: true,
    petBridge: false,
    skinServer: false,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 5000,
    heartbeatIntervalMs: 5000,
    tickIntervalMs: 20,
    marketDigestMs: 1000,
    contractTickMs: 20,
    contractRetryMs: 1000,
    contractStartupGraceMs: 5,
    peerLostMs: 20000,
    workRetryMs: 50,
    workTimeoutMs: 1500
  }
  const b = makeService(t, { ...base, dataDir: dirB, port: 0, targetPort: 0, desktop: false })
  await b.ready
  const bPort = b.localPort()
  assert.ok(bPort > 0)
  const a = makeService(t, {
    ...base,
    dataDir: dirA,
    port: 0,
    targetPort: bPort,
    desktopFactory: desktop.factory
  })
  await a.ready
  desktop.ready()
  await waitFor(() => desktop.calls.scenes.length > 0)

  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)
  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  a.room.admit(bId)
  b.room.admit(aId)
  a.sendHeartbeats()
  b.sendHeartbeats()
  await waitFor(() => (a.snapshot().neighbors[0]?.heartbeatAt ?? 0) > 0)

  // 开窗：完整 farm view 带 hire/guard/worker，contracts 块始终存在。
  desktop.emit({ type: 'action', id: 'w1', action: 'farm-open', plotId: 'p1' })
  await waitFor(() => desktop.calls.windows.some((window) => window.open === true) &&
    desktop.calls.results.some((entry) => entry.id === 'w1'))
  const opened = desktop.calls.windows.find((window) => window.open === true)
  assert.equal(opened.open, true)
  assert.equal(opened.plotId, 'p1')
  assert.equal(opened.farm.guard, 0.3)
  assert.equal(opened.farm.worker, null)
  assert.deepEqual(opened.farm.hire, { enabled: false, wagePerHour: 10, minHours: 2, maxHours: 8 })
  assert.deepEqual(opened.contracts.outgoing, [])
  assert.deepEqual(opened.contracts.incoming, [])
  assert.equal(opened.contracts.pendingHire, false)
  // 窗口白名单也接受这份 contracts，不会在 helper 侧被丢掉。
  const normalized = shared.normalizeFarmWindow(opened)
  assert.equal(normalized.contracts.pendingHire, false)
  assert.equal(normalized.farm.guard, 0.3)

  // B 挂牌（HTTP 侧先起；随后 A 用桌面动作改自己的挂牌，验证四条动作闸门）。
  const bListing = await callAction(b, {
    action: 'hire-listing',
    enabled: true,
    wagePerHour: 10,
    minHours: 2,
    maxHours: 4
  })
  assert.equal(bListing.body.ok, true)
  desktop.emit({
    type: 'action',
    id: 'w2',
    action: 'hire-listing',
    enabled: true,
    wagePerHour: 10,
    minHours: 2,
    maxHours: 8
  })
  await waitFor(() => desktop.calls.results.some((entry) => entry.id === 'w2'))
  assert.equal(desktop.calls.results.find((entry) => entry.id === 'w2').result.ok, true)
  assert.deepEqual(a.snapshot().farm.hire, { enabled: true, wagePerHour: 10, minHours: 2, maxHours: 8 })

  // 等 B 的挂牌进 A 的雇工板（宿主 push 的 contracts.listings）。
  await waitFor(() => desktop.calls.windows.at(-1)?.contracts?.listings?.some((entry) =>
    entry.deviceId === bId && entry.available === true), 6000)
  const listingWindow = desktop.calls.windows.at(-1)
  const listing = listingWindow.contracts.listings.find((entry) => entry.deviceId === bId)
  assert.equal(listing.wagePerHour, 10)

  // 雇佣：桌面事件只带 deviceId + hours。
  desktop.emit({ type: 'action', id: 'w3', action: 'hire', deviceId: bId, hours: 2 })
  await waitFor(() => desktop.calls.results.some((entry) => entry.id === 'w3'))
  const hired = desktop.calls.results.find((entry) => entry.id === 'w3').result
  assert.equal(hired.ok, true, JSON.stringify(hired))
  await waitFor(() => desktop.calls.windows.at(-1)?.contracts?.outgoing?.[0]?.status === 'active')
  const activeWindow = desktop.calls.windows.at(-1)
  assert.equal(activeWindow.contracts.outgoing[0].workerNickname.length > 0, true)
  assert.equal(activeWindow.farm.guard, 0.8)
  assert.equal(activeWindow.farm.worker.nickname.length > 0, true)
  // 场景里出现带 work 角标的雇工。
  await waitFor(() => desktop.calls.scenes.at(-1).items.some((item) => item.role === 'worker'))
  const workerItem = desktop.calls.scenes.at(-1).items.find((item) => item.role === 'worker')
  assert.equal(workerItem.badge, 'work')

  // 提前结束：同一道窄口。
  const contractId = activeWindow.contracts.outgoing[0].id
  desktop.emit({ type: 'action', id: 'w4', action: 'end-contract', contractId })
  await waitFor(() => desktop.calls.results.some((entry) => entry.id === 'w4'))
  assert.equal(desktop.calls.results.find((entry) => entry.id === 'w4').result.ok, true)
  await waitFor(() => a.snapshot().contracts.outgoing[0].settled === true)
  assert.equal(a.snapshot().farm.coins, 9 + 20, '退款 20；手续费 1 烧掉')
  await waitFor(() => desktop.calls.windows.at(-1)?.farm?.guard === 0.3)

  // 源码窄口：preload 显式拷字段，窗口只发窄动作。
  const preload = await readFile(new URL('../desktop/farm-preload.js', import.meta.url), 'utf8')
  for (const field of ['deviceId', 'hours', 'contractId', 'wagePerHour', 'minHours', 'maxHours', 'enabled']) {
    assert.match(preload, new RegExp(field + ':'))
  }
  const renderer = await readFile(new URL('../desktop/farm.js', import.meta.url), 'utf8')
  assert.match(renderer, /hire-listing/)
  assert.match(renderer, /recall-worker/)
  assert.match(renderer, /end-contract/)
  const html = await readFile(new URL('../desktop/farm.html', import.meta.url), 'utf8')
  assert.match(html, /id="page-hire"/)

  // 白名单：四条动作与 contracts 归一化。
  assert.equal(shared.normalizeFarmAction({ action: 'hire', deviceId: bId, hours: 2 }).deviceId, bId)
  assert.equal(shared.normalizeFarmAction({ action: 'hire', deviceId: bId, hours: 1 }), null)
  assert.equal(shared.normalizeFarmAction({ action: 'hire', deviceId: bId, hours: 9 }), null)
  assert.equal(shared.normalizeFarmAction({ action: 'hire', deviceId: 'nope', hours: 2 }), null)
  assert.deepEqual(shared.normalizeFarmAction({ action: 'recall-worker', contractId }), {
    action: 'recall-worker',
    contractId
  })
  assert.equal(shared.normalizeFarmAction({ action: 'recall-worker', contractId: 'x' }), null)
  assert.deepEqual(shared.normalizeFarmAction({
    action: 'hire-listing',
    enabled: true,
    wagePerHour: 10,
    minHours: 2,
    maxHours: 8
  }), { action: 'hire-listing', enabled: true, wagePerHour: 10, minHours: 2, maxHours: 8 })
  assert.equal(shared.normalizeFarmAction({
    action: 'hire-listing',
    enabled: true,
    wagePerHour: 10,
    minHours: 6,
    maxHours: 4
  }), null)
  assert.equal(shared.FARM_ACTIONS.includes('hire'), true)

  const contracts = shared.normalizeContracts({
    outgoing: [{
      id: contractId,
      workerNickname: '  阿蟹  ',
      hours: 2,
      wagePerHour: 20,
      wage: 40,
      fee: 2,
      status: 'active',
      earned: 0,
      remainingMs: 1000,
      settled: false
    }],
    incoming: [],
    listings: [{ deviceId: bId, nickname: '阿蟹', available: true, wagePerHour: 20, minHours: 2, maxHours: 4, reason: 'ready' }],
    pendingHire: true
  })
  assert.equal(contracts.outgoing[0].workerNickname, '阿蟹')
  assert.equal(contracts.listings[0].deviceId, bId)
  assert.equal(contracts.pendingHire, true)
})
