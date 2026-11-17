/**
 * 票 95：玩家挂单撮合（限价单、价格优先、每根成交）。
 *
 * 两层各管一半：规则层的 `sortBook`/`matchOrders` 只回答「同样的订单，任何机器算出同样的成交序列」；
 * 账本层的 `place`/`cancel`/`matchDue` 只回答「冻结、成交、退款这三笔钱有没有对上」。
 * 全部用真磁盘（tmpdir）和一只假农场，不起 service/网络——双机那半在 futures-net.test.js。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FUTURES_FILE, FUTURES_VERSION, createFuturesStore } from '../src/futures.js'
import {
  FUTURES_ORDER_KINDS,
  HOUR_MS,
  marginOf,
  matchOrders,
  notionalOf,
  roundCoin,
  sortBook,
  takerFeeOf
} from '../src/futures-rules.js'
import { FUTURES_ORDER_KINDS as PROTOCOL_ORDER_KINDS } from '../src/protocol.js'

const MONDAY = new Date(2026, 10, 16, 10, 0, 0, 0).getTime()
const AT = MONDAY + 3 * HOUR_MS

async function tempDir (t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-zoo-futures-book-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return dir
}

function logSink () {
  const warnings = []
  return { warnings, log: { warn (line) { warnings.push(line) } } }
}

/** 假农场：与 futures-store.test.js 同一只，`addCoins` 在上限处静默截断。 */
function fakeFarm (coins, { max = 1_000_000 } = {}) {
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
      state.coins = Math.min(max, before + qty)
      return { ok: true, qty: state.coins - before, coins: state.coins }
    }
  }
}

async function makeStore (t, { coins = 5000, at = AT } = {}) {
  const dir = await tempDir(t)
  const farm = fakeFarm(coins)
  let now = at
  const sink = logSink()
  const store = await createFuturesStore(dir, { farm, now: () => now, log: sink.log })
  return { dir, farm, store, sink, now: () => now, advance: (ms) => { now += ms } }
}

/** 规则层的一条挂单：只带排序/撮合真的会读的字段。 */
function row (overrides = {}) {
  return {
    id: 'o1',
    deviceId: 'local',
    crop: 'tomato',
    contract: 'tomato-2026W47',
    side: 'long',
    price: 5,
    lots: 1,
    lotsLeft: 1,
    leverage: 10,
    marginFrozen: 0.5,
    at: 1000,
    ...overrides
  }
}

function ids (orders) {
  return orders.map((order) => order.id)
}

// ── 规则层：排序与撮合 ───────────────────────────────────────────────────────

test('sortBook：买盘价高优先、卖盘价低优先，同价按时间再按 id', () => {
  const book = [
    row({ id: 'b-low', side: 'long', price: 4.98, at: 10 }),
    row({ id: 'b-high', side: 'long', price: 5.02, at: 20 }),
    row({ id: 'b-mid-late', side: 'long', price: 5.0, at: 30 }),
    row({ id: 'b-mid-early', side: 'long', price: 5.0, at: 20 }),
    row({ id: 'a-high', side: 'short', price: 5.1, at: 5 }),
    row({ id: 'a-low-b', side: 'short', price: 5.04, at: 8 }),
    row({ id: 'a-low-a', side: 'short', price: 5.04, at: 8 })
  ]
  const sorted = sortBook(book)
  assert.deepEqual(ids(sorted), [
    'b-high',
    'b-mid-early',
    'b-mid-late',
    'b-low',
    'a-low-a',
    'a-low-b',
    'a-high'
  ])
  // 买盘在前、卖盘在后：调用方不用再分一次。
  assert.deepEqual(sorted.map((order) => order.side), [
    'long', 'long', 'long', 'long', 'short', 'short', 'short'
  ])
})

test('sortBook：已经吃完的单、坏方向、坏价格都不进盘口', () => {
  const sorted = sortBook([
    row({ id: 'done', lotsLeft: 0 }),
    row({ id: 'bad-side', side: 'both' }),
    row({ id: 'bad-price', price: 0 }),
    row({ id: 'ok' })
  ])
  assert.deepEqual(ids(sorted), ['ok'])
})

test('matchOrders：固定一组订单得到可复现的成交序列（价格优先、同价时间优先）', () => {
  const book = [
    row({ id: 'bid-a', side: 'long', price: 5.1, lots: 2, lotsLeft: 2, at: 3000 }),
    row({ id: 'bid-b', side: 'long', price: 5.0, lots: 1, lotsLeft: 1, at: 1000 }),
    row({ id: 'ask-a', side: 'short', price: 5.0, lots: 3, lotsLeft: 3, at: 2000 }),
    row({ id: 'ask-b', side: 'short', price: 5.2, lots: 1, lotsLeft: 1, at: 500 })
  ]
  const due = matchOrders({ orders: book, contract: 'tomato-2026W47', at: AT })
  assert.deepEqual(due, [
    // 5.10 的买单先吃 5.00 的卖单；两张同为 5.00，问价方（ask-a, t=2000）比 bid-a（t=3000）早，所以它是 maker。
    { makerId: 'ask-a', takerId: 'bid-a', lots: 2, price: 5 },
    // bid-a 吃完，轮到 5.00 的 bid-b；这次 bid-b（t=1000）更早，maker 换边。
    { makerId: 'bid-b', takerId: 'ask-a', lots: 1, price: 5 }
  ])
  // 同一份输入重复算：序列一模一样（每台机器算出的必须是同一盘）。
  assert.deepEqual(matchOrders({ orders: book, contract: 'tomato-2026W47', at: AT }), due)
  // ask-b 卖 5.20 比所有买价都高，不成交。
  assert.equal(due.some((fill) => fill.makerId === 'ask-b' || fill.takerId === 'ask-b'), false)
})

test('matchOrders：成交价取 maker 的挂单价，不是对手价', () => {
  // 卖单先挂 5.00、买单后到 5.20：maker 是卖单，成交价 5.00。
  const askFirst = matchOrders({
    orders: [
      row({ id: 'ask', side: 'short', price: 5.0, at: 1000 }),
      row({ id: 'bid', side: 'long', price: 5.2, at: 2000 })
    ]
  })
  assert.deepEqual(askFirst, [{ makerId: 'ask', takerId: 'bid', lots: 1, price: 5 }])

  // 反过来：买单先挂 5.20、卖单后到 5.00，maker 是买单，成交价 5.20（买方占便宜）。
  const bidFirst = matchOrders({
    orders: [
      row({ id: 'bid', side: 'long', price: 5.2, at: 1000 }),
      row({ id: 'ask', side: 'short', price: 5.0, at: 2000 })
    ]
  })
  assert.deepEqual(bidFirst, [{ makerId: 'bid', takerId: 'ask', lots: 1, price: 5.2 }])
})

test('matchOrders：支持部分成交，maker 剩多少吃多少；未到时间的单不参与', () => {
  const book = [
    row({ id: 'bid', side: 'long', price: 5.1, lots: 5, lotsLeft: 5, at: 1000 }),
    row({ id: 'ask-early', side: 'short', price: 5.0, lots: 2, lotsLeft: 2, at: 900 }),
    row({ id: 'ask-late', side: 'short', price: 5.0, lots: 2, lotsLeft: 2, at: 5000 })
  ]
  const due = matchOrders({ orders: book, contract: 'tomato-2026W47', at: 2000 })
  // 只算 2000 之前挂出来的单；买单 5 张，第一笔吃满 2 张。
  assert.deepEqual(due, [{ makerId: 'ask-early', takerId: 'bid', lots: 2, price: 5 }])
})

test('FUTURES_ORDER_KINDS：规则层与协议层是同一份白名单，且包含 place 与 convert', () => {
  assert.deepEqual([...FUTURES_ORDER_KINDS], ['open', 'close', 'deposit', 'place', 'convert'])
  assert.deepEqual([...PROTOCOL_ORDER_KINDS], [...FUTURES_ORDER_KINDS])
})

// ── 账本层：冻结、成交、撤单 ─────────────────────────────────────────────────

test('place：下单即冻结保证金，余额与 marginUsed 同时变化，挂单落盘', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(1000)
  const quote = store.quoteOf('tomato', AT)
  const price = roundCoin(quote.bid - 0.5)
  const placed = await store.place({ crop: 'tomato', side: 'long', price, lots: 2, leverage: 10, at: AT })
  assert.equal(placed.ok, true)

  const frozen = marginOf({ lots: 2, price, leverage: 10 })
  assert.equal(placed.order.marginFrozen, frozen)
  assert.equal(placed.order.lots, 2)
  assert.equal(placed.order.lotsLeft, 2)
  assert.equal(placed.order.contract, quote.contract.id)
  assert.equal(placed.order.price, price)
  assert.equal(placed.balance, roundCoin(1000 - frozen), '保证金从可用余额划走')
  assert.equal(placed.marginUsed, frozen, '冻结的保证金算进占用')

  const view = store.snapshot({ at: AT })
  assert.equal(view.orders.length, 1)
  assert.equal(view.orderCount, 1)
  assert.equal(view.orders[0].id, placed.order.id)
  assert.equal(view.marginUsed, frozen)
})

test('place：余额不够、自成交、挂单条数上限都当场拒，且一分钱不动', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(1000)
  const quote = store.quoteOf('tomato', AT)
  const price = roundCoin(quote.bid - 0.5)

  const broke = await store.place({ crop: 'tomato', side: 'long', price, lots: 1000, leverage: 10, at: AT })
  assert.equal(broke.ok, false)
  assert.equal(broke.error, 'no-balance')
  assert.equal(store.snapshot({ at: AT }).balance, 1000)

  const buy = await store.place({ crop: 'tomato', side: 'long', price, lots: 1, leverage: 10, at: AT })
  assert.equal(buy.ok, true)
  // 新卖单的价格低于自己已挂的买价 → 会立刻和自己成交，必须拒。
  const self = await store.place({ crop: 'tomato', side: 'short', price, lots: 1, leverage: 10, at: AT })
  assert.equal(self.ok, false)
  assert.equal(self.error, 'self-trade')
  assert.equal(store.snapshot({ at: AT }).orders.length, 1)

  // 坏字段各自有自己的错误码，不落到 no-balance。
  assert.equal((await store.place({ crop: 'nope', side: 'long', price, lots: 1, leverage: 10, at: AT })).error, 'bad-crop')
  assert.equal((await store.place({ crop: 'tomato', side: 'both', price, lots: 1, leverage: 10, at: AT })).error, 'bad-side')
  assert.equal((await store.place({ crop: 'tomato', side: 'long', price: 0, lots: 1, leverage: 10, at: AT })).error, 'bad-price')
  assert.equal((await store.place({ crop: 'tomato', side: 'long', price, lots: 0, leverage: 10, at: AT })).error, 'bad-lots')
  assert.equal((await store.place({ crop: 'tomato', side: 'long', price, lots: 1, leverage: 7, at: AT })).error, 'bad-leverage')

  // 单账户最多 8 条：补到 8 条，第 9 条回 order-limit。
  for (let i = 1; i < 8; i += 1) {
    const resting = await store.place({
      crop: 'tomato',
      side: 'long',
      price: roundCoin(price - 0.01 * i),
      lots: 1,
      leverage: 10,
      at: AT
    })
    assert.equal(resting.ok, true)
  }
  const ninth = await store.place({ crop: 'tomato', side: 'long', price: roundCoin(price - 0.2), lots: 1, leverage: 10, at: AT })
  assert.equal(ninth.ok, false)
  assert.equal(ninth.error, 'order-limit')
})

test('cancel：只退剩余未成交部分的冻结保证金，别人的单回 not-yours', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(1000)
  const quote = store.quoteOf('tomato', AT)
  const price = roundCoin(quote.bid - 0.5)
  const placed = await store.place({ crop: 'tomato', side: 'long', price, lots: 2, leverage: 10, at: AT })
  const frozen = placed.order.marginFrozen

  // 远端账户挂一张同价卖单吃掉 1 张；成交后本地单只剩 1 张。
  const peer = randomUUID()
  assert.equal((await store.hostDeposit(peer, 1000, AT)).ok, true)
  const ask = await store.hostPlace(peer, { crop: 'tomato', side: 'short', price, lots: 1, leverage: 10, at: AT + 1000 })
  assert.equal(ask.ok, true)
  const matched = await store.matchDue(AT + 2000)
  assert.equal(matched.fills, 1)

  const left = store.snapshot({ at: AT + 2000 }).orders
  assert.equal(left.length, 1)
  assert.equal(left[0].lotsLeft, 1)
  assert.ok(left[0].marginFrozen > 0 && left[0].marginFrozen < frozen, '已成交那半不再冻结')
  assert.equal(matched.marginUsed, frozen, '仓位保证金 + 剩余冻结 = 原冻结额')

  // 别人的单不能撤。
  const wrong = await store.hostCancel(peer, { orderId: placed.order.id, at: AT + 3000 })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.error, 'not-yours')
  assert.equal((await store.cancel({ orderId: peer, at: AT + 3000 })).error, 'no-order')

  const cancelled = await store.cancel({ orderId: placed.order.id, at: AT + 3000 })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.released, left[0].marginFrozen)
  assert.equal(store.snapshot({ at: AT + 3000 }).orders.length, 0)
  assert.equal(store.snapshot({ at: AT + 3000 }).marginUsed, roundCoin(frozen - left[0].marginFrozen))
})

test('matchDue：买单价 ≥ ask 时整张被做市商吃掉，成交价仍取挂单价', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(1000)
  const quote = store.quoteOf('tomato', AT)
  const price = roundCoin(quote.ask + 0.05)
  const placed = await store.place({ crop: 'tomato', side: 'long', price, lots: 2, leverage: 10, at: AT })
  const frozen = placed.order.marginFrozen

  const matched = await store.matchDue(AT)
  assert.equal(matched.fills, 1)

  const view = store.snapshot({ at: AT })
  assert.equal(view.orders.length, 0, '成交完的单从盘口消失')
  assert.equal(view.positions.length, 1)
  assert.equal(view.positions[0].side, 'long')
  assert.equal(view.positions[0].lots, 2)
  assert.equal(view.positions[0].entry, price, '成交价是挂单价，不是 ask')
  assert.equal(view.positions[0].margin, frozen, '整张成交：冻结全部转成仓位保证金')

  const fee = takerFeeOf(notionalOf({ lots: 2, price }))
  assert.equal(view.balance, roundCoin(1000 - frozen - fee))
  assert.equal(view.marginUsed, frozen)
  assert.equal(roundCoin(view.fees.insurance + view.fees.burned), fee)

  const trade = view.trades[0]
  assert.equal(trade.kind, 'open')
  assert.equal(trade.orderId, placed.order.id)
  assert.equal(trade.price, price)
  assert.equal(trade.lots, 2)
})

test('matchDue：玩家对玩家成交——双方开仓、各付 0.1%，钱只在两人之间挪', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(1000)
  const peer = randomUUID()
  assert.equal((await store.hostDeposit(peer, 1000, AT)).ok, true)

  const quote = store.quoteOf('tomato', AT)
  const price = roundCoin(quote.bid - 0.5)
  const mine = await store.place({ crop: 'tomato', side: 'long', price, lots: 2, leverage: 10, at: AT })
  const theirs = await store.hostPlace(peer, { crop: 'tomato', side: 'short', price, lots: 2, leverage: 10, at: AT + 1000 })
  assert.equal(mine.ok, true)
  assert.equal(theirs.ok, true)

  const matched = await store.matchDue(AT + 2000)
  assert.equal(matched.fills, 1)
  assert.equal(matched.accounts.length, 1, '只有远端的账需要 +1 流水号')

  const view = store.snapshot({ at: AT + 2000 })
  assert.equal(view.orders.length, 0)
  assert.equal(view.positions.length, 1)
  assert.equal(view.positions[0].side, 'long')
  assert.equal(view.positions[0].entry, price)
  assert.equal(view.positions[0].lots, 2)
  assert.equal(view.positions[0].margin, mine.order.marginFrozen)

  const fee = takerFeeOf(notionalOf({ lots: 2, price }))
  assert.equal(view.balance, roundCoin(1000 - mine.order.marginFrozen - fee), '多头付钱拿仓 + 自己那腿手续费')
  assert.equal(roundCoin(view.fees.insurance + view.fees.burned), roundCoin(2 * fee), '两腿费用都记进账簿')

  const account = store.accountOf(peer, { at: AT + 2000 })
  assert.equal(account.positions.length, 1)
  assert.equal(account.positions[0].side, 'short')
  assert.equal(account.positions[0].entry, price)
  assert.equal(account.positions[0].lots, 2)
  assert.equal(account.positions[0].margin, theirs.order.marginFrozen)
  assert.equal(account.balance, roundCoin(1000 - theirs.order.marginFrozen - fee), '空头交仓收钱 + 自己那腿手续费')
  assert.equal(account.orders.length, 0)
  // 成交是零和的：两头都只少了各自那腿手续费。保证金只是从「可用」划进「占用」，
  // 仍是自己的钱（与票 92/94 的 `open`/`hostOpen` 同一口径），所以权益和才是守恒量。
  assert.equal(roundCoin((view.equity - 1000) + (account.equity - 1000)), roundCoin(-2 * fee))
})

test('matchDue：重复调用同一时刻不重复成交', async (t) => {
  const { store } = await makeStore(t)
  await store.deposit(1000)
  const quote = store.quoteOf('tomato', AT)
  const price = roundCoin(quote.ask + 0.05)
  await store.place({ crop: 'tomato', side: 'long', price, lots: 2, leverage: 10, at: AT })

  const first = await store.matchDue(AT)
  assert.equal(first.fills, 1)
  const afterFirst = store.snapshot({ at: AT })

  const second = await store.matchDue(AT)
  assert.equal(second.fills, 0)
  const third = await store.matchDue(AT)
  assert.equal(third.fills, 0)
  const afterThird = store.snapshot({ at: AT })
  assert.equal(afterThird.positions.length, afterFirst.positions.length)
  assert.equal(afterThird.balance, afterFirst.balance)
  assert.equal(afterThird.marginUsed, afterFirst.marginUsed)
  assert.equal(afterThird.trades.length, afterFirst.trades.length)
})

test('落盘重开：挂单还在、冻结还在；老文件没有 orders 也能读成空数组', async (t) => {
  const { dir, store, sink } = await makeStore(t)
  await store.deposit(1000)
  const quote = store.quoteOf('tomato', AT)
  const price = roundCoin(quote.bid - 0.5)
  const placed = await store.place({ crop: 'tomato', side: 'long', price, lots: 2, leverage: 10, at: AT })
  const frozen = placed.order.marginFrozen

  const reopened = await createFuturesStore(dir, {
    farm: fakeFarm(0),
    now: () => AT,
    log: sink.log
  })
  const view = reopened.snapshot({ at: AT })
  assert.equal(view.orders.length, 1)
  assert.equal(view.orders[0].id, placed.order.id)
  assert.equal(view.orders[0].lotsLeft, 2)
  assert.equal(view.orders[0].marginFrozen, frozen)
  assert.equal(view.marginUsed, frozen)
  assert.equal(view.balance, roundCoin(1000 - frozen))

  // 票 94 时期的老文件没有 `orders` 键：补空数组，不算修补、不告警。
  const legacyDir = await tempDir(t)
  await writeFile(join(legacyDir, FUTURES_FILE), JSON.stringify({
    version: FUTURES_VERSION,
    epoch: 'e1',
    balance: 10,
    marginUsed: 0,
    fees: { insurance: 0, burned: 0 },
    positions: [],
    trades: [],
    week: { start: 0, pnl: 0 },
    closed: 0,
    tradedAt: 0
  }) + '\n', 'utf8')
  const legacySink = logSink()
  const legacy = await createFuturesStore(legacyDir, { farm: fakeFarm(0), now: () => AT, log: legacySink.log })
  assert.deepEqual(legacy.snapshot({ at: AT }).orders, [])
  assert.equal(legacySink.warnings.length, 0)

  // 坏挂单记录整条丢，好的留着；盘上不写 `lotsLeft: 0` 的残单。
  const file = JSON.parse(await readFile(join(dir, FUTURES_FILE), 'utf8'))
  file.orders.push({ ...file.orders[0], id: 'bad', lotsLeft: 99 })
  await writeFile(join(dir, FUTURES_FILE), JSON.stringify(file) + '\n', 'utf8')
  const repairedSink = logSink()
  const again = await createFuturesStore(dir, { farm: fakeFarm(0), now: () => AT, log: repairedSink.log })
  assert.equal(again.snapshot({ at: AT }).orders.length, 1)
  assert.equal(repairedSink.warnings.length, 1)
})
