import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { startSkinServer, DEFAULT_SKIN_PORT, resolveSkinPort } from '../src/skin-server.js'

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-skin-server-'))
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
  const server = await startSkinServer({ host: '127.0.0.1', port: 0, ...options })
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

  const response = await fetch(url(server, '/local-pet-skin/manifest'))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json/)
  const manifest = await response.json()
  assert.equal(manifest.v, 1)
  assert.equal(manifest.id, 'test')
  assert.equal(manifest.name, '测试皮肤')
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
  const server = await startSkinServer({
    sources: [source],
    host: '127.0.0.1',
    port: busy,
    maxPortTries: 1
  })
  assert.equal(server, null)

  const next = await startSkinServer({
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
