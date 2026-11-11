/**
 * 动作白名单的形状检查。
 *
 * `desktop/shared.js` 的 `FARM_ACTIONS` 是从几个数组 concat 出来的；曾经误把
 * `normalizeFarmLook` / `normalizeNeighborChips` 两个函数也拼进去（还重复拼了一次
 * `FARM_LOOK_ACTIONS`）。`.includes('farm-buy-seed')` 照样返回 true，所以功能测试全绿，
 * 但白名单里混进函数是定时炸弹：任何遍历/序列化/拼日志的地方都会炸。
 *
 * 这里只断言「白名单里的每一条都是非空字符串、没有重复」，交易所两条必须还在。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const shared = require('../desktop/shared.js')

test('FARM_ACTIONS 只装动作名：非空字符串、不重复、交易所两条还在', () => {
  assert.ok(Array.isArray(shared.FARM_ACTIONS))
  for (const action of shared.FARM_ACTIONS) {
    assert.equal(typeof action, 'string', '白名单里混进了非字符串：' + String(action))
    assert.ok(action.trim() !== '', '白名单里不该有空动作')
  }
  assert.equal(new Set(shared.FARM_ACTIONS).size, shared.FARM_ACTIONS.length, '白名单不应有重复')
  for (const action of ['farm-buy-seed', 'farm-sell-crop', 'hire', 'hire-listing', 'farm-look', 'farm-raid', 'farm-unlock']) {
    assert.ok(shared.FARM_ACTIONS.includes(action), action + ' 应该在 FARM_ACTIONS 里')
  }
})

test('CONTROL_ACTIONS / DESKTOP_ACTIONS / MENU_ACTION_IDS 同样只装字符串', () => {
  for (const [name, list] of [
    ['CONTROL_ACTIONS', shared.CONTROL_ACTIONS],
    ['DESKTOP_ACTIONS', shared.DESKTOP_ACTIONS],
    ['MENU_ACTION_IDS', shared.MENU_ACTION_IDS]
  ]) {
    assert.ok(Array.isArray(list), name + ' 应该是数组')
    for (const entry of list) assert.equal(typeof entry, 'string', name + ' 里混进了非字符串')
  }
})
