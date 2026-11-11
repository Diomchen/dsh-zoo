/**
 * 票 51：`caps`、`visit-request` 的 `purpose`/`plots`、`visit-ack` 的 `raid`。
 *
 * 三条约定：
 *   - `caps` 是能力声明，只认已知项；坏项/重复项只丢自己，不整包丢。
 *   - `plots` 是**请求**（我要偷哪几块），坏地块只丢那一项；`purpose` 只认 `'steal'`。
 *   - `raid` 是**回执**：stolen 里坏作物只丢那一条，`caught`/`skipped` 有上限。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PROTOCOL_VERSION, encodePacket, parsePacket } from '../src/protocol.js'

const DEVICE = '11111111-1111-4111-8111-111111111111'
const VISIT = '22222222-2222-4222-8222-222222222222'

function beacon (extra = {}) {
  return parsePacket(encodePacket({
    type: 'beacon',
    deviceId: DEVICE,
    nickname: '小黄',
    port: 45871,
    ...extra
  })).packet
}

function visitRequest (extra = {}) {
  return parsePacket(encodePacket({
    type: 'visit-request',
    deviceId: DEVICE,
    visitId: VISIT,
    nickname: '小黄',
    anim: '东张西望',
    ...extra
  })).packet
}

test('caps：只认已知能力，重复与未知项只丢自己', () => {
  assert.deepEqual(beacon({ caps: ['raid', 'look'] }).caps, ['raid', 'look'])
  assert.deepEqual(beacon({ caps: ['look', 'raid', 'raid', 'nope'] }).caps, ['look', 'raid'])
  assert.equal(beacon({ caps: [] }).caps, undefined, '空的 caps 不带这个字段')
  assert.equal(beacon({ caps: ['nope'] }).caps, undefined)
  assert.equal(beacon({ caps: 'raid' }).caps, undefined, '不是数组就当没有')
  assert.equal(beacon().caps, undefined, '老版本没这个字段')
})

test('caps：心跳也带，且不超过 4 项', () => {
  const packet = parsePacket(encodePacket({
    type: 'heartbeat',
    deviceId: DEVICE,
    anim: '待机',
    caps: ['raid', 'look']
  })).packet
  assert.deepEqual(packet.caps, ['raid', 'look'])

  const many = parsePacket(Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'heartbeat',
    deviceId: DEVICE,
    anim: '待机',
    caps: ['raid', 'look', 'raid', 'look', 'raid']
  }), 'utf8')).packet
  assert.deepEqual(many.caps, ['raid', 'look'], '重复项先去重，最多 4 项')
})

test('visit-request 带 purpose 与 plots：坏地块只丢自己', () => {
  const packet = visitRequest({ purpose: 'steal', plots: ['p2', 'p1', 'p2', 'pX', 'p99'] })
  assert.equal(packet.purpose, 'steal')
  assert.deepEqual(packet.plots, ['p2', 'p1'], '去重、丢掉非法、保留顺序')

  assert.equal(visitRequest().purpose, undefined, '普通串门不带 purpose')
  assert.equal(visitRequest({ purpose: 'borrow' }).purpose, undefined, '只认 steal')
  assert.equal(visitRequest({ plots: ['p1'] }).plots, undefined, '没有 purpose 就不该有 plots')
})

test('visit-request 的 plots 最多 50 块', () => {
  const many = Array.from({ length: 60 }, (_, index) => `p${index + 1}`)
  const packet = visitRequest({ purpose: 'steal', plots: many })
  assert.equal(packet.plots.length, 50)
  assert.equal(packet.plots[49], 'p50')
})

test('visit-ack 带 raid 回执：坏作物丢那一条，其余保留', () => {
  const packet = parsePacket(encodePacket({
    type: 'visit-ack',
    deviceId: DEVICE,
    visitId: VISIT,
    raid: {
      stolen: [{ plot: 'p1', crop: 'tomato' }, { plot: 'p2', crop: 'banana' }, { plot: 'p3', crop: 'carrot' }],
      caught: 1,
      skipped: ['p4', 'pX']
    }
  })).packet
  assert.deepEqual(packet.raid.stolen, [
    { plot: 'p1', crop: 'tomato' },
    { plot: 'p3', crop: 'carrot' }
  ])
  assert.equal(packet.raid.caught, 1)
  assert.deepEqual(packet.raid.skipped, ['p4'])

  const plain = parsePacket(encodePacket({ type: 'visit-ack', deviceId: DEVICE, visitId: VISIT })).packet
  assert.equal(plain.raid, undefined, '没有结果的 ack 还是老样子')
})

test('visit-ack 的 raid 是敌意输入：形状不对就当没有', () => {
  const hostile = (raid) => parsePacket(Buffer.from(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'visit-ack',
    deviceId: DEVICE,
    visitId: VISIT,
    raid
  }), 'utf8')).packet.raid

  assert.equal(hostile('nope'), undefined)
  assert.equal(hostile({ stolen: 'nope' }), undefined)
  assert.deepEqual(hostile({ stolen: [], caught: -5, skipped: [] }), { stolen: [], caught: 0, skipped: [] })
  assert.deepEqual(hostile({ stolen: [], caught: 999, skipped: [] }), { stolen: [], caught: 50, skipped: [] })
})
