/**
 * 票 41：交易所 + 农场两本账的库存守恒。
 *
 * 买卖必须同时改 `farm.json` 的硬币/种子/作物与 `market.json` 的价格/历史；
 * 这里用真磁盘验证「扣多少、加多少、什么时候明确失败」。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_HIRE,
  FARM_FILE,
  FARM_VERSION,
  MAX_COINS,
  MAX_STACK,
  PLOT_IDS,
  START_COINS,
  START_SEEDS,
  createFarmStore,
  emptyPlot
} from '../src/farm.js'
import { CROPS, MAX_DEW, localDayKey } from '../src/farm-rules.js'
import { MARKET_FILE, createMarketStore } from '../src/market.js'

const NOON = new Date(2026, 4, 6, 12, 0, 0).getTime()
const TODAY = localDayKey(NOON)

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-farm-market-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function logSink () {
  return { warn () {} }
}

function makeClock (start = NOON) {
  let value = start
  return { now: () => value, set (next) { value = next }, advance (ms) { value += ms } }
}

function farmFile (overrides = {}) {
  return {
    version: FARM_VERSION,
    coins: START_COINS,
    seeds: { ...START_SEEDS },
    crops: {},
    dew: 0,
    dewEarned: 0,
    dewAt: NOON,
    dewDay: TODAY,
    dewDayEarned: TODAY,
    lastTickAt: NOON,
    plots: PLOT_IDS.map(emptyPlot),
    hire: { ...DEFAULT_HIRE },
    log: [],
    ...overrides
  }
}

async function writeFarm (dir, value) {
  await writeFile(join(dir, FARM_FILE), JSON.stringify(value), 'utf8')
}

async function readJson (dir, file) {
  return JSON.parse(await readFile(join(dir, file), 'utf8'))
}

async function makeStores (dir, clock, farmOverrides = {}) {
  if (farmOverrides !== null) await writeFarm(dir, farmFile(farmOverrides))
  const market = await createMarketStore(dir, { log: logSink(), now: clock.now })
  const farm = await createFarmStore(dir, { log: logSink(), market, now: clock.now })
  return { farm, market }
}

test('买种子：扣硬币、加种子、交易所记一笔 buy；两本账一起落盘', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const { farm } = await makeStores(dir, clock)

  const bought = await farm.buySeed('tomato', 2)
  assert.equal(bought.ok, true)
  assert.equal(bought.action, 'buy-seed')
  assert.equal(bought.unitPrice, CROPS.tomato.seedPrice)
  assert.equal(bought.total, 12)
  assert.equal(bought.coins, 18)
  assert.deepEqual(bought.seeds, { tomato: 4 })
  assert.equal(bought.persisted, true)
  assert.match(bought.notice, /买了 2 颗小番茄种子/)

  const farmFileAfter = await readJson(dir, FARM_FILE)
  assert.equal(farmFileAfter.coins, 18)
  assert.deepEqual(farmFileAfter.seeds, { tomato: 4 })
  const marketFileAfter = await readJson(dir, MARKET_FILE)
  assert.equal(marketFileAfter.history[0].side, 'buy')
  assert.equal(marketFileAfter.history[0].qty, 2)
  assert.equal(marketFileAfter.history[0].price, 6)
})

test('卖作物：按 bid 加硬币、扣作物，价格随数量下跌；作物不会卖成负数', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const { farm } = await makeStores(dir, clock, { crops: { tomato: 10 } })

  const sold = await farm.sellCrop('tomato', 3)
  assert.equal(sold.ok, true)
  assert.equal(sold.unitPrice, 5, '初始价 5 → bid 5')
  assert.equal(sold.total, 15)
  assert.equal(sold.coins, 45)
  assert.deepEqual(sold.crops, { tomato: 7 })
  assert.ok(sold.price < 5, '卖 3 个之后价格下跌')
  assert.match(sold.notice, /卖了 3 个小番茄/)

  const farmFileAfter = await readJson(dir, FARM_FILE)
  assert.equal(farmFileAfter.coins, 45)
  assert.deepEqual(farmFileAfter.crops, { tomato: 7 })
  const marketFileAfter = await readJson(dir, MARKET_FILE)
  assert.equal(marketFileAfter.history[0].side, 'sell')
  assert.equal(marketFileAfter.history[0].qty, 3)
  assert.equal(marketFileAfter.history[0].price, 5)
  assert.equal(marketFileAfter.prices.tomato.price, sold.price)
})

test('错误码：bad-crop / bad-qty / no-coin / no-seed；失败不动任何一本账', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const { farm } = await makeStores(dir, clock)

  const badCrop = await farm.buySeed('alien', 1)
  assert.equal(badCrop.error, 'bad-crop')
  const badQty = await farm.buySeed('tomato', 100)
  assert.equal(badQty.error, 'bad-qty')
  const noCoin = await farm.buySeed('pumpkin', 1)
  assert.equal(noCoin.error, 'no-coin', '初始 30 硬币买不起 36 的南瓜种子')
  const noCrop = await farm.sellCrop('tomato', 1)
  assert.equal(noCrop.error, 'no-crop')
  assert.match(noCrop.notice, /没有这种作物/)
  assert.equal((await farm.buySeed('tomato', 0)).error, 'bad-qty')
  assert.equal((await farm.buySeed('tomato', 2.5)).error, 'bad-qty', '只认整数')

  const file = await readJson(dir, FARM_FILE)
  assert.equal(file.coins, START_COINS)
  assert.deepEqual(file.seeds, { ...START_SEEDS })
  assert.deepEqual(file.crops, {})
  await assert.rejects(readFile(join(dir, MARKET_FILE), 'utf8'), /ENOENT/, '失败不写交易所')
})

test('仓库上限：硬币/种子都夹在 SPEC 的上限内', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const { farm } = await makeStores(dir, clock, {
    coins: MAX_COINS,
    seeds: { tomato: MAX_STACK }
  })
  assert.equal((await farm.buySeed('tomato', 1)).error, 'cap')
  assert.equal((await farm.buySeed('carrot', 1)).ok, true)
  assert.equal((await farm.buySeed('pumpkin', 1)).ok, true)
  assert.equal(farm.snapshot().coins, MAX_COINS - CROPS.carrot.seedPrice - CROPS.pumpkin.seedPrice)
  assert.equal(farm.snapshot().coins < MAX_COINS, true)
})

test('每分钟最多 10 笔：第 11 笔明确 market-busy，前 10 笔都已落盘', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const { farm } = await makeStores(dir, clock, {
    coins: MAX_COINS,
    seeds: {},
    dew: MAX_DEW,
    dewEarned: MAX_DEW
  })

  for (let index = 0; index < 10; index += 1) {
    const bought = await farm.buySeed('tomato', 1)
    assert.equal(bought.ok, true, '第 ' + (index + 1) + ' 笔应该成功')
  }
  const blocked = await farm.buySeed('tomato', 1)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error, 'market-busy')
  assert.equal(blocked.persisted, false)

  const file = await readJson(dir, FARM_FILE)
  assert.deepEqual(file.seeds, { tomato: 10 })
  const marketFileAfter = await readJson(dir, MARKET_FILE)
  assert.equal(marketFileAfter.history.length, 10)

  clock.advance(61 * 1000)
  assert.equal((await farm.buySeed('tomato', 1)).ok, true, '过了 1 分钟窗口恢复')
})

test('买卖会重置待机计时（和种/收/浇/施肥同一条规则）', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const { farm } = await makeStores(dir, clock, { dew: 0, dewEarned: 0, dewAt: NOON })
  clock.advance(10 * 60 * 1000)
  // 交易入口先 advance，10 分钟攒的 1 点露水不会因为买卖丢掉；同时把待机锚点推到 now。
  const first = await farm.buySeed('tomato', 1)
  assert.equal(first.dew, 1)
  clock.advance(5 * 60 * 1000)
  const second = await farm.buySeed('tomato', 1)
  assert.equal(second.dew, 1, '买卖刚重置过待机，5 分钟还不够再攒 1 点')
  clock.advance(10 * 60 * 1000)
  const third = await farm.buySeed('tomato', 1)
  assert.equal(third.dew, 2, '又攒满 10 分钟，再得 1 点')
})
