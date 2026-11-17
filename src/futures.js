/**
 * 期货账本（票 92）：`<dataDir>/futures.json` v1。
 *
 * 形状（SPEC v11「futures.json」的 **加法子集**，协议与撮合由票 94/95 补）：
 *   {
 *     "version": 1,
 *     "epoch": "…uuid…",                       // 每次启动换新；票 94 用它判「换了一本账」
 *     "balance": 120.5,                        // 托管账户可用余额（币，到分）
 *     "marginUsed": 100,                       // 冻结的保证金（币，到分）
 *     "fees": { "insurance": 0.12, "burned": 1.08 },
 *     "positions": [
 *       { "id": "…", "crop": "tomato", "contract": "tomato-2026W47", "side": "long",
 *         "lots": 2, "entry": 5.05, "margin": 101, "leverage": 10,
 *         "openedAt": 1763308800000, "slot": 1959232, "settleSlot": 1959233 }
 *     ],
 *     "trades": [                              // 成交记录，最新在前，硬截 50 条（票 93）
 *       { "at": 1763308800000, "crop": "tomato", "contract": "tomato-2026W47",
 *         "side": "long", "lots": 2, "price": 5.05, "fee": 1.01, "kind": "open" }
 *     ],
 *     "orders": [                              // 票 95：自己挂的限价单（未成交部分还冻结着保证金）
 *       { "id": "…", "deviceId": "local", "crop": "tomato", "contract": "tomato-2026W47",
 *         "side": "long", "price": 5.05, "lots": 2, "lotsLeft": 2, "leverage": 10,
 *         "marginFrozen": 10.1, "at": 1763308800000 }
 *     ],
 *     "week": { "start": 1763251200000, "pnl": 12.5 },  // 本周已实现盈亏（票 93 顶部展示）
 *     "closed": 0,                             // 平掉/交割的累计笔数（只用于展示）
 *     "tradedAt": 0,                           // 最后一笔动钱的时刻
 *     "seq": 7,                                // 票 94：账本流水号，每次「peer 必须看见」的变动 +1
 *     "remotes": {                             // 票 94：房主替别人托管的账户（key = deviceId）
 *       "…uuid…": { "balance": 100, "marginUsed": 40, "positions": [ … ], "orders": [ … ],
 *                   "lastSeq": 7, "updatedAt": 1763308800000 }
 *     }
 *   }
 *
 * 票 94 的分工：**房主是清算所**。别人的账户记在 `remotes` 里，价格、成交、余额全由
 * 本机算（peer 只能发「充值/开仓/平仓/挂单/撤单」这些指令，发不了价格）；`seq` 是这条账的
 * 单调流水号，peer 按 `(epoch, seq)` 判重、拒收倒退的包。`epoch` 每次启动换新，所以房主
 * 重启后 peer 的旧 `lastSeq` 一律作废、直接采纳新账本。
 *
 * 票 95 的挂单：下单即把 `marginFrozen` 从 `balance` 划进 `marginUsed`（钱没离开托管账户，
 * 只是从「可用」变成「冻结」）；成交时这笔冻结按成交张数比例转成仓位的 `margin`，手续费
 * 另从 `balance` 扣。撤单只退**剩余未成交**那部分。所以任何时刻都有
 * `marginUsed = Σ 仓位保证金 + Σ 挂单冻结保证金`，`balance + marginUsed` 才是总权益。
 *
 * peer 侧的副本（`replica`）**不落盘**：它只是房主账本的缓存，重启后 30 秒内就会重新同步，
 * 写盘只会多一份可能过期的副本。
 *
 * 四条产品规则决定这里的形状：
 *   - **钱先进托管账户**：充值是 `farm.spendCoins`，提现是 `farm.addCoins`；托管余额与
 *     农场硬币物理隔离，`/state` 里的「总权益 = balance + marginUsed」才是玩家的钱。
 *   - **张数由名义价值决定**：`lots = floor(保证金 × 杠杆 ÷ (成交价 × 100))`，至少一张；
 *     这也是为什么手填 1 币保证金也能开——它买的是最小的一张合约，不是「1 币名义」。
 *   - **每根收盘盯市一次，靠仓位自己记结算时点**：每个仓位带 `settleSlot`（下一根结算的
 *     根号），结算时把浮盈亏记进余额、入场价改成收盘价、仓位继续持有——所以重启、补算、
 *     快进时钟都不会重复入账，也不需要额外的「结算到第几根」游标。
 *   - **手续费拆到分**：`fees.insurance + fees.burned` 永远等于收过的 taker 费之和。
 *
 * 容错与 `src/farm.js` / `src/market.js` / `src/trading.js` 同一套路：
 *   - 文件不存在：空账本，不告警；
 *   - 文件损坏/形状不对：空账本 + 每个原因只告警一次，**不写回**（下次动钱才覆盖）；
 *   - 坏仓位只丢自己，整份坏才归零；
 *   - 写盘串行 + tmp/rename；写失败只告警一次（本次运行内存里照常）。
 *
 * 账本**绝不能**放进 `gifts/`（那里的配额清理会按最旧删目录）。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CROP_IDS, CROPS, isCropId } from './farm-rules.js'
import { MAX_COINS, MAX_STACK } from './farm.js'
import { parseJsonText } from './json-text.js'
// 票 94：远端账户的键就是协议里的 deviceId，形状校验只认那一份真相（protocol 不 import 本文件）。
import { isDeviceId, FUTURES_MAX_POSITIONS, FUTURES_MAX_ORDERS } from './protocol.js'
import {
  DAY_MS,
  DELIVERY_FEE_RATE,
  HOUR_MS,
  SLOT_MS,
  contractOf,
  contractWindowOf,
  deliveryClosesOf,
  deliveryPriceOf,
  fairPriceOf,
  feeSplitOf,
  fillPriceOf,
  isFuturesLeverage,
  isFuturesSide,
  isMarginAmount,
  LOT_SIZE,
  lotsFor,
  marginOf,
  matchOrders,
  MAX_MARGIN,
  notionalOf,
  pnlOf,
  quotesOf,
  roundCoin,
  sortBook,
  startOfWeek,
  takerFeeOf
} from './futures-rules.js'

export const FUTURES_FILE = 'futures.json'
export const FUTURES_VERSION = 1
/** `/state` 最多带 20 个仓位；账本本身不设上限（一周最多几十手）。 */
export const FUTURES_VIEW_POSITIONS = 20
/** 盘上最多留 50 条成交；`/state` 与窗口只带最近 20 条（票 93 的「成交记录」）。 */
export const FUTURES_TRADE_LIMIT = 50
export const FUTURES_VIEW_TRADES = 20

const MAX_ID_LENGTH = 64
const MAX_QUANTITY = 1_000_000
/** 本地挂单的 deviceId 占位：真正的设备号只出现在 `remotes` 的键上。 */
export const LOCAL_ORDER_DEVICE = 'local'

function finiteNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function positiveInt (value, max = Number.MAX_SAFE_INTEGER) {
  const num = finiteNumber(value)
  if (num === null || num <= 0) return null
  return Math.min(max, Math.floor(num))
}

function nonNegativeCoin (value) {
  const num = finiteNumber(value)
  if (num === null || num < 0) return null
  return roundCoin(num)
}

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}

/** 空账本；`epoch` 留空到第一次落盘再生，免得读盘失败也写一个新身份。 */
export function initialFuturesState () {
  return {
    epoch: '',
    balance: 0,
    marginUsed: 0,
    fees: { insurance: 0, burned: 0 },
    positions: [],
    trades: [],
    orders: [],
    week: { start: 0, pnl: 0 },
    closed: 0,
    tradedAt: 0,
    // 票 94：房主替 peer 托管的账户、账本流水号，以及 peer 侧的只读副本（副本不落盘）。
    seq: 0,
    remotes: {},
    replica: null,
    // 票 96：已交割的合约（contractId → 交割时刻），以及保证金亏穿的累计缺口。
    // 缺口先记账，票 97 的保险基金兜底再决定从哪补。
    delivered: {},
    shortfall: 0
  }
}

/** 一个远端账户的空壳（房主第一次见到某个 deviceId 时用）。 */
function initialRemoteAccount (seq = 0, at = 0) {
  return { balance: 0, marginUsed: 0, positions: [], orders: [], trades: [], lastSeq: seq, updatedAt: at }
}

/**
 * 启动早期（store 还没读出来）也要有完整形状，不能给 undefined；
 * 与 `initialMarketView` / `initialTradingView` 同一约定。
 */
export function initialFuturesView () {
  return {
    epoch: '',
    balance: 0,
    marginUsed: 0,
    equity: 0,
    fees: { insurance: 0, burned: 0 },
    closed: 0,
    positionCount: 0,
    positions: [],
    trades: [],
    orders: [],
    orderCount: 0,
    week: { start: 0, pnl: 0 },
    quotes: {},
    // 票 96：到期日窗口与本周所处的交易阶段；还没读盘时先按「交易中」占位。
    delivery: null,
    session: { kind: 'trading', text: '交易中' }
  }
}

function normalizePosition (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' && raw.id !== '' && raw.id.length <= MAX_ID_LENGTH ? raw.id : null
  const crop = isCropId(raw.crop) ? raw.crop : null
  const contract = contractWindowOf(raw.contract)
  const side = isFuturesSide(raw.side) ? raw.side : null
  const lots = positiveInt(raw.lots, MAX_QUANTITY)
  const entry = finiteNumber(raw.entry)
  const margin = nonNegativeCoin(raw.margin)
  const leverage = isFuturesLeverage(raw.leverage) ? raw.leverage : null
  const openedAt = finiteNumber(raw.openedAt)
  const slot = finiteNumber(raw.slot)
  const settleSlot = finiteNumber(raw.settleSlot)
  if (id === null || crop === null || contract === null || side === null) return null
  if (lots === null || entry === null || entry <= 0 || margin === null || leverage === null) return null
  if (openedAt === null || openedAt <= 0 || slot === null || settleSlot === null) return null
  return { id, crop, contract: contract.id, side, lots, entry, margin, leverage, openedAt, slot, settleSlot }
}

/** 一条成交记录：坏记录整条丢掉，不修补（它只是展示用的流水）。 */
function normalizeTrade (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const at = finiteNumber(raw.at)
  const crop = isCropId(raw.crop) ? raw.crop : null
  const contract = contractWindowOf(raw.contract)
  const side = isFuturesSide(raw.side) ? raw.side : null
  const lots = positiveInt(raw.lots, MAX_QUANTITY)
  const price = finiteNumber(raw.price)
  const fee = nonNegativeCoin(raw.fee)
  const kind = raw.kind === 'close'
    ? 'close'
    : raw.kind === 'open'
      ? 'open'
      : raw.kind === 'delivery'
        ? 'delivery'
        : raw.kind === 'convert'
          ? 'convert'
          : null
  if (at === null || at <= 0 || crop === null || contract === null || side === null) return null
  if (lots === null || price === null || price <= 0 || fee === null || kind === null) return null
  const trade = { at, crop, contract: contract.id, side, lots, price, fee, kind }
  if (kind === 'delivery') {
    const deliveryFee = nonNegativeCoin(raw.deliveryFee)
    if (deliveryFee === null) return null
    trade.deliveryFee = deliveryFee
  }
  return trade
}

/**
 * 一条挂单（票 95）。`marginFrozen` 只记**剩余未成交**部分的冻结保证金：
 * 每笔成交按比例扣掉一份，撤单把剩下的退回去，所以它永远等于「还压着的钱」。
 */
function normalizeOrder (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' && raw.id !== '' && raw.id.length <= MAX_ID_LENGTH ? raw.id : null
  const deviceId = typeof raw.deviceId === 'string' && raw.deviceId !== '' && raw.deviceId.length <= MAX_ID_LENGTH
    ? raw.deviceId
    : null
  const crop = isCropId(raw.crop) ? raw.crop : null
  const contract = contractWindowOf(raw.contract)
  const side = isFuturesSide(raw.side) ? raw.side : null
  const price = finiteNumber(raw.price)
  const lots = positiveInt(raw.lots, MAX_QUANTITY)
  const lotsLeft = positiveInt(raw.lotsLeft, MAX_QUANTITY)
  const leverage = isFuturesLeverage(raw.leverage) ? raw.leverage : null
  const marginFrozen = nonNegativeCoin(raw.marginFrozen)
  const at = finiteNumber(raw.at)
  if (id === null || deviceId === null || crop === null || contract === null || side === null) return null
  if (price === null || price <= 0 || lots === null || lotsLeft === null || lotsLeft > lots) return null
  if (leverage === null || marginFrozen === null || marginFrozen <= 0) return null
  if (at === null || at <= 0) return null
  return {
    id,
    deviceId,
    crop,
    contract: contract.id,
    side,
    price: roundCoin(price),
    lots,
    lotsLeft,
    leverage,
    marginFrozen,
    at
  }
}

/**
 * 一个远端账户（票 94）：房主替 peer 记的账。位置形状与本地仓位一致（也要能逐根盯市）。
 * 坏账户整条丢掉——留着半份账户比没有更危险（少一条持仓，看起来就像已经平掉了）。
 */
function normalizeRemoteAccount (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const balance = nonNegativeCoin(raw.balance)
  const marginUsed = nonNegativeCoin(raw.marginUsed)
  if (balance === null || marginUsed === null) return null
  if (raw.lastSeq !== undefined && !(Number.isInteger(raw.lastSeq) && raw.lastSeq >= 0)) return null
  const lastSeq = raw.lastSeq === undefined ? 0 : raw.lastSeq
  if (raw.updatedAt !== undefined && !(finiteNumber(raw.updatedAt) >= 0)) return null
  const updatedAt = raw.updatedAt === undefined ? 0 : finiteNumber(raw.updatedAt)
  const positions = []
  if (raw.positions !== undefined) {
    if (!Array.isArray(raw.positions)) return null
    const seen = new Set()
    for (const entry of raw.positions) {
      const position = normalizePosition(entry)
      if (position === null || seen.has(position.id)) return null
      seen.add(position.id)
      positions.push(position)
    }
  }
  const orders = []
  if (raw.orders !== undefined) {
    if (!Array.isArray(raw.orders)) return null
    const seen = new Set()
    for (const entry of raw.orders) {
      const order = normalizeOrder(entry)
      if (order === null || seen.has(order.id)) return null
      seen.add(order.id)
      orders.push(order)
    }
  }
  // 保证金一律以「仓位 + 挂单冻结」为准（与本地账本同一取舍）：删仓位/撤单之后不会留下凭空冻结的钱。
  const margin = positions.reduce((sum, position) => sum + position.margin, 0) +
    orders.reduce((sum, order) => sum + order.marginFrozen, 0)
  // 票 96：远端成交流水（peer 窗口的「成交记录」靠它同步）；坏记录只丢自己。
  const trades = []
  if (raw.trades !== undefined) {
    if (!Array.isArray(raw.trades)) return null
    for (const entry of raw.trades) {
      const trade = normalizeTrade(entry)
      if (trade === null) continue
      if (trades.length >= FUTURES_TRADE_LIMIT) break
      trades.push(trade)
    }
  }
  return { balance, marginUsed: roundCoin(margin), positions, orders, trades, lastSeq, updatedAt }
}

/**
 * 副本（peer 侧）里的一条持仓：线上形状——**没有** openedAt/slot/settleSlot。
 * 那三个是房主本地的结算游标，peer 不需要也不该猜（猜错就会算错下一根）。
 */
function normalizeReplicaPosition (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' && raw.id !== '' && raw.id.length <= MAX_ID_LENGTH ? raw.id : null
  const crop = isCropId(raw.crop) ? raw.crop : null
  const contract = contractWindowOf(raw.contract)
  const side = isFuturesSide(raw.side) ? raw.side : null
  const lots = positiveInt(raw.lots, MAX_QUANTITY)
  const entry = finiteNumber(raw.entry)
  const margin = nonNegativeCoin(raw.margin)
  const leverage = isFuturesLeverage(raw.leverage) ? raw.leverage : null
  if (id === null || crop === null || contract === null || side === null) return null
  if (lots === null || entry === null || entry <= 0 || margin === null || leverage === null) return null
  return { id, crop, contract: contract.id, side, lots, entry, margin, leverage }
}

/** 副本（peer 侧）里的一条挂单：线上形状，`lotsLeft` 是剩余未成交张数。 */
function normalizeReplicaOrder (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' && raw.id !== '' && raw.id.length <= MAX_ID_LENGTH ? raw.id : null
  const crop = isCropId(raw.crop) ? raw.crop : null
  const contract = contractWindowOf(raw.contract)
  const side = isFuturesSide(raw.side) ? raw.side : null
  const price = finiteNumber(raw.price)
  const lotsLeft = positiveInt(raw.lotsLeft, MAX_QUANTITY)
  const leverage = isFuturesLeverage(raw.leverage) ? raw.leverage : null
  const marginFrozen = nonNegativeCoin(raw.marginFrozen)
  const at = finiteNumber(raw.at)
  if (id === null || crop === null || contract === null || side === null) return null
  if (price === null || price <= 0 || lotsLeft === null || leverage === null) return null
  if (marginFrozen === null || marginFrozen < 0) return null
  if (at === null || at <= 0) return null
  return {
    id,
    crop,
    contract: contract.id,
    side,
    price: roundCoin(price),
    lots: lotsLeft,
    lotsLeft,
    leverage,
    marginFrozen,
    at
  }
}

/**
 * 把盘上的任意东西整理成一份能用的账本。坏仓位只丢自己；整份不是对象才是 `corrupt`。
 * `repaired` 是「有多少处被修补/丢弃」，调用方据此决定要不要告警。
 */
export function normalizeFuturesFile (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { futures: initialFuturesState(), corrupt: true, repaired: 0 }
  }
  const state = initialFuturesState()
  let repaired = 0

  if (typeof value.epoch === 'string' && value.epoch !== '' && value.epoch.length <= MAX_ID_LENGTH) {
    state.epoch = value.epoch
  }
  const balance = nonNegativeCoin(value.balance)
  if (balance === null) repaired += 1
  else state.balance = balance

  const marginUsed = nonNegativeCoin(value.marginUsed)
  if (marginUsed === null) repaired += 1
  else state.marginUsed = marginUsed

  if (value.fees !== null && typeof value.fees === 'object' && !Array.isArray(value.fees)) {
    const insurance = nonNegativeCoin(value.fees.insurance)
    const burned = nonNegativeCoin(value.fees.burned)
    if (insurance === null || burned === null) repaired += 1
    else state.fees = { insurance, burned }
  } else if (value.fees !== undefined) {
    repaired += 1
  }

  // `closed` 从 0 起步，0 是合法值（`positiveInt` 会把 0 判成坏值，所以这里单独判）。
  const closed = value.closed === undefined
    ? 0
    : Number.isInteger(value.closed) && value.closed >= 0 ? value.closed : null
  if (closed === null) repaired += 1
  else state.closed = closed

  const tradedAt = value.tradedAt === undefined ? 0 : finiteNumber(value.tradedAt)
  if (tradedAt === null || tradedAt < 0) repaired += 1
  else state.tradedAt = tradedAt

  // 成交流水只是展示：坏记录逐条丢，不影响账。
  if (Array.isArray(value.trades)) {
    for (const raw of value.trades) {
      const trade = normalizeTrade(raw)
      if (trade === null) {
        repaired += 1
        continue
      }
      if (state.trades.length >= FUTURES_TRADE_LIMIT) break
      state.trades.push(trade)
    }
  } else if (value.trades !== undefined) {
    repaired += 1
  }

  // 本周盈亏（票 93）：`start` 是那一周的周一 00:00，`pnl` 可正可负。
  if (value.week !== null && typeof value.week === 'object' && !Array.isArray(value.week)) {
    const start = finiteNumber(value.week.start)
    const pnl = finiteNumber(value.week.pnl)
    if (start === null || start < 0 || pnl === null) repaired += 1
    else state.week = { start, pnl: roundCoin(pnl) }
  } else if (value.week !== undefined) {
    repaired += 1
  }

  // 票 94：账本流水号与远端账户。老文件没有这两个键，按空值处理（不算修补）。
  if (value.seq !== undefined) {
    if (!Number.isInteger(value.seq) || value.seq < 0) repaired += 1
    else state.seq = value.seq
  }

  if (value.remotes !== undefined) {
    if (value.remotes === null || typeof value.remotes !== 'object' || Array.isArray(value.remotes)) {
      repaired += 1
    } else {
      for (const [deviceId, entry] of Object.entries(value.remotes)) {
        if (!isDeviceId(deviceId)) {
          repaired += 1
          continue
        }
        const account = normalizeRemoteAccount(entry)
        if (account === null) {
          repaired += 1
          continue
        }
        const key = deviceId.toLowerCase()
        // 挂单的归属以账户键为准：文件里手改的 deviceId 不认。
        for (const order of account.orders) order.deviceId = key
        state.remotes[key] = account
      }
    }
  }

  if (value.positions !== undefined) {
    if (!Array.isArray(value.positions)) {
      repaired += 1
    } else {
      const seen = new Set()
      for (const raw of value.positions) {
        const position = normalizePosition(raw)
        if (position === null || seen.has(position.id)) {
          repaired += 1
          continue
        }
        seen.add(position.id)
        state.positions.push(position)
      }
    }
  }

  // 票 95：挂单。老文件没有这个键（空数组，不算修补）；坏记录整条丢。
  if (value.orders !== undefined) {
    if (!Array.isArray(value.orders)) {
      repaired += 1
    } else {
      const seen = new Set()
      for (const raw of value.orders) {
        const order = normalizeOrder(raw)
        if (order === null || seen.has(order.id)) {
          repaired += 1
          continue
        }
        seen.add(order.id)
        state.orders.push({ ...order, deviceId: LOCAL_ORDER_DEVICE })
      }
    }
  }

  // 票 96：已交割合约与保证金缺口。老文件没有这两个键，按空值处理（不算修补）。
  if (value.delivered !== undefined) {
    if (value.delivered === null || typeof value.delivered !== 'object' || Array.isArray(value.delivered)) {
      repaired += 1
    } else {
      for (const [contractId, rawAt] of Object.entries(value.delivered)) {
        const window = contractWindowOf(contractId)
        const at = finiteNumber(rawAt)
        if (window === null || at === null || at <= 0) {
          repaired += 1
          continue
        }
        state.delivered[window.id] = at
      }
    }
  }

  const shortfall = value.shortfall === undefined ? 0 : nonNegativeCoin(value.shortfall)
  if (shortfall === null) repaired += 1
  else state.shortfall = shortfall

  // 保证金是「从余额划走的钱」：仓位/挂单丢了、保证金还在，账会凭空多钱或少钱。
  // 仓位 + 挂单冻结的总额才是真相，marginUsed 以它为准（与 farm 的坏账处理同一取舍）。
  const expectedMargin = roundCoin(
    state.positions.reduce((sum, position) => sum + position.margin, 0) +
    state.orders.reduce((sum, order) => sum + order.marginFrozen, 0)
  )
  if (expectedMargin !== state.marginUsed) {
    state.marginUsed = expectedMargin
    repaired += 1
  }

  return { futures: state, corrupt: false, repaired }
}

function toFileState (state) {
  return {
    version: FUTURES_VERSION,
    epoch: state.epoch,
    balance: roundCoin(state.balance),
    marginUsed: roundCoin(state.marginUsed),
    fees: { insurance: roundCoin(state.fees.insurance), burned: roundCoin(state.fees.burned) },
    positions: state.positions.map((position) => ({ ...position })),
    trades: state.trades.map((trade) => ({ ...trade })),
    // 票 95：挂单（`marginFrozen` 只覆盖剩余未成交部分）。
    orders: state.orders.map((order) => ({ ...order })),
    week: { start: state.week.start, pnl: roundCoin(state.week.pnl) },
    closed: state.closed,
    tradedAt: state.tradedAt,
    // 票 94：流水号与替别人托管的账户（`replica` 不落盘，见文件头）。
    seq: state.seq,
    remotes: remoteFileState(state.remotes),
    // 票 96：交割标记与累计缺口（缺口是「亏穿保证金的钱」，负余额不允许出现）。
    delivered: { ...state.delivered },
    shortfall: roundCoin(state.shortfall)
  }
}

function remoteFileState (remotes) {
  const out = {}
  for (const [deviceId, account] of Object.entries(remotes)) {
    out[deviceId] = {
      balance: roundCoin(account.balance),
      marginUsed: roundCoin(account.marginUsed),
      positions: account.positions.map((position) => ({ ...position })),
      orders: account.orders.map((order) => ({ ...order })),
      trades: (account.trades ?? []).map((trade) => ({ ...trade })),
      lastSeq: account.lastSeq,
      updatedAt: account.updatedAt
    }
  }
  return out
}

/**
 * 打开（或创建）期货账本。读盘失败不抛：调用方拿到的是一份空账本，只留一条警告。
 * `farm` 是必须的（充提都要动农场硬币）；`indexOf(crop)` 提供现货指数，单机就是交易所价。
 */
export async function createFuturesStore (dir, { log, farm, now = Date.now, indexOf = null } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('futures: missing data directory')
  if (farm === null || typeof farm !== 'object') throw new Error('futures: missing farm store')
  const store = new FuturesStore({ dir, log, farm, now, indexOf })
  await store.load()
  return store
}

class FuturesStore {
  #dir
  #log
  #farm
  #now
  #indexOf
  #state = initialFuturesState()
  #warned = new Set()
  #writeChain = Promise.resolve()
  /** 行情每 15 秒才变一次：同一个 tick 里连续读快照不用重算 960 步偏离。 */
  #quoteCache = new Map()

  constructor ({ dir, log, farm, now, indexOf }) {
    this.#dir = dir
    this.#log = log
    this.#farm = farm
    const clock = typeof now === 'function' ? now : () => now
    this.#now = () => {
      const stamp = Number(clock())
      return Number.isFinite(stamp) ? stamp : Date.now()
    }
    this.#indexOf = typeof indexOf === 'function' ? indexOf : defaultIndexOf
  }

  async load () {
    let text
    try {
      text = await readFile(join(this.#dir, FUTURES_FILE), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warnOnce('read', '期货账本读不出来，先按空市场运行（' + errorName(error) + '）')
      }
      this.#state = initialFuturesState()
      // 票 94：epoch 必须在启动时就存在——房主拿它给 peer 标记「这是哪一本账」，
      // 空字符串会被 `futures-settle` 直接拒掉。读盘失败也换新：旧账本反正读不出来了。
      this.#state.epoch = randomUUID()
      return
    }

    let raw
    try {
      raw = parseJsonText(text)
    } catch {
      this.#warnOnce('parse', '期货账本不是合法 JSON，先按空市场运行')
      this.#state = initialFuturesState()
      this.#state.epoch = randomUUID()
      return
    }

    const normalized = normalizeFuturesFile(raw)
    this.#state = normalized.futures
    if (normalized.corrupt) {
      this.#warnOnce('shape', '期货账本形状不对，先按空市场运行')
    } else if (normalized.repaired > 0) {
      this.#warnOnce('entries', '期货账本有 ' + normalized.repaired + ' 处格式不对，已按默认值修补')
    }
    // 不落盘：坏文件留在盘上等下一次动钱覆盖，读的时候不自作主张改写用户的账。
    // epoch 每次启动换新（SPEC v11）：它是「这一本账」的身份，票 94 用它判 peer 的状态过期了。
    this.#state.epoch = randomUUID()
  }

  #nowMs () {
    return this.#now()
  }

  #slotOf (at) {
    const stamp = Number(at)
    return Number.isFinite(stamp) ? Math.floor(stamp / SLOT_MS) : Math.floor(this.#nowMs() / SLOT_MS)
  }

  /** 某一刻的合约与报价；休市（周末）返回 null。 */
  quoteOf (crop, at = this.#nowMs()) {
    if (!isCropId(crop)) return null
    const contract = contractOf(crop, at)
    if (contract === null) return null
    const index = this.#indexOf(crop)
    const fair = fairPriceOf({ indexPrice: index, crop, contractId: contract.id, at })
    if (fair === null) return null
    const quotes = quotesOf(fair)
    if (quotes === null) return null
    return { contract, fair, ...quotes }
  }

  /** 只读快照：调用方随便改返回值，改不到账本。 */
  snapshot ({ at = this.#nowMs(), crop = null, positionLimit = FUTURES_VIEW_POSITIONS, tradeLimit = FUTURES_VIEW_TRADES } = {}) {
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const focus = isCropId(crop) ? crop : CROP_IDS[0]
    const quotes = {}
    for (const cropId of CROP_IDS) {
      const quote = this.quoteOf(cropId, stamp)
      if (quote !== null) quotes[cropId] = quote
    }
    const positions = this.#state.positions.slice(0, positionLimit).map((position) => ({
      ...position,
      quote: this.quoteOf(position.crop, stamp),
      unrealized: this.#unrealizedOf(position, stamp)
    }))
    return {
      epoch: this.#state.epoch,
      balance: roundCoin(this.#state.balance),
      marginUsed: roundCoin(this.#state.marginUsed),
      equity: roundCoin(this.#state.balance + this.#state.marginUsed),
      fees: { ...this.#state.fees },
      closed: this.#state.closed,
      positionCount: this.#state.positions.length,
      positions,
      trades: this.#state.trades.slice(0, Math.max(0, Number(tradeLimit) || 0)).map((trade) => ({ ...trade })),
      // 票 95：自己的挂单（窗口画「我的挂单」，撮合后 lotsLeft 会变）。
      orders: this.#state.orders.map((order) => ({ ...order })),
      orderCount: this.#state.orders.length,
      week: { start: this.#weekStartOf(stamp), pnl: this.#weekPnl(stamp) },
      quotes,
      // 票 96：到期日窗口 + 当前阶段。`crop` 只影响这两块，行情仍是全目录。
      delivery: this.#deliveryOf(focus, stamp),
      session: this.#sessionOf(focus, stamp),
      now: stamp
    }
  }

  /**
   * 票 96：到期日（周五）的交割窗口。19:15/19:30/19:45/20:00 四根收盘价从
   * `deliveryClosesOf` 来，交割价与窗口复核共用同一组到分数值。
   * 20:00 之后 `contractOf` 已返回 null，这里用「到期前一毫秒」把本周合约取回来。
   */
  #deliveryOf (crop, stamp) {
    if (new Date(stamp).getDay() !== 5) return null
    let window = contractOf(crop, stamp)
    if (window === null) {
      const monday = startOfWeek(stamp)
      window = contractOf(crop, monday + 4 * DAY_MS + 20 * HOUR_MS - 1)
    }
    if (window === null) return null
    const closes = deliveryClosesOf({
      crop,
      contractId: window.id,
      indexOf: (cropId) => this.#indexOf(cropId),
      at: stamp
    })
    return {
      contract: window.id,
      closes,
      // 窗口展示的价格必须等于上面四根的均价，不能再用一次 indexOf 重算（指数可能在这一瞬跳动）。
      price: closes === null
        ? null
        : roundCoin(closes.reduce((sum, value) => sum + value, 0) / closes.length),
      at: window.expireAt
    }
  }

  /** 票 96：交易中 / 已到期 / 周末三态；文案由账本层统一给，窗口不自己拼。 */
  #sessionOf (crop, stamp) {
    const contract = contractOf(crop, stamp)
    if (contract !== null) {
      return { kind: 'trading', text: contract.id + ' 交易中，周五 20:00 到期。' }
    }
    const day = new Date(stamp).getDay()
    if (day === 5) {
      return { kind: 'expired', text: '合约已到期，本周合约已交割，下周一 00:00 开新合约。' }
    }
    return { kind: 'weekend', text: '周末休市，本周合约已交割，下周一 00:00 开新合约。' }
  }

  #unrealizedOf (position, at) {
    const quote = this.quoteOf(position.crop, at)
    if (quote === null) return 0
    const exit = position.side === 'long' ? quote.bid : quote.ask
    return pnlOf({ lots: position.lots, entry: position.entry, exit, side: position.side })
  }

  /** 充值：农场扣 coins、托管余额加同样的数。 */
  async deposit (rawCoins) {
    const coins = positiveInt(rawCoins, MAX_COINS)
    if (coins === null) return { ok: false, error: 'bad-amount' }
    const spent = await this.#farm.spendCoins(coins)
    if (spent === null || spent.ok !== true) {
      return { ok: false, error: spent?.error === 'no-coin' ? 'no-coin' : 'farm-refused' }
    }
    this.#state.balance = roundCoin(this.#state.balance + spent.qty)
    this.#state.tradedAt = this.#nowMs()
    const persisted = await this.#persist()
    return { ok: true, action: 'futures-deposit', coins: spent.qty, ...this.#view(), persisted }
  }

  /**
   * 提现：托管余额减少、农场硬币增加。
   *
   * 农场 `addCoins` 在上限 1,000,000 处**静默截断**，所以这里按 1,000,000 分批并核对
   * 每一批的实收 `qty`：收多少就扣多少，剩下的留在托管账户里，绝不「账上扣了、农场没进」。
   */
  async withdraw (rawCoins) {
    // 提现不受农场单次上限约束：正是「一次提一大笔」才需要分批。
    const coins = positiveInt(rawCoins, Number.MAX_SAFE_INTEGER)
    if (coins === null) return { ok: false, error: 'bad-amount' }
    const available = Math.floor(this.#state.balance)
    if (available < coins) return { ok: false, error: 'no-balance' }
    let remaining = coins
    let credited = 0
    while (remaining > 0) {
      const batch = Math.min(MAX_COINS, remaining)
      const added = await this.#farm.addCoins(batch)
      if (added === null || added.ok !== true || !(added.qty > 0)) {
        // 一批都没成功：整体失败，托管余额一分不动
        if (credited === 0) return { ok: false, error: 'farm-refused' }
        break
      }
      credited += added.qty
      remaining -= added.qty
      if (added.qty < batch) break // 农场到上限了，剩下的留在托管账户
    }
    this.#state.balance = roundCoin(this.#state.balance - credited)
    this.#state.tradedAt = this.#nowMs()
    const persisted = await this.#persist()
    return { ok: true, action: 'futures-withdraw', coins: credited, ...this.#view(), persisted }
  }

  /**
   * 票 94：把本机托管余额划出去交给房主账本。**不碰农场**——这不是提现，
   * 而是「这笔钱改由房主记账」：本机少多少，房主账本上就该多多少。
   * peer 充值走「农场 → 本机托管（`deposit`）→ 房主账本（这里）」两步，两边账守恒。
   */
  async transferOut (rawCoins) {
    const coins = positiveInt(rawCoins, MAX_COINS)
    if (coins === null) return { ok: false, error: 'bad-amount' }
    if (Math.floor(this.#state.balance) < coins) return { ok: false, error: 'no-balance' }
    this.#state.balance = roundCoin(this.#state.balance - coins)
    this.#state.tradedAt = this.#nowMs()
    const persisted = await this.#persist()
    return { ok: true, action: 'futures-transfer-out', coins, ...this.#view(), persisted }
  }

  /**
   * 房主：给 peer 充值（票 94）。钱不从本机农场出——peer 的农场在它自己机器上，
   * 房主只负责记「你在我这里有这么多可用余额」（peer 那边已经在 `transferOut` 里扣过）。
   */
  async hostDeposit (deviceId, rawCoins, at = this.#nowMs()) {
    const coins = positiveInt(rawCoins, MAX_COINS)
    if (coins === null) return { ok: false, error: 'bad-amount' }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const account = this.#remoteAccount(deviceId, stamp)
    if (account === null) return { ok: false, error: 'bad-device' }
    account.balance = roundCoin(account.balance + coins)
    account.updatedAt = stamp
    const seq = this.#bumpAccount(account)
    const persisted = await this.#persist()
    return { ok: true, action: 'futures-deposit', coins, account: this.#accountView(account, stamp), seq, persisted }
  }

  /** 房主：替 peer 开仓（票 94）——校验、定价、收费与 `open()` 是同一套函数，只是账记在 `remotes` 上。 */
  async hostOpen (deviceId, { crop, side, margin, leverage, at = this.#nowMs() } = {}) {
    if (!isCropId(crop)) return { ok: false, error: 'bad-crop' }
    if (!isFuturesSide(side)) return { ok: false, error: 'bad-side' }
    if (!isMarginAmount(margin)) return { ok: false, error: 'bad-margin' }
    if (!isFuturesLeverage(leverage)) return { ok: false, error: 'bad-leverage' }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const account = this.#remoteAccount(deviceId, stamp)
    if (account === null) return { ok: false, error: 'bad-device' }
    // 一条 settle 最多 8 条持仓：超了协议就装不下，所以房主必须在这里拒绝，而不是发不出去。
    if (account.positions.length >= FUTURES_MAX_POSITIONS) return { ok: false, error: 'position-limit' }
    const quote = this.quoteOf(crop, stamp)
    if (quote === null) {
      return this.#closedError(crop, stamp) ?? { ok: false, error: 'market-closed', notice: '现货指数未就绪。' }
    }
    if (this.#state.delivered[quote.contract.id] !== undefined) {
      return { ok: false, error: 'contract-expired', notice: '合约已到期，周五 20:00 后停止交易。' }
    }
    const price = fillPriceOf(quote, side)
    const notional = roundCoin(Number(margin) * Number(leverage))
    const lots = lotsFor({ notional, price })
    const usedMargin = marginOf({ lots, price, leverage })
    const fee = takerFeeOf(notionalOf({ lots, price }))
    const total = roundCoin(usedMargin + fee)
    if (account.balance < total) return { ok: false, error: 'no-balance' }

    account.balance = roundCoin(account.balance - total)
    const slot = this.#slotOf(stamp)
    const position = {
      id: randomUUID(),
      crop,
      contract: quote.contract.id,
      side,
      lots,
      entry: price,
      margin: usedMargin,
      leverage,
      openedAt: stamp,
      slot,
      settleSlot: slot + 1
    }
    account.positions.push(position)
    account.marginUsed = this.#recomputeFor(account)
    account.updatedAt = stamp
    const seq = this.#bumpAccount(account)
    // 手续费从 peer 的余额里出，落在本机的保险/销毁桶里（钱确实动了，费账就得跟着动）。
    this.#chargeFee(fee)
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-open',
      position: { ...position },
      lots,
      price,
      fee,
      account: this.#accountView(account, stamp),
      seq,
      persisted
    }
  }

  /** 房主：替 peer 平仓（票 94）。规则与 `close()` 相同；别人的盈亏不进本机的周成绩。 */
  async hostClose (deviceId, { id, at = this.#nowMs() } = {}) {
    const key = this.#remoteKey(deviceId)
    if (key === null) return { ok: false, error: 'bad-device' }
    const account = this.#state.remotes[key]
    if (account === undefined) return { ok: false, error: 'no-position' }
    const index = account.positions.findIndex((position) => position.id === id)
    if (index < 0) return { ok: false, error: 'no-position' }
    const position = account.positions[index]
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const window = contractWindowOf(position.contract)
    if (window === null) return { ok: false, error: 'bad-contract' }
    if (stamp >= window.expireAt) return { ok: false, error: 'contract-expired' }
    const quote = this.quoteOf(position.crop, stamp)
    if (quote === null) return { ok: false, error: 'market-closed' }
    const exit = fillPriceOf(quote, position.side === 'long' ? 'short' : 'long')
    const pnl = pnlOf({ lots: position.lots, entry: position.entry, exit, side: position.side })
    account.positions.splice(index, 1)
    account.marginUsed = this.#recomputeFor(account)
    const credit = Math.max(0, roundCoin(position.margin + pnl))
    account.balance = roundCoin(account.balance + credit)
    account.updatedAt = stamp
    const seq = this.#bumpAccount(account)
    this.#state.closed += 1
    this.#state.tradedAt = stamp
    this.#recordRemoteTrade(account, {
      at: stamp,
      crop: position.crop,
      contract: position.contract,
      side: position.side === 'long' ? 'short' : 'long',
      lots: position.lots,
      price: exit,
      fee: 0,
      kind: 'close'
    })
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-close',
      position: { ...position },
      exit,
      pnl,
      credit,
      account: this.#accountView(account, stamp),
      seq,
      persisted
    }
  }

  /**
   * 票 96：转现货的公共算式——先校验并算好所有数字，调用方再决定要不要动农场/账户。
   * 保证金按张数比例释放（部分平仓），盈亏按当前公允价（mid）结算，手续费按现货名义收一腿。
   */
  #convertPlan (account, positionId, rawLots, stamp) {
    const index = account.positions.findIndex((position) => position.id === positionId)
    if (index < 0) return { ok: false, error: 'no-position' }
    const position = account.positions[index]
    const lots = positiveInt(rawLots, MAX_QUANTITY)
    if (lots === null || lots > position.lots) return { ok: false, error: 'bad-lots' }
    const window = contractWindowOf(position.contract)
    if (window === null) return { ok: false, error: 'bad-contract' }
    if (this.#state.delivered[position.contract] !== undefined || stamp >= window.expireAt) {
      return { ok: false, error: 'contract-expired', notice: '合约已到期，不能转现货。' }
    }
    const quote = this.quoteOf(position.crop, stamp)
    if (quote === null) return { ok: false, error: 'market-closed', notice: '现货指数未就绪。' }
    const fair = roundCoin(quote.fair)
    const qty = lots * LOT_SIZE
    const cost = roundCoin(qty * fair)
    const fee = takerFeeOf(cost)
    const marginPart = lots === position.lots
      ? position.margin
      : roundCoin(position.margin * lots / position.lots)
    const pnl = pnlOf({ lots, entry: position.entry, exit: fair, side: position.side })
    const credit = Math.max(0, roundCoin(marginPart + pnl))
    if (account.balance + credit < roundCoin(cost + fee)) {
      return { ok: false, error: 'no-coins', notice: '托管余额不够按公允价买下这些现货。' }
    }
    return {
      ok: true,
      index,
      position,
      lots,
      qty,
      fair,
      cost,
      fee,
      marginPart,
      pnl,
      credit,
      delta: roundCoin(credit - cost - fee)
    }
  }

  /**
   * 票 96：转现货（本地账户）。先算、再入农场、最后一次性改账本；任何一步失败都回滚。
   * 口径是「平掉 N 张 → 释放保证金与浮盈 → 用余额按当前公允价买 N×100 个作物」，
   * 所以不是「保证金直接换作物」，余额不够时仍然会 `no-coins`。
   */
  async convertToSpot ({ positionId, lots, at = this.#nowMs() } = {}) {
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const plan = this.#convertPlan(this.#state, positionId, lots, stamp)
    if (plan.ok !== true) return plan
    const current = Number(this.#farm.snapshot()?.crops?.[plan.position.crop]) || 0
    if (current + plan.qty > MAX_STACK) {
      return { ok: false, error: 'no-space', notice: '这种作物的仓库放不下这么多现货。' }
    }
    const before = {
      balance: this.#state.balance,
      marginUsed: this.#state.marginUsed,
      closed: this.#state.closed,
      tradedAt: this.#state.tradedAt,
      positions: this.#state.positions.map((position) => ({ ...position })),
      trades: this.#state.trades.map((trade) => ({ ...trade })),
      fees: { ...this.#state.fees },
      week: { ...this.#state.week }
    }
    let added = null
    try {
      added = await this.#farm.addCrop(plan.position.crop, plan.qty)
    } catch {
      // 农场抛异常时账本还没动，直接按拒单处理；不能把账本改成「付了钱没拿到货」。
      return { ok: false, error: 'farm-refused', notice: '农场没有收下这批现货。' }
    }
    if (added === null || added?.ok !== true || Number(added.qty) !== plan.qty) {
      const got = added?.ok === true ? Number(added.qty) || 0 : 0
      if (got > 0) await this.#farm.takeCropOf(plan.position.crop, got)
      return { ok: false, error: 'farm-refused', notice: '农场没有收下这批现货。' }
    }

    const position = this.#state.positions[plan.index]
    this.#state.balance = roundCoin(this.#state.balance + plan.delta)
    if (plan.lots === position.lots) this.#state.positions.splice(plan.index, 1)
    else {
      position.lots -= plan.lots
      position.margin = roundCoin(position.margin - plan.marginPart)
    }
    this.#state.marginUsed = this.#recomputeMarginUsed()
    this.#state.closed += 1
    this.#state.tradedAt = stamp
    this.#bookPnl(plan.pnl, stamp)
    this.#chargeFee(plan.fee)
    this.#recordTrade({
      at: stamp,
      crop: position.crop,
      contract: position.contract,
      side: position.side === 'long' ? 'short' : 'long',
      lots: plan.lots,
      price: plan.fair,
      fee: plan.fee,
      kind: 'convert'
    })
    const persisted = await this.#persist()
    if (persisted === false) {
      await this.#farm.takeCropOf(plan.position.crop, plan.qty)
      this.#state.balance = before.balance
      this.#state.marginUsed = before.marginUsed
      this.#state.closed = before.closed
      this.#state.tradedAt = before.tradedAt
      this.#state.positions = before.positions
      this.#state.trades = before.trades
      this.#state.fees = before.fees
      this.#state.week = before.week
      return { ok: false, error: 'write-failed', notice: '账本没写进去，本次转现货已回滚。' }
    }
    return {
      ok: true,
      action: 'futures-convert',
      positionId: plan.position.id,
      crop: plan.position.crop,
      lots: plan.lots,
      qty: plan.qty,
      price: plan.fair,
      cost: plan.cost,
      fee: plan.fee,
      marginPart: plan.marginPart,
      pnl: plan.pnl,
      credit: plan.credit,
      delta: plan.delta,
      ...this.#view(),
      persisted
    }
  }

  /** 房主：替 peer 转现货。作物不进房主农场——peer 在自己机器上入仓，这里只结钱与合约。 */
  async hostConvert (deviceId, { positionId, lots, at = this.#nowMs() } = {}) {
    const key = this.#remoteKey(deviceId)
    if (key === null) return { ok: false, error: 'bad-device' }
    const account = this.#state.remotes[key]
    if (account === undefined) return { ok: false, error: 'no-position' }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const plan = this.#convertPlan(account, positionId, lots, stamp)
    if (plan.ok !== true) return plan
    const position = account.positions[plan.index]
    account.balance = roundCoin(account.balance + plan.delta)
    if (plan.lots === position.lots) account.positions.splice(plan.index, 1)
    else {
      position.lots -= plan.lots
      position.margin = roundCoin(position.margin - plan.marginPart)
    }
    account.marginUsed = this.#recomputeFor(account)
    account.updatedAt = stamp
    const seq = this.#bumpAccount(account)
    this.#state.closed += 1
    this.#state.tradedAt = stamp
    this.#chargeFee(plan.fee)
    this.#recordRemoteTrade(account, {
      at: stamp,
      crop: position.crop,
      contract: position.contract,
      side: position.side === 'long' ? 'short' : 'long',
      lots: plan.lots,
      price: plan.fair,
      fee: plan.fee,
      kind: 'convert'
    })
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-convert',
      positionId: position.id,
      crop: position.crop,
      lots: plan.lots,
      qty: plan.qty,
      price: plan.fair,
      cost: plan.cost,
      fee: plan.fee,
      marginPart: plan.marginPart,
      pnl: plan.pnl,
      credit: plan.credit,
      delta: plan.delta,
      account: this.#accountView(account, stamp),
      seq,
      persisted
    }
  }

  /**
   * 票 96：一个账户的到期处理——先撤该合约全部挂单（退冻结），再按交割价现金结清全部仓位。
   * `credit = max(0, margin + pnl)`；亏穿保证金的差额累计进 `state.shortfall`（票 97 兜底）。
   * 交割费按交割名义收 0.1%，从释放出来的钱里扣；扣完仍不够时也记缺口，余额绝不为负。
   */
  #deliverAccount (account, window, price, stamp, local) {
    const kept = []
    let cancelled = 0
    for (const order of account.orders) {
      if (order.contract !== window.id) {
        kept.push(order)
        continue
      }
      account.balance = roundCoin(account.balance + order.marginFrozen)
      cancelled += 1
    }
    account.orders = kept

    const remaining = []
    const delivered = []
    for (const position of account.positions) {
      if (position.contract !== window.id) {
        remaining.push(position)
        continue
      }
      const pnl = pnlOf({ lots: position.lots, entry: position.entry, exit: price, side: position.side })
      const credit = Math.max(0, roundCoin(position.margin + pnl))
      const deliveryFee = roundCoin(notionalOf({ lots: position.lots, price }) * DELIVERY_FEE_RATE)
      let net = roundCoin(credit - deliveryFee)
      let gap = Math.max(0, -roundCoin(position.margin + pnl))
      if (net < 0) {
        gap = roundCoin(gap - net)
        net = 0
      }
      this.#state.shortfall = roundCoin(this.#state.shortfall + gap)
      account.balance = roundCoin(account.balance + net)
      this.#state.closed += 1
      this.#chargeFee(deliveryFee)
      const trade = {
        at: stamp,
        crop: position.crop,
        contract: position.contract,
        side: position.side === 'long' ? 'short' : 'long',
        lots: position.lots,
        price,
        fee: deliveryFee,
        kind: 'delivery',
        deliveryFee
      }
      if (local) {
        this.#bookPnl(pnl, stamp)
        this.#recordTrade(trade)
      } else {
        this.#recordRemoteTrade(account, trade)
      }
      delivered.push({ position: { ...position }, pnl, credit, deliveryFee, net, gap })
    }
    account.positions = remaining
    account.marginUsed = this.#recomputeFor(account)
    return { cancelled, delivered }
  }

  /**
   * 票 96：到期交割（幂等）。只碰「已过 20:00、还没交割、且本地或远端还有仓/单」的合约；
   * 交割价取四根收盘均价，指数缺失时整张合约跳过、等下一拍，不拿残缺价格硬结。
   */
  async expireDue (at = this.#nowMs()) {
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const contracts = new Set()
    for (const position of this.#state.positions) contracts.add(position.contract)
    for (const order of this.#state.orders) contracts.add(order.contract)
    for (const account of Object.values(this.#state.remotes)) {
      for (const position of account.positions) contracts.add(position.contract)
      for (const order of account.orders) contracts.add(order.contract)
    }

    const deliveries = []
    const remotes = []
    for (const contractId of [...contracts].sort()) {
      const window = contractWindowOf(contractId)
      if (window === null || stamp < window.expireAt) continue
      if (this.#state.delivered[contractId] !== undefined) continue
      const price = deliveryPriceOf({
        crop: window.crop,
        contractId,
        indexOf: (cropId) => this.#indexOf(cropId),
        at: stamp
      })
      if (price === null) continue

      const local = this.#deliverAccount(this.#state, window, price, stamp, true)
      const accounts = []
      for (const [deviceId, account] of Object.entries(this.#state.remotes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        const before = account.lastSeq
        const result = this.#deliverAccount(account, window, price, stamp, false)
        if (result.cancelled === 0 && result.delivered.length === 0) continue
        account.updatedAt = stamp
        const seq = this.#bumpAccount(account)
        if (seq === before) continue
        accounts.push({ deviceId, seq, account: this.#accountView(account, stamp) })
      }
      remotes.push(...accounts)
      this.#state.delivered[contractId] = stamp
      this.#state.tradedAt = stamp
      deliveries.push({
        contract: contractId,
        crop: window.crop,
        price,
        at: stamp,
        cancelled: local.cancelled,
        positions: local.delivered.length
      })
    }

    if (deliveries.length === 0) {
      return { ok: true, action: 'futures-expire', deliveries: [], remotes: [] }
    }
    this.#state.marginUsed = this.#recomputeMarginUsed()
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-expire',
      deliveries,
      remotes,
      ...this.#view(),
      persisted
    }
  }

  /**
   * 一个远端账户的只读视图（房主拿它拼 `futures-settle`，窗口拿它画别人的账）。
   * 不抛异常：未知账户返回一份零账户，调用方不用先问「有没有」。
   */
  accountOf (deviceId, { at = this.#nowMs(), positionLimit = FUTURES_VIEW_POSITIONS } = {}) {
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const key = this.#remoteKey(deviceId)
    const account = key === null ? undefined : this.#state.remotes[key]
    if (account === undefined) {
      return { balance: 0, marginUsed: 0, equity: 0, positions: [], orders: [], trades: [], seq: 0, epoch: this.#state.epoch }
    }
    return this.#accountView(account, stamp, positionLimit)
  }

  /**
   * peer 侧：采纳房主的一条账户快照（票 94）。
   *
   * 幂等键是 `(epoch, seq)`：同一条重发只算一次（`stale`），倒退的包直接丢；epoch 变了
   * 说明房主换了账本（重启/换人），旧的 lastSeq 一笔作废、直接采纳新账。
   * 不写盘：这是房主账本的缓存（见文件头）。
   */
  applySettle ({ epoch, seq, balance, marginUsed, positions, orders, trades, at = this.#nowMs() } = {}) {
    // 先验形状再看新旧：坏包必须被「拒」，不能被当成「旧的」悄悄咽下去。
    if (typeof epoch !== 'string' || epoch === '' || epoch.length > MAX_ID_LENGTH) {
      return { ok: false, error: 'bad-epoch' }
    }
    if (!Number.isInteger(seq) || seq < 0) return { ok: false, error: 'bad-seq' }
    const current = this.#state.replica
    if (current !== null && current.epoch === epoch && seq <= current.lastSeq) {
      return { ok: true, applied: false, reason: 'stale' }
    }
    const safeBalance = nonNegativeCoin(balance)
    const safeMarginUsed = nonNegativeCoin(marginUsed)
    if (safeBalance === null || safeMarginUsed === null) return { ok: false, error: 'bad-account' }
    if (!Array.isArray(positions)) return { ok: false, error: 'bad-positions' }
    // 坏条目只丢自己：副本只用来画图，画半截不如少画一条（房主下一拍还会重发整份）。
    const accountPositions = []
    for (const entry of positions) {
      const position = normalizeReplicaPosition(entry)
      if (position !== null) accountPositions.push(position)
    }
    // 票 95：自己的挂单。老房主不发 `orders` 时按空数组处理（不算坏包）。
    if (orders !== undefined && !Array.isArray(orders)) return { ok: false, error: 'bad-orders' }
    const accountOrders = []
    for (const entry of Array.isArray(orders) ? orders.slice(0, FUTURES_MAX_ORDERS) : []) {
      const order = normalizeReplicaOrder(entry)
      if (order !== null) accountOrders.push(order)
    }
    // 票 96：交割/转现货的成交流水。老房主不发 `trades` 时按空数组处理。
    if (trades !== undefined && !Array.isArray(trades)) return { ok: false, error: 'bad-trades' }
    const accountTrades = []
    for (const entry of Array.isArray(trades) ? trades.slice(0, FUTURES_VIEW_TRADES) : []) {
      const trade = normalizeTrade(entry)
      if (trade !== null) accountTrades.push(trade)
    }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    this.#state.replica = {
      epoch,
      lastSeq: seq,
      balance: safeBalance,
      marginUsed: safeMarginUsed,
      positions: accountPositions,
      orders: accountOrders,
      trades: accountTrades,
      updatedAt: stamp
    }
    return { ok: true, applied: true }
  }

  /** peer 侧的只读副本；从没收到过 settle 就是 null（窗口据此显示「等对端」）。 */
  replicaOf () {
    const replica = this.#state.replica
    if (replica === null) return null
    return {
      epoch: replica.epoch,
      lastSeq: replica.lastSeq,
      balance: roundCoin(replica.balance),
      marginUsed: roundCoin(replica.marginUsed),
      positions: replica.positions.map((position) => ({ ...position })),
      orders: replica.orders.map((order) => ({ ...order })),
      trades: (replica.trades ?? []).map((trade) => ({ ...trade }))
    }
  }

  /** 票 96：周五 20:00 与周末都按 `market-closed` 拒绝，只有文案区分；已有仓位走 `contract-expired`。 */
  #closedError (crop, stamp) {
    if (contractOf(crop, stamp) !== null) return null
    const monday = startOfWeek(stamp)
    if (stamp < monday + 5 * DAY_MS) {
      return { ok: false, error: 'market-closed', notice: '合约已到期，周五 20:00 后停止交易。' }
    }
    return { ok: false, error: 'market-closed', notice: '周末休市，下周一 00:00 开新合约。' }
  }

  /** 吃单开仓：做多吃卖一、做空吃买一；保证金与手续费当场从余额划走。 */
  async open ({ crop, side, margin, leverage, at = this.#nowMs() }) {
    if (!isCropId(crop)) return { ok: false, error: 'bad-crop' }
    if (!isFuturesSide(side)) return { ok: false, error: 'bad-side' }
    if (!isMarginAmount(margin)) return { ok: false, error: 'bad-margin' }
    if (!isFuturesLeverage(leverage)) return { ok: false, error: 'bad-leverage' }
    const stamp = Number(at)
    const quote = this.quoteOf(crop, stamp)
    if (quote === null) {
      return this.#closedError(crop, stamp) ?? { ok: false, error: 'market-closed', notice: '现货指数未就绪。' }
    }
    if (this.#state.delivered[quote.contract.id] !== undefined) {
      return { ok: false, error: 'contract-expired', notice: '合约已到期，周五 20:00 后停止交易。' }
    }
    const price = fillPriceOf(quote, side)
    const notional = roundCoin(Number(margin) * Number(leverage))
    const lots = lotsFor({ notional, price })
    const usedMargin = marginOf({ lots, price, leverage })
    const fee = takerFeeOf(notionalOf({ lots, price }))
    const total = roundCoin(usedMargin + fee)
    if (this.#state.balance < total) return { ok: false, error: 'no-balance' }

    this.#state.balance = roundCoin(this.#state.balance - total)
    this.#state.marginUsed = roundCoin(this.#state.marginUsed + usedMargin)
    const slot = this.#slotOf(stamp)
    const position = {
      id: randomUUID(),
      crop,
      contract: quote.contract.id,
      side,
      lots,
      entry: price,
      margin: usedMargin,
      leverage,
      openedAt: stamp,
      slot,
      settleSlot: slot + 1
    }
    this.#state.positions.push(position)
    this.#state.tradedAt = stamp
    this.#chargeFee(fee)
    this.#recordTrade({ at: stamp, crop, contract: quote.contract.id, side, lots, price, fee, kind: 'open' })
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-open',
      position: { ...position },
      lots,
      price,
      fee,
      ...this.#view(),
      persisted
    }
  }

  /**
   * 挂限价单（票 95）：下单即把保证金从余额划进「冻结」，成交/撤单时才动。
   * `deviceId` 给了就走房主的 `hostPlace`（peer 的单记在 `remotes` 上）。
   */
  async place ({ crop, side, price, lots, leverage, at = this.#nowMs(), deviceId = null } = {}) {
    if (isDeviceId(deviceId)) return this.hostPlace(deviceId, { crop, side, price, lots, leverage, at })
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const prepared = this.#prepareOrder({ crop, side, price, lots, leverage, stamp })
    if (prepared.ok !== true) return prepared
    const placed = this.#placeInto(this.#state, prepared)
    if (placed.ok !== true) return placed
    this.#state.tradedAt = stamp
    const persisted = await this.#persist()
    return { ok: true, action: 'futures-place', order: { ...placed.order }, ...this.#view(), persisted }
  }

  /** 房主：替 peer 挂单——规则与 `place()` 同一套，账记在 `remotes[deviceId]` 上。 */
  async hostPlace (deviceId, { crop, side, price, lots, leverage, at = this.#nowMs() } = {}) {
    const key = this.#remoteKey(deviceId)
    if (key === null) return { ok: false, error: 'bad-device' }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const prepared = this.#prepareOrder({ crop, side, price, lots, leverage, stamp })
    if (prepared.ok !== true) return prepared
    prepared.order.deviceId = key
    const account = this.#remoteAccount(deviceId, stamp)
    if (account === null) return { ok: false, error: 'bad-device' }
    const placed = this.#placeInto(account, prepared)
    if (placed.ok !== true) return placed
    account.updatedAt = stamp
    const seq = this.#bumpAccount(account)
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-place',
      order: { ...placed.order },
      account: this.#accountView(account, stamp),
      seq,
      persisted
    }
  }

  /**
   * 撤单（票 95）：只退**剩余未成交**那部分冻结保证金；已经成交的部分早就变成仓位了。
   * 别人的单回 `not-yours`（不泄漏「这单存在」以外的信息），不存在回 `no-order`。
   */
  async cancel ({ orderId, at = this.#nowMs(), deviceId = null } = {}) {
    if (isDeviceId(deviceId)) return this.hostCancel(deviceId, { orderId, at })
    const id = typeof orderId === 'string' && orderId !== '' && orderId.length <= MAX_ID_LENGTH ? orderId : null
    if (id === null) return { ok: false, error: 'bad-order' }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const index = this.#state.orders.findIndex((order) => order.id === id)
    if (index < 0) return { ok: false, error: this.#orderOwnerOf(id) === null ? 'no-order' : 'not-yours' }
    const order = this.#state.orders[index]
    this.#state.orders.splice(index, 1)
    this.#state.balance = roundCoin(this.#state.balance + order.marginFrozen)
    this.#state.marginUsed = this.#recomputeMarginUsed()
    this.#state.tradedAt = stamp
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-cancel',
      order: { ...order },
      released: order.marginFrozen,
      ...this.#view(),
      persisted
    }
  }

  /** 房主：替 peer 撤单。 */
  async hostCancel (deviceId, { orderId, at = this.#nowMs() } = {}) {
    const key = this.#remoteKey(deviceId)
    if (key === null) return { ok: false, error: 'bad-device' }
    const id = typeof orderId === 'string' && orderId !== '' && orderId.length <= MAX_ID_LENGTH ? orderId : null
    if (id === null) return { ok: false, error: 'bad-order' }
    const account = this.#state.remotes[key]
    if (account === undefined) return { ok: false, error: 'no-order' }
    const index = account.orders.findIndex((order) => order.id === id)
    if (index < 0) return { ok: false, error: this.#orderOwnerOf(id) === null ? 'no-order' : 'not-yours' }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const order = account.orders[index]
    account.orders.splice(index, 1)
    account.balance = roundCoin(account.balance + order.marginFrozen)
    account.marginUsed = this.#recomputeFor(account)
    account.updatedAt = stamp
    const seq = this.#bumpAccount(account)
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-cancel',
      order: { ...order },
      released: order.marginFrozen,
      account: this.#accountView(account, stamp),
      seq,
      persisted
    }
  }

  /**
   * 撮合入口（票 95）：每个 tick 对每个合约跑一次。
   *
   * 顺序固定、与机器无关：
   *   1. 先把这一拍的盯市补上（成交必须落在已经结算过的账上）；
   *   2. 玩家挂单两两撮合（`matchOrders`：价格优先、同价时间优先，成交价取 maker 价）；
   *   3. 做市商扫单：买单价 ≥ ask、卖单价 ≤ bid 时整张被 MM 吃掉（同样按挂单价成交）。
   *
   * 幂等：成交当场扣 `lotsLeft`、扣 `marginFrozen`，所以同一时刻重复调用不会重复成交。
   * 每笔成交给双方各开一个仓位（`margin` = 该笔成交对应的那部分冻结保证金，
   * `entry` = 成交价），按成交名义向双方各收 0.1%，并记一条 `kind:'open'` 的成交流水。
   */
  async matchDue (at = this.#nowMs()) {
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    await this.settleDue(stamp)
    let fills = 0
    const touched = new Map()
    const contracts = new Set()
    for (const order of this.#state.orders) contracts.add(order.contract)
    for (const account of Object.values(this.#state.remotes)) {
      for (const order of account.orders) contracts.add(order.contract)
    }
    for (const contract of [...contracts].sort()) {
      const window = contractWindowOf(contract)
      // 票 96：20:00 整点之后这张合约只剩“撤单 + 交割”，不再撮合，避免到期后凭空开仓。
      if (window === null || stamp >= window.expireAt) continue
      const pools = this.#orderPools(contract)
      if (pools.orders.length === 0) continue
      const due = matchOrders({ orders: pools.orders, contract, at: stamp })
      for (const fill of due) {
        const parties = this.#applyFill(pools, fill, stamp)
        if (parties === null) continue
        fills += 1
        for (const party of parties) if (party.deviceId !== undefined) touched.set(party.deviceId, party.account)
      }
      // 做市商扫单：这一拍剩下的单里，价格已经穿过对手价的整张吃掉。
      fills += this.#sweepMarketMaker(pools, stamp, touched)
    }
    if (fills === 0) return { ok: true, action: 'futures-match', fills, ...this.#view() }
    // 成交完的单从盘口摘掉：`lotsLeft: 0` 的单留在账本里会让 settle 的 `orders` 变成坏字段。
    this.#pruneOrders()

    const accounts = []
    for (const [deviceId, account] of touched) {
      account.updatedAt = stamp
      const seq = this.#bumpAccount(account)
      accounts.push({ deviceId, seq, account: this.#accountView(account, stamp) })
    }
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-match',
      fills,
      accounts,
      ...this.#view(),
      persisted
    }
  }

  /** 校验一张挂单的静态字段；余额、自成交、条数上限由 `#placeInto` 按账户判断。 */
  #prepareOrder ({ crop, side, price, lots, leverage, stamp }) {
    if (!isCropId(crop)) return { ok: false, error: 'bad-crop' }
    if (!isFuturesSide(side)) return { ok: false, error: 'bad-side' }
    const limit = finiteNumber(price)
    if (limit === null || limit <= 0) return { ok: false, error: 'bad-price' }
    const count = positiveInt(lots, MAX_QUANTITY)
    if (count === null) return { ok: false, error: 'bad-lots' }
    if (!isFuturesLeverage(leverage)) return { ok: false, error: 'bad-leverage' }
    const contract = contractOf(crop, stamp)
    if (contract === null) {
      return this.#closedError(crop, stamp) ?? { ok: false, error: 'market-closed', notice: '现货指数未就绪。' }
    }
    // 票 96：已交割的合约即使时钟被拨回也不许再挂单。
    if (this.#state.delivered[contract.id] !== undefined) {
      return { ok: false, error: 'contract-expired', notice: '合约已到期，周五 20:00 后停止交易。' }
    }
    const limitPrice = roundCoin(limit)
    const marginFrozen = marginOf({ lots: count, price: limitPrice, leverage })
    if (!(marginFrozen > 0) || marginFrozen > MAX_MARGIN) return { ok: false, error: 'bad-margin' }
    return {
      ok: true,
      order: {
        id: randomUUID(),
        deviceId: LOCAL_ORDER_DEVICE,
        crop,
        contract: contract.id,
        side,
        price: limitPrice,
        lots: count,
        lotsLeft: count,
        leverage,
        marginFrozen,
        at: stamp
      }
    }
  }

  /** 把一张已经校验过的单挂进某个账户：查条数上限、自成交、余额，然后冻结保证金。 */
  #placeInto (account, prepared) {
    const order = prepared.order
    if (account.orders.length >= FUTURES_MAX_ORDERS) return { ok: false, error: 'order-limit' }
    if (this.#crossesOwn(account.orders, order)) return { ok: false, error: 'self-trade' }
    const cost = roundCoin(order.marginFrozen + takerFeeOf(notionalOf({ lots: order.lots, price: order.price })))
    if (account.balance < cost) return { ok: false, error: 'no-balance' }
    account.orders.push(order)
    account.balance = roundCoin(account.balance - order.marginFrozen)
    account.marginUsed = this.#recomputeFor(account)
    return { ok: true, order }
  }

  /** 新单会不会立刻和同一个账户已有的对手单交叉（自成交防护）。 */
  #crossesOwn (orders, order) {
    for (const other of orders) {
      if (other.side === order.side) continue
      if (other.lotsLeft <= 0) continue
      if (order.side === 'long' && order.price >= other.price) return true
      if (order.side === 'short' && order.price <= other.price) return true
    }
    return false
  }

  /** 这一条单属于哪个账户（`local` / 远端 deviceId），找不到返回 null。 */
  #orderOwnerOf (id) {
    if (this.#state.orders.some((order) => order.id === id)) return LOCAL_ORDER_DEVICE
    for (const [deviceId, account] of Object.entries(this.#state.remotes)) {
      if (account.orders.some((order) => order.id === id)) return deviceId
    }
    return null
  }

  /** 把一个合约上所有账户的挂单摊平成一盘，`owners` 记住每条单属于谁。 */
  #orderPools (contract) {
    const local = { account: this.#state, local: true }
    const pools = { local, accounts: [], orders: [], owners: new Map() }
    for (const order of this.#state.orders) {
      if (order.contract !== contract) continue
      pools.orders.push(order)
      pools.owners.set(order.id, local)
    }
    for (const [deviceId, account] of Object.entries(this.#state.remotes)) {
      const pool = { account, local: false, deviceId }
      pools.accounts.push(pool)
      for (const order of account.orders) {
        if (order.contract !== contract) continue
        pools.orders.push(order)
        pools.owners.set(order.id, pool)
      }
    }
    return pools
  }

  /** 成交完的单从盘口摘掉：`lotsLeft: 0` 留在账本里会让 settle 的 `orders` 变成坏字段。 */
  #pruneOrders () {
    this.#state.orders = this.#state.orders.filter((order) => order.lotsLeft > 0)
    for (const account of Object.values(this.#state.remotes)) {
      account.orders = account.orders.filter((order) => order.lotsLeft > 0)
    }
  }

  /** 从挂单的冻结保证金里按成交张数比例扣一份，返回这一份（最后一张全给，避免留 1 分残渣）。 */  #takeFrozen (order, lots) {
    const count = Math.min(lots, order.lotsLeft)
    const part = count >= order.lotsLeft ? order.marginFrozen : roundCoin(order.marginFrozen * count / order.lotsLeft)
    order.marginFrozen = roundCoin(order.marginFrozen - part)
    order.lotsLeft = count >= order.lotsLeft ? 0 : order.lotsLeft - count
    return part
  }

  /** 成交后给某一方开仓：保证金来自冻结，手续费从余额扣，仓位带这一拍的结算游标。 */
  #openFromOrder (pool, order, lots, price, margin, stamp) {
    const account = pool.account
    const fee = takerFeeOf(notionalOf({ lots, price }))
    account.balance = roundCoin(account.balance - fee)
    const slot = this.#slotOf(stamp)
    account.positions.push({
      id: randomUUID(),
      crop: order.crop,
      contract: order.contract,
      side: order.side,
      lots,
      entry: price,
      margin,
      leverage: order.leverage,
      openedAt: stamp,
      slot,
      settleSlot: slot + 1
    })
    account.marginUsed = this.#recomputeFor(account)
    if (pool.local) {
      this.#state.tradedAt = stamp
      this.#recordTrade({
        at: stamp,
        crop: order.crop,
        contract: order.contract,
        side: order.side,
        lots,
        price,
        fee,
        kind: 'open',
        orderId: order.id
      })
    }
    this.#chargeFee(fee)
  }

  /** 落一笔玩家对玩家的成交；返回吃到的两方（用于给远端账户 +1 流水号）。 */
  #applyFill (pools, fill, stamp) {
    const maker = pools.owners.get(fill.makerId)
    const taker = pools.owners.get(fill.takerId)
    if (maker === undefined || taker === undefined) return null
    const makerOrder = maker.account.orders.find((order) => order.id === fill.makerId)
    const takerOrder = taker.account.orders.find((order) => order.id === fill.takerId)
    if (makerOrder === undefined || takerOrder === undefined) return null
    const lots = Math.min(fill.lots, makerOrder.lotsLeft, takerOrder.lotsLeft)
    if (!(lots > 0)) return null
    const price = Number(fill.price)
    const makerMargin = this.#takeFrozen(makerOrder, lots)
    const takerMargin = this.#takeFrozen(takerOrder, lots)
    this.#openFromOrder(maker, makerOrder, lots, price, makerMargin, stamp)
    this.#openFromOrder(taker, takerOrder, lots, price, takerMargin, stamp)
    return [maker, taker]
  }

  /** 做市商扫单：买单价 ≥ ask / 卖单价 ≤ bid 的整张吃掉，成交价仍是挂单价。 */
  #sweepMarketMaker (pools, stamp, touched) {
    const window = contractWindowOf(pools.orders[0]?.contract)
    if (window === null) return 0
    const quote = this.quoteOf(window.crop, stamp)
    if (quote === null) return 0
    let fills = 0
    for (const order of sortBook(pools.orders)) {
      if (order.lotsLeft <= 0) continue
      const touch = order.side === 'long' ? quote.ask : quote.bid
      const crossed = order.side === 'long' ? Number(order.price) >= touch : Number(order.price) <= touch
      if (!crossed) continue
      const pool = pools.owners.get(order.id)
      if (pool === undefined) continue
      const lots = order.lotsLeft
      const margin = this.#takeFrozen(order, lots)
      this.#openFromOrder(pool, order, lots, Number(order.price), margin, stamp)
      if (pool.deviceId !== undefined) touched.set(pool.deviceId, pool.account)
      fills += 1
    }
    return fills
  }


  /** 主动平仓：按当前对手价成交，保证金 + 盈亏记回余额。合约过期后只能等交割（票 96）。 */
  async close ({ id, at = this.#nowMs() }) {
    const index = this.#state.positions.findIndex((position) => position.id === id)
    if (index < 0) return { ok: false, error: 'no-position' }
    const position = this.#state.positions[index]
    const stamp = Number(at)
    const window = contractWindowOf(position.contract)
    if (window === null) return { ok: false, error: 'bad-contract' }
    if (stamp >= window.expireAt) return { ok: false, error: 'contract-expired' }
    const quote = this.quoteOf(position.crop, stamp)
    if (quote === null) return { ok: false, error: 'market-closed' }
    const exit = fillPriceOf(quote, position.side === 'long' ? 'short' : 'long')
    const pnl = pnlOf({ lots: position.lots, entry: position.entry, exit, side: position.side })
    this.#state.positions.splice(index, 1)
    this.#state.marginUsed = this.#recomputeMarginUsed()
    const credit = Math.max(0, roundCoin(position.margin + pnl))
    this.#state.balance = roundCoin(this.#state.balance + credit)
    this.#state.closed += 1
    this.#state.tradedAt = stamp
    this.#bookPnl(pnl, stamp)
    // 平仓是反向的一笔成交：方向反过来记，手续费只有开仓那一下收（交割费由票 96 加）。
    this.#recordTrade({
      at: stamp,
      crop: position.crop,
      contract: position.contract,
      side: position.side === 'long' ? 'short' : 'long',
      lots: position.lots,
      price: exit,
      fee: 0,
      kind: 'close'
    })
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-close',
      position: { ...position },
      exit,
      pnl,
      credit,
      ...this.#view(),
      persisted
    }
  }

  /**
   * 逐根盯市：结算所有「这一根已经走完」的仓位，按那一根的收盘公允价重估。
   *
   * 盯市 = 把浮盈浮亏记进 `balance`，入场价改成收盘价，仓位继续持有、保证金不动——
   * 这样周合约才拿得住一整周，票 97 的逐 tick 强平也才有对象可强。
   * 权益归零（亏光保证金）就当场强平：保证金没收，仓位删除。
   * 结算时点由仓位自己的 `settleSlot` 决定，所以重复调用、重启、补算走同一条路径。
   */
  async settleDue (at = this.#nowMs()) {
    const stamp = Number(at)
    const settled = []
    for (let i = this.#state.positions.length - 1; i >= 0; i -= 1) {
      const position = this.#state.positions[i]
      const outcome = this.#settlePositionAt(position, stamp)
      if (outcome === null) continue
      if (outcome.liquidated) {
        // 亏光保证金：保证金没收，仓位删除（票 97 会把这条路径做细）
        this.#state.positions.splice(i, 1)
        this.#state.marginUsed = this.#recomputeMarginUsed()
        this.#state.closed += 1
        // 本周盈亏记「整块保证金」（钱在开仓时就已经划走了，这里记的是它的去向）。
        this.#bookPnl(roundCoin(-position.margin), outcome.at)
        settled.push({
          position: { ...position },
          price: outcome.price,
          pnl: outcome.pnl,
          credit: 0,
          liquidated: true,
          at: outcome.at
        })
        continue
      }
      this.#state.balance = roundCoin(this.#state.balance + outcome.pnl)
      position.entry = outcome.price
      position.settleSlot = this.#slotOf(outcome.at) + 1
      this.#state.tradedAt = outcome.at
      this.#bookPnl(outcome.pnl, outcome.at)
      settled.push({
        position: { ...position },
        price: outcome.price,
        pnl: outcome.pnl,
        credit: outcome.pnl,
        liquidated: false,
        at: outcome.at
      })
    }

    // 票 94：替 peer 托管的账户同样逐根盯市——否则 peer 那边的浮盈永远停在开仓价。
    // 一条 settle 只带一个账户，所以每个动过的账户各自 +1 流水号（peer 按 (epoch,seq) 判重）。
    const remotes = []
    for (const [deviceId, account] of Object.entries(this.#state.remotes)) {
      const entries = this.#settleRemoteAccount(account, stamp)
      if (entries.length === 0) continue
      account.updatedAt = stamp
      const seq = this.#bumpAccount(account)
      remotes.push({ deviceId, seq, settled: entries, account: this.#accountView(account, stamp) })
    }

    if (settled.length === 0 && remotes.length === 0) return { ok: true, action: 'futures-settle', settled }
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-settle',
      settled,
      ...(remotes.length === 0 ? {} : { remotes }),
      ...this.#view(),
      persisted
    }
  }

  /**
   * 替 peer 的账户逐根盯市：只动余额/入场价/结算游标，不碰本机的周盈亏。
   * 强平时保证金没收（开仓时已从余额划走），删仓位、重算占用即可。
   */
  #settleRemoteAccount (account, stamp) {
    const settled = []
    for (let i = account.positions.length - 1; i >= 0; i -= 1) {
      const position = account.positions[i]
      const outcome = this.#settlePositionAt(position, stamp)
      if (outcome === null) continue
      if (outcome.liquidated) {
        account.positions.splice(i, 1)
        settled.push({
          position: { ...position },
          price: outcome.price,
          pnl: outcome.pnl,
          credit: 0,
          liquidated: true,
          at: outcome.at
        })
        continue
      }
      account.balance = roundCoin(account.balance + outcome.pnl)
      position.entry = outcome.price
      position.settleSlot = this.#slotOf(outcome.at) + 1
      settled.push({
        position: { ...position },
        price: outcome.price,
        pnl: outcome.pnl,
        credit: outcome.pnl,
        liquidated: false,
        at: outcome.at
      })
    }
    if (settled.length > 0) account.marginUsed = this.#recomputeFor(account)
    return settled
  }

  /**
   * 一个仓位这一拍该不该结算；返回 null = 没到点 / 没有价（下一拍再试）。
   * 本地账户与远端账户共用这一条：规则只有一份，才不会出现「两种盯市」。
   */
  #settlePositionAt (position, stamp) {
    const settleAt = position.settleSlot * SLOT_MS
    if (!(settleAt <= stamp)) return null
    const window = contractWindowOf(position.contract)
    if (window === null) return null
    // 到期那一根没有「下一根」了：按到期前一毫秒的价结算，否则周五最后一根的仓位
    // 会因为 contractOf() 在到期后返回 null 而永远结不掉。
    const priceAt = Math.min(settleAt, window.expireAt - 1)
    const price = this.#fairAt(position.crop, position.contract, priceAt)
    if (price === null) return null // 没有指数的作物不结（账本不动，下一拍再试）
    const pnl = pnlOf({ lots: position.lots, entry: position.entry, exit: price, side: position.side })
    return { price, pnl, liquidated: roundCoin(position.margin + pnl) <= 0, at: priceAt }
  }

  /** 某个合约在某一刻的公允价：用仓位自己的合约，不被「本周合约」顶替。 */
  #fairAt (crop, contractId, at) {
    const indexPrice = this.#indexOf(crop)
    const price = fairPriceOf({ indexPrice, crop, contractId, at })
    return price === null ? null : roundCoin(price)
  }

  /** 远端账户的键：非法 deviceId 一律 null（绝不用没校验过的字符串当对象键）。 */
  #remoteKey (deviceId) {
    return isDeviceId(deviceId) ? deviceId.toLowerCase() : null
  }

  /** 取（必要时创建）一个远端账户：第一次见到某个 deviceId 就开一个空账户。 */
  #remoteAccount (deviceId, at) {
    const key = this.#remoteKey(deviceId)
    if (key === null) return null
    let account = this.#state.remotes[key]
    if (account === undefined) {
      account = initialRemoteAccount(this.#state.seq, at)
      this.#state.remotes[key] = account
    }
    return account
  }

  /** 远端账户的只读视图：与本地快照同一套字段（余额/占用/权益 + 持仓的行情与浮盈）。 */
  #accountView (account, at, positionLimit = FUTURES_VIEW_POSITIONS) {
    const limit = Number.isInteger(positionLimit) && positionLimit > 0 ? positionLimit : FUTURES_VIEW_POSITIONS
    const positions = account.positions.slice(0, limit).map((position) => ({
      ...position,
      quote: this.quoteOf(position.crop, at),
      unrealized: this.#unrealizedOf(position, at)
    }))
    return {
      balance: roundCoin(account.balance),
      marginUsed: roundCoin(account.marginUsed),
      equity: roundCoin(account.balance + account.marginUsed),
      positions,
      // 票 95：这个账户自己的挂单（房主据此拼 settle）。
      orders: account.orders.map((order) => ({ ...order })),
      // 票 96：这个账户自己的成交流水（交割后 peer 窗口要能看到「交割」）。
      trades: (account.trades ?? []).slice(0, FUTURES_VIEW_TRADES).map((trade) => ({ ...trade })),
      seq: account.lastSeq,
      epoch: this.#state.epoch
    }
  }

  /** 流水号 +1：只有「peer 必须看见」的变动才动它（本机自己的买卖不影响别人的账）。 */
  #bumpAccount (account) {
    this.#state.seq += 1
    account.lastSeq = this.#state.seq
    return account.lastSeq
  }

  /** 保证金占用一律以「仓位 + 挂单冻结」为准：删仓位/撤单之后不会留下凭空冻结的钱。 */
  #recomputeMarginUsed () {
    return roundCoin(this.#marginSum(this.#state.positions) + this.#frozenSum(this.#state.orders))
  }

  /** 任意账户（本地 state 或远端 account）的保证金总额。 */
  #recomputeFor (account) {
    return roundCoin(this.#marginSum(account.positions) + this.#frozenSum(account.orders))
  }

  #marginSum (positions) {
    let sum = 0
    for (const position of positions) sum = roundCoin(sum + position.margin)
    return sum
  }

  #frozenSum (orders) {
    let sum = 0
    for (const order of orders) sum = roundCoin(sum + order.marginFrozen)
    return sum
  }

  #weekStartOf (at) {
    const start = startOfWeek(at)
    return Number.isFinite(start) ? start : 0
  }

  /** 本周已实现盈亏：跨周之后旧数字不算数（读的时候不写账，等下一笔成交再滚）。 */
  #weekPnl (at) {
    if (this.#state.week.start !== this.#weekStartOf(at)) return 0
    return roundCoin(this.#state.week.pnl)
  }

  #bookPnl (pnl, at) {
    const start = this.#weekStartOf(at)
    if (this.#state.week.start !== start) this.#state.week = { start, pnl: 0 }
    this.#state.week.pnl = roundCoin(this.#state.week.pnl + pnl)
  }

  /** 成交流水：最新在前，硬截 50 条（盘上不留无限增长的账）。 */
  #recordTrade (trade) {
    this.#state.trades.unshift(trade)
    if (this.#state.trades.length > FUTURES_TRADE_LIMIT) this.#state.trades.length = FUTURES_TRADE_LIMIT
  }

  /** 票 96：远端账户的成交流水，与本地同一截断规则。 */
  #recordRemoteTrade (account, trade) {
    if (!Array.isArray(account.trades)) account.trades = []
    account.trades.unshift(trade)
    if (account.trades.length > FUTURES_TRADE_LIMIT) account.trades.length = FUTURES_TRADE_LIMIT
  }

  #chargeFee (fee) {
    const split = feeSplitOf(fee)
    this.#state.fees.insurance = roundCoin(this.#state.fees.insurance + split.insurance)
    this.#state.fees.burned = roundCoin(this.#state.fees.burned + split.burned)
  }

  #view () {
    return {
      balance: roundCoin(this.#state.balance),
      marginUsed: roundCoin(this.#state.marginUsed),
      equity: roundCoin(this.#state.balance + this.#state.marginUsed)
    }
  }

  #persist () {
    if (this.#state.epoch === '') this.#state.epoch = randomUUID()
    const run = this.#writeChain.then(() => this.#write())
    this.#writeChain = run.then(() => {}, () => {})
    return run
  }

  async #write () {
    const target = join(this.#dir, FUTURES_FILE)
    const tmp = target + '.tmp-' + randomUUID()
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      const body = JSON.stringify(toFileState(this.#state), null, 2) + '\n'
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, target)
      return true
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      this.#warnOnce('write', '期货账本写不进去：本次运行仍能交易，但重启后可能丢（' + errorName(error) + '）')
      return false
    }
  }

  #warnOnce (key, message) {
    if (this.#warned.has(key)) return
    this.#warned.add(key)
    try {
      this.#log?.warn?.(message)
    } catch {
      // 日志不能反过来把插件搞穿
    }
  }
}

/** 单机默认指数：作物底价。联机时由 service 换成交易所的局域网加权指数。 */
function defaultIndexOf (cropId) {
  return isCropId(cropId) ? CROPS[cropId].base : null
}
