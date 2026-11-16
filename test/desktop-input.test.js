import assert from 'node:assert/strict'
import test from 'node:test'

import shared from '../desktop/shared.js'

/**
 * ticket 30：现场「窗口显示可交互、真实左键却进不了渲染端」没有可观测信号——
 * `ignoring=false` 只说明穿透摘了，`busy=false` 只说明租约没立。渲染端只对 `isTrusted`
 * 的按下计数，主进程放进 status，宿主再原样透出；这条路每一层都是白名单。
 */

test('可信输入上报：只认 down / up', () => {
  assert.deepEqual(shared.normalizeInputReport({ type: 'down' }), { type: 'down' })
  assert.deepEqual(shared.normalizeInputReport({ type: 'up' }), { type: 'up' })
})

test('可信输入上报：坏形状一律当没报，不抛', () => {
  assert.equal(shared.normalizeInputReport({ type: 'move' }), null)
  assert.equal(shared.normalizeInputReport({ type: 1 }), null)
  assert.equal(shared.normalizeInputReport('down'), null)
  assert.equal(shared.normalizeInputReport(null), null)
  assert.equal(shared.normalizeInputReport([]), null)
})

test('status 事件：可信输入计数穿过宿主白名单（别又削掉）', () => {
  const parsed = shared.normalizeHelperEvent({
    type: 'status',
    id: 1,
    trustedInputs: 3,
    lastTrustedInputAgeMs: 120
  })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.event.status.trustedInputs, 3)
  assert.equal(parsed.event.status.lastTrustedInputAgeMs, 120)
})

test('宿主命令：debug-kick-input 能被解析（不重启的输入态重置）', () => {
  const parsed = shared.normalizeHostCommand({ type: 'debug-kick-input', id: 'k1' })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.command.type, 'debug-kick-input')
  assert.equal(parsed.command.id, 'k1')
})

/**
 * 票 76：Windows 上「可交互」会粘住 —— 窗口自称可交互、真实左键却进不来，一直卡到一次
 * 真正的 true→false 翻转或 helper 重启。修法有两半：定时把同一个值重放给 native 层，
 * 以及渲染端发现「只有 up、没有 down」时让主进程立刻重放一次。
 */

test('可信输入上报：lost-down（只有 up、没有 down）也认', () => {
  assert.deepEqual(shared.normalizeInputReport({ type: 'lost-down' }), { type: 'lost-down' })
})

test('status 事件：丢 down / 重放 / 窗口消息计数穿过宿主白名单', () => {
  const parsed = shared.normalizeHelperEvent({
    type: 'status',
    id: 7,
    lostDowns: 2,
    lastLostDownAgeMs: 340,
    reasserts: 11,
    windowMessages: { leftDown: 5, leftUp: 5, rightDown: 1, rightUp: 1 }
  })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.event.status.lostDowns, 2)
  assert.equal(parsed.event.status.lastLostDownAgeMs, 340)
  assert.equal(parsed.event.status.reasserts, 11)
  assert.deepEqual(parsed.event.status.windowMessages, {
    leftDown: 5,
    leftUp: 5,
    rightDown: 1,
    rightUp: 1
  })
})

test('status 事件：没有窗口消息字段时给全零，不漏形状', () => {
  const parsed = shared.normalizeHelperEvent({ type: 'status', id: 8 })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.event.status.lostDowns, 0)
  assert.equal(parsed.event.status.lastLostDownAgeMs, null)
  assert.equal(parsed.event.status.reasserts, 0)
  assert.deepEqual(parsed.event.status.windowMessages, {
    leftDown: 0,
    leftUp: 0,
    rightDown: 0,
    rightUp: 0
  })
})

test('窗口消息计数：负数/非整数一律当 0，不把坏数据放进 status', () => {
  const parsed = shared.normalizeHelperEvent({
    type: 'status',
    id: 9,
    windowMessages: { leftDown: -3, leftUp: 1.5, rightDown: 'x', rightUp: 4 }
  })

  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.event.status.windowMessages, {
    leftDown: 0,
    leftUp: 0,
    rightDown: 0,
    rightUp: 4
  })
})

test('重放判定：只在可交互时重放，按间隔来，时钟回拨也算到点', () => {
  const interval = shared.INTERACTIVE_REASSERT_MS

  // 穿透态不重放：它本来就不接输入。
  assert.equal(shared.shouldReassert({ ignoring: true, now: 10_000, lastAt: 0 }), false)
  // 刚翻成可交互（还没重放过）就压实一次。
  assert.equal(shared.shouldReassert({ ignoring: false, now: 10_000, lastAt: 0 }), true)
  // 没到间隔：不动。
  assert.equal(shared.shouldReassert({ ignoring: false, now: 10_000, lastAt: 10_000 - interval + 1 }), false)
  // 到点：重放。
  assert.equal(shared.shouldReassert({ ignoring: false, now: 10_000, lastAt: 10_000 - interval }), true)
  // 时钟回拨：宁可多重放一次，也不要让窗口卡在假可交互。
  assert.equal(shared.shouldReassert({ ignoring: false, now: 9_000, lastAt: 10_000 }), true)
  // now 不是有限数字：不冒险。
  assert.equal(shared.shouldReassert({ ignoring: false, now: NaN, lastAt: 0 }), false)
})

test('丢 down 自愈的冷却必须是正数（主进程按它节流）', () => {
  assert.equal(Number.isInteger(shared.LOST_DOWN_HEAL_COOLDOWN_MS), true)
  assert.equal(shared.LOST_DOWN_HEAL_COOLDOWN_MS > 0, true)
})
