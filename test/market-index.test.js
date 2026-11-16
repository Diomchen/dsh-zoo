/**
 * 票 42：局域网行情指数（纯公式 + `market.json` 落盘）。
 *
 * 这一层不碰 UDP：中位数、2 分钟新鲜度、按邻居数/作物 beta 的混合价，
 * 以及「每个 deviceId 只留最近一条」「过期保留最后一次值但不再参与定价」。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MARKET_CROP_BETA,
  MARKET_FILE,
  MARKET_INDEX_WEIGHT_MAX,
  MARKET_INDEX_WEIGHT_TIERS,
  MARKET_VERSION,
  bidPrice,
  computeMarketIndex,
  createMarketStore,
  effectivePrice,
  freshIndexPrice,
  isFreshMarketSample,
  marketIndexWeight,
  medianPrice
} from '../src/market.js'
import { MINUTE_MS } from '../src/farm-rules.js'

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

function indexEntry (price, samples, at = NOON, momentum = 0) {
  return { price, at, samples, momentum }
}

function stateEntry (price, samples, at = NOON) {
  return { price, at, samples }
}

function close (actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`)
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

test('权重：邻居数分档 × 作物 beta，封顶 85%', () => {
  assert.deepEqual(MARKET_INDEX_WEIGHT_TIERS, [0, 0.45, 0.65, 0.75])
  assert.equal(MARKET_INDEX_WEIGHT_MAX, 0.85)
  assert.equal(MARKET_CROP_BETA.tomato, 0.8)
  assert.equal(MARKET_CROP_BETA.pumpkin, 1.3)
  assert.equal(MARKET_CROP_BETA.watermelon, 1.4)
  assert.equal(marketIndexWeight(0, 'tomato'), 0)
  close(marketIndexWeight(1, 'tomato'), 0.36)
  close(marketIndexWeight(2, 'tomato'), 0.52)
  close(marketIndexWeight(3, 'tomato'), 0.6)
  close(marketIndexWeight(4, 'tomato'), 0.6, 1e-12)
  close(marketIndexWeight(3, 'watermelon'), 0.85, 1e-12)
  close(marketIndexWeight(1, 'unknown-crop'), 0.45)
})

test('指数：只取 peer 价格的中位数；samples 是 peer 数；at 取最新 peer 样本', () => {
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
  // tomato: peer [7,9] → 8；carrot: [12,4] → 8；pumpkin: 999 越界丢掉 → [30] → 30。
  assert.deepEqual(index.tomato, indexEntry(8, 2, NOON - 500))
  assert.deepEqual(index.carrot, indexEntry(8, 2, NOON - 500))
  assert.deepEqual(index.pumpkin, indexEntry(30, 1, NOON - 500))
})

test('动量：邻居整体涨 3% → 指数额外 +1.5%；单轮封顶 ±12%', () => {
  const localPrices = { pumpkin: { base: 30, price: 30 } }
  const up = computeMarketIndex({
    localPrices,
    now: NOON,
    samples: [
      { prices: { pumpkin: 30.9 }, previous: { pumpkin: 30 }, at: NOON },
      { prices: { pumpkin: 30.9 }, previous: { pumpkin: 30 }, at: NOON }
    ]
  })
  // 中位数 30.9，动量 3% → 30.9 × 1.03 = 31.827
  close(up.pumpkin.price, 31.827)
  close(up.pumpkin.momentum, 0.03)

  const capped = computeMarketIndex({
    localPrices,
    now: NOON,
    samples: [{ prices: { pumpkin: 60 }, previous: { pumpkin: 30 }, at: NOON }]
  })
  // 100% 涨幅被压到 12%，60 × 1.12 = 67.2，再被 base×2=60 夹住。
  assert.equal(capped.pumpkin.price, 60)
  assert.equal(capped.pumpkin.momentum, 0.12)

  const down = computeMarketIndex({
    localPrices,
    now: NOON,
    samples: [{ prices: { pumpkin: 27 }, previous: { pumpkin: 30 }, at: NOON }]
  })
  // -10% → 27 × 0.9 = 24.3
  assert.equal(down.pumpkin.price, 24.3)
  assert.equal(down.pumpkin.momentum, -0.1)
})

test('指数：过期/没有 peer 时退化为本机价、samples 0；未知作物/坏价格不拖垮别的作物', () => {
  const localPrices = { tomato: { price: 5 }, carrot: { price: 6 }, pumpkin: { price: 30 } }
  const stale = computeMarketIndex({
    localPrices,
    now: NOON,
    samples: [{ prices: { tomato: 10, carrot: 12, pumpkin: 60 }, at: NOON - 2 * MINUTE_MS - 1 }]
  })
  assert.deepEqual(stale, {
    tomato: indexEntry(5, 0, NOON),
    carrot: indexEntry(6, 0, NOON),
    pumpkin: indexEntry(30, 0, NOON)
  }, '过了 2 分钟的样本一个都不算，指数 = 本机')

  const localOnly = {
    tomato: indexEntry(5, 0, NOON),
    carrot: indexEntry(6, 0, NOON),
    pumpkin: indexEntry(30, 0, NOON)
  }
  assert.deepEqual(computeMarketIndex({ localPrices, now: NOON, samples: [] }), localOnly)
  assert.deepEqual(computeMarketIndex({ localPrices, now: NOON }), localOnly)

  const mixed = computeMarketIndex({
    localPrices,
    now: NOON,
    samples: [
      { prices: { tomato: Number.NaN, carrot: 12, alien: 1 }, at: NOON },
      { prices: { tomato: 7, carrot: Number.POSITIVE_INFINITY, pumpkin: '30' }, at: NOON }
    ]
  })
  assert.deepEqual(mixed.tomato, indexEntry(7, 1, NOON))
  assert.deepEqual(mixed.carrot, indexEntry(12, 1, NOON))
  assert.deepEqual(mixed.pumpkin, indexEntry(30, 1, NOON))
  assert.equal('alien' in mixed, false)

  // 没有本机价、也没有 peer：那种作物不编条目。
  assert.deepEqual(computeMarketIndex({ localPrices: {}, now: NOON, samples: [] }), {})
})

test('混合价：按邻居数/作物 beta 加权；没有指数退回本机价', () => {
  assert.equal(effectivePrice(5), 5)
  assert.equal(effectivePrice(5, null), 5)
  assert.equal(effectivePrice(5, 10, { samples: 0, cropId: 'tomato' }), 5)
  assert.equal(effectivePrice(5, 10, { samples: 1, cropId: 'tomato' }), 6.8)
  assert.equal(effectivePrice(5, 10, { samples: 2, cropId: 'tomato' }), 7.6)
  assert.equal(effectivePrice(5, 10, { samples: 3, cropId: 'watermelon' }), 9.25)
  assert.equal(bidPrice(5), 5)
  assert.equal(bidPrice(10, 5, { samples: 1, cropId: 'tomato' }), 7, 'effective 8.2 → bid 7.38 → 7')
  assert.equal(bidPrice(5, 10, { samples: 3, cropId: 'watermelon' }), 8)
  assert.equal(effectivePrice(0, 10, { samples: 2, cropId: 'tomato' }), 0)
  assert.equal(effectivePrice(5, Number.NaN, { samples: 2, cropId: 'tomato' }), 5)
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

  assert.deepEqual(store.snapshot().index.tomato, stateEntry(5, 0, NOON),
    '没有邻居时指数 = 本机、samples 0')

  const first = store.observeDigest(PEER_A, {
    prices: { tomato: 7, carrot: 9 },
    at: NOON - 1000
  })
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  await first.persisted
  assert.deepEqual(store.snapshot().index.tomato, stateEntry(7, 1, NOON - 1000))
  assert.deepEqual(store.snapshot().index.carrot, stateEntry(9, 1, NOON - 1000))
  assert.deepEqual(store.snapshot().index.pumpkin, stateEntry(30, 0, NOON),
    '没有 peer 样本的作物仍给本机价、samples 0')

  // 同一个 peer 再发一条：替换，不是叠加样本。价格不变，动量归零。
  clock.advance(1000)
  const second = store.observeDigest(PEER_A, {
    prices: { tomato: 7, carrot: 9 },
    at: NOON
  })
  await second.persisted
  assert.deepEqual(store.snapshot().index.tomato, stateEntry(7, 1, NOON))

  // 第二个 peer：两个 peer 样本，中位数取平均。
  clock.advance(1000)
  const third = store.observeDigest(PEER_B, {
    prices: { tomato: 6, carrot: 12 },
    at: NOON + 1000
  })
  await third.persisted
  assert.deepEqual(store.snapshot().index.tomato, stateEntry(6.5, 2, NOON + 1000))
  assert.deepEqual(store.snapshot().index.carrot, stateEntry(10.5, 2, NOON + 1000))

  const file = JSON.parse(await readFile(join(dir, MARKET_FILE), 'utf8'))
  assert.deepEqual(file.index.tomato, indexEntry(6.5, 2, NOON + 1000))

  // 重启：指数还在（盘上有），但已经过期 → 窗口画灰、定价不再采用。
  const restarted = await createMarketStore(dir, { log: { warn () {} }, now: clock.now })
  assert.deepEqual(restarted.snapshot().index.tomato, stateEntry(6.5, 2, NOON + 1000))
  clock.advance(3 * MINUTE_MS)
  assert.equal(restarted.snapshot({ withBid: true }).index.tomato.stale, true)
  assert.equal(restarted.snapshot({ withBid: true }).prices.tomato.bid, 5, '过期指数不参与 bid')
})

test('store：过期样本不删旧指数，但新鲜样本回来会覆盖；坏 digest 不崩', async (t) => {
  const clock = makeClock()
  const { store } = await makeStore(t, clock)
  await store.observeDigest(PEER_A, { prices: { tomato: 10 }, at: NOON }).persisted
  assert.deepEqual(store.snapshot().index.tomato, stateEntry(10, 1, NOON))

  clock.advance(2 * MINUTE_MS + 1)
  // 再收一条过期的（协议层之后、store 之前的时间判断兜底）：不参与重算，旧指数保留。
  const stale = store.observeDigest(PEER_B, { prices: { tomato: 5 }, at: NOON })
  assert.equal(stale.ok, true)
  assert.deepEqual(store.snapshot().index.tomato, stateEntry(10, 1, NOON))
  assert.equal(store.snapshot({ withBid: true }).index.tomato.stale, true)

  for (const bad of [null, {}, { prices: null, at: NOON }, { prices: {}, at: 0 }]) {
    assert.equal(store.observeDigest(PEER_B, bad).ok, false, JSON.stringify(bad))
  }
  assert.equal(store.observeDigest('', { prices: {}, at: NOON }).ok, false)
})

test('store：新鲜指数参与本机卖价（bid 按邻居数/beta 混合），落盘同价', async (t) => {
  const dir = await tempDir(t)
  await writeMarket(dir, priceFile(10))
  const clock = makeClock()
  const store = await createMarketStore(dir, { log: { warn () {} }, now: clock.now })
  const observed = store.observeDigest(PEER_A, { prices: { tomato: 5 }, at: NOON })
  await observed.persisted
  assert.deepEqual(store.snapshot().index.tomato, stateEntry(5, 1, NOON))

  const trade = store.applyTrade({ side: 'sell', cropId: 'tomato', qty: 1, now: NOON })
  assert.equal(trade.ok, true)
  assert.equal(trade.unitPrice, 7, '本机 10 / peer 5 → effective 8.2 → bid 7.38 → 7')
  await trade.persisted
  const file = JSON.parse(await readFile(join(dir, MARKET_FILE), 'utf8'))
  assert.equal(file.history[0].price, trade.unitPrice)
})

test('store.removeDigest：被拒绝/移除的邻居不再影响指数；还有别人时重算', async (t) => {
  const clock = makeClock()
  const { store } = await makeStore(t, clock)
  await store.observeDigest(PEER_A, { prices: { tomato: 8 }, at: NOON }).persisted
  assert.deepEqual(store.snapshot().index.tomato, stateEntry(8, 1, NOON))

  // 还有 PEER_B：取两个 peer 的中位数。
  await store.observeDigest(PEER_B, { prices: { tomato: 9 }, at: NOON }).persisted
  assert.deepEqual(store.snapshot().index.tomato, stateEntry(8.5, 2, NOON))
  const removedA = store.removeDigest(PEER_A)
  assert.equal(removedA.changed, true)
  await removedA.persisted
  assert.deepEqual(store.snapshot().index.tomato, stateEntry(9, 1, NOON))

  // 最后一个新鲜邻居被移除：不再假装有邻居，退化为本机价 / samples 0。
  const removedB = store.removeDigest(PEER_B)
  await removedB.persisted
  assert.deepEqual(store.snapshot().index.tomato, stateEntry(5, 0, NOON))
  assert.equal(store.snapshot().index.carrot.samples, 0)
  assert.equal(store.snapshot().index.pumpkin.samples, 0)

  // 不存在的 deviceId 是 no-op。
  const missing = store.removeDigest(PEER_A)
  assert.equal(missing.ok, true)
  assert.equal(missing.changed, false)
  assert.equal(await missing.persisted, false)
})
