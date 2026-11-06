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
export const PLOT_ID_RE = /^p[1-4]$/
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
  'market-digest',
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
  'work-settle-ack'
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
 * 串门捎的礼物（ADR-0011）：`kind:'text'` 是内联字条，`kind:'file'` 只有元数据
 * （name/size/sha256），本体由接收方在访客抵达时向发起方拉取（ticket 25）。
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
  // 认识的 kind 就这两种；别的值整条 gift 丢掉（旧端读到新 kind 也是这条路径）。
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
  action,
  semantic,
  say,
  skinPort,
  skinId,
  gift,
  at,
  prices,
  hire,
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
    packet = { ...base, anim: normalizeAnimation(anim), ...pet, ...skin }
  } else if (type === 'visit-request') {
    if (!isVisitId(visitId)) throw new Error('protocol: invalid visitId')
    const safeNickname = normalizeNickname(nickname)
    if (safeNickname === null) throw new Error('protocol: invalid nickname')
    packet = {
      ...base,
      visitId: visitId.toLowerCase(),
      nickname: safeNickname,
      anim: normalizeAnimation(anim),
      ...pet,
      ...skin
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
  } else if (type === 'market-digest') {
    // 自己的分支，绝不并进 VISIT_TYPES：那条只写四个字段，prices/hire 会在这里消失。
    const stamp = at === undefined ? normalizeDigestAt(now) : normalizeDigestAt(at)
    if (stamp === null) throw new Error('protocol: invalid digest time')
    const safePrices = normalizeDigestPrices(prices)
    if (safePrices === null) throw new Error('protocol: invalid digest prices')
    const safeHire = normalizeDigestHire(hire)
    if (safeHire === null) throw new Error('protocol: invalid digest hire')
    packet = { ...base, at: stamp, prices: safePrices, hire: safeHire }
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
  } else if (VISIT_TYPES.has(type)) {
    if (!isVisitId(visitId)) throw new Error('protocol: invalid visitId')
    packet = { ...base, visitId: visitId.toLowerCase() }
  } else {
    if (!isPort(port)) throw new Error('protocol: invalid port')
    const safeNickname = normalizeNickname(nickname)
    if (safeNickname === null) throw new Error('protocol: invalid nickname')
    packet = { ...base, nickname: safeNickname, port, ...skin }
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

export function encodeVisitAck ({ deviceId, visitId } = {}) {
  return encodePacket({ type: 'visit-ack', deviceId, visitId })
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
 * 行情 gossip（ticket 42）：本机每种作物的 price + 自己的雇工挂牌。
 * `at` 缺省用本地时钟；价格/挂牌由调用方从 store 取，坏条目在这里被丢弃。
 */
export function encodeMarketDigest ({ deviceId, at, prices, hire, now } = {}) {
  return encodePacket({ type: 'market-digest', deviceId, at, prices, hire, now })
}

/**
 * 农场动作（ticket 43）：访客 → 主人。
 * 只带这次动作的全部输入；没有昵称、端口、坐标、路径或自由文本。
 */
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
        ...skinExtras({ skinPort: raw.skinPort, skinId: raw.skinId })
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

  // ack / recall 只关联一次串门：除了 id 什么都不接受。
  if (VISIT_TYPES.has(raw.type)) {
    if (!isVisitId(raw.visitId)) return fail('visit-id')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        visitId: raw.visitId.toLowerCase()
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
      ...skinExtras({ skinPort: raw.skinPort, skinId: raw.skinId })
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
