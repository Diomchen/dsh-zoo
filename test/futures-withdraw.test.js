/**
 * 1.13.1：peer 的余额在房主账上，提现只能由房主放款。
 *
 * 镜像修完之后 peer 不能自己提现了（`not-owner`）：本地账本只是副本，自己扣一笔、
 * 再让自家农场加币，等于凭空造币。所以走「peer 报意图 → 房主扣账 → 随 settle 带放款
 * → peer 收下时加进自家农场」。
 *
 * 这里盯三件事：钱确实从房主账上出、到 peer 农场里；同一笔跟着后面几拍重发只加一次；
 * 农场在 1,000,000 上限处截断而不是把币弄丢。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFuturesStore } from '../src/futures.js'
import { roundCoin } from '../src/futures-rules.js'

const NOW = new Date(2026, 10, 17, 12, 0, 0, 0).getTime()
const PEER = 'a1b2c3d4-0000-4000-8000-000000000001'

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
      // 真实农场到上限就加不进去，返回实收多少（这里照 `src/farm.js` 的口径）。
      const want = Math.max(0, Math.floor(qty))
      const added = Math.min(want, Math.max(0, 1_000_000 - state.coins))
      state.coins += added
      return { ok: added > 0, action: 'add-coins', qty: added, coins: state.coins }
    }
  }
}

async function makeStore (t, { coins = 1000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-withdraw-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const farm = fakeFarm(coins)
  const store = await createFuturesStore(dir, { farm, now: () => NOW })
  return { dir, farm, store }
}

test('1.13.1：房主扣账记放款，peer 收到才把币加进自家农场', async (t) => {
  const host = await makeStore(t)
  const peer = await makeStore(t, { coins: 5000 })

  const funded = await host.store.hostDeposit(PEER, 500, NOW)
  assert.equal(funded.ok, true, JSON.stringify(funded))

  const asked = await host.store.requestWithdraw(PEER, 200, NOW)
  assert.equal(asked.ok, true, JSON.stringify(asked))
  // 房主账上立刻少 200，同时挂一笔待放款。
  const account = host.store.accountOf(PEER, { at: NOW })
  assert.equal(account.balance, 300)
  assert.deepEqual(account.payout, { at: NOW, coins: 200 })

  // peer 收到这份账：余额是副本，币还没进农场。
  const settled = await peer.store.applySettle({
    epoch: 'epoch-1', seq: 1, balance: 300, marginUsed: 0, positions: [], payout: { at: NOW, coins: 200 }, at: NOW
  })
  assert.equal(settled.ok, true, JSON.stringify(settled))
  assert.equal(peer.farm.state.coins, 5000)

  const payout = await peer.store.settlePayout()
  assert.equal(payout.ok, true, JSON.stringify(payout))
  assert.equal(payout.applied, true)
  assert.equal(payout.coins, 200)
  assert.equal(peer.farm.state.coins, 5200)

  // 房主会把同一笔跟着后面几拍重发：只加一次。
  const again = await peer.store.applySettle({
    epoch: 'epoch-1', seq: 2, balance: 300, marginUsed: 0, positions: [], payout: { at: NOW, coins: 200 }, at: NOW + 15_000
  })
  assert.equal(again.ok, true, JSON.stringify(again))
  const repeat = await peer.store.settlePayout()
  assert.equal(repeat.applied, false)
  assert.equal(peer.farm.state.coins, 5200)
})

test('1.13.1：上一笔还没送到时，第二笔提现被拒', async (t) => {
  const host = await makeStore(t)
  await host.store.hostDeposit(PEER, 500, NOW)

  const first = await host.store.requestWithdraw(PEER, 100, NOW)
  assert.equal(first.ok, true, JSON.stringify(first))
  const second = await host.store.requestWithdraw(PEER, 100, NOW + 1000)
  assert.equal(second.ok, false)
  assert.equal(second.error, 'payout-pending')
  // 被拒的那笔不能动余额。
  assert.equal(host.store.accountOf(PEER, { at: NOW }).balance, 400)

  // 钱不够也拒。
  const tooMuch = await host.store.requestWithdraw(PEER, 10_000, NOW + 2000)
  assert.equal(tooMuch.ok, false)
})

test('1.13.1：农场快满时按实收记，剩下的写进 notice', async (t) => {
  const peer = await makeStore(t, { coins: 999_900 })
  await peer.store.applySettle({
    epoch: 'epoch-1', seq: 1, balance: 500, marginUsed: 0, positions: [], payout: { at: NOW, coins: 500 }, at: NOW
  })

  const payout = await peer.store.settlePayout()
  assert.equal(payout.ok, true, JSON.stringify(payout))
  assert.equal(payout.coins, 100)
  assert.equal(peer.farm.state.coins, 1_000_000)
  assert.match(String(payout.notice), /上限/)
  // 本机农场还剩多少空间：满了就是 0。
  assert.equal(peer.store.farmRoom(), 0)

  const room = await makeStore(t, { coins: 1_000 })
  assert.equal(room.store.farmRoom(), roundCoin(999_000))
})
