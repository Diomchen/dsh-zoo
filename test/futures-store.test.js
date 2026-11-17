/**
 * 票 92：期货账本（`<dataDir>/futures.json`）。
 *
 * 只回答四件事：充提与农场硬币对得上、吃单开仓的钱怎么分、每根结算只结算一次、
 * 坏文件怎么降级。全部用真磁盘（tmpdir）和一只假农场，不起 service/网络。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CROPS } from '../src/farm-rules.js'
import {
  FUTURES_FILE,
  FUTURES_VERSION,
  createFuturesStore,
  initialFuturesState,
  normalizeFuturesFile
} from '../src/futures.js'
import {
  HOUR_MS,
  SLOT_MS,
  contractOf,
  fairPriceOf,
  fillPriceOf,
  lotsFor,
  marginOf,
  notionalOf,
  pnlOf,
  quotesOf,
  roundCoin,
  takerFeeOf
} from '../src/futures-rules.js'

const MONDAY = new Date(2026, 10, 16, 10, 0, 0, 0).getTime()

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function logSink () {
  const warnings = []
  return { warnings, log: { warn (line) { warnings.push(line) } } }
}

/** 假农场：`addCoins` 在上限处静默截断，和真农场一样。 */
function fakeFarm (coins, { max = 1_000_000 } = {}) {
  const state = { coins }
  return {
    state,
    async spendCoins (qty) {
      if (state.coins < qty) return { ok: false, error: 'no-coin' }
      state.coins -= qty
      return { ok: true, qty, coins: state.coins }
    },
    async addCoins (qty) {
      const before = state.coins
      state.coins = Math.min(max, before + qty)
      return { ok: true, qty: state.coins - before, coins: state.coins }
    }
  }
}

async function makeStore (t, { coins = 1000, at = MONDAY, max = 1_000_000 } = {}) {
  const dir = await tempDir(t)
  const farm = fakeFarm(coins, { max })
  let now = at
  const sink = logSink()
  const store = await createFuturesStore(dir, { farm, now: () => now, log: sink.log })
  return { dir, farm, store, sink, advance: (ms) => { now += ms }, now: () => now }
}

test('初始：没有文件时是空账本，不告警', async (t) => {
  const { store, sink } = await makeStore(t)
  const view = store.snapshot()
  assert.equal(view.balance, 0)
  assert.equal(view.marginUsed, 0)
  assert.deepEqual(view.fees, { insurance: 0, burned: 0 })
  assert.deepEqual(view.positions, [])
  assert.equal(sink.warnings.length, 0)
})

test('充值：农场硬币等额进托管账户；硬币不够时整体失败', async (t) => {
  const { store, farm } = await makeStore(t, { coins: 500 })
  const ok = await store.deposit(300)
  assert.equal(ok.ok, true)
  assert.equal(ok.balance, 300)
  assert.equal(farm.state.coins, 200)

  const broke = await store.deposit(500)
  assert.equal(broke.ok, false)
  assert.equal(broke.error, 'no-coin')
  assert.equal(farm.state.coins, 200, '失败时农场一分不动')
  assert.equal(store.snapshot().balance, 300)
})

test('开仓：保证金与 taker 费从余额划走，张数由名义价值决定', async (t) => {
  const { store } = await makeStore(t, { coins: 5000 })
  await store.deposit(1000)
  const at = MONDAY + 3 * HOUR_MS
  const result = await store.open({ crop: 'tomato', side: 'long', margin: 100, leverage: 10, at })
  assert.equal(result.ok, true)

  const contract = contractOf('tomato', at)
  const index = CROPS.tomato.base
  const fair = fairPriceOf({ indexPrice: index, crop: 'tomato', contractId: contract.id, at })
  const quotes = quotesOf(fair)
  const price = quotes.ask
  const notional = 100 * 10
  const lots = lotsFor({ notional, price })
  const margin = marginOf({ lots, price, leverage: 10 })
  const fee = takerFeeOf(notionalOf({ lots, price }))

  assert.equal(result.lots, lots)
  assert.equal(result.price, price)
  assert.equal(result.fee, fee)
  const view = store.snapshot({ at })
  assert.equal(view.balance, roundCoin(1000 - margin - fee))
  assert.equal(view.marginUsed, margin)
  assert.equal(view.equity, roundCoin(1000 - fee))
  assert.equal(view.positions.length, 1)
  assert.equal(view.positions[0].settleSlot, Math.floor(at / SLOT_MS) + 1)
  // 费用 10% 进保险基金、90% 销毁，两边相加恰好等于收的钱
  assert.equal(roundCoin(view.fees.insurance + view.fees.burned), fee)
})

test('开仓：余额不够保证金+手续费就拒绝，账本不动', async (t) => {
  const { store } = await makeStore(t, { coins: 1000 })
  await store.deposit(50)
  const at = MONDAY + 3 * HOUR_MS
  const result = await store.open({ crop: 'tomato', side: 'long', margin: 100, leverage: 20, at })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-balance')
  const view = store.snapshot({ at })
  assert.equal(view.balance, 50)
  assert.equal(view.positions.length, 0)
})

test('开仓：周五 20:00 之后没有合约', async (t) => {
  const { store } = await makeStore(t, { coins: 1000 })
  await store.deposit(500)
  const saturday = MONDAY + 5 * 24 * HOUR_MS
  const result = await store.open({ crop: 'tomato', side: 'long', margin: 100, leverage: 10, at: saturday })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'market-closed')
})

test('盯市：一根结束时按收盘公允价重估，仓位继续持有，重复调用不重复入账', async (t) => {
  const at = MONDAY + 3 * HOUR_MS
  const { store, advance } = await makeStore(t, { coins: 5000, at })
  await store.deposit(1000)
  const opened = await store.open({ crop: 'tomato', side: 'long', margin: 100, leverage: 10, at })
  const position = opened.position

  advance(SLOT_MS)
  const settled = await store.settleDue()
  assert.equal(settled.settled.length, 1)
  assert.equal(settled.settled[0].position.id, position.id)
  assert.equal(settled.settled[0].liquidated, false)

  const contract = contractOf('tomato', at)
  const settleAt = position.settleSlot * SLOT_MS
  const fair = roundCoin(fairPriceOf({
    indexPrice: CROPS.tomato.base, crop: 'tomato', contractId: contract.id, at: settleAt
  }))
  const expectedPnl = pnlOf({ lots: position.lots, entry: position.entry, exit: fair, side: 'long' })
  assert.equal(settled.settled[0].price, fair, '按收盘公允价（中间价）结，不再吃买卖价差')

  const view = store.snapshot({ at: settleAt })
  assert.equal(view.positions.length, 1, '盯市不删仓位，周合约才拿得住')
  assert.equal(view.positions[0].entry, fair, '入场价改成收盘价，浮盈亏已经落袋')
  assert.equal(view.positions[0].settleSlot, Math.floor(settleAt / SLOT_MS) + 1)
  assert.equal(view.marginUsed, position.margin, '保证金不动')
  assert.equal(view.balance, roundCoin(1000 - position.margin - opened.fee + expectedPnl))

  // 再跑一次：这一根已经结过（settleSlot 前进过），余额一分不动
  const again = await store.settleDue()
  assert.equal(again.settled.length, 0)
  assert.equal(store.snapshot().balance, view.balance)
})

test('盯市：重启后不会把已经结过的那一根再结一次', async (t) => {
  const { store, dir, farm } = await makeStore(t, { coins: 5000 })
  await store.deposit(1000)
  const at = MONDAY + 3 * HOUR_MS
  await store.open({ crop: 'tomato', side: 'long', margin: 100, leverage: 10, at })
  const reloaded = await createFuturesStore(dir, { farm, now: () => at + SLOT_MS })
  const settled = await reloaded.settleDue()
  assert.equal(settled.settled.length, 1)
  const afterFirst = reloaded.snapshot().balance

  const again = await createFuturesStore(dir, { farm, now: () => at + SLOT_MS })
  const settledAgain = await again.settleDue()
  assert.equal(settledAgain.settled.length, 0, '第二本账不该再结一次')
  assert.equal(again.snapshot().balance, afterFirst)
})

test('epoch：每次启动换新，盘上的旧值只当历史', async (t) => {
  const { store, dir, farm } = await makeStore(t, { coins: 5000 })
  await store.deposit(100)
  const first = store.snapshot().epoch
  assert.match(first, /^[0-9a-f-]{36}$/)
  const reloaded = await createFuturesStore(dir, { farm, now: () => MONDAY })
  assert.notEqual(reloaded.snapshot().epoch, first, '换一本账就要换一个 epoch')
})

test('到期守卫：周五最后一根开的仓结得掉；过期后手动平仓被拒', async (t) => {
  const { store } = await makeStore(t, { coins: 5000 })
  await store.deposit(1000)
  const window = contractOf('tomato', MONDAY)
  // 周五 19:50 开仓：这一根的收盘正好是 20:00（到期那一毫秒）
  const at = window.expireAt - 10 * 60 * 1000
  const opened = await store.open({ crop: 'tomato', side: 'long', margin: 100, leverage: 10, at })
  assert.equal(opened.ok, true, JSON.stringify(opened.ok))

  const settled = await store.settleDue(at + SLOT_MS)
  assert.equal(settled.settled.length, 1, '到期那一根不能变成永远结不掉的僵尸仓位')

  const loser = await store.open({ crop: 'tomato', side: 'short', margin: 100, leverage: 10, at })
  const closed = await store.close({ id: loser.position.id, at: window.expireAt + 60 * 1000 })
  assert.equal(closed.ok, false)
  assert.equal(closed.error, 'contract-expired')
})

test('平仓：按对手价成交，保证金+盈亏回到余额', async (t) => {
  const { store } = await makeStore(t, { coins: 5000 })
  await store.deposit(1000)
  const at = MONDAY + 3 * HOUR_MS
  const opened = await store.open({ crop: 'tomato', side: 'short', margin: 100, leverage: 10, at })
  const closed = await store.close({ id: opened.position.id, at: at + 60 * 1000 })
  assert.equal(closed.ok, true)

  const view = store.snapshot({ at: at + 60 * 1000 })
  assert.equal(view.positions.length, 0)
  assert.equal(view.marginUsed, 0)
  assert.equal(view.balance, roundCoin(1000 - opened.fee + closed.pnl))
  assert.ok(closed.credit >= 0)
})

test('提现：超过农场上限时按 1,000,000 分批，并只扣实收的部分', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(0)
  const store = await createFuturesStore(dir, { farm, now: () => MONDAY })
  // 直接改盘上的余额到 1,500,000（托管账户没有上限，农场才有）
  await writeFile(join(dir, FUTURES_FILE), JSON.stringify({
    version: 1, epoch: 'e', balance: 1_500_000, marginUsed: 0,
    fees: { insurance: 0, burned: 0 }, positions: [], closed: 0, tradedAt: 0
  }))
  // 农场默认上限 1,000,000：第一笔加满，第二笔被静默吞掉，必须只扣实收的那 1,000,000
  const reloaded = await createFuturesStore(dir, { farm, now: () => MONDAY })

  const result = await reloaded.withdraw(1_200_000)
  assert.equal(result.ok, true)
  assert.equal(result.coins, 1_000_000, '只有农场实收的那部分才算提走')
  assert.equal(farm.state.coins, 1_000_000)
  assert.equal(reloaded.snapshot().balance, 500_000, '没加进去的 200,000 留在托管账户里')
})

test('坏文件：按空账本运行、只告警一次、不写回盘上的坏内容', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(0)
  const sink = logSink()
  const bad = '{ 这不是 JSON'
  await writeFile(join(dir, FUTURES_FILE), bad)

  const store = await createFuturesStore(dir, { farm, now: () => MONDAY, log: sink.log })
  assert.equal(store.snapshot().balance, 0)
  assert.equal(sink.warnings.length, 1)
  assert.equal(await readFile(join(dir, FUTURES_FILE), 'utf8'), bad, '读的时候不改写用户的文件')
})

test('修补：仓位丢了但 marginUsed 还在时，以仓位总额为准', () => {
  const normalized = normalizeFuturesFile({
    version: 1,
    balance: 10,
    marginUsed: 999,
    positions: [],
    fees: { insurance: 0, burned: 0 }
  })
  assert.equal(normalized.corrupt, false)
  assert.equal(normalized.futures.marginUsed, 0)
  assert.ok(normalized.repaired > 0)

  const broken = normalizeFuturesFile('nope')
  assert.equal(broken.corrupt, true)
  assert.deepEqual(broken.futures, initialFuturesState())
})

test('耐久：动钱之后盘上有一份完整账本', async (t) => {
  const { store, dir } = await makeStore(t, { coins: 500 })
  await store.deposit(200)
  const raw = JSON.parse(await readFile(join(dir, FUTURES_FILE), 'utf8'))
  assert.equal(raw.version, FUTURES_VERSION)
  assert.equal(raw.balance, 200)
  assert.equal(typeof raw.epoch, 'string')
  assert.ok(raw.epoch.length > 10)
})
