/**
 * 邻居协议的**纯**内核：编码、解析、字段白名单、长度与速率限制。
 *
 * 这里的每一个字节都来自局域网，必须当成敌意输入：
 * - 单包上限 4 KiB，超过直接丢；
 * - 只认本文件列出的字段，多余的字段在重建对象时被丢弃；
 * - 版本、类型、deviceId、port 逐项校验，昵称清洗 + 截断，动画名只允许安全文件名；
 * - 每种报文只写自己那几个字段：beacon/beacon-ack 是身份，heartbeat 是动作意图；
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
/** 放行后每 2 秒一次心跳；动作变化时 service 会额外立刻补发（见 src/service.js）。 */
export const HEARTBEAT_INTERVAL_MS = 2000
/** 30 秒没有心跳，访客从客厅消失；与邻居灯共用同一条 tick 时间线。 */
export const GUEST_TTL_MS = 30000
export const PACKET_TYPES = Object.freeze(['beacon', 'beacon-ack', 'heartbeat'])

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

/** 合法的动画名去掉首尾空白；其余一律降级成 null（客户端会退到待机/色块）。 */
export function normalizeAnimation (value) {
  return isSafeAnimationName(value) ? value.trim() : null
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
 *   beacon / beacon-ack → { v, type, deviceId, nickname, port }
 *   heartbeat          → { v, type, deviceId, anim }
 * 绝不带上坐标：这个函数没有接收坐标的参数，也不需要（ADR-0003）。
 *
 * deviceId / port 是本地代码传进来的，非法即抛（这是程序错误，不是网络输入）。
 * 本机动画名非法时不抛：降级成 null，让对端自己放待机。
 */
export function encodePacket ({ type, deviceId, nickname, port, anim } = {}) {
  if (!TYPE_SET.has(type)) throw new Error('protocol: invalid packet type')
  if (!isDeviceId(deviceId)) throw new Error('protocol: invalid deviceId')

  const base = {
    v: PROTOCOL_VERSION,
    type,
    deviceId: deviceId.toLowerCase()
  }
  let packet
  if (type === 'heartbeat') {
    packet = { ...base, anim: normalizeAnimation(anim) }
  } else {
    if (!isPort(port)) throw new Error('protocol: invalid port')
    const safeNickname = normalizeNickname(nickname)
    if (safeNickname === null) throw new Error('protocol: invalid nickname')
    packet = { ...base, nickname: safeNickname, port }
  }

  const data = Buffer.from(JSON.stringify(packet), 'utf8')
  if (data.length > MAX_PACKET_BYTES) throw new Error('protocol: packet too large')
  return data
}

/** ticket 04 的窄入口：调用方无法往心跳里塞昵称、端口或坐标。 */
export function encodeHeartbeat ({ deviceId, anim } = {}) {
  return encodePacket({ type: 'heartbeat', deviceId, anim })
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

  // 心跳只承载动作意图：anim 必须显式存在，是 null 或安全动画名。
  // nickname / port / 坐标等字段即使出现也不会被读取（下面重建对象）。
  if (raw.type === 'heartbeat') {
    if (raw.anim !== null && !isSafeAnimationName(raw.anim)) return fail('anim')
    return {
      ok: true,
      packet: {
        v: PROTOCOL_VERSION,
        type: raw.type,
        deviceId: raw.deviceId.toLowerCase(),
        anim: raw.anim === null ? null : raw.anim.trim()
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
