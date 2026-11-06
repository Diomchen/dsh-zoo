/**
 * 票 43：丢包重试的幂等（真 service 之间，单向中继吞掉指定的第一包）。
 *
 * 两条路径各测一次：
 *   1. A→B 的 farm-action 丢了：A 重发同一个 requestId，B 只落账一次；
 *   2. B→A 的 farm-action-result 丢了：A 重发，B 回放缓存，A 只应用一次。
 *
 * 回环上所有 service 共用 127.0.0.1 的 20 包/10 秒限速，所以心跳 2 秒、广播 60 秒，
 * 动作只串行发一次。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FARM_FILE, FARM_VERSION } from '../src/farm.js'
import { CROPS } from '../src/farm-rules.js'
import { parsePacket } from '../src/protocol.js'
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-farm-retry-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    petBridge: false,
    desktop: false,
    skinServer: false,
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

/**
 * 单向 UDP 中继：原样转发到 targetPort，但吞掉前 `dropCount` 包 `dropType`。
 * 和 visit-e2e 的同一套；两个真服务之间没有别的注入口。
 */
async function lossyRelay (t, targetPort, { dropType, dropCount = 1 } = {}) {
  const socket = dgram.createSocket('udp4')
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject)
      resolve()
    })
  })
  t.after(() => {
    try {
      socket.close()
    } catch {
      // 已经关掉了
    }
  })
  let dropped = 0
  socket.on('message', (message) => {
    const parsed = parsePacket(message)
    if (parsed.ok && parsed.packet.type === dropType && dropped < dropCount) {
      dropped += 1
      return
    }
    socket.send(message, targetPort, '127.0.0.1')
  })
  return {
    socket,
    port: socket.address().port,
    dropped: () => dropped
  }
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
    farmActionRetryMs: 60,
    farmActionTimeoutMs: 1500,
    ...overrides
  }
}

function farmFile (overrides = {}) {
  const mature = {
    id: 'p1',
    crop: 'tomato',
    plantedAt: NOW - CROPS.tomato.growMs,
    grownMs: CROPS.tomato.growMs,
    growMs: CROPS.tomato.growMs,
    waterings: 0,
    fertilized: false,
    stolenBy: [],
    helpedBy: []
  }
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
    plots: [mature],
    hire: { enabled: false, wagePerHour: 10, minHours: 2, maxHours: 8 },
    log: [],
    ...overrides
  }
}

async function readFarm (dir) {
  return JSON.parse(await readFile(join(dir, FARM_FILE), 'utf8'))
}

async function admittedPair (t, dirA, dirB, portA, portB, optionsA = {}, optionsB = {}) {
  const a = makeService(t, twoOptions(dirA, portA, portB, optionsA))
  await a.ready
  const b = makeService(t, twoOptions(dirB, portB, portA, optionsB))
  await b.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)
  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)
  await waitFor(() => a.snapshot().neighbors[0].heartbeatAt > 0 && b.snapshot().neighbors[0].heartbeatAt > 0)
  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)
  return { a, b, aId, bId }
}

test('farm-action 丢第一包：访客重发同一 requestId，主人只落账一次', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  await writeFile(join(dirA, FARM_FILE), JSON.stringify(farmFile()), 'utf8')
  await writeFile(join(dirB, FARM_FILE), JSON.stringify(farmFile()), 'utf8')
  const [portA, portB] = await Promise.all([freeUdpPort(), freeUdpPort()])
  const relay = await lossyRelay(t, portB, { dropType: 'farm-action', dropCount: 1 })
  // B 对外广告中继端口：A 的 farm-action 先到中继，第一包被吞掉。
  const { a, b, aId } = await admittedPair(t, dirA, dirB, portA, portB, {}, { servicePort: relay.port })

  const stolen = await callAction(a, { action: 'farm-steal', plotId: 'p1' })
  assert.equal(stolen.status, 200)
  assert.equal(stolen.body.ok, true)
  assert.equal(stolen.body.crop, 'tomato')
  assert.equal(relay.dropped(), 1, '中继确实吞掉了第一包 farm-action')

  const farm = await readFarm(dirB)
  assert.deepEqual(farm.plots[0].stolenBy, [aId])
  assert.equal(farm.log.filter((entry) => entry.kind === 'steal').length, 1)
  assert.equal(a.snapshot().farm.crops.tomato, 1)
  assert.equal(b.snapshot().visitors.length, 1)
})

test('farm-action-result 丢第一包：A 重发，B 回放缓存，A 只应用一次', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  await writeFile(join(dirA, FARM_FILE), JSON.stringify(farmFile()), 'utf8')
  await writeFile(join(dirB, FARM_FILE), JSON.stringify(farmFile()), 'utf8')
  const [portA, portB] = await Promise.all([freeUdpPort(), freeUdpPort()])
  const relay = await lossyRelay(t, portA, { dropType: 'farm-action-result', dropCount: 1 })
  // A 对外广告中继端口：B 的 farm-action-result 先到中继，第一包被吞掉。
  const { a, b, aId } = await admittedPair(t, dirA, dirB, portA, portB, { servicePort: relay.port }, {})

  const stolen = await callAction(a, { action: 'farm-steal', plotId: 'p1' })
  assert.equal(stolen.status, 200)
  assert.equal(stolen.body.ok, true)
  assert.equal(relay.dropped(), 1, '中继确实吞掉了第一包 farm-action-result')

  const farm = await readFarm(dirB)
  assert.deepEqual(farm.plots[0].stolenBy, [aId])
  assert.equal(farm.log.filter((entry) => entry.kind === 'steal').length, 1)
  // A 只应用一次：仓库 +1，而不是 +2。
  assert.equal(a.snapshot().farm.crops.tomato, 1)
  assert.equal(b.snapshot().visitors.length, 1)
})

test('对方不回应：1.5 秒内明确 timeout，访客仓库不变', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  await writeFile(join(dirA, FARM_FILE), JSON.stringify(farmFile()), 'utf8')
  await writeFile(join(dirB, FARM_FILE), JSON.stringify(farmFile()), 'utf8')
  const [portA, portB] = await Promise.all([freeUdpPort(), freeUdpPort()])
  // B 广告中继端口：中继把 farm-action 全部吞掉，其它报文（visit-request/ack）照常转发。
  const blackhole = await lossyRelay(t, portB, { dropType: 'farm-action', dropCount: 99 })
  const { a } = await admittedPair(t, dirA, dirB, portA, portB, {}, { servicePort: blackhole.port })

  const startedAt = Date.now()
  const result = await callAction(a, { action: 'farm-steal', plotId: 'p1' })
  const elapsed = Date.now() - startedAt
  assert.equal(result.status, 409)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.error, 'timeout')
  assert.ok(elapsed < 4000, '1.5 秒左右就该收手（实际 ' + elapsed + 'ms）')
  assert.deepEqual(a.snapshot().farm.crops, {})
})
