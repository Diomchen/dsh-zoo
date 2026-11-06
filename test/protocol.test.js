import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  BEACON_INTERVAL_MS,
  DEFAULT_PORT,
  GUEST_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  HIRE_REASONS,
  MARKET_DIGEST_FRESH_MS,
  MARKET_DIGEST_INTERVAL_MS,
  MAX_PACKET_BYTES,
  PACKET_TYPES,
  PEER_LOST_MS,
  PROTOCOL_VERSION,
  VISIT_MAX_MS,
  createRateLimiter,
  encodeHeartbeat,
  encodeMarketDigest,
  encodePacket,
  encodeVisitAck,
  encodeVisitDeny,
  encodeVisitRecall,
  encodeVisitRecallAck,
  encodeVisitRequest,
  isSafeAnimationName,
  isVisitId,
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

function validHire (overrides = {}) {
  return {
    enabled: true,
    wagePerHour: 12,
    minHours: 2,
    maxHours: 8,
    guard: 0.5,
    available: true,
    reason: null,
    ...overrides
  }
}

function validDigest (overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: 'market-digest',
    deviceId: randomUUID(),
    at: 1700000000000,
    prices: { tomato: 5, carrot: 6, pumpkin: 30 },
    hire: validHire(),
    ...overrides
  }
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

test('任何报文都不含坐标字段（包括串门报文）', () => {
  const deviceId = randomUUID()
  const visitId = randomUUID()
  const packets = [
    encodePacket({ type: 'beacon', deviceId, nickname: '甲', port: 45871 }),
    encodePacket({ type: 'beacon-ack', deviceId, nickname: '甲', port: 45871 }),
    encodeHeartbeat({ deviceId, anim: '写代码' }),
    encodeHeartbeat({ deviceId, anim: null }),
    encodeVisitRequest({ deviceId, visitId, nickname: '甲', anim: '写代码' }),
    encodeVisitAck({ deviceId, visitId }),
    encodeVisitDeny({ deviceId, visitId }),
    encodeVisitRecall({ deviceId, visitId })
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
  for (const type of PACKET_TYPES) {
    let raw
    if (type === 'heartbeat') {
      raw = { v: PROTOCOL_VERSION, type, deviceId, anim: '写代码', x: 1, y: 2, coordinates: { x: 3, y: 4 } }
    } else if (type === 'visit-request') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        visitId,
        nickname: '甲',
        anim: null,
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type === 'gift-received') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        visitId,
        giftId: randomUUID(),
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type === 'market-digest') {
      raw = {
        ...validDigest({ deviceId }),
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type === 'farm-action') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        visitId: randomUUID(),
        requestId: randomUUID(),
        action: 'steal',
        plotId: 'p1',
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type === 'farm-action-result') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        requestId: randomUUID(),
        ok: true,
        crop: 'tomato',
        qty: 1,
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type.startsWith('visit-')) {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        visitId,
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        nickname: '甲',
        port: 45871,
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    }
    const parsed = parsePacket(encodeJson(raw))
    assert.equal(parsed.ok, true)
    assert.deepEqual(
      Object.keys(parsed.packet),
      type === 'heartbeat'
        ? ['v', 'type', 'deviceId', 'anim']
        : type === 'visit-request'
          ? ['v', 'type', 'deviceId', 'visitId', 'nickname', 'anim']
          : type === 'visit-deny'
            ? ['v', 'type', 'deviceId', 'visitId', 'reason']
            : type === 'gift-received'
              ? ['v', 'type', 'deviceId', 'visitId', 'giftId']
              : type === 'market-digest'
                ? ['v', 'type', 'deviceId', 'at', 'prices', 'hire']
                : type === 'farm-action'
                  ? ['v', 'type', 'deviceId', 'visitId', 'requestId', 'action', 'plotId']
                  : type === 'farm-action-result'
                    ? ['v', 'type', 'deviceId', 'requestId', 'ok', 'crop', 'qty']
                    : type.startsWith('visit-')
                      ? ['v', 'type', 'deviceId', 'visitId']
                      : ['v', 'type', 'deviceId', 'nickname', 'port']
    )
  }
})

test('串门请求只写 v/type/deviceId/visitId/nickname/anim', () => {
  const deviceId = randomUUID()
  const visitId = randomUUID()
  const data = encodeVisitRequest({
    deviceId: deviceId.toUpperCase(),
    visitId: visitId.toUpperCase(),
    nickname: '  隔壁  ',
    anim: ' 东张西望 ',
    // 下面这些都不该出现在请求里。
    port: 1234,
    x: 1,
    y: 2,
    coordinates: { x: 3, y: 4 }
  })
  const raw = JSON.parse(data.toString('utf8'))
  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'visitId', 'nickname', 'anim'])
  assert.deepEqual(raw, {
    v: PROTOCOL_VERSION,
    type: 'visit-request',
    deviceId: deviceId.toLowerCase(),
    visitId: visitId.toLowerCase(),
    nickname: '隔壁',
    anim: '东张西望'
  })
  assert.deepEqual(parsePacket(data), {
    ok: true,
    packet: {
      v: PROTOCOL_VERSION,
      type: 'visit-request',
      deviceId: deviceId.toLowerCase(),
      visitId: visitId.toLowerCase(),
      nickname: '隔壁',
      anim: '东张西望'
    }
  })

  // 本机动画名坏掉时降级成 null，而不是把整个请求丢掉。
  const idle = encodeVisitRequest({ deviceId, visitId, nickname: '甲', anim: '../secret' })
  assert.equal(JSON.parse(idle.toString('utf8')).anim, null)
  assert.equal(parsePacket(idle).packet.anim, null)
})

test('visit-ack / visit-recall / visit-recall-ack 只关联串门 id，visit-deny 多一个固定枚举 reason', () => {
  const deviceId = randomUUID()
  const visitId = randomUUID()
  const cases = [
    ['visit-ack', encodeVisitAck({ deviceId, visitId }), 'not-admitted', ['v', 'type', 'deviceId', 'visitId']],
    ['visit-recall', encodeVisitRecall({ deviceId, visitId }), 'not-admitted', ['v', 'type', 'deviceId', 'visitId']],
    ['visit-recall-ack', encodeVisitRecallAck({ deviceId, visitId }), 'not-admitted', ['v', 'type', 'deviceId', 'visitId']],
    ['visit-deny', encodeVisitDeny({ deviceId, visitId }), 'not-admitted', ['v', 'type', 'deviceId', 'visitId', 'reason']],
    ['visit-deny', encodeVisitDeny({ deviceId, visitId, reason: 'visits-off' }), 'visits-off', ['v', 'type', 'deviceId', 'visitId', 'reason']]
  ]
  for (const [type, data, expectedReason, expectedKeys] of cases) {
    const raw = JSON.parse(data.toString('utf8'))
    assert.deepEqual(Object.keys(raw), expectedKeys)
    assert.equal(raw.type, type)
    if (type === 'visit-deny') assert.equal(raw.reason, expectedReason)
    const parsed = parsePacket(data)
    assert.equal(parsed.ok, true)
    assert.deepEqual(Object.keys(parsed.packet), expectedKeys)
    assert.equal(parsed.packet.deviceId, deviceId)
    assert.equal(parsed.packet.visitId, visitId)
    if (type === 'visit-deny') assert.equal(parsed.packet.reason, expectedReason)

    // 敌意附加字段（昵称、端口、坐标、未知字段）不会进入解析结果。
    const hostile = parsePacket(encodeJson({
      v: PROTOCOL_VERSION,
      type,
      deviceId,
      visitId,
      nickname: '伪造',
      port: 1,
      anim: '写代码',
      x: 1,
      y: 2,
      coordinates: { x: 3, y: 4 }
    }))
    assert.deepEqual(Object.keys(hostile.packet), expectedKeys)
    assert.equal(hostile.packet.nickname, undefined)
  }
})

test('visit-deny 的 reason 只接受固定枚举；缺失按 not-admitted，坏值整包丢弃', () => {
  const deviceId = randomUUID()
  const visitId = randomUUID()
  const base = { v: PROTOCOL_VERSION, type: 'visit-deny', deviceId, visitId }

  const missing = parsePacket(encodeJson(base))
  assert.equal(missing.ok, true)
  assert.equal(missing.packet.reason, 'not-admitted')

  assert.equal(parsePacket(encodeJson({ ...base, reason: 'visits-off' })).packet.reason, 'visits-off')
  for (const reason of ['closed', 'visits_off', '', 42, null, ['visits-off'], { reason: 'visits-off' }]) {
    assert.equal(parsePacket(encodeJson({ ...base, reason })).reason, 'deny-reason', String(reason))
  }
  assert.throws(() => encodeVisitDeny({ deviceId, visitId, reason: 'closed' }), /deny reason/)
})

test('串门报文的 visitId 必须是 UUID；版本、deviceId、4 KiB 同样校验', () => {
  const deviceId = randomUUID()
  const visitId = randomUUID()
  for (const badVisitId of ['visit-1', '', 42, null, randomUUID() + 'x']) {
    assert.equal(
      parsePacket(encodeJson({ v: PROTOCOL_VERSION, type: 'visit-ack', deviceId, visitId: badVisitId })).reason,
      'visit-id',
      String(badVisitId)
    )
    assert.equal(
      parsePacket(encodeJson({
        v: PROTOCOL_VERSION,
        type: 'visit-request',
        deviceId,
        visitId: badVisitId,
        nickname: '甲',
        anim: null
      })).reason,
      'visit-id',
      String(badVisitId)
    )
  }

  // 请求必须显式带 anim（null 或安全动画名）和可读昵称。
  assert.equal(parsePacket(encodeJson({
    v: PROTOCOL_VERSION,
    type: 'visit-request',
    deviceId,
    visitId,
    nickname: '甲'
  })).reason, 'anim')
  assert.equal(parsePacket(encodeJson({
    v: PROTOCOL_VERSION,
    type: 'visit-request',
    deviceId,
    visitId,
    nickname: 42,
    anim: null
  })).reason, 'nickname')
  assert.equal(parsePacket(encodeJson({
    v: PROTOCOL_VERSION,
    type: 'visit-request',
    deviceId,
    visitId,
    nickname: '甲',
    anim: '../secret'
  })).reason, 'anim')

  assert.equal(parsePacket(encodeJson({
    v: 2,
    type: 'visit-recall',
    deviceId,
    visitId
  })).reason, 'version')
  assert.equal(parsePacket(encodeJson({
    v: PROTOCOL_VERSION,
    type: 'visit-recall',
    deviceId: 'not-a-uuid',
    visitId
  })).reason, 'device-id')
  assert.equal(parsePacket(Buffer.alloc(MAX_PACKET_BYTES + 1, 0x61)).reason, 'too-large')

  assert.equal(isVisitId(visitId), true)
  assert.equal(isVisitId(visitId.toUpperCase()), true)
  assert.equal(isVisitId('visit-1'), false)
  assert.equal(isVisitId(null), false)
})

test('串门的本地字段非法在编码阶段就失败', () => {
  const deviceId = randomUUID()
  assert.throws(
    () => encodeVisitRequest({ deviceId, visitId: 'visit-1', nickname: '甲', anim: null }),
    /visitId/
  )
  assert.throws(
    () => encodeVisitRequest({ deviceId, visitId: randomUUID(), nickname: '', anim: null }),
    /nickname/
  )
  assert.throws(
    () => encodeVisitAck({ deviceId, visitId: 'nope' }),
    /visitId/
  )
  assert.throws(
    () => encodeVisitRecall({ deviceId: 'not-a-uuid', visitId: randomUUID() }),
    /deviceId/
  )
  assert.throws(
    () => encodePacket({ type: 'visit', deviceId, visitId: randomUUID() }),
    /type/
  )
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
  assert.equal(resolvePort({ DSH_ZOO_PORT: '' }), DEFAULT_PORT)
  assert.equal(resolvePort({ DSH_ZOO_PORT: '50001' }), 50001)
  assert.equal(resolvePort({ DSH_ZOO_PORT: '0' }), DEFAULT_PORT)
  assert.equal(resolvePort({ DSH_ZOO_PORT: '70000' }), DEFAULT_PORT)
  assert.equal(resolvePort({ DSH_ZOO_PORT: 'abc' }), DEFAULT_PORT)
})

test('默认参数：发现 5 秒、心跳 2 秒、行情 30 秒/新鲜 2 分钟、心跳影子 30 秒、出门上限 30 分钟、失联 2 分钟', () => {
  assert.equal(BEACON_INTERVAL_MS, 5000)
  assert.equal(DEFAULT_PORT, 45871)
  assert.equal(HEARTBEAT_INTERVAL_MS, 2000)
  assert.equal(MARKET_DIGEST_INTERVAL_MS, 30 * 1000)
  assert.equal(MARKET_DIGEST_FRESH_MS, 2 * 60 * 1000)
  assert.deepEqual(HIRE_REASONS, ['ready', 'off', 'visiting', 'working'])
  assert.equal(GUEST_TTL_MS, 30000)
  assert.equal(VISIT_MAX_MS, 30 * 60 * 1000)
  assert.equal(PEER_LOST_MS, 2 * 60 * 1000)
  assert.deepEqual(PACKET_TYPES, [
    'beacon',
    'beacon-ack',
    'heartbeat',
    'visit-request',
    'visit-ack',
    'visit-deny',
    'visit-recall',
    'visit-recall-ack',
    'gift-received',
    'market-digest',
    'farm-action',
    'farm-action-result'
  ])
})

test('market-digest：编码只写 v/type/deviceId/at/prices/hire，解析后形状一致', () => {
  const deviceId = randomUUID()
  const data = encodeMarketDigest({
    deviceId: deviceId.toUpperCase(),
    at: 1700000000123,
    prices: { tomato: 7.5, carrot: 6, pumpkin: 30 },
    hire: validHire({ enabled: false, available: false })
  })
  const raw = JSON.parse(data.toString('utf8'))
  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'at', 'prices', 'hire'])
  assert.deepEqual(Object.keys(raw.hire), [
    'enabled', 'wagePerHour', 'minHours', 'maxHours', 'guard', 'available', 'reason'
  ])
  assert.equal(raw.deviceId, deviceId.toLowerCase())
  assert.deepEqual(raw.prices, { tomato: 7.5, carrot: 6, pumpkin: 30 })
  assert.deepEqual(parsePacket(data), {
    ok: true,
    packet: {
      v: PROTOCOL_VERSION,
      type: 'market-digest',
      deviceId: deviceId.toLowerCase(),
      at: 1700000000123,
      prices: { tomato: 7.5, carrot: 6, pumpkin: 30 },
      hire: validHire({ enabled: false, available: false })
    }
  })

  // 缺省 at 用本机时钟；extra 字段（昵称/端口/visitId/坐标）一个都不写。
  const idle = encodeMarketDigest({
    deviceId,
    prices: { tomato: 5 },
    hire: validHire(),
    nickname: '不该出现',
    port: 1,
    visitId: randomUUID(),
    x: 1,
    y: 2
  })
  const idleRaw = JSON.parse(idle.toString('utf8'))
  assert.deepEqual(Object.keys(idleRaw), ['v', 'type', 'deviceId', 'at', 'prices', 'hire'])
  assert.ok(Number.isSafeInteger(idleRaw.at) && idleRaw.at > 0)
  assert.equal(idleRaw.nickname, undefined)
  assert.equal(idleRaw.port, undefined)
  assert.equal(idleRaw.visitId, undefined)
})

test('market-digest：未知作物/坏价格只丢条目；未知字段消失；整包超 4 KiB 仍拒收', () => {
  const deviceId = randomUUID()
  const parsed = parsePacket(encodeJson(validDigest({
    deviceId,
    prices: {
      tomato: 7.5,
      carrot: 999, // 越界：丢
      pumpkin: '30', // 非数字：丢
      alien: 5, // 未知作物：丢
      x: 1
    },
    nickname: '伪造',
    port: 1,
    visitId: randomUUID(),
    extra: { path: '/tmp/x' }
  })))
  assert.equal(parsed.ok, true)
  assert.deepEqual(Object.keys(parsed.packet), ['v', 'type', 'deviceId', 'at', 'prices', 'hire'])
  assert.deepEqual(parsed.packet.prices, { tomato: 7.5 })
  assert.equal(parsed.packet.nickname, undefined)
  assert.equal(parsed.packet.port, undefined)
  assert.equal(parsed.packet.visitId, undefined)

  // 空 prices 对象是合法的（对端可能一种作物都拿不出来），不是整包损坏。
  assert.deepEqual(parsePacket(encodeJson(validDigest({ prices: {} }))).packet.prices, {})
  // 但 prices 本身不是对象就整包丢。
  for (const prices of [null, 42, 'x', []]) {
    assert.equal(parsePacket(encodeJson(validDigest({ prices }))).reason, 'prices', String(prices))
  }
  assert.equal(parsePacket(Buffer.alloc(MAX_PACKET_BYTES + 1, 0x61)).reason, 'too-large')
})

test('market-digest：at / hire 坏字段整包丢；reason 只认 null 或固定枚举', () => {
  for (const at of [undefined, null, 0, -1, 1.5, '1700000000000', Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(parsePacket(encodeJson(validDigest({ at }))).reason, 'at', String(at))
  }
  for (const hire of [undefined, null, 42, [], {}, validHire({ wagePerHour: 0 }), validHire({ wagePerHour: 101 }),
    validHire({ minHours: 1 }), validHire({ maxHours: 9 }), validHire({ minHours: 8, maxHours: 2 }),
    validHire({ guard: -0.1 }), validHire({ guard: 0.9 }), validHire({ available: 'yes' }),
    validHire({ reason: '自由文本' })]) {
    assert.equal(parsePacket(encodeJson(validDigest({ hire }))).reason, 'hire', JSON.stringify(hire))
  }
  for (const reason of HIRE_REASONS) {
    assert.equal(parsePacket(encodeJson(validDigest({ hire: validHire({ reason }) }))).packet.hire.reason, reason)
  }
})

test('market-digest：价格与挂牌边界是闭区间', () => {
  const boundary = parsePacket(encodeJson(validDigest({
    prices: { tomato: 2.5, carrot: 12, pumpkin: 15 },
    hire: validHire({
      wagePerHour: 100,
      minHours: 8,
      maxHours: 8,
      guard: 0.8,
      reason: 'ready'
    })
  })))
  assert.equal(boundary.ok, true)
  assert.deepEqual(boundary.packet.prices, { tomato: 2.5, carrot: 12, pumpkin: 15 })
  assert.equal(boundary.packet.hire.wagePerHour, 100)
  assert.equal(boundary.packet.hire.guard, 0.8)

  const low = parsePacket(encodeJson(validDigest({
    prices: { tomato: 2.499, carrot: 2.999, pumpkin: 14.999 }
  })))
  assert.deepEqual(low.packet.prices, {}, '刚过下界一丁点就丢条目')
  const high = parsePacket(encodeJson(validDigest({
    prices: { tomato: 10.001, carrot: 12.001, pumpkin: 60.001 }
  })))
  assert.deepEqual(high.packet.prices, {})

  assert.equal(parsePacket(encodeJson(validDigest({
    hire: validHire({ wagePerHour: 1, minHours: 2, maxHours: 2, guard: 0 })
  }))).ok, true)
})

test('market-digest：本地字段非法在编码阶段失败；旧 peer 的类型静默丢弃', () => {
  const deviceId = randomUUID()
  assert.throws(() => encodeMarketDigest({ deviceId: 'nope', prices: {}, hire: validHire() }), /deviceId/)
  assert.throws(() => encodeMarketDigest({ deviceId, at: 0, prices: {}, hire: validHire() }), /digest time/)
  assert.throws(() => encodeMarketDigest({ deviceId, prices: null, hire: validHire() }), /digest prices/)
  assert.throws(() => encodeMarketDigest({ deviceId, prices: {}, hire: validHire({ wagePerHour: 0 }) }), /digest hire/)
  assert.throws(() => encodePacket({ type: 'market-digest', deviceId }), /digest prices/)

  // 旧版本的邻居 TYPE_SET 里没有这个类型：parsePacket 返回 type，发现层静默丢包。
  assert.equal(parsePacket(encodeJson(validDigest({ type: 'market-digest-v2' }))).reason, 'type')
  assert.equal(parsePacket(encodeJson(validDigest({ extra: true }))).ok, true)
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
