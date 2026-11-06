import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CROPS, CROP_IDS, isCropId, MINUTE_MS } from './farm-rules.js'
import { parseJsonText } from './json-text.js'

/**
 * 本机交易所（ticket 41）：`<dataDir>/market.json`。
 *
 * 形状（SPEC v5「存储」）：
 *   {
 *     "version": 1,
 *     "prices": { "tomato": { "base": 5, "price": 5.2, "volume24h": 12, "at": 1700000000000 } },
 *     "history": [ { "crop": "tomato", "side": "sell", "qty": 3, "price": 4, "at": 1700000000000 } ],
 *     "index": { "tomato": { "price": 5.1, "at": 1700000000000, "samples": 2 } }
 *   }
 *
 * 三条产品规则决定这里的形状：
 *   - **永远是本机做市**：买种子按表里的固定价，卖作物走本机 `bid`，永远有流动性；
 *   - **卖多了价跌**：每卖一次按数量冲击价格，每 10 分钟向 base 均值回归 3%；
 *   - **价格夹在 [base×0.5, base×2]**：手改文件也不能把交易所推到离谱的价位。
 *
 * v1 的 `effective = price`；`index` 只是先把文件形状固定下来，ticket 42 才填局域网行情。
 *
 * 容错与 `src/farm.js` / `src/backpack.js` 同一套路：
 *   - 文件不存在：按作物表建初始价，不告警、不落盘；
 *   - 文件损坏/形状不对：初始交易所 + 每个原因只告警一次；
 *   - `prices` 逐作物修补、`history`/`index` 逐条修补；
 *   - 写盘串行 + tmp/rename；写失败只告警一次（本次运行内存里照常）。
 *
 * 账本**绝不能**放进 `gifts/`（那里的配额清理会按最旧删目录）。
 */

export const MARKET_FILE = 'market.json'
export const MARKET_VERSION = 1
/** 成交历史最多 200 笔；`/state` 与交易所页只取最近 50 笔。 */
export const MAX_MARKET_HISTORY = 200
export const MARKET_VIEW_HISTORY = 50
/** 单次买卖 1–99 个；每分钟最多 10 笔。 */
export const MIN_TRADE_QTY = 1
export const MAX_TRADE_QTY = 99
export const TRADE_LIMIT = 10
export const TRADE_WINDOW_MS = MINUTE_MS

/** 卖价冲击：卖 20 个跌 12%；均值回归每 10 分钟回 3%。 */
export const SELL_IMPACT_RATE = 0.12
export const SELL_IMPACT_QTY = 20
export const REVERSION_INTERVAL_MS = 10 * MINUTE_MS
export const MEAN_REVERSION_RATE = 0.03
/** 价格永远夹在 base 的 0.5×–2×；bid = round(effective × 0.9)。 */
export const PRICE_FLOOR_RATIO = 0.5
export const PRICE_CEIL_RATIO = 2
export const BID_RATIO = 0.9

const SIDES = Object.freeze(['buy', 'sell'])
const MAX_HISTORY_PRICE = 1_000_000_000

function finiteNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function nonNegativeInt (value, max = Number.MAX_SAFE_INTEGER) {
  const num = finiteNumber(value)
  if (num === null) return null
  return Math.min(max, Math.max(0, Math.floor(num)))
}

function normalizeTimestamp (value) {
  const num = finiteNumber(value)
  if (num === null || num <= 0) return null
  return Math.floor(num)
}

export function isTradeSide (value) {
  return typeof value === 'string' && SIDES.includes(value)
}

/** 数量只认 1–99 的整数；字符串数字也接受（HTTP/JSON 手写都常见）。 */
export function normalizeTradeQty (value) {
  const num = finiteNumber(value)
  if (num === null || !Number.isInteger(num)) return null
  if (num < MIN_TRADE_QTY || num > MAX_TRADE_QTY) return null
  return num
}

/** 作物底价；表是唯一真相。 */
export function basePriceOf (cropId) {
  return isCropId(cropId) ? CROPS[cropId].base : 0
}

/** 价格夹在 [base×0.5, base×2]。坏 base/价格时退回一个安全值，绝不给出 NaN。 */
export function clampPrice (price, base) {
  const anchor = Number(base)
  const value = Number(price)
  if (!Number.isFinite(anchor) || anchor <= 0) {
    return Number.isFinite(value) && value > 0 ? value : 0
  }
  if (!Number.isFinite(value)) return anchor
  return Math.min(anchor * PRICE_CEIL_RATIO, Math.max(anchor * PRICE_FLOOR_RATIO, value))
}

/**
 * 成交价（v1 的 `effective` = price）。ticket 42 会把局域网指数混进来；
 * 成交那一刻仍按本机价格，指数只影响展示与背货套利。
 */
export function effectivePrice (price) {
  const value = Number(price)
  if (!Number.isFinite(value) || value <= 0) return 0
  return value
}

/** 交易所买价：`bid = round(effective × 0.9)`。 */
export function bidPrice (price) {
  return Math.round(effectivePrice(price) * BID_RATIO)
}

/** 卖 `qty` 个之后的 price：`price × (1 − 0.12 × qty / 20)`，再夹取。 */
export function sellImpactPrice (price, base, qty) {
  const current = clampPrice(price, base)
  const count = normalizeTradeQty(qty)
  if (count === null) return current
  const factor = 1 - SELL_IMPACT_RATE * count / SELL_IMPACT_QTY
  return clampPrice(current * factor, base)
}

/** 均值回归：每步 `price += (base − price) × 0.03`；steps 次复合。 */
export function meanRevertPrice (price, base, steps = 1) {
  let current = clampPrice(price, base)
  const count = nonNegativeInt(steps, 1_000_000)
  if (count === null || count <= 0) return current
  for (let index = 0; index < count; index += 1) {
    current = clampPrice(current + (Number(base) - current) * MEAN_REVERSION_RATE, base)
  }
  return current
}

/** 初始价：三种作物都从表里的 base 起步。 */
export function initialMarketState (at = null) {
  const stamp = normalizeTimestamp(at)
  const prices = {}
  for (const cropId of CROP_IDS) {
    const base = CROPS[cropId].base
    prices[cropId] = { base, price: base, volume24h: 0, at: stamp }
  }
  return { version: MARKET_VERSION, prices, history: [], index: {} }
}

/**
 * 状态出口/交易所页的只读视图。
 * `withBid` 只给窗口用：`/state.market` 保持 SPEC 的 prices 形状，不额外发明字段。
 */
export function marketView (state, { historyLimit = MAX_MARKET_HISTORY, withBid = false } = {}) {
  const source = state ?? initialMarketState()
  const prices = {}
  for (const cropId of CROP_IDS) {
    const entry = source.prices?.[cropId]
    if (entry === undefined) {
      const base = CROPS[cropId].base
      prices[cropId] = { base, price: base, volume24h: 0, at: null, ...(withBid ? { bid: bidPrice(base) } : {}) }
      continue
    }
    prices[cropId] = {
      base: entry.base,
      price: entry.price,
      volume24h: entry.volume24h,
      at: entry.at,
      ...(withBid ? { bid: bidPrice(entry.price) } : {})
    }
  }
  const index = {}
  for (const cropId of CROP_IDS) {
    const entry = source.index?.[cropId]
    if (entry !== undefined) index[cropId] = { ...entry }
  }
  const limit = Number.isFinite(Number(historyLimit))
    ? Math.max(0, Math.floor(Number(historyLimit)))
    : MAX_MARKET_HISTORY
  return {
    prices,
    index,
    history: (Array.isArray(source.history) ? source.history : [])
      .slice(0, limit)
      .map((entry) => ({ ...entry }))
  }
}

/** 启动早期（store 还没读出来）也要有完整形状，不能给 undefined。 */
export function initialMarketView ({ withBid = false } = {}) {
  return marketView(initialMarketState(), { withBid })
}

// ---------------------------------------------------------------------------
// 归一化：读回来的白名单。坏的价格/历史/指数条目各自修，绝不让脏值进内存。
// ---------------------------------------------------------------------------

function normalizePriceEntry (cropId, value) {
  const base = CROPS[cropId].base
  // 文件里少写一种作物不算损坏：按作物表补默认价，和缺文件同一条规则。
  if (value === undefined) {
    return { entry: { base, price: base, volume24h: 0, at: null }, repaired: 0 }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { entry: { base, price: base, volume24h: 0, at: null }, repaired: 1 }
  }

  let repaired = 0
  // base 以作物表为准：手改文件只能改价格，不能把交易所的锚点改没。
  if (value.base !== undefined) {
    const rawBase = finiteNumber(value.base)
    if (rawBase === null || rawBase !== base) repaired += 1
  }

  let price = base
  if (value.price !== undefined) {
    const rawPrice = finiteNumber(value.price)
    if (rawPrice === null) repaired += 1
    else price = clampPrice(rawPrice, base)
  }

  let volume24h = 0
  if (value.volume24h !== undefined) {
    const volume = nonNegativeInt(value.volume24h, Number.MAX_SAFE_INTEGER)
    if (volume === null) repaired += 1
    else volume24h = volume
  }

  let at = null
  if (value.at !== undefined && value.at !== null) {
    at = normalizeTimestamp(value.at)
    if (at === null) repaired += 1
  }

  for (const key of Object.keys(value)) {
    if (key !== 'base' && key !== 'price' && key !== 'volume24h' && key !== 'at') repaired += 1
  }

  return { entry: { base, price, volume24h, at }, repaired }
}

function normalizePrices (value) {
  if (value === undefined) return { prices: initialMarketState().prices, repaired: 0 }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { prices: initialMarketState().prices, repaired: 1 }
  }

  const prices = {}
  let repaired = 0
  for (const cropId of CROP_IDS) {
    const normalized = normalizePriceEntry(cropId, value[cropId])
    prices[cropId] = normalized.entry
    repaired += normalized.repaired
  }
  for (const key of Object.keys(value)) {
    if (!isCropId(key)) repaired += 1
  }
  return { prices, repaired }
}

function normalizeHistoryEntry (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (!isCropId(value.crop)) return null
  if (!isTradeSide(value.side)) return null
  const at = normalizeTimestamp(value.at)
  if (at === null) return null
  const rawQty = finiteNumber(value.qty)
  if (rawQty === null) return null
  const qty = Math.min(MAX_TRADE_QTY, Math.max(MIN_TRADE_QTY, Math.floor(rawQty)))
  const rawPrice = finiteNumber(value.price)
  if (rawPrice === null || rawPrice < 0) return null
  const price = Math.min(MAX_HISTORY_PRICE, Math.floor(rawPrice))
  return { crop: value.crop, side: value.side, qty, price, at }
}

function normalizeHistory (value) {
  if (value === undefined) return { history: [], repaired: 0 }
  if (!Array.isArray(value)) return { history: [], repaired: 1 }

  const history = []
  let repaired = 0
  for (const candidate of value) {
    const entry = normalizeHistoryEntry(candidate)
    if (entry === null) {
      repaired += 1
      continue
    }
    history.push(entry)
  }
  history.sort((left, right) => right.at - left.at)
  if (history.length > MAX_MARKET_HISTORY) {
    repaired += history.length - MAX_MARKET_HISTORY
    history.length = MAX_MARKET_HISTORY
  }
  return { history, repaired }
}

function normalizeIndexEntry (cropId, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const rawPrice = finiteNumber(value.price)
  if (rawPrice === null || rawPrice < 0) return null
  const at = normalizeTimestamp(value.at)
  if (at === null) return null
  const samples = nonNegativeInt(value.samples, 1_000_000)
  return {
    price: clampPrice(rawPrice, CROPS[cropId].base),
    at,
    samples: samples === null ? 0 : samples
  }
}

function normalizeIndex (value) {
  if (value === undefined) return { index: {}, repaired: 0 }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { index: {}, repaired: 1 }
  }

  const index = {}
  let repaired = 0
  for (const cropId of CROP_IDS) {
    if (value[cropId] === undefined) continue
    const entry = normalizeIndexEntry(cropId, value[cropId])
    if (entry === null) repaired += 1
    else index[cropId] = entry
  }
  for (const key of Object.keys(value)) {
    if (!isCropId(key)) repaired += 1
  }
  return { index, repaired }
}

/**
 * 读整份 `market.json`。返回 `{ market, corrupt, repaired }`：
 *   - `corrupt` = 不是对象 / 版本不认识，调用方按初始交易所处理并告警一次；
 *   - `repaired` = 单项价格/成交/指数被修补或丢弃的数量，只用于告警一次；
 *   - 单个坏条目只丢自己，不拖垮另外两种作物。
 */
export function normalizeMarketFile (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { market: initialMarketState(), corrupt: true, repaired: 0 }
  }
  if (value.version !== undefined && value.version !== MARKET_VERSION) {
    return { market: initialMarketState(), corrupt: true, repaired: 0 }
  }

  const prices = normalizePrices(value.prices)
  const history = normalizeHistory(value.history)
  const index = normalizeIndex(value.index)
  return {
    market: {
      version: MARKET_VERSION,
      prices: prices.prices,
      history: history.history,
      index: index.index
    },
    corrupt: false,
    repaired: prices.repaired + history.repaired + index.repaired
  }
}

function toFileState (state) {
  return {
    version: MARKET_VERSION,
    prices: Object.fromEntries(CROP_IDS.map((cropId) => {
      const entry = state.prices[cropId]
      return [cropId, {
        base: entry.base,
        price: entry.price,
        volume24h: entry.volume24h,
        at: entry.at
      }]
    })),
    history: state.history.map((entry) => ({
      crop: entry.crop,
      side: entry.side,
      qty: entry.qty,
      price: entry.price,
      at: entry.at
    })),
    index: Object.fromEntries(CROP_IDS
      .filter((cropId) => state.index[cropId] !== undefined)
      .map((cropId) => [cropId, { ...state.index[cropId] }]))
  }
}

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}

/**
 * 打开（或创建）交易所 store。读盘失败不抛：调用方拿到的是一份能交易的初始交易所，
 * 只在日志里留一条警告。`now` 只为测试注入，生产不传就是 Date.now。
 */
export async function createMarketStore (dir, { log, now = Date.now } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('market: missing data directory')
  const store = new MarketStore({ dir, log, now })
  await store.load()
  return store
}

class MarketStore {
  #dir
  #log
  #now
  #state = initialMarketState()
  #warned = new Set()
  /** 串行化写盘：同一毫秒里的两笔成交不能互相写掉对方的历史/价格。 */
  #writeChain = Promise.resolve()
  /** 每分钟最多 10 笔；只活在本次运行里（重启不该继承「刚才太忙」）。 */
  #tradeAt = []
  /** 均值回归的锚点：每满 10 分钟推进一次；不落盘，重启后从这一刻重新计时。 */
  #lastRevertAt = Number.NEGATIVE_INFINITY

  constructor ({ dir, log, now }) {
    this.#dir = dir
    this.#log = log
    const clock = typeof now === 'function' ? now : () => now
    this.#now = () => {
      const stamp = Number(clock())
      return Number.isFinite(stamp) ? stamp : Date.now()
    }
  }

  async load () {
    const now = this.#nowMs()
    this.#lastRevertAt = now

    let text
    try {
      text = await readFile(join(this.#dir, MARKET_FILE), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warnOnce('read', '交易所读不出来，先按初始行情运行（' + errorName(error) + '）')
      }
      this.#state = initialMarketState(now)
      return
    }

    let raw
    try {
      raw = parseJsonText(text)
    } catch {
      this.#warnOnce('parse', '交易所不是合法 JSON，先按初始行情运行')
      this.#state = initialMarketState(now)
      return
    }

    const normalized = normalizeMarketFile(raw)
    this.#state = normalized.market
    if (normalized.corrupt) {
      this.#warnOnce('shape', '交易所形状不对，先按初始行情运行')
    } else if (normalized.repaired > 0) {
      this.#warnOnce('entries', '交易所有 ' + normalized.repaired + ' 处格式不对，已按默认值修补')
    }
  }

  /** 只读视图：调用方可以随便改返回值，改不到 store。 */
  snapshot () {
    return marketView(this.#state, { historyLimit: MAX_MARKET_HISTORY })
  }

  /** 均值回归：每 10 分钟把价格往 base 拉 3%；没有满 10 分钟不写盘。 */
  tick () {
    const now = this.#nowMs()
    const steps = this.#revert(now)
    if (steps <= 0) return Promise.resolve(false)
    return this.#persist().then((persisted) => persisted === true)
  }

  /**
   * 成交的唯一入口：先夹取/限速，再更新价格与历史，最后排队落盘。
   * **同步**修改内存，调用方（FarmStore）可以在同一个同步段里接着改硬币/仓库，
   * 两本账不会在 await 之间被 tick 插进来。返回的 `persisted` 是写盘 Promise。
   */
  applyTrade ({ side, cropId, qty, now } = {}) {
    if (!isTradeSide(side)) return { ok: false, error: 'bad-trade', persisted: false }
    if (!isCropId(cropId)) return { ok: false, error: 'bad-crop', persisted: false }
    const count = normalizeTradeQty(qty)
    if (count === null) return { ok: false, error: 'bad-qty', persisted: false }

    const stamp = Number.isFinite(Number(now)) && Number(now) > 0 ? Math.floor(Number(now)) : this.#nowMs()
    this.#tradeAt = this.#tradeAt.filter((at) => stamp - at < TRADE_WINDOW_MS)
    if (this.#tradeAt.length >= TRADE_LIMIT) {
      return { ok: false, error: 'market-busy', persisted: false }
    }

    // 到点了但 tick 还没跑：成交前先把这 10 分钟的均值回归补上。
    this.#revert(stamp)
    const entry = this.#state.prices[cropId]
    const priceBefore = entry.price
    let unitPrice
    if (side === 'sell') {
      // 这一笔按成交前的 bid 结算；数量冲击只影响下一笔（和现实做市商一样）。
      unitPrice = bidPrice(priceBefore)
      entry.price = sellImpactPrice(priceBefore, entry.base, count)
      entry.at = stamp
    } else {
      // 种子按表里的固定价卖；买种子不影响作物价（未来供应市场看不见）。
      unitPrice = CROPS[cropId].seedPrice
    }
    entry.volume24h = Math.min(Number.MAX_SAFE_INTEGER, entry.volume24h + count)

    const trade = {
      crop: cropId,
      side,
      qty: count,
      price: unitPrice,
      at: stamp
    }
    this.#state.history.unshift(trade)
    if (this.#state.history.length > MAX_MARKET_HISTORY) {
      this.#state.history.length = MAX_MARKET_HISTORY
    }
    this.#tradeAt.push(stamp)

    return {
      ok: true,
      side,
      cropId,
      qty: count,
      unitPrice,
      total: unitPrice * count,
      priceBefore,
      priceAfter: entry.price,
      at: stamp,
      trade: { ...trade },
      persisted: this.#persist()
    }
  }

  #nowMs () {
    return this.#now()
  }

  /** 推进已到期的均值回归；返回推进了几个 10 分钟。 */
  #revert (now) {
    const current = Number(now)
    const anchor = this.#lastRevertAt
    if (!Number.isFinite(current) || !Number.isFinite(anchor)) return 0
    if (current - anchor < REVERSION_INTERVAL_MS) return 0
    const steps = Math.floor((current - anchor) / REVERSION_INTERVAL_MS)
    if (steps <= 0) return 0
    this.#lastRevertAt = anchor + steps * REVERSION_INTERVAL_MS
    for (const cropId of CROP_IDS) {
      const entry = this.#state.prices[cropId]
      const next = meanRevertPrice(entry.price, entry.base, steps)
      if (next !== entry.price) {
        entry.price = next
        entry.at = current
      }
    }
    return steps
  }

  #persist () {
    const run = this.#writeChain.then(() => this.#write())
    this.#writeChain = run.then(() => {}, () => {})
    return run
  }

  async #write () {
    const target = join(this.#dir, MARKET_FILE)
    const tmp = target + '.tmp-' + randomUUID()
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      const body = JSON.stringify(toFileState(this.#state), null, 2) + '\n'
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
      // 同目录 rename 是原子的：不会留下半个交易所，也不会读到写了一半的 JSON。
      await rename(tmp, target)
      return true
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      this.#warnOnce('write', '交易所写不进去：本次运行仍然能交易，但重启后可能丢（' + errorName(error) + '）')
      return false
    }
  }

  #warnOnce (key, message) {
    if (this.#warned.has(key)) return
    this.#warned.add(key)
    try {
      this.#log?.warn?.(message)
    } catch {
      // 日志不能反过来把插件搞崩
    }
  }
}
