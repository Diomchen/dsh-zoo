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
