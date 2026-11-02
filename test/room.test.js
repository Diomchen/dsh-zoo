import assert from 'node:assert/strict'
import test from 'node:test'

import { GUEST_TTL_MS, MAX_NEIGHBORS, NEIGHBOR_TTL_MS } from '../src/protocol.js'
import { MAX_GUESTS, MAX_PROMPTS, PROMPT_SNOOZE_MS, createRoom } from '../src/room.js'

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
