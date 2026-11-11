import {
  MAX_CONTRACT_HOURS,
  MAX_CONTRACT_WAGE,
  MIN_CONTRACT_HOURS,
  MIN_CONTRACT_WAGE
} from './contracts-rules.js'
import { CROP_IDS, MAX_GUARD, MAX_PLOTS, isCropId } from './farm-rules.js'
import { isPrivateAddress } from './skin-fetch.js'
import { PLOT_ID_RE, isDeviceId, isVisitId, normalizeNickname } from './protocol.js'

/**
 * 访客宿主拉主人的农场快照（ticket 43）。
 *
 * 和礼物/素材拉取是同一套安全口径，但形状完全不同：
 *   - 只拉一份 ≤64 KiB 的小 JSON，不落盘；
 *   - 2 秒总超时（AbortController）；
 *   - 只连私网/回环地址，绝不解析域名；
 *   - 404 = 这次串门已经结束（`gone`），窗口切到 ended，不再重试；
 *   - 同一个 `address:port` 失败后冷却 60 秒，避免每 3 秒打一台坏邻居。
 *
 * 返回的 view 是**敌意输入**：`normalizeVisitView` 只重建白名单字段，
 * 绝不把远端的 stolenBy/helpedBy 原数组（别人的 deviceId）带进窗口。
 */

export const FARM_FETCH_TIMEOUT_MS = 2000
export const MAX_FARM_VIEW_BYTES = 64 * 1024
export const FARM_FETCH_COOLDOWN_MS = 60 * 1000
/** 快照响应体在窗口里的硬上限：50 块地 + 行情摘要仍远小于 64 KiB。 */
const STAGES = new Set(['empty', 'growing', 'mature'])
const MAX_LIMIT = 99

export function createFarmFetcher (options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : FARM_FETCH_TIMEOUT_MS
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : MAX_FARM_VIEW_BYTES
  const cooldownMs = Number.isFinite(options.cooldownMs) && options.cooldownMs >= 0
    ? options.cooldownMs
    : FARM_FETCH_COOLDOWN_MS
  const failures = new Map()

  /**
   * 票 52：拉一份公开只读视图。和 `get` 同一套口径（2s / 64 KiB / 私网 / 冷却），
   * 只是路径换成 `/open/<viewerDeviceId>`，而且**不需要串门**。
   */
  async function open ({ address, port, deviceId } = {}) {
    if (!isPrivateAddress(address)) return { ok: false, error: 'refused' }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: 'no-port' }
    if (!isDeviceId(deviceId)) return { ok: false, error: 'refused' }
    // 看田是**用户点出来的**，不走 60 秒冷却：失败一次他应该能马上再点一次。
    // （后台轮询的 `get` 仍然按 address:port 冷却，那条是防止每 3 秒去打一台坏邻居。）
    const key = address.trim().toLowerCase() + ':' + port

    const url = 'http://' + address + ':' + port + '/dsh-zoo-farm/open/' + encodeURIComponent(deviceId.toLowerCase())
    const result = await grab(url, key)
    if (result.ok !== true) return result
    const view = normalizeOpenView(result.raw)
    if (view === null) return { ok: false, error: 'bad-shape' }
    return { ok: true, view }
  }

  async function get ({ address, port, visitId } = {}) {
    if (!isPrivateAddress(address)) return { ok: false, error: 'refused' }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: 'no-port' }
    if (!isVisitId(visitId)) return { ok: false, error: 'refused' }
    const key = address.trim().toLowerCase() + ':' + port
    const failedAt = failures.get(key)
    if (failedAt !== undefined && now() - failedAt < cooldownMs) {
      return { ok: false, error: 'refused' }
    }

    const url = 'http://' + address + ':' + port + '/dsh-zoo-farm/' + encodeURIComponent(visitId.toLowerCase())
    const result = await grab(url, key)
    if (result.ok !== true) return result
    const view = normalizeVisitView(result.raw)
    if (view === null) return fail(key, 'bad-shape')
    failures.delete(key)
    return { ok: true, view }
  }

  /** 真正的 HTTP 往返：超时、限量、JSON 解析都在这里，`get` 与 `open` 共用。 */
  async function grab (url, key) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer = null
    try {
      if (typeof fetchImpl !== 'function') return fail(key, 'refused')
      const pending = fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        ...(controller === null ? {} : { signal: controller.signal })
      })
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          try {
            controller?.abort()
          } catch {
            // 已经结束了
          }
          resolve(null)
        }, timeoutMs)
      })
      const response = await Promise.race([pending, timeout])
      if (response === null) return fail(key, 'timeout')
      if (response === undefined || typeof response !== 'object') return fail(key, 'refused')

      if (response.status === 404) {
        // 串门结束：冷却没有意义（下一次串门换 visitId），但也不再打这台。
        failures.set(key, now())
        return { ok: false, error: 'gone' }
      }
      if (!response.ok) return fail(key, 'refused')

      const declared = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) return fail(key, 'too-large')

      const body = await readLimited(response, maxBytes)
      if (body === null) return fail(key, 'too-large')
      if (body === false) return fail(key, 'refused')

      let raw
      try {
        raw = JSON.parse(body)
      } catch {
        return fail(key, 'bad-json')
      }
      failures.delete(key)
      return { ok: true, raw }
    } catch (error) {
      if (error?.name === 'AbortError') return fail(key, 'timeout')
      return fail(key, 'refused')
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  function fail (key, error) {
    failures.set(key, now())
    return { ok: false, error }
  }

  function clear () {
    failures.clear()
  }

  return { get, open, clear }
}

async function readLimited (response, maxBytes) {
  if (response.body !== null && response.body !== undefined && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
      size += bytes.length
      if (size > maxBytes) return null
      chunks.push(bytes)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  if (typeof response.text === 'function') {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) return null
    return text
  }
  if (typeof response.arrayBuffer === 'function') {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) return null
    return buffer.toString('utf8')
  }
  return false
}

/**
 * 把远端 JSON 收成窗口能画的访客视图（白名单重建）。
 *
 * 硬约束：只输出 `stolenByMe` / `helpedByMe` 两个布尔，**绝不**回传 stolenBy/helpedBy
 * 原数组（会泄露别的访客 deviceId）；没有任何 path/dir 字段。坏地块只丢那一块，
 * 不整包失败；根形状/visitId 不对才返回 null。
 */
export function normalizeVisitView (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!isVisitId(raw.visitId)) return null

  const host = raw.host !== null && typeof raw.host === 'object' && !Array.isArray(raw.host)
    ? { nickname: normalizeNickname(raw.host.nickname) ?? '邻居' }
    : { nickname: '邻居' }
  const guard = clampNumber(raw.guard, 0, MAX_GUARD, 0)
  const guardParts = raw.guardParts !== null && typeof raw.guardParts === 'object'
    ? { ownerHome: raw.guardParts.ownerHome === true, worker: raw.guardParts.worker === true }
    : { ownerHome: false, worker: false }

  const plots = []
  const sourcePlots = Array.isArray(raw.plots) ? raw.plots : []
  const seen = new Set()
  for (const candidate of sourcePlots) {
    if (plots.length >= MAX_PLOTS) break
    const plot = normalizeVisitPlot(candidate)
    if (plot === null || seen.has(plot.id)) continue
    seen.add(plot.id)
    plots.push(plot)
  }
  // 只画主人发来的已解锁地块（最多 50 块）；不补 p1–p4。
  plots.sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)))

  const limits = normalizeLimits(raw.limits)
  const hire = normalizeHire(raw.hire)
  const market = normalizeVisitMarket(raw.market)
  const at = Number(raw.at)

  return {
    v: 1,
    visitId: raw.visitId.toLowerCase(),
    host,
    guard,
    guardParts,
    plots,
    limits,
    hire,
    market,
    at: Number.isFinite(at) && at > 0 ? Math.floor(at) : 0
  }
}

/**
 * 公开只读视图（票 52）的白名单重建。地块复用访客视图那套（坏地块只丢自己）；
 * `quotas`/`caps` 只留数字与已知能力名——远端塞进来的多余字段一律不进结果。
 */
export function normalizeOpenView (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!isDeviceId(raw.deviceId)) return null

  const host = raw.host !== null && typeof raw.host === 'object' && !Array.isArray(raw.host)
    ? { nickname: normalizeNickname(raw.host.nickname) ?? '邻居' }
    : { nickname: '邻居' }

  const plots = []
  const seen = new Set()
  for (const candidate of Array.isArray(raw.plots) ? raw.plots : []) {
    if (plots.length >= MAX_PLOTS) break
    const plot = normalizeVisitPlot(candidate)
    if (plot === null || seen.has(plot.id)) continue
    seen.add(plot.id)
    plots.push(plot)
  }
  plots.sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)))

  const quotas = raw.quotas !== null && typeof raw.quotas === 'object' && !Array.isArray(raw.quotas)
    ? {
        perTrip: limitInt(raw.quotas.perTrip),
        perTripLeft: limitInt(raw.quotas.perTripLeft)
      }
    : { perTrip: 0, perTripLeft: 0 }

  const at = Number(raw.at)
  return {
    v: 1,
    deviceId: raw.deviceId.toLowerCase(),
    host,
    guard: clampNumber(raw.guard, 0, MAX_GUARD, 0),
    guardParts: raw.guardParts !== null && typeof raw.guardParts === 'object'
      ? { ownerHome: raw.guardParts.ownerHome === true, worker: raw.guardParts.worker === true }
      : { ownerHome: false, worker: false },
    plots,
    quotas,
    caps: Array.isArray(raw.caps)
      ? raw.caps.filter((entry) => entry === 'raid' || entry === 'look')
      : [],
    at: Number.isFinite(at) && at > 0 ? Math.floor(at) : 0
  }
}

function normalizeVisitPlot (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
  if (!PLOT_ID_RE.test(id)) return null
  const crop = raw.crop === null || raw.crop === undefined ? null : (isCropId(raw.crop) ? raw.crop : null)
  if (raw.crop !== null && raw.crop !== undefined && crop === null) return null
  const stage = STAGES.has(raw.stage) ? raw.stage : (crop === null ? 'empty' : 'growing')
  const mature = crop !== null && (raw.mature === true || stage === 'mature')
  if (crop === null && stage !== 'empty') return null
  const remaining = Number(raw.remainingMs)
  return {
    id,
    crop,
    stage: crop === null ? 'empty' : (mature ? 'mature' : 'growing'),
    mature,
    remainingMs: mature || !Number.isFinite(remaining) ? 0 : Math.max(0, Math.floor(remaining)),
    stolenByMe: raw.stolenByMe === true,
    helpedByMe: raw.helpedByMe === true
  }
}

function normalizeLimits (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const kind of ['steal', 'help']) {
    const source = raw[kind]
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      out[kind] = null
      continue
    }
    out[kind] = {
      perVisit: limitInt(source.perVisit),
      usedInVisit: limitInt(source.usedInVisit),
      perFarm: limitInt(source.perFarm),
      usedOnFarm: limitInt(source.usedOnFarm),
      perDay: limitInt(source.perDay),
      usedToday: limitInt(source.usedToday)
    }
  }
  return out
}

function limitInt (value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.min(MAX_LIMIT, Math.max(0, Math.floor(num)))
}

function normalizeHire (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const wage = Number(raw.wagePerHour)
  const minHours = Number(raw.minHours)
  const maxHours = Number(raw.maxHours)
  return {
    enabled: raw.enabled === true,
    wagePerHour: Number.isFinite(wage)
      ? Math.min(MAX_CONTRACT_WAGE, Math.max(MIN_CONTRACT_WAGE, Math.floor(wage)))
      : 10,
    minHours: Number.isFinite(minHours)
      ? Math.min(MAX_CONTRACT_HOURS, Math.max(MIN_CONTRACT_HOURS, Math.floor(minHours)))
      : MIN_CONTRACT_HOURS,
    maxHours: Number.isFinite(maxHours)
      ? Math.min(MAX_CONTRACT_HOURS, Math.max(MIN_CONTRACT_HOURS, Math.floor(maxHours)))
      : MAX_CONTRACT_HOURS
  }
}

/**
 * 行情摘要（41/42）：只给窗口画价目与局域网指数，不转发历史。
 * 坏条目只丢自己。
 */
function normalizeVisitMarket (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const prices = {}
  const index = {}
  const rawPrices = raw.prices !== null && typeof raw.prices === 'object' ? raw.prices : {}
  const rawIndex = raw.index !== null && typeof raw.index === 'object' ? raw.index : {}
  for (const cropId of CROP_IDS) {
    const price = rawPrices[cropId]
    if (price !== null && typeof price === 'object' && !Array.isArray(price)) {
      const entry = {
        base: nonNegative(price.base),
        price: nonNegative(price.price),
        volume24h: limitInt(price.volume24h),
        ...(Number.isFinite(Number(price.bid)) ? { bid: nonNegative(price.bid) } : {})
      }
      if (entry.base !== null && entry.price !== null) prices[cropId] = entry
    }
    const sample = rawIndex[cropId]
    if (sample !== null && typeof sample === 'object' && !Array.isArray(sample)) {
      const priceValue = nonNegative(sample.price)
      const at = Number(sample.at)
      if (priceValue !== null) {
        index[cropId] = {
          price: priceValue,
          at: Number.isFinite(at) && at > 0 ? Math.floor(at) : 0,
          samples: limitInt(sample.samples),
          stale: sample.stale === true
        }
      }
    }
  }
  return { prices, index }
}

function nonNegative (value) {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? num : null
}

function clampNumber (value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}
