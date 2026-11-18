/**
 * 票 110（B 方案）：市价单先吃邻居的挂单——「你赚的钱是邻居亏的钱」。
 *
 * 规则就一条：同一合约、同一本账、对手方向、价格不劣于做市商那一侧的挂单，
 * 市价单先按价格优先吃掉；剩下的张数才按做市商那一侧成交。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFuturesStore } from '../src/futures.js'
import { HOUR_MS, roundCoin } from '../src/futures-rules.js'

const MONDAY = new Date(2026, 10, 16, 10, 0, 0, 0).getTime()
const AT = MONDAY + 3 * HOUR_MS

function fakeFarm (coins) {
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
      state.coins = Math.min(1_000_000, before + qty)
      return { ok: true, qty: state.coins - before, coins: state.coins }
    }
  }
}

async function makeStore (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-pvp-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const farm = fakeFarm(5000)
  const store = await createFuturesStore(dir, { farm, now: () => AT })
  await store.setMode('live')
  await store.setAccountMode('live')
  return { store, farm }
}

test('票 110：市价单先吃邻居的挂单，成交价是挂单价而不是做市商报价', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(4000)
  const quote = store.quoteOf('tomato', AT)
  assert.notEqual(quote, null)

  // 邻居挂一张卖单，价在买一上：既比做市商的卖一便宜，又确实在盘口里。
  const neighbor = randomUUID()
  const price = roundCoin(quote.bid)
  await store.hostDeposit(neighbor, 500, AT)
  const placed = await store.hostPlace(neighbor, { crop: 'tomato', side: 'short', price, lots: 1, leverage: 10, at: AT })
  assert.equal(placed.ok, true, JSON.stringify(placed))

  // 本机市价开多：第一张吃邻居，剩下的才吃做市商。
  const opened = await store.open({ crop: 'tomato', side: 'long', margin: 120, leverage: 10, at: AT })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(opened.lots, 2, '120 保证金 × 10 倍 = 1,200 名义，在 5 块上正好 2 张')

  const mine = store.snapshot({ at: AT }).positions
  assert.equal(mine.length, 2, '一笔市价单拆成两笔仓位：一笔邻居、一笔做市商')
  assert.equal(mine[0].entry, price, '第一笔成交在邻居的挂单价上')
  assert.equal(mine[1].entry, quote.ask, '第二笔成交在做市商的卖一上')

  // 邻居那边也开出了一张空单，他的挂单被吃完。
  const theirs = store.accountOf(neighbor, { at: AT }).positions
  assert.equal(theirs.length, 1)
  assert.equal(theirs[0].side, 'short')
  assert.equal(theirs[0].entry, price)
  assert.equal(store.accountOf(neighbor, { at: AT }).orders.length, 0)
})

test('票 110：没有邻居挂单时，市价单还是按做市商报价成交（退化成老行为）', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(4000)
  const quote = store.quoteOf('tomato', AT)
  const opened = await store.open({ crop: 'tomato', side: 'long', margin: 100, leverage: 10, at: AT })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(opened.price, quote.ask)
  assert.equal(store.snapshot({ at: AT }).positions.length, 1)
})

test('票 110：邻居的价不优于做市商时不撮合——市价单不该替别人抬价', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(4000)
  const quote = store.quoteOf('tomato', AT)
  const neighbor = randomUUID()
  // 卖得比做市商还贵：吃它等于多花钱，市价单不去碰。
  const price = roundCoin(quote.ask * 1.02)
  await store.hostDeposit(neighbor, 500, AT)
  const placed = await store.hostPlace(neighbor, { crop: 'tomato', side: 'short', price, lots: 1, leverage: 10, at: AT })
  assert.equal(placed.ok, true, JSON.stringify(placed))

  const opened = await store.open({ crop: 'tomato', side: 'long', margin: 100, leverage: 10, at: AT })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(opened.price, quote.ask, '还是按做市商卖一成交')
  assert.equal(store.accountOf(neighbor, { at: AT }).positions.length, 0, '邻居那张单没被吃')
})
