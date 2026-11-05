import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { MAX_GIFT_BYTES, isVisitId } from './protocol.js'
import { GIFT_ROUTES } from './lan-routes.js'
import { isPrivateAddress } from './skin-fetch.js'

/**
 * 文件礼物的拉取客户端（ticket 25）。
 *
 * 为什么**不**复用 `src/skin-fetch.js` 的 `fetchBytes`：那一份是「一个 AbortController
 * 管总时长 + 响应体全量进内存」，最多只服务 8 MB 的 WebM。礼物要的是：
 *   - 连接 5s / 总计 20s 两条超时；
 *   - 边下边算 sha256、直接写 `<目标>.part`，成功后 rename——16 MiB 不经过内存；
 *   - 失败只报固定词表里的原因：`timeout / no-port / checksum / too-large / refused / write`；
 *   - 同一来源失败后冷却 60 秒。
 * 唯一复用 `skin-fetch.js` 的只有 `isPrivateAddress`（只连私网/回环，绝不解析域名）。
 *
 * 路由先新后旧（`src/lan-routes.js`）：新版本用 `/dsh-zoo-gift`，改名前的邻居（≤0.5.7）只认
 * `/local-pet-gift`；新路径 404 时再试旧路径，其余状态码不重试（410/413 是真实结论）。
 *
 * 安全底线：地址只来自发现层（UDP 报文的来源地址），端口只来自对方广告的 `skinPort`；
 * 目标路径由宿主从礼物目录推出来，giftId 只参与拼 URL 且必须是 UUID。
 */

export const GIFT_CONNECT_TIMEOUT_MS = 5000
export const GIFT_TOTAL_TIMEOUT_MS = 20000
export const GIFT_FAILURE_COOLDOWN_MS = 60 * 1000
const WRITE_ERROR_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'ENOENT', 'EISDIR', 'EEXIST', 'EMFILE', 'ENFILE', 'EDQUOT', 'ENOTDIR'])

export function createGiftFetcher (options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const connectTimeoutMs = positiveMs(options.connectTimeoutMs, GIFT_CONNECT_TIMEOUT_MS)
  const totalTimeoutMs = positiveMs(options.totalTimeoutMs, GIFT_TOTAL_TIMEOUT_MS)
  const cooldownMs = Number.isFinite(options.cooldownMs) && options.cooldownMs >= 0
    ? options.cooldownMs
    : GIFT_FAILURE_COOLDOWN_MS
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : MAX_GIFT_BYTES
  const log = options.log ?? {}
  /** `address:port` → { at, reason }：失败来源冷却，避免每个访客都去撞一台坏掉的邻居。 */
  const failures = new Map()

  function failureOf (key) {
    const failure = failures.get(key)
    if (failure === undefined) return null
    if (now() - failure.at >= cooldownMs) {
      failures.delete(key)
      return null
    }
    return failure
  }

  function fail (error, key = null) {
    if (key !== null) failures.set(key, { at: now(), reason: error })
    return { ok: false, error }
  }

  /** 一次 GET；404 时先把响应体关掉，交给调用方决定要不要回落旧路由。 */
  async function request (url, signal) {
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      signal,
      headers: { accept: 'application/octet-stream' }
    })
    if (response === null || typeof response !== 'object' || response.ok === true) return response
    if (response.status === 404) {
      try {
        await response.body?.cancel?.()
      } catch {
        // 已经关了
      }
    }
    return response
  }

  /**
   * 把礼物拉到 `targetPath`。成功时 `targetPath` 已经 rename 到位；
   * 任何失败都不会留下半个文件（`.part` 会被删掉）。
   */
  async function fetchTo ({
    address,
    port,
    giftId,
    targetPath,
    size = null,
    sha256 = null
  } = {}) {
    if (!isPrivateAddress(address)) return fail('refused')
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return fail('no-port')
    if (!isVisitId(giftId)) return fail('refused')
    if (typeof targetPath !== 'string' || targetPath === '') return fail('write')
    const host = address.includes(':') ? '[' + address + ']' : address
    const base = 'http://' + host + ':' + port
    const id = encodeURIComponent(giftId.toLowerCase())
    const urls = GIFT_ROUTES.map((route) => base + route + '/' + id)
    const key = address + ':' + port
    const cooling = failureOf(key)
    if (cooling !== null) return { ok: false, error: cooling.reason, cooldown: true }

    const controller = new AbortController()
    let timedOut = false
    let connectTimer = null
    let totalTimer = null
    let response = null
    const partPath = targetPath + '.part'
    let wrote = false
    try {
      totalTimer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, totalTimeoutMs)
      totalTimer.unref?.()
      connectTimer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, connectTimeoutMs)
      connectTimer.unref?.()

      response = await request(urls[0], controller.signal)
      if (connectTimer !== null) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
      // 旧版邻居不认识新路径：404 才回落，410/413 等都是对方给出的真实结论。
      if (response !== null && response.ok !== true && response.status === 404 && urls.length > 1) {
        response = await request(urls[1], controller.signal)
      }
      if (response === null || typeof response !== 'object') return fail('refused', key)
      if (response.ok !== true) {
        return fail(response.status === 413 ? 'too-large' : 'refused', key)
      }
      if (response.body === null || typeof response.body !== 'object') return fail('refused', key)

      const rawLength = response.headers?.get?.('content-length')
      const declared = rawLength === null || rawLength === undefined ? Number.NaN : Number(rawLength)
      if (Number.isFinite(declared)) {
        // 先判上限再判大小：对方把一个超限的东西塞过来时，说“太大”比“变了”更有用。
        if (declared > maxBytes) return fail('too-large', key)
        if (Number.isInteger(size) && declared !== size) return fail('checksum', key)
      }

      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
      wrote = true
      const hash = createHash('sha256')
      let bytes = 0
      const meter = new Transform({
        transform (chunk, encoding, callback) {
          bytes += chunk.length
          if (bytes > maxBytes) {
            const error = new Error('gift too large')
            error.code = 'GIFT_TOO_LARGE'
            callback(error)
            return
          }
          hash.update(chunk)
          callback(null, chunk)
        }
      })
      // 流式落盘：响应体 → 计数/哈希 → `.part`，内存里最多一个 chunk。
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partPath, { mode: 0o600 }))
      const actual = 'sha256:' + hash.digest('hex')
      if (Number.isInteger(size) && bytes !== size) return fail('checksum', key)
      if (typeof sha256 === 'string' && actual !== sha256.toLowerCase()) return fail('checksum', key)
      await rename(partPath, targetPath)
      failures.delete(key)
      return { ok: true, size: bytes, sha256: actual }
    } catch (error) {
      if (timedOut || controller.signal.aborted) return fail('timeout', key)
      if (error?.code === 'GIFT_TOO_LARGE') return fail('too-large', key)
      if (WRITE_ERROR_CODES.has(error?.code)) {
        log.warn?.('礼物写不进磁盘（' + error.code + '）')
        return fail('write', key)
      }
      return fail('timeout', key)
    } finally {
      if (connectTimer !== null) clearTimeout(connectTimer)
      if (totalTimer !== null) clearTimeout(totalTimer)
      // 失败/中断时把半截文件删掉；成功时 `.part` 已经被 rename 走了。
      if (wrote) await rm(partPath, { force: true }).catch(() => {})
      try {
        if (response !== null && typeof response.body?.cancel === 'function') await response.body.cancel()
      } catch {
        // 已经读完/已经关了
      }
    }
  }

  return { fetchTo }
}

function positiveMs (value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}
