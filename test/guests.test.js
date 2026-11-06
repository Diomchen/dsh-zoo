import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { GUEST_TTL_MS, PROTOCOL_VERSION, parsePacket } from '../src/protocol.js'
import { createService } from '../src/service.js'

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor (predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-guests-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, { petBridge: false, skinServer: false, ...options })
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

async function distinctPorts (count) {
  const ports = new Set()
  while (ports.size < count) ports.add(await freeUdpPort())
  return [...ports]
}

async function loopbackPeer (t) {
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

  const received = []
  socket.on('message', (message, rinfo) => {
    received.push({ message, rinfo, parsed: parsePacket(message), at: Date.now() })
  })
  return { socket, received }
}

function heartbeatEntries (received) {
  return received.filter((entry) => entry.parsed.ok && entry.parsed.packet.type === 'heartbeat')
}

function beaconPayload ({ deviceId, nickname, port }) {
  return Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'beacon',
    deviceId,
    nickname,
    port
  }), 'utf8')
}

function heartbeatPayload ({ deviceId, anim }) {
  return Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'heartbeat',
    deviceId,
    anim
  }), 'utf8')
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

test('放行前不发心跳；放行后心跳只带四个字段，对方心跳创建访客', async (t) => {
  const dir = await tempDir(t)
  const peer = await loopbackPeer(t)
  const peerPort = peer.socket.address().port
  const servicePort = await freeUdpPort()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    port: servicePort,
    targetPort: peerPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 150
  })
  await service.ready

  const deviceId = randomUUID()
  peer.socket.send(
    beaconPayload({ deviceId, nickname: '乙', port: peerPort }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().neighbors.length === 1)
  assert.equal(service.snapshot().neighbors[0].status, 'pending')

  // 未放行：服务端只发过 beacon/ack，不会向这个来源发心跳。
  await delay(450)
  assert.equal(heartbeatEntries(peer.received).length, 0)
  assert.deepEqual(service.snapshot().guests, [])

  const admitted = await callAction(service, { action: 'admit', deviceId })
  assert.equal(admitted.status, 200)
  assert.equal(admitted.body.ok, true)
  assert.equal(admitted.body.persisted, true)

  // 放行会立刻补发一轮心跳，不用等 2 秒节拍。
  await waitFor(() => heartbeatEntries(peer.received).length > 0)
  const first = heartbeatEntries(peer.received)[0]
  assert.equal(first.parsed.ok, true)
  assert.deepEqual(Object.keys(first.parsed.packet), ['v', 'type', 'deviceId', 'anim'])
  assert.equal(first.parsed.packet.type, 'heartbeat')
  assert.equal(first.parsed.packet.deviceId, service.snapshot().self.deviceId)
  assert.equal(first.parsed.packet.anim, null)

  const wire = first.message.toString('utf8')
  const raw = JSON.parse(wire)
  for (const key of ['x', 'y', 'pos', 'position', 'coordinates', 'coord', 'lat', 'lng']) {
    assert.equal(Object.prototype.hasOwnProperty.call(raw, key), false, key)
  }
  assert.doesNotMatch(wire, /"(x|y|pos|position|coordinates?|coord|lat|lng)"\s*:/)

  // 本机影子换动作后，下一次心跳带上新的 anim。
  service.room.setSelfPet({ name: '蓝毛小女仆', anim: '写代码' })
  await waitFor(() => heartbeatEntries(peer.received).some((entry) => entry.parsed.packet.anim === '写代码'))
  assert.deepEqual(service.snapshot().self.pet, { name: '蓝毛小女仆', anim: '写代码' })
  // 自己的心跳不会把自己变成访客。
  assert.deepEqual(service.snapshot().guests, [])

  // 对方心跳 → 本机访客，带昵称与动作；快照里没有地址/坐标。
  peer.socket.send(
    heartbeatPayload({ deviceId, anim: '东张西望' }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().guests.length === 1)
  const guest = service.snapshot().guests[0]
  assert.equal(guest.deviceId, deviceId)
  assert.equal(guest.nickname, '乙')
  assert.equal(guest.anim, '东张西望')
  assert.equal(Number.isFinite(guest.since), true)
  assert.equal(guest.expiresAt, guest.since + GUEST_TTL_MS)
  assert.deepEqual(Object.keys(guest), ['deviceId', 'nickname', 'anim', 'since', 'expiresAt'])
  assert.equal(JSON.stringify(service.snapshot()).includes('127.0.0.1'), false)
  assert.equal(JSON.stringify(service.snapshot()).includes('"coordinates"'), false)

  // 拒绝 → 访客立即消失；之后对方再发心跳也不会被带回来，本机也不再发心跳。
  service.room.reject(deviceId)
  assert.deepEqual(service.snapshot().guests, [])
  peer.socket.send(
    heartbeatPayload({ deviceId, anim: '写代码' }),
    servicePort,
    '127.0.0.1'
  )
  await delay(100)
  assert.deepEqual(service.snapshot().guests, [])

  const beatsAfterReject = heartbeatEntries(peer.received).length
  await delay(450)
  assert.equal(heartbeatEntries(peer.received).length, beatsAfterReject)
})

test('两个实例在回环上互相放行：动作进对方访客表，拒绝立即清掉', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const [portA, portB] = await distinctPorts(2)
  const options = (dir, port, targetPort) => ({
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    petBridge: false,
    port,
    targetPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 600
  })

  // 先起 B，再起 A：A 的首包一定能被已绑定的 B 收到，B 的回执让 A 也看见 B。
  const b = makeService(t, options(dirB, portB, portA))
  await b.ready
  const a = makeService(t, options(dirA, portA, portB))
  await a.ready

  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)
  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal(a.snapshot().neighbors[0].deviceId, bId)
  assert.equal(b.snapshot().neighbors[0].deviceId, aId)
  assert.deepEqual(a.snapshot().guests, [])
  assert.deepEqual(b.snapshot().guests, [])

  // 单向放行：A 发心跳，但 B 的门控还关着，B 不会出现访客。
  a.room.admit(bId)
  await delay(900)
  assert.deepEqual(b.snapshot().guests, [])
  assert.equal(b.snapshot().neighbors[0].status, 'pending')

  // 双向放行：两边各出现一位访客，昵称来自各自的快照身份。
  b.room.admit(aId)
  await waitFor(() => a.snapshot().guests.length === 1 && b.snapshot().guests.length === 1)
  assert.deepEqual(
    a.snapshot().guests.map((guest) => [guest.deviceId, guest.nickname]),
    [[bId, b.snapshot().self.nickname]]
  )
  assert.deepEqual(
    b.snapshot().guests.map((guest) => [guest.deviceId, guest.nickname]),
    [[aId, a.snapshot().self.nickname]]
  )

  // A 本地影子换动作，通过心跳出现在 B 的访客身上；A 自己的影子不受影响。
  a.room.setSelfPet({ name: '蓝毛小女仆', anim: '写代码' })
  await waitFor(() => b.snapshot().guests[0].anim === '写代码', 3000)
  assert.deepEqual(a.snapshot().self.pet, { name: '蓝毛小女仆', anim: '写代码' })
  assert.equal(a.snapshot().guests.length, 1)

  // 地址只在发现层；两个快照都不含回环地址或坐标字段。
  for (const snap of [a.snapshot(), b.snapshot()]) {
    const text = JSON.stringify(snap)
    assert.equal(text.includes('127.0.0.1'), false)
    assert.equal(text.includes('"coordinates"'), false)
    assert.equal(text.includes('"x"'), false)
    assert.equal(text.includes('"y"'), false)
  }

  // B 拒绝 A：B 的访客立即消失，A 之后的心跳也被丢弃。
  b.room.reject(aId)
  assert.deepEqual(b.snapshot().guests, [])
  await delay(900)
  assert.deepEqual(b.snapshot().guests, [])
  // A 没有拒绝 B，所以 A 那边的访客还在：两位邻居的客厅互不干扰。
  assert.equal(a.snapshot().guests.length, 1)
})

async function listen (server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return `http://127.0.0.1:${server.address().port}`
}

function close (server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('本机动作一变就立刻补发心跳，不等 2 秒节拍', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')

  let stateAnim = '写代码'
  const server = createServer((req, res) => {
    if (req.url !== '/dsh-pet-7340/state') {
      res.statusCode = 404
      res.end('no')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      counter: Date.now(),
      pets: { main: { anim: { counter: 1, data: { name: stateAnim } } } }
    }))
  })
  const origin = await listen(server)
  t.after(() => close(server))

  const peer = await loopbackPeer(t)
  const peerPort = peer.socket.address().port
  const servicePort = await freeUdpPort()
  const { ctx, routes } = fakeCtx()
  ctx.webServer.getOrigin = () => origin
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: configPath,
    network: true,
    skinServer: false,
    port: servicePort,
    targetPort: peerPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    // 很长：这个测试只看“动作变化触发的立刻补发”，不看周期心跳。
    heartbeatIntervalMs: 60000
  })
  service.routes = routes
  t.after(() => service.dispose())
  await service.ready
  assert.deepEqual(service.snapshot().self.pet, { name: '蓝毛小女仆', anim: '写代码' })

  const deviceId = randomUUID()
  peer.socket.send(
    beaconPayload({ deviceId, nickname: '乙', port: peerPort }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().neighbors.length === 1)
  const admitted = await callAction(service, { action: 'admit', deviceId })
  assert.equal(admitted.status, 200)

  // 放行本身会立刻发一轮，带上当前动作。
  await waitFor(() => heartbeatEntries(peer.received).some((entry) => entry.parsed.packet.anim === '写代码'))
  const before = heartbeatEntries(peer.received).length

  // dsh-pet 的状态变了：桥接下一次轮询会把新 anim 写进 self.pet，并立刻补发心跳。
  stateAnim = '东张西望'
  await waitFor(
    () => heartbeatEntries(peer.received).some((entry) => entry.parsed.packet.anim === '东张西望'),
    2500
  )
  const after = heartbeatEntries(peer.received).length
  assert.ok(after > before)
  assert.equal(service.snapshot().self.pet.anim, '东张西望')
  // 仍然只带四个字段，没有坐标。
  const latest = heartbeatEntries(peer.received).at(-1)
  assert.deepEqual(Object.keys(latest.parsed.packet), ['v', 'type', 'deviceId', 'anim'])
})
