import assert from 'node:assert/strict'
import test from 'node:test'

import { PEER_LOST_MS, VISIT_MAX_MS } from '../src/protocol.js'
import { MAX_VISIT_RECORD_MS, createRoom } from '../src/room.js'

const T0 = 1_700_000_000_000
const PEER = 'neighbor-a'
const PEER_NAME = '甲'
const VISIT_ID = '11111111-1111-4111-8111-111111111111'

function makeRoom () {
  const room = createRoom({ clock: () => T0 })
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.observeBeacon({ deviceId: PEER, nickname: PEER_NAME, port: 40001 }, T0)
  room.admit(PEER)
  return room
}

function inbound (room, at = T0) {
  const replied = room.observeVisitRequest({
    deviceId: PEER,
    visitId: VISIT_ID,
    nickname: PEER_NAME,
    anim: '写代码'
  }, at)
  assert.equal(replied.reply, 'ack')
  return replied.visit
}

function heartbeat (room, at) {
  assert.equal(room.observeHeartbeat({ deviceId: PEER, anim: '写代码' }, at), true)
}

function outbound (room) {
  assert.equal(room.beginVisit(PEER, { at: T0, visitId: VISIT_ID }).ok, true)
  assert.equal(room.observeVisitAck({ deviceId: PEER, visitId: VISIT_ID }, T0 + 100).ok, true)
}

test('客人不走：心跳一直来，入站访客可以待几个小时；送客按真实时长记录（封顶 30 分钟）', () => {
  const room = makeRoom()
  inbound(room)

  for (let at = T0 + 60_000; at <= T0 + 2 * 60 * 60 * 1000; at += 60_000) heartbeat(room, at)
  room.tick(T0 + 2 * 60 * 60 * 1000)
  assert.equal(room.snapshot().visitors.length, 1, '没有入站 TTL，心跳在就一直在')
  assert.equal(room.snapshot().visitors[0].endsAt, null)

  const ended = room.endInboundVisit(PEER, T0 + 2 * 60 * 60 * 1000)
  assert.equal(ended.ok, true)
  assert.equal(ended.record.durationMs, MAX_VISIT_RECORD_MS)
  assert.deepEqual(room.snapshot().visitors, [])
  assert.deepEqual(room.drainVisitRecalls(), [{ deviceId: PEER, visitId: VISIT_ID }])
})

test('送客立刻生效：写一条 in 记录、通知对方回家、不留下访客', () => {
  const room = makeRoom()
  inbound(room)
  const ended = room.endInboundVisit(PEER, T0 + 12_345)

  assert.equal(ended.ok, true)
  assert.equal(ended.deviceId, PEER)
  assert.equal(ended.visitId, VISIT_ID)
  assert.equal(ended.nickname, PEER_NAME)
  assert.deepEqual(ended.record, {
    direction: 'in',
    nickname: PEER_NAME,
    startedAt: T0,
    durationMs: 12_345
  })
  assert.deepEqual(room.snapshot().visitors, [])
  assert.deepEqual(room.snapshot().visits, [ended.record])
  assert.deepEqual(room.drainVisitRecords(), [ended.record])
  assert.deepEqual(room.drainVisitRecalls(), [{ deviceId: PEER, visitId: VISIT_ID }])

  // 再点一次：明确失败 + 一句人话，不会写第二条记录。
  const again = room.endInboundVisit(PEER, T0 + 13_000)
  assert.equal(again.ok, false)
  assert.equal(again.error, 'no-visitor')
  assert.match(again.notice, /已经不在桌面上/)
  assert.equal(room.drainVisitRecords().length, 0)
})

test('对方失联（入站）：2 分钟没有心跳才走，早一刻都还在；走时写 in 记录并提示', () => {
  const room = makeRoom()
  inbound(room)

  room.tick(T0 + PEER_LOST_MS - 1)
  assert.equal(room.snapshot().visitors.length, 1)
  assert.deepEqual(room.snapshot().visits, [])

  room.tick(T0 + PEER_LOST_MS)
  assert.deepEqual(room.snapshot().visitors, [])
  assert.deepEqual(room.snapshot().visits, [{
    direction: 'in',
    nickname: PEER_NAME,
    startedAt: T0,
    durationMs: PEER_LOST_MS
  }])
  assert.match(room.snapshot().notices[0].text, /失联/)
  assert.equal(room.drainVisitRecords().length, 1)

  // 再 tick 不会重复写记录。
  room.tick(T0 + PEER_LOST_MS + 10_000)
  assert.equal(room.drainVisitRecords().length, 0)
  assert.equal(room.snapshot().visits.length, 1)
})

test('同时来多位客人不设上限：80 位各自独立，送走一位不影响其他人', () => {
  const room = createRoom({ clock: () => T0 })
  const allowed = {}
  for (let index = 0; index < 80; index += 1) {
    allowed['dev-' + index] = { nickname: '客人' + index }
  }
  room.setTrust({ allowed, denied: {} })

  for (let index = 0; index < 80; index += 1) {
    const replied = room.observeVisitRequest({
      deviceId: 'dev-' + index,
      visitId: VISIT_ID,
      nickname: '客人' + index,
      anim: null
    }, T0 + index)
    assert.equal(replied.reply, 'ack', String(index))
  }
  assert.equal(room.snapshot().visitors.length, 80)

  const ended = room.endInboundVisit('dev-40', T0 + 1000)
  assert.equal(ended.ok, true)
  assert.equal(room.snapshot().visitors.length, 79)
  assert.equal(room.snapshot().visitors.some((visitor) => visitor.deviceId === 'dev-40'), false)
  assert.equal(room.drainVisitRecords().length, 1)

  // 没有心跳的 80 位会在 2 分钟后一起失联，各自写一条记录。
  room.tick(T0 + 79 + PEER_LOST_MS)
  assert.equal(room.snapshot().visitors.length, 0)
  assert.equal(room.drainVisitRecords().length, 79)
})

test('对方失联（出门）：我出门在外，2 分钟没有对方心跳就回家并写 out 记录', () => {
  const room = makeRoom()
  outbound(room)
  heartbeat(room, T0 + 60_000)

  room.tick(T0 + 60_000 + PEER_LOST_MS - 1)
  assert.equal(room.snapshot().self.out.phase, 'active')
  assert.deepEqual(room.snapshot().visits, [])

  room.tick(T0 + 60_000 + PEER_LOST_MS)
  assert.equal(room.snapshot().self.out, null)
  assert.deepEqual(room.snapshot().visits, [{
    direction: 'out',
    nickname: PEER_NAME,
    startedAt: T0 + 100,
    durationMs: 60_000 + PEER_LOST_MS - 100
  }])
  assert.match(room.snapshot().notices[0].text, /失联/)
  assert.deepEqual(room.drainVisitRecalls(), [{ deviceId: PEER, visitId: VISIT_ID }])
  assert.equal(room.drainVisitRecords().length, 1)

  // 不会重复记录。
  room.tick(T0 + 10 * 60 * 1000)
  assert.equal(room.drainVisitRecords().length, 0)
})

test('30 分钟上限：tick 迟到也不会写出超过 30 分钟的停留时长', () => {
  const room = makeRoom()
  outbound(room)
  const active = room.snapshot().self.out
  for (let at = T0 + 60_000; at < active.endsAt; at += 60_000) heartbeat(room, at)

  // 模拟机器睡过头：上限早过了很久才 tick。
  room.tick(active.endsAt + 10 * 60 * 1000)
  assert.equal(room.snapshot().self.out, null)
  assert.equal(room.snapshot().visits[0].durationMs, VISIT_MAX_MS)
  assert.ok(room.snapshot().visits[0].durationMs <= VISIT_MAX_MS)
})

test('入站记录时长封顶：客人待了 2 小时，记录仍是 30 分钟而不是 2 小时', () => {
  const room = makeRoom()
  inbound(room)
  for (let at = T0 + 60_000; at <= T0 + 2 * 60 * 60 * 1000; at += 60_000) heartbeat(room, at)
  const ended = room.endInboundVisit(PEER, T0 + 2 * 60 * 60 * 1000)
  assert.equal(ended.record.durationMs, MAX_VISIT_RECORD_MS)
  assert.equal(MAX_VISIT_RECORD_MS, VISIT_MAX_MS)
})

test('入站访客与出门状态互不影响：客人留在家里，本机宠物也可以同时在别人家', () => {
  const room = makeRoom()
  inbound(room)
  assert.equal(room.beginVisit(PEER, { at: T0 + 2000, visitId: '22222222-2222-4222-8222-222222222222' }).ok, true)
  assert.equal(room.snapshot().visitors.length, 1)
  assert.equal(room.snapshot().self.out.phase, 'requesting')
})
