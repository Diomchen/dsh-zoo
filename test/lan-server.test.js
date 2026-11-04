import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_SKIN_PORT,
  GIFT_ROUTE,
  MAX_GIFT_FILE_BYTES,
  resolveSkinPort,
  startLanServer
} from '../src/lan-server.js'

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-lan-server-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function sha256 (buffer) {
  return 'sha256:' + createHash('sha256').update(buffer).digest('hex')
}

async function fixture (t) {
  const dir = await tempDir(t)
  const a = Buffer.from('fake-webm-A')
  const b = Buffer.from('fake-webm-B')
  await writeFile(join(dir, 'A.webm'), a)
  await writeFile(join(dir, 'B.webm'), b)
  const source = {
    id: 'test',
    name: '测试皮肤',
    size: 220,
    dirs: [dir],
    actions: {
      A: { file: 'A.webm', dir },
      B: { file: 'B.webm', dir }
    }
  }
  return { dir, source, a, b }
}

async function start (t, options) {
  const server = await startLanServer({ host: '127.0.0.1', port: 0, ...options })
  assert.ok(server, 'server should start')
  t.after(() => server.close())
  return server
}

function url (server, path) {
  return `http://127.0.0.1:${server.port}${path}`
}

test('manifest 带 size/idle 和每个文件的 sha256', async (t) => {
  const { source, a, b } = await fixture(t)
  const server = await start(t, { sources: [source] })
  assert.equal(server.skinId, 'test', '有源时服务器带上源 id')

  const response = await fetch(url(server, '/local-pet-skin/manifest'))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json/)
  const manifest = await response.json()
  assert.equal(manifest.v, 1)
  assert.equal(manifest.id, 'test')
  // 清单里的名字就是源 id：不给皮肤另起显示名（ticket 33）
  assert.equal(manifest.name, 'test')
  assert.equal(manifest.size, 220)
  assert.equal(manifest.idle, 'A')
  assert.deepEqual(manifest.actions.A, { file: 'A.webm', loop: true, hash: sha256(a) })
  assert.deepEqual(manifest.actions.B, { file: 'B.webm', loop: true, hash: sha256(b) })
  assert.match(manifest.hash, /^sha256:[0-9a-f]{64}$/)
})

test('素材按动作 id 取，响应带 webm 类型与长度', async (t) => {
  const { source, a } = await fixture(t)
  const server = await start(t, { sources: [source] })

  const response = await fetch(url(server, '/local-pet-skin/asset/A'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'video/webm')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), a)

  // 也接受带扩展名的写法，方便直接用 manifest 里的 file
  const withExt = await fetch(url(server, '/local-pet-skin/asset/A.webm'))
  assert.equal(withExt.status, 200)
})

test('Range 请求回 206 与正确的字节段', async (t) => {
  const { source, b } = await fixture(t)
  const server = await start(t, { sources: [source] })

  const response = await fetch(url(server, '/local-pet-skin/asset/B'), {
    headers: { range: 'bytes=2-5' }
  })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), `bytes 2-5/${b.length}`)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), b.subarray(2, 6))

  const invalid = await fetch(url(server, '/local-pet-skin/asset/B'), {
    headers: { range: 'bytes=999-' }
  })
  assert.equal(invalid.status, 416)
})

test('多源按 id 路由；没登记的源、动作、穿越路径都是 404', async (t) => {
  const { dir, source } = await fixture(t)
  const other = { ...source, id: 'other', name: '另一个', actions: { A: source.actions.A } }
  const server = await start(t, { sources: [source, other] })

  assert.equal((await fetch(url(server, '/local-pet-skin/other/manifest'))).status, 200)
  assert.equal((await fetch(url(server, '/local-pet-skin/nope/manifest'))).status, 404)
  assert.equal((await fetch(url(server, '/local-pet-skin/asset/../secret'))).status, 404)
  assert.equal((await fetch(url(server, '/local-pet-skin/asset/..%2Fsecret'))).status, 404)
  assert.equal((await fetch(url(server, '/local-pet-skin/other/asset/B'))).status, 404)
  assert.equal((await fetch(url(server, '/nope'))).status, 404)
  assert.equal((await fetch(url(server, '/local-pet-skin/manifest'), { method: 'POST' })).status, 405)
  assert.ok(dir.length > 0)
})

test('超过单文件上限的素材被拒绝', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'big.webm'), Buffer.alloc(64, 1))
  const source = {
    id: 'big',
    name: 'big',
    size: 220,
    dirs: [dir],
    actions: { big: { file: 'big.webm', dir } }
  }
  const server = await start(t, { sources: [source], maxFileBytes: 32 })

  const response = await fetch(url(server, '/local-pet-skin/asset/big'))
  assert.equal(response.status, 413)
})

test('端口被占时向后找一个；全部失败返回 null', async (t) => {
  const blocker = createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => blocker.close(resolve)))
  const busy = blocker.address().port

  const { source } = await fixture(t)
  const server = await startLanServer({
    sources: [source],
    host: '127.0.0.1',
    port: busy,
    maxPortTries: 1
  })
  assert.equal(server, null)

  const next = await startLanServer({
    sources: [source],
    host: '127.0.0.1',
    port: busy,
    maxPortTries: 4
  })
  t.after(() => next?.close())
  assert.ok(next)
  assert.ok(next.port > busy)
})

test('默认端口常量是 45873', () => {
  assert.equal(DEFAULT_SKIN_PORT, 45873)
})

test('LOCAL_PET_SKIN_PORT 覆盖默认端口，非法值回落', () => {
  assert.equal(resolveSkinPort({}), DEFAULT_SKIN_PORT)
  assert.equal(resolveSkinPort({ LOCAL_PET_SKIN_PORT: '46000' }), 46000)
  assert.equal(resolveSkinPort({ LOCAL_PET_SKIN_PORT: '0' }), 0)
  assert.equal(resolveSkinPort({ LOCAL_PET_SKIN_PORT: 'nope' }), DEFAULT_SKIN_PORT)
  assert.equal(resolveSkinPort({ LOCAL_PET_SKIN_PORT: '70000' }), DEFAULT_SKIN_PORT)
})

// ---------------------------------------------------------------------------
// 礼物路由（ticket 25）：无素材源也要起；只查 armed 表；404/410/413/405
// ---------------------------------------------------------------------------

function armedEntry (filePath, bytes, { until = Date.now() + 60000 } = {}) {
  return {
    path: filePath,
    size: bytes.length,
    hash: sha256(bytes),
    visitId: '11111111-1111-4111-8111-111111111111',
    until
  }
}

async function giftFixture (t) {
  const dir = await tempDir(t)
  const bytes = Buffer.from('礼物本体：一条文件礼物', 'utf8')
  const file = join(dir, '报价单.pdf')
  await writeFile(file, bytes)
  const giftId = '22222222-2222-4222-8222-222222222222'
  const armed = new Map([[giftId, armedEntry(file, bytes)]])
  return { dir, file, bytes, giftId, armed, lookupGift: (id) => armed.get(id) ?? null }
}

test('没有素材源时服务器照常起：skin 路由 404，礼物路由可用（端口仍可被访客访问）', async (t) => {
  const { bytes, giftId, lookupGift } = await giftFixture(t)
  const server = await start(t, { sources: [], lookupGift })

  // 没装 dsh-pet 的用户：素材没有，但礼物端口必须在；源 id 为空（beacon 只带 skinPort）。
  assert.equal(server.skinId, null)
  assert.equal((await fetch(url(server, '/local-pet-skin/manifest'))).status, 404)

  const response = await fetch(url(server, GIFT_ROUTE + '/' + giftId))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('content-length'), String(bytes.length))
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)

  // HEAD 只回头，不发字节；v1 不做 Range。
  const head = await fetch(url(server, GIFT_ROUTE + '/' + giftId), { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(bytes.length))
  assert.equal(head.headers.get('accept-ranges'), null)
})

test('礼物路由：未知 id / 非 UUID / 多段路径 / 未 armed / 已过期 → 404；POST → 405', async (t) => {
  const { giftId, armed, lookupGift } = await giftFixture(t)
  const server = await start(t, { sources: [], lookupGift })

  assert.equal((await fetch(url(server, GIFT_ROUTE + '/'))).status, 404)
  assert.equal((await fetch(url(server, GIFT_ROUTE + '/gift-1'))).status, 404)
  assert.equal((await fetch(url(server, GIFT_ROUTE + '/' + encodeURIComponent('../' + giftId)))).status, 404)
  assert.equal((await fetch(url(server, GIFT_ROUTE + '/' + giftId + '/extra'))).status, 404)
  assert.equal((await fetch(url(server, GIFT_ROUTE + '/' + '33333333-3333-4333-8333-333333333333'))).status, 404)
  assert.equal((await fetch(url(server, GIFT_ROUTE + '/' + giftId), { method: 'POST' })).status, 405)

  // 过期（5 分钟窗口到了）即便表里还在也不可读。
  armed.set(giftId, { ...armed.get(giftId), until: Date.now() - 1 })
  assert.equal((await fetch(url(server, GIFT_ROUTE + '/' + giftId))).status, 404)
})

test('礼物路由：文件被删 / 大小变了 / 内容变了（hash 不符）→ 410', async (t) => {
  const { file, bytes, giftId, lookupGift } = await giftFixture(t)
  const server = await start(t, { sources: [], lookupGift })
  const target = url(server, GIFT_ROUTE + '/' + giftId)

  // 内容变了但长度一样：sha256 不符。
  await writeFile(file, Buffer.from('X'.repeat(bytes.length)))
  assert.equal((await fetch(target)).status, 410)

  // 大小变了。
  await writeFile(file, Buffer.from(bytes, 'utf8').subarray(0, 3))
  assert.equal((await fetch(target)).status, 410)

  // 删掉了。
  await rm(file)
  assert.equal((await fetch(target)).status, 410)
})

test('礼物路由：文件超过 16 MiB → 413（先于 410 的大小判定）', async (t) => {
  const dir = await tempDir(t)
  const file = join(dir, 'huge.bin')
  const bytes = Buffer.from('x')
  await writeFile(file, bytes)
  const giftId = '44444444-4444-4444-8444-444444444444'
  const armed = new Map([[giftId, armedEntry(file, bytes)]])
  const server = await start(t, { sources: [], lookupGift: (id) => armed.get(id) ?? null })

  // 发送之后被换成一个超过上限的文件：路由报“太大”，而不是“变了”。
  await writeFile(file, Buffer.alloc(MAX_GIFT_FILE_BYTES + 1, 1))
  assert.equal((await fetch(url(server, GIFT_ROUTE + '/' + giftId))).status, 413)
})

test('setSources：换表之后新源可取、删掉的源 404，端口不动', async (t) => {
  const dir = await tempDir(t)
  const a = Buffer.from('webm-A')
  const c = Buffer.from('webm-C')
  await writeFile(join(dir, 'A.webm'), a)
  await writeFile(join(dir, 'C.webm'), c)

  const first = {
    id: 'first',
    dirs: [dir],
    actions: { A: { file: 'A.webm', dir } }
  }
  const second = {
    id: 'second',
    dirs: [dir],
    actions: { C: { file: 'C.webm', dir } }
  }

  const server = await start(t, { sources: [first] })
  const port = server.port
  assert.equal(server.skinId, 'first')
  assert.equal((await fetch(url(server, '/local-pet-skin/second/manifest'))).status, 404)

  const applied = server.setSources([second])
  assert.deepEqual(applied, { count: 1, fallback: 'second' })
  assert.equal(server.port, port, '换表不换端口')
  assert.equal(server.skinId, 'second')

  const manifest = await (await fetch(url(server, '/local-pet-skin/second/manifest'))).json()
  assert.equal(manifest.id, 'second')
  assert.deepEqual(manifest.actions.C, { file: 'C.webm', loop: true, hash: sha256(c) })

  // 默认路由跟着换表走；被删掉的那张皮 404。
  assert.equal((await (await fetch(url(server, '/local-pet-skin/manifest'))).json()).id, 'second')
  assert.equal((await fetch(url(server, '/local-pet-skin/first/manifest'))).status, 404)
  assert.equal((await fetch(url(server, '/local-pet-skin/second/asset/C'))).status, 200)
})

test('setSources：同一个源对象不必重算 sha256（按对象缓存）', async (t) => {
  const dir = await tempDir(t)
  const bytes = Buffer.from('webm-A')
  await writeFile(join(dir, 'A.webm'), bytes)
  const source = { id: 'same', dirs: [dir], actions: { A: { file: 'A.webm', dir } } }

  const server = await start(t, { sources: [source] })
  const first = await (await fetch(url(server, '/local-pet-skin/same/manifest'))).json()

  // 换表时把同一个对象再放回去：清单必须逐字节一致（命中缓存，不重算）。
  server.setSources([source])
  const second = await (await fetch(url(server, '/local-pet-skin/same/manifest'))).json()
  assert.deepEqual(second, first)
})
