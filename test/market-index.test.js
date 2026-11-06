/**
 * 票 42：局域网行情指数（纯公式 + `market.json` 落盘）。
 *
 * 这一层不碰 UDP：中位数、2 分钟新鲜度、本机价与指数的混合价，以及
 * 「每个 deviceId 只留最近一条」「过期保留最后一次值但不再参与定价」。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MARKET_FILE,
  MARKET_INDEX_WEIGHT,
  MARKET_LOCAL_WEIGHT,
  MARKET_VERSION,
  bidPrice,
  computeMarketIndex,
  createMarketStore,
  effectivePrice,
  freshIndexPrice,
  isFreshMarketSample,
  medianPrice
} from '../src/market.js'
import { CROPS, MINUTE_MS } from '../src/farm-rules.js'

const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()
const PEER_A = '11111111-1111-4111-8111-111111111111'
const PEER_B = '22222222-2222-4222-8222-222222222222'

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-market-index-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeClock (start = NOON) {
  let value = start
  return {
    now: () => value,
    advance (ms) { value += ms }
  }
}

async function makeStore (t, clock = makeClock()) {
  const dir = await tempDir(t)
  const warnings = []
  const store = await createMarketStore(dir, {
    log: { warn (line) { warnings.push(line) } },
    now: clock.now
  })
  return { dir, store, clock, warnings }
}

async function writeMarket (dir, value) {
  await writeFile(join(dir, MARKET_FILE), JSON.stringify(value), 'utf8')
}

function priceFile (tomato = 5) {
  return {
    version: MARKET_VERSION,
    prices: {
      tomato: { base: 5, price: tomato, volume24h: 0, at: NOON },
      carrot: { base: 6, price: 6, volume24h: 0, at: NOON },
      pumpkin: { base: 30, price: 30, volume24h: 0, at: NOON }
    },
    history: [],
    index: {}
  }
}

// ---------------------------------------------------------------------------
// 纯公式
// ---------------------------------------------------------------------------

test('中位数：奇数取中间，偶数取平均，空/坏值返回 null', () => {
  assert.equal(medianPrice([5]), 5)
  assert.equal(medianPrice([10, 5, 7]), 7)
  assert.equal(medianPrice([10, 6, 7, 5]), 6.5)
  assert.equal(medianPrice([]), null)
  assert.equal(medianPrice(null), null)
  assert.equal(medianPrice([Number.NaN, 8, 'x']), 8)
})

test('新鲜度：恰好 2 分钟仍然新鲜，超过就过期；未来时间也按 absolutely 判', () => {
  assert.equal(isFreshMarketSample(NOON, NOON), true)
  assert.equal(isFreshMarketSample(NOON - 2 * MINUTE_MS, NOON), true)
  assert.equal(isFreshMarketSample(NOON - 2 * MINUTE_MS - 1, NOON), false)
  assert.equal(isFreshMarketSample(NOON + 2 * MINUTE_MS, NOON), true)
  assert.equal(isFreshMarketSample(NOON + 2 * MINUTE_MS + 1, NOON), false)
  assert.equal(isFreshMarketSample(0, NOON), false)
  assert.equal(isFreshMarketSample('x', NOON), false)
  assert.equal(isFreshMarketSample(NOON, undefined), false)
})

test('指数：本机 + 新鲜 peer 的中位数；samples 含本机；at 取最新 peer 样本', () => {
  const localPrices = {
    tomato: { base: 5, price: 5 },
    carrot: { base: 6, price: 6 },
    pumpkin: { base: 30, price: 30 }
  }
  const index = computeMarketIndex({
    localPrices,
    now: NOON,
    samples: [
      { prices: { tomato: 7, carrot: 12, pumpkin: 999 }, at: NOON - 1000 },
      { prices: { tomato: 9, carrot: 4, pumpkin: 30 }, at: NOON - 500 }
    ]
  })
  // tomato: [5,7,9] → 7；carrot: [6,12,4] → 6；pumpkin: 999 越界丢掉 → [30,30] → 30。
  assert.deepEqual(index.tomato, { price: 7, at: NOON - 500, samples: 3 })
  assert.deepEqual(index.carrot, { price: 6, at: NOON - 500, samples: 3 })
  assert.deepEqual(index.pumpkin, { price: 30, at: NOON - 500, samples: 2 })
})

test('指数：过期样本被剔除；只有自己时不出条目；未知作物/坏价格不拖垮别的作物', () => {
  const localPrices = { tomato: { price: 5 }, carrot: { price: 6 }, pumpkin: { price: 30 } }
  const stale = computeMarketIndex({
    localPrices,
    now: NOON,
    samples: [{ prices: { tomato: 10, carrot: 12, pumpkin: 60 }, at: NOON - 2 * MINUTE_MS - 1 }]
  })
  assert.deepEqual(stale, {}, '过了 2 分钟的样本一个都不算')

  assert.deepEqual(computeMarketIndex({ localPrices, now: NOON, samples: [] }), {})
  assert.deepEqual(computeMarketIndex({ localPrices, now: NOON }), {})

  const mixed = computeMarketIndex({
    localPrices,
    now: NOON,
    samples: [
      { prices: { tomato: Number.NaN, carrot: 12, alien: 1 }, at: NOON },
      { prices: { tomato: 7, carrot: Number.POSITIVE_INFINITY, pumpkin: '30' }, at: NOON }
    ]
  })
  assert.deepEqual(mixed.tomato, { price: 6, at: NOON, samples: 2 })
  assert.deepEqual(mixed.carrot, { price: 9, at: NOON, samples: 2 })
  assert.equal('alien' in mixed, false)
})

test('混合价：effective = 0.85×本机 + 0.15×指数；没有指数退回本机价', () => {
  assert.equal(MARKET_LOCAL_WEIGHT, 0.85)
  assert.equal(MARKET_INDEX_WEIGHT, 0.15)
  assert.equal(effectivePrice(5), 5)
  assert.equal(effectivePrice(5, null), 5)
  assert.equal(effectivePrice(5, 10), 5.75)
  assert.equal(bidPrice(5), 5)
  assert.equal(bidPrice(10, 5), 8, 'effective 9.25 → bid 8.325 → 8')
  assert.equal(bidPrice(5, 10), 5)
  assert.equal(effectivePrice(0, 10), 0)
  assert.equal(effectivePrice(5, Number.NaN), 5)
})

test('freshIndexPrice：只认新鲜且正的指数', () => {
  assert.equal(freshIndexPrice({ price: 7, at: NOON }, NOON), 7)
  assert.equal(freshIndexPrice({ price: 7, at: NOON - 2 * MINUTE_MS - 1 }, NOON), null)
  assert.equal(freshIndexPrice({ price: -1, at: NOON }, NOON), null)
  assert.equal(freshIndexPrice(null, NOON), null)
})

// ---------------------------------------------------------------------------
// store：digest → index → market.json
// ---------------------------------------------------------------------------

test('store：按 deviceId 只留最近一条，指数写入 market.json，重启读得回来', async (t) => {
  const clock = makeClock()
  const { dir, store } = await makeStore(t, clock)

  assert.equal(store.snapshot().index.tomato, undefined, '没有邻居时没有局域网指数')

  const first = store.observeDigest(PEER_A, {
    prices: { tomato: 7, carrot: 9 },
    at: NOON - 1000
  })
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  await first.persisted
  assert.deepEqual(store.snapshot().index.tomato, { price: 6, at: NOON - 1000, samples: 2 })
  assert.deepEqual(store.snapshot().index.carrot, { price: 7.5, at: NOON - 1000, samples: 2 })
  assert.equal(store.snapshot().index.pumpkin, undefined, '没有 peer 样本的作物不编一个指数')

  // 同一个 peer 再发一条：替换，不是叠加样本。
  clock.advance(1000)
  const second = store.observeDigest(PEER_A, {
    prices: { tomato: 9, carrot: 6 },
    at: NOON
  })
  await second.persisted
  assert.deepEqual(store.snapshot().index.tomato, { price: 7, at: NOON, samples: 2 })

  // 第二个 peer：三个样本，中位数取中间。
  clock.advance(1000)
  const third = store.observeDigest(PEER_B, {
    prices: { tomato: 6, carrot: 12 },
    at: NOON + 1000
  })
  await third.persisted
  assert.deepEqual(store.snapshot().index.tomato, { price: 6, at: NOON + 1000, samples: 3 })
  assert.deepEqual(store.snapshot().index.carrot, { price: 6, at: NOON + 1000, samples: 3 })

  const file = JSON.parse(await readFile(join(dir, MARKET_FILE), 'utf8'))
  assert.deepEqual(file.index.tomato, { price: 6, at: NOON + 1000, samples: 3 })

  // 重启：指数还在（盘上有），但已经过期 → 窗口画灰、定价不再采用。
  const restarted = await createMarketStore(dir, { log: { warn () {} }, now: clock.now })
  assert.deepEqual(restarted.snapshot().index.tomato, { price: 6, at: NOON + 1000, samples: 3 })
  clock.advance(3 * MINUTE_MS)
  assert.equal(restarted.snapshot({ withBid: true }).index.tomato.stale, true)
  assert.equal(restarted.snapshot({ withBid: true }).prices.tomato.bid, 5, '过期指数不参与 bid')
})

test('store：过期样本不删旧指数，但新鲜样本回来会覆盖；坏 digest 不崩', async (t) => {
  const clock = makeClock()
  const { store } = await makeStore(t, clock)
  await store.observeDigest(PEER_A, { prices: { tomato: 10 }, at: NOON }).persisted
  assert.deepEqual(store.snapshot().index.tomato, { price: 7.5, at: NOON, samples: 2 })

  clock.advance(2 * MINUTE_MS + 1)
  // 再收一条过期的（协议层之后、store 之前的时间判断兜底）：不参与重算，旧指数保留。
  const stale = store.observeDigest(PEER_B, { prices: { tomato: 5 }, at: NOON })
  assert.equal(stale.ok, true)
  assert.deepEqual(store.snapshot().index.tomato, { price: 7.5, at: NOON, samples: 2 })
  assert.equal(store.snapshot({ withBid: true }).index.tomato.stale, true)

  for (const bad of [null, {}, { prices: null, at: NOON }, { prices: {}, at: 0 }]) {
    assert.equal(store.observeDigest(PEER_B, bad).ok, false, JSON.stringify(bad))
  }
  assert.equal(store.observeDigest('', { prices: {}, at: NOON }).ok, false)
})

test('store：新鲜指数参与本机卖价（bid 按 0.85/0.15 混合），落盘同价', async (t) => {
  const dir = await tempDir(t)
  await writeMarket(dir, priceFile(10))
  const clock = makeClock()
  const store = await createMarketStore(dir, { log: { warn () {} }, now: clock.now })
  const observed = store.observeDigest(PEER_A, { prices: { tomato: 5 }, at: NOON })
  await observed.persisted
  assert.deepEqual(store.snapshot().index.tomato, { price: 7.5, at: NOON, samples: 2 })

  const trade = store.applyTrade({ side: 'sell', cropId: 'tomato', qty: 1, now: NOON })
  assert.equal(trade.ok, true)
  assert.equal(trade.unitPrice, 9, '本机 10 / 指数 7.5 → effective 9.625 → bid 8.6625 → 9')
  await trade.persisted
  const file = JSON.parse(await readFile(join(dir, MARKET_FILE), 'utf8'))
  assert.equal(file.history[0].price, trade.unitPrice)
})


test('store.removeDigest：被拒绝/移除的邻居不再影响指数；还有别人时重算', async (t) => {
  const clock = makeClock()
  const { store } = await makeStore(t, clock)
  await store.observeDigest(PEER_A, { prices: { tomato: 8 }, at: NOON }).persisted
  assert.deepEqual(store.snapshot().index.tomato, { price: 6.5, at: NOON, samples: 2 })

  // 还有 PEER_B：只摘掉 A，中位数改由 B 参与。
  await store.observeDigest(PEER_B, { prices: { tomato: 9 }, at: NOON }).persisted
  assert.deepEqual(store.snapshot().index.tomato, { price: 8, at: NOON, samples: 3 })
  const removedA = store.removeDigest(PEER_A)
  assert.equal(removedA.changed, true)
  await removedA.persisted
  assert.deepEqual(store.snapshot().index.tomato, { price: 7, at: NOON, samples: 2 })

  // 最后一个新鲜邻居被移除：指数清空（不是画灰的旧值）。
  const removedB = store.removeDigest(PEER_B)
  await removedB.persisted
  assert.deepEqual(store.snapshot().index, {})

  // 不存在的 deviceId 是 no-op。
  const missing = store.removeDigest(PEER_A)
  assert.equal(missing.ok, true)
  assert.equal(missing.changed, false)
  assert.equal(await missing.persisted, false)
})
