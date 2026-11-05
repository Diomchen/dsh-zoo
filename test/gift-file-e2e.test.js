/**
 * 票 25：文件礼物端到端（两个真 service + loopback + 真 HTTP）。
 *
 * 覆盖：
 *   1. A 背包里的文件 → A 出门 → B 来取 → B 的 gifts/ 落盘；A 召回后礼物路由立刻 404；
 *   2. 发送端：文件被改动/删掉 → 410，换成 >16 MiB → 413，路由只在 armed 期间可读；
 *   3. 接收端失败词表：checksum / timeout / too-large / refused / no-port；
 *      一个坏礼物不影响同一位访客之外的串门，也不影响别的访客的字条。
 *
 * 真 socket、真协议、真磁盘；不 spawn Electron。
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BACKPACK_FILE } from '../src/backpack.js'
import { GIFTS_DIR, META_FILE } from '../src/gifts.js'
import { MAX_GIFT_BYTES } from '../src/protocol.js'
import { createService } from '../src/service.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-gift-file-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 注意：这里**不**默认 skinServer:false——礼物端到端要真的起那个端口。 */
function makeService (t, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, { petBridge: false, desktop: false, ...options })
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
  const server = createNetServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
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
  socket.unref?.()
  return { socket, port: socket.address().port }
}

function beaconPayload ({ deviceId, nickname, port }) {
  return Buffer.from(JSON.stringify({
    v: 1,
    type: 'beacon',
    deviceId,
    nickname,
    port
  }), 'utf8')
}

function visitRequestPayload ({ deviceId, visitId, nickname, gift, skinPort }) {
  return Buffer.from(JSON.stringify({
    v: 1,
    type: 'visit-request',
    deviceId,
    visitId,
    nickname,
    anim: null,
    ...(skinPort === undefined ? {} : { skinPort }),
    gift
  }), 'utf8')
}

function visitAckPayload ({ deviceId, visitId }) {
  return Buffer.from(JSON.stringify({ v: 1, type: 'visit-ack', deviceId, visitId }), 'utf8')
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

function sha256 (bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex')
}

/** 一个假的邻居（只发 UDP，不跑 service）：能收 beacon 回执/visit-request，也能量产 ack。 */
async function fakeNeighbor (t, { deviceId = randomUUID(), nickname = '隔壁测试员' } = {}) {
  const peer = await loopbackPeer(t)
  return {
    ...peer,
    deviceId,
    nickname,
    announceTo (servicePort) {
      peer.socket.send(beaconPayload({ deviceId, nickname, port: peer.port }), servicePort, '127.0.0.1')
    },
    sendVisit (servicePort, { visitId = randomUUID(), gift, skinPort } = {}) {
      const payload = visitRequestPayload({ deviceId, visitId, nickname, gift, skinPort })
      peer.socket.send(payload, servicePort, '127.0.0.1')
      return visitId
    },
    ack (servicePort, visitId) {
      peer.socket.send(visitAckPayload({ deviceId, visitId }), servicePort, '127.0.0.1')
    }
  }
}

async function admittedFakeNeighbor (t, service, servicePort, options = {}) {
  const neighbor = await fakeNeighbor(t, options)
  neighbor.announceTo(servicePort)
  await waitFor(() => service.snapshot().neighbors.some((row) => row.deviceId === neighbor.deviceId))
  const admitted = await callAction(service, { action: 'admit', deviceId: neighbor.deviceId })
  assert.equal(admitted.status, 200)
  return neighbor
}

function visitorGift (service, deviceId) {
  const visitor = service.snapshot().visitors.find((candidate) => candidate.deviceId === deviceId)
  return visitor?.gift ?? null
}

async function waitGiftStatus (service, deviceId, status, timeoutMs = 5000) {
  await waitFor(() => visitorGift(service, deviceId)?.status === status, timeoutMs)
  return visitorGift(service, deviceId)
}

async function giftRoute (port, giftId) {
  return fetch('http://127.0.0.1:' + port + '/dsh-zoo-gift/' + giftId, { cache: 'no-store' })
}

/** 起一个只服务这次测试的假礼物源。 */
async function fakeSource (t, handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    // undici 的 keep-alive 默认 4s；不主动关掉空闲连接，测试会白等。
    server.closeAllConnections?.()
    return new Promise((resolve) => server.close(resolve))
  })
  return { port: server.address().port }
}

function twoInstanceOptions (dir, port, targetPort, overrides = {}) {
  return {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    petBridge: false,
    desktop: false,
    port,
    targetPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 5000,
    heartbeatIntervalMs: 60000,
    visitRetryMs: 50,
    visitTimeoutMs: 3000,
    visitTickMs: 20,
    tickIntervalMs: 50,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1) 两个 service：正常取回 + 召回后 404
// ---------------------------------------------------------------------------

test('两个 service：文件礼物正常取回（中文名）；armed 期间可读，召回后立刻 404', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  const [portA, portB, skinPortA] = await Promise.all([freeUdpPort(), freeUdpPort(), freeTcpPort()])

  const b = makeService(t, twoInstanceOptions(dirB, portB, portA))
  await b.ready
  const a = makeService(t, twoInstanceOptions(dirA, portA, portB, { skinPort: skinPortA }))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)
  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal((await callAction(a, { action: 'admit', deviceId: bId })).status, 200)
  assert.equal((await callAction(b, { action: 'admit', deviceId: aId })).status, 200)

  // A 的背包里放一个中文名文件。
  const file = join(dirA, '报价单.pdf')
  const bytes = Buffer.from('这是一份报价单，中文名要能原样到对面。', 'utf8')
  await writeFile(file, bytes)
  const brought = await callAction(a, { action: 'bring', kind: 'file', path: file })
  assert.equal(brought.status, 200)
  const giftId = brought.body.giftId

  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.giftId, giftId)

  // B 真的把东西取回来了：visitor.gift 是 file + received，磁盘上有本体与 meta。
  const received = await waitGiftStatus(b, aId, 'received')
  assert.equal(received.kind, 'file')
  assert.equal(received.name, '报价单.pdf')
  assert.equal(received.size, bytes.length)
  assert.equal('text' in received, false)

  const [dirName] = await readdir(join(dirB, GIFTS_DIR))
  const target = join(dirB, GIFTS_DIR, dirName, '报价单.pdf')
  assert.deepEqual(await readFile(target), bytes)
  const meta = JSON.parse(await readFile(join(dirB, GIFTS_DIR, dirName, META_FILE), 'utf8'))
  assert.equal(meta.kind, 'file')
  assert.equal(meta.name, '报价单.pdf')
  assert.equal(meta.size, bytes.length)
  assert.equal(meta.sha256, sha256(bytes))
  assert.equal(meta.from.deviceId, aId)

  // 送达回执（ticket 26 的文件路径）：A 只有收到 `gift-received` 才会把这一件从背包里删掉。
  // 这条接线是解合并冲突时补的，25 与 26 各自的测试都碰不到它。
  await waitFor(async () => {
    const backpack = JSON.parse(await readFile(join(dirA, BACKPACK_FILE), 'utf8'))
    return Array.isArray(backpack.items) && backpack.items.length === 0
  })

  // A 这边的礼物路由在 armed 期间可读（B 就是这么取的）。
  const live = await giftRoute(skinPortA, giftId)
  assert.equal(live.status, 200)
  assert.deepEqual(Buffer.from(await live.arrayBuffer()), bytes)

  // 召回 = 这次串门结束：立刻 unarm，路由 404；B 的访客与卡片也收起。
  const recalled = await callAction(a, { action: 'recall' })
  assert.equal(recalled.status, 200)
  await waitFor(() => a.snapshot().self.out === null)
  assert.equal((await giftRoute(skinPortA, giftId)).status, 404)

  // B 收到 recall 后清场（卡片跟着访客走，自然收起）。
  await waitFor(() => b.snapshot().visitors.length === 0)
  assert.equal(b.snapshot().visitors.length, 0)
})

// ---------------------------------------------------------------------------
// 2) 发送端：410 / 413，以及 arm 的五个结束点
// ---------------------------------------------------------------------------

test('发送端：文件被改动/删掉 → 410、换成 >16 MiB → 413；召回后 404', async (t) => {
  const dir = await tempDir(t)
  const servicePort = await freeUdpPort()
  const skinPort = await freeTcpPort()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    port: servicePort,
    targetPort: 0,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 60000,
    visitRetryMs: 50,
    visitTimeoutMs: 3000,
    visitTickMs: 20,
    tickIntervalMs: 50,
    skinPort
  })
  await service.ready
  const peer = await admittedFakeNeighbor(t, service, servicePort)

  const file = join(dir, '会被改.pdf')
  const bytes = Buffer.from('原始内容', 'utf8')
  await writeFile(file, bytes)
  const brought = await callAction(service, { action: 'bring', kind: 'file', path: file })
  const giftId = brought.body.giftId

  // 对方的 socket 收到 visit-request 之后回 ack，A 的 outbound 进入 active。
  const received = []
  peer.socket.on('message', (message) => {
    try {
      received.push(JSON.parse(message.toString('utf8')))
    } catch {
      // 忽略
    }
  })
  const started = await callAction(service, { action: 'visit', deviceId: peer.deviceId })
  assert.equal(started.status, 200)
  await waitFor(() => received.some((packet) => packet.type === 'visit-request'))
  const request = received.find((packet) => packet.type === 'visit-request')
  peer.ack(servicePort, request.visitId)
  await waitFor(() => service.snapshot().self.out?.phase === 'active')

  // 原样：200 + 正确字节。
  const first = await giftRoute(skinPort, giftId)
  assert.equal(first.status, 200)
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes)

  // 内容变了但长度一样 → 410。
  await writeFile(file, Buffer.from('换掉内容', 'utf8'))
  assert.equal((await giftRoute(skinPort, giftId)).status, 410)

  // 恢复原样 → 200；再删掉 → 410。
  await writeFile(file, bytes)
  assert.equal((await giftRoute(skinPort, giftId)).status, 200)
  await rm(file)
  assert.equal((await giftRoute(skinPort, giftId)).status, 410)

  // 换成一个超过 16 MiB 的文件 → 413（先于大小不符的 410）。
  await writeFile(file, 'x')
  await truncate(file, MAX_GIFT_BYTES + 1)
  assert.equal((await giftRoute(skinPort, giftId)).status, 413)

  // 召回 → 404（不再可读，即使文件还在）。
  assert.equal((await callAction(service, { action: 'recall' })).status, 200)
  await waitFor(() => service.snapshot().self.out === null)
  assert.equal((await giftRoute(skinPort, giftId)).status, 404)
})

// ---------------------------------------------------------------------------
// 3) 接收端失败词表
// ---------------------------------------------------------------------------

async function receivingService (t, options = {}) {
  const dir = await tempDir(t)
  const port = await freeUdpPort()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    port,
    targetPort: 0,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 60000,
    visitTickMs: 20,
    tickIntervalMs: 50,
    // 端口 0：绑定临时端口；对方广告的 skinPort 由测试自己编。
    skinPort: 0,
    ...options
  })
  await service.ready
  return { service, dir, port }
}

test('接收端：sha256 不符 → failed/checksum；一个坏礼物不影响另一位访客的字条', async (t) => {
  const { service, dir, port } = await receivingService(t)
  const bytes = Buffer.from('正确内容')
  const source = await fakeSource(t, (req, res) => {
    const wrong = Buffer.from('错误内容')
    res.writeHead(200, { 'content-length': wrong.length })
    res.end(wrong)
  })

  const bad = await admittedFakeNeighbor(t, service, port, { nickname: '坏文件邻居' })
  bad.sendVisit(port, {
    gift: {
      id: randomUUID(),
      kind: 'file',
      name: '坏文件.bin',
      size: bytes.length,
      sha256: sha256(bytes)
    },
    skinPort: source.port
  })
  const failed = await waitGiftStatus(service, bad.deviceId, 'failed')
  assert.equal(failed.reason, 'checksum')
  assert.equal(failed.kind, 'file')

  // 磁盘上不留半个文件，也不建礼物目录。
  let entries = []
  try {
    entries = await readdir(join(dir, GIFTS_DIR))
  } catch {
    entries = []
  }
  assert.deepEqual(entries, [])

  // 另一位访客的字条照常收下：一个坏礼物不影响别人。
  const good = await admittedFakeNeighbor(t, service, port, { nickname: '好字条邻居' })
  const noteId = randomUUID()
  good.sendVisit(port, { gift: { id: noteId, kind: 'text', text: '我还好' } })
  const note = await waitGiftStatus(service, good.deviceId, 'received')
  assert.equal(note.kind, 'text')
  assert.equal(note.text, '我还好')
  assert.equal(service.snapshot().visitors.length, 2)
})

test('接收端：超时 → failed/timeout；对方 413 → failed/too-large；对方 410 → failed/refused', async (t) => {
  const { service, port } = await receivingService(t, {
    giftConnectTimeoutMs: 80,
    giftTimeoutMs: 150
  })

  const stalls = await fakeSource(t, () => {
    // 永不响应。
  })
  const slow = await admittedFakeNeighbor(t, service, port, { nickname: '慢邻居' })
  const slowId = randomUUID()
  slow.sendVisit(port, {
    gift: { id: slowId, kind: 'file', name: '慢.bin', size: 3, sha256: sha256(Buffer.from('abc')) },
    skinPort: stalls.port
  })
  assert.equal((await waitGiftStatus(service, slow.deviceId, 'failed')).reason, 'timeout')

  // 对方回 413（超过上限）。
  const big = await fakeSource(t, (req, res) => {
    res.writeHead(413)
    res.end()
  })
  const bigger = await admittedFakeNeighbor(t, service, port, { nickname: '大文件邻居' })
  const bigId = randomUUID()
  bigger.sendVisit(port, {
    gift: { id: bigId, kind: 'file', name: '大.bin', size: 3, sha256: sha256(Buffer.from('abc')) },
    skinPort: big.port
  })
  assert.equal((await waitGiftStatus(service, bigger.deviceId, 'failed')).reason, 'too-large')

  // 对方回 410（东西已经不在了）。
  const gone = await fakeSource(t, (req, res) => {
    res.writeHead(410)
    res.end()
  })
  const gonePeer = await admittedFakeNeighbor(t, service, port, { nickname: '丢东西邻居' })
  gonePeer.sendVisit(port, {
    gift: { id: randomUUID(), kind: 'file', name: '没了.bin', size: 3, sha256: sha256(Buffer.from('abc')) },
    skinPort: gone.port
  })
  assert.equal((await waitGiftStatus(service, gonePeer.deviceId, 'failed')).reason, 'refused')
})

test('接收端：对方没广告 skinPort → failed/no-port（不发起任何网络请求）', async (t) => {
  const { service, port } = await receivingService(t)
  const neighbor = await admittedFakeNeighbor(t, service, port)
  neighbor.sendVisit(port, {
    gift: {
      id: randomUUID(),
      kind: 'file',
      name: '取不回来.bin',
      size: 3,
      sha256: sha256(Buffer.from('abc'))
    }
    // 故意不带 skinPort：旧版本 / 没开端口的邻居。
  })
  const gift = await waitGiftStatus(service, neighbor.deviceId, 'failed')
  assert.equal(gift.reason, 'no-port')
  assert.equal(gift.status, 'failed')
})
