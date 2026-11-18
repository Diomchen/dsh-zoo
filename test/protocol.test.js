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
  FUTURES_MAX_ORDERS,
  FUTURES_MAX_POSITIONS,
  FUTURES_ORDER_KINDS,
  createRateLimiter,
  encodeFuturesCancel,
  encodeFuturesHello,
  encodeFuturesOrder,
  encodeFuturesSettle,
  encodeFuturesSync,
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

function workPayload (type, deviceId) {
  const contractId = randomUUID()
  const requestId = randomUUID()
  const base = { v: PROTOCOL_VERSION, type, deviceId }
  if (type === 'work-request') {
    return { ...base, requestId, hours: 2, wagePerHour: 5, fee: 1 }
  }
  if (type === 'work-ack') {
    return { ...base, requestId, ok: true, contractId, startedAt: 1700000000000, endsAt: 1700007200000, guard: 0.5 }
  }
  if (type === 'work-recall') return { ...base, contractId }
  if (type === 'work-recall-ack') return { ...base, contractId, ok: true }
  if (type === 'work-end') return { ...base, contractId, reason: 'employer-end' }
  if (type === 'work-end-ack') return { ...base, contractId, requestId, ok: true }
  if (type === 'work-settle') {
    return { ...base, contractId, requestId, servedMs: 3600000, earned: 5, reason: 'completed' }
  }
  return { ...base, contractId, requestId, ok: true, earned: 5 }
}

function workKeys (type) {
  return {
    'work-request': ['v', 'type', 'deviceId', 'requestId', 'hours', 'wagePerHour', 'fee'],
    'work-ack': ['v', 'type', 'deviceId', 'requestId', 'ok', 'contractId', 'startedAt', 'endsAt', 'guard'],
    'work-recall': ['v', 'type', 'deviceId', 'contractId'],
    'work-recall-ack': ['v', 'type', 'deviceId', 'contractId', 'ok'],
    'work-end': ['v', 'type', 'deviceId', 'contractId', 'reason'],
    'work-end-ack': ['v', 'type', 'deviceId', 'contractId', 'requestId', 'ok'],
    'work-settle': ['v', 'type', 'deviceId', 'contractId', 'requestId', 'servedMs', 'earned', 'reason'],
    'work-settle-ack': ['v', 'type', 'deviceId', 'contractId', 'requestId', 'ok', 'earned']
  }[type]
}

function futuresPayload (type, deviceId) {
  const base = { v: PROTOCOL_VERSION, type, deviceId, at: 1700000000000 }
  if (type === 'futures-hello') return base
  if (type === 'futures-order') return { ...base, kind: 'deposit', coins: 5 }
  if (type === 'futures-cancel') return { ...base, orderId: randomUUID() }
  if (type === 'futures-sync') return { ...base, epoch: 'e1', lastSeq: 3 }
  if (type === 'futures-mode') return { ...base, accountMode: 'live' }
  if (type === 'futures-pause') return { ...base, paused: true }
  if (type === 'futures-ledger') {
    return { ...base, epoch: 'e1', seq: 3, hostId: deviceId, index: 0, total: 1, chunk: '{"a":1}' }
  }
  return { ...base, epoch: 'e1', seq: 3, balance: 10, marginUsed: 0, delta: 0, positions: [], orders: [], trades: [], insurance: 0, shortfall: 0 }
}

function futuresKeys (type) {
  return {
    'futures-hello': ['v', 'type', 'deviceId', 'at'],
    'futures-order': ['v', 'type', 'deviceId', 'at', 'kind', 'coins'],
    'futures-cancel': ['v', 'type', 'deviceId', 'at', 'orderId'],
    'futures-settle': ['v', 'type', 'deviceId', 'at', 'epoch', 'seq', 'balance', 'marginUsed', 'delta', 'positions', 'orders', 'trades', 'insurance', 'shortfall', 'mode', 'accountMode', 'paused', 'pending'],
    'futures-sync': ['v', 'type', 'deviceId', 'at', 'epoch', 'lastSeq'],
    'futures-mode': ['v', 'type', 'deviceId', 'at', 'accountMode'],
    'futures-pause': ['v', 'type', 'deviceId', 'at', 'paused'],
    'futures-ledger': ['v', 'type', 'deviceId', 'at', 'epoch', 'seq', 'hostId', 'index', 'total', 'chunk']
  }[type]
}

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
    } else if (type === 'trading-digest') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        at: 1700000000000,
        weekPnl: 12,
        positions: [{ crop: 'tomato', side: 'long', leverage: 1 }],
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
    } else if (type === 'crop-catalog-request') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        hash: '0123456789abcdef',
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type === 'crop-catalog') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        catalogHash: '0123456789abcdef',
        chunk: 0,
        total: 1,
        entries: [{ id: 'kiwi', name: '猕猴桃', growMs: 7200000, seedPrice: 20, yield: 5, base: 12 }],
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type === 'packet-return') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        giftId: visitId,
        contents: { coins: 3, crops: { tomato: 1 }, seeds: {} },
        note: '\u9000\u56DE',
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type === 'packet-returned') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        giftId: visitId,
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type === 'board-flow') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        at: 1700000000000,
        events: [{
          id: 'flow:1',
          deviceId,
          at: 1700000000000,
          crop: 'tomato',
          action: 'open',
          side: 'long',
          reason: 'manual',
          notional: 500,
          source: 'board'
        }],
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type === 'board-flow-sync') {
      raw = {
        v: PROTOCOL_VERSION,
        type,
        deviceId,
        at: 1700000000000,
        since: 1699990000000,
        x: 1,
        y: 2,
        coordinates: { x: 3, y: 4 }
      }
    } else if (type.startsWith('futures-')) {
      raw = { ...futuresPayload(type, deviceId), x: 1, y: 2, coordinates: { x: 3, y: 4 } }
    } else if (type.startsWith('work-')) {
      raw = { ...workPayload(type, deviceId), x: 1, y: 2, coordinates: { x: 3, y: 4 } }
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
                : type === 'trading-digest'
                  ? ['v', 'type', 'deviceId', 'at', 'weekPnl', 'positions']
                : type === 'board-flow'
                  ? ['v', 'type', 'deviceId', 'at', 'events', 'sync']
                  : type === 'board-flow-sync'
                    ? ['v', 'type', 'deviceId', 'at', 'since']
                : type === 'farm-action'
                  ? ['v', 'type', 'deviceId', 'visitId', 'requestId', 'action', 'plotId']
                  : type === 'farm-action-result'
                    ? ['v', 'type', 'deviceId', 'requestId', 'ok', 'crop', 'qty']
                    : type === 'crop-catalog-request'
                      ? ['v', 'type', 'deviceId', 'hash']
                      : type === 'crop-catalog'
                        ? ['v', 'type', 'deviceId', 'catalogHash', 'chunk', 'total', 'entries']
                        : type === 'packet-return'
  ? ['v', 'type', 'deviceId', 'giftId', 'contents', 'note']
  : type === 'packet-returned'
    ? ['v', 'type', 'deviceId', 'giftId']
  : type.startsWith('futures-')
    ? futuresKeys(type)
  : type.startsWith('work-')
                          ? workKeys(type)
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
    'packet-return',
    'packet-returned',
    'market-digest',
    // 票 82：盘口周报（本周盈亏 + 当前持仓），也是"局域网情报"这一类
    'trading-digest',
    // 票 59：运行时作物目录（跟着行情后面，都是"局域网情报"这一类）
    'crop-catalog-request',
    'crop-catalog',
    'farm-action',
    'farm-action-result',
    'work-request',
    'work-ack',
    'work-recall',
    'work-recall-ack',
    'work-end',
    'work-end-ack',
    'work-settle',
    'work-settle-ack',
    // 票 94：双机开户与净额结算（hello/order/cancel/settle/sync 各自独立，不进 VISIT_TYPES）
    'futures-hello',
    'futures-order',
    'futures-cancel',
    'futures-settle',
    'futures-sync',
    // 1.10.0：账户自己申报档位（真钱/纸面），房主据此记账
    'futures-mode',
    // 1.12.0：账户自己申报暂停（只停自己，停不了别人的市）
    'futures-pause',
    // 1.12.0（B）：整本账快照分片（换房主时重建账本）
    'futures-ledger',
    // 票 107：盘口 LAN 资金流与同步请求
    'board-flow',
    'board-flow-sync'
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

// ── 票 94：期货五包（hello / order / cancel / settle / sync） ────────────────
// 这一层只验 wire：白名单字段、每项坏字段整包丢、单包 ≤ 4 KiB。
// 「谁记账、谁信谁」在 futures-net.test.js 的两台服务里验。

const FUTURES_AT = 1700000000123

function validFuturesPosition (overrides = {}) {
  return {
    id: randomUUID(),
    crop: 'tomato',
    contract: 'tomato-2026W47',
    side: 'long',
    lots: 3,
    entry: 5.12,
    margin: 15.36,
    leverage: 10,
    ...overrides
  }
}

function validFuturesSettle (overrides = {}) {
  return {
    deviceId: randomUUID(),
    at: FUTURES_AT,
    epoch: 'a3f1c2d4-0000-4000-8000-000000000000',
    seq: 7,
    balance: 120.5,
    marginUsed: 15.36,
    delta: 0,
    positions: [validFuturesPosition()],
    ...overrides
  }
}

/** 票 95：settle 里的一条挂单（`lots` 原始张数、`lotsLeft` 剩余张数）。 */
function validFuturesOrder (overrides = {}) {
  return {
    id: randomUUID(),
    crop: 'tomato',
    contract: 'tomato-2026W47',
    side: 'long',
    price: 5.12,
    lots: 3,
    lotsLeft: 2,
    leverage: 10,
    marginFrozen: 6.4,
    at: FUTURES_AT,
    ...overrides
  }
}

test('票 94：futures-hello 往返只带 v/type/deviceId/at，多余字段解析时丢掉', () => {
  const deviceId = randomUUID()
  const data = encodeFuturesHello({ deviceId: deviceId.toUpperCase(), at: FUTURES_AT })
  const raw = JSON.parse(data.toString('utf8'))
  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'at'])
  assert.equal(raw.deviceId, deviceId)

  const parsed = parsePacket(data)
  assert.deepEqual(parsed, {
    ok: true,
    packet: { v: PROTOCOL_VERSION, type: 'futures-hello', deviceId, at: FUTURES_AT }
  })
  // 冒充/夹带：解析只重建白名单字段，nickname/epoch 这类一律不进 packet。
  const dirty = parsePacket(encodeJson({ ...raw, nickname: '路过的小猫', epoch: 'fake', seq: 99 }))
  assert.equal(dirty.ok, true)
  assert.deepEqual(Object.keys(dirty.packet), ['v', 'type', 'deviceId', 'at'])
})

test('票 95/96：futures-order 五种 kind 各自往返，缺字段/坏字段直接拒', () => {
  const deviceId = randomUUID()
  assert.deepEqual([...FUTURES_ORDER_KINDS], ['open', 'close', 'deposit', 'place', 'convert'])

  const open = encodeFuturesOrder({
    deviceId,
    at: FUTURES_AT,
    kind: 'open',
    crop: 'tomato',
    side: 'short',
    margin: 20,
    leverage: 10
  })
  assert.deepEqual(JSON.parse(open.toString('utf8')), {
    v: PROTOCOL_VERSION,
    type: 'futures-order',
    deviceId,
    at: FUTURES_AT,
    kind: 'open',
    crop: 'tomato',
    side: 'short',
    margin: 20,
    leverage: 10
  })

  const positionId = randomUUID()
  assert.deepEqual(parsePacket(encodeFuturesOrder({ deviceId, at: FUTURES_AT, kind: 'close', positionId })).packet, {
    v: PROTOCOL_VERSION,
    type: 'futures-order',
    deviceId,
    at: FUTURES_AT,
    kind: 'close',
    positionId
  })

  assert.deepEqual(parsePacket(encodeFuturesOrder({ deviceId, at: FUTURES_AT, kind: 'deposit', coins: 250 })).packet, {
    v: PROTOCOL_VERSION,
    type: 'futures-order',
    deviceId,
    at: FUTURES_AT,
    kind: 'deposit',
    coins: 250
  })

  // 票 95：place 只带限价、方向、张数、杠杆；保证金与成交价不随包走。
  const placed = encodeFuturesOrder({
    deviceId,
    at: FUTURES_AT,
    kind: 'place',
    crop: 'tomato',
    side: 'long',
    price: 5.12,
    lots: 3,
    leverage: 10
  })
  assert.deepEqual(JSON.parse(placed.toString('utf8')), {
    v: PROTOCOL_VERSION,
    type: 'futures-order',
    deviceId,
    at: FUTURES_AT,
    kind: 'place',
    crop: 'tomato',
    side: 'long',
    price: 5.12,
    lots: 3,
    leverage: 10
  })
  assert.deepEqual(parsePacket(placed).packet, {
    v: PROTOCOL_VERSION,
    type: 'futures-order',
    deviceId,
    at: FUTURES_AT,
    kind: 'place',
    crop: 'tomato',
    side: 'long',
    price: 5.12,
    lots: 3,
    leverage: 10
  })

  // 票 96：convert 只带仓位 id 与张数；价格/手续费全由房主算。
  const convertId = randomUUID()
  assert.deepEqual(
    parsePacket(encodeFuturesOrder({ deviceId, at: FUTURES_AT, kind: 'convert', positionId: convertId.toUpperCase(), lots: 2 })).packet,
    { v: PROTOCOL_VERSION, type: 'futures-order', deviceId, at: FUTURES_AT, kind: 'convert', positionId: convertId, lots: 2 }
  )
  assert.throws(
    () => encodeFuturesOrder({ deviceId, kind: 'convert', positionId: convertId, lots: 0 }),
    /invalid futures lots/
  )
  assert.throws(
    () => encodeFuturesOrder({ deviceId, kind: 'convert', positionId: 'nope', lots: 1 }),
    /invalid futures positionId/
  )
  const convertBase = { v: PROTOCOL_VERSION, type: 'futures-order', deviceId, at: FUTURES_AT }
  assert.equal(
    parsePacket(encodeJson({ ...convertBase, kind: 'convert', positionId: convertId, lots: 1.5 })).reason,
    'lots'
  )
  assert.equal(
    parsePacket(encodeJson({ ...convertBase, kind: 'convert', positionId: 'nope', lots: 1 })).reason,
    'position-id'
  )

  // 编码端：本地字段坏 = 抛，不发半截包。
  assert.throws(
    () => encodeFuturesOrder({ deviceId, kind: 'open', crop: 'tomato', side: 'long', margin: 0, leverage: 10 }),
    /invalid futures margin/
  )
  assert.throws(
    () => encodeFuturesOrder({ deviceId, kind: 'open', crop: 'nope', side: 'long', margin: 10, leverage: 10 }),
    /invalid futures crop/
  )
  assert.throws(
    () => encodeFuturesOrder({ deviceId, kind: 'open', crop: 'tomato', side: 'both', margin: 10, leverage: 10 }),
    /invalid futures side/
  )
  assert.throws(
    () => encodeFuturesOrder({ deviceId, kind: 'open', crop: 'tomato', side: 'long', margin: 10, leverage: 7 }),
    /invalid futures leverage/
  )
  assert.throws(() => encodeFuturesOrder({ deviceId, kind: 'close' }), /invalid positionId/)
  assert.throws(() => encodeFuturesOrder({ deviceId, kind: 'deposit', coins: 0 }), /invalid futures coins/)
  assert.throws(() => encodeFuturesOrder({ deviceId, kind: 'open', margin: 10 }), /invalid futures crop/)
  assert.throws(
    () => encodeFuturesOrder({ deviceId, kind: 'place', crop: 'tomato', side: 'long', price: 0, lots: 3, leverage: 10 }),
    /invalid futures place/
  )
  assert.throws(
    () => encodeFuturesOrder({ deviceId, kind: 'place', crop: 'tomato', side: 'long', price: 5.12, lots: 0, leverage: 10 }),
    /invalid futures place/
  )
  assert.throws(
    () => encodeFuturesOrder({ deviceId, kind: 'place', crop: 'tomato', side: 'long', price: 5.12, lots: 3, leverage: 7 }),
    /invalid futures place/
  )

  // 解析端：同样坏的内容返回 {ok:false}，连 reason 都指到具体字段。
  const base = { v: PROTOCOL_VERSION, type: 'futures-order', deviceId, at: FUTURES_AT }
  assert.equal(parsePacket(encodeJson({ ...base, kind: 'open', crop: 'tomato', side: 'long', margin: -1, leverage: 10 })).ok, false)
  assert.equal(parsePacket(encodeJson({ ...base, kind: 'steal' })).reason, 'kind')
  assert.equal(parsePacket(encodeJson({ ...base, kind: 'open', crop: 'tomato', side: 'long', margin: 10 })).reason, 'leverage')
  assert.equal(parsePacket(encodeJson({ ...base, kind: 'deposit', coins: 0 })).reason, 'coins')
  assert.equal(parsePacket(encodeJson({ ...base, kind: 'deposit', coins: 1_000_000_001 })).reason, 'coins')
  assert.equal(parsePacket(encodeJson({ ...base, kind: 'close', positionId: 'nope' })).reason, 'position-id')
  assert.equal(
    parsePacket(encodeJson({ ...base, kind: 'place', crop: 'tomato', side: 'long', price: 5.12, lots: 3, leverage: 7 })).reason,
    'place'
  )
  assert.equal(
    parsePacket(encodeJson({ ...base, kind: 'place', crop: 'tomato', side: 'long', price: 5.12, lots: 3 })).reason,
    'place'
  )
})

test('票 95：futures-cancel 认 orderId（也留 positionId 给票 96），两者都没有整包拒', () => {
  const deviceId = randomUUID()
  const orderId = randomUUID()
  assert.deepEqual(
    parsePacket(encodeFuturesCancel({ deviceId, at: FUTURES_AT, orderId: orderId.toUpperCase() })).packet,
    { v: PROTOCOL_VERSION, type: 'futures-cancel', deviceId, at: FUTURES_AT, orderId }
  )

  // 票 96 会按仓位撤：positionId 继续可选，两个一起给就都带上。
  const positionId = randomUUID()
  assert.deepEqual(
    parsePacket(encodeFuturesCancel({ deviceId, at: FUTURES_AT, positionId })).packet,
    { v: PROTOCOL_VERSION, type: 'futures-cancel', deviceId, at: FUTURES_AT, positionId }
  )
  assert.deepEqual(
    parsePacket(encodeFuturesCancel({ deviceId, at: FUTURES_AT, orderId, positionId })).packet,
    { v: PROTOCOL_VERSION, type: 'futures-cancel', deviceId, at: FUTURES_AT, orderId, positionId }
  )

  assert.throws(() => encodeFuturesCancel({ deviceId }), /invalid futures cancel target/)
  assert.throws(() => encodeFuturesCancel({ deviceId, orderId: 'nope' }), /invalid futures cancel target/)
  const base = { v: PROTOCOL_VERSION, type: 'futures-cancel', deviceId, at: FUTURES_AT }
  assert.equal(parsePacket(encodeJson(base)).reason, 'cancel-target')
  assert.equal(parsePacket(encodeJson({ ...base, orderId: 'nope' })).reason, 'cancel-target')
})

test('票 95：futures-settle 往返带账目与挂单；9 个持仓 / 9 条挂单 / 坏字段都整包拒', () => {
  const body = validFuturesSettle({ orders: [validFuturesOrder()] })
  const parsed = parsePacket(encodeFuturesSettle(body))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.packet, {
    v: PROTOCOL_VERSION,
    type: 'futures-settle',
    deviceId: body.deviceId,
    at: body.at,
    epoch: body.epoch,
    seq: body.seq,
    balance: body.balance,
    marginUsed: body.marginUsed,
    delta: 0,
    positions: body.positions,
    orders: body.orders,
    trades: [],
    // 票 97：基金/欠账始终在线，缺省 0。
    insurance: 0,
    shortfall: 0,
    // 票 98：模式缺省 shadow、待提取缺省 0。
    mode: 'shadow',
    // 1.10.0：账户档位可选，缺省 null。
    accountMode: null,
    // 1.12.0：账户自己的暂停，缺省 false。
    paused: false,
    pending: 0
  })

  // 票 95：`orders` 是可选的（票 94 的调用方不带），不带就是空盘口，字段始终在线。
  const bare = parsePacket(encodeFuturesSettle(validFuturesSettle()))
  assert.equal(bare.ok, true)
  assert.deepEqual(bare.packet.orders, [])
  // 票 96：`trades` 同样可选，字段始终在线。
  assert.deepEqual(bare.packet.trades, [])
  // 票 97：基金与欠账同样可选，缺省 0，字段始终在线。
  assert.deepEqual([bare.packet.insurance, bare.packet.shortfall], [0, 0])
  // 票 98：模式与待提取同样可选；缺省 shadow / 0。
  assert.deepEqual([bare.packet.mode, bare.packet.pending], ['shadow', 0])
  assert.throws(() => encodeFuturesSettle(validFuturesSettle({ mode: 'turbo' })), /invalid futures mode/)
  assert.throws(() => encodeFuturesSettle(validFuturesSettle({ pending: -1 })), /invalid futures pending/)
  assert.equal(parsePacket(encodeFuturesSettle(validFuturesSettle({ mode: 'live', pending: 12.5 }))).packet.pending,
    12.5
  )

  // 金额到分、张数与杠杆夹取由编码端统一做：不是整数分就拒，不四舍五入蒙过去。
  assert.throws(() => encodeFuturesSettle(validFuturesSettle({ balance: -1 })), /invalid futures balance/)
  assert.throws(() => encodeFuturesSettle(validFuturesSettle({ seq: -1 })), /invalid futures seq/)
  assert.throws(() => encodeFuturesSettle(validFuturesSettle({ epoch: '' })), /invalid futures epoch/)
  assert.throws(() => encodeFuturesSettle(validFuturesSettle({ epoch: 'e'.repeat(65) })), /invalid futures epoch/)

  // 持仓上限 8：8 个能发，9 个连编码都不行。
  assert.equal(FUTURES_MAX_POSITIONS, 8)
  const eight = Array.from({ length: 8 }, () => validFuturesPosition())
  const packed = encodeFuturesSettle(validFuturesSettle({ positions: eight }))
  assert.ok(packed.length <= MAX_PACKET_BYTES)
  assert.equal(parsePacket(packed).packet.positions.length, 8)
  assert.throws(
    () => encodeFuturesSettle(validFuturesSettle({ positions: [...eight, validFuturesPosition()] })),
    /invalid futures positions/
  )

  // 挂单上限 8：与持仓同一条口径（一条账目里最多 8 笔）。
  assert.equal(FUTURES_MAX_ORDERS, 8)
  const eightOrders = Array.from({ length: 8 }, () => validFuturesOrder())
  const packedOrders = encodeFuturesSettle(validFuturesSettle({ orders: eightOrders }))
  assert.ok(packedOrders.length <= MAX_PACKET_BYTES)
  assert.equal(parsePacket(packedOrders).packet.orders.length, 8)
  assert.throws(
    () => encodeFuturesSettle(validFuturesSettle({ orders: [...eightOrders, validFuturesOrder()] })),
    /invalid futures orders/
  )

  const base = { v: PROTOCOL_VERSION, type: 'futures-settle', deviceId: body.deviceId, at: FUTURES_AT, epoch: 'e1', seq: 1, balance: 10, marginUsed: 0 }
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [], mode: 'turbo' })).reason, 'mode')
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [], pending: -1 })).reason, 'pending')
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [...eight, validFuturesPosition()] })).reason, 'positions')
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [validFuturesPosition({ contract: 'tomato-47' })] })).reason, 'positions')
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [validFuturesPosition({ side: 'both' })] })).reason, 'positions')
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [validFuturesPosition({ lots: 0 })] })).reason, 'positions')
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [] , balance: -10 })).reason, 'balance')
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [], epoch: '' })).reason, 'epoch')
  // 空持仓是合法的：零账户（还没开过仓）也要能发出去。
  assert.deepEqual(parsePacket(encodeJson({ ...base, delta: 0, positions: [] })).packet.positions, [])

  // 挂单同理：坏一条整包丢（`lotsLeft` 超过 `lots`、时间坏、`marginFrozen` 为负都算坏）。
  const badOrders = (orders) => parsePacket(encodeJson({ ...base, delta: 0, positions: [], orders })).reason
  assert.equal(badOrders([validFuturesOrder({ lotsLeft: 9 })]), 'orders')
  assert.equal(badOrders([validFuturesOrder({ at: 0 })]), 'orders')
  assert.equal(badOrders([validFuturesOrder({ marginFrozen: -1 })]), 'orders')
  assert.equal(badOrders([validFuturesOrder({ price: 0 })]), 'orders')
  assert.equal(badOrders([validFuturesOrder({ contract: 'tomato-47' })]), 'orders')
  assert.equal(badOrders('nope'), 'orders')
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [], orders: [] })).ok, true)

  // 票 96：交割流水往返；delivery 必须带 deliveryFee，坏一条整包丢。
  const delivery = {
    at: FUTURES_AT,
    crop: 'tomato',
    contract: 'tomato-2026W47',
    side: 'short',
    lots: 2,
    price: 5.12,
    fee: 1.02,
    kind: 'delivery',
    deliveryFee: 1.02
  }
  const settled = parsePacket(encodeFuturesSettle(validFuturesSettle({ trades: [delivery] })))
  assert.equal(settled.ok, true)
  assert.deepEqual(settled.packet.trades, [delivery])
  assert.throws(
    () => encodeFuturesSettle(validFuturesSettle({ trades: [{ ...delivery, deliveryFee: undefined }] })),
    /invalid futures trades/
  )
  assert.throws(
    () => encodeFuturesSettle(validFuturesSettle({ trades: [{ ...delivery, kind: 'steal' }] })),
    /invalid futures trades/
  )
  assert.equal(
    parsePacket(encodeJson({ ...base, delta: 0, positions: [], trades: [{ ...delivery, fee: -1 }] })).reason,
    'trades'
  )

  // 票 97：强平流水与交割同形（额外字段只有 delivery 要），kind 白名单认 liquidation。
  const liquidation = {
    at: FUTURES_AT,
    crop: 'tomato',
    contract: 'tomato-2026W47',
    side: 'short',
    lots: 1,
    price: 4.87,
    fee: 0.49,
    kind: 'liquidation'
  }
  const blown = parsePacket(encodeFuturesSettle(validFuturesSettle({ trades: [liquidation] })))
  assert.equal(blown.ok, true)
  assert.deepEqual(blown.packet.trades, [liquidation])

  // 票 98：灰度切换流水只带 note，lots/price/fee 固定 0，允许没有 crop/contract/side。
  const mode = { at: FUTURES_AT, kind: 'mode', note: 'shadow', lots: 0, price: 0, fee: 0 }
  const switched = parsePacket(encodeFuturesSettle(validFuturesSettle({ trades: [mode] })))
  assert.equal(switched.ok, true)
  assert.deepEqual(switched.packet.trades, [mode])
  assert.equal(
    parsePacket(encodeJson({ ...base, delta: 0, positions: [], trades: [{ ...mode, note: 'turbo' }] })).reason,
    'trades'
  )

  // 票 97：基金余额与欠账往返；负数/非整数分连编码都过不去，解码侧落 'insurance' / 'shortfall'。
  const funded = parsePacket(encodeFuturesSettle(validFuturesSettle({ insurance: 3.2, shortfall: 0.8 })))
  assert.deepEqual([funded.packet.insurance, funded.packet.shortfall], [3.2, 0.8])
  assert.throws(() => encodeFuturesSettle(validFuturesSettle({ insurance: -0.01 })), /invalid futures insurance/)
  assert.throws(() => encodeFuturesSettle(validFuturesSettle({ shortfall: -1 })), /invalid futures shortfall/)
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [], insurance: -1 })).reason, 'insurance')
  assert.equal(parsePacket(encodeJson({ ...base, delta: 0, positions: [], shortfall: 'x' })).reason, 'shortfall')
})

test('票 94：futures-sync 带 (epoch,lastSeq)；坏 lastSeq 拒', () => {
  const deviceId = randomUUID()
  assert.deepEqual(parsePacket(encodeFuturesSync({ deviceId, at: FUTURES_AT, epoch: 'e1', lastSeq: 4 })).packet, {
    v: PROTOCOL_VERSION,
    type: 'futures-sync',
    deviceId,
    at: FUTURES_AT,
    epoch: 'e1',
    lastSeq: 4
  })
  assert.throws(() => encodeFuturesSync({ deviceId, epoch: 'e1', lastSeq: -1 }), /invalid futures last seq/)
  assert.throws(() => encodeFuturesSync({ deviceId, epoch: '', lastSeq: 1 }), /invalid futures epoch/)
  const base = { v: PROTOCOL_VERSION, type: 'futures-sync', deviceId, at: FUTURES_AT, epoch: 'e1' }
  assert.equal(parsePacket(encodeJson({ ...base, lastSeq: 1.5 })).reason, 'last-seq')
  assert.equal(parsePacket(encodeJson({ ...base, lastSeq: 2 ** 31 })).reason, 'last-seq')
})

test('票 94：一条装满 8 个持仓的 settle 也在 4 KiB 之内', () => {
  // 最坏情况：64 字符 epoch + 8 个字段都取上限的持仓 + 大余额。
  const positions = Array.from({ length: FUTURES_MAX_POSITIONS }, () => validFuturesPosition({
    id: randomUUID(),
    crop: 'pumpkin',
    contract: 'pumpkin-9999W99',
    lots: 1_000_000,
    entry: 999_999.99,
    margin: 999_999.99,
    leverage: 20
  }))
  const data = encodeFuturesSettle(validFuturesSettle({
    epoch: 'e'.repeat(64),
    seq: 2 ** 31 - 1,
    balance: 999_999_999.99,
    marginUsed: 999_999_999.99,
    delta: -999_999_999.99,
    positions
  }))
  assert.ok(data.length <= MAX_PACKET_BYTES, 'settle 单包 ' + data.length + ' 字节，超过 4 KiB')
  assert.equal(parsePacket(data).packet.positions.length, FUTURES_MAX_POSITIONS)
})

test('票 95：8 个持仓 + 8 条挂单同时装满也仍在 4 KiB 之内', () => {
  // 最坏情况：64 字符 epoch + 8 个字段都取上限的持仓 + 8 条字段取上限的挂单 + 大余额。
  const positions = Array.from({ length: FUTURES_MAX_POSITIONS }, () => validFuturesPosition({
    crop: 'pumpkin',
    contract: 'pumpkin-9999W99',
    lots: 1_000_000,
    entry: 999_999.99,
    margin: 999_999.99,
    leverage: 20
  }))
  const orders = Array.from({ length: FUTURES_MAX_ORDERS }, () => validFuturesOrder({
    crop: 'pumpkin',
    contract: 'pumpkin-9999W99',
    lots: 1_000_000,
    lotsLeft: 1_000_000,
    price: 999_999.99,
    marginFrozen: 999_999.99,
    leverage: 20
  }))
  const data = encodeFuturesSettle(validFuturesSettle({
    epoch: 'e'.repeat(64),
    seq: 2 ** 31 - 1,
    balance: 999_999_999.99,
    marginUsed: 999_999_999.99,
    delta: -999_999_999.99,
    positions,
    orders
  }))
  assert.ok(data.length <= MAX_PACKET_BYTES, 'settle 单包 ' + data.length + ' 字节，超过 4 KiB')
  const parsed = parsePacket(data)
  assert.equal(parsed.packet.positions.length, FUTURES_MAX_POSITIONS)
  assert.equal(parsed.packet.orders.length, FUTURES_MAX_ORDERS)
  // 线上只带剩余张数：`lots` 是原始张数，`lotsLeft` 才是还能成交的部分。
  assert.equal(parsed.packet.orders[0].lots, 1_000_000)
  assert.equal(parsed.packet.orders[0].lotsLeft, 1_000_000)
})
