/**
 * 票 43：两个真 service 的端到端（串门 → 访客窗口 → 偷/帮 → 结束 404）。
 *
 * 回环上两个 service 共用 127.0.0.1 的 20 包/10 秒限速，所以：
 *   - 心跳保持 2 秒（端口缓存需要心跳；不能调到 60 秒）；
 *   - 广播 60 秒一次，动作之间串行等待，不并发打满。
 */
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FARM_FILE, FARM_VERSION } from '../src/farm.js'
import { CROPS, localDayKey } from '../src/farm-rules.js'
import { createService } from '../src/service.js'

const NOW = Date.now()
const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor (predicate, timeoutMs = 4000) {
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-farm-visit-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    petBridge: false,
    desktop: false,
    ...options
  })
  service.routes = routes
  t.after(() => service.dispose())
  return service
}

async function freeUdpPort () {
  const socket = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject)
      resolve()
    })
  })
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

async function freeTcpPort () {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

function twoOptions (dir, port, targetPort, overrides = {}) {
  return {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    port,
    targetPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 2000,
    visitMaxMs: 60000,
    visitRetryMs: 50,
    visitTimeoutMs: 2000,
    visitTickMs: 10,
    tickIntervalMs: 50,
    farmNow: () => NOON,
    farmRandom: () => 1,
    ...overrides
  }
}

function plot (id, crop, { mature = false } = {}) {
  return {
    id,
    crop,
    plantedAt: NOW - (mature ? CROPS[crop].growMs : 1000),
    grownMs: mature ? CROPS[crop].growMs : 1000,
    growMs: CROPS[crop].growMs,
    waterings: 0,
    fertilized: false,
    stolenBy: [],
    helpedBy: []
  }
}

function farmFile (overrides = {}) {
  return {
    version: FARM_VERSION,
    coins: 30,
    seeds: { tomato: 2 },
    crops: {},
    dew: 0,
    dewEarned: 0,
    dewAt: null,
    dewDay: null,
    lastTickAt: null,
    plots: [plot('p1', 'tomato', { mature: true }), plot('p2', 'carrot'), plot('p3', 'tomato', { mature: true }), plot('p4', 'tomato', { mature: true })],
    hire: { enabled: false, wagePerHour: 10, minHours: 2, maxHours: 8 },
    log: [],
    ...overrides
  }
}

async function readFarm (dir) {
  return JSON.parse(await readFile(join(dir, FARM_FILE), 'utf8'))
}

async function callAction (service, body) {
  const route = service.routes.find((candidate) => candidate.path === '/dsh-zoo/action')
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

/** 只记录场景/窗口命令/action-result 的桌面替身；不 spawn Electron。 */
function desktopDouble () {
  const calls = { scenes: [], windows: [], results: [] }
  let onEvent = null
  return {
    calls,
    factory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4343 } },
        update (scene) { calls.scenes.push(scene); return true },
        resync (scene) { calls.scenes.push(scene); return true },
        farmWindow (payload) {
          calls.windows.push(payload)
          return true
        },
        actionResult (id, result) {
          calls.results.push({ id, result })
        },
        dispose () {}
      }
    },
    ready (workArea = { x: 0, y: 30, width: 1000, height: 700 }) {
      onEvent?.({
        type: 'ready',
        pid: 4343,
        workArea,
        displays: [{ id: 1, bounds: workArea, workArea, scaleFactor: 1, primary: true }]
      })
    },
    emit (event) {
      onEvent?.(event)
    }
  }
}

async function twoServices (t, { aFarm, bFarm, aDesktop = false, ...overrides } = {}) {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  if (aFarm !== undefined) await writeFile(join(dirA, FARM_FILE), JSON.stringify(aFarm), 'utf8')
  if (bFarm !== undefined) await writeFile(join(dirB, FARM_FILE), JSON.stringify(bFarm), 'utf8')
  const [portA, portB, skinPortB] = await Promise.all([freeUdpPort(), freeUdpPort(), freeTcpPort()])

  const desktop = aDesktop ? desktopDouble() : null
  const b = makeService(t, twoOptions(dirB, portB, portA, {
    skinPort: skinPortB,
    ...overrides
  }))
  await b.ready
  const a = makeService(t, twoOptions(dirA, portA, portB, {
    skinPort: 0,
    ...(desktop === null ? { desktop: false } : { desktop: true, desktopFactory: desktop.factory }),
    ...overrides
  }))
  await a.ready
  if (desktop !== null) desktop.ready()

  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)
  // 放行后各自立刻补发心跳：农场快照的 LAN 端口缓存从心跳/广播里来，必须真的见到一拍。
  await waitFor(() => a.snapshot().neighbors[0].heartbeatAt > 0 && b.snapshot().neighbors[0].heartbeatAt > 0)

  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)
  return { a, b, dirA, dirB, desktop, aId, bId, skinPortB, portA, portB, visitId: a.snapshot().self.out.visitId }
}

test('访客窗口 + 偷/帮：快照只给布尔、动作走 UDP、结果回窗；结束后 404 + ended', async (t) => {
  const context = await twoServices(t, {
    aFarm: farmFile({ dew: 2, dewEarned: 2 }),
    bFarm: farmFile(),
    aDesktop: true
  })
  const { a, b, desktop, aId, bId, skinPortB, visitId } = context

  // 主人侧快照（真实 HTTP 路由）：只在活跃串门期间可读。
  const response = await fetch('http://127.0.0.1:' + skinPortB + '/dsh-zoo-farm/' + visitId)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const snapshot = await response.json()
  assert.equal(snapshot.visitId, visitId)
  assert.equal(snapshot.guard, 0.3)
  assert.deepEqual(snapshot.guardParts, { ownerHome: true, worker: false })
  assert.deepEqual(snapshot.plots.map((plot) => plot.id), ['p1', 'p2', 'p3', 'p4'])
  assert.equal(snapshot.plots[0].stage, 'mature')
  assert.equal(snapshot.plots[0].stolenByMe, false)
  assert.equal(snapshot.plots[1].stage, 'growing')
  assert.equal(snapshot.limits.steal.perVisit, 3)
  assert.equal(snapshot.limits.steal.usedInVisit, 0)
  assert.equal(snapshot.hire.wagePerHour, 10)
  const text = JSON.stringify(snapshot)
  assert.equal(text.includes('stolenBy"'), false)
  assert.equal(text.includes('helpedBy"'), false)
  assert.equal(text.includes('"path"'), false)
  assert.equal(text.includes(aId), false, '访客视图不回传自己的 deviceId')
  assert.equal(text.includes(bId), false, '访客视图不回传主人的 deviceId')

  // 打开窗口：先 owner + loading，随后拉到 ready。
  desktop.emit({ type: 'action', id: 'f-open', action: 'farm-open' })
  await waitFor(() => desktop.calls.windows.length > 0)
  assert.equal(desktop.calls.windows[0].mode, 'visitor')
  assert.equal(desktop.calls.windows[0].visit.state, 'loading')
  await waitFor(() => {
    const last = desktop.calls.windows.at(-1)
    return last.visit?.state === 'ready'
  })
  const ready = desktop.calls.windows.at(-1)
  assert.equal(ready.visit.guard, 0.3)
  assert.equal(ready.visit.plots.length, 4)
  assert.equal(ready.visit.plots[0].mature, true)
  assert.equal(ready.visit.plots[1].remainingMs > 0, true)
  assert.equal('stolenBy' in ready.visit.plots[0], false)

  // 偷：desktop → 宿主 UDP → 主人落账 → 结果回窗（成功不关窗，只 toast）。
  desktop.emit({ type: 'action', id: 'f-steal', action: 'farm-steal', plotId: 'p1' })
  await waitFor(() => desktop.calls.results.some((entry) => entry.id === 'f-steal'))
  const stealResult = desktop.calls.results.find((entry) => entry.id === 'f-steal').result
  assert.equal(stealResult.ok, true)
  assert.match(stealResult.notice, /偷到了 1 个/)
  assert.equal((await a.snapshot().farm.crops).tomato, 1)
  const bFarm = await readFarm(context.dirB)
  assert.deepEqual(bFarm.plots[0].stolenBy, [aId])
  assert.equal(bFarm.log[0].kind, 'steal')
  assert.equal(bFarm.log[0].who, a.snapshot().self.nickname)

  // 窗口刷新：同一块地变成 stolenByMe=true。
  await waitFor(() => {
    const last = desktop.calls.windows.at(-1)
    return last.visit?.state === 'ready' && last.visit.plots[0].stolenByMe === true
  })

  // 帮：先扣 1 露水；成功后 +1 硬币；地块 +10% 且不算 waterings。
  const beforeHelp = (await readFarm(context.dirB)).plots[1]
  desktop.emit({ type: 'action', id: 'f-help', action: 'farm-help', plotId: 'p2' })
  await waitFor(() => desktop.calls.results.some((entry) => entry.id === 'f-help'))
  assert.equal(desktop.calls.results.find((entry) => entry.id === 'f-help').result.ok, true)
  assert.equal(a.snapshot().farm.dew, 1)
  assert.equal(a.snapshot().farm.coins, 31)
  const helpedFarm = await readFarm(context.dirB)
  assert.deepEqual(helpedFarm.plots[1].helpedBy, [aId])
  assert.equal(
    helpedFarm.plots[1].grownMs,
    beforeHelp.grownMs + Math.floor(beforeHelp.growMs * 0.1)
  )
  assert.equal(helpedFarm.plots[1].waterings, 0)
  assert.equal(helpedFarm.log[0].kind, 'help')
  assert.equal(helpedFarm.log[0].who, a.snapshot().self.nickname)

  // 再帮同一块地：主人回 already-helped，访客把扣掉的露水退回（只退一次）。
  desktop.emit({ type: 'action', id: 'f-help-2', action: 'farm-help', plotId: 'p2' })
  await waitFor(() => desktop.calls.results.some((entry) => entry.id === 'f-help-2'))
  const helpAgain = desktop.calls.results.find((entry) => entry.id === 'f-help-2').result
  assert.equal(helpAgain.ok, false)
  assert.equal(helpAgain.error, 'already-helped')
  assert.equal(a.snapshot().farm.dew, 1)

  // 送客：快照立刻 404；窗口收到 ended。
  assert.equal((await callAction(b, { action: 'end-visit', deviceId: aId })).status, 200)
  await waitFor(() => a.snapshot().self.out === null, 3000)
  assert.equal(
    (await fetch('http://127.0.0.1:' + skinPortB + '/dsh-zoo-farm/' + visitId)).status,
    404
  )
  await waitFor(() => desktop.calls.windows.at(-1).visit?.state === 'ended')
  assert.equal(desktop.calls.windows.at(-1).mode, 'visitor')
})

test('访客侧本机日上限：偷 10 次后不再发 UDP，直接 cap', async (t) => {
  // 主人地块不写死；访客本机账本直接改成 10 次，验证本地门先挡住（不发包）。
  const context = await twoServices(t, {
    aFarm: farmFile({
      dew: 2,
      visitStats: {
        day: localDayKey(NOON),
        steal: { total: 0, byVisitor: {} },
        help: { total: 0, byVisitor: {} },
        mine: { steal: 10, help: 0 }
      }
    }),
    bFarm: farmFile(),
    aDesktop: true
  })
  const { a, desktop, b } = context
  assert.equal((await a.snapshot().farm.crops?.tomato) ?? 0, 0)
  const before = await readFarm(context.dirB)
  desktop.emit({ type: 'action', id: 'f-cap', action: 'farm-steal', plotId: 'p1' })
  await waitFor(() => desktop.calls.results.some((entry) => entry.id === 'f-cap'))
  const capResult = desktop.calls.results.find((entry) => entry.id === 'f-cap').result
  assert.equal(capResult.ok, false)
  assert.equal(capResult.error, 'cap')
  // 主人侧地块完全没有被动过。
  const after = await readFarm(context.dirB)
  assert.deepEqual(after.plots[0].stolenBy, before.plots[0].stolenBy)
  assert.equal(b.snapshot().visitors.length, 1)
})
