import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MAX_VISIT_RECORDS,
  VISITS_FILE,
  VISITS_FILE_VERSION,
  createVisitStore
} from '../src/visits.js'
import { VISIT_RECORD_LIMIT } from '../src/room.js'

const T0 = 1_700_000_000_000

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-visits-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function record (index, overrides = {}) {
  return {
    direction: index % 2 === 0 ? 'out' : 'in',
    nickname: '邻居' + index,
    startedAt: T0 + index * 1000,
    durationMs: 60000,
    ...overrides
  }
}

function logSink () {
  const warnings = []
  return {
    warnings,
    log: { warn (line) { warnings.push(line) } }
  }
}

async function readFileJson (dir) {
  return JSON.parse(await readFile(join(dir, VISITS_FILE), 'utf8'))
}

test('visits.json 不存在：空记录开始，不告警', async (t) => {
  const dir = await tempDir(t)
  const { warnings, log } = logSink()
  const store = await createVisitStore(dir, { log })

  assert.deepEqual(store.records(), [])
  assert.equal(store.count(), 0)
  assert.deepEqual(warnings, [])
})

test('追加记录会落盘；重新载入后仍是最新在前，字段只有四个', async (t) => {
  const dir = await tempDir(t)
  const { warnings, log } = logSink()
  const store = await createVisitStore(dir, { log })

  const first = record(1, { direction: 'out', nickname: '隔壁同事' })
  const second = record(2, { direction: 'in', nickname: '来串门的' })
  assert.equal(await store.append(first), true)
  assert.equal(await store.append(second), true)
  assert.equal(await store.append(null), false)
  assert.equal(await store.append({ direction: 'sideways', nickname: 'x', startedAt: T0, durationMs: 1 }), false)

  const raw = await readFileJson(dir)
  assert.equal(raw.version, VISITS_FILE_VERSION)
  assert.equal(raw.visits.length, 2)
  assert.deepEqual(raw.visits[0], {
    direction: 'in',
    nickname: '来串门的',
    startedAt: T0 + 2000,
    durationMs: 60000
  })
  assert.deepEqual(Object.keys(raw.visits[0]), ['direction', 'nickname', 'startedAt', 'durationMs'])

  const reloaded = await createVisitStore(dir, { log })
  assert.deepEqual(reloaded.records(), [
    {
      direction: 'in',
      nickname: '来串门的',
      startedAt: T0 + 2000,
      durationMs: 60000
    },
    {
      direction: 'out',
      nickname: '隔壁同事',
      startedAt: T0 + 1000,
      durationMs: 60000
    }
  ])
  assert.deepEqual(warnings, [])
})

test('默认上限 200 条：载入时丢弃最旧的，超出部分不留在内存里', async (t) => {
  const dir = await tempDir(t)
  const visits = []
  for (let index = 0; index < MAX_VISIT_RECORDS + 5; index += 1) visits.push(record(index))
  await writeFile(join(dir, VISITS_FILE), JSON.stringify({
    version: VISITS_FILE_VERSION,
    visits
  }), 'utf8')

  const { log, warnings } = logSink()
  const store = await createVisitStore(dir, { log })
  assert.equal(MAX_VISIT_RECORDS, 200)
  assert.equal(VISIT_RECORD_LIMIT, MAX_VISIT_RECORDS)
  assert.equal(store.count(), MAX_VISIT_RECORDS)
  assert.equal(store.records()[0].nickname, '邻居' + (MAX_VISIT_RECORDS + 4))
  assert.equal(store.records().at(-1).nickname, '邻居5')
  assert.deepEqual(warnings, [])
})

test('追加超出上限时丢最旧的那条（maxRecords 可注入）', async (t) => {
  const dir = await tempDir(t)
  const { warnings, log } = logSink()
  const store = await createVisitStore(dir, { log, maxRecords: 3 })

  for (let index = 0; index < 5; index += 1) {
    assert.equal(await store.append(record(index)), true)
  }
  assert.equal(store.count(), 3)
  assert.deepEqual(store.records().map((item) => item.nickname), ['邻居4', '邻居3', '邻居2'])

  const reloaded = await createVisitStore(dir, { log, maxRecords: 3 })
  assert.deepEqual(reloaded.records().map((item) => item.nickname), ['邻居4', '邻居3', '邻居2'])
  assert.deepEqual(warnings, [])
})

test('损坏的 visits.json：空记录 + 一条警告；之后追加仍能写出合法文件', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, VISITS_FILE), '{ oops', 'utf8')
  const { warnings, log } = logSink()
  const store = await createVisitStore(dir, { log })

  assert.deepEqual(store.records(), [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /串门记录/)

  assert.equal(await store.append(record(1)), true)
  assert.deepEqual(store.records().map((item) => item.nickname), ['邻居1'])
  const raw = await readFileJson(dir)
  assert.equal(raw.visits.length, 1)
  assert.equal(warnings.length, 1)
})

test('形状不对 / 单条非法：能救的救回来，只告警一次；不会把整份记录炸掉', async (t) => {
  const badShapeDir = await tempDir(t)
  await writeFile(join(badShapeDir, VISITS_FILE), JSON.stringify({ version: 1, visits: 'nope' }), 'utf8')
  const badShape = logSink()
  const none = await createVisitStore(badShapeDir, { log: badShape.log })
  assert.deepEqual(none.records(), [])
  assert.equal(badShape.warnings.length, 1)

  const partialDir = await tempDir(t)
  await writeFile(join(partialDir, VISITS_FILE), JSON.stringify({
    version: VISITS_FILE_VERSION,
    visits: [
      record(1),
      { direction: 'sideways', nickname: '坏方向', startedAt: T0, durationMs: 1 },
      null,
      { direction: 'in', nickname: '', startedAt: T0, durationMs: 1 },
      { direction: 'in', nickname: '坏时间', startedAt: -1, durationMs: 1 },
      record(2)
    ]
  }), 'utf8')
  const partial = logSink()
  const store = await createVisitStore(partialDir, { log: partial.log })
  assert.deepEqual(store.records().map((item) => item.nickname), ['邻居2', '邻居1'])
  assert.equal(partial.warnings.length, 1)
  assert.match(partial.warnings[0], /格式不对/)
})

test('文件写不进去：内存里仍有记录，只告警一次，后续追加不重复告警', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('以 root 运行时 chmod 不可靠')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-visits-ro-'))
  t.after(async () => {
    await chmod(dir, 0o700)
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  await chmod(dir, 0o500)

  const { warnings, log } = logSink()
  const store = await createVisitStore(dir, { log })
  assert.equal(await store.append(record(1)), false)
  assert.equal(await store.append(record(2)), false)
  assert.equal(store.count(), 2)
  assert.deepEqual(store.records().map((item) => item.nickname), ['邻居2', '邻居1'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /写不进去/)
})

test('手改成裸数组也能读；下一次写入会恢复带 version 的对象形状', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, VISITS_FILE), JSON.stringify([record(1), record(2)]), 'utf8')
  const { warnings, log } = logSink()
  const store = await createVisitStore(dir, { log })
  assert.deepEqual(store.records().map((item) => item.nickname), ['邻居2', '邻居1'])
  assert.deepEqual(warnings, [])

  assert.equal(await store.append(record(3)), true)
  const raw = await readFileJson(dir)
  assert.equal(raw.version, VISITS_FILE_VERSION)
  assert.deepEqual(raw.visits.map((item) => item.nickname), ['邻居3', '邻居2', '邻居1'])
})
