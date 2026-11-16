/**
 * 盘口纯规则（票 79/80）：15 分钟一根的确定性行情、盈亏与结算、强平与止损、本周起点。
 *
 * 这一层不读盘、不碰时钟、不碰网络：价格只由 `作物 + slot + tick + 版本盐` 决定，
 * 同一套代码在任何机器上算出同一张图（ADR-0028：不做对手盘、不做服务器）。
 * 票 84 的 1 时/1 日/1 周只是把**同一条**曲线按更粗的桶采样来画趋势（显示用近似）；
 * 合约结算仍然只认 15 分钟收盘，粗周期一根都不参与（见 `barsForTimeframe`）。
 * 票 86 把这条曲线从「两条 2–3 小时波」换成**多尺度慢波**（2–3 小时 → 16 周）：
 * 日/周线要读出趋势，只能让长周期真的进价格公式，而不是在渲染层补形状（ADR-0030）。
 *
 * 行情只有 `boardPrice()` 一个入口：当前价、收盘结算价、K 线（票 81）、
 * 离线补算与强平（票 80）都必须调它。多写一个价格公式，就会出现「图上没插针、
 * 结算却强平」这种对不上账的现场。`pathScan()` 是「按剩余路径检查」的唯一实现：
 * 快进、插针、离线补算都走同一条逐分钟的路，谁也不许直接拿收盘价糊过去。
 * K 线（`barsFor`）与风向（`hintOf`）也一样：它们只是把同一条曲线按根/按 tick
 * 读出来，不引入第二个公式。票 83 的到价成交扫描（`limitFillScan`）同样复用
 * `markPrice()` 和 1 分钟格点：成交价是玩家设的目标价，但「哪一分钟越价」只由这一条
 * 曲线决定，不另算一套行情。
 */

import { CROPS } from './farm-rules.js'

/** 一根 = 15 分钟 = 1 个 slot；一根里有 15 个 1 分钟 tick。 */
export const SLOT_MS = 15 * 60 * 1000
export const SLOT_TICKS = 15
export const TICK_MS = SLOT_MS / SLOT_TICKS
/** 1 小时 = 4 个 slot（票 84 的 1 时桶，纪元对齐）。 */
const HOUR_MS = 60 * 60 * 1000
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
 * v1 → v2（票 86）：慢波从两条换成多尺度，旧图作废；确定性不变，所有机器仍是同一张图。
 */
export const PRICE_SALT = 'board-v2'
/** 价格锚在作物底价，夹在 [0.55, 1.75] 倍（SPEC v10「行情」）。 */
export const PRICE_FLOOR_RATIO = 0.55
export const PRICE_CEIL_RATIO = 1.75
/**
 * 票 79 只做一个作物、两档保证金；票 80 补齐杠杆与止损档；票 83 加到三档 + 全下。
 * 这几个数组是**下单/设止损的白名单**，也是窗口按钮的唯一来源
 * （宿主随 payload 下发，窗口不复制一份，省掉 drift 测试）。
 * 票 80 加 5×/20×，票 81 加三个作物，票 83 加 250——只改这里。
 * 「全下」不在这张表里：金额 = 可用硬币，窗口多画一颗按钮，`isMarginAmount` 放行任意整数。
 *
 * 三作物的顺序就是窗口页签与 payload 的顺序（tomato 是第一根 `payload.bar` 的来源）；
 * 底价差得开（5 / 6 / 30），切页签时曲线形状一眼能分辨。
 */
export const BOARD_CROPS = Object.freeze(['tomato', 'carrot', 'pumpkin'])
export const TRADING_MARGINS = Object.freeze([50, 100, 250])
/** 1× / 5× / 20×（SPEC v10「交易与结算」）；1× 没有强平。 */
export const TRADING_LEVERAGES = Object.freeze([1, 5, 20])
/** 读盘时杠杆的形状上限：就是白名单里最大的那一档，别在 store 里另写一个 20。 */
export const MAX_LEVERAGE = 20
/**
 * 单笔保证金上限 = 农场硬币上限（`src/farm.js` 的 `MAX_COINS`）。
 *
 * 票 83 的「全下」把保证金从一个固定档位变成「玩家自己填的数」，所以这里只守形状：
 * 整数 1..MAX_MARGIN。上限与硬币同值，是因为**保证金本来就是硬币**——超过钱包余额的
 * 申请会先被 `no-coin` 挡掉，这个数只防 `1e9` 那种把账本撑爆的离谱输入。
 * `test/farm-constants-drift.test.js` 有一条与 `MAX_COINS` 的 drift 断言盯着它们相等。
 */
export const MAX_MARGIN = 1_000_000
export const BOARD_SIDES = Object.freeze(['long', 'short'])
/**
 * 止损档位（票 80）：亏掉多少比例的保证金就平。`0` = 关，是默认值。
 * 用**比例**而不是百分比数字：结算公式里直接乘 margin，不用再除一次 100。
 */
export const TRADING_STOP_LEVELS = Object.freeze([0, 0.25, 0.5, 1])
/** 结算原因（SPEC v10「交易与结算」）：手动 / 收盘 / 强平 / 止损。 */
export const TRADING_CLOSE_REASONS = Object.freeze(['close', 'settle', 'liquidate', 'stop'])

/**
 * 多尺度慢趋势（票 86 / ADR-0030）：六条正弦叠在**同一条**对数价格上。
 *
 * 每条波**单独给对数振幅**，不再用「权重和 = 1 × 一个总幅度」：它们服务的图表周期不一样，
 * 用同一个幅度均分，等于把长波饿死（旧模型只有两条 2–3 小时波，日/周线就是纯噪声）。
 * 幅度按「谁的周期长谁说话」排：短波只负责盘面的呼吸，日/周线的趋势必须由长波扛。
 *
 *   9 / 11.4 slot（2.25 / 2.85 小时）→ 15 分钟图的风向：6 小时里两三个来回；
 *   33 slot（8.25 小时）             → 1 时图的波段；故意比 8 小时多半根，日线/周线的形态
 *                                      才不逐根复读（正好整除一天/一周会让高低点永远落在同一点）；
 *   688 slot（7.17 天）              → 1 日图的主趋势（一周一次涨跌），1 周图的形状；
 *                                      同样故意不完全等于 672（日历周）；
 *   2816 slot（29.3 天，约 4 周）    → 1 日/1 周图的波段：24 根日线正好走完一个来回；
 *   8064 slot（84 天）               → 1 周图的宏观底/顶：票 86/ADR-0030 写「约 16 周（≈8064 slot）」，
 *                                      按 slot 数算其实是 84 天（12 周）；照 ticket 给的 slot 数实现，
 *                                      量级不变——24 根周线里只走半圈，「这半年在涨还是在跌」看它。
 *
 * 六条振幅之和 ≈ 0.52（对数口径），实测极值远小于这个和（各波相位不同），
 * 所以价格离 [0.55, 1.75] × 底价 的夹子还有富余——不去撞夹子，夹子只兜底（票 86 验收）。
 * 相位仍由 `phaseOf(crop, index)` 按作物 + 序号散列，确定性不变：同一台机器、同一刻一张图。
 */
const SLOW_WAVES = Object.freeze([
  // 2–3 小时：15 分钟图的「风」。票 86 保留这两条周期，只把幅度从 ±19% 收到 ±7%。
  Object.freeze({ slots: 9, amplitude: 0.04 }),
  Object.freeze({ slots: 11.4, amplitude: 0.028 }),
  // 8 小时：1 时图一段能看出涨跌；1 日图里走三个来回，只进影线，几乎不进日线收盘。
  Object.freeze({ slots: 33, amplitude: 0.032 }),
  // 1 周：1 日图的主趋势——连着三四根日线同向，靠的就是这一条。
  Object.freeze({ slots: 688, amplitude: 0.12 }),
  // 4 周：1 日/1 周图的波段，也是周线实体的主要来源（周线收盘 = 4 周波走了 1/4 圈）。
  Object.freeze({ slots: 2816, amplitude: 0.21 }),
  // 12 周：1 周图的宏观底/顶，24 根周线里只走半圈，负责「这半年在涨还是在跌」。
  Object.freeze({ slots: 8064, amplitude: 0.09 })
])
/** 快噪声：每个 slot 一个散列值、tick 之间平滑插值，幅度约 ±2.2%。 */
const FAST_AMPLITUDE = 0.022
const TWO_PI = Math.PI * 2

/**
 * K 线显示最近 24 根 + 当前形成中的一根（SPEC v10「行情」）。
 * 根数只在这里定一份：窗口按 payload 画，不自己算也不自己截。
 */
export const BOARD_BAR_COUNT = 24
/** 兜底上限：payload 是跨进程数据，24 之外再多画只会白占带宽。 */
const MAX_BOARD_BAR_COUNT = 72
/**
 * 盘口 K 线的周期（票 84）：`15m` 就是合约本身的一根（`barsFor`，精确到 1 分钟），
 * 其余三个只是把**同一条** `boardPrice()` 曲线按更粗的桶读出来看趋势。
 * 这里是周期清单的唯一来源：`limits.timeframes` 直接由它下发，窗口不复制一份。
 */
export const BOARD_TIMEFRAMES = Object.freeze([
  Object.freeze({ id: '15m', label: '15分' }),
  Object.freeze({ id: '1h', label: '1时' }),
  Object.freeze({ id: '1d', label: '1日' }),
  Object.freeze({ id: '1w', label: '1周' })
])
/**
 * 粗周期的采样步长（票 84，票 86 加密）：1 时每 5 分钟、1 日每小时、1 周每 3 小时。
 * 首尾两针正好落在桶边界上（`sampledPrices` 末尾补 `limit` 那一针），所以每根的
 * 开/收就是边界价，周线的影线不再被 6 小时抽样糊掉。
 * **采样只用于画图**：粗周期看不出 15 分钟里的插针，而合约结算仍然只认
 * `slotClosePrice()`（15 分钟收盘）。所以这里只决定「看哪几个点」，
 * 不引入第二种价格公式——每一针还是 `markPrice()`。
 */
const TIMEFRAME_SAMPLE_MS = Object.freeze({
  '1h': 5 * TICK_MS,
  '1d': 60 * TICK_MS,
  '1w': 3 * 60 * TICK_MS
})
/**
 * 风向 = 慢趋势在本根的斜率（本根起点 → 下一根起点），**快噪声不参与**。
 * 置信度 55–68% 是产品口径：慢趋势的斜率越陡越可信，但快噪声随时能把弱信号打反，
 * 所以封顶 68%，UI 必须写「不是保证」（SPEC v10「行情」）。
 * 取本根起点而不是「此刻」，是为了让一根之内风向不闪。
 */
const HINT_FLAT_SLOPE = 0.002
const HINT_MIN_CONFIDENCE = 0.55
const HINT_MAX_CONFIDENCE = 0.68
/**
 * 多尺度慢波叠起来，单根斜率最大约 0.051（六条同相时）；到 0.04 就算顶格——
 * 再陡的坡度多半是短波凑出来的，不该让玩家觉得「这一根特别有把握」。
 */
const HINT_FULL_SLOPE = 0.04

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
 * 多尺度波各自带振幅直接相加（见 `SLOW_WAVES` 的注释：短波是呼吸、长波是趋势）。
 * 相位由作物决定，所以三个作物将来是三条不同的曲线，但同一条在所有机器上一样。
 */
function slowLevel (crop, x) {
  let sum = 0
  for (let index = 0; index < SLOW_WAVES.length; index += 1) {
    const wave = SLOW_WAVES[index]
    sum += wave.amplitude * Math.sin((TWO_PI * x) / wave.slots + phaseOf(crop, index))
  }
  return sum
}

/**
 * 快噪声分量：格点在**半根**（slot 的 1/2，即 tick 7.5）上，tick 之间用 smoothstep 插值。
 *
 * 为什么不是整根一格：整根一格时一根里的 1 分钟路径是**单调**的（smoothstep 从 a 到 b
 * 不回弯），现实里不存在的「插针→收回」「同一根里先破止损再站回去」这些场景就一个都没有了
 * （票 86 实测：20k 根里 0 根能先跌破 1.25% 再收回）。半根一格之后 1 分钟图会拐一次弯，
 * 而整根边界仍然是格点（`tick = 0` / `tick = 15` 都落在格点上）——
 * 一根的收盘价天然等于下一根的开盘价，不需要额外对齐。
 */
function fastLevel (crop, x) {
  const cell = Math.floor(x * 2)
  const frac = x * 2 - cell
  const smooth = frac * frac * (3 - 2 * frac)
  const a = unitHash(PRICE_SALT + ':' + crop + ':fast:' + cell) * 2 - 1
  const b = unitHash(PRICE_SALT + ':' + crop + ':fast:' + (cell + 1)) * 2 - 1
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

/**
 * 一整根的历史 K 线：开 = tick 0，收 = tick 15，高低点按**整数 tick**取样。
 *
 * 为什么只取整数 tick：1 分钟就是图上最小的刻度，再密的采样只会让 payload 变大，
 * 而落在两根 tick 之间的极值在图上根本看不出来。收盘 = 下一根的开盘由
 * `boardPrice()` 的插值方式保证，所以相邻两根天然连续，不用额外对齐。
 * `start`/`end` 是这一根的真实毫秒边界（票 84）：窗口用它写时间标签，
 * 不再打印「自 1970 起的第几根」这种玩家看不懂的绝对序号。
 */
function barAt (crop, slot) {
  const open = boardPrice({ crop, slot, tick: 0 })
  const close = boardPrice({ crop, slot, tick: SLOT_TICKS })
  let high = Math.max(open, close)
  let low = Math.min(open, close)
  for (let tick = 1; tick < SLOT_TICKS; tick += 1) {
    const price = boardPrice({ crop, slot, tick })
    if (price > high) high = price
    if (price < low) low = price
  }
  return {
    slot,
    start: slot * SLOT_MS,
    end: (slot + 1) * SLOT_MS,
    open,
    high,
    low,
    close
  }
}

/**
 * 最近 `count` 根 + 当前形成中的一根（票 81）。
 *
 * `bars` 是过去的整根（旧 → 新，最后一根的收盘就是当前根的开盘）；
 * `current` 是这一根的实时 OHLC：`price` 是此刻的现价，`tick` 是已经走了多少分钟
 * （0–15，两位小数，窗口拿它画进度），`remainingMs` 是距收盘。
 * `base` 一起带出去：窗口的底价参考线、夹取范围、下单预览都靠它对齐，
 * 不让窗口自己再猜一次作物底价。
 *
 * 认不出作物 / 时间不是有限数时返回 null：窗口画空态，绝不算出另一张图。
 */
export function barsFor ({ crop, now, count = BOARD_BAR_COUNT } = {}) {
  if (baseOf(crop) === null) return null
  const stamp = finiteNumber(now)
  if (stamp === null) return null
  const bounds = slotBounds(stamp)
  if (bounds === null) return null
  const total = Number.isInteger(count)
    ? Math.floor(clampNumber(count, 1, MAX_BOARD_BAR_COUNT))
    : BOARD_BAR_COUNT
  const bars = []
  for (let offset = total; offset >= 1; offset -= 1) {
    bars.push(barAt(crop, bounds.slot - offset))
  }
  const open = boardPrice({ crop, slot: bounds.slot, tick: 0 })
  const price = markPrice({ crop, now: stamp })
  // 底价坏了/时钟坏了在上面的 baseOf/slotBounds 已经挡掉；这里只防一条窄路：
  // 价格算不出来时宁可返回 null 让窗口画空态，也不往 payload 里塞 NaN。
  if (open === null || price === null) return null
  const tick = (stamp - bounds.start) / TICK_MS
  let high = Math.max(open, price)
  let low = Math.min(open, price)
  // 已经走完的整分钟也参与高低点；加上此刻的现价（可能落在半分钟上）。
  for (let step = 1; step <= Math.floor(tick); step += 1) {
    const sampled = boardPrice({ crop, slot: bounds.slot, tick: step })
    if (sampled > high) high = sampled
    if (sampled < low) low = sampled
  }
  return {
    base: baseOf(crop),
    bars,
    current: {
      slot: bounds.slot,
      start: bounds.start,
      end: bounds.end,
      open,
      high,
      low,
      price,
      tick: Math.round(tick * 100) / 100,
      remainingMs: Math.max(0, bounds.end - stamp)
    }
  }
}

/**
 * 本地自然日 00:00（票 84 的「1 日」桶边界）。
 * 写法和 `weekStartOf()` 同一条：先归零时分秒，跨夏令时那天也不会偏到前一天 23:00。
 * 日/周的边界必须按**本地日历**走，不能用 `start + 24h`——夏令时那天会错一小时。
 */
function dayStartOf (stamp) {
  const date = new Date(stamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 本地日历 +`days` 天的 00:00：`setDate` 按本地日历走，跨夏令时也落在本地零点。 */
function shiftLocalDayStart (start, days) {
  const date = new Date(start)
  date.setDate(date.getDate() + days)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * 一个粗周期桶的边界（票 84）：`start` 是桶起点，`end` 是下一个桶的起点。
 * 1 时按纪元整点对齐（全世界同一条线，和 slot 一样）；1 日/1 周按本地日历对齐。
 */
function bucketBoundsOf (timeframe, stamp) {
  if (timeframe === '1h') {
    const start = Math.floor(stamp / HOUR_MS) * HOUR_MS
    return { start, end: start + HOUR_MS }
  }
  if (timeframe === '1d') {
    const start = dayStartOf(stamp)
    return { start, end: shiftLocalDayStart(start, 1) }
  }
  if (timeframe === '1w') {
    const start = weekStartOf(stamp)
    if (start === null) return null
    return { start, end: shiftLocalDayStart(start, 7) }
  }
  return null
}

/** 上一个桶的起点：1 时是整点减法；1 日/1 周走本地日历（夏令时安全）。 */
function previousBucketStartOf (timeframe, start) {
  if (timeframe === '1h') return start - HOUR_MS
  if (timeframe === '1d') return shiftLocalDayStart(start, -1)
  if (timeframe === '1w') return shiftLocalDayStart(start, -7)
  return null
}

/**
 * 粗周期在 `[start, limit]` 上的采样价：从 `start` 起每 `stepMs` 一针，**两端都算**
 * （起点是开盘、终点是收盘）。终点不落在整步上时补最后一针，所以本地日/周在夏令时
 * 那天也照样首尾对齐；形成中的桶把 `limit = now`，只采到此刻。
 */
function sampledPrices (crop, start, limit, stepMs) {
  const prices = []
  for (let at = start; at < limit; at += stepMs) {
    const price = markPrice({ crop, now: at })
    if (price === null) return null
    prices.push(price)
  }
  const last = markPrice({ crop, now: limit })
  if (last === null) return null
  prices.push(last)
  return prices
}

/**
 * 一根粗周期的 OHLC：开 = 第一针、收 = 最后一针、高/低 = 采样路径上的极值。
 * 采样只用于画图（显示用近似）；`close` 仍然只是 `boardPrice()` 在那一刻的价，
 * 不是第二种结算公式——合约结算只认 15 分钟收盘（`slotClosePrice()`）。
 */
function coarseBarAt (crop, timeframe, start, limit) {
  const stepMs = TIMEFRAME_SAMPLE_MS[timeframe]
  const prices = sampledPrices(crop, start, limit, stepMs)
  if (prices === null) return null
  let high = prices[0]
  let low = prices[0]
  for (const price of prices) {
    if (price > high) high = price
    if (price < low) low = price
  }
  return {
    slot: Math.floor(start / SLOT_MS),
    open: prices[0],
    high,
    low,
    close: prices[prices.length - 1]
  }
}

/**
 * 任意周期的「最近 `count` 根 + 当前形成中的一根」（票 84）。
 *
 * `15m` 原样转给 `barsFor()`——那是合约本身的一根，精确到 1 分钟 tick，
 * 语义一个字都没改；`1h`/`1d`/`1w` 由同一条 `boardPrice()` 曲线按粗桶采样，
 * 只为了看趋势。`current.tick` 对粗周期是 `null`：`第 m/15 分钟` 这种进度
 * 只对 15 分钟的合约根有意义。
 *
 * 返回形状与 `barsFor()` 一致（`base` + `bars` + `current`），只是每根多带
 * `start`/`end` 毫秒边界；窗口按 payload 画，不自己算桶。
 */
export function barsForTimeframe ({ crop, now, timeframe = '15m', count = BOARD_BAR_COUNT } = {}) {
  if (timeframe === '15m') return barsFor({ crop, now, count })
  if (baseOf(crop) === null) return null
  if (TIMEFRAME_SAMPLE_MS[timeframe] === undefined) return null
  const stamp = finiteNumber(now)
  if (stamp === null) return null
  const total = Number.isInteger(count)
    ? Math.floor(clampNumber(count, 1, MAX_BOARD_BAR_COUNT))
    : BOARD_BAR_COUNT
  const bounds = bucketBoundsOf(timeframe, stamp)
  if (bounds === null) return null
  // 先把「当前桶 + 它的 total 个前任」的起点串起来（旧 → 新），再逐段采样。
  const starts = [bounds.start]
  for (let index = 0; index < total; index += 1) {
    const previous = previousBucketStartOf(timeframe, starts[starts.length - 1])
    if (previous === null) return null
    starts.push(previous)
  }
  const bars = []
  for (let index = starts.length - 1; index >= 1; index -= 1) {
    const barStart = starts[index]
    const barEnd = starts[index - 1]
    const bar = coarseBarAt(crop, timeframe, barStart, barEnd)
    if (bar === null) return null
    bars.push({ ...bar, start: barStart, end: barEnd })
  }
  const forming = coarseBarAt(crop, timeframe, bounds.start, stamp)
  const price = markPrice({ crop, now: stamp })
  if (forming === null || price === null) return null
  return {
    base: baseOf(crop),
    bars,
    current: {
      slot: Math.floor(bounds.start / SLOT_MS),
      start: bounds.start,
      end: bounds.end,
      open: forming.open,
      high: forming.high,
      low: forming.low,
      price,
      // 粗周期没有「本根第几分钟」：`第 m/15 分钟` 只属于 15 分钟合约。
      tick: null,
      remainingMs: Math.max(0, bounds.end - stamp)
    }
  }
}

/**
 * 风向提示（票 81）：慢趋势在本根的斜率 → 方向 + 置信度。
 *
 * 只读 `slowLevel()`，不碰快噪声：这正是 SPEC 说的「快噪声会把弱信号打反，
 * UI 必须写不是保证」——所以这里给的永远是一个 55–68% 的弱信号，不是预测。
 * 同一根内返回值恒定（取本根起点），窗口每秒重画也不会闪。
 */
export function hintOf ({ crop, now } = {}) {
  if (baseOf(crop) === null) return null
  const slot = slotIndexAt(now)
  if (slot === null) return null
  const slope = slowLevel(crop, slot + 1) - slowLevel(crop, slot)
  const strength = Math.min(1, Math.abs(slope) / HINT_FULL_SLOPE)
  const confidence = Math.round(
    (HINT_MIN_CONFIDENCE + (HINT_MAX_CONFIDENCE - HINT_MIN_CONFIDENCE) * strength) * 100
  ) / 100
  const direction = Math.abs(slope) < HINT_FLAT_SLOPE ? 'flat' : slope > 0 ? 'up' : 'down'
  return { direction, confidence }
}

export function isBoardCrop (value) {
  return typeof value === 'string' && BOARD_CROPS.includes(value)
}

export function isBoardSide (value) {
  return typeof value === 'string' && BOARD_SIDES.includes(value)
}

/**
 * 保证金只守形状：整数 1..MAX_MARGIN（票 83「全下」把固定档位换成任意金额）。
 * 预设（50/100/250/全下）是**窗口按钮**的白名单，不是这里的规则——
 * 别再用 `TRADING_MARGINS.includes()` 收窄它，否则自定义的 73 会被当成坏输入。
 */
export function isMarginAmount (value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_MARGIN
}

export function isTradingLeverage (value) {
  return Number.isInteger(value) && TRADING_LEVERAGES.includes(value)
}

/** 读盘用：只判断形状合法（1..MAX_LEVERAGE），下单白名单另说。 */
export function isStoredLeverage (value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_LEVERAGE
}

/**
 * 到价挂单的目标价带（票 83）：和 `boardPrice()` 的夹取范围是同一组数
 * （`[0.55, 1.75] × 底价`）。落到带外的目标价**永远不会被触到**，所以下单时就拒绝
 * （`bad-target`），免得玩家挂一张永远不成交、还以为在等的单。
 * 认不出作物返回 null，调用方按坏输入处理。
 */
export function targetBandOf ({ crop } = {}) {
  const base = baseOf(crop)
  if (base === null) return null
  return { min: base * PRICE_FLOOR_RATIO, max: base * PRICE_CEIL_RATIO }
}

/** 目标价是不是一个有限正数且落在带内（边界算带内：图上摸到就能成交）。 */
export function isOrderTarget ({ crop, target } = {}) {
  const band = targetBandOf({ crop })
  const price = finiteNumber(target)
  if (band === null || price === null || price <= 0) return false
  return price >= band.min && price <= band.max
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
 * `stopFrom` 是**止损的生效时刻**（缺省 = `from`，老调用方行为不变）：止损是玩家在
 * 某一刻自己设的工具，只能从那一刻往后看；而强平是从 `from` 起就一直有效的系统规则。
 * 两个游标分开传，是因为账本里「设止损」不能顺手把强平的检查进度也挪走——设止损之前
 * 已经越过强平线的那一段，下一拍仍然要补出来（评审 P0）。
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
  to,
  stopFrom
} = {}) {
  if (!isBoardSide(side)) return null
  const start = finiteNumber(from)
  const end = finiteNumber(to)
  const entryPrice = finiteNumber(entry)
  const marginValue = finiteNumber(margin)
  if (start === null || end === null || entryPrice === null || marginValue === null) return null
  if (end <= start) return null
  // 止损只在设下之后生效；没给就按老口径「整段都能止损」（from 之前没有可扫的点）。
  const stopStart = finiteNumber(stopFrom) ?? start
  // 同一根里的 15 分钟也先算好：强平线一次算清，循环里不再重复求值。
  const liquidation = liquidationPriceOf({ side, entry: entryPrice, leverage })
  const checkAt = (at) => {
    const exit = markPrice({ crop, now: at })
    if (exit === null) return null
    // 先看玩家自己设的止损：`−100%` 那一档与强平线是同一个价（都是亏光保证金），
    // 档位既然存在就按「止损」记，钱一分不差（亏损封顶）。没设档位时强平兜底。
    // 止损的生效时刻之前不参与判定——设止损不翻旧账，强平则照常从路径起点检查。
    const hit = at >= stopStart && isStopLossHit({
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
 * 到价挂单的成交扫描（票 83）：和目标价在同一张图上逐分钟走，
 * 做多 `现价 ≤ 目标价`、做空 `现价 ≥ 目标价` 的第一分钟就是成交时刻；
 * **成交价永远是目标价**（不是那一刻的现价），所以这里只返回 `{ at, slot }`。
 *
 * 为什么和 `pathScan()` 同一套格点：同一根里的价格只由 `boardPrice()` 决定，
 * 挂单成交与强平/止损不能各扫一套时间点，否则会出现「图上摸到了却没成交」。
 * 起点用 `from`（挂单那一刻），终点由调用方给（`min(now, 本根收盘)`）：
 * 挂单只活一根，收盘未成交就撤，不存在跨根扫描。
 *
 * 与 `pathScan()` 一样从**下一个整数分钟**开始看，端点是开区间外的最后一刻
 * （可能是收盘那一刻，也可能不是整分钟）。参数不成立返回 null。
 */
export function limitFillScan ({ crop, side, target, from, to } = {}) {
  if (!isBoardSide(side)) return null
  if (baseOf(crop) === null) return null
  const targetPrice = finiteNumber(target)
  const start = finiteNumber(from)
  const end = finiteNumber(to)
  if (targetPrice === null || targetPrice <= 0) return null
  if (start === null || end === null || end <= start) return null
  const crossedAt = (at) => {
    const mark = markPrice({ crop, now: at })
    if (mark === null) return false
    return side === 'long' ? mark <= targetPrice : mark >= targetPrice
  }
  const horizon = Math.min(end, start + MAX_PATH_SCAN_MS)
  let cursor = Math.ceil(start / TICK_MS) * TICK_MS
  if (cursor <= start) cursor += TICK_MS
  while (cursor < horizon) {
    if (crossedAt(cursor)) return { at: cursor, slot: slotIndexAt(cursor) }
    cursor += TICK_MS
  }
  if (crossedAt(horizon)) return { at: horizon, slot: slotIndexAt(horizon) }
  return null
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
