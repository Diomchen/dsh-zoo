/**
 * 票 42：行情 gossip 的端到端路径。
 *
 * 1. 两个真 service 在回环上互相发现、双向放行 → digest 收敛成同一个中位数；
 *    本机成交后立刻补发，另一台的指数跟着变。
 * 2. 假 peer：放行后才收得到 digest；同一 peer 的行情按窗口限速；坏包不崩。
 * 3. 没放行时不发；发出去不等 ack、不重试（下一轮 30 秒自然补）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_HIRE, FARM_VERSION, PLOT_IDS, emptyPlot } from '../src/farm.js'
import { localDayKey } from '../src/farm-rules.js'
import { MARKET_VERSION } from '../src/market.js'
import { PROTOCOL_VERSION, parsePacket } from '../src/protocol.js'
import { createService } from '../src/service.js'

const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-market-digest-'))
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
  return { socket, port: socket.address().port, received }
}

function digests (peer) {
  return peer.received.filter((entry) => entry.parsed.ok && entry.parsed.packet.type === 'market-digest')
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

function digestPayload ({ deviceId, at, prices, hire }) {
  return Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'market-digest',
    deviceId,
    at,
    prices,
    hire
  }), 'utf8')
}

function send (peer, payload, port) {
  peer.socket.send(payload, port, '127.0.0.1')
}

function twoInstanceOptions (dir, port, targetPort, overrides = {}) {
  return {
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
    marketDigestMs: 80,
    ...overrides
  }
}

function makeClock (start = NOON) {
  let value = start
  return {
    now: () => value,
    advance (ms) { value += ms }
  }
}

function marketFile (tomatoPrice) {
  return {
    version: MARKET_VERSION,
    prices: {
      tomato: { base: 5, price: tomatoPrice, volume24h: 0, at: NOON },
      carrot: { base: 6, price: 6, volume24h: 0, at: NOON },
      pumpkin: { base: 30, price: 30, volume24h: 0, at: NOON }
    },
    history: [],
    index: {}
  }
}

function farmFile (hire = DEFAULT_HIRE) {
  const day = localDayKey(NOON)
  return {
    version: FARM_VERSION,
    coins: 30,
    seeds: {},
    crops: { tomato: 10 },
    dew: 0,
    dewEarned: 0,
    dewAt: NOON,
    dewDay: day,
    dewDayEarned: day,
    lastTickAt: NOON,
    plots: PLOT_IDS.map(emptyPlot),
    hire: { ...hire },
    log: []
  }
}

async function call (service, path, { method = 'GET', body } = {}) {
  const route = service.routes.find((candidate) => candidate.path === path)
  assert.ok(route, '应该注册 ' + path)
  const res = {
    statusCode: 0,
    setHeader () {},
    end (payload) { this.payload = payload }
  }
  const req = {
    method,
    _listeners: {},
    on (event, fn) {
      this._listeners[event] = fn
      return this
    },
    destroy () {}
  }
  const pending = route.handler(req, res)
  if (body !== undefined) {
    queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body))))
    queueMicrotask(() => req._listeners.end?.())
  }
  await pending
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}

function action (service, body) {
  return call(service, '/dsh-zoo/action', { method: 'POST', body })
}

// ---------------------------------------------------------------------------

test('两个 service：双向放行后指数收敛到同一中位数；成交后立刻广播，对面跟着变', async (t) => {
  const dirA = await tempDir(t)
  const dirB = await tempDir(t)
  await writeFile(join(dirA, 'market.json'), JSON.stringify(marketFile(10)), 'utf8')
  await writeFile(join(dirA, 'farm.json'), JSON.stringify(farmFile()), 'utf8')
  const [portA, portB] = await distinctPorts(2)
  // 这里用真实时钟：1 peer / 窗口的限速按墙钟走，假时钟不动会把后续 digest 全挡掉。
  const b = makeService(t, twoInstanceOptions(dirB, portB, portA))
  await b.ready
  const a = makeService(t, twoInstanceOptions(dirA, portA, portB))
  await a.ready
  await waitFor(() => a.snapshot().neighbors.length === 1 && b.snapshot().neighbors.length === 1)

  const aId = a.snapshot().self.deviceId
  const bId = b.snapshot().self.deviceId
  assert.equal(a.room.admit(bId).ok, true)
  assert.equal(b.room.admit(aId).ok, true)

  // A 的 tomato 10、B 的 5；指数只取 peer 价，所以 A 看到 5、B 看到 10（样本都只有 1 个）。
  await waitFor(() => a.snapshot().market.index.tomato?.samples === 1 &&
    b.snapshot().market.index.tomato?.samples === 1)
  assert.equal(a.snapshot().market.index.tomato.price, 5)
  assert.equal(b.snapshot().market.index.tomato.price, 10)
  assert.ok(a.snapshot().market.index.tomato.at > NOON, '指数 at 是 digest 的本地时钟')
  assert.ok(b.snapshot().market.index.tomato.at > NOON)

  // `GET /state` 的 market.index 就是 `{price, at, samples}`，不带窗口用的 stale。
  const state = await call(b, '/dsh-zoo/state')
  const stateIndex = state.body.market.index.tomato
  assert.equal(stateIndex.price, 10)
  assert.equal(stateIndex.samples, 1)
  assert.deepEqual(Object.keys(stateIndex).sort(), ['at', 'price', 'samples'])

  // A 卖 3 个：本机价 10 → 9.82，digest 立刻补发；B 的指数从 10 → 9.82（peer 价就是 A 的本机价）。
  const sold = await action(a, { action: 'sell-crop', cropId: 'tomato', qty: 3 })
  assert.equal(sold.body.ok, true)
  assert.ok(Math.abs(sold.body.price - 9.82) < 1e-9)
  await waitFor(() => {
    const index = b.snapshot().market.index.tomato
    return index !== undefined && Math.abs(index.price - 9.82) < 1e-9
  })
  assert.equal(b.snapshot().market.index.tomato.samples, 1)
  // A 仍看 B 的 5；成交不会把本机价混进自己的指数。
  assert.equal(a.snapshot().market.index.tomato.price, 5)
  assert.equal(a.snapshot().market.index.tomato.samples, 1)
})

test('假 peer：放行才收得到 digest；同一 peer 限速 1 条/窗口；坏包不崩', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'farm.json'), JSON.stringify(farmFile({
    enabled: true,
    wagePerHour: 20,
    minHours: 3,
    maxHours: 6
  })), 'utf8')
  const peer = await loopbackPeer(t)
  const servicePort = await freeUdpPort()
  const clock = makeClock()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    port: servicePort,
    targetPort: peer.port,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 60000,
    tickIntervalMs: 10,
    marketDigestMs: 200,
    marketNow: clock.now,
    farmNow: clock.now
  })
  await service.ready

  const deviceId = randomUUID()
  send(peer, beaconPayload({ deviceId, nickname: '行情邻居', port: peer.port }), servicePort)
  await waitFor(() => service.snapshot().neighbors.some((neighbor) => neighbor.deviceId === deviceId))

  // 还没放行：等过一个发送窗口，一个 digest 都不该来；对方发来的行情也不该进指数。
  await delay(300)
  assert.equal(digests(peer).length, 0, '未放行邻居收不到行情')
  send(peer, digestPayload({
    deviceId,
    at: clock.now(),
    prices: { tomato: 8, carrot: 6, pumpkin: 30 },
    hire: {
      enabled: false,
      wagePerHour: 10,
      minHours: 2,
      maxHours: 8,
      guard: 0.5,
      available: false,
      reason: null
    }
  }), servicePort)
  await delay(60)
  assert.deepEqual(service.snapshot().market.index.tomato, { price: 5, at: NOON, samples: 0 },
    '未放行邻居的行情不进指数；没有 peer 时指数 = 本机、samples 0')

  assert.equal((await action(service, { action: 'admit', deviceId })).status, 200)
  await waitFor(() => digests(peer).length >= 1)
  const first = digests(peer)[0].parsed.packet
  assert.deepEqual(Object.keys(first), ['v', 'type', 'deviceId', 'at', 'prices', 'hire'])
  assert.equal(first.deviceId, service.snapshot().self.deviceId)
  assert.deepEqual(Object.keys(first.prices).sort(), ['carrot', 'pumpkin', 'tomato'])
  // 挂牌发 farm.json 的值 + 雇工贡献的 0.5；available/reason 来自真实在家状态。
  assert.deepEqual(first.hire, {
    enabled: true,
    wagePerHour: 20,
    minHours: 3,
    maxHours: 6,
    guard: 0.5,
    available: true,
    reason: 'ready'
  })

  // 真实可用性：串门中 → visiting；打工中 → working；关掉挂牌 → off。
  const hireMark = digests(peer).length
  const visitId = randomUUID()
  assert.equal(service.room.beginVisit(deviceId, { visitId, at: Date.now() }).ok, true)
  service.sendMarketDigest({ force: true })
  await waitFor(() => digests(peer).length > hireMark)
  assert.deepEqual(digests(peer).at(-1).parsed.packet.hire, { ...first.hire, available: false, reason: 'visiting' })
  service.room.recallOutbound(Date.now())

  const workStart = Date.now()
  const contractId = randomUUID()
  const begun = service.room.beginWorking({
    contractId,
    employerDeviceId: deviceId,
    employerNickname: '行情邻居',
    startedAt: workStart,
    endsAt: workStart + 2 * 60 * 60 * 1000,
    guard: 0.5
  }, workStart)
  assert.equal(begun.ok, true)
  service.sendMarketDigest({ force: true })
  await waitFor(() => digests(peer).length > hireMark + 1)
  assert.deepEqual(digests(peer).at(-1).parsed.packet.hire, { ...first.hire, available: false, reason: 'working' })
  service.room.endWorking(contractId, { at: workStart + 1000, reason: 'recall' })

  const off = await action(service, {
    action: 'hire-listing',
    enabled: false,
    wagePerHour: 20,
    minHours: 3,
    maxHours: 6
  })
  assert.equal(off.status, 200)
  await waitFor(() => {
    const last = digests(peer).at(-1)?.parsed.packet
    return last?.hire?.reason === 'off' && last.hire.available === false
  })

  // 第一条合法 digest：本机 5 + peer 8 → 指数 8（不含本机）。
  send(peer, digestPayload({
    deviceId,
    at: clock.now(),
    prices: { tomato: 8, carrot: 6, pumpkin: 30 },
    hire: first.hire
  }), servicePort)
  await waitFor(() => Math.abs((service.snapshot().market.index.tomato?.price ?? 0) - 8) < 1e-9)
  assert.equal(service.snapshot().market.index.tomato.samples, 1)

  // 同一窗口里的第二条被限速丢掉：仍是 6.5。
  send(peer, digestPayload({
    deviceId,
    at: clock.now(),
    prices: { tomato: 9, carrot: 6, pumpkin: 30 },
    hire: first.hire
  }), servicePort)
  await delay(80)
  assert.equal(service.snapshot().market.index.tomato.price, 8, '1 peer / 窗口最多 1 条')

  // 坏包（未知类型 / 坏挂牌 / 越界价格）既不更新指数，也不把服务弄崩。
  const before = JSON.stringify(service.snapshot().market.index)
  peer.socket.send(Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'work-nope',
    deviceId,
    at: clock.now()
  }), 'utf8'), servicePort, '127.0.0.1')
  send(peer, digestPayload({
    deviceId,
    at: clock.now(),
    prices: { tomato: 5 },
    hire: { ...first.hire, wagePerHour: 999 }
  }), servicePort)
  send(peer, digestPayload({
    deviceId,
    at: clock.now(),
    prices: { tomato: 999, carrot: -1 },
    hire: first.hire
  }), servicePort)
  await delay(80)
  assert.equal(JSON.stringify(service.snapshot().market.index), before, '坏 digest 不影响已有指数')
  assert.equal((await call(service, '/dsh-zoo/state')).status, 200, '服务还活着')

  // 过了窗口，新的合法 digest 才进来：指数 = peer 9。
  clock.advance(250)
  send(peer, digestPayload({
    deviceId,
    at: clock.now(),
    prices: { tomato: 9, carrot: 6, pumpkin: 30 },
    hire: first.hire
  }), servicePort)
  await waitFor(() => Math.abs((service.snapshot().market.index.tomato?.price ?? 0) - 9) < 1e-9)
  assert.equal(service.snapshot().market.index.tomato.samples, 1)

  // 拒绝这位邻居：它已经送来的价格也不再影响本机指数，退回本机价 / samples 0。
  assert.equal((await action(service, { action: 'reject', deviceId })).status, 200)
  assert.deepEqual(service.snapshot().market.index.tomato, { price: 5, at: clock.now(), samples: 0 })
})

test('行情不重试：一条 digest 没有回执，窗口内不会连发', async (t) => {
  const dir = await tempDir(t)
  const peer = await loopbackPeer(t)
  const servicePort = await freeUdpPort()
  const clock = makeClock()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    port: servicePort,
    targetPort: peer.port,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 60000,
    tickIntervalMs: 10,
    marketDigestMs: 10000,
    marketNow: clock.now,
    farmNow: clock.now
  })
  await service.ready

  const deviceId = randomUUID()
  send(peer, beaconPayload({ deviceId, nickname: '沉默邻居', port: peer.port }), servicePort)
  await waitFor(() => service.snapshot().neighbors.some((neighbor) => neighbor.deviceId === deviceId))
  assert.equal((await action(service, { action: 'admit', deviceId })).status, 200)

  await waitFor(() => digests(peer).length === 1)
  await delay(250)
  assert.equal(digests(peer).length, 1, '没有 ack 也不重发；下一轮靠 30 秒节拍')

  // 价格没变、时间没到：手动触发也只在 force 时发；正常调用返回 0。
  assert.equal(service.sendMarketDigest(), 0)
  assert.equal(digests(peer).length, 1)
})
