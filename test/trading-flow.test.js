/**
 * 票 107：盘口 store 的资金流接线（半滑点、tape 持久化、接收、收盘不补流水）。
 *
 * 这些用例显式 `flow:true`；旧的 v5 结算用例默认关（见 `createTradingStore` 的 `flow` 选项）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createTradingStore, TRADING_FILE } from '../src/trading.js'
import { impactOf } from '../src/board-flow.js'
import { SLOT_MS, TICK_MS, markPrice, slotClosePrice, slotIndexAt, weekStartOf } from '../src/trading-rules.js'

const OPEN_AT = 1763308800000 + 3 * TICK_MS
const DEVICE = '3f0f2a1c-1d2e-4b3a-8c9d-0e1f2a3b4c5d'

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-flow-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function makeClock (start = OPEN_AT) {
  let value = start
  return {
    now: () => value,
    set (next) { value = next },
    advance (ms) { value += ms }
  }
}

function fakeFarm (coins = 1000) {
  const wallet = { coins }
  return {
    wallet,
    snapshot () { return { coins: wallet.coins } },
    async spendCoins (qty) {
      if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: 'bad-qty' }
      if (wallet.coins < qty) return { ok: false, error: 'no-coin' }
      wallet.coins -= qty
      return { ok: true, qty, coins: wallet.coins }
    },
    async addCoins (qty) {
      if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: 'bad-qty' }
      wallet.coins = Math.min(1_000_000, wallet.coins + qty)
      return { ok: true, qty, coins: wallet.coins }
    }
  }
}

async function openStore (dir, { clock, farm, flow = true, deviceId = DEVICE, onFlow = null }) {
  return createTradingStore(dir, { now: clock.now, farm, flow, deviceId, onFlow })
}

async function readFileState (dir) {
  return JSON.parse(await readFile(join(dir, TRADING_FILE), 'utf8'))
}

test('票 107：开仓含一半自身冲击，tape 落盘；平仓往返净冲击≈0', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const farm = fakeFarm()
  const events = []
  const store = await openStore(dir, { clock, farm, onFlow: (event) => events.push(event) })
  const pre = markPrice({ crop: 'tomato', now: clock.now() })
  const opened = await store.openPosition({ crop: 'tomato', side: 'long', margin: 100, leverage: 5 })
  assert.equal(opened.ok, true)
  const u = impactOf({ action: 'open', side: 'long', notional: 500 })
  assert.ok(Math.abs(opened.flow.impact - u) < 1e-12)
  assert.ok(Math.abs(opened.flow.slippage - u / 2) < 1e-12)
  assert.ok(Math.abs(opened.position.entry - pre * Math.exp(u / 2)) < 1e-12, '成交价 = 现价 × exp(u/2)')
  assert.equal(events.length, 1)
  assert.equal(events[0].deviceId, DEVICE)
  const file = await readFileState(dir)
  assert.equal(file.flow.tape.length, 1)
  assert.equal(file.flow.seq, 1)

  const positionId = opened.position.id
  const closed = await store.closePosition(positionId)
  assert.equal(closed.ok, true)
  assert.equal(closed.flow.recorded, true)
  assert.ok(Math.abs(closed.flow.impact + u) < 1e-12, '平仓方向相反、同额')
  // 同一分钟开+平：入场和出场都含一半自身冲击，正好回到入场价。
  assert.ok(Math.abs(closed.history.exit - opened.position.entry) < 1e-9)
  assert.equal(events.length, 2)
  const after = await readFileState(dir)
  assert.equal(after.flow.tape.length, 2)
  // 同一分钟开盘+平仓：水平回到 0；往返只剩手续费。
  const view = store.flowView({ now: clock.now(), crop: 'tomato' })
  assert.ok(Math.abs(view.level) < 1e-12)
  assert.ok(Math.abs(view.net) < 1e-12)
})

test('票 107：单根上限 1.2%——第 5 笔交易仍可做，但不再推动行情', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const farm = fakeFarm(10_000)
  const store = await openStore(dir, { clock, farm })
  const flows = []
  for (let index = 0; index < 5; index += 1) {
    const result = await store.openPosition({ crop: 'tomato', side: 'long', margin: 100, leverage: 5 })
    assert.equal(result.ok, true)
    flows.push(result.flow)
  }
  assert.deepEqual(flows.map((flow) => flow.recorded), [true, true, true, true, false])
  assert.equal(flows[4].impact, 0)
  assert.ok(flows.slice(0, 4).every((flow) => Math.abs(flow.impact - 0.003) < 1e-12))
})

test('票 107：接收邻居流水（实时/同步）、flowView、setDeviceId', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const farm = fakeFarm()
  const observed = []
  const store = await openStore(dir, { clock, farm, onFlow: (event) => observed.push(event) })
  store.setDeviceId(DEVICE)
  const other = {
    id: 'other:1',
    deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    at: clock.now(),
    crop: 'tomato',
    action: 'open',
    side: 'long',
    reason: 'manual',
    notional: 500,
    source: 'board'
  }
  const live = await store.acceptFlow([other], { now: clock.now(), mode: 'live' })
  assert.equal(live.accepted, 1)
  const view = store.flowView({ now: clock.now(), crop: 'tomato' })
  assert.equal(view.events.length, 1)
  assert.ok(Math.abs(view.level - 0.003) < 1e-12)
  assert.equal(observed.length, 0, '接收邻居事件不再回调广播，避免回声')

  // 同一条重复收：去重。
  const duplicate = await store.acceptFlow([other], { now: clock.now(), mode: 'live' })
  assert.equal(duplicate.accepted, 0)

  // 老于 15 秒的实时事件丢掉；同步模式收。
  const late = { ...other, id: 'other:2', at: clock.now() - 20 * 1000 }
  assert.equal((await store.acceptFlow([late], { now: clock.now(), mode: 'live' })).accepted, 0)
  assert.equal((await store.acceptFlow([late], { now: clock.now(), mode: 'sync' })).accepted, 1)
  const since = store.flowEventsSince(clock.now() - 60 * 1000)
  assert.ok(since.length >= 2)
})

test('票 107：收盘结算按含资金流的收盘价，不补一条结算流水', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const farm = fakeFarm()
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ crop: 'tomato', side: 'long', margin: 100, leverage: 5 })
  assert.equal(opened.ok, true)
  const slot = slotIndexAt(clock.now())
  const tapeBefore = (await readFileState(dir)).flow.tape.length
  clock.set((slot + 1) * SLOT_MS)
  assert.equal(await store.tick(), true)
  const after = await readFileState(dir)
  assert.equal(after.positions.length, 0)
  assert.equal(after.history.length, 1)
  assert.equal(after.history[0].reason, 'settle')
  assert.equal(after.flow.tape.length, tapeBefore, '结算不补流水')
  // 结算价 = 含 open 资金流的收盘价（不是纯 markPrice）。
  const flowLevel = store.flowView({ now: (slot + 1) * SLOT_MS, crop: 'tomato' }).level
  const expected = slotClosePrice('tomato', slot, flowLevel)
  assert.ok(Math.abs(after.history[0].exit - expected) < 1e-9)
})
