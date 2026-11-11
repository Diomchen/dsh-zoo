/**
 * 交易所一行的纯模型（desktop/farm-view.js 的 tradeView）。
 *
 * 这里锁的是「按钮为什么不能点」：窗口以前只把买卖按钮灰掉，而灰掉的按钮和可点的
 * 长得一样，点下去不发申请也不给提示——用户看到的就是「交易所坏了」。
 * 模型必须同时给出 canBuy/canSell 和一句人话原因，DOM 只负责画。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const view = require('../desktop/farm-view.js')

const farm = (overrides = {}) => ({
  coins: 30,
  seeds: { tomato: 0, carrot: 0, pumpkin: 0 },
  crops: { tomato: 4, carrot: 0, pumpkin: 0 },
  ...overrides
})

const market = (overrides = {}) => ({
  prices: {
    tomato: { base: 5, price: 5, bid: 4 },
    carrot: { base: 6, price: 5, bid: 5 },
    pumpkin: { base: 30, price: 27, bid: 27 }
  },
  ...overrides
})

test('买得起也卖得掉：总价按种子价与 bid 算，提示为空', () => {
  const row = view.tradeView(farm(), market(), 'tomato', 1)
  assert.equal(row.canBuy, true)
  assert.equal(row.canSell, true)
  assert.equal(row.seedTotal, 6)
  assert.equal(row.sellTotal, 4)
  assert.equal(row.buyHint, '')
  assert.equal(row.sellHint, '')
})

test('硬币不够：按钮不可点，原因写明差多少（南瓜 36 > 30）', () => {
  const row = view.tradeView(farm(), market(), 'pumpkin', 1)
  assert.equal(row.canBuy, false)
  assert.equal(row.buyHint, '硬币还差 6（需要 36）')
  assert.equal(row.buyShort, '差 6 硬币', '按钮上的短标签也要说明原因')
  assert.equal(row.maxBuy, 0)
})

test('数量买得起但仓库上限不够：种子最多 999', () => {
  const row = view.tradeView(farm({ seeds: { tomato: 998, carrot: 0, pumpkin: 0 } }), market(), 'tomato', 2)
  assert.equal(row.canBuy, false)
  assert.match(row.buyHint, /种子最多 999 颗/)
})

test('没有可卖的：胡萝卜 0 个', () => {
  const row = view.tradeView(farm(), market(), 'carrot', 1)
  assert.equal(row.canSell, false)
  assert.equal(row.sellHint, '仓库里还没有胡萝卜')
  assert.equal(row.sellShort, '没有可卖的')
})

test('卖超了：仓库只有 4 个小番茄', () => {
  const row = view.tradeView(farm(), market(), 'tomato', 5)
  assert.equal(row.canSell, false)
  assert.equal(row.sellHint, '仓库只有 4 个小番茄')
  assert.equal(row.sellShort, '只有 4 个')
})

test('数量越界或不是整数：两边都不能点，原因是数量', () => {
  for (const qty of [0, -1, 100, 1.5, NaN, '']) {
    const row = view.tradeView(farm(), market(), 'tomato', qty)
    assert.equal(row.valid, false, 'qty=' + String(qty))
    assert.equal(row.canBuy, false)
    assert.equal(row.canSell, false)
    assert.match(row.buyHint, /数量要在 1–99 之间/)
    assert.match(row.sellHint, /数量要在 1–99 之间/)
    assert.equal(row.buyShort, '数量 1–99')
    assert.equal(row.sellShort, '数量 1–99')
  }
})

test('maxBuy 同时受硬币、999 上限与 99 约束；maxSell 受仓库约束', () => {
  assert.equal(view.tradeView(farm(), market(), 'tomato', 1).maxBuy, 5, '30 硬币 / 6 = 5 颗')
  assert.equal(view.tradeView(farm({ coins: 999999 }), market(), 'tomato', 1).maxBuy, 99)
  assert.equal(
    view.tradeView(farm({ coins: 999999, seeds: { tomato: 995, carrot: 0, pumpkin: 0 } }), market(), 'tomato', 1).maxBuy,
    4
  )
  assert.equal(view.tradeView(farm(), market(), 'tomato', 1).maxSell, 4)
  assert.equal(view.tradeView(farm({ crops: { tomato: 500, carrot: 0, pumpkin: 0 } }), market(), 'tomato', 1).maxSell, 99)
})

test('宿主数据缺席时不炸：bid 退回 base×0.9，硬币/种子/作物都按 0', () => {
  const row = view.tradeView(null, null, 'tomato', 1)
  // 没有行情时退回 base×0.9：小番茄 base 5 → round(4.5) = 5（与旧 bidOf 同一口径）。
  assert.equal(row.bid, 5)
  assert.equal(row.coins, 0)
  assert.equal(row.seeds, 0)
  assert.equal(row.crops, 0)
  assert.equal(row.canBuy, false)
  assert.equal(row.canSell, false)
  assert.equal(view.tradeView(farm(), market(), 'alien', 1), null)
})
