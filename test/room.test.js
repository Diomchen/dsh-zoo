import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_NEIGHBORS, NEIGHBOR_TTL_MS } from '../src/protocol.js'
import { createRoom } from '../src/room.js'

const T0 = 1_700_000_000_000

function roomAt (now = T0) {
  return createRoom({ clock: () => now })
}

test('初始快照保持 v1 形状，并带上降级状态', () => {
  const snap = roomAt().snapshot()
  assert.equal(snap.version, 1)
  assert.deepEqual(snap.self, {
    deviceId: null,
    nickname: '我',
    pet: null,
    bridge: { ok: false, reason: 'starting' }
  })
  assert.deepEqual(snap.neighbors, [])
  assert.deepEqual(snap.guests, [])
  assert.deepEqual(snap.visits, [])
  assert.equal(snap.prompt, null)
  assert.deepEqual(snap.notices, [])
})

test('身份与本地影子来自宿主的本地输入', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '阿蓝' })
  room.setSelfPet({ name: '蓝毛小女仆', anim: '写代码' })
  room.setBridge({ ok: true })

  const snap = room.snapshot()
  assert.equal(snap.self.deviceId, 'me-1')
  assert.equal(snap.self.nickname, '阿蓝')
  assert.deepEqual(snap.self.pet, { name: '蓝毛小女仆', anim: '写代码' })
  assert.deepEqual(snap.self.bridge, { ok: true, reason: null })
})

test('宠物未知时为 null；非法动画名不会进入快照', () => {
  const room = roomAt()

  room.setSelfPet(null)
  assert.equal(room.snapshot().self.pet, null)

  room.setSelfPet({ name: null, anim: null })
  assert.equal(room.snapshot().self.pet, null)

  room.setSelfPet({ name: '蓝毛小女仆', anim: null })
  assert.deepEqual(room.snapshot().self.pet, { name: '蓝毛小女仆', anim: null })

  room.setSelfPet({ name: '蓝毛小女仆', anim: '../etc/passwd' })
  assert.deepEqual(room.snapshot().self.pet, { name: '蓝毛小女仆', anim: null })
})

test('邻居首次出现是 pending，并按 deviceId 更新而不是按 IP', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '隔壁同事', port: 40001 }, T0)

  assert.deepEqual(room.snapshot().neighbors, [{
    deviceId: 'neighbor-a',
    nickname: '隔壁同事',
    status: 'pending',
    lastSeen: T0,
    port: 40001
  }])

  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '隔壁改名了', port: 40002 }, T0 + 5000)
  const neighbors = room.snapshot().neighbors
  assert.equal(neighbors.length, 1)
  assert.equal(neighbors[0].nickname, '隔壁改名了')
  assert.equal(neighbors[0].lastSeen, T0 + 5000)
  assert.equal(neighbors[0].port, 40002)
  assert.equal(neighbors[0].status, 'pending')
})

test('自己的广播不会变成邻居', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.observeBeacon({ deviceId: 'me-1', nickname: '冒名', port: 40001 }, T0)
  assert.deepEqual(room.snapshot().neighbors, [])
})

test('30 秒没有新报文就丢掉邻居', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '隔壁', port: 40001 }, T0)

  assert.equal(room.tick(T0 + NEIGHBOR_TTL_MS - 1), 0)
  assert.equal(room.snapshot().neighbors.length, 1)

  assert.equal(room.tick(T0 + NEIGHBOR_TTL_MS), 1)
  assert.deepEqual(room.snapshot().neighbors, [])
})

test('远程昵称会清洗并截断，远程字段不会碰到 self', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  const before = room.snapshot().self

  room.observeBeacon({
    deviceId: 'neighbor-a',
    nickname: '  \u0000 很长的邻居名字'.padEnd(80, '喵'),
    port: 40001,
    // 以下都是伪造字段：room 只读取自己认识的那几个
    anim: '写代码',
    path: '/tmp/evil',
    command: 'rm -rf /',
    self: { nickname: '被篡改' }
  }, T0)

  const snap = room.snapshot()
  assert.deepEqual(snap.self, before)
  assert.equal(Array.from(snap.neighbors[0].nickname).length, 32)
  assert.equal(snap.neighbors[0].nickname.includes('\u0000'), false)
})

test('邻居名字不可用或 deviceId 非法时丢弃报文', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: '', nickname: 'x' }, T0)
  room.observeBeacon({ deviceId: 'a'.repeat(65), nickname: 'x' }, T0)
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '\u0000\u0007' }, T0)
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: 42 }, T0)
  assert.deepEqual(room.snapshot().neighbors, [])
})

test('邻居表有上限，防止广播投毒无限增长', () => {
  const room = roomAt()
  for (let index = 0; index < MAX_NEIGHBORS + 5; index += 1) {
    room.observeBeacon({ deviceId: 'dev-' + index, nickname: '邻居' + index, port: 40000 }, T0)
  }
  assert.equal(room.snapshot().neighbors.length, MAX_NEIGHBORS)
})

test('快照是拷贝，调用方改快照不会污染客厅状态', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '隔壁', port: 40001 }, T0)
  const snap = room.snapshot()
  snap.neighbors[0].nickname = '被改掉'
  snap.neighbors.push({ deviceId: 'ghost' })
  assert.equal(room.snapshot().neighbors.length, 1)
  assert.equal(room.snapshot().neighbors[0].nickname, '隔壁')
})

test('桥接状态只接受已知 reason', () => {
  const room = roomAt()
  room.setBridge({ ok: false, reason: 'weird' })
  assert.deepEqual(room.snapshot().self.bridge, { ok: false, reason: 'unreachable' })

  room.setBridge({ ok: true, reason: 'whatever' })
  assert.deepEqual(room.snapshot().self.bridge, { ok: true, reason: null })
})

test('未知 action 明确失败，不假装成功', async () => {
  const room = roomAt()
  assert.deepEqual(await room.action({ action: 'visit' }), {
    ok: false,
    error: 'not-implemented',
    action: 'visit'
  })
})
