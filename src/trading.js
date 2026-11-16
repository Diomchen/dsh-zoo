/**
 * 盘口账本（票 79/80）：`<dataDir>/trading.json` v1。
 *
 * 形状（SPEC v10「硬币与账本」）：
 *   {
 *     "version": 1,
 *     "week": { "start": 1763308800000, "pnl": 0, "base": 30 },
 *     "positions": [
 *       { "id": "…", "crop": "tomato", "side": "long", "margin": 50, "leverage": 5,
 *         "entry": 5.12, "openedAt": 1763308800000, "slot": 1959232, "stopLoss": 0.5,
 *         "settling": { "at": 1763309700000, "exit": 5.3, "pnl": 8, "credit": 58, "reason": "close" } }
 *     ],
 *     "orders": [
 *       { "id": "…", "crop": "tomato", "side": "long", "target": 4.8, "margin": 50,
 *         "leverage": 5, "placedAt": 1763308800000, "slot": 1959232,
 *         "refunding": { "at": 1763309700000 } }
 *     ],
 *     "history": [
 *       { "id": "…", "crop": "tomato", "side": "long", "margin": 50, "leverage": 5,
 *         "entry": 5.12, "exit": 5.3, "pnl": 8, "reason": "liquidate", "at": 1763309700000 }
 *     ]
 *   }
 *
 * 三条产品规则决定这里的形状：
 *   - **钱包是农场硬币**（`farm.json` 的 coins），这里不存余额、不加锁币字段：
 *     开仓 `spendCoins(margin)`（当场扣），结算 `credit = margin + pnl` 时 `addCoins`；
 *     窗口里的「含锁定 + 未实现」只是展示层加回，farm.json 一直只有可用硬币。
 *   - **周一 00:00 只清本周盈亏**：`week.pnl` 存已实现，`week.base` 是这一周开始时的
 *     可用硬币（收益率的分母）；硬币一分不动。
 *   - **结算幂等**：先写 `settling` 意图再动钱，再记历史/删仓位；启动时看到 `settling`
 *     只补后半段，绝不重复铸币（与 `src/contracts.js` 的 beginSettle/finishSettle 同源，
 *     宁可少退一次也不重复发钱）。
 *
 * 票 80 只做**加法**（`version` 还是 1）：每个仓位多存一个 `stopLoss` 档位；
 * 强平价不落盘——它由 `side + entry + leverage` 现算（`liquidationPriceOf`），
 * 存一份就会和改过的 entry/杠杆对不上。逐分钟的强平/止损检查全在 `pathScan()`：
 * tick、插针、快进时钟、离线补算走同一条路，账本这里只负责「先写意图再动钱」。
 *
 * 票 83 的到价挂单同样是**加法**（`version` 仍为 1，老文件 orders 缺省 = 空数组）：
 * 挂单在**下单那一刻**就 `spendCoins(margin)` 把保证金锁进农场，所以成交时不用再动钱，
 * 也不可能出现「到价了但硬币不够」；成交只把订单换成仓位（同一次写盘，原子）。
 * 退款是跨文件的（farm.json），照抄结算的意图模式：先写 `refunding` 再 `addCoins`，
 * 再删单落盘；启动时看到 `refunding` 只补删单、**绝不再退一次**。
 * 挂单/撤单/到期都不进历史——历史只记「平掉的仓位」。
 *
 * 容错与 `src/farm.js` / `src/market.js` 同一套路：
 *   - 文件不存在：空盘口（本周从此刻起算），不告警；
 *   - 文件损坏/形状不对：空盘口 + 只告警一次；**农场硬币不动**（锁定中的保证金按坏账处理）；
 *   - 坏持仓/坏历史只丢自己，整份坏才归零；
 *   - 写盘串行 + tmp/rename；写失败只告警一次（本次运行内存里照常）。
 *
 * 账本**绝不能**放进 `gifts/`（那里的配额清理会按最旧删目录）。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MAX_COINS } from './farm.js'
import { parseJsonText } from './json-text.js'
import {
  BOARD_CROPS,
  MAX_MARGIN,
  SLOT_MS,
  TRADING_CLOSE_REASONS,
  isBoardCrop,
  isBoardSide,
  isMarginAmount,
  isOrderTarget,
  isStopLossLevel,
  isStoredLeverage,
  isTradingLeverage,
  limitFillScan,
  liquidationPriceOf,
  markPrice,
  pathScan,
  pnlOf,
  settlementOf,
  slotClosePrice,
  slotIndexAt,
  weekStartOf
} from './trading-rules.js'

/** 结算原因的枚举住在纯规则里；这里原样转出，票 79 的调用方不用改 import。 */
export { TRADING_CLOSE_REASONS }

export const TRADING_FILE = 'trading.json'
export const TRADING_VERSION = 1
/** 结算历史最多 200 条；`/state` 与盘口窗只取最近 50 条。 */
export const MAX_TRADING_HISTORY = 200
export const TRADING_VIEW_HISTORY = 50
/** 写盘节流：tick 有变化也最多每 30 秒落一次；开/平/结算这些动钱的动作总是立即落盘。 */
export const SAVE_THROTTLE_MS = 30 * 1000
const MAX_PRICE = 1_000_000_000
const MAX_ID_LENGTH = 64

function finiteNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  return null
}

function strictInt (value, min, max) {
  const num = finiteNumber(value)
  if (num === null || !Number.isInteger(num)) return null
  return num < min || num > max ? null : num
}

function positiveNumber (value, max = MAX_PRICE) {
  const num = finiteNumber(value)
  if (num === null || num <= 0 || num > max) return null
  return num
}

function timestamp (value) {
  const num = finiteNumber(value)
  if (num === null || num <= 0) return null
  return Math.floor(num)
}

function normalizeId (value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id === '' || id.length > MAX_ID_LENGTH ? null : id
}

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}

function emptyWeek () {
  return { start: null, pnl: 0, base: 0 }
}

/** 空盘口：store 还没读出来时也要有完整形状，绝不 undefined。 */
export function initialTradingView () {
  return {
    week: { start: 0, pnl: 0, base: 0 },
    positions: [],
    orders: [],
    history: [],
    locked: 0,
    unrealized: 0
  }
}

function initialTradingState (now, base) {
  return {
    version: TRADING_VERSION,
    week: { start: weekStartOf(now) ?? 0, pnl: 0, base },
    positions: [],
    orders: [],
    history: []
  }
}

function copyHistory (entry) {
  return { ...entry }
}

function copyPosition (position) {
  return position.settling === undefined
    ? { ...position }
    : { ...position, settling: { ...position.settling } }
}

function copyOrder (order) {
  return order.refunding === undefined
    ? { ...order }
    : { ...order, refunding: { ...order.refunding } }
}

// ---------------------------------------------------------------------------
// 归一化：只认白名单字段，坏条目只丢自己
// ---------------------------------------------------------------------------

function normalizeWeek (value) {
  if (value === undefined) return { week: emptyWeek(), repaired: 0 }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { week: emptyWeek(), repaired: 1 }
  }
  const start = timestamp(value.start)
  const pnl = strictInt(value.pnl, -MAX_COINS, MAX_COINS)
  const base = strictInt(value.base, 0, MAX_COINS)
  let repaired = 0
  if (value.start !== undefined && start === null) repaired += 1
  if (value.pnl !== undefined && pnl === null) repaired += 1
  if (value.base !== undefined && base === null) repaired += 1
  return {
    // start 坏掉留 null：load 会按「这不是本周」重设，而不是把上周盈亏带进来。
    week: { start, pnl: pnl === null ? 0 : pnl, base: base === null ? 0 : base },
    repaired
  }
}

function normalizeSettling (value) {
  if (value === undefined) return { settling: null, repaired: 0 }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { settling: null, repaired: 1 }
  }
  const at = timestamp(value.at)
  const exit = positiveNumber(value.exit)
  const pnl = strictInt(value.pnl, -MAX_COINS, MAX_COINS)
  const credit = strictInt(value.credit, 0, MAX_COINS)
  const reason = typeof value.reason === 'string' && TRADING_CLOSE_REASONS.includes(value.reason)
    ? value.reason
    : null
  if (at === null || exit === null || pnl === null || credit === null || reason === null) {
    return { settling: null, repaired: 1 }
  }
  return { settling: { at, exit, pnl, credit, reason }, repaired: 0 }
}

/**
 * 止损档位（票 80）：0 = 关；0.25/0.5/1 = 亏掉多少比例的保证金就平。
 * 没写 = 关（老档案天然升级，不算修补）；写了但不在这四档 = 关 + 记**一处**修补。
 * 它是认识的字段，绝不能当成「未知键」再多算一处（否则每次启动都白告警一次）。
 */
function normalizeStopLoss (value) {
  if (value === undefined) return { level: 0, repaired: 0 }
  return isStopLossLevel(value) ? { level: value, repaired: 0 } : { level: 0, repaired: 1 }
}

function normalizePosition (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const id = normalizeId(value.id)
  if (id === null) return null
  if (!isBoardCrop(value.crop)) return null
  if (!isBoardSide(value.side)) return null
  const margin = strictInt(value.margin, 1, MAX_COINS)
  if (margin === null) return null
  if (!isStoredLeverage(value.leverage)) return null
  const entry = positiveNumber(value.entry)
  if (entry === null) return null
  const openedAt = timestamp(value.openedAt)
  if (openedAt === null) return null
  const settling = normalizeSettling(value.settling)
  const stopLoss = normalizeStopLoss(value.stopLoss)
  return {
    position: {
      id,
      crop: value.crop,
      side: value.side,
      margin,
      leverage: value.leverage,
      entry,
      openedAt,
      // slot 是**派生字段**：按 openedAt 重算，文件里写错了也不信。
      slot: slotIndexAt(openedAt),
      stopLoss: stopLoss.level,
      ...(settling.settling === null ? {} : { settling: settling.settling })
    },
    repaired: settling.repaired + stopLoss.repaired
  }
}

function normalizePositions (value) {
  if (value === undefined) return { positions: [], repaired: 0 }
  if (!Array.isArray(value)) return { positions: [], repaired: 1 }
  const positions = []
  let repaired = 0
  for (const candidate of value) {
    const normalized = normalizePosition(candidate)
    if (normalized === null) {
      repaired += 1
      continue
    }
    // 文件里的 slot 与实际 openedAt 对不上也算一处修补（不影响可用性）。
    if (candidate.slot !== undefined && candidate.slot !== normalized.position.slot) repaired += 1
    positions.push(normalized.position)
    repaired += normalized.repaired
  }
  return { positions, repaired }
}

function normalizeHistoryEntry (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const id = normalizeId(value.id)
  if (id === null) return null
  if (!isBoardCrop(value.crop)) return null
  if (!isBoardSide(value.side)) return null
  const margin = strictInt(value.margin, 1, MAX_COINS)
  if (margin === null) return null
  if (!isStoredLeverage(value.leverage)) return null
  const entry = positiveNumber(value.entry)
  const exit = positiveNumber(value.exit)
  if (entry === null || exit === null) return null
  const pnl = strictInt(value.pnl, -MAX_COINS, MAX_COINS)
  if (pnl === null) return null
  if (typeof value.reason !== 'string' || !TRADING_CLOSE_REASONS.includes(value.reason)) return null
  const at = timestamp(value.at)
  if (at === null) return null
  return {
    id,
    crop: value.crop,
    side: value.side,
    margin,
    leverage: value.leverage,
    entry,
    exit,
    pnl,
    reason: value.reason,
    at
  }
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
  if (history.length > MAX_TRADING_HISTORY) {
    repaired += history.length - MAX_TRADING_HISTORY
    history.length = MAX_TRADING_HISTORY
  }
  return { history, repaired }
}

/**
 * 退款意图（票 83）：和仓位的 `settling` 同一个思路——先落盘「这笔钱要退」，
 * 再动 farm.json，再删单。启动时看到它只补删单，绝不重复 addCoins。
 * 没写 = 没有在退款；写了但 at 坏了 = 当坏字段（丢意图、记一处修补）：
 * 删除本身是幂等的，宁可少退一次也绝不重复发钱。
 */
function normalizeRefunding (value) {
  if (value === undefined) return { refunding: null, repaired: 0 }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { refunding: null, repaired: 1 }
  }
  const at = timestamp(value.at)
  if (at === null) return { refunding: null, repaired: 1 }
  return { refunding: { at }, repaired: 0 }
}

/**
 * 到价挂单（票 83）：`{ id, crop, side, target, margin, leverage, placedAt, slot }`。
 * 读盘时**能成交的形状才算数**：目标价落在带外、杠杆不在 1/5/20、保证金不是正整数的
 * 条目一律丢掉（那张单永远成交不了，留着只会一直占着锁定的保证金当坏账）。
 * 坏一条只丢自己——和坏持仓/坏历史同一条纪律。
 */
function normalizeOrder (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const id = normalizeId(value.id)
  if (id === null) return null
  if (!isBoardCrop(value.crop)) return null
  if (!isBoardSide(value.side)) return null
  const margin = strictInt(value.margin, 1, MAX_MARGIN)
  if (margin === null) return null
  if (!isTradingLeverage(value.leverage)) return null
  if (!isOrderTarget({ crop: value.crop, target: value.target })) return null
  const target = positiveNumber(value.target)
  if (target === null) return null
  const placedAt = timestamp(value.placedAt)
  if (placedAt === null) return null
  const refunding = normalizeRefunding(value.refunding)
  return {
    order: {
      id,
      crop: value.crop,
      side: value.side,
      target,
      margin,
      leverage: value.leverage,
      placedAt,
      slot: slotIndexAt(placedAt),
      ...(refunding.refunding === null ? {} : { refunding: refunding.refunding })
    },
    repaired: refunding.repaired
  }
}

function normalizeOrders (value) {
  if (value === undefined) return { orders: [], repaired: 0 }
  if (!Array.isArray(value)) return { orders: [], repaired: 1 }
  const orders = []
  let repaired = 0
  for (const candidate of value) {
    const normalized = normalizeOrder(candidate)
    if (normalized === null) {
      repaired += 1
      continue
    }
    // 和持仓一样：slot 是派生字段（按 placedAt 重算），写错只算一处修补。
    if (candidate.slot !== undefined && candidate.slot !== normalized.order.slot) repaired += 1
    orders.push(normalized.order)
    repaired += normalized.repaired
  }
  return { orders, repaired }
}

/**
 * 读整份 `trading.json`。返回 `{ state, corrupt, repaired }`：
 *   - `corrupt` = 不是对象 / 版本不认识，调用方按空盘口处理并告警一次；
 *   - `repaired` = 单条持仓/历史/字段被修补或丢弃的数量，只用于告警一次；
 *   - 单条坏持仓只丢自己，`week` 形状坏掉由 load 按「新的一周」重设。
 */
export function normalizeTradingFile (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { state: initialTradingState(0, 0), corrupt: true, repaired: 0 }
  }
  if (value.version !== undefined && value.version !== TRADING_VERSION) {
    return { state: initialTradingState(0, 0), corrupt: true, repaired: 0 }
  }
  const week = normalizeWeek(value.week)
  const positions = normalizePositions(value.positions)
  const orders = normalizeOrders(value.orders)
  const history = normalizeHistory(value.history)
  return {
    state: {
      version: TRADING_VERSION,
      week: week.week,
      positions: positions.positions,
      orders: orders.orders,
      history: history.history
    },
    corrupt: false,
    repaired: week.repaired + positions.repaired + orders.repaired + history.repaired
  }
}

function toFileState (state) {
  return {
    version: TRADING_VERSION,
    week: {
      start: state.week.start ?? 0,
      pnl: state.week.pnl,
      base: state.week.base
    },
    positions: state.positions.map(copyPosition),
    orders: state.orders.map(copyOrder),
    history: state.history.map(copyHistory)
  }
}

/**
 * 打开（或创建）盘口账本。读盘失败不抛：调用方拿到的是一份空盘口，
 * 只在日志里留一条警告。`now` 只为测试注入，生产不传就是 Date.now。
 *
 * `farm` 是农场 store（硬币是唯一钱包）：给它才能开仓/结算；不给时开仓回 `starting`。
 */
export async function createTradingStore (dir, { log, now = Date.now, farm = null } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('trading: missing data directory')
  const store = new TradingStore({ dir, log, now, farm })
  await store.load()
  return store
}

class TradingStore {
  #dir
  #log
  #farm
  #now
  #state = initialTradingState(0, 0)
  #warned = new Set()
  /**
   * 每手仓位「强平已经检查到哪一刻」（position.id → 毫秒）。**只在内存里**：
   *   - 重启后没有它 → 从 `openedAt` 重扫，离线期间撞过的强平/止损照样补出来；
   *   - 落了盘反而危险：存档里的一切都可能被人改，路径检查的起点不该由它决定。
   * 起点只影响「从哪一分钟开始算」，终点永远跟收盘对齐，所以结果依旧只由仓位与时间决定。
   *
   * 票 80 的止损另有自己的游标（`#stopFrom`），**绝不能共用这一个**：设止损是玩家在
   * 某一刻做的选择，它只该决定「止损从哪一刻起生效」；如果顺手把强平的检查进度也推到
   * 那一刻，设止损之前已经越过强平线的一段就被跳过了（评审 P0）。
   */
  #checked = new Map()
  /**
   * 每手仓位的止损生效时刻（position.id → 毫秒）。设止损/关止损都写在这里；
   * 强平游标 `#checked` 不受影响。没写过 = 从开仓那一刻起（默认关，本来也不会触发）。
   */
  #stopFrom = new Map()
  /** 串行化：同一毫秒里的两笔开/平不能互相写掉对方的仓位。 */
  #chain = Promise.resolve()
  #lastWriteAt = Number.NEGATIVE_INFINITY

  constructor ({ dir, log, now, farm }) {
    this.#dir = dir
    this.#log = log
    this.#farm = farm
    const clock = typeof now === 'function' ? now : () => now
    this.#now = () => {
      const stamp = Number(clock())
      return Number.isFinite(stamp) ? stamp : Date.now()
    }
  }

  async load () {
    const now = this.#nowMs()
    let text
    try {
      text = await readFile(join(this.#dir, TRADING_FILE), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warnOnce('read', '盘口读不出来，先按空盘口运行（' + errorName(error) + '）')
      }
      this.#state = initialTradingState(now, this.#coinBase())
      this.#rollWeek(now)
      return
    }

    let raw
    try {
      raw = parseJsonText(text)
    } catch {
      this.#warnOnce('parse', '盘口不是合法 JSON，先按空盘口运行')
      this.#state = initialTradingState(now, this.#coinBase())
      this.#rollWeek(now)
      return
    }

    const normalized = normalizeTradingFile(raw)
    this.#state = normalized.state
    if (normalized.corrupt) {
      this.#warnOnce('shape', '盘口形状不对，先按空盘口运行')
    } else if (normalized.repaired > 0) {
      this.#warnOnce('entries', '盘口里有 ' + normalized.repaired + ' 处格式不对，已按默认值修补')
    }

    // 先跨周（只清本周盈亏，硬币不动），再补结算：这次补出来的盈亏算本周的。
    const rolled = this.#rollWeek(now)
    // `settling` = 上次写完「要结算」就崩了。钱可能已经退过，按已入账处理：
    // 只补历史与本周盈亏，**绝不 addCoins**（和 contracts 的取舍一致）。
    let resumed = false
    for (const position of [...this.#state.positions]) {
      if (position.settling === undefined) continue
      this.#finishSettle(position, position.settling)
      resumed = true
    }
    // `refunding` = 上次写完「要退挂单保证金」就崩了。钱可能已经退过，
    // 这里只补删单，绝不重复 addCoins（和 settling 同一条取舍）。
    let refunded = false
    for (const order of [...this.#state.orders]) {
      if (order.refunding === undefined) continue
      const index = this.#state.orders.indexOf(order)
      if (index >= 0) this.#state.orders.splice(index, 1)
      refunded = true
    }
    // 离线期间挂单可能已经越价成交、也可能已经过了那一根：先撮合，再结算。
    // 成交出来的仓位属于它成交那一刻的 slot，下面 `#settleDue` 会照常补收盘价。
    const matched = this.#farm === null ? false : await this.#matchOrders(now)
    // 离线跨过收盘/撞过强平线：启动就把这些仓位结掉（先路径、后收盘），
    // 用户打开盘口时看到的不是「昨天还开着」的旧仓位。
    const closed = await this.#settleDue(now)
    // 坏文件不覆盖（等下一次动作/tick 再写）；补出来的补结算、跨周与修补要立刻落盘。
    if (!normalized.corrupt &&
      (resumed || refunded || matched || rolled || closed || normalized.repaired > 0)) {
      await this.#persist(true)
    }
  }

  /**
   * 只读视图：带每手仓位的现价与盈亏。窗口与 `/state` 共用这一份形状。
   * `locked` 是未平仓的保证金合计，`unrealized` 是按现价算的浮盈浮亏合计；
   * 两者都只在展示层加回硬币，`farm.json` 里始终只有可用硬币。
   */
  view ({ now = this.#nowMs(), historyLimit = TRADING_VIEW_HISTORY } = {}) {
    const stamp = Number(now)
    const at = Number.isFinite(stamp) ? stamp : this.#nowMs()
    const positions = this.#state.positions.map((position) => this.#positionView(position, at))
    const orders = this.#state.orders.map((order) => this.#orderView(order, at))
    let locked = 0
    let unrealized = 0
    for (const position of positions) {
      locked += position.margin
      unrealized += position.pnl ?? 0
    }
    // 挂单的保证金已经花出去了，但还没成交/没退：展示层要把它算回「含锁定」，
    // 否则挂一张单，顶部的「含锁定」会凭空少一笔（farm.json 里同样只有可用硬币）。
    for (const order of orders) locked += order.margin
    const limit = Number.isInteger(historyLimit) && historyLimit >= 0
      ? historyLimit
      : TRADING_VIEW_HISTORY
    return {
      week: { ...this.#state.week },
      positions,
      orders,
      history: this.#state.history.slice(0, limit).map(copyHistory),
      locked,
      unrealized
    }
  }

  /**
   * 开一手（唯一入口）：先扣硬币，再记仓位。扣钱成功而落盘失败时仍然算成功
   * （`persisted:false`），与农场动作同口径——内存里能用，只是重启可能丢。
   */
  openPosition (raw = {}) {
    return this.#enqueue(() => this.#openPosition(raw))
  }

  /** 手动平仓：按此刻的现价结算，原因记 `close`。 */
  closePosition (positionId, { reason = 'close' } = {}) {
    return this.#enqueue(() => this.#closePosition(positionId, reason))
  }

  /**
   * 一键止损（票 80）：0 = 关，0.25/0.5/1 = 亏掉这么多比例的保证金就平。
   * 只改这一档，不动钱也不动仓位；窗口负责循环档位，白名单校验在这里——
   * 别把 0.3 这种值写进账本（重启后它就成了一条永远不触发的档）。
   */
  setStopLoss (positionId, level) {
    return this.#enqueue(() => this.#setStopLoss(positionId, level))
  }

  /**
   * 挂一张到价单（票 83）：先 `spendCoins(margin)` 把保证金锁进农场，再记订单，
   * 最后写一次盘。这样成交时不用再动钱，也不会出现「到价了但硬币不够」。
   * 扣钱成功而落盘失败仍算成功（`persisted:false`）——与 `openPosition` 同一条口径。
   */
  placeOrder (raw = {}) {
    return this.#enqueue(() => this.#placeOrder(raw))
  }

  /** 手动撤单：走和到期退款同一条意图路径（先写 refunding，再退钱，再删单）。 */
  cancelOrder (orderId) {
    return this.#enqueue(() => this.#cancelOrder(orderId))
  }

  /**
   * 每分钟一拍：跨周就重设本周；还没结算的仓位先逐分钟走一遍路径（强平/止损），
   * 收过盘的再按收盘价结。返回本次是否改动了盘面（宿主据此决定要不要重推窗口）。
   */
  tick () {
    return this.#enqueue(() => this.#tick())
  }

  async #openPosition (raw) {
    const side = raw?.side
    if (!isBoardSide(side)) return tradingError('bad-side')
    // 票 83 起保证金是任意整数金额（50/100/250/全下只是窗口的预设）。
    if (!isMarginAmount(raw?.margin)) return tradingError('bad-margin')
    const leverage = raw?.leverage === undefined || raw?.leverage === null ? 1 : raw.leverage
    if (!isTradingLeverage(leverage)) return tradingError('bad-leverage')
    const crop = raw?.crop === undefined || raw?.crop === null ? BOARD_CROPS[0] : raw.crop
    if (!isBoardCrop(crop)) return tradingError('bad-crop')
    const farm = this.#farm
    if (farm === null) return tradingError('starting')

    const now = this.#nowMs()
    this.#rollWeek(now)
    if (this.#coinBase() < raw.margin) return tradingError('no-coin')
    const spent = await farm.spendCoins(raw.margin)
    if (spent?.ok !== true) {
      return tradingError(spent?.error === 'no-coin' ? 'no-coin' : 'action-failed')
    }
    // 成交价 = 扣钱那一刻的现价；算不出来（作物底价坏了）就把保证金退回去。
    const entry = markPrice({ crop, now })
    if (entry === null) {
      await farm.addCoins(raw.margin)
      return tradingError('action-failed')
    }
    const position = {
      id: randomUUID(),
      crop,
      side,
      margin: raw.margin,
      leverage,
      entry,
      openedAt: now,
      slot: slotIndexAt(now),
      // 止损默认关（SPEC：玩家工具，不是系统强加的风控）；开仓时不接受档位，只走 setStopLoss。
      stopLoss: 0
    }
    this.#state.positions.push(position)
    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'trading-open-position',
      position: this.#positionView(position, now),
      coins: this.#coinBase(),
      persisted
    }
  }

  async #closePosition (positionId, reason) {
    if (this.#farm === null) return tradingError('starting')
    if (typeof positionId !== 'string' || positionId === '') return tradingError('no-position')
    const position = this.#state.positions.find((candidate) => candidate.id === positionId)
    if (position === undefined) return tradingError('no-position')
    if (position.settling !== undefined) return tradingError('settling')
    const now = this.#nowMs()
    const exit = markPrice({ crop: position.crop, now })
    if (exit === null) return tradingError('action-failed')
    const safeReason = TRADING_CLOSE_REASONS.includes(reason) ? reason : 'close'
    return this.#settle(position, { exit, reason: safeReason, at: now })
  }

  async #setStopLoss (positionId, level) {
    if (typeof positionId !== 'string' || positionId === '') return tradingError('no-position')
    if (!isStopLossLevel(level)) return tradingError('bad-stop')
    const position = this.#state.positions.find((candidate) => candidate.id === positionId)
    if (position === undefined) return tradingError('no-position')
    // 结算中的仓位只剩「记历史」这一步，改档位没有意义（钱已经走出去了）。
    if (position.settling !== undefined) return tradingError('settling')
    const now = this.#nowMs()
    position.stopLoss = level
    // 新档位从「设下的这一刻」开始生效：不翻旧账去按更早的 mark 平
    // （那会让「刚设的止损」按一个几分钟前的价成交，说不通）。
    // 只挪止损游标；强平游标 `#checked` 不动——设止损之前越过的强平线下一拍仍要补出来。
    this.#stopFrom.set(position.id, now)
    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'trading-set-stop',
      position: this.#positionView(position, now),
      coins: this.#coinBase(),
      // 宿主回给窗口的 toast：说清「现在是哪一档」，而不是只回一个 ok。
      notice: level === 0 ? '止损已关闭。' : '止损已设为 −' + Math.round(level * 100) + '% 保证金。',
      persisted
    }
  }

  async #placeOrder (raw) {
    const crop = raw?.crop === undefined || raw?.crop === null ? BOARD_CROPS[0] : raw.crop
    if (!isBoardCrop(crop)) return tradingError('bad-crop')
    const side = raw?.side
    if (!isBoardSide(side)) return tradingError('bad-side')
    if (!isMarginAmount(raw?.margin)) return tradingError('bad-margin')
    const leverage = raw?.leverage === undefined || raw?.leverage === null ? 1 : raw.leverage
    if (!isTradingLeverage(leverage)) return tradingError('bad-leverage')
    // 带外的目标价永远成交不了：下单就拒，别让玩家挂一张死单还占着保证金。
    if (!isOrderTarget({ crop, target: raw?.target })) return tradingError('bad-target')
    const target = Number(raw.target)
    const farm = this.#farm
    if (farm === null) return tradingError('starting')

    const now = this.#nowMs()
    this.#rollWeek(now)
    if (this.#coinBase() < raw.margin) return tradingError('no-coin')
    const spent = await farm.spendCoins(raw.margin)
    if (spent?.ok !== true) {
      return tradingError(spent?.error === 'no-coin' ? 'no-coin' : 'action-failed')
    }
    const order = {
      id: randomUUID(),
      crop,
      side,
      target,
      margin: raw.margin,
      leverage,
      placedAt: now,
      slot: slotIndexAt(now)
    }
    this.#state.orders.push(order)
    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'trading-place-order',
      order: this.#orderView(order, now),
      coins: this.#coinBase(),
      // 宿主的 toast：说清「挂在哪个价、什么时候会撤」，不只回一个 ok。
      notice: '已挂到价单：' + (side === 'long' ? '做多' : '做空') + ' · 目标 ' +
        target.toFixed(2) + ' · 保证金 ' + raw.margin + '；收盘没成交就自动撤单并退回保证金。',
      persisted
    }
  }

  async #cancelOrder (orderId) {
    if (this.#farm === null) return tradingError('starting')
    if (typeof orderId !== 'string' || orderId === '') return tradingError('no-order')
    const order = this.#state.orders.find((candidate) => candidate.id === orderId)
    if (order === undefined) return tradingError('no-order')
    // 已经在退款的单：钱大概率已到账，这次只等它被删掉，不能再退一次。
    if (order.refunding !== undefined) return tradingError('no-order')
    const refunded = await this.#refundOrder(order, { at: this.#nowMs() })
    if (refunded.ok !== true) return refunded
    return {
      ok: true,
      action: 'trading-cancel-order',
      orderId: order.id,
      coins: refunded.coins,
      notice: '已撤单，保证金 ' + order.margin + ' 退回硬币。',
      persisted: refunded.persisted
    }
  }

  async #tick () {
    const now = this.#nowMs()
    const rolled = this.#rollWeek(now)
    // 先撮合挂单、再结算仓位：同一拍里刚成交的仓位，如果它那一根已经收盘，
    // 会在下面的 `#settleDue` 里按收盘价结掉——顺序反了就会多留一拍。
    const matched = await this.#matchOrders(now)
    const settled = await this.#settleDue(now)
    if (!rolled && !matched && !settled) return false
    await this.#persist(settled)
    return true
  }

  /**
   * 每个还没结算的仓位走一遍「路径 → 收盘」：
   *   1. 从**上一次检查到的时刻**（重启后从 `openedAt`）到「此刻与这一根收盘的较早者」
   *      逐分钟找强平/止损（`pathScan`）；
   *   2. 找到就按那一刻的价平（原因 `liquidate` / `stop`），插针和快进时钟都不放过；
   *   3. 没找到且这一根已经收盘，才按这一根的收盘价结（原因 `settle`）。
   * 在线的 tick 与启动补算走同一个函数，所以离线补出来的价和图上最后一根永远一致。
   */
  async #settleDue (now) {
    const currentSlot = slotIndexAt(now)
    let settled = false
    for (const position of [...this.#state.positions]) {
      // 结算中的仓位等重启补后半段，不重复动钱。
      if (position.settling !== undefined) continue
      const horizon = Math.min(now, (position.slot + 1) * SLOT_MS)
      const trigger = this.#triggerOf(position, horizon)
      if (trigger !== null) {
        this.#forgetCheck(position.id)
        const result = await this.#settle(position, trigger)
        if (result.ok === true) settled = true
        continue
      }
      // 这一根还没收盘：仓位照常开着，记住这次检查到哪，等下一拍或收盘。
      if (position.slot >= currentSlot) {
        this.#rememberCheck(position, horizon)
        continue
      }
      const exit = slotClosePrice(position.crop, position.slot)
      if (exit === null) continue
      const result = await this.#settle(position, {
        exit,
        reason: 'settle',
        at: (position.slot + 1) * SLOT_MS
      })
      if (result.ok === true) settled = true
    }
    return settled
  }

  /**
   * 撮合挂单（票 83）：
   *   - 成交：从 `placedAt` 扫到「此刻与本根收盘的较早者」，第一处越价就按**目标价**成交；
   *     删单 + 推仓位在内存里一起改、只写一次盘（两边都在 `trading.json`，要么都成要么都不成）；
   *   - 到期：第一拍发现 `slotIndexAt(now) > order.slot` 且没成交，就退回保证金并删单；
   *   - 退款是跨文件的，走 `#refundOrder` 的意图路径（先写 refunding，再 addCoins，再删单）。
   * 关掉 DSH 很久再回来时，老单也走同一条路：先看看那一根里有没有越过目标价（有可能成交），
   * 没越过才退款——不会因为「离线太久」直接当成过期丢掉。
   */
  async #matchOrders (now) {
    let filled = false
    for (const order of [...this.#state.orders]) {
      // 已经在退款中的单由 `load()` 补完删单，这里不重复动钱。
      if (order.refunding !== undefined) continue
      const end = (order.slot + 1) * SLOT_MS
      const horizon = Math.min(now, end)
      const crossing = limitFillScan({
        crop: order.crop,
        side: order.side,
        target: order.target,
        from: order.placedAt,
        to: horizon
      })
      if (crossing !== null) {
        const index = this.#state.orders.indexOf(order)
        if (index >= 0) this.#state.orders.splice(index, 1)
        this.#state.positions.push({
          id: randomUUID(),
          crop: order.crop,
          side: order.side,
          margin: order.margin,
          leverage: order.leverage,
          // SPEC：成交价 = 目标价，不是越过那一刻的现价。
          entry: order.target,
          openedAt: crossing.at,
          slot: crossing.slot,
          // 止损默认关；挂单成交的仓位也一样，玩家可以成交后再设。
          stopLoss: 0
        })
        filled = true
        continue
      }
      // 这一根已经收盘还没成交：撤单退钱。没有农场（启动早期）时留着，下一拍再说。
      if (slotIndexAt(now) > order.slot && this.#farm !== null) {
        await this.#refundOrder(order, { at: now })
      }
    }
    // 成交必须立刻落盘（订单和仓位一起）；退款在 #refundOrder 里各自写过意图与删单。
    if (filled) await this.#persist(true)
    return filled
  }

  /**
   * 退款的两段式（幂等）：先写 `refunding` 意图，再 `addCoins(margin)`，最后删单落盘。
   * 第 2 步失败时订单保持 `refunding`：本次运行不会再动它，重启后只补删单。
   * 这样和仓位的 `settling` 同一个取舍：宁可少退一次，也绝不重复发钱。
   */
  async #refundOrder (order, { at }) {
    const farm = this.#farm
    if (farm === null) return tradingError('starting')
    order.refunding = { at }
    const intent = await this.#persist(true)
    if (intent !== true) {
      delete order.refunding
      return { ok: false, error: 'write-failed', persisted: false }
    }
    const credited = await farm.addCoins(order.margin)
    if (credited?.ok !== true) {
      // 钱没进去：意图留在盘上，重启后只补删单（不重复加钱）。本次运行到此为止。
      return { ok: false, error: 'action-failed', persisted: false }
    }
    const index = this.#state.orders.indexOf(order)
    if (index >= 0) this.#state.orders.splice(index, 1)
    const persisted = await this.#persist(true)
    return { ok: true, order, coins: this.#coinBase(), persisted }
  }

  /** 挂单的展示形状：不落盘的 `remainingMs` 让窗口能画倒计时（到本根收盘为止）。 */
  #orderView (order, now) {
    return {
      id: order.id,
      crop: order.crop,
      side: order.side,
      target: order.target,
      margin: order.margin,
      leverage: order.leverage,
      placedAt: order.placedAt,
      slot: order.slot,
      remainingMs: Math.max(0, (order.slot + 1) * SLOT_MS - now)
    }
  }

  /**
   * 这个仓位在 `[强平游标, horizon]` 这段路上撞过强平线或止损档没有。
   *
   * 为什么不能只看端点：快进时钟、关掉 DSH 几小时再回来、中间某一分钟插针又弹回去，
   * 端点可能完全安全，而仓位早就该平了。强平是系统规则，止损是玩家工具，都不许被跳过。
   *
   * 两个起点分开传（评审 P0）：强平从 `#checked`（上一次检查到的时刻）起算；
   * 止损从 `#stopFrom`（玩家设下档位的那一刻）起算，不能拿强平的进度去补旧账，
   * 也不能因为设了止损就少扫强平。
   *
   * 终点是「此刻与这一根收盘的较早者」：收盘之后由 `settle` 接管，扫过去只会把收盘价
   * 换成中间某一分钟，反而和图上最后一根对不上。仓位只活一根，所以这段路最长一根，
   * `pathScan` 的 3 天上限在账本里永远碰不到（它防的是别处传入的离谱区间）。
   */
  #triggerOf (position, horizon) {
    const liquidationFrom = Math.max(
      position.openedAt,
      this.#checked.get(position.id) ?? position.openedAt
    )
    const stopFrom = Math.max(
      position.openedAt,
      this.#stopFrom.get(position.id) ?? position.openedAt
    )
    return pathScan({
      crop: position.crop,
      side: position.side,
      margin: position.margin,
      leverage: position.leverage,
      entry: position.entry,
      stopLoss: position.stopLoss,
      from: liquidationFrom,
      to: horizon,
      stopFrom
    })
  }

  /** 记住「这手仓位的强平已经检查到这个时刻」；时钟往后退时不倒着走。 */
  #rememberCheck (position, horizon) {
    const previous = this.#checked.get(position.id) ?? position.openedAt
    if (horizon > previous) this.#checked.set(position.id, horizon)
  }

  /** 仓位结算/消失时把两个游标都清掉，别让内存表跟着历史一起长。 */
  #forgetCheck (positionId) {
    this.#checked.delete(positionId)
    this.#stopFrom.delete(positionId)
  }

  /**
   * 结算的两段式（幂等）：
   *   1. 把 `settling` 意图写盘（exit/pnl/credit/reason）——之后崩溃也能从这一条续上；
   *   2. 退硬币（`credit > 0` 才调 addCoins，`addCoins(0)` 会 bad-qty）；
   *   3. 记历史、删仓位、累加本周盈亏，再写一次盘。
   * 第 2 步失败时仓位保持 `settling`：本次运行不会再动它，重启后只补后半段。
   */
  async #settle (position, { exit, reason, at }) {
    const outcome = settlementOf({
      side: position.side,
      margin: position.margin,
      leverage: position.leverage,
      entry: position.entry,
      mark: exit
    })
    if (outcome === null) return tradingError('action-failed')
    const settling = { at, exit, pnl: outcome.pnl, credit: outcome.credit, reason }
    position.settling = settling
    const intent = await this.#persist(true)
    if (intent !== true) {
      delete position.settling
      return { ok: false, error: 'write-failed', persisted: false }
    }
    if (outcome.credit > 0) {
      const credited = await this.#farm.addCoins(outcome.credit)
      if (credited?.ok !== true) {
        // 钱没进去：意图留在盘上，重启后只补历史（不重复加钱）。本次运行到此为止。
        return { ok: false, error: 'action-failed', persisted: false }
      }
    }
    const history = this.#finishSettle(position, settling)
    const persisted = await this.#persist(true)
    return {
      ok: true,
      action: 'trading-close-position',
      history,
      pnl: outcome.pnl,
      credit: outcome.credit,
      coins: this.#coinBase(),
      persisted
    }
  }

  /** 结算的后半段：记历史、删仓位、累加本周盈亏（钱在调用方那边已处理）。 */
  #finishSettle (position, settling) {
    const index = this.#state.positions.indexOf(position)
    if (index >= 0) this.#state.positions.splice(index, 1)
    this.#forgetCheck(position.id)
    const history = {
      id: randomUUID(),
      crop: position.crop,
      side: position.side,
      margin: position.margin,
      leverage: position.leverage,
      entry: position.entry,
      exit: settling.exit,
      pnl: settling.pnl,
      reason: settling.reason,
      at: settling.at
    }
    this.#state.history.unshift(history)
    if (this.#state.history.length > MAX_TRADING_HISTORY) this.#state.history.length = MAX_TRADING_HISTORY
    this.#state.week.pnl = Math.min(
      MAX_COINS,
      Math.max(-MAX_COINS, this.#state.week.pnl + settling.pnl)
    )
    return history
  }

  /**
   * 跨周就重设：周一 00:00 清 `week.pnl`，把 `week.base` 换成此刻的可用硬币。
   * 硬币本身不动——榜和钱是两本账（SPEC「本周交易盈亏」）。
   */
  #rollWeek (now) {
    const start = weekStartOf(now)
    if (start === null || this.#state.week.start === start) return false
    this.#state.week = { start, pnl: 0, base: this.#coinBase() }
    return true
  }

  #positionView (position, now) {
    const settling = position.settling
    const mark = settling === undefined ? markPrice({ crop: position.crop, now }) : settling.exit
    const pnl = settling === undefined
      ? (mark === null
          ? null
          // 展示用取整前的值（可保留 1 位小数）；入账才在 settlementOf 里取整。
          : pnlOf({
            side: position.side,
            margin: position.margin,
            leverage: position.leverage,
            entry: position.entry,
            mark
          }))
      : settling.pnl
    return {
      id: position.id,
      crop: position.crop,
      side: position.side,
      margin: position.margin,
      leverage: position.leverage,
      entry: position.entry,
      openedAt: position.openedAt,
      slot: position.slot,
      // 强平价是派生字段（票 80）：1× 没有强平 → null，窗口画「—」。
      // 不落盘：改了 entry/杠杆以后，存下来的那条线会立刻变成假话。
      liquidation: liquidationPriceOf({
        side: position.side,
        entry: position.entry,
        leverage: position.leverage
      }),
      // 0 = 关（默认）；窗口的循环按钮就按这个值显示「关 / −25% / −50% / −100%」。
      stopLoss: position.stopLoss ?? 0,
      mark,
      pnl,
      ...(settling === undefined ? {} : { settling: true })
    }
  }

  #coinBase () {
    const coins = Number(this.#farm?.snapshot?.()?.coins)
    return Number.isFinite(coins) && coins > 0 ? Math.floor(coins) : 0
  }

  #nowMs () {
    return Math.floor(this.#now())
  }

  #enqueue (task) {
    const run = this.#chain.then(task, task)
    this.#chain = run.then(() => {}, () => {})
    return run
  }

  /** 动作总是立即落盘；tick 走 30 秒节流，避免每拍都写一遍 JSON。 */
  #persist (force) {
    if (!force) {
      const now = this.#nowMs()
      if (now - this.#lastWriteAt < SAVE_THROTTLE_MS) return Promise.resolve(false)
      this.#lastWriteAt = now
    } else {
      this.#lastWriteAt = this.#nowMs()
    }
    return this.#write()
  }

  async #write () {
    const target = join(this.#dir, TRADING_FILE)
    const tmp = target + '.tmp-' + randomUUID()
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      const body = JSON.stringify(toFileState(this.#state), null, 2) + '\n'
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
      // 同目录 rename 是原子的：不会留下半个盘口，也不会读到写了一半的 JSON。
      await rename(tmp, target)
      return true
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      this.#warnOnce('write', '盘口写不进去：本次运行仍然能用，但重启后可能丢（' + errorName(error) + '）')
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

function tradingError (error, notice = null) {
  return {
    ok: false,
    error,
    persisted: false,
    ...(notice === null ? {} : { notice })
  }
}
