/**
 * 邻居协议的**纯**内核：编码、解析、字段白名单、长度与速率限制。
 *
 * 这里的每一个字节都来自局域网，必须当成敌意输入：
 * - 单包上限 4 KiB，超过直接丢；
 * - 只认本文件列出的字段，多余的字段在重建对象时被丢弃；
 * - 版本、类型、deviceId、port 逐项校验，昵称清洗 + 截断；
 * - 任何校验失败都只返回 `{ ok: false }`，不抛异常、不写盘、不读本机状态。
 *
 * 协议本身不传素材、不传坐标、不传项目或会话信息（ADR-0003）。
 */
export const PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 45871
export const MAX_PACKET_BYTES = 4 * 1024
export const MAX_NICKNAME = 32
export const MAX_LABEL = 64
export const MAX_ANIMATION = 64
export const MAX_NEIGHBORS = 64
export const BEACON_INTERVAL_MS = 5000
export const NEIGHBOR_TTL_MS = 30000
export const PACKET_TYPES = Object.freeze(['beacon', 'beacon-ack'])

const TYPE_SET = new Set(PACKET_TYPES)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g
const BIDI_RE = /[\u202a-\u202e\u2066-\u2069]/g

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

/** 环境变量覆盖监听端口；非法值静默回落到默认端口，避免坏配置把插件拖死。 */
export function resolvePort (env = process.env) {
  const raw = env?.LOCAL_PET_PORT
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_PORT
  const port = Number(String(raw).trim())
  return isPort(port) ? port : DEFAULT_PORT
}

/**
 * 构造一个只含白名单字段的报文。字段顺序固定，便于测试和抓包对照。
 * deviceId / port / type 是本地代码传进来的，非法即抛（这是程序错误，不是网络输入）。
 */
export function encodePacket ({ type, deviceId, nickname, port }) {
  if (!TYPE_SET.has(type)) throw new Error('protocol: invalid packet type')
  if (!isDeviceId(deviceId)) throw new Error('protocol: invalid deviceId')
  if (!isPort(port)) throw new Error('protocol: invalid port')
  const safeNickname = normalizeNickname(nickname)
  if (safeNickname === null) throw new Error('protocol: invalid nickname')
  const packet = {
    v: PROTOCOL_VERSION,
    type,
    deviceId: deviceId.toLowerCase(),
    nickname: safeNickname,
    port
  }
  const data = Buffer.from(JSON.stringify(packet), 'utf8')
  if (data.length > MAX_PACKET_BYTES) throw new Error('protocol: packet too large')
  return data
}

function fail (reason) {
  return { ok: false, reason }
}

/**
 * 把 UDP 载荷解析成**新**的、只含白名单字段的对象。
 * 绝不把原始 JSON 对象交给调用方：未知字段到这里就结束了。
 */
export function parsePacket (input) {
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
      port: raw.port
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
