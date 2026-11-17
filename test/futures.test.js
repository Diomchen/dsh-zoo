/**
 * 票 92：期货纯规则（`src/futures-rules.js`）。
 *
 * 只回答四件事：合约窗口（周一开、周五 20:00 收、周末没有）、偏离噪声可复现、
 * 报价与张数的算术、费用拆到分能对上。不起 service、不碰磁盘。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DAY_MS,
  FEE_BURN_SHARE,
  FEE_INSURANCE_SHARE,
  FUTURES_LEVERAGES,
  HOUR_MS,
  LOT_SIZE,
  MM_SPREAD,
  OU_MEMORY_STEPS,
  OU_SIGMA,
  SLOT_MS,
  TAKER_FEE_RATE,
  contractOf,
  contractWindowOf,
  fairPriceOf,
  feeSplitOf,
  fillPriceOf,
  isFuturesLeverage,
  isFuturesSide,
  lotsFor,
  marginOf,
  notionalOf,
  ouDeviation,
  pnlOf,
  quotesOf,
  roundCoin,
  takerFeeOf
} from '../src/futures-rules.js'

/** 2026-11-16 是周一。所有窗口测试都挂在这一天，避免「今天恰好是周日」的偶发。 */
const MONDAY = new Date(2026, 10, 16, 0, 0, 0, 0).getTime()

test('合约：周一 00:00 上市，周五 20:00 到期，周末没有合约', () => {
  const monday = contractOf('tomato', MONDAY)
  assert.equal(monday.id, 'tomato-2026W47')
  assert.equal(monday.openAt, MONDAY)
  assert.equal(monday.expireAt, MONDAY + 4 * DAY_MS + 20 * HOUR_MS)

  // 周四 23:59 仍在这张合约里
  assert.equal(contractOf('tomato', MONDAY + 3 * DAY_MS + 23 * HOUR_MS + 59 * 60 * 1000).id, monday.id)
  // 周五 20:00 整到期
  assert.equal(contractOf('tomato', monday.expireAt), null)
  // 周六、周日均休市
  assert.equal(contractOf('tomato', MONDAY + 5 * DAY_MS + 9 * HOUR_MS), null)
  assert.equal(contractOf('tomato', MONDAY + 6 * DAY_MS + 9 * HOUR_MS), null)
  // 下周一开盘是下一张
  const next = contractOf('tomato', MONDAY + 7 * DAY_MS)
  assert.equal(next.id, 'tomato-2026W48')
})

test('合约：编号能反解回窗口，坏编号返回 null', () => {
  const window = contractWindowOf('tomato-2026W47')
  assert.equal(window.crop, 'tomato')
  assert.equal(window.openAt, MONDAY)
  assert.equal(window.expireAt, MONDAY + 4 * DAY_MS + 20 * HOUR_MS)

  assert.equal(contractWindowOf('tomato-2026W54'), null)
  assert.equal(contractWindowOf('tomato'), null)
  assert.equal(contractWindowOf('../etc/passwd'), null)
  assert.equal(contractWindowOf(null), null)
})

test('合约：跨年那一周用 ISO 周号，两台机器算出同一张', () => {
  // 2026-12-31 是周四，属于 2026 的最后一周
  const thursday = new Date(2026, 11, 31, 12, 0, 0, 0).getTime()
  const a = contractOf('rice', thursday)
  const b = contractOf('rice', thursday + 60 * 1000)
  assert.equal(a.id, b.id)
  assert.ok(a.id.startsWith('rice-'))
})

test('偏离：同样的输入永远同一个数，clamp 在合理范围', () => {
  const contract = contractOf('tomato', MONDAY)
  const at = MONDAY + 13 * HOUR_MS + 7 * 60 * 1000
  const first = ouDeviation({ crop: 'tomato', contractId: contract.id, at })
  const second = ouDeviation({ crop: 'tomato', contractId: contract.id, at })
  assert.equal(first, second)
  assert.ok(Math.abs(first) < 0.02, '单点偏离不该超过 2%（σ 是 0.4%）')

  // 换 15 秒就是另一个数（噪声在走），但相邻两点不会跳崖
  const next = ouDeviation({ crop: 'tomato', contractId: contract.id, at: at + 15 * 1000 })
  assert.notEqual(first, next)
  assert.ok(Math.abs(next - first) < 0.01)
})

test('偏离：均值接近 0、平稳标准差就是 0.4%', () => {
  const contract = contractOf('tomato', MONDAY)
  const values = []
  // 每 30 分钟取一个点（相隔一个半衰期），样本近似独立；逐 15 秒取样会把同一条
  // 噪声曲线数很多遍，均值检验就没有意义了。
  for (let k = 0; k < 600; k += 1) {
    values.push(ouDeviation({ crop: 'tomato', contractId: contract.id, at: MONDAY + k * 30 * 60 * 1000 }))
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const sd = Math.sqrt(variance)
  assert.ok(Math.abs(mean) < 0.002, '均值应接近 0，实测 ' + mean)
  assert.ok(sd > 0.003 && sd < 0.005, '平稳标准差应约等于 OU_SIGMA = 0.4%，实测 ' + sd)
  // 记忆 960 步 = 8 个半衰期，足够把截断误差压到千分之一
  assert.ok(OU_MEMORY_STEPS >= 900)
})

test('偏离：均值回归——大幅偏离之后会往 0 走，而不是继续漂', () => {
  const contract = contractOf('tomato', MONDAY)
  // 找出一个 |dev| 明显偏大的时刻，往后看半个半衰期，它应该更靠近 0
  let worst = 0
  let worstAt = MONDAY
  for (let k = 0; k < 200; k += 1) {
    const at = MONDAY + k * 15 * 60 * 1000
    const dev = ouDeviation({ crop: 'tomato', contractId: contract.id, at })
    if (Math.abs(dev) > Math.abs(worst)) {
      worst = dev
      worstAt = at
    }
  }
  const later = ouDeviation({ crop: 'tomato', contractId: contract.id, at: worstAt + 15 * 60 * 1000 })
  assert.ok(Math.abs(later) < Math.abs(worst) + 0.002, '半个半衰期之后不该离 0 更远')
})

test('公允价：index × exp(偏离)；指数不是正数返回 null', () => {
  const contract = contractOf('tomato', MONDAY)
  const at = MONDAY + 10 * HOUR_MS
  const dev = ouDeviation({ crop: 'tomato', contractId: contract.id, at })
  const fair = fairPriceOf({ indexPrice: 5, crop: 'tomato', contractId: contract.id, at })
  assert.ok(Math.abs(fair - 5 * Math.exp(dev)) < 1e-12)
  assert.equal(fairPriceOf({ indexPrice: 0, crop: 'tomato', contractId: contract.id, at }), null)
  assert.equal(fairPriceOf({ indexPrice: NaN, crop: 'tomato', contractId: contract.id, at }), null)
})

test('报价：两侧各让 0.2%，做多吃卖一、做空吃买一', () => {
  const quotes = quotesOf(100)
  assert.equal(quotes.bid, 100 * (1 - MM_SPREAD))
  assert.equal(quotes.ask, 100 * (1 + MM_SPREAD))
  assert.equal(fillPriceOf(quotes, 'long'), quotes.ask)
  assert.equal(fillPriceOf(quotes, 'short'), quotes.bid)
  assert.equal(fillPriceOf(quotes, 'flat'), null)
  assert.equal(quotesOf(0), null)
})

test('张数：floor(名义 ÷ (价 × 100))，至少一张', () => {
  // 5 币的作物，一张 = 500 币名义；1000 币名义买 2 张
  assert.equal(lotsFor({ notional: 1000, price: 5 }), 2)
  assert.equal(lotsFor({ notional: 1499, price: 5 }), 2)
  // 名义不够一张也给一张
  assert.equal(lotsFor({ notional: 10, price: 5 }), 1)
  assert.equal(notionalOf({ lots: 2, price: 5 }), 2 * LOT_SIZE * 5)
})

test('保证金与 taker 费：到分，不产生浮点毛刺', () => {
  const price = 5.123456789
  const lots = 3
  const notional = notionalOf({ lots, price })
  const margin = marginOf({ lots, price, leverage: 10 })
  assert.equal(margin, Math.round((notional / 10) * 100) / 100)
  const fee = takerFeeOf(notional)
  assert.equal(fee, Math.round(notional * TAKER_FEE_RATE * 100) / 100)
  // 0.1% 的费用在 1537 币名义上就是 1.54 币，不是 1.537
  assert.equal(takerFeeOf(1537.5), 1.54)
  assert.equal(roundCoin(-0.0001), 0)
})

test('盈亏：多头涨赚钱、空头跌赚钱，空仓方向非法时归零', () => {
  assert.equal(pnlOf({ lots: 2, entry: 5, exit: 5.5, side: 'long' }), 100)
  assert.equal(pnlOf({ lots: 2, entry: 5, exit: 4.5, side: 'short' }), 100)
  assert.equal(pnlOf({ lots: 2, entry: 5, exit: 4.5, side: 'long' }), -100)
  assert.equal(pnlOf({ lots: 2, entry: 5, exit: 4.5, side: 'flat' }), 0)
})

test('费用拆分：保险 + 销毁恰好等于总额，比例 10/90', () => {
  for (const fee of [0.01, 1.54, 12.345, 999.99]) {
    const split = feeSplitOf(fee)
    assert.equal(roundCoin(split.insurance + split.burned), split.total)
    assert.ok(Math.abs(split.insurance / split.total - FEE_INSURANCE_SHARE) < 0.02 || split.total < 0.1)
    assert.ok(Math.abs(split.burned / split.total - FEE_BURN_SHARE) < 0.02 || split.total < 0.1)
  }
})

test('校验：方向、杠杆白名单、保证金只认整数', () => {
  assert.ok(isFuturesSide('long'))
  assert.ok(isFuturesSide('short'))
  assert.ok(!isFuturesSide('flat'))
  assert.deepEqual([...FUTURES_LEVERAGES], [1, 3, 10, 20])
  assert.ok(isFuturesLeverage(20))
  assert.ok(!isFuturesLeverage(5), '盘口的 5× 不在期货白名单里')
  assert.ok(!isFuturesLeverage(2.5))
  assert.ok(SLOT_MS === 15 * 60 * 1000 && OU_SIGMA === 0.004)
})
