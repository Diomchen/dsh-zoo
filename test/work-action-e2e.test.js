/**
 * 票 44：假 peer 的幂等与敌意输入。
 *
 * 覆盖「同一个 requestId 重发只落一份合同/只回同一串 ack」「坏时长/坏手续费/坏时薪整包拒绝」
 * 「settle 重复只入账一次」「未知合同 settle 明确失败」。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PROTOCOL_VERSION, encodeWorkRequest, parsePacket } from '../src/protocol.js'
import { createService } from '../src/service.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-work-action-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, dir, port, targetPort) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    petBridge: false,
    skinServer: false,
    desktop: false,
    port,
    targetPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 60000,
    tickIntervalMs: 20,
    contractTickMs: 20,
    contractRetryMs: 1000,
    contractStartupGraceMs: 5,
    peerLostMs: 600000
  })
  service.routes = routes
  t.after(() => service.dispose())
  return service
}

async function peerSocket (t) {
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
  const received = []
  socket.on('message', (message) => {
    received.push({ message, parsed: parsePacket(message) })
  })
  return { socket, port: socket.address().port, received }
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

function beacon (deviceId, nickname, port) {
  return Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'beacon',
    deviceId,
    nickname,
    port
  }), 'utf8')
}

function packetsOfType (peer, type) {
  return peer.received.filter((entry) => entry.parsed.ok && entry.parsed.packet.type === type)
}

test('work-request 重发：只建一份合同，ack 逐字节一致；坏字段明确拒绝', async (t) => {
  const dir = await tempDir(t)
  const peer = await peerSocket(t)
  const service = makeService(t, dir, 0, peer.port)
  await service.ready
  const port = service.localPort()
  assert.ok(port > 0)
  const employerId = randomUUID()

  // 先让 service 看见这位邻居，再放行。
  peer.socket.send(beacon(employerId, '楼上的柯基', peer.port), port, '127.0.0.1')
  await waitFor(() => service.snapshot().neighbors.some((neighbor) => neighbor.deviceId === employerId))
  assert.equal(service.room.admit(employerId).ok, true)

  const listing = await callAction(service, {
    action: 'hire-listing',
    enabled: true,
    wagePerHour: 10,
    minHours: 2,
    maxHours: 8
  })
  assert.equal(listing.body.ok, true)

  // 先验坏字段：低于挂牌时薪 / 手续费不对 → bad-wage；1 小时在协议层就丢。
  const tooCheap = encodeWorkRequest({
    deviceId: employerId,
    requestId: randomUUID(),
    hours: 2,
    wagePerHour: 9,
    fee: 1
  })
  peer.socket.send(tooCheap, port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-ack').length === 1)
  assert.equal(packetsOfType(peer, 'work-ack')[0].parsed.packet.ok, false)
  assert.equal(packetsOfType(peer, 'work-ack')[0].parsed.packet.error, 'bad-wage')

  const wrongFee = Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'work-request',
    deviceId: employerId,
    requestId: randomUUID(),
    hours: 2,
    wagePerHour: 10,
    fee: 2
  }), 'utf8')
  peer.socket.send(wrongFee, port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-ack').length === 2)
  assert.equal(packetsOfType(peer, 'work-ack')[1].parsed.packet.ok, false)
  assert.equal(packetsOfType(peer, 'work-ack')[1].parsed.packet.error, 'bad-wage')

  // 协议只允许 2–8；手工构造一个 1 小时的包，协议层直接丢，service 根本不回 ack。
  const rawBadHours = Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'work-request',
    deviceId: employerId,
    requestId: randomUUID(),
    hours: 1,
    wagePerHour: 10,
    fee: 1
  }), 'utf8')
  peer.socket.send(rawBadHours, port, '127.0.0.1')
  await delay(120)
  assert.equal(packetsOfType(peer, 'work-ack').length, 2, '协议层就丢了 1 小时的包')

  // 正常雇佣：ack 带 contractId + 起点/终点 + 0.5 守卫。
  const requestId = randomUUID()
  const packet = encodeWorkRequest({
    deviceId: employerId,
    requestId,
    hours: 2,
    wagePerHour: 10,
    fee: 1
  })
  peer.socket.send(packet, port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-ack').length === 3)
  const firstAck = packetsOfType(peer, 'work-ack')[2]
  assert.equal(firstAck.parsed.packet.ok, true)
  assert.equal(firstAck.parsed.packet.guard, 0.5)
  const contractId = firstAck.parsed.packet.contractId
  assert.equal(service.snapshot().contracts.incoming.length, 1)
  assert.equal(service.snapshot().self.work.contractId, contractId)
  assert.equal(service.snapshot().visitors.length, 0, 'work-request 不是串门')

  // 同一串字节再发一次：回放同一串 ack，不新建合同。
  peer.socket.send(packet, port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-ack').length === 4)
  const secondAck = packetsOfType(peer, 'work-ack')[3]
  assert.deepEqual(secondAck.message, firstAck.message)
  assert.equal(service.snapshot().contracts.incoming.length, 1)

  // 已经在外打工：同一位雇主再发一笔（新 requestId）→ already-working。
  const secondContract = encodeWorkRequest({
    deviceId: employerId,
    requestId: randomUUID(),
    hours: 2,
    wagePerHour: 10,
    fee: 1
  })
  peer.socket.send(secondContract, port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-ack').length === 5)
  assert.equal(packetsOfType(peer, 'work-ack')[4].parsed.packet.error, 'already-working')
  assert.equal(packetsOfType(peer, 'work-ack')[2].parsed.packet.requestId, requestId)
  assert.equal(service.snapshot().farm.coins, 30, '雇工侧不扣钱')

})

test('work-end → 结算幂等：重复 settle 只入账一次，ack 可重放；未知合同明确失败', async (t) => {
  const dir = await tempDir(t)
  const peer = await peerSocket(t)
  const service = makeService(t, dir, 0, peer.port)
  await service.ready
  const port = service.localPort()
  assert.ok(port > 0)
  const employerId = randomUUID()
  const employerNickname = '楼上的柯基'
  peer.socket.send(beacon(employerId, employerNickname, peer.port), port, '127.0.0.1')
  await waitFor(() => service.snapshot().neighbors.some((neighbor) => neighbor.deviceId === employerId))
  service.room.admit(employerId)
  await callAction(service, {
    action: 'hire-listing',
    enabled: true,
    wagePerHour: 10,
    minHours: 2,
    maxHours: 8
  })

  const requestId = randomUUID()
  peer.socket.send(encodeWorkRequest({
    deviceId: employerId,
    requestId,
    hours: 2,
    wagePerHour: 10,
    fee: 1
  }), port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-ack').length === 1)
  const contractId = packetsOfType(peer, 'work-ack')[0].parsed.packet.contractId

  // 雇主提前结束：雇工镜像消失，合同 ended。
  const endPayload = Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'work-end',
    deviceId: employerId,
    contractId,
    reason: 'employer-end'
  }), 'utf8')
  peer.socket.send(endPayload, port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-end-ack').length === 1)
  assert.equal(service.snapshot().self.work, null)
  assert.equal(service.snapshot().contracts.incoming[0].status, 'ended')
  assert.equal(service.farmGuard().guard, 0.3)

  // 重复 work-end：回 ok，不重复结束。
  peer.socket.send(endPayload, port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-end-ack').length === 2)
  assert.equal(packetsOfType(peer, 'work-end-ack')[1].parsed.packet.ok, true)

  const settleRequestId = randomUUID()
  const settle = Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'work-settle',
    deviceId: employerId,
    contractId,
    requestId: settleRequestId,
    servedMs: 3600000,
    earned: 10,
    reason: 'employer-end'
  }), 'utf8')
  peer.socket.send(settle, port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-settle-ack').length === 1)
  const first = packetsOfType(peer, 'work-settle-ack')[0].parsed.packet
  assert.equal(first.ok, true)
  assert.equal(first.earned, 10)
  await waitFor(() => service.snapshot().farm.coins === 40)

  // 同一包重发：只重放 ack，不再加钱。
  peer.socket.send(settle, port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-settle-ack').length === 2)
  const second = packetsOfType(peer, 'work-settle-ack')[1]
  assert.equal(second.parsed.packet.earned, 10)
  assert.deepEqual(second.message, packetsOfType(peer, 'work-settle-ack')[0].message)
  assert.equal(service.snapshot().farm.coins, 40)
  assert.equal(service.snapshot().contracts.incoming[0].settled, true)

  // 未知合同：明确 contract-not-found，不崩。
  const unknown = Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'work-settle',
    deviceId: employerId,
    contractId: randomUUID(),
    requestId: randomUUID(),
    servedMs: 0,
    earned: 0,
    reason: 'recall'
  }), 'utf8')
  peer.socket.send(unknown, port, '127.0.0.1')
  await waitFor(() => packetsOfType(peer, 'work-settle-ack').length === 3)
  assert.equal(packetsOfType(peer, 'work-settle-ack')[2].parsed.packet.ok, false)
  assert.equal(packetsOfType(peer, 'work-settle-ack')[2].parsed.packet.error, 'contract-not-found')
})
