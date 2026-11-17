/**
 * 期货的纯规则（票 92）：合约编号、偏离噪声、公允价、做市报价、张数与费用。
 *
 * 这里**没有**任何状态、没有时钟、没有文件：同样的 (作物, 合约, 时刻) 在任何一台
 * 机器上必须算出同一个数，否则两个人的账本一对就散。所有噪声都由散列派生，
 * 不碰 `Math.random()`（与 `src/trading-rules.js` 的 `PRICE_SALT` 同一套路）。
 *
 * 三件事定形状：
 *   - **一周一张合约**：周一 00:00 上市、周五 20:00 到期（`contractOf`）；周末没有
 *     可交易的合约，开仓直接拒绝——到期换月是票 96 的事，这里只负责说「现在没有」。
 *   - **公允价锚现货指数**：`fair = index × exp(ou)`，ou 是均值回归偏离（σ 0.4%/15 秒、
 *     半衰期 30 分钟）。指数由调用方给（单机就是本机交易所价），规则层不认识交易所。
 *   - **做市商两侧各让 0.2%**：`bid = fair × 0.998`、`ask = fair × 1.002`，永远有对手方。
 *
 * 金额一律用「币」的浮点数算、落账前 `roundCoin` 到分：农场硬币是整数，但手续费
 * 拆到分之后必须能对上（90% 销毁 / 10% 保险基金），四舍五入到整币会让账对不平。
 */

export const SLOT_MS = 15 * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000
export const HOUR_MS = 60 * 60 * 1000

/** 偏离噪声：每 15 秒一步，σ 0.4%，半衰期 30 分钟。 */
export const OU_STEP_MS = 15 * 1000
export const OU_SIGMA = 0.004
export const OU_HALF_LIFE_MS = 30 * 60 * 1000
/**
 * 记忆长度：8 个半衰期（4 小时 = 960 步）。再往前的权重是 e^-8 ≈ 0.03%，
 * 截断误差远小于散户能感知的价格跳动，换来的是「任意时刻 O(960) 次散列」而不是
 * 「从周一开盘一步步模拟过来」。
 */
export const OU_MEMORY_STEPS = 8 * (OU_HALF_LIFE_MS / OU_STEP_MS)

/** 做市商在公允价两侧各让 0.2%。 */
export const MM_SPREAD = 0.002
/** 一张合约 = 100 个作物。 */
export const LOT_SIZE = 100
/** taker 费 0.1% 名义；交割 0.1% 名义（票 96 用，这里先定义好同一套常量）。 */
export const TAKER_FEE_RATE = 0.001
export const DELIVERY_FEE_RATE = 0.001
/** 手续费的 10% 进保险基金，90% 销毁。 */
export const FEE_INSURANCE_SHARE = 0.1
export const FEE_BURN_SHARE = 0.9
/** 杠杆白名单：期货有价差与偏离，不用盘口那套 1/5/20。 */
export const FUTURES_LEVERAGES = Object.freeze([1, 3, 10, 20])
/**
 * 期货指令的种类（票 95）：开仓/平仓/充值/挂限价单。
 * 协议层直接引用这一份，避免「规则层认 place、线上却不认」的漂移（测试有断言）。
 */
export const FUTURES_ORDER_KINDS = Object.freeze(['open', 'close', 'deposit', 'place'])
export const MAX_MARGIN = 1_000_000
/** 合约编号里的作物部分只认小写字母数字与下划线，防手改文件塞进路径分隔符。 */
const CONTRACT_ID_RE = /^([a-z][a-z0-9_]*)-(\d{4})W(\d{2})$/
const SIDES = Object.freeze(['long', 'short'])
export const FUTURES_SIDES = SIDES

const TWO_PI = Math.PI * 2
const LN2 = Math.log(2)

/** FNV-1a 32 位；与盘口同一个散列，谁先写的不重要，重要的是只有一个。 */
export function hash32 (text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** murmur3 的尾混合：让末位的一个字符也能把整个 32 位搅乱。 */
function fmix32 (value) {
  let hash = value >>> 0
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return hash >>> 0
}
/**
 * 散列 → [0, 1)。先过一遍 fmix（murmur3 的尾混合）再归一：FNV-1a 对「只差最后一个字符」
 * 的两个串会输出只差一个常数的值，不过尾混合的话 `:1`…`:4` 四个数共线，
 * 四数相加的方差能到 3.8 而不是 1——正态就被放大成 1.9 倍。
 */
export function unitHash (text) {
  return fmix32(hash32(text)) / 4294967296
}

/**
 * 均值为 0、方差为 1 的伪正态：四个均匀数相加再标准化（Irwin–Hall）。
 * 只要求「可复现、够像正态、不依赖随机源」——真拿 Box–Muller 也得有同一颗种子。
 */
export function normalHash (text) {
  const sum = unitHash(text + ':1') + unitHash(text + ':2') + unitHash(text + ':3') + unitHash(text + ':4')
  return (sum - 2) * Math.sqrt(3)
}

export function isFuturesSide (value) {
  return typeof value === 'string' && SIDES.includes(value)
}

export function isFuturesLeverage (value) {
  return typeof value === 'number' && FUTURES_LEVERAGES.includes(value)
}

export function isMarginAmount (value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_MARGIN
}

/** 落账精度：到分；负零统一成 0，免得 JSON 里出现 `-0`。 */
export function roundCoin (value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  const rounded = Math.round(num * 100) / 100
  return rounded === 0 ? 0 : rounded
}

/** 这一周的周一 00:00（本地时区）。合约上市时间与「本周盈亏」的起算点都用它。 */
export function startOfWeek (at) {
  const date = new Date(at)
  const day = date.getDay() // 0 = 周日
  const offset = (day + 6) % 7 // 周一 = 0
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset, 0, 0, 0, 0)
  return monday.getTime()
}

/** ISO 周号（周一为一周第一天），只用在合约编号里，不参与结算。 */
function isoWeekOf (mondayMs) {
  const monday = new Date(mondayMs)
  // ISO：周四所在的年份才是这一周的年份；把周四移回本周周一再算序号。
  const thursday = new Date(monday.getTime() + 3 * DAY_MS)
  const year = thursday.getFullYear()
  const firstThursday = (() => {
    const jan4 = new Date(year, 0, 4)
    const offset = (jan4.getDay() + 6) % 7
    return new Date(year, 0, 4 - offset + 3, 0, 0, 0, 0).getTime()
  })()
  const week = Math.round((thursday.getTime() - firstThursday) / (7 * DAY_MS)) + 1
  return { year, week }
}

function pad2 (value) {
  return String(value).padStart(2, '0')
}

/**
 * 某一刻属于哪张合约：周一 00:00 上市、周五 20:00 到期。
 * 周五 20:00 之后到周日 24:00 之间没有可交易的合约 → `null`（周末休市）。
 */
export function contractOf (crop, at) {
  if (typeof crop !== 'string' || crop === '') return null
  const stamp = Number(at)
  if (!Number.isFinite(stamp)) return null
  const monday = startOfWeek(stamp)
  const expireAt = monday + 4 * DAY_MS + 20 * HOUR_MS
  if (stamp >= expireAt) return null
  const { year, week } = isoWeekOf(monday)
  return {
    crop,
    id: crop + '-' + year + 'W' + pad2(week),
    openAt: monday,
    expireAt,
    week
  }
}

/** 合约编号 → 窗口；编号不合法返回 null（坏存档按空市场处理时要用）。 */
export function contractWindowOf (id) {
  const match = CONTRACT_ID_RE.exec(String(id ?? ''))
  if (match === null) return null
  const [, crop, yearText, weekText] = match
  const year = Number(yearText)
  const week = Number(weekText)
  if (week < 1 || week > 53) return null
  // 反推这一周的周一：从该年 1 月 4 日所在的周一开始数。
  const jan4 = new Date(year, 0, 4)
  const offset = (jan4.getDay() + 6) % 7
  const firstMonday = new Date(year, 0, 4 - offset, 0, 0, 0, 0).getTime()
  const openAt = firstMonday + (week - 1) * 7 * DAY_MS
  return { crop, id: crop + '-' + year + 'W' + pad2(week), openAt, expireAt: openAt + 4 * DAY_MS + 20 * HOUR_MS, week }
}

/**
 * 偏离（对数尺度）：`ou(t) = Σ shock · e^{-λ·k·dt} · z(t-k·dt)`，k 从 0 到 960。
 *
 * 这是 OU 过程的截断表示——每一步的冲击按半衰期衰减，越早的冲击权重越小。
 * `OU_SIGMA` 是**偏离本身的平稳标准差**（0.4%），所以每步冲击取
 * `σ·√(1−e^{−2λdt})`，平稳时 `Σ decay^{2k}·shock² = σ²` 正好成立：
 * 公允价围着现货指数摆动，标准差就是文档里写的那个 0.4%，不是把 0.4% 当每步冲击。
 */
export function ouDeviation ({ crop, contractId, at }) {
  const stamp = Number(at)
  if (!Number.isFinite(stamp)) return 0
  const step = OU_STEP_MS
  const decay = Math.exp(-LN2 * step / OU_HALF_LIFE_MS)
  const shock = OU_SIGMA * Math.sqrt(1 - decay * decay)
  const cell = Math.floor(stamp / step)
  const key = 'futures:' + crop + ':' + contractId + ':ou:'
  let sum = 0
  let weight = 1
  for (let k = 0; k < OU_MEMORY_STEPS; k += 1) {
    sum += weight * normalHash(key + (cell - k))
    weight *= decay
  }
  return sum * shock
}

/** 公允价 = 指数 × exp(偏离)；指数不是正数时返回 null（没有行情的作物不能交易）。 */
export function fairPriceOf ({ indexPrice, crop, contractId, at }) {
  const index = Number(indexPrice)
  if (!Number.isFinite(index) || index <= 0) return null
  return index * Math.exp(ouDeviation({ crop, contractId, at }))
}

/** 做市商两侧报价；`side` 是吃单方向：long 吃 ask、short 吃 bid。 */
export function quotesOf (fair) {
  const price = Number(fair)
  if (!Number.isFinite(price) || price <= 0) return null
  return { bid: price * (1 - MM_SPREAD), ask: price * (1 + MM_SPREAD) }
}

/** 吃单价：做多吃卖一、做空吃买一。 */
export function fillPriceOf (quotes, side) {
  if (quotes === null || !isFuturesSide(side)) return null
  return side === 'long' ? quotes.ask : quotes.bid
}

/** 张数 = floor(名义价值 ÷ (成交价 × 100))，至少 1 张；名义不够一张也让你开。 */
export function lotsFor ({ notional, price }) {
  const amount = Number(notional)
  const unit = Number(price) * LOT_SIZE
  if (!Number.isFinite(amount) || !Number.isFinite(unit) || unit <= 0) return 0
  return Math.max(1, Math.floor(amount / unit))
}

/** 名义价值 = 张数 × 100 × 价格。 */
export function notionalOf ({ lots, price }) {
  const count = Number(lots)
  const unit = Number(price)
  if (!Number.isFinite(count) || !Number.isFinite(unit)) return 0
  return count * LOT_SIZE * unit
}

/** taker 费：名义 × 0.1%，到分。 */
export function takerFeeOf (notional) {
  return roundCoin(Number(notional) * TAKER_FEE_RATE)
}

/** 保证金 = 名义 ÷ 杠杆，到分。 */
export function marginOf ({ lots, price, leverage }) {
  const notional = notionalOf({ lots, price })
  const lev = Number(leverage)
  if (!Number.isFinite(lev) || lev <= 0) return 0
  return roundCoin(notional / lev)
}

/** 盈亏（到分）：张数 × 100 × (现价 − 入场) × 方向。 */
export function pnlOf ({ lots, entry, exit, side }) {
  if (!isFuturesSide(side)) return 0
  const move = Number(exit) - Number(entry)
  const dir = side === 'long' ? 1 : -1
  return roundCoin(Number(lots) * LOT_SIZE * move * dir)
}

/** 手续费拆分（到分）：先算保险基金那份，剩余的进销毁，两份相加永远等于总额。 */
export function feeSplitOf (fee) {
  const total = roundCoin(fee)
  const insurance = roundCoin(total * FEE_INSURANCE_SHARE)
  return { total, insurance, burned: roundCoin(total - insurance) }
}

// ── 挂单簿（票 95） ──────────────────────────────────────────────────────────
// 撮合必须「可复现」：同一组挂单在房主和任何一台复核机器上都要算出同一个成交序列。
// 所以这里不碰时钟、不碰随机数，排序键全部来自挂单自身（价格、at、id）。

function orderIdOf (order) {
  return typeof order?.id === 'string' ? order.id : ''
}

function orderTimeOf (order) {
  const at = Number(order?.at)
  return Number.isFinite(at) ? at : 0
}

/** 时间优先的比较器：`at` 早的在前，同一毫秒按 `id` 字典序（不用 localeCompare，避免机器相关）。 */
function timeThenId (left, right) {
  const delta = orderTimeOf(left) - orderTimeOf(right)
  if (delta !== 0) return delta
  const a = orderIdOf(left)
  const b = orderIdOf(right)
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * 挂单的规范顺序：买盘在前（价高优先），卖盘在后（价低优先）；同价 `at` 早优先，
 * 再按 `id` 字典序。返回新数组，不改入参。
 *
 * `lotsLeft <= 0`（已经成交完）的单不进盘口；方向、价格、剩余张数不是正数的坏记录
 * 也一并丢掉——盘口只认能成交的单，坏数据不该影响排序结果。
 */
export function sortBook (orders) {
  const bids = []
  const asks = []
  const list = Array.isArray(orders) ? orders : []
  for (const order of list) {
    if (order === null || typeof order !== 'object') continue
    if (!isFuturesSide(order.side)) continue
    const price = Number(order.price)
    const lotsLeft = Number(order.lotsLeft)
    if (!Number.isFinite(price) || price <= 0) continue
    if (!Number.isFinite(lotsLeft) || lotsLeft <= 0) continue
    if (order.side === 'long') bids.push(order)
    else asks.push(order)
  }
  bids.sort((left, right) => (Number(right.price) - Number(left.price)) || timeThenId(left, right))
  asks.sort((left, right) => (Number(left.price) - Number(right.price)) || timeThenId(left, right))
  return [...bids, ...asks]
}

/**
 * 两两撮合（票 95）：返回**确定性**的成交序列 `[{ makerId, takerId, lots, price }]`。
 *
 * - 只撮合同一个 `contract` 的单（`contract` 为空则不分合约，测试/单合约场景用）。
 * - 买一 ≥ 卖一才成交；成交价取 **maker（先挂的那一单）的挂单价**，不是对手价。
 * - 部分成交：maker 剩多少吃多少，`lotsLeft` 不够就按较小的那边算。
 * - `at` 给了就只撮合「这个时刻之前已经挂出」的单（`order.at <= at`），防止把
 *   下一拍才生效的单提前吃掉。
 *
 * 这里只算「谁和谁、多少张、什么价」，冻结保证金、仓位、手续费都在账本层落。
 */
export function matchOrders ({ orders, contract = null, at = null } = {}) {
  const stamp = Number(at)
  const cutoff = Number.isFinite(stamp) && stamp > 0 ? stamp : null
  const book = sortBook(
    (Array.isArray(orders) ? orders : [])
      .filter((order) => order !== null && typeof order === 'object')
      .filter((order) => contract === null || contract === undefined || order.contract === contract)
      .filter((order) => cutoff === null || orderTimeOf(order) <= cutoff)
  )
  const bids = book.filter((order) => order.side === 'long')
  const asks = book.filter((order) => order.side === 'short')
  const left = new Map()
  for (const order of book) left.set(order.id, Number(order.lotsLeft))

  const fills = []
  let bi = 0
  let ai = 0
  while (bi < bids.length && ai < asks.length) {
    const bid = bids[bi]
    const ask = asks[ai]
    const bidLeft = left.get(bid.id) ?? 0
    const askLeft = left.get(ask.id) ?? 0
    if (bidLeft <= 0) {
      bi += 1
      continue
    }
    if (askLeft <= 0) {
      ai += 1
      continue
    }
    // 买价低于卖价：后面只会更差（两边都按价格优先排过），到此为止。
    if (Number(bid.price) < Number(ask.price)) break
    const lots = Math.min(bidLeft, askLeft)
    const maker = timeThenId(bid, ask) <= 0 ? bid : ask
    fills.push({
      makerId: maker.id,
      takerId: maker === bid ? ask.id : bid.id,
      lots,
      price: Number(maker.price)
    })
    left.set(bid.id, bidLeft - lots)
    left.set(ask.id, askLeft - lots)
    if (left.get(bid.id) === 0) bi += 1
    if (left.get(ask.id) === 0) ai += 1
  }
  return fills
}
