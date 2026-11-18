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
 *       { "id": "…", "crop": "tomato", "contract": "tomato-20261117", "side": "long",
 *         "lots": 2, "entry": 5.05, "margin": 101, "leverage": 10,
 *         "openedAt": 1763308800000, "slot": 1959232, "settleSlot": 1959233 }
 *     ],
 *     "trades": [                              // 成交记录，最新在前，硬截 50 条（票 93）
 *       { "at": 1763308800000, "crop": "tomato", "contract": "tomato-20261117",
 *         "side": "long", "lots": 2, "price": 5.05, "fee": 1.01, "kind": "open" }
 *     ],
 *     "orders": [                              // 票 95：自己挂的限价单（未成交部分还冻结着保证金）
 *       { "id": "…", "deviceId": "local", "crop": "tomato", "contract": "tomato-20261117",
 *         "side": "long", "price": 5.05, "lots": 2, "lotsLeft": 2, "leverage": 10,
 *         "marginFrozen": 10.1, "at": 1763308800000 }
 *     ],
 *     "week": { "start": 1763251200000, "pnl": 12.5 },  // 本周已实现盈亏（票 93 顶部展示）
 *     "closed": 0,                             // 平掉/交割/强平的累计笔数（只用于展示）
 *     "tradedAt": 0,                           // 最后一笔动钱的时刻
 *     "insurance": 3.2,                        // 票 97：保险基金**当前余额**（会被亏空花掉）
 *     "shortfall": 0,                          // 票 97：基金也垫不上的累计欠账（不追缴）
 *     "liquidationCount": 0,                   // 票 97：累计强平笔数
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
 *   - **强平按路径扫、亏空先由基金垫**（票 97）：每 15 秒对每个仓位（本地 + 所有远端）从
 *     上次盯市时刻起，按价格原生分辨率（15 秒）逐点采样该合约的公允价；多头在
 *     `盈亏 ≤ -保证金` 的第一个采样点强平（空头反之），同一拍按触发时刻、建仓时间、id
 *     排序执行，所以插针也扫得到、结果可复现。强平按**触发点公允价**成交、收一腿 taker
 *     费；`保证金 + 盈亏 - 实收费用` 为负的部分叫「亏空」，先由 `insurance` 垫，垫不上
 *     的累计进 `shortfall`（欠账，不向玩家追缴，余额永不为负）。交割费收不上来走同一条路。
 *     基金的钱只有一个来源：每笔**实收**费用按 `FEE_INSURANCE_SHARE` 注入 `insurance`
 *     （同时累进 `fees.insurance`），所以 `insurance ≤ fees.insurance` 永远成立。
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
  DAILY_NOTIONAL_CAP,
  DAILY_NOTIONAL_MULTIPLE,
  dailyNotionalCapFor,
  DELIVERY_FEE_RATE,
  FUTURES_ACCOUNT_MODES,
  FUTURES_DEFAULT_ACCOUNT_MODE,
  FUTURES_DEFAULT_MODE,
  FUTURES_MODES,
  HOUR_MS,
  POSITION_NOTIONAL_CAP,
  SLOT_MS,
  contractOf,
  contractWindowOf,
  dayWindowOf,
  deliveryClosesOf,
  deliveryPriceOf,
  fairPriceOf,
  feeSplitOf,
  fillPriceOf,
  isFuturesAccountMode,
  isFuturesLeverage,
  isFuturesSide,
  isMarginAmount,
  LOT_SIZE,
  lotsFor,
  marginOf,
  matchOrders,
  MAX_MARGIN,
  notionalOf,
  OU_STEP_MS,
  pnlOf,
  quotesOf,
  roundCoin,
  sortBook,
  startOfWeek,
  takerFeeOf
} from './futures-rules.js'

export const FUTURES_FILE = 'futures.json'
export const FUTURES_VERSION = 1
/** `/state` 最多带 20 个仓位；账本本身不设上限（一天最多几十手）。 */
export const FUTURES_VIEW_POSITIONS = 20
/** 盘上最多留 50 条成交；`/state` 与窗口只带最近 20 条（票 93 的「成交记录」）。 */
export const FUTURES_TRADE_LIMIT = 50
export const FUTURES_VIEW_TRADES = 20

// 票 98：灰度模式与敞口限额都由规则层定义，账本层与协议层共用同一份，避免三处各写一套。
export {
  DAILY_NOTIONAL_CAP,
  DAILY_NOTIONAL_MULTIPLE,
  dailyNotionalCapFor,
  FUTURES_ACCOUNT_MODES,
  FUTURES_DEFAULT_ACCOUNT_MODE,
  FUTURES_DEFAULT_MODE,
  FUTURES_MODES,
  POSITION_NOTIONAL_CAP,
  isFuturesAccountMode
}

/**
 * 拒绝原因的中文文案（票 98）：窗口、`/state`、日志都从这里取，保证同一错误码
 * 不会在不同地方显示成两句话。
 */
export const FUTURES_ERROR_TEXT = Object.freeze({
  off: '期货未开放。',
  disabled: '期货已回滚停用，不能再开仓或挂单。',
  'daily-cap': '今日交易额已到上限。',
  'notional-cap': '持仓名义已到上限。',
  'rate-limited': '请求太频繁，已限速。',
  'not-host': '只有房主能操作。',
  'bad-mode': '未知的期货模式。',
  'bad-account-mode': '未知的账户档位。',
  paused: '你暂停了期货交易，继续之后才能开仓或挂单。',
  'not-owner': '这份账在房主那台，先把仓位平掉、余额提回农场就行。',
  // 1.12.3：下面这些以前只有错误码、没有文案，窗口就退化成「没成交，再试一次」。
  // 服务层出口会用它补齐 `notice`，所以这里宁可写得啰嗦，也别让用户看代码。
  'bad-amount': '金额不对：要写正整数（1 到 1,000,000 币）。',
  'no-coin': '农场硬币不够。',
  'farm-refused': '农场那边没有办成这笔操作。',
  'bad-crop': '没有这个作物。',
  'bad-side': '方向只认「做多」或「做空」。',
  'bad-margin': '保证金不对：要写 1 到 1,000,000 的整数币。',
  'bad-leverage': '杠杆只认 1、3、10、20 倍。',
  'bad-price': '价格不对：要写正的币数，最多两位小数。',
  'bad-lots': '张数不对：要写 1 到 1,000,000 的整数。',
  'bad-device': '不认识的邻居（设备号不对）。',
  'bad-contract': '合约编号不认识。',
  'contract-expired': '合约已到期，20:00 后停止交易。',
  'market-closed': '现在没有可交易的合约（周末休市，或已经收盘）。',
  'no-balance': '托管余额不够：先充值，或者把仓位平掉。',
  'no-position': '没有这个仓位（可能已经平掉或交割了）。',
  'no-order': '没有这个挂单（可能已经成交或撤掉）。',
  'no-space': '仓库放不下这么多现货。',
  'no-coins': '硬币不够。',
  'position-limit': '持仓条数到上限了，先平掉几笔。',
  'order-limit': '挂单条数到上限了，先撤掉几笔。',
  'self-trade': '不能跟自己的挂单成交。',
  'bad-order': '挂单参数不对。',
  'bad-market-order': '市价单参数不对。',
  'bad-positions': '这批持仓的编号或张数不对。',
  'write-failed': '存盘失败：磁盘写不进去。',
  'bad-paused': '暂停开关只接受 true / false。',
  'bad-epoch': '账本代号不对。',
  'bad-seq': '账本流水号不对。',
  'bad-account': '账本里的账户不对。',
  'bad-orders': '账本里的挂单不对。',
  'bad-trades': '账本里的流水不对。',
  'bad-fund': '账本里的保险基金数字不对。',
  'bad-pending': '账本里的待提取数字不对。',
  'bad-ledger': '账本快照不对。'
})

const MAX_ID_LENGTH = 64
const MAX_QUANTITY = 1_000_000
// 1.12.0（B）：一本账最多几个账户。局域网里一台机器一个账户，16 已经是宽松上限；
// 再大就不该硬塞进 4 KiB 的 UDP 包，宁可让快照分片失败也不把包撑爆。
const LEDGER_MAX_ACCOUNTS = 16
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
    // 票 96：已交割的合约（contractId → 交割时刻）。
    delivered: {},
    // 票 97：保险基金**当前余额**（与 `fees.insurance` 的「累计注入」区分开：前者会被
    // 强平/交割的亏空花掉，后者只增不减，是历史累计）；`shortfall` 是基金也垫不上、
    // 记在账上的欠账（不向玩家追缴）；`liquidationCount` 是累计强平笔数（展示用）。
    insurance: 0,
    shortfall: 0,
    liquidationCount: 0,
    // 1.12.4：做市商那一侧的累计盈亏（`house -= pnl`）。玩家赚的钱从这儿出、亏的钱进这儿，
    // 所以「玩家盈亏 + house + 硬币总量」三项才闭合。允许为负：负得越多，说明系统净付出越多。
    house: 0,
    // 票 98：灰度模式（off/shadow/live）、按自然日的成交额、待提取余额、回滚停用标记。
    // `farmAnchor/farmIn/farmOut` 只服务于对账：影子模式没有真实流动，所以差额恒为 0。
    mode: FUTURES_DEFAULT_MODE,
    // 1.10.0：本账户自己的档位（`shadow` 纸面 / `live` 真钱）。`null` = 跟随上面的市场档位，
    // 老存档读出来就是这个值。1.12.0 起 `mode` 只用于显示：暂停自己会把它写成 `off`，
    // 但它不再拦别人——闸门只看账户自己的 `disabled` / `paused`。
    accountMode: null,
    dayStart: 0,
    dayNotional: 0,
    pending: 0,
    disabled: false,
    // 1.12.0：每个账户自己的「暂停交易」开关。房主关市只关自己，不再拦别人——
    // 停别人的市这件事在 LAN 里没有正当性（谁都能拔网线，但没人能替别人按暂停）。
    paused: false,
    farmAnchor: 0,
    farmIn: 0,
    farmOut: 0,
    // 票 98：模式变更的版本号。模式是全局状态，不挂在某个远端账户上；
    // 推进它并把 peer 的 seq 对齐，切档后的第一份 settle 才不会被当成重复包。
    modeSeq: 0,
    // 1.12.0（B）：最近一次从房主收到的整本账快照。换房主时用它重建——
    // 只记一份、只留最新（`(epoch, seq)` 大的那份），别的不攒。
    ledger: null
  }
}

/** 一个远端账户的空壳（房主第一次见到某个 deviceId 时用）。 */
function initialRemoteAccount (seq = 0, at = 0) {
  return {
    balance: 0,
    marginUsed: 0,
    positions: [],
    orders: [],
    trades: [],
    lastSeq: seq,
    updatedAt: at,
    pending: 0,
    dayStart: 0,
    dayNotional: 0,
    accountMode: null,
    paused: false,
    disabled: false
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
    // 票 97：保险基金余额、累计欠账、累计强平笔数——窗口和 `/state` 都直接读这三个数。
    insurance: 0,
    shortfall: 0,
    liquidationCount: 0,
    closed: 0,
    positionCount: 0,
    positions: [],
    trades: [],
    orders: [],
    orderCount: 0,
    week: { start: 0, pnl: 0 },
    quotes: {},
    // 票 98：模式、日额进度与上限、待提取、回滚停用——窗口直接照抄这些字段。
    // 1.10.0：`mode` 是市场闸门（off/shadow/live），`accountMode` 是本账户自己的档位。
    mode: FUTURES_DEFAULT_MODE,
    accountMode: FUTURES_DEFAULT_ACCOUNT_MODE,
    dayNotional: 0,
    dayCap: DAILY_NOTIONAL_CAP,
    positionCap: POSITION_NOTIONAL_CAP,
    pending: 0,
    disabled: false,
    // 票 98：拒绝原因的中文文案，窗口与 /state 直接取这份表。
    errorText: FUTURES_ERROR_TEXT,
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
  const kind = raw.kind === 'mode'
    ? 'mode'
    : raw.kind === 'close'
      ? 'close'
      : raw.kind === 'open'
        ? 'open'
        : raw.kind === 'delivery'
          ? 'delivery'
          : raw.kind === 'convert'
            ? 'convert'
            : raw.kind === 'liquidation'
              ? 'liquidation'
              : null
  // 票 98：模式切换流水是审计记录，没有作物/合约/方向，张数与价格都是 0，
  // 所以必须在常规成交流水校验之前单独放行。1.10.0：账户级档位复用同一种流水。
  if (kind === 'mode') {
    const note = FUTURES_MODES.includes(raw.note) || FUTURES_ACCOUNT_MODES.includes(raw.note) ? raw.note : null
    if (at === null || at <= 0 || note === null) return null
    return { at, kind, note, lots: 0, price: 0, fee: 0 }
  }
  const crop = isCropId(raw.crop) ? raw.crop : null
  const contract = contractWindowOf(raw.contract)
  const side = isFuturesSide(raw.side) ? raw.side : null
  const lots = positiveInt(raw.lots, MAX_QUANTITY)
  const price = finiteNumber(raw.price)
  const fee = nonNegativeCoin(raw.fee)
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
  const pending = raw.pending === undefined ? 0 : nonNegativeCoin(raw.pending)
  if (pending === null) return null
  const dayStart = raw.dayStart === undefined ? 0 : finiteNumber(raw.dayStart)
  if (!(dayStart >= 0)) return null
  const dayNotional = raw.dayNotional === undefined ? 0 : nonNegativeCoin(raw.dayNotional)
  if (dayNotional === null) return null
  // 1.10.0：账户自己的档位（`shadow` 纸面 / `live` 真钱）；缺省（老存档）跟随全局市场档位。
  const accountMode = raw.accountMode === undefined || raw.accountMode === null
    ? null
    : (isFuturesAccountMode(raw.accountMode) ? raw.accountMode : undefined)
  if (accountMode === undefined) return null
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
  // 1.12.0：暂停与退出标记也要跟着落盘，否则房主重启后远端账户会「自己恢复交易」。
  const paused = raw.paused === undefined ? false : raw.paused
  if (typeof paused !== 'boolean') return null
  const disabled = raw.disabled === undefined ? false : raw.disabled
  if (typeof disabled !== 'boolean') return null
  return { balance, marginUsed: roundCoin(margin), positions, orders, trades, lastSeq, updatedAt, pending, dayStart, dayNotional, accountMode, paused, disabled }
}

/**
 * 1.12.0（B）：房主广播的整本账快照。
 *
 * 只有一件事要保证：**换房主时能用它把账重建出来**。所以快照里每个账户都带齐
 * 余额、仓位、挂单、成交流水、档位、暂停/退出标记；市场层的保险基金、欠账、交割标记
 * 也一并带走。校验从严——坏一个字段就整份丢掉，宁可不接管也不能接管一份半截账。
 */
export function normalizeLedgerSnapshot (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const epoch = typeof raw.epoch === 'string' ? raw.epoch.slice(0, 64) : ''
  const seq = Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : null
  const at = finiteNumber(raw.at)
  if (seq === null || at === null || at < 0) return null
  const hostId = typeof raw.hostId === 'string' && raw.hostId !== '' && raw.hostId.length <= MAX_ID_LENGTH
    ? raw.hostId
    : null
  if (hostId === null) return null
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0 || raw.accounts.length > LEDGER_MAX_ACCOUNTS) return null
  const accounts = []
  const seen = new Set()
  for (const entry of raw.accounts) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const deviceId = typeof entry.deviceId === 'string' && entry.deviceId !== '' && entry.deviceId.length <= MAX_ID_LENGTH
      ? entry.deviceId
      : null
    if (deviceId === null || seen.has(deviceId)) return null
    seen.add(deviceId)
    const account = normalizeRemoteAccount(entry)
    if (account === null) return null
    accounts.push({ deviceId, ...account })
  }
  const insurance = raw.insurance === undefined ? 0 : nonNegativeCoin(raw.insurance)
  const shortfall = raw.shortfall === undefined ? 0 : nonNegativeCoin(raw.shortfall)
  if (insurance === null || shortfall === null) return null
  const liquidationCount = raw.liquidationCount === undefined
    ? 0
    : (Number.isInteger(raw.liquidationCount) && raw.liquidationCount >= 0 ? raw.liquidationCount : null)
  if (liquidationCount === null) return null
  // 1.12.4：做市商净盈亏允许为负（负 = 系统净付出）。
  const house = raw.house === undefined ? 0 : finiteNumber(raw.house)
  if (house === null) return null
  const delivered = {}
  if (raw.delivered !== undefined && raw.delivered !== null) {
    if (typeof raw.delivered !== 'object' || Array.isArray(raw.delivered)) return null
    for (const [contractId, value] of Object.entries(raw.delivered)) {
      const window = contractWindowOf(contractId)
      const stampedAt = finiteNumber(value)
      if (window === null || stampedAt === null || stampedAt <= 0) return null
      delivered[window.id] = stampedAt
    }
  }
  return { v: 1, epoch, seq, at, hostId, insurance, shortfall, liquidationCount, house, delivered, accounts }
}

/** 快照里一个账户的线上形状：本地账本和远端账户共用一份序列化，省得两边漂。 */
function accountSnapshotOf (account) {
  return {
    balance: roundCoin(account.balance),
    marginUsed: roundCoin(account.marginUsed),
    positions: account.positions.map((position) => ({ ...position })),
    orders: account.orders.map((order) => ({ ...order })),
    trades: (account.trades ?? []).slice(0, FUTURES_TRADE_LIMIT).map((trade) => ({ ...trade })),
    lastSeq: account.lastSeq ?? 0,
    updatedAt: account.updatedAt ?? 0,
    pending: roundCoin(account.pending ?? 0),
    dayStart: account.dayStart ?? 0,
    dayNotional: roundCoin(account.dayNotional ?? 0),
    accountMode: account.accountMode ?? null,
    paused: account.paused === true,
    disabled: account.disabled === true
  }
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

  // 票 97：保险基金余额与累计强平笔数。老文件没有这两个键（票 96 之前根本没有基金），
  // 按 0 处理且**不算修补**——缺字段是旧版本，不是坏账。
  const insurance = value.insurance === undefined ? 0 : nonNegativeCoin(value.insurance)
  if (insurance === null) repaired += 1
  else state.insurance = insurance

  const liquidationCount = value.liquidationCount === undefined
    ? 0
    : Number.isInteger(value.liquidationCount) && value.liquidationCount >= 0
      ? value.liquidationCount
      : null
  if (liquidationCount === null) repaired += 1
  else state.liquidationCount = liquidationCount

  // 1.12.4：做市商净盈亏（老存档没有这个字段，当 0）。
  const house = value.house === undefined ? 0 : finiteNumber(value.house)
  if (house === null) repaired += 1
  else state.house = house

  // 票 98：灰度模式与限额进度。缺字段是旧版本，按缺省值处理且不算修补；
  // 非法的模式名则必须当坏账修掉（否则窗口会显示一个谁都不认识的状态）。
  const mode = value.mode === undefined
    ? FUTURES_DEFAULT_MODE
    : FUTURES_MODES.includes(value.mode) ? value.mode : null
  if (mode === null) repaired += 1
  else state.mode = mode

  const dayStart = value.dayStart === undefined ? 0 : finiteNumber(value.dayStart)
  if (dayStart === null || dayStart < 0) repaired += 1
  else state.dayStart = dayStart

  const dayNotional = value.dayNotional === undefined ? 0 : nonNegativeCoin(value.dayNotional)
  if (dayNotional === null) repaired += 1
  else state.dayNotional = dayNotional

  const pending = value.pending === undefined ? 0 : nonNegativeCoin(value.pending)
  if (pending === null) repaired += 1
  else state.pending = pending

  const disabled = value.disabled === undefined ? false : value.disabled
  if (typeof disabled !== 'boolean') repaired += 1
  else state.disabled = disabled

  // 1.12.0：老存档没有 `paused`，缺省就是「没暂停」。
  const paused = value.paused === undefined ? false : value.paused
  if (typeof paused !== 'boolean') repaired += 1
  else state.paused = paused

  // 1.12.2：账户档位落盘了就以盘上为准；老存档没有这个字段，留 null 走 `mode` 反推。
  if (value.accountMode !== undefined && value.accountMode !== null) {
    if (isFuturesAccountMode(value.accountMode)) state.accountMode = value.accountMode
    else repaired += 1
  }

  const farmAnchor = value.farmAnchor === undefined ? 0 : nonNegativeCoin(value.farmAnchor)
  const farmIn = value.farmIn === undefined ? 0 : nonNegativeCoin(value.farmIn)
  const farmOut = value.farmOut === undefined ? 0 : nonNegativeCoin(value.farmOut)
  if (farmAnchor === null || farmIn === null || farmOut === null) repaired += 1
  else {
    state.farmAnchor = farmAnchor
    state.farmIn = farmIn
    state.farmOut = farmOut
  }

  const modeSeq = value.modeSeq === undefined ? 0 : value.modeSeq
  if (!(Number.isInteger(modeSeq) && modeSeq >= 0)) repaired += 1
  else state.modeSeq = modeSeq

  // 1.12.0（B）：上一次收到的整本账快照。缺字段是旧版本（没这一版就没有快照），
  // 不算修补；但既然是坏账就必须丢掉——接管一份半截账比不接管更糟。
  if (value.ledger !== undefined && value.ledger !== null) {
    const ledger = normalizeLedgerSnapshot(value.ledger)
    if (ledger === null) repaired += 1
    else state.ledger = ledger
  }

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
    shortfall: roundCoin(state.shortfall),
    // 票 97：保险基金余额与累计强平笔数（基金余额会被亏空花掉，`fees.insurance` 只增不减）。
    insurance: roundCoin(state.insurance),
    liquidationCount: state.liquidationCount,
    // 1.12.4：做市商净盈亏（玩家盈亏的反数），允许为负。
    house: roundCoin(state.house),
    // 票 98：模式、日额进度、待提取、回滚标记与对账锚点。
    mode: state.mode,
    dayStart: state.dayStart,
    dayNotional: roundCoin(state.dayNotional),
    pending: roundCoin(state.pending),
    disabled: state.disabled,
    paused: state.paused === true,
    // 1.12.2：档位要落盘。以前只靠 `mode` 反推，一按暂停（mode 变 off）就退回「纸面」，
    // 重启后更是直接丢——充值、提现、结算都会按错档位走。
    accountMode: isFuturesAccountMode(state.accountMode) ? state.accountMode : null,
    farmAnchor: roundCoin(state.farmAnchor),
    farmIn: roundCoin(state.farmIn),
    farmOut: roundCoin(state.farmOut),
    modeSeq: state.modeSeq,
    // 1.12.0（B）：整本账快照（只有 peer 会存，房主这边是 null）。
    ledger: state.ledger === null ? null : state.ledger
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
      updatedAt: account.updatedAt,
      pending: roundCoin(account.pending ?? 0),
      dayStart: account.dayStart ?? 0,
      dayNotional: roundCoin(account.dayNotional ?? 0),
      // 1.12.2：这三样以前都没落盘，房主一重启，邻居就自动变回「纸面、没暂停、没退出」。
      accountMode: isFuturesAccountMode(account.accountMode) ? account.accountMode : null,
      paused: account.paused === true,
      disabled: account.disabled === true
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
      this.#state.farmAnchor = this.#farmCoins()
      return
    }

    let raw
    try {
      raw = parseJsonText(text)
    } catch {
      this.#warnOnce('parse', '期货账本不是合法 JSON，先按空市场运行')
      this.#state = initialFuturesState()
      this.#state.epoch = randomUUID()
      this.#state.farmAnchor = this.#farmCoins()
      return
    }

    const normalized = normalizeFuturesFile(raw)
    this.#state = normalized.futures
    if (normalized.corrupt) {
      this.#warnOnce('shape', '期货账本形状不对，先按空市场运行')
    } else if (normalized.repaired > 0) {
      this.#warnOnce('entries', '期货账本有 ' + normalized.repaired + ' 处格式不对，已按默认值修补')
    }
    // 票 98：旧账本没有对账锚点，第一次读盘时用当前农场硬币补上；之后随账本落盘。
    if (raw.farmAnchor === undefined) this.#state.farmAnchor = this.#farmCoins()
    // 不落盘：坏文件留在盘上等下一次动钱覆盖，读的时候不自作主张改写用户的账。
    // epoch 每次启动换新（SPEC v11）：它是「这一本账」的身份，票 94 用它判 peer 的状态过期了。
    this.#state.epoch = randomUUID()
  }

  #nowMs () {
    return this.#now()
  }

  /**
   * 农场当前的硬币数（票 98 对账用）。真实 farm 有 `snapshot()`；测试里的假农场只有
   * `state.coins`，两条路都兼容。读不到时按 0 处理，宁可对账报警也不抛。
   */
  #farmCoins () {
    const farm = this.#farm
    try {
      if (farm !== null && typeof farm.snapshot === 'function') {
        const coins = nonNegativeCoin(farm.snapshot()?.coins)
        if (coins !== null) return coins
      }
      if (farm !== null && farm.state !== null && typeof farm.state === 'object') {
        const coins = nonNegativeCoin(farm.state.coins)
        if (coins !== null) return coins
      }
    } catch {
      // 农场读失败不影响交易；对账会把差额显出来。
    }
    return 0
  }

  /** 当前生效的模式：peer 跟随房主下发的副本，房主用自己的账本。 */
  modeOf () {
    const replica = this.#state.replica
    if (replica !== null && typeof replica === 'object' && FUTURES_MODES.includes(replica.mode)) {
      return replica.mode
    }
    return this.#state.mode
  }

  /**
   * 1.10.0：某个账户这一刻的档位。
   *
   * 1.12.4：自己的档位**自己说了算**——本机账户优先读本地 `accountMode`，房主回执只用来
   * 覆盖「本地还没选过」的情况。以前先读 `replica.accountMode`，房主那边记成 null 时就会
   * 落回 `modeOf()`，于是「房主是纸面」把所有人都按成纸面，切了也不生效。
   * 都没选过时按纸面算：纸面是安全侧，不会拿别人的真钱下注。
   */
  #accountModeOf (account) {
    if (account === this.#state) {
      const own = this.#state.accountMode
      if (isFuturesAccountMode(own)) return own
      const mirrored = this.#state.replica?.accountMode
      if (isFuturesAccountMode(mirrored)) return mirrored
    } else {
      const chosen = account?.accountMode
      if (isFuturesAccountMode(chosen)) return chosen
    }
    // 谁都没选过（老存档）：跟着市场档位走——1.9 之前 `live` 就是「全场真钱」，
    // 那批存档读出来不能突然变成纸面。
    return this.modeOf() === 'live' ? 'live' : 'shadow'
  }

  /** 本机账户的档位：充值、提现、开仓、结算文案都按它分真钱与纸面。 */
  accountMode () {
    return this.#accountModeOf(this.#state)
  }

  /**
   * 1.12.6：本机**自己选过**的档位；没选过回 null。
   *
   * 和 `accountMode()` 的区别：那个会按 1.9 的老语义跟着市场档位走，所以「房主开的是
   * live」会被算成「每个 peer 都想玩真钱」。房主那边只需要知道我们自己选过什么，
   * 没选过就别去申报（否则每次报到都白推一格 seq）。
   */
  chosenAccountMode () {
    return isFuturesAccountMode(this.#state.accountMode) ? this.#state.accountMode : null
  }

  /** 账户权益：余额 + 已占保证金（不含浮盈——浮盈每 15 秒变，额度不该跟着抖）。 */
  #equityOf (account) {
    const target = account ?? this.#state
    const balance = Number.isFinite(target?.balance) ? target.balance : 0
    const used = Number.isFinite(target?.marginUsed) ? target.marginUsed : 0
    return roundCoin(balance + used)
  }

  /** 1.12.2：今天的日额上限——地板 5,000，权益多的人按 5 × 权益放大。 */
  #dayCapOf (account) {
    return dailyNotionalCapFor(this.#equityOf(account))
  }

  #disabled (account = this.#state) {
    return account?.disabled === true
  }

  /**
   * 统一的交易入口闸门（1.12.0）：**只看这个账户自己**。
   *
   * `disabled` = 自己退出过；`paused` = 自己按了暂停。房主的「关市」不再出现在这里——
   * 一台机器停不了别人的仓，这是 LAN 里唯一说得通的分权。
   */
  #gate (account = this.#state) {
    if (this.#disabled(account)) {
      return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
    }
    if (account?.paused === true) {
      return { ok: false, error: 'paused', notice: FUTURES_ERROR_TEXT.paused }
    }
    return null
  }

  #limitError (code, notice = FUTURES_ERROR_TEXT[code]) {
    return { ok: false, error: code, notice }
  }

  /** 本地自然日 00:00（票 98 的日额按本地时区归零）。 */
  #dayStartOf (stamp) {
    const date = new Date(stamp)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }

  #rollDay (stamp) {
    this.#rollDayFor(this.#state, stamp)
  }

  /** 每个账户各自按本地 00:00 归零日额（本地账本就是 `#state`，远端各有一份）。 */
  #rollDayFor (account, stamp) {
    const start = this.#dayStartOf(stamp)
    if (account.dayStart !== start) {
      account.dayStart = start
      account.dayNotional = 0
    }
  }

  /** 仓位 + 挂单冻结的名义（都按 `保证金 × 杠杆` 还原）。 */
  #notionalOfAccount (account) {
    const positions = Array.isArray(account?.positions) ? account.positions : []
    const orders = Array.isArray(account?.orders) ? account.orders : []
    return roundCoin(
      positions.reduce((sum, position) => sum + position.margin * position.leverage, 0) +
      orders.reduce((sum, order) => sum + order.marginFrozen * order.leverage, 0)
    )
  }

  /**
   * 票 98 的两道敞口闸门：先日额、再同时持仓名义。
   * 1.10.0：纸面账户（`shadow`）同样能交易，只是钱是纸面的，所以日额上限也是满的
   * `DAILY_NOTIONAL_CAP`——只是它的单永远只跟做市商成交，不与真钱账户的挂单交叉。
   * 返回 null 表示放行。
   */
  #checkLimits (account, notional, stamp) {
    const amount = nonNegativeCoin(notional)
    if (amount === null || amount <= 0) return null
    const owner = account ?? this.#state
    this.#rollDayFor(owner, stamp)
    const cap = this.#dayCapOf(owner)
    const usedDay = roundCoin(owner.dayNotional)
    if (owner.dayNotional + amount >= cap) {
      // 说清楚「还剩多少」：光一句「已到上限」看不出差多少，窗口也没法提示下一单该缩到多小。
      return this.#limitError('daily-cap',
        '今日交易额已到上限：上限 ' + cap + ' 名义，已用 ' + usedDay + '，这笔要 ' + amount +
        '，明天 00:00 重置。')
    }
    const usedPosition = this.#notionalOfAccount(account)
    if (usedPosition + amount >= POSITION_NOTIONAL_CAP) {
      return this.#limitError('notional-cap',
        '持仓名义已到上限：上限 ' + POSITION_NOTIONAL_CAP + ' 名义，已用 ' + usedPosition +
        '，这笔要 ' + amount + '，先平掉一点再开。')
    }
    return null
  }

  #recordNotional (account, notional, stamp) {
    const owner = account ?? this.#state
    this.#rollDayFor(owner, stamp)
    owner.dayNotional = roundCoin(owner.dayNotional + notional)
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
      // 票 97：保险基金余额、累计欠账、累计强平笔数（窗口顶部展示）。
      insurance: roundCoin(this.#state.insurance),
      shortfall: roundCoin(this.#state.shortfall),
      liquidationCount: this.#state.liquidationCount,
      // 1.12.4：做市商净盈亏——玩家赢的就是从这里付出去的，负得越多说明系统净付出越多。
      house: roundCoin(this.#state.house),
      // 票 98：模式、日额进度/上限、持仓上限、待提取与回滚标记。
      // 1.10.0：`mode` 是市场闸门，`accountMode` 是本账户自己的档位（真钱/纸面）。
      mode: this.modeOf(),
      accountMode: this.accountMode(),
      dayNotional: roundCoin(this.#state.dayNotional),
      dayCap: this.#dayCapOf(this.#state),
      positionCap: POSITION_NOTIONAL_CAP,
      pending: roundCoin(this.#state.pending),
      disabled: this.#state.disabled,
      paused: this.#state.paused === true,
      // 1.12.0：本地没暂停、账也没回滚，就能开新仓（别人暂停不影响你）。
      canTrade: this.#state.disabled !== true && this.#state.paused !== true,
      errorText: FUTURES_ERROR_TEXT,
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
   * 1.12.0：暂停 / 继续**自己的**交易。
   *
   * 这是「关市」下放之后唯一还需要的开关：暂停后不能开仓、不能挂单，已有仓位照常盯市、
   * 强平、交割，想减仓随时可以平——停的是「新风险」，不是「逃生的门」。
   */
  async setPaused (rawPaused, at = this.#nowMs()) {
    if (typeof rawPaused !== 'boolean') {
      return { ok: false, error: 'bad-paused', notice: '暂停开关只接受 true / false。' }
    }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    if (this.#disabled()) {
      return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
    }
    this.#state.paused = rawPaused
    // 1.12.2：`mode` 只是市场闸门的投影；暂停/继续都不该把账户自己的档位抹成纸面。
    if (rawPaused) this.#state.mode = 'off'
    else if (this.#state.mode === 'off') this.#state.mode = this.accountMode() === 'live' ? 'live' : 'shadow'
    this.#state.tradedAt = stamp
    this.#recordTrade({ at: stamp, kind: 'mode', note: rawPaused ? 'off' : 'live', lots: 0, price: 0, fee: 0 })
    this.#state.modeSeq += 1
    this.#state.seq = Math.max(this.#state.seq, this.#state.modeSeq)
    for (const account of Object.values(this.#state.remotes)) {
      account.updatedAt = stamp
      account.lastSeq = this.#state.seq
    }
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-pause',
      paused: rawPaused,
      mode: this.#state.mode,
      ...this.#view(),
      persisted
    }
  }

  /** 房主替 peer 记下它自己按的暂停（peer 那台已经先本地按下去了）。 */
  async setRemotePaused (deviceId, rawPaused, at = this.#nowMs()) {
    if (typeof rawPaused !== 'boolean') {
      return { ok: false, error: 'bad-paused', notice: '暂停开关只接受 true / false。' }
    }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const account = this.#remoteAccount(deviceId, stamp)
    if (account === null) return { ok: false, error: 'bad-device' }
    if (this.#disabled(account)) return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
    account.paused = rawPaused
    this.#bumpAccount(account, stamp)
    this.#recordRemoteTrade(deviceId, {
      at: stamp,
      kind: 'mode',
      note: rawPaused ? 'off' : 'live',
      lots: 0,
      price: 0,
      fee: 0
    }, stamp)
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-pause',
      accountMode: this.#accountModeOf(account),
      paused: rawPaused,
      account: this.#accountView(deviceId, stamp),
      seq: account.lastSeq,
      persisted
    }
  }

  /**
   * 票 98 的老接口，1.12.0 起退化成「暂停自己 / 继续自己」：
   * `off` = 按下暂停，`shadow` / `live` = 继续（并记住市场档位，只用于显示）。
   */
  async setMode (rawMode, at = this.#nowMs()) {
    if (!FUTURES_MODES.includes(rawMode)) {
      return { ok: false, error: 'bad-mode', notice: FUTURES_ERROR_TEXT['bad-mode'] }
    }
    const result = await this.setPaused(rawMode === 'off', at)
    if (result.ok !== true) return result
    if (rawMode === 'off') return { ...result, action: 'futures-mode' }
    // 1.12.2：老入口 `futures-mode` 以前是「市场档位」，现在等价于「把这个账户自己设成那个档位」。
    // 只改 `mode` 不改 `accountMode` 的话，账户档位仍然是纸面，充值也就仍然不碰农场。
    const applied = await this.setAccountMode(rawMode === 'live' ? 'live' : 'shadow', at)
    if (applied.ok !== true) return applied
    this.#state.mode = rawMode
    const persisted = await this.#persist()
    return { ...result, action: 'futures-mode', mode: rawMode, accountMode: this.accountMode(), persisted }
  }

  /**
   * 1.10.0：本机账户切换自己的档位（`shadow` 纸面 / `live` 真钱）。
   *
   * 为什么不再由房主统一决定：玩不玩真钱是每个人自己的事。房主只保留「关市」这一道
   * 全局闸门（`setMode('off')`），关市时谁都不能切、也不能交易。
   */
  async setAccountMode (rawMode, at = this.#nowMs()) {
    if (!isFuturesAccountMode(rawMode)) {
      return { ok: false, error: 'bad-account-mode', notice: FUTURES_ERROR_TEXT['bad-account-mode'] }
    }
    if (this.#disabled()) {
      return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
    }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    this.#state.accountMode = rawMode
    this.#state.tradedAt = stamp
    this.#recordTrade({ at: stamp, kind: 'mode', note: rawMode, lots: 0, price: 0, fee: 0 })
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-account-mode',
      accountMode: rawMode,
      ...this.#view(),
      persisted
    }
  }

  /**
   * 1.10.0：房主替 peer 记下它自己选的档位。钱在 peer 自己的农场上扣，
   * 房主这里只决定这本账按真钱还是纸面结算。
   */
  async setRemoteAccountMode (deviceId, rawMode, at = this.#nowMs()) {
    if (!isFuturesAccountMode(rawMode)) {
      return { ok: false, error: 'bad-account-mode', notice: FUTURES_ERROR_TEXT['bad-account-mode'] }
    }
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const account = this.#remoteAccount(deviceId, stamp)
    if (account === null) return { ok: false, error: 'bad-device' }
    if (this.#disabled(account)) return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
    account.accountMode = rawMode
    account.updatedAt = stamp
    const seq = this.#bumpAccount(account)
    this.#recordRemoteTrade(account, { at: stamp, kind: 'mode', note: rawMode, lots: 0, price: 0, fee: 0 })
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-account-mode',
      accountMode: rawMode,
      account: this.#accountView(account, stamp),
      seq,
      persisted
    }
  }

  /**
   * 票 98：影子对账。`diff = 按账面应当的农场硬币 - 真实农场硬币`。
   *
   * 影子模式没有任何真实流动（`farmIn/farmOut` 都是 0），所以只要农场没被别的
   * 模块动过，差额就是 0；切到 live 后的充提都会同时记进这两个计数器，差额仍是 0。
   */
  reconcile () {
    const farmCoins = this.#farmCoins()
    const custodyTotal = roundCoin(
      this.#state.balance +
      Object.values(this.#state.remotes).reduce((sum, account) => sum + account.balance, 0)
    )
    let positionsNotional = this.#notionalOfAccount(this.#state)
    for (const account of Object.values(this.#state.remotes)) {
      positionsNotional = roundCoin(positionsNotional + this.#notionalOfAccount(account))
    }
    const expected = roundCoin(this.#state.farmAnchor + this.#state.farmOut - this.#state.farmIn)
    return {
      ok: true,
      mode: this.modeOf(),
      farmCoins,
      custodyTotal,
      positionsNotional,
      diff: roundCoin(expected - farmCoins)
    }
  }

  /**
   * 1.12.0：退出（只作用于**自己**这一本账）。
   *
   * 顺序：撤掉自己的挂单释放冻结 → 按当前公允价强平自己的仓位 → 托管余额退回自己的农场
   * （撞上限的部分留在托管账标 pending）→ 自己的账户标 `disabled`。别人的账、别人的钱一概不碰：
   * 房主退出不再替全场退款，也不会把邻居的余额记到自己农场上（票 98 的那条偏差就此消掉）。
   * 数据不删：仓位/流水都还在，只是不能再开新仓。
   */
  async rollback ({ at = this.#nowMs() } = {}) {
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    // peer 的账在房主那台，本地只有副本；替它「回滚」只会把两边账本扯歪。
    if (this.#state.replica !== null && this.#state.replica !== undefined) {
      return { ok: false, error: 'not-owner', notice: FUTURES_ERROR_TEXT['not-owner'] }
    }
    // 先确认每个仓位都拿得到当前公允价；有一个拿不到就整笔取消，避免“平到一半”。
    const targets = []
    for (const position of this.#state.positions) {
      const price = this.#fairAt(position.crop, position.contract, stamp)
      if (price === null) return { ok: false, error: 'market-closed', notice: '有仓位拿不到公允价，退出已取消。' }
      targets.push({ account: this.#state, position, local: true, deviceId: 'local', price })
    }

    // 撤单：冻结的保证金先回到余额，才能整笔退给农场。
    for (const order of this.#state.orders) this.#state.balance = roundCoin(this.#state.balance + order.marginFrozen)
    this.#state.orders = []
    this.#state.marginUsed = this.#recomputeMarginUsed()

    for (const target of targets) {
      const pnl = pnlOf({
        lots: target.position.lots,
        entry: target.position.entry,
        exit: target.price,
        side: target.position.side
      })
      this.#liquidate({
        account: target.account,
        position: target.position,
        local: target.local,
        deviceId: target.local ? null : target.deviceId,
        hit: { at: stamp, price: target.price, pnl, trigger: true }
      }, stamp)
    }

    const refunds = []
    refunds.push(await this.#refundAccount(this.#state, 'local'))

    this.#state.disabled = true
    this.#state.paused = false
    this.#recordTrade({ at: stamp, kind: 'mode', note: 'off', lots: 0, price: 0, fee: 0 })
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-rollback',
      refunds,
      disabled: true,
      mode: this.#state.mode,
      ...this.#view(),
      pending: roundCoin(this.#state.pending),
      persisted
    }
  }

  /** 回滚时把一个托管账户的余额退回农场；撞上限的部分留在余额并标 pending。 */
  async #refundAccount (account, deviceId) {
    const amount = roundCoin(account.balance)
    let credited = 0
    if (amount > 0) {
      try {
        const added = await this.#farm.addCoins(amount)
        if (added !== null && added.ok === true && Number(added.qty) > 0) {
          credited = roundCoin(Number(added.qty))
        }
      } catch {
        // 农场拒绝时全部留作 pending，不静默丢钱。
      }
    }
    const pending = roundCoin(amount - credited)
    account.balance = pending
    account.pending = pending
    this.#state.farmOut = roundCoin(this.#state.farmOut + credited)
    return { deviceId, credited, pending }
  }

  /**
   * 票 96：交割窗口。19:15/19:30/19:45/20:00 四根收盘价从 `deliveryClosesOf` 来，
   * 交割价与窗口复核共用同一组到分数值。
   * 日合约的每个交易日都是到期日，所以工作日全天都返回今天这张；20:00 之后
   * `contractOf` 已返回 null，用 `dayWindowOf` 把「今天这张」取回来。
   */
  #deliveryOf (crop, stamp) {
    const window = dayWindowOf(crop, stamp)
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

  /**
   * 票 96：交易中 / 今日已收盘 / 周末三态；文案由账本层统一给，窗口不自己拼。
   * 1.10.0：档位（真钱/纸面）不再是「一种休市状态」——纸面账户照常交易，档位由窗口
   * 单独画一枚徽章（`accountMode`），不再顶替合约状态。
   */
  #sessionOf (crop, stamp) {
    // 1.12.0：只有自己退出过（`disabled`）才盖住合约状态；暂停只是「不开新仓」，
    // 行情、平仓、交割照旧，所以这里不拦。
    if (this.#state.disabled) {
      return { kind: 'off', text: '期货未开放' }
    }
    const contract = contractOf(crop, stamp)
    if (contract !== null) {
      return { kind: 'trading', text: contract.id + ' 交易中，今天 20:00 交割。' }
    }
    if (dayWindowOf(crop, stamp) !== null) {
      return { kind: 'expired', text: '今日合约已交割，明天 00:00 开新合约。' }
    }
    return { kind: 'weekend', text: '周末休市，周一 00:00 开新合约。' }
  }

  #unrealizedOf (position, at) {
    const quote = this.quoteOf(position.crop, at)
    if (quote === null) return 0
    const exit = position.side === 'long' ? quote.bid : quote.ask
    return pnlOf({ lots: position.lots, entry: position.entry, exit, side: position.side })
  }

  /** 充值：真钱档农场扣 coins、托管余额加同样的数；纸面档只记托管账。 */
  async deposit (rawCoins) {
    const blocked = this.#gate()
    if (blocked !== null) return blocked
    const coins = positiveInt(rawCoins, MAX_COINS)
    if (coins === null) return { ok: false, error: 'bad-amount' }
    if (this.accountMode() === 'shadow') {
      this.#state.balance = roundCoin(this.#state.balance + coins)
      this.#state.tradedAt = this.#nowMs()
      const persisted = await this.#persist()
      return {
        ok: true,
        action: 'futures-deposit',
        coins,
        shadow: true,
        mode: 'shadow',
        ...this.#view(),
        persisted
      }
    }
    const spent = await this.#farm.spendCoins(coins)
    if (spent === null || spent.ok !== true) {
      return { ok: false, error: spent?.error === 'no-coin' ? 'no-coin' : 'farm-refused' }
    }
    // 农场的契约是「要么整笔划出来，要么失败」；真有实现只回 `ok` 不回 `qty` 时，按我们请求的
    // 金额记账——否则农场扣了钱、托管没加钱，用户的硬币就这么没了（QA 探针踩到过）。
    const credited = roundCoin(Number.isFinite(Number(spent.qty)) ? Number(spent.qty) : coins)
    this.#state.balance = roundCoin(this.#state.balance + credited)
    this.#state.farmIn = roundCoin(this.#state.farmIn + credited)
    this.#state.tradedAt = this.#nowMs()
    const persisted = await this.#persist()
    return { ok: true, action: 'futures-deposit', coins: credited, ...this.#view(), persisted }
  }

  /**
   * 提现：托管余额减少、农场硬币增加。
   *
   * 农场 `addCoins` 在上限 1,000,000 处**静默截断**，所以这里按 1,000,000 分批并核对
   * 每一批的实收 `qty`：收多少就扣多少，剩下的留在托管账户里，绝不「账上扣了、农场没进」。
   * 票 98：撞上限的余额留在 `balance` 并标 `pending`，同时返回中文 `notice`。
   * 纸面档（`accountMode: 'shadow'`）不碰农场：整笔都算「已提现」，只在托管账上减。
   */
  async withdraw (rawCoins) {
    // 提现是把钱拿回来，属于减风险：暂停着也要能提（暂停锁的是「新仓」，不是「逃生门」）。
    if (this.#disabled()) return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
    // 提现不受农场单次上限约束：正是「一次提一大笔」才需要分批。
    const coins = positiveInt(rawCoins, Number.MAX_SAFE_INTEGER)
    if (coins === null) return { ok: false, error: 'bad-amount' }
    const available = Math.floor(this.#state.balance)
    if (available < coins) return { ok: false, error: 'no-balance' }
    if (this.accountMode() === 'shadow') {
      this.#state.balance = roundCoin(this.#state.balance - coins)
      this.#state.tradedAt = this.#nowMs()
      const persisted = await this.#persist()
      return {
        ok: true,
        action: 'futures-withdraw',
        coins,
        credited: coins,
        pending: 0,
        shadow: true,
        mode: 'shadow',
        ...this.#view(),
        persisted
      }
    }
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
    const uncredited = roundCoin(coins - credited)
    this.#state.balance = roundCoin(this.#state.balance - credited)
    // 撞上限时，剩下的整笔余额都提不动，统一标成 pending；全额提成功时，
    // 旧 pending 里被这次提走的部分要相应扣掉。
    this.#state.pending = uncredited > 0
      ? this.#state.balance
      : Math.max(0, roundCoin(this.#state.pending - credited))
    this.#state.farmOut = roundCoin(this.#state.farmOut + credited)
    this.#state.tradedAt = this.#nowMs()
    const persisted = await this.#persist()
    const result = {
      ok: true,
      action: 'futures-withdraw',
      coins: credited,
      credited,
      ...this.#view(),
      persisted
    }
    if (uncredited > 0) {
      result.notice = '农场硬币到上限了，剩 ' + this.#state.pending + ' 留在托管账待提取。'
    }
    return result
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
    // 1.12.0：充值也只看这个账户自己（暂停/退出的人不收钱）。
    const blocked = this.#gate(account)
    if (blocked !== null) return blocked
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
    // 1.12.0：闸门看的是**这个账户自己**的暂停/退出，不是房主的状态。
    const blocked = this.#gate(account)
    if (blocked !== null) return blocked
    // 一条 settle 最多 8 条持仓：超了协议就装不下，所以房主必须在这里拒绝，而不是发不出去。
    if (account.positions.length >= FUTURES_MAX_POSITIONS) return { ok: false, error: 'position-limit' }
    const quote = this.quoteOf(crop, stamp)
    if (quote === null) {
      return this.#closedError(crop, stamp) ?? { ok: false, error: 'market-closed', notice: '现货指数未就绪。' }
    }
    if (this.#state.delivered[quote.contract.id] !== undefined) {
      return { ok: false, error: 'contract-expired', notice: '合约已到期，20:00 后停止交易。' }
    }
    const notional = roundCoin(Number(margin) * Number(leverage))
    // 票 110：市价单先吃邻居的挂单，剩下才找做市商。
    const plan = this.#planMarketOpen(account, { quote, side, notional, leverage })
    // 余额先判：买不起的单本来就该回 no-balance（不该被说成限额）；
    // 买得起才看日额/持仓两道闸门，被限额拒绝时账上一分不动。
    if (account.balance < roundCoin(plan.margin + plan.fee)) return { ok: false, error: 'no-balance' }
    const limited = this.#checkLimits(account, notional, stamp)
    if (limited !== null) return limited

    const filled = this.#commitMarketOpen(account, { crop, quote, side, leverage, stamp, plan, local: false })
    const position = filled.positions[0]
    account.updatedAt = stamp
    const seq = this.#bumpAccount(account)
    this.#recordNotional(account, notional, stamp)
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-open',
      position: { ...position },
      lots: filled.lots,
      price: filled.price,
      fee: filled.fee,
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
    // 平仓是减风险：账户暂停着也允许（停的是「新风险」，不是「逃生的门」）。
    if (this.#disabled(account)) return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
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
    this.#bookPnl(pnl, stamp, account)
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
    // 转现货是减风险：暂停着也允许。
    if (this.#disabled()) return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
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
    this.#chargeFee(plan.fee, this.#state)
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
    // 转现货也是减风险，暂停着照样能动。
    if (this.#disabled(account)) return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
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
    this.#chargeFee(plan.fee, account)
    this.#bookPnl(plan.pnl, stamp, account)
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
   * 票 96/97：一个账户的到期处理——先撤该合约全部挂单（退冻结），再按交割价现金结清全部仓位。
   * `credit = max(0, margin + pnl)`；交割费按交割名义收 0.1%，从释放出来的钱里扣，收不上来
   * 的部分和亏穿的保证金合称「亏空」，走 `#coverHole`：先花保险基金、再记欠账，余额绝不为负。
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
      const gross = roundCoin(position.margin + pnl)
      const credit = Math.max(0, gross)
      const deliveryFee = roundCoin(notionalOf({ lots: position.lots, price }) * DELIVERY_FEE_RATE)
      // 交割费只能从释放出来的钱里收；收不到的部分并进亏空（与强平同一条兜底）。
      // `net` 只扣**真收到**的那部分，否则同一笔收不上来的费会既扣余额又花基金。
      const paidFee = Math.min(deliveryFee, credit)
      const net = roundCoin(credit - paidFee)
      const gap = roundCoin(Math.max(0, -gross) + Math.max(0, deliveryFee - credit))
      // 1.10.0：纸面账户的亏空是纸面的，不能花真钱保险基金。
      const covered = this.#accountModeOf(account) === 'shadow'
        ? { paid: 0, owed: 0 }
        : this.#coverHole(gap)
      account.balance = roundCoin(account.balance + net)
      this.#state.closed += 1
      if (paidFee > 0) this.#chargeFee(paidFee, account)
      const trade = {
        at: stamp,
        crop: position.crop,
        contract: position.contract,
        side: position.side === 'long' ? 'short' : 'long',
        lots: position.lots,
        price,
        fee: paidFee,
        kind: 'delivery',
        deliveryFee: paidFee
      }
      if (local) {
        this.#bookPnl(pnl, stamp)
        this.#recordTrade(trade)
      } else {
        this.#bookPnl(pnl, stamp, account)
        this.#recordRemoteTrade(account, trade)
      }
      delivered.push({
        position: { ...position },
        pnl,
        credit,
        deliveryFee: paidFee,
        net,
        gap,
        fundPaid: covered.paid,
        shortfall: covered.owed
      })
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
      return {
        balance: 0,
        marginUsed: 0,
        equity: 0,
        positions: [],
        orders: [],
        trades: [],
        // 票 98：还没建账的 peer 也要看到房主刚拨过的模式；用模式版本号，
        // 切档后的第一份 settle 才不会被对端当重复包丢掉。
        seq: this.#state.modeSeq,
        epoch: this.#state.epoch,
        pending: 0
      }
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
  applySettle ({
    epoch,
    seq,
    balance,
    marginUsed,
    positions,
    orders,
    trades,
    insurance,
    shortfall,
    house,
    mode,
    accountMode,
    paused,
    pending,
    at = this.#nowMs()
  } = {}) {
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
    // 票 97：保险基金与欠账是**房主账本的全局数**（peer 只显示，不参与计算）。
    // 旧房主不发这两个数时按 0 处理，不把整包判坏。
    const safeInsurance = insurance === undefined ? 0 : nonNegativeCoin(insurance)
    const safeShortfall = shortfall === undefined ? 0 : nonNegativeCoin(shortfall)
    if (safeInsurance === null || safeShortfall === null) return { ok: false, error: 'bad-fund' }
    // 1.12.4：做市商净盈亏（允许为负，老房主不发时按 0，不判坏包）。
    const safeHouse = house === undefined ? 0 : finiteNumber(house)
    if (safeHouse === null) return { ok: false, error: 'bad-fund' }
    // 票 98：房主把当前模式与待提取余额一起下发；老房主不发时按缺省处理，不判坏包。
    const safeMode = mode === undefined
      ? FUTURES_DEFAULT_MODE
      : FUTURES_MODES.includes(mode) ? mode : null
    if (safeMode === null) return { ok: false, error: 'bad-mode' }
    const safePending = pending === undefined ? 0 : nonNegativeCoin(pending)
    if (safePending === null) return { ok: false, error: 'bad-pending' }
    // 1.10.0：房主把「你这个账户的档位」回传（peer 窗口据此显示真钱/纸面）。
    const safeAccountMode = accountMode === undefined || accountMode === null
      ? null
      : (isFuturesAccountMode(accountMode) ? accountMode : undefined)
    if (safeAccountMode === undefined) return { ok: false, error: 'bad-account-mode' }
    // 1.12.0：账户自己按的暂停，房主随账目回传（老房主不发 = 没暂停）。
    if (paused !== undefined && typeof paused !== 'boolean') return { ok: false, error: 'bad-paused' }
    const safePaused = paused === true
    this.#state.replica = {
      epoch,
      lastSeq: seq,
      balance: safeBalance,
      marginUsed: safeMarginUsed,
      positions: accountPositions,
      orders: accountOrders,
      trades: accountTrades,
      insurance: safeInsurance,
      shortfall: safeShortfall,
      house: safeHouse,
      mode: safeMode,
      accountMode: safeAccountMode,
      paused: safePaused,
      pending: safePending,
      updatedAt: stamp
    }
    return { ok: true, applied: true }
  }

  /** 1.12.0（B）：把整本账打成一份可广播的快照。 */
  ledgerSnapshotOf ({ hostId = '', at = this.#nowMs() } = {}) {
    const state = this.#state
    const accounts = [{ deviceId: hostId, ...accountSnapshotOf(state) }]
    for (const [deviceId, account] of Object.entries(state.remotes)) {
      accounts.push({ deviceId, ...accountSnapshotOf(account) })
    }
    return {
      v: 1,
      epoch: state.epoch,
      seq: state.seq,
      at,
      hostId,
      insurance: roundCoin(state.insurance),
      shortfall: roundCoin(state.shortfall),
      liquidationCount: state.liquidationCount,
      house: roundCoin(state.house),
      delivered: { ...state.delivered },
      accounts
    }
  }

  /** peer 侧收下快照：只留最新的一份，供换房主时接管。 */
  async applyLedgerSnapshot (raw) {
    const ledger = normalizeLedgerSnapshot(raw)
    if (ledger === null) return { ok: false, error: 'bad-ledger' }
    const current = this.#state.ledger
    const older = current !== null && current !== undefined &&
      (current.epoch === ledger.epoch ? current.seq >= ledger.seq : current.at > ledger.at)
    if (older) {
      return { ok: true, action: 'futures-ledger', applied: false, epoch: current.epoch, seq: current.seq }
    }
    this.#state.ledger = ledger
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-ledger',
      applied: true,
      epoch: ledger.epoch,
      seq: ledger.seq,
      accounts: ledger.accounts.length,
      persisted
    }
  }

  /** 本机账本还是空的、手上又有一份别人广播的快照 → 该接管了。 */
  adoptableLedger () {
    const ledger = this.#state.ledger
    if (ledger === null || ledger === undefined) return null
    const state = this.#state
    // 判断「空」只看账本内容，不看 epoch：`#persist()` 会给空账本补一个随机 epoch。
    if (Object.keys(state.remotes).length > 0) return null
    if (state.balance > 0 || state.marginUsed > 0 || state.pending > 0) return null
    if (state.positions.length > 0 || state.orders.length > 0) return null
    if (state.trades.length > 0) return null
    if (state.disabled === true) return null
    return ledger
  }

  /**
   * 1.12.0（B）：接手别人广播的整本账。
   *
   * 谁是本机（`selfId`）谁的账就落进本地账本，其余进 `remotes`；认不出的账户直接跳过
   * （换机器/改 deviceId 之后旧账户就留在快照里，不动它比乱认强）。
   */
  async adoptLedger (raw, { selfId = '', at = this.#nowMs() } = {}) {
    const ledger = normalizeLedgerSnapshot(raw)
    if (ledger === null) return { ok: false, error: 'bad-ledger' }
    if (typeof selfId !== 'string' || selfId === '') return { ok: false, error: 'bad-device' }
    const state = this.#state
    const own = ledger.accounts.find((account) => account.deviceId === selfId) ?? null
    const remotes = {}
    for (const account of ledger.accounts) {
      if (account.deviceId === selfId) continue
      remotes[account.deviceId] = normalizeRemoteAccount(account)
    }
    state.epoch = ledger.epoch
    state.seq = Math.max(state.seq, ledger.seq)
    state.insurance = ledger.insurance
    state.shortfall = ledger.shortfall
    state.liquidationCount = ledger.liquidationCount
    state.house = ledger.house
    state.delivered = { ...ledger.delivered }
    state.remotes = remotes
    if (own !== null) {
      state.balance = own.balance
      state.marginUsed = own.marginUsed
      state.positions = own.positions.map((position) => ({ ...position }))
      state.orders = own.orders.map((order) => ({ ...order }))
      state.trades = own.trades.map((trade) => ({ ...trade }))
      state.pending = own.pending
      state.dayStart = own.dayStart
      state.dayNotional = own.dayNotional
      state.accountMode = own.accountMode
      state.paused = own.paused === true
      state.disabled = own.disabled === true
    }
    state.tradedAt = at
    // 接管完就把快照放下：账本已经变成活的，再留一份只会让下一次判断「空不空」变糊。
    state.ledger = null
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-ledger-adopt',
      epoch: ledger.epoch,
      seq: ledger.seq,
      accounts: ledger.accounts.length,
      adoptedSelf: own !== null,
      persisted
    }
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
      trades: (replica.trades ?? []).map((trade) => ({ ...trade })),
      // 票 97：房主广播过来的全局基金/欠账（peer 只读）。
      insurance: roundCoin(replica.insurance ?? 0),
      shortfall: roundCoin(replica.shortfall ?? 0),
      // 1.12.4：做市商净盈亏（负 = 系统净付出）。
      house: roundCoin(replica.house ?? 0),
      // 票 98：模式与待提取余额也跟随房主；1.10.0：账户档位同样以房主回传的为准。
      mode: FUTURES_MODES.includes(replica.mode) ? replica.mode : FUTURES_DEFAULT_MODE,
      accountMode: isFuturesAccountMode(replica.accountMode) ? replica.accountMode : null,
      paused: replica.paused === true,
      pending: roundCoin(replica.pending ?? 0)
    }
  }

  /** 票 96：20:00 之后与周末都按 `market-closed` 拒绝，只有文案区分；已有仓位走 `contract-expired`。 */
  #closedError (crop, stamp) {
    if (contractOf(crop, stamp) !== null) return null
    if (dayWindowOf(crop, stamp) !== null) {
      return { ok: false, error: 'market-closed', notice: '今日合约已交割，20:00 后停止交易，明天 00:00 开新合约。' }
    }
    return { ok: false, error: 'market-closed', notice: '周末休市，周一 00:00 开新合约。' }
  }

  /** 吃单开仓：做多吃卖一、做空吃买一；保证金与手续费当场从余额划走。 */
  async open ({ crop, side, margin, leverage, at = this.#nowMs() }) {
    const blocked = this.#gate()
    if (blocked !== null) return blocked
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
      return { ok: false, error: 'contract-expired', notice: '合约已到期，20:00 后停止交易。' }
    }
    const notional = roundCoin(Number(margin) * Number(leverage))
    // 票 110：市价单先吃邻居的挂单，剩下才找做市商——「你赚的钱是邻居亏的钱」从这里开始。
    const plan = this.#planMarketOpen(this.#state, { quote, side, notional, leverage })
    if (this.#state.balance < roundCoin(plan.margin + plan.fee)) return { ok: false, error: 'no-balance' }
    const limited = this.#checkLimits(this.#state, notional, stamp)
    if (limited !== null) return limited
    const filled = this.#commitMarketOpen(this.#state, { crop, quote, side, leverage, stamp, plan, local: true })
    const position = filled.positions[0]
    this.#recordNotional(this.#state, notional, stamp)
    this.#recordTrade({
      at: stamp,
      crop,
      contract: quote.contract.id,
      side,
      lots: filled.lots,
      price: filled.price,
      fee: filled.fee,
      kind: 'open'
    })
    const persisted = await this.#persist()
    return {
      ok: true,
      action: 'futures-open',
      position: { ...position },
      lots: filled.lots,
      price: filled.price,
      fee: filled.fee,
      ...this.#view(),
      persisted
    }
  }

  /**
   * 挂限价单（票 95）：下单即把保证金从余额划进「冻结」，成交/撤单时才动。
   * `deviceId` 给了就走房主的 `hostPlace`（peer 的单记在 `remotes` 上）。
   */
  async place ({ crop, side, price, lots, leverage, at = this.#nowMs(), deviceId = null } = {}) {
    const blocked = this.#gate()
    if (blocked !== null) return blocked
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
    // 1.12.0：挂单是加风险，按这个账户自己的暂停/退出拦。
    const blocked = this.#gate(account)
    if (blocked !== null) return blocked
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
    // 撤单是减风险：暂停着也允许把单撤掉。
    if (this.#disabled()) return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
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
    // 撤单不制造新风险，暂停着也允许。
    if (this.#disabled(account)) return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
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
      // 1.10.0：两本账不交叉——纸面账户的单只碰做市商，真钱账户之间才互相撮合。
      // 否则纸面账户等于拿假钱去赚真钱玩家的真钱，保险基金迟早被掏空。
      for (const book of FUTURES_ACCOUNT_MODES) {
        const orders = pools.orders.filter((order) => this.#orderModeOf(pools, order) === book)
        if (orders.length < 2) continue
        const due = matchOrders({ orders, contract, at: stamp })
        for (const fill of due) {
          const parties = this.#applyFill(pools, fill, stamp)
          if (parties === null) continue
          fills += 1
          for (const party of parties) if (party.deviceId !== undefined) touched.set(party.deviceId, party.account)
        }
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
      return { ok: false, error: 'contract-expired', notice: '合约已到期，20:00 后停止交易。' }
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
    const notional = roundCoin(order.marginFrozen * order.leverage)
    const cost = roundCoin(order.marginFrozen + takerFeeOf(notionalOf({ lots: order.lots, price: order.price })))
    if (account.balance < cost) return { ok: false, error: 'no-balance' }
    // 票 98：挂单也占日额与同时持仓名义（用冻结保证金还原名义）。
    // 1.10.0：纸面账户同样能挂单，只是它的单只跟做市商成交（见 `#matchPool`）。
    const limited = this.#checkLimits(account, notional, order.at)
    if (limited !== null) return limited
    account.orders.push(order)
    account.balance = roundCoin(account.balance - order.marginFrozen)
    account.marginUsed = this.#recomputeFor(account)
    this.#recordNotional(account, notional, order.at)
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

  /** 1.10.0：一条挂单属于哪本账（`shadow` 纸面 / `live` 真钱）。 */
  #orderModeOf (pools, order) {
    const pool = pools.owners.get(order.id)
    if (pool === undefined) return FUTURES_DEFAULT_ACCOUNT_MODE
    return this.#accountModeOf(pool.account)
  }

  /** 把一个合约上所有账户的挂单摊平成一盘，`owners` 记住每条单属于谁。 */
  #orderPools (contract) {    const local = { account: this.#state, local: true }
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
    this.#chargeFee(fee, account)
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


  /**
   * 票 110（B 方案）：市价单先吃邻居的挂单。
   *
   * 同一合约、同一本账（纸面与真钱不交叉）、对手方向、价格不劣于做市商那一侧的挂单，
   * 按价格优先取走；同价按挂单先后。成交价就是挂单价——比做市商便宜的那部分，是邻居让的。
   */
  #bookParts (account, { contract, side, lots, touch }) {
    const pools = this.#orderPools(contract)
    const book = this.#accountModeOf(account)
    const opposite = side === 'long' ? 'short' : 'long'
    const eligible = []
    for (const order of pools.orders) {
      if (order.side !== opposite || !(order.lotsLeft > 0)) continue
      if (this.#orderModeOf(pools, order) !== book) continue
      const limit = Number(order.price)
      if (!Number.isFinite(limit) || limit <= 0) continue
      if (side === 'long' ? limit > touch : limit < touch) continue
      const owner = pools.owners.get(order.id)
      if (owner === undefined) continue
      eligible.push({ order, owner })
    }
    eligible.sort((a, b) => {
      const delta = Number(a.order.price) - Number(b.order.price)
      return side === 'long' ? delta : -delta
    })
    const parts = []
    let left = lots
    for (const entry of eligible) {
      if (left <= 0) break
      const take = Math.min(left, entry.order.lotsLeft)
      if (!(take > 0)) continue
      parts.push({ order: entry.order, owner: entry.owner, lots: take, price: Number(entry.order.price) })
      left -= take
    }
    return { parts, left }
  }

  /** 算一笔市价开仓会吃到什么价：邻居那部分按挂单价，余量按做市商那一侧。 */
  #planMarketOpen (account, { quote, side, notional, leverage }) {
    const touch = fillPriceOf(quote, side)
    const lots = lotsFor({ notional, price: touch })
    const { parts: bookParts, left } = this.#bookParts(account, { contract: quote.contract.id, side, lots, touch })
    const parts = [...bookParts]
    if (left > 0) parts.push({ lots: left, price: touch })
    let margin = 0
    let fee = 0
    for (const part of parts) {
      margin += marginOf({ lots: part.lots, price: part.price, leverage })
      fee += takerFeeOf(notionalOf({ lots: part.lots, price: part.price }))
    }
    return { lots, touch, parts, margin: roundCoin(margin), fee: roundCoin(fee) }
  }

  /** 落账：邻居那几笔先给 maker 开仓（保证金从冻结里出），再给 taker 开仓、扣保证金与手续费。 */
  #commitMarketOpen (account, { crop, quote, side, leverage, stamp, plan, local }) {
    const positions = []
    for (const part of plan.parts) {
      if (part.order !== undefined) {
        const frozen = this.#takeFrozen(part.order, part.lots)
        this.#openFromOrder(part.owner, part.order, part.lots, part.price, frozen, stamp)
      }
      const slot = this.#slotOf(stamp)
      const position = {
        id: randomUUID(),
        crop,
        contract: quote.contract.id,
        side,
        lots: part.lots,
        entry: part.price,
        margin: marginOf({ lots: part.lots, price: part.price, leverage }),
        leverage,
        openedAt: stamp,
        slot,
        settleSlot: slot + 1
      }
      account.positions.push(position)
      positions.push(position)
    }
    account.balance = roundCoin(account.balance - plan.margin - plan.fee)
    account.marginUsed = this.#recomputeFor(account)
    this.#chargeFee(plan.fee, account)
    // 吃空的挂单当场摘掉：`lotsLeft: 0` 留在账本里，settle 的 `orders` 就成了坏字段。
    this.#pruneOrders()
    if (local) this.#state.tradedAt = stamp
    return { positions, lots: plan.lots, price: plan.touch, margin: plan.margin, fee: plan.fee }
  }

  /** 主动平仓：按当前对手价成交，保证金 + 盈亏记回余额。合约过期后只能等交割（票 96）。 */
  async close ({ id, at = this.#nowMs() }) {
    // 平仓是减风险：暂停着也允许（停的是「新风险」，不是「逃生的门」）。
    if (this.#disabled()) return { ok: false, error: 'disabled', notice: FUTURES_ERROR_TEXT.disabled }
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
   * 逐根盯市 + 逐拍强平（票 97）。
   *
   * 盯市 = 把浮盈浮亏记进 `balance`，入场价改成收盘价，仓位继续持有、保证金不动——
   * 这样一根接一根地拿，不会被「这只是浮盈」卡住。
   *
   * 强平不再看「这一根的收盘价」，而是**按路径扫**：对每个仓位（本地 + 所有远端）从上次
   * 盯市时刻一直采样到 `now`（15 秒一格，正好是价格的生成分辨率），第一个让
   * `盈亏 ≤ -保证金` 的采样点就是触发点。收盘价在插针面前是瞎子，路径扫描不是。
   *
   * 同一拍里先算完所有触发点，按「触发时刻 → 建仓时间 → id」排序后逐笔强平，再对剩下
   * 的仓位逐根盯市。排序让结果可复现：文件里仓位的先后、远端账户的遍历顺序都不影响成交。
   * 结算时点由仓位自己的 `settleSlot` 决定，所以重复调用、重启、补算走同一条路径。
   */
  async settleDue (at = this.#nowMs()) {
    const stamp = Number.isFinite(Number(at)) ? Number(at) : this.#nowMs()
    const settled = []
    // 票 97：先把这一拍所有该强平的仓位找出来、排好队；强平之间互不影响，顺序只为可复现。
    const remoteHits = new Map()
    for (const hit of this.#liquidationHits(stamp)) {
      const entry = this.#liquidate(hit, stamp)
      if (hit.local) {
        settled.push(entry)
        continue
      }
      let list = remoteHits.get(hit.deviceId)
      if (list === undefined) {
        list = []
        remoteHits.set(hit.deviceId, list)
      }
      list.push(entry)
    }

    for (let i = this.#state.positions.length - 1; i >= 0; i -= 1) {
      const position = this.#state.positions[i]
      const outcome = this.#settlePositionAt(position, stamp)
      if (outcome === null) continue
      if (outcome.liquidated) {
        // 扫描窗口已经覆盖到这个时刻；走到这里只可能是「结算价恰好压线」的边界情况，
        // 同样走强平那条路——余额绝不允许被记成负数。
        settled.push(this.#liquidate({
          account: this.#state,
          position,
          local: true,
          deviceId: null,
          hit: outcome
        }, stamp))
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
      const entries = [
        ...(remoteHits.get(deviceId) ?? []),
        ...this.#settleRemoteAccount(account, stamp)
      ]
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
   * 票 97：这一拍所有被扫到的强平点，已按「触发时刻 → 建仓时间 → id」排好。
   * 排序用 `<` 比较字符串（不依赖 locale），同一份盘在不同机器上顺序一致。
   */
  #liquidationHits (stamp) {
    const hits = []
    const consider = (account, position, local, deviceId) => {
      const hit = this.#scanLiquidation(position, stamp)
      if (hit !== null) hits.push({ account, position, local, deviceId, hit })
    }
    for (const position of this.#state.positions) consider(this.#state, position, true, null)
    for (const [deviceId, account] of Object.entries(this.#state.remotes)) {
      for (const position of account.positions) consider(account, position, false, deviceId)
    }
    hits.sort((a, b) => {
      if (a.hit.at !== b.hit.at) return a.hit.at - b.hit.at
      if (a.position.openedAt !== b.position.openedAt) return a.position.openedAt - b.position.openedAt
      if (a.position.id === b.position.id) return 0
      return a.position.id < b.position.id ? -1 : 1
    })
    return hits
  }

  /**
   * 票 97：从上次检查时刻扫到 `now`，返回第一个「保证金被吃穿」的采样点。
   *
   * 起点取 `max(openedAt, 上次盯市那根的起点)`：盯市会把 `entry` 改成那一根收盘价，
   * 所以更早的路径属于上一次检查、不该重复扫。终点不越过到期前一刻（到期后由交割接管）。
   */
  #scanLiquidation (position, stamp) {
    const window = contractWindowOf(position.contract)
    if (window === null) return null
    const start = Math.max(position.openedAt, (position.settleSlot - 1) * SLOT_MS)
    const end = Math.min(stamp, window.expireAt - 1)
    if (!(end >= start)) return null
    // 价格的原生分辨率就是 15 秒一格：对齐到网格逐格扫，插针不会落在网格之间。
    let at = Math.ceil(start / OU_STEP_MS) * OU_STEP_MS
    let last = null
    for (; at <= end; at += OU_STEP_MS) {
      const sample = this.#liquidationSample(position, at)
      if (sample === null) return null // 没有指数价：本拍跳过，下一拍再试
      if (sample.trigger) return sample
      last = at
    }
    // `now` 一般不在 15 秒网格上：补采末尾那半格，否则最后不到 15 秒的行情会被漏掉。
    if (last !== null && last < end) {
      const sample = this.#liquidationSample(position, end)
      if (sample !== null && sample.trigger) return sample
    }
    return null
  }

  #liquidationSample (position, at) {
    const price = this.#fairAt(position.crop, position.contract, at)
    if (price === null) return null
    const pnl = pnlOf({ lots: position.lots, entry: position.entry, exit: price, side: position.side })
    // 强平线 = 1/杠杆：`pnl <= -margin` 与「权益归零」是同一件事（保证金就是开仓时压的钱）。
    return { at, price, pnl, trigger: roundCoin(position.margin + pnl) <= 0 }
  }

  /**
   * 票 97：执行一笔强平。
   *
   * 成交价 = 触发点的公允价（不是收盘价、也不是交割价），并收一腿 taker 费。
   * 能收回来的钱 `credit = max(0, 保证金 + 盈亏 - 费用)` 回余额；收不上来的费用和亏穿的
   * 保证金合称「亏空」，先由保险基金垫，基金不够就累计欠账，绝不把余额记成负数。
   */
  #liquidate ({ account, position, local, deviceId, hit }, stamp) {
    const fee = takerFeeOf(notionalOf({ lots: position.lots, price: hit.price }))
    const gross = roundCoin(position.margin + hit.pnl)
    // 账户里只剩 `max(0, gross)` 这点钱，费用只能从这里收；收不到的部分并进亏空。
    const paidFee = Math.min(fee, Math.max(0, gross))
    const credit = Math.max(0, roundCoin(gross - fee))
    const hole = roundCoin(Math.max(0, -gross) + Math.max(0, fee - Math.max(0, gross)))
    // 1.10.0：同上——纸面账户强平不花真钱保险基金。
    const covered = this.#accountModeOf(account) === 'shadow' ? { paid: 0, owed: 0 } : this.#coverHole(hole)

    const index = account.positions.findIndex((item) => item.id === position.id)
    if (index >= 0) account.positions.splice(index, 1)
    if (local) {
      this.#state.balance = roundCoin(this.#state.balance + credit)
      this.#state.marginUsed = this.#recomputeMarginUsed()
      this.#state.tradedAt = hit.at
      if (paidFee > 0) this.#chargeFee(paidFee, this.#state)
      this.#bookPnl(hit.pnl, hit.at)
      this.#recordTrade({
        at: hit.at,
        crop: position.crop,
        contract: position.contract,
        // 成交方向记「平仓那一腿」：多单被卖出、空单被买回。
        side: position.side === 'long' ? 'short' : 'long',
        lots: position.lots,
        price: hit.price,
        fee: paidFee,
        kind: 'liquidation'
      })
    } else {
      account.balance = roundCoin(account.balance + credit)
      account.marginUsed = this.#recomputeFor(account)
      if (paidFee > 0) this.#chargeFee(paidFee, account)
      this.#bookPnl(hit.pnl, hit.at, account)
      this.#recordRemoteTrade(account, {
        at: hit.at,
        crop: position.crop,
        contract: position.contract,
        side: position.side === 'long' ? 'short' : 'long',
        lots: position.lots,
        price: hit.price,
        fee: paidFee,
        kind: 'liquidation'
      })
    }
    this.#state.closed += 1
    this.#state.liquidationCount += 1
    return {
      position: { ...position },
      price: hit.price,
      pnl: hit.pnl,
      credit,
      fee: paidFee,
      hole,
      fundPaid: covered.paid,
      shortfall: covered.owed,
      liquidated: true,
      at: hit.at,
      ...(local ? {} : { deviceId })
    }
  }

  /**
   * 票 97：亏空兜底。先花保险基金，基金不够的部分累计成欠账（`shortfall`），
   * 余额永不为负、也不向玩家追缴。强平与交割费共用这一条。
   */
  #coverHole (amount) {
    const hole = roundCoin(Number(amount))
    if (!Number.isFinite(hole) || hole <= 0) return { paid: 0, owed: 0 }
    const fund = roundCoin(this.#state.insurance)
    const paid = Math.min(fund, hole)
    this.#state.insurance = roundCoin(fund - paid)
    const owed = roundCoin(hole - paid)
    if (owed > 0) this.#state.shortfall = roundCoin(this.#state.shortfall + owed)
    return { paid, owed }
  }

  /**
   * 替 peer 的账户逐根盯市：只动余额/入场价/结算游标，不碰本机的周盈亏。
   * 强平（含扫描触发）在 `settleDue` 里已经统一做过；这里的 `liquidated` 只是兜底边界。
   */
  #settleRemoteAccount (account, stamp) {
    const settled = []
    for (let i = account.positions.length - 1; i >= 0; i -= 1) {
      const position = account.positions[i]
      const outcome = this.#settlePositionAt(position, stamp)
      if (outcome === null) continue
      if (outcome.liquidated) {
        settled.push(this.#liquidate({
          account,
          position,
          local: false,
          deviceId: null,
          hit: outcome
        }, stamp))
        continue
      }
      account.balance = roundCoin(account.balance + outcome.pnl)
      position.entry = outcome.price
      position.settleSlot = this.#slotOf(outcome.at) + 1
      this.#bookPnl(outcome.pnl, outcome.at, account)
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
    // 到期那一根没有「下一根」了：按到期前一毫秒的价结算，否则当天最后一根的仓位
    // 会因为 contractOf() 在到期后返回 null 而永远结不掉。
    const priceAt = Math.min(settleAt, window.expireAt - 1)
    const price = this.#fairAt(position.crop, position.contract, priceAt)
    if (price === null) return null // 没有指数的作物不结（账本不动，下一拍再试）
    const pnl = pnlOf({ lots: position.lots, entry: position.entry, exit: price, side: position.side })
    return { price, pnl, liquidated: roundCoin(position.margin + pnl) <= 0, at: priceAt }
  }

  /** 某个合约在某一刻的公允价：用仓位自己的合约，不被「今天这张」顶替。 */
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
      epoch: this.#state.epoch,
      pending: roundCoin(account.pending ?? 0),
      // 1.10.0：这个账户自己的档位（peer 窗口据此显示「真钱 / 纸面」）。
      accountMode: this.#accountModeOf(account),
      // 1.12.0：这个账户自己按的暂停 / 退出（房主据此拒绝新单）。
      paused: account.paused === true,
      disabled: account.disabled === true
    }
  }

  /** 流水号 +1：只有「peer 必须看见」的变动才动它（本机自己的买卖不影响别人的账）。 */
  #bumpAccount (account) {
    // 票 98：切模式也会推进 seq；下一次动钱必须严格大于模式那一次的 seq。
    this.#state.seq = Math.max(this.#state.seq, this.#state.modeSeq, account.lastSeq) + 1
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

  /**
   * 记一笔已实现盈亏：进周榜，同时把做市商那一侧记上反数（`house -= pnl`）。
   *
   * 1.12.4：以前这里只动周榜，硬币凭空增减——玩家赚的 100 是系统印的，亏的 100 是系统销的。
   * 现在每一笔已实现盈亏（平仓、交割、强平、盯市）都从 `house` 里进出，账本才闭合。
   * 纸面账户既不进榜也不进 `house`：假钱统计进去只会让数字变成假的。
   */
  #bookPnl (pnl, at, account = this.#state) {
    if (!Number.isFinite(pnl) || pnl === 0) return
    if (this.#accountModeOf(account) === 'shadow') return
    const start = this.#weekStartOf(at)
    if (this.#state.week.start !== start) this.#state.week = { start, pnl: 0 }
    this.#state.week.pnl = roundCoin(this.#state.week.pnl + pnl)
    this.#state.house = roundCoin(this.#state.house - pnl)
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

  /**
   * 记一笔手续费的分配。1.10.0：纸面账户（`shadow`）的手续费是纸面的，不能流进
   * 保险基金和销毁桶——那两个桶装的是真钱，纸面费进来等于凭空铸币。
   */
  #chargeFee (fee, account = null) {
    if (account !== null && this.#accountModeOf(account) === 'shadow') return
    const split = feeSplitOf(fee)
    this.#state.fees.insurance = roundCoin(this.#state.fees.insurance + split.insurance)
    this.#state.fees.burned = roundCoin(this.#state.fees.burned + split.burned)
    // 票 97：同样一笔 10% 进保险基金的**余额**（`fees.insurance` 是累计注入，只增不减；
    // `insurance` 会被强平/交割的亏空花掉，所以永远有 `insurance <= fees.insurance`）。
    this.#state.insurance = roundCoin(this.#state.insurance + split.insurance)
  }

  /** 票 97：保险基金余额、累计欠账、累计强平笔数（房主随 settle 广播前两个数）。 */
  fundOf () {
    return {
      insurance: roundCoin(this.#state.insurance),
      shortfall: roundCoin(this.#state.shortfall),
      liquidationCount: this.#state.liquidationCount,
      // 1.12.4：做市商净盈亏（玩家盈亏的反数），负 = 系统净付出。
      house: roundCoin(this.#state.house)
    }
  }

  #view () {
    return {
      balance: roundCoin(this.#state.balance),
      marginUsed: roundCoin(this.#state.marginUsed),
      equity: roundCoin(this.#state.balance + this.#state.marginUsed),
      mode: this.modeOf(),
      accountMode: this.accountMode(),
      pending: roundCoin(this.#state.pending),
      paused: this.#state.paused === true,
      disabled: this.#state.disabled,
      // 1.12.4：做市商净盈亏（玩家盈亏的反数），窗口据此显示「系统净付出」。
      house: roundCoin(this.#state.house)
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
