/**
 * 票 107：LAN 真人资金流的纯规则（`src/board-flow.js`）。
 *
 * 只测数学/白名单/上限：冲击公式、2 小时半衰期、单笔/单根/单日/水平帽、
 * 去重与限速、同步窗口、自买自卖的往返净冲击。不碰磁盘、网络、时钟。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FLOW_DAY_CAP,
  FLOW_MAX_LEVEL,
  FLOW_MAX_TAPE,
  FLOW_SLOT_CAP,
  deviceImpactBetween,
  deviceSlotImpact,
  effectiveImpactOf,
  flowDirectionOf,
  flowEventsForView,
  flowEventsSince,
  flowEventView,
  flowLevelAt,
  flowNetBetween,
  impactOf,
  mergeFlowEvents,
  normalizeFlowEvent
} from '../src/board-flow.js'

const NOW = Date.UTC(2026, 10, 18, 5, 37, 25)
const MINUTE = 60 * 1000
const SLOT = 15 * MINUTE

function event (overrides = {}) {
  return {
    id: 'dev-a:1',
    deviceId: 'dev-a',
    at: NOW,
    crop: 'tomato',
    action: 'open',
    side: 'long',
    reason: 'manual',
    notional: 500,
    source: 'board',
    ...overrides
  }
}

test('票 107：方向只由 action + side 决定；单笔冲击封顶 0.6%', () => {
  assert.equal(flowDirectionOf({ action: 'open', side: 'long' }), 1)
  assert.equal(flowDirectionOf({ action: 'open', side: 'short' }), -1)
  assert.equal(flowDirectionOf({ action: 'close', side: 'long' }), -1)
  assert.equal(flowDirectionOf({ action: 'close', side: 'short' }), 1)
  assert.equal(flowDirectionOf({ action: 'nope', side: 'long' }), 0)

  assert.equal(impactOf({ action: 'open', side: 'long', notional: 500 }), 0.003)
  assert.ok(Math.abs(impactOf({ action: 'open', side: 'long', notional: 1250 }) - 0.003 * Math.sqrt(2.5)) < 1e-12)
  assert.equal(impactOf({ action: 'open', side: 'long', notional: 5000 }), 0.006)
  assert.equal(impactOf({ action: 'open', side: 'short', notional: 500 }), -0.003)
  assert.equal(impactOf({ action: 'open', side: 'long', notional: 0 }), 0)
  assert.equal(impactOf({ action: 'open', side: 'long', notional: 'x' }), 0)
})

test('票 107：白名单归一化丢坏字段，保留 reason/source 缺省', () => {
  const normalized = normalizeFlowEvent(event())
  assert.deepEqual(normalized, event())
  assert.equal(normalizeFlowEvent({ ...event(), notional: 0 }), null)
  assert.equal(normalizeFlowEvent({ ...event(), crop: '../etc' }), null)
  assert.equal(normalizeFlowEvent({ ...event(), id: '' }), null)
  assert.equal(normalizeFlowEvent({ ...event(), at: 0 }), null)
  assert.equal(normalizeFlowEvent(null), null)
  const fallback = normalizeFlowEvent({ ...event(), reason: 'nope', source: 'nope' })
  assert.equal(fallback.reason, 'manual')
  assert.equal(fallback.source, 'board')
})

test('票 107：资金流按 2 小时半衰期衰减，并夹在 ±1.5%', () => {
  const tape = [
    event({ id: 'a', at: NOW }),
    event({ id: 'b', at: NOW + 120 * MINUTE })
  ]
  const level0 = flowLevelAt({ events: tape, crop: 'tomato', minute: Math.floor(NOW / MINUTE) })
  assert.ok(Math.abs(level0 - 0.003) < 1e-12)
  const level120 = flowLevelAt({ events: tape, crop: 'tomato', minute: Math.floor((NOW + 120 * MINUTE) / MINUTE) })
  assert.ok(Math.abs(level120 - (0.003 * 0.5 + 0.003)) < 1e-12)
  // 别的作物不吃这条流。
  assert.equal(flowLevelAt({ events: tape, crop: 'carrot', minute: Math.floor(NOW / MINUTE) }), 0)
  // 大额/多条叠到水平帽。
  const many = Array.from({ length: 10 }, (_, index) => event({ id: 'x' + index, at: NOW }))
  assert.equal(flowLevelAt({ events: many, crop: 'tomato', minute: Math.floor(NOW / MINUTE) }), FLOW_MAX_LEVEL)
})

test('票 107：有效贡献在水平帽处只补到帽子上', () => {
  const tape = Array.from({ length: 3 }, (_, index) => event({ id: 'p' + index, at: NOW, notional: 500 }))
  // 3 × 0.003 = 0.009；再 0.006 只到 0.015。
  const minute = Math.floor(NOW / MINUTE)
  const before = flowLevelAt({ events: tape, crop: 'tomato', minute })
  const effective = effectiveImpactOf({
    events: tape,
    crop: 'tomato',
    minute,
    event: event({ id: 'new', at: NOW, notional: 5000 })
  })
  assert.ok(Math.abs(before + effective - FLOW_MAX_LEVEL) < 1e-12)
})

test('票 107：自买自卖的往返净冲击为 0', () => {
  const open = event({ id: 'open', at: NOW, action: 'open', side: 'long', notional: 1250 })
  const close = event({ id: 'close', at: NOW, action: 'close', side: 'long', notional: 1250 })
  const tape = [open, close]
  const minute = Math.floor(NOW / MINUTE)
  assert.ok(Math.abs(flowLevelAt({ events: tape, crop: 'tomato', minute })) < 1e-12)
  assert.ok(Math.abs(flowNetBetween({ tape, crop: 'tomato', from: NOW, to: NOW + 1 })) < 1e-12)
})

test('票 107：merge 去重、实时窗口、同步窗口、限速与单根/单日上限', () => {
  const at = NOW
  const one = event({ id: 'a:1', at })
  const merged = mergeFlowEvents({ tape: [], incoming: [one, one], now: at, mode: 'live' })
  assert.equal(merged.accepted.length, 1)
  assert.equal(merged.rejected, 1)
  assert.equal(merged.tape.length, 1)

  // 实时窗口外的事件丢掉；同步模式收。
  const late = event({ id: 'a:2', at: at - 20 * 1000 })
  assert.equal(mergeFlowEvents({ tape: [], incoming: [late], now: at, mode: 'live' }).accepted.length, 0)
  assert.equal(mergeFlowEvents({ tape: [], incoming: [late], now: at, mode: 'sync' }).accepted.length, 1)

  // 限速：小额的 7 条，一分钟最多 6 条。
  const tiny = Array.from({ length: 7 }, (_, index) => event({
    id: 'r:' + index,
    at,
    notional: 5
  }))
  const rate = mergeFlowEvents({ tape: [], incoming: tiny, now: at, mode: 'live' })
  assert.equal(rate.accepted.length, 6)
  assert.equal(rate.rejected, 1)

  // 单根上限 1.2%：0.003 × 5 = 0.015，第 5 条只到 0.012 之前，收 4 条。
  const big = Array.from({ length: 5 }, (_, index) => event({
    id: 's:' + index,
    at,
    notional: 500
  }))
  const slot = mergeFlowEvents({ tape: [], incoming: big, now: at, mode: 'live' })
  assert.equal(slot.accepted.length, 4)
  assert.ok(deviceImpactBetween(slot.tape, 'dev-a', at - 1, at + 1) <= FLOW_SLOT_CAP + 1e-12)
  assert.ok(deviceSlotImpact({ tape: slot.tape, deviceId: 'dev-a', crop: 'tomato', at }) <= FLOW_SLOT_CAP + 1e-12)

  // 单日上限 4%：跨多根的 0.003 事件，收到第 13 条后不能再收。
  const day = Array.from({ length: 15 }, (_, index) => event({
    id: 'd:' + index,
    at: at - index * SLOT - 60 * 1000,
    notional: 500
  }))
  const daily = mergeFlowEvents({ tape: [], incoming: day, now: at, mode: 'sync' })
  assert.ok(deviceImpactBetween(daily.tape, 'dev-a', at - 24 * 60 * MINUTE, at + 1) <= FLOW_DAY_CAP + 1e-12)
  assert.ok(daily.accepted.length < 15)
})

test('票 107：tape 只留 24 小时/最多 500 条；sync 按 since 返回', () => {
  const old = event({ id: 'old', at: NOW - 25 * 60 * MINUTE })
  const fresh = event({ id: 'fresh', at: NOW })
  const merged = mergeFlowEvents({ tape: [old, fresh], incoming: [], now: NOW, mode: 'sync' })
  assert.deepEqual(merged.tape.map((entry) => entry.id), ['fresh'])

  const many = Array.from({ length: FLOW_MAX_TAPE + 20 }, (_, index) => event({
    id: 'm:' + index,
    at: NOW - (FLOW_MAX_TAPE + 19 - index) * MINUTE,
    notional: 5
  }))
  const pruned = mergeFlowEvents({ tape: [], incoming: many, now: NOW, mode: 'sync' })
  assert.ok(pruned.tape.length <= FLOW_MAX_TAPE)

  const since = flowEventsSince({ tape: pruned.tape, since: NOW - 24 * 60 * MINUTE, limit: 16 })
  assert.ok(since.length <= 16)
  assert.ok(since.length > 0)
  assert.ok(since.every((entry) => entry.at >= NOW - 24 * 60 * MINUTE))

  const view = flowEventsForView({ tape: pruned.tape, crop: 'tomato', from: NOW - 24 * 60 * MINUTE, to: NOW + 1, limit: 5 })
  assert.ok(view.length > 0 && view.length <= 5)
  assert.ok(view.every((entry) => entry.at >= NOW - 24 * 60 * MINUTE))
  assert.equal(flowEventView(view[0]).crop, undefined)
  assert.ok(Number.isFinite(flowEventView(view[0]).impact))
})
