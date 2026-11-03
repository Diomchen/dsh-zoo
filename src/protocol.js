/**
 * 邻居协议的**纯**内核：编码、解析、字段白名单、长度与速率限制。
 *
 * 这里的每一个字节都来自局域网，必须当成敌意输入：
 * - 单包上限 4 KiB，超过直接丢；
 * - 只认本文件列出的字段，多余的字段在重建对象时被丢弃；
 * - 版本、类型、deviceId、visitId、port 逐项校验，昵称清洗 + 截断，动画名只允许安全文件名；
 * - 每种报文只写自己那几个字段：beacon/beacon-ack 是身份，heartbeat 是动作意图，
 *   visit-request/ack/deny/recall 是一次串门的生命周期；
 * - 任何校验失败都只返回 `{ ok: false }`，不抛异常、不写盘、不读本机状态。
 *
 * 协议本身不传素材本体、不传坐标、不传项目或会话信息（ADR-0003）。素材只传引用：
 * `skinPort` / `skinId` 告诉对方去哪儿取，视频本身走 HTTP（ticket 15 起）。
 */
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
 */
export const PACKET_TYPES = Object.freeze([
  'beacon',
  'beacon-ack',
  'heartbeat',
  'visit-request',
  'visit-ack',
  'visit-deny',
  'visit-recall',
  'visit-recall-ack'
])
const VISIT_TYPES = new Set([
  'visit-request',
  'visit-ack',
  'visit-deny',
  'visit-recall',
  'visit-recall-ack'
])
/**
 * visit-deny 的理由是固定枚举，不是自由文本：
 * - not-admitted：本机没放行这位邻居（默认，也兼容不带 reason 的旧报文）
 * - visits-off：本机客厅的“允许串门”开关被关掉了
 * 发起方据此给出不同的人话提示，但不能借这个字段传任意内容。
 */
export const VISIT_DENY_REASONS = Object.freeze(['not-admitted', 'visits-off'])
const DENY_REASON_SET = new Set(VISIT_DENY_REASONS)

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
 * 串门捎的礼物（ADR-0011）。v1 只有字条这一种；文件礼物的 `kind:'file'` 由 ticket 25 加进来。
 *
 * **校验不过返回 null，由调用方把整个 `gift` 字段丢掉，串门照常。**
 * 这与 `anim` 非法就整包丢是相反的策略：动画是这次串门的“外观”，坏了可以退回待机；
 * 便条只是搭车的一件东西，为它把一次串门搞砸，代价和收益完全不对等。
 */
export function normalizeGift (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (!isVisitId(value.id)) return null
  // kind 只认本版本真的能收下的那一种；未来加 'file' 时，旧端的表现就是“这次没有礼物”。
  if (value.kind !== 'text') return null
  const text = sanitizeNote(value.text)
  if (text === null) return null
  return { id: value.id.toLowerCase(), kind: 'text', text }
}

/** 环境变量覆盖监听端口；非法值静默回落到默认端口，避免坏配置把插件拖死。 */
export function resolvePort (env = process.env) {
  const raw = env?.LOCAL_PET_PORT
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
  action,
  semantic,
  say,
  skinPort,
  skinId,
  gift,
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
