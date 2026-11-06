/**
 * 票 44：room 的雇佣镜像（`self.work` / `worker`）。
 *
 * room 保持纯：喂事件、看快照；结束事件排队给 service，不碰磁盘、不发报文。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { createRoom } from '../src/room.js'

const T0 = 1_700_000_000_000
const HOUR = 3600_000
const EMPLOYER = randomUUID()
const WORKER = randomUUID()

function roomAt (now = T0) {
  const room = createRoom({ clock: () => now, peerLostMs: 2000 })
  room.setIdentity({ deviceId: randomUUID(), nickname: '我' })
  room.setTrust({ allowed: {
    [EMPLOYER]: { nickname: '楼上的柯基' },
    [WORKER]: { nickname: '阿蟹' }
  } })
  return room
}

function workingContract (overrides = {}) {
  return {
    contractId: randomUUID(),
    employerDeviceId: EMPLOYER,
    employerNickname: '楼上的柯基',
    startedAt: T0,
    endsAt: T0 + 4 * HOUR,
    guard: 0.5,
    ...overrides
  }
}

function workerContract (overrides = {}) {
  return {
    contractId: randomUUID(),
    workerDeviceId: WORKER,
    workerNickname: '阿蟹',
    startedAt: T0,
    endsAt: T0 + 4 * HOUR,
    guard: 0.5,
    ...overrides
  }
}

test('beginWorking：两个镜像与 out 互斥；快照多 self.work / 顶层 worker', () => {
  const room = roomAt()
  const started = room.beginWorking(workingContract(), T0)
  assert.equal(started.ok, true)
  assert.equal(started.work.employerDeviceId, EMPLOYER)

  const snap = room.snapshot()
  assert.equal(snap.self.work.contractId, started.work.contractId)
  assert.equal(snap.self.work.employerNickname, '楼上的柯基')
  assert.equal(snap.self.out, null)
  assert.equal(snap.worker, null)

  // 合同期内不能串门（另一次 beginVisit 会被 already-working 挡住）。
  const visit = room.beginVisit(EMPLOYER, { at: T0, visitId: randomUUID() })
  assert.equal(visit.ok, false)
  assert.equal(visit.error, 'already-working')

  // 已在外打工时再接一份工作：already-working。
  assert.equal(room.beginWorking(workingContract(), T0).error, 'already-working')
})

test('beginWorker：一个农场只允许一位雇工；不能雇自己的 deviceId', () => {
  const room = roomAt()
  const id = room.snapshot().self.deviceId
  assert.equal(room.beginWorker(workerContract({ workerDeviceId: id }), T0).error, 'own-pet')
  const first = room.beginWorker(workerContract(), T0)
  assert.equal(first.ok, true)
  assert.equal(room.snapshot().worker.workerNickname, '阿蟹')
  assert.equal(room.beginWorker(workerContract(), T0).error, 'already-hired')
})

test('beginWorking：已经在串门时返回 already-out', () => {
  const room = roomAt()
  const other = randomUUID()
  room.setTrust({ allowed: { [other]: { nickname: '邻居' } } })
  assert.equal(room.beginVisit(other, { at: T0, visitId: randomUUID() }).ok, true)
  assert.equal(room.beginWorking(workingContract(), T0).error, 'already-out')
})

test('坏合同形状不会进入镜像', () => {
  const room = roomAt()
  assert.equal(room.beginWorking({ ...workingContract(), contractId: 'x' }, T0).error, 'bad-contract')
  assert.equal(room.beginWorking({ ...workingContract(), endsAt: T0 }, T0).error, 'bad-contract')
  assert.equal(room.beginWorker({ ...workerContract(), workerDeviceId: '' }, T0).error, 'bad-contract')
  assert.equal(room.snapshot().self.work, null)
  assert.equal(room.snapshot().worker, null)
})

test('心跳刷新 work/worker 的 lastSeen 与 anim', () => {
  const room = roomAt()
  room.beginWorking(workingContract(), T0)
  room.beginWorker(workerContract(), T0)
  assert.equal(room.observeHeartbeat({ deviceId: WORKER, anim: '打工中' }, T0 + 1000), true)
  assert.equal(room.observeHeartbeat({ deviceId: EMPLOYER, anim: null }, T0 + 1500), true)
  assert.equal(room.snapshot().worker.lastSeen, T0 + 1000)
  assert.equal(room.snapshot().worker.anim, '打工中')
  assert.equal(room.snapshot().self.work.lastSeen, T0 + 1500)
})

test('tick：到期按 endsAt 结束，并把事件排队给 service', () => {
  const room = roomAt()
  const work = workingContract()
  const worker = workerContract()
  room.beginWorking(work, T0)
  room.beginWorker(worker, T0)
  assert.equal(room.tick(work.endsAt).worker, undefined)
  assert.equal(room.snapshot().self.work, null)
  assert.equal(room.snapshot().worker, null)
  const ended = room.drainEndedContracts()
  assert.deepEqual(ended.map((event) => [event.role, event.reason]), [
    ['employer', 'expired'],
    ['worker', 'expired']
  ])
  assert.deepEqual(room.drainEndedContracts(), [])
})

test('tick：2 分钟没有心跳按最后心跳结束（offline）', () => {
  const room = roomAt()
  room.beginWorking(workingContract(), T0)
  room.beginWorker(workerContract(), T0)
  room.tick(T0 + 1000)
  assert.notEqual(room.snapshot().self.work, null, '还在心跳窗口内')
  room.tick(T0 + 2000)
  assert.equal(room.snapshot().self.work, null)
  assert.equal(room.snapshot().worker, null)
  const ended = room.drainEndedContracts()
  assert.equal(ended[0].reason, 'offline')
  assert.equal(ended[0].endedAt, T0)
})

test('endWorking / endWorker：只清匹配的那一份，且幂等', () => {
  const room = roomAt()
  const work = workingContract()
  const worker = workerContract()
  room.beginWorking(work, T0)
  room.beginWorker(worker, T0)
  assert.equal(room.endWorking(worker.contractId), false, '不匹配的合同号什么也不清')
  assert.equal(room.endWorking(work.contractId, { at: T0 + 1000, reason: 'recall' }), true)
  assert.equal(room.endWorking(work.contractId), false)
  assert.equal(room.snapshot().self.work, null)
  assert.notEqual(room.snapshot().worker, null, '雇工镜像还在')
  const ended = room.drainEndedContracts()
  assert.deepEqual(ended, [{
    role: 'worker',
    contractId: work.contractId,
    endedAt: T0 + 1000,
    reason: 'recall'
  }])
})

test('拒绝/信任收紧：合同立即结束（D7）', () => {
  const room = roomAt()
  room.beginWorker(workerContract(), T0)
  room.beginWorking(workingContract(), T0)
  const decision = room.reject(WORKER)
  assert.equal(decision.ok, true)
  assert.equal(room.snapshot().worker, null)
  assert.notEqual(room.snapshot().self.work, null, '雇主没被拒绝，工作合同还在')
  assert.deepEqual(room.drainEndedContracts().map((event) => [event.role, event.reason]),
    [['employer', 'denied']])

  // 雇主被拒绝：在外打工的合同同样立即结束。
  assert.equal(room.reject(EMPLOYER).ok, true)
  assert.equal(room.snapshot().self.work, null)
  assert.deepEqual(room.drainEndedContracts().map((event) => [event.role, event.reason]),
    [['worker', 'denied']])
})

test('dispose 清空两个镜像与排队事件', () => {
  const room = roomAt()
  room.beginWorker(workerContract(), T0)
  room.beginWorking(workingContract(), T0)
  room.dispose()
  assert.equal(room.snapshot().worker, null)
  assert.equal(room.snapshot().self.work, null)
  assert.deepEqual(room.drainEndedContracts(), [])
})

test('peerNickname：邻居表优先，其次放行名单，非法返回 null', () => {
  const room = roomAt()
  assert.equal(room.peerNickname(EMPLOYER), '楼上的柯基')
  assert.equal(room.peerNickname('nope'), null)
  assert.equal(room.peerNickname(null), null)
})
