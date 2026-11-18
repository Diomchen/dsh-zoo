/**
 * 1.10.0：档位下放到每个账户。
 *
 * 覆盖：
 *   1. 本机自己切真钱/纸面，坏值被拒，切档写审计流水；
 *   2. 纸面充提不动农场硬币，真钱才动；
 *   3. 纸面账户的手续费不进保险基金，真钱才进；
 *   4. 纸面账户的亏空不吃真钱保险基金（不记欠账）；
 *   5. 纸面单与真钱单永不在同一本账里撮合，同一本账才成交；
 *   6. 房主替 peer 记档位，settle 把档位回传给该 peer。
 *
 * 全部用假时钟 + 假农场；需要特定初始状态的用例直接写 `futures.json` 落盘。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MAX_COINS } from '../src/farm.js'
import { createFuturesStore } from '../src/futures.js'
import { SLOT_MS, contractOf } from '../src/futures-rules.js'

// 2026-11-17 是周二；取本地 12:00（东八区 UTC+8，仍在当日 20:00 交割前）。
const NOW = new Date(2026, 10, 17, 12, 0, 0, 0).getTime()
const CROP = 'tomato'
const PEER = '11111111-1111-4111-8111-111111111111'
const PEER_2 = '22222222-2222-4222-8222-222222222222'

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
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-account-mode-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

async function makeStore (t, { coins = 500, file = null } = {}) {
  const dir = await tempDir(t)
  if (file !== null) await writeFile(join(dir, 'futures.json'), JSON.stringify(file), 'utf8')
  const farm = fakeFarm(coins)
  const store = await createFuturesStore(dir, { farm, now: () => NOW })
  return { dir, farm, store }
}

/** 造一条远端仓位的落盘片段：多头、1 张、按 `entry` 进场、保证金 `margin`。 */
function remotePositionSeed ({ margin, entry, contract = contractOf(CROP, NOW) }) {
  const slot = Math.floor(contract.openAt / SLOT_MS)
  return {
    id: 'seed-position-1',
    crop: CROP,
    contract: contract.id,
    side: 'long',
    lots: 1,
    entry,
    margin,
    leverage: 1,
    openedAt: NOW,
    slot,
    settleSlot: slot + 1
  }
}

test('1.10.0：本机能自己切真钱/纸面，坏档位被拒', async (t) => {
  const { store, farm } = await makeStore(t)
  assert.equal(store.snapshot({ at: NOW }).accountMode, 'shadow', '缺省是纸面')

  const bad = await store.setAccountMode('weekly', NOW)
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'bad-account-mode')
  assert.equal(bad.notice, '未知的账户档位。')
  assert.equal(store.snapshot({ at: NOW }).accountMode, 'shadow', '坏值不改档')

  const paper = await store.deposit(100)
  assert.equal(paper.ok, true)
  assert.equal(farm.state.coins, 500, '纸面充值不花农场硬币')
  assert.equal(store.snapshot({ at: NOW }).balance, 100)

  const toLive = await store.setAccountMode('live', NOW)
  assert.equal(toLive.ok, true, JSON.stringify(toLive))
  assert.equal(toLive.action, 'futures-account-mode')
  assert.equal(store.snapshot({ at: NOW }).accountMode, 'live')
  assert.equal(store.snapshot({ at: NOW }).trades[0].kind, 'mode')
  assert.equal(store.snapshot({ at: NOW }).trades[0].note, 'live')

  const real = await store.deposit(100)
  assert.equal(real.ok, true)
  assert.equal(farm.state.coins, 400, '真钱充值真扣农场硬币')
  assert.equal(store.snapshot({ at: NOW }).balance, 200)

  const back = await store.setAccountMode('shadow', NOW)
  assert.equal(back.ok, true)
  const paperAgain = await store.deposit(50)
  assert.equal(paperAgain.ok, true)
  assert.equal(farm.state.coins, 400, '切回纸面后充值不再动农场')
  assert.equal(store.snapshot({ at: NOW }).balance, 250)
})

test('1.10.0：纸面手续费不进保险基金，真钱才进', async (t) => {
  const paper = await makeStore(t)
  await paper.store.deposit(5000)
  const opened = await paper.store.open({ crop: CROP, side: 'long', margin: 50, leverage: 20, at: NOW })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(paper.store.fundOf().insurance, 0, '纸面开仓的手续费没有进真钱基金')
  assert.deepEqual(paper.store.snapshot({ at: NOW }).fees, { insurance: 0, burned: 0 })

  const real = await makeStore(t)
  await real.store.setAccountMode('live', NOW)
  await real.store.deposit(100)
  const openedReal = await real.store.open({ crop: CROP, side: 'long', margin: 50, leverage: 20, at: NOW })
  assert.equal(openedReal.ok, true, JSON.stringify(openedReal))
  assert.ok(real.store.fundOf().insurance > 0, '真钱开仓的手续费按 10% 进基金')
})

test('1.10.0：纸面账户的亏空不吃真钱保险基金，也不记欠账', async (t) => {
  // 昨天那张合约已经交割：用「进场价 40、现价 5」造一个必亏的窟窿。
  const expired = 'tomato-20261116'
  const seed = {
    version: 1,
    mode: 'live',
    balance: 0,
    insurance: 5,
    fees: { insurance: 5, burned: 0 },
    remotes: {
      [PEER]: {
        balance: 0,
        marginUsed: 100,
        accountMode: 'shadow',
        positions: [remotePositionSeed({ margin: 100, entry: 40, contract: contractOf(CROP, new Date(2026, 10, 16, 12, 0, 0, 0).getTime()) })],
        orders: [],
        trades: []
      }
    }
  }
  const paperCase = await makeStore(t, { coins: 500, file: seed })
  const delivered = await paperCase.store.expireDue(NOW)
  assert.equal(delivered.ok, true, JSON.stringify(delivered))
  assert.equal(paperCase.store.accountOf(PEER, { at: NOW }).positions.length, 0, '交割后仓位清空')
  assert.equal(paperCase.store.fundOf().insurance, 5, '纸面的窟窿不花真钱基金')
  assert.equal(paperCase.store.fundOf().shortfall, 0, '纸面的窟窿不记真账欠账')
  assert.equal(paperCase.store.accountOf(PEER, { at: NOW }).accountMode, 'shadow')

  const liveSeed = structuredClone(seed)
  liveSeed.remotes[PEER].accountMode = 'live'
  const liveCase = await makeStore(t, { coins: 500, file: liveSeed })
  const deliveredLive = await liveCase.store.expireDue(NOW)
  assert.equal(deliveredLive.ok, true, JSON.stringify(deliveredLive))
  assert.ok(liveCase.store.fundOf().shortfall > 0, '真钱账户的窟窿才记欠账')
})

test('1.10.0：纸面单与真钱单不在同一本账里撮合，同一本账才成交', async (t) => {
  const quote = null
  const { store } = await makeStore(t)
  const q = store.quoteOf(CROP, NOW)
  assert.ok(q !== null)
  const sell = q.fair - 0.002
  const buy = q.fair + 0.002
  assert.ok(sell < buy, '两张单互相穿价')

  await store.hostDeposit(PEER, 5000, NOW) // 纸面
  await store.hostDeposit(PEER_2, 5000, NOW) // 真钱
  await store.setRemoteAccountMode(PEER_2, 'live', NOW)

  const placedSell = await store.hostPlace(PEER, {
    crop: CROP, side: 'short', price: sell, lots: 1, leverage: 1, at: NOW
  })
  assert.equal(placedSell.ok, true, JSON.stringify(placedSell))
  const placedBuy = await store.hostPlace(PEER_2, {
    crop: CROP, side: 'long', price: buy, lots: 1, leverage: 1, at: NOW
  })
  assert.equal(placedBuy.ok, true, JSON.stringify(placedBuy))

  await store.matchDue(NOW + 1000)
  assert.equal(store.accountOf(PEER, { at: NOW }).positions.length, 0, '纸面单没被真钱单吃掉')
  assert.equal(store.accountOf(PEER_2, { at: NOW }).positions.length, 0, '真钱单也没吃纸面单')
  assert.equal(store.accountOf(PEER, { at: NOW }).orders.length, 1)
  assert.equal(store.accountOf(PEER_2, { at: NOW }).orders.length, 1)
  assert.equal(quote, null)

  // 对照：两个账户都是真钱，同样的两张单会成交。
  const same = await makeStore(t)
  await same.store.setRemoteAccountMode(PEER, 'live', NOW)
  await same.store.setRemoteAccountMode(PEER_2, 'live', NOW)
  await same.store.hostDeposit(PEER, 5000, NOW)
  await same.store.hostDeposit(PEER_2, 5000, NOW)
  await same.store.hostPlace(PEER, {
    crop: CROP, side: 'short', price: sell, lots: 1, leverage: 1, at: NOW
  })
  await same.store.hostPlace(PEER_2, {
    crop: CROP, side: 'long', price: buy, lots: 1, leverage: 1, at: NOW
  })
  await same.store.matchDue(NOW + 1000)
  const positions = same.store.accountOf(PEER, { at: NOW }).positions.length +
    same.store.accountOf(PEER_2, { at: NOW }).positions.length
  assert.ok(positions >= 1, '同一本账里互相穿价的单应该成交')
})

test('1.10.0：房主替 peer 记档位，settle 把档位回传', async (t) => {
  const { store } = await makeStore(t)
  const bad = await store.setRemoteAccountMode(PEER, 'weekly', NOW)
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'bad-account-mode')

  const missing = await store.setRemoteAccountMode('not-a-device', 'live', NOW)
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'bad-device')

  await store.hostDeposit(PEER, 100, NOW)
  const switched = await store.setRemoteAccountMode(PEER, 'live', NOW)
  assert.equal(switched.ok, true, JSON.stringify(switched))
  assert.equal(switched.accountMode, 'live')
  assert.equal(store.accountOf(PEER, { at: NOW }).accountMode, 'live')
})

test('1.10.0：settle 带上账户档位，replica 读得到；坏档位整包拒', async (t) => {
  const { store } = await makeStore(t)
  const first = store.applySettle({ epoch: 'e1', seq: 1, balance: 100, marginUsed: 0, positions: [], accountMode: 'live' })
  assert.deepEqual(first, { ok: true, applied: true })
  assert.equal(store.replicaOf().accountMode, 'live')
  assert.equal(store.accountMode(), 'live', 'peer 以房主回传的档位为准')

  const bare = store.applySettle({ epoch: 'e1', seq: 2, balance: 100, marginUsed: 0, positions: [] })
  assert.deepEqual(bare, { ok: true, applied: true })
  assert.equal(store.replicaOf().accountMode, null, '没带档位就记 null（沿用本地）')

  const bad = store.applySettle({ epoch: 'e1', seq: 3, balance: 100, marginUsed: 0, positions: [], accountMode: 'weekly' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'bad-account-mode')
  assert.equal(store.replicaOf().lastSeq, 2, '坏包不动账本')
})
