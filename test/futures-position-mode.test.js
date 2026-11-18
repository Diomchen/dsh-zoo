/**
 * 1.13.1：档位跟着仓位走，不跟着账户走。
 *
 * 症状：仓位里没有开仓时的档位，`#bookPnl()` 只能按账户**此刻**的 `accountMode` 决定
 * 记不记账。于是「真钱开仓 → 切纸面 → 平仓」时余额照加、`house` 不动，总账凭空多/少币；
 * 反过来「纸面开仓 → 切真钱 → 平仓」会把假钱盈亏记进 `house` 与周榜。
 *
 * 现在的口径：开仓那一刻把档位写进仓位，之后账户怎么切都不改这一笔的账。
 * 恒等式与 `futures-house.test.js` 同一份：
 *
 *     farm + balance + marginUsed + pending + fees.burned + insurance + house
 *
 * 纸面仓位的盈亏不进 `house`/周榜，但仍要落在（假钱）余额上。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createFuturesStore } from '../src/futures.js'
import { SLOT_MS, roundCoin } from '../src/futures-rules.js'

const NOW = new Date(2026, 10, 17, 12, 0, 0, 0).getTime()
const CROP = 'tomato'

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

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-position-mode-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function makeStore (t, { coins = 5000, live = true, file = null } = {}) {
  const dir = await tempDir(t)
  if (file !== null) await writeFile(join(dir, 'futures.json'), JSON.stringify(file), 'utf8')
  const farm = fakeFarm(coins)
  const store = await createFuturesStore(dir, { farm, now: () => NOW })
  if (live) {
    const mode = await store.setAccountMode('live', NOW)
    assert.equal(mode.ok, true, JSON.stringify(mode))
  }
  return { dir, farm, store }
}

/** 全系统的硬币总量再加上做市商那一侧（与 `futures-house.test.js` 同一份恒等式）。 */
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

test('真钱开仓后切纸面：盈亏仍按真钱进 house，恒等式不变', async (t) => {
  const { farm, store } = await makeStore(t)
  const before = closedTotal(store, farm)

  assert.equal((await store.deposit(1000, NOW)).ok, true)
  const opened = await store.open({ crop: CROP, side: 'long', margin: 200, leverage: 20, at: NOW })
  assert.equal(opened.ok, true, JSON.stringify(opened))

  // 先走几根，让盯市把浮盈浮亏落进余额（也落进 house），再切档。
  for (let step = 1; step <= 3; step += 1) {
    await store.settleDue(NOW + step * SLOT_MS)
  }
  const switched = await store.setAccountMode('shadow', NOW + 3 * SLOT_MS)
  assert.equal(switched.ok, true, JSON.stringify(switched))
  const houseBefore = store.snapshot({ at: NOW }).house

  const closed = await store.close({ id: opened.position.id, at: NOW + 3 * SLOT_MS + 1000 })
  assert.equal(closed.ok, true, JSON.stringify(closed))

  const view = store.snapshot({ at: NOW + 4 * SLOT_MS })
  assert.equal(view.accountMode, 'shadow', '账户已经切到纸面')
  assert.notEqual(closed.pnl, 0, '这一笔必须有盈亏，否则证明不了记账走的是哪本账')
  // 平仓的盈亏按**仓位**的档位（真钱）记：house 必须恰好动 -pnl。
  assert.equal(
    roundCoin(view.house - houseBefore),
    roundCoin(-closed.pnl),
    '真钱仓位平仓后 house 没动：这笔盈亏又凭空造/销币了'
  )
  assert.equal(
    closedTotal(store, farm),
    before,
    `闭环破了：总量差 ${roundCoin(closedTotal(store, farm) - before)}`
  )
  assert.equal(closed.position.accountMode, 'live', '仓位上要留下开仓那一刻的档位')
})

test('纸面开仓后切真钱：house 与周榜一分不动，盈亏只落在余额上', async (t) => {
  const { farm, store } = await makeStore(t, { live: false })
  await store.deposit(1000, NOW)
  const opened = await store.open({ crop: CROP, side: 'long', margin: 200, leverage: 20, at: NOW })
  assert.equal(opened.ok, true, JSON.stringify(opened))

  for (let step = 1; step <= 3; step += 1) {
    await store.settleDue(NOW + step * SLOT_MS)
  }
  const switched = await store.setAccountMode('live', NOW + 3 * SLOT_MS)
  assert.equal(switched.ok, true, JSON.stringify(switched))
  const beforeClose = store.snapshot({ at: NOW + 3 * SLOT_MS })

  const closed = await store.close({ id: opened.position.id, at: NOW + 3 * SLOT_MS + 1000 })
  assert.equal(closed.ok, true, JSON.stringify(closed))
  assert.notEqual(closed.pnl, 0, '这一笔必须有盈亏，否则证明不了记账走的是哪本账')

  const view = store.snapshot({ at: NOW + 4 * SLOT_MS })
  assert.equal(view.accountMode, 'live')
  assert.equal(view.house, 0, '纸面仓位的盈亏不能记到做市商头上')
  assert.equal(view.week.pnl, 0, '纸面仓位不进周榜')
  // 假钱也是钱：平仓的盈亏要真的落在余额上（权益变化恰好等于 pnl）。
  assert.equal(roundCoin(view.equity - beforeClose.equity), roundCoin(closed.pnl))
  assert.equal(farm.state.coins, 5000, '纸面账户全程不碰农场硬币')
  assert.equal(closed.position.accountMode, 'shadow')
})

test('老存档没有 accountMode：按账户当前档位处理，不崩也不丢仓位', async (t) => {
  // 先借一个空账本拿到这一刻的公允价与合约，再把「旧版本写出来的」仓位原样落盘：
  // 那份 JSON 里**没有** accountMode，正是升级前的存档形状。
  const probeDir = await tempDir(t)
  const probe = await createFuturesStore(probeDir, { farm: fakeFarm(), now: () => NOW })
  const quote = probe.quoteOf(CROP, NOW)
  assert.ok(quote !== null)
  const slot = Math.floor(quote.contract.openAt / SLOT_MS)

  const seed = {
    version: 1,
    epoch: 'e-old-save',
    mode: 'live',
    accountMode: 'live',
    balance: 1000,
    fees: { insurance: 0, burned: 0 },
    positions: [{
      id: 'old-position-1',
      crop: CROP,
      contract: quote.contract.id,
      side: 'long',
      lots: 1,
      entry: roundCoin(quote.fair),
      margin: 200,
      leverage: 20,
      openedAt: NOW,
      slot,
      settleSlot: slot + 1
    }],
    orders: [],
    trades: [],
    week: { start: 0, pnl: 0 },
    closed: 0,
    tradedAt: 0,
    seq: 0,
    remotes: {},
    delivered: {},
    shortfall: 0,
    insurance: 0,
    liquidationCount: 0,
    house: 0,
    pending: 0
  }
  const { farm, store } = await makeStore(t, { live: false, file: seed })
  const before = closedTotal(store, farm)
  assert.equal(store.snapshot({ at: NOW }).accountMode, 'live', '档位从盘上读回来')
  assert.equal(store.snapshot({ at: NOW }).positions.length, 1, '没有 accountMode 的老仓位不能被丢掉')

  const closed = await store.close({ id: 'old-position-1', at: NOW + 1000 })
  assert.equal(closed.ok, true, JSON.stringify(closed))
  // 缺省按账户当前档位（live）记：house 恰好动 -pnl，恒等式仍然闭合。
  const view = store.snapshot({ at: NOW + 2 * SLOT_MS })
  assert.equal(roundCoin(view.house), roundCoin(-closed.pnl), '老仓位按账户当前档位（真钱）记账')
  assert.equal(
    closedTotal(store, farm),
    before,
    `老存档平仓后总量变了：差 ${roundCoin(closedTotal(store, farm) - before)}`
  )
})
