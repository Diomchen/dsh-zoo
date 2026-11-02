import assert from 'node:assert/strict'
import test from 'node:test'

import { NEIGHBOR_TTL_MS } from '../src/protocol.js'
import { ACTIVITY_WINDOW_MS, DEPARTURE_COOLDOWN_MS } from '../src/visit-policy.js'
import { createRoom } from '../src/room.js'

const T0 = 1_700_000_000_000
const PEER_A = '11111111-1111-4111-8111-111111111111'
const PEER_B = '22222222-2222-4222-8222-222222222222'
const VISIT_ID = '33333333-3333-4333-8333-333333333333'

function makeRoom () {
  const clock = { now: T0 }
  const room = createRoom({ clock: () => clock.now })
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.observeBeacon({ deviceId: PEER_A, nickname: '甲', port: 40001 }, T0)
  room.observeBeacon({ deviceId: PEER_B, nickname: '乙', port: 40002 }, T0)
  room.admit(PEER_A)
  room.admit(PEER_B)
  // 心跳同时证明“对方放行了我”，是 visitTargets 的必要条件。
  room.observeHeartbeat({ deviceId: PEER_A, anim: null }, T0)
  room.observeHeartbeat({ deviceId: PEER_B, anim: null }, T0)
  return { room, clock }
}

test('默认关：autoVisit 初始状态、活动来源 none、没有 visitTargets', () => {
  const room = createRoom({ clock: () => T0 })
  const snap = room.snapshot()
  assert.deepEqual(snap.autoVisit, {
    enabled: false,
    activitySource: 'none',
    lastActivityAt: null,
    lastDepartureAt: null,
    lastDecision: null
  })
  assert.deepEqual(snap.visitTargets, [])
  assert.equal(room.setAutoVisits(true), true)
  assert.equal(room.snapshot().autoVisit.enabled, true)
  assert.equal(room.setAutoVisits('yes'), true, '非布尔值不改变开关')
  assert.equal(room.snapshot().autoVisit.enabled, true)
})

test('活动来源：session 与 pointer 各自保存最近时间，快照取更近的那个；同一来源只前进', () => {
  const room = createRoom({ clock: () => T0 })

  assert.deepEqual(room.noteActivity('session', T0 + 1000), { at: T0 + 1000, source: 'session' })
  assert.equal(room.snapshot().autoVisit.activitySource, 'session')
  assert.equal(room.snapshot().autoVisit.lastActivityAt, T0 + 1000)

  assert.deepEqual(room.noteActivity('pointer', T0 + 2000), { at: T0 + 2000, source: 'pointer' })
  assert.equal(room.snapshot().autoVisit.activitySource, 'pointer')

  // 迟到的 session 事件比 pointer 旧：不能把“最近活动”往回拨。
  assert.deepEqual(room.noteActivity('session', T0 + 1500), { at: T0 + 2000, source: 'pointer' })

  // 新的 session 事件更近：来源切回 session。
  assert.deepEqual(room.noteActivity('session', T0 + 3000), { at: T0 + 3000, source: 'session' })

  assert.equal(room.noteActivity('keyboard', T0 + 9999), null)
  assert.equal(room.snapshot().autoVisit.lastActivityAt, T0 + 3000)
})

test('自发策略：开关关闭绝不出发；打开后活动/冷却/邻居三道门逐条生效', () => {
  const { room, clock } = makeRoom()
  clock.now = T0 + 1000

  assert.equal(room.spontaneousVisitPlan(() => 0).reason, 'disabled')

  room.setAutoVisits(true)
  // 没有活动：
  assert.equal(room.spontaneousVisitPlan(() => 0).reason, 'no-activity')

  room.noteActivity('session', clock.now - 1000)
  const ready = room.spontaneousVisitPlan(() => 0)
  assert.equal(ready.go, true)
  assert.equal(ready.reason, 'ready')
  assert.equal(ready.activitySource, 'session')
  assert.deepEqual(ready.candidate, { deviceId: PEER_A, nickname: '甲' })
  assert.equal(ready.candidates, 2)

  // 活动刚好 10 分钟：仍可出门（邻居要同时保持在线）；超过 1ms：不行。
  clock.now = T0 + ACTIVITY_WINDOW_MS
  room.observeBeacon({ deviceId: PEER_A, nickname: '甲', port: 40001 }, clock.now)
  room.observeBeacon({ deviceId: PEER_B, nickname: '乙', port: 40002 }, clock.now)
  room.observeHeartbeat({ deviceId: PEER_A, anim: null }, clock.now)
  room.observeHeartbeat({ deviceId: PEER_B, anim: null }, clock.now)
  assert.equal(room.spontaneousVisitPlan(() => 0).go, true)
  clock.now += 1
  room.observeBeacon({ deviceId: PEER_A, nickname: '甲', port: 40001 }, clock.now)
  room.observeBeacon({ deviceId: PEER_B, nickname: '乙', port: 40002 }, clock.now)
  room.observeHeartbeat({ deviceId: PEER_A, anim: null }, clock.now)
  room.observeHeartbeat({ deviceId: PEER_B, anim: null }, clock.now)
  assert.equal(room.spontaneousVisitPlan(() => 0).reason, 'no-activity')

  room.noteActivity('session', clock.now - 1000)
  // 没有邻居：把邻居表清空（放行名单还在，心跳目标还在，只是没在线地址）。
  room.setTrust({ allowed: {}, denied: {} })
  assert.equal(room.spontaneousVisitPlan(() => 0).reason, 'no-neighbor')
})

test('对方在线但没放行我（只有广播、没有心跳）：不自动出门，也不把手动串门指向它', () => {
  const clock = { now: T0 }
  const room = createRoom({ clock: () => clock.now })
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.observeBeacon({ deviceId: PEER_A, nickname: '甲', port: 40001 }, T0)
  room.admit(PEER_A)
  room.setAutoVisits(true)
  room.noteActivity('session', T0)

  // 只收到广播：它在线，但没有心跳证明“它放行了我”。
  assert.deepEqual(room.visitTargets(), [])
  const plan = room.spontaneousVisitPlan(() => 0)
  assert.equal(plan.go, false)
  assert.equal(plan.reason, 'no-neighbor')

  // 收到心跳后才成为目标。
  room.observeHeartbeat({ deviceId: PEER_A, anim: null }, T0 + 1000)
  assert.deepEqual(room.visitTargets(), [{ deviceId: PEER_A, nickname: '甲' }])
  room.noteActivity('session', T0 + 1000)
  assert.equal(room.spontaneousVisitPlan(() => 0).go, true)
})

test('自发策略：以 room 的邻居表和随机源选人；已在外面时 already-out', () => {
  const { room, clock } = makeRoom()
  clock.now = T0 + 1000
  room.setAutoVisits(true)
  room.noteActivity('session', clock.now - 1000)

  const second = room.spontaneousVisitPlan(() => 0.99)
  assert.equal(second.candidate.deviceId, PEER_B)

  assert.equal(room.beginVisit(PEER_A, { at: clock.now, visitId: VISIT_ID }).ok, true)
  const away = room.spontaneousVisitPlan(() => 0)
  assert.equal(away.go, false)
  assert.equal(away.reason, 'already-out')
  assert.equal(away.gate, 'out')
})

test('手动串门也计入 15 分钟冷却；冷却从开始出门算，不是从回家算', () => {
  const { room, clock } = makeRoom()
  clock.now = T0 + 1000
  room.setAutoVisits(true)
  room.noteActivity('session', clock.now - 1000)

  assert.equal(room.beginVisit(PEER_A, { at: clock.now, visitId: VISIT_ID }).ok, true)
  room.recallOutbound(clock.now + 5000)
  assert.equal(room.snapshot().autoVisit.lastDepartureAt, clock.now)

  clock.now += DEPARTURE_COOLDOWN_MS - 1
  room.noteActivity('session', clock.now)
  room.observeBeacon({ deviceId: PEER_A, nickname: '甲', port: 40001 }, clock.now)
  room.observeBeacon({ deviceId: PEER_B, nickname: '乙', port: 40002 }, clock.now)
  room.observeHeartbeat({ deviceId: PEER_A, anim: null }, clock.now)
  room.observeHeartbeat({ deviceId: PEER_B, anim: null }, clock.now)
  assert.equal(room.spontaneousVisitPlan(() => 0).reason, 'cooldown')

  clock.now += 1
  room.noteActivity('session', clock.now)
  room.observeBeacon({ deviceId: PEER_A, nickname: '甲', port: 40001 }, clock.now)
  room.observeBeacon({ deviceId: PEER_B, nickname: '乙', port: 40002 }, clock.now)
  room.observeHeartbeat({ deviceId: PEER_A, anim: null }, clock.now)
  room.observeHeartbeat({ deviceId: PEER_B, anim: null }, clock.now)
  assert.equal(room.spontaneousVisitPlan(() => 0).go, true)
})

test('lastDecision 进快照：保留 reason/gate/候选人与活动来源，坏输入被清洗', () => {
  const { room, clock } = makeRoom()
  clock.now = T0 + 1000
  room.setAutoVisits(true)
  room.noteActivity('session', clock.now - 1000)

  const plan = room.spontaneousVisitPlan(() => 0)
  room.notePolicyDecision(plan, clock.now)
  const decision = room.snapshot().autoVisit.lastDecision
  assert.equal(decision.at, clock.now)
  assert.equal(decision.reason, 'ready')
  assert.equal(decision.gate, null)
  assert.deepEqual(decision.candidate, { deviceId: PEER_A, nickname: '甲' })
  assert.equal(decision.activitySource, 'session')
  assert.equal(decision.candidates, 2)

  room.notePolicyDecision({ reason: '../evil', gate: 42, candidates: -1, activitySource: 'keyboard' })
  const cleaned = room.snapshot().autoVisit.lastDecision
  assert.equal(cleaned.reason, 'no-activity')
  assert.equal(cleaned.gate, null)
  assert.equal(cleaned.candidates, 0)
  assert.equal(cleaned.activitySource, 'none')
  assert.equal(cleaned.candidate, null)

  room.notePolicyDecision(null)
  assert.equal(room.snapshot().autoVisit.lastDecision, null)
})

test('visitTargets / pickVisitTarget / noVisitTarget：在线且已放行才算目标，失败文案区分两种原因', () => {
  const { room, clock } = makeRoom()
  assert.deepEqual(room.snapshot().visitTargets, [
    { deviceId: PEER_A, nickname: '甲' },
    { deviceId: PEER_B, nickname: '乙' }
  ])
  assert.equal(room.pickVisitTarget(() => 0).deviceId, PEER_A)
  assert.equal(room.pickVisitTarget(() => 0.99).deviceId, PEER_B)

  // 两位都掉线（邻居 TTL 过了）：仍然放行，但没有在线目标。
  clock.now = T0 + NEIGHBOR_TTL_MS + 1
  room.tick(clock.now)
  assert.deepEqual(room.visitTargets(), [])
  assert.equal(room.pickVisitTarget(() => 0), null)
  const offline = room.noVisitTarget(clock.now)
  assert.equal(offline.ok, false)
  assert.equal(offline.error, 'no-online')
  assert.match(offline.notice, /都不在线/)

  // 没有任何放行：提示“还没有人放行你”。
  const empty = createRoom({ clock: () => T0 })
  const none = empty.noVisitTarget(T0)
  assert.equal(none.error, 'no-admitted')
  assert.match(none.notice, /还没有人放行你/)
})

test('visitTargets 的变化不影响邻居表本身；未放行/已拒绝的邻居永远不是目标', () => {
  const { room } = makeRoom()
  room.reject(PEER_A)
  assert.deepEqual(room.snapshot().visitTargets.map((target) => target.deviceId), [PEER_B])
  assert.equal(room.snapshot().neighbors.find((neighbor) => neighbor.deviceId === PEER_A).status, 'denied')
})
