import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_NEIGHBORS, NEIGHBOR_TTL_MS } from '../src/protocol.js'
import { MAX_PROMPTS, PROMPT_SNOOZE_MS, createRoom } from '../src/room.js'

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
