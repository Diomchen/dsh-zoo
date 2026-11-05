/**
 * 票 25：文件礼物的拉取客户端。
 *
 * 真的起一个本地 HTTP 源（127.0.0.1），验证：流式落盘、连接/总时长两条超时、
 * sha256 与大小双校验、`.part` 清理、失败冷却，以及失败原因只落在固定词表里。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createGiftFetcher } from '../src/gift-fetch.js'

const GIFT_ID = '22222222-2222-4222-8222-222222222222'

function sha256 (bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex')
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-gift-fetch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function start (t, handler) {
  const state = { hits: { count: 0, paths: [] } }
  return (async () => {
    const server = createServer((req, res) => {
      state.hits.count += 1
      state.hits.paths.push(req.url)
      handler(req, res)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => {
      // undici 的 keep-alive 默认 4s；不主动关掉空闲连接，测试会白等。
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(resolve))
    })
    return { port: server.address().port, hits: state.hits }
  })()
}

test('正常拉取：流式写盘、sha256 对、没有留下 .part', async (t) => {
  const dir = await tempDir(t)
  const target = join(dir, GIFT_ID, '报价单.pdf')
  const bytes = Buffer.from('这是一份报价单，内容有中文也有 emoji 🐾', 'utf8')
  const source = await start(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
    res.end(bytes)
  })
  const fetcher = createGiftFetcher()

  const result = await fetcher.fetchTo({
    address: '127.0.0.1',
    port: source.port,
    giftId: GIFT_ID,
    targetPath: target,
    size: bytes.length,
    sha256: sha256(bytes)
  })
  assert.deepEqual(result, { ok: true, size: bytes.length, sha256: sha256(bytes) })
  assert.deepEqual(await readFile(target), bytes)
  assert.equal(existsSync(target + '.part'), false)
  assert.deepEqual(source.hits.paths, ['/dsh-zoo-gift/' + GIFT_ID])
})

test('旧版邻居只认 /local-pet-gift：新路由 404 后再回落旧路由', async (t) => {
  const dir = await tempDir(t)
  const target = join(dir, GIFT_ID, '旧礼物.txt')
  const bytes = Buffer.from('来自旧版本邻居的文件礼物', 'utf8')
  const source = await start(t, (req, res) => {
    if (req.url === '/local-pet-gift/' + GIFT_ID) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length })
      res.end(bytes)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })

  const result = await createGiftFetcher().fetchTo({
    address: '127.0.0.1',
    port: source.port,
    giftId: GIFT_ID,
    targetPath: target,
    size: bytes.length,
    sha256: sha256(bytes)
  })

  assert.deepEqual(result, { ok: true, size: bytes.length, sha256: sha256(bytes) })
  assert.deepEqual(await readFile(target), bytes)
  assert.deepEqual(source.hits.paths, [
    '/dsh-zoo-gift/' + GIFT_ID,
    '/local-pet-gift/' + GIFT_ID
  ])
})

test('只连私网/回环：公网地址直接 refused，不发请求', async (t) => {
  const dir = await tempDir(t)
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    res.end('x')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    return new Promise((resolve) => server.close(resolve))
  })

  const fetcher = createGiftFetcher()
  const result = await fetcher.fetchTo({
    address: '8.8.8.8',
    port: server.address().port,
    giftId: GIFT_ID,
    targetPath: join(dir, 'x.bin'),
    size: 1,
    sha256: sha256(Buffer.from('x'))
  })
  assert.deepEqual(result, { ok: false, error: 'refused' })
  assert.equal(hits, 0)
})

test('sha256 与大小双校验：不符就 checksum，且不落盘、不留 .part', async (t) => {
  const dir = await tempDir(t)
  const bytes = Buffer.from('真的内容')
  const wrong = Buffer.from('假的内容')
  assert.equal(bytes.length, wrong.length)
  const source = await start(t, (req, res) => {
    res.writeHead(200, { 'content-length': wrong.length })
    res.end(wrong)
  })
  const target = join(dir, GIFT_ID, 'x.bin')
  const fetcher = createGiftFetcher()

  const result = await fetcher.fetchTo({
    address: '127.0.0.1',
    port: source.port,
    giftId: GIFT_ID,
    targetPath: target,
    size: bytes.length,
    sha256: sha256(bytes)
  })
  assert.deepEqual(result, { ok: false, error: 'checksum' })
  assert.equal(existsSync(target), false)
  assert.equal(existsSync(target + '.part'), false)
})

test('对方声明的长度与 wire 上的 size 不符：直接 checksum，不下载', async (t) => {
  const dir = await tempDir(t)
  const source = await start(t, (req, res) => {
    res.writeHead(200, { 'content-length': 5 })
    res.end('12345')
  })
  const target = join(dir, GIFT_ID, 'x.bin')
  const result = await createGiftFetcher().fetchTo({
    address: '127.0.0.1',
    port: source.port,
    giftId: GIFT_ID,
    targetPath: target,
    size: 99,
    sha256: sha256(Buffer.from('12345'))
  })
  assert.deepEqual(result, { ok: false, error: 'checksum' })
  assert.equal(existsSync(target + '.part'), false)
})

test('超过 16 MiB：对方声明太大直接 too-large；实际流超限也 too-large', async (t) => {
  const dir = await tempDir(t)
  const declared = await start(t, (req, res) => {
    res.writeHead(200, { 'content-length': 17 * 1024 * 1024 })
    res.end('x')
  })
  const fetcher = createGiftFetcher({ maxBytes: 64 })
  const first = await fetcher.fetchTo({
    address: '127.0.0.1',
    port: declared.port,
    giftId: GIFT_ID,
    targetPath: join(dir, 'a.bin'),
    size: 1,
    sha256: sha256(Buffer.from('x'))
  })
  assert.deepEqual(first, { ok: false, error: 'too-large' })

  // 声明说谎（没有 content-length），实读超过上限。
  const streaming = await start(t, (req, res) => {
    res.writeHead(200)
    res.end(Buffer.alloc(128, 1))
  })
  const second = await fetcher.fetchTo({
    address: '127.0.0.1',
    port: streaming.port,
    giftId: GIFT_ID,
    targetPath: join(dir, 'b.bin'),
    size: 128,
    sha256: sha256(Buffer.alloc(128, 1))
  })
  assert.deepEqual(second, { ok: false, error: 'too-large' })
  assert.equal(existsSync(join(dir, 'b.bin.part')), false)
})

test('连接超时 / 传输总超时：timeout，冷却期内不再打同一来源', async (t) => {
  const dir = await tempDir(t)
  const source = await start(t, () => {
    // 永不响应：连接超时。
  })
  const fetcher = createGiftFetcher({ connectTimeoutMs: 80, totalTimeoutMs: 300 })
  const first = await fetcher.fetchTo({
    address: '127.0.0.1',
    port: source.port,
    giftId: GIFT_ID,
    targetPath: join(dir, 'a.bin'),
    size: 1,
    sha256: sha256(Buffer.from('x'))
  })
  assert.deepEqual(first, { ok: false, error: 'timeout' })
  assert.equal(source.hits.count, 1)

  // 冷却期内（60 秒）不再重试；原因沿用上一次的。
  const second = await fetcher.fetchTo({
    address: '127.0.0.1',
    port: source.port,
    giftId: GIFT_ID,
    targetPath: join(dir, 'a.bin'),
    size: 1,
    sha256: sha256(Buffer.from('x'))
  })
  assert.deepEqual(second, { ok: false, error: 'timeout', cooldown: true })
  assert.equal(source.hits.count, 1)

  // 总时长超时：响应头已经回来了，正文一半就不动了。
  const slow = await start(t, (req, res) => {
    res.writeHead(200, { 'content-length': 100 })
    res.write('half')
  })
  const slowFetcher = createGiftFetcher({ connectTimeoutMs: 1000, totalTimeoutMs: 80 })
  const third = await slowFetcher.fetchTo({
    address: '127.0.0.1',
    port: slow.port,
    giftId: GIFT_ID,
    targetPath: join(dir, 'b.bin'),
    size: 100,
    sha256: sha256(Buffer.alloc(100, 1))
  })
  assert.deepEqual(third, { ok: false, error: 'timeout' })
  assert.equal(existsSync(join(dir, 'b.bin.part')), false)
})

test('对方回 410/404：refused；回 413：too-large', async (t) => {
  const dir = await tempDir(t)
  const gone = await start(t, (req, res) => {
    res.writeHead(410)
    res.end()
  })
  const refused = await createGiftFetcher().fetchTo({
    address: '127.0.0.1',
    port: gone.port,
    giftId: GIFT_ID,
    targetPath: join(dir, 'a.bin'),
    size: 1,
    sha256: sha256(Buffer.from('x'))
  })
  assert.deepEqual(refused, { ok: false, error: 'refused' })

  const big = await start(t, (req, res) => {
    res.writeHead(413)
    res.end()
  })
  const tooLarge = await createGiftFetcher().fetchTo({
    address: '127.0.0.1',
    port: big.port,
    giftId: GIFT_ID,
    targetPath: join(dir, 'b.bin'),
    size: 1,
    sha256: sha256(Buffer.from('x'))
  })
  assert.deepEqual(tooLarge, { ok: false, error: 'too-large' })
})

test('写盘失败：write（不留半个文件，也不当成网络失败）', async (t) => {
  const dir = await tempDir(t)
  const blocker = join(dir, 'this-is-a-file')
  await writeFile(blocker, 'not a directory')
  const source = await start(t, (req, res) => {
    res.writeHead(200, { 'content-length': 1 })
    res.end('x')
  })
  const result = await createGiftFetcher().fetchTo({
    address: '127.0.0.1',
    port: source.port,
    giftId: GIFT_ID,
    // 父路径是一个普通文件：mkdir 会 ENOTDIR。
    targetPath: join(blocker, 'x.bin'),
    size: 1,
    sha256: sha256(Buffer.from('x'))
  })
  assert.deepEqual(result, { ok: false, error: 'write' })
})
