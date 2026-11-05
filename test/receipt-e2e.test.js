/**
 * 票 26：送达回执与退包，端到端。
 *
 * 真 socket、真协议、真磁盘，覆盖 SPEC v4「礼物（wire）」的那条规则：
 * **送达以对方回执为准**。
 *   - 回执正常到达：接收方真写进 gifts/ 才回执；发起方删掉背包那件并说「收下了」；
 *     重复回执（重发三包）幂等，不重复删、不重复提示。
 *   - 回执丢失：串门结束还没收到 → 东西退回 idle + 一句「没送到」。
 *   - 旧端永不回执：到点由 tick 结束，同样退包。
 *   - 串门被拒：背包里不会留下 out 件（东西回到 idle）。
 *   - 送客提醒：meta.opened === false 才提醒；打开过就不再说。
 *   - onPeer 路由：`gift-received` 必须有自己的分支，不能落到 observeBeacon 兜底。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BACKPACK_FILE } from '../src/backpack.js'
import { GIFTS_DIR, META_FILE } from '../src/gifts.js'
import { PROTOCOL_VERSION, parsePacket } from '../src/protocol.js'
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-receipt-e2e-'))
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
  socket.on('message', (message) => {
    received.push({ message, parsed: parsePacket(message) })
  })
  return { socket, received }
}

function packetsOf (peer, type) {
  return peer.received.filter((entry) => entry.parsed.ok && entry.parsed.packet.type === type)
    .map((entry) => entry.parsed.packet)
}

function packetPayload (value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function beaconPayload ({ deviceId, nickname, port }) {
  return packetPayload({ v: PROTOCOL_VERSION, type: 'beacon', deviceId, nickname, port })
}

function visitRequestPayload ({ deviceId, visitId, nickname, gift }) {
  return packetPayload({
    v: PROTOCOL_VERSION,
    type: 'visit-request',
    deviceId,
    visitId,
    nickname,
    anim: null,
    ...(gift === undefined ? {} : { gift })
  })
}

function visitAckPayload ({ deviceId, visitId }) {
  return packetPayload({ v: PROTOCOL_VERSION, type: 'visit-ack', deviceId, visitId })
}

function visitDenyPayload ({ deviceId, visitId, reason = 'not-admitted' }) {
  return packetPayload({ v: PROTOCOL_VERSION, type: 'visit-deny', deviceId, visitId, reason })
}

function visitRecallPayload ({ deviceId, visitId }) {
  return packetPayload({ v: PROTOCOL_VERSION, type: 'visit-recall', deviceId, visitId })
}

/** 故意带上 beacon 的字段：解析层必须把它们丢掉，onPeer 也不能把它当 beacon。 */
function giftReceivedPayload ({ deviceId, visitId, giftId, nickname, port }) {
  return packetPayload({
    v: PROTOCOL_VERSION,
    type: 'gift-received',
    deviceId,
    visitId,
    giftId,
    ...(nickname === undefined ? {} : { nickname }),
    ...(port === undefined ? {} : { port })
  })
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

async function readBackpack (dir) {
  return JSON.parse(await readFile(join(dir, BACKPACK_FILE), 'utf8'))
}

async function giftDirs (dir) {
  return readdir(join(dir, GIFTS_DIR)).catch(() => [])
}

/**
 * 一个被放行的回环假邻居：只收包、不自动回执。
 * 回执相关计时器调快（30ms / 90ms = 三次），测试不用等 800ms。
 */
async function admittedPeer (t, dir, options = {}) {
  const peer = await loopbackPeer(t)
  const peerPort = peer.socket.address().port
  const servicePort = await freeUdpPort()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    desktop: false,
    port: servicePort,
    targetPort: peerPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 60000,
    visitRetryMs: 50,
    visitTimeoutMs: 3000,
    visitTickMs: 20,
    tickIntervalMs: 30,
    receiptRetryMs: 30,
    receiptTimeoutMs: 90,
    ...options
  })
  await service.ready
  const deviceId = randomUUID()
  peer.socket.send(
    beaconPayload({ deviceId, nickname: '隔壁同事', port: peerPort }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().neighbors.length === 1)
  assert.equal((await callAction(service, { action: 'admit', deviceId })).status, 200)
  return { service, peer, deviceId, servicePort }
}

function twoInstanceOptions (dir, port, targetPort, overrides = {}) {
  return {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    desktop: false,
    port,
    targetPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 5000,
    heartbeatIntervalMs: 60000,
    visitMaxMs: 5000,
    visitRetryMs: 50,
    visitTimeoutMs: 2000,
    visitTickMs: 20,
    tickIntervalMs: 30,
    receiptRetryMs: 30,
    receiptTimeoutMs: 90,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1) 回执正常到达 + 重复回执幂等
// ---------------------------------------------------------------------------

test('回执到达：接收方写盘后回执，发起方删件并说「收下了」；重复回执不再删、不再提示', async (t) => {
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

  const added = await callAction(a, { action: 'bring', kind: 'text', text: '到了就回一声' })
  assert.equal(added.body.ok, true)
  const giftId = added.body.giftId

  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  assert.equal(started.body.giftId, giftId)
  const visitId = started.body.visitId

  // 接收方：真写进了 gifts/，卡片才从 pending 变 received。
  await waitFor(() => b.snapshot().visitors[0]?.gift?.status === 'received')
  assert.deepEqual((await giftDirs(dirB)).length, 1)
  // 发起方：收到回执才删件——磁盘上那件真的没了，而不是退回 idle。
  await waitFor(async () => (await readBackpack(dirA)).items.length === 0)
  await waitFor(() => a.snapshot().notices.some((notice) => /收下了/.test(notice.text)))

  const delivered = a.snapshot().notices.filter((notice) => /收下了/.test(notice.text))
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].text, /^「.+」收下了。$/)
  // 回执只表示“东西收下了”，不该顺手结束串门。
  assert.equal(a.snapshot().self.out?.phase, 'active')
  assert.equal(a.snapshot().notices.some((notice) => /没送到/.test(notice.text)), false)

  // 重发/晚到的同一条回执：直接丢掉（不重复删、不重复提示）。
  const extra = await loopbackPeer(t)
  extra.socket.send(
    giftReceivedPayload({ deviceId: bId, visitId, giftId }),
    portA,
    '127.0.0.1'
  )
  await delay(250)
  assert.equal(a.snapshot().notices.filter((notice) => /收下了/.test(notice.text)).length, 1)
  assert.deepEqual((await readBackpack(dirA)).items, [])
})

// ---------------------------------------------------------------------------
// 2) 回执丢失：串门结束仍没回执 → 退回背包 + 一句人话
// ---------------------------------------------------------------------------

test('回执丢失：串门结束还没收到回执 → 退包到 idle，并说「没送到」', async (t) => {
  const dir = await tempDir(t)
  const { service, peer, deviceId, servicePort } = await admittedPeer(t, dir)

  const added = await callAction(service, { action: 'bring', kind: 'text', text: '可能丢了' })
  const started = await callAction(service, { action: 'visit', deviceId })
  assert.equal(started.body.giftId, added.body.giftId)

  await waitFor(() => packetsOf(peer, 'visit-request').length >= 1)
  const request = packetsOf(peer, 'visit-request')[0]
  assert.equal(request.gift.id, added.body.giftId)

  // 对方收到了请求（ack 到了），但回执一直没来。
  peer.socket.send(visitAckPayload({ deviceId, visitId: request.visitId }), servicePort, '127.0.0.1')
  await waitFor(() => service.snapshot().self.out?.phase === 'active')
  assert.equal((await readBackpack(dir)).items[0].state, 'out')

  // 对方结束这次串门（回家/送客都行）：本地结束点必须把 out 件退回 idle。
  peer.socket.send(visitRecallPayload({ deviceId, visitId: request.visitId }), servicePort, '127.0.0.1')
  await waitFor(() => service.snapshot().self.out === null)
  await waitFor(async () => (await readBackpack(dir)).items[0]?.state === 'idle')

  const raw = await readBackpack(dir)
  assert.equal(raw.items[0].id, added.body.giftId)
  assert.equal(raw.items[0].state, 'idle')
  assert.equal('visitId' in raw.items[0], false)
  assert.ok(service.snapshot().notices.some((notice) => /没送到/.test(notice.text)))
  // 没收到回执就绝不能说「收下了」。
  assert.equal(service.snapshot().notices.some((notice) => /收下了/.test(notice.text)), false)
})

// ---------------------------------------------------------------------------
// 3) 旧端永不回执：到点由 tick 结束，同样退包
// ---------------------------------------------------------------------------

test('旧端永不回执：出门上限到点后由 tick 结束，礼物退回 idle 并提示', async (t) => {
  const dir = await tempDir(t)
  const { service, peer, deviceId, servicePort } = await admittedPeer(t, dir, {
    visitMaxMs: 200,
    tickIntervalMs: 20
  })

  const added = await callAction(service, { action: 'bring', kind: 'text', text: '旧版本不会回执' })
  await callAction(service, { action: 'visit', deviceId })

  await waitFor(() => packetsOf(peer, 'visit-request').length >= 1)
  const request = packetsOf(peer, 'visit-request')[0]
  // ack 到了 = 串门成立；对方是旧版本，永远不会发 gift-received。
  peer.socket.send(visitAckPayload({ deviceId, visitId: request.visitId }), servicePort, '127.0.0.1')
  await waitFor(() => service.snapshot().self.out?.phase === 'active')

  // 200ms 上限到点：tick 走 finishOutbound → flush → 退包。
  await waitFor(() => service.snapshot().self.out === null)
  await waitFor(async () => (await readBackpack(dir)).items[0]?.state === 'idle')
  assert.equal((await readBackpack(dir)).items[0].id, added.body.giftId)
  assert.ok(service.snapshot().notices.some((notice) => /没送到/.test(notice.text)))
})

// ---------------------------------------------------------------------------
// 4) 串门被拒：背包里不会留下 out 件
// ---------------------------------------------------------------------------

test('串门被拒：礼物退回 idle，背包里没有 out 件，也不会一直等回执', async (t) => {
  const dir = await tempDir(t)
  const { service, peer, deviceId, servicePort } = await admittedPeer(t, dir)

  const added = await callAction(service, { action: 'bring', kind: 'text', text: '会被拒' })
  await callAction(service, { action: 'visit', deviceId })

  await waitFor(() => packetsOf(peer, 'visit-request').length >= 1)
  const request = packetsOf(peer, 'visit-request')[0]
  peer.socket.send(
    visitDenyPayload({ deviceId, visitId: request.visitId, reason: 'not-admitted' }),
    servicePort,
    '127.0.0.1'
  )

  await waitFor(() => service.snapshot().self.out === null)
  await waitFor(async () => (await readBackpack(dir)).items[0]?.state === 'idle')

  const raw = await readBackpack(dir)
  assert.equal(raw.items[0].id, added.body.giftId)
  assert.equal(raw.items[0].state, 'idle')
  assert.equal('visitId' in raw.items[0], false)
  // 对方的拒绝理由要说清楚；东西也没有“送达”的可能，所以绝不会出现「收下了」。
  assert.ok(service.snapshot().notices.some((notice) => /没有放行你/.test(notice.text)))
  assert.equal(service.snapshot().notices.some((notice) => /收下了/.test(notice.text)), false)
})

// ---------------------------------------------------------------------------
// 5) 接收方真的发三次
// ---------------------------------------------------------------------------

test('接收方：写盘成功后回执发三次（测试里 30ms 一次），每包都是同一件', async (t) => {
  const dir = await tempDir(t)
  const { service, peer, deviceId, servicePort } = await admittedPeer(t, dir)

  const visitId = randomUUID()
  const giftId = randomUUID()
  peer.socket.send(
    visitRequestPayload({
      deviceId,
      visitId,
      nickname: '楼下的柯基',
      gift: { id: giftId, kind: 'text', text: '写盘成功才回执' }
    }),
    servicePort,
    '127.0.0.1'
  )

  await waitFor(() => packetsOf(peer, 'gift-received').length >= 3)
  const receipts = packetsOf(peer, 'gift-received')
  // 三次之后收手（attempts=3），不会变成无限重发。
  await delay(150)
  assert.equal(packetsOf(peer, 'gift-received').length, 3)
  const selfId = service.snapshot().self.deviceId
  for (const packet of receipts) {
    assert.deepEqual(packet, {
      v: PROTOCOL_VERSION,
      type: 'gift-received',
      deviceId: selfId,
      visitId,
      giftId
    })
  }
})

// ---------------------------------------------------------------------------
// 6) onPeer 路由：gift-received 不能落到 observeBeacon 兜底
// ---------------------------------------------------------------------------

test('gift-received 走自己的 onPeer 分支：不会被当成 beacon 静默吞掉', async (t) => {
  const dir = await tempDir(t)
  const peer = await loopbackPeer(t)
  const peerPort = peer.socket.address().port
  const servicePort = await freeUdpPort()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    desktop: false,
    port: servicePort,
    targetPort: peerPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 60000
  })
  await service.ready

  const beaconCalls = []
  const originalObserveBeacon = service.room.observeBeacon.bind(service.room)
  service.room.observeBeacon = (packet, at) => {
    beaconCalls.push(packet.type)
    return originalObserveBeacon(packet, at)
  }

  // 故意塞上 nickname/port：如果落到 observeBeacon，它会当场长出一位邻居和一条放行卡片。
  peer.socket.send(
    giftReceivedPayload({
      deviceId: randomUUID(),
      visitId: randomUUID(),
      giftId: randomUUID(),
      nickname: '伪装成邻居',
      port: peerPort
    }),
    servicePort,
    '127.0.0.1'
  )
  await delay(250)

  assert.deepEqual(beaconCalls, [])
  assert.deepEqual(service.snapshot().neighbors, [])
  assert.equal(service.snapshot().prompt, null)
})

// ---------------------------------------------------------------------------
// 7) 送客提醒：meta.opened === false 才说
// ---------------------------------------------------------------------------

test('送客提醒：没打开过才说「还在 gifts 里」；打开过、对方召回/失联也各自只提醒一次', async (t) => {
  const dir = await tempDir(t)
  const openedPaths = []
  const desktopFactory = () => ({
    start () { return { ok: true, pid: 4343 } },
    update () { return true },
    resync () { return true },
    actionResult () {},
    giftOpen (path) { openedPaths.push(path); return true },
    giftDiscard () {},
    dispose () {}
  })
  const { service, peer, deviceId, servicePort } = await admittedPeer(t, dir, {
    desktop: true,
    desktopFactory,
    peerLostMs: 800
  })

  const REMINDER = /「隔壁同事」捎来的东西还在 gifts 里。/
  // 快照只暴露最近 3 条 notice（room 的既有约定）：这里只看“最新那条”，
  // 不靠累计条数——连续几次结束会把更早的提醒挤出窗口。
  function newestNotice () {
    return service.snapshot().notices[0]?.text ?? ''
  }

  async function arrive (text) {
    const visitId = randomUUID()
    const giftId = randomUUID()
    peer.socket.send(
      visitRequestPayload({
        deviceId,
        visitId,
        nickname: '楼下的柯基',
        gift: { id: giftId, kind: 'text', text }
      }),
      servicePort,
      '127.0.0.1'
    )
    await waitFor(() => service.snapshot().visitors[0]?.gift?.id === giftId)
    await waitFor(() => service.snapshot().visitors[0]?.gift?.status === 'received')
    return { visitId, giftId }
  }

  // 1) 送客 + 一次都没打开过 → 提醒。
  await arrive('没打开过的字条')
  assert.equal((await callAction(service, { action: 'end-visit', deviceId })).status, 200)
  // 昵称以放行名单/邻居表为准（约定见 room.observeVisitRequest），不是报文里那个。
  await waitFor(() => REMINDER.test(newestNotice()))

  // 2) 打开过（gift-open 写了 meta.opened=true）→ 不再提醒。
  const second = await arrive('打开过的字条')
  assert.equal((await callAction(service, { action: 'gift-open', giftId: second.giftId })).status, 200)
  const dirs = await giftDirs(dir)
  assert.equal(dirs.length, 2)
  const meta = JSON.parse(await readFile(join(dir, GIFTS_DIR, dirs.find((name) => name.endsWith(second.giftId.slice(0, 8))), META_FILE), 'utf8'))
  assert.equal(meta.opened, true)
  const beforeEnd = service.snapshot().notices.map((notice) => notice.text)
  assert.equal((await callAction(service, { action: 'end-visit', deviceId })).status, 200)
  await delay(150)
  // 打开过就不提醒：这期间一条新 notice 都不该有（对方回家的那句本就不冒泡）。
  assert.deepEqual(service.snapshot().notices.map((notice) => notice.text), beforeEnd)

  // 3) 对方召回 → 也算一次“入站串门结束”，没打开过就提醒。
  const third = await arrive('被对方召回')
  peer.socket.send(visitRecallPayload({ deviceId, visitId: third.visitId }), servicePort, '127.0.0.1')
  await waitFor(() => REMINDER.test(newestNotice()))

  // 4) 失联（对方不再发心跳）→ 同样提醒（这一句在“失联了”之后入队，所以仍是最新一条）。
  await arrive('对方失联了')
  await waitFor(() => service.snapshot().visitors.length === 0, 3000)
  await waitFor(() => REMINDER.test(newestNotice()))
  assert.equal(openedPaths.length, 1)
})

// ---------------------------------------------------------------------------
// 8) dispose 也是结束点：还没回执的礼物写回 idle
// ---------------------------------------------------------------------------

test('dispose：还没等到回执的 out 件也会写回 idle，不留一个“永远在路上”', async (t) => {
  const dir = await tempDir(t)
  const { service, peer, deviceId, servicePort } = await admittedPeer(t, dir)

  const added = await callAction(service, { action: 'bring', kind: 'text', text: '卸载前还没回执' })
  await callAction(service, { action: 'visit', deviceId })
  await waitFor(() => packetsOf(peer, 'visit-request').length >= 1)
  const request = packetsOf(peer, 'visit-request')[0]
  peer.socket.send(visitAckPayload({ deviceId, visitId: request.visitId }), servicePort, '127.0.0.1')
  await waitFor(async () => (await readBackpack(dir)).items[0]?.state === 'out')

  service.dispose()
  await waitFor(async () => (await readBackpack(dir)).items[0]?.state === 'idle')
  assert.equal((await readBackpack(dir)).items[0].id, added.body.giftId)
})
