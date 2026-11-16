/**
 * 票 79：盘口账本（`trading.json`）+ 农场硬币的联动。
 *
 * 临时目录 + 假时钟 + 假农场（只有 coins / spendCoins / addCoins 三个口），
 * 不联网、不 sleep。硬币的加减全部走真实 store 的串行队列与落盘。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MAX_TRADING_HISTORY,
  TRADING_FILE,
  TRADING_VERSION,
  createTradingStore,
  normalizeTradingFile
} from '../src/trading.js'
import {
  SLOT_MS,
  TICK_MS,
  markPrice,
  pnlOf,
  settlementOf,
  slotClosePrice,
  weekStartOf
} from '../src/trading-rules.js'

/** 正好落在 slot 边界上的一刻。 */
const SLOT_EDGE = 1763308800000
const SLOT = SLOT_EDGE / SLOT_MS
const MONDAY = weekStartOf(SLOT_EDGE)

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-trading-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/** 只记账的假农场：硬币上限 1,000,000，`addCoins(0)` 与真农场一样报 bad-qty。 */
function fakeFarm (coins = 500) {
  const wallet = { coins }
  const calls = []
  return {
    wallet,
    calls,
    snapshot () {
      return { coins: wallet.coins }
    },
    async spendCoins (qty) {
      calls.push(['spend', qty])
      if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: 'bad-qty' }
      if (wallet.coins < qty) return { ok: false, error: 'no-coin' }
      wallet.coins -= qty
      return { ok: true, qty, coins: wallet.coins, persisted: true }
    },
    async addCoins (qty) {
      calls.push(['add', qty])
      if (!Number.isInteger(qty) || qty <= 0) return { ok: false, error: 'bad-qty' }
      const before = wallet.coins
      wallet.coins = Math.min(1_000_000, before + qty)
      return { ok: true, qty: wallet.coins - before, coins: wallet.coins, persisted: true }
    }
  }
}

function makeClock (start = SLOT_EDGE) {
  let value = start
  return {
    now: () => value,
    set (next) { value = next },
    advance (ms) { value += ms }
  }
}

function makeLogger () {
  const warnings = []
  return { warnings, log: { warn (line) { warnings.push(line) } } }
}

async function openStore (dir, { clock, farm, log }) {
  return createTradingStore(dir, {
    ...(log === undefined ? {} : { log }),
    now: clock?.now,
    farm: farm ?? null
  })
}

async function readTrading (dir) {
  return JSON.parse(await readFile(join(dir, TRADING_FILE), 'utf8'))
}

async function writeTrading (dir, value) {
  await writeFile(join(dir, TRADING_FILE), JSON.stringify(value), 'utf8')
}

test('票 79：开仓当场扣硬币；持仓有现价与浮盈亏；锁定与可用分得清', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(SLOT_EDGE + 3 * TICK_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })

  assert.equal((await store.openPosition({ margin: 50 })).error, 'bad-side', '没给方向就拒绝')
  const opened = await store.openPosition({ side: 'long', margin: 50 })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(opened.persisted, true)
  assert.equal(farm.wallet.coins, 450, '开仓当场扣掉保证金')
  assert.equal(opened.coins, 450)

  const now = SLOT_EDGE + 9 * TICK_MS
  clock.set(now)
  const view = store.view({ now })
  assert.equal(view.positions.length, 1)
  const position = view.positions[0]
  assert.equal(position.side, 'long')
  assert.equal(position.margin, 50)
  assert.equal(position.leverage, 1, '票 79 只有 1×')
  assert.equal(position.entry, markPrice({ crop: 'tomato', now: SLOT_EDGE + 3 * TICK_MS }))
  assert.equal(position.mark, markPrice({ crop: 'tomato', now }))
  assert.equal(view.locked, 50)
  assert.equal(view.unrealized, pnlOf({
    side: 'long', margin: 50, leverage: 1, entry: position.entry, mark: position.mark
  }))

  // 再开一手空的：两笔都扣钱，锁定累加。
  const second = await store.openPosition({ side: 'short', margin: 100, leverage: 1, crop: 'tomato' })
  assert.equal(second.ok, true)
  assert.equal(farm.wallet.coins, 350)
  const both = store.view({ now })
  assert.equal(both.positions.length, 2)
  assert.equal(both.locked, 150)
  assert.deepEqual(both.orders, [])

  // 磁盘上就是契约形状：没有硬币余额，只有本周/持仓/挂单/历史。
  const file = await readTrading(dir)
  assert.equal(file.version, TRADING_VERSION)
  assert.deepEqual(Object.keys(file).sort(), ['history', 'orders', 'positions', 'version', 'week'])
  assert.equal(file.week.start, MONDAY)
  assert.equal(file.positions.length, 2)
  assert.equal('coins' in file, false)
})

test('票 79：硬币不够（含 0 硬币）拒绝开仓，硬币一分不动', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock()
  const farm = fakeFarm(49)
  const store = await openStore(dir, { clock, farm })
  const result = await store.openPosition({ side: 'long', margin: 50 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-coin')
  assert.equal(farm.wallet.coins, 49)

  const broke = fakeFarm(0)
  const second = await openStore(await tempDir(t), { clock, farm: broke })
  const refused = await second.openPosition({ side: 'short', margin: 100 })
  assert.equal(refused.error, 'no-coin')
  assert.equal(broke.wallet.coins, 0)
  assert.deepEqual(broke.calls, [], '没钱就不该碰钱包')
})

test('票 79：白名单之外的作物/方向/保证金/杠杆都不开仓', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock: makeClock(), farm })
  assert.equal((await store.openPosition({ side: 'long', margin: 250 })).error, 'bad-margin')
  // 2× 不在白名单里（只有 1× / 5× / 20×）。
  assert.equal((await store.openPosition({ side: 'long', margin: 50, leverage: 2 })).error, 'bad-leverage')
  assert.equal((await store.openPosition({ side: 'up', margin: 50 })).error, 'bad-side')
  assert.equal((await store.openPosition({ side: 'long', margin: 50, crop: 'corn' })).error, 'bad-crop')
  assert.equal(farm.wallet.coins, 500, '拒绝的一律不扣钱')
  // 没有农场（启动早期）：明确回 starting。
  const orphan = await openStore(await tempDir(t), { clock: makeClock(), farm: null })
  assert.equal((await orphan.openPosition({ side: 'long', margin: 50 })).error, 'starting')
})

test('票 79：手动平仓按现价结算，退回 保证金+盈亏（整数），历史一条', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(SLOT_EDGE + 2 * TICK_MS)
  const farm = fakeFarm(300)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'long', margin: 100 })
  const entry = opened.position.entry

  const closeAt = SLOT_EDGE + 11 * TICK_MS
  clock.set(closeAt)
  const closed = await store.closePosition(opened.position.id)
  assert.equal(closed.ok, true, JSON.stringify(closed))
  const exit = markPrice({ crop: 'tomato', now: closeAt })
  const expected = settlementOf({ side: 'long', margin: 100, leverage: 1, entry, mark: exit })
  assert.equal(closed.pnl, expected.pnl)
  assert.equal(closed.credit, expected.credit)
  assert.equal(farm.wallet.coins, 200 + expected.credit, '硬币 = 扣掉的 100 里退回 100+盈亏')
  assert.equal(closed.history.reason, 'close')
  assert.equal(closed.history.entry, entry)
  assert.equal(closed.history.exit, exit)
  assert.equal(Number.isInteger(closed.history.pnl), true, '入账是整数硬币')
  assert.equal(store.view().positions.length, 0)
  assert.equal(store.view().history.length, 1)
  assert.equal(store.view().week.pnl, expected.pnl)
  // 同一个仓位不能再平一次。
  assert.equal((await store.closePosition(opened.position.id)).error, 'no-position')

  // 关闭时 credit 为 0（保证金全亏）不能调 addCoins(0)：看假农场的调用记录。
  assert.equal(farm.calls.some(([kind, qty]) => kind === 'add' && qty === 0), false)
})

test('票 79：硬币不会变负——价格暴跌也只亏掉保证金，credit 停在 0', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(100)
  const clock = makeClock(SLOT_EDGE + 60 * 1000)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'long', margin: 100 })
  assert.equal(farm.wallet.coins, 0, '全部硬币押进去了')

  // 手改档案把入场价推到天上（模拟「买在顶上」），现价再怎么走都只亏保证金。
  const file = await readTrading(dir)
  file.positions[0].entry = 1_000_000
  await writeTrading(dir, file)

  const restarted = await openStore(dir, { clock, farm })
  const closed = await restarted.closePosition(opened.position.id)
  assert.equal(closed.ok, true)
  assert.equal(closed.credit, 0, '保证金全亏时没有钱要退')
  assert.equal(closed.pnl, -100, '亏损封顶保证金')
  assert.equal(farm.wallet.coins, 0, '硬币不会变成负数')
  assert.equal(farm.calls.some(([kind]) => kind === 'add'), false, 'credit 为 0 时不调 addCoins')
})

test('票 79：15 分钟收盘自动结算，用这一根的收盘价；重复 tick 不重复加钱', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(SLOT_EDGE + 4 * TICK_MS)
  const farm = fakeFarm(400)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'short', margin: 50 })
  const entry = opened.position.entry
  assert.equal(farm.wallet.coins, 350)

  // 还在这一根里：tick 不动仓位。
  clock.set(SLOT_EDGE + 14 * TICK_MS)
  assert.equal(await store.tick(), false)
  assert.equal(store.view().positions.length, 1)

  // 过了收盘：结算价 = 这一根的收盘价，与窗口最后一根一致。
  const closeAt = SLOT_EDGE + SLOT_MS + 1000
  clock.set(closeAt)
  assert.equal(await store.tick(), true)
  const exit = slotClosePrice('tomato', SLOT)
  const expected = settlementOf({ side: 'short', margin: 50, leverage: 1, entry, mark: exit })
  const view = store.view({ now: closeAt })
  assert.equal(view.positions.length, 0)
  assert.equal(view.history.length, 1)
  assert.equal(view.history[0].reason, 'settle')
  assert.equal(view.history[0].exit, exit)
  assert.equal(view.history[0].pnl, expected.pnl)
  assert.equal(farm.wallet.coins, 350 + expected.credit)
  assert.equal(view.week.pnl, expected.pnl)

  // 再拍两下：历史还是那一条，硬币不再变（幂等）。
  const coins = farm.wallet.coins
  assert.equal(await store.tick(), false)
  assert.equal(await store.tick(), false)
  assert.equal(farm.wallet.coins, coins)
  assert.equal(store.view().history.length, 1)
})

test('票 79：离线跨过收盘——启动就按那一根的收盘价结算，不留旧仓位', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(SLOT_EDGE + 2 * TICK_MS)
  const farm = fakeFarm(300)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'long', margin: 50 })
  assert.equal(farm.wallet.coins, 250)

  // 关掉 DSH 半小时再回来：行情是算出来的，收盘价不会因为离线而变。
  clock.set(SLOT_EDGE + 2 * SLOT_MS)
  const restarted = await openStore(dir, { clock, farm })
  const view = restarted.view()
  assert.equal(view.positions.length, 0, '不把昨天的仓位画成还开着')
  assert.equal(view.history.length, 1)
  assert.equal(view.history[0].reason, 'settle')
  const expected = settlementOf({
    side: 'long',
    margin: 50,
    leverage: 1,
    entry: opened.position.entry,
    mark: slotClosePrice('tomato', opened.position.slot)
  })
  assert.equal(view.history[0].exit, slotClosePrice('tomato', opened.position.slot))
  assert.equal(view.history[0].pnl, expected.pnl)
  assert.equal(farm.wallet.coins, 250 + expected.credit)
  assert.equal(view.week.pnl, expected.pnl)
})

test('票 79：重启恢复——持仓、本周盈亏、历史都从 trading.json 读回来', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(SLOT_EDGE + TICK_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const first = await store.openPosition({ side: 'long', margin: 50 })
  const second = await store.openPosition({ side: 'short', margin: 100 })

  // 换一个 store 实例（模拟重启），硬币余额不变。
  const restarted = await openStore(dir, { clock, farm })
  const view = restarted.view({ now: SLOT_EDGE + TICK_MS })
  assert.deepEqual(view.positions.map((position) => position.id).sort(), [first.position.id, second.position.id].sort())
  assert.equal(view.locked, 150)
  assert.equal(view.week.start, MONDAY)
  assert.equal(farm.wallet.coins, 350)
  // 平掉其中一手，重启后历史还在。
  await restarted.closePosition(first.position.id)
  const again = await openStore(dir, { clock, farm })
  assert.equal(again.view().history.length, 1)
  assert.equal(again.view().positions.length, 1)
})

test('票 79：settling 意图（写完就崩）在启动时只补后半段，绝不重复加钱', async (t) => {
  const dir = await tempDir(t)
  // 磁盘上是「意图已写、钱已退、历史还没记」的那一刻。
  await writeTrading(dir, {
    version: TRADING_VERSION,
    week: { start: MONDAY, pnl: 0, base: 500 },
    positions: [{
      id: 'p-settling',
      crop: 'tomato',
      side: 'long',
      margin: 50,
      leverage: 1,
      entry: 5,
      openedAt: SLOT_EDGE,
      slot: SLOT,
      settling: { at: SLOT_EDGE + 5 * TICK_MS, exit: 5.5, pnl: 5, credit: 55, reason: 'close' }
    }],
    history: []
  })
  const farm = fakeFarm(500)
  const warnings = []
  const clock = makeClock(SLOT_EDGE + 6 * TICK_MS)
  const store = await openStore(dir, { clock, farm, log: { warn (line) { warnings.push(line) } } })

  const view = store.view({ now: SLOT_EDGE + 6 * TICK_MS })
  assert.equal(view.positions.length, 0, '补完后半段，仓位没了')
  assert.equal(view.history.length, 1)
  assert.equal(view.history[0].pnl, 5)
  assert.equal(view.history[0].reason, 'close')
  assert.equal(view.week.pnl, 5)
  assert.equal(farm.wallet.coins, 500, '启动恢复不碰硬币')
  assert.deepEqual(farm.calls, [], '一次 addCoins 都不该发生')
  assert.deepEqual(warnings, [], 'settling 是正常状态，不告警')
  assert.equal((await readTrading(dir)).positions.length, 0, '补完之后落盘')

  // 再启动一次：历史仍是那一条，不重复记账。
  const restarted = await openStore(dir, { clock, farm })
  assert.equal(restarted.view().history.length, 1)
  assert.equal(restarted.view().week.pnl, 5)
  assert.equal(farm.wallet.coins, 500)
})

test('票 79：坏 trading.json 按空盘口运行，只告警一次，硬币不动', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(500)
  const logger = makeLogger()
  await writeFile(join(dir, TRADING_FILE), '{ not json', 'utf8')

  const store = await openStore(dir, { clock: makeClock(), farm, log: logger.log })
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /盘口/)
  const view = store.view()
  assert.deepEqual(view.positions, [])
  assert.deepEqual(view.history, [])
  assert.equal(farm.wallet.coins, 500)
  // 后续动作/tick 不再重复同一条告警。
  await store.tick()
  assert.equal(logger.warnings.length, 1)

  // 形状不对（不是对象 / 版本不认识）：同样空盘口 + 一次告警。
  for (const bad of ['[]', '{"version":9,"positions":[]}', '{"positions":"nope"}']) {
    const other = await tempDir(t)
    const quiet = makeLogger()
    await writeFile(join(other, TRADING_FILE), bad, 'utf8')
    const second = await openStore(other, { clock: makeClock(), farm: fakeFarm(500), log: quiet.log })
    assert.equal(quiet.warnings.length, 1, bad)
    assert.equal(second.view().positions.length, 0)
  }
})

test('票 79：单条坏持仓只丢自己；本周从本地周一算起，跨周清盈亏不动硬币', async (t) => {
  const dir = await tempDir(t)
  const lastMonday = weekStartOf(SLOT_EDGE - 7 * 24 * 60 * 60 * 1000)
  await writeTrading(dir, {
    version: TRADING_VERSION,
    week: { start: lastMonday, pnl: 42, base: 10 },
    positions: [
      { id: 'ok', crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5, openedAt: SLOT_EDGE, slot: SLOT },
      { id: 'bad-side', crop: 'tomato', side: 'sideways', margin: 50, leverage: 1, entry: 5, openedAt: SLOT_EDGE },
      { id: 'bad-crop', crop: 'corn', side: 'long', margin: 50, leverage: 1, entry: 5, openedAt: SLOT_EDGE },
      { id: 'bad-margin', crop: 'tomato', side: 'long', margin: 0, leverage: 1, entry: 5, openedAt: SLOT_EDGE }
    ],
    orders: [{ id: 'o1' }, null],
    history: [
      { id: 'h1', crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5, exit: 6, pnl: 10, reason: 'settle', at: SLOT_EDGE - 1000 },
      { id: 'h2', crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5, exit: 6, pnl: 10, reason: 'teleport', at: SLOT_EDGE - 2000 }
    ]
  })
  const farm = fakeFarm(500)
  const logger = makeLogger()
  const clock = makeClock(SLOT_EDGE + 9 * TICK_MS)
  const store = await openStore(dir, { clock, farm, log: logger.log })
  const view = store.view({ now: SLOT_EDGE + 9 * TICK_MS })
  assert.equal(view.positions.length, 1, '坏持仓只丢自己')
  assert.equal(view.positions[0].id, 'ok')
  assert.equal(view.history.length, 1, '坏历史只丢自己')
  assert.equal(view.history[0].id, 'h1')
  assert.deepEqual(view.orders, [], '票 83 之前 orders 只有空形状')
  assert.equal(logger.warnings.length, 1, '修补只告警一次')
  assert.match(logger.warnings[0], /修补/)
  // 上周的 42 不能带进本周；base 换成此刻的可用硬币。
  assert.equal(view.week.start, MONDAY)
  assert.equal(view.week.pnl, 0)
  assert.equal(view.week.base, 500)
  assert.equal(farm.wallet.coins, 500, '跨周不动硬币')

  // 同一周内再启动：本周盈亏与 base 保持不变（不清第二次）。
  const sameWeek = await openStore(dir, { clock, farm })
  assert.equal(sameWeek.view().week.base, 500)
})

test('票 79：tick 里也会跨周；历史最多 200 条', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(500)
  const clock = makeClock(SLOT_EDGE)
  const store = await openStore(dir, { clock, farm })
  const history = Array.from({ length: MAX_TRADING_HISTORY + 5 }, (_, index) => ({
    id: 'h' + index,
    crop: 'tomato',
    side: 'long',
    margin: 50,
    leverage: 1,
    entry: 5,
    exit: 6,
    pnl: 10,
    reason: 'close',
    at: SLOT_EDGE - (index + 1) * 1000
  }))
  await writeTrading(dir, {
    version: TRADING_VERSION,
    week: { start: weekStartOf(SLOT_EDGE - 7 * 24 * 60 * 60 * 1000), pnl: 7, base: 1 },
    positions: [],
    history
  })
  const trimmed = await openStore(dir, { clock, farm })
  assert.equal(trimmed.view({ historyLimit: MAX_TRADING_HISTORY }).history.length, MAX_TRADING_HISTORY)

  // 跨到下一周：tick 里重设本周（pnl 清零、base 换成此刻硬币）。
  clock.set(weekStartOf(SLOT_EDGE) + 7 * 24 * 60 * 60 * 1000 + 1000)
  await trimmed.tick()
  const view = trimmed.view()
  assert.equal(view.week.pnl, 0)
  assert.equal(view.week.base, 500)
  assert.equal(view.week.start, weekStartOf(clock.now()))
})

test('票 79：读盘归一化不认白名单之外的字段', () => {
  const normalized = normalizeTradingFile({
    version: 1,
    week: { start: MONDAY, pnl: 3, base: 100, extra: 'nope' },
    positions: [{
      id: 'p1',
      crop: 'tomato',
      side: 'long',
      margin: 50,
      leverage: 1,
      entry: 5,
      openedAt: SLOT_EDGE,
      slot: SLOT,
      coins: 999_999,
      nickname: '伪造'
    }],
    history: []
  })
  assert.equal(normalized.corrupt, false)
  assert.equal(normalized.repaired, 0)
  assert.deepEqual(Object.keys(normalized.state.positions[0]).sort(),
    ['crop', 'entry', 'id', 'leverage', 'margin', 'openedAt', 'side', 'slot'])
  assert.equal('extra' in normalized.state.week, false)
  // slot 是派生字段：文件里写错会被重算（并计一处修补）。
  const fixed = normalizeTradingFile({
    version: 1,
    positions: [{
      id: 'p1', crop: 'tomato', side: 'long', margin: 50, leverage: 1, entry: 5,
      openedAt: SLOT_EDGE, slot: 1
    }],
    history: []
  })
  assert.equal(fixed.state.positions[0].slot, SLOT)
  assert.equal(fixed.repaired, 1)
  // 空文件也可以是「还没开始」的一周。
  assert.equal(normalizeTradingFile({}).state.week.start, null)
})
