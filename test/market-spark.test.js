import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const view = require('../desktop/farm-view.js')

const HOUR = 60 * 60 * 1000
const NOW = 1_800_000_000_000

test('marketSpark：只取这个作物最近 24 小时的成交，再补当前卖价', () => {
  const spark = view.marketSpark([
    { crop: 'tomato', price: 5, at: NOW - HOUR },
    { crop: 'tomato', price: 4, at: NOW - 2 * HOUR },
    { crop: 'tomato', price: 99, at: NOW - 30 * HOUR },
    { crop: 'carrot', price: 8, at: NOW - HOUR }
  ], 'tomato', { now: NOW, currentPrice: 6 })

  assert.equal(spark.empty, false)
  assert.equal(spark.trend, 'up')
  assert.equal(spark.min, 4)
  assert.equal(spark.max, 6)
  assert.equal(spark.points.length, 3)
  assert.equal(spark.points[0].price, 4)
  assert.equal(spark.points[2].price, 6)
  assert.deepEqual(spark.marks.map((mark) => [mark.at, mark.price, mark.current]), [
    [NOW - 2 * HOUR, 4, false],
    [NOW - HOUR, 5, false],
    [NOW, 6, true]
  ])
  assert.match(spark.path, /^0\.00,\d+\.\d+ 50\.00,\d+\.\d+ 100\.00,/)
})

test('marketSpark：没有成交时返回空曲线，但保留当前卖价的水平线', () => {
  const spark = view.marketSpark([], 'tomato', { now: NOW, currentPrice: 6 })
  assert.equal(spark.empty, true)
  assert.equal(spark.trend, 'flat')
  assert.equal(spark.path, '0.00,12.00 100.00,12.00')
  assert.equal(spark.points.length, 2)
  assert.equal(spark.marks.length, 0)
})

test('marketSpark：只有一笔成交时保留成交点和当前卖价', () => {
  const spark = view.marketSpark([
    { crop: 'rice', price: 12, at: NOW - HOUR }
  ], 'rice', { now: NOW, currentPrice: 12 })
  assert.equal(spark.empty, false)
  assert.equal(spark.trend, 'flat')
  assert.equal(spark.points.length, 2)
  assert.equal(spark.points[0].at, NOW - HOUR)
  assert.equal(spark.marks.length, 2)
  assert.equal(spark.marks[0].price, 12)
  assert.equal(spark.marks[1].current, true)
  assert.match(spark.path, /^0\.00,12\.00 100\.00,12\.00$/)
})
