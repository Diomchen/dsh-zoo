/**
 * 票 96：到期交割与转现货。
 *
 * 全部用假时钟 + 真磁盘 + 一只带作物库存的假农场；不起网络（双机路径在
 * `test/futures-net.test.js`）。重点是可复核：交割价必须等于窗口里四根收盘价的均价。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { MAX_STACK } from '../src/farm.js'
import { createFuturesStore } from '../src/futures.js'
import {
  DELIVERY_FEE_RATE,
  LOT_SIZE,
  contractOf,
  deliveryClosesOf,
  deliveryPriceOf,
  notionalOf,
  pnlOf,
  roundCoin,
  takerFeeOf
} from '../src/futures-rules.js'

const CROP = 'tomato'
const CONTRACT = 'tomato-2026W47'

function local (year, month, day, hour, minute = 0, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

const MONDAY = local(2026, 11, 16, 0, 0, 0)
const FRIDAY_LATE = local(2026, 11, 20, 19, 59, 59)
const FRIDAY_EXPIRE = local(2026, 11, 20, 20, 0, 0)
const SATURDAY = local(2026, 11, 21, 10, 0, 0)

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-expiry-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/** 假农场：硬币按上限截断；作物库存与真农场一样封顶 999，且能回滚。 */
function fakeFarm (coins = 1000, { max = 1_000_000 } = {}) {
  const state = { coins, crops: {} }
  return {
    state,
    snapshot () { return { crops: { ...state.crops } } },
    async spendCoins (qty) {
      if (state.coins < qty) return { ok: false, error: 'no-coin' }
      state.coins -= qty
      return { ok: true, qty, coins: state.coins }
    },
    async addCoins (qty) {
      const before = state.coins
      state.coins = Math.min(max, before + qty)
      return { ok: true, qty: state.coins - before, coins: state.coins }
    },
    async addCrop (crop, qty) {
      const before = state.crops[crop] ?? 0
      const after = Math.min(MAX_STACK, before + Math.floor(qty))
      state.crops[crop] = after
      return { ok: true, action: 'add-crop', crop, qty: after - before, crops: { ...state.crops } }
    },
    async takeCropOf (crop, qty) {
      const before = state.crops[crop] ?? 0
      if (before < qty) return { ok: false, error: 'not-enough-crops' }
      state.crops[crop] = before - qty
      return { ok: true, crop, qty, crops: { ...state.crops } }
    }
  }
}

async function makeStore (t, { coins = 1000, at = MONDAY, indexPrice = 10 } = {}) {
  const dir = await tempDir(t)
  const farm = fakeFarm(coins)
  let now = at
  const store = await createFuturesStore(dir, {
    farm,
    now: () => now,
    indexOf: () => indexPrice,
    log: { warn () {} }
  })
  // 票 98：缺省 shadow 不动农场；这组用例验交割与转现货的真钱口径。
  await store.setMode('live')
  return { dir, farm, store, setNow: (ms) => { now = ms }, now: () => now }
}

test('周一 00:00 上新合约；周五 19:59:59 仍可开仓，20:00 整休市，周六是 weekend', async (t) => {
  const { store } = await makeStore(t)
  assert.equal(contractOf(CROP, MONDAY).id, CONTRACT)
  assert.equal(contractOf(CROP, FRIDAY_LATE).id, CONTRACT)
  assert.equal(contractOf(CROP, FRIDAY_EXPIRE), null)

  await store.deposit(1000)
  const opened = await store.open({
    crop: CROP,
    side: 'long',
    margin: 100,
    leverage: 10,
    at: FRIDAY_LATE
  })
  assert.equal(opened.ok, true, '19:59:59 必须还能开仓')

  const closed = await store.open({
    crop: CROP,
    side: 'long',
    margin: 100,
    leverage: 10,
    at: FRIDAY_EXPIRE
  })
  assert.equal(closed.ok, false)
  assert.equal(closed.error, 'market-closed')
  assert.match(closed.notice, /合约已到期/)

  const friday = store.snapshot({ at: FRIDAY_EXPIRE, crop: CROP })
  assert.equal(friday.session.kind, 'expired')
  assert.match(friday.session.text, /下周一 00:00 开新合约/)
  assert.equal(friday.delivery.contract, CONTRACT)
  assert.equal(friday.delivery.closes.length, 4)
  assert.equal(friday.delivery.price, deliveryPriceOf({
    crop: CROP,
    contractId: CONTRACT,
    indexOf: () => 10,
    at: FRIDAY_EXPIRE
  }))

  const saturday = store.snapshot({ at: SATURDAY, crop: CROP })
  assert.equal(saturday.session.kind, 'weekend')
  assert.equal(saturday.delivery, null, '周六窗口不再展示上一周的交付价')
})

test('交割价 = 19:00–20:00 四根收盘价的算术平均，且窗口四根可复核', async (t) => {
  const { store } = await makeStore(t)
  const closes = deliveryClosesOf({
    crop: CROP,
    contractId: CONTRACT,
    indexOf: () => 10,
    at: FRIDAY_EXPIRE
  })
  assert.equal(closes.length, 4)
  for (const close of closes) assert.ok(close > 0)
  const price = roundCoin(closes.reduce((sum, close) => sum + close, 0) / closes.length)
  assert.equal(deliveryPriceOf({ crop: CROP, contractId: CONTRACT, indexOf: () => 10, at: FRIDAY_EXPIRE }), price)

  const view = store.snapshot({ at: FRIDAY_EXPIRE, crop: CROP })
  assert.deepEqual(view.delivery.closes, closes)
  assert.equal(view.delivery.price, price)
  assert.equal(view.delivery.at, FRIDAY_EXPIRE)
})

test('到期现金交割：仓位清零、余额 = 期初 − 开仓费 + 盈亏 − 交割费，marginUsed 归零', async (t) => {
  // 19:00 开仓：此时合约还在，交割价取 19:15–20:00 四根，与开仓价不同，正好验盈亏。
  const openAt = local(2026, 11, 20, 19, 0, 0)
  const { store } = await makeStore(t)
  await store.deposit(1000)
  const opened = await store.open({ crop: CROP, side: 'long', margin: 200, leverage: 10, at: openAt })
  assert.equal(opened.ok, true)
  const position = opened.position
  const price = deliveryPriceOf({ crop: CROP, contractId: CONTRACT, indexOf: () => 10, at: FRIDAY_EXPIRE })
  const pnl = pnlOf({ lots: position.lots, entry: position.entry, exit: price, side: 'long' })
  const deliveryFee = roundCoin(notionalOf({ lots: position.lots, price }) * DELIVERY_FEE_RATE)

  const result = await store.expireDue(FRIDAY_EXPIRE)
  assert.equal(result.ok, true)
  assert.equal(result.action, 'futures-expire')
  assert.equal(result.deliveries.length, 1)
  assert.equal(result.deliveries[0].contract, CONTRACT)
  assert.equal(result.deliveries[0].price, price)

  const view = store.snapshot({ at: FRIDAY_EXPIRE, crop: CROP })
  assert.equal(view.positions.length, 0)
  assert.equal(view.positionCount, 0)
  assert.equal(view.marginUsed, 0)
  assert.equal(view.balance, roundCoin(1000 - opened.fee + pnl - deliveryFee))
  const trade = view.trades.find((entry) => entry.kind === 'delivery')
  assert.ok(trade, '成交记录里必须有一条交割')
  assert.equal(trade.price, price)
  assert.equal(trade.deliveryFee, deliveryFee)
  assert.equal(trade.lots, position.lots)
})

test('到期先撤单：挂单消失、冻结保证金退回；重复 expireDue 不重复退', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(1000)
  const placed = await store.place({
    crop: CROP,
    side: 'long',
    price: 1,
    lots: 2,
    leverage: 10,
    at: local(2026, 11, 20, 18, 0, 0)
  })
  assert.equal(placed.ok, true)
  const frozen = placed.order.marginFrozen
  const before = store.snapshot({ at: local(2026, 11, 20, 18, 0, 0) })
  assert.equal(before.orders.length, 1)

  const first = await store.expireDue(FRIDAY_EXPIRE)
  assert.equal(first.deliveries.length, 1)
  assert.equal(first.deliveries[0].cancelled, 1)
  const after = store.snapshot({ at: FRIDAY_EXPIRE, crop: CROP })
  assert.deepEqual(after.orders, [])
  assert.equal(after.balance, roundCoin(before.balance + frozen))
  assert.equal(after.marginUsed, 0)

  const balance = after.balance
  const second = await store.expireDue(FRIDAY_EXPIRE + 15_000)
  assert.deepEqual(second.deliveries, [])
  assert.equal(store.snapshot({ at: FRIDAY_EXPIRE + 15_000 }).balance, balance)
})

test('转现货：整张与部分（lots:1 分两次）都入作物库存，守恒只差手续费', async (t) => {
  const at = local(2026, 11, 20, 19, 0, 0)
  const { store, farm } = await makeStore(t, { coins: 10_000 })
  await store.deposit(10_000)
  // 按 ask 反推「正好两张」的保证金，后面才能用 lots:1 分两次平完。
  const asking = store.quoteOf(CROP, at).ask
  const margin = Math.ceil(2 * asking * LOT_SIZE / 10)
  const opened = await store.open({ crop: CROP, side: 'long', margin, leverage: 10, at })
  assert.equal(opened.ok, true)
  const position = opened.position
  assert.equal(position.lots, 2, '这组参数正好开 2 张')

  const fair = roundCoin(store.quoteOf(CROP, at).fair)
  const before = store.snapshot({ at })
  const beforePnl = pnlOf({ lots: position.lots, entry: position.entry, exit: fair, side: position.side })
  const beforeWealth = roundCoin(before.balance + before.marginUsed + beforePnl)

  const first = await store.convertToSpot({ positionId: position.id, lots: 1, at })
  assert.equal(first.ok, true)
  assert.equal(first.qty, LOT_SIZE)
  assert.equal(farm.state.crops[CROP], LOT_SIZE)
  const mid = store.snapshot({ at })
  assert.equal(mid.positions[0].lots, position.lots - 1)
  assert.equal(mid.marginUsed, roundCoin(position.margin - first.marginPart))
  // 平掉那一张释放的保证金 + 浮盈，恰好够买 100 个作物，再扣一腿 taker 费。
  assert.equal(mid.balance, roundCoin(before.balance + first.marginPart + first.pnl - first.cost - first.fee))
  const remainingPnl = pnlOf({
    lots: mid.positions[0].lots,
    entry: mid.positions[0].entry,
    exit: fair,
    side: mid.positions[0].side
  })
  const midWealth = roundCoin(mid.balance + mid.marginUsed + farm.state.crops[CROP] * fair + remainingPnl)
  assert.equal(Math.abs(midWealth - (beforeWealth - first.fee)) <= 0.05, true, `转现货不应凭空造钱：${midWealth} vs ${beforeWealth - first.fee}`)

  const second = await store.convertToSpot({ positionId: position.id, lots: 1, at })
  assert.equal(second.ok, true)
  const done = store.snapshot({ at })
  assert.equal(done.positions.length, 0)
  assert.equal(done.marginUsed, 0)
  assert.equal(farm.state.crops[CROP], LOT_SIZE * 2)
  const doneWealth = roundCoin(done.balance + farm.state.crops[CROP] * fair)
  assert.equal(Math.abs(doneWealth - (beforeWealth - first.fee - second.fee)) <= 0.05, true, `整张平完后只剩两次手续费：${doneWealth} vs ${beforeWealth - first.fee - second.fee}`)
  assert.equal(done.trades.filter((entry) => entry.kind === 'convert').length, 2)
})

test('转现货拒绝：无仓位、坏张数、到期后、余额不足都有明确错误码', async (t) => {
  const at = local(2026, 11, 20, 19, 0, 0)
  const { store } = await makeStore(t)
  await store.deposit(300)
  const opened = await store.open({ crop: CROP, side: 'long', margin: 200, leverage: 20, at })
  assert.equal(opened.ok, true)

  assert.equal((await store.convertToSpot({ positionId: randomUUID(), lots: 1, at })).error, 'no-position')
  assert.equal((await store.convertToSpot({ positionId: opened.position.id, lots: 0, at })).error, 'bad-lots')
  assert.equal(
    (await store.convertToSpot({ positionId: opened.position.id, lots: opened.position.lots + 1, at })).error,
    'bad-lots'
  )
  // 杠杆 20 + 只有 300 币：一张也买不起，拒绝而不是把余额扣成负数。
  const broke = await store.convertToSpot({ positionId: opened.position.id, lots: 1, at })
  assert.equal(broke.error, 'no-coins')

  const expired = await store.convertToSpot({
    positionId: opened.position.id,
    lots: 1,
    at: FRIDAY_EXPIRE
  })
  assert.equal(expired.error, 'contract-expired')
})
