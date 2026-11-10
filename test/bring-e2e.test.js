/**
 * 票 24：背包（发送端）+ 右键「带派」小窗的宿主侧。
 *
 * 覆盖三件事，全部走真实的 service / 磁盘 / UDP：
 *   1. `POST /dsh-zoo/action` 的 bring/unbring 与错误码；菜单 bring 打开小窗并收到背包快照；
 *      小窗提交（helper 事件）与宿主 action-result 回路。
 *   2. 出门自动带最旧的一件；三次重发带的是**同一个** gift 对象；out 中不能撤。
 *   3. 文件礼物的 name/size/sha256 在发送那一刻才读；文件消失时空手出门、留在背包、留一句人话。
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import dgram from 'node:dgram'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BACKPACK_FILE, MAX_BACKPACK_ITEMS } from '../src/backpack.js'
import { MAX_GIFT_BYTES, parsePacket } from '../src/protocol.js'
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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-bring-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeService (t, options = {}) {
  const { ctx, routes } = fakeCtx()
  const service = createService(ctx, {
    petBridge: false,
    skinServer: false,
    ...options
  })
  service.routes = routes
  t.after(() => service.dispose())
  return service
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

/** 只记录窗口命令与 action-result 的桌面替身；不 spawn Electron。 */
function desktopDouble () {
  const calls = { windows: [], results: [] }
  let onEvent = null
  return {
    calls,
    factory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update () { return true },
        resync () { return true },
        bringWindow (payload) {
          calls.windows.push(payload)
          return true
        },
        actionResult (id, result) {
          calls.results.push({ id, result })
        },
        dispose () {}
      }
    },
    emit (event) {
      onEvent?.(event)
    }
  }
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
    received.push({ message, rinfo })
  })
  return { socket, received }
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

function visitRequests (received, parse) {
  return received.filter((entry) => {
    const parsed = parse(entry.message)
    return parsed.ok && parsed.packet.type === 'visit-request'
  }).map((entry) => parse(entry.message).packet)
}

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
    tickIntervalMs: 50,
    ...options
  })
  await service.ready
  const deviceId = randomUUID()
  peer.socket.send(beaconPayload({ deviceId, nickname: '隔壁同事', port: peerPort }), servicePort, '127.0.0.1')
  await waitFor(() => service.snapshot().neighbors.length === 1)
  assert.equal((await callAction(service, { action: 'admit', deviceId })).status, 200)
  return { service, peer, deviceId, servicePort }
}

// ---------------------------------------------------------------------------
// 1) 背包动作 + 小窗回路
// ---------------------------------------------------------------------------

test('背包动作：bring/unbring 的成功与错误码；菜单 bring 开窗，小窗提交走 action-result', async (t) => {
  const dir = await tempDir(t)
  const desktop = desktopDouble()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktopFactory: desktop.factory
  })
  await service.ready

  // 右键「带派」：只发一个空动作，宿主开窗并把背包（此时为空）交给 helper。
  const opened = await callAction(service, { action: 'bring' })
  assert.equal(opened.status, 200)
  assert.equal(opened.body.ok, true)
  assert.equal(opened.body.window, 'opened')
  assert.equal(desktop.calls.windows.length, 1)
  assert.deepEqual(desktop.calls.windows[0], { open: true, items: [] })

  // 小窗/HTTP 放进第一件：宿主刷新已经开着的窗（open:false + 背包内容）。
  const first = await callAction(service, { action: 'bring', kind: 'text', text: '  第一行\n第二行  ' })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.count, 1)
  assert.equal(desktop.calls.windows.length, 2)
  assert.equal(desktop.calls.windows[1].open, false)
  assert.equal(desktop.calls.windows[1].items.length, 1)
  assert.equal(desktop.calls.windows[1].items[0].kind, 'text')
  assert.equal(desktop.calls.windows[1].items[0].text, '第一行\n第二行')
  assert.equal('path' in desktop.calls.windows[1].items[0], false)

  // 文本上限：超 500 码点是 bad-gift，不静默截断。
  const tooLong = await callAction(service, { action: 'bring', kind: 'text', text: '字'.repeat(501) })
  assert.equal(tooLong.status, 409)
  assert.equal(tooLong.body.error, 'bad-gift')

  const second = await callAction(service, { action: 'bring', kind: 'text', text: '第二件' })
  assert.equal(second.status, 200)
  assert.equal((await readBackpack(dir)).items.length, MAX_BACKPACK_ITEMS)

  // 满了拒绝，不挤掉旧件。
  const full = await callAction(service, { action: 'bring', kind: 'text', text: '第三件' })
  assert.equal(full.status, 409)
  assert.equal(full.body.error, 'backpack-full')
  assert.match(full.body.notice, /两件/)

  // 撤掉 idle 件；再撤一次是 gift-not-found；坏 id 是 bad-gift。
  const removed = await callAction(service, { action: 'unbring', giftId: first.body.giftId })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.count, 1)
  assert.equal(desktop.calls.windows.at(-1).items.length, 1)
  assert.equal((await callAction(service, { action: 'unbring', giftId: first.body.giftId })).body.error, 'gift-not-found')
  assert.equal((await callAction(service, { action: 'unbring', giftId: 'gift-1' })).body.error, 'bad-gift')

  // 小窗提交：helper 事件 → 宿主放进背包 → action-result 回窗（成功；bring 成功会由主进程关窗）。
  desktop.emit({
    type: 'action',
    id: 'gift-1',
    action: 'bring',
    gift: { kind: 'text', text: '从窗口来' }
  })
  await waitFor(() => desktop.calls.results.length === 1)
  assert.deepEqual(desktop.calls.results[0], {
    id: 'gift-1',
    result: { ok: true, notice: null, error: null }
  })
  assert.equal((await readBackpack(dir)).items.some((item) => item.text === '从窗口来'), true)

  // 小窗撤一件：action-result 成功；再撤同一件失败并带人话 notice。
  const current = (await readBackpack(dir)).items.at(-1)
  desktop.emit({ type: 'action', id: 'gift-2', action: 'unbring', giftId: current.id })
  await waitFor(() => desktop.calls.results.length === 2)
  assert.equal(desktop.calls.results[1].result.ok, true)
  desktop.emit({ type: 'action', id: 'gift-3', action: 'unbring', giftId: current.id })
  await waitFor(() => desktop.calls.results.length === 3)
  assert.equal(desktop.calls.results[2].result.ok, false)
  assert.match(desktop.calls.results[2].result.notice, /没有这件东西/)

  // 桌面层关着时，空手 bring 不能静默成功。
  const offline = makeService(t, {
    dataDir: await tempDir(t),
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    desktop: false
  })
  await offline.ready
  const noDesktop = await callAction(offline, { action: 'bring' })
  assert.equal(noDesktop.status, 409)
  assert.equal(noDesktop.body.error, 'desktop-off')
  assert.match(noDesktop.body.notice, /带派/)
})

// ---------------------------------------------------------------------------
// 2) 出门自动带最旧的一件 + 重发同一对象
// ---------------------------------------------------------------------------

test('出门自动带 at 最小的那件；三次重发带同一个 gift；out 中不能撤', async (t) => {
  const dir = await tempDir(t)
  const { service, peer, deviceId } = await admittedPeer(t, dir)

  const first = await callAction(service, { action: 'bring', kind: 'text', text: '先放的' })
  const second = await callAction(service, { action: 'bring', kind: 'text', text: '后放的' })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)

  const started = await callAction(service, { action: 'visit', deviceId })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.giftId, first.body.giftId)

  // 对方不 ack：service 必须按计划补发三次，而且三次带的是**同一件**。
  await waitFor(() => visitRequests(peer.received, serviceParse).length >= 3)
  const requests = visitRequests(peer.received, serviceParse)
  assert.equal(requests.length >= 3, true)
  const gifts = requests.slice(0, 3).map((packet) => packet.gift)
  assert.deepEqual(gifts[0], { id: first.body.giftId, kind: 'text', text: '先放的' })
  for (const gift of gifts) assert.deepEqual(gift, gifts[0])

  // 发出去了就是 out：东西可能已经在对方磁盘上，不能撤。
  await waitFor(async () => (await readBackpack(dir)).items[0].state === 'out')
  const raw = await readBackpack(dir)
  assert.equal(raw.items[0].id, first.body.giftId)
  assert.equal(raw.items[0].state, 'out')
  const unbring = await callAction(service, { action: 'unbring', giftId: first.body.giftId })
  assert.equal(unbring.status, 409)
  assert.equal(unbring.body.error, 'gift-out')

  // 第二件还留在背包里（第一件在 out 也占位，这正是“满了两件”的语义）。
  assert.equal(raw.items[1].id, second.body.giftId)
})

/** parsePacket 单独包一层，便于在 filter 里读包。 */
function serviceParse (message) {
  return parsePacket(message)
}

// ---------------------------------------------------------------------------
// 3) 文件件：发送那一刻读元数据；源文件消失不挡串门
// ---------------------------------------------------------------------------

test('文件礼物：发送时才读 size/sha256；报文里没有路径；三次重发仍是同一对象', async (t) => {
  const dir = await tempDir(t)
  const { service, peer, deviceId } = await admittedPeer(t, dir)

  const file = join(dir, '报价单.pdf')
  const content = '这是一份报价单'
  await writeFile(file, content)
  const added = await callAction(service, { action: 'bring', kind: 'file', path: file })
  assert.equal(added.status, 200)
  assert.equal(added.body.ok, true)

  // 背包里只有路径 + name：size/sha256 不在磁盘上（发送那一刻才算）。
  const raw = await readBackpack(dir)
  assert.equal(raw.items[0].path, file)
  assert.equal(raw.items[0].name, '报价单.pdf')
  assert.equal('size' in raw.items[0], false)
  assert.equal('sha256' in raw.items[0], false)

  const started = await callAction(service, { action: 'visit', deviceId })
  assert.equal(started.status, 200)
  assert.equal(started.body.giftId, added.body.giftId)

  await waitFor(() => visitRequests(peer.received, serviceParse).length >= 3)
  const requests = visitRequests(peer.received, serviceParse).slice(0, 3)
  const expected = {
    id: added.body.giftId,
    kind: 'file',
    name: '报价单.pdf',
    size: Buffer.byteLength(content),
    sha256: 'sha256:' + createHash('sha256').update(content).digest('hex')
  }
  assert.deepEqual(requests[0].gift, expected)
  assert.equal('path' in requests[0].gift, false)
  for (const packet of requests) assert.deepEqual(packet.gift, expected)
})

test('文件在放进背包之后被删：这次空手出门，东西留在背包，本机留一句人话', async (t) => {
  const dir = await tempDir(t)
  const { service, peer, deviceId } = await admittedPeer(t, dir)

  const file = join(dir, '会被删掉.pdf')
  await writeFile(file, '再见')
  const added = await callAction(service, { action: 'bring', kind: 'file', path: file })
  assert.equal(added.status, 200)
  await rm(file)

  const started = await callAction(service, { action: 'visit', deviceId })
  assert.equal(started.status, 200)
  assert.equal(started.body.ok, true)
  assert.equal(started.body.giftDropped, false)
  assert.match(started.body.notice, /会被删掉\.pdf/)
  assert.match(started.body.notice, /找不到了/)

  // 串门照常发出去；这一次没有 gift 字段。
  await waitFor(() => visitRequests(peer.received, serviceParse).length >= 1)
  assert.equal('gift' in visitRequests(peer.received, serviceParse)[0], false)
  assert.equal(service.snapshot().notices.some((notice) => /找不到了/.test(notice.text)), true)

  // 东西还在背包里、仍是 idle，下一次可以再试（不会因为一次失败被吃掉）。
  const raw = await readBackpack(dir)
  assert.equal(raw.items[0].id, added.body.giftId)
  assert.equal(raw.items[0].state, 'idle')

  // 超过 16 MiB 的文件在 bring 入口就拒绝（不占背包）。
  const tooLarge = join(dir, 'big.bin')
  await writeFile(tooLarge, '')
  await truncate(tooLarge, MAX_GIFT_BYTES + 1)
  assert.equal((await callAction(service, { action: 'unbring', giftId: added.body.giftId })).status, 200)
  const rejected = await callAction(service, { action: 'bring', kind: 'file', path: tooLarge })
  assert.equal(rejected.status, 409)
  assert.equal(rejected.body.error, 'too-large')
})
