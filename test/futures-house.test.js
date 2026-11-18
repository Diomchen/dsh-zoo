/**
 * 1.12.4：做市商那一侧也要入账。
 *
 * 以前玩家赚的 100 是「凭空造币」、亏的 100 是「凭空销币」：`#bookPnl()` 只写周榜。
 * 现在每笔已实现盈亏都记到 `house` 上（`house -= pnl`），于是
 *
 *     farm + balance + marginUsed + pending + fees.burned + insurance − house
 *
 * 这个和在交易全程恒定。这里的用例就是盯着这个恒等式，顺带确认纸面账户不参与。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFuturesStore } from '../src/futures.js'
import { SLOT_MS, roundCoin } from '../src/futures-rules.js'

const NOW = new Date(2026, 10, 17, 12, 0, 0, 0).getTime()

function fakeFarm (coins = 5000) {
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
      const amount = Math.max(0, Math.floor(qty))
      state.coins += amount
      return { ok: true, action: 'add-coins', qty: amount, coins: state.coins }
    }
  }
}

async function makeStore (t, { coins = 5000, live = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-house-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const farm = fakeFarm(coins)
  const store = await createFuturesStore(dir, { farm, now: () => NOW })
  if (live) {
    const mode = await store.setAccountMode('live', NOW)
    assert.equal(mode.ok, true, JSON.stringify(mode))
  }
  return { dir, farm, store }
}

/**
 * 全系统的硬币总量（托管余额、冻结保证金、农场、两个费用桶）再加上做市商那一侧。
 *
 * `house` 是**系统**的净盈亏：玩家赚 P 时凭空多出 P 枚硬币、`house` 同时变成 -P，
 * 所以「总量 + house」才是恒定的；单看总量会因为造币/销币而漂。
 */
function closedTotal (store, farm) {
  const view = store.snapshot({ at: NOW })
  return roundCoin(
    farm.state.coins +
    view.balance +
    view.marginUsed +
    view.pending +
    view.fees.burned +
    view.insurance +
    view.house
  )
}

test('做市商入账：玩家赚的钱从 house 出，恒等式全程成立', async (t) => {
  const { farm, store } = await makeStore(t)
  const before = closedTotal(store, farm)

  const deposit = await store.deposit(1000, NOW)
  assert.equal(deposit.ok, true, JSON.stringify(deposit))
  const opened = await store.open({ crop: 'tomato', side: 'long', margin: 200, leverage: 20, at: NOW })
  assert.equal(opened.ok, true, JSON.stringify(opened))

  // 走几根，让盯市把浮盈浮亏真的落进余额（也就会落进 house）。
  for (let step = 1; step <= 3; step += 1) {
    await store.settleDue(NOW + step * SLOT_MS)
  }
  const closed = await store.close({ id: opened.position.id, at: NOW + 3 * SLOT_MS + 1000 })
  assert.equal(closed.ok, true, JSON.stringify(closed))

  const view = store.snapshot({ at: NOW + 4 * SLOT_MS })
  // 亏了 = 玩家亏的钱进 house（house > 0）；赚了 = house 变负。
  assert.notEqual(view.house, 0, '一整轮下来 house 不可能还是 0（否则就是没记账）')
  assert.equal(
    closedTotal(store, farm),
    before,
    `闭环破了：总量差 ${roundCoin(closedTotal(store, farm) - before)}`
  )
})

test('纸面账户不进做市商账，也不进周榜', async (t) => {
  const { farm, store } = await makeStore(t, { live: false })
  const before = closedTotal(store, farm)

  await store.deposit(1000, NOW)
  const opened = await store.open({ crop: 'tomato', side: 'long', margin: 200, leverage: 20, at: NOW })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  for (let step = 1; step <= 3; step += 1) {
    await store.settleDue(NOW + step * SLOT_MS)
  }
  await store.close({ id: opened.position.id, at: NOW + 3 * SLOT_MS + 1000 })

  const view = store.snapshot({ at: NOW + 4 * SLOT_MS })
  assert.equal(view.house, 0, '纸面盈亏不该记到做市商头上')
  assert.equal(view.week.pnl, 0, '纸面盈亏不该进周榜')
  assert.equal(view.accountMode, 'shadow')
  // 纸面账户不碰农场；纸面余额是「假钱」，所以不能拿闭合恒等式去量它（假钱本来就不守恒）。
  assert.equal(farm.state.coins, 5000)
  assert.ok(before > 0)
})

test('档位自己说了算：房主回执里没有档位时，本地选的档位不被覆盖', async (t) => {
  const { store } = await makeStore(t)
  assert.equal(store.accountMode(), 'live')
  // 房主那边还没记上这个账户（`accountMode: null`），回执不能把本机打回纸面。
  store.applySettle({
    epoch: 'e1',
    seq: 1,
    balance: 0,
    marginUsed: 0,
    positions: [],
    orders: [],
    trades: [],
    accountMode: null,
    at: NOW
  })
  assert.equal(store.accountMode(), 'live', '本地选的档位不该被房主的 null 覆盖')
  assert.equal(store.snapshot({ at: NOW }).accountMode, 'live')

  // 房主明确回一句 shadow 也不改本机：档位是账户自己的事。
  store.applySettle({
    epoch: 'e1',
    seq: 2,
    balance: 0,
    marginUsed: 0,
    positions: [],
    orders: [],
    trades: [],
    accountMode: 'shadow',
    at: NOW
  })
  assert.equal(store.accountMode(), 'live')
})
