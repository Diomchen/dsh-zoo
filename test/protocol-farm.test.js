/**
 * 票 43：`farm-action` / `farm-action-result` 的编解码与白名单。
 *
 * 两条与礼物相反、与串门相同的约定：
 *   - 字段就是这次动作的全部输入，任何一项坏都**整包丢**；
 *   - 新类型绝不并进 `VISIT_TYPES`（那条只重建四个字段，requestId/action/plotId 会被吃掉）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  FARM_ACTION_ERRORS,
  FARM_ACTION_KINDS,
  MAX_FARM_QTY,
  MAX_PACKET_BYTES,
  PROTOCOL_VERSION,
  encodeFarmAction,
  encodeFarmActionResult,
  parsePacket
} from '../src/protocol.js'

function encodeJson (value) {
  return Buffer.from(JSON.stringify(value), 'utf8')
}

function actionInput (overrides = {}) {
  return {
    deviceId: randomUUID(),
    visitId: randomUUID(),
    requestId: randomUUID(),
    action: 'steal',
    plotId: 'p1',
    ...overrides
  }
}

function actionResultInput (overrides = {}) {
  return {
    deviceId: randomUUID(),
    requestId: randomUUID(),
    ok: true,
    crop: 'tomato',
    qty: 1,
    ...overrides
  }
}

test('farm-action：只写 v/type/deviceId/visitId/requestId/action/plotId，解析后形状一致', () => {
  const input = actionInput({ deviceId: randomUUID().toUpperCase(), visitId: randomUUID().toUpperCase(), requestId: randomUUID().toUpperCase() })
  const data = encodeFarmAction(input)
  const raw = JSON.parse(data.toString('utf8'))
  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'visitId', 'requestId', 'action', 'plotId'])
  assert.equal(raw.deviceId, input.deviceId.toLowerCase())
  assert.equal(raw.visitId, input.visitId.toLowerCase())
  assert.equal(raw.requestId, input.requestId.toLowerCase())
  assert.equal(raw.action, 'steal')
  assert.equal(raw.plotId, 'p1')
  assert.ok(data.length < 300)
  assert.deepEqual(parsePacket(data), { ok: true, packet: raw })
})

test('farm-action：额外字段（昵称/端口/坐标/路径）全部丢弃', () => {
  const input = actionInput()
  const parsed = parsePacket(encodeJson({
    v: PROTOCOL_VERSION,
    type: 'farm-action',
    ...input,
    nickname: '伪造',
    port: 45871,
    path: '/Users/secret',
    x: 1,
    y: 2,
    coordinates: { x: 3, y: 4 }
  }))
  assert.equal(parsed.ok, true)
  assert.deepEqual(Object.keys(parsed.packet), [
    'v', 'type', 'deviceId', 'visitId', 'requestId', 'action', 'plotId'
  ])
  assert.equal(parsed.packet.nickname, undefined)
  assert.equal(parsed.packet.port, undefined)
  assert.equal(parsed.packet.path, undefined)
})

test('farm-action：坏 visitId/requestId/action/plotId 整包丢弃（固定 reason）', () => {
  const base = { v: PROTOCOL_VERSION, type: 'farm-action', ...actionInput() }
  assert.equal(parsePacket(encodeJson({ ...base, visitId: 'nope' })).reason, 'visit-id')
  assert.equal(parsePacket(encodeJson({ ...base, requestId: 'nope' })).reason, 'request-id')
  assert.equal(parsePacket(encodeJson({ ...base, action: 'rob' })).reason, 'action')
  assert.equal(parsePacket(encodeJson({ ...base, action: null })).reason, 'action')
  assert.equal(parsePacket(encodeJson({ ...base, plotId: 'p51' })).reason, 'plot-id')
  assert.equal(parsePacket(encodeJson({ ...base, plotId: '../p1' })).reason, 'plot-id')
  // 编码侧是本地程序错误：非法入参必须抛，不能悄悄发出去。
  for (const broken of [
    actionInput({ visitId: 'nope' }),
    actionInput({ requestId: 'nope' }),
    actionInput({ action: 'rob' }),
    actionInput({ plotId: 'p51' })
  ]) {
    assert.throws(() => encodeFarmAction(broken))
  }
})

test('farm-action-result：成功只带 crop/qty，caught 只在 true 时出现', () => {
  const input = actionResultInput()
  const data = encodeFarmActionResult(input)
  const raw = JSON.parse(data.toString('utf8'))
  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'requestId', 'ok', 'crop', 'qty'])
  assert.deepEqual(parsePacket(data), { ok: true, packet: raw })

  // caught 只能跟 guard 一起出现（成功结果没有 caught）。
  assert.throws(() => encodeFarmActionResult({ ...actionResultInput(), caught: true }))
  const caught = encodeFarmActionResult({
    ...actionResultInput({ ok: false }), error: 'guard', caught: true, crop: undefined, qty: undefined
  })
  assert.deepEqual(Object.keys(JSON.parse(caught.toString('utf8'))), [
    'v', 'type', 'deviceId', 'requestId', 'ok', 'error', 'caught'
  ])
})

test('farm-action-result：失败必须用固定错误枚举；caught 只能是布尔', () => {
  const input = actionResultInput({ ok: false, error: 'guard', caught: true, crop: undefined, qty: undefined })
  const data = encodeFarmActionResult(input)
  const raw = JSON.parse(data.toString('utf8'))
  assert.deepEqual(Object.keys(raw), ['v', 'type', 'deviceId', 'requestId', 'ok', 'error', 'caught'])
  assert.equal(raw.error, 'guard')
  assert.equal(raw.caught, true)
  assert.deepEqual(parsePacket(data), { ok: true, packet: raw })

  // 错误码是闭集，不转发任意文本。
  for (const error of ['boom', 'not-growing', '', null]) {
    assert.throws(() => encodeFarmActionResult({ ...actionResultInput({ ok: false }), error }))
  }
  assert.equal(FARM_ACTION_ERRORS.includes('guard'), true)
  assert.equal(FARM_ACTION_ERRORS.includes('caught'), false)
  assert.deepEqual(FARM_ACTION_KINDS, ['steal', 'help'])
  assert.equal(MAX_FARM_QTY, 1)
})

test('farm-action-result：坏 requestId/ok/crop/qty/caught 整包丢弃', () => {
  const base = { v: PROTOCOL_VERSION, type: 'farm-action-result', ...actionResultInput() }
  assert.equal(parsePacket(encodeJson({ ...base, requestId: 'nope' })).reason, 'request-id')
  assert.equal(parsePacket(encodeJson({ ...base, ok: 'yes' })).reason, 'ok')
  assert.equal(parsePacket(encodeJson({ ...base, crop: 'alien' })).reason, 'crop')
  assert.equal(parsePacket(encodeJson({ ...base, qty: 2 })).reason, 'qty')
  assert.equal(parsePacket(encodeJson({ ...base, qty: -1 })).reason, 'qty')
  assert.equal(parsePacket(encodeJson({ ...base, caught: 'yes' })).reason, 'caught')
  const failure = { ...base, ok: false }
  assert.equal(parsePacket(encodeJson({ ...failure, error: 'boom' })).reason, 'error')
  assert.equal(parsePacket(encodeJson({ ...failure, error: 'guard', caught: 'x' })).reason, 'caught')
  assert.equal(parsePacket(encodeJson({ ...failure, error: 'cap', caught: true })).reason, 'caught')
  assert.equal(parsePacket(encodeJson({ ...base, caught: true })).reason, 'caught')
})

test('旧邻居：不认识的新类型在解析层被静默丢弃（type），不崩', () => {
  const parsed = parsePacket(encodeJson({
    v: PROTOCOL_VERSION,
    type: 'farm-nope',
    deviceId: randomUUID(),
    nickname: '甲',
    port: 45871
  }))
  assert.deepEqual(parsed, { ok: false, reason: 'type' })
})

test('4 KiB 上限：farm 两个包都是几十字节，超限输入直接 too-large', () => {
  const action = encodeFarmAction(actionInput())
  const result = encodeFarmActionResult(actionResultInput())
  assert.ok(action.length < 300)
  assert.ok(result.length < 300)
  assert.equal(parsePacket(Buffer.alloc(MAX_PACKET_BYTES + 1, 0x61)).reason, 'too-large')
})
