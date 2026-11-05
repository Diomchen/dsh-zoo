/**
 * 票 23：字条端到端。
 *
 * 真 socket、真协议、真磁盘：
 *   - fake peer 发来一条带 gift 的 visit-request → `gifts/<dir>/note.txt` + meta.json；
 *   - 快照里挂到访客身上，`controls.gifts` 变成一张卡；
 *   - 「扔掉」后目录没了，重发同一件礼物也不会复活；没有磁盘记录的卡片同样能扔掉；
 *   - 不带 gift 的旧报文不影响串门；`visit` 只从背包带礼物（票 23 的临时入口已删）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { controlsFromSnapshot } from '../src/desktop-pets.js'
import { GIFTS_DIR, META_FILE, NOTE_FILE, createGiftStore } from '../src/gifts.js'
import { PROTOCOL_VERSION, parsePacket } from '../src/protocol.js'
import { createService } from '../src/service.js'
import { VISITS_FILE } from '../src/visits.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-gift-e2e-'))
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
    received.push({ message, rinfo, parsed: parsePacket(message) })
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

function visitRequestPayload ({ deviceId, visitId, nickname, anim = null, gift }) {
  return Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'visit-request',
    deviceId,
    visitId,
    nickname,
    anim,
    ...(gift === undefined ? {} : { gift })
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

function twoInstanceOptions (dir, port, targetPort, overrides = {}) {
  return {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    petBridge: false,
    skinServer: false,
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
    tickIntervalMs: 50,
    ...overrides
  }
}

async function giftDirs (dir) {
  return readdir(join(dir, GIFTS_DIR)).catch(() => [])
}

test('fake peer 发来字条：落盘 → 快照挂到访客 → 卡片出现；扔掉后目录与卡片一起消失', async (t) => {
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
    heartbeatIntervalMs: 60000,
    tickIntervalMs: 50
  })
  await service.ready

  const deviceId = randomUUID()
  peer.socket.send(
    beaconPayload({ deviceId, nickname: '楼下的柯基', port: peerPort }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().neighbors.length === 1)
  assert.equal((await callAction(service, { action: 'admit', deviceId })).status, 200)

  const visitId = randomUUID()
  const giftId = randomUUID()
  peer.socket.send(
    visitRequestPayload({
      deviceId,
      visitId,
      nickname: '楼下的柯基',
      gift: { id: giftId, kind: 'text', text: '  第一行\n第二行  ' }
    }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().visitors[0]?.gift?.status === 'received')

  // 磁盘：gifts/<可读时间>-<id 前 8 位>/note.txt + meta.json
  const dirs = await giftDirs(dir)
  assert.equal(dirs.length, 1)
  const dirName = dirs[0]
  assert.match(dirName, /^\d{8}-\d{6}-[0-9a-f]{8}$/)
  assert.equal(dirName.endsWith(giftId.slice(0, 8)), true)
  const note = await readFile(join(dir, GIFTS_DIR, dirName, NOTE_FILE), 'utf8')
  assert.equal(note, '第一行\n第二行\n')
  const meta = JSON.parse(await readFile(join(dir, GIFTS_DIR, dirName, META_FILE), 'utf8'))
  assert.equal(meta.id, giftId)
  assert.equal(meta.dir, dirName)
  assert.deepEqual(meta.from, { deviceId, nickname: '楼下的柯基' })
  assert.equal(meta.kind, 'text')
  assert.equal(meta.text, '第一行\n第二行')
  assert.equal(meta.opened, false)

  // 快照 / 卡片：标题与正文都来自宿主，正文只在该收到时出现。
  const visitor = service.snapshot().visitors[0]
  assert.equal(visitor.deviceId, deviceId)
  assert.equal(visitor.gift.id, giftId)
  assert.equal(visitor.gift.status, 'received')
  const card = controlsFromSnapshot(service.snapshot()).gifts
  assert.deepEqual(card, [{
    deviceId,
    giftId,
    kind: 'text',
    status: 'received',
    title: '「楼下的柯基」捎来一张字条',
    text: '第一行\n第二行'
  }])

  // 没有桌面层时，打开/显示/复制明确失败（不用静默假装成功）。
  const open = await callAction(service, { action: 'gift-open', giftId })
  assert.equal(open.status, 409)
  assert.equal(open.body.error, 'open-failed')

  // 扔掉：目录立刻删、卡片立刻消失。
  const discard = await callAction(service, { action: 'gift-discard', giftId })
  assert.equal(discard.status, 200)
  assert.equal(discard.body.ok, true)
  assert.deepEqual(await giftDirs(dir), [])
  assert.equal('gift' in service.snapshot().visitors[0], false)
  assert.deepEqual(controlsFromSnapshot(service.snapshot()).gifts, [])

  // 对方没收到 ack 又重发同一条请求：东西已经被扔掉，卡片与目录都不许复活。
  peer.socket.send(
    visitRequestPayload({
      deviceId,
      visitId: randomUUID(),
      nickname: '楼下的柯基',
      gift: { id: giftId, kind: 'text', text: '第一行\n第二行' }
    }),
    servicePort,
    '127.0.0.1'
  )
  await delay(250)
  assert.deepEqual(await giftDirs(dir), [])
  assert.equal('gift' in service.snapshot().visitors[0], false)
  assert.deepEqual(controlsFromSnapshot(service.snapshot()).gifts, [])

  // 再扔一次：这次没有磁盘记录了，但「扔掉」仍然认（只拉黑，不碰文件），幂等返回 ok。
  const again = await callAction(service, { action: 'gift-discard', giftId })
  assert.equal(again.status, 200)
  assert.equal(again.body.ok, true)

  // 收尾：让对方回家，避免 t.after 里的 dispose 留下一条 in 记录（这不是本测试的断言点）。
  peer.socket.send(recallAckPayload({ deviceId, visitId }), servicePort, '127.0.0.1')
})

test('没有磁盘记录的礼物卡也能「扔掉」：拉黑、卡片消失、返回 ok、不碰文件', async (t) => {
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
    heartbeatIntervalMs: 60000,
    tickIntervalMs: 50
  })
  await service.ready

  const deviceId = randomUUID()
  peer.socket.send(
    beaconPayload({ deviceId, nickname: '楼下的柯基', port: peerPort }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().neighbors.length === 1)
  assert.equal((await callAction(service, { action: 'admit', deviceId })).status, 200)

  const visitId = randomUUID()
  const giftId = randomUUID()
  const sendGift = () => peer.socket.send(
    visitRequestPayload({
      deviceId,
      visitId,
      nickname: '楼下的柯基',
      // 没有 skinPort：文件礼物根本取不回来 → failed/no-port，磁盘上没有记录。
      gift: {
        id: giftId,
        kind: 'file',
        name: '报价单.pdf',
        size: 4,
        sha256: 'sha256:' + 'a'.repeat(64)
      }
    }),
    servicePort,
    '127.0.0.1'
  )

  sendGift()
  await waitFor(() => {
    const gift = service.snapshot().visitors[0]?.gift
    return gift?.id === giftId && gift.status === 'failed' && gift.reason === 'no-port'
  })
  assert.deepEqual(await giftDirs(dir), [], '没有落盘，所以没有磁盘记录')
  assert.equal(controlsFromSnapshot(service.snapshot()).gifts[0]?.status, 'failed')

  const discarded = await callAction(service, { action: 'gift-discard', giftId })
  assert.equal(discarded.status, 200)
  assert.equal(discarded.body.ok, true)
  assert.equal('gift' in service.snapshot().visitors[0], false)
  assert.deepEqual(controlsFromSnapshot(service.snapshot()).gifts, [])

  // 重发同一条：黑名单认这件，卡片不会长回来，也不会尝试写盘。
  sendGift()
  await delay(250)
  assert.equal('gift' in service.snapshot().visitors[0], false)
  assert.deepEqual(await giftDirs(dir), [])
})

test('不带 gift 的旧报文：访客照常进门，没有礼物目录、没有卡片', async (t) => {
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

  const deviceId = randomUUID()
  peer.socket.send(beaconPayload({ deviceId, nickname: '老邻居', port: peerPort }), servicePort, '127.0.0.1')
  await waitFor(() => service.snapshot().neighbors.length === 1)
  assert.equal((await callAction(service, { action: 'admit', deviceId })).status, 200)

  peer.socket.send(
    visitRequestPayload({ deviceId, visitId: randomUUID(), nickname: '老邻居' }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => service.snapshot().visitors.length === 1)
  assert.equal('gift' in service.snapshot().visitors[0], false)
  assert.deepEqual(controlsFromSnapshot(service.snapshot()).gifts, [])
  assert.deepEqual(await giftDirs(dir), [])
})

test('两个实例：A 背包里的字条随 visit 带过去 → B 落盘并出现在 B 的卡片上', async (t) => {
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

  // 礼物唯一入口是背包（票 24）：先放进去，出门时自动带上 `at` 最小的那件。
  const added = await callAction(a, { action: 'bring', kind: 'text', text: '到你家门口了\n顺带一句' })
  assert.equal(added.status, 200)
  const giftId = added.body.giftId
  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  assert.equal(started.body.giftId, giftId)
  assert.equal(started.body.giftDropped, false)
  await waitFor(() => b.snapshot().visitors[0]?.gift?.status === 'received')
  assert.equal(b.snapshot().visitors[0].gift.id, giftId)
  const card = controlsFromSnapshot(b.snapshot()).gifts[0]
  assert.equal(card.giftId, giftId)
  assert.equal(card.text, '到你家门口了\n顺带一句')
  assert.equal(card.title, '「' + a.snapshot().self.nickname + '」捎来一张字条')

  const dirs = await giftDirs(dirB)
  assert.equal(dirs.length, 1)
  assert.equal(
    await readFile(join(dirB, GIFTS_DIR, dirs[0], NOTE_FILE), 'utf8'),
    '到你家门口了\n顺带一句\n'
  )
})

test('visit action 不再接受显式 gift：只从背包带东西', async (t) => {
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
    heartbeatIntervalMs: 60000,
    visitRetryMs: 500,
    visitTimeoutMs: 300
  })
  await service.ready

  const deviceId = randomUUID()
  peer.socket.send(beaconPayload({ deviceId, nickname: '隔壁', port: peerPort }), servicePort, '127.0.0.1')
  await waitFor(() => service.snapshot().neighbors.length === 1)
  assert.equal((await callAction(service, { action: 'admit', deviceId })).status, 200)

  const added = await callAction(service, { action: 'bring', kind: 'text', text: '背包里的' })
  assert.equal(added.status, 200)
  const started = await callAction(service, {
    action: 'visit',
    deviceId,
    // 票 23 的临时入口已经删掉：这个字段必须被忽略，带上的只能是背包里那件。
    gift: { id: randomUUID(), kind: 'text', text: '这条应该被忽略' }
  })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.giftId, added.body.giftId)

  await waitFor(() => visitEntries(peer.received).length >= 1)
  const requests = visitEntries(peer.received)
  for (const entry of requests) {
    assert.equal(entry.parsed.packet.gift.id, added.body.giftId)
    assert.equal(entry.parsed.packet.gift.text, '背包里的')
  }
  assert.equal(service.snapshot().notices.some((notice) => /字条太长了/.test(notice.text)), false)
})

test('桌面动作：打开/显示/复制走 helper，扔掉交给 helper；路径只从 store 来', async (t) => {
  const dir = await tempDir(t)
  // 先放一件已经收到的礼物，再起 service（启动时从磁盘读回索引）。
  const seeded = await createGiftStore(dir, { log: { warn () {} } })
  const giftId = randomUUID()
  const saved = await seeded.receiveText({
    id: giftId,
    from: { deviceId: randomUUID(), nickname: '阿蟹' },
    text: '你好\n再见'
  })
  assert.equal(saved.ok, true)

  const calls = { open: [], reveal: [], copy: [], discard: [] }
  let onEvent = null
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 7777 } },
        update () { return true },
        resync () { return true },
        actionResult () {},
        giftOpen (path) { calls.open.push(path); return true },
        giftReveal (path) { calls.reveal.push(path); return true },
        giftCopy (text) { calls.copy.push(text); return true },
        giftDiscard (path) { calls.discard.push(path); return true },
        dispose () {}
      }
    }
  })
  await service.ready
  assert.equal(typeof onEvent, 'function')

  const opened = await callAction(service, { action: 'gift-open', giftId })
  assert.equal(opened.status, 200)
  assert.deepEqual(calls.open, [saved.gift.notePath])
  const meta = JSON.parse(await readFile(saved.gift.metaPath, 'utf8'))
  assert.equal(meta.opened, true)

  const revealed = await callAction(service, { action: 'gift-reveal', giftId })
  assert.equal(revealed.status, 200)
  assert.deepEqual(calls.reveal, [saved.gift.notePath])

  const copied = await callAction(service, { action: 'gift-copy', giftId })
  assert.equal(copied.status, 200)
  assert.equal(copied.body.notice, '字条已经复制到剪贴板。')
  // 宿主读的是 note.txt 原文（写入时带一个换行；helper 侧还会再清洗一遍）。
  assert.deepEqual(calls.copy, ['你好\n再见\n'])

  // 用户手改过 note.txt：复制到的是磁盘上的当前内容，不是内存里的旧正文。
  await writeFile(saved.gift.notePath, '手改过的正文\n', 'utf8')
  const copiedEdited = await callAction(service, { action: 'gift-copy', giftId })
  assert.equal(copiedEdited.status, 200)
  assert.deepEqual(calls.copy.at(-1), '手改过的正文\n')

  // 磁盘文件读不到时才回退内存值：至少还能复制到收到时的正文。
  await rm(saved.gift.notePath, { force: true })
  const copiedFallback = await callAction(service, { action: 'gift-copy', giftId })
  assert.equal(copiedFallback.status, 200)
  assert.deepEqual(calls.copy.at(-1), '你好\n再见')

  const discarded = await callAction(service, { action: 'gift-discard', giftId })
  assert.equal(discarded.status, 200)
  // 宿主先删（HTTP/没有 helper 的路径也成立），同一台桌面上再顺带发一条 helper 命令。
  assert.deepEqual(await readdir(join(dir, GIFTS_DIR)), [])
  assert.deepEqual(calls.discard, [saved.gift.dirPath])

  // 已经不在索引里：打开/显示/复制都是 gift-not-found；坏 id 是 bad-gift。
  for (const action of ['gift-open', 'gift-reveal', 'gift-copy']) {
    const missing = await callAction(service, { action, giftId })
    assert.equal(missing.status, 409, action)
    assert.equal(missing.body.error, 'gift-not-found', action)
  }
  // 「扔掉」是幂等的：没有磁盘记录也认这次操作（只拉黑，不碰文件），返回 ok。
  const discardedAgain = await callAction(service, { action: 'gift-discard', giftId })
  assert.equal(discardedAgain.status, 200)
  assert.equal(discardedAgain.body.ok, true)
  const bad = await callAction(service, { action: 'gift-open', giftId: 'gift-1' })
  assert.equal(bad.status, 409)
  assert.equal(bad.body.error, 'bad-gift')
})

async function visitsOf (dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir, VISITS_FILE), 'utf8'))
    return Array.isArray(raw?.visits) ? raw.visits : []
  } catch {
    return []
  }
}

test('频率限额：同一邻居第 11 件礼物 → refused/rate，不落盘、不回执；文件路径同样被挡', async (t) => {
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
    heartbeatIntervalMs: 60000,
    tickIntervalMs: 50
  })
  await service.ready

  const deviceId = randomUUID()
  peer.socket.send(beaconPayload({ deviceId, nickname: '楼下的柯基', port: peerPort }), servicePort, '127.0.0.1')
  await waitFor(() => service.snapshot().neighbors.length === 1)
  assert.equal((await callAction(service, { action: 'admit', deviceId })).status, 200)

  // 10 件字条逐件等落盘：第 11 件才该被频率闸挡下。
  for (let index = 0; index < 10; index += 1) {
    const giftId = randomUUID()
    peer.socket.send(
      visitRequestPayload({
        deviceId,
        visitId: randomUUID(),
        nickname: '楼下的柯基',
        gift: { id: giftId, kind: 'text', text: '第 ' + index + ' 张便条' }
      }),
      servicePort,
      '127.0.0.1'
    )
    await waitFor(() => {
      const gift = service.snapshot().visitors[0]?.gift
      return gift?.id === giftId && gift.status === 'received'
    })
  }
  assert.equal((await giftDirs(dir)).length, 10)

  // 第 11 件故意走文件路径（没有 skinPort，本会得到 failed/no-port）：
  // 现在必须是 refused/rate —— 证明字条与文件共用同一道闸，且限速先于拉取。
  const refusedGiftId = randomUUID()
  peer.socket.send(
    visitRequestPayload({
      deviceId,
      visitId: randomUUID(),
      nickname: '楼下的柯基',
      gift: {
        id: refusedGiftId,
        kind: 'file',
        name: '报价单.pdf',
        size: 4,
        sha256: 'sha256:' + 'a'.repeat(64)
      }
    }),
    servicePort,
    '127.0.0.1'
  )
  await waitFor(() => {
    const gift = service.snapshot().visitors[0]?.gift
    return gift?.id === refusedGiftId && gift.status === 'refused'
  })
  const refused = service.snapshot().visitors[0].gift
  assert.equal(refused.status, 'refused')
  assert.equal(refused.reason, 'rate')

  await delay(250)
  assert.equal((await giftDirs(dir)).length, 10, '第 11 件不落盘')
  const receipts = visitEntries(peer.received, 'gift-received')
  assert.equal(
    receipts.some((entry) => entry.parsed.packet.giftId === refusedGiftId),
    false,
    '第 11 件不回执'
  )
  // 串门本身照常：访客还在，礼物卡只是「没收下」。
  assert.equal(service.snapshot().visitors.length, 1)
})

test('gifts/ 总量超限（注入小额度）：新礼物写成功后立刻按 receivedAt 删最旧，/state 只剩最新', async (t) => {
  const dir = await tempDir(t)
  const peer = await loopbackPeer(t)
  const peerPort = peer.socket.address().port
  const servicePort = await freeUdpPort()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    desktop: false,
    // 生产是 500 MiB；这里缩小到 1 字节，验的是「先写后剪、删最旧」这条路径。
    giftMaxTotalBytes: 1,
    port: servicePort,
    targetPort: peerPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 60000,
    tickIntervalMs: 50
  })
  await service.ready

  const deviceId = randomUUID()
  peer.socket.send(beaconPayload({ deviceId, nickname: '楼下的柯基', port: peerPort }), servicePort, '127.0.0.1')
  await waitFor(() => service.snapshot().neighbors.length === 1)
  assert.equal((await callAction(service, { action: 'admit', deviceId })).status, 200)

  let latestGiftId = null
  for (let index = 0; index < 3; index += 1) {
    const giftId = randomUUID()
    latestGiftId = giftId
    peer.socket.send(
      visitRequestPayload({
        deviceId,
        visitId: randomUUID(),
        nickname: '楼下的柯基',
        gift: { id: giftId, kind: 'text', text: '第 ' + index + ' 张便条' }
      }),
      servicePort,
      '127.0.0.1'
    )
    await waitFor(() => {
      const gift = service.snapshot().visitors[0]?.gift
      return gift?.id === giftId && gift.status === 'received'
    })
    // 每次收下之后目录里只剩刚写的这一件：旧的两件都被整目录删掉了。
    await waitFor(async () => (await giftDirs(dir)).length === 1)
  }

  const dirs = await giftDirs(dir)
  assert.equal(dirs.length, 1)
  assert.equal(dirs[0].endsWith(latestGiftId.slice(0, 8)), true, '保留的是最新那件')
  const state = service.snapshot()
  assert.equal(state.gifts.length, 1)
  assert.equal(state.gifts[0].id, latestGiftId)
  assert.equal(state.gifts[0].status, 'received')
  assert.match(state.gifts[0].path, /note\.txt$/)
})

test('记录里带 gift：字条在双方 visits.json 都留下 {kind:"text"}，不记正文', async (t) => {
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

  const secret = '私房话：今晚吃鱼\n第二行'
  const added = await callAction(a, { action: 'bring', kind: 'text', text: secret })
  assert.equal(added.status, 200)
  const started = await callAction(a, { action: 'visit', deviceId: bId })
  assert.equal(started.status, 200)
  assert.equal(started.body.giftId, added.body.giftId)
  await waitFor(() => b.snapshot().visitors[0]?.gift?.status === 'received')
  await waitFor(() => a.snapshot().self.out?.phase === 'active')

  assert.equal((await callAction(a, { action: 'recall' })).status, 200)
  await waitFor(async () => (await visitsOf(dirA)).length === 1 && (await visitsOf(dirB)).length === 1)

  const outRecord = (await visitsOf(dirA))[0]
  const inRecord = (await visitsOf(dirB))[0]
  assert.equal(outRecord.direction, 'out')
  assert.equal(inRecord.direction, 'in')
  assert.deepEqual(outRecord.gift, { kind: 'text' })
  assert.deepEqual(inRecord.gift, { kind: 'text' })
  // 记录只留摘要：正文不写进历史文件。
  assert.equal(JSON.stringify(outRecord).includes('私房话'), false)
  assert.equal(JSON.stringify(inRecord).includes('私房话'), false)
})
