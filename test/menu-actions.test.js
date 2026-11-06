/**
 * 右键菜单背后的三个宿主动作（ticket 22）：
 *   play-anim  → dsh-pet 的 /anim（ADR-0009）
 *   reload     → 重读 settings/skin，重建场景，让 helper 重建
 *   open-site  → 把 DSH 地址交给主进程去打开
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createService } from '../src/service.js'
import { SETTINGS_FILE } from '../src/settings.js'

function fakeCtx () {
  const routes = []
  const warnings = []
  const ctx = {
    webServer: {
      register (options) {
        routes.push(options)
        return () => {}
      }
    },
    logger: { info () {}, warn (line) { warnings.push(line) } },
    on () { return () => {} }
  }
  return { ctx, routes, warnings }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-menu-actions-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
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

function fakeDesktop (calls) {
  const state = { onEvent: null }
  return {
    state,
    factory (options) {
      state.onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update (scene) { calls.updates.push(scene); return true },
        resync (scene) { calls.updates.push(scene); return true },
        actionResult () {},
        reload () { calls.reload = (calls.reload ?? 0) + 1; return { ok: true } },
        openUrl (url) { calls.opened = calls.opened ?? []; calls.opened.push(url); return true },
        dispose () {}
      }
    },
    ready () {
      state.onEvent?.({ type: 'ready', pid: 4242, workArea: { x: 0, y: 0, width: 1200, height: 800 } })
    }
  }
}

function makeService (t, options = {}) {
  const { ctx, routes, warnings } = fakeCtx()
  const service = createService(ctx, {
    network: false,
    // 点播要桥接；没有 dsh-pet 时它只会降级，不会把测试拖住。
    petBridge: true,
    // 有桌面工厂才开桌面层（否则 createDesktop 会真的去 spawn Electron）。
    desktop: typeof options.desktopFactory === 'function' ? undefined : false,
    ...options
  })
  service.routes = routes
  service.warnings = warnings
  service.ctx = ctx
  t.after(() => service.dispose())
  return service
}

test('点播：POST 到 dsh-pet 的 /anim?pet=<id>，成功回 ok', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')

  const seen = []
  const server = createServer((req, res) => {
    if (req.url === '/dsh-pet-7340/state') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ pets: { main: { anim: { data: { name: '东张西望' } } } } }))
      return
    }
    if (req.url.startsWith('/dsh-pet-7340/anim?pet=main') && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        // surface=any 是 dsh-pet 的必填参数：dsh-zoo 只镜像 /state，不属于它的任何一端。
        assert.match(req.url, /[?&]surface=any(&|$)/)
        seen.push(JSON.parse(body || 'null'))
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, playbackId: 3 }))
      })
      return
    }
    res.statusCode = 404
    res.end('no')
  })
  const origin = await listen(server)
  t.after(() => close(server))

  const service = makeService(t, { dataDir: dir, petConfigPath: configPath })
  service.ctx.webServer.getOrigin = () => origin
  await service.ready

  const played = await call(service, '/dsh-zoo/action', {
    method: 'POST',
    body: { action: 'play-anim', name: '写代码' }
  })
  assert.equal(played.status, 200)
  assert.deepEqual(played.body, { ok: true, action: 'play-anim', name: '写代码' })
  assert.deepEqual(seen, [{ name: '写代码' }])

  const bad = await call(service, '/dsh-zoo/action', { method: 'POST', body: { action: 'play-anim' } })
  assert.equal(bad.status, 409)
  assert.equal(bad.body.error, 'bad-name')
})

test('点播：dsh-pet 拒绝时是 anim-rejected；够不着时是 anim-unreachable', async (t) => {
  const dir = await tempDir(t)
  const configPath = join(dir, 'main-config.jsonc')
  await writeFile(configPath, '{"pets":[{"id":"main","name":"蓝毛小女仆"}]}', 'utf8')

  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url.includes('/anim?pet=main')) {
      res.end(JSON.stringify({ ok: false, reason: 'not-in-pool', message: '没有这段动作' }))
      return
    }
    res.end(JSON.stringify({ pets: {} }))
  })
  const origin = await listen(server)
  t.after(() => close(server))

  const service = makeService(t, { dataDir: dir, petConfigPath: configPath })
  service.ctx.webServer.getOrigin = () => origin
  await service.ready

  const rejected = await call(service, '/dsh-zoo/action', {
    method: 'POST',
    body: { action: 'play-anim', name: '不存在的动作' }
  })
  assert.equal(rejected.status, 409)
  assert.equal(rejected.body.error, 'anim-rejected')
  assert.equal(rejected.body.detail, '没有这段动作')

  // 没有回环地址 = 够不着
  service.ctx.webServer.getOrigin = () => null
  service.ctx.webServer.port = undefined
  const unreachable = await call(service, '/dsh-zoo/action', {
    method: 'POST',
    body: { action: 'play-anim', name: '写代码' }
  })
  assert.equal(unreachable.body.error, 'anim-unreachable')
})

test('重载配置：重读 settings.json、重建场景，并让 helper 重建', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, acceptVisits: false, autoVisits: false }), 'utf8')

  const calls = { updates: [], reload: 0 }
  const desktop = fakeDesktop(calls)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory
  })
  await service.ready
  desktop.ready()
  assert.equal(service.snapshot().acceptVisits, false)

  // 手改文件，再点「重载配置」
  await writeFile(join(dir, SETTINGS_FILE), JSON.stringify({ version: 1, acceptVisits: true, autoVisits: true }), 'utf8')
  const reloaded = await call(service, '/dsh-zoo/action', { method: 'POST', body: { action: 'reload' } })
  assert.equal(reloaded.status, 200)
  assert.deepEqual(reloaded.body, { ok: true, action: 'reload' })
  assert.equal(service.snapshot().acceptVisits, true)
  assert.equal(service.snapshot().autoVisit.enabled, true)
  assert.equal(calls.reload, 1)
  assert.ok(calls.updates.length >= 1)
  const scene = calls.updates[calls.updates.length - 1]
  assert.ok(scene.menu.tools.some((tool) => tool.id === 'reload'))
})

test('打开软件：地址由宿主给，只交给 helper 的 openUrl；拿不到地址就不出现这一项', async (t) => {
  const dir = await tempDir(t)
  const calls = { updates: [] }
  const desktop = fakeDesktop(calls)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    desktopFactory: desktop.factory
  })
  service.ctx.webServer.getOrigin = () => 'http://127.0.0.1:64071'
  await service.ready
  desktop.ready()

  const openedResult = await call(service, '/dsh-zoo/action', { method: 'POST', body: { action: 'open-site' } })
  assert.equal(openedResult.status, 200)
  assert.deepEqual(openedResult.body, { ok: true, action: 'open-site' })
  assert.deepEqual(calls.opened, ['http://127.0.0.1:64071/'])

  const scene = calls.updates[calls.updates.length - 1]
  assert.ok(scene.menu.tools.some((tool) => tool.id === 'open-site'))

  // 拿不到地址：动作明确失败（不静默）
  service.ctx.webServer.getOrigin = () => null
  service.ctx.webServer.port = undefined
  const noOrigin = await call(service, '/dsh-zoo/action', { method: 'POST', body: { action: 'open-site' } })
  assert.equal(noOrigin.body.error, 'no-origin')
})

test('渲染端场景：没有 dsh-pet 时菜单只剩工具项，且永远有「回到初始位置」', async (t) => {
  const dir = await tempDir(t)
  const calls = { updates: [] }
  const desktop = fakeDesktop(calls)
  const service = makeService(t, {
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc'),
    // 空的 DSH_HOME：这台机器上真装着的 dsh-pet 不该影响"没装 dsh-pet"这条断言。
    env: { DSH_HOME: join(dir, 'dsh-home') },
    desktopFactory: desktop.factory
  })
  await service.ready
  desktop.ready()
  const scene = calls.updates[calls.updates.length - 1]
  assert.deepEqual(scene.menu.tools.map((tool) => tool.id), ['bring', 'farm', 'home', 'reload', 'scan-skins'])
  assert.deepEqual(scene.menu.groups, [])
})
