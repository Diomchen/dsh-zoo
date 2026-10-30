import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { IDENTITY_FILE, defaultNickname } from '../src/identity.js'
import { PEERS_FILE } from '../src/peers.js'
import { isDeviceId, normalizeNickname } from '../src/protocol.js'
import { createService } from '../src/service.js'

function fakeCtx () {
  const routes = []
  const warnings = []
  return {
    ctx: {
      webServer: {
        register (options) {
          routes.push(options)
          return () => {}
        }
      },
      logger: {
        info () {},
        warn (line) { warnings.push(line) }
      }
    },
    routes,
    warnings
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-service-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
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
  const { ctx, routes, warnings } = fakeCtx()
  const service = createService(ctx, {
    network: false,
    petBridge: false,
    ...options
  })
  service.routes = routes
  service.warnings = warnings
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
    body: { action: 'visit' }
  })
  assert.equal(unknown.status, 409)
  assert.equal(unknown.body.error, 'not-implemented')
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
