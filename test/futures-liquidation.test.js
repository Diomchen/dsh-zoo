/**
 * 票 97：真强平与保险基金兜底。
 *
 * 只回答六件事：强平按路径采样触发（不是收盘价、不是交割价）、同一拍多仓位按可复现的顺序执行、
 * 亏空先花保险基金再记欠账、费用按 10% 注入基金、交割费收不上来也走同一条兜底、重复 tick 不重复强平。
 *
 * 全部用真磁盘（tmpdir）和一个假时钟：把仓位直接写进 `futures.json` 再造 store，
 * 这样能精确控制「建仓价 / 建仓时刻 / 基金余额」，不必依赖真实下单路径的中间状态。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CROPS } from '../src/farm-rules.js'
import { FUTURES_FILE, FUTURES_VERSION, createFuturesStore } from '../src/futures.js'
import {
  DELIVERY_FEE_RATE,
  OU_STEP_MS,
  SLOT_MS,
  contractOf,
  deliveryPriceOf,
  fairPriceOf,
  feeSplitOf,
  marginOf,
  notionalOf,
  pnlOf,
  roundCoin,
  takerFeeOf
} from '../src/futures-rules.js'

/**
 * 指数价（可控）：全程恒定，路径只由 OU 偏离决定。
 * 取番茄的基准价，和真实盘口同源，避免测试里出现「凭空的指数」。
 */
const INDEX = CROPS.tomato.base

/** 15 秒网格上的一个点：路径扫描按 `OU_STEP_MS` 采样，触发点必然落在网格上。 */
function grid (at) {
  return Math.ceil(at / OU_STEP_MS) * OU_STEP_MS
}

/** 周二上午，落在当周合约的存活期内。 */
const T0 = grid(new Date(2026, 10, 17, 10, 0, 0, 0).getTime())
const T1 = T0 + OU_STEP_MS

/** 周五 20:00 到期那一刻。 */
const FRIDAY = new Date(2026, 10, 20, 20, 0, 0, 0).getTime()

function fairAt (contract, at) {
  return roundCoin(fairPriceOf({ indexPrice: INDEX, crop: 'tomato', contractId: contract.id, at }))
}

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-liquidation-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

/**
 * 一个仓位的最小合法形状。`openedAt` 默认取触发点前 1 秒：
 * 扫描从 `max(openedAt, 上一根收盘)` 起算，`ceil` 到 15 秒网格后第一个样本正好是触发点。
 */
function positionOf ({ id, contract, at, entry, lots = 1, leverage = 20, openedAt = at - 1000 }) {
  const slot = Math.floor(openedAt / SLOT_MS)
  return {
    id,
    crop: 'tomato',
    contract: contract.id,
    side: 'long',
    lots,
    entry,
    margin: marginOf({ lots, price: entry, leverage }),
    leverage,
    openedAt,
    slot,
    settleSlot: slot + 1
  }
}

/** 一整份 `futures.json`；`marginUsed` 由仓位现算，免得读盘时被判「修补」。 */
function fileState ({ positions = [], balance = 0, insurance = 0, shortfall = 0, fees, remotes = {}, seq = 0 } = {}) {
  return {
    version: FUTURES_VERSION,
    epoch: 'fixture-epoch',
    balance,
    marginUsed: roundCoin(positions.reduce((sum, position) => sum + position.margin, 0)),
    fees: fees ?? { insurance: 0, burned: 0 },
    insurance,
    shortfall,
    liquidationCount: 0,
    positions,
    trades: [],
    orders: [],
    week: { start: 0, pnl: 0 },
    closed: 0,
    tradedAt: 0,
    seq,
    remotes,
    delivered: {}
  }
}

async function makeStore (t, { at, ...fixture }) {
  const dir = await tempDir(t)
  await writeFile(join(dir, FUTURES_FILE), JSON.stringify(fileState(fixture)))
  const warnings = []
  const store = await createFuturesStore(dir, {
    farm: {
      async spendCoins (qty) { return { ok: true, qty } },
      async addCoins (qty) { return { ok: true, qty } }
    },
    now: () => at,
    indexOf: () => INDEX,
    log: { warn (line) { warnings.push(line) } }
  })
  return { dir, store, warnings }
}

/** 强平那一笔的「亏空」：垫不上的亏损 + 收不上来的费用（与 `#coverHole` 同一条口径）。 */
function holeOf ({ entry, price, lots, leverage }) {
  const margin = marginOf({ lots, price: entry, leverage })
  const pnl = pnlOf({ lots, entry, exit: price, side: 'long' })
  const fee = takerFeeOf(notionalOf({ lots, price }))
  const gross = roundCoin(margin + pnl)
  return roundCoin(Math.max(0, -gross) + Math.max(0, fee - Math.max(0, gross)))
}

/**
 * 找一个「建仓价 + 杠杆 + 手数」，让这一笔强平的亏空正好等于 `target`（币）。
 * 20× 下保证金被吃穿的点在 `price / (1 - 1/杠杆)` 附近，只需在这一小段里按分扫；
 * 用途：票面要求「亏空 3 币、基金 10 币 → 基金变 7」，需要精确的 3.00。
 */
function scenarioForHole (price, target) {
  for (const leverage of [20, 10, 3]) {
    for (const lots of [1, 2, 3]) {
      const base = price / (1 - 1 / leverage)
      for (let cents = Math.round(base * 100) - 60; cents <= Math.round(base * 100) + 60; cents += 1) {
        const entry = cents / 100
        if (holeOf({ entry, price, lots, leverage }) !== target) continue
        const margin = marginOf({ lots, price: entry, leverage })
        const pnl = pnlOf({ lots, entry, exit: price, side: 'long' })
        return { entry, lots, leverage, margin, pnl }
      }
    }
  }
  return null
}

test('20× 多单在 5.1% 逆行处被强平：触发价取扫描点公允价，余额不为负', async (t) => {
  const contract = contractOf('tomato', T0)
  const price = fairAt(contract, T0)
  // 建仓价高出触发点 5.1%：20× 下亏掉 102% 保证金，正好在保证金被吃穿的那一拍触发。
  const entry = roundCoin(price / 0.949)
  const margin = marginOf({ lots: 1, price: entry, leverage: 20 })
  const pnl = pnlOf({ lots: 1, entry, exit: price, side: 'long' })
  assert.ok(roundCoin(margin + pnl) <= 0, '构造的行情确实亏穿了保证金')
  assert.ok(Math.abs((price - entry) / entry + 0.051) < 0.001, '逆行幅度是 5.1%')

  const { dir, store } = await makeStore(t, {
    at: T0,
    balance: 100,
    insurance: 5,
    positions: [positionOf({ id: 'pos-20x', contract, at: T0, entry })]
  })

  const result = await store.settleDue(T0)
  assert.equal(result.ok, true)
  assert.equal(result.settled.length, 1)

  const [settled] = result.settled
  assert.equal(settled.liquidated, true)
  assert.equal(settled.position.id, 'pos-20x')
  // 触发价 = 触发点（15 秒采样点）的公允价，不是收盘价、不是交割价。
  assert.equal(settled.at, T0)
  assert.equal(settled.price, price)
  assert.equal(settled.pnl, pnl)

  const view = store.snapshot({ at: T0 })
  assert.equal(view.marginUsed, 0, '强平后保证金归零')
  assert.ok(view.balance >= 0, '余额永不为负')
  assert.equal(view.liquidationCount, 1)
  assert.equal(view.closed, 1)
  assert.deepEqual(view.positions, [])

  const [trade] = view.trades
  assert.equal(trade.kind, 'liquidation')
  assert.equal(trade.price, price, '流水里写的是强平触发价')
  assert.equal(trade.at, T0)
  assert.equal(trade.side, 'short', '多单的平仓腿是卖出')
  assert.equal(trade.fee, settled.fee)

  // 亏空 = margin + pnl - 实收费用 的绝对值；这单亏穿得比费用多，基金被扣掉整笔亏空。
  const hole = roundCoin(Math.max(0, -pnl - margin) + Math.max(0, takerFeeOf(notionalOf({ lots: 1, price }))))
  assert.equal(settled.hole, hole)
  assert.equal(view.insurance, roundCoin(5 - hole))
  assert.equal(view.shortfall, 0)

  // 落盘：基金余额、强平笔数、流水都要在文件里，重启不会把强平「忘掉」。
  const saved = JSON.parse(await readFile(join(dir, FUTURES_FILE), 'utf8'))
  assert.equal(saved.insurance, view.insurance)
  assert.equal(saved.liquidationCount, 1)
  assert.equal(saved.trades[0].kind, 'liquidation')
})

test('1× 没有强平线：价格腰斩只盯市，不清仓', async (t) => {
  const contract = contractOf('tomato', T0)
  const price = fairAt(contract, T0)
  const entry = roundCoin(price * 2)
  const { store } = await makeStore(t, {
    at: T0,
    balance: 1000,
    positions: [positionOf({ id: 'pos-1x', contract, at: T0, entry, leverage: 1 })]
  })

  const result = await store.settleDue(T0)
  assert.equal(result.settled.length, 1)
  assert.equal(result.settled[0].liquidated, false)

  const view = store.snapshot({ at: T0 })
  assert.equal(view.liquidationCount, 0)
  assert.equal(view.positionCount, 1, '仓位还在')
  assert.equal(view.trades.length, 0, '没有强平流水')
})

test('同一拍多个仓位：先按触发时刻，再按建仓时间，最后按 id 排序', async (t) => {
  const contract = contractOf('tomato', T0)
  const price1 = fairAt(contract, T0)
  const price2 = fairAt(contract, T1)
  const blowUp = (price) => roundCoin(price / 0.949)

  const positions = [
    // 晚一拍才触发。
    positionOf({ id: 'late', contract, at: T1, entry: blowUp(price2) }),
    // 同一拍（T0）触发，建仓更早的排在前面。
    positionOf({ id: 'zzz', contract, at: T0, entry: blowUp(price1), openedAt: T0 - 3000 }),
    // 同一拍、同一建仓时刻：按 id 字典序。
    positionOf({ id: 'mmm', contract, at: T0, entry: blowUp(price1) }),
    positionOf({ id: 'aaa', contract, at: T0, entry: blowUp(price1) })
  ]

  const { store } = await makeStore(t, { at: T1, insurance: 100, positions })
  const result = await store.settleDue(T1)

  assert.deepEqual(
    result.settled.map((entry) => entry.position.id),
    ['zzz', 'aaa', 'mmm', 'late']
  )
  assert.deepEqual(
    result.settled.map((entry) => entry.at),
    [T0, T0, T0, T1]
  )
  assert.equal(store.snapshot({ at: T1 }).liquidationCount, 4)
})

test('保险基金先垫亏空，垫不上才记欠账；余额永不为负', async (t) => {
  const contract = contractOf('tomato', T0)
  const price = fairAt(contract, T0)
  const found = scenarioForHole(price, 3)
  assert.ok(found, '能找到亏空正好 3.00 的建仓价')
  const { entry, lots, leverage, margin, pnl } = found
  assert.ok(roundCoin(margin + pnl) < 0, '这一笔确实亏穿')

  const position = positionOf({ id: 'pos-hole', contract, at: T0, entry, lots, leverage })

  // ① 基金 10：亏空 3 全由基金垫，欠账不动。
  const rich = await makeStore(t, { at: T0, balance: 40, insurance: 10, positions: [position] })
  await rich.store.settleDue(T0)
  const richView = rich.store.snapshot({ at: T0 })
  assert.equal(richView.insurance, 7)
  assert.equal(richView.shortfall, 0)
  assert.equal(richView.balance, 40, '亏空不进余额，余额不为负')
  assert.ok(richView.balance >= 0)

  // ② 基金 0：亏空全额记欠账，不向玩家追缴。
  const broke = await makeStore(t, { at: T0, balance: 40, insurance: 0, positions: [position] })
  await broke.store.settleDue(T0)
  const brokeView = broke.store.snapshot({ at: T0 })
  assert.equal(brokeView.insurance, 0)
  assert.equal(brokeView.shortfall, 3)
  assert.equal(brokeView.balance, 40)
  assert.ok(brokeView.balance >= 0)

  // ③ 基金 1：垫掉 1，剩下 2 记欠账。
  const half = await makeStore(t, { at: T0, balance: 40, insurance: 1, positions: [position] })
  await half.store.settleDue(T0)
  const halfView = half.store.snapshot({ at: T0 })
  assert.equal(halfView.insurance, 0)
  assert.equal(halfView.shortfall, 2)
})

test('每笔实收费用把 10% 注入保险基金', async (t) => {
  const dir = await tempDir(t)
  let now = T0
  const store = await createFuturesStore(dir, {
    farm: { async spendCoins (qty) { return { ok: true, qty } }, async addCoins (qty) { return { ok: true, qty } } },
    now: () => now,
    indexOf: () => INDEX,
    log: { warn () {} }
  })
  await store.deposit(1000)
  const opened = await store.open({ crop: 'tomato', side: 'long', margin: 100, leverage: 10, at: T0 })
  assert.equal(opened.ok, true)

  const split = feeSplitOf(opened.fee)
  const view = store.snapshot({ at: T0 })
  assert.ok(opened.fee > 0)
  assert.equal(view.insurance, split.insurance, '基金余额 = 这笔费用的 10%')
  assert.equal(view.fees.insurance, split.insurance, '累计注入同步增加')
  assert.equal(view.fees.burned, split.burned)
  assert.ok(view.insurance <= view.fees.insurance, '基金余额不会超过累计注入')

  // 再开一单：基金继续按 10% 累加。
  now = T0 + 1000
  const second = await store.open({ crop: 'tomato', side: 'short', margin: 100, leverage: 10, at: now })
  assert.equal(second.ok, true)
  const later = store.snapshot({ at: now })
  assert.equal(later.insurance, roundCoin(split.insurance + feeSplitOf(second.fee).insurance))
})

test('交割费收不上来时由保险基金兜底，基金不够再记欠账', async (t) => {
  const contract = contractOf('tomato', FRIDAY - 1000)
  const price = deliveryPriceOf({ crop: 'tomato', contractId: contract.id, indexOf: () => INDEX, at: FRIDAY })
  assert.ok(price > 0)

  // 建仓价高出交割价 5.15%：保证金只剩几毛，交割费（0.1% 名义）比它还多。
  const entry = roundCoin(price * 1.0515)
  const position = positionOf({ id: 'pos-expiry', contract, at: FRIDAY - 1000, entry })

  const funded = await makeStore(t, { at: FRIDAY, balance: 0, insurance: 10, positions: [position] })
  const result = await funded.store.expireDue(FRIDAY)
  assert.equal(result.ok, true)
  const view = funded.store.snapshot({ at: FRIDAY })
  const delivered = view.trades.find((trade) => trade.kind === 'delivery')
  assert.ok(delivered, '交割流水仍然照记')
  // 期望值全部从「实际成交记录」推：交割价可能与建仓时看到的公允价差几分。
  const fullFee = roundCoin(notionalOf({ lots: 1, price: delivered.price }) * DELIVERY_FEE_RATE)
  const gross = roundCoin(position.margin + pnlOf({ lots: 1, entry, exit: delivered.price, side: 'long' }))
  const credit = Math.max(0, gross)
  const hole = roundCoin(Math.max(0, -gross) + Math.max(0, fullFee - credit))
  assert.ok(credit > 0 && credit < fullFee, '释放出来的钱不够交交割费')
  assert.ok(hole > 0 && hole < 10)
  assert.equal(delivered.deliveryFee, credit, '流水只记真收到的费用')
  // 这笔实收的交割费同样按 10% 回注基金，所以基金余额是「垫掉亏空 + 回注」的净额。
  const refund = feeSplitOf(credit).insurance
  assert.equal(view.insurance, roundCoin(10 - hole + refund), '交割费缺口由基金补')
  assert.equal(view.shortfall, 0)
  assert.equal(view.balance, 0, '收不上来的费不从余额里再扣一次')

  const bare = await makeStore(t, { at: FRIDAY, balance: 0, insurance: 0, positions: [position] })
  await bare.store.expireDue(FRIDAY)
  const bareView = bare.store.snapshot({ at: FRIDAY })
  assert.equal(bareView.insurance, refund, '收上来的那部分费用仍按 10% 回注')
  assert.equal(bareView.shortfall, hole, '基金为 0 时缺口进欠账')
  assert.ok(bareView.balance >= 0)
})

test('同一时刻重复 tick 不重复强平', async (t) => {
  const contract = contractOf('tomato', T0)
  const price = fairAt(contract, T0)
  const entry = roundCoin(price / 0.949)
  const { store } = await makeStore(t, {
    at: T0,
    balance: 100,
    insurance: 5,
    positions: [positionOf({ id: 'once', contract, at: T0, entry })]
  })

  const first = await store.settleDue(T0)
  assert.equal(first.settled.length, 1)
  const afterFirst = store.snapshot({ at: T0 })

  const second = await store.settleDue(T0)
  assert.deepEqual(second.settled, [], '同一拍再跑没有可结算的仓位')
  const afterSecond = store.snapshot({ at: T0 })

  assert.equal(afterSecond.balance, afterFirst.balance)
  assert.equal(afterSecond.insurance, afterFirst.insurance)
  assert.equal(afterSecond.shortfall, afterFirst.shortfall)
  assert.equal(afterSecond.liquidationCount, 1, '强平笔数不翻倍')
  assert.equal(afterSecond.trades.length, 1, '流水不重复')
})

test('远端仓位也按同一条路径强平，亏空从同一个保险基金垫', async (t) => {
  const contract = contractOf('tomato', T0)
  const price = fairAt(contract, T0)
  const entry = roundCoin(price / 0.949)
  const remoteId = '11111111-1111-4111-8111-111111111111'
  const remotePosition = positionOf({ id: 'peer-pos', contract, at: T0, entry })
  const { store } = await makeStore(t, {
    at: T0,
    balance: 7,
    insurance: 5,
    // 房主的流水号是全局的：文件里已经发到 4，这一拍强平后应该是 5。
    seq: 4,
    remotes: {
      [remoteId]: {
        balance: 12,
        marginUsed: remotePosition.margin,
        positions: [remotePosition],
        orders: [],
        trades: [],
        lastSeq: 4,
        updatedAt: T0 - 1000
      }
    }
  })

  const result = await store.settleDue(T0)
  assert.equal(result.settled.length, 0, '本地没有仓位')
  assert.equal(result.remotes.length, 1)
  const [remote] = result.remotes
  assert.equal(remote.deviceId, remoteId)
  assert.equal(remote.seq, 5, '强平也要让这个 peer 的流水号 +1')
  assert.equal(remote.settled.length, 1)
  assert.equal(remote.settled[0].liquidated, true)
  assert.equal(remote.settled[0].price, price, '远端也按触发点公允价成交')
  assert.deepEqual(remote.account.positions, [])
  assert.equal(remote.account.marginUsed, 0)

  // 亏空只从房主的保险基金出：本地余额一分不动，欠账也不落到本地头上。
  const view = store.snapshot({ at: T0 })
  assert.equal(view.balance, 7, '本地余额不受远端强平影响')
  assert.equal(view.insurance, roundCoin(5 - remote.settled[0].hole))
  assert.equal(view.shortfall, 0)
  assert.equal(view.liquidationCount, 1)

  const peerTrades = remote.account.trades
  assert.equal(peerTrades[0].kind, 'liquidation')
  assert.equal(peerTrades[0].price, price)
  assert.equal(peerTrades[0].fee, remote.settled[0].fee)
})
