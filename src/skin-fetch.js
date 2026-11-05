import { createHash } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { SKIN_ROUTES } from './lan-routes.js'

/**
 * 远端素材拉取（ticket 17）。
 *
 * 访客的本体在对方机器上，素材也在那儿。这里按对方广告的 `skinPort` / `skinId`
 * 拉 manifest 和当前动作，校验后落进本机磁盘缓存；helper 只读缓存，永远不联网。
 *
 * 路由先新后旧（`src/lan-routes.js`）：新版本用 `/dsh-zoo-skin`，改名前的邻居（≤0.5.7）只认
 * `/local-pet-skin`。manifest 从哪条路由取到，后面的素材也跟着走同一条。
 *
 * 安全口径（跨机 HTTP 是新的攻击面）：
 * - 只连私网/回环地址，绝不解析域名；
 * - manifest ≤256KB、单个素材 ≤8MB、2 秒超时；
 * - 只接受 WebM（EBML 魔数），且必须与 manifest 里的 sha256 对上；
 * - 没 hash 的动作不拉；校验失败不落盘；
 * - 同一个来源失败后冷却 60 秒，避免每 500ms 巡检都去打一台已经坏掉的邻居。
 */

export const SKIN_CACHE_DIR = 'skin-cache'
export const MAX_SKIN_BYTES = 8 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 256 * 1024
export const CACHE_MAX_BYTES = 200 * 1024 * 1024
export const MANIFEST_TTL_MS = 10 * 60 * 1000
export const FETCH_TIMEOUT_MS = 2000
export const FAILURE_COOLDOWN_MS = 60 * 1000

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const SKIN_ID_RE = /^[A-Za-z0-9_-]{1,32}$/
const SEGMENT_RE = /^[^/\\\u0000-\u001f\u007f]{1,64}$/

/** 只放行回环、RFC1918 私网、链路本地与 IPv6 ULA；其余一律不连。 */
export function isPrivateAddress (value) {
  if (typeof value !== 'string') return false
  const address = value.trim().toLowerCase()
  if (address === '::1') return true
  if (address.startsWith('fc') || address.startsWith('fd')) return true
  if (/^fe[89ab]/.test(address)) return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (match === null) return false
  const a = Number(match[1])
  const b = Number(match[2])
  const c = Number(match[3])
  const d = Number(match[4])
  if (a > 255 || b > 255 || c > 255 || d > 255) return false
  if (a === 127 || a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true
  return false
}

export function createSkinFetcher (options = {}) {
  const dir = typeof options.dir === 'string' && options.dir !== '' ? options.dir : null
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const now = typeof options.now === 'function' ? options.now : Date.now
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : FETCH_TIMEOUT_MS
  const maxSkinBytes = Number.isInteger(options.maxSkinBytes) && options.maxSkinBytes > 0
    ? options.maxSkinBytes
    : MAX_SKIN_BYTES
  const cacheMaxBytes = Number.isInteger(options.cacheMaxBytes) && options.cacheMaxBytes >= 0
    ? options.cacheMaxBytes
    : CACHE_MAX_BYTES
  const log = options.log ?? {}

  const manifests = new Map()
  const failures = new Map()
  const inFlight = new Map()

  async function resolve ({ address, port, skinId, action } = {}) {
    if (dir === null || typeof fetchImpl !== 'function') return null
    if (!isPrivateAddress(address)) return null
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    if (typeof skinId !== 'string' || !SKIN_ID_RE.test(skinId)) return null
    const sourceKey = address + ':' + port + '/' + skinId
    const failedAt = failures.get(sourceKey)
    if (failedAt !== undefined && now() - failedAt < FAILURE_COOLDOWN_MS) return null

    const flightKey = sourceKey + '/' + (typeof action === 'string' ? action : '')
    if (inFlight.has(flightKey)) return inFlight.get(flightKey)
    const flight = resolveOnce({ address, port, skinId, sourceKey, action })
      .catch(() => null)
      .finally(() => inFlight.delete(flightKey))
    inFlight.set(flightKey, flight)
    const result = await flight
    if (result === null) failures.set(sourceKey, now())
    else failures.delete(sourceKey)
    return result
  }

  async function resolveOnce ({ address, port, skinId, sourceKey, action }) {
    const origin = 'http://' + address + ':' + port
    const loaded = await loadManifest(origin, skinId, sourceKey)
    if (loaded === null) return null
    const { manifest, route } = loaded

    const chosen = pickAction(manifest, action)
    if (chosen === null) return null
    const entry = manifest.actions[chosen]
    if (entry === null || entry === undefined) return null
    const hex = entry.hash.slice('sha256:'.length)
    // 扁平缓存：内容寻址，同一个 hash 跨来源共享；helper 的 dshzoo://cache/<hash>.webm 直接对得上。
    const file = join(dir, SKIN_CACHE_DIR, hex + '.webm')
    const url = 'dshzoo://cache/' + hex + '.webm'

    if (await isFile(file)) return { url, action: chosen, hash: entry.hash }

    const bytes = await fetchBytes(
      origin + route + '/' + skinId + '/asset/' + encodeURIComponent(chosen),
      maxSkinBytes
    )
    if (bytes === null) return null
    if (!isWebm(bytes)) {
      log.warn?.('远端素材不是 WebM，拒收：' + chosen)
      return null
    }
    if (sha256(bytes) !== entry.hash) {
      log.warn?.('远端素材与 manifest 的 hash 对不上，拒收：' + chosen)
      return null
    }
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, bytes)
      await enforceCacheLimit()
    } catch {
      // 落盘失败不影响本次播放：把字节写临时文件也行，但这里选择让调用方降级。
      return null
    }
    return { url, action: chosen, hash: entry.hash }
  }

  async function loadManifest (origin, skinId, sourceKey) {
    const cached = manifests.get(sourceKey)
    if (cached !== undefined && now() - cached.at < MANIFEST_TTL_MS) return cached.value

    for (const route of SKIN_ROUTES) {
      const bytes = await fetchBytes(origin + route + '/' + skinId + '/manifest', MAX_MANIFEST_BYTES)
      if (bytes === null) continue
      let parsed
      try {
        parsed = JSON.parse(bytes.toString('utf8'))
      } catch {
        continue
      }
      const manifest = normalizeManifest(parsed)
      if (manifest === null) continue
      const value = { manifest, route }
      manifests.set(sourceKey, { at: now(), value })
      return value
    }
    return null
  }

  async function fetchBytes (url, maxBytes) {
    if (typeof fetchImpl !== 'function') return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
        headers: { accept: 'application/json, video/webm' }
      })
      if (response === null || typeof response !== 'object' || response.ok !== true) return null
      const declared = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) return null
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxBytes) return null
      return buffer
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function enforceCacheLimit () {
    const root = join(dir, SKIN_CACHE_DIR)
    let names = []
    try {
      names = await readdir(root)
    } catch {
      return
    }
    const files = []
    for (const name of names) {
      const path = join(root, name)
      try {
        const info = await stat(path)
        if (info.isFile()) files.push({ path, size: info.size, at: info.mtimeMs })
      } catch {
        // 文件刚被删：跳过
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    if (total <= cacheMaxBytes) return
    files.sort((a, b) => a.at - b.at)
    for (const file of files) {
      if (total <= cacheMaxBytes) break
      try {
        await rm(file.path, { force: true })
        total -= file.size
      } catch {
        // 删不掉就下次再说
      }
    }
  }

  return { resolve }
}

function pickAction (manifest, action) {
  if (typeof action === 'string' && Object.prototype.hasOwnProperty.call(manifest.actions, action)) {
    return action
  }
  if (typeof manifest.idle === 'string' && Object.prototype.hasOwnProperty.call(manifest.actions, manifest.idle)) {
    return manifest.idle
  }
  return Object.keys(manifest.actions).sort()[0] ?? null
}

function normalizeManifest (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.v !== 1) return null
  if (typeof value.id !== 'string' || value.id === '') return null
  if (value.actions === null || typeof value.actions !== 'object' || Array.isArray(value.actions)) return null
  const actions = {}
  for (const [id, raw] of Object.entries(value.actions)) {
    if (!SEGMENT_RE.test(id)) continue
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    if (typeof raw.file !== 'string' || !SEGMENT_RE.test(raw.file) || !raw.file.endsWith('.webm')) continue
    if (typeof raw.hash !== 'string' || !HASH_RE.test(raw.hash)) continue
    actions[id] = { file: raw.file, hash: raw.hash }
  }
  if (Object.keys(actions).length === 0) return null
  const idle = typeof value.idle === 'string' && Object.prototype.hasOwnProperty.call(actions, value.idle)
    ? value.idle
    : Object.keys(actions).sort()[0]
  return { id: value.id, idle, actions }
}

function isWebm (buffer) {
  return buffer.length >= 4 &&
    buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3
}

function sha256 (buffer) {
  return 'sha256:' + createHash('sha256').update(buffer).digest('hex')
}

async function isFile (path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
