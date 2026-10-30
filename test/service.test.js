import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { IDENTITY_FILE, defaultNickname } from '../src/identity.js'
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
