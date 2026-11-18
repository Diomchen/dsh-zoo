/**
 * 邻居协议的**纯**内核：编码、解析、字段白名单、长度与速率限制。
 *
 * 这里的每一个字节都来自局域网，必须当成敌意输入：
 * - 单包上限 4 KiB，超过直接丢；
 * - 只认本文件列出的字段，多余的字段在重建对象时被丢弃；
 * - 版本、类型、deviceId、visitId、port 逐项校验，昵称清洗 + 截断，动画名只允许安全文件名；
 * - 每种报文只写自己那几个字段：beacon/beacon-ack 是身份，heartbeat 是动作意图，
 *   visit-request/ack/deny/recall 是一次串门的生命周期，gift-received 是礼物的送达回执；
 *   market-digest 是本机行情与雇工挂牌的定期广播；work-*（ticket 44）是一份
 *   雇佣合同的生命周期（请求/确认/召回/结束/结算）；
 * - 任何校验失败都只返回 `{ ok: false }`，不抛异常、不写盘、不读本机状态。
 *
 * 协议本身不传素材本体、不传坐标、不传项目或会话信息（ADR-0003）。素材只传引用：
 * `skinPort` / `skinId` 告诉对方去哪儿取，视频本身走 HTTP（ticket 15 起）。
 */
import {
  CONTRACT_END_REASONS as CONTRACT_END_REASON_LIST,
  HIRE_REASONS as CONTRACT_HIRE_REASON_LIST,
  MAX_CONTRACT_HOURS,
  MAX_CONTRACT_MS,
  MAX_CONTRACT_WAGE,
  MIN_CONTRACT_HOURS,
  MIN_CONTRACT_WAGE,
  WORK_ERRORS as CONTRACT_WORK_ERROR_LIST,
  WORK_SETTLE_REASONS as CONTRACT_SETTLE_REASON_LIST
} from './contracts-rules.js'
import { CROPS, CROP_IDS, MAX_GUARD, isCropId, MINUTE_MS } from './farm-rules.js'
import { MAX_CROPS, normalizeCropDef } from './crop-catalog.js'
// 票 82：盘口周报只认盘口的作物/方向/杠杆白名单——白名单的真相在 `src/trading-rules.js`
// （盘口窗口的按钮也由它下发），协议层不另抄一份。
// 票 101/2026-11-18：协议层用 `isStoredLeverage`（1..100）读回盘上仓位；
// 下单白名单是 1×/5×/20×/50×/100×。
import { isBoardCrop, isBoardSide, isStoredLeverage } from './trading-rules.js'
import { normalizeFlowEvent } from './board-flow.js'
// 票 94：期货的方向/杠杆白名单也只有一份真相（`src/futures-rules.js` 是不带状态的纯规则）。
// 票 95：指令种类（含 `place`）同样只认规则层那一份，协议层 re-export。
import {
  FUTURES_ACCOUNT_MODES,
  FUTURES_DEFAULT_MODE,
  FUTURES_MODES,
  FUTURES_ORDER_KINDS,
  isFuturesAccountMode,
  isFuturesLeverage,
  isFuturesSide,
  isMarginAmount
} from './futures-rules.js'

export { FUTURES_ACCOUNT_MODES, FUTURES_MODES, FUTURES_ORDER_KINDS }

export const PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 45871
export const MAX_PACKET_BYTES = 4 * 1024
export const MAX_NICKNAME = 32
export const MAX_LABEL = 64
export const MAX_ANIMATION = 64
/** 跨端气泡最多 80 个码点；再长就不像“随口一句”，也给了滥用一个上限。 */
export const MAX_SAY = 80
/**
 * 字条正文最多 500 个码点（SPEC v4）。
 * 上限不按字节：一条 500 字的中文便条 JSON 后约 1.5 KiB，塞得进 4 KiB 的 UDP 包；
 * 文件礼物走拉取（ticket 25），报文里只放元数据。
 */
export const MAX_GIFT_TEXT = 500
/**
 * 文件礼物（ticket 24 起发、ticket 25 收）：单件上限 16 MiB，文件名最多 120 个码点。
 * 报文里只放元数据（name/size/sha256），本体永远走 HTTP 拉取（ADR-0011）。
 */
export const MAX_GIFT_NAME = 120
export const MAX_GIFT_BYTES = 16 * 1024 * 1024
const GIFT_SHA256_RE = /^sha256:[0-9a-f]{64}$/
/** 气泡最多活 30 秒；过期就不再显示，避免一条旧话挂在别人桌面上。 */
export const SAY_MAX_AGE_MS = 30 * 1000
/** 语义标签是固定小表：不认识的动作名靠它画一个通用表情。 */
export const SEMANTIC_TAGS = Object.freeze(['working', 'eating', 'sleeping', 'idle', 'other'])
const SEMANTIC_SET = new Set(SEMANTIC_TAGS)
const SKIN_ID_RE = /^[A-Za-z0-9_-]{1,32}$/
export const MAX_NEIGHBORS = 64
export const BEACON_INTERVAL_MS = 5000
export const NEIGHBOR_TTL_MS = 30000
/** 放行后每 2 秒一次心跳；动作变化时 service 会额外立刻补发（见 src/service.js）。 */
export const HEARTBEAT_INTERVAL_MS = 2000
/** 30 秒没有心跳，心跳影子从快照里消失；与邻居灯共用同一条 tick 时间线。 */
export const GUEST_TTL_MS = 30000
/**
 * 行情 gossip（ticket 42）：每 30 秒一条 `market-digest`；接收端只认 2 分钟内的样本。
 * 这两个数字既是发送节拍/接收新鲜度，也是「1 个 peer 30 秒最多 1 条」的限速窗口。
 */
export const MARKET_DIGEST_INTERVAL_MS = 30 * 1000
export const MARKET_DIGEST_FRESH_MS = 2 * MINUTE_MS
/**
 * 盘口周报（票 82）：每 30 秒一条 `trading-digest`；接收端只认 2 分钟内的样本。
 * 和行情 gossip 同口径：发送节拍同时也是「1 个 peer 30 秒最多 1 条」的限速窗口。
 */
export const TRADING_DIGEST_INTERVAL_MS = 30 * 1000
export const TRADING_DIGEST_FRESH_MS = 2 * MINUTE_MS
/**
 * 一条周报最多带 8 条持仓（SPEC v10「真人榜与协议」）。这不是产品上的仓位上限
 * （ADR-0028 明确没有），只是报文的体积与展示上限：超出的部分不发，本机照常持仓。
 */
export const MAX_TRADING_POSITIONS = 8
/**
 * 本周盈亏（金币）的线上范围：与农场硬币上限同量级（`MAX_COINS` = 1,000,000，
 * 在 `src/farm.js`）。这里不 import 农场（协议层要能纯粹地单独加载），只跟着这个量级走。
 */
export const MAX_WEEK_PNL = 1_000_000
/**
 * 收益率是**比率**（0.035 = +3.5%，与 SPEC v10「收益率 = weekPnl / weekBase」同口径），
 * 不是百分数：邻居自报这个数，窗口画的时候乘 100。杠杆下单可能远超 100%，留到 ±1000 倍。
 */
export const MAX_WEEK_PNL_PCT = 1000
/**
 * 期货（票 94）：一台机器当房主清算，其余机器只发指令。
 *
 * 线上只有五个类型：`hello`（我想跟你做期货）、`order`（充值/开仓/平仓）、
 * `cancel`（票 95 起有语义：撤自己的挂单）、`settle`（房主 → peer 的账户快照）、
 * `sync`（peer 每 30 秒要一次对账）。
 *
 * 关键：**peer 发过来的只有「做什么」**——没有成交价、没有余额。
 * 价格、成交、余额全部由房主算（SPEC v11「任何 LAN 玩家都能开户，不需要审批」），
 * 所以伪造一包也改不了别人的账，最多改自己的。挂单只带限价与张数，撮合仍由房主按盘口做。
 */
/** 一份 settle 最多带 8 条持仓、8 条挂单：与盘口周报同一量级，整包稳在 4 KiB 内。 */
export const FUTURES_MAX_POSITIONS = 8
export const FUTURES_MAX_ORDERS = 8
/** 合约编号（与 `src/futures-rules.js` 的 `contractOf` 同形）：`tomato-20261117`（旧存档还有 `tomato-2026W47`）。 */
export const FUTURES_CONTRACT_RE = /^[a-z][a-z0-9_]*-(?:\d{4}W\d{2}|\d{8})$/
/** 余额/保证金是「币」，上线到分（`roundCent`）；这里只给一个宽到不可能撞上的上界。 */
export const MAX_FUTURES_COIN = 1_000_000_000
/** 账户流水号 0..2^31-1：一根合约 15 分钟结算一次，这个量级够跑几十年。 */
export const MAX_FUTURES_SEQ = 2 ** 31 - 1
/** 一条持仓的张数上限：与 `src/futures.js` 的 `MAX_QUANTITY` 同量级（100 张一手 × 一万手）。 */
export const MAX_FUTURES_LOTS = 1_000_000
/** settle 里最多带 8 条成交流水（交割/转现货回执）；再多就挤占持仓与挂单的 4 KiB 预算。 */
export const MAX_FUTURES_TRADES = 8
/**
 * 雇工挂牌的真实可用性（ticket 44）：`ready` / `off` / `visiting` / `working`。
 * 枚举与 `src/contracts-rules.js` 同源；`null` 只为兼容旧版本保留。
 */
export const HIRE_REASONS = CONTRACT_HIRE_REASON_LIST
export const HIRE_WAGE_MIN = MIN_CONTRACT_WAGE
export const HIRE_WAGE_MAX = MAX_CONTRACT_WAGE
export const HIRE_HOURS_MIN = MIN_CONTRACT_HOURS
export const HIRE_HOURS_MAX = MAX_CONTRACT_HOURS
/** 挂牌/合同里守卫值的上界：与纯规则 `MAX_GUARD` 同源（0.8）。 */
export const HIRE_GUARD_MAX = MAX_GUARD
/**
 * 雇佣合同（ticket 44）的线上常量。与 `src/contracts-rules.js` 同源（那边是钱的真相，
 * 这里是报文的边界）；`test/contracts-rules.test.js` 有防漂移断言。
 */
export const WORK_MIN_HOURS = MIN_CONTRACT_HOURS
export const WORK_MAX_HOURS = MAX_CONTRACT_HOURS
export const WORK_MIN_WAGE = MIN_CONTRACT_WAGE
export const WORK_MAX_WAGE = MAX_CONTRACT_WAGE
/** 8 小时 × 100 硬币 = 800；手续费最多 40。 */
export const MAX_WORK_EARNED = MAX_CONTRACT_HOURS * MAX_CONTRACT_WAGE
export const MAX_WORK_SERVED_MS = MAX_CONTRACT_MS
export const MAX_WORK_FEE = Math.ceil(MAX_WORK_EARNED * 0.05)
export const WORK_ERRORS = CONTRACT_WORK_ERROR_LIST
export const WORK_END_REASONS = CONTRACT_END_REASON_LIST
export const WORK_SETTLE_REASONS = CONTRACT_SETTLE_REASON_LIST
/** 合同 id / requestId 与 visitId 同一种 UUID 形状。 */
export const isContractId = isVisitId
/**
 * 农场访客动作（ticket 43）：偷/帮只由这两条线走，别的动作名整包丢弃。
 * `requestId` 是幂等键（重发复用同一个），`visitId` 只用来核对“这次串门还在不在”。
 */
export const FARM_ACTION_KINDS = Object.freeze(['steal', 'help'])
/** 主人侧结果的固定错误枚举（不转发自由文本；面向用户的话在 farm-text.js）。 */
export const FARM_ACTION_ERRORS = Object.freeze([
  'no-visit',
  'bad-plot',
  'bad-action',
  'not-mature',
  'already-stolen',
  'already-helped',
  'cap',
  'guard',
  'starting'
])
/** 地块 id：开局 p1–p4，最多解锁到 p50（ticket 48）。 */
export const PLOT_ID_RE = /^p(?:[1-9]|[1-4][0-9]|50)$/

/**
 * 能力声明（ticket 51 / ADR-0018）：老版本不发也不认，缺省 = 只支持串门。
 * `raid` = 能收「来偷」的串门请求（免放行）；`look` = 有 `/dsh-zoo-farm/open` 只读视图；
 * `crops` = 会发运行时作物目录；`futures` = 认识期货五包（票 94，没有 = 老版本，不能一起交易）；
 * `packet` = 认识 `kind:'packet'` 的礼物（1.6.5 起才有，1.7.2 起才声明）。
 */
export const CAPS = Object.freeze(['raid', 'look', 'crops', 'futures', 'packet'])
export const MAX_CAPS = 5
/**
 * 对方能不能收红包（票 79）。
 *
 * 1.6.5 之前的版本在 `normalizeGift` 里会把不认识的 `kind:'packet'` **整件丢掉**，
 * 串门却照常成功——发件方只看到「送出去了」，红包和里面的东西就静默蒸发。
 * 所以只在对方明确声明 `packet` 时才真的把红包带上路。
 */
export function supportsPacket (caps) {
  return Array.isArray(caps) && caps.includes('packet')
}
/** 一趟行程的硬上限（ticket 51）：到点自己回家，不写串门记录。 */
export const RAID_MAX_MS = 60 * 1000
export const RAID_PURPOSE = 'steal'
/** 一次请求最多带多少块地；回执里的 stolen/skipped/caught 也用这个上限。 */
export const MAX_RAID_PLOTS = 50

export function normalizeCaps (value) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!CAPS.includes(name) || out.includes(name)) continue
    out.push(name)
    if (out.length >= MAX_CAPS) break
  }
  return out.length === 0 ? null : out
}

function capsExtras (value) {
  const caps = normalizeCaps(value)
  return caps === null ? {} : { caps }
}

/** 请求里的地块：去重、只认 pN、最多 50 个；坏项只丢自己。 */
function normalizeRaidPlots (value) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const id = entry.trim().toLowerCase()
    if (!PLOT_ID_RE.test(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_RAID_PLOTS) break
  }
  return out.length === 0 ? null : out
}

/**
 * 票 59：作物目录在 wire 上的几个常量。
 *
 * 目录本身不走 beacon——它可能好几 KB，而 beacon 每 30 秒发一次（4 KiB 上限）。
 * beacon 只带「我这边的目录指纹」，两边不一样再单独拉一次完整目录。
 */
export const CATALOG_VERSION = 1
/** 一条 catalog 报文最多塞这么多条定义：每条 ~150 字节，8 条连信封一起稳在 4 KiB 内。 */
export const MAX_CATALOG_ENTRIES_PER_PACKET = 8
/** 一份目录最多切这么多片（8 × 32 = 256 条，比 MAX_CROPS 宽出一截，留余量）。 */
export const MAX_CATALOG_CHUNKS = 32

const HEX16_RE = /^[0-9a-f]{16}$/

function normalizeCatalogAnnounce (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const hash = typeof value.hash === 'string' ? value.hash.trim().toLowerCase() : ''
  if (!HEX16_RE.test(hash)) return null
  const count = Number(value.count)
  if (!Number.isInteger(count) || count < 1 || count > MAX_CROPS) return null
  return { v: CATALOG_VERSION, hash, count }
}

function normalizeCatalogArt (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const hash = typeof value.hash === 'string' ? value.hash.trim().toLowerCase() : ''
  const ext = typeof value.ext === 'string' ? value.ext.trim().toLowerCase() : ''
  const bytes = Number(value.bytes)
  if (!HEX16_RE.test(hash)) return null
  if (ext !== 'svg' && ext !== 'png') return null
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > 256 * 1024) return null
  return { hash, ext, bytes }
}

/** 一条定义：数值部分交给 `normalizeCropDef`（和本机文件同一套夹取），图只带哈希。 */
function normalizeCatalogEntry (value) {
  const def = normalizeCropDef(value)
  if (def === null) return null
  const art = normalizeCatalogArt(value.art)
  return { ...def, ...(art === null ? {} : { art }) }
}

function normalizeCatalogEntries (value) {
  if (!Array.isArray(value)) return null
  const out = []
  // 先挑合格的、再截断：坏条目只丢自己，不该占掉别人的位置。
  // 只扫有限条，别让一条恶意报文把解析拖成 O(n²)。
  for (const candidate of value.slice(0, MAX_CATALOG_ENTRIES_PER_PACKET * 8)) {
    const entry = normalizeCatalogEntry(candidate)
    if (entry === null) continue
    out.push(entry)
    if (out.length >= MAX_CATALOG_ENTRIES_PER_PACKET) break
  }
  return out
}

/**
 * 回执里的结果。`stolen` / `skipped` 形状不对就当整包没有（敌意输入，不猜）：
 * 数组里坏的条目丢自己，但字段本身不是数组就说明这条回执没意义。
 */
function normalizeRaidResult (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.stolen !== undefined && !Array.isArray(value.stolen)) return null
  if (value.skipped !== undefined && !Array.isArray(value.skipped)) return null
  const stolen = []
  for (const entry of Array.isArray(value.stolen) ? value.stolen : []) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    if (typeof entry.plot !== 'string') continue
    const plot = entry.plot.trim().toLowerCase()
    if (!PLOT_ID_RE.test(plot) || !isCropId(entry.crop)) continue
    stolen.push({ plot, crop: entry.crop })
    if (stolen.length >= MAX_RAID_PLOTS) break
  }
  const skipped = normalizeRaidPlots(value.skipped) ?? []
  const caughtRaw = Number(value.caught)
  const caught = Number.isFinite(caughtRaw)
    ? Math.min(MAX_RAID_PLOTS, Math.max(0, Math.floor(caughtRaw)))
    : 0
  return { stolen, caught, skipped }
}
/** 一次偷只拿 1 个；结果里的 qty 只能是 0..1。 */
export const MAX_FARM_QTY = 1
const FARM_ACTION_KIND_SET = new Set(FARM_ACTION_KINDS)
const FARM_ACTION_ERROR_SET = new Set(FARM_ACTION_ERRORS)
/**
 * 一次**出门**的硬上限：30 分钟到点主动回家并写记录（ticket 09）。
 * 入站串门没有时间上限——访客待到主人点「送客」（ticket 10）。
 * 这个值同时是单条串门记录的时长上限（见 src/visit-record.js）。
 */
export const VISIT_MAX_MS = 30 * 60 * 1000
/**
 * 心跳失联阈值：入站访客或出门在外的本机宠物，2 分钟没有对方心跳就判定「对方失联」。
 * 心跳每 2 秒一次，所以 2 分钟已经是 60 个心跳周期，足够容忍丢包与短暂卡顿。
 */
export const PEER_LOST_MS = 2 * 60 * 1000
/**
 * 串门走现有 UDP socket，不另开 TCP 监听（见 docs/protocol.md 的“为什么是 UDP”）。
 * 类型集按生命周期固定：请求 → ack/deny，任一方可发 recall，收到 recall 的一方回一条
 * `visit-recall-ack` 作为回执（recall 也会丢，发起方要靠它停止重试）。
 * `gift-received` 是礼物自己的回执（ticket 26），与串门生命周期无关。
 */
export const PACKET_TYPES = Object.freeze([
  'beacon',
  'beacon-ack',
  'heartbeat',
  'visit-request',
  'visit-ack',
  'visit-deny',
  'visit-recall',
  'visit-recall-ack',
  'gift-received',
  // ticket 79：红包 24 小时没拆就退回寄件人。return 由收件方发、returned 是寄件方的回执；
  // 两条都**故意不放进 VISIT_TYPES**（那条只重建四个字段，giftId/contents 会被吃掉）。
  'packet-return',
  'packet-returned',
  'market-digest',
  // 票 82：盘口周报（本周盈亏 + 当前持仓）。老版本按「未知类型」整包丢掉，不崩。
  'trading-digest',
  // 票 59：运行时作物目录。老版本会按「未知类型」直接丢掉这两条，不崩。
  'crop-catalog-request',
  'crop-catalog',
  'farm-action',
  'farm-action-result',
  // ticket 44：雇佣合同。**故意不放进 VISIT_TYPES**——那条分支只重建四个字段，
  // hours/wage/contractId/earned 会被吃掉。
  'work-request',
  'work-ack',
  'work-recall',
  'work-recall-ack',
  'work-end',
  'work-end-ack',
  'work-settle',
  'work-settle-ack',
  // 票 94：期货（双机开户与净额结算）。老版本按「未知类型」整包丢掉——既不会崩，
  // 也不会被拉进一场它算不了的账；本机靠 beacon 的 `futures` 能力位认出这些邻居。
  'futures-hello',
  'futures-order',
  'futures-cancel',
  'futures-settle',
  'futures-sync',
  // 1.10.0：账户自己的档位申报（peer → 房主）。
  'futures-mode',
  // 1.12.0：账户自己按的暂停申报（peer → 房主）。
  'futures-pause',
  // 1.12.0（B）：整本账快照的分片（房主 → peer），换房主时用来重建账本。
  'futures-ledger',
  // 票 107：盘口 LAN 资金流。老版本按「未知类型」整包丢掉，不崩。
  'board-flow',
  'board-flow-sync'
])
const VISIT_TYPES = new Set([
  'visit-request',
  'visit-ack',
  'visit-deny',
  'visit-recall',
  'visit-recall-ack'
])
// `gift-received` **故意不在 VISIT_TYPES 里**：那条分支只重建 v/type/deviceId/visitId，
// 塞进去 giftId 会被吃掉。编码与解析各有一条自己的分支（ticket 26）。
/**
 * visit-deny 的理由是固定枚举，不是自由文本：
 * - not-admitted：本机没放行这位邻居（默认，也兼容不带 reason 的旧报文）
 * - visits-off：本机客厅的“允许串门”开关被关掉了
 * 发起方据此给出不同的人话提示，但不能借这个字段传任意内容。
 */
export const VISIT_DENY_REASONS = Object.freeze(['not-admitted', 'visits-off'])
const DENY_REASON_SET = new Set(VISIT_DENY_REASONS)
/** 雇工挂牌原因同样是固定枚举（ticket 44）；42 只发 null。 */
const HIRE_REASON_SET = new Set(HIRE_REASONS)
const WORK_ERROR_SET = new Set(WORK_ERRORS)
const WORK_END_REASON_SET = new Set(WORK_END_REASONS)
const WORK_SETTLE_REASON_SET = new Set(WORK_SETTLE_REASONS)
const FUTURES_ORDER_KIND_SET = new Set(FUTURES_ORDER_KINDS)

const TYPE_SET = new Set(PACKET_TYPES)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g
/**
 * 字条正文的控制字符：**保留换行**（\u000a），其余 C0/C1 与 DEL 全部去掉。
 * 便条是唯一允许多行的跨端文本：换行是它的一半意思，折叠掉就成了一行摘要。
 */
const NOTE_CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g

/** 清理本地或远端文本：去掉控制字符与双向覆盖符，折叠空白，按码点截断。 */
export function sanitizeLabel (value, max = MAX_NICKNAME) {
  if (typeof value !== 'string') return null
  if (typeof value.isWellFormed === 'function' && !value.isWellFormed()) return null
  const clean = value
    .replace(CONTROL_RE, ' ')
    .replace(BIDI_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean === '') return null
  const limit = Number.isInteger(max) && max > 0 ? max : MAX_NICKNAME
  const chars = Array.from(clean)
  return chars.length > limit ? chars.slice(0, limit).join('') : clean
}

export function normalizeNickname (value) {
  return sanitizeLabel(value, MAX_NICKNAME)
}

export function isDeviceId (value) {
  return typeof value === 'string' && value.length <= 64 && UUID_RE.test(value)
}

/**
 * 串门 id 与 deviceId 用同一种 UUID 形状：它不是设备身份，只是一次串门的关联键。
 * 形状校验让它可以安全地出现在快照与日志里，也让胡乱构造的 id 在协议层就被丢掉。
 */
export function isVisitId (value) {
  return isDeviceId(value)
}

/** visit-deny 的 reason 只能是固定枚举；其余值整包丢弃，不做自由文本转发。 */
export function isVisitDenyReason (value) {
  return typeof value === 'string' && DENY_REASON_SET.has(value)
}

/** 合同里的整数枚举：时薪、时长、手续费、服务毫秒、工钱。 */
function safeInt (value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}

export function isWorkHours (value) {
  return safeInt(value, WORK_MIN_HOURS, WORK_MAX_HOURS) !== null
}

export function isWorkWage (value) {
  return safeInt(value, WORK_MIN_WAGE, WORK_MAX_WAGE) !== null
}

export function isWorkFee (value) {
  return safeInt(value, 1, MAX_WORK_FEE) !== null
}

export function isWorkGuard (value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= HIRE_GUARD_MAX
}

export function isWorkError (value) {
  return typeof value === 'string' && WORK_ERROR_SET.has(value)
}

export function isWorkEndReason (value) {
  return typeof value === 'string' && WORK_END_REASON_SET.has(value)
}

export function isWorkSettleReason (value) {
  return typeof value === 'string' && WORK_SETTLE_REASON_SET.has(value)
}

export function isPort (value) {
  return Number.isInteger(value) && value > 0 && value <= 65535
}

/** 动画名会被拼进浏览器 URL；只允许不含路径分隔符与控制字符的普通名字。 */
export function isSafeAnimationName (value) {
  if (typeof value !== 'string') return false
  const name = value.trim()
  if (name === '' || name.length > MAX_ANIMATION) return false
  if (name === '.' || name === '..') return false
  if (typeof name.isWellFormed === 'function' && !name.isWellFormed()) return false
  return !/[\\/\u0000-\u001f\u007f]/.test(name)
}

/** 合法的动画名去掉首尾空白；其余一律降级成 null（客户端会退到待机/色块）。 */
export function normalizeAnimation (value) {
  return isSafeAnimationName(value) ? value.trim() : null
}

/** 语义标签只认固定小表；不认识（或旧端没带）一律 null，由调用方回退。 */
export function normalizeSemantic (value) {
  return typeof value === 'string' && SEMANTIC_SET.has(value) ? value : null
}

/** 素材源 id：和 deviceId 一样是短标识符，不是路径。 */
export function normalizeSkinId (value) {
  return typeof value === 'string' && SKIN_ID_RE.test(value) ? value : null
}

/**
 * 气泡：`{ text, until }`。文本清洗成一行、按码点截断 80；`until` 超过 30 秒封顶；
 * 过期或形状不对整条丢弃（返回 null），不抛——这是网络输入。
 */
export function normalizeSay (value, now = Date.now()) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const text = sanitizeLabel(value.text, MAX_SAY)
  if (text === null) return null
  const until = Number(value.until)
  if (!Number.isFinite(until) || until <= now) return null
  return { text, until: Math.min(Math.floor(until), now + SAY_MAX_AGE_MS) }
}

/**
 * 字条正文的清洗：**保留换行**，去掉其余控制字符与双向覆盖符，首尾空白裁掉。
 *
 * 与 `sanitizeLabel` 的差别只有两处，但都很关键：
 *   - 换行留着（便条是多行的，折成一行等于替用户改稿）；
 *   - 超过上限返回 null，**不截断**。字条是一整段话，截一半比不带更糟；
 *     调用方据此决定“这条礼物不收 / 这次不带”，而不是悄悄改字。
 */
export function sanitizeNote (value, max = MAX_GIFT_TEXT) {
  if (typeof value !== 'string') return null
  if (typeof value.isWellFormed === 'function' && !value.isWellFormed()) return null
  const clean = value
    .replace(/\r\n?/g, '\n')
    .replace(NOTE_CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .trim()
  if (clean === '') return null
  const limit = Number.isInteger(max) && max > 0 ? max : MAX_GIFT_TEXT
  if (Array.from(clean).length > limit) return null
  return clean
}

/**
 * 文件礼物的名字：去掉路径分隔符、控制字符、双向覆盖符与前导点，最多 120 码点。
 * 空名返回 null，由 `normalizeGift` 退成 `file`——名字只是给人看的，不该让整件礼物作废。
 *
 * 这个名字**不参与拼路径**：接收端目录名由 `receivedAt` + id 推出来（ticket 25），
 * 所以「去路径分隔符」是双保险，不是唯一防线。
 */
export function sanitizeGiftName (value) {
  if (typeof value !== 'string') return null
  if (typeof value.isWellFormed === 'function' && !value.isWellFormed()) return null
  const clean = value
    .replace(/[\\/]/g, '')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  if (clean === '') return null
  const chars = Array.from(clean)
  return chars.length > MAX_GIFT_NAME ? chars.slice(0, MAX_GIFT_NAME).join('') : clean
}

/**
 * 红包（ticket 79）的上限。数字写死在协议里而不是只写在 UI 上：
 * 收到的报文一律按这里夹紧/拒绝，寄件人改了客户端也塞不进更多东西。
 *
 * 一个红包最多 5 种作物 + 5 种种子：再多种类串联起来会让 visit-request 逼近 4 KiB，
 * 而红包是搭串门的车，不能把串门本身挤掉（见 encodeVisitRequestDetailed 的摘礼物逻辑）。
 */
export const PACKET_LIMITS = Object.freeze({
  maxCoins: 200,
  maxPerCrop: 20,
  maxKinds: 5,
  maxNoteChars: 60
})

/** 红包里的一摞东西：`{ coins, crops:{id:qty}, seeds:{id:qty} }`，空的返回 null。 */
export function normalizePacketContents (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const coins = value.coins === undefined ? 0 : Number(value.coins)
  if (!Number.isInteger(coins) || coins < 0 || coins > PACKET_LIMITS.maxCoins) return null
  const stacks = (raw) => {
    if (raw === undefined || raw === null) return {}
    if (typeof raw !== 'object' || Array.isArray(raw)) return null
    const out = {}
    let kinds = 0
    for (const cropId of CROP_IDS) {
      if (!Object.prototype.hasOwnProperty.call(raw, cropId)) continue
      const qty = Number(raw[cropId])
      // 0 等于没装：静默丢掉，不因为它把整个红包判坏。
      if (!Number.isInteger(qty) || qty < 0) return null
      if (qty === 0) continue
      if (qty > PACKET_LIMITS.maxPerCrop) return null
      kinds += 1
      if (kinds > PACKET_LIMITS.maxKinds) return null
      out[cropId] = qty
    }
    return out
  }
  const crops = stacks(value.crops)
  if (crops === null) return null
  const seeds = stacks(value.seeds)
  if (seeds === null) return null
  if (coins === 0 && Object.keys(crops).length === 0 && Object.keys(seeds).length === 0) {
    return null
  }
  return { coins, crops, seeds }
}

/** 祝福语：短文本，超长直接判坏（红包的祝福是点缀，不做静默截断）。 */
function normalizePacketNote (value) {
  if (value === undefined || value === null) return ''
  const note = sanitizeNote(value)
  if (note === null) return null
  if (Array.from(note).length > PACKET_LIMITS.maxNoteChars) return null
  return note
}

/**
 * 串门捎的礼物（ADR-0011）：`kind:'text'` 是内联字条，`kind:'file'` 只有元数据
 * （name/size/sha256），本体由接收方在访客抵达时向发起方拉取（ticket 25）。
 * `kind:'packet'` 是红包（ticket 79）：金币/作物/种子直接写在报文里，
 * 收下并不等于入账，要对方在串门记录里点「拆开」才结算（ADR-0027）。
 *
 * **校验不过返回 null，由调用方把整个 `gift` 字段丢掉，串门照常。**
 * 这与 `anim` 非法就整包丢是相反的策略：动画是这次串门的“外观”，坏了可以退回待机；
 * 便条/文件只是搭车的一件东西，为它把一次串门搞砸，代价和收益完全不对等。
 */
export function normalizeGift (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (!isVisitId(value.id)) return null
  const id = value.id.toLowerCase()
  if (value.kind === 'text') {
    const text = sanitizeNote(value.text)
    if (text === null) return null
    return { id, kind: 'text', text }
  }
  if (value.kind === 'file') {
    const name = sanitizeGiftName(value.name) ?? 'file'
    const size = Number(value.size)
    // `1 … 16 MiB`：0 字节的文件不叫礼物，也会让接收端的 sha256 校验没有意义。
    if (!Number.isInteger(size) || size <= 0 || size > MAX_GIFT_BYTES) return null
    if (typeof value.sha256 !== 'string' || !GIFT_SHA256_RE.test(value.sha256)) return null
    return { id, kind: 'file', name, size, sha256: value.sha256 }
  }
  if (value.kind === 'packet') {
    const contents = normalizePacketContents(value.packet)
    if (contents === null) return null
    const note = normalizePacketNote(value.note)
    if (note === null) return null
    return { id, kind: 'packet', packet: contents, ...(note === '' ? {} : { note }) }
  }
  // 认识的 kind 就这三种；别的值整条 gift 丢掉（旧端读到新 kind 也是这条路径）。
  return null
}

/**
 * 行情 digest 的单个价格：只认已知作物 + 有限数字 + `[base×0.5, base×2]`。
 * 价格是**条目**而不是整包：一个坏价只丢这一种作物（见 `normalizeDigestPrices`）。
 */
export function isDigestPrice (cropId, value) {
  if (!isCropId(cropId)) return false
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  const base = CROPS[cropId].base
  return value >= base * 0.5 && value <= base * 2
}

/**
 * 把 `prices` 收成白名单新对象：未知作物、坏价格、超范围价格都丢掉，
 * 但**不**因为一个坏条目丢掉整条 digest（SPEC：「坏条目丢掉、不整包丢」）。
 * 形状不是对象时返回 null，由调用方把整包判坏。
 */
export function normalizeDigestPrices (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const prices = {}
  for (const cropId of CROP_IDS) {
    if (!Object.prototype.hasOwnProperty.call(value, cropId)) continue
    if (!isDigestPrice(cropId, value[cropId])) continue
    prices[cropId] = value[cropId]
  }
  return prices
}

/**
 * 雇工挂牌：字段固定 `{ enabled, wagePerHour, minHours, maxHours, guard, available, reason }`。
 * 开工前拍板（ticket 44 D1）：42 的 digest 就带 `available/reason/guard`，44 的雇工板直接读。
 * 新版本 `reason` 总是四值之一；`null` 只接受旧版本发来的报文（不整包丢）。
 * `guard` 是雇工贡献的 0.5，不是 `farmGuard()` 合成后的值。
 */
export function normalizeDigestHire (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.enabled !== 'boolean') return null
  if (typeof value.available !== 'boolean') return null
  if (!Number.isInteger(value.wagePerHour) ||
    value.wagePerHour < HIRE_WAGE_MIN || value.wagePerHour > HIRE_WAGE_MAX) return null
  if (!Number.isInteger(value.minHours) || !Number.isInteger(value.maxHours)) return null
  if (value.minHours < HIRE_HOURS_MIN || value.maxHours > HIRE_HOURS_MAX) return null
  if (value.minHours > value.maxHours) return null
  if (typeof value.guard !== 'number' || !Number.isFinite(value.guard)) return null
  if (value.guard < 0 || value.guard > HIRE_GUARD_MAX) return null
  const reason = value.reason
  if (reason !== null && !(typeof reason === 'string' && HIRE_REASON_SET.has(reason))) return null
  return {
    enabled: value.enabled,
    wagePerHour: value.wagePerHour,
    minHours: value.minHours,
    maxHours: value.maxHours,
    guard: value.guard,
    available: value.available,
    reason
  }
}

/** digest 时间戳：正整数毫秒；**新鲜度**在接收端按本地时钟判（见 src/market.js）。 */
export function normalizeDigestAt (value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * 盘口周报的分数：本周交易盈亏（金币），有限数且落在 ±MAX_WEEK_PNL。
 * 坏值整包丢（不是归零）：`NaN`/字符串一旦进榜，排序和窗口都会画出一行坏数字。
 */
export function normalizeWeeklyPnl (value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < -MAX_WEEK_PNL || value > MAX_WEEK_PNL) return null
  return value
}

/** 可选收益率（比率，见 MAX_WEEK_PNL_PCT 的注释）：有限数且落在 ±1000 倍。 */
export function normalizeWeeklyPnlPct (value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < -MAX_WEEK_PNL_PCT || value > MAX_WEEK_PNL_PCT) return null
  return value
}

/**
 * 周报里的持仓：最多 8 条，每条只留 `{ crop, side, leverage }`。
 *
 * 作物白名单走 `isBoardCrop()`（票 88 / ADR-0031）：盘口清单跟随运行时作物目录，
 * 目录里新增的作物（含 LAN 同步来的）不用改协议就收；未知/坏底价作物仍然整包丢。
 *
 * 与行情 digest「坏条目丢自己」**不同**：这里任何一条坏就整包丢。
 * 为什么：持仓列表是「谁在逆势」的全部依据，半截列表比没有更容易被误读
 * （少了做空那几条，看起来就像满仓做多）；而合法条目只有三个小字段，
 * 对不上就说明对方坏了，整包丢最省事。
 */
export function normalizeTradingPositions (value) {
  if (!Array.isArray(value)) return null
  if (value.length > MAX_TRADING_POSITIONS) return null
  const positions = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    if (!isBoardCrop(entry.crop)) return null
    if (!isBoardSide(entry.side)) return null
    // 协议只校验「读得回来的杠杆形状」（1..100），不是「现在能不能下单」；
    // 周报/排行榜要能显示别人手里的 20×/100× 仓位。
    if (!isStoredLeverage(entry.leverage)) return null
    positions.push({ crop: entry.crop, side: entry.side, leverage: entry.leverage })
  }
  return positions
}

/**
 * 币值（余额/保证金/盈亏）：一律四舍五入到分再上线。
 *
 * 农场硬币是整数，期货的保证金/手续费/盈亏却是「币」的浮点数（账本那边落账前
 * 都过 `roundCoin`）。线上再取一次整分，是为了让「同一笔账」在两台机器上
 * JSON 比出来完全相等——否则 100.00000000000001 这种尾巴会让两边永远对不上。
 */
function roundCent (value) {
  return Math.round(value * 100) / 100
}

/** 币值：有限数、非负、到分；坏值返回 null（整包丢，不猜）。 */
function normalizeFuturesCoin (value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > MAX_FUTURES_COIN) return null
  return roundCent(value)
}

/** 价格/保证金的正数版本：0 不算（持仓的 entry/margin 不可能是 0）。 */
function normalizeFuturesPositiveCoin (value) {
  const coin = normalizeFuturesCoin(value)
  return coin === null || coin <= 0 ? null : coin
}

/** 变动额：可正可负（充值 +、强平 −），同样到分。 */
function normalizeFuturesDelta (value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < -MAX_FUTURES_COIN || value > MAX_FUTURES_COIN) return null
  return roundCent(value)
}

/** 账户 epoch：房主每次启动换一个新 UUID；线上只要求非空、不超长。 */
export function isFuturesEpoch (value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LABEL
}

/** 账户流水号：0..2^31-1 的整数（比 SafeInteger 窄，坏包更容易被抓出来）。 */
export function isFuturesSeq (value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_FUTURES_SEQ
}

export function isFuturesOrderKind (value) {
  return typeof value === 'string' && FUTURES_ORDER_KIND_SET.has(value)
}

/**
 * settle 里的一条持仓。与盘口周报的持仓（只有 crop/side/leverage）不同，
 * 这里必须带 id/entry/margin/lots：peer 要按 id 平仓，也要自己算浮盈给你看。
 *
 * 任何一条坏就整包丢——半份账户比没有更危险（少一条持仓，看起来就像已经平掉了）。
 */
function normalizeFuturesPosition (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (!isVisitId(value.id)) return null
  if (!isCropId(value.crop)) return null
  if (typeof value.contract !== 'string' || !FUTURES_CONTRACT_RE.test(value.contract)) return null
  if (!isFuturesSide(value.side)) return null
  if (!Number.isInteger(value.lots) || value.lots < 1 || value.lots > MAX_FUTURES_LOTS) return null
  const entry = normalizeFuturesPositiveCoin(value.entry)
  if (entry === null) return null
  const margin = normalizeFuturesPositiveCoin(value.margin)
  if (margin === null) return null
  if (!isFuturesLeverage(value.leverage)) return null
  return {
    id: value.id.toLowerCase(),
    crop: value.crop,
    contract: value.contract,
    side: value.side,
    lots: value.lots,
    entry,
    margin,
    leverage: value.leverage
  }
}

function normalizeFuturesPositions (value) {
  if (!Array.isArray(value)) return null
  if (value.length > FUTURES_MAX_POSITIONS) return null
  const positions = []
  for (const entry of value) {
    const position = normalizeFuturesPosition(entry)
    if (position === null) return null
    positions.push(position)
  }
  return positions
}

/** `place` 指令的载荷（票 95）：只带限价与张数，成交价与保证金全由房主算。 */
function normalizeFuturesPlace (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (!isCropId(value.crop)) return null
  if (!isFuturesSide(value.side)) return null
  const price = normalizeFuturesPositiveCoin(value.price)
  if (price === null) return null
  if (!Number.isInteger(value.lots) || value.lots < 1 || value.lots > MAX_FUTURES_LOTS) return null
  if (!isFuturesLeverage(value.leverage)) return null
  return { crop: value.crop, side: value.side, price, lots: value.lots, leverage: value.leverage }
}

/**
 * settle 里的一条挂单（票 95）：`lots` 是原始张数、`lotsLeft` 是还没成交的部分，
 * `marginFrozen` 是剩余部分压着的保证金。坏一条同样整包丢。
 */
function normalizeFuturesOrder (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (!isVisitId(value.id)) return null
  if (!isCropId(value.crop)) return null
  if (typeof value.contract !== 'string' || !FUTURES_CONTRACT_RE.test(value.contract)) return null
  if (!isFuturesSide(value.side)) return null
  const price = normalizeFuturesPositiveCoin(value.price)
  if (price === null) return null
  if (!Number.isInteger(value.lots) || value.lots < 1 || value.lots > MAX_FUTURES_LOTS) return null
  if (!Number.isInteger(value.lotsLeft) || value.lotsLeft < 1 || value.lotsLeft > value.lots) return null
  if (!isFuturesLeverage(value.leverage)) return null
  const marginFrozen = normalizeFuturesCoin(value.marginFrozen)
  if (marginFrozen === null) return null
  const at = normalizeDigestAt(value.at)
  if (at === null) return null
  return {
    id: value.id.toLowerCase(),
    crop: value.crop,
    contract: value.contract,
    side: value.side,
    price,
    lots: value.lots,
    lotsLeft: value.lotsLeft,
    leverage: value.leverage,
    marginFrozen,
    at
  }
}

function normalizeFuturesOrders (value) {
  if (!Array.isArray(value)) return null
  if (value.length > FUTURES_MAX_ORDERS) return null
  const orders = []
  for (const entry of value) {
    const order = normalizeFuturesOrder(entry)
    if (order === null) return null
    orders.push(order)
  }
  return orders
}

/**
 * settle 里的一条成交流水（票 96）：交割与转现货要能让 peer 窗口看见。
 * 与盘上账本的 trade 同形；交割额外带 `deliveryFee`，坏一条整包丢。
 */
function normalizeFuturesTrade (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const at = normalizeDigestAt(value.at)
  if (at === null) return null
  // 票 98：模式切换流水没有作物/合约/方向，价格与张数都是 0，必须在常规校验之前放行。
  if (value.kind === 'mode') {
    if (!FUTURES_MODES.includes(value.note)) return null
    return { at, kind: 'mode', note: value.note, lots: 0, price: 0, fee: 0 }
  }
  if (!isCropId(value.crop)) return null
  if (typeof value.contract !== 'string' || !FUTURES_CONTRACT_RE.test(value.contract)) return null
  if (!isFuturesSide(value.side)) return null
  if (!Number.isInteger(value.lots) || value.lots < 1 || value.lots > MAX_FUTURES_LOTS) return null
  const price = normalizeFuturesPositiveCoin(value.price)
  if (price === null) return null
  const fee = normalizeFuturesCoin(value.fee)
  if (fee === null) return null
  const kind = value.kind === 'close'
    ? 'close'
    : value.kind === 'open'
      ? 'open'
      : value.kind === 'delivery'
        ? 'delivery'
        : value.kind === 'convert'
          ? 'convert'
          : value.kind === 'liquidation'
            ? 'liquidation'
            : null
  if (kind === null) return null
  const trade = {
    at,
    crop: value.crop,
    contract: value.contract,
    side: value.side,
    lots: value.lots,
    price,
    fee,
    kind
  }
  if (kind === 'delivery') {
    const deliveryFee = normalizeFuturesCoin(value.deliveryFee)
    if (deliveryFee === null) return null
    trade.deliveryFee = deliveryFee
  }
  return trade
}

function normalizeFuturesTrades (value) {
  if (!Array.isArray(value)) return null
  if (value.length > MAX_FUTURES_TRADES) return null
  const trades = []
  for (const entry of value) {
    const trade = normalizeFuturesTrade(entry)
    if (trade === null) return null
    trades.push(trade)
  }
  return trades
}

/** 五包共用的 `at`：缺省取本地时钟；坏时间整包丢（与 digest 同一套判定）。 */
function futuresStamp (at, now) {
  const stamp = at === undefined ? normalizeDigestAt(now) : normalizeDigestAt(at)
  if (stamp === null) throw new Error('protocol: invalid futures at')
  return stamp
}

/** 环境变量覆盖监听端口；非法值静默回落到默认端口，避免坏配置把插件拖死。 */
export function resolvePort (env = process.env) {
  const raw = env?.DSH_ZOO_PORT
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PORT
  const port = Number(String(raw).trim())
  return isPort(port) ? port : DEFAULT_PORT
}

/**
 * 构造一个只含白名单字段的报文。字段顺序与字段集按类型固定，便于测试和抓包对照：
 *   beacon / beacon-ack     → { v, type, deviceId, nickname, port[, skinPort, skinId] }
 *   heartbeat               → { v, type, deviceId, anim[, action, semantic, say, skinPort, skinId] }
 *   visit-request           → { v, type, deviceId, visitId, nickname, anim[, action, semantic, say, skinPort, skinId, gift] }
 *   visit-ack / visit-recall / visit-recall-ack → { v, type, deviceId, visitId }
 *   visit-deny              → { v, type, deviceId, visitId, reason }
 *   gift-received           → { v, type, deviceId, visitId, giftId }
 *   market-digest           → { v, type, deviceId, at, prices, hire }
 *   trading-digest          → { v, type, deviceId, at, weekPnl[, weekPnlPct], positions }
 *   futures-*               → hello { v, type, deviceId, at }；
 *                             order { v, type, deviceId, at, kind, … }（按 kind 只带自己那几个字段）；
 *                             cancel { v, type, deviceId, at, positionId }；
 *                             settle { v, type, deviceId, at, epoch, seq, balance, marginUsed, delta, positions }；
 *                             sync { v, type, deviceId, at, epoch, lastSeq }
 * 绝不带上坐标：这个函数没有接收坐标的参数，也不需要（ADR-0003）。
 *
 * deviceId / visitId / port / deny reason 是本地代码传进来的，非法即抛
 * （这是程序错误，不是网络输入）。
 * 本机动画名/动作名/气泡/字条非法时不抛：降级成“不带这个字段”，让对端自己放待机。
 * 字条是唯一会因**整包体积**被丢掉的字段——见 `buildPacket` 的 4 KiB 兜底。
 */
export function encodePacket (options = {}) {
  return buildPacket(options).data
}

/**
 * 带字条的串门请求：除了字节，还回一个 `giftDropped`。
 *
 * 4 KiB 是 UDP 的硬上限，而一批便条不该把一次串门搞砸。所以编码层自己先试带 gift 的包，
 * 超了就把 gift 摘掉重编一次，并告诉调用方“这次没带上”——service 据此在本机说一句话。
 * 这个判断必须在这一层做：`encodePacket` 超限只有一个裸 `throw`，在 service 里 catch
 * 之后分不清是字条太大、还是身份/昵称坏了，只能猜。
 *
 * `maxBytes` 只给单测用：500 码点的字条最坏（emoji）约 3 KiB，正常触不到 4 KiB，
 * 防御路径要把上限调小才测得到。
 */
export function encodeVisitRequestDetailed (options = {}, { maxBytes = MAX_PACKET_BYTES } = {}) {
  return buildPacket({ ...options, type: 'visit-request' }, { maxBytes })
}

function buildPacket ({
  type,
  deviceId,
  nickname,
  port,
  anim,
  visitId,
  reason,
  giftId,
  // ticket 79：红包退回报文的内容与祝福语（`contents` 不叫 packet，避免与整包对象同名）
  contents,
  note,
  action,
  semantic,
  say,
  skinPort,
  skinId,
  gift,
  at,
  prices,
  hire,
  // 票 82：盘口周报的三个字段（持仓只有 crop/side/leverage）
  weekPnl,
  weekPnlPct,
  positions,
  requestId,
  plotId,
  ok,
  error,
  crop,
  qty,
  caught,
  // ticket 44：合同的全部线上字段
  contractId,
  hours,
  wagePerHour,
  fee,
  startedAt,
  endsAt,
  guard,
  servedMs,
  earned,
  // 票 94：期货五包的全部线上字段（side/margin/leverage/coins/positionId/epoch/seq/balance/marginUsed/delta/lastSeq）
  kind,
  side,
  margin,
  leverage,
  coins,
  positionId,
  // 票 95：挂单（place 的限价/张数、settle 的 orders[]、cancel 的 orderId）
  price,
  lots,
  orders,
  // 票 96：settle 里的成交流水（交割/转现货回执）
  trades,
  orderId,
  epoch,
  seq,
  balance,
  marginUsed,
  delta,
  // 票 97：settle 里附带的保险基金余额与累计欠账（整数分），peer 只显示
  insurance,
  shortfall,
  // 票 98：settle 里附带的灰度模式与待提取余额
  mode,
  pending,
  lastSeq,
  caps,
  purpose,
  plots,
  raid,
  // 票 59：作物目录与它的指纹
  crops,
  catalogHash,
  // 票 107：资金流事件与同步起点
  events,
  since,
  sync,
  chunk,
  total,
  entries,
  hash,
  now = Date.now()
} = {}, { maxBytes = MAX_PACKET_BYTES } = {}) {
  if (!TYPE_SET.has(type)) throw new Error('protocol: invalid packet type')
  if (!isDeviceId(deviceId)) throw new Error('protocol: invalid deviceId')

  const base = {
    v: PROTOCOL_VERSION,
    type,
    deviceId: deviceId.toLowerCase()
  }
  const pet = petExtras({ action, semantic, say, now })
  const skin = skinExtras({ skinPort, skinId })
  let packet
  if (type === 'heartbeat') {
    packet = { ...base, anim: normalizeAnimation(anim), ...pet, ...skin, ...capsExtras(caps) }
  } else if (type === 'visit-request') {
    if (!isVisitId(visitId)) throw new Error('protocol: invalid visitId')
    const safeNickname = normalizeNickname(nickname)
    if (safeNickname === null) throw new Error('protocol: invalid nickname')
    const steals = purpose === RAID_PURPOSE
    const safePlots = steals ? normalizeRaidPlots(plots) : null
    packet = {
      ...base,
      visitId: visitId.toLowerCase(),
      nickname: safeNickname,
      anim: normalizeAnimation(anim),
      ...pet,
      ...skin,
      ...(steals ? { purpose: RAID_PURPOSE } : {}),
      ...(safePlots === null ? {} : { plots: safePlots })
    }
  } else if (type === 'visit-deny') {
    if (!isVisitId(visitId)) throw new Error('protocol: invalid visitId')
    // 本机没填理由时按“没放行”编码：这是最常见也最保守的拒绝理由。
    const safeReason = reason === undefined ? 'not-admitted' : reason
    if (!isVisitDenyReason(safeReason)) throw new Error('protocol: invalid deny reason')
    packet = { ...base, visitId: visitId.toLowerCase(), reason: safeReason }
  } else if (type === 'gift-received') {
    // 自己的分支，别并进 VISIT_TYPES：那条只写四个字段，giftId 会在这里消失。
    if (!isVisitId(visitId)) throw new Error('protocol: invalid visitId')
    if (!isVisitId(giftId)) throw new Error('protocol: invalid giftId')
    packet = { ...base, visitId: visitId.toLowerCase(), giftId: giftId.toLowerCase() }
  } else if (type === 'packet-return') {
    // ticket 79：把没拆的红包原样送回寄件人。内容仍按 PACKET_LIMITS 再校验一次——
    // 收件方没义务相信任何一端，寄件人自己也要防着被塞超量。
    if (!isVisitId(giftId)) throw new Error('protocol: invalid giftId')
    const safeContents = normalizePacketContents(contents)
    if (safeContents === null) throw new Error('protocol: invalid packet')
    const safeNote = normalizePacketNote(note)
    if (safeNote === null) throw new Error('protocol: invalid packet note')
    packet = {
      ...base,
      giftId: giftId.toLowerCase(),
      contents: safeContents,
      ...(safeNote === '' ? {} : { note: safeNote })
    }
  } else if (type === 'packet-returned') {
    if (!isVisitId(giftId)) throw new Error('protocol: invalid giftId')
    packet = { ...base, giftId: giftId.toLowerCase() }
  } else if (type === 'market-digest') {
    // 自己的分支，绝不并进 VISIT_TYPES：那条只写四个字段，prices/hire 会在这里消失。
    const stamp = at === undefined ? normalizeDigestAt(now) : normalizeDigestAt(at)
    if (stamp === null) throw new Error('protocol: invalid digest time')
    const safePrices = normalizeDigestPrices(prices)
    if (safePrices === null) throw new Error('protocol: invalid digest prices')
    const safeHire = normalizeDigestHire(hire)
    if (safeHire === null) throw new Error('protocol: invalid digest hire')
    packet = { ...base, at: stamp, prices: safePrices, hire: safeHire }
  } else if (type === 'trading-digest') {
    // 自己的分支，绝不并进 VISIT_TYPES：那条只写四个字段，weekPnl/positions 会在这里消失。
    const stamp = at === undefined ? normalizeDigestAt(now) : normalizeDigestAt(at)
    if (stamp === null) throw new Error('protocol: invalid digest time')
    const safePnl = normalizeWeeklyPnl(weekPnl)
    if (safePnl === null) throw new Error('protocol: invalid week pnl')
    // 收益率是**可选**的：本机没有 base 时就整条不带这个键（而不是发一个 0）。
    const hasPct = weekPnlPct !== undefined && weekPnlPct !== null
    const safePct = hasPct ? normalizeWeeklyPnlPct(weekPnlPct) : null
    if (hasPct && safePct === null) throw new Error('protocol: invalid week pnl pct')
    const safePositions = normalizeTradingPositions(positions)
    if (safePositions === null) throw new Error('protocol: invalid trading positions')
    packet = {
      ...base,
      at: stamp,
      weekPnl: safePnl,
      ...(safePct === null ? {} : { weekPnlPct: safePct }),
      positions: safePositions
    }
  } else if (type === 'board-flow') {
    const stamp = at === undefined ? normalizeDigestAt(now) : normalizeDigestAt(at)
    if (stamp === null) throw new Error('protocol: invalid board flow time')
    const list = Array.isArray(events) ? events.slice(0, 16) : []
    const safe = []
    for (const candidate of list) {
      const event = normalizeFlowEvent(candidate)
      if (event === null) continue
      // 事件里的 deviceId 一律盖成包上的发送端：伪造别人的流水没有意义。
      safe.push({ ...event, deviceId: deviceId.toLowerCase() })
    }
    packet = { ...base, at: stamp, events: safe, sync: sync === true }
  } else if (type === 'board-flow-sync') {
    const stamp = at === undefined ? normalizeDigestAt(now) : normalizeDigestAt(at)
    if (stamp === null) throw new Error('protocol: invalid board flow sync time')
    const start = Number(since)
    if (!Number.isFinite(start) || start < 0 || start > stamp + 5 * 60 * 1000) {
      throw new Error('protocol: invalid board flow since')
    }
    packet = { ...base, at: stamp, since: Math.floor(start) }
  } else if (type === 'farm-action') {
    // 自己的分支，绝不并进 VISIT_TYPES：那条只写四个字段，requestId/action/plotId 会消失。
    if (!isVisitId(visitId)) throw new Error('protocol: invalid visitId')
    if (!isVisitId(requestId)) throw new Error('protocol: invalid requestId')
    if (!FARM_ACTION_KIND_SET.has(action)) throw new Error('protocol: invalid farm action')
    if (typeof plotId !== 'string' || !PLOT_ID_RE.test(plotId)) {
      throw new Error('protocol: invalid plotId')
    }
    packet = {
      ...base,
      visitId: visitId.toLowerCase(),
      requestId: requestId.toLowerCase(),
      action,
      plotId
    }
  } else if (type === 'farm-action-result') {
    if (!isVisitId(requestId)) throw new Error('protocol: invalid requestId')
    if (typeof ok !== 'boolean') throw new Error('protocol: invalid result ok')
    if (ok === true) {
      if (caught === true) throw new Error('protocol: caught requires guard')
      if (!isCropId(crop)) throw new Error('protocol: invalid crop')
      if (!Number.isInteger(qty) || qty < 0 || qty > MAX_FARM_QTY) {
        throw new Error('protocol: invalid qty')
      }
      packet = {
        ...base,
        requestId: requestId.toLowerCase(),
        ok: true,
        crop,
        qty,
        ...(caught === true ? { caught: true } : {})
      }
    } else {
      if (!FARM_ACTION_ERROR_SET.has(error)) throw new Error('protocol: invalid farm error')
      // `caught` 只有一个意思：被守卫抓住；不能拿它给别的错误加戏。
      if (caught === true && error !== 'guard') throw new Error('protocol: caught without guard')
      packet = {
        ...base,
        requestId: requestId.toLowerCase(),
        ok: false,
        error,
        ...(caught === true ? { caught: true } : {})
      }
    }
  } else if (type === 'work-request') {
    // 自己的一条分支，绝不并进 VISIT_TYPES。
    if (!isVisitId(requestId)) throw new Error('protocol: invalid requestId')
    if (!isWorkHours(hours)) throw new Error('protocol: invalid work hours')
    if (!isWorkWage(wagePerHour)) throw new Error('protocol: invalid work wage')
    if (!isWorkFee(fee)) throw new Error('protocol: invalid work fee')
    packet = {
      ...base,
      requestId: requestId.toLowerCase(),
      hours,
      wagePerHour,
      fee
    }
  } else if (type === 'work-ack') {
    if (!isVisitId(requestId)) throw new Error('protocol: invalid requestId')
    if (typeof ok !== 'boolean') throw new Error('protocol: invalid work ack ok')
    if (ok === true) {
      if (!isVisitId(contractId)) throw new Error('protocol: invalid contractId')
      if (!Number.isSafeInteger(startedAt) || startedAt <= 0) throw new Error('protocol: invalid startedAt')
      if (!Number.isSafeInteger(endsAt)) throw new Error('protocol: invalid endsAt')
      if (endsAt <= startedAt || endsAt - startedAt > MAX_WORK_SERVED_MS) {
        throw new Error('protocol: invalid contract time')
      }
      if (!isWorkGuard(guard)) throw new Error('protocol: invalid guard')
      packet = {
        ...base,
        requestId: requestId.toLowerCase(),
        ok: true,
        contractId: contractId.toLowerCase(),
        startedAt,
        endsAt,
        guard
      }
    } else {
      if (!isWorkError(error)) throw new Error('protocol: invalid work error')
      packet = { ...base, requestId: requestId.toLowerCase(), ok: false, error }
    }
  } else if (type === 'work-recall' || type === 'work-recall-ack') {
    if (!isVisitId(contractId)) throw new Error('protocol: invalid contractId')
    if (type === 'work-recall') {
      packet = { ...base, contractId: contractId.toLowerCase() }
    } else {
      if (typeof ok !== 'boolean') throw new Error('protocol: invalid work ack ok')
      if (ok !== true && !isWorkError(error)) throw new Error('protocol: invalid work error')
      packet = {
        ...base,
        contractId: contractId.toLowerCase(),
        ok,
        ...(ok === true ? {} : { error })
      }
    }
  } else if (type === 'work-end') {
    // contractId 优先；取消一笔还没 ack 的请求时用 requestId。
    const hasContract = contractId !== undefined && contractId !== null
    const hasRequest = requestId !== undefined && requestId !== null
    if (!hasContract && !hasRequest) throw new Error('protocol: invalid work end target')
    if (hasContract && !isVisitId(contractId)) throw new Error('protocol: invalid contractId')
    if (hasRequest && !isVisitId(requestId)) throw new Error('protocol: invalid requestId')
    if (!isWorkEndReason(reason)) throw new Error('protocol: invalid work end reason')
    packet = {
      ...base,
      ...(hasContract ? { contractId: contractId.toLowerCase() } : {}),
      ...(hasContract || !hasRequest ? {} : { requestId: requestId.toLowerCase() }),
      reason
    }
  } else if (type === 'work-end-ack') {
    if (typeof ok !== 'boolean') throw new Error('protocol: invalid work ack ok')
    const hasContract = contractId !== undefined && contractId !== null
    const hasRequest = requestId !== undefined && requestId !== null
    if (!hasContract && !hasRequest) throw new Error('protocol: invalid work end target')
    if (hasContract && !isVisitId(contractId)) throw new Error('protocol: invalid contractId')
    if (hasRequest && !isVisitId(requestId)) throw new Error('protocol: invalid requestId')
    if (ok !== true && !isWorkError(error)) throw new Error('protocol: invalid work error')
    packet = {
      ...base,
      ...(hasContract ? { contractId: contractId.toLowerCase() } : {}),
      ...(hasRequest ? { requestId: requestId.toLowerCase() } : {}),
      ok,
      ...(ok === true ? {} : { error })
    }
  } else if (type === 'work-settle') {
    if (!isVisitId(contractId)) throw new Error('protocol: invalid contractId')
    if (!isVisitId(requestId)) throw new Error('protocol: invalid requestId')
    if (!Number.isSafeInteger(servedMs) || servedMs < 0 || servedMs > MAX_WORK_SERVED_MS) {
      throw new Error('protocol: invalid servedMs')
    }
    if (!Number.isSafeInteger(earned) || earned < 0 || earned > MAX_WORK_EARNED) {
      throw new Error('protocol: invalid earned')
    }
    if (!isWorkSettleReason(reason)) throw new Error('protocol: invalid settle reason')
    packet = {
      ...base,
      contractId: contractId.toLowerCase(),
      requestId: requestId.toLowerCase(),
      servedMs,
      earned,
      reason
    }
  } else if (type === 'work-settle-ack') {
    if (!isVisitId(contractId)) throw new Error('protocol: invalid contractId')
    if (!isVisitId(requestId)) throw new Error('protocol: invalid requestId')
    if (typeof ok !== 'boolean') throw new Error('protocol: invalid work ack ok')
    if (ok === true) {
      if (!Number.isSafeInteger(earned) || earned < 0 || earned > MAX_WORK_EARNED) {
        throw new Error('protocol: invalid earned')
      }
      packet = {
        ...base,
        contractId: contractId.toLowerCase(),
        requestId: requestId.toLowerCase(),
        ok: true,
        earned
      }
    } else {
      if (!isWorkError(error)) throw new Error('protocol: invalid work error')
      packet = {
        ...base,
        contractId: contractId.toLowerCase(),
        requestId: requestId.toLowerCase(),
        ok: false,
        error
      }
    }
  } else if (type === 'crop-catalog-request') {
    // 「你那边的目录指纹是多少」——只带发起方自己的指纹，对方一样就没必要回。
    const safeHash = typeof hash === 'string' ? hash.trim().toLowerCase() : ''
    if (!HEX16_RE.test(safeHash)) throw new Error('protocol: invalid catalog hash')
    packet = { ...base, hash: safeHash }
  } else if (type === 'crop-catalog') {
    const safeCatalogHash = typeof catalogHash === 'string' ? catalogHash.trim().toLowerCase() : ''
    if (!HEX16_RE.test(safeCatalogHash)) throw new Error('protocol: invalid catalog hash')
    if (!Number.isInteger(chunk) || chunk < 0 || chunk >= MAX_CATALOG_CHUNKS) {
      throw new Error('protocol: invalid catalog chunk')
    }
    if (!Number.isInteger(total) || total < 1 || total > MAX_CATALOG_CHUNKS) {
      throw new Error('protocol: invalid catalog total')
    }
    if (chunk >= total) throw new Error('protocol: invalid catalog chunk')
    const safeEntries = normalizeCatalogEntries(entries)
    if (safeEntries === null) throw new Error('protocol: invalid catalog entries')
    packet = { ...base, catalogHash: safeCatalogHash, chunk, total, entries: safeEntries }
  } else if (type === 'futures-hello') {
    // 自己的分支，绝不并进 VISIT_TYPES：那条只写四个字段，at 会在这里消失。
    packet = { ...base, at: futuresStamp(at, now) }
  } else if (type === 'futures-order') {
    // 只带「做什么」。成交价、保证金、余额一律不上线：房主算，peer 信不信由它。
    const stamp = futuresStamp(at, now)
    if (!isFuturesOrderKind(kind)) throw new Error('protocol: invalid futures kind')
    if (kind === 'open') {
      if (!isCropId(crop)) throw new Error('protocol: invalid futures crop')
      if (!isFuturesSide(side)) throw new Error('protocol: invalid futures side')
      if (!isMarginAmount(margin)) throw new Error('protocol: invalid futures margin')
      if (!isFuturesLeverage(leverage)) throw new Error('protocol: invalid futures leverage')
      packet = { ...base, at: stamp, kind, crop, side, margin, leverage }
    } else if (kind === 'close') {
      if (!isVisitId(positionId)) throw new Error('protocol: invalid positionId')
      packet = { ...base, at: stamp, kind, positionId: positionId.toLowerCase() }
    } else if (kind === 'place') {
      // 票 95：限价单只带限价与张数，冻多少保证金由房主按同一套 marginOf 算。
      const safePlace = normalizeFuturesPlace({ crop, side, price, lots, leverage })
      if (safePlace === null) throw new Error('protocol: invalid futures place')
      packet = { ...base, at: stamp, kind, ...safePlace }
    } else if (kind === 'convert') {
      // 票 96：转现货只带仓位与张数；价格、盈亏、手续费全由房主按同一套规则算。
      if (!isVisitId(positionId)) throw new Error('protocol: invalid futures positionId')
      if (!Number.isInteger(lots) || lots < 1 || lots > MAX_FUTURES_LOTS) {
        throw new Error('protocol: invalid futures lots')
      }
      packet = { ...base, at: stamp, kind, positionId: positionId.toLowerCase(), lots }
    } else {
      // 充值只带金币数量：钱从房主那边的农场账户走，peer 不自己扣。
      if (!Number.isInteger(coins) || coins < 1 || coins > MAX_FUTURES_COIN) {
        throw new Error('protocol: invalid futures coins')
      }
      packet = { ...base, at: stamp, kind, coins }
    }
  } else if (type === 'futures-cancel') {
    // 票 95：按挂单撤（`orderId`）；`positionId` 留给票 96 的「按仓位撤单」，两者至少一个。
    const safeOrderId = isVisitId(orderId) ? orderId.toLowerCase() : null
    const safePositionId = isVisitId(positionId) ? positionId.toLowerCase() : null
    if (safeOrderId === null && safePositionId === null) {
      throw new Error('protocol: invalid futures cancel target')
    }
    packet = {
      ...base,
      at: futuresStamp(at, now),
      ...(safeOrderId === null ? {} : { orderId: safeOrderId }),
      ...(safePositionId === null ? {} : { positionId: safePositionId })
    }
  } else if (type === 'futures-settle') {
    // 房主 → peer 的账户快照。`delta` 只说明这一拍余额动了多少，
    // peer **不拿它入账**（账以 balance/marginUsed/positions/orders 为准），所以重复包不会被记两次。
    const stamp = futuresStamp(at, now)
    if (!isFuturesEpoch(epoch)) throw new Error('protocol: invalid futures epoch')
    if (!isFuturesSeq(seq)) throw new Error('protocol: invalid futures seq')
    const safeBalance = normalizeFuturesCoin(balance)
    if (safeBalance === null) throw new Error('protocol: invalid futures balance')
    const safeMarginUsed = normalizeFuturesCoin(marginUsed)
    if (safeMarginUsed === null) throw new Error('protocol: invalid futures margin used')
    const safeDelta = normalizeFuturesDelta(delta)
    if (safeDelta === null) throw new Error('protocol: invalid futures delta')
    const safePositions = normalizeFuturesPositions(positions)
    if (safePositions === null) throw new Error('protocol: invalid futures positions')
    // 票 95：挂单是可选字段（老调用方不带 = 空盘口），带了就必须整份合法。
    const safeOrders = orders === undefined ? [] : normalizeFuturesOrders(orders)
    if (safeOrders === null) throw new Error('protocol: invalid futures orders')
    // 票 96：成交流水（交割/转现货）也是可选字段；不带就是空，带了必须整份合法。
    const safeTrades = trades === undefined ? [] : normalizeFuturesTrades(trades)
    if (safeTrades === null) throw new Error('protocol: invalid futures trades')
    // 票 97：保险基金余额与累计欠账（整数分、非负）。老房主不发时按 0，不算坏包。
    const safeInsurance = insurance === undefined ? 0 : normalizeFuturesCoin(insurance)
    if (safeInsurance === null) throw new Error('protocol: invalid futures insurance')
    const safeShortfall = shortfall === undefined ? 0 : normalizeFuturesCoin(shortfall)
    if (safeShortfall === null) throw new Error('protocol: invalid futures shortfall')
    // 票 98：灰度模式（白名单）与待提取余额（非负、可缺省为 0）。
    const safeMode = mode === undefined ? FUTURES_DEFAULT_MODE : (FUTURES_MODES.includes(mode) ? mode : null)
    if (safeMode === null) throw new Error('protocol: invalid futures mode')
    const safePending = pending === undefined ? 0 : normalizeFuturesCoin(pending)
    if (safePending === null) throw new Error('protocol: invalid futures pending')
    packet = {
      ...base,
      at: stamp,
      epoch,
      seq,
      balance: safeBalance,
      marginUsed: safeMarginUsed,
      delta: safeDelta,
      positions: safePositions,
      orders: safeOrders,
      trades: safeTrades,
      insurance: safeInsurance,
      shortfall: safeShortfall,
      mode: safeMode,
      pending: safePending
    }
  } else if (type === 'futures-sync') {
    // peer：我手上是 (epoch, lastSeq)，缺的请补给我。房主只回一条 settle（整份快照）。
    const stamp = futuresStamp(at, now)
    if (!isFuturesEpoch(epoch)) throw new Error('protocol: invalid futures epoch')
    if (!isFuturesSeq(lastSeq)) throw new Error('protocol: invalid futures last seq')
    packet = { ...base, at: stamp, epoch, lastSeq }
  } else if (VISIT_TYPES.has(type)) {
    if (!isVisitId(visitId)) throw new Error('protocol: invalid visitId')
    packet = { ...base, visitId: visitId.toLowerCase() }
  } else {
    if (!isPort(port)) throw new Error('protocol: invalid port')
    const safeNickname = normalizeNickname(nickname)
    if (safeNickname === null) throw new Error('protocol: invalid nickname')
    // 票 59：beacon 只带目录指纹（三个数），完整目录在两边不一致时单独拉。
    const announce = normalizeCatalogAnnounce(crops)
    packet = {
      ...base,
      nickname: safeNickname,
      port,
      ...skin,
      ...capsExtras(caps),
      ...(announce === null ? {} : { crops: announce })
    }
  }

  if (type === 'visit-ack' && raid !== undefined && raid !== null) {
    const safeRaid = normalizeRaidResult(raid)
    if (safeRaid !== null) packet = { ...packet, raid: safeRaid }
  }

  let giftDropped = false
  if (type === 'visit-request' && gift !== undefined && gift !== null) {
    const safeGift = normalizeGift(gift)
    if (safeGift === null) giftDropped = true
    else packet = { ...packet, gift: safeGift }
  }

  let data = Buffer.from(JSON.stringify(packet), 'utf8')
  if (data.length > maxBytes && packet.gift !== undefined) {
    // 兜底：字条再重要也不值得让串门失败。丢掉它、重编一次，串门本身一个字段都不动。
    const { gift: _dropped, ...withoutGift } = packet
    packet = withoutGift
    data = Buffer.from(JSON.stringify(packet), 'utf8')
    giftDropped = true
  }
  if (data.length > maxBytes) throw new Error('protocol: packet too large')
  return { data, giftDropped }
}

/** 心跳/串门请求共用的可选字段；非法值只是不带，不整包失败。 */
function petExtras ({ action, semantic, say, now }) {
  const extras = {}
  const safeAction = normalizeAnimation(action)
  if (safeAction !== null) extras.action = safeAction
  const safeSemantic = normalizeSemantic(semantic)
  if (safeSemantic !== null) extras.semantic = safeSemantic
  const safeSay = normalizeSay(say, now)
  if (safeSay !== null) extras.say = safeSay
  return extras
}

function skinExtras ({ skinPort, skinId }) {
  const extras = {}
  if (isPort(skinPort)) extras.skinPort = skinPort
  const safeId = normalizeSkinId(skinId)
  if (safeId !== null) extras.skinId = safeId
  return extras
}

/** ticket 04 的窄入口：调用方无法往心跳里塞昵称、端口或坐标。 */
export function encodeHeartbeat ({ deviceId, anim, action, semantic, say, skinPort, skinId, now } = {}) {
  return encodePacket({ type: 'heartbeat', deviceId, anim, action, semantic, say, skinPort, skinId, now })
}

/**
 * ticket 05 的窄入口：串门请求只带昵称、动作和串门 id（外加可选的 skin/状态与字条）。
 * 需要知道“礼物到底带没带上”的调用方用 `encodeVisitRequestDetailed`；这里保持
 * “返回一串字节”的老契约，超限时字条会被静默丢掉（串门本身仍然成功）。
 */
export function encodeVisitRequest ({ deviceId, visitId, nickname, anim, action, semantic, say, skinPort, skinId, gift, now } = {}) {
  return encodePacket({
    type: 'visit-request',
    deviceId,
    visitId,
    nickname,
    anim,
    action,
    semantic,
    say,
    skinPort,
    skinId,
    gift,
    now
  })
}

export function encodeVisitAck ({ deviceId, visitId, raid } = {}) {
  return encodePacket({ type: 'visit-ack', deviceId, visitId, raid })
}

export function encodeVisitDeny ({ deviceId, visitId, reason } = {}) {
  return encodePacket({ type: 'visit-deny', deviceId, visitId, reason })
}

export function encodeVisitRecall ({ deviceId, visitId } = {}) {
  return encodePacket({ type: 'visit-recall', deviceId, visitId })
}

/** 收到 recall 的回执：让发起方立刻停止重发（它可能有两次重试在路上）。 */
export function encodeVisitRecallAck ({ deviceId, visitId } = {}) {
  return encodePacket({ type: 'visit-recall-ack', deviceId, visitId })
}

/**
 * 礼物的送达回执（ticket 26）：接收方**真的写进 `gifts/` 之后**才发。
 * 发起方收到才把背包那件删掉，所以 `giftId` 是这条报文的全部意义——
 * `visitId` 只用来核对“是不是这次串门带出去的那一件”。
 */
export function encodeGiftReceived ({ deviceId, visitId, giftId } = {}) {
  return encodePacket({ type: 'gift-received', deviceId, visitId, giftId })
}

/**
 * 红包退回（ticket 79）：收件方 24 小时没拆，把内容原样送回寄件人。
 * `giftId` 仍是原红包的 id——寄件人靠它认出是哪一包，也靠它去重（重发不会入账两次）。
 */
export function encodePacketReturn ({ deviceId, giftId, contents, note } = {}) {
  return encodePacket({ type: 'packet-return', deviceId, giftId, contents, note })
}

/** 退回回执：收件方收到它才把本地那张卡标成「已退回」。 */
export function encodePacketReturned ({ deviceId, giftId } = {}) {
  return encodePacket({ type: 'packet-returned', deviceId, giftId })
}

/**
 * 行情 gossip（ticket 42）：本机每种作物的 price + 自己的雇工挂牌。
 * `at` 缺省用本地时钟；价格/挂牌由调用方从 store 取，坏条目在这里被丢弃。
 */
export function encodeMarketDigest ({ deviceId, at, prices, hire, now } = {}) {
  return encodePacket({ type: 'market-digest', deviceId, at, prices, hire, now })
}

/**
 * 盘口周报（票 82）：只报「本周交易盈亏 + 当前持仓（作物/方向/杠杆）」。
 *
 * 这里**没有**硬币余额、保证金、入场价、历史——不是漏了，是协议就不给这个入口：
 * 邻居只需要知道分数和方向（SPEC v10「不包含硬币余额、保证金、入场价、历史」）。
 * `positions` 最多 `MAX_TRADING_POSITIONS` 条；`weekPnlPct` 是可选比率，缺省就不带这个键。
 */
export function encodeTradingDigest ({ deviceId, at, weekPnl, weekPnlPct, positions, now } = {}) {
  return encodePacket({ type: 'trading-digest', deviceId, at, weekPnl, weekPnlPct, positions, now })
}

/**
 * 盘口资金流（票 107）：peer 把自己/收到的流水广播给邻居。
 * 一包最多 16 条；事件只带 `id/at/crop/action/side/reason/notional/source`，
 * 冲击由接收端按同一套 `board-flow.js` 现算，不信发送端的 `u`。
 */
export function encodeBoardFlow ({ deviceId, at, events, sync = false, now } = {}) {
  return encodePacket({ type: 'board-flow', deviceId, at, events, sync, now })
}

/** 要一段流水：`since` 之后的事件，房主/邻居用 `board-flow` 回。 */
export function encodeBoardFlowSync ({ deviceId, at, since, now } = {}) {
  return encodePacket({ type: 'board-flow-sync', deviceId, at, since, now })
}

/**
 * 期货五包（票 94）的窄入口：全部只带账户字段——没有昵称、端口、坐标、自由文本。
 * 编码失败抛异常（本机程序错误）；解析失败返回 `{ok:false, reason}`（网络输入）。
 */
export function encodeFuturesHello ({ deviceId, at, now } = {}) {
  return encodePacket({ type: 'futures-hello', deviceId, at, now })
}

export function encodeFuturesOrder ({ deviceId, at, kind, crop, side, margin, leverage, price, lots, coins, positionId, now } = {}) {
  return encodePacket({
    type: 'futures-order',
    deviceId,
    at,
    kind,
    crop,
    side,
    margin,
    leverage,
    price,
    lots,
    coins,
    positionId,
    now
  })
}

export function encodeFuturesCancel ({ deviceId, at, orderId, positionId, now } = {}) {
  return encodePacket({ type: 'futures-cancel', deviceId, at, orderId, positionId, now })
}

export function encodeFuturesSettle ({
  deviceId,
  at,
  epoch,
  seq,
  balance,
  marginUsed,
  delta = 0,
  positions,
  orders,
  trades,
  insurance = 0,
  shortfall = 0,
  house = 0,
  mode = FUTURES_DEFAULT_MODE,
  accountMode = null,
  paused = false,
  pending = 0,
  now
} = {}) {
  const packet = {
    type: 'futures-settle',
    deviceId,
    at,
    epoch,
    seq,
    balance,
    marginUsed,
    delta,
    positions,
    orders,
    trades,
    insurance,
    shortfall,
    mode,
    pending,
    now
  }
  // 1.12.4：做市商净盈亏，只在非 0 时带字段（负数是合法的：负 = 系统净付出）。
  if (Number.isFinite(house) && house !== 0) packet.house = house
  // 1.10.0：账户档位是可选字段（老 peer 不发 = 不知道，按 null）。
  if (isFuturesAccountMode(accountMode)) packet.accountMode = accountMode
  // 1.12.0：账户自己的暂停开关，只在按下时带字段（缺省 = 没暂停）。
  if (paused === true) packet.paused = true
  return encodePacket(packet)
}

/**
 * 1.12.0：账户申报自己按下的暂停（peer → 房主）。
 * 只带一个布尔值：房主据此拒绝这个账户的新单，别人的账一概不动。
 */
export function encodeFuturesPause ({ deviceId, at, paused, now } = {}) {
  return encodePacket({ type: 'futures-pause', deviceId, at, paused: paused === true, now })
}

/** 1.12.0（B）：整本账快照的一个分片。`chunk` 是 JSON 字符串的一段，房主按序发、peer 拼。 */
export const FUTURES_LEDGER_MAX_CHUNK = 2800
export const FUTURES_LEDGER_MAX_PARTS = 8

export function encodeFuturesLedger ({ deviceId, at, epoch, seq, hostId, index, total, chunk, now } = {}) {
  return encodePacket({
    type: 'futures-ledger',
    deviceId,
    at,
    epoch,
    seq,
    hostId,
    index,
    total,
    chunk
  }, { now })
}

/**
 * 1.10.0：账户申报自己的档位（peer → 房主）。
 * 只带一个白名单值，不带余额/农场/自由文本——房主按它决定这本账按真钱还是纸面结算。
 */
export function encodeFuturesMode ({ deviceId, at, accountMode, now } = {}) {
  return encodePacket({ type: 'futures-mode', deviceId, at, accountMode, now })
}

export function encodeFuturesSync ({ deviceId, at, epoch, lastSeq, now } = {}) {
  return encodePacket({ type: 'futures-sync', deviceId, at, epoch, lastSeq, now })
}

/**
 * 农场动作（ticket 43）：访客 → 主人。
 * 只带这次动作的全部输入；没有昵称、端口、坐标、路径或自由文本。
 */
/**
 * 票 59：请邻居把他的作物目录发过来（只带自己的指纹，对方一致就不回）。
 * 收到请求的一方按每邻居 30 秒最多回一次的频率答复，见 service 的 `catalogPeers`。
 */
export function encodeCropCatalogRequest ({ deviceId, hash } = {}) {
  return encodePacket({ type: 'crop-catalog-request', deviceId, hash })
}

/**
 * 票 59：作物目录的一片。`chunk`/`total` 从 0 起；每片最多
 * `MAX_CATALOG_ENTRIES_PER_PACKET` 条，保证整包仍在 4 KiB 里。
 */
export function encodeCropCatalog ({ deviceId, catalogHash, chunk, total, entries } = {}) {
  return encodePacket({ type: 'crop-catalog', deviceId, catalogHash, chunk, total, entries })
}

export function encodeFarmAction ({ deviceId, visitId, requestId, action, plotId } = {}) {
  return encodePacket({ type: 'farm-action', deviceId, visitId, requestId, action, plotId })
}

/**
 * 农场动作结果：主人 → 访客。`requestId` 原样回传，访客按它 settle 一次。
 * 成功带 crop/qty；失败带固定枚举 error；`caught` 只跟 steal 的 guard 一起出现。
 */
export function encodeFarmActionResult ({ deviceId, requestId, ok, error, crop, qty, caught } = {}) {
  return encodePacket({ type: 'farm-action-result', deviceId, requestId, ok, error, crop, qty, caught })
}

/**
 * 八个 work-* 的窄入口（ticket 44）。全部只带合同字段：没有昵称、端口、路径、自由文本。
 * 编码失败抛异常（本机程序错误）；解析失败返回 `{ok:false, reason}`（网络输入）。
 */
export function encodeWorkRequest ({ deviceId, requestId, hours, wagePerHour, fee } = {}) {
  return encodePacket({ type: 'work-request', deviceId, requestId, hours, wagePerHour, fee })
}

export function encodeWorkAck ({ deviceId, requestId, ok, contractId, startedAt, endsAt, guard, error } = {}) {
  return encodePacket({
    type: 'work-ack',
    deviceId,
    requestId,
    ok,
    contractId,
    startedAt,
    endsAt,
    guard,
    error
  })
}

export function encodeWorkRecall ({ deviceId, contractId } = {}) {
  return encodePacket({ type: 'work-recall', deviceId, contractId })
}

export function encodeWorkRecallAck ({ deviceId, contractId, ok = true, error } = {}) {
  return encodePacket({ type: 'work-recall-ack', deviceId, contractId, ok, error })
}

export function encodeWorkEnd ({ deviceId, contractId, requestId, reason } = {}) {
  return encodePacket({ type: 'work-end', deviceId, contractId, requestId, reason })
}

export function encodeWorkEndAck ({ deviceId, contractId, requestId, ok = true, error } = {}) {
  return encodePacket({ type: 'work-end-ack', deviceId, contractId, requestId, ok, error })
}

export function encodeWorkSettle ({ deviceId, contractId, requestId, servedMs, earned, reason } = {}) {
  return encodePacket({ type: 'work-settle', deviceId, contractId, requestId, servedMs, earned, reason })
}

export function encodeWorkSettleAck ({ deviceId, contractId, requestId, ok = true, earned, error } = {}) {
  return encodePacket({
    type: 'work-settle-ack',
    deviceId,
    contractId,
    requestId,
    ok,
    earned,
    error
  })
}

function fail (reason) {
  return { ok: false, reason }
}

/**
 * 把 UDP 载荷解析成**新**的、只含白名单字段的对象。
 * 绝不把原始 JSON 对象交给调用方：未知字段到这里就结束了。
 */
export function parsePacket (input, { now = Date.now() } = {}) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > MAX_PACKET_BYTES) return fail('too-large')
  } else if (input instanceof Uint8Array) {
    if (input.length > MAX_PACKET_BYTES) return fail('too-large')
  } else {
    return fail('bad-type')
  }

  let text
  try {
    text = typeof input === 'string'
      ? input
      : new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    return fail('bad-encoding')
  }

  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('bad-json')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('bad-shape')
  if (raw.v !== PROTOCOL_VERSION) return fail('version')
  if (typeof raw.type !== 'string' || !TYPE_SET.has(raw.type)) return fail('type')
  if (!isDeviceId(raw.deviceId)) return fail('device-id')

  // 心跳只承载动作意图：anim 必须显式存在，是 null 或安全动画名。
  // 新字段（action/semantic/say/skin*）全部可选：非法就只是不带，旧字段仍然有效。
  // nickname / port / 坐标等字段即使出现也不会被读取（下面重建对象）。
  if (raw.type === 'heartbeat') {
    if (raw.anim !== null && !isSafeAnimationName(raw.anim)) return fail('anim')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        anim: raw.anim === null ? null : raw.anim.trim(),
        ...petExtras({ action: raw.action, semantic: raw.semantic, say: raw.say, now }),
        ...skinExtras({ skinPort: raw.skinPort, skinId: raw.skinId }),
        ...capsExtras(raw.caps)
      }
    }
  }

  // 串门请求带昵称与动作名；昵称仍要清洗，动作名非法整包丢（与心跳一致）。
  // 礼物是**例外**：gift 校验不过只丢这个字段，串门照常（见 normalizeGift 的注释）。
  // anim 是这次串门的“外观”，退化一下还能画；一道便条却只是搭车的东西。
  if (raw.type === 'visit-request') {
    if (!isVisitId(raw.visitId)) return fail('visit-id')
    const nickname = normalizeNickname(raw.nickname)
    if (nickname === null) return fail('nickname')
    if (raw.anim !== null && !isSafeAnimationName(raw.anim)) return fail('anim')
    const gift = normalizeGift(raw.gift)
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        visitId: raw.visitId.toLowerCase(),
        nickname,
        anim: raw.anim === null ? null : raw.anim.trim(),
        ...petExtras({ action: raw.action, semantic: raw.semantic, say: raw.say, now }),
        ...skinExtras({ skinPort: raw.skinPort, skinId: raw.skinId }),
        ...(raw.purpose === RAID_PURPOSE ? { purpose: RAID_PURPOSE } : {}),
        ...(raw.purpose === RAID_PURPOSE && normalizeRaidPlots(raw.plots) !== null
          ? { plots: normalizeRaidPlots(raw.plots) }
          : {}),
        ...(gift === null ? {} : { gift })
      }
    }
  }

  // visit-deny 多一个固定枚举理由；旧报文没带 reason 时按 not-admitted 处理。
  if (raw.type === 'visit-deny') {
    if (!isVisitId(raw.visitId)) return fail('visit-id')
    const reason = raw.reason === undefined ? 'not-admitted' : raw.reason
    if (!isVisitDenyReason(reason)) return fail('deny-reason')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        visitId: raw.visitId.toLowerCase(),
        reason
      }
    }
  }

  // 送达回执（ticket 26）：多一个 giftId，且**不能**落进下面 VISIT_TYPES 那条分支
  // （那里只重建四个字段，giftId 会被吃掉）。和 ack/recall 一样，别的字段一律丢弃。
  if (raw.type === 'gift-received') {
    if (!isVisitId(raw.visitId)) return fail('visit-id')
    if (!isVisitId(raw.giftId)) return fail('gift-id')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        visitId: raw.visitId.toLowerCase(),
        giftId: raw.giftId.toLowerCase()
      }
    }
  }

  // 红包退回（ticket 79）：多 giftId + 内容，**不能**落进 VISIT_TYPES（那里只重建四个字段）。
  // 内容按 PACKET_LIMITS 再校验；不合法就整包丢——宁可这一包退不回来，也不让坏内容入账。
  if (raw.type === 'packet-return') {
    if (!isVisitId(raw.giftId)) return fail('gift-id')
    const contents = normalizePacketContents(raw.contents)
    if (contents === null) return fail('packet')
    const note = normalizePacketNote(raw.note)
    if (note === null) return fail('note')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        giftId: raw.giftId.toLowerCase(),
        contents,
        ...(note === '' ? {} : { note })
      }
    }
  }

  // 退回回执：只有 giftId，别的字段一律丢弃。
  if (raw.type === 'packet-returned') {
    if (!isVisitId(raw.giftId)) return fail('gift-id')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        giftId: raw.giftId.toLowerCase()
      }
    }
  }

  // 行情 digest（ticket 42）：**不**落进 VISIT_TYPES（那里只重建四个字段）。
  // 坏价格只丢那一个作物；形状/时间/挂牌坏了才整包丢。昵称、端口等一律不读。
  if (raw.type === 'market-digest') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    const prices = normalizeDigestPrices(raw.prices)
    if (prices === null) return fail('prices')
    const hire = normalizeDigestHire(raw.hire)
    if (hire === null) return fail('hire')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        at,
        prices,
        hire
      }
    }
  }

  // 盘口周报（票 82）：**不**落进 VISIT_TYPES（那里只重建四个字段）。
  // 任何一项坏都整包丢（含持仓里的一条）：榜上不留半截行；昵称/端口等一律不读。
  if (raw.type === 'trading-digest') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    const weekPnl = normalizeWeeklyPnl(raw.weekPnl)
    if (weekPnl === null) return fail('week-pnl')
    let weekPnlPct = null
    if (raw.weekPnlPct !== undefined && raw.weekPnlPct !== null) {
      weekPnlPct = normalizeWeeklyPnlPct(raw.weekPnlPct)
      if (weekPnlPct === null) return fail('week-pnl-pct')
    }
    const positions = normalizeTradingPositions(raw.positions)
    if (positions === null) return fail('positions')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        at,
        weekPnl,
        ...(weekPnlPct === null ? {} : { weekPnlPct }),
        positions
      }
    }
  }

  // 票 107：LAN 资金流。事件里的 deviceId 一律盖成包上的发送端；坏一条丢一条。
  if (raw.type === 'board-flow') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    if (!Array.isArray(raw.events)) return fail('events')
    const events = []
    for (const candidate of raw.events.slice(0, 16)) {
      const event = normalizeFlowEvent(candidate)
      if (event === null) continue
      events.push({ ...event, deviceId: raw.deviceId.toLowerCase() })
    }
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        at,
        events,
        sync: raw.sync === true
      }
    }
  }
  if (raw.type === 'board-flow-sync') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    const since = Number(raw.since)
    if (!Number.isFinite(since) || since < 0 || since > at + 5 * 60 * 1000) return fail('since')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        at,
        since: Math.floor(since)
      }
    }
  }

  // 农场动作（ticket 43）：**不**落进 VISIT_TYPES（那里只重建四个字段）。
  // 字段就是这次动作的全部输入：任何一项坏都整包丢；昵称/端口等一律不读。
  if (raw.type === 'farm-action') {
    if (!isVisitId(raw.visitId)) return fail('visit-id')
    if (!isVisitId(raw.requestId)) return fail('request-id')
    if (typeof raw.action !== 'string' || !FARM_ACTION_KIND_SET.has(raw.action)) return fail('action')
    if (typeof raw.plotId !== 'string' || !PLOT_ID_RE.test(raw.plotId)) return fail('plot-id')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        visitId: raw.visitId.toLowerCase(),
        requestId: raw.requestId.toLowerCase(),
        action: raw.action,
        plotId: raw.plotId
      }
    }
  }

  // 农场动作结果（ticket 43）：成功必须有合法作物与 0..1 的数量；
  // 失败必须有固定枚举；`caught` 可选，但出现就必须是布尔（不转发文本）。
  if (raw.type === 'farm-action-result') {
    if (!isVisitId(raw.requestId)) return fail('request-id')
    if (typeof raw.ok !== 'boolean') return fail('ok')
    if (raw.caught !== undefined && typeof raw.caught !== 'boolean') return fail('caught')
    if (raw.ok === true) {
      if (raw.caught === true) return fail('caught')
      if (!isCropId(raw.crop)) return fail('crop')
      const qty = Number(raw.qty)
      if (!Number.isInteger(qty) || qty < 0 || qty > MAX_FARM_QTY) return fail('qty')
      return {
        ok: true,
        packet: {
          v: PROTOCOL_VERSION,
          type: raw.type,
          deviceId: raw.deviceId.toLowerCase(),
          requestId: raw.requestId.toLowerCase(),
          ok: true,
          crop: raw.crop,
          qty,
          ...(raw.caught === true ? { caught: true } : {})
        }
      }
    }
    if (typeof raw.error !== 'string' || !FARM_ACTION_ERROR_SET.has(raw.error)) return fail('error')
    // caught 只能跟 guard 一起出现；`ok:true + caught` 或 `cap + caught` 都整包丢。
    if (raw.caught === true && raw.error !== 'guard') return fail('caught')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        requestId: raw.requestId.toLowerCase(),
        ok: false,
        error: raw.error,
        ...(raw.caught === true ? { caught: true } : {})
      }
    }
  }

  // 雇佣合同（ticket 44）：八个独立分支，**不落进 VISIT_TYPES**。
  if (raw.type === 'work-request') {
    if (!isVisitId(raw.requestId)) return fail('request-id')
    if (!isWorkHours(raw.hours)) return fail('hours')
    if (!isWorkWage(raw.wagePerHour)) return fail('wage')
    if (!isWorkFee(raw.fee)) return fail('fee')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        requestId: raw.requestId.toLowerCase(),
        hours: raw.hours,
        wagePerHour: raw.wagePerHour,
        fee: raw.fee
      }
    }
  }

  if (raw.type === 'work-ack') {
    if (!isVisitId(raw.requestId)) return fail('request-id')
    if (typeof raw.ok !== 'boolean') return fail('ok')
    if (raw.ok === true) {
      if (!isVisitId(raw.contractId)) return fail('contract-id')
      if (!Number.isSafeInteger(raw.startedAt) || raw.startedAt <= 0) return fail('started-at')
      if (!Number.isSafeInteger(raw.endsAt)) return fail('ends-at')
      if (raw.endsAt <= raw.startedAt || raw.endsAt - raw.startedAt > MAX_WORK_SERVED_MS) {
        return fail('contract-time')
      }
      if (!isWorkGuard(raw.guard)) return fail('guard')
      return {
        ok: true,
        packet: {
          v: PROTOCOL_VERSION,
          type: raw.type,
          deviceId: raw.deviceId.toLowerCase(),
          requestId: raw.requestId.toLowerCase(),
          ok: true,
          contractId: raw.contractId.toLowerCase(),
          startedAt: raw.startedAt,
          endsAt: raw.endsAt,
          guard: raw.guard
        }
      }
    }
    if (!isWorkError(raw.error)) return fail('error')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        requestId: raw.requestId.toLowerCase(),
        ok: false,
        error: raw.error
      }
    }
  }

  if (raw.type === 'work-recall' || raw.type === 'work-recall-ack') {
    if (!isVisitId(raw.contractId)) return fail('contract-id')
    if (raw.type === 'work-recall') {
      return {
        ok: true,
        packet: {
          v: PROTOCOL_VERSION,
          type: raw.type,
          deviceId: raw.deviceId.toLowerCase(),
          contractId: raw.contractId.toLowerCase()
        }
      }
    }
    if (typeof raw.ok !== 'boolean') return fail('ok')
    if (raw.ok !== true && !isWorkError(raw.error)) return fail('error')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        contractId: raw.contractId.toLowerCase(),
        ok: raw.ok,
        ...(raw.ok === true ? {} : { error: raw.error })
      }
    }
  }

  if (raw.type === 'work-end') {
    const hasContract = raw.contractId !== undefined && raw.contractId !== null
    const hasRequest = raw.requestId !== undefined && raw.requestId !== null
    if (!hasContract && !hasRequest) return fail('target')
    if (hasContract && !isVisitId(raw.contractId)) return fail('contract-id')
    if (hasRequest && !isVisitId(raw.requestId)) return fail('request-id')
    if (!isWorkEndReason(raw.reason)) return fail('reason')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        ...(hasContract ? { contractId: raw.contractId.toLowerCase() } : {}),
        ...(hasContract || !hasRequest ? {} : { requestId: raw.requestId.toLowerCase() }),
        reason: raw.reason
      }
    }
  }

  if (raw.type === 'work-end-ack') {
    const hasContract = raw.contractId !== undefined && raw.contractId !== null
    const hasRequest = raw.requestId !== undefined && raw.requestId !== null
    if (!hasContract && !hasRequest) return fail('target')
    if (hasContract && !isVisitId(raw.contractId)) return fail('contract-id')
    if (hasRequest && !isVisitId(raw.requestId)) return fail('request-id')
    if (typeof raw.ok !== 'boolean') return fail('ok')
    if (raw.ok !== true && !isWorkError(raw.error)) return fail('error')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        ...(hasContract ? { contractId: raw.contractId.toLowerCase() } : {}),
        ...(hasRequest ? { requestId: raw.requestId.toLowerCase() } : {}),
        ok: raw.ok,
        ...(raw.ok === true ? {} : { error: raw.error })
      }
    }
  }

  if (raw.type === 'work-settle') {
    if (!isVisitId(raw.contractId)) return fail('contract-id')
    if (!isVisitId(raw.requestId)) return fail('request-id')
    if (!Number.isSafeInteger(raw.servedMs) || raw.servedMs < 0 || raw.servedMs > MAX_WORK_SERVED_MS) {
      return fail('served-ms')
    }
    if (!Number.isSafeInteger(raw.earned) || raw.earned < 0 || raw.earned > MAX_WORK_EARNED) {
      return fail('earned')
    }
    if (!isWorkSettleReason(raw.reason)) return fail('reason')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        contractId: raw.contractId.toLowerCase(),
        requestId: raw.requestId.toLowerCase(),
        servedMs: raw.servedMs,
        earned: raw.earned,
        reason: raw.reason
      }
    }
  }

  if (raw.type === 'work-settle-ack') {
    if (!isVisitId(raw.contractId)) return fail('contract-id')
    if (!isVisitId(raw.requestId)) return fail('request-id')
    if (typeof raw.ok !== 'boolean') return fail('ok')
    if (raw.ok === true) {
      if (!Number.isSafeInteger(raw.earned) || raw.earned < 0 || raw.earned > MAX_WORK_EARNED) {
        return fail('earned')
      }
      return {
        ok: true,
        packet: {
          v: PROTOCOL_VERSION,
          type: raw.type,
          deviceId: raw.deviceId.toLowerCase(),
          contractId: raw.contractId.toLowerCase(),
          requestId: raw.requestId.toLowerCase(),
          ok: true,
          earned: raw.earned
        }
      }
    }
    if (!isWorkError(raw.error)) return fail('error')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        contractId: raw.contractId.toLowerCase(),
        requestId: raw.requestId.toLowerCase(),
        ok: false,
        error: raw.error
      }
    }
  }

  // 期货五包（票 94）：**不**落进 VISIT_TYPES（那里只重建四个字段，账户字段会消失）。
  // 任何一项坏都整包丢；昵称、端口、坐标等即使出现也不读（下面重建对象）。
  if (raw.type === 'futures-hello') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    return {
      ok: true,
      packet: { v: PROTOCOL_VERSION, type: raw.type, deviceId: raw.deviceId.toLowerCase(), at }
    }
  }

  // 1.10.0：账户申报自己的档位。只有白名单两个值，别的一律拒。
  if (raw.type === 'futures-mode') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    if (!isFuturesAccountMode(raw.accountMode)) return fail('account-mode')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        at,
        accountMode: raw.accountMode
      }
    }
  }

  // 1.12.0：账户申报自己按下的暂停。只是一个布尔值。
  if (raw.type === 'futures-pause') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    if (typeof raw.paused !== 'boolean') return fail('paused')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        at,
        paused: raw.paused
      }
    }
  }

  // 1.12.0（B）：整本账快照的分片。房主按序发，peer 按 `(epoch, seq, total)` 拼回来；
  // 分片本身没有语义，只保证「不超过上限、序号自洽」。
  if (raw.type === 'futures-ledger') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    if (typeof raw.epoch !== 'string' || raw.epoch.length > 64) return fail('epoch')
    if (!(Number.isInteger(raw.seq) && raw.seq >= 0)) return fail('seq')
    if (typeof raw.hostId !== 'string' || raw.hostId === '' || raw.hostId.length > 64) return fail('host-id')
    if (!(Number.isInteger(raw.total) && raw.total >= 1 && raw.total <= FUTURES_LEDGER_MAX_PARTS)) return fail('total')
    if (!(Number.isInteger(raw.index) && raw.index >= 0 && raw.index < raw.total)) return fail('index')
    if (typeof raw.chunk !== 'string' || raw.chunk.length === 0 || raw.chunk.length > FUTURES_LEDGER_MAX_CHUNK) {
      return fail('chunk')
    }
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        at,
        epoch: raw.epoch,
        seq: raw.seq,
        hostId: raw.hostId,
        index: raw.index,
        total: raw.total,
        chunk: raw.chunk
      }
    }
  }

  if (raw.type === 'futures-order') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    if (!isFuturesOrderKind(raw.kind)) return fail('kind')
    const base = { v: PROTOCOL_VERSION, type: raw.type, deviceId: raw.deviceId.toLowerCase(), at, kind: raw.kind }
    if (raw.kind === 'open') {
      if (!isCropId(raw.crop)) return fail('crop')
      if (!isFuturesSide(raw.side)) return fail('side')
      if (!isMarginAmount(raw.margin)) return fail('margin')
      if (!isFuturesLeverage(raw.leverage)) return fail('leverage')
      return { ok: true, packet: { ...base, crop: raw.crop, side: raw.side, margin: raw.margin, leverage: raw.leverage } }
    }
    if (raw.kind === 'close') {
      if (!isVisitId(raw.positionId)) return fail('position-id')
      return { ok: true, packet: { ...base, positionId: raw.positionId.toLowerCase() } }
    }
    if (raw.kind === 'place') {
      // 票 95：只收限价与张数；多余的字段一律不读（重建对象）。
      const place = normalizeFuturesPlace(raw)
      if (place === null) return fail('place')
      return { ok: true, packet: { ...base, ...place } }
    }
    if (raw.kind === 'convert') {
      // 票 96：只收仓位 id 与张数；价格/费用由房主算。
      if (!isVisitId(raw.positionId)) return fail('position-id')
      if (!Number.isInteger(raw.lots) || raw.lots < 1 || raw.lots > MAX_FUTURES_LOTS) return fail('lots')
      return { ok: true, packet: { ...base, positionId: raw.positionId.toLowerCase(), lots: raw.lots } }
    }
    if (!Number.isInteger(raw.coins) || raw.coins < 1 || raw.coins > MAX_FUTURES_COIN) return fail('coins')
    return { ok: true, packet: { ...base, coins: raw.coins } }
  }

  // 撤单（票 95）：`orderId` 撤挂单，`positionId` 留给票 96 的按仓位撤单，至少给一个。
  if (raw.type === 'futures-cancel') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    const orderId = isVisitId(raw.orderId) ? raw.orderId.toLowerCase() : null
    const positionId = isVisitId(raw.positionId) ? raw.positionId.toLowerCase() : null
    if (orderId === null && positionId === null) return fail('cancel-target')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        at,
        ...(orderId === null ? {} : { orderId }),
        ...(positionId === null ? {} : { positionId })
      }
    }
  }

  // 账户快照：peer 只读，不入账两次（幂等键是 (epoch, seq)，见 service 的 applySettle）。
  if (raw.type === 'futures-settle') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    if (!isFuturesEpoch(raw.epoch)) return fail('epoch')
    if (!isFuturesSeq(raw.seq)) return fail('seq')
    const balance = normalizeFuturesCoin(raw.balance)
    if (balance === null) return fail('balance')
    const marginUsed = normalizeFuturesCoin(raw.marginUsed)
    if (marginUsed === null) return fail('margin-used')
    const delta = normalizeFuturesDelta(raw.delta)
    if (delta === null) return fail('delta')
    const positions = normalizeFuturesPositions(raw.positions)
    if (positions === null) return fail('positions')
    // 票 95：挂单可选（老 peer 不发 = 空盘口）；给了就必须整份合法。
    const orders = raw.orders === undefined ? [] : normalizeFuturesOrders(raw.orders)
    if (orders === null) return fail('orders')
    // 票 96：成交流水可选（老 peer 不发 = 空）；给了就必须整份合法。
    const trades = raw.trades === undefined ? [] : normalizeFuturesTrades(raw.trades)
    if (trades === null) return fail('trades')
    // 票 97：保险基金与欠账可选（老房主不发 = 0）；给了就必须是非负整数分。
    const insurance = raw.insurance === undefined ? 0 : normalizeFuturesCoin(raw.insurance)
    if (insurance === null) return fail('insurance')
    const shortfall = raw.shortfall === undefined ? 0 : normalizeFuturesCoin(raw.shortfall)
    if (shortfall === null) return fail('shortfall')
    // 1.12.4：做市商净盈亏可选、允许为负（老房主不发 = 0）。
    let house = 0
    if (raw.house !== undefined) {
      if (typeof raw.house !== 'number' || !Number.isFinite(raw.house)) return fail('house')
      house = raw.house
    }
    // 票 98：模式缺省按 shadow（新装实例的缺省）；显式给了就必须在三值白名单里。
    const mode = raw.mode === undefined
      ? FUTURES_DEFAULT_MODE
      : FUTURES_MODES.includes(raw.mode) ? raw.mode : null
    if (mode === null) return fail('mode')
    const pending = raw.pending === undefined ? 0 : normalizeFuturesCoin(raw.pending)
    if (pending === null) return fail('pending')
    // 1.10.0：账户档位可选（老房主不发 = null，peer 按自己的设置猜）。
    const accountMode = raw.accountMode === undefined || raw.accountMode === null
      ? null
      : (isFuturesAccountMode(raw.accountMode) ? raw.accountMode : undefined)
    if (accountMode === undefined) return fail('account-mode')
    // 1.12.0：账户自己的暂停可选（老房主不发 = 没暂停）。
    const paused = raw.paused === undefined ? false : raw.paused
    if (typeof paused !== 'boolean') return fail('paused')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        at,
        epoch: raw.epoch,
        seq: raw.seq,
        balance,
        marginUsed,
        delta,
        positions,
        orders,
        trades,
        insurance,
        shortfall,
        house,
        mode,
        accountMode,
        paused,
        pending
      }
    }
  }

  // 对账请求：peer 报「我手上有哪个 epoch 的第几号账」，房主回一条 settle。
  if (raw.type === 'futures-sync') {
    const at = normalizeDigestAt(raw.at)
    if (at === null) return fail('at')
    if (!isFuturesEpoch(raw.epoch)) return fail('epoch')
    if (!isFuturesSeq(raw.lastSeq)) return fail('last-seq')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        at,
        epoch: raw.epoch,
        lastSeq: raw.lastSeq
      }
    }
  }

  // ack / recall 只关联一次串门：除了 id 什么都不接受。
  if (VISIT_TYPES.has(raw.type)) {
    if (!isVisitId(raw.visitId)) return fail('visit-id')
    const raid = raw.type === 'visit-ack' ? normalizeRaidResult(raw.raid) : null
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        visitId: raw.visitId.toLowerCase(),
        ...(raid === null ? {} : { raid })
      }
    }
  }

  // 票 59：作物目录的两条报文。老版本不认识这两个类型，会在最上面按「未知类型」丢掉。
  if (raw.type === 'crop-catalog-request') {
    const hash = typeof raw.hash === 'string' ? raw.hash.trim().toLowerCase() : ''
    if (!HEX16_RE.test(hash)) return fail('hash')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        hash
      }
    }
  }

  if (raw.type === 'crop-catalog') {
    const catalogHash = typeof raw.catalogHash === 'string' ? raw.catalogHash.trim().toLowerCase() : ''
    if (!HEX16_RE.test(catalogHash)) return fail('catalog-hash')
    if (!Number.isInteger(raw.chunk) || raw.chunk < 0 || raw.chunk >= MAX_CATALOG_CHUNKS) return fail('catalog-chunk')
    if (!Number.isInteger(raw.total) || raw.total < 1 || raw.total > MAX_CATALOG_CHUNKS) return fail('catalog-total')
    if (raw.chunk >= raw.total) return fail('catalog-chunk')
    const entries = normalizeCatalogEntries(raw.entries)
    if (entries === null) return fail('catalog-entries')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        catalogHash,
        chunk: raw.chunk,
        total: raw.total,
        entries
      }
    }
  }

  const nickname = normalizeNickname(raw.nickname)
  if (nickname === null) return fail('nickname')
  if (!isPort(raw.port)) return fail('port')

  // 只读取上面这些字段，再用新对象重建。未知字段一律丢弃。
  return {
    ok: true,
    packet: {
      v: PROTOCOL_VERSION,
      type: raw.type,
      deviceId: raw.deviceId.toLowerCase(),
      nickname,
      port: raw.port,
      ...skinExtras({ skinPort: raw.skinPort, skinId: raw.skinId }),
      ...capsExtras(raw.caps),
      ...(normalizeCatalogAnnounce(raw.crops) === null ? {} : { crops: normalizeCatalogAnnounce(raw.crops) })
    }
  }
}

/**
 * 每来源滑动窗口限速。超限丢弃，不排队。
 * maxSources 同时限制内存：邻居表可以被投毒，但不会被无限投毒。
 */
export function createRateLimiter ({
  windowMs = 10000,
  max = 20,
  maxSources = 128,
  now = () => Date.now()
} = {}) {
  const span = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 10000
  const limit = Number.isInteger(max) && max > 0 ? max : 1
  const sourceCap = Number.isInteger(maxSources) && maxSources > 0 ? maxSources : 1
  const buckets = new Map()

  return {
    allow (key, at = now()) {
      if (typeof key !== 'string' || key === '') return false
      const stamp = Number.isFinite(at) ? at : now()
      let times = buckets.get(key)
      if (times === undefined) {
        if (buckets.size >= sourceCap) {
          let oldestKey
          let oldestAt = Infinity
          for (const [candidate, list] of buckets) {
            const last = list.length > 0 ? list[list.length - 1] : -Infinity
            if (last < oldestAt) {
              oldestAt = last
              oldestKey = candidate
            }
          }
          if (oldestKey !== undefined) buckets.delete(oldestKey)
        }
        times = []
        buckets.set(key, times)
      }
      const cutoff = stamp - span
      while (times.length > 0 && times[0] <= cutoff) times.shift()
      if (times.length >= limit) return false
      times.push(stamp)
      return true
    },
    size () {
      return buckets.size
    },
    clear () {
      buckets.clear()
    }
  }
}
