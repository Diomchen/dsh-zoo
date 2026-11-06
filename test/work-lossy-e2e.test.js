/**
 * 票 44：UDP 丢包下的雇佣 —— request / ack / settle 各丢一包。
 *
 * 两个真 service 之间各放一个单向中继（只丢 work-*，其余照常转发）：
 *   A→B 丢第一包 work-request 和第一包 work-settle；
 *   B→A 丢第一包 work-ack。
 * 期望：A 重发同一 requestId → B 回放同一串 ack → 只建一份合同；
 * 结算重发同一 requestId → 只入账一次；钱只动一次。
 */
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createService } from '../src/service.js'
import { parsePacket } from '../src/protocol.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-work-lossy-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    petBridge: false,
    skinServer: false,
    desktop: false,
    ...options
  })
  service.routes = routes
  t.after(() => service.dispose())
  return service
}

/** 单向中继：原样转发到 targetPort（可后设），按类型吞掉前 N 包，并记下被吞的包。 */
async function lossyRelay (t, drops = {}) {
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
      // 已经关了
    }
  })
  const dropped = {}
  const droppedMessages = []
  const forwarded = []
  let targetPort = null
  socket.on('message', (message) => {
    const parsed = parsePacket(message)
    const type = parsed.ok ? parsed.packet.type : null
    const remaining = drops[type] ?? 0
    const already = dropped[type] ?? 0
    if (remaining > already) {
      dropped[type] = already + 1
      droppedMessages.push({ type, message })
      return
    }
    if (!Number.isInteger(targetPort) || targetPort <= 0) return
    forwarded.push(type)
    socket.send(message, targetPort, '127.0.0.1')
  })
  return {
    socket,
    port: socket.address().port,
    dropped,
    droppedMessages,
    forwarded,
    setTarget (port) { targetPort = port }
  }
}

async function callAction (service, body) {
  const route = service.routes.find((candidate) => candidate.path === '/dsh-zoo/action')
  assert.ok(route)
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

test('丢 request / ack / settle 各一包：仍只建一份合同、只结算一次', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  // A → B 的中继（丢第一包 work-request / work-settle），A 的 targetPort。
  const r1 = await lossyRelay(t, { 'work-request': 1, 'work-settle': 1 })
  // B → A 的中继（丢第一包 work-ack），B 的 targetPort。
  const r2 = await lossyRelay(t, { 'work-ack': 1 })

  const common = {
    network: true,
    petBridge: false,
    skinServer: false,
    desktop: false,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 5000,
    heartbeatIntervalMs: 5000,
    tickIntervalMs: 20,
    marketDigestMs: 1000,
    contractTickMs: 20,
    contractRetryMs: 1000,
    contractRetryMaxMs: 2000,
    contractStartupGraceMs: 5,
    peerLostMs: 20000,
    workRetryMs: 100,
    workAttempts: 4,
    workTimeoutMs: 3000
  }
  const b = makeService(t, {
    ...common,
    dataDir: dirB,
    port: 0,
    targetPort: r2.port,
    // B 对外广告「回 B 的中继」端口，A 的 ack/结束都走 r1。
    servicePort: r1.port
  })
  await b.ready
  const bPort = b.localPort()
  assert.ok(bPort > 0)
  r1.setTarget(bPort)
  const a = makeService(t, {
    ...common,
    dataDir: dirA,
    port: 0,
    targetPort: r1.port,
    // A 对外广告「回 A 的中继」端口，B 的 ack 才能被 r2 丢一次。
    servicePort: r2.port
  })
  await a.ready
  const aPort = a.localPort()
  assert.ok(aPort > 0)
  r2.setTarget(aPort)
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1, 8000)
  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  a.room.admit(bId)
  b.room.admit(aId)
  a.sendHeartbeats()
  b.sendHeartbeats()
  await waitFor(() => (a.snapshot().neighbors[0]?.heartbeatAt ?? 0) > 0 &&
    (b.snapshot().neighbors[0]?.heartbeatAt ?? 0) > 0)

  const listing = await callAction(b, {
    action: 'hire-listing',
    enabled: true,
    wagePerHour: 10,
    minHours: 2,
    maxHours: 8
  })
  assert.equal(listing.body.ok, true)

  let listingSeen = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    b.sendMarketDigest({ force: true })
    listingSeen = a.contractWindow().listings.find((entry) => entry.deviceId === bId && entry.available === true)
    if (listingSeen !== undefined) break
    await delay(600)
  }
  assert.ok(listingSeen, 'A 应该收到 B 的挂牌')

  const hired = await callAction(a, { action: 'hire', deviceId: bId, hours: 2 })
  assert.equal(hired.body.ok, true, JSON.stringify(hired.body))
  assert.equal(r1.dropped['work-request'], 1, '第一包 request 被丢了')
  assert.equal(r2.dropped['work-ack'], 1, '第一包 ack 被丢了')
  await waitFor(() => b.snapshot().contracts.incoming.length === 1)
  assert.equal(b.snapshot().contracts.incoming.length, 1, '重发不重复建合同')
  assert.equal(a.snapshot().contracts.outgoing.length, 1)
  assert.equal(a.snapshot().farm.coins, 9)
  assert.equal(a.farmGuard().guard, 0.8)

  const contractId = a.snapshot().contracts.outgoing[0].id
  const ended = await callAction(a, { action: 'end-contract', contractId })
  assert.equal(ended.body.ok, true, JSON.stringify(ended.body))
  await waitFor(() => b.snapshot().contracts.incoming[0]?.settled === true)
  assert.equal(r1.dropped['work-settle'], 1, '第一包 settle 被丢了')
  await waitFor(() => a.snapshot().contracts.outgoing[0]?.settled === true)
  await waitFor(() => a.snapshot().farm.coins === 29)
  assert.equal(b.snapshot().farm.coins, 30)
  await delay(250)
  assert.equal(a.snapshot().farm.coins, 29, '重发 settle 不重复退款')
  assert.equal(b.snapshot().farm.coins, 30, '重发 settle 不重复入账')
  assert.equal(a.snapshot().contracts.outgoing.length, 1)

  // 被丢的那两包与之后的重发必须是同一个 requestId（服务端按 id 幂等）。
  const settleDrops = r1.droppedMessages.filter((entry) => entry.type === 'work-settle')
  assert.equal(settleDrops.length, 1)
  const droppedSettle = parsePacket(settleDrops[0].message)
  assert.equal(droppedSettle.ok, true)
  assert.equal(droppedSettle.packet.contractId, contractId)
})
