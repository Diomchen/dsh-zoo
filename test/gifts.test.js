import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { isVisitId } from '../src/protocol.js'
import {
  GIFTS_DIR,
  META_FILE,
  NOTE_FILE,
  createGiftStore,
  giftDirName,
  giftDirPath,
  isGiftDirName,
  normalizeGiftMeta
} from '../src/gifts.js'

const T0 = 1_760_000_000_000

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-gifts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function from () {
  return { deviceId: randomUUID(), nickname: '楼下的柯基' }
}

/** 用固定 UTC+8 的时间不容易跨时区复现；这里只断言形状，不断言具体时区。 */
function readMeta (dir, dirName) {
  return readFile(join(dir, GIFTS_DIR, dirName, META_FILE), 'utf8').then((text) => JSON.parse(text))
}

test('giftDirName：时间可读 + id 前 8 位；非法 id 给 null', () => {
  const id = 'ab12cd34-0000-4000-8000-000000000000'
  const name = giftDirName(id, T0)
  assert.match(name, /^\d{8}-\d{6}-ab12cd34$/)
  assert.equal(name, giftDirName(id, T0), '同一个 receivedAt 永远同一个目录名')
  assert.equal(isGiftDirName(name), true)
  assert.equal(giftDirName('gift-1', T0), null)
  assert.equal(isGiftDirName('../etc'), false)
  assert.equal(giftDirPath('/tmp/data', '../etc'), null)
  assert.equal(giftDirPath('/tmp/data', name), join('/tmp/data', GIFTS_DIR, name))
})

test('normalizeGiftMeta：只认白名单字段；版本/目录/正文不对就返回 null', () => {
  const id = randomUUID()
  const dir = giftDirName(id, T0)
  const valid = {
    version: 1,
    id,
    dir,
    from: { deviceId: randomUUID(), nickname: '  隔壁  ' },
    kind: 'text',
    text: '  第一行\n第二行  ',
    receivedAt: T0,
    opened: false,
    path: '/etc/passwd'
  }
  const meta = normalizeGiftMeta(valid)
  assert.deepEqual(Object.keys(meta), ['id', 'dir', 'from', 'kind', 'text', 'receivedAt', 'opened'])
  assert.equal(meta.id, id)
  assert.equal(meta.dir, dir)
  assert.equal(meta.text, '第一行\n第二行')
  assert.equal(meta.from.nickname, '隔壁')
  assert.equal(meta.opened, false)

  for (const broken of [
    { ...valid, version: 2 },
    { ...valid, id: 'gift-1' },
    { ...valid, dir: '../../etc' },
    { ...valid, kind: 'file' },
    { ...valid, text: '' },
    { ...valid, receivedAt: 0 },
    { ...valid, from: { deviceId: 'nope', nickname: 'x' } },
    { ...valid, from: null },
    null,
    []
  ]) {
    assert.equal(normalizeGiftMeta(broken), null, JSON.stringify(broken))
  }
})

test('createGiftStore：收下字条 → note.txt + meta.json 落盘，路径都在 gifts 目录里', async (t) => {
  const dir = await tempDir(t)
  const store = await createGiftStore(dir, { log: { warn () {} } })
  const id = randomUUID()
  const sender = from()
  const received = await store.receiveText({ id, from: sender, text: '第一行\n第二行', receivedAt: T0 })
  assert.equal(received.ok, true)
  assert.equal(received.gift.id, id)
  assert.match(received.gift.dirName, /^\d{8}-\d{6}-/)
  assert.equal(received.gift.dirPath.startsWith(join(dir, GIFTS_DIR)), true)
  assert.equal(received.gift.notePath, join(received.gift.dirPath, NOTE_FILE))

  const note = await readFile(received.gift.notePath, 'utf8')
  assert.equal(note, '第一行\n第二行\n')
  const meta = await readMeta(dir, received.gift.dirName)
  assert.deepEqual(Object.keys(meta), ['version', 'id', 'dir', 'from', 'kind', 'text', 'receivedAt', 'opened'])
  assert.equal(meta.version, 1)
  assert.equal(meta.id, id)
  assert.equal(meta.dir, received.gift.dirName)
  assert.deepEqual(meta.from, { deviceId: sender.deviceId.toLowerCase(), nickname: '楼下的柯基' })
  assert.equal(meta.kind, 'text')
  assert.equal(meta.text, '第一行\n第二行')
  assert.equal(meta.receivedAt, T0)
  assert.equal(meta.opened, false)

  const looked = store.lookup(id.toUpperCase())
  assert.equal(looked.id, id)
  assert.equal(looked.text, '第一行\n第二行')
  assert.equal(store.lookup(randomUUID()), null)
  assert.equal(store.lookup('gift-1'), null)
})

test('createGiftStore：非法 id / 空字条 / 坏 from 一律拒绝，不建目录', async (t) => {
  const dir = await tempDir(t)
  const store = await createGiftStore(dir, { log: { warn () {} } })
  for (const input of [
    { id: '../../etc', from: from(), text: 'x' },
    { id: randomUUID(), from: from(), text: '   ' },
    { id: randomUUID(), from: { deviceId: 'nope', nickname: 'x' }, text: 'x' },
    { id: randomUUID(), from: from(), text: 'x'.repeat(501) },
    {}
  ]) {
    const result = await store.receiveText({ ...input, receivedAt: T0 })
    assert.deepEqual(result, { ok: false, error: 'bad-gift' }, JSON.stringify(input))
  }
  const entries = await readdir(join(dir, GIFTS_DIR)).catch((error) => {
    assert.equal(error.code, 'ENOENT', '拒绝时不应创建 gifts 目录')
    return []
  })
  assert.deepEqual(entries, [])
})

test('createGiftStore：同一 giftId 重试原地覆盖（幂等），不同 id 撞名加后缀', async (t) => {
  const dir = await tempDir(t)
  const store = await createGiftStore(dir, { log: { warn () {} } })
  const id = randomUUID()
  const sender = from()
  const first = await store.receiveText({ id, from: sender, text: '第一版', receivedAt: T0 })
  await store.markOpened(id)
  const retry = await store.receiveText({ id, from: sender, text: '第二版', receivedAt: T0 + 5000 })
  assert.equal(retry.ok, true)
  assert.equal(retry.gift.dirName, first.gift.dirName, '同一件礼物只占一个目录')
  assert.equal(retry.gift.opened, true, '重试不该把“已打开”抹掉')
  assert.equal((await readdir(join(dir, GIFTS_DIR))).length, 1)
  assert.equal((await readFile(retry.gift.notePath, 'utf8')), '第二版\n')

  // 两个 id 前 8 位相同（目录名撞车），第二条必须加后缀，第一条一个字都不能变。
  const base = 'aaaaaaaa'
  const idA = base + '-1111-4111-8111-111111111111'
  const idB = base + '-2222-4222-8222-222222222222'
  const savedA = await store.receiveText({ id: idA, from: sender, text: 'A', receivedAt: T0 })
  const savedB = await store.receiveText({ id: idB, from: sender, text: 'B', receivedAt: T0 })
  assert.equal(savedA.gift.dirName === savedB.gift.dirName, false)
  assert.equal((await readFile(savedA.gift.notePath, 'utf8')), 'A\n')
  assert.equal((await readFile(savedB.gift.notePath, 'utf8')), 'B\n')
})

test('createGiftStore：同一个 giftId 的并发重试只建一个目录（写操作串行化）', async (t) => {
  const dir = await tempDir(t)
  const store = await createGiftStore(dir, { log: { warn () {} } })
  const id = randomUUID()
  const sender = from()
  const results = await Promise.all([
    '第一版', '第二版', '第三版', '第四版', '第五版'
  ].map((text, index) => store.receiveText({ id, from: sender, text, receivedAt: T0 + index })))
  for (const result of results) assert.equal(result.ok, true)
  const dirs = await readdir(join(dir, GIFTS_DIR))
  assert.equal(dirs.length, 1, '并发重试也只有一个目录')
  assert.equal(results.at(-1).gift.dirName, dirs[0])
  assert.equal((await readFile(results.at(-1).gift.notePath, 'utf8')), '第五版\n')
})

test('createGiftStore：重启后从磁盘读回来；坏 meta 只跳过那一条、只告警一次', async (t) => {
  const dir = await tempDir(t)
  const warnings = []
  const store = await createGiftStore(dir, { log: { warn: (line) => warnings.push(line) } })
  const id = randomUUID()
  const sender = from()
  const saved = await store.receiveText({ id, from: sender, text: '留个记号', receivedAt: T0 })
  assert.equal(saved.ok, true)

  // 另外两个目录：一个 meta 不是 JSON，一个 meta 的 dir 指错地方。
  const otherId = randomUUID()
  const brokenDir = join(dir, GIFTS_DIR, giftDirName(otherId, T0))
  await mkdir(brokenDir, { recursive: true })
  await writeFile(join(brokenDir, META_FILE), '{ broken', 'utf8')
  const wrongDirId = randomUUID()
  const wrongDir = join(dir, GIFTS_DIR, giftDirName(wrongDirId, T0))
  await mkdir(wrongDir, { recursive: true })
  await writeFile(join(wrongDir, META_FILE), JSON.stringify({
    version: 1,
    id: wrongDirId,
    dir: giftDirName(randomUUID(), T0),
    from: sender,
    kind: 'text',
    text: 'x',
    receivedAt: T0
  }), 'utf8')

  const reloaded = await createGiftStore(dir, { log: { warn: (line) => warnings.push(line) } })
  assert.deepEqual(reloaded.list().map((gift) => gift.id), [id])
  assert.equal(warnings.filter((line) => /meta\.json/.test(line)).length, 1, '只告警一次')
  assert.equal(warnings.filter((line) => /礼物目录里/.test(line)).length, 1)
})

test('createGiftStore：markOpened 落盘；discard 整目录删除且幂等失败', async (t) => {
  const dir = await tempDir(t)
  const store = await createGiftStore(dir, { log: { warn () {} } })
  const id = randomUUID()
  const saved = await store.receiveText({ id, from: from(), text: '点开看看', receivedAt: T0 })
  assert.equal(await store.markOpened(id), true)
  assert.equal((await readMeta(dir, saved.gift.dirName)).opened, true)
  assert.equal(store.lookup(id).opened, true)

  assert.deepEqual(await store.discard(id), { ok: true })
  assert.equal(store.lookup(id), null)
  assert.equal(await readdir(join(dir, GIFTS_DIR)).then((list) => list.length), 0)
  assert.deepEqual(await store.discard(id), { ok: false, error: 'gift-not-found' })
  assert.deepEqual(await store.discard('gift-1'), { ok: false, error: 'bad-gift' })
})

test('createGiftStore：gifts 路径被文件占住时只返回 write 失败，不抛、不内伤', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, GIFTS_DIR), 'not a directory', 'utf8')
  const warnings = []
  const store = await createGiftStore(dir, { log: { warn: (line) => warnings.push(line) } })
  const result = await store.receiveText({ id: randomUUID(), from: from(), text: 'x', receivedAt: T0 })
  assert.deepEqual(result, { ok: false, error: 'write' })
  // load 时“gifts 不是目录”会告警一次，写入失败再告警一次；两次都不抛。
  assert.equal(warnings.filter((line) => /礼物写不进去/.test(line)).length, 1)
  assert.match(warnings.at(-1), /礼物写不进去/)
})

test('giftDirPath / isVisitId：目录名只来自校验过的字符串', () => {
  const id = randomUUID()
  assert.equal(isVisitId(id), true)
  const name = giftDirName(id, T0)
  assert.equal(basename(giftDirPath('/tmp/x', name)), name)
  assert.equal(giftDirPath('/tmp/x', name + '/../../etc'), null)
  assert.equal(giftDirPath('/tmp/x', '20261103-153245-zzzzzzzz'), null)
})
