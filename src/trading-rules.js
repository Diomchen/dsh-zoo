/**
 * 盘口纯规则（票 79）：15 分钟一根的确定性行情、盈亏与结算、本周起点。
 *
 * 这一层不读盘、不碰时钟、不碰网络：价格只由 `作物 + slot + tick + 版本盐` 决定，
 * 同一套代码在任何机器上算出同一张图（ADR-0027：不做对手盘、不做服务器）。
 *
 * 行情只有 `boardPrice()` 一个入口：当前价、收盘结算价、将来的 K 线（票 81）、
 * 离线补算与强平（票 80）都必须调它。多写一个价格公式，就会出现「图上没插针、
 * 结算却强平」这种对不上账的现场。
 */

import { CROPS } from './farm-rules.js'

/** 一根 = 15 分钟 = 1 个 slot；一根里有 15 个 1 分钟 tick。 */
export const SLOT_MS = 15 * 60 * 1000
export const SLOT_TICKS = 15
export const TICK_MS = SLOT_MS / SLOT_TICKS
/**
 * 行情版本盐：调价格手感（幅度/波形）时一起改它，老图当场作废，
 * 而不是邻居算一份新、我算一份旧。它只进散列种子，不落盘。
 */
export const PRICE_SALT = 'board-v1'
/** 价格锚在作物底价，夹在 [0.55, 1.75] 倍（SPEC v10「行情」）。 */
export const PRICE_FLOOR_RATIO = 0.55
export const PRICE_CEIL_RATIO = 1.75
/**
 * 票 79 只做一个作物、一档杠杆、两档保证金。这几个数组是**下单白名单**，
 * 也是窗口按钮的唯一来源（宿主随 payload 下发，窗口不复制一份，省掉 drift 测试）。
 * 票 80 加 5×/20×，票 81 加三个作物——只改这里。
 */
export const BOARD_CROPS = Object.freeze(['tomato'])
export const TRADING_MARGINS = Object.freeze([50, 100])
export const TRADING_LEVERAGES = Object.freeze([1])
/** 读盘时杠杆的形状上限：票 80 的 [1, 5, 20] 从这里取，别在 store 里另写一个 20。 */
export const MAX_LEVERAGE = 20
export const BOARD_SIDES = Object.freeze(['long', 'short'])

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
