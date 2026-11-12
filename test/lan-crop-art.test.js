/**
 * 票 59：`GET /dsh-zoo-crops/<hash>.<svg|png>` 的只读路由。
 *
 * 票 62 把会开 socket 的网络用例整档删了，`lan-server` 的路由因此没有覆盖。
 * 这条测试**不开端口**：用注入的假 `createServer` 把 handler 抠出来直接调，
 * 只验路由/头/状态码，不碰网络。真机链路在 `notes/59-cross-machine-verified.md`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { startLanServer } from '../src/lan-server.js'

const HASH = '0123456789abcdef'

function fakeResponse () {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead (status, headers) {
      this.statusCode = status
      for (const [key, value] of Object.entries(headers ?? {})) this.headers[String(key).toLowerCase()] = value
      return this
    },
    setHeader (key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    end (chunk) {
      if (chunk !== undefined && chunk !== null) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      return this
    }
  }
}

/** 假 server：不 listen，只把 handler 交出来；`address()` 给一个假端口。 */
function fakeServerFactory (captured) {
  return (handler) => {
    captured.handler = handler
    return {
      once () { return this },
      listen (_port, _host, callback) {
        if (typeof callback === 'function') callback()
        return this
      },
      address () { return { port: 45899 } },
      close () {}
    }
  }
}

async function startFake (lookupCropArt) {
  const captured = {}
  const server = await startLanServer({
    port: 0,
    host: '127.0.0.1',
    createServer: fakeServerFactory(captured),
    lookupCropArt,
    log: { warn () {} }
  })
  assert.ok(server !== null && server !== undefined, '假 server 应该启动成功')
  return { captured, server }
}

async function call (captured, url, { method = 'GET' } = {}) {
  const response = fakeResponse()
  await captured.handler({ method, url }, response)
  return response
}

test('作物图路由：命中就回字节、内容类型、长度与缓存头', async () => {
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
  const { captured } = await startFake(async (name) => (
    name === HASH + '.svg' ? { bytes, contentType: 'image/svg+xml' } : null
  ))

  const response = await call(captured, '/dsh-zoo-crops/' + HASH + '.svg')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'image/svg+xml')
  assert.equal(response.headers['content-length'], String(bytes.length))
  assert.equal(response.headers['cache-control'], 'public, max-age=300')
  assert.deepEqual(response.body, bytes)
})

test('作物图路由：HEAD 只要头，不发字节', async () => {
  const bytes = Buffer.from('<svg/>')
  const { captured } = await startFake(async () => ({ bytes, contentType: 'image/svg+xml' }))
  const response = await call(captured, '/dsh-zoo-crops/' + HASH + '.svg', { method: 'HEAD' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-length'], String(bytes.length))
  assert.equal(response.body, null)
})

test('作物图路由：查不到、查抛错、空文件都回 404（不区分原因）', async () => {
  const missing = await startFake(async () => null)
  assert.equal((await call(missing.captured, '/dsh-zoo-crops/' + HASH + '.svg')).statusCode, 404)

  const throwing = await startFake(async () => {
    throw new Error('磁盘炸了')
  })
  assert.equal((await call(throwing.captured, '/dsh-zoo-crops/' + HASH + '.svg')).statusCode, 404)

  const empty = await startFake(async () => ({ bytes: Buffer.alloc(0), contentType: 'image/svg+xml' }))
  assert.equal((await call(empty.captured, '/dsh-zoo-crops/' + HASH + '.svg')).statusCode, 404)
})

test('作物图路由：没有 lookup（老配置）时整条 404，别的路由不受影响', async () => {
  const { captured } = await startFake(null)
  const response = await call(captured, '/dsh-zoo-crops/' + HASH + '.svg')
  assert.equal(response.statusCode, 404)
  assert.match(String(response.body), /crop art not found/)
  // 未知路径仍然是通用 404，不会把请求带进作物分支。
  assert.equal((await call(captured, '/nonsense')).statusCode, 404)
})

test('作物图路由：只认一层、只认 GET/HEAD、不做路径穿越', async () => {
  const seen = []
  const { captured } = await startFake(async (name) => {
    seen.push(name)
    return { bytes: Buffer.from('x'), contentType: 'image/svg+xml' }
  })

  // 多一层 = 404，且不会把名字交给 lookup。
  assert.equal((await call(captured, '/dsh-zoo-crops/a/b.svg')).statusCode, 404)
  // 空的 = 404
  assert.equal((await call(captured, '/dsh-zoo-crops/')).statusCode, 404)
  // 编码过的斜杠会在路由层被拦下
  assert.equal((await call(captured, '/dsh-zoo-crops/a%2Fb.svg')).statusCode, 404)
  // 非 GET/HEAD 一律 405（外层拦，不进 lookup）
  assert.equal((await call(captured, '/dsh-zoo-crops/' + HASH + '.svg', { method: 'POST' })).statusCode, 405)
  assert.deepEqual(seen, [], '不合法的形状不该调到 lookup')
})
