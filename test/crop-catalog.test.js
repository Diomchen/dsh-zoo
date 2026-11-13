/**
 * 票 59：运行时作物目录（`src/crop-catalog.js`）。
 *
 * 覆盖：单条定义的夹取、定义/目录哈希的稳定性、三层合并的优先级与冲突收敛、
 * 本机 `crops.json` + 图目录的容错读法、图按内容哈希落盘。
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ART_EXTENSIONS,
  CROP_ART_DIR,
  CROPS_DIR,
  CROPS_FILE,
  MAX_ART_BYTES,
  artFileName,
  buildCatalog,
  catalogEntries,
  catalogHash,
  chunkCatalog,
  cropDefHash,
  isArtFileName,
  normalizeCropDef,
  readLocalCrops,
  readRemoteCatalog,
  writeCropArt,
  writeRemoteCatalog
} from '../src/crop-catalog.js'
import { BUILTIN_CROPS, CROPS, CROP_IDS, applyCropCatalog, resetCropCatalog } from '../src/farm-rules.js'

const require = createRequire(import.meta.url)
const farmView = require('../desktop/farm-view.js')

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

function def (overrides = {}) {
  return { id: 'blueberry', name: '蓝莓', growMs: 90 * MINUTE, seedPrice: 30, yield: 4, base: 18, ...overrides }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-crops-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------------------
// 单条定义
// ---------------------------------------------------------------------------

test('作物定义：六种内置条目都能通过校验，且 id 与键一致', () => {
  for (const id of Object.keys(BUILTIN_CROPS)) {
    const normalized = normalizeCropDef(BUILTIN_CROPS[id])
    assert.ok(normalized, id + ' 应该合格')
    assert.equal(normalized.id, id)
    assert.equal(normalized.base, BUILTIN_CROPS[id].base)
  }
})

test('作物定义：坏 id / 坏名字 / 越界数值整条丢掉，不做部分修补', () => {
  assert.equal(normalizeCropDef(null), null)
  assert.equal(normalizeCropDef('tomato'), null)
  assert.equal(normalizeCropDef(def({ id: 'Blueberry' })), null, 'id 只认小写')
  assert.equal(normalizeCropDef(def({ id: 'b' })), null, 'id 至少两位')
  assert.equal(normalizeCropDef(def({ id: 'x'.repeat(25) })), null, 'id 最多 24 位')
  assert.equal(normalizeCropDef(def({ id: 'blue berry' })), null)
  assert.equal(normalizeCropDef(def({ name: '  ' })), null)
  assert.equal(normalizeCropDef(def({ name: '长'.repeat(17) })), null, '名字最多 16 字')
  assert.equal(normalizeCropDef(def({ growMs: 59 * 1000 })), null, '快过一分钟没意义')
  assert.equal(normalizeCropDef(def({ growMs: 31 * 24 * HOUR })), null, '慢过三十天长不完')
  assert.equal(normalizeCropDef(def({ seedPrice: 0 })), null)
  assert.equal(normalizeCropDef(def({ yield: 100 })), null)
  assert.equal(normalizeCropDef(def({ base: 0 })), null)
  // 控制字符从名字里剥掉，其余字段照常：名字洗净以后还是合法的。
  assert.equal(normalizeCropDef(def({ name: '蓝\u0000莓' })).name, '蓝莓')
})

test('定义哈希：相同的数值算出同一个哈希，与键顺序无关；改动任何一项都会变', () => {
  const a = def()
  const reordered = { base: 18, yield: 4, seedPrice: 30, growMs: 90 * MINUTE, name: '蓝莓', id: 'blueberry' }
  assert.equal(cropDefHash(a), cropDefHash(reordered))
  assert.notEqual(cropDefHash(a), cropDefHash(def({ base: 19 })))
  assert.notEqual(cropDefHash(a), cropDefHash(def({ name: '蔓越莓' })))
  assert.equal(cropDefHash({ id: 'BAD' }), null)
})

test('目录哈希：与顺序无关，多一种作物就变，换图也会变', () => {
  const one = [def()]
  const two = [def(), def({ id: 'kiwi', name: '猕猴桃', growMs: 3 * HOUR })]
  assert.equal(catalogHash(one), catalogHash([...one].reverse()))
  assert.notEqual(catalogHash(one), catalogHash(two))
  assert.equal(catalogHash([]), catalogHash([null, 'x']))
  // 票 59：图的内容哈希也进指纹——只换图、不改数值，邻居也该重拉一次。
  const withArt = [def({ art: { hash: '0123456789abcdef', ext: 'svg', bytes: 100 } })]
  const otherArt = [def({ art: { hash: 'fedcba9876543210', ext: 'svg', bytes: 100 } })]
  assert.notEqual(catalogHash(withArt), catalogHash(one))
  assert.notEqual(catalogHash(withArt), catalogHash(otherArt))
})

// ---------------------------------------------------------------------------
// 三层合并
// ---------------------------------------------------------------------------

test('合并：内置打底，网络目录补新 id，本机手写的永远赢', () => {
  const remote = [def({ base: 20 })]
  const local = [def({ base: 99, name: '我家的蓝莓' })]
  const { defs, sources } = buildCatalog({ remote, local })
  assert.equal(sources.get('tomato'), 'builtin')
  assert.equal(defs.get('blueberry').base, 99, '本机条目覆盖网络条目')
  assert.equal(sources.get('blueberry'), 'local')

  const withoutLocal = buildCatalog({ remote })
  assert.equal(withoutLocal.defs.get('blueberry').base, 20)
  assert.equal(withoutLocal.sources.get('blueberry'), 'remote')
})

test('合并冲突：同 id 不同定义按哈希字典序小的赢，且与到达顺序无关', () => {
  const left = def({ base: 10 })
  const right = def({ base: 40 })
  const winner = cropDefHash(left) < cropDefHash(right) ? 10 : 40
  const loser = winner === 10 ? 40 : 10

  const first = buildCatalog({ remote: [left, right] })
  const second = buildCatalog({ remote: [right, left] })
  assert.equal(first.defs.get('blueberry').base, winner, '先到先算也要收敛到哈希小者')
  assert.equal(second.defs.get('blueberry').base, winner, '后到也要收敛到同一个')
  assert.ok(first.conflicts.includes('blueberry'))
  assert.ok(loser === (winner === 10 ? 40 : 10))
})

test('目录排序：按生长时长，同长按 id；应用进 farm-rules 以后顺序也跟着走', (t) => {
  t.after(() => resetCropCatalog())
  const entries = catalogEntries(new Map([
    ['b', def({ id: 'b', growMs: 5 * HOUR })],
    ['a', def({ id: 'a', growMs: 5 * HOUR })],
    ['c', def({ id: 'c', growMs: 2 * HOUR })]
  ]))
  assert.deepEqual(entries.map((entry) => entry.id), ['c', 'a', 'b'])

  const added = applyCropCatalog([def()])
  assert.deepEqual(added, ['blueberry'])
  assert.equal(CROPS.blueberry.name, '蓝莓')
  assert.equal(CROP_IDS.includes('blueberry'), true)
  assert.deepEqual(
    CROP_IDS.slice(CROP_IDS.indexOf('strawberry'), CROP_IDS.indexOf('strawberry') + 3),
    ['strawberry', 'blueberry', 'radish'],
    '90 分钟的蓝莓排在 45 分钟的草莓和 90 分钟的白萝卜之间'
  )
  // 再应用一次是覆盖，不是重复追加。
  applyCropCatalog([def({ base: 21 })])
  assert.equal(CROPS.blueberry.base, 21)
  assert.equal(CROP_IDS.filter((id) => id === 'blueberry').length, 1)
})

// ---------------------------------------------------------------------------
// 本机文件
// ---------------------------------------------------------------------------

test('本机目录：没有 crops.json 不算错，什么都不返回', async (t) => {
  const dir = await tempDir(t)
  const out = await readLocalCrops({ dir })
  assert.deepEqual(out.entries, [])
  assert.equal(out.art.size, 0)
  assert.deepEqual(out.warnings, [])
})

test('本机目录：坏 JSON / 缺数组只告警不抛，坏条目只丢自己', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, CROPS_FILE), '{ 这不是 json')
  const broken = await readLocalCrops({ dir })
  assert.deepEqual(broken.entries, [])
  assert.equal(broken.warnings.length, 1)
  assert.match(broken.warnings[0], /读不出来/)

  await writeFile(join(dir, CROPS_FILE), JSON.stringify({ version: 1 }))
  assert.match((await readLocalCrops({ dir })).warnings[0], /缺 crops 数组/)

  await writeFile(join(dir, CROPS_FILE), JSON.stringify({
    version: 1,
    crops: [
      def(),
      def({ id: 'BLUEBERRY' }), // 坏 id
      def({ name: '蔓越莓', seedPrice: 0 }), // 坏价格
      def() // 重复
    ]
  }))
  const mixed = await readLocalCrops({ dir })
  assert.deepEqual(mixed.entries.map((entry) => entry.id), ['blueberry'])
  assert.equal(mixed.warnings.filter((line) => line.includes('不合格')).length, 2)
  assert.equal(mixed.warnings.filter((line) => line.includes('重复')).length, 1)
})

test('本机目录：图按 <id>.svg / <id>.png 找，太大的和带 <script 的不要', async (t) => {
  const dir = await tempDir(t)
  await mkdir(join(dir, CROPS_DIR), { recursive: true })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>'
  await writeFile(join(dir, CROPS_DIR, 'blueberry.svg'), svg)
  await writeFile(join(dir, CROPS_DIR, 'kiwi.svg'), '<svg onload="x"><script>alert(1)</script></svg>')
  await writeFile(join(dir, CROPS_DIR, 'pear.svg'), 'x'.repeat(MAX_ART_BYTES + 1))
  await writeFile(join(dir, CROPS_FILE), JSON.stringify({
    version: 1,
    crops: [def(), def({ id: 'kiwi', name: '猕猴桃' }), def({ id: 'pear', name: '梨' })]
  }))

  const out = await readLocalCrops({ dir })
  assert.deepEqual(out.entries.map((entry) => entry.id), ['blueberry', 'kiwi', 'pear'])
  assert.equal(out.art.get('blueberry').ext, 'svg')
  assert.equal(out.art.has('kiwi'), false, '带 <script 的图不认')
  assert.equal(out.art.has('pear'), false, '超过 256 KB 的图不认')
  assert.ok(out.warnings.some((line) => line.includes('<script')))
  assert.ok(out.warnings.some((line) => line.includes('太大')))
})

test('本机目录：art 字段只认本目录下的文件名，路径穿越直接跳过', async (t) => {
  const dir = await tempDir(t)
  await mkdir(join(dir, CROPS_DIR), { recursive: true })
  await writeFile(join(dir, CROPS_DIR, 'leaf.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(join(dir, CROPS_FILE), JSON.stringify({
    version: 1,
    crops: [def({ art: 'leaf.svg' }), def({ id: 'kiwi', name: '猕猴桃', art: '../../etc/passwd' })]
  }))
  const out = await readLocalCrops({ dir })
  assert.equal(out.art.has('blueberry'), true, '显式 art 文件名能用')
  assert.equal(out.art.has('kiwi'), false)
  assert.ok(out.warnings.some((line) => line.includes('只认本目录')))
})

// ---------------------------------------------------------------------------
// 图落盘
// ---------------------------------------------------------------------------

test('作物图：按内容哈希起名，同一张图两个 id 共用一份文件', async (t) => {
  const dir = await tempDir(t)
  const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
  const art = new Map([
    ['blueberry', { bytes, ext: 'svg' }],
    ['kiwi', { bytes, ext: 'svg' }]
  ])
  const urls = await writeCropArt({ dir, art })
  assert.equal(urls.size, 2)
  assert.equal(urls.get('blueberry').url, urls.get('kiwi').url, '内容一样就同一份文件')
  const file = urls.get('blueberry').url.replace('dshzoo://crops/', '')
  assert.equal(isArtFileName(file), true)
  assert.equal((await readFile(join(dir, CROP_ART_DIR, file), 'utf8')), bytes.toString('utf8'))
  assert.deepEqual(artFileName(bytes, 'svg').name, file)
})

test('作物图：只认 svg/png 的名字，别的扩展名和短哈希都不算', () => {
  for (const ext of ART_EXTENSIONS) assert.equal(isArtFileName('0123456789abcdef.' + ext), true)
  assert.equal(isArtFileName('0123456789abcdef.webm'), false)
  assert.equal(isArtFileName('0123.svg'), false, '哈希必须 16 位')
  assert.equal(isArtFileName('../../0123456789abcdef.svg'), false)
  assert.equal(isArtFileName(null), false)
})

// ---------------------------------------------------------------------------
// 窗口侧（票 59）：目录随每一包下发，视图层整份换掉
// ---------------------------------------------------------------------------

test('窗口目录：宿主发来的条目整份替换内置表，未知作物退成通用幼苗', (t) => {
  t.after(() => farmView.setCrops(null))
  farmView.setCrops([
    { id: 'tomato', name: '小番茄', growMs: 30 * MINUTE, seedPrice: 7, yield: 3, base: 5 },
    { id: 'blueberry', name: '蓝莓', growMs: 90 * MINUTE, seedPrice: 30, yield: 4, base: 18 },
    { id: 'kiwi', name: '猕猴桃', growMs: 2 * HOUR, seedPrice: 20, yield: 5, base: 12 }
  ])
  assert.deepEqual(farmView.CROP_IDS, ['tomato', 'blueberry', 'kiwi'], '按生长时长排')
  assert.equal(farmView.CROP_META.tomato.art, 'crops/tomato.svg', '内置条目继续用包里的 SVG')
  assert.equal(farmView.CROP_META.tomato.seedPrice, 7, '数值以宿主下发为准')
  assert.equal(farmView.CROP_META.blueberry.art, '', '宿主认识、包里没图的条目没有 art')
  assert.equal(farmView.CROP_META.blueberry.emoji, '🌱', '没图时退回通用幼苗，不留空格子')
  assert.equal(farmView.cropMeta('kiwi').name, '猕猴桃')
})

test('窗口目录：空数组/坏目录退回内置六种，不会把窗口画空', (t) => {
  t.after(() => farmView.setCrops(null))
  farmView.setCrops([])
  assert.deepEqual(farmView.CROP_IDS, Object.keys(farmView.BUILTIN_META))
  farmView.setCrops([{ id: '', name: '' }, null, 'x'])
  assert.deepEqual(farmView.CROP_IDS, Object.keys(farmView.BUILTIN_META))
})

// ---------------------------------------------------------------------------
// 局域网收到过的目录（票 59）：落在单独一个文件里，和手写的那份分开
// ---------------------------------------------------------------------------

test('收到过的目录：写进去再读出来，图引用与来源都在，坏条目被丢掉', async (t) => {
  const dir = await tempDir(t)
  const art = { hash: '0123456789abcdef', ext: 'svg', bytes: 512 }
  const written = await writeRemoteCatalog({
    dir,
    entries: [def({ art }), { id: 'BAD', name: '' }],
    seenFrom: new Map([['blueberry', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']])
  })
  assert.equal(written, true)

  const read = await readRemoteCatalog({ dir })
  assert.deepEqual(read.warnings, [])
  assert.equal(read.entries.length, 1, '坏条目丢掉')
  assert.deepEqual(read.entries[0].art, art)
  assert.equal(read.seenFrom.get('blueberry'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
})

test('收到过的目录：文件不存在/坏 JSON 都只当没收到过，不抛', async (t) => {
  const dir = await tempDir(t)
  assert.deepEqual((await readRemoteCatalog({ dir })).entries, [])

  await writeFile(join(dir, 'crop-catalog.json'), '{ 坏 json')
  const broken = await readRemoteCatalog({ dir })
  assert.deepEqual(broken.entries, [])
  assert.equal(broken.warnings.length, 1)
  assert.match(broken.warnings[0], /读不出来/)
})

test('三层合并（内置 + 收到 + 手写）：手写永远赢，收到的不覆盖手写', () => {
  const remote = [def({ base: 40 })]
  const local = [def({ base: 25 })]
  const merged = buildCatalog({ remote, local })
  assert.equal(merged.defs.get('blueberry').base, 25)
  assert.equal(merged.sources.get('blueberry'), 'local')
})

test('目录切片（票 59）：按 8 条一片，空目录不产片，片数与拼回来一致', () => {
  assert.deepEqual(chunkCatalog([]), [])
  assert.deepEqual(chunkCatalog(null), [])
  const one = [def()]
  assert.equal(chunkCatalog(one).length, 1)
  const sixteen = Array.from({ length: 16 }, (_, index) => def({ id: 'crop_' + index }))
  const chunks = chunkCatalog(sixteen)
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks.flat().map((entry) => entry.id), sixteen.map((entry) => entry.id))
  assert.equal(chunkCatalog(sixteen, 5).length, 4)
  assert.equal(chunkCatalog(sixteen, 0).length, 2, '坏片宽退回 8')
})
