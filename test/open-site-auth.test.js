/**
 * 「打开软件」必须交出一个**能被 DSH 认下来**的地址。
 *
 * 用户报的是：右键宠物 → 打开软件 → 浏览器停在
 *   dsh web authentication required; reopen the URL printed by dsh web.
 * 也就是 401 页。根因在宿主这半侧：`dshOrigin()` 只把 `webServer.getOrigin()`
 * 交出去，而 DSH 的 Web 认证要的是 `/` 上带 `?token=<launch token>` 的那条
 * 登录地址（见 `ctx.connection.authenticatedUrl`），裸 origin 一律 401。
 *
 * 这条回路走的是插件真实的外沿：createService → POST /dsh-zoo/action
 * → desktop.openUrl 收到的那条字符串，再用真 HTTP 去请求它。镜像的是 DSH
 * `browser-auth` 的最小契约：`GET /?token=…` → 303 + 会话 Cookie，缺 token
 * 或 token 不对 → 401 + 上面那句原文。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createService } from '../src/service.js'

const LAUNCH_TOKEN = 'launch-token-for-open-site-test'
const AUTH_MESSAGE = 'dsh web authentication required; reopen the URL printed by dsh web.'
const SESSION_COOKIE = 'dsh-auth-127-0-0-1=test-session'

function fakeCtx (connection) {
  const routes = []
  const ctx = {
    webServer: {
      register (options) {
        routes.push(options)
        return () => {}
      }
    },
    logger: { info () {}, warn () {} },
    on () { return () => {} }
  }
  // 与 DSH 宿主一致：插件用 ctx.get('connection') 现取服务，拿不到就退回旧行为。
  ctx.get = (name) => (name === 'connection' ? connection : undefined)
  return { ctx, routes }
}

/** DSH `browser-auth` 的最小镜像：只认 `GET /` + 唯一 token（或已换到的 Cookie）。 */
function dshAuthServer () {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const tokens = url.searchParams.getAll('token')
    if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1 && tokens[0] === LAUNCH_TOKEN) {
      res.writeHead(303, {
        location: './',
        'set-cookie': `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Strict`
      })
      res.end()
      return
    }
    if (req.method === 'GET' && url.pathname === '/' && (req.headers.cookie ?? '').includes(SESSION_COOKIE)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>DeepSeek Harness</title>')
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(AUTH_MESSAGE + '\n')
  })
}

async function listen (server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
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
  queueMicrotask(() => req._listeners.data?.(Buffer.from(JSON.stringify(body ?? {}))))
  queueMicrotask(() => req._listeners.end?.())
  await pending
  return { status: res.statusCode, body: res.payload ? JSON.parse(res.payload) : null }
}

/** 起一只带桌面层的服务；`connection` 就是 DSH 宿主会递给插件的那一面。 */
async function boot (t, connection) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-open-site-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))

  const server = dshAuthServer()
  const origin = await listen(server)
  t.after(() => close(server))

  const opened = []
  let onEvent = null
  const { ctx, routes } = fakeCtx(connection)
  const service = createService(ctx, {
    network: false,
    petBridge: false,
    desktopFactory (options) {
      onEvent = options.onEvent
      return {
        start () { return { ok: true, pid: 4242 } },
        update () { return true },
        resync () { return true },
        actionResult () {},
        reload () { return { ok: true } },
        openUrl (url) { opened.push(url); return true },
        dispose () {}
      }
    },
    dataDir: dir,
    petConfigPath: join(dir, 'missing.jsonc')
  })
  service.routes = routes
  t.after(() => service.dispose())
  ctx.webServer.getOrigin = () => origin
  await service.ready
  onEvent?.({ type: 'ready', pid: 4242, workArea: { x: 0, y: 0, width: 1200, height: 800 } })
  return { service, opened, origin }
}

test('打开软件：交给浏览器的地址必须带着 DSH 的 launch token，落进 GUI 而不是 401 页', async (t) => {
  const { service, opened } = await boot(t, {
    authenticatedUrl (baseUrl) {
      const url = new URL(baseUrl)
      url.searchParams.set('token', LAUNCH_TOKEN)
      return url.href
    }
  })

  const result = await call(service, '/dsh-zoo/action', { method: 'POST', body: { action: 'open-site' } })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.deepEqual(result.body, { ok: true, action: 'open-site' })
  assert.equal(opened.length, 1, '应该只交给 helper 一条地址')

  const handed = opened[0]
  const response = await fetch(handed, { redirect: 'manual' })
  const body = await response.text()
  assert.notEqual(
    response.status,
    401,
    `「打开软件」交出的是没认证的地址 ${handed}，浏览器只会停在：${body.trim()}`
  )
  assert.equal(response.status, 303, 'DSH 的登录地址应该 303 到干净的 ./')

  // 浏览器跟过去：Cookie 已由登录地址种下，干净的 ./ 应该拿到 GUI。
  const cookie = response.headers.get('set-cookie').split(';')[0]
  const gui = await fetch(new URL('./', handed), { headers: { cookie } })
  assert.equal(gui.status, 200)
})

test('打开软件：拿不到 connection（或它抛错）就退回裸 origin，不把这一项弄没', async (t) => {
  const absent = await boot(t, undefined)
  const first = await call(absent.service, '/dsh-zoo/action', { method: 'POST', body: { action: 'open-site' } })
  assert.deepEqual(first.body, { ok: true, action: 'open-site' })
  assert.deepEqual(absent.opened, [absent.origin + '/'])

  const broken = await boot(t, {
    authenticatedUrl () { throw new Error('connection not ready') }
  })
  const second = await call(broken.service, '/dsh-zoo/action', { method: 'POST', body: { action: 'open-site' } })
  assert.deepEqual(second.body, { ok: true, action: 'open-site' })
  assert.deepEqual(broken.opened, [broken.origin + '/'])
})
