/**
 * 票 24：发送端背包（`<dataDir>/backpack.json`）。
 *
 * 这一层只回答四件事：能放什么、先带哪一件、什么时候不能撤、发送那一刻文件还在不在。
 * 全部用真磁盘（tmpdir），但不起 service/网络。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BACKPACK_FILE,
  BACKPACK_VERSION,
  MAX_BACKPACK_ITEMS,
  createBackpackStore,
  giftNameFromPath,
  nextItemAt,
  normalizeBackpackFile,
  normalizeBackpackItem,
  normalizeBringInput,
  oldestIdleItem
} from '../src/backpack.js'
import { MAX_GIFT_BYTES, MAX_GIFT_TEXT } from '../src/protocol.js'

const T0 = 1_700_000_000_000
const VISIT = '11111111-1111-4111-8111-111111111111'

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-backpack-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function logSink () {
  const warnings = []
  return { warnings, log: { warn (line) { warnings.push(line) } } }
}

async function writeBackpack (dir, value) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, BACKPACK_FILE), JSON.stringify(value), 'utf8')
}

async function readBackpack (dir) {
  return JSON.parse(await readFile(join(dir, BACKPACK_FILE), 'utf8'))
}

function textItem (id, text, at, overrides = {}) {
  return { id, kind: 'text', text, at, state: 'idle', ...overrides }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('normalizeBringInput：字条保留换行、≤500；文件只收本机绝对路径；别的一律 bad-gift', () => {
  assert.deepEqual(
    normalizeBringInput({ kind: 'text', text: '  第一行\r\n第二行  ' }),
    { ok: true, item: { kind: 'text', text: '第一行\n第二行' } }
  )
  assert.deepEqual(
    normalizeBringInput({ kind: 'file', path: '/Users/me/报价单.pdf' }),
    { ok: true, item: { kind: 'file', path: '/Users/me/报价单.pdf' } }
  )
  assert.equal(normalizeBringInput({ kind: 'file', path: 'C:\\Users\\me\\a.pdf' }).ok, true)

  for (const bad of [
    null,
    'text',
    [],
    {},
    { kind: 'movie', text: 'x' },
    { kind: 'text', text: '   ' },
    { kind: 'text', text: '字'.repeat(MAX_GIFT_TEXT + 1) },
    { kind: 'text', text: 42 },
    { kind: 'file', path: 'relative/a.pdf' },
    { kind: 'file', path: '' },
    { kind: 'file' }
  ]) {
    assert.deepEqual(normalizeBringInput(bad), { ok: false, error: 'bad-gift' }, JSON.stringify(bad))
  }
})

test('FIFO：at 最小的 idle 件先走；同一毫秒连放两件也排得出先后', () => {
  const first = textItem('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '先放的', T0)
  const second = textItem('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '后放的', T0 + 5)
  assert.equal(oldestIdleItem([second, first]).id, first.id)
  // out 中的不参与“下一件”，否则同一件会被两次串门带走。
  assert.equal(oldestIdleItem([{ ...first, state: 'out' }, second]).id, second.id)
  assert.equal(oldestIdleItem([]), null)
  assert.equal(nextItemAt([], T0), T0)
  assert.equal(nextItemAt([first], T0), T0 + 1, '同毫秒也要严格递增')
  assert.equal(nextItemAt([first], T0 + 10), T0 + 10)
})

test('normalizeBackpackItem：id/at/kind 必须合法；out 缺 visitId 就当 idle', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  assert.deepEqual(
    normalizeBackpackItem({ id, kind: 'text', text: ' 你好 ', at: T0, state: 'idle', extra: 'x' }),
    { id, kind: 'text', text: '你好', at: T0, state: 'idle' }
  )
  assert.equal(normalizeBackpackItem({ id: id.toUpperCase(), kind: 'text', text: 'x', at: T0 }).id, id)
  assert.deepEqual(
    normalizeBackpackItem({
      id,
      kind: 'file',
      path: '/Users/me/.hidden.pdf',
      name: '../报价单.pdf',
      at: T0,
      state: 'out',
      visitId: VISIT
    }),
    {
      id,
      kind: 'file',
      path: '/Users/me/.hidden.pdf',
      name: '报价单.pdf',
      at: T0,
      state: 'out'
    }
  )
  // out 没有合法 visitId：按 idle 处理（启动归一化本来也会放回 idle）。
  assert.equal(normalizeBackpackItem({ id, kind: 'text', text: 'x', at: T0, state: 'out' }).state, 'idle')
  for (const bad of [
    null,
    {},
    { id: 'gift-1', kind: 'text', text: 'x', at: T0 },
    { id, kind: 'text', text: 'x', at: 0 },
    { id, kind: 'text', text: '   ', at: T0 },
    { id, kind: 'file', path: 'relative.pdf', at: T0 },
    { id, kind: 'movie', text: 'x', at: T0 }
  ]) {
    assert.equal(normalizeBackpackItem(bad), null, JSON.stringify(bad))
  }
})

test('normalizeBackpackFile：损坏整份 → corrupt；坏件跳过；超过两件按 at 留最旧的', () => {
  for (const bad of [null, 42, 'x', { version: 2, items: [] }, { items: 'x' }]) {
    assert.equal(normalizeBackpackFile(bad).corrupt, true, JSON.stringify(bad))
  }
  const id = (n) => String(n).repeat(8) + '-' + String(n).repeat(4) + '-4' + String(n).repeat(3) +
    '-8' + String(n).repeat(3) + '-' + String(n).repeat(12)
  const normalized = normalizeBackpackFile({
    version: BACKPACK_VERSION,
    items: [
      textItem(id(3), '第三', T0 + 30),
      textItem(id(1), '第一', T0 + 10),
      textItem(id(2), '第二', T0 + 20),
      { id: 'bad', kind: 'text', text: '坏', at: T0 },
      textItem(id(1), '重复', T0 + 40)
    ]
  })
  assert.equal(normalized.corrupt, false)
  assert.deepEqual(normalized.items.map((item) => item.text), ['第一', '第二'])
  assert.equal(normalized.dropped, 3)

  // 手改成裸数组也认（与 visits.json 同一条容错约定）。
  const bare = normalizeBackpackFile([textItem(id(1), '唯一', T0)])
  assert.equal(bare.corrupt, false)
  assert.equal(bare.items.length, 1)
})

test('giftNameFromPath：去路径分隔符与前导点，空名退成 file', () => {
  assert.equal(giftNameFromPath('/Users/me/报价单.pdf'), '报价单.pdf')
  assert.equal(giftNameFromPath('C:\\Users\\me\\a.png'), 'a.png')
  assert.equal(giftNameFromPath('/Users/me/.secret'), 'secret')
  assert.equal(giftNameFromPath('/Users/me/'), 'file')
  assert.equal(giftNameFromPath(null), 'file')
})

// ---------------------------------------------------------------------------
// store：读写 / 满 / 撤回 / out / 启动归一化 / 源文件
// ---------------------------------------------------------------------------

test('空背包：文件不存在不告警；第一次 bring 之后才写 backpack.json', async (t) => {
  const dir = await tempDir(t)
  const { warnings, log } = logSink()
  const store = await createBackpackStore(dir, { log })
  assert.deepEqual(store.items(), [])
  assert.deepEqual(warnings, [])
  await assert.rejects(readFile(join(dir, BACKPACK_FILE), 'utf8'), /ENOENT/)

  const added = await store.add({ kind: 'text', text: '第一件' })
  assert.equal(added.ok, true)
  assert.equal(added.count, 1)
  const raw = await readBackpack(dir)
  assert.equal(raw.version, BACKPACK_VERSION)
  assert.deepEqual(Object.keys(raw.items[0]), ['id', 'kind', 'text', 'at', 'state'])
  assert.equal(raw.items[0].state, 'idle')
  // tmp + rename：目录里只留最终文件，没有 .tmp-*。
  assert.deepEqual(await readdir(dir), [BACKPACK_FILE])
})

test('最多两件：满了明确 backpack-full，绝不静默挤掉旧件', async (t) => {
  const dir = await tempDir(t)
  const store = await createBackpackStore(dir, { log: logSink().log })
  const first = await store.add({ kind: 'text', text: '第一件' })
  const second = await store.add({ kind: 'text', text: '第二件' })
  const third = await store.add({ kind: 'text', text: '第三件' })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.deepEqual(third, { ok: false, error: 'backpack-full', persisted: false })
  assert.equal(MAX_BACKPACK_ITEMS, 2)
  assert.deepEqual(store.items().map((item) => item.text), ['第一件', '第二件'])
})

test('撤掉：只有 idle 能撤；out 明确 gift-out；不存在是 gift-not-found；坏 id 是 bad-gift', async (t) => {
  const dir = await tempDir(t)
  const store = await createBackpackStore(dir, { log: logSink().log })
  const added = await store.add({ kind: 'text', text: '要撤的' })
  assert.equal((await store.remove(added.item.id)).ok, true)
  assert.deepEqual(store.items(), [])
  assert.equal((await store.remove(added.item.id)).error, 'gift-not-found')
  assert.equal((await store.remove('gift-1')).error, 'bad-gift')

  const out = await store.add({ kind: 'text', text: '要带走的' })
  assert.equal((await store.markOut(out.item.id, VISIT)).ok, true)
  assert.deepEqual(await store.remove(out.item.id), { ok: false, error: 'gift-out', persisted: false })
  assert.equal(store.items()[0].state, 'out')
  // 发送失败（根本没出门）才允许放回 idle。
  assert.equal((await store.releaseOut(out.item.id, VISIT)).ok, true)
  assert.equal(store.items()[0].state, 'idle')
})

test('启动归一化：遗留的 out 全部变回 idle 并写回磁盘（那次串门不可能还在）', async (t) => {
  const dir = await tempDir(t)
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  await writeBackpack(dir, {
    version: BACKPACK_VERSION,
    items: [textItem(id, '上次没回来', T0, { state: 'out', visitId: VISIT })]
  })
  const { warnings, log } = logSink()
  const store = await createBackpackStore(dir, { log })
  assert.deepEqual(warnings, [])
  assert.equal(store.items()[0].state, 'idle')
  const raw = await readBackpack(dir)
  assert.equal(raw.items[0].state, 'idle')
  assert.equal('visitId' in raw.items[0], false)
})

test('损坏的背包：空背包 + 只告警一次；之后 bring 仍能写出合法文件', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, BACKPACK_FILE), '{ 不是 JSON', 'utf8')
  const { warnings, log } = logSink()
  const store = await createBackpackStore(dir, { log })
  assert.deepEqual(store.items(), [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /背包/)

  assert.equal((await store.add({ kind: 'text', text: '新的' })).ok, true)
  assert.equal((await store.add({ kind: 'text', text: '再一件' })).ok, true)
  // 写盘成功，不该因为“之前坏过”再告警。
  assert.equal(warnings.length, 1)
  assert.equal((await readBackpack(dir)).items.length, 2)
})

test('文件件：只存路径 + name；源文件不存在/是目录/超过 16 MiB 都有明确错误码', async (t) => {
  const dir = await tempDir(t)
  const store = await createBackpackStore(dir, { log: logSink().log })
  assert.equal((await store.add({ kind: 'file', path: join(dir, 'missing.pdf') })).error, 'no-such-file')

  const folder = join(dir, 'folder')
  await mkdir(folder)
  assert.equal((await store.add({ kind: 'file', path: folder })).error, 'no-such-file')

  const tooLarge = join(dir, 'big.bin')
  await writeFile(tooLarge, '')
  await truncate(tooLarge, MAX_GIFT_BYTES + 1)
  assert.equal((await store.add({ kind: 'file', path: tooLarge })).error, 'too-large')

  const small = join(dir, '.报价单.pdf')
  await writeFile(small, 'hello')
  const added = await store.add({ kind: 'file', path: small })
  assert.equal(added.ok, true)
  assert.equal(added.item.kind, 'file')
  assert.equal(added.item.path, small)
  assert.equal(added.item.name, '报价单.pdf')
  const raw = await readBackpack(dir)
  assert.deepEqual(Object.keys(raw.items[0]), ['id', 'kind', 'path', 'name', 'at', 'state'])
  assert.equal(raw.items[0].size, undefined, 'size 不在背包里存')
  assert.equal(raw.items[0].sha256, undefined, 'sha256 不在背包里存')
})

test('发送那一刻才读 size/sha256：文件消失 → 留在背包 + no-such-file', async (t) => {
  const dir = await tempDir(t)
  const store = await createBackpackStore(dir, { log: logSink().log })
  const file = join(dir, 'note.txt')
  await writeFile(file, 'hello world')
  const added = await store.add({ kind: 'file', path: file })
  assert.equal(added.ok, true)

  const prepared = await store.prepareGift(store.oldestIdle())
  assert.deepEqual(prepared.gift, {
    id: added.item.id,
    kind: 'file',
    name: 'note.txt',
    size: 11,
    sha256: 'sha256:' + createHash('sha256').update('hello world').digest('hex')
  })

  await rm(file)
  assert.deepEqual(await store.prepareGift(store.oldestIdle()), { ok: false, error: 'no-such-file' })
  // 背包状态没变：东西还在，下一次还能再试。
  assert.equal(store.items()[0].state, 'idle')
  assert.equal(store.items()[0].path, file)
})

test('发送那一刻文件变大超过 16 MiB：too-large，仍留在背包', async (t) => {
  const dir = await tempDir(t)
  const store = await createBackpackStore(dir, { log: logSink().log })
  const file = join(dir, 'grow.bin')
  await writeFile(file, 'x')
  await store.add({ kind: 'file', path: file })
  await truncate(file, MAX_GIFT_BYTES + 1)
  assert.deepEqual(await store.prepareGift(store.oldestIdle()), { ok: false, error: 'too-large' })
  assert.equal(store.items()[0].state, 'idle')
})

test('字条件 prepareGift 直接给协议形状（id/kind/text），不需要碰磁盘', async (t) => {
  const dir = await tempDir(t)
  const store = await createBackpackStore(dir, { log: logSink().log })
  const added = await store.add({ kind: 'text', text: '  第一行\n第二行  ' })
  assert.deepEqual(await store.prepareGift(store.oldestIdle()), {
    ok: true,
    gift: { id: added.item.id, kind: 'text', text: '第一行\n第二行' }
  })
})
