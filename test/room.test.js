import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { GUEST_TTL_MS, MAX_NEIGHBORS, NEIGHBOR_TTL_MS } from '../src/protocol.js'
import { MAX_GUESTS, MAX_PROMPTS, PROMPT_SNOOZE_MS, createRoom } from '../src/room.js'
import { visitReasonText } from '../src/visit-copy.js'

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
    bridge: { ok: false, reason: 'starting' },
    out: null
  })
  assert.deepEqual(snap.neighbors, [])
  assert.deepEqual(snap.guests, [])
  assert.deepEqual(snap.visitors, [])
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
    port: 40001,
    heartbeatAt: 0
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

test('第一次见到邻居时出放行提示；接受后不再问，门控通过', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '隔壁同事', port: 40001 }, T0)

  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-a', nickname: '隔壁同事' })
  assert.equal(room.snapshot().neighbors[0].status, 'pending')
  assert.equal(room.mayTalkTo('neighbor-a'), false)

  assert.deepEqual(room.admit('neighbor-a'), {
    ok: true,
    deviceId: 'neighbor-a',
    nickname: '隔壁同事',
    status: 'allowed',
    at: T0
  })
  assert.equal(room.snapshot().prompt, null)
  assert.equal(room.snapshot().neighbors[0].status, 'allowed')
  assert.equal(room.mayTalkTo('neighbor-a'), true)

  // 再收到广播也不会重新询问。
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '隔壁改名', port: 40002 }, T0 + 5000)
  assert.equal(room.snapshot().prompt, null)
  assert.equal(room.snapshot().neighbors[0].status, 'allowed')
  assert.equal(room.snapshot().neighbors[0].nickname, '隔壁改名')
})

test('拒绝后不再提示、门控关闭；邻居灯消失后再次出现仍是 denied', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '隔壁', port: 40001 }, T0)

  assert.equal(room.reject('neighbor-a').status, 'denied')
  assert.equal(room.snapshot().prompt, null)
  assert.equal(room.snapshot().neighbors[0].status, 'denied')
  assert.equal(room.mayTalkTo('neighbor-a'), false)

  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '隔壁又来了', port: 40001 }, T0 + 5000)
  assert.equal(room.snapshot().prompt, null)
  assert.equal(room.snapshot().neighbors[0].status, 'denied')

  // 30 秒后灯灭；下一次广播仍然按 deviceId 记住拒绝。
  room.tick(T0 + 5000 + NEIGHBOR_TTL_MS)
  assert.deepEqual(room.snapshot().neighbors, [])
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '隔壁', port: 40001 }, T0 + 40000)
  assert.equal(room.snapshot().neighbors[0].status, 'denied')
  assert.equal(room.snapshot().prompt, null)
})

test('放行提示是 FIFO：决定一位后自动轮到下一位', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  room.observeBeacon({ deviceId: 'neighbor-b', nickname: '乙', port: 40002 }, T0)
  room.observeBeacon({ deviceId: 'neighbor-c', nickname: '丙', port: 40003 }, T0)

  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-a', nickname: '甲' })
  room.admit('neighbor-a')
  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-b', nickname: '乙' })
  room.reject('neighbor-b')
  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-c', nickname: '丙' })
  room.admit('neighbor-c')
  assert.equal(room.snapshot().prompt, null)

  assert.equal(room.mayTalkTo('neighbor-a'), true)
  assert.equal(room.mayTalkTo('neighbor-b'), false)
  assert.equal(room.mayTalkTo('neighbor-c'), true)
})

test('放行队列有上限，超出的邻居等下一次广播再排队', () => {
  const room = roomAt()
  const extra = MAX_PROMPTS + 2
  for (let index = 0; index < extra; index += 1) {
    room.observeBeacon({ deviceId: 'dev-' + index, nickname: '邻居' + index, port: 40000 }, T0)
  }

  assert.deepEqual(room.snapshot().prompt, { deviceId: 'dev-0', nickname: '邻居0' })
  for (let index = 0; index < MAX_PROMPTS; index += 1) {
    room.admit('dev-' + index)
  }
  assert.equal(room.snapshot().prompt, null)

  // 队列空出来以后，之前没排上的两位会在下一次广播时补上。
  room.observeBeacon({ deviceId: 'dev-' + MAX_PROMPTS, nickname: '排队者', port: 40000 }, T0 + 5000)
  assert.deepEqual(room.snapshot().prompt, {
    deviceId: 'dev-' + MAX_PROMPTS,
    nickname: '排队者'
  })
})

test('“稍后再说”让队列前进，并在十分钟内不再问同一位', () => {
  let now = T0
  const room = createRoom({ clock: () => now })
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, now)
  room.observeBeacon({ deviceId: 'neighbor-b', nickname: '乙', port: 40002 }, now)

  assert.equal(room.dismissPrompt('neighbor-b').ok, false)
  const moved = room.dismissPrompt('neighbor-a')
  assert.equal(moved.ok, true)
  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-b', nickname: '乙' })
  assert.equal(room.snapshot().neighbors[0].status, 'pending')
  assert.equal(room.snapshot().neighbors[1].status, 'pending')
  assert.equal(room.mayTalkTo('neighbor-a'), false)

  // 处理完别人后，被“稍后再说”的那位不会立刻回来。
  room.admit('neighbor-b')
  assert.equal(room.snapshot().prompt, null)
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, now + 5000)
  assert.equal(room.snapshot().prompt, null)

  // 十分钟后再次广播，重新询问。
  now += PROMPT_SNOOZE_MS
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, now)
  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-a', nickname: '甲' })
})

test('只剩一位时“稍后再说”先收起；它离开后重新出现会立刻再问', () => {
  let now = T0
  const room = createRoom({ clock: () => now })
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, now)
  const result = room.dismissPrompt('neighbor-a')
  assert.equal(result.ok, true)
  assert.equal(room.snapshot().prompt, null)

  // 还在线时不会因为下一包广播又弹出来。
  now += 5000
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, now)
  assert.equal(room.snapshot().prompt, null)

  // 离开 30 秒后再回来：清掉 snooze，重新询问。
  now += NEIGHBOR_TTL_MS
  room.tick(now)
  assert.deepEqual(room.snapshot().neighbors, [])
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, now)
  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-a', nickname: '甲' })
})

test('“稍后再说”的邻居不会挡住后来的新邻居', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  room.observeBeacon({ deviceId: 'neighbor-b', nickname: '乙', port: 40002 }, T0)

  room.dismissPrompt('neighbor-a')
  room.observeBeacon({ deviceId: 'neighbor-c', nickname: '丙', port: 40003 }, T0)
  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-b', nickname: '乙' })

  room.admit('neighbor-b')
  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-c', nickname: '丙' })
  assert.equal(room.mayTalkTo('neighbor-a'), false)
})

test('邻居 30 秒没消息时，排队的提示也一起消失；回来重新询问', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-a', nickname: '甲' })

  room.tick(T0 + NEIGHBOR_TTL_MS)
  assert.equal(room.snapshot().prompt, null)

  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0 + 40000)
  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-a', nickname: '甲' })
})

test('载入名单后：放行/拒绝的邻居直接是终态，不再问', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.setTrust({
    allowed: { 'neighbor-a': { nickname: '甲', allowedAt: T0 } },
    denied: { 'neighbor-b': { nickname: '乙', deniedAt: T0 } }
  })

  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  room.observeBeacon({ deviceId: 'neighbor-b', nickname: '乙', port: 40002 }, T0)
  room.observeBeacon({ deviceId: 'neighbor-c', nickname: '丙', port: 40003 }, T0)

  const neighbors = room.snapshot().neighbors
  assert.deepEqual(neighbors.map((neighbor) => [neighbor.deviceId, neighbor.status]), [
    ['neighbor-a', 'allowed'],
    ['neighbor-b', 'denied'],
    ['neighbor-c', 'pending']
  ])
  assert.deepEqual(room.snapshot().prompt, { deviceId: 'neighbor-c', nickname: '丙' })
  assert.equal(room.mayTalkTo('neighbor-a'), true)
  assert.equal(room.mayTalkTo('neighbor-b'), false)
  assert.equal(room.mayTalkTo('neighbor-c'), false)
})

test('名单在邻居出现之后载入，也会把状态对齐', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  room.observeBeacon({ deviceId: 'neighbor-b', nickname: '乙', port: 40002 }, T0)

  room.setTrust({
    allowed: { 'neighbor-a': { nickname: '甲' } },
    denied: { 'neighbor-b': { nickname: '乙' } }
  })

  assert.equal(room.snapshot().neighbors[0].status, 'allowed')
  assert.equal(room.snapshot().neighbors[1].status, 'denied')
  assert.equal(room.snapshot().prompt, null)
})

test('mayTalkTo 只对 allowed 的邻居为真', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.setTrust({
    allowed: {
      'neighbor-a': { nickname: '甲' },
      'me-1': { nickname: '我' }
    },
    denied: { 'neighbor-b': { nickname: '乙' } }
  })

  assert.equal(room.mayTalkTo('neighbor-a'), true)
  assert.equal(room.mayTalkTo('neighbor-b'), false)
  assert.equal(room.mayTalkTo('me-1'), false)
  assert.equal(room.mayTalkTo('unknown'), false)
  assert.equal(room.mayTalkTo(''), false)
  assert.equal(room.mayTalkTo('   '), false)
  assert.equal(room.mayTalkTo(null), false)
  assert.equal(room.mayTalkTo(42), false)
  assert.equal(room.mayTalkTo({ deviceId: 'neighbor-a' }), false)

  // 拒绝会覆盖之前的放行，门控立即关闭。
  room.setTrust({ allowed: { 'neighbor-a': { nickname: '甲' } } })
  room.reject('neighbor-a')
  assert.equal(room.mayTalkTo('neighbor-a'), false)
})

test('对未知 deviceId 的接受/拒绝明确失败，不留下半截状态', () => {
  const room = roomAt()
  assert.deepEqual(room.admit('ghost'), { ok: false, error: 'unknown-neighbor' })
  assert.deepEqual(room.reject('ghost'), { ok: false, error: 'unknown-neighbor' })
  assert.deepEqual(room.admit(''), { ok: false, error: 'bad-device-id' })
  assert.deepEqual(room.reject(42), { ok: false, error: 'bad-device-id' })
  assert.deepEqual(room.dismissPrompt('ghost'), { ok: false, error: 'not-prompt' })
  assert.equal(room.mayTalkTo('ghost'), false)
})

test('放行后的心跳创建访客；未放行、自己和未知来源的心跳都不创建', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)

  assert.equal(room.observeHeartbeat({ deviceId: 'neighbor-a', anim: '写代码' }, T0 + 100), false)
  assert.deepEqual(room.snapshot().guests, [])

  assert.equal(room.admit('neighbor-a').ok, true)
  assert.equal(room.observeHeartbeat({ deviceId: 'neighbor-a', anim: '写代码' }, T0 + 2000), true)
  assert.deepEqual(room.snapshot().guests, [{
    deviceId: 'neighbor-a',
    nickname: '甲',
    anim: '写代码',
    since: T0 + 2000,
    expiresAt: T0 + 2000 + GUEST_TTL_MS
  }])
  assert.deepEqual(Object.keys(room.snapshot().guests[0]), [
    'deviceId', 'nickname', 'anim', 'since', 'expiresAt'
  ])

  room.setTrust({
    allowed: { 'neighbor-a': { nickname: '甲' }, 'me-1': { nickname: '我' } }
  })
  assert.equal(room.observeHeartbeat({ deviceId: 'me-1', anim: '写代码' }, T0 + 3000), false)
  assert.equal(room.observeHeartbeat({ deviceId: 'ghost', anim: '写代码' }, T0 + 3000), false)
  assert.equal(room.observeHeartbeat(null, T0 + 3000), false)
  assert.equal(room.observeHeartbeat({ deviceId: '', anim: '写代码' }, T0 + 3000), false)

  // 非法动画名降级成 null，不清掉访客。
  assert.equal(room.observeHeartbeat({ deviceId: 'neighbor-a', anim: '../secret' }, T0 + 4000), true)
  assert.equal(room.snapshot().guests.length, 1)
  assert.equal(room.snapshot().guests[0].anim, null)
  assert.equal(room.snapshot().guests[0].since, T0 + 2000)
})

test('心跳刷新访客的动作与昵称，但 since 不变；邻居灯也跟着续命', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  room.admit('neighbor-a')

  room.observeHeartbeat({ deviceId: 'neighbor-a', anim: '写代码' }, T0 + 2000)
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲改名', port: 40001 }, T0 + 3000)
  room.observeHeartbeat({ deviceId: 'neighbor-a', anim: '东张西望' }, T0 + 4000)

  assert.deepEqual(room.snapshot().guests, [{
    deviceId: 'neighbor-a',
    nickname: '甲改名',
    anim: '东张西望',
    since: T0 + 2000,
    expiresAt: T0 + 4000 + GUEST_TTL_MS
  }])
  assert.equal(room.snapshot().neighbors[0].lastSeen, T0 + 4000)
})

test('访客 30 秒没有心跳就消失；邻居灯按自己的 lastSeen 独立到期', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  room.admit('neighbor-a')
  room.observeHeartbeat({ deviceId: 'neighbor-a', anim: '写代码' }, T0 + 20000)
  // 之后只有广播、没有心跳：灯续命到 T0+55000，访客只到 T0+50000。
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0 + 25000)

  assert.equal(room.tick(T0 + 20000 + GUEST_TTL_MS - 1), 0)
  assert.equal(room.snapshot().guests.length, 1)

  assert.equal(room.tick(T0 + 20000 + GUEST_TTL_MS), 0)
  assert.deepEqual(room.snapshot().guests, [])
  assert.equal(room.snapshot().neighbors.length, 1)

  assert.equal(room.tick(T0 + 25000 + NEIGHBOR_TTL_MS), 1)
  assert.deepEqual(room.snapshot().neighbors, [])
})

test('访客快照带 expiresAt：最后一次心跳 + 30 秒，刷新后顺延而 since 不变', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  room.admit('neighbor-a')

  room.observeHeartbeat({ deviceId: 'neighbor-a', anim: '写代码' }, T0 + 2000)
  assert.equal(room.snapshot().guests[0].since, T0 + 2000)
  assert.equal(room.snapshot().guests[0].expiresAt, T0 + 2000 + GUEST_TTL_MS)

  room.observeHeartbeat({ deviceId: 'neighbor-a', anim: '东张西望' }, T0 + 12000)
  assert.equal(room.snapshot().guests[0].since, T0 + 2000)
  assert.equal(room.snapshot().guests[0].expiresAt, T0 + 12000 + GUEST_TTL_MS)

  // Host 仍在 TTL 到点时移除；expiresAt 只是给客户端做最后 2.5 秒淡出。
  room.tick(T0 + 12000 + GUEST_TTL_MS - 1)
  assert.equal(room.snapshot().guests.length, 1)
  room.tick(T0 + 12000 + GUEST_TTL_MS)
  assert.deepEqual(room.snapshot().guests, [])
})

test('访客表最多 8 位，满了挤掉最久没心跳的那位', () => {
  const room = roomAt()
  for (let index = 0; index < MAX_GUESTS; index += 1) {
    room.observeBeacon({ deviceId: 'dev-' + index, nickname: '邻居' + index, port: 40000 }, T0)
    room.admit('dev-' + index)
    room.observeHeartbeat({ deviceId: 'dev-' + index, anim: null }, T0 + 1000 + index)
  }
  assert.equal(room.snapshot().guests.length, MAX_GUESTS)

  // 刷新 dev-0，让 dev-1 成为最久没心跳的那位。
  room.observeHeartbeat({ deviceId: 'dev-0', anim: '写代码' }, T0 + 2000)
  room.observeBeacon({ deviceId: 'dev-new', nickname: '新来的', port: 40000 }, T0 + 2000)
  room.admit('dev-new')
  room.observeHeartbeat({ deviceId: 'dev-new', anim: null }, T0 + 2001)

  const ids = room.snapshot().guests.map((guest) => guest.deviceId)
  assert.equal(ids.length, MAX_GUESTS)
  assert.equal(ids.includes('dev-new'), true)
  assert.equal(ids.includes('dev-0'), true)
  assert.equal(ids.includes('dev-1'), false)
})

test('拒绝立即清掉访客；放行名单收紧时也立即清掉', () => {
  const room = roomAt()
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  room.admit('neighbor-a')
  room.observeHeartbeat({ deviceId: 'neighbor-a', anim: '写代码' }, T0 + 2000)
  assert.equal(room.snapshot().guests.length, 1)

  assert.equal(room.reject('neighbor-a').status, 'denied')
  assert.deepEqual(room.snapshot().guests, [])
  assert.equal(room.mayTalkTo('neighbor-a'), false)

  // 重新放行后心跳又能创建；名单被手改收紧时立即离开，不等 TTL。
  room.admit('neighbor-a')
  room.observeHeartbeat({ deviceId: 'neighbor-a', anim: '写代码' }, T0 + 4000)
  assert.equal(room.snapshot().guests.length, 1)
  room.setTrust({ allowed: {}, denied: {} })
  assert.deepEqual(room.snapshot().guests, [])
  assert.equal(room.snapshot().neighbors[0].status, 'pending')
})

test('放行名单里有、但还没收到广播的邻居，其心跳仍能创建访客', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.setTrust({ allowed: { 'neighbor-x': { nickname: '名单里的邻居' } } })

  assert.equal(room.observeHeartbeat({ deviceId: 'neighbor-x', anim: '写代码' }, T0), true)
  assert.deepEqual(room.snapshot().guests, [{
    deviceId: 'neighbor-x',
    nickname: '名单里的邻居',
    anim: '写代码',
    since: T0,
    expiresAt: T0 + GUEST_TTL_MS
  }])
  // 没收到广播也可以从心跳认识它：心跳本身证明它在线，也证明它放行了我。
  assert.deepEqual(room.snapshot().neighbors, [{
    deviceId: 'neighbor-x',
    nickname: '名单里的邻居',
    status: 'allowed',
    lastSeen: T0,
    port: null,
    heartbeatAt: T0
  }])
  assert.deepEqual(room.heartbeatTargets(), ['neighbor-x'])
})

test('heartbeatTargets 只列出放行名单；pending/denied/自己都不在其中', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.setTrust({
    allowed: { 'allowed-b': { nickname: '乙' }, 'me-1': { nickname: '我' } },
    denied: { 'denied-c': { nickname: '丙' } }
  })
  room.observeBeacon({ deviceId: 'pending-a', nickname: '甲', port: 40001 }, T0)
  room.observeBeacon({ deviceId: 'allowed-b', nickname: '乙', port: 40002 }, T0)
  room.observeBeacon({ deviceId: 'denied-c', nickname: '丙', port: 40003 }, T0)

  assert.deepEqual(room.heartbeatTargets(), ['allowed-b'])
  assert.equal(room.mayTalkTo('pending-a'), false)
  assert.equal(room.mayTalkTo('denied-c'), false)
})

test('心跳只影响访客表：不改本地影子、名字、信任或邻居昵称', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  room.setSelfPet({ name: '蓝毛小女仆', anim: '写代码' })
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  room.admit('neighbor-a')
  const before = room.snapshot().self

  room.observeHeartbeat({
    deviceId: 'neighbor-a',
    anim: '东张西望',
    nickname: '伪造的名字',
    name: '伪造的名字',
    self: { nickname: '被篡改' },
    path: '/etc/passwd',
    command: 'rm -rf /',
    allowed: true,
    port: 1,
    coordinates: { x: 1, y: 2 }
  }, T0 + 2000)

  const snap = room.snapshot()
  assert.deepEqual(snap.self, before)
  assert.equal(snap.guests[0].nickname, '甲')
  assert.equal(snap.guests[0].anim, '东张西望')
  assert.equal(room.mayTalkTo('neighbor-a'), true)
})

test('visitBlockedReason 跟 visitTargets 用同一个判定：没人放行 / 都离线 / 有目标', () => {
  const room = roomAt()
  room.setIdentity({ deviceId: 'me-1', nickname: '我' })
  // 没有邻居：没人放行我。
  assert.equal(room.snapshot().visitBlockedReason, 'no-admitted')
  assert.equal(room.snapshot().visitTargets.length, 0)

  // 放行一位还没心跳过的邻居：我放行了它，但它没证明放行我 → 目标表还是空的。
  room.observeBeacon({ deviceId: 'neighbor-a', nickname: '甲', port: 40001 }, T0)
  room.admit('neighbor-a')
  const snap = room.snapshot()
  assert.deepEqual(snap.visitTargets, [])
  assert.equal(snap.visitBlockedReason, 'no-online')
  // 按钮的理由（A6）和失败 notice 是同一句话。
  assert.equal(room.noVisitTarget().notice, visitReasonText('no-online'))

  // 对方心跳到达：既可出门，也没有“为什么不能”的理由了。
  room.observeHeartbeat({ deviceId: 'neighbor-a', anim: null }, T0 + 1000)
  assert.equal(room.snapshot().visitTargets.length, 1)
  assert.equal(room.snapshot().visitBlockedReason, null)

  // 没有放行名单（空名单）时回到 no-admitted。
  const bare = roomAt()
  bare.setIdentity({ deviceId: 'me-2', nickname: '我' })
  assert.equal(bare.snapshot().visitBlockedReason, 'no-admitted')
})

test('场景放不下访客时提醒一次：不静默丢宠物，拥挤解除后可以再提醒', () => {
  const room = roomAt()
  assert.equal(room.snapshot().notices.length, 0)

  room.noteSceneOverflow(3, T0)
  let notices = room.snapshot().notices
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /3 位/)
  assert.match(notices[0].text, /访客/)

  // 同一次拥挤不重复刷屏。
  room.noteSceneOverflow(3, T0 + 500)
  assert.equal(room.snapshot().notices.length, 1)

  // 拥挤解除（dropped=0）之后，下一次拥挤可以再提醒。
  room.noteSceneOverflow(0, T0 + 1000)
  room.noteSceneOverflow(2, T0 + 1500)
  notices = room.snapshot().notices
  assert.equal(notices.length, 2)
  assert.match(notices[0].text, /2 位/)

  // 坏输入不写 notice、也不抛。
  room.noteSceneOverflow('nope', T0 + 2000)
  room.noteSceneOverflow(-1, T0 + 2000)
  room.noteSceneOverflow(null, T0 + 2000)
  assert.doesNotThrow(() => room.noteSceneOverflow(undefined, T0))
})

test('self-state：推来的动作/语义/气泡进入快照，30 秒后过期', () => {
  let now = T0
  const room = createRoom({ clock: () => now })
  room.setSelfPet({ name: '小蓝', anim: '待机呼吸休闲' })

  assert.equal(room.setSelfState({
    action: '写代码',
    semantic: 'working',
    say: { text: '在写代码', until: T0 + 5000 }
  }), true)

  assert.deepEqual(room.snapshot().self.pet, {
    name: '小蓝',
    anim: '待机呼吸休闲',
    action: '写代码',
    semantic: 'working',
    say: { text: '在写代码', until: T0 + 5000 }
  })

  now = T0 + 30001
  assert.deepEqual(room.snapshot().self.pet, { name: '小蓝', anim: '待机呼吸休闲' })
})

test('self-state：全非法返回 false，不覆盖已有快照', () => {
  const room = roomAt()
  room.setSelfPet({ name: '小蓝', anim: null })
  assert.equal(room.setSelfState({ action: '../x', semantic: 'nope', say: { text: '', until: T0 + 1 } }), false)
  assert.deepEqual(room.snapshot().self.pet, { name: '小蓝', anim: null })
})

// ---------------------------------------------------------------------------
// ticket 23：串门捎来的字条
// ---------------------------------------------------------------------------

function giftRoom (deviceId, nickname = '阿蟹') {
  const room = roomAt()
  room.setIdentity({ deviceId: randomUUID(), nickname: '我' })
  room.setTrust({ allowed: { [deviceId]: nickname } })
  return room
}

function giftVisit (deviceId, overrides = {}) {
  return {
    deviceId,
    visitId: randomUUID(),
    nickname: '阿蟹',
    anim: null,
    ...overrides
  }
}

test('访客身上的礼物：state=received 前是 pending，正文按协议清洗、换行保留', () => {
  const id = randomUUID()
  const room = giftRoom(id)
  const giftId = randomUUID()
  const result = room.observeVisitRequest(giftVisit(id, {
    gift: { id: giftId, kind: 'text', text: '  第一行\n第二行\u202e  ' }
  }), T0)
  assert.equal(result.reply, 'ack')
  const visitor = room.snapshot().visitors[0]
  assert.deepEqual(visitor.gift, {
    id: giftId,
    kind: 'text',
    text: '第一行\n第二行',
    status: 'pending'
  })

  // 写盘成功之后由 service 回报 received；状态进快照，其余字段一个不动。
  assert.equal(room.markGiftStatus(id, giftId, 'received'), true)
  assert.equal(room.snapshot().visitors[0].gift.status, 'received')

  // 幂等重试：同一个 giftId 不把状态打回 pending，也不重置 since。
  const since = room.snapshot().visitors[0].since
  room.observeVisitRequest(giftVisit(id, { gift: { id: giftId, kind: 'text', text: '第一行\n第二行' } }), T0 + 5000)
  const again = room.snapshot().visitors[0]
  assert.equal(again.gift.status, 'received')
  assert.equal(again.since, since)
})

test('坏礼物不建卡片，但访客照常进门；换一件新礼物才换卡', () => {
  const id = randomUUID()
  const room = giftRoom(id)
  const result = room.observeVisitRequest(giftVisit(id, {
    gift: { id: 'not-a-uuid', kind: 'text', text: 'x' }
  }), T0)
  assert.equal(result.reply, 'ack')
  assert.equal(room.snapshot().visitors.length, 1)
  assert.equal('gift' in room.snapshot().visitors[0], false)

  const first = randomUUID()
  room.observeVisitRequest(giftVisit(id, { gift: { id: first, kind: 'text', text: '旧的' } }), T0 + 1000)
  assert.equal(room.snapshot().visitors[0].gift.id, first)

  const second = randomUUID()
  room.observeVisitRequest(giftVisit(id, { gift: { id: second, kind: 'text', text: '新的' } }), T0 + 2000)
  const gift = room.snapshot().visitors[0].gift
  assert.equal(gift.id, second)
  assert.equal(gift.text, '新的')
  assert.equal(gift.status, 'pending')
})

test('markGiftStatus 只认这位访客身上的那一件；未知状态/坏 id 一律 false', () => {
  const id = randomUUID()
  const room = giftRoom(id)
  const giftId = randomUUID()
  room.observeVisitRequest(giftVisit(id, { gift: { id: giftId, kind: 'text', text: 'x' } }), T0)

  assert.equal(room.markGiftStatus(id, randomUUID(), 'received'), false)
  assert.equal(room.markGiftStatus(randomUUID(), giftId, 'received'), false)
  assert.equal(room.markGiftStatus(id, giftId, 'lost'), false)
  assert.equal(room.markGiftStatus(id, giftId, 'received'), true)
  assert.equal(room.markGiftStatus(id, 'gift-1', 'failed'), false)
})

test('扔掉之后卡片立刻消失，且重试报文也不会再长回来', () => {
  const id = randomUUID()
  const room = giftRoom(id)
  const giftId = randomUUID()
  room.observeVisitRequest(giftVisit(id, { gift: { id: giftId, kind: 'text', text: 'x' } }), T0)
  assert.equal(room.discardGift(id, giftId), true)
  assert.equal('gift' in room.snapshot().visitors[0], false)
  assert.equal(room.markGiftStatus(id, giftId, 'received'), false)

  // 对方没收到 ack 又重发同一条请求：礼物已经扔掉，卡片不许复活。
  room.observeVisitRequest(giftVisit(id, { gift: { id: giftId, kind: 'text', text: 'x' } }), T0 + 3000)
  assert.equal('gift' in room.snapshot().visitors[0], false)

  // 换一件新的仍然可以收：黑名单只针对扔掉的那一个 id。
  const other = randomUUID()
  room.observeVisitRequest(giftVisit(id, { gift: { id: other, kind: 'text', text: 'y' } }), T0 + 4000)
  assert.equal(room.snapshot().visitors[0].gift.id, other)
})

test('访客回家/送客/失联时礼物一起消失：卡片跟着访客，不需要第二套生命周期', () => {
  const id = randomUUID()
  const room = giftRoom(id, '阿蟹')
  const giftId = randomUUID()
  room.observeVisitRequest(giftVisit(id, { gift: { id: giftId, kind: 'text', text: 'x' } }), T0)
  assert.equal(room.snapshot().visitors[0].gift.id, giftId)
  room.endInboundVisit(id, T0 + 1000)
  assert.deepEqual(room.snapshot().visitors, [])

  // 再来一次，靠失联清场：礼物同样不留在快照里。
  const secondGift = randomUUID()
  room.observeVisitRequest(giftVisit(id, { gift: { id: secondGift, kind: 'text', text: 'y' } }), T0 + 2000)
  room.tick(T0 + 2000 + 2 * 60 * 1000 + 1)
  assert.deepEqual(room.snapshot().visitors, [])
})

test('noteGiftDropped：字条没带上时留一句人话，不影响任何串门状态', () => {
  const room = roomAt()
  const notice = room.noteGiftDropped(T0)
  assert.match(notice.text, /字条太长了，这次没带上/)
  assert.equal(room.snapshot().notices[0].text, notice.text)
  assert.deepEqual(room.snapshot().visitors, [])
})

// ---------------------------------------------------------------------------
// ticket 25：文件礼物挂在访客上（name/size/status/reason）
// ---------------------------------------------------------------------------

test('文件礼物：访客身上只留 name/size，走 pending → receiving → received；理由只认词表', () => {
  const id = randomUUID()
  const room = giftRoom(id)
  const giftId = randomUUID()
  const sha = 'sha256:' + 'a'.repeat(64)
  room.observeVisitRequest(giftVisit(id, {
    gift: { id: giftId, kind: 'file', name: '../报价单.pdf', size: 23194, sha256: sha }
  }), T0)

  const gift = room.snapshot().visitors[0].gift
  assert.deepEqual(gift, {
    id: giftId,
    kind: 'file',
    name: '报价单.pdf',
    size: 23194,
    status: 'pending'
  })
  // 路径与 sha256 都不进快照：渲染端不需要，也不该拿到。
  assert.equal('path' in gift, false)
  assert.equal('sha256' in gift, false)

  assert.equal(room.markGiftStatus(id, giftId, 'receiving'), true)
  assert.equal(room.snapshot().visitors[0].gift.status, 'receiving')
  // failed/refused 才记理由，且只认固定词表；未知理由被丢掉。
  assert.equal(room.markGiftStatus(id, giftId, 'failed', 'checksum'), true)
  assert.equal(room.snapshot().visitors[0].gift.reason, 'checksum')
  assert.equal(room.markGiftStatus(id, giftId, 'failed', 'made-up'), true)
  assert.equal('reason' in room.snapshot().visitors[0].gift, false)
  assert.equal(room.markGiftStatus(id, giftId, 'received'), true)
  assert.equal('reason' in room.snapshot().visitors[0].gift, false)
})
