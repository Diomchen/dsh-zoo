import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, inject, name } from '../index.js'

function fakeCtx () {
  const routes = []
  const effects = []
  return {
    ctx: {
      webServer: { register (options) { routes.push(options); return () => {} } },
      effect (fn) { effects.push(fn) },
      logger: { info () {}, warn () {} }
    },
    routes,
    effects
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-smoke-'))
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

test('插件声明了宿主需要的能力', () => {
  assert.equal(name, 'local-pet')
  assert.deepEqual(inject, ['webServer'])
})

test('挂载后注册了快照接口，且快照形状稳定', async (t) => {
  const dir = await tempDir(t)
  const { ctx, routes } = fakeCtx()
  apply(ctx, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    network: false,
    petBridge: false
  })

  const state = routes.find((route) => route.path === '/local-pet/state')
  assert.ok(state, '应该注册 /local-pet/state')

  const res = await call(state.handler, { method: 'GET' })
  assert.equal(res.status, 200)
  assert.equal(res.body.version, 1)
  assert.ok(Array.isArray(res.body.neighbors))
  assert.ok(Array.isArray(res.body.guests))
  assert.ok(res.body.self && typeof res.body.self.nickname === 'string')
  assert.equal(res.body.self.pet, null)
  assert.ok(res.body.self.bridge)
})

test('坏掉的 webServer 不会把宿主拖下水', () => {
  const errors = []
  apply({
    webServer: { register () { throw new Error('boom') } },
    effect () {},
    logger: { info () {}, warn (line) { errors.push(line) } }
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /初始化失败/)
})

async function call (handler, { method = 'GET', body } = {}) {
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
  const pending = handler(req, res)
  if (body !== undefined) {
    queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body))))
    queueMicrotask(() => req._listeners.end?.())
  }
  await pending
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}
