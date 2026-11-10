/**
 * 票 41：本机交易所（`<dataDir>/market.json`）。
 *
 * 只回答四件事：初始价/缺文件、价格公式与夹取、成交落盘与历史裁剪、
 * 坏文件怎么降级。全部用真磁盘（tmpdir），不起 service/网络。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MARKET_FILE,
  MARKET_VERSION,
  MAX_MARKET_HISTORY,
  REVERSION_INTERVAL_MS,
  bidPrice,
  clampPrice,
  createMarketStore,
  initialMarketState,
  meanRevertPrice,
  normalizeMarketFile,
  sellImpactPrice
} from '../src/market.js'
import { CROPS, HOUR_MS, MINUTE_MS } from '../src/farm-rules.js'

const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-market-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function logSink () {
  const warnings = []
  return { warnings, log: { warn (line) { warnings.push(line) } } }
}

function makeClock (start = NOON) {
  let value = start
  return {
    now: () => value,
    set (next) { value = next },
    advance (ms) { value += ms }
  }
}

function price (overrides = {}) {
  return { base: 5, price: 5, volume24h: 0, at: NOON, ...overrides }
}

function marketFile (overrides = {}) {
  return {
    version: MARKET_VERSION,
    prices: {
      tomato: price(),
      carrot: price({ base: 6, price: 6 }),
      pumpkin: price({ base: 30, price: 30 })
    },
    history: [],
    index: {},
    ...overrides
  }
}

async function writeMarket (dir, value) {
  await writeFile(join(dir, MARKET_FILE), JSON.stringify(value), 'utf8')
}

async function readMarket (dir) {
  return JSON.parse(await readFile(join(dir, MARKET_FILE), 'utf8'))
}

// ---------------------------------------------------------------------------
// 初始 / 纯公式
// ---------------------------------------------------------------------------

test('初始交易所：缺文件按作物表建价，不告警、不落盘', async (t) => {
  const dir = await tempDir(t)
  const { warnings, log } = logSink()
  const store = await createMarketStore(dir, { log, now: makeClock().now })
  const view = store.snapshot()

  for (const cropId of Object.keys(CROPS)) {
    assert.equal(view.prices[cropId].base, CROPS[cropId].base)
    assert.equal(view.prices[cropId].price, CROPS[cropId].base)
    assert.equal(view.prices[cropId].volume24h, 0)
    assert.equal(view.prices[cropId].bid, undefined, '状态视图不额外发明 bid')
  }
  assert.deepEqual(view.history, [])
  // 没有邻居：指数条目存在，但价格 = 本机、samples 0（UI 画成「本机行情」）。
  assert.deepEqual(view.index, Object.fromEntries(Object.keys(CROPS).map((cropId) => [cropId, {
    price: CROPS[cropId].base,
    at: NOON,
    samples: 0
  }])))
  assert.deepEqual(warnings, [])
  await assert.rejects(readFile(join(dir, MARKET_FILE), 'utf8'), /ENOENT/)
})

test('价格公式：bid、卖价冲击、上下夹取、均值回归', () => {
  assert.equal(bidPrice(5), 5, 'round(4.5)')
  assert.equal(bidPrice(4.4), 4)
  assert.equal(clampPrice(5, 5), 5)
  assert.equal(clampPrice(1, 5), 2.5, '下限 base×0.5')
  assert.equal(clampPrice(100, 5), 10, '上限 base×2')

  assert.ok(Math.abs(sellImpactPrice(5, 5, 20) - 4.4) < 1e-9)
  assert.ok(Math.abs(sellImpactPrice(5, 5, 1) - 4.97) < 1e-9)
  assert.equal(sellImpactPrice(5, 5, 99), 2.5, '卖 99 个直接被下限夹住')
  assert.equal(sellImpactPrice(2.5, 5, 99), 2.5, '已经在下限就不再跌')

  assert.ok(Math.abs(meanRevertPrice(10, 5, 1) - 9.85) < 1e-9)
  assert.ok(Math.abs(meanRevertPrice(10, 5, 2) - 9.7045) < 1e-9)
  assert.equal(meanRevertPrice(5, 5, 10), 5)
  const recovered = meanRevertPrice(2.5, 5, 10)
  assert.ok(recovered > 2.5 && recovered < 5, '从下限往 base 回归，但仍在下限之上')
})

test('normalizeMarketFile：整份损坏 → 初始价；逐项夹取/丢弃/裁剪到 200', () => {
  for (const bad of [null, 42, 'x', [], { version: 2 }]) {
    const normalized = normalizeMarketFile(bad)
    assert.equal(normalized.corrupt, true, JSON.stringify(bad))
    assert.deepEqual(normalized.market, initialMarketState())
  }

  const history = Array.from({ length: MAX_MARKET_HISTORY + 50 }, (_, index) => ({
    crop: 'tomato',
    side: index % 2 === 0 ? 'buy' : 'sell',
    qty: 1 + (index % 99),
    price: 5 + (index % 3),
    at: NOON + index
  }))
  history.push({ crop: 'alien', side: 'sell', qty: 1, price: 5, at: NOON })
  history.push({ crop: 'tomato', side: 'nope', qty: 1, price: 5, at: NOON })
  history.push({ crop: 'tomato', side: 'sell', qty: 1000, price: 5, at: NOON })

  const normalized = normalizeMarketFile({
    version: MARKET_VERSION,
    prices: {
      tomato: { base: 999, price: 100, volume24h: -3, at: 0 },
      carrot: null,
      alien: { base: 1, price: 1 }
    },
    history,
    index: {
      tomato: { price: 100, at: NOON, samples: 2 },
      carrot: { price: 'nope' },
      alien: { price: 1, at: NOON, samples: 1 }
    }
  })
  assert.equal(normalized.corrupt, false)
  assert.ok(normalized.repaired > 0)
  assert.equal(normalized.market.prices.tomato.base, 5, 'base 以作物表为准')
  assert.equal(normalized.market.prices.tomato.price, 10, '价格夹到 base×2')
  assert.equal(normalized.market.prices.tomato.volume24h, 0)
  assert.equal(normalized.market.prices.tomato.at, null)
  assert.equal(normalized.market.prices.carrot.price, 6, '坏条目回默认价')
  assert.equal('alien' in normalized.market.prices, false)
  assert.equal(normalized.market.history.length, MAX_MARKET_HISTORY)
  assert.equal(normalized.market.history[0].at, NOON + MAX_MARKET_HISTORY + 49, '最新在前')
  assert.equal(normalized.market.history.at(-1).at, NOON + 50)
  assert.equal(normalized.market.index.tomato.price, 10)
  assert.equal(normalized.market.index.tomato.samples, 2)
  assert.equal('alien' in normalized.market.index, false)
})

test('normalizeMarketFile：缺 prices/history/index 不崩，补成完整形状', () => {
  const normalized = normalizeMarketFile({ version: MARKET_VERSION })
  assert.equal(normalized.corrupt, false)
  assert.deepEqual(Object.keys(normalized.market.prices).sort(), ['carrot', 'pumpkin', 'tomato'])
  assert.deepEqual(normalized.market.history, [])
  assert.deepEqual(normalized.market.index, {})

  // 只手写了一种作物：其余按作物表补默认价，不算「损坏」。
  const partial = normalizeMarketFile({
    version: MARKET_VERSION,
    prices: { tomato: { base: 5, price: 5, volume24h: 0, at: NOON } }
  })
  assert.equal(partial.corrupt, false)
  assert.equal(partial.repaired, 0)
  assert.equal(partial.market.prices.carrot.price, 6)
})

// ---------------------------------------------------------------------------
// 成交 / 落盘 / 均值回归
// ---------------------------------------------------------------------------

test('卖作物：按成交前的 bid 结算，随后价格下跌并记一笔 sell', async (t) => {
  const dir = await tempDir(t)
  await writeMarket(dir, marketFile({
    prices: { tomato: price({ price: 10 }), carrot: price({ base: 6, price: 6 }), pumpkin: price({ base: 30, price: 30 }) }
  }))
  const clock = makeClock()
  const store = await createMarketStore(dir, { log: logSink().log, now: clock.now })

  const trade = store.applyTrade({ side: 'sell', cropId: 'tomato', qty: 20, now: NOON })
  assert.equal(trade.ok, true)
  assert.equal(trade.unitPrice, 9, 'bid = round(10 × 0.9)')
  assert.equal(trade.total, 180)
  assert.ok(Math.abs(trade.priceAfter - 8.8) < 1e-9)
  assert.equal(await trade.persisted, true)
  assert.equal(store.snapshot().history[0].side, 'sell')
  assert.equal(store.snapshot().history[0].price, 9)
  assert.equal(store.snapshot().prices.tomato.volume24h, 20)

  const file = await readMarket(dir)
  assert.equal(file.version, MARKET_VERSION)
  assert.equal(file.prices.tomato.price, trade.priceAfter)
  assert.equal(file.history[0].qty, 20)
  assert.deepEqual(await readdir(dir), [MARKET_FILE], 'tmp+rename 不留下临时文件')
})

test('买种子：固定种子价，不影响作物价，但记一笔 buy', async (t) => {
  const dir = await tempDir(t)
  const store = await createMarketStore(dir, { log: logSink().log, now: makeClock().now })
  const trade = store.applyTrade({ side: 'buy', cropId: 'carrot', qty: 2, now: NOON })
  assert.equal(trade.ok, true)
  assert.equal(trade.unitPrice, CROPS.carrot.seedPrice)
  assert.equal(trade.total, 28)
  assert.equal(trade.priceAfter, 6)
  assert.equal(store.snapshot().history[0].side, 'buy')
  assert.equal(store.snapshot().history[0].price, 14)
  assert.equal(store.snapshot().prices.carrot.price, 6)
  await trade.persisted
})

test('10 笔/分钟限速；过了窗口才恢复；并发成交串行写入不丢', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const store = await createMarketStore(dir, { log: logSink().log, now: clock.now })
  const writes = []
  for (let index = 0; index < 10; index += 1) {
    const trade = store.applyTrade({ side: 'sell', cropId: 'tomato', qty: 1, now: NOON })
    assert.equal(trade.ok, true, '第 ' + (index + 1) + ' 笔应该成功')
    writes.push(trade.persisted)
  }
  const blocked = store.applyTrade({ side: 'sell', cropId: 'tomato', qty: 1, now: NOON + 1000 })
  assert.deepEqual(blocked, { ok: false, error: 'market-busy', persisted: false })
  await Promise.all(writes)

  const file = await readMarket(dir)
  assert.equal(file.history.length, 10, '并发写盘不能互相写掉')
  assert.equal(store.snapshot().prices.tomato.volume24h, 10)

  clock.advance(61 * 1000)
  const afterWindow = store.applyTrade({ side: 'sell', cropId: 'tomato', qty: 1, now: clock.now() })
  assert.equal(afterWindow.ok, true)
  await afterWindow.persisted
})

test('历史最多 200 笔：预置满 200 条后新成交仍只保留 200', async (t) => {
  const dir = await tempDir(t)
  const history = Array.from({ length: MAX_MARKET_HISTORY }, (_, index) => ({
    crop: 'tomato',
    side: 'sell',
    qty: 1,
    price: 5,
    at: NOON - (index + 1) * 1000
  }))
  await writeMarket(dir, marketFile({ history }))
  const store = await createMarketStore(dir, { log: logSink().log, now: makeClock().now })
  assert.equal(store.snapshot().history.length, MAX_MARKET_HISTORY)

  const trade = store.applyTrade({ side: 'sell', cropId: 'tomato', qty: 2, now: NOON })
  assert.equal(trade.ok, true)
  await trade.persisted
  assert.equal(store.snapshot().history.length, MAX_MARKET_HISTORY)
  assert.equal(store.snapshot().history[0].qty, 2)

  const file = await readMarket(dir)
  assert.equal(file.history.length, MAX_MARKET_HISTORY)
})

test('均值回归：每 10 分钟向 base 拉 3%，tick 落盘；没满 10 分钟不动', async (t) => {
  const dir = await tempDir(t)
  await writeMarket(dir, marketFile({
    prices: { tomato: price({ price: 10 }), carrot: price({ base: 6, price: 6 }), pumpkin: price({ base: 30, price: 30 }) }
  }))
  const clock = makeClock()
  const store = await createMarketStore(dir, { log: logSink().log, now: clock.now })

  clock.advance(REVERSION_INTERVAL_MS - 1)
  assert.equal(await store.tick(), false)
  assert.equal(store.snapshot().prices.tomato.price, 10)

  clock.advance(1)
  assert.equal(await store.tick(), true)
  assert.ok(Math.abs(store.snapshot().prices.tomato.price - 9.85) < 1e-9)
  const file = await readMarket(dir)
  assert.ok(Math.abs(file.prices.tomato.price - 9.85) < 1e-9, '回归结果要落盘')

  // 一段 25 分钟的停机（没有 tick）在下一拍按 2 个 10 分钟复合补上。
  clock.advance(REVERSION_INTERVAL_MS * 2.5)
  await store.tick()
  const expected = meanRevertPrice(9.85, 5, 2)
  assert.ok(Math.abs(store.snapshot().prices.tomato.price - expected) < 1e-9)

  // 成交前也会先补回归，不能因为「tick 还没轮到」就按旧价成交。
  clock.advance(HOUR_MS)
  const trade = store.applyTrade({ side: 'sell', cropId: 'carrot', qty: 1, now: clock.now() })
  assert.equal(trade.ok, true)
  await trade.persisted
})

test('坏 JSON：初始交易所 + 只告警一次；下一笔成交写出合法文件', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, MARKET_FILE), '{ 不是 JSON', 'utf8')
  const { warnings, log } = logSink()
  const store = await createMarketStore(dir, { log, now: makeClock().now })

  assert.equal(store.snapshot().prices.tomato.price, CROPS.tomato.base)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /交易所/)

  const trade = store.applyTrade({ side: 'buy', cropId: 'tomato', qty: 1, now: NOON })
  assert.equal(trade.ok, true)
  await trade.persisted
  assert.equal(warnings.length, 1, '同一个原因不重复告警')
  const file = await readMarket(dir)
  assert.equal(file.version, MARKET_VERSION)
  assert.equal(file.history.length, 1)
})

test('形状不对：坏价格/坏历史/坏指数只修不崩，且只告警一次', async (t) => {
  const dir = await tempDir(t)
  await writeMarket(dir, marketFile({
    prices: {
      tomato: { base: 'x', price: 'oops', volume24h: 'many', at: 'nope' },
      carrot: price({ base: 6, price: 999 }),
      pumpkin: price({ base: 30, price: -1 })
    },
    history: [null, { crop: 'alien', side: 'sell' }, { crop: 'tomato', side: 'buy', qty: 1, price: 6, at: NOON }],
    index: { tomato: { price: 5, at: NOON, samples: 1 }, alien: {} }
  }))
  const { warnings, log } = logSink()
  const store = await createMarketStore(dir, { log, now: makeClock().now })

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /交易所有 \d+ 处/)
  assert.equal(store.snapshot().prices.tomato.price, 5)
  assert.equal(store.snapshot().prices.tomato.volume24h, 0)
  assert.equal(store.snapshot().prices.carrot.price, 12, '999 夹到 base×2')
  assert.equal(store.snapshot().prices.pumpkin.price, 15, '-1 夹到 base×0.5')
  assert.equal(store.snapshot().history.length, 1)
  assert.deepEqual(store.snapshot().index, {
    tomato: { price: 5, at: NOON, samples: 1 },
    carrot: { price: 12, at: NOON, samples: 0 },
    pumpkin: { price: 15, at: NOON, samples: 0 }
  })
})

test('重启：价格与成交历史都还在，均值回归锚点从重启这一刻重新计时', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const first = await createMarketStore(dir, { log: logSink().log, now: clock.now })
  const trade = first.applyTrade({ side: 'sell', cropId: 'tomato', qty: 20, now: NOON })
  await trade.persisted

  const second = await createMarketStore(dir, { log: logSink().log, now: clock.now })
  assert.ok(Math.abs(second.snapshot().prices.tomato.price - trade.priceAfter) < 1e-9)
  assert.equal(second.snapshot().history.length, 1)
  // 重启后 9 分钟不回归：锚点不会把停机时间当成「开着的时间」。
  clock.advance(9 * MINUTE_MS)
  assert.equal(await second.tick(), false)
})
