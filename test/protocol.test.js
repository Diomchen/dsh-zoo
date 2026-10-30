import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  BEACON_INTERVAL_MS,
  DEFAULT_PORT,
  GUEST_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_PACKET_BYTES,
  PACKET_TYPES,
  PROTOCOL_VERSION,
  createRateLimiter,
  encodeHeartbeat,
  encodePacket,
  isSafeAnimationName,
  normalizeNickname,
  parsePacket,
  resolvePort
} from '../src/protocol.js'

function validPacket (overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: 'beacon',
    deviceId: randomUUID(),
    nickname: '隔壁的小猫',
    port: 45872,
    ...overrides
  }
}

function encodeJson (value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

test('编码只写白名单字段，解析后形状完全一致', () => {
  const deviceId = randomUUID()
  const data = encodePacket({ type: 'beacon', deviceId, nickname: '  隔壁  ', port: 45872 })
  const raw = JSON.parse(data.toString('utf8'))

  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'nickname', 'port'])
  assert.deepEqual(parsePacket(data), {
    ok: true,
    packet: {
      v: PROTOCOL_VERSION,
      type: 'beacon',
      deviceId,
      nickname: '隔壁',
      port: 45872
    }
  })
})

test('未知字段被丢弃，不会进入解析结果', () => {
  const raw = validPacket({ path: '/tmp/x', command: 'rm -rf /', anim: '写代码', coordinates: [1, 2] })
  const parsed = parsePacket(encodeJson(raw))
  assert.equal(parsed.ok, true)
  assert.deepEqual(Object.keys(parsed.packet), ['v', 'type', 'deviceId', 'nickname', 'port'])
  assert.equal(parsed.packet.path, undefined)
  assert.equal(parsed.packet.nickname, raw.nickname)
})

test('心跳只写 v/type/deviceId/anim，带动作名或 null', () => {
  const deviceId = randomUUID()
  const data = encodePacket({
    type: 'heartbeat',
    deviceId: deviceId.toUpperCase(),
    anim: ' 写代码 ',
    // 下面这些都不该出现在心跳里：编码器按类型只写四个字段。
    nickname: '不该出现',
    port: 1234,
    x: 1,
    y: 2,
    coordinates: { x: 3, y: 4 }
  })
  const raw = JSON.parse(data.toString('utf8'))
  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'anim'])
  assert.deepEqual(raw, {
    v: PROTOCOL_VERSION,
    type: 'heartbeat',
    deviceId: deviceId.toLowerCase(),
    anim: '写代码'
  })
  assert.deepEqual(parsePacket(data), {
    ok: true,
    packet: {
      v: PROTOCOL_VERSION,
      type: 'heartbeat',
      deviceId: deviceId.toLowerCase(),
      anim: '写代码'
    }
  })

  const idle = encodeHeartbeat({ deviceId })
  assert.deepEqual(JSON.parse(idle.toString('utf8')), {
    v: PROTOCOL_VERSION,
    type: 'heartbeat',
    deviceId,
    anim: null
  })
  assert.equal(parsePacket(idle).packet.anim, null)

  // 本机动画名坏掉时降级成 null，而不是把心跳整包丢掉。
  const brokenAnim = encodeHeartbeat({ deviceId, anim: '../secret' })
  assert.equal(JSON.parse(brokenAnim.toString('utf8')).anim, null)
})

test('心跳的 anim 必须是 null 或安全动画名；缺失、路径、控制字符都拒绝', () => {
  const base = { v: PROTOCOL_VERSION, type: 'heartbeat', deviceId: randomUUID() }
  for (const anim of [42, '', '   ', '../secret', 'a/b', 'a\\b', '..', 'x'.repeat(65), undefined]) {
    assert.equal(parsePacket(encodeJson({ ...base, anim })).reason, 'anim', String(anim))
  }
  assert.equal(parsePacket(encodeJson({ ...base, anim: '东张西望' })).ok, true)
  assert.equal(parsePacket(encodeJson({ ...base, anim: null })).packet.anim, null)
})

test('心跳里的昵称、端口、坐标即使出现也不会被读取', () => {
  const deviceId = randomUUID()
  const parsed = parsePacket(encodeJson({
    v: PROTOCOL_VERSION,
    type: 'heartbeat',
    deviceId,
    anim: '写代码',
    nickname: '伪造的名字',
    port: 1,
    x: 10,
    y: 20
  }))
  assert.deepEqual(parsed.packet, {
    v: PROTOCOL_VERSION,
    type: 'heartbeat',
    deviceId,
    anim: '写代码'
  })
  assert.deepEqual(Object.keys(parsed.packet), ['v', 'type', 'deviceId', 'anim'])
})

test('心跳同样接受版本、deviceId、4 KiB 的校验', () => {
  const base = { v: PROTOCOL_VERSION, type: 'heartbeat', deviceId: randomUUID(), anim: null }
  assert.equal(parsePacket(encodeJson({ ...base, v: 2 })).reason, 'version')
  assert.equal(parsePacket(encodeJson({ ...base, type: 'beacon' })).reason, 'nickname')
  assert.equal(parsePacket(encodeJson({ ...base, deviceId: 'not-a-uuid' })).reason, 'device-id')
  assert.equal(parsePacket(Buffer.alloc(MAX_PACKET_BYTES + 1, 0x61)).reason, 'too-large')
})

test('任何报文都不含坐标字段', () => {
  const deviceId = randomUUID()
  const packets = [
    encodePacket({ type: 'beacon', deviceId, nickname: '甲', port: 45871 }),
    encodePacket({ type: 'beacon-ack', deviceId, nickname: '甲', port: 45871 }),
    encodeHeartbeat({ deviceId, anim: '写代码' }),
    encodeHeartbeat({ deviceId, anim: null })
  ]
  const coordinateKeys = ['x', 'y', 'pos', 'position', 'coordinates', 'coord', 'lat', 'lng']

  for (const data of packets) {
    const text = data.toString('utf8')
    const raw = JSON.parse(text)
    for (const key of coordinateKeys) {
      assert.equal(Object.prototype.hasOwnProperty.call(raw, key), false, key)
    }
    // 连字段名都不该出现在线上报文里。
    assert.doesNotMatch(text, /"(x|y|pos|position|coordinates?|coord|lat|lng)"\s*:/)
  }

  // 敌意报文里的坐标在解析时被丢弃，不会流进 room / 快照。
  for (const type of ['beacon', 'beacon-ack', 'heartbeat']) {
    const raw = type === 'heartbeat'
      ? { v: PROTOCOL_VERSION, type, deviceId, anim: '写代码', x: 1, y: 2, coordinates: { x: 3, y: 4 } }
      : { v: PROTOCOL_VERSION, type, deviceId, nickname: '甲', port: 45871, x: 1, y: 2, coordinates: { x: 3, y: 4 } }
    const parsed = parsePacket(encodeJson(raw))
    assert.equal(parsed.ok, true)
    assert.deepEqual(
      Object.keys(parsed.packet),
      type === 'heartbeat' ? ['v', 'type', 'deviceId', 'anim'] : ['v', 'type', 'deviceId', 'nickname', 'port']
    )
  }
})

test('超过 4 KiB 的报文直接丢，不解析', () => {
  assert.deepEqual(parsePacket(Buffer.alloc(MAX_PACKET_BYTES + 1, 0x61)), {
    ok: false,
    reason: 'too-large'
  })
  assert.deepEqual(parsePacket('a'.repeat(MAX_PACKET_BYTES + 1)), {
    ok: false,
    reason: 'too-large'
  })
})

test('恰好 4 KiB 但内容不是 JSON 的报文只按坏 JSON 丢', () => {
  const data = Buffer.alloc(MAX_PACKET_BYTES, 0x61)
  assert.deepEqual(parsePacket(data), { ok: false, reason: 'bad-json' })
})

test('版本、类型、形状不匹配都忽略', () => {
  assert.equal(parsePacket(encodeJson(validPacket({ v: 2 }))).reason, 'version')
  assert.equal(parsePacket(encodeJson(validPacket({ v: '1' }))).reason, 'version')
  assert.equal(parsePacket(encodeJson(validPacket({ type: 'visit' }))).reason, 'type')
  assert.equal(parsePacket(encodeJson([])).reason, 'bad-shape')
  assert.equal(parsePacket(encodeJson(null)).reason, 'bad-shape')
  assert.equal(parsePacket(Buffer.from('{oops', 'utf8')).reason, 'bad-json')
  assert.equal(parsePacket(Buffer.from([0xff, 0xfe])).reason, 'bad-encoding')
})

test('deviceId 只接受 UUID 形状；额外空格与超长都拒绝', () => {
  assert.equal(parsePacket(encodeJson(validPacket({ deviceId: 'not-a-uuid' }))).reason, 'device-id')
  assert.equal(parsePacket(encodeJson(validPacket({ deviceId: randomUUID() + 'x' }))).reason, 'device-id')
  assert.equal(parsePacket(encodeJson(validPacket({ deviceId: 42 }))).reason, 'device-id')
  assert.equal(parsePacket(encodeJson(validPacket({ deviceId: randomUUID().toUpperCase() }))).ok, true)
})

test('昵称清洗、按码点截断到 32，空昵称拒绝', () => {
  const long = encodeJson(validPacket({ nickname: '喵'.repeat(40) }))
  const parsed = parsePacket(long)
  assert.equal(parsed.ok, true)
  assert.equal(Array.from(parsed.packet.nickname).length, 32)

  assert.equal(normalizeNickname('  A\u0000\nB  '), 'A B')
  assert.equal(normalizeNickname('\u0000\u0007'), null)
  assert.equal(normalizeNickname('\ud800'), null)
  assert.equal(parsePacket(encodeJson(validPacket({ nickname: 42 }))).reason, 'nickname')
  assert.equal(parsePacket(encodeJson(validPacket({ nickname: '   ' }))).reason, 'nickname')
})

test('端口必须是 1..65535 的整数', () => {
  for (const port of [0, -1, 65536, '45872', 3.14, null, undefined]) {
    assert.equal(parsePacket(encodeJson(validPacket({ port }))).reason, 'port', String(port))
  }
})

test('动画名只允许安全文件名，不能带路径或控制字符', () => {
  assert.equal(isSafeAnimationName('东张西望'), true)
  assert.equal(isSafeAnimationName('原地漂浮踏步'), true)
  assert.equal(isSafeAnimationName('../secret'), false)
  assert.equal(isSafeAnimationName('a/b'), false)
  assert.equal(isSafeAnimationName('a\\b'), false)
  assert.equal(isSafeAnimationName('..'), false)
  assert.equal(isSafeAnimationName(''), false)
  assert.equal(isSafeAnimationName('x'.repeat(65)), false)
  assert.equal(isSafeAnimationName('a\u0000b'), false)
  assert.equal(isSafeAnimationName('\ud800'), false)
  assert.equal(isSafeAnimationName(42), false)
})

test('环境变量只在合法时覆盖默认端口', () => {
  assert.equal(resolvePort({}), DEFAULT_PORT)
  assert.equal(resolvePort({ LOCAL_PET_PORT: '' }), DEFAULT_PORT)
  assert.equal(resolvePort({ LOCAL_PET_PORT: '50001' }), 50001)
  assert.equal(resolvePort({ LOCAL_PET_PORT: '0' }), DEFAULT_PORT)
  assert.equal(resolvePort({ LOCAL_PET_PORT: '70000' }), DEFAULT_PORT)
  assert.equal(resolvePort({ LOCAL_PET_PORT: 'abc' }), DEFAULT_PORT)
})

test('默认的发现参数是 5 秒 / 45871；心跳 2 秒、访客 30 秒', () => {
  assert.equal(BEACON_INTERVAL_MS, 5000)
  assert.equal(DEFAULT_PORT, 45871)
  assert.equal(HEARTBEAT_INTERVAL_MS, 2000)
  assert.equal(GUEST_TTL_MS, 30000)
  assert.deepEqual(PACKET_TYPES, ['beacon', 'beacon-ack', 'heartbeat'])
})

test('每来源限速：窗口内超限丢弃，窗口后恢复', () => {
  let now = 0
  const limiter = createRateLimiter({ windowMs: 1000, max: 2, maxSources: 4, now: () => now })

  assert.equal(limiter.allow('10.0.0.1', 0), true)
  assert.equal(limiter.allow('10.0.0.1', 10), true)
  assert.equal(limiter.allow('10.0.0.1', 20), false)
  assert.equal(limiter.allow('10.0.0.2', 20), true)

  now = 1001
  assert.equal(limiter.allow('10.0.0.1', 1001), true)
})

test('限速器的来源表有上限，不能被打爆', () => {
  const limiter = createRateLimiter({ windowMs: 10000, max: 1, maxSources: 3 })
  for (let index = 0; index < 10; index += 1) {
    assert.equal(limiter.allow('source-' + index, index), true)
  }
  assert.ok(limiter.size() <= 3)
})

test('非法本地字段在编码阶段就失败，不会发出半截包', () => {
  assert.throws(() => encodePacket({ type: 'visit', deviceId: randomUUID(), nickname: 'x', port: 1 }), /type/)
  assert.throws(() => encodePacket({ type: 'beacon', deviceId: 'nope', nickname: 'x', port: 1 }), /deviceId/)
  assert.throws(() => encodePacket({ type: 'beacon', deviceId: randomUUID(), nickname: 'x', port: 0 }), /port/)
  assert.throws(() => encodePacket({ type: 'beacon', deviceId: randomUUID(), nickname: '', port: 1 }), /nickname/)
  // 心跳不需要昵称/端口；非法的本机动画名不抛，降级为 null。
  assert.doesNotThrow(() => encodeHeartbeat({ deviceId: randomUUID() }))
  assert.equal(JSON.parse(encodeHeartbeat({ deviceId: randomUUID(), anim: 42 }).toString('utf8')).anim, null)
})
