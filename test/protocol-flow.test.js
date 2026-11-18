/**
 * 票 107：board-flow / board-flow-sync 的协议边界。
 *
 * 事件里没有「影响多少」——只有 action/side/notional；接收端用同一套
 * `src/board-flow.js` 现算。事件里的 deviceId 一律盖成包上的发送端。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_PACKET_BYTES,
  encodeBoardFlow,
  encodeBoardFlowSync,
  parsePacket
} from '../src/protocol.js'

const DEVICE = '3f0f2a1c-1d2e-4b3a-8c9d-0e1f2a3b4c5d'
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const AT = 1763308800000

function event (overrides = {}) {
  return {
    id: 'flow:1',
    deviceId: OTHER,
    at: AT,
    crop: 'tomato',
    action: 'open',
    side: 'long',
    reason: 'manual',
    notional: 500,
    source: 'board',
    ...overrides
  }
}

test('票 107：board-flow 编码/解析，事件 deviceId 盖成发送端', () => {
  const data = encodeBoardFlow({ deviceId: DEVICE, at: AT, events: [event()] })
  assert.ok(Buffer.byteLength(data, 'utf8') < MAX_PACKET_BYTES)
  const parsed = parsePacket(data, { now: AT })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.packet.type, 'board-flow')
  assert.equal(parsed.packet.deviceId, DEVICE)
  assert.equal(parsed.packet.sync, false)
  assert.equal(parsed.packet.events.length, 1)
  assert.equal(parsed.packet.events[0].deviceId, DEVICE)
  assert.equal(parsed.packet.events[0].notional, 500)
})

test('票 107：坏事件丢自己；最多 16 条；sync 标志保留', () => {
  const events = Array.from({ length: 20 }, (_, index) => event({ id: 'f:' + index }))
  events.push({ id: '', at: AT })
  const data = encodeBoardFlow({ deviceId: DEVICE, at: AT, events, sync: true })
  const parsed = parsePacket(data, { now: AT })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.packet.events.length, 16)
  assert.equal(parsed.packet.sync, true)
  assert.ok(parsed.packet.events.every((entry) => entry.id !== ''))
  assert.ok(parsed.packet.events.every((entry) => entry.deviceId === DEVICE))
})

test('票 107：board-flow-sync 请求带 since；坏 since/at 整包丢', () => {
  const data = encodeBoardFlowSync({ deviceId: DEVICE, at: AT, since: AT - 60_000 })
  const parsed = parsePacket(data, { now: AT })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.packet.type, 'board-flow-sync')
  assert.equal(parsed.packet.since, AT - 60_000)

  const badSince = JSON.parse(data)
  badSince.since = -1
  assert.equal(parsePacket(JSON.stringify(badSince), { now: AT }).ok, false)

  const badAt = JSON.parse(data)
  badAt.at = 'nope'
  assert.equal(parsePacket(JSON.stringify(badAt), { now: AT }).ok, false)
})

test('票 107：空 board-flow 合法（同步没货时回空包）', () => {
  const data = encodeBoardFlow({ deviceId: DEVICE, at: AT, events: [] })
  const parsed = parsePacket(data, { now: AT })
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.packet.events, [])
})
