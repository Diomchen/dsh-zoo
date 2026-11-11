/**
 * 票 43：主人侧的 farm-action 集成（fake peer，不依赖第二个 service）。
 *
 * 覆盖：visitId/deviceId 双证、成熟/每块地一次/日限额、守卫被抓、幂等重发、
 * 帮的 +10% 与日志里的「谁」、串门结束后不再响应。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FARM_FILE, FARM_VERSION, PLOT_IDS } from '../src/farm.js'
import { CROPS } from '../src/farm-rules.js'
import { PROTOCOL_VERSION, encodeFarmAction, parsePacket } from '../src/protocol.js'
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-farm-action-'))
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

function resultsOf (received) {
  return received.filter((entry) => entry.parsed.ok && entry.parsed.packet.type === 'farm-action-result')
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

const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()

function maturePlot (id, crop = 'tomato') {
  return {
    id,
    crop,
    plantedAt: Date.now() - CROPS[crop].growMs,
    grownMs: CROPS[crop].growMs,
    growMs: CROPS[crop].growMs,
    waterings: 0,
    fertilized: false,
    stolenBy: [],
    helpedBy: []
  }
}

function growingPlot (id, crop = 'carrot') {
  return {
    id,
    crop,
    plantedAt: Date.now() - 1000,
    grownMs: 1000,
    growMs: CROPS[crop].growMs,
    waterings: 0,
    fertilized: false,
    stolenBy: [],
    helpedBy: []
  }
}

function farmFile (plots) {
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
    plots,
    hire: { enabled: false, wagePerHour: 10, minHours: 2, maxHours: 8 },
    log: []
  }
}

async function readFarm (dir) {
  return JSON.parse(await readFile(join(dir, FARM_FILE), 'utf8'))
}

/** 主机 + 一个裸 UDP 邻居；邻居已经进门（visitor 表里有一条）。 */
async function hostWithVisitor (t, { plots, farmRandom = () => 1 }) {
  const dir = await tempDir(t)
  await writeFile(join(dir, FARM_FILE), JSON.stringify(farmFile(plots)), 'utf8')
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
    visitTickMs: 10,
    tickIntervalMs: 50,
    farmNow: () => NOON,
    farmRandom
  })
  await service.ready

  const deviceId = randomUUID()
  const visitId = randomUUID()
  const nickname = '阿蟹'
  peer.socket.send(Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'beacon',
    deviceId,
    nickname,
    port: peerPort
  }), 'utf8'), servicePort, '127.0.0.1')
  await waitFor(() => service.snapshot().neighbors.length === 1)
  const admitted = await callAction(service, { action: 'admit', deviceId })
  assert.equal(admitted.status, 200)

  peer.socket.send(Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'visit-request',
    deviceId,
    visitId,
    nickname,
    anim: null,
    skinPort: peerPort
  }), 'utf8'), servicePort, '127.0.0.1')
  await waitFor(() => service.snapshot().visitors.length === 1)
  assert.equal(service.snapshot().visitors[0].visitId, visitId)

  return { dir, peer, peerPort, servicePort, service, deviceId, visitId, nickname }
}

function sendAction (context, { visitId = context.visitId, deviceId = context.deviceId, requestId, action = 'steal', plotId }) {
  const data = encodeFarmAction({
    deviceId,
    visitId,
    requestId,
    action,
    plotId
  })
  context.peer.socket.send(data, context.servicePort, '127.0.0.1')
  return data
}

test('偷成功：访客仓库 +1、地块 stolenBy、日志带 who；同 requestId 重发只落一次', async (t) => {
  const context = await hostWithVisitor(t, {
    plots: [maturePlot('p1'), maturePlot('p2'), maturePlot('p3'), growingPlot('p4')]
  })
  const requestId = randomUUID()
  sendAction(context, { requestId, plotId: 'p1' })
  await waitFor(() => resultsOf(context.peer.received).length === 1)
  const first = resultsOf(context.peer.received)[0].parsed.packet
  assert.deepEqual(first, {
    v: PROTOCOL_VERSION,
    type: 'farm-action-result',
    deviceId: context.service.snapshot().self.deviceId,
    requestId,
    ok: true,
    crop: 'tomato',
    qty: 1
  })

  const farm = await readFarm(context.dir)
  assert.deepEqual(farm.plots[0].stolenBy, [context.deviceId])
  assert.equal(farm.plots[0].stolenBy.length, 1)
  assert.equal(farm.log.filter((entry) => entry.kind === 'steal').length, 1)
  assert.equal(farm.log[0].who, '阿蟹')
  // 收获产量在读取时按 stolenBy 结算：3 − 1 = 2。
  assert.equal(farm.plots[0].stolenBy.length, 1)
  assert.match(context.service.snapshot().notices[0].text, /「阿蟹」偷了 1 个小番茄/)

  // 重发同一 requestId：回同一结果，不重复写 stolenBy / 日志。
  sendAction(context, { requestId, plotId: 'p1' })
  await waitFor(() => resultsOf(context.peer.received).length === 2)
  assert.deepEqual(resultsOf(context.peer.received)[1].parsed.packet, first)
  const again = await readFarm(context.dir)
  assert.equal(again.plots[0].stolenBy.length, 1)
  assert.equal(again.log.filter((entry) => entry.kind === 'steal').length, 1)

  // 新 requestId 同一块地：already-stolen（并同样缓存失败结果）。
  const secondRequest = randomUUID()
  sendAction(context, { requestId: secondRequest, plotId: 'p1' })
  await waitFor(() => resultsOf(context.peer.received).length === 3)
  assert.deepEqual(resultsOf(context.peer.received)[2].parsed.packet, {
    v: PROTOCOL_VERSION,
    type: 'farm-action-result',
    deviceId: context.service.snapshot().self.deviceId,
    requestId: secondRequest,
    ok: false,
    error: 'already-stolen'
  })
})

test('守卫：random < guard 就 caught/guard，地块不变、日志 qty 0；日限额 3/访客', async (t) => {
  let randomValue = 0
  const context = await hostWithVisitor(t, {
    plots: [maturePlot('p1'), maturePlot('p2'), maturePlot('p3'), maturePlot('p4')],
    farmRandom: () => randomValue
  })

  // 被抓住：没有罚款，也不标 stolenBy。
  const caughtRequest = randomUUID()
  sendAction(context, { requestId: caughtRequest, plotId: 'p1' })
  await waitFor(() => resultsOf(context.peer.received).length === 1)
  assert.deepEqual(resultsOf(context.peer.received)[0].parsed.packet, {
    v: PROTOCOL_VERSION,
    type: 'farm-action-result',
    deviceId: context.service.snapshot().self.deviceId,
    requestId: caughtRequest,
    ok: false,
    error: 'guard',
    caught: true
  })
  let farm = await readFarm(context.dir)
  assert.deepEqual(farm.plots[0].stolenBy, [])
  assert.equal(farm.log[0].kind, 'steal')
  assert.equal(farm.log[0].qty, 0)
  assert.equal(farm.log[0].who, '阿蟹')
  assert.match(context.service.snapshot().notices[0].text, /被抓住了/)

  // 被抓也算一次尝试：只剩两次成功额度，之后就是 cap（不能靠换 requestId 重试到成功）。
  randomValue = 1
  for (const plotId of ['p1', 'p2']) {
    sendAction(context, { requestId: randomUUID(), plotId })
  }
  await waitFor(() => resultsOf(context.peer.received).length === 3)
  assert.equal(resultsOf(context.peer.received).slice(1).every((entry) => entry.parsed.packet.ok === true), true)
  const cappedRequest = randomUUID()
  sendAction(context, { requestId: cappedRequest, plotId: 'p3' })
  await waitFor(() => resultsOf(context.peer.received).length === 4)
  assert.deepEqual(resultsOf(context.peer.received)[3].parsed.packet, {
    v: PROTOCOL_VERSION,
    type: 'farm-action-result',
    deviceId: context.service.snapshot().self.deviceId,
    requestId: cappedRequest,
    ok: false,
    error: 'cap'
  })
  farm = await readFarm(context.dir)
  assert.equal(farm.plots.filter((plot) => plot.stolenBy.length > 0).length, 2)
  // 两次被抓的日志都写下了（每次尝试一条），但 stolenBy 只在成功时出现。
  assert.equal(farm.log.filter((entry) => entry.kind === 'steal' && entry.qty === 0).length, 1)
  assert.equal(farm.visitStats.steal.byVisitor[context.deviceId], 3, '被抓 + 两次成功 = 3 次尝试')
})

test('被抓：每次尝试都写日志且占次数，但桌面提示每位访客每天只发一次；requestId 重放心跳不重复', async (t) => {
  const context = await hostWithVisitor(t, {
    plots: [maturePlot('p1'), maturePlot('p2'), maturePlot('p3'), maturePlot('p4')],
    farmRandom: () => 0
  })

  const firstRequest = randomUUID()
  sendAction(context, { requestId: firstRequest, plotId: 'p1' })
  await waitFor(() => resultsOf(context.peer.received).length === 1)
  // 同一 requestId 重发：命中缓存，原样回放，不再写日志/不再计数。
  sendAction(context, { requestId: firstRequest, plotId: 'p1' })
  await waitFor(() => resultsOf(context.peer.received).length === 2)
  assert.deepEqual(resultsOf(context.peer.received)[1].parsed.packet,
    resultsOf(context.peer.received)[0].parsed.packet)
  let farm = await readFarm(context.dir)
  assert.equal(farm.log.length, 1)
  assert.equal(farm.visitStats.steal.byVisitor[context.deviceId], 1)
  const caughtNotices = () => context.service.snapshot().notices.filter((notice) => /被抓住了/.test(notice.text))
  assert.equal(caughtNotices().length, 1)

  // 再来两次新的被抓：占满 3 次额度；日志 3 条，桌面提示仍然只有 1 条。
  sendAction(context, { requestId: randomUUID(), plotId: 'p2' })
  await waitFor(() => resultsOf(context.peer.received).length === 3)
  sendAction(context, { requestId: randomUUID(), plotId: 'p3' })
  await waitFor(() => resultsOf(context.peer.received).length === 4)
  farm = await readFarm(context.dir)
  assert.equal(farm.log.filter((entry) => entry.qty === 0).length, 3)
  assert.equal(farm.visitStats.steal.byVisitor[context.deviceId], 3)
  assert.equal(caughtNotices().length, 1)

  sendAction(context, { requestId: randomUUID(), plotId: 'p4' })
  await waitFor(() => resultsOf(context.peer.received).length === 5)
  assert.equal(resultsOf(context.peer.received)[4].parsed.packet.error, 'cap')
  assert.deepEqual((await readFarm(context.dir)).plots.map((plot) => plot.stolenBy), PLOT_IDS.map(() => []))
})

test('帮忙：生长中 +10%、helpedBy、日志；同一块地重复 → already-helped', async (t) => {
  const context = await hostWithVisitor(t, {
    plots: [maturePlot('p1'), growingPlot('p2'), maturePlot('p3'), maturePlot('p4')]
  })
  const before = (await readFarm(context.dir)).plots[1]
  const requestId = randomUUID()
  sendAction(context, { requestId, action: 'help', plotId: 'p2' })
  await waitFor(() => resultsOf(context.peer.received).length === 1)
  const result = resultsOf(context.peer.received)[0].parsed.packet
  assert.equal(result.ok, true)
  assert.equal(result.crop, 'carrot')
  assert.equal(result.qty, 1)

  const farm = await readFarm(context.dir)
  const plot = farm.plots[1]
  assert.deepEqual(plot.helpedBy, [context.deviceId])
  assert.equal(plot.waterings, 0)
  assert.equal(plot.grownMs, before.grownMs + Math.floor(before.growMs * 0.1))
  assert.equal(farm.log[0].kind, 'help')
  assert.equal(farm.log[0].who, '阿蟹')
  assert.match(context.service.snapshot().notices[0].text, /帮忙浇水/)

  // 重发同请求幂等；新 requestId 同一块地 already-helped。
  sendAction(context, { requestId, action: 'help', plotId: 'p2' })
  await waitFor(() => resultsOf(context.peer.received).length === 2)
  assert.deepEqual(resultsOf(context.peer.received)[1].parsed.packet, result)
  sendAction(context, { requestId: randomUUID(), action: 'help', plotId: 'p2' })
  await waitFor(() => resultsOf(context.peer.received).length === 3)
  assert.equal(resultsOf(context.peer.received)[2].parsed.packet.error, 'already-helped')
})

test('授权：visitId 对不上 / deviceId 对不上都静默丢弃；串门结束后也不再回', async (t) => {
  const context = await hostWithVisitor(t, {
    plots: [maturePlot('p1'), maturePlot('p2'), maturePlot('p3'), maturePlot('p4')]
  })

  // 错误 visitId：不回结果。
  sendAction(context, { visitId: randomUUID(), requestId: randomUUID(), plotId: 'p1' })
  await delay(250)
  assert.equal(resultsOf(context.peer.received).length, 0)

  // 正确 visitId、但冒用别人的 deviceId：同样静默。
  sendAction(context, { deviceId: randomUUID(), requestId: randomUUID(), plotId: 'p1' })
  await delay(250)
  assert.equal(resultsOf(context.peer.received).length, 0)

  // 正常一偷之后送客：同一个 visitId 不再回结果。
  sendAction(context, { requestId: randomUUID(), plotId: 'p1' })
  await waitFor(() => resultsOf(context.peer.received).length === 1)
  const ended = await callAction(context.service, { action: 'end-visit', deviceId: context.deviceId })
  assert.equal(ended.status, 200)
  assert.deepEqual(context.service.snapshot().visitors, [])
  sendAction(context, { requestId: randomUUID(), plotId: 'p2' })
  await delay(300)
  assert.equal(resultsOf(context.peer.received).length, 1)
})

test('日限额跨日重置：同一访客第二天又能偷 3 次（store 的 day 键）', async (t) => {
  const context = await hostWithVisitor(t, {
    plots: [maturePlot('p1'), maturePlot('p2'), maturePlot('p3'), maturePlot('p4')]
  })
  // 直接改 farm.json 的 visitStats.day 到昨天，模拟“第二天重新打开”。
  const farm = await readFarm(context.dir)
  farm.visitStats = {
    day: '2000-01-01',
    steal: { total: 3, byVisitor: { [context.deviceId]: 3 } },
    help: { total: 0, byVisitor: {} },
    mine: { steal: 0, help: 0 }
  }
  await context.service.dispose()
  await writeFile(join(context.dir, FARM_FILE), JSON.stringify(farm), 'utf8')

  // 重新起一台同目录服务（旧服务已 dispose，端口空闲）。
  const peer2 = await loopbackPeer(t)
  const peerPort = peer2.socket.address().port
  const servicePort = await freeUdpPort()
  const restarted = makeService(t, {
    dataDir: context.dir,
    petConfigPath: join(context.dir, 'missing.jsonc'),
    network: true,
    port: servicePort,
    targetPort: peerPort,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 60000,
    visitTickMs: 10,
    tickIntervalMs: 50,
    farmNow: () => NOON,
    farmRandom: () => 1
  })
  await restarted.ready
  const deviceId = randomUUID()
  const visitId = randomUUID()
  peer2.socket.send(Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION, type: 'beacon', deviceId, nickname: '阿蟹', port: peerPort
  })), servicePort, '127.0.0.1')
  await waitFor(() => restarted.snapshot().neighbors.length === 1)
  await callAction(restarted, { action: 'admit', deviceId })
  peer2.socket.send(Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION, type: 'visit-request', deviceId, visitId, nickname: '阿蟹', anim: null, skinPort: peerPort
  })), servicePort, '127.0.0.1')
  await waitFor(() => restarted.snapshot().visitors.length === 1)

  const requestId = randomUUID()
  peer2.socket.send(encodeFarmAction({ deviceId, visitId, requestId, action: 'steal', plotId: 'p1' }), servicePort, '127.0.0.1')
  await waitFor(() => resultsOf(peer2.received).length === 1)
  assert.equal(resultsOf(peer2.received)[0].parsed.packet.ok, true)
})

test('同一 requestId 连发两包（in-flight 重发）：只落账一次，两包回同一结果', async (t) => {
  const context = await hostWithVisitor(t, {
    plots: [maturePlot('p1'), maturePlot('p2'), maturePlot('p3'), maturePlot('p4')]
  })
  const requestId = randomUUID()
  // 不等第一包结果就连发第二包：第一次的磁盘写可能还没完成，靠 in-flight 去重。
  sendAction(context, { requestId, plotId: 'p1' })
  sendAction(context, { requestId, plotId: 'p1' })
  await waitFor(() => resultsOf(context.peer.received).length === 2)
  const [first, second] = resultsOf(context.peer.received).map((entry) => entry.parsed.packet)
  assert.deepEqual(first, second)
  assert.equal(first.ok, true)
  const farm = await readFarm(context.dir)
  assert.equal(farm.plots[0].stolenBy.length, 1)
  assert.equal(farm.log.filter((entry) => entry.kind === 'steal').length, 1)
})
