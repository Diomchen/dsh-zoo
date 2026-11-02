import assert from 'node:assert/strict'
import test from 'node:test'

import { NEIGHBOR_TTL_MS } from '../src/protocol.js'
import {
  ACTIVITY_WINDOW_MS,
  DEPARTURE_COOLDOWN_MS,
  eligibleVisitTargets,
  pickVisitTarget,
  planSpontaneousVisit
} from '../src/visit-policy.js'

const NOW = 1_700_000_000_000

function neighbor (overrides = {}) {
  return {
    deviceId: 'neighbor-a',
    nickname: '甲',
    status: 'allowed',
    lastSeen: NOW - 1000,
    port: 40001,
    heartbeatAt: NOW - 1000,
    ...overrides
  }
}

function input (overrides = {}) {
  return {
    now: NOW,
    enabled: true,
    lastActivityAt: NOW - 1000,
    lastDepartureAt: NOW - DEPARTURE_COOLDOWN_MS,
    neighbors: [neighbor()],
    random: () => 0,
    ...overrides
  }
}

test('四道门都满足：出门，并把选中的邻居一起返回', () => {
  const plan = planSpontaneousVisit(input())

  assert.equal(plan.go, true)
  assert.equal(plan.reason, 'ready')
  assert.equal(plan.gate, null)
  assert.deepEqual(plan.candidate, { deviceId: 'neighbor-a', nickname: '甲' })
  assert.equal(plan.candidates, 1)
  assert.equal(plan.activityAgeMs, 1000)
  assert.equal(plan.sinceDepartureMs, DEPARTURE_COOLDOWN_MS)
})

test('闸门一：总开关关着，其他条件全满足也不出门', () => {
  for (const enabled of [false, undefined, null, 1, 'true']) {
    const plan = planSpontaneousVisit(input({ enabled }))
    assert.equal(plan.go, false, String(enabled))
    assert.equal(plan.reason, 'disabled')
    assert.equal(plan.gate, 'switch')
    assert.equal(plan.candidate, null)
  }
})

test('闸门二：没有活动、或活动超过 10 分钟，绝不出门；刚好 10 分钟仍算有活动', () => {
  const noActivity = planSpontaneousVisit(input({ lastActivityAt: null }))
  assert.equal(noActivity.go, false)
  assert.equal(noActivity.reason, 'no-activity')
  assert.equal(noActivity.gate, 'activity')
  assert.equal(noActivity.activityAgeMs, null)

  const stale = planSpontaneousVisit(input({ lastActivityAt: NOW - ACTIVITY_WINDOW_MS - 1 }))
  assert.equal(stale.go, false)
  assert.equal(stale.reason, 'no-activity')

  const boundary = planSpontaneousVisit(input({ lastActivityAt: NOW - ACTIVITY_WINDOW_MS }))
  assert.equal(boundary.go, true, '正好 10 分钟还在窗口内')

  // 传入坏时间戳时按“没有活动”处理，绝不因为 NaN 误放行。
  for (const value of [Number.NaN, Infinity, -Infinity, '刚刚']) {
    const plan = planSpontaneousVisit(input({ lastActivityAt: value }))
    assert.equal(plan.go, false, String(value))
    assert.equal(plan.reason, 'no-activity')
  }
})

test('闸门三：距上次出门不到 15 分钟不出门；刚好 15 分钟可以', () => {
  const cooling = planSpontaneousVisit(input({ lastDepartureAt: NOW - DEPARTURE_COOLDOWN_MS + 1 }))
  assert.equal(cooling.go, false)
  assert.equal(cooling.reason, 'cooldown')
  assert.equal(cooling.gate, 'cooldown')

  const boundary = planSpontaneousVisit(input({ lastDepartureAt: NOW - DEPARTURE_COOLDOWN_MS }))
  assert.equal(boundary.go, true)

  const never = planSpontaneousVisit(input({ lastDepartureAt: null }))
  assert.equal(never.go, true, '从没出过门 = 没有冷却')

  // 时钟回拨/未来时间戳：按 0 秒前处理，仍然在冷却里。
  const future = planSpontaneousVisit(input({ lastDepartureAt: NOW + 60_000 }))
  assert.equal(future.go, false)
  assert.equal(future.reason, 'cooldown')
  assert.equal(future.sinceDepartureMs, 0)
})

test('闸门四：没有在线且已放行的邻居就不出门', () => {
  const empty = planSpontaneousVisit(input({ neighbors: [] }))
  assert.equal(empty.go, false)
  assert.equal(empty.reason, 'no-neighbor')
  assert.equal(empty.gate, 'neighbor')
  assert.equal(empty.candidates, 0)

  const pending = planSpontaneousVisit(input({ neighbors: [neighbor({ status: 'pending' })] }))
  assert.equal(pending.go, false)
  assert.equal(pending.reason, 'no-neighbor')

  const denied = planSpontaneousVisit(input({ neighbors: [neighbor({ status: 'denied' })] }))
  assert.equal(denied.go, false)

  const offline = planSpontaneousVisit(input({
    neighbors: [neighbor({ lastSeen: NOW - NEIGHBOR_TTL_MS - 1 })]
  }))
  assert.equal(offline.go, false)
  assert.equal(offline.reason, 'no-neighbor')

  const unknownStatus = planSpontaneousVisit(input({ neighbors: [neighbor({ status: 'allowed-ish' })] }))
  assert.equal(unknownStatus.go, false)
})

test('已经在外面：不再挑邻居、也不会再出门', () => {
  const plan = planSpontaneousVisit(input({ alreadyOut: true }))
  assert.equal(plan.go, false)
  assert.equal(plan.reason, 'already-out')
  assert.equal(plan.gate, 'out')
  assert.equal(plan.candidate, null)
  assert.equal(plan.candidates, 1, '仍然报告候选数，便于排障')
})

test('随机只发生在合格的邻居里：0 取第一位、接近 1 取最后一位，坏随机源不抛', () => {
  const neighbors = [
    neighbor({ deviceId: 'a', nickname: '甲' }),
    neighbor({ deviceId: 'b', nickname: '乙' }),
    neighbor({ deviceId: 'c', nickname: '丙' }),
    neighbor({ deviceId: 'offline', nickname: '离线', lastSeen: NOW - NEIGHBOR_TTL_MS - 1 }),
    neighbor({ deviceId: 'pending', nickname: '待放行', status: 'pending' })
  ]
  const first = planSpontaneousVisit(input({ neighbors, random: () => 0 }))
  assert.equal(first.candidate.deviceId, 'a')
  assert.equal(first.candidates, 3)

  const middle = planSpontaneousVisit(input({ neighbors, random: () => 0.5 }))
  assert.equal(middle.candidate.deviceId, 'b')

  const last = planSpontaneousVisit(input({ neighbors, random: () => 0.999999 }))
  assert.equal(last.candidate.deviceId, 'c')

  for (const random of [() => 1, () => -1, () => Number.NaN, () => { throw new Error('boom') }, 'nope']) {
    const plan = planSpontaneousVisit(input({ neighbors, random }))
    assert.equal(plan.go, true, String(random))
    assert.ok(['a', 'b', 'c'].includes(plan.candidate.deviceId))
  }
})

test('非法输入不抛：null/坏邻居/坏 now 都只得到一条明确的 reason', () => {
  assert.equal(planSpontaneousVisit().reason, 'disabled')
  assert.equal(planSpontaneousVisit({ enabled: true }).reason, 'no-activity')
  assert.equal(planSpontaneousVisit({
    enabled: true,
    now: Number.NaN,
    lastActivityAt: Date.now() - ACTIVITY_WINDOW_MS - 1000
  }).reason, 'no-activity', '坏 now 回落到当前时间，活动时间戳旧了就是没活动')

  const weird = planSpontaneousVisit({
    now: NOW,
    enabled: true,
    lastActivityAt: NOW,
    lastDepartureAt: null,
    neighbors: [null, 'nope', 42, {}, neighbor({ deviceId: '' }), neighbor({ deviceId: 'x'.repeat(100) })]
  })
  assert.equal(weird.go, false)
  assert.equal(weird.reason, 'no-neighbor')
})

test('eligibleVisitTargets：只留在线且已放行的邻居，昵称清洗、deviceId 去重', () => {
  const targets = eligibleVisitTargets([
    neighbor({ deviceId: '  a  ', nickname: '  甲  ' }),
    neighbor({ deviceId: 'a', nickname: '重复' }),
    neighbor({ deviceId: 'b', nickname: '\u0000\u0007' }),
    neighbor({ deviceId: 'c', status: 'pending' }),
    neighbor({ deviceId: 'd', lastSeen: NOW - NEIGHBOR_TTL_MS - 1 }),
    // 在线、我也放行了，但对方没有心跳 = 对方没有放行我。
    neighbor({ deviceId: 'e', heartbeatAt: 0 }),
    neighbor({ deviceId: 'f', heartbeatAt: NOW - NEIGHBOR_TTL_MS - 1 }),
    neighbor({ deviceId: 'g', nickname: '边界', heartbeatAt: NOW - NEIGHBOR_TTL_MS })
  ], { now: NOW })
  assert.deepEqual(targets, [
    { deviceId: 'a', nickname: '甲' },
    { deviceId: 'b', nickname: '邻居' },
    { deviceId: 'g', nickname: '边界' }
  ])
  assert.deepEqual(eligibleVisitTargets(null, { now: NOW }), [])
})

test('pickVisitTarget：手动串门只从合格邻居里随机挑，没有就 null', () => {
  const neighbors = [
    neighbor({ deviceId: 'a', nickname: '甲' }),
    neighbor({ deviceId: 'b', nickname: '乙', status: 'pending' })
  ]
  assert.equal(pickVisitTarget(neighbors, { now: NOW, random: () => 0 }).deviceId, 'a')
  assert.equal(pickVisitTarget(neighbors, { now: NOW, random: () => 0.99 }).deviceId, 'a')
  assert.equal(pickVisitTarget([], { now: NOW }), null)
  assert.equal(pickVisitTarget([neighbor({ status: 'denied' })], { now: NOW }), null)
})
