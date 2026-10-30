import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import test from 'node:test'

import { createDiscovery } from '../src/discovery.js'
import { DEFAULT_PORT, PROTOCOL_VERSION, parsePacket } from '../src/protocol.js'
import { createRoom } from '../src/room.js'

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor (predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error('waitFor timeout')
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
  return socket
}

function inbox (socket) {
  const entries = []
  const waiters = []

  socket.on('message', (message, rinfo) => {
    const entry = { message, rinfo, parsed: parsePacket(message) }
    const at = waiters.findIndex((waiter) => waiter.predicate(entry))
    if (at >= 0) {
      const [waiter] = waiters.splice(at, 1)
      clearTimeout(waiter.timer)
      waiter.resolve(entry)
      return
    }
    entries.push(entry)
  })

  return {
    next (predicate, timeoutMs = 1500) {
      const at = entries.findIndex(predicate)
      if (at >= 0) return Promise.resolve(entries.splice(at, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null }
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('timeout waiting for UDP packet'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    }
  }
}

function beaconPayload (overrides = {}) {
  return Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'beacon',
    deviceId: randomUUID(),
    nickname: '隔壁',
    port: 40001,
    ...overrides
  }), 'utf8')
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

test('发现服务在回环上广播、记录邻居并单播回执；敌意包被丢弃', async (t) => {
  const peer = await loopbackPeer(t)
  const peerPort = peer.address().port
  const box = inbox(peer)
  const warnings = []
  const room = createRoom()
  const identity = { deviceId: randomUUID(), nickname: '甲' }

  const discovery = createDiscovery({
    identity,
    port: 0,
    targetPort: peerPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    onPeer: (packet) => room.observeBeacon(packet),
    log: { warn: (line) => warnings.push(line) }
  })
  t.after(() => discovery.dispose())

  await discovery.start()
  const myPort = discovery.address().port
  assert.ok(myPort > 0)
  assert.notEqual(myPort, DEFAULT_PORT)

  const initial = await box.next((entry) => entry.parsed.ok && entry.parsed.packet.type === 'beacon')
  assert.equal(initial.parsed.packet.deviceId, identity.deviceId)
  assert.equal(initial.parsed.packet.nickname, '甲')
  assert.equal(initial.parsed.packet.port, myPort)
  assert.deepEqual(Object.keys(JSON.parse(initial.message.toString('utf8'))), ['v', 'type', 'deviceId', 'nickname', 'port'])

  const neighborId = randomUUID()
  peer.send(beaconPayload({
    deviceId: neighborId,
    nickname: '乙',
    port: peerPort,
    path: '/tmp/evil',
    command: 'rm -rf /'
  }), myPort, '127.0.0.1')

  const ack = await box.next((entry) => entry.parsed.ok && entry.parsed.packet.type === 'beacon-ack')
  assert.equal(ack.parsed.packet.deviceId, identity.deviceId)
  assert.equal(ack.parsed.packet.nickname, '甲')
  assert.equal(ack.parsed.packet.port, myPort)

  await waitFor(() => room.snapshot().neighbors.length === 1)
  const neighbor = room.snapshot().neighbors[0]
  assert.equal(neighbor.deviceId, neighborId)
  assert.equal(neighbor.nickname, '乙')
  assert.equal(neighbor.status, 'pending')
  assert.equal(neighbor.port, peerPort)

  // 版本不匹配：不产生邻居，只记一条日志。
  peer.send(beaconPayload({ v: 2 }), myPort, '127.0.0.1')
  await delay(40)
  peer.send(beaconPayload({ v: 99 }), myPort, '127.0.0.1')
  await delay(60)
  assert.equal(room.snapshot().neighbors.length, 1)
  assert.equal(warnings.filter((line) => /协议版本/.test(line)).length, 1)

  // 超过 4 KiB：在解析前丢弃。
  peer.send(Buffer.alloc(5000, 0x61), myPort, '127.0.0.1')
  await delay(60)
  assert.equal(room.snapshot().neighbors.length, 1)

  // 自己的广播不产生邻居（也避免自回执循环）。
  peer.send(beaconPayload({ deviceId: identity.deviceId, nickname: '冒名' }), myPort, '127.0.0.1')
  await delay(60)
  assert.equal(room.snapshot().neighbors.length, 1)
})

test('两个发现实例在回环上互相看见，不需要知道对方地址', async (t) => {
  const portA = await freeUdpPort()
  const portB = await freeUdpPort()
  assert.notEqual(portA, portB)
  assert.notEqual(portA, DEFAULT_PORT)
  assert.notEqual(portB, DEFAULT_PORT)

  const roomA = createRoom()
  const roomB = createRoom()
  const identityA = { deviceId: randomUUID(), nickname: '甲' }
  const identityB = { deviceId: randomUUID(), nickname: '乙' }
  const discoveryA = createDiscovery({
    identity: identityA,
    port: portA,
    targetPort: portB,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    onPeer: (packet) => roomA.observeBeacon(packet),
    log: { warn () {} }
  })
  const discoveryB = createDiscovery({
    identity: identityB,
    port: portB,
    targetPort: portA,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    onPeer: (packet) => roomB.observeBeacon(packet),
    log: { warn () {} }
  })
  t.after(() => discoveryA.dispose())
  t.after(() => discoveryB.dispose())

  await discoveryA.start()
  await discoveryB.start()
  // A 的首包在 B 绑定前发出，可能丢失；B 起来后手动补一发，模拟下一次 5 秒广播。
  discoveryA.sendBeacon()

  await waitFor(() => roomA.snapshot().neighbors.length === 1 && roomB.snapshot().neighbors.length === 1)
  assert.equal(roomA.snapshot().neighbors[0].deviceId, identityB.deviceId)
  assert.equal(roomA.snapshot().neighbors[0].nickname, '乙')
  assert.equal(roomB.snapshot().neighbors[0].deviceId, identityA.deviceId)
  assert.equal(roomB.snapshot().neighbors[0].nickname, '甲')
  assert.equal(roomA.snapshot().neighbors[0].status, 'pending')
  assert.equal(roomB.snapshot().neighbors[0].status, 'pending')
})

test('同一个来源在回执窗口内只回执一次，但邻居仍会刷新', async (t) => {
  const peer = await loopbackPeer(t)
  const peerPort = peer.address().port
  const box = inbox(peer)
  const room = createRoom()
  const identity = { deviceId: randomUUID(), nickname: '甲' }
  const discovery = createDiscovery({
    identity,
    port: 0,
    targetPort: peerPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    onPeer: (packet) => room.observeBeacon(packet),
    log: { warn () {} }
  })
  t.after(() => discovery.dispose())
  await discovery.start()
  const myPort = discovery.address().port
  await box.next((entry) => entry.parsed.ok && entry.parsed.packet.type === 'beacon')

  const neighborId = randomUUID()
  peer.send(beaconPayload({ deviceId: neighborId }), myPort, '127.0.0.1')
  await box.next((entry) => entry.parsed.ok && entry.parsed.packet.type === 'beacon-ack')
  await waitFor(() => room.snapshot().neighbors.length === 1)
  const firstSeen = room.snapshot().neighbors[0].lastSeen

  await delay(20)
  peer.send(beaconPayload({ deviceId: neighborId, nickname: '乙改名' }), myPort, '127.0.0.1')
  await assert.rejects(
    box.next((entry) => entry.parsed.ok && entry.parsed.packet.type === 'beacon-ack', 150),
    /timeout/
  )
  await waitFor(() => room.snapshot().neighbors[0].nickname === '乙改名')
  assert.ok(room.snapshot().neighbors[0].lastSeen >= firstSeen)
})
