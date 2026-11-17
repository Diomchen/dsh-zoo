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
 *     "week": { "start": 1763251200000, "pnl": 12.5 },  // 本周已实现盈亏（票 93 顶部展示）
 *     "closed": 0,                             // 平掉/交割的累计笔数（只用于展示）
 *     "tradedAt": 0                            // 最后一笔动钱的时刻
 *   }
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
import { MAX_COINS } from './farm.js'
import { parseJsonText } from './json-text.js'
import {
  SLOT_MS,
  contractOf,
  contractWindowOf,
  fairPriceOf,
  feeSplitOf,
  fillPriceOf,
  isFuturesLeverage,
  isFuturesSide,
  isMarginAmount,
  lotsFor,
  marginOf,
  notionalOf,
  pnlOf,
  quotesOf,
  roundCoin,
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
    week: { start: 0, pnl: 0 },
    closed: 0,
    tradedAt: 0
  }
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
    week: { start: 0, pnl: 0 },
    quotes: {}
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
  const kind = raw.kind === 'close' ? 'close' : raw.kind === 'open' ? 'open' : null
  if (at === null || at <= 0 || crop === null || contract === null || side === null) return null
  if (lots === null || price === null || price <= 0 || fee === null || kind === null) return null
  return { at, crop, contract: contract.id, side, lots, price, fee, kind }
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

  const closed = value.closed === undefined ? 0 : positiveInt(value.closed, MAX_QUANTITY)
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

  // 保证金是「从余额划走的钱」：仓位丢了、保证金还在，账会凭空多钱或少钱。
  // 托盘里的仓位总额才是真相，marginUsed 以它为准（与 farm 的坏账处理同一取舍）。
  const expectedMargin = roundCoin(state.positions.reduce((sum, position) => sum + position.margin, 0))
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
    week: { start: state.week.start, pnl: roundCoin(state.week.pnl) },
    closed: state.closed,
    tradedAt: state.tradedAt
  }
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
      return
    }

    let raw
    try {
      raw = parseJsonText(text)
    } catch {
      this.#warnOnce('parse', '期货账本不是合法 JSON，先按空市场运行')
      this.#state = initialFuturesState()
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
  snapshot ({ at = this.#nowMs(), positionLimit = FUTURES_VIEW_POSITIONS, tradeLimit = FUTURES_VIEW_TRADES } = {}) {
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
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
      week: { start: this.#weekStartOf(stamp), pnl: this.#weekPnl(stamp) },
      quotes,
      now: stamp
    }
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

  /** 吃单开仓：做多吃卖一、做空吃买一；保证金与手续费当场从余额划走。 */
  async open ({ crop, side, margin, leverage, at = this.#nowMs() }) {
    if (!isCropId(crop)) return { ok: false, error: 'bad-crop' }
    if (!isFuturesSide(side)) return { ok: false, error: 'bad-side' }
    if (!isMarginAmount(margin)) return { ok: false, error: 'bad-margin' }
    if (!isFuturesLeverage(leverage)) return { ok: false, error: 'bad-leverage' }
    const stamp = Number(at)
    const quote = this.quoteOf(crop, stamp)
    if (quote === null) return { ok: false, error: 'market-closed' }
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
      const settleAt = position.settleSlot * SLOT_MS
      if (!(settleAt <= stamp)) continue
      const window = contractWindowOf(position.contract)
      if (window === null) continue
      // 到期那一根没有「下一根」了：按到期前一毫秒的价结算，否则周五最后一根的仓位
      // 会因为 contractOf() 在到期后返回 null 而永远结不掉。
      const priceAt = Math.min(settleAt, window.expireAt - 1)
      const price = this.#fairAt(position.crop, position.contract, priceAt)
      if (price === null) continue // 没有指数的作物不结（账本不动，下一拍再试）
      const pnl = pnlOf({ lots: position.lots, entry: position.entry, exit: price, side: position.side })
      const liquidated = roundCoin(position.margin + pnl) <= 0
      if (liquidated) {
        // 亏光保证金：保证金没收，仓位删除（票 97 会把这条路径做细）
        this.#state.positions.splice(i, 1)
        this.#state.marginUsed = this.#recomputeMarginUsed()
        this.#state.closed += 1
        // 本周盈亏记「整块保证金」（钱在开仓时就已经划走了，这里记的是它的去向）。
        this.#bookPnl(roundCoin(-position.margin), priceAt)
        settled.push({
          position: { ...position },
          price,
          pnl,
          credit: 0,
          liquidated: true,
          at: priceAt
        })
        continue
      }
      this.#state.balance = roundCoin(this.#state.balance + pnl)
      position.entry = price
      position.settleSlot = this.#slotOf(priceAt) + 1
      this.#state.tradedAt = priceAt
      this.#bookPnl(pnl, priceAt)
      settled.push({
        position: { ...position },
        price,
        pnl,
        credit: pnl,
        liquidated: false,
        at: priceAt
      })
    }
    if (settled.length === 0) return { ok: true, action: 'futures-settle', settled }
    const persisted = await this.#persist()
    return { ok: true, action: 'futures-settle', settled, ...this.#view(), persisted }
  }

  /** 某个合约在某一刻的公允价：用仓位自己的合约，不被「本周合约」顶替。 */
  #fairAt (crop, contractId, at) {
    const indexPrice = this.#indexOf(crop)
    const price = fairPriceOf({ indexPrice, crop, contractId, at })
    return price === null ? null : roundCoin(price)
  }

  /** 保证金占用一律以仓位为准：删仓位之后不会留下凭空冻结的钱。 */
  #recomputeMarginUsed () {
    let sum = 0
    for (const position of this.#state.positions) sum = roundCoin(sum + position.margin)
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
