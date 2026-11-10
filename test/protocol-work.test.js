/**
 * 票 44：8 种 work-* 报文的严格编解码。
 *
 * 这里断言的是**字段集**：多一个字段都不该出现在线上，少一个就该整包丢。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  MAX_PACKET_BYTES,
  PACKET_TYPES,
  PROTOCOL_VERSION,
  WORK_END_REASONS,
  WORK_ERRORS,
  WORK_SETTLE_REASONS,
  encodePacket,
  encodeWorkAck,
  encodeWorkEnd,
  encodeWorkEndAck,
  encodeWorkRecall,
  encodeWorkRecallAck,
  encodeWorkRequest,
  encodeWorkSettle,
  encodeWorkSettleAck,
  isWorkGuard,
  isWorkHours,
  isWorkWage,
  parsePacket
} from '../src/protocol.js'

const T0 = 1_700_000_000_000
const HOUR = 3600_000

function json (value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function base (type, deviceId = randomUUID()) {
  return { v: PROTOCOL_VERSION, type, deviceId }
}

test('8 种 work-* 都进 PACKET_TYPES，且没有进 VISIT_TYPES 的短分支', () => {
  for (const type of ['work-request', 'work-ack', 'work-recall', 'work-recall-ack', 'work-end', 'work-end-ack', 'work-settle', 'work-settle-ack']) {
    assert.equal(PACKET_TYPES.includes(type), true, type)
  }
  // 如果 work-recall 落进 VISIT_TYPES，解析结果只剩四个字段——这条断言就是守它。
  const packet = parsePacket(encodeWorkRecall({ deviceId: randomUUID(), contractId: randomUUID() }))
  assert.equal(packet.ok, true)
  assert.deepEqual(Object.keys(packet.packet), ['v', 'type', 'deviceId', 'contractId'])
})

test('work-request：字段集精确，UUID/整数/范围都挡在门外', () => {
  const deviceId = randomUUID()
  const requestId = randomUUID()
  const data = encodeWorkRequest({ deviceId, requestId, hours: 4, wagePerHour: 10, fee: 2 })
  const raw = JSON.parse(data.toString('utf8'))
  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'requestId', 'hours', 'wagePerHour', 'fee'])
  assert.deepEqual(parsePacket(data).packet, {
    v: PROTOCOL_VERSION,
    type: 'work-request',
    deviceId,
    requestId,
    hours: 4,
    wagePerHour: 10,
    fee: 2
  })

  const valid = { ...base('work-request'), requestId, hours: 2, wagePerHour: 5, fee: 1 }
  for (const requestIdBad of ['nope', '', 42, null]) {
    assert.equal(parsePacket(json({ ...valid, requestId: requestIdBad })).reason, 'request-id')
  }
  for (const hours of [1, 9, 2.5, '4', null, undefined]) {
    assert.equal(parsePacket(json({ ...valid, hours })).reason, 'hours', String(hours))
  }
  for (const wage of [0, 101, 10.5, '10', null]) {
    assert.equal(parsePacket(json({ ...valid, wagePerHour: wage })).reason, 'wage', String(wage))
  }
  for (const fee of [0, 41, 1.5, null]) {
    assert.equal(parsePacket(json({ ...valid, fee })).reason, 'fee', String(fee))
  }
  assert.throws(() => encodeWorkRequest({ deviceId, requestId, hours: 1, wagePerHour: 10, fee: 1 }), /hours/)
  assert.throws(() => encodeWorkRequest({ deviceId, requestId, hours: 4, wagePerHour: 0, fee: 1 }), /wage/)
  assert.throws(() => encodeWorkRequest({ deviceId, requestId, hours: 4, wagePerHour: 10, fee: 0 }), /fee/)
})

test('work-ack 成功：contractId + 起点/终点 + 守卫；结束时间差不超过 8 小时', () => {
  const deviceId = randomUUID()
  const requestId = randomUUID()
  const contractId = randomUUID()
  const data = encodeWorkAck({
    deviceId,
    requestId,
    ok: true,
    contractId,
    startedAt: T0,
    endsAt: T0 + 4 * HOUR,
    guard: 0.5
  })
  assert.deepEqual(Object.keys(JSON.parse(data.toString('utf8'))), [
    'v', 'type', 'deviceId', 'requestId', 'ok', 'contractId', 'startedAt', 'endsAt', 'guard'
  ])
  const parsed = parsePacket(data)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.packet.guard, 0.5)

  const valid = {
    ...base('work-ack'),
    requestId,
    ok: true,
    contractId,
    startedAt: T0,
    endsAt: T0 + HOUR,
    guard: 0.5
  }
  for (const contractIdBad of ['nope', null]) {
    assert.equal(parsePacket(json({ ...valid, contractId: contractIdBad })).reason, 'contract-id')
  }
  for (const startedAt of [0, -1, 1.5, '1700', null]) {
    assert.equal(parsePacket(json({ ...valid, startedAt })).reason, 'started-at', String(startedAt))
  }
  assert.equal(parsePacket(json({ ...valid, endsAt: T0 })).reason, 'contract-time')
  assert.equal(parsePacket(json({ ...valid, endsAt: T0 + 9 * HOUR })).reason, 'contract-time')
  for (const guard of [-0.1, 0.9, '0.5', null]) {
    assert.equal(parsePacket(json({ ...valid, guard })).reason, 'guard', String(guard))
  }
  assert.throws(() => encodeWorkAck({
    deviceId,
    requestId,
    ok: true,
    contractId,
    startedAt: T0,
    endsAt: T0,
    guard: 0.5
  }), /contract time/)
})

test('work-ack 失败：只带固定枚举 error，不带合同字段', () => {
  const deviceId = randomUUID()
  const requestId = randomUUID()
  const data = encodeWorkAck({ deviceId, requestId, ok: false, error: 'worker-unavailable' })
  assert.deepEqual(Object.keys(JSON.parse(data.toString('utf8'))), [
    'v', 'type', 'deviceId', 'requestId', 'ok', 'error'
  ])
  assert.deepEqual(parsePacket(data).packet, {
    v: PROTOCOL_VERSION,
    type: 'work-ack',
    deviceId,
    requestId,
    ok: false,
    error: 'worker-unavailable'
  })
  assert.equal(parsePacket(json({
    ...base('work-ack'),
    requestId,
    ok: false,
    error: '随便一句'
  })).reason, 'error')
  assert.equal(parsePacket(json({ ...base('work-ack'), requestId, ok: 'yes' })).reason, 'ok')
})

test('work-recall / work-recall-ack：按 contractId 幂等，失败带固定枚举', () => {
  const deviceId = randomUUID()
  const contractId = randomUUID()
  const recall = encodeWorkRecall({ deviceId, contractId })
  assert.deepEqual(Object.keys(JSON.parse(recall.toString('utf8'))), ['v', 'type', 'deviceId', 'contractId'])
  assert.equal(parsePacket(recall).ok, true)

  const ack = encodeWorkRecallAck({ deviceId, contractId, ok: true })
  assert.deepEqual(parsePacket(ack).packet, {
    v: PROTOCOL_VERSION,
    type: 'work-recall-ack',
    deviceId,
    contractId,
    ok: true
  })
  const failure = parsePacket(encodeWorkRecallAck({
    deviceId,
    contractId,
    ok: false,
    error: 'contract-not-found'
  }))
  assert.equal(failure.ok, true)
  assert.equal(failure.packet.ok, false)
  assert.equal(failure.packet.error, 'contract-not-found')
  assert.equal(parsePacket(json({
    ...base('work-recall'),
    contractId: 'nope'
  })).reason, 'contract-id')
})

test('work-end：contractId 优先，取消 pending 时只带 requestId；reason 固定枚举', () => {
  const deviceId = randomUUID()
  const contractId = randomUUID()
  const requestId = randomUUID()

  const byContract = encodeWorkEnd({ deviceId, contractId, requestId, reason: 'employer-end' })
  assert.deepEqual(Object.keys(JSON.parse(byContract.toString('utf8'))), [
    'v', 'type', 'deviceId', 'contractId', 'reason'
  ])
  const byRequest = encodeWorkEnd({ deviceId, requestId, reason: 'cancelled' })
  assert.deepEqual(Object.keys(JSON.parse(byRequest.toString('utf8'))), [
    'v', 'type', 'deviceId', 'requestId', 'reason'
  ])
  assert.equal(parsePacket(byRequest).packet.requestId, requestId)
  assert.equal(parsePacket(json({
    ...base('work-end'),
    contractId,
    reason: 'whatever'
  })).reason, 'reason')
  assert.equal(parsePacket(json({
    ...base('work-end'),
    reason: 'employer-end'
  })).reason, 'target')
  for (const reason of WORK_END_REASONS) {
    assert.equal(parsePacket(json({ ...base('work-end'), contractId, reason })).ok, true, reason)
  }
})

test('work-end-ack：ok + 至少一个 id；失败带 error', () => {
  const deviceId = randomUUID()
  const contractId = randomUUID()
  const requestId = randomUUID()
  const ack = encodeWorkEndAck({ deviceId, contractId, requestId, ok: true })
  assert.deepEqual(Object.keys(JSON.parse(ack.toString('utf8'))), [
    'v', 'type', 'deviceId', 'contractId', 'requestId', 'ok'
  ])
  const parsed = parsePacket(ack)
  assert.equal(parsed.ok, true)
  assert.equal(parsePacket(json({
    ...base('work-end-ack'),
    requestId,
    ok: false,
    error: 'contract-not-found'
  })).packet.error, 'contract-not-found')
  assert.equal(parsePacket(json({ ...base('work-end-ack'), ok: true })).reason, 'target')
})

test('work-settle / work-settle-ack：servedMs / earned 整数与上下界', () => {
  const deviceId = randomUUID()
  const contractId = randomUUID()
  const requestId = randomUUID()
  const settle = encodeWorkSettle({
    deviceId,
    contractId,
    requestId,
    servedMs: 2 * HOUR,
    earned: 20,
    reason: 'completed'
  })
  assert.deepEqual(Object.keys(JSON.parse(settle.toString('utf8'))), [
    'v', 'type', 'deviceId', 'contractId', 'requestId', 'servedMs', 'earned', 'reason'
  ])
  assert.equal(parsePacket(settle).ok, true)

  const valid = {
    ...base('work-settle'),
    contractId,
    requestId,
    servedMs: HOUR,
    earned: 10,
    reason: 'recall'
  }
  for (const servedMs of [-1, 9 * HOUR, 1.5, '3600', null]) {
    assert.equal(parsePacket(json({ ...valid, servedMs })).reason, 'served-ms', String(servedMs))
  }
  for (const earned of [-1, 801, 1.5, '10', null]) {
    assert.equal(parsePacket(json({ ...valid, earned })).reason, 'earned', String(earned))
  }
  for (const reason of WORK_SETTLE_REASONS) {
    assert.equal(parsePacket(json({ ...valid, reason })).ok, true, reason)
  }
  assert.equal(parsePacket(json({ ...valid, reason: 'whatever' })).reason, 'reason')

  const ack = encodeWorkSettleAck({ deviceId, contractId, requestId, ok: true, earned: 10 })
  assert.deepEqual(parsePacket(ack).packet, {
    v: PROTOCOL_VERSION,
    type: 'work-settle-ack',
    deviceId,
    contractId,
    requestId,
    ok: true,
    earned: 10
  })
  assert.equal(parsePacket(json({
    ...base('work-settle-ack'),
    contractId,
    requestId,
    ok: true
  })).reason, 'earned')
  assert.equal(parsePacket(json({
    ...base('work-settle-ack'),
    contractId,
    requestId,
    ok: false,
    error: 'contract-not-found'
  })).packet.error, 'contract-not-found')
})

test('敌意字段（昵称/端口/路径/坐标/自由文本）在解析时全部丢弃', () => {
  const deviceId = randomUUID()
  const requestId = randomUUID()
  const hostile = {
    ...base('work-request'),
    requestId,
    hours: 4,
    wagePerHour: 10,
    fee: 2,
    nickname: '伪造',
    port: 1,
    path: '/etc/passwd',
    x: 1,
    y: 2,
    contractId: randomUUID(),
    earned: 999
  }
  const parsed = parsePacket(json(hostile))
  assert.equal(parsed.ok, true)
  assert.deepEqual(Object.keys(parsed.packet), [
    'v', 'type', 'deviceId', 'requestId', 'hours', 'wagePerHour', 'fee'
  ])
})

test('4 KiB：work 包极小；超过上限直接丢', () => {
  const deviceId = randomUUID()
  const requestId = randomUUID()
  const data = encodeWorkRequest({
    deviceId,
    requestId: randomUUID(),
    hours: 8,
    wagePerHour: 100,
    fee: 40
  })
  assert.ok(data.length < 300, 'work 包应该 <300 字节，实际 ' + data.length)
  assert.equal(parsePacket(Buffer.alloc(MAX_PACKET_BYTES + 1, 0x61)).reason, 'too-large')
  // 旧 peer 的白名单里没有 work-*：解析成 type 后静默丢包，而不是崩。
  assert.equal(parsePacket(json({ ...base('work-nope'), requestId })).reason, 'type')
})

test('编码非法本机字段抛异常；guard/hours/wage 的边界一致', () => {
  const deviceId = randomUUID()
  assert.throws(() => encodeWorkRequest({ deviceId: 'nope' }), /deviceId/)
  assert.throws(() => encodeWorkRecall({ deviceId, contractId: 'x' }), /contractId/)
  assert.throws(() => encodeWorkSettle({ deviceId, contractId: randomUUID(), requestId: randomUUID(), servedMs: -1, earned: 1, reason: 'completed' }), /servedMs/)
  assert.throws(() => encodeWorkSettle({ deviceId, contractId: randomUUID(), requestId: randomUUID(), servedMs: 1, earned: 1, reason: 'nope' }), /settle reason/)

  assert.equal(isWorkHours(2), true)
  assert.equal(isWorkHours(8), true)
  assert.equal(isWorkHours(1), false)
  assert.equal(isWorkWage(1), true)
  assert.equal(isWorkWage(100), true)
  assert.equal(isWorkWage(0), false)
  assert.equal(isWorkGuard(0), true)
  assert.equal(isWorkGuard(0.8), true)
  assert.equal(isWorkGuard(0.81), false)

  // 错误枚举与协议层共用同一份（服务端只认这些码）。
  for (const error of WORK_ERRORS) {
    const packet = parsePacket(encodeWorkAck({ deviceId, requestId: randomUUID(), ok: false, error }))
    assert.equal(packet.ok, true, error)
  }
  assert.throws(() => encodeWorkAck({ deviceId, requestId: randomUUID(), ok: false, error: 'nope' }), /work error/)
  assert.throws(() => encodePacket({ type: 'work-request', deviceId }), /invalid requestId/)
})
