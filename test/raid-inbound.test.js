/**
 * 票 51：免放行的入站偷菜。
 *
 * 一台真 service（主人侧）+ 一颗裸 UDP socket（偷的那只）。**不建立任何放行关系**，
 * 直接发 `visit-request(purpose:'steal')`，看主人是不是照收、按地块落账、
 * 把结果塞进 ack，并且把这只宠物登记成 `kind:'raid'`。
 */
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

import { FARM_FILE, initialFarmState } from '../src/farm.js'
import { CROPS } from '../src/farm-rules.js'
import { encodePacket, parsePacket } from '../src/protocol.js'
import { createService } from '../src/service.js'

const THIEF = '33333333-3333-4333-8333-333333333333'

test('没放行的邻居也能来偷：ack 带结果，主人侧留记录', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-raid-in-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

  const farm = initialFarmState()
  const plot = farm.plots.find((candidate) => candidate.id === 'p1')
  Object.assign(plot, {
    crop: 'tomato',
    plantedAt: Date.now() - CROPS.tomato.growMs,
    grownMs: CROPS.tomato.growMs,
    growMs: CROPS.tomato.growMs
  })
  await writeFile(join(dir, FARM_FILE), JSON.stringify(farm), 'utf8')

  const socket = await peerSocket(t)
  const inbox = collect(socket)
  const service = makeService(t, dir, { farmRandom: () => 1, targetPort: socket.address().port })

  // 1) 先让它知道服务端口：beacon-ack 里有 port。UDP socket 是异步起来的，重试几拍再判失败。
  const ack = await handshake(socket, inbox, service.port)
  assert.equal(ack.packet.port, service.port)

  // 在同一份证据里确认能力声明：主人的广播自己说得出「我能被偷、也能被看」。
  const beacon = inbox.packets.find((entry) => entry.packet.type === 'beacon')
  assert.deepEqual(beacon.packet.caps, ['raid', 'look'])

  // 2) 直接来偷：不放行、不串门，只说"我来拿 p1"。
  const visitId = randomUUID()
  socket.send(
    encodePacket({
      type: 'visit-request',
      deviceId: THIEF,
      visitId,
      nickname: '小蓝',
      anim: '待机',
      purpose: 'steal',
      plots: ['p1', 'p9']
    }),
    service.port,
    '127.0.0.1'
  )

  const result = await inbox.waitFor('visit-ack')
  assert.equal(result.packet.raid.stolen.length, 1, JSON.stringify(result.packet))
  assert.deepEqual(result.packet.raid.stolen[0], { plot: 'p1', crop: 'tomato' })
  assert.equal(result.packet.raid.caught, 0)
  assert.deepEqual(result.packet.raid.skipped, ['p9'], '空地进 skipped，不算被抓')

  const state = await getState(service)
  const p1 = state.farm.plots.find((candidate) => candidate.id === 'p1')
  assert.deepEqual(p1.stolenBy, [THIEF], '主人这块地被这位偷过了')
  assert.equal(p1.crop, 'tomato', '地块本身还在（收获时才少一个）')
  assert.equal(state.visitors.length, 1)
  assert.equal(state.visitors[0].kind, 'raid')
  assert.equal(state.visitors[0].deviceId, THIEF)
  assert.ok(Number.isFinite(state.visitors[0].endsAt), '偷客有到期时间')
  assert.ok(state.farm.log.some((entry) => entry.kind === 'steal'))
})

test('同一块地一轮只偷一次：第二遍进 skipped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-raid-twice-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

  const farm = initialFarmState()
  Object.assign(farm.plots.find((p) => p.id === 'p1'), {
    crop: 'carrot',
    plantedAt: Date.now() - CROPS.carrot.growMs,
    grownMs: CROPS.carrot.growMs,
    growMs: CROPS.carrot.growMs
  })
  await writeFile(join(dir, FARM_FILE), JSON.stringify(farm), 'utf8')

  const socket = await peerSocket(t)
  const inbox = collect(socket)
  const service = makeService(t, dir, { farmRandom: () => 1, targetPort: socket.address().port })
  await settle()

  const steal = async (visitId) => {
    socket.send(
      encodePacket({
        type: 'visit-request',
        deviceId: THIEF,
        visitId,
        nickname: '小蓝',
        anim: '待机',
        purpose: 'steal',
        plots: ['p1']
      }),
      service.port,
      '127.0.0.1'
    )
    return (await inbox.waitFor('visit-ack')).packet.raid
  }

  const first = await steal(randomUUID())
  assert.deepEqual(first.stolen, [{ plot: 'p1', crop: 'carrot' }])

  // 同一块地第二轮：不算偷到，落到 skipped（而不是被抓、也不重复落账）。
  const second = await steal(randomUUID())
  assert.deepEqual(second.stolen, [])
  assert.deepEqual(second.skipped, ['p1'])
})

test('普通串门照旧：没放行就 deny（免放行只对来偷）', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-raid-plain-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

  const socket = await peerSocket(t)
  const inbox = collect(socket)
  const service = makeService(t, dir, { targetPort: socket.address().port })
  await settle()

  socket.send(
    encodePacket({
      type: 'visit-request',
      deviceId: THIEF,
      visitId: randomUUID(),
      nickname: '小蓝',
      anim: '待机'
    }),
    service.port,
    '127.0.0.1'
  )

  const denied = await inbox.waitFor('visit-deny')
  assert.equal(denied.packet.reason, 'not-admitted')
  assert.equal((await getState(service)).visitors.length, 0)
})

// ---------------------------------------------------------------------------

function fakeCtx () {
  const routes = []
  return {
    ctx: {
      webServer: { register (options) { routes.push(options); return () => {} } },
      logger: { info () {}, warn () {} }
    },
    routes
  }
}

function makeService (t, dir, overrides = {}) {
  const { ctx, routes } = fakeCtx()
  const port = freeUdpPort()
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: true,
    port,
    targetPort: port + 1,
    bindAddress: '127.0.0.1',
    broadcastAddress: '127.0.0.1',
    beaconIntervalMs: 60000,
    heartbeatIntervalMs: 2000,
    tickIntervalMs: 20,
    desktop: false,
    petBridge: false,
    ...overrides
  })
  service.routes = routes
  service.port = port
  t.after(() => service.dispose())
  return service
}

function freeUdpPort () {
  // 随机挑一个高位端口：从系统时钟取，撞了大概率也还能用（服务端 bind 失败会让测试炸出来）
  return 45000 + Math.floor(Math.random() * 2000)
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
    try { socket.close() } catch { /* 已经关了 */ }
  })
  return socket
}

/** 打个照面：反复发 beacon 直到服务端回 beacon-ack（它的 UDP socket 是异步绑定的）。 */
function settle (ms = 150) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function handshake (socket, inbox, servicePort) {
  const data = encodePacket({
    type: 'beacon',
    deviceId: THIEF,
    nickname: '小蓝',
    port: socket.address().port,
    caps: ['raid']
  })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    socket.send(data, servicePort, '127.0.0.1')
    try {
      return await inbox.waitFor('beacon-ack', 1500)
    } catch {
      // 还没起来，再敲一次（回环有 20 包/10 秒的额度，别敲太勤）
    }
  }
  throw new Error('服务端一直没有回 beacon-ack')
}

function collect (socket) {
  const packets = []
  socket.on('message', (data) => {
    const parsed = parsePacket(data)
    if (parsed.ok) packets.push({ packet: parsed.packet, at: Date.now() })
  })

  // 取走即消费：同一个类型连着来三次，三次 `waitFor` 必须各拿到一条新的，
  // 不能每次都把最早那条再返回一遍。
  return {
    packets,
    async waitFor (type, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const index = packets.findIndex((entry) => entry.packet.type === type)
        if (index >= 0) return packets.splice(index, 1)[0]
        if (Date.now() >= deadline) {
          throw new Error('没等到 ' + type + '；收到过：' + packets.map((e) => e.packet.type).join(', '))
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  }
}

async function getState (service) {
  const route = service.routes.find((candidate) => candidate.path === '/dsh-zoo/state')
  assert.ok(route, '应该注册 /dsh-zoo/state')
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
    end (payload) { this.payload = payload }
  }
  await route.handler({ method: 'GET', on () {}, destroy () {} }, res)
  return JSON.parse(res.payload)
}
