import assert from 'node:assert/strict'
import test from 'node:test'

import { VISIT_TTL_MS } from '../src/protocol.js'
import { createRoom } from '../src/room.js'

const T0 = 1_700_000_000_000
const VISIT_A = '11111111-1111-4111-8111-111111111111'
const VISIT_B = '22222222-2222-4222-8222-222222222222'
const PEER = 'neighbor-a'
const PEER_NAME = '甲'

function makeRoom ({
  identity = 'me-1',
  nickname = '我',
  peer = PEER,
  peerName = PEER_NAME,
  admitted = true
} = {}) {
  const room = createRoom({ clock: () => T0 })
  room.setIdentity({ deviceId: identity, nickname })
  room.observeBeacon({ deviceId: peer, nickname: peerName, port: 40001 }, T0)
  if (admitted) room.admit(peer)
  return room
}

function outboundActive (room, { visitId = VISIT_A, at = T0 } = {}) {
  const begun = room.beginVisit(PEER, { at, visitId })
  assert.equal(begun.ok, true)
  const ack = room.observeVisitAck({ deviceId: PEER, visitId }, at + 100)
  assert.equal(ack.ok, true)
  return ack.visit
}

function inboundVisitor (room, { visitId = VISIT_A, at = T0 } = {}) {
  const replied = room.observeVisitRequest({
    deviceId: PEER,
    visitId,
    nickname: PEER_NAME,
    anim: '写代码'
  }, at)
  assert.equal(replied.reply, 'ack')
  return replied.visit
}

function lastNotice (room) {
  return room.snapshot().notices[0]?.text ?? ''
}

test('出门：请求中 → ack 后 60 秒 TTL，本地影子进入“出门了”状态', () => {
  const room = makeRoom()
  const begun = room.beginVisit(PEER, { at: T0, visitId: VISIT_A })

  assert.equal(begun.ok, true)
  assert.deepEqual(Object.keys(begun.visit), [
    'deviceId', 'nickname', 'visitId', 'phase', 'startedAt', 'endsAt'
  ])
  assert.equal(begun.visit.phase, 'requesting')
  assert.equal(begun.visit.endsAt, null)
  assert.deepEqual(room.snapshot().self.out, begun.visit)
  assert.deepEqual(room.outboundVisit(), begun.visit)

  const acked = room.observeVisitAck({ deviceId: PEER, visitId: VISIT_A }, T0 + 100)
  assert.equal(acked.ok, true)
  assert.equal(acked.visit.phase, 'active')
  assert.equal(acked.visit.startedAt, T0 + 100)
  assert.equal(acked.visit.endsAt, T0 + 100 + VISIT_TTL_MS)
  assert.equal(room.snapshot().self.out.phase, 'active')
  assert.deepEqual(room.snapshot().visits, [])
})

test('出门到点：发起方自己写一条 out 记录、清空状态，并排一条 visit-recall', () => {
  const room = makeRoom()
  const active = outboundActive(room)

  room.tick(active.endsAt - 1)
  assert.equal(room.snapshot().self.out.phase, 'active')
  assert.deepEqual(room.snapshot().visits, [])

  room.tick(active.endsAt)
  assert.equal(room.snapshot().self.out, null)
  assert.deepEqual(room.snapshot().visits, [{
    direction: 'out',
    nickname: PEER_NAME,
    startedAt: active.startedAt,
    durationMs: VISIT_TTL_MS
  }])
  assert.deepEqual(room.drainVisitRecords(), [{
    direction: 'out',
    nickname: PEER_NAME,
    startedAt: active.startedAt,
    durationMs: VISIT_TTL_MS
  }])
  assert.deepEqual(room.drainVisitRecalls(), [{ deviceId: PEER, visitId: VISIT_A }])
  // 正常到点回家不是失败，不写失败提示。
  assert.deepEqual(room.snapshot().notices, [])
})

test('接收方：放行过的请求得到 ack，自己跑 60 秒 TTL，不依赖发起方还在', () => {
  const room = makeRoom({ identity: 'me-2', nickname: '乙' })
  const visitor = inboundVisitor(room)

  assert.deepEqual(room.snapshot().visitors, [{
    deviceId: PEER,
    nickname: PEER_NAME,
    anim: '写代码',
    visitId: VISIT_A,
    since: T0,
    endsAt: T0 + VISIT_TTL_MS
  }])
  assert.deepEqual(visitor, room.snapshot().visitors[0])

  // 发起方彻底消失：没有心跳、没有再发任何包，接收方仍然自己到期并记录。
  room.tick(T0 + VISIT_TTL_MS - 1)
  assert.equal(room.snapshot().visitors.length, 1)
  room.tick(T0 + VISIT_TTL_MS)
  assert.deepEqual(room.snapshot().visitors, [])
  assert.deepEqual(room.snapshot().visits, [{
    direction: 'in',
    nickname: PEER_NAME,
    startedAt: T0,
    durationMs: VISIT_TTL_MS
  }])
  assert.deepEqual(room.drainVisitRecords(), [{
    direction: 'in',
    nickname: PEER_NAME,
    startedAt: T0,
    durationMs: VISIT_TTL_MS
  }])
})

test('请求重试按 visitId 幂等：不重置 60 秒、不多写记录', () => {
  const room = makeRoom({ identity: 'me-2', nickname: '乙' })
  inboundVisitor(room)

  const retry = room.observeVisitRequest({
    deviceId: PEER,
    visitId: VISIT_A,
    nickname: '伪造的名字',
    anim: '东张西望'
  }, T0 + 600)
  assert.equal(retry.reply, 'ack')
  assert.equal(room.snapshot().visitors.length, 1)
  const visitor = room.snapshot().visitors[0]
  assert.equal(visitor.since, T0)
  assert.equal(visitor.endsAt, T0 + VISIT_TTL_MS)
  assert.equal(visitor.nickname, PEER_NAME) // 昵称来自放行名单，不来自请求
  assert.equal(visitor.anim, '东张西望')

  // 即便对方换了一个 visitId（例如上一次 ack 丢了），也只保留一位访客。
  const takeover = room.observeVisitRequest({
    deviceId: PEER,
    visitId: VISIT_B,
    nickname: PEER_NAME,
    anim: null
  }, T0 + 1200)
  assert.equal(takeover.reply, 'ack')
  assert.equal(room.snapshot().visitors.length, 1)
  assert.equal(room.snapshot().visitors[0].since, T0)
  assert.equal(room.snapshot().visitors[0].visitId, VISIT_B)

  room.tick(T0 + VISIT_TTL_MS)
  assert.equal(room.snapshot().visits.length, 1)
  assert.equal(room.drainVisitRecords().length, 1)
})

test('未放行的请求得到 deny，不创建访客、不写记录', () => {
  const room = makeRoom({ identity: 'me-2', nickname: '乙', admitted: false })
  const replied = room.observeVisitRequest({
    deviceId: PEER,
    visitId: VISIT_A,
    nickname: PEER_NAME,
    anim: null
  }, T0)

  assert.deepEqual(replied, {
    reply: 'deny',
    deviceId: PEER,
    visitId: VISIT_A,
    reason: 'not-admitted'
  })
  assert.deepEqual(room.snapshot().visitors, [])
  assert.deepEqual(room.snapshot().visits, [])
  assert.deepEqual(room.drainVisitRecords(), [])

  // 未知来源同样只回 deny，不留下任何本机状态。
  assert.equal(room.observeVisitRequest({
    deviceId: 'stranger',
    visitId: VISIT_B,
    nickname: '陌生人',
    anim: null
  }, T0).reply, 'deny')
  assert.deepEqual(room.snapshot().visitors, [])
})

test('关掉串门：已放行的请求也得到 visits-off 的 deny，不建访客；发起方提示与“没放行”不同', () => {
  const receiver = makeRoom({ identity: 'me-2', nickname: '乙' })
  assert.equal(receiver.snapshot().acceptVisits, true)
  assert.equal(receiver.setAcceptVisits(false), false)
  assert.equal(receiver.snapshot().acceptVisits, false)

  const replied = receiver.observeVisitRequest({
    deviceId: PEER,
    visitId: VISIT_A,
    nickname: PEER_NAME,
    anim: null
  }, T0)
  assert.deepEqual(replied, {
    reply: 'deny',
    deviceId: PEER,
    visitId: VISIT_A,
    reason: 'visits-off'
  })
  assert.deepEqual(receiver.snapshot().visitors, [])
  assert.deepEqual(receiver.snapshot().visits, [])
  assert.deepEqual(receiver.drainVisitRecords(), [])

  // 开关只挡串门：邻居灯、心跳影子、本机出门都不受影响。
  receiver.observeBeacon({ deviceId: PEER, nickname: PEER_NAME, port: 40001 }, T0 + 1000)
  receiver.admit(PEER)
  assert.equal(receiver.observeHeartbeat({ deviceId: PEER, anim: '写代码' }, T0 + 2000), true)
  assert.equal(receiver.snapshot().guests.length, 1)
  assert.equal(receiver.beginVisit(PEER, { at: T0 + 3000, visitId: VISIT_B }).ok, true)

  // 发起方收到 visits-off 的 deny：文案必须能区分“对方关掉了串门”。
  const sender = makeRoom()
  sender.beginVisit(PEER, { at: T0, visitId: VISIT_A })
  const denied = sender.observeVisitDeny({
    deviceId: PEER,
    visitId: VISIT_A,
    reason: 'visits-off'
  }, T0 + 300)
  assert.equal(denied.ok, true)
  assert.equal(denied.error, 'visits-off')
  assert.equal(sender.snapshot().self.out, null)
  assert.deepEqual(sender.snapshot().visits, [])
  assert.match(lastNotice(sender), /关掉了串门/)
  assert.doesNotMatch(lastNotice(sender), /没有放行你/)

  // 没带 reason 的 deny（旧报文/普通拒绝）仍然是原来的“没有放行你”。
  const generic = makeRoom()
  generic.beginVisit(PEER, { at: T0, visitId: VISIT_A })
  generic.observeVisitDeny({ deviceId: PEER, visitId: VISIT_A }, T0 + 300)
  assert.match(lastNotice(generic), /没有放行你/)
  assert.notEqual(lastNotice(generic), lastNotice(sender))
})

test('本地召回：立即清掉出门状态、写 out 记录并排 recall；接收方收到后立即清场', () => {
  const sender = makeRoom()
  const active = outboundActive(sender)

  const recalled = sender.recallOutbound(T0 + 5000)
  assert.equal(recalled.ok, true)
  assert.equal(recalled.cancelled, false)
  assert.equal(sender.snapshot().self.out, null)
  assert.deepEqual(recalled.record, {
    direction: 'out',
    nickname: PEER_NAME,
    startedAt: active.startedAt,
    durationMs: 4900
  })
  assert.deepEqual(sender.drainVisitRecalls(), [{ deviceId: PEER, visitId: VISIT_A }])

  const receiver = makeRoom({ identity: 'me-2', nickname: '乙' })
  inboundVisitor(receiver)
  const received = receiver.observeVisitRecall({ deviceId: PEER, visitId: VISIT_A }, T0 + 5000)
  assert.equal(received.ok, true)
  assert.deepEqual(receiver.snapshot().visitors, [])
  assert.deepEqual(receiver.snapshot().visits, [{
    direction: 'in',
    nickname: PEER_NAME,
    startedAt: T0,
    durationMs: 5000
  }])
})

test('接收方也能提前结束：写 in 记录并排 recall，发起方收到后回家并写 out 记录', () => {
  const receiver = makeRoom({ identity: 'me-2', nickname: '乙' })
  inboundVisitor(receiver)
  const ended = receiver.endInboundVisit(PEER, T0 + 4000)

  assert.equal(ended.ok, true)
  assert.deepEqual(receiver.snapshot().visitors, [])
  assert.deepEqual(ended.record, {
    direction: 'in',
    nickname: PEER_NAME,
    startedAt: T0,
    durationMs: 4000
  })
  assert.deepEqual(receiver.drainVisitRecalls(), [{ deviceId: PEER, visitId: VISIT_A }])

  const sender = makeRoom()
  const active = outboundActive(sender)
  const recalled = sender.observeVisitRecall({ deviceId: PEER, visitId: VISIT_A }, T0 + 4000)
  assert.equal(recalled.ok, true)
  assert.equal(sender.snapshot().self.out, null)
  assert.deepEqual(sender.snapshot().visits, [{
    direction: 'out',
    nickname: PEER_NAME,
    startedAt: active.startedAt,
    durationMs: 3900
  }])
  assert.match(lastNotice(sender), /结束了这次串门/)
  // 对方主动召回后不需要再回一条 recall。
  assert.deepEqual(sender.drainVisitRecalls(), [])
})

test('请求中被本地召回：只取消，不写记录、不发 recall', () => {
  const room = makeRoom()
  room.beginVisit(PEER, { at: T0, visitId: VISIT_A })
  const recalled = room.recallOutbound(T0 + 100)

  assert.equal(recalled.ok, true)
  assert.equal(recalled.cancelled, true)
  assert.equal(room.snapshot().self.out, null)
  assert.deepEqual(room.snapshot().visits, [])
  assert.deepEqual(room.drainVisitRecords(), [])
  assert.deepEqual(room.drainVisitRecalls(), [])
})

test('被拒绝：请求中收到 deny → 明确失败提示、不写记录、宠物留在家', () => {
  const room = makeRoom()
  room.beginVisit(PEER, { at: T0, visitId: VISIT_A })
  const denied = room.observeVisitDeny({ deviceId: PEER, visitId: VISIT_A }, T0 + 300)

  assert.equal(denied.ok, true)
  assert.equal(room.snapshot().self.out, null)
  assert.deepEqual(room.snapshot().visits, [])
  assert.match(lastNotice(room), /没有放行你/)
})

test('超时 / 离线 / 未放行 / 已经在串门：五种失败各有可读且不同的提示', () => {
  const texts = []

  const pending = makeRoom({ admitted: false })
  const notAdmitted = pending.beginVisit(PEER, { at: T0, visitId: VISIT_A })
  assert.equal(notAdmitted.error, 'not-admitted')
  texts.push(lastNotice(pending))
  assert.match(lastNotice(pending), /还没放行「甲」/)

  const unknown = makeRoom({ peer: 'neighbor-x', peerName: '乙' })
  const offline = unknown.beginVisit('neighbor-y', { at: T0, visitId: VISIT_A })
  assert.equal(offline.error, 'peer-offline')
  texts.push(lastNotice(unknown))
  assert.match(lastNotice(unknown), /好像不在线/)

  const timingOut = makeRoom()
  timingOut.beginVisit(PEER, { at: T0, visitId: VISIT_A })
  const timeout = timingOut.failOutboundVisit('timeout', T0 + 1800)
  assert.equal(timeout.ok, true)
  texts.push(lastNotice(timingOut))
  assert.match(lastNotice(timingOut), /没有回应/)

  const deniedRoom = makeRoom()
  deniedRoom.beginVisit(PEER, { at: T0, visitId: VISIT_A })
  deniedRoom.observeVisitDeny({ deviceId: PEER, visitId: VISIT_A }, T0 + 300)
  texts.push(lastNotice(deniedRoom))
  assert.match(lastNotice(deniedRoom), /没有放行你/)

  const already = makeRoom()
  outboundActive(already)
  const second = already.beginVisit(PEER, { at: T0 + 1000, visitId: VISIT_B })
  assert.equal(second.error, 'already-out')
  texts.push(lastNotice(already))
  assert.match(lastNotice(already), /已经在「甲」家/)

  assert.equal(new Set(texts).size, texts.length, texts.join('\n'))
  for (const text of texts) {
    assert.ok(Array.from(text).length > 8, text)
    // 用户看到的不是错误码：没有全小写英文 code、没有堆栈。
    assert.doesNotMatch(text, /^(not-admitted|peer-offline|timeout|denied|already-out)$/)
    assert.doesNotMatch(text, /\bat \w+|<anonymous>|Error:/)
  }
  // 快照最多挂 3 条，最新的在前。
  assert.equal(deniedRoom.snapshot().notices.length, 1)
  assert.ok(deniedRoom.snapshot().notices[0].at >= T0)
})

test('同一只宠物同时只能有一次出门；失败的第二次不会覆盖第一次的状态', () => {
  const room = makeRoom()
  room.beginVisit(PEER, { at: T0, visitId: VISIT_A })

  const second = room.beginVisit(PEER, { at: T0 + 100, visitId: VISIT_B })
  assert.equal(second.ok, false)
  assert.equal(second.error, 'already-out')
  assert.equal(room.snapshot().self.out.visitId, VISIT_A)
  assert.equal(room.snapshot().self.out.phase, 'requesting')
})

test('ack 只接受当前目标的同一个 visitId；错配不会让宠物假装已抵达', () => {
  const room = makeRoom()
  room.beginVisit(PEER, { at: T0, visitId: VISIT_A })

  assert.equal(room.observeVisitAck({ deviceId: PEER, visitId: VISIT_B }, T0 + 10).ok, false)
  assert.equal(room.observeVisitAck({ deviceId: 'other', visitId: VISIT_A }, T0 + 10).ok, false)
  assert.equal(room.snapshot().self.out.phase, 'requesting')

  assert.equal(room.observeVisitAck({ deviceId: PEER, visitId: VISIT_A }, T0 + 20).ok, true)
  assert.equal(room.snapshot().self.out.phase, 'active')
  // 迟到的第二次 ack 不会重置 TTL。
  assert.equal(room.observeVisitAck({ deviceId: PEER, visitId: VISIT_A }, T0 + 5000).ok, false)
  assert.equal(room.snapshot().self.out.endsAt, T0 + 20 + VISIT_TTL_MS)
})

test('拒绝或名单收紧时，入站访客立即离开并留下一条 in 记录', () => {
  const rejected = makeRoom({ identity: 'me-2', nickname: '乙' })
  inboundVisitor(rejected)
  rejected.reject(PEER)
  assert.deepEqual(rejected.snapshot().visitors, [])
  assert.deepEqual(rejected.snapshot().visits, [{
    direction: 'in',
    nickname: PEER_NAME,
    startedAt: T0,
    durationMs: 0
  }])
  assert.equal(rejected.drainVisitRecords().length, 1)

  const tightened = makeRoom({ identity: 'me-2', nickname: '乙' })
  inboundVisitor(tightened)
  tightened.setTrust({ allowed: {}, denied: {} })
  assert.deepEqual(tightened.snapshot().visitors, [])
  assert.deepEqual(tightened.snapshot().visits.map((record) => record.direction), ['in'])
})

test('心跳能更新串门访客的动作，但不会延长 60 秒 TTL', () => {
  const room = makeRoom({ identity: 'me-2', nickname: '乙' })
  inboundVisitor(room)

  assert.equal(room.observeHeartbeat({ deviceId: PEER, anim: '东张西望' }, T0 + 30000), true)
  const visitor = room.snapshot().visitors[0]
  assert.equal(visitor.anim, '东张西望')
  assert.equal(visitor.endsAt, T0 + VISIT_TTL_MS)

  room.tick(T0 + VISIT_TTL_MS)
  assert.deepEqual(room.snapshot().visitors, [])
})

test('载入的记录按开始时间倒序，快照只给最近 5 条', () => {
  const room = makeRoom()
  const records = []
  for (let index = 0; index < 8; index += 1) {
    records.push({
      direction: index % 2 === 0 ? 'out' : 'in',
      nickname: '邻居' + index,
      startedAt: T0 + index * 1000,
      durationMs: 60000
    })
  }
  // 故意打乱输入顺序。
  records.reverse()
  room.setVisitRecords(records)

  const visits = room.snapshot().visits
  assert.equal(visits.length, 5)
  assert.deepEqual(visits.map((record) => record.nickname), ['邻居7', '邻居6', '邻居5', '邻居4', '邻居3'])
  assert.deepEqual(Object.keys(visits[0]), ['direction', 'nickname', 'startedAt', 'durationMs'])
})

test('接收方收到携带旧 visitId 的迟到 recall：仍按 deviceId 立即清场', () => {
  const receiver = makeRoom({ identity: 'me-2', nickname: '乙' })
  inboundVisitor(receiver, { visitId: VISIT_B })

  const received = receiver.observeVisitRecall({ deviceId: PEER, visitId: VISIT_A }, T0 + 2000)
  assert.equal(received.ok, true)
  assert.equal(received.side, 'in')
  assert.deepEqual(receiver.snapshot().visitors, [])
  assert.deepEqual(receiver.snapshot().visits, [{
    direction: 'in',
    nickname: PEER_NAME,
    startedAt: T0,
    durationMs: 2000
  }])
})
