/**
 * 票 44：桌面的 worker 层（role/badge/owner presence/contracts 白名单）。
 *
 * 四层都要过：`normalizeScene`（wire）→ `petScene`（host）→ `normalizeItem`（helper）
 * → 渲染端读到的 `item.role`/`item.badge`。这里从 helper 的 shared 入口与宿主翻译层两侧验。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { controlsFromSnapshot, petsFromSnapshot } from '../src/desktop-pets.js'

const WORKER = randomUUID()
const EMPLOYER = randomUUID()

function snapshotWith (overrides = {}) {
  return {
    version: 1,
    self: {
      deviceId: randomUUID(),
      nickname: '我',
      pet: { name: '小蓝', anim: '东张西望' },
      bridge: { ok: true, reason: null },
      out: null,
      work: null
    },
    neighbors: [],
    guests: [],
    visitors: [],
    visits: [],
    prompt: null,
    notices: [],
    acceptVisits: true,
    autoVisit: { enabled: false, activitySource: 'none', lastActivityAt: null, lastDepartureAt: null, lastDecision: null },
    visitTargets: [],
    visitBlockedReason: null,
    worker: null,
    farm: {
      plots: [{ id: 'p1', crop: null, stage: 'empty', mature: false }],
      coins: 30,
      dew: 0,
      worker: null,
      contractCount: 0
    },
    ...overrides
  }
}

test('petsFromSnapshot：worker 在 self 之后、visitors 之前，带 role/badge', () => {
  const snapshot = snapshotWith({
    worker: {
      contractId: randomUUID(),
      workerDeviceId: WORKER,
      workerNickname: '  阿蟹  ',
      startedAt: 1,
      endsAt: 2,
      guard: 0.5,
      anim: '打工中',
      lastSeen: 1
    },
    visitors: [{
      deviceId: randomUUID(),
      nickname: '访客',
      anim: null,
      visitId: randomUUID(),
      since: 1,
      lastSeen: 1
    }]
  })
  const pets = petsFromSnapshot(snapshot)
  assert.deepEqual(pets.map((pet) => pet.role), ['self', 'worker', 'visitor'])
  assert.equal(pets[1].id, 'worker:' + WORKER)
  assert.equal(pets[1].label, '阿蟹')
  assert.equal(pets[1].anim, '打工中')
  assert.equal(pets[1].badge, 'work')
  // worker 不占访客名额。
  assert.equal(shared.normalizeControls({ farm: shared.normalizeFarmSummary(snapshot.farm) }).farm.owner.presence, 'home')
})

test('self.work：本机宠物在外打工时 self 从桌面消失；controls 给出「不能串门」', () => {
  const snapshot = snapshotWith({
    self: {
      deviceId: randomUUID(),
      nickname: '我',
      pet: { name: '小蓝', anim: null },
      bridge: { ok: true, reason: null },
      out: null,
      work: {
        contractId: randomUUID(),
        employerDeviceId: EMPLOYER,
        employerNickname: '柯基',
        startedAt: 1,
        endsAt: 2,
        guard: 0.5,
        lastSeen: 1
      }
    },
    visitTargets: [{ deviceId: EMPLOYER, nickname: '柯基' }]
  })
  const pets = petsFromSnapshot(snapshot)
  assert.equal(pets.some((pet) => pet.id === 'self'), false)
  const controls = controlsFromSnapshot(snapshot)
  assert.equal(controls.visit.enabled, false)
  assert.match(controls.visit.reason, /在外打工/)
  assert.equal(controls.farm.owner.presence, 'working')
  assert.equal(controls.recall.enabled, false, '召回只服务串门，雇工合同在农场窗里召回')
})

test('farm owner presence：home / visiting / working，缺省回 home', () => {
  const home = controlsFromSnapshot(snapshotWith()).farm
  assert.deepEqual(home.owner, { presence: 'home' })

  const visiting = controlsFromSnapshot(snapshotWith({
    self: {
      ...snapshotWith().self,
      out: { deviceId: EMPLOYER, nickname: '柯基', visitId: randomUUID(), phase: 'active', startedAt: 1, endsAt: 2 }
    }
  })).farm
  assert.deepEqual(visiting.owner, { presence: 'visiting' })

  // 老宿主没有 owner：normalizeFarmSummary 给 home，不画「看家中」的反向文案。
  const legacy = shared.normalizeFarmSummary({ plots: [], coins: 0, dew: 0, worker: null, contractCount: 0 })
  assert.deepEqual(legacy.owner, { presence: 'home' })
  // 认不出的值不猜。
  assert.deepEqual(shared.normalizeFarmSummary({ ...snapshotWith().farm, owner: { presence: 'nope' } }).owner,
    { presence: 'home' })
})

test('helper 四层：PET_ROLES 含 worker，normalizeItem/petScene 保留 badge，非法 badge 丢弃', () => {
  assert.deepEqual(shared.PET_ROLES, ['self', 'guest', 'visitor', 'worker'])
  assert.deepEqual(shared.PET_BADGES, ['work'])

  const wire = shared.normalizeScene({
    items: [{
      id: 'worker:' + WORKER,
      kind: 'pet',
      role: 'worker',
      badge: 'work',
      anim: '打工中',
      label: '阿蟹',
      color: '#c2913b',
      x: 10,
      y: 20,
      width: 60,
      height: 80
    }]
  })
  assert.equal(wire.items[0].role, 'worker')
  assert.equal(wire.items[0].badge, 'work')

  const noBadge = shared.normalizeScene({
    items: [{
      id: 'worker:x',
      kind: 'pet',
      role: 'worker',
      badge: '随便写',
      label: '阿蟹',
      x: 1,
      y: 2,
      width: 30,
      height: 40
    }]
  })
  assert.equal(noBadge.items[0].badge, undefined)

  const scene = shared.petScene([
    { id: 'self', role: 'self', label: '我' },
    { id: 'worker:' + WORKER, role: 'worker', badge: 'work', label: '阿蟹' },
    { id: 'visitor:x', role: 'visitor', label: '访客' }
  ], { width: 1000, height: 700 }, {
    reset: true,
    controls: {
      farm: {
        plots: [{ id: 'p1', crop: null }],
        coins: 30,
        dew: 0,
        worker: { nickname: '阿蟹' },
        contractCount: 1,
        owner: { presence: 'home' }
      }
    }
  })
  assert.equal(scene.items.length, 3)
  assert.equal(scene.items[1].role, 'worker')
  assert.equal(scene.items[1].badge, 'work')
  assert.equal(scene.controls.farm.owner.presence, 'home')
  // 坏 badge 不进入场景（固定枚举，不是自由文本）。
  const hostile = shared.normalizeScene({
    items: [{ id: 'worker:y', kind: 'pet', role: 'worker', badge: '<script>', label: 'x', x: 1, y: 2, width: 10, height: 10 }]
  })
  assert.equal(hostile.items[0].badge, undefined)
  // 场景里仍然只有摘要，没有 hire/guard/seeds/log。
  for (const key of ['hire', 'guard', 'seeds', 'crops', 'log']) {
    assert.equal(key in scene.controls.farm, false, key)
  }
})

test('farm-window：contracts 白名单只留公开字段，坏条目只丢自己', () => {
  const command = shared.normalizeHostCommand({
    type: 'farm-window',
    open: true,
    farm: {
      plots: [{ id: 'p1', crop: 'tomato', stage: 'growing', mature: false, remainingMs: 1000, waterings: 0, fertilized: false }],
      seeds: { tomato: 1 },
      crops: {},
      coins: 30,
      dew: 0,
      worker: { nickname: '阿蟹' },
      contractCount: 1,
      hire: { enabled: true, wagePerHour: 10, minHours: 2, maxHours: 8 },
      guard: 0.8,
      log: []
    },
    contracts: {
      outgoing: [
        {
          id: randomUUID(),
          workerNickname: ' 阿蟹 ',
          hours: 2,
          wagePerHour: 10,
          wage: 20,
          fee: 1,
          status: 'active',
          earned: 0,
          remainingMs: 1000,
          settled: false,
          // 内部 WAL 字段不该过 IPC。
          charged: true,
          refunded: false
        },
        { id: 'bad', status: 'active' },
        { id: randomUUID(), status: 'settled' }
      ],
      incoming: [],
      listings: [{
        deviceId: WORKER,
        nickname: '阿蟹',
        enabled: true,
        available: true,
        reason: 'ready',
        wagePerHour: 10,
        minHours: 2,
        maxHours: 8,
        guard: 0.5,
        stale: false
      }],
      pendingHire: true
    }
  })
  assert.equal(command.ok, true)
  const window = command.command
  assert.equal(window.farm.hire.wagePerHour, 10)
  assert.equal(window.farm.guard, 0.8)
  assert.equal(window.farm.worker.nickname, '阿蟹')
  // 完整视图不带 owner（那是地块条摘要的字段）。
  assert.equal('owner' in window.farm, false)
  assert.equal(window.contracts.outgoing.length, 1)
  assert.equal(window.contracts.outgoing[0].workerNickname, '阿蟹')
  assert.equal('charged' in window.contracts.outgoing[0], false)
  assert.equal('refunded' in window.contracts.outgoing[0], false)
  assert.equal(window.contracts.listings.length, 1)
  assert.equal(window.contracts.listings[0].deviceId, WORKER)
  assert.equal(window.contracts.pendingHire, true)
})

test('helper 事件：hire/recall-worker/end-contract/hire-listing 的字段白名单', () => {
  const hire = shared.normalizeHelperEvent({
    type: 'action',
    id: 'a1',
    action: 'hire',
    deviceId: WORKER,
    hours: 2,
    // 窗口多传的字段一律丢掉。
    coins: 999,
    wage: 999
  })
  assert.equal(hire.ok, true)
  assert.deepEqual(hire.event, {
    type: 'action',
    id: 'a1',
    action: 'hire',
    deviceId: WORKER,
    hours: 2,
    nickname: null
  })

  assert.equal(shared.normalizeHelperEvent({
    type: 'action', id: 'a2', action: 'hire', deviceId: WORKER, hours: 1
  }).ok, false)

  const recall = shared.normalizeHelperEvent({
    type: 'action', id: 'a3', action: 'recall-worker', contractId: randomUUID()
  })
  assert.equal(recall.ok, true)
  assert.equal(recall.event.action, 'recall-worker')

  const listing = shared.normalizeHelperEvent({
    type: 'action',
    id: 'a4',
    action: 'hire-listing',
    enabled: true,
    wagePerHour: 10,
    minHours: 2,
    maxHours: 8
  })
  assert.equal(listing.ok, true)
  assert.equal(listing.event.enabled, true)

  assert.equal(shared.normalizeHelperEvent({
    type: 'action', id: 'a5', action: 'hire-listing', enabled: 'yes', wagePerHour: 10, minHours: 2, maxHours: 8
  }).ok, false)

  // 冒烟命令也能带新字段。
  const debug = shared.normalizeHostCommand({
    type: 'debug-farm-submit',
    action: 'hire',
    deviceId: WORKER,
    hours: 2
  })
  assert.equal(debug.ok, true)
  assert.equal(debug.command.deviceId, WORKER)
  assert.equal(debug.command.hours, 2)
})
