/**
 * 票 98：灰度开关（off/shadow/live）与敞口限额。
 *
 * 覆盖票面验收：
 *   1. 三档状态机：off 拒一切；shadow 充提只记账、开仓只动托管；live 真扣真加；
 *   2. 影子对账 `diff === 0`，切 live 后充提一笔仍为 0；
 *   3. 日额 4,999 通过 / 5,000 拒；持仓名义 19,999 通过 / 20,000 拒；
 *   4. 同源 20 包/10 秒的第 21 包被丢；
 *   5. 影子模式日额上限为 0（新开仓/挂单一律 daily-cap）；
 *   6. 回滚：强平、退款、`disabled`、再开仓被拒；撞上限的余额留在 pending；
 *   7. 提现撞 1,000,000 上限：`credited` 精确、余数留在托管账。
 *
 * 全部用假时钟 + 假农场。边界用例直接写 `futures.json` 落盘文件做初始状态，
 * 避免 `setMode` 自带的流水/seq 影响断言。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MAX_COINS } from '../src/farm.js'
import { createFuturesStore } from '../src/futures.js'
import {
  SLOT_MS,
  contractOf,
  fillPriceOf,
  lotsFor,
  notionalOf
} from '../src/futures-rules.js'
import { createFuturesRateLimiter } from '../src/service.js'

// 2026-11-17 是周二；取本地 12:00（UTC 12:00 在东八区已过 20:00 交割，日合约会休市）。
const NOW = new Date(2026, 10, 17, 12, 0, 0, 0).getTime()
const CROP = 'tomato'
const PEER = '11111111-1111-4111-8111-111111111111'

function fakeFarm (coins = 500, { max = MAX_COINS } = {}) {
  const state = { coins }
  return {
    state,
    snapshot: () => ({ coins: state.coins }),
    async spendCoins (qty) {
      if (!(qty > 0) || state.coins < qty) return { ok: false, error: 'no-coin' }
      state.coins -= qty
      return { ok: true, action: 'spend-coins', qty, coins: state.coins }
    },
    async addCoins (qty) {
      const amount = Math.max(0, Math.min(max - state.coins, Math.floor(qty)))
      state.coins += amount
      return { ok: true, action: 'add-coins', qty: amount, coins: state.coins }
    }
  }
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-mode-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function makeStore (t, { mode = 'shadow', coins = 500, file = null } = {}) {
  const dir = await tempDir(t)
  if (file !== null) await writeFile(join(dir, 'futures.json'), JSON.stringify(file), 'utf8')
  else if (mode !== 'shadow') await writeFile(join(dir, 'futures.json'), JSON.stringify({ version: 1, mode }), 'utf8')
  const farm = fakeFarm(coins)
  const store = await createFuturesStore(dir, { farm, now: () => NOW })
  return { dir, farm, store }
}

/** 在同一个目录上按给定落盘内容重开一本账（农场句柄可复用）。 */
async function reloadStore (t, dir, farm) {
  return createFuturesStore(dir, { farm, now: () => NOW })
}

function quotePrice (store) {
  const quote = store.quoteOf(CROP, NOW)
  assert.ok(quote !== null, '本周合约应该有报价')
  return fillPriceOf(quote, 'long')
}

function positionSeed (margin, price) {
  const contract = contractOf(CROP, NOW)
  const slot = Math.floor(NOW / SLOT_MS)
  return {
    id: 'seed-position-1',
    crop: CROP,
    contract: contract.id,
    side: 'long',
    lots: 1,
    entry: price,
    margin,
    leverage: 1,
    openedAt: NOW,
    slot,
    settleSlot: slot + 1
  }
}

test('票 98：缺省是 shadow，充值提现不碰农场，开仓只动托管', async (t) => {
  const { store, farm } = await makeStore(t)
  const view = store.snapshot({ at: NOW })
  assert.equal(view.mode, 'shadow')
  assert.equal(view.session.kind, 'shadow')
  assert.equal(view.session.text, '影子模式：只记账，不动农场硬币')

  const funded = await store.deposit(5000)
  assert.equal(funded.ok, true)
  assert.equal(farm.state.coins, 500, '影子充值不花农场硬币')
  assert.equal(store.snapshot().balance, 5000)

  const opened = await store.open({ crop: CROP, side: 'long', margin: 50, leverage: 1, at: NOW })
  // 影子模式日额上限 0：新开仓一律 daily-cap，不会走到扣款。
  assert.equal(opened.ok, false)
  assert.equal(opened.error, 'daily-cap')
  assert.equal(store.snapshot().balance, 5000)

  const paid = await store.withdraw(30)
  assert.equal(paid.ok, true)
  assert.equal(paid.credited, 30)
  assert.equal(paid.pending, 0)
  assert.equal(farm.state.coins, 500, '影子提现不加农场硬币')
  assert.equal(store.snapshot().balance, 4970)
})

test('票 98：off 拒绝一切期货动作，窗口显示「期货未开放」', async (t) => {
  const { store, farm } = await makeStore(t)
  const switched = await store.setMode('off', NOW)
  assert.equal(switched.ok, true)
  assert.equal(store.snapshot().session.kind, 'off')
  assert.equal(store.snapshot().session.text, '期货未开放')
  const audit = store.snapshot().trades[0]
  assert.equal(audit.kind, 'mode')
  assert.equal(audit.note, 'off')
  assert.equal(audit.price, 0)
  assert.equal(audit.lots, 0)

  const results = [
    await store.deposit(10),
    await store.withdraw(10),
    await store.open({ crop: CROP, side: 'long', margin: 10, leverage: 1, at: NOW }),
    await store.place({ crop: CROP, side: 'long', price: quotePrice(store), lots: 1, leverage: 1, at: NOW }),
    await store.close({ id: 'whatever', at: NOW }),
    await store.cancel({ orderId: 'whatever', at: NOW }),
    await store.convertToSpot({ positionId: 'whatever', lots: 1, at: NOW }),
    await store.hostDeposit(PEER, 10, NOW),
    await store.hostOpen(PEER, { crop: CROP, side: 'long', margin: 10, leverage: 1, at: NOW })
  ]
  for (const result of results) {
    assert.equal(result.ok, false)
    assert.equal(result.error, 'off')
    assert.equal(result.notice, '期货未开放。')
  }
  assert.equal(farm.state.coins, 500)
  assert.equal(store.snapshot().balance, 0)
})

test('票 98：live 真扣真加，农场硬币跟着充提走', async (t) => {
  const { store, farm } = await makeStore(t, { mode: 'live' })
  const funded = await store.deposit(100)
  assert.equal(funded.ok, true)
  assert.equal(farm.state.coins, 400)
  assert.equal(store.snapshot().balance, 100)

  const paid = await store.withdraw(40)
  assert.equal(paid.ok, true)
  assert.equal(paid.credited, 40)
  assert.equal(paid.pending, 0)
  assert.equal(farm.state.coins, 440)
  assert.equal(store.snapshot().balance, 60)
})

test('票 98：影子对账 diff 恒为 0；切 live 充提一笔后仍为 0', async (t) => {
  const { store } = await makeStore(t, { coins: 500 })
  await store.deposit(200)
  const shadow = store.reconcile()
  assert.equal(shadow.ok, true)
  assert.equal(shadow.mode, 'shadow')
  assert.equal(shadow.farmCoins, 500)
  assert.equal(shadow.custodyTotal, 200)
  assert.equal(shadow.positionsNotional, 0)
  assert.equal(shadow.diff, 0)

  await store.setMode('live', NOW)
  // setMode 会把对账锚点重置到当前农场；之后只认真实流动。
  await store.deposit(50)
  await store.withdraw(20)
  const live = store.reconcile()
  assert.equal(live.mode, 'live')
  assert.equal(live.farmCoins, 470)
  assert.equal(live.custodyTotal, 230)
  assert.equal(live.diff, 0)
})

test('票 98：日额 4,999 通过、5,000 拒', async (t) => {
  const { store } = await makeStore(t, { coins: 20_000, mode: 'live' })
  await store.deposit(20_000)
  const first = await store.open({ crop: CROP, side: 'long', margin: 4999, leverage: 1, at: NOW })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(store.snapshot().dayNotional, 4999)
  assert.equal(store.snapshot().dayCap, 5000)

  const second = await store.open({ crop: CROP, side: 'long', margin: 1, leverage: 1, at: NOW })
  assert.equal(second.ok, false)
  assert.equal(second.error, 'daily-cap')
  assert.equal(second.notice, '今日交易额已到上限。')
  assert.equal(store.snapshot().dayNotional, 4999, '拒单不累计日额')
})

test('票 98：日额按账户各算各的，不会互相吃掉额度', async (t) => {
  const { store } = await makeStore(t, { mode: 'live' })
  const other = '22222222-2222-4222-8222-222222222222'
  await store.hostDeposit(PEER, 6000, NOW)
  await store.hostDeposit(other, 6000, NOW)
  const first = await store.hostOpen(PEER, { crop: CROP, side: 'long', margin: 4000, leverage: 1, at: NOW })
  assert.equal(first.ok, true, JSON.stringify(first))
  const second = await store.hostOpen(other, { crop: CROP, side: 'long', margin: 4000, leverage: 1, at: NOW })
  assert.equal(second.ok, true, '另一个账户的日额应独立')
  const third = await store.hostOpen(PEER, { crop: CROP, side: 'long', margin: 1000, leverage: 1, at: NOW })
  assert.equal(third.ok, false)
  assert.equal(third.error, 'daily-cap')
})

test('票 98：持仓名义 19,999 通过、20,000 拒', async (t) => {
  const { dir, farm, store: probe } = await makeStore(t, { coins: 500, mode: 'live' })
  const price = quotePrice(probe)
  const smallLots = lotsFor({ notional: 1, price })
  const smallMargin = notionalOf({ lots: smallLots, price })
  // 种子仓位的名义是 19,999 - 这一笔实际会占用的保证金；再加这一笔正好 19,999。
  const seedMargin = 19_999 - smallMargin
  assert.ok(seedMargin > 0)
  await writeFile(join(dir, 'futures.json'), JSON.stringify({
    version: 1,
    mode: 'live',
    balance: 100_000,
    dayNotional: 0,
    positions: [positionSeed(seedMargin, price)]
  }), 'utf8')
  const store = await reloadStore(t, dir, farm)
  assert.equal(store.snapshot({ at: NOW }).positionCount, 1)

  const first = await store.open({ crop: CROP, side: 'long', margin: 1, leverage: 1, at: NOW })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(store.snapshot({ at: NOW }).positions.length, 2)

  const second = await store.open({ crop: CROP, side: 'long', margin: 1, leverage: 1, at: NOW })
  assert.equal(second.ok, false)
  assert.equal(second.error, 'notional-cap')
  assert.equal(second.notice, '持仓名义已到上限。')
  assert.equal(store.snapshot({ at: NOW }).positions.length, 2, '拒单不建仓')
})

test('票 98：影子模式日额上限为 0，新挂单也一律 daily-cap', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(5000)
  const placed = await store.place({
    crop: CROP,
    side: 'long',
    price: quotePrice(store),
    lots: 1,
    leverage: 1,
    at: NOW
  })
  assert.equal(placed.ok, false)
  assert.equal(placed.error, 'daily-cap')
  assert.equal(placed.notice, '今日交易额已到上限。')
  assert.equal(store.snapshot().orders.length, 0)
})

test('票 98：回滚把托管余额逐笔退回农场，之后不能再开仓', async (t) => {
  const { store, farm } = await makeStore(t, { coins: 500, mode: 'live' })
  await store.deposit(400)
  const peer = await store.hostDeposit(PEER, 200, NOW)
  assert.equal(peer.ok, true)
  const before = store.snapshot({ at: NOW })
  const custody = before.balance + store.accountOf(PEER, { at: NOW }).balance
  assert.equal(custody, 600)
  const farmBeforeRollback = farm.state.coins

  const rolled = await store.rollback({ at: NOW })
  assert.equal(rolled.ok, true, JSON.stringify(rolled))
  assert.equal(rolled.disabled, true)
  assert.equal(rolled.mode, 'off')
  assert.equal(store.snapshot({ at: NOW }).positions.length, 0)
  assert.equal(store.snapshot({ at: NOW }).orders.length, 0)
  assert.equal(store.snapshot({ at: NOW }).disabled, true)

  const credited = rolled.refunds.reduce((sum, entry) => sum + entry.credited, 0)
  const pending = rolled.refunds.reduce((sum, entry) => sum + entry.pending, 0)
  assert.equal(credited + pending, custody, '退款 + 待提取 = 回滚前的托管总额')
  assert.equal(farm.state.coins - farmBeforeRollback, credited, '农场增量等于实退金额')
  assert.ok(rolled.refunds.some((entry) => entry.deviceId === PEER))

  const blocked = await store.open({ crop: CROP, side: 'long', margin: 10, leverage: 1, at: NOW })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error, 'disabled')
  assert.equal(store.snapshot({ at: NOW }).session.kind, 'off')
})

test('票 98：回滚会按当前公允价强平仓位', async (t) => {
  const { store, farm } = await makeStore(t, { coins: 5000, mode: 'live' })
  await store.deposit(1000)
  const opened = await store.open({ crop: CROP, side: 'long', margin: 100, leverage: 10, at: NOW })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(store.snapshot({ at: NOW }).positions.length, 1)

  const rolled = await store.rollback({ at: NOW })
  assert.equal(rolled.ok, true, JSON.stringify(rolled))
  assert.equal(store.snapshot({ at: NOW }).positions.length, 0, '回滚必须强平全部仓位')
  assert.equal(store.snapshot({ at: NOW }).liquidationCount >= 1, true)
  assert.equal(rolled.refunds.length, 1)
  assert.ok(farm.state.coins > 4000, '平仓后的余额回到农场')
})

test('票 98：回滚撞 1,000,000 上限时剩余留在托管账并标 pending', async (t) => {
  const { store, farm } = await makeStore(t, { coins: 999_900 })
  await store.deposit(300)
  await store.hostDeposit(PEER, 200, NOW)
  const rolled = await store.rollback({ at: NOW })
  assert.equal(rolled.ok, true)
  assert.equal(farm.state.coins, MAX_COINS, '农场最多加到上限')
  const credited = rolled.refunds.reduce((sum, entry) => sum + entry.credited, 0)
  const pending = rolled.refunds.reduce((sum, entry) => sum + entry.pending, 0)
  assert.equal(credited, 100)
  assert.equal(pending, 400)
  assert.equal(store.snapshot({ at: NOW }).pending, 200, '本地没退成的部分留在托管账')
  assert.equal(store.accountOf(PEER, { at: NOW }).pending, 200)
})

test('票 98：提现撞上限时 credited 精确、余数留在托管账', async (t) => {
  const { dir, farm } = await makeStore(t, { coins: 999_999, mode: 'live', file: { version: 1, mode: 'live', balance: 1000 } })
  const store = await reloadStore(t, dir, farm)
  const result = await store.withdraw(1000)
  assert.equal(result.ok, true)
  assert.equal(result.credited, 1)
  assert.equal(result.pending, 999)
  assert.equal(result.notice, '农场硬币到上限了，剩 999 留在托管账待提取。')
  assert.equal(farm.state.coins, MAX_COINS)
  assert.equal(store.snapshot().balance, 999)
  assert.equal(store.snapshot().pending, 999)
})

test('票 98：同源地址 20 包/10 秒，第 21 包被丢，窗口过期后恢复', () => {
  let now = 1_000_000
  const warned = []
  const limiter = createFuturesRateLimiter({
    limit: 20,
    windowMs: 10_000,
    now: () => now,
    onLimit: (address) => warned.push(address)
  })
  for (let index = 0; index < 20; index += 1) {
    assert.equal(limiter.allows('192.168.1.9'), true, '第 ' + (index + 1) + ' 包应放行')
  }
  assert.equal(limiter.allows('192.168.1.9'), false, '第 21 包应丢弃')
  assert.equal(limiter.allows('192.168.1.10'), true, '别的源地址不受影响')
  assert.deepEqual(warned, ['192.168.1.9'])
  now += 10_000
  assert.equal(limiter.allows('192.168.1.9'), true, '10 秒窗口过后重新计数')
})
