/**
 * 盘口纯规则（票 79/80）：15 分钟一根的确定性行情、盈亏与结算、强平与止损、本周起点。
 *
 * 这一层不读盘、不碰时钟、不碰网络：价格只由 `作物 + slot + tick + 版本盐` 决定，
 * 同一套代码在任何机器上算出同一张图（ADR-0027：不做对手盘、不做服务器）。
 *
 * 行情只有 `boardPrice()` 一个入口：当前价、收盘结算价、将来的 K 线（票 81）、
 * 离线补算与强平（票 80）都必须调它。多写一个价格公式，就会出现「图上没插针、
 * 结算却强平」这种对不上账的现场。`pathScan()` 是「按剩余路径检查」的唯一实现：
 * 快进、插针、离线补算都走同一条逐分钟的路，谁也不许直接拿收盘价糊过去。
 */

import { CROPS } from './farm-rules.js'

/** 一根 = 15 分钟 = 1 个 slot；一根里有 15 个 1 分钟 tick。 */
export const SLOT_MS = 15 * 60 * 1000
export const SLOT_TICKS = 15
export const TICK_MS = SLOT_MS / SLOT_TICKS
/**
 * 路径检查的窗口上限：3 天 = 288 根。离线很久回来时，循环必须有界——
 * 超过这一段的部分不逐分钟扫，由调用方按「那一根的收盘价」结掉
 * （票 80 的降级口径：宁可少扫，也不为了补一个月的账跑几万次）。
 */
export const MAX_PATH_SCAN_SLOTS = 3 * 96
export const MAX_PATH_SCAN_MS = MAX_PATH_SCAN_SLOTS * SLOT_MS
/**
 * 行情版本盐：调价格手感（幅度/波形）时一起改它，老图当场作废，
 * 而不是邻居算一份新、我算一份旧。它只进散列种子，不落盘。
 */
export const PRICE_SALT = 'board-v1'
/** 价格锚在作物底价，夹在 [0.55, 1.75] 倍（SPEC v10「行情」）。 */
export const PRICE_FLOOR_RATIO = 0.55
export const PRICE_CEIL_RATIO = 1.75
/**
 * 票 79 只做一个作物、两档保证金；票 80 补齐杠杆与止损档。
 * 这几个数组是**下单/设止损的白名单**，也是窗口按钮的唯一来源
 * （宿主随 payload 下发，窗口不复制一份，省掉 drift 测试）。
 * 票 81 加三个作物——只改这里。
 */
export const BOARD_CROPS = Object.freeze(['tomato'])
export const TRADING_MARGINS = Object.freeze([50, 100])
/** 1× / 5× / 20×（SPEC v10「交易与结算」）；1× 没有强平。 */
export const TRADING_LEVERAGES = Object.freeze([1, 5, 20])
/** 读盘时杠杆的形状上限：就是白名单里最大的那一档，别在 store 里另写一个 20。 */
export const MAX_LEVERAGE = 20
export const BOARD_SIDES = Object.freeze(['long', 'short'])
/**
 * 止损档位（票 80）：亏掉多少比例的保证金就平。`0` = 关，是默认值。
 * 用**比例**而不是百分比数字：结算公式里直接乘 margin，不用再除一次 100。
 */
export const TRADING_STOP_LEVELS = Object.freeze([0, 0.25, 0.5, 1])
/** 结算原因（SPEC v10「交易与结算」）：手动 / 收盘 / 强平 / 止损。 */
export const TRADING_CLOSE_REASONS = Object.freeze(['close', 'settle', 'liquidate', 'stop'])

/**
 * 慢趋势 = 两三条正弦叠加，半个周期（一波涨/一波跌）约 4–6 根。
 * 权重和 = 1，所以慢趋势的幅度上限是 `SLOW_AMPLITUDE`（对数口径，约 ±20%）。
 */
const SLOW_WAVES = Object.freeze([
  Object.freeze({ slots: 9, weight: 0.68 }),
  Object.freeze({ slots: 11.4, weight: 0.32 })
])
const SLOW_AMPLITUDE = 0.19
/** 快噪声：每个 slot 一个散列值、tick 之间平滑插值，幅度约 ±2.2%。 */
const FAST_AMPLITUDE = 0.022
const TWO_PI = Math.PI * 2

function finiteNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  return null
}

/**
 * FNV-1a 32 位散列（与 `season-omens.js` 的私有实现同款，但各写一份：
 * 那个只服务来客时间窗，盘口要随手改种子文本，不该互相牵连）。
 */
export function hash32 (text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 散列到 [0, 1)：只用来当噪声格点值与相位，绝不参与钱的取整。 */
function unitHash (text) {
  return hash32(text) / 4294967296
}

function phaseOf (crop, index) {
  return unitHash(PRICE_SALT + ':' + crop + ':phase:' + index) * TWO_PI
}

function clampNumber (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** 作物底价来自运行时目录（票 59）；认不出/坏底价返回 null，调用方按坏输入处理。 */
function baseOf (crop) {
  if (typeof crop !== 'string') return null
  const base = finiteNumber(CROPS[crop]?.base)
  return base === null || base <= 0 ? null : base
}

/**
 * 慢趋势分量（对数口径）：`x = slot + tick / 15`，按「根」为单位连续变化。
 * 相位由作物决定，所以三个作物将来是三条不同的曲线，但同一条在所有机器上一样。
 */
function slowLevel (crop, x) {
  let sum = 0
  for (let index = 0; index < SLOW_WAVES.length; index += 1) {
    const wave = SLOW_WAVES[index]
    sum += wave.weight * Math.sin((TWO_PI * x) / wave.slots + phaseOf(crop, index))
  }
  return sum * SLOW_AMPLITUDE
}

/**
 * 快噪声分量：格点在**整数 slot** 上，tick 之间用 smoothstep 插值。
 * 这样 `tick = 0` 正好落在格点上，`tick = 15` 正好落在下一个格点上——
 * 一根的收盘价天然等于下一根的开盘价，不需要额外对齐。
 */
function fastLevel (crop, x) {
  const slot = Math.floor(x)
  const frac = x - slot
  const smooth = frac * frac * (3 - 2 * frac)
  const a = unitHash(PRICE_SALT + ':' + crop + ':fast:' + slot) * 2 - 1
  const b = unitHash(PRICE_SALT + ':' + crop + ':fast:' + (slot + 1)) * 2 - 1
  return (a * (1 - smooth) + b * smooth) * FAST_AMPLITUDE
}

/**
 * 盘口价的唯一公式：`底价 × exp(慢趋势 + 快噪声)`，再夹到 [0.55, 1.75] × 底价。
 *
 * `tick` 可以是小数（`tick ∈ [0, 15]`），窗口按真实时间取当前价；
 * `tick = 0` 是这根的开盘，`tick = 15` 是收盘（= 下一根的开盘）。
 * 认不出作物或参数不是有限数时返回 null。
 */
export function boardPrice ({ crop, slot, tick = 0 } = {}) {
  const base = baseOf(crop)
  if (base === null) return null
  const slotNumber = finiteNumber(slot)
  const tickNumber = finiteNumber(tick)
  if (slotNumber === null || tickNumber === null) return null
  const slotIndex = Math.floor(slotNumber)
  const ticks = clampNumber(tickNumber, 0, SLOT_TICKS)
  const x = slotIndex + ticks / SLOT_TICKS
  const raw = base * Math.exp(slowLevel(crop, x) + fastLevel(crop, x))
  return clampNumber(raw, base * PRICE_FLOOR_RATIO, base * PRICE_CEIL_RATIO)
}

/** 收盘价 = 下一根的开盘价；结算（收盘/离线补算）只认这一个数。 */
export function slotClosePrice (crop, slot) {
  return boardPrice({ crop, slot, tick: SLOT_TICKS })
}

/** 现在这一根是哪个 slot。 */
export function slotIndexAt (now) {
  const stamp = finiteNumber(now)
  return stamp === null ? null : Math.floor(stamp / SLOT_MS)
}

/** 现在这一根的边界：`slot` / 起点 / 终点（毫秒）。窗口倒计时用 `end - now`。 */
export function slotBounds (now) {
  const slot = slotIndexAt(now)
  if (slot === null) return null
  return { slot, start: slot * SLOT_MS, end: (slot + 1) * SLOT_MS }
}

/**
 * 此刻的价格：把真实时间换成 `slot + tick / 15` 再交给 `boardPrice()`。
 * 开仓成交价、持仓现价、手动平仓价全走它；`tick` 用小数，价格不会一分钟一跳。
 */
export function markPrice ({ crop, now } = {}) {
  const stamp = finiteNumber(now)
  if (stamp === null) return null
  const slot = Math.floor(stamp / SLOT_MS)
  const tick = (stamp - slot * SLOT_MS) / TICK_MS
  return boardPrice({ crop, slot, tick })
}

export function isBoardCrop (value) {
  return typeof value === 'string' && BOARD_CROPS.includes(value)
}

export function isBoardSide (value) {
  return typeof value === 'string' && BOARD_SIDES.includes(value)
}

export function isTradingMargin (value) {
  return Number.isInteger(value) && TRADING_MARGINS.includes(value)
}

export function isTradingLeverage (value) {
  return Number.isInteger(value) && TRADING_LEVERAGES.includes(value)
}

/** 读盘用：只判断形状合法（1..MAX_LEVERAGE），下单白名单另说。 */
export function isStoredLeverage (value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_LEVERAGE
}

/**
 * 持仓盈亏（未取整）：
 *   做多 `margin × leverage × (mark / entry − 1)`；
 *   做空 `margin × leverage × (1 − mark / entry)`。
 * 参数不成立返回 null；亏损封顶留给 `settlementOf()`（那是结算口径，不是显示口径）。
 */
export function pnlOf ({ side, margin, leverage = 1, entry, mark } = {}) {
  if (!isBoardSide(side)) return null
  const entryPrice = finiteNumber(entry)
  const markPrice_ = finiteNumber(mark)
  const marginValue = finiteNumber(margin)
  const leverageValue = finiteNumber(leverage)
  if (entryPrice === null || entryPrice <= 0) return null
  if (markPrice_ === null || markPrice_ < 0) return null
  if (marginValue === null || leverageValue === null) return null
  const change = side === 'short' ? 1 - markPrice_ / entryPrice : markPrice_ / entryPrice - 1
  return marginValue * leverageValue * change
}

/**
 * 结算结果：`pnl` 是取整后的盈亏（整数硬币，亏损封顶保证金），`credit` 是要退回的
 * `margin + pnl`。SPEC 的「亏损上限是 margin、不会欠钱」落在这里——硬币不会变负。
 */
export function settlementOf ({ side, margin, leverage = 1, entry, mark } = {}) {
  const raw = pnlOf({ side, margin, leverage, entry, mark })
  const marginValue = finiteNumber(margin)
  if (raw === null || marginValue === null || marginValue <= 0) return null
  const pnl = Math.round(Math.max(-marginValue, raw))
  return { pnl, credit: Math.max(0, Math.round(marginValue) + pnl) }
}

/**
 * 强平价（票 80）：做多 `entry × (1 − 1/leverage)`，做空 `entry × (1 + 1/leverage)`。
 * 1× 没有强平（价格要跌到 0 才亏光，而价格有底价），返回 null，窗口画「—」。
 * 参数不成立也返回 null——调用方按「没有强平线」处理，不会凭空造一条线出来。
 */
export function liquidationPriceOf ({ side, entry, leverage = 1 } = {}) {
  if (!isBoardSide(side)) return null
  const entryPrice = finiteNumber(entry)
  const leverageValue = finiteNumber(leverage)
  if (entryPrice === null || entryPrice <= 0) return null
  if (leverageValue === null || leverageValue <= 1) return null
  const ratio = 1 / leverageValue
  return side === 'long' ? entryPrice * (1 - ratio) : entryPrice * (1 + ratio)
}

/**
 * 现价有没有撞到强平线。**相等也算撞线**：图上摸到那条线就是强平，
 * 不做 `mark < liq` 的擦边豁免（票 80 的边界口径）。
 */
export function isLiquidated ({ side, mark, liquidation } = {}) {
  if (!isBoardSide(side)) return false
  const line = finiteNumber(liquidation)
  const price = finiteNumber(mark)
  if (line === null || line <= 0 || price === null || price < 0) return false
  return side === 'long' ? price <= line : price >= line
}

export function isStopLossLevel (value) {
  return typeof value === 'number' && Number.isFinite(value) && TRADING_STOP_LEVELS.includes(value)
}

/**
 * 现价有没有撞到止损档（票 80）：浮亏 ≥ `level × margin` 就算。
 * `level = 0`（默认关）永远不触发——它是玩家自己设的工具，不是系统风控。
 * 亏损按未取整的浮盈亏比，取整只在 `settlementOf()` 里做一次。
 */
export function isStopLossHit ({ side, margin, leverage = 1, entry, mark, stopLoss = 0 } = {}) {
  if (!isStopLossLevel(stopLoss) || stopLoss === 0) return false
  const marginValue = finiteNumber(margin)
  if (marginValue === null || marginValue <= 0) return false
  const pnl = pnlOf({ side, margin: marginValue, leverage, entry, mark })
  if (pnl === null) return false
  return pnl <= -stopLoss * marginValue
}

/**
 * 路径检查（票 80）：从 `from` 到 `to` 逐分钟走 `markPrice`（= `boardPrice`），
 * 返回第一处触发 `{ at, exit, reason }`（同一刻先算玩家的 `stop`，再算系统的
 * `liquidate`；见 `checkAt` 的注释），整条路径都没触发返回 null。
 *
 * 为什么不能只看端点：插针、快进时钟、关掉 DSH 几小时再回来，端点可能已经回到安全区，
 * 而中间某一分钟早就撞线了。强平是系统规则，止损是玩家工具，两者都不许被「跳过」。
 *
 * 窗口上限 `MAX_PATH_SCAN_MS`（3 天）：更老的部分不逐分钟扫，调用方按仓位那一根的
 * 收盘价结（循环有界，补账不会因为离线一个月而跑几十万次）。
 */
export function pathScan ({
  crop,
  side,
  margin,
  leverage = 1,
  entry,
  stopLoss = 0,
  from,
  to
} = {}) {
  if (!isBoardSide(side)) return null
  const start = finiteNumber(from)
  const end = finiteNumber(to)
  const entryPrice = finiteNumber(entry)
  const marginValue = finiteNumber(margin)
  if (start === null || end === null || entryPrice === null || marginValue === null) return null
  if (end <= start) return null
  // 同一根里的 15 分钟也先算好：强平线一次算清，循环里不再重复求值。
  const liquidation = liquidationPriceOf({ side, entry: entryPrice, leverage })
  const checkAt = (at) => {
    const exit = markPrice({ crop, now: at })
    if (exit === null) return null
    // 先看玩家自己设的止损：`−100%` 那一档与强平线是同一个价（都是亏光保证金），
    // 档位既然存在就按「止损」记，钱一分不差（亏损封顶）。没设档位时强平兜底。
    const hit = isStopLossHit({
      side,
      margin: marginValue,
      leverage,
      entry: entryPrice,
      mark: exit,
      stopLoss
    })
    if (hit) return { at, exit, reason: 'stop' }
    if (isLiquidated({ side, mark: exit, liquidation })) return { at, exit, reason: 'liquidate' }
    return null
  }
  const horizon = Math.min(end, start + MAX_PATH_SCAN_MS)
  // 对齐到绝对分钟格点：同一段时间在任何机器上扫的是同样的点（开仓那一刻 pnl=0，不用重看）。
  let cursor = Math.ceil(start / TICK_MS) * TICK_MS
  if (cursor <= start) cursor += TICK_MS
  while (cursor < horizon) {
    const hit = checkAt(cursor)
    if (hit !== null) return hit
    cursor += TICK_MS
  }
  // 端点（收盘那一刻或「现在」）本身也要看：它可能不在分钟格点上。
  return checkAt(horizon)
}

/**
 * 本周起点：**本地**周一 00:00（不是 UTC，也不是「7 天前这个点」）。
 * 先归零时分秒再回退天数，最后再归零一次——跨夏令时那天也不会落到 23:00/01:00。
 */
export function weekStartOf (now) {
  const stamp = finiteNumber(now)
  if (stamp === null) return null
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return null
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
