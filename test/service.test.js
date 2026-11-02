import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { IDENTITY_FILE, defaultNickname } from '../src/identity.js'
import { PEERS_FILE } from '../src/peers.js'
import { PEER_LOST_MS, isDeviceId, normalizeNickname } from '../src/protocol.js'
import { createService } from '../src/service.js'
import { DEFAULT_ACCEPT_VISITS, DEFAULT_AUTO_VISITS, SETTINGS_FILE, SETTINGS_VERSION } from '../src/settings.js'
import { VISITS_FILE } from '../src/visits.js'

function fakeCtx () {
  const routes = []
  const warnings = []
  const handlers = new Map()
  const ctx = {
    webServer: {
      register (options) {
        routes.push(options)
        return () => {}
      }
    },
    logger: {
      info () {},
      warn (line) { warnings.push(line) }
    },
    on (name, fn, options) {
      handlers.set(name, { fn, options })
      return () => handlers.delete(name)
    }
  }
  return { ctx, routes, warnings, handlers }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-service-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForVisits (dir, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(await readFile(join(dir, VISITS_FILE), 'utf8'))
      if (predicate(raw)) return raw
    } catch {
      // 文件还没写出来 / 正写到一半：下一轮再读
    }
    await delay(15)
  }
  throw new Error('waitForVisits timeout')
}

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

async function call (service, path, { method = 'GET', body } = {}) {
  const route = service.routes.find((candidate) => candidate.path === path)
  assert.ok(route, '应该注册 ' + path)
  const res = {
    statusCode: 0,
    headers: {},
    setHeader (key, value) { this.headers[key] = value },
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

function makeService (t, options = {}) {
  const { ctx, routes, warnings, handlers } = fakeCtx()
  const service = createService(ctx, {
    network: false,
    petBridge: false,
    ...options
  })
  service.routes = routes
  service.warnings = warnings
  service.handlers = handlers
  t.after(() => service.dispose())
  return service
}

test('启动后快照有稳定的 deviceId 与可读昵称，dsh-pet 缺失时一行降级', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready

  const snap = service.snapshot()
  assert.equal(snap.version, 1)
  assert.equal(isDeviceId(snap.self.deviceId), true)
  assert.equal(snap.self.nickname, defaultNickname({ hostname: hostname() }))
  assert.equal(snap.self.pet, null)
  assert.deepEqual(snap.self.bridge, { ok: false, reason: 'starting' })
  assert.deepEqual(snap.neighbors, [])

  const raw = JSON.parse(await readFile(join(dir, IDENTITY_FILE), 'utf8'))
  assert.equal(raw.deviceId, snap.self.deviceId)
  assert.equal(raw.nickname, snap.self.nickname)

  const state = await call(service, '/local-pet/state')
  assert.equal(state.status, 200)
  assert.equal(state.body.self.deviceId, snap.self.deviceId)
})

test('昵称可以通过本地 action 修改并落盘；坏 action 明确失败', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready

  const renamed = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'rename', nickname: '  新 名字  ' }
  })
  assert.equal(renamed.status, 200)
  assert.deepEqual(renamed.body, { ok: true, action: 'rename', nickname: '新 名字' })
  assert.equal(service.snapshot().self.nickname, '新 名字')
  assert.equal(JSON.parse(await readFile(join(dir, IDENTITY_FILE), 'utf8')).nickname, '新 名字')

  const bad = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'rename', nickname: '\u0000\u0007' }
  })
  assert.equal(bad.status, 409)
  assert.equal(bad.body.error, 'bad-nickname')
  assert.equal(service.snapshot().self.nickname, '新 名字')

  const unknown = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'unknown' }
  })
  assert.equal(unknown.status, 409)
  assert.equal(unknown.body.error, 'not-implemented')
})

test('客厅开关默认开；关掉后落盘，重启仍是关，重新打开也落盘', async (t) => {
  const dir = await tempDir(t)
  const first = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await first.ready
  assert.equal(DEFAULT_ACCEPT_VISITS, true)
  assert.equal(first.snapshot().acceptVisits, true)

  const off = await call(first, '/local-pet/action', {
    method: 'POST',
    body: { action: 'accept-visits', enabled: false }
  })
  assert.equal(off.status, 200)
  assert.deepEqual(off.body, {
    ok: true,
    action: 'accept-visits',
    acceptVisits: false,
    persisted: true
  })
  assert.equal(first.snapshot().acceptVisits, false)
  assert.deepEqual(JSON.parse(await readFile(join(dir, SETTINGS_FILE), 'utf8')), {
    version: SETTINGS_VERSION,
    acceptVisits: false,
    autoVisits: false,
    desktop: true
  })

  // 非布尔值明确失败，不隐式 toggle。
  const bad = await call(first, '/local-pet/action', {
    method: 'POST',
    body: { action: 'accept-visits', enabled: 'false' }
  })
  assert.equal(bad.status, 409)
  assert.deepEqual(bad.body, { ok: false, error: 'bad-enabled' })
  assert.equal(first.snapshot().acceptVisits, false)

  first.dispose()

  const second = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await second.ready
  assert.equal(second.snapshot().acceptVisits, false)

  const on = await call(second, '/local-pet/action', {
    method: 'POST',
    body: { action: 'accept-visits', enabled: true }
  })
  assert.equal(on.status, 200)
  assert.equal(on.body.acceptVisits, true)
  assert.equal(on.body.persisted, true)
  assert.equal(second.snapshot().acceptVisits, true)
  assert.equal(
    JSON.parse(await readFile(join(dir, SETTINGS_FILE), 'utf8')).acceptVisits,
    true
  )
})

test('通过 webServer.getOrigin() 找到回环 dsh-pet，并把 anim 放进快照', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')

  const server = createServer((req, res) => {
    if (req.url !== '/dsh-pet-7340/state') {
      res.statusCode = 404
      res.end('no')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      counter: 1,
      pets: { main: { anim: { counter: 1, data: { name: '写代码' } } } }
    }))
  })
  const origin = await listen(server)
  t.after(() => close(server))

  const { ctx, routes } = fakeCtx()
  ctx.webServer.getOrigin = () => origin
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: configPath,
    network: false,
    petBridge: true
  })
  service.routes = routes
  t.after(() => service.dispose())
  await service.ready

  const snap = service.snapshot()
  assert.deepEqual(snap.self.pet, { name: '蓝毛小女仆', anim: '写代码' })
  assert.deepEqual(snap.self.bridge, { ok: true, reason: null })
  assert.equal(snap.self.nickname, '蓝毛小女仆')
})

test('getOrigin() 未绑定时回退 ctx.webServer.port', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"name":"蓝毛小女仆"}]}', 'utf8')

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      counter: 1,
      pets: { main: { anim: { data: { name: '东张西望' } } } }
    }))
  })
  await listen(server)
  const port = server.address().port
  t.after(() => close(server))

  const { ctx, routes } = fakeCtx()
  ctx.webServer.port = port
  ctx.webServer.getOrigin = () => { throw new Error('not bound') }
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: configPath,
    network: false,
    petBridge: true
  })
  service.routes = routes
  t.after(() => service.dispose())
  await service.ready

  assert.deepEqual(service.snapshot().self.pet, { name: '蓝毛小女仆', anim: '东张西望' })
})

test('重复 dispose 安全；快照在卸载后仍然可读', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready
  service.dispose()
  service.dispose()
  assert.equal(service.snapshot().version, 1)
  assert.equal(normalizeNickname(service.snapshot().self.nickname) !== null, true)
})

test('第一次见面放行/拒绝都落盘；重启后不再询问', async (t) => {
  const dir = await tempDir(t)
  const allowedId = randomUUID()
  const deniedId = randomUUID()
  const now = Date.now()

  const first = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await first.ready

  first.room.observeBeacon({ deviceId: allowedId, nickname: '甲', port: 40001 }, now)
  first.room.observeBeacon({ deviceId: deniedId, nickname: '乙', port: 40002 }, now)
  assert.deepEqual(first.snapshot().prompt, { deviceId: allowedId, nickname: '甲' })
  assert.equal(first.mayTalkTo(allowedId), false)
  assert.equal(first.mayTalkTo(deniedId), false)

  const admitted = await call(first, '/local-pet/action', {
    method: 'POST',
    body: { action: 'admit', deviceId: allowedId }
  })
  assert.equal(admitted.status, 200)
  assert.equal(admitted.body.ok, true)
  assert.equal(admitted.body.action, 'admit')
  assert.equal(admitted.body.status, 'allowed')
  assert.equal(admitted.body.nickname, '甲')
  assert.equal(admitted.body.persisted, true)
  assert.equal(first.mayTalkTo(allowedId), true)
  assert.deepEqual(first.snapshot().prompt, { deviceId: deniedId, nickname: '乙' })

  const rejected = await call(first, '/local-pet/action', {
    method: 'POST',
    body: { action: 'reject', deviceId: deniedId }
  })
  assert.equal(rejected.status, 200)
  assert.equal(rejected.body.status, 'denied')
  assert.equal(rejected.body.persisted, true)
  assert.equal(first.mayTalkTo(deniedId), false)
  assert.equal(first.snapshot().prompt, null)

  const raw = JSON.parse(await readFile(join(dir, PEERS_FILE), 'utf8'))
  assert.deepEqual(Object.keys(raw.allowed), [allowedId])
  assert.equal(raw.allowed[allowedId].nickname, '甲')
  assert.equal(Number.isFinite(raw.allowed[allowedId].allowedAt), true)
  assert.deepEqual(Object.keys(raw.denied), [deniedId])
  assert.equal(raw.denied[deniedId].nickname, '乙')
  assert.equal(Number.isFinite(raw.denied[deniedId].deniedAt), true)

  first.dispose()

  const second = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await second.ready
  second.room.observeBeacon({ deviceId: allowedId, nickname: '甲', port: 40001 }, Date.now())
  second.room.observeBeacon({ deviceId: deniedId, nickname: '乙', port: 40002 }, Date.now())

  const neighbors = second.snapshot().neighbors
  assert.deepEqual(neighbors.map((neighbor) => [neighbor.deviceId, neighbor.status]), [
    [allowedId, 'allowed'],
    [deniedId, 'denied']
  ])
  assert.equal(second.snapshot().prompt, null)
  assert.equal(second.mayTalkTo(allowedId), true)
  assert.equal(second.mayTalkTo(deniedId), false)

  const state = await call(second, '/local-pet/state')
  assert.equal(state.status, 200)
  assert.deepEqual(state.body.neighbors.map((neighbor) => neighbor.status), ['allowed', 'denied'])
  assert.equal(state.body.prompt, null)
  // 地址永远不进口径：快照里没有任何邻居地址字段。
  assert.equal(JSON.stringify(state.body).includes('127.0.0.1'), false)
})

test('dismiss action 只让队列前进，不改变信任', async (t) => {
  const dir = await tempDir(t)
  const firstId = randomUUID()
  const secondId = randomUUID()
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready

  const now = Date.now()
  service.room.observeBeacon({ deviceId: firstId, nickname: '甲', port: 40001 }, now)
  service.room.observeBeacon({ deviceId: secondId, nickname: '乙', port: 40002 }, now)
  assert.deepEqual(service.snapshot().prompt, { deviceId: firstId, nickname: '甲' })

  const dismissed = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'dismiss', deviceId: firstId }
  })
  assert.equal(dismissed.status, 200)
  assert.equal(dismissed.body.ok, true)
  assert.deepEqual(dismissed.body.prompt, { deviceId: secondId, nickname: '乙' })
  assert.deepEqual(service.snapshot().prompt, { deviceId: secondId, nickname: '乙' })
  assert.equal(service.mayTalkTo(firstId), false)
  assert.deepEqual(service.snapshot().neighbors.map((neighbor) => neighbor.status), [
    'pending',
    'pending'
  ])

  const state = await call(service, '/local-pet/state')
  assert.deepEqual(state.body.prompt, { deviceId: secondId, nickname: '乙' })
})

test('坏的 deviceId / 未知邻居明确失败，不留下半截状态', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready

  const bad = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'admit', deviceId: 'not-a-uuid' }
  })
  assert.equal(bad.status, 409)
  assert.deepEqual(bad.body, { ok: false, error: 'bad-device-id' })

  const unknown = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'reject', deviceId: randomUUID() }
  })
  assert.equal(unknown.status, 409)
  assert.deepEqual(unknown.body, { ok: false, error: 'unknown-neighbor' })

  const badDismiss = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'dismiss', deviceId: randomUUID() }
  })
  assert.equal(badDismiss.status, 409)
  assert.deepEqual(badDismiss.body, { ok: false, error: 'not-prompt' })
})

test('损坏的 peers.json 不影响启动，第一次放行仍然可用', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, PEERS_FILE), '{ oops', 'utf8')
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready

  assert.ok(service.warnings.some((line) => /放行名单/.test(line)))

  const deviceId = randomUUID()
  service.room.observeBeacon({ deviceId, nickname: '甲', port: 40001 }, Date.now())
  assert.deepEqual(service.snapshot().prompt, { deviceId, nickname: '甲' })
  const admitted = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'admit', deviceId }
  })
  assert.equal(admitted.status, 200)
  assert.equal(admitted.body.persisted, true)
  assert.deepEqual(JSON.parse(await readFile(join(dir, PEERS_FILE), 'utf8')).allowed[deviceId].nickname, '甲')
})

test('损坏的 visits.json 不影响启动与串门；完成后的记录会重新写成合法文件', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, VISITS_FILE), '{ oops', 'utf8')
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready

  assert.ok(service.warnings.some((line) => /串门记录/.test(line)))
  assert.deepEqual(service.snapshot().visits, [])

  const deviceId = randomUUID()
  const visitId = randomUUID()
  const now = Date.now()
  service.room.setTrust({ allowed: { [deviceId]: { nickname: '甲' } } })
  assert.equal(service.room.beginVisit(deviceId, { visitId, at: now }).ok, true)
  assert.equal(service.room.observeVisitAck({ deviceId, visitId }, now + 100).ok, true)
  service.room.tick(now + 100 + PEER_LOST_MS)
  // 内存里的记录立即出现；磁盘上还是损坏文件，直到 service 把队列交出去。
  assert.equal(service.snapshot().visits.length, 1)
  assert.equal(service.snapshot().visits[0].direction, 'out')

  // dispose 会先把完成记录交给 visits.json；损坏的旧文件被合法文件覆盖。
  service.dispose()
  const raw = await waitForVisits(dir, (parsed) => parsed.visits.length === 1)
  assert.equal(raw.visits[0].direction, 'out')
  assert.equal(raw.visits[0].nickname, '甲')
  assert.equal(raw.visits[0].durationMs, PEER_LOST_MS)
})

test('visits.json 不可写：串门照常完成，记录留在内存且只告警一次', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('以 root 运行时 chmod 不可靠')
    return
  }
  const dir = await tempDir(t)
  await writeFile(join(dir, VISITS_FILE), JSON.stringify({ version: 1, visits: [] }), 'utf8')
  await chmod(join(dir, VISITS_FILE), 0o400)
  t.after(async () => {
    await chmod(join(dir, VISITS_FILE), 0o600).catch(() => {})
  })

  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready
  assert.deepEqual(service.warnings, [])

  const deviceId = randomUUID()
  const visitId = randomUUID()
  const now = Date.now()
  service.room.setTrust({ allowed: { [deviceId]: { nickname: '甲' } } })
  assert.equal(service.room.beginVisit(deviceId, { visitId, at: now }).ok, true)
  assert.equal(service.room.observeVisitAck({ deviceId, visitId }, now + 100).ok, true)
  service.room.tick(now + 100 + PEER_LOST_MS)
  assert.equal(service.snapshot().visits.length, 1)

  service.dispose()
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !service.warnings.some((line) => /串门记录写不进去/.test(line))) {
    await delay(15)
  }
  assert.ok(service.warnings.some((line) => /串门记录写不进去/.test(line)))
  const raw = JSON.parse(await readFile(join(dir, VISITS_FILE), 'utf8'))
  assert.deepEqual(raw.visits, [])
})


test('自动出门默认关；auto-visits action 落盘，重启后保持', async (t) => {
  const dir = await tempDir(t)
  const first = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await first.ready

  assert.equal(DEFAULT_AUTO_VISITS, false)
  assert.equal(first.snapshot().autoVisit.enabled, false)
  assert.equal(first.snapshot().autoVisit.activitySource, 'none')

  const bad = await call(first, '/local-pet/action', {
    method: 'POST',
    body: { action: 'auto-visits', enabled: 'false' }
  })
  assert.equal(bad.status, 409)
  assert.deepEqual(bad.body, { ok: false, error: 'bad-enabled' })
  assert.equal(first.snapshot().autoVisit.enabled, false)

  const on = await call(first, '/local-pet/action', {
    method: 'POST',
    body: { action: 'auto-visits', enabled: true }
  })
  assert.equal(on.status, 200)
  assert.deepEqual(on.body, {
    ok: true,
    action: 'auto-visits',
    autoVisits: true,
    persisted: true
  })
  assert.equal(first.snapshot().autoVisit.enabled, true)
  assert.equal(JSON.parse(await readFile(join(dir, SETTINGS_FILE), 'utf8')).autoVisits, true)

  first.dispose()
  const second = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await second.ready
  assert.equal(second.snapshot().autoVisit.enabled, true)
  assert.equal(second.snapshot().acceptVisits, DEFAULT_ACCEPT_VISITS)
})

test('老 settings.json 没有 autoVisits：按默认关运行，不告警', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({
    version: SETTINGS_VERSION,
    acceptVisits: false
  }), 'utf8')

  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready
  assert.equal(service.snapshot().acceptVisits, false)
  assert.equal(service.snapshot().autoVisit.enabled, false)
  assert.deepEqual(service.warnings, [])
})

test('session/event 是主活动信号：订阅带 global，任何事件都刷新 lastActivityAt', async (t) => {
  const service = makeService(t, {
    dataDir: await tempDir(t),
    petConfigPath: join(await tempDir(t), 'missing.jsonc')
  })
  await service.ready

  const entry = service.handlers.get('session/event')
  assert.ok(entry, '应该订阅 session/event')
  assert.deepEqual(entry.options, { global: true })
  assert.equal(service.snapshot().autoVisit.activitySource, 'none')

  entry.fn({ id: 'session-1' }, { type: 'user/message' })
  const first = service.snapshot().autoVisit
  assert.equal(first.activitySource, 'session')
  assert.equal(Number.isFinite(first.lastActivityAt), true)

  entry.fn({ id: 'session-1' }, { type: 'turn/start' })
  assert.ok(service.snapshot().autoVisit.lastActivityAt >= first.lastActivityAt)

  service.dispose()
  assert.equal(service.handlers.has('session/event'), false, 'dispose 要退订')
})

test('session/event 不可用时退回桌面指针：光标进入宠物才算活动，离开不算', async (t) => {
  const dir = await tempDir(t)
  let captured = null
  const factory = (options) => {
    captured = options
    return {
      start () { return { ok: true, pid: 123 } },
      update () { return true },
      resync () { return true },
      dispose () {}
    }
  }
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: factory
  })
  await service.ready
  assert.ok(captured, '桌面层应该被创建')
  captured.onEvent({ type: 'ready', pid: 123, workArea: { x: 0, y: 0, width: 1000, height: 700 } })
  assert.equal(service.snapshot().autoVisit.activitySource, 'none')

  captured.onEvent({ type: 'hit', inside: true, point: { x: 10, y: 20 }, reason: 'hovering' })
  const pointer = service.snapshot().autoVisit
  assert.equal(pointer.activitySource, 'pointer')
  assert.equal(Number.isFinite(pointer.lastActivityAt), true)

  // 光标离开宠物不算“有活动”；session/event 的事件更近时又切回主信号。
  captured.onEvent({ type: 'hit', inside: false, point: { x: 10, y: 20 }, reason: 'outside' })
  assert.equal(service.snapshot().autoVisit.lastActivityAt, pointer.lastActivityAt)
  service.handlers.get('session/event').fn({ id: 's' }, { type: 'turn/start' })
  assert.equal(service.snapshot().autoVisit.activitySource, 'session')
})

test('手动串门不带 deviceId：随机挑在线已放行邻居；没有目标时给可读原因', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready

  // 一个都没放行：明确说“还没有人放行你”，不是含糊的超时。
  const none = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'visit' }
  })
  assert.equal(none.status, 409)
  assert.equal(none.body.error, 'no-admitted')
  assert.match(none.body.notice, /还没有人放行你/)

  // 放行了、也收到了广播，但对方还没有心跳 = 还不确定对方放行了我：不指向它。
  const deviceId = randomUUID()
  service.room.observeBeacon({ deviceId, nickname: '甲', port: 40001 }, Date.now())
  assert.equal((await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'admit', deviceId }
  })).status, 200)
  const noEvidence = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'visit' }
  })
  assert.equal(noEvidence.status, 409)
  assert.equal(noEvidence.body.error, 'no-online')
  assert.match(noEvidence.body.notice, /都不在线/)

  // 收到对方心跳后（证明对方放行了我），随机挑中了它；但发现层没有地址（network:false），
  // 所以明确报 peer-offline，而不是含糊的超时。
  assert.equal(service.room.observeHeartbeat({ deviceId, anim: null }, Date.now()), true)

  const offline = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'visit' }
  })
  assert.equal(offline.status, 409)
  assert.equal(offline.body.error, 'peer-offline')
  assert.equal(offline.body.deviceId, deviceId)
  assert.match(offline.body.notice, /好像不在线/)
  assert.equal(service.snapshot().self.out, null)
  assert.deepEqual(service.snapshot().visits, [])
})

test('坏 deviceId 仍然明确失败；不带 deviceId 才是“随机挑一个”', async (t) => {
  const dir = await tempDir(t)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  await service.ready

  for (const deviceId of ['', 'not-a-uuid', 42]) {
    const result = await call(service, '/local-pet/action', {
      method: 'POST',
      body: { action: 'visit', deviceId }
    })
    assert.equal(result.status, 409)
    assert.deepEqual(result.body, { ok: false, error: 'bad-device-id' })
  }
})

async function waitFor (predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error('waitFor timeout')
}

/**
 * 假 dsh-pet：`/state` 常在，`/config` 支持 GET / PUT。
 * PUT 成功时会像真的一样把名字写回配置文件——桥接读的是磁盘上的 JSONC，
 * 不写文件的话“改名后桌面标签跟着变”根本测不出来。
 */
async function fakeDshPet (t, { name = '蓝毛小女仆', id = 'main', putStatus = 200, configPath = null } = {}) {
  const state = { name, id, putStatus, puts: [] }
  const petBody = () => ({
    id: state.id,
    name: state.name,
    size: 462,
    balanceEnabled: true,
    display: 'desktop',
    position: { corner: 'top-right', marginX: 24, marginY: 100 }
  })
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', async () => {
      if (req.url === '/dsh-pet-7340/state') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ counter: 1, pets: { [state.id]: { anim: { data: { name: '东张西望' } } } } }))
        return
      }
      if (req.url === '/dsh-pet-7340/config') {
        if (req.method === 'PUT') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          state.puts.push(body)
          if (state.putStatus !== 200) {
            res.statusCode = state.putStatus
            res.end('nope')
            return
          }
          state.name = body.pets[0].name
          if (configPath !== null) {
            await writeFile(configPath, JSON.stringify({ pets: body.pets }, null, 2), 'utf8')
          }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ main: { pets: body.pets } }))
          return
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ main: { pets: [petBody()] } }))
        return
      }
      res.statusCode = 404
      res.end('no')
    })
  })
  const origin = await listen(server)
  t.after(() => close(server))
  return { origin, state }
}

async function petService (t, { dir, configPath, origin, pollMs = 200 }) {
  const { ctx, routes } = fakeCtx()
  ctx.webServer.getOrigin = () => origin
  const service = createService(ctx, {
    dataDir: dir,
    petConfigPath: configPath,
    network: false,
    petBridge: true,
    bridgePollMs: pollMs,
    bridgeConfigTtlMs: 0
  })
  service.routes = routes
  t.after(() => service.dispose())
  await service.ready
  return service
}

test('名字跟着 dsh-pet 走：配置里改名，本机镜像跟着改并落盘', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')
  const pet = await fakeDshPet(t, { configPath })
  const service = await petService(t, { dir, configPath, origin: pet.origin })

  assert.equal(service.snapshot().self.nickname, '蓝毛小女仆')

  // 用户在 dsh-pet 设置页把名字改了：下一次配置轮询就该跟上
  await writeFile(configPath, '{"pets":[{"id":"main","name":"泡泡"}]}', 'utf8')
  await waitFor(() => service.snapshot().self.nickname === '泡泡')
  assert.equal(JSON.parse(await readFile(join(dir, IDENTITY_FILE), 'utf8')).nickname, '泡泡')
})

test('启动时 dsh-pet 的名字覆盖 identity.json 里的旧昵称', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')
  await writeFile(
    join(dir, IDENTITY_FILE),
    JSON.stringify({ deviceId: randomUUID(), nickname: '旧名字' }),
    'utf8'
  )
  const pet = await fakeDshPet(t, { configPath })
  const service = await petService(t, { dir, configPath, origin: pet.origin })

  assert.equal(service.snapshot().self.nickname, '蓝毛小女仆')
})

test('改名走 dsh-pet 的 PUT /config：只改 name，三处一起变', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')
  const pet = await fakeDshPet(t, { configPath })
  const service = await petService(t, { dir, configPath, origin: pet.origin })

  const renamed = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'rename', nickname: '  新 名字  ' }
  })
  assert.equal(renamed.status, 200)
  assert.deepEqual(renamed.body, { ok: true, action: 'rename', nickname: '新 名字' })

  // 写进了 dsh-pet，而且只动了名字（其余字段原样带回去）
  assert.equal(pet.state.puts.length, 1)
  assert.equal(pet.state.puts[0].pets[0].name, '新 名字')
  assert.equal(pet.state.puts[0].pets[0].size, 462)

  assert.equal(service.snapshot().self.nickname, '新 名字')
  assert.equal(service.snapshot().self.pet.name, '新 名字')
  assert.equal(JSON.parse(await readFile(join(dir, IDENTITY_FILE), 'utf8')).nickname, '新 名字')
})

test('dsh-pet 写不进去时改名整个取消，本地一个字段都不动', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')
  const pet = await fakeDshPet(t, { configPath, putStatus: 500 })
  const service = await petService(t, { dir, configPath, origin: pet.origin })

  const renamed = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'rename', nickname: '新名字' }
  })
  assert.equal(renamed.status, 409)
  assert.deepEqual(renamed.body, { ok: false, error: 'dsh-pet-write-failed', status: 500 })

  assert.equal(service.snapshot().self.nickname, '蓝毛小女仆')
  assert.equal(service.snapshot().self.pet.name, '蓝毛小女仆')
  assert.equal(JSON.parse(await readFile(join(dir, IDENTITY_FILE), 'utf8')).nickname, '蓝毛小女仆')
})

test('dsh-pet 装着但不通：改名明确失败，不回退成只改本地', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')
  const service = await petService(t, { dir, configPath, origin: 'http://127.0.0.1:1' })

  const renamed = await call(service, '/local-pet/action', {
    method: 'POST',
    body: { action: 'rename', nickname: '新名字' }
  })
  assert.equal(renamed.status, 409)
  assert.equal(renamed.body.error, 'dsh-pet-unreachable')
  assert.equal(service.snapshot().self.nickname, '蓝毛小女仆')
})
