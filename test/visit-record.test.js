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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-record-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
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

const GIFT_A = '33333333-3333-4333-8333-333333333333'
const GIFT_B = '44444444-4444-4444-8444-444444444444'
const PEER = '55555555-5555-4555-8555-555555555555'
const VISIT_A = '66666666-6666-4666-8666-666666666666'
const VISIT_B = '77777777-7777-4777-8777-777777777777'

test('记录里的 gift：旧文件没有照常读；非法只丢字段；字条不留正文、文件只留名字', () => {
  const base = { direction: 'in', nickname: '甲', startedAt: T0, durationMs: 1000 }
  assert.deepEqual(normalizeVisitRecord(base), base)
  assert.equal('gift' in normalizeVisitRecord(base), false)

  assert.deepEqual(normalizeVisitRecord({ ...base, gift: { kind: 'text', text: '私房话' } }), {
    ...base,
    gift: { kind: 'text' }
  })
  assert.deepEqual(normalizeVisitRecord({ ...base, gift: { kind: 'file', name: '报价单.pdf' } }), {
    ...base,
    gift: { kind: 'file', name: '报价单.pdf' }
  })
  // 文件名非法/缺失：只丢 name，kind 还在，记录更不会因此作废。
  assert.deepEqual(normalizeVisitRecord({ ...base, gift: { kind: 'file', name: 42 } }), {
    ...base,
    gift: { kind: 'file' }
  })
  assert.deepEqual(normalizeVisitRecord({ ...base, gift: { kind: 'file' } }), {
    ...base,
    gift: { kind: 'file' }
  })
  // 整个 gift 非法：只丢 gift，四个字段照旧。
  for (const gift of [null, 'text', [], { kind: 'image' }, {}]) {
    const record = normalizeVisitRecord({ ...base, gift })
    assert.deepEqual(record, base, JSON.stringify(gift))
  }
})

test('visits.json：带 gift 的记录写进去能原样读回；旧文件缺字段照常读', async (t) => {
  const dir = await tempDir(t)
  const store = await createVisitStore(dir, { log: { warn () {} } })
  const textRecord = {
    direction: 'in',
    nickname: '甲',
    startedAt: T0,
    durationMs: 1000,
    gift: { kind: 'text' }
  }
  const fileRecord = {
    direction: 'out',
    nickname: '乙',
    startedAt: T0 + 1000,
    durationMs: 2000,
    gift: { kind: 'file', name: '报价单.pdf' }
  }
  assert.equal(await store.append(textRecord), true)
  assert.equal(await store.append(fileRecord), true)

  const raw = JSON.parse(await readFile(join(dir, 'visits.json'), 'utf8'))
  assert.deepEqual(raw.visits, [fileRecord, textRecord])

  const reloaded = await createVisitStore(dir, { log: { warn () {} } })
  assert.deepEqual(reloaded.records(), [fileRecord, textRecord])
})

test('room 的 in / out 两条结束路径都把礼物摘要写进记录（不写正文）', () => {
  const room = createRoom({ clock: () => T0 })
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.observeBeacon({ deviceId: PEER, nickname: '甲', port: 40001 }, T0)
  room.admit(PEER)

  // out：真正带上路的那件文件礼物由 service 在发送成功后登记。
  assert.equal(room.beginVisit(PEER, { at: T0, visitId: VISIT_A }).ok, true)
  assert.equal(room.markOutboundGift(VISIT_A, { kind: 'file', name: '报价单.pdf' }), true)
  assert.equal(room.observeVisitAck({ deviceId: PEER, visitId: VISIT_A }, T0 + 100).ok, true)
  room.tick(T0 + 100 + MAX_VISIT_RECORD_MS)
  assert.deepEqual(room.snapshot().visits[0], {
    direction: 'out',
    nickname: '甲',
    startedAt: T0 + 100,
    durationMs: MAX_VISIT_RECORD_MS,
    gift: { kind: 'file', name: '报价单.pdf' }
  })
  assert.deepEqual(room.drainVisitRecords()[0].gift, { kind: 'file', name: '报价单.pdf' })

  // in：访客身上那件字条在送客时落进记录；正文绝不进记录。
  room.observeVisitRequest({
    deviceId: PEER,
    visitId: VISIT_B,
    nickname: '甲',
    anim: null,
    gift: { id: GIFT_A, kind: 'text', text: '私房话' }
  }, T0 + 200)
  room.endInboundVisit(PEER, T0 + 300)
  const inRecord = room.snapshot().visits[0]
  assert.deepEqual(inRecord.gift, { kind: 'text' })
  assert.equal(JSON.stringify(inRecord).includes('私房话'), false)
  assert.deepEqual(room.drainVisitRecords()[0].gift, { kind: 'text' })
})

test('markOutboundGift 只认当前这次 visitId，且不污染快照里的出门形状', () => {
  const room = createRoom({ clock: () => T0 })
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.observeBeacon({ deviceId: PEER, nickname: '甲', port: 40001 }, T0)
  room.admit(PEER)
  const begun = room.beginVisit(PEER, { at: T0, visitId: VISIT_A })
  assert.equal(room.markOutboundGift(VISIT_B, { kind: 'text' }), false)
  assert.equal(room.markOutboundGift(VISIT_A, { kind: 'text' }), true)
  assert.deepEqual(room.snapshot().self.out, begun.visit)
  assert.equal('gift' in room.snapshot().self.out, false)
  // 编码层丢掉礼物时 service 传 null：记录里就不该出现 gift。
  assert.equal(room.markOutboundGift(VISIT_A, null), true)
  assert.equal(room.observeVisitAck({ deviceId: PEER, visitId: VISIT_A }, T0 + 100).ok, true)
  room.recallOutbound(T0 + 200)
  assert.equal('gift' in room.snapshot().visits[0], false)
})
