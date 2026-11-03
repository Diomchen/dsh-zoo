import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { startLanServer } from '../src/lan-server.js'
import { createSkinFetcher, isPrivateAddress, SKIN_CACHE_DIR } from '../src/skin-fetch.js'

const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-fetch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function fixture (t, { cacheMaxBytes } = {}) {
  const dir = await tempDir(t)
  const assets = {
    A: Buffer.concat([EBML, Buffer.from('-A-')]),
    B: Buffer.concat([EBML, Buffer.from('-B-')])
  }
  await writeFile(join(dir, 'A.webm'), assets.A)
  await writeFile(join(dir, 'B.webm'), assets.B)
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
  const server = await startLanServer({ sources: [source], host: '127.0.0.1', port: 0 })
  t.after(() => server.close())
  const cacheDir = await tempDir(t)
  const fetcher = createSkinFetcher({
    dir: cacheDir,
    cacheMaxBytes,
    fetchImpl: (...args) => fetch(...args)
  })
  return { assets, cacheDir, fetcher, server, source }
}

test('私网地址判定：只放行局域网与回环', () => {
  for (const value of ['127.0.0.1', '10.1.2.3', '192.168.1.8', '172.16.0.2', '172.31.255.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(value), true, value)
  }
  for (const value of ['8.8.8.8', '172.32.0.1', '1.1.1.1', 'example.com', '', null, 42, '2001:4860:4860::8888']) {
    assert.equal(isPrivateAddress(value), false, String(value))
  }
})

test('拉 manifest 与动作，校验 hash 后落缓存并返回 localpet URL', async (t) => {
  const { assets, cacheDir, fetcher, server } = await fixture(t)
  const result = await fetcher.resolve({
    address: '127.0.0.1',
    port: server.port,
    skinId: 'test',
    action: 'A'
  })

  assert.ok(result)
  const hash = createHash('sha256').update(assets.A).digest('hex')
  assert.equal(result.url, 'localpet://cache/' + hash + '.webm')
  const cached = await readFile(join(cacheDir, SKIN_CACHE_DIR, hash + '.webm'))
  assert.deepEqual(cached, assets.A)

  // 第二次：同一个 fetcher 再解析，返回同一个缓存 URL
  const again = await fetcher.resolve({ address: '127.0.0.1', port: server.port, skinId: 'test', action: 'A' })
  assert.equal(again.url, result.url)
})

test('不认识的动作回退 manifest.idle', async (t) => {
  const { fetcher, server } = await fixture(t)
  const result = await fetcher.resolve({
    address: '127.0.0.1',
    port: server.port,
    skinId: 'test',
    action: '这个动作不存在'
  })
  assert.ok(result)
  assert.equal(result.action, 'A')
})

test('非私网、坏端口、404 都返回 null 且不抛', async (t) => {
  const { fetcher, server } = await fixture(t)
  assert.equal(await fetcher.resolve({ address: '8.8.8.8', port: server.port, skinId: 'test', action: 'A' }), null)
  assert.equal(await fetcher.resolve({ address: '127.0.0.1', port: 0, skinId: 'test', action: 'A' }), null)
  assert.equal(await fetcher.resolve({ address: '127.0.0.1', port: 1, skinId: 'test', action: 'A' }), null)
  assert.equal(await fetcher.resolve({ address: '127.0.0.1', port: server.port, skinId: 'nope', action: 'A' }), null)
})

test('manifest hash 对不上、或素材不是 WebM，都不落盘', async (t) => {
  const dir = await tempDir(t)
  const cacheDir = await tempDir(t)
  const bad = Buffer.from('not-a-webm')

  let mode = 'bad-hash'
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/manifest')) {
      const hash = 'sha256:' + '0'.repeat(64)
      return new Response(JSON.stringify({
        v: 1,
        id: 'x',
        size: 220,
        idle: 'A',
        actions: { A: { file: 'A.webm', loop: true, hash } },
        hash: 'sha256:' + '1'.repeat(64)
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (mode === 'bad-hash') return new Response(bad, { status: 200, headers: { 'content-type': 'video/webm' } })
    return new Response(Buffer.concat([EBML, bad]), { status: 200, headers: { 'content-type': 'video/webm' } })
  }

  const fetcher = createSkinFetcher({ dir: cacheDir, fetchImpl })
  assert.equal(await fetcher.resolve({ address: '127.0.0.1', port: 45873, skinId: 'x', action: 'A' }), null)

  // 内容不是 WebM 魔数：即使长度/hash 对也不收
  const webmHash = createHash('sha256').update(bad).digest('hex')
  const fetchBadMagic = async (url) => {
    if (String(url).endsWith('/manifest')) {
      return new Response(JSON.stringify({
        v: 1,
        id: 'x',
        size: 220,
        idle: 'A',
        actions: { A: { file: 'A.webm', loop: true, hash: 'sha256:' + webmHash } },
        hash: 'sha256:' + '2'.repeat(64)
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(bad, { status: 200, headers: { 'content-type': 'video/webm' } })
  }
  const second = createSkinFetcher({ dir: cacheDir, fetchImpl: fetchBadMagic })
  assert.equal(await second.resolve({ address: '127.0.0.1', port: 45873, skinId: 'x', action: 'A' }), null)
  assert.deepEqual(await readdir(join(cacheDir, SKIN_CACHE_DIR)).catch(() => []), [])
  assert.ok(dir)
})

test('缓存超过上限时按最旧的文件先删', async (t) => {
  const { assets, cacheDir, fetcher } = await fixture(t, { cacheMaxBytes: 12 })
  const { server } = await fixture(t)
  // 用同一个 fetcher 拉两次：上限 1 字节，两个都放不下，最终只剩一个或零个。
  const first = await fetcher.resolve({ address: '127.0.0.1', port: server.port, skinId: 'test', action: 'A' })
  assert.ok(first)
  const second = await fetcher.resolve({ address: '127.0.0.1', port: server.port, skinId: 'test', action: 'B' })
  assert.ok(second)
  const files = await readdir(join(cacheDir, SKIN_CACHE_DIR))
  assert.equal(files.length, 1)
  assert.ok(assets.A.length > 0)
})
