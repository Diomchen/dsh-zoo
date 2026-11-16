/**
 * 票 79/80：盘口账本（`trading.json`）+ 农场硬币的联动。
 *
 * 临时目录 + 假时钟 + 假农场（只有 coins / spendCoins / addCoins 三个口），
 * 不联网、不 sleep。硬币的加减全部走真实 store 的串行队列与落盘。
 * 票 80 的用例挑的是确定性行情里「跳时钟之后一定撞线」的那一段（见 SLOT_80 的注释）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MAX_TRADING_HISTORY,
  TRADING_CLOSE_REASONS,
  TRADING_FILE,
  TRADING_VERSION,
  createTradingStore,
  normalizeTradingFile
} from '../src/trading.js'
import {
  SLOT_MS,
  TICK_MS,
  boardPrice,
  liquidationPriceOf,
  markPrice,
  pnlOf,
  settlementOf,
  slotClosePrice,
  slotIndexAt,
  weekStartOf
} from '../src/trading-rules.js'
import { tradingErrorText, tradingReasonText } from '../src/trading-text.js'

/** 正好落在 slot 边界上的一刻。 */
const SLOT_EDGE = 1763308800000
const SLOT = SLOT_EDGE / SLOT_MS
const MONDAY = weekStartOf(SLOT_EDGE)
/**
 * 票 80 用的那一根：`SLOT_EDGE + SLOT_MS`（下一根）开在 tick 5，之后一路跌到收盘。
 * 20× 做多在这一根里 tick 12 撞强平线（−5%），5× 做多 + −25% 止损也在 tick 12 撞线
 * （−5% 价格 = −25% 保证金），而收盘价离得更远——「按路径平」和「按收盘平」拿到的价不同。
 */
const SLOT_80 = SLOT + 1
const OPEN_80 = SLOT_80 * SLOT_MS + 5 * TICK_MS
const TICK_80 = 12

/**
 * 找一根「先跌破 −25% 止损档、随后又收回去」的行情（评审 P0 的回归用例）。
 * 20× 做多时 −25% 保证金 = −1.25% 价格：挑那根里一次都没碰到 −5% 强平线的，
 * 这样「旧插针补平」与「强平」不会被混在一起。返回开仓 tick、插针 tick 与
 * 可以安全设止损的 tick。找不到就抛——行情规则改了，用例要重新挑点。
 */
function dipThenRecover (startSlot) {
  for (let slot = startSlot; slot < startSlot + 600; slot += 1) {
    const prices = []
    for (let tick = 0; tick <= 15; tick += 1) {
      prices.push(boardPrice({ crop: 'tomato', slot, tick }))
    }
    const entry = prices[5]
    const threshold = entry * (1 - 0.25 / 20)
    if (prices.some((price) => price <= entry * 0.95)) continue
    for (let dip = 6; dip < 15; dip += 1) {
      if (prices[dip] >= threshold) continue
      for (let setTick = dip + 1; setTick < 15; setTick += 1) {
        if (prices[setTick] < threshold) continue
        let clean = true
        for (let tick = setTick; tick <= 15; tick += 1) {
          if (prices[tick] < threshold) clean = false
        }
        if (clean) return { slot, entry, dip, setTick }
      }
    }
  }
  throw new Error('找不到「先跌破止损再收回」的行情（行情规则改了？）')
}

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

test('票 79/83：白名单之外的作物/方向/保证金/杠杆都不开仓', async (t) => {
  const dir = await tempDir(t)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock: makeClock(), farm })
  // 票 83：250 已经是预设之一；坏保证金的边界改成 0 / 小数 / 超过硬币上限。
  assert.equal((await store.openPosition({ side: 'long', margin: 0 })).error, 'bad-margin')
  assert.equal((await store.openPosition({ side: 'long', margin: 50.5 })).error, 'bad-margin')
  assert.equal((await store.openPosition({ side: 'long', margin: 1_000_001 })).error, 'bad-margin')
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
  assert.deepEqual(view.orders, [], '两条坏挂单只丢自己')
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
    ['crop', 'entry', 'id', 'leverage', 'margin', 'openedAt', 'side', 'slot', 'stopLoss'])
  // 票 80：没写 stopLoss 的老档案按「关」读，且不算修补。
  assert.equal(normalized.state.positions[0].stopLoss, 0)
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

test('票 80：5×/20× 开仓落盘；持仓带强平价与止损档，1× 没有强平线', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(SLOT_EDGE + 3 * TICK_MS)
  const farm = fakeFarm(1000)
  const store = await openStore(dir, { clock, farm })

  const one = await store.openPosition({ side: 'long', margin: 50, leverage: 1 })
  const five = await store.openPosition({ side: 'long', margin: 50, leverage: 5 })
  const twenty = await store.openPosition({ side: 'short', margin: 100, leverage: 20 })
  assert.equal(one.ok, true, JSON.stringify(one))
  assert.equal(five.ok, true, JSON.stringify(five))
  assert.equal(twenty.ok, true, JSON.stringify(twenty))
  assert.equal(farm.wallet.coins, 800, '三手各扣各的保证金')

  const now = SLOT_EDGE + 3 * TICK_MS
  const view = store.view({ now })
  const [first, second, third] = view.positions
  // 1× 没有强平线：窗口画「—」。
  assert.equal(first.liquidation, null)
  assert.equal(first.stopLoss, 0, '止损默认关')
  // 5×/20× 的强平价 = entry × (1 ∓ 1/杠杆)，和纯规则同源。
  assert.equal(second.leverage, 5)
  assert.equal(second.liquidation, liquidationPriceOf({ side: 'long', entry: second.entry, leverage: 5 }))
  assert.equal(third.leverage, 20)
  assert.equal(third.liquidation, liquidationPriceOf({ side: 'short', entry: third.entry, leverage: 20 }))
  assert.ok(third.liquidation > third.entry, '做空的强平线在入场价上方')

  // 磁盘上：杠杆、止损落盘；强平价是派生字段，不落盘（改 entry 后它会立刻变假）。
  const file = await readTrading(dir)
  assert.deepEqual(file.positions.map((position) => position.leverage), [1, 5, 20])
  assert.deepEqual(file.positions.map((position) => position.stopLoss), [0, 0, 0])
  assert.equal('liquidation' in file.positions[0], false)

  // 重启：杠杆与强平价都读得回来（5×/20× 不会因为读盘被降级）。
  const restarted = await openStore(dir, { clock, farm })
  const again = restarted.view({ now })
  assert.deepEqual(again.positions.map((position) => position.leverage), [1, 5, 20])
  assert.equal(again.positions[1].liquidation, second.liquidation)
})

test('票 80：一键止损——档位循环落盘；坏档位拒绝；坏值读回修补，缺省不算修补', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(SLOT_EDGE + 3 * TICK_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'long', margin: 50, leverage: 5 })
  const id = opened.position.id

  // 循环：−25% → −50% → −100% → 关，每次都说清现在是哪一档。
  const quarter = await store.setStopLoss(id, 0.25)
  assert.equal(quarter.ok, true, JSON.stringify(quarter))
  assert.equal(quarter.notice, '止损已设为 −25% 保证金。')
  assert.equal(quarter.position.stopLoss, 0.25)
  assert.equal((await readTrading(dir)).positions[0].stopLoss, 0.25, '档位立刻落盘')
  assert.equal((await store.setStopLoss(id, 0.5)).position.stopLoss, 0.5)
  assert.equal((await store.setStopLoss(id, 1)).position.stopLoss, 1)
  const off = await store.setStopLoss(id, 0)
  assert.equal(off.ok, true)
  assert.equal(off.notice, '止损已关闭。')
  assert.equal(off.position.stopLoss, 0)

  // 坏档位/坏 id：稳定错误码，且不改已有的档。
  await store.setStopLoss(id, 0.5)
  assert.equal((await store.setStopLoss(id, 0.3)).error, 'bad-stop')
  assert.equal((await store.setStopLoss(id, '0.5')).error, 'bad-stop')
  assert.equal((await store.setStopLoss(id, null)).error, 'bad-stop')
  assert.equal(store.view().positions[0].stopLoss, 0.5, '拒绝的一律不写')
  assert.equal((await store.setStopLoss('nope', 0.25)).error, 'no-position')
  assert.equal((await store.setStopLoss('', 0.25)).error, 'no-position')

  // 读盘：好值照读；坏值退回「关」并记**一处**修补（不知道的键才丢，认识的键只修）。
  const file = await readTrading(dir)
  const good = file.positions[0]
  file.positions = [good, { ...good, id: 'bad-stop', stopLoss: 0.4 }]
  await writeTrading(dir, file)
  const logger = makeLogger()
  const repairedStore = await openStore(dir, { clock, farm, log: logger.log })
  const repaired = repairedStore.view().positions
  assert.equal(repaired.length, 2, '坏档位不丢仓位')
  assert.equal(repaired[0].stopLoss, 0.5)
  assert.equal(repaired[1].stopLoss, 0, '坏档位退回默认值')
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /修补/)

  // 缺省同样退回「关」，但那是老档案的正常升级：一次告警都不该有。
  const clean = await tempDir(t)
  await writeTrading(clean, {
    version: TRADING_VERSION,
    week: { start: MONDAY, pnl: 0, base: 500 },
    positions: [{
      id: 'old', crop: 'tomato', side: 'long', margin: 50, leverage: 5, entry: 5,
      openedAt: SLOT_EDGE, slot: SLOT
    }],
    history: []
  })
  const quiet = makeLogger()
  const oldStore = await openStore(clean, { clock, farm: fakeFarm(500), log: quiet.log })
  assert.equal(oldStore.view().positions[0].stopLoss, 0)
  assert.deepEqual(quiet.warnings, [])
})

test('票 80：20× 强平——时钟跳过也按路径平，只亏保证金，硬币不为负', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(OPEN_80)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'long', margin: 50, leverage: 20 })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(farm.wallet.coins, 450, '开仓当场扣掉保证金')
  const entry = opened.position.entry
  const liquidation = opened.position.liquidation
  assert.equal(liquidation, liquidationPriceOf({ side: 'long', entry, leverage: 20 }))

  // 时钟直接跳过这一根：强平线在 tick 12 就被跌穿，收盘价还在更下面。
  clock.set(SLOT_EDGE + 2 * SLOT_MS + 1000)
  assert.equal(await store.tick(), true, 'tick 应当认账（强平）')
  const view = store.view()
  assert.equal(view.positions.length, 0)
  assert.equal(view.history.length, 1)
  const row = view.history[0]
  const exit = boardPrice({ crop: 'tomato', slot: SLOT_80, tick: TICK_80 })
  const expected = settlementOf({ side: 'long', margin: 50, leverage: 20, entry, mark: exit })
  assert.equal(row.reason, 'liquidate', '结算原因写「强平」')
  assert.equal(row.exit, exit, '平在第一次撞线那一刻的价')
  assert.equal(row.at, SLOT_80 * SLOT_MS + TICK_80 * TICK_MS)
  assert.ok(row.exit > slotClosePrice('tomato', SLOT_80), '不是按收盘价敷衍过去的')
  assert.equal(row.pnl, expected.pnl)
  assert.equal(row.pnl, -50, '亏损封顶保证金')
  assert.equal(farm.wallet.coins, 450, 'credit 0：只亏掉已经扣掉的 50')
  assert.equal(view.week.pnl, -50)
  assert.equal(farm.calls.some(([kind, qty]) => kind === 'add' && qty === 0), false, 'credit 0 不调 addCoins')
  assert.equal(tradingReasonText(row.reason), '强平')

  // 重复 tick / 重启：不再结一次、不再动钱。
  assert.equal(await store.tick(), false)
  const coins = farm.wallet.coins
  const restarted = await openStore(dir, { clock, farm })
  assert.equal(restarted.view().history.length, 1)
  assert.equal(restarted.view().positions.length, 0)
  assert.equal(farm.wallet.coins, coins)
  assert.equal((await readTrading(dir)).history.length, 1, '离线补算只写一条')
})

test('票 80：硬币本来就是 0 时强平也不为负（亏损上限是保证金）', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(OPEN_80)
  const farm = fakeFarm(50)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'long', margin: 50, leverage: 20 })
  assert.equal(farm.wallet.coins, 0, '全部硬币押进去了')

  clock.set(SLOT_EDGE + 2 * SLOT_MS + 1000)
  await store.tick()
  const row = store.view().history[0]
  assert.equal(row.reason, 'liquidate')
  assert.equal(row.pnl, -50)
  assert.equal(farm.wallet.coins, 0, '硬币不会变成负数')
  assert.equal(farm.calls.some(([kind]) => kind === 'add'), false, '没有一分钱要退')
})

test('票 80：止损到线按那一刻的 mark 平，原因 止损；默认关不触发；−100% 是真档位', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(OPEN_80)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  // 5× 做多：−25% 保证金 = −5% 价格，强平线还在 −20%（先撞止损）。
  const opened = await store.openPosition({ side: 'long', margin: 50, leverage: 5 })
  const id = opened.position.id
  const entry = opened.position.entry
  assert.equal((await store.setStopLoss(id, 0.25)).ok, true)

  clock.set(SLOT_EDGE + 2 * SLOT_MS + 1000)
  assert.equal(await store.tick(), true)
  const row = store.view().history[0]
  const exit = boardPrice({ crop: 'tomato', slot: SLOT_80, tick: TICK_80 })
  const expected = settlementOf({ side: 'long', margin: 50, leverage: 5, entry, mark: exit })
  assert.equal(row.reason, 'stop')
  assert.equal(row.exit, exit)
  assert.equal(row.pnl, expected.pnl)
  assert.ok(row.pnl > -50, '止损没等到亏光就平了')
  assert.equal(farm.wallet.coins, 450 + expected.credit)
  assert.equal(tradingReasonText(row.reason), '止损')

  // 重复 tick 不重复结。
  assert.equal(await store.tick(), false)
  assert.equal(farm.wallet.coins, 450 + expected.credit)

  // 默认关的那一手：同样的行情只按收盘价结（原因 `settle`），不会被止损抢走。
  const other = await tempDir(t)
  const otherClock = makeClock(OPEN_80)
  const otherFarm = fakeFarm(500)
  const noStop = await openStore(other, { clock: otherClock, farm: otherFarm })
  const plain = await noStop.openPosition({ side: 'long', margin: 50, leverage: 5 })
  assert.equal(plain.position.stopLoss, 0, '默认关')
  otherClock.set(SLOT_EDGE + 2 * SLOT_MS + 1000)
  await noStop.tick()
  const plainRow = noStop.view().history[0]
  assert.equal(plainRow.reason, 'settle')
  assert.equal(plainRow.exit, slotClosePrice('tomato', SLOT_80))

  // −100% 是真档位（不是「关」）：能写进档案，也真的在「亏光保证金」那一刻平。
  // 20× 的强平线（−5% 价格）这一根里会到；同一刻先算玩家设的止损，原因写「止损」。
  const last = await tempDir(t)
  const lastClock = makeClock(OPEN_80)
  const lastStore = await openStore(last, { clock: lastClock, farm: fakeFarm(500) })
  const taken = await lastStore.openPosition({ side: 'long', margin: 50, leverage: 20 })
  const doomed = await lastStore.setStopLoss(taken.position.id, 1)
  assert.equal(doomed.ok, true)
  assert.equal(doomed.position.stopLoss, 1)
  lastClock.set(SLOT_EDGE + 2 * SLOT_MS + 1000)
  await lastStore.tick()
  const lastRow = lastStore.view().history[0]
  assert.equal(lastRow.reason, 'stop')
  assert.equal(lastRow.pnl, -50, '到 −100% 保证金时正好亏光')
  // 和「不设档位」那手是同一个价、同一笔钱：档位没到就由强平接手（上面已经断言过）。
  assert.equal(lastRow.exit, boardPrice({ crop: 'tomato', slot: SLOT_80, tick: TICK_80 }))
})

test('票 80（评审 P0）：设止损不跳过之前的强平路径，新止损不按旧 mark 平', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(OPEN_80)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'long', margin: 50, leverage: 20 })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const entry = opened.position.entry
  assert.ok(liquidationPriceOf({ side: 'long', entry, leverage: 20 }) < entry * 0.96)

  // 时钟已经越过强平线（tick 12），但还没 tick：玩家偏偏在这时点了止损。
  // 之前的实现会把「检查进度」也推到此刻，下一拍直接按止损平掉——强平被跳过。
  clock.set(SLOT_80 * SLOT_MS + 13 * TICK_MS + 1000)
  assert.equal((await store.setStopLoss(opened.position.id, 0.25)).ok, true)

  assert.equal(await store.tick(), true)
  const row = store.view().history[0]
  const firstBreach = boardPrice({ crop: 'tomato', slot: SLOT_80, tick: TICK_80 })
  assert.equal(row.reason, 'liquidate', '下一拍仍要补出设止损之前越过的强平')
  assert.equal(row.at, SLOT_80 * SLOT_MS + TICK_80 * TICK_MS, '平在最早撞线的那一分钟')
  assert.equal(row.exit, firstBreach, '不是按设止损那一刻的 mark 平')
  assert.equal(row.pnl, -50)
  // 强平已经发生：止损档位不再有任何作用，钱只亏保证金。
  assert.equal(farm.wallet.coins, 450)
})

test('票 80（评审 P0）：设止损之前跌破档位的那一段不补平，之后照常收盘结算', async (t) => {
  const { slot, dip, setTick } = dipThenRecover(SLOT + 20)
  assert.ok(dip < setTick)
  const dir = await tempDir(t)
  const clock = makeClock(slot * SLOT_MS + 5 * TICK_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'long', margin: 50, leverage: 20 })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const entry = opened.position.entry
  const stopPrice = entry * (1 - 0.25 / 20)
  // 插针那一分钟确实在档位之下：如果设止损时把整段路径重扫一遍，它就会被补平。
  assert.ok(boardPrice({ crop: 'tomato', slot, tick: dip }) < stopPrice)

  // 插针过后、价格收回档位上方时设止损：新档位只能从这一刻起生效。
  clock.set(slot * SLOT_MS + setTick * TICK_MS)
  assert.equal((await store.setStopLoss(opened.position.id, 0.25)).ok, true)
  // 收盘后 tick：路径上从 setTick 起都没再跌破档位，也没碰强平线 → 按收盘价结算。
  clock.set((slot + 1) * SLOT_MS)
  assert.equal(await store.tick(), true)
  const row = store.view().history[0]
  assert.equal(row.reason, 'settle', '设止损之前的那次插针不能按新档位补平')
  assert.equal(row.exit, slotClosePrice('tomato', slot))
  assert.equal(row.at, (slot + 1) * SLOT_MS)
})

test('票 80（评审 P0）：快进跨多根仍按最早撞线那一刻平，不按收盘价敷衍', async (t) => {
  // 强平：20× 做多，时钟一次跳过 6 根，路径上第一处触发仍在开仓那一根的 tick 12。
  const dir = await tempDir(t)
  const clock = makeClock(OPEN_80)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'long', margin: 50, leverage: 20 })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  clock.set(OPEN_80 + 6 * SLOT_MS)
  assert.equal(await store.tick(), true)
  const liquidated = store.view().history[0]
  assert.equal(liquidated.reason, 'liquidate')
  assert.equal(liquidated.at, SLOT_80 * SLOT_MS + TICK_80 * TICK_MS)
  assert.equal(liquidated.exit, boardPrice({ crop: 'tomato', slot: SLOT_80, tick: TICK_80 }))
  assert.ok(liquidated.exit > slotClosePrice('tomato', SLOT_80), '最早撞线价不是收盘价')
  assert.equal(liquidated.pnl, -50)

  // 止损：5× 做多 + −25% 档，同样跳 6 根；最早触发那一刻（同一个 tick 12）优先于收盘。
  const stopDir = await tempDir(t)
  const stopClock = makeClock(OPEN_80)
  const stopFarm = fakeFarm(500)
  const stopStore = await openStore(stopDir, { clock: stopClock, farm: stopFarm })
  const stopOpened = await stopStore.openPosition({ side: 'long', margin: 50, leverage: 5 })
  assert.equal((await stopStore.setStopLoss(stopOpened.position.id, 0.25)).ok, true)
  stopClock.set(OPEN_80 + 6 * SLOT_MS)
  assert.equal(await stopStore.tick(), true)
  const stopped = stopStore.view().history[0]
  assert.equal(stopped.reason, 'stop')
  assert.equal(stopped.at, SLOT_80 * SLOT_MS + TICK_80 * TICK_MS)
  assert.equal(stopped.exit, boardPrice({ crop: 'tomato', slot: SLOT_80, tick: TICK_80 }))
  assert.ok(stopped.exit > slotClosePrice('tomato', SLOT_80), '最早撞线价不是收盘价')
})

test('票 80：关掉止损后不再触发；离线几个小时回来只补一次', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(OPEN_80)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const opened = await store.openPosition({ side: 'long', margin: 50, leverage: 5 })
  const id = opened.position.id
  await store.setStopLoss(id, 0.25)
  await store.setStopLoss(id, 0)

  // 关掉之后：按收盘价结（1× 都不触发，5× 也不会被止损抢）。
  clock.set(SLOT_EDGE + 2 * SLOT_MS + 1000)
  await store.tick()
  assert.equal(store.view().history[0].reason, 'settle')

  // 另一手带着止损「离线」几个小时：启动时按路径补出止损，只补一次。
  const offline = await tempDir(t)
  const offlineClock = makeClock(OPEN_80)
  const offlineFarm = fakeFarm(300)
  const before = await openStore(offline, { clock: offlineClock, farm: offlineFarm })
  const pending = await before.openPosition({ side: 'long', margin: 50, leverage: 5 })
  await before.setStopLoss(pending.position.id, 0.25)
  assert.equal(offlineFarm.wallet.coins, 250)

  offlineClock.set(OPEN_80 + 5 * 60 * 60 * 1000)
  const afterRestart = await openStore(offline, { clock: offlineClock, farm: offlineFarm })
  const view = afterRestart.view()
  assert.equal(view.positions.length, 0)
  assert.equal(view.history.length, 1)
  assert.equal(view.history[0].reason, 'stop')
  assert.equal(view.history[0].exit, boardPrice({ crop: 'tomato', slot: SLOT_80, tick: TICK_80 }))
  const coins = offlineFarm.wallet.coins
  assert.equal(coins, 250 + view.history[0].pnl + 50)

  // 再启动一次 + 再 tick：历史还是那一条，硬币不再变。
  const again = await openStore(offline, { clock: offlineClock, farm: offlineFarm })
  await again.tick()
  assert.equal(again.view().history.length, 1)
  assert.equal(offlineFarm.wallet.coins, coins)
})

test('票 80：结算原因枚举四项，文案表一项不缺', () => {
  assert.deepEqual(TRADING_CLOSE_REASONS, ['close', 'settle', 'liquidate', 'stop'])
  for (const reason of TRADING_CLOSE_REASONS) {
    assert.equal(typeof tradingReasonText(reason), 'string', reason + ' 缺中文')
  }
  assert.equal(tradingReasonText('teleport'), null)
  assert.equal(tradingReasonText(0), null)
  // 票 80 的错误码也有人话：窗口 toast / 桌面 action-result 都从这份表取。
  assert.match(tradingErrorText('bad-stop'), /止损/)
  assert.match(tradingErrorText('bad-leverage'), /1×/)
  assert.equal(tradingErrorText('nope'), null)
})
