/**
 * 票 83：到价开仓（本地限价单）的账本行为。
 *
 * 临时目录 + 假时钟 + 假农场（只记 coins / spendCoins / addCoins），不联网、不 sleep。
 * 行情是 board-v4 的**分钟级随机游走**（同一分钟内价格恒定）：需要某种形状的行情时
 * （第一次越价、跌破止损线、收盘前从不越价），全部从 `SLOT_EDGE` 往后现场扫出来
 * （见 `fillBar` / `dropBar` / `noFillBar`），不再写死 slot / tick / 价格。
 * 成交价、退款次数、硬币余额全按外部行为断言，不测私有函数。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  TRADING_FILE,
  TRADING_VERSION,
  createTradingStore,
  normalizeTradingFile
} from '../src/trading.js'
import {
  SLOT_MS,
  SLOT_TICKS,
  TICK_MS,
  boardPrice,
  liquidationPriceOf,
  markPrice,
  settlementOf,
  slotClosePrice,
  slotIndexAt,
  tradingFeeOf,
  weekStartOf
} from '../src/trading-rules.js'

/** 正好落在 slot 边界上的一刻。 */
const SLOT_EDGE = 1763308800000
const SLOT = SLOT_EDGE / SLOT_MS

/** 一根里 0..15 分钟的价格（tick 15 就是收盘价）。 */
function pricesOf (slot) {
  const prices = []
  for (let tick = 0; tick <= SLOT_TICKS; tick += 1) {
    prices.push(boardPrice({ crop: 'tomato', slot, tick }))
  }
  return prices
}

/**
 * 成交用的那一根：tick 1 之后**第一次**越价落在 tick 2..14 的最低点（`LONG_FILL_TICK`）。
 * 做多 target 取这个低点 → 目标价在那一分钟第一次被摸到；做空 target 取第 1 分钟的价，
 * 第 1 分钟第一次越价。价格是随机的（board-v4 随机游走），所以现场扫，不写死。
 */
function fillBar (fromSlot) {
  for (let slot = fromSlot; slot < fromSlot + 4000; slot += 1) {
    const prices = pricesOf(slot)
    let tick = 2
    let low = prices[2]
    for (let t = 3; t <= 14; t += 1) {
      if (prices[t] < low) {
        low = prices[t]
        tick = t
      }
    }
    // 必须是**第一次**越价：成交那一分钟之前没有更低的价。
    if (prices.slice(1, tick).some((price) => price <= low)) continue
    return { slot, tick, target: low }
  }
  throw new Error('找不到「tick 1 之后第一次越价落在 tick 2..14」的行情（行情规则改了？）')
}
const { slot: FILL_SLOT, tick: LONG_FILL_TICK } = fillBar(SLOT)
const SHORT_FILL_TICK = 1
const MONDAY = weekStartOf(SLOT_EDGE)

/**
 * 强平/止损用的那一根：tick 1 开仓，之后**第一次**跌破 −5% 的那一分钟（`DROP_TICK`）
 * 要深到 −5.5%——5× 的 −25% 止损档在 −5% 价格处触发，多跌一点才不会擦线落在 −12。
 * 20× 老仓的强平线（−4.75%）也在这根里：同一根能测「强平先于止损」和「按强平线成交」。
 * 行情是随机的，这一根（含强平撞线的那一分钟）也是现场扫出来的。
 */
function dropBar (fromSlot) {
  for (let slot = fromSlot; slot < fromSlot + 20000; slot += 1) {
    const prices = pricesOf(slot)
    const entry = prices[1]
    let dropTick = -1
    for (let tick = 3; tick <= SLOT_TICKS; tick += 1) {
      if (prices[tick] <= entry * 0.95) {
        dropTick = tick
        break
      }
    }
    if (dropTick < 0) continue
    if (prices[dropTick] > entry * 0.945) continue
    // 20× 的强平线：第一次撞线的那一分钟（强平按线成交，at 用这一分钟）。
    const line = liquidationPriceOf({ side: 'long', entry, leverage: 20 })
    let liqTick = -1
    for (let tick = 2; tick <= SLOT_TICKS; tick += 1) {
      if (prices[tick] <= line) {
        liqTick = tick
        break
      }
    }
    if (liqTick < 0) continue
    return { slot, entry, dropTick, liqTick, line }
  }
  throw new Error('找不到「tick 1 开仓后第一次跌破 −5% 且深到 −5.5%」的行情（行情规则改了？）')
}
const {
  slot: DROP_SLOT,
  entry: DROP_ENTRY,
  dropTick: DROP_TICK,
  liqTick: DROP_LIQ_TICK,
  line: DROP_LIQ_LINE
} = dropBar(SLOT + 2)

/**
 * 「这一根从没越价」用的那一根：目标价压在这一根所有分钟价之下（`low`），
 * 而下一根的 tick 1 已经低于它——「此刻现价已越过目标价」但挂单只活一根，
 * 到期只退款、不成交。和 `dropBar` 分开扫：同一根同时满足两边太苛刻。
 */
function noFillBar (fromSlot) {
  for (let slot = fromSlot; slot < fromSlot + 4000; slot += 1) {
    const prices = pricesOf(slot)
    const low = Math.min(...prices.slice(1))
    const nextFirst = boardPrice({ crop: 'tomato', slot: slot + 1, tick: 1 })
    if (nextFirst >= low) continue
    return { slot, target: nextFirst }
  }
  throw new Error('找不到「下一根更低、这一根从不越价」的行情（行情规则改了？）')
}
const { slot: NOFILL_SLOT, target: NOFILL_TARGET } = noFillBar(SLOT + 2)

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-trading-orders-'))
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

function priceAt (slot, tick) {
  return markPrice({ crop: 'tomato', now: slot * SLOT_MS + tick * TICK_MS })
}

/** 这一根里所有 tick 的最低价（挑「绝不会成交」的目标价用）。 */
function tickLowOf (slot) {
  let low = Infinity
  for (let tick = 0; tick <= SLOT_TICKS; tick += 1) low = Math.min(low, priceAt(slot, tick))
  return low
}

test('票 83：挂单当场锁保证金一次；视图/存档有单；重启不重复扣钱', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(FILL_SLOT * SLOT_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const target = priceAt(FILL_SLOT, LONG_FILL_TICK)

  const placed = await store.placeOrder({
    crop: 'tomato',
    side: 'long',
    target,
    margin: 50,
    leverage: 5
  })
  assert.equal(placed.ok, true, JSON.stringify(placed))
  assert.equal(placed.persisted, true)
  assert.equal(farm.wallet.coins, 450, '挂单当场锁掉保证金')
  assert.equal(placed.coins, 450)
  assert.match(placed.notice, /目标/)

  const view = store.view({ now: clock.now() })
  assert.equal(view.orders.length, 1)
  const order = view.orders[0]
  assert.equal(order.crop, 'tomato')
  assert.equal(order.side, 'long')
  assert.equal(order.target, target)
  assert.equal(order.margin, 50)
  assert.equal(order.leverage, 5)
  assert.equal(order.placedAt, clock.now())
  assert.equal(order.slot, slotIndexAt(clock.now()))
  assert.equal(order.remainingMs, FILL_SLOT * SLOT_MS + SLOT_MS - clock.now())
  // 挂单的保证金也在「含锁定」里：展示层加回，farm.json 只有可用硬币。
  assert.equal(view.locked, 50)
  assert.equal(view.unrealized, 0)
  assert.equal(farm.calls.filter(([kind]) => kind === 'spend').length, 1)

  // 磁盘就是契约形状：订单在主文件里，没有余额字段。
  const file = await readTrading(dir)
  assert.equal(file.version, TRADING_VERSION)
  assert.equal(file.orders.length, 1)
  assert.equal(file.orders[0].target, target)
  assert.equal('coins' in file, false)

  // 重启：单还在，硬币不会因为「读到一张单」再扣一次。
  const restarted = await openStore(dir, { clock, farm })
  const afterRestart = restarted.view({ now: clock.now() })
  assert.equal(afterRestart.orders.length, 1)
  assert.equal(afterRestart.orders[0].id, order.id)
  assert.equal(farm.wallet.coins, 450)
})

test('票 83：坏挂单/硬币不够都不扣钱；同一价位连挂两张各扣各的', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(FILL_SLOT * SLOT_MS + TICK_MS)
  const farm = fakeFarm(120)
  const store = await openStore(dir, { clock, farm })
  const target = priceAt(FILL_SLOT, LONG_FILL_TICK)

  const bads = [
    [{ crop: 'dragonfruit', side: 'long', target, margin: 50, leverage: 5 }, 'bad-crop'],
    [{ crop: 'tomato', side: 'up', target, margin: 50, leverage: 5 }, 'bad-side'],
    [{ crop: 'tomato', side: 'long', target, margin: 0, leverage: 5 }, 'bad-margin'],
    [{ crop: 'tomato', side: 'long', target, margin: 50.5, leverage: 5 }, 'bad-margin'],
    [{ crop: 'tomato', side: 'long', target, margin: 50, leverage: 2 }, 'bad-leverage'],
    // 带外的目标价永远成交不了：挂单时就拒，不能白锁硬币。
    [{ crop: 'tomato', side: 'long', target: 99, margin: 50, leverage: 5 }, 'bad-target'],
    [{ crop: 'tomato', side: 'long', target: 1, margin: 50, leverage: 5 }, 'bad-target'],
    [{ crop: 'tomato', side: 'long', target: 'x', margin: 50, leverage: 5 }, 'bad-target']
  ]
  for (const [raw, error] of bads) {
    const result = await store.placeOrder(raw)
    assert.equal(result.ok, false, JSON.stringify(raw))
    assert.equal(result.error, error, JSON.stringify(raw))
  }
  assert.equal(farm.wallet.coins, 120)
  assert.deepEqual(farm.calls, [], '被拒的申请一次都不碰钱包')

  // 同一价位挂两张是两张独立的单：各锁 50，不是「去重」也不是重复扣同一张。
  assert.equal((await store.placeOrder({ crop: 'tomato', side: 'long', target, margin: 50, leverage: 1 })).ok, true)
  assert.equal((await store.placeOrder({ crop: 'tomato', side: 'long', target, margin: 50, leverage: 1 })).ok, true)
  assert.equal(farm.wallet.coins, 20)
  assert.equal(store.view({ now: clock.now() }).orders.length, 2)
  // 第三张余额不够：no-coin，一分不动。
  const third = await store.placeOrder({ crop: 'tomato', side: 'long', target, margin: 50, leverage: 1 })
  assert.equal(third.error, 'no-coin')
  assert.equal(farm.wallet.coins, 20)
  assert.equal(store.view({ now: clock.now() }).orders.length, 2)
})

test('票 83：做多跌到目标价、做空涨到目标价——成交价是目标价，时刻是第一处越价', async (t) => {
  // 做多：目标价取 tick 2..14 里第一次越价的那个低点，成交就在那一分钟。
  const longDir = await tempDir(t)
  // 挂单就在这一根开盘那一刻：成交必须发生在挂单之后，不能拿「挂单前的价」倒推。
  const longClock = makeClock(FILL_SLOT * SLOT_MS)
  const longFarm = fakeFarm(500)
  const longStore = await openStore(longDir, { clock: longClock, farm: longFarm })
  const longTarget = priceAt(FILL_SLOT, LONG_FILL_TICK)
  assert.equal((await longStore.placeOrder({
    crop: 'tomato', side: 'long', target: longTarget, margin: 50, leverage: 5
  })).ok, true)
  longClock.set(FILL_SLOT * SLOT_MS + LONG_FILL_TICK * TICK_MS)
  await longStore.tick()
  const longView = longStore.view({ now: longClock.now() })
  assert.equal(longView.orders.length, 0, '成交后挂单消失')
  assert.equal(longView.positions.length, 1)
  const longPosition = longView.positions[0]
  assert.equal(longPosition.entry, longTarget, '成交价 = 目标价，不是越过那一刻的现价')
  assert.equal(longPosition.side, 'long')
  assert.equal(longPosition.margin, 50)
  assert.equal(longPosition.leverage, 5)
  assert.equal(longPosition.openedAt, FILL_SLOT * SLOT_MS + LONG_FILL_TICK * TICK_MS)
  assert.equal(longPosition.slot, FILL_SLOT)
  assert.equal(longPosition.stopLoss, 0, '挂单成交的仓位默认不设止损')
  assert.equal(longFarm.wallet.coins, 450, '成交不再动钱（保证金早就锁了）')
  assert.equal(longFarm.calls.filter(([kind]) => kind === 'add').length, 0)

  // 做空：目标价取第 1 分钟的价，第 1 分钟第一次越价。
  const shortDir = await tempDir(t)
  const shortClock = makeClock(FILL_SLOT * SLOT_MS)
  const shortFarm = fakeFarm(500)
  const shortStore = await openStore(shortDir, { clock: shortClock, farm: shortFarm })
  const shortTarget = priceAt(FILL_SLOT, SHORT_FILL_TICK)
  assert.equal((await shortStore.placeOrder({
    crop: 'tomato', side: 'short', target: shortTarget, margin: 100, leverage: 1
  })).ok, true)
  shortClock.set(FILL_SLOT * SLOT_MS + SHORT_FILL_TICK * TICK_MS)
  await shortStore.tick()
  const shortPosition = shortStore.view({ now: shortClock.now() }).positions[0]
  assert.equal(shortPosition.side, 'short')
  assert.equal(shortPosition.entry, shortTarget)
  assert.equal(shortPosition.openedAt, FILL_SLOT * SLOT_MS + SHORT_FILL_TICK * TICK_MS)
  assert.equal(shortFarm.wallet.coins, 400)
})

test('票 83：这一根从没越价就不成交（哪怕此刻的现价已经越过目标），到期只退一次', async (t) => {
  const dir = await tempDir(t)
  const placedAt = NOFILL_SLOT * SLOT_MS
  const clock = makeClock(placedAt)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  // 这一根从 tick 1 到收盘都不低于 NOFILL_TARGET；目标价只在下一根才被摸到。
  const later = (NOFILL_SLOT + 1) * SLOT_MS + TICK_MS
  assert.ok(markPrice({ crop: 'tomato', now: later }) <= NOFILL_TARGET, '此刻现价已经越过目标价')
  assert.equal((await store.placeOrder({
    crop: 'tomato', side: 'long', target: NOFILL_TARGET, margin: 50, leverage: 5
  })).ok, true)
  assert.equal(farm.wallet.coins, 450)

  clock.set(later)
  await store.tick()
  const view = store.view({ now: clock.now() })
  assert.equal(view.orders.length, 0, '过了这一根，没成交就撤')
  assert.equal(view.positions.length, 0, '不能拿「此刻现价」倒推成交')
  assert.equal(view.history.length, 0, '撤单/到期不进历史')
  assert.equal(farm.wallet.coins, 500, '保证金原样退回')
  assert.deepEqual(farm.calls, [['spend', 50], ['add', 50]], '一锁一退，各一次')

  // 再拍一次也不会再退一次。
  await store.tick()
  assert.equal(farm.wallet.coins, 500)
  assert.equal(farm.calls.filter(([kind]) => kind === 'add').length, 1)
})

test('票 83：refunding 意图（写完退款就崩）在启动时只补删单，绝不重复加钱', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(FILL_SLOT * SLOT_MS + 2 * TICK_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const target = priceAt(FILL_SLOT, LONG_FILL_TICK)
  assert.equal((await store.placeOrder({
    crop: 'tomato', side: 'long', target, margin: 50, leverage: 1
  })).ok, true)
  assert.equal(farm.wallet.coins, 450)

  // 磁盘上是「意图已写、钱已退、单还没删」的那一刻：把硬币补回 500 再重启。
  const file = await readTrading(dir)
  file.orders[0].refunding = { at: clock.now() }
  await writeTrading(dir, file)
  farm.wallet.coins = 500
  farm.calls.length = 0

  const restarted = await openStore(dir, { clock, farm })
  assert.equal(restarted.view().orders.length, 0, '补完删单')
  assert.equal(farm.wallet.coins, 500)
  assert.deepEqual(farm.calls, [], '启动恢复一次 addCoins 都不该发生')
  assert.equal((await readTrading(dir)).orders.length, 0, '补完之后落盘')

  // 再重启一次：不会冒出第二张单，也不会再退钱。
  const again = await openStore(dir, { clock, farm })
  assert.equal(again.view().orders.length, 0)
  assert.equal(farm.wallet.coins, 500)
  assert.deepEqual(farm.calls, [])
})

test('票 83：手动撤单退一次；再撤是 no-order；撤单不进历史', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(FILL_SLOT * SLOT_MS + 3 * TICK_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const target = priceAt(FILL_SLOT, LONG_FILL_TICK)
  const placed = await store.placeOrder({
    crop: 'tomato', side: 'short', target, margin: 100, leverage: 5
  })
  assert.equal(farm.wallet.coins, 400)

  const cancelled = await store.cancelOrder(placed.order.id)
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled))
  assert.equal(cancelled.orderId, placed.order.id)
  assert.equal(cancelled.coins, 500)
  assert.match(cancelled.notice, /撤单/)
  assert.equal(store.view({ now: clock.now() }).orders.length, 0)
  assert.equal(store.view({ now: clock.now() }).history.length, 0, '历史只记平掉的仓位')
  assert.equal(farm.calls.filter(([kind]) => kind === 'add').length, 1)

  const again = await store.cancelOrder(placed.order.id)
  assert.equal(again.error, 'no-order')
  assert.equal(farm.wallet.coins, 500)
  assert.equal((await store.cancelOrder('nope')).error, 'no-order')

  // 撤掉以后同一根还能再挂（硬币回来了）。
  assert.equal((await store.placeOrder({
    crop: 'tomato', side: 'long', target, margin: 100, leverage: 1
  })).ok, true)
  assert.equal(farm.wallet.coins, 400)
})

test('票 83：坏挂单行只丢自己并计修补；缺省 orders 不算修补；好单能读回来', async (t) => {
  const good = {
    id: 'o-good',
    crop: 'tomato',
    side: 'long',
    // 目标价压在这一根所有 tick 之下（由行情现算）：写死价格会被当场越价成交，
    // 那就不是「好单读得回来」而是「好单已经成交」了。
    target: tickLowOf(FILL_SLOT) * 0.999,
    margin: 50,
    leverage: 5,
    placedAt: FILL_SLOT * SLOT_MS,
    slot: FILL_SLOT
  }
  const normalized = normalizeTradingFile({
    version: 1,
    week: { start: MONDAY, pnl: 0, base: 500 },
    positions: [],
    orders: [
      good,
      null,
      { ...good, id: 'o-no-band', target: 99 },
      { ...good, id: 'o-bad-lev', leverage: 2 },
      { ...good, id: 'o-bad-margin', margin: 0 },
      { ...good, id: 'o-bad-crop', crop: 'dragonfruit' }
    ],
    history: []
  })
  assert.equal(normalized.corrupt, false)
  assert.equal(normalized.state.orders.length, 1)
  assert.equal(normalized.state.orders[0].id, 'o-good')
  assert.equal(normalized.repaired, 5, '丢 5 条坏挂单')

  // 缺省 orders（老 v1 文件）：空数组 + 零修补，不是「坏文件」。
  const legacy = normalizeTradingFile({
    version: 1,
    week: { start: MONDAY, pnl: 0, base: 500 },
    positions: [],
    history: []
  })
  assert.deepEqual(legacy.state.orders, [])
  assert.equal(legacy.repaired, 0)
  assert.equal(legacy.corrupt, false)
  // 不是数组才是一处形状修补。
  const wrong = normalizeTradingFile({
    version: 1,
    week: { start: MONDAY, pnl: 0, base: 500 },
    positions: [],
    orders: 'nope',
    history: []
  })
  assert.deepEqual(wrong.state.orders, [])
  assert.equal(wrong.repaired, 1)

  // 带一张好单的存档：启动只告警一次，单还在。
  const dir = await tempDir(t)
  const clock = makeClock(FILL_SLOT * SLOT_MS + TICK_MS)
  const farm = fakeFarm(500)
  await writeTrading(dir, {
    version: TRADING_VERSION,
    week: { start: MONDAY, pnl: 0, base: 500 },
    positions: [],
    orders: [good, { id: 'broken' }],
    history: []
  })
  const logger = makeLogger()
  const store = await openStore(dir, { clock, farm, log: logger.log })
  assert.equal(store.view({ now: clock.now() }).orders.length, 1)
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /修补/)
})

test('票 83：到价成交的仓位照样走得完强平——20× 老仓插针只亏保证金', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(DROP_SLOT * SLOT_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const target = DROP_ENTRY
  assert.equal(target, priceAt(DROP_SLOT, 1), '目标价就是 tick 1 的价')
  assert.equal((await store.placeOrder({
    crop: 'tomato', side: 'long', target, margin: 50, leverage: 5
  })).ok, true)
  assert.equal(farm.wallet.coins, 450)

  // 成交：第 1 分钟第一次越价，仓位 entry = 目标价。
  clock.set(DROP_SLOT * SLOT_MS + TICK_MS)
  await store.tick()
  const filled = store.view({ now: clock.now() })
  assert.equal(filled.positions.length, 1)
  assert.equal(filled.positions[0].entry, target)

  // 新单最高 5×，一根要跌 19% 才强平（v4 一根最多约 6%）——强平路径只有老仓能走到：
  // 把落盘的杠杆改成 20（读盘允许 1..20 的老仓位），重启后同一根继续走。
  const file = await readTrading(dir)
  assert.equal(file.positions[0].leverage, 5)
  file.positions[0].leverage = 20
  await writeTrading(dir, file)
  const restarted = await openStore(dir, { clock, farm })
  assert.equal(restarted.view({ now: clock.now() }).positions[0].leverage, 20)

  clock.set((DROP_SLOT + 1) * SLOT_MS)
  await restarted.tick()
  const view = restarted.view({ now: clock.now() })
  assert.equal(view.positions.length, 0)
  assert.equal(view.orders.length, 0)
  assert.equal(view.history.length, 1)

  const fee = tradingFeeOf({ margin: 50, leverage: 20 }) * 2
  const outcome = settlementOf({
    side: 'long', margin: 50, leverage: 20, entry: target, mark: DROP_LIQ_LINE, fee
  })
  const history = view.history[0]
  assert.equal(history.reason, 'liquidate')
  assert.equal(history.entry, target, '成交价仍是目标价')
  // 强平按**强平线本身**成交，不是撞线那一分钟的插针价。
  assert.equal(history.exit, liquidationPriceOf({ side: 'long', entry: target, leverage: 20 }))
  assert.equal(history.exit, DROP_LIQ_LINE)
  assert.equal(history.at, DROP_SLOT * SLOT_MS + DROP_LIQ_TICK * TICK_MS, '第一处撞线的那一分钟')
  assert.equal(history.pnl, outcome.pnl)
  assert.equal(history.fee, fee, '手续费在结算时一次扣清（开平两侧）')
  assert.equal(history.pnl >= -50, true, '亏损封顶保证金')
  assert.equal(history.pnl <= -40, true, '强平线只剩 5% 维持保证金，几乎亏光')
  assert.equal(farm.wallet.coins, 450, '保证金全亏，没有钱退回')
  assert.equal(view.week.pnl, outcome.pnl - outcome.fee, '本周盈亏是净额（pnl − fee）')
  assert.equal(farm.calls.some(([kind, qty]) => kind === 'add' && qty === 0), false, '不调 addCoins(0)')
})

test('票 83：到价成交后还能设止损，按路径上撞线那一分钟平', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(DROP_SLOT * SLOT_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const target = DROP_ENTRY
  assert.equal((await store.placeOrder({
    crop: 'tomato', side: 'long', target, margin: 50, leverage: 5
  })).ok, true)

  // 推进到 tick 2：成交（tick 1）后仓位还开着。
  clock.set(DROP_SLOT * SLOT_MS + 2 * TICK_MS)
  await store.tick()
  const position = store.view({ now: clock.now() }).positions[0]
  assert.equal(position.entry, target)
  assert.equal((await store.setStopLoss(position.id, 0.25)).ok, true)

  clock.set((DROP_SLOT + 1) * SLOT_MS)
  await store.tick()
  const view = store.view({ now: clock.now() })
  assert.equal(view.positions.length, 0)
  assert.equal(view.history.length, 1)
  const exit = priceAt(DROP_SLOT, DROP_TICK)
  const fee = tradingFeeOf({ margin: 50, leverage: 5 }) * 2
  const outcome = settlementOf({
    side: 'long', margin: 50, leverage: 5, entry: target, mark: exit, fee
  })
  const history = view.history[0]
  assert.equal(history.reason, 'stop')
  // 止损按**触发那一分钟的价**成交（不是强平线）。
  assert.equal(history.exit, exit)
  assert.equal(history.at, DROP_SLOT * SLOT_MS + DROP_TICK * TICK_MS)
  assert.equal(history.pnl, outcome.pnl)
  assert.equal(history.fee, fee)
  assert.equal(history.pnl <= -13, true, '−25% 保证金档（5× 下约 −14）')
  assert.equal(farm.wallet.coins, 450 + outcome.credit, '回款 = 保证金 + 盈亏 − 手续费')
})

test('票 83：到价成交后收盘照常结算（用这一根的收盘价）', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(FILL_SLOT * SLOT_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const target = priceAt(FILL_SLOT, LONG_FILL_TICK)
  assert.equal((await store.placeOrder({
    crop: 'tomato', side: 'long', target, margin: 50, leverage: 1
  })).ok, true)

  clock.set((FILL_SLOT + 1) * SLOT_MS)
  await store.tick()
  const view = store.view({ now: clock.now() })
  assert.equal(view.history.length, 1)
  assert.equal(view.history[0].reason, 'settle')
  assert.equal(view.history[0].exit, slotClosePrice('tomato', FILL_SLOT))
  assert.equal(view.history[0].openedAt, undefined, '历史行不复制开盘时刻（契约只有 at）')
  const fee = tradingFeeOf({ margin: 50, leverage: 1 }) * 2
  // 本周盈亏是净额：pnl − fee（这一档手续费取整为 0，但口径不写死）。
  assert.equal(view.week.pnl, view.history[0].pnl - fee)
})

test('票 83：保证金接受任意整数（全下/自定义金额），不只 50/100/250', async (t) => {
  const dir = await tempDir(t)
  const clock = makeClock(FILL_SLOT * SLOT_MS + TICK_MS)
  const farm = fakeFarm(500)
  const store = await openStore(dir, { clock, farm })
  const target = priceAt(FILL_SLOT, LONG_FILL_TICK)

  // 开仓 73：不是预设，但仍是合法金额（规则只守 1..MAX_MARGIN 的整数形状）。
  const opened = await store.openPosition({ side: 'long', margin: 73, leverage: 1 })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  assert.equal(opened.position.margin, 73)
  assert.equal(farm.wallet.coins, 427)

  // 挂单 127：同上；撤单后原样退回。
  const placed = await store.placeOrder({ crop: 'tomato', side: 'long', target, margin: 127, leverage: 5 })
  assert.equal(placed.ok, true, JSON.stringify(placed))
  assert.equal(placed.order.margin, 127)
  assert.equal(farm.wallet.coins, 300)
  const cancelled = await store.cancelOrder(placed.order.id)
  assert.equal(cancelled.ok, true)
  assert.equal(farm.wallet.coins, 427)
})
