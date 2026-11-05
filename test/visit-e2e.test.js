import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PROTOCOL_VERSION, parsePacket } from '../src/protocol.js'
import { createService } from '../src/service.js'
import { VISITS_FILE } from '../src/visits.js'

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor (predicate, timeoutMs = 3000) {
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-visit-e2e-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
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

function visitEntries (received, type = 'visit-request') {
  return received.filter((entry) => entry.parsed.ok && entry.parsed.packet.type === type)
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

function visitRequestPayload ({ deviceId, visitId, nickname, anim = null }) {
  return Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'visit-request',
    deviceId,
    visitId,
    nickname,
    anim
  }), 'utf8')
}

function recallAckPayload ({ deviceId, visitId }) {
  return Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'visit-recall-ack',
    deviceId,
    visitId
  }), 'utf8')
}

/**
 * 单向 UDP 中继：原样转发到 targetPort，但吞掉前 `dropCount` 包 `dropType`。
 * 两个真服务之间没有别的注入口，用它才能在回环上真实地模拟“这一包丢了”。
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

async function readVisits (dir) {
  return JSON.parse(await readFile(join(dir, VISITS_FILE), 'utf8'))
}

async function waitForVisits (dir, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const raw = await readVisits(dir)
      if (predicate(raw)) return raw
    } catch {
      // 文件还没写出来 / 正写到一半：下一轮再读
    }
    await delay(15)
  }
  throw new Error('waitForVisits timeout')
}

function twoInstanceOptions (dir, port, targetPort, overrides = {}) {
  return {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    petBridge: false,
    port,
    targetPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 5000,
    heartbeatIntervalMs: 60000,
    visitMaxMs: 600,
    visitRetryMs: 50,
    visitTimeoutMs: 2000,
    visitTickMs: 20,
    tickIntervalMs: 50,
    ...overrides
  }
}

test('串门请求重试三次仍无 ack：明确超时、宠物留在家里、没有假记录', async (t) => {
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
    heartbeatIntervalMs: 60000,
    visitRetryMs: 40,
    visitTimeoutMs: 400,
    visitTickMs: 10,
    tickIntervalMs: 50
  })
  await service.ready

  // 一台“收得到但从不回应”的邻居：先让它被看见并放行。
  const deviceId = randomUUID()
  peer.socket.send(
    beaconPayload({ deviceId, nickname: '沉默的邻居', port: peerPort }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().neighbors.length === 1)
  const admitted = await callAction(service, { action: 'admit', deviceId })
  assert.equal(admitted.status, 200)

  const started = await callAction(service, { action: 'visit', deviceId })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.phase, 'requesting')
  const visitId = started.body.visitId
  assert.equal(typeof visitId, 'string')
  assert.equal(service.snapshot().self.out.phase, 'requesting')

  await waitFor(() => service.snapshot().notices.some((notice) => /没有回应/.test(notice.text)))
  assert.equal(service.snapshot().self.out, null)
  assert.deepEqual(service.snapshot().visits, [])

  // 首次 + 两次重试，一共三包；同一 visitId，白名单字段，无坐标。
  const requests = visitEntries(peer.received)
  assert.equal(requests.length, 3)
  for (const entry of requests) {
    const packet = entry.parsed.packet
    assert.equal(packet.visitId, visitId)
    assert.equal(packet.deviceId, service.snapshot().self.deviceId)
    assert.equal(packet.nickname, service.snapshot().self.nickname)
    assert.equal(packet.anim, null)
    assert.deepEqual(Object.keys(packet), ['v', 'type', 'deviceId', 'visitId', 'nickname', 'anim'])
    assert.doesNotMatch(entry.message.toString('utf8'), /"(x|y|pos|position|coordinates?|coord)"\s*:/)
  }
})

test('对方离线：不卡住、不写记录，直接给一句可读的 peer-offline', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false
  })
  await service.ready

  // 放行名单里有，但发现层从没见过它的地址：sendTo 会拒绝。
  const deviceId = randomUUID()
  const now = Date.now()
  service.room.observeBeacon({ deviceId, nickname: '掉线的邻居', port: 40001 }, now)
  service.room.admit(deviceId)

  const started = await callAction(service, { action: 'visit', deviceId })
  assert.equal(started.status, 409)
  assert.equal(started.body.error, 'peer-offline')
  assert.equal(service.snapshot().self.out, null)
  assert.match(service.snapshot().notices[0].text, /好像不在线/)
  assert.deepEqual(service.snapshot().visits, [])
})

test('两个实例：未双向放行时得到明确 deny；放行后串门成功，召回与到期都各留一条记录', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const [portA, portB] = await distinctPorts(2)

  const b = makeService(t, twoInstanceOptions(dirB, portB, portA))
  await b.ready
  const a = makeService(t, twoInstanceOptions(dirA, portA, portB))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal(a.snapshot().neighbors[0].deviceId, bId)
  assert.equal(b.snapshot().neighbors[0].deviceId, aId)

  // 不同的可读昵称，方便核对记录里的“谁”。
  assert.equal((await callAction(a, { action: 'rename', nickname: '甲' })).status, 200)
  assert.equal((await callAction(b, { action: 'rename', nickname: '乙' })).status, 200)
  assert.equal(a.snapshot().self.nickname, '甲')
  assert.equal(b.snapshot().self.nickname, '乙')

  // 只有 A 放行 B：A 发请求，B 回 deny，A 得到“对方没有放行你”。
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  const denied = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(denied.status, 200)
  await waitFor(() => a.snapshot().notices.some((notice) => /没有放行你/.test(notice.text)))
  assert.equal(a.snapshot().self.out, null)
  assert.deepEqual(a.snapshot().visits, [])
  assert.deepEqual(b.snapshot().visitors, [])
  assert.deepEqual(b.snapshot().visits, [])

  // 双向放行：A 出门 → B 桌面出现一位常驻访客。
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)
  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  const firstVisitId = started.body.visitId
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)

  assert.equal(a.snapshot().self.out.nickname, '乙')
  assert.equal(a.snapshot().self.out.visitId, firstVisitId)
  assert.equal(b.snapshot().visitors[0].deviceId, aId)
  assert.equal(b.snapshot().visitors[0].nickname, '甲')
  assert.equal(b.snapshot().visitors[0].visitId, firstVisitId)
  // ticket 10：入站访客没有 TTL，endsAt 固定为 null。
  assert.equal(b.snapshot().visitors[0].endsAt, null)
  // 地址与坐标都不进快照。
  for (const snap of [a.snapshot(), b.snapshot()]) {
    const text = JSON.stringify(snap)
    assert.equal(text.includes('127.0.0.1'), false)
    assert.equal(text.includes('"coordinates"'), false)
  }

  // A 提前召回：双方立即清场，各写一条记录。
  assert.equal((await callAction(a, { action: 'recall' })).status, 200)
  await waitFor(() => a.snapshot().self.out === null && b.snapshot().visitors.length === 0)
  await waitFor(() => a.snapshot().visits.length === 1 && b.snapshot().visits.length === 1)
  assert.equal(a.snapshot().visits[0].direction, 'out')
  assert.equal(a.snapshot().visits[0].nickname, '乙')
  assert.equal(b.snapshot().visits[0].direction, 'in')
  assert.equal(b.snapshot().visits[0].nickname, '甲')
  assert.ok(a.snapshot().visits[0].durationMs >= 0)

  // 第二次串门：不发 recall，让 A 的 30 分钟上限（测试里 600ms）到点；
  // A 到点会发 recall，B 收到后清场——B 自己不再有 TTL。
  const second = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(second.status, 200)
  const secondVisitId = second.body.visitId
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)
  assert.equal(b.snapshot().visitors[0].visitId, secondVisitId)

  await waitFor(
    () => a.snapshot().self.out === null && b.snapshot().visitors.length === 0,
    4000
  )
  await waitFor(() => a.snapshot().visits.length === 2 && b.snapshot().visits.length === 2)
  // 最新在前，第二次的开始时间晚于第一次。
  assert.ok(a.snapshot().visits[0].startedAt >= a.snapshot().visits[1].startedAt)
  assert.ok(b.snapshot().visits[0].startedAt >= b.snapshot().visits[1].startedAt)

  // 落盘：双方各两份，方向相反；重启后读得回来。
  const rawA = await waitForVisits(dirA, (raw) => raw.visits.length === 2)
  const rawB = await waitForVisits(dirB, (raw) => raw.visits.length === 2)
  assert.deepEqual(rawA.visits.map((record) => record.direction), ['out', 'out'])
  assert.deepEqual(rawB.visits.map((record) => record.direction), ['in', 'in'])
  assert.deepEqual(rawA.visits.map((record) => record.nickname), ['乙', '乙'])
  assert.deepEqual(rawB.visits.map((record) => record.nickname), ['甲', '甲'])
  for (const record of [...rawA.visits, ...rawB.visits]) {
    assert.deepEqual(Object.keys(record), ['direction', 'nickname', 'startedAt', 'durationMs'])
  }

  b.dispose()
  const bReloaded = makeService(t, {
    dataDir: dirB,
    petConfigPath: join(dirB, 'missing.jsonc'),
    network: false
  })
  await bReloaded.ready
  assert.deepEqual(
    bReloaded.snapshot().visits.map((record) => [record.direction, record.nickname]),
    [['in', '甲'], ['in', '甲']]
  )
})

test('接收方提前结束：发 recall，发起方立即回家，双方各留一条记录', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const [portA, portB] = await distinctPorts(2)
  const b = makeService(t, twoInstanceOptions(dirB, portB, portA))
  await b.ready
  const a = makeService(t, twoInstanceOptions(dirA, portA, portB))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)

  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)

  // B 是接收方，也能提前结束这次串门。
  assert.equal((await callAction(b, { action: 'end-visit', deviceId: aId })).status, 200)
  await waitFor(() => b.snapshot().visitors.length === 0 && a.snapshot().self.out === null)
  await waitFor(() => b.snapshot().visits.length === 1 && a.snapshot().visits.length === 1)

  assert.equal(b.snapshot().visits[0].direction, 'in')
  assert.equal(a.snapshot().visits[0].direction, 'out')
  assert.match(a.snapshot().notices[0].text, /结束了这次串门/)
})

test('接收方关掉串门：请求被 visits-off 拒绝，发起方看到明确原因，重新打开后又能进', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const [portA, portB] = await distinctPorts(2)
  const b = makeService(t, twoInstanceOptions(dirB, portB, portA))
  await b.ready
  const a = makeService(t, twoInstanceOptions(dirA, portA, portB))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)

  // B 一键关掉串门；邻居与心跳都还在，只有入站串门被拒。
  const off = await callAction(b, { action: 'accept-visits', enabled: false })
  assert.equal(off.status, 200)
  assert.equal(off.body.acceptVisits, false)
  assert.equal(b.snapshot().acceptVisits, false)
  assert.equal(a.snapshot().neighbors.length, 1)

  const denied = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(denied.status, 200)
  await waitFor(() => a.snapshot().notices.some((notice) => /关掉了串门/.test(notice.text)))
  assert.equal(a.snapshot().self.out, null)
  assert.deepEqual(a.snapshot().visits, [])
  assert.deepEqual(b.snapshot().visitors, [])
  assert.deepEqual(b.snapshot().visits, [])
  assert.doesNotMatch(a.snapshot().notices[0].text, /没有放行你/)

  // 重新打开后，同一个邻居可以正常进门。
  assert.equal((await callAction(b, { action: 'accept-visits', enabled: true })).status, 200)
  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)
  assert.equal(b.snapshot().visitors[0].deviceId, aId)
})

test('visits.json 损坏时串门仍然成功；记录只丢历史，不影响客厅', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const [portA, portB] = await distinctPorts(2)
  await writeFile(join(dirA, VISITS_FILE), '{ broken', 'utf8')

  const b = makeService(t, twoInstanceOptions(dirB, portB, portA))
  await b.ready
  const a = makeService(t, twoInstanceOptions(dirA, portA, portB))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)
  assert.deepEqual(a.snapshot().visits, [])

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)

  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)
  assert.equal((await callAction(a, { action: 'recall' })).status, 200)
  await waitFor(() => a.snapshot().visits.length === 1 && b.snapshot().visits.length === 1)

  // A 的记录文件会在下一次 flush 后变成合法文件，B 的一直正常。
  const rawA = await waitForVisits(dirA, (raw) => raw.visits.length === 1)
  assert.equal(rawA.visits[0].direction, 'out')
})

test('自动出门：没活动绝不出门；有活动且开关打开才出发；送客后双方各留一条真实时长记录', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const [portA, portB] = await distinctPorts(2)

  const b = makeService(t, twoInstanceOptions(dirB, portB, portA))
  await b.ready
  const a = makeService(t, twoInstanceOptions(dirA, portA, portB, {
    autoVisitIntervalMs: 30,
    // 给自动串门留足往返时间，别让 600ms 的测试上限抢在断言前到点。
    visitMaxMs: 5000
  }))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)
  // 互相放行之后，B 会立刻补发心跳；A 收到心跳才知道“对方也放行了我”，
  // 这正是自动/手动串门的目标条件。
  await waitFor(() => a.snapshot().visitTargets.length === 1)

  // 打开总开关，但本机没有任何活动：策略每 30ms 跑一次，仍然绝不出发。
  const on = await callAction(a, { action: 'auto-visits', enabled: true })
  assert.equal(on.status, 200)
  assert.equal(on.body.autoVisits, true)
  await delay(150)
  assert.equal(a.snapshot().self.out, null)
  assert.equal(b.snapshot().visitors.length, 0)
  assert.equal(a.snapshot().autoVisit.lastDecision.reason, 'no-activity')

  // 有活动之后，同一条策略允许出发；B 的桌面出现 A 的宠物（常驻访客）。
  a.room.noteActivity('session', Date.now())
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)
  assert.equal(b.snapshot().visitors[0].deviceId, aId)
  assert.equal(b.snapshot().visitors[0].nickname, a.snapshot().self.nickname)
  assert.equal(b.snapshot().visitors[0].endsAt, null)
  assert.ok(['ready', 'already-out'].includes(a.snapshot().autoVisit.lastDecision.reason))

  // 主人点「送客」：B 立即清场并写 in 记录；A 收到 recall 回家并写 out 记录。
  const startedAt = Date.now()
  assert.equal((await callAction(b, { action: 'end-visit', deviceId: aId })).status, 200)
  await waitFor(() => b.snapshot().visitors.length === 0 && a.snapshot().self.out === null)
  await waitFor(() => b.snapshot().visits.length === 1 && a.snapshot().visits.length === 1)
  assert.equal(b.snapshot().visits[0].direction, 'in')
  assert.equal(b.snapshot().visits[0].nickname, a.snapshot().self.nickname)
  assert.equal(a.snapshot().visits[0].direction, 'out')
  assert.equal(a.snapshot().visits[0].nickname, b.snapshot().self.nickname)
  for (const record of [a.snapshot().visits[0], b.snapshot().visits[0]]) {
    assert.ok(record.durationMs >= 0)
    assert.ok(record.durationMs < 30 * 60 * 1000 + 1)
  }
  assert.ok(Date.now() - startedAt < 5000)

  // 手动「串门」永远可用（不受自动开关/活动窗口影响），不带 deviceId 也能量：
  // 随机挑到唯一在线的邻居 B。
  const manual = await callAction(a, { action: 'visit' })
  assert.equal(manual.status, 200)
  assert.equal(manual.body.deviceId, bId)
  await waitFor(() => b.snapshot().visitors.length === 1)
  assert.equal((await callAction(a, { action: 'recall' })).status, 200)
  await waitFor(() => b.snapshot().visitors.length === 0 && a.snapshot().self.out === null)

  // 自动开关落盘：重启后仍然是开。
  const rawSettings = JSON.parse(await readFile(join(dirA, 'settings.json'), 'utf8'))
  assert.equal(rawSettings.autoVisits, true)
})

test('对方失联（出门方向）：2 分钟窗口（测试里 300ms）没有心跳 → 回家、写 out、提示失联', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const [portA, portB] = await distinctPorts(2)
  const b = makeService(t, twoInstanceOptions(dirB, portB, portA))
  await b.ready
  const a = makeService(t, twoInstanceOptions(dirA, portA, portB, {
    peerLostMs: 300,
    tickIntervalMs: 30,
    visitMaxMs: 5000
  }))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)
  await waitFor(() => a.snapshot().visitTargets.length === 1)

  assert.equal((await callAction(a, { action: 'visit' })).status, 200)
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)

  // 对面整个进程消失：没有 recall，也没有心跳。A 必须自己回家并留下失联记录。
  b.dispose()
  await waitFor(() => a.snapshot().self.out === null, 3000)
  await waitFor(() => a.snapshot().visits.length === 1)
  assert.equal(a.snapshot().visits[0].direction, 'out')
  assert.equal(a.snapshot().visits[0].nickname, b.snapshot().self.nickname)
  assert.match(a.snapshot().notices[0].text, /失联/)
})

test('对方失联（入站方向）：2 分钟窗口（测试里 300ms）没有心跳 → 客人消失、写 in、提示失联', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const [portA, portB] = await distinctPorts(2)
  const b = makeService(t, twoInstanceOptions(dirB, portB, portA, {
    peerLostMs: 300,
    tickIntervalMs: 30,
    visitMaxMs: 5000
  }))
  await b.ready
  const a = makeService(t, twoInstanceOptions(dirA, portA, portB))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)
  await waitFor(() => a.snapshot().visitTargets.length === 1)

  assert.equal((await callAction(a, { action: 'visit' })).status, 200)
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)

  // 来访者进程消失：B 没有收到 recall，只能靠心跳停掉自己清理。
  a.dispose()
  await waitFor(() => b.snapshot().visitors.length === 0, 3000)
  await waitFor(() => b.snapshot().visits.length === 1)
  assert.equal(b.snapshot().visits[0].direction, 'in')
  assert.match(b.snapshot().notices[0].text, /失联/)

  // B 的自动重访不会发生：B 没有打开总开关（默认关）。
  await delay(150)
  assert.equal(b.snapshot().self.out, null)
})

test('送客的 recall 有界重试：丢第一包也会补发，收到 visit-recall-ack 立刻收手（A1）', async (t) => {
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
    heartbeatIntervalMs: 60000,
    recallRetryMs: 120,
    recallTimeoutMs: 2000,
    visitTickMs: 10,
    tickIntervalMs: 50
  })
  await service.ready

  // 一台真的会串门的邻居（裸 socket，能精确控制“哪一包当它丢了”）。
  const deviceId = randomUUID()
  peer.socket.send(
    beaconPayload({ deviceId, nickname: '隔壁', port: peerPort }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().neighbors.length === 1)
  assert.equal((await callAction(service, { action: 'admit', deviceId })).status, 200)

  const visitId = randomUUID()
  peer.socket.send(
    visitRequestPayload({ deviceId, visitId, nickname: '隔壁' }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().visitors.length === 1)
  assert.equal(visitEntries(peer.received, 'visit-ack').length, 1)

  // 送客：第一包 recall 当作丢了（peer 不回执、也不清场）。
  assert.equal((await callAction(service, { action: 'end-visit', deviceId })).status, 200)
  assert.deepEqual(service.snapshot().visitors, [])
  await waitFor(() => visitEntries(peer.received, 'visit-recall').length >= 2, 2000)
  const recalls = visitEntries(peer.received, 'visit-recall')
  assert.equal(recalls[0].parsed.packet.visitId, visitId)
  assert.equal(recalls[1].parsed.packet.visitId, visitId, '重发携带同一个 visitId（对方幂等清场）')
  for (const entry of recalls) {
    assert.equal(entry.parsed.packet.deviceId, service.snapshot().self.deviceId)
    assert.deepEqual(Object.keys(entry.parsed.packet), ['v', 'type', 'deviceId', 'visitId'])
  }

  // 对方回执：不再有第三包。
  peer.socket.send(recallAckPayload({ deviceId, visitId }), servicePort, '127.0.0.1')
  await delay(400)
  assert.equal(visitEntries(peer.received, 'visit-recall').length, 2, '收到回执后停止重试')

  // 重发是幂等的：本机只有一条 in 记录，且没有被重复请求/重发改写。
  assert.deepEqual(service.snapshot().visits.map((record) => record.direction), ['in'])
  assert.equal(service.snapshot().visits[0].durationMs >= 0, true)
})

test('送客的 recall 丢第一包：重发到达后对方立刻回家，记录不是 30 分钟上限（A1）', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const [portA, portB] = await distinctPorts(2)

  // A 是出门的一方。它的广告端口指向中继：B 发来的 recall 第一包会被吞掉。
  const relay = await lossyRelay(t, portA, { dropType: 'visit-recall' })
  const a = makeService(t, twoInstanceOptions(dirA, portA, portB, {
    servicePort: relay.port,
    visitMaxMs: 60000,
    recallRetryMs: 60
  }))
  await a.ready
  const b = makeService(t, twoInstanceOptions(dirB, portB, portA, { visitMaxMs: 60000 }))
  await b.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)

  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  await waitFor(() => a.snapshot().self.out?.phase === 'active' && b.snapshot().visitors.length === 1)
  const startedAt = a.snapshot().self.out.startedAt

  // B 送客：第一包 recall 真的丢了。没有重试时 A 要挂到自己的 30 分钟上限。
  assert.equal((await callAction(b, { action: 'end-visit', deviceId: aId })).status, 200)
  assert.deepEqual(b.snapshot().visitors, [])
  await waitFor(() => a.snapshot().self.out === null, 3000)
  assert.equal(relay.dropped(), 1, '中继确实吞掉了第一包 visit-recall')

  // A 的记录是真实停留时长（几十 ms），不是 60s 的出门上限。
  const record = a.snapshot().visits[0]
  assert.equal(record.direction, 'out')
  assert.ok(record.durationMs < 5000,
    'recall 到达后立刻回家（' + record.durationMs + 'ms），不是等到上限')
  assert.ok(record.durationMs <= Date.now() - startedAt)
  await waitFor(() => b.snapshot().visits.length === 1)
  assert.equal(b.snapshot().visits[0].direction, 'in')
})

/**
 * 现场反馈（2026-11-05）：我改了皮肤再串门，别人那里不变；改了皮肤后动作也不跟着换。
 *
 * 这条走完整的跨机链路：A 的素材源 → B 的 skin-fetch 落缓存 → B 的桌面场景。
 * 断言的是**访客在别人桌面上真的用自己的素材**（src），并且在 A 换皮后跟着换。
 */
test('访客换皮：邻居桌面拿到的是访客自己的素材，换皮后 src 立刻跟着换', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-zoo-skin-visit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fishDir = join(root, 'fish')
  const catDir = join(root, 'cat')
  const dirA = join(root, 'a')
  const dirB = join(root, 'b')
  for (const dir of [fishDir, catDir, dirA, dirB]) await mkdir(dir, { recursive: true })

  // 两张皮的待机动作名不同：dsh-pet 的「待机呼吸休闲」和 maodie 的「待机」。
  const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
  const fishBytes = Buffer.concat([EBML, Buffer.from('fish-idle')])
  const catBytes = Buffer.concat([EBML, Buffer.from('cat-idle')])
  await writeFile(join(fishDir, '待机呼吸休闲.webm'), fishBytes)
  await writeFile(join(catDir, '待机.webm'), catBytes)
  await writeFile(join(dirA, 'skin.json'), JSON.stringify({
    sources: [
      { id: 'fish', dirs: [fishDir], size: 462 },
      { id: 'cat', dirs: [catDir], size: 462, idle: '待机' }
    ]
  }))
  const urlOf = (bytes) => 'dshzoo://cache/' + createHash('sha256').update(bytes).digest('hex') + '.webm'
  const fishUrl = urlOf(fishBytes)
  const catUrl = urlOf(catBytes)

  // 两台机器都不去碰开发机上真实装没装 dsh-pet 的目录。
  const env = { ...process.env, DSH_ZOO_DSH_PET_ASSETS: fishDir }
  const [portA, portB] = await distinctPorts(2)

  const bScenes = []
  let bDesktop = null
  const b = makeService(t, twoInstanceOptions(dirB, portB, portA, {
    env,
    heartbeatIntervalMs: 100,
    beaconIntervalMs: 500,
    desktopSyncMs: 20,
    desktopFactory (options) {
      bDesktop = options
      return {
        start () { return { ok: true, pid: 7001 } },
        update (scene) { bScenes.push(scene); return true },
        resync (scene) { bScenes.push(scene); return true },
        actionResult () {},
        dispose () {}
      }
    }
  }))
  await b.ready
  assert.ok(bDesktop, 'B 的桌面层应该拿到工厂参数')
  bDesktop.onEvent({ type: 'ready', pid: 7001, workArea: { x: 0, y: 30, width: 1000, height: 700 } })

  const a = makeService(t, twoInstanceOptions(dirA, portA, portB, {
    env,
    heartbeatIntervalMs: 100,
    beaconIntervalMs: 500,
    // 这条用例要在一次串门里完成“到达 → 换皮 → 邻居重取”，不能撞上 600ms 的到期。
    visitMaxMs: 60000,
    skinServer: true,
    skinPort: 0
  }))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1, 5000)

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)
  assert.equal((await callAction(a, { action: 'visit', deviceId: bId })).status, 200)

  const visitorItem = () => bScenes.at(-1)?.items.find((item) => item.role === 'visitor')
  await waitFor(() => b.snapshot().visitors.length === 1, 3000)
  await waitFor(() => visitorItem()?.src === fishUrl, 3000)

  // A 换皮：同一只宠物、同一次串门，只换外观和动作。
  const switched = await callAction(a, { action: 'use-skin', skinId: 'cat' })
  assert.equal(switched.status, 200)
  assert.equal(switched.body.skin, 'cat')
  assert.equal(a.snapshot().skin.id, 'cat')

  // 60 秒节流不能成为“别人那里不更新”的理由：心跳一来就该按新 skinId 重取。
  await waitFor(() => visitorItem()?.src === catUrl, 3000)
  assert.equal(visitorItem().label, b.snapshot().visitors[0].nickname)
  // 名字、身份、这次串门都没被换皮影响（ADR-0013）。
  assert.equal(b.snapshot().visitors[0].deviceId, aId)
})
