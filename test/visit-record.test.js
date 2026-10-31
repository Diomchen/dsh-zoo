import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MAX_VISIT_RECORD_MS, normalizeVisitRecord } from '../src/visit-record.js'
import { createRoom } from '../src/room.js'
import { VISITS_FILE, createVisitStore } from '../src/visits.js'

const T0 = 1_700_000_000_000

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-local-pet-record-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('唯一的记录规范器：小数向下取整、时长封顶，坏记录拒绝', () => {
  assert.deepEqual(normalizeVisitRecord({
    direction: 'out',
    nickname: '  隔壁  ',
    startedAt: T0 + 0.9,
    durationMs: 1234.9
  }), {
    direction: 'out',
    nickname: '隔壁',
    startedAt: T0,
    durationMs: 1234
  })

  assert.equal(
    normalizeVisitRecord({
      direction: 'in',
      nickname: '甲',
      startedAt: T0,
      durationMs: MAX_VISIT_RECORD_MS * 2
    }).durationMs,
    MAX_VISIT_RECORD_MS
  )

  const bad = [
    null,
    [],
    { direction: 'sideways', nickname: '甲', startedAt: T0, durationMs: 1 },
    { direction: 'in', nickname: '', startedAt: T0, durationMs: 1 },
    { direction: 'in', nickname: '甲', startedAt: -1, durationMs: 1 },
    { direction: 'in', nickname: '甲', startedAt: T0, durationMs: -1 },
    { direction: 'in', nickname: '甲', startedAt: NaN, durationMs: 1 },
    { direction: 'in', nickname: '甲', startedAt: T0, durationMs: Infinity }
  ]
  for (const raw of bad) assert.equal(normalizeVisitRecord(raw), null, JSON.stringify(raw))
})

test('room 与 visits.json 对同一条记录得出完全一样的结果', async (t) => {
  const dir = await tempDir(t)
  const raw = {
    direction: 'in',
    nickname: '  来串门的  ',
    startedAt: T0 + 0.75,
    durationMs: 60000.9
  }
  const expected = normalizeVisitRecord(raw)
  assert.deepEqual(expected, {
    direction: 'in',
    nickname: '来串门的',
    startedAt: T0,
    durationMs: 60000
  })

  const room = createRoom({ clock: () => T0 })
  room.setVisitRecords([raw, { direction: 'out', nickname: '', startedAt: T0, durationMs: 1 }])
  assert.deepEqual(room.snapshot().visits, [expected])

  const store = await createVisitStore(dir, { log: { warn () {} } })
  assert.equal(await store.append(raw), true)
  assert.deepEqual(store.records(), [expected])
  assert.deepEqual(JSON.parse(await readFile(join(dir, VISITS_FILE), 'utf8')).visits, [expected])
})
