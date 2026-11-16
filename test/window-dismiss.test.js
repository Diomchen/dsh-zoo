/**
 * 票 85：点窗口外面收起所有插件窗（ADR-0029）的判定表。
 *
 * 这里只测纯函数；真正的 200ms 计时器/`BrowserWindow.getFocusedWindow()` 只有 Electron 里
 * 才能跑（`npm run smoke:desktop` 覆盖），静态接线窄口在 `test/desktop.test.js`。判定表覆盖
 * 验收里的每一条：外部焦点收起、另一扇插件窗有焦点不关、输入法合成不关、冒烟锁不关、
 * 退出不关、计时未到不关。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { DISMISS_DELAY_MS, shouldDismissOnBlur } = require('../desktop/window-dismiss.js')

const BASE = {
  focusedId: null,
  pluginIds: [11, 22],
  composing: false,
  locked: false,
  quitting: false,
  blurAgeMs: DISMISS_DELAY_MS
}

function decide (patch = {}) {
  return shouldDismissOnBlur({ ...BASE, ...patch })
}

test('票 85：失焦够久且焦点在桌面/别的应用 → 收起所有插件窗', () => {
  assert.equal(DISMISS_DELAY_MS, 200)
  assert.equal(decide(), true)
  assert.equal(decide({ focusedId: 99 }), true, '焦点在非插件窗口（桌面/别的应用）')
  assert.equal(decide({ focusedId: undefined }), true, '没有焦点窗口')
})

test('票 85：焦点还在任一插件窗 → 不收起（从盘口点到农场不算点外面）', () => {
  assert.equal(decide({ focusedId: 22 }), false, '另一扇插件窗拿到焦点')
  assert.equal(decide({ focusedId: 11 }), false, '刚失焦的那扇自己抢回焦点')
  assert.equal(decide({ focusedId: 33 }), true, '不在打开列表里的窗口不算')
})

test('票 85：输入法合成 / 冒烟锁 / 退出 → 不收起', () => {
  assert.equal(decide({ composing: true }), false)
  assert.equal(decide({ locked: true }), false)
  assert.equal(decide({ quitting: true }), false)
  // 三个例外同时命中也不能“互相抵消”成收起。
  assert.equal(decide({ composing: true, locked: true, quitting: true }), false)
})

test('票 85：200ms 计时未到不收起；坏时间戳按不收起处理', () => {
  assert.equal(decide({ blurAgeMs: 0 }), false)
  assert.equal(decide({ blurAgeMs: DISMISS_DELAY_MS - 1 }), false)
  assert.equal(decide({ blurAgeMs: DISMISS_DELAY_MS }), true)
  assert.equal(decide({ blurAgeMs: Number.NaN }), false)
  assert.equal(decide({ blurAgeMs: Number.POSITIVE_INFINITY }), false)
  assert.equal(decide({ blurAgeMs: '200' }), false)
  assert.equal(decide({ blurAgeMs: undefined }), false)
})

test('票 85：没有插件窗/坏 id 列表时不安排收起', () => {
  assert.equal(decide({ pluginIds: [] }), false)
  assert.equal(decide({ pluginIds: null }), false)
  assert.equal(decide({ pluginIds: ['11', Number.NaN, 11] }), true, '坏 id 过滤后还剩 11')
  assert.equal(decide({ pluginIds: ['11', Number.NaN] }), false)
})
