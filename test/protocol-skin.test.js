import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  MAX_SAY,
  SAY_MAX_AGE_MS,
  SEMANTIC_TAGS,
  encodeHeartbeat,
  encodePacket,
  encodeVisitRequest,
  parsePacket
} from '../src/protocol.js'

const NOW = 1_700_000_000_000

function parse (data, now = NOW) {
  const result = parsePacket(data, { now })
  assert.equal(result.ok, true, result.reason)
  return result.packet
}

test('heartbeat 往返：action / semantic / say / skin 引用都在', () => {
  const deviceId = randomUUID()
  const data = encodeHeartbeat({
    deviceId,
    anim: '东张西望',
    action: '写代码',
    semantic: 'working',
    say: { text: '在写代码', until: NOW + 5000 },
    skinPort: 45873,
    skinId: 'dsh-pet',
    now: NOW
  })

  assert.deepEqual(parse(data), {
    v: 1,
    type: 'heartbeat',
    deviceId,
    anim: '东张西望',
    action: '写代码',
    semantic: 'working',
    say: { text: '在写代码', until: NOW + 5000 },
    skinPort: 45873,
    skinId: 'dsh-pet'
  })
})

test('visit-request 往返：串门请求也带得动 skin 与状态', () => {
  const deviceId = randomUUID()
  const visitId = randomUUID()
  const data = encodeVisitRequest({
    deviceId,
    visitId,
    nickname: '柯基',
    anim: '打瞌睡',
    action: '打瞌睡',
    semantic: 'sleeping',
    say: { text: '困了', until: NOW + 1000 },
    skinPort: 45873,
    skinId: 'corgi',
    now: NOW
  })

  assert.deepEqual(parse(data), {
    v: 1,
    type: 'visit-request',
    deviceId,
    visitId,
    nickname: '柯基',
    anim: '打瞌睡',
    action: '打瞌睡',
    semantic: 'sleeping',
    say: { text: '困了', until: NOW + 1000 },
    skinPort: 45873,
    skinId: 'corgi'
  })
})

test('beacon 往返：skinPort / skinId 可选', () => {
  const deviceId = randomUUID()
  const data = encodePacket({
    type: 'beacon',
    deviceId,
    nickname: '蓝毛小女仆',
    port: 45871,
    skinPort: 45873,
    skinId: 'dsh-pet'
  })

  assert.deepEqual(parse(data), {
    v: 1,
    type: 'beacon',
    deviceId,
    nickname: '蓝毛小女仆',
    port: 45871,
    skinPort: 45873,
    skinId: 'dsh-pet'
  })
})

test('旧报文（只有 anim）解析后不会多出任何新字段', () => {
  const deviceId = randomUUID()
  const packet = parse(encodeHeartbeat({ deviceId, anim: null }))
  assert.deepEqual(Object.keys(packet).sort(), ['anim', 'deviceId', 'type', 'v'])
  assert.equal(packet.anim, null)
})

test('未知字段在解析时被丢弃', () => {
  const deviceId = randomUUID()
  const raw = JSON.stringify({
    v: 1,
    type: 'heartbeat',
    deviceId,
    anim: '东张西望',
    action: '东张西望',
    evil: 'x',
    nested: { a: 1 }
  })
  const packet = parse(raw)
  assert.deepEqual(Object.keys(packet).sort(), ['action', 'anim', 'deviceId', 'type', 'v'])
  assert.equal(packet.evil, undefined)
  assert.equal(packet.nested, undefined)
})

test('say 文本清洗、截断与 until 封顶', () => {
  const deviceId = randomUUID()
  const longText = '字'.repeat(MAX_SAY + 20)
  const raw = JSON.stringify({
    v: 1,
    type: 'heartbeat',
    deviceId,
    anim: null,
    say: { text: '\u0000' + longText + '\n', until: NOW + SAY_MAX_AGE_MS * 10 }
  })
  const packet = parse(raw)
  assert.equal(Array.from(packet.say.text).length, MAX_SAY)
  assert.equal(packet.say.text.includes('\u0000'), false)
  assert.equal(packet.say.until, NOW + SAY_MAX_AGE_MS)
})

test('过期或坏掉的 say 整条丢弃，但心跳照收', () => {
  const deviceId = randomUUID()
  for (const say of [
    { text: '过期了', until: NOW - 1 },
    { text: '', until: NOW + 1000 },
    { text: 42, until: NOW + 1000 },
    { text: '没有 until' },
    { text: 'x'.repeat(10), until: 'soon' }
  ]) {
    const raw = JSON.stringify({ v: 1, type: 'heartbeat', deviceId, anim: '东张西望', say })
    const packet = parse(raw)
    assert.equal(packet.say, undefined)
    assert.equal(packet.anim, '东张西望')
  }
})

test('非法的 action / semantic / skin 字段各自丢弃，不整包丢', () => {
  const deviceId = randomUUID()
  const raw = JSON.stringify({
    v: 1,
    type: 'heartbeat',
    deviceId,
    anim: '东张西望',
    action: '../evil',
    semantic: 'nope',
    skinPort: 99999,
    skinId: '../evil'
  })
  const packet = parse(raw)
  assert.equal(packet.anim, '东张西望')
  assert.equal(packet.action, undefined)
  assert.equal(packet.semantic, undefined)
  assert.equal(packet.skinPort, undefined)
  assert.equal(packet.skinId, undefined)
})

test('常量与语义枚举固定', () => {
  assert.equal(MAX_SAY, 80)
  assert.equal(SAY_MAX_AGE_MS, 30000)
  assert.deepEqual([...SEMANTIC_TAGS].sort(), ['eating', 'idle', 'other', 'sleeping', 'working'])
})
