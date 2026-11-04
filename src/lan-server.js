import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { MAX_GIFT_BYTES, isVisitId } from './protocol.js'

/**
 * 局域网只读服务（ticket 15 的素材源 + ticket 25 的礼物源）。
 *
 * 这是 local-pet 自己开的**只读** HTTP 端口——不能复用 DSH 的 webServer，它只绑
 * 127.0.0.1，邻居访问不到。同一个端口挂两套路由：
 *   GET /local-pet-skin/manifest            → 默认源的 manifest（含每个文件的 sha256）
 *   GET /local-pet-skin/asset/<动作>         → WebM，支持 Range
 *   GET /local-pet-skin/<源 id>/...          → 多源时的显式路由
 *   GET /local-pet-gift/<giftId>             → 文件礼物的本体（只在 armed 期间可读）
 *
 * **没有素材源时也要能起来**（ticket 25）：不装 dsh-pet 的用户照样需要礼物端口，
 * 所以 `sources` 为空只是「skin 路由一律 404」，不再让整个服务器返回 null。
 * 端口被占就向后找，找不到才返回 null 让调用方降级（beacon 不带 skinPort）。
 *
 * 安全口径：只认登记过的动作 id 与**礼物表里的那一个绝对路径**（报文里没有任何路径），
 * 不拼用户输入、只回 webm/octet-stream、单文件有上限、只读、不列目录、v1 不做 Range。
 */

export const SKIN_ROUTE = '/local-pet-skin'
export const GIFT_ROUTE = '/local-pet-gift'
export const DEFAULT_SKIN_PORT = 45873
export const MAX_SKIN_FILE_BYTES = 8 * 1024 * 1024
export const MAX_SKIN_PORT_TRIES = 10
/** 礼物路由的单件上限与 wire 上的 `MAX_GIFT_BYTES` 是同一个数：16 MiB。 */
export const MAX_GIFT_FILE_BYTES = MAX_GIFT_BYTES
const SOURCE_ID = /^[A-Za-z0-9_-]{1,32}$/
const GIFT_HASH_RE = /^sha256:[0-9a-f]{64}$/

export async function startLanServer (options = {}) {
  const sources = Array.isArray(options.sources) ? options.sources : []
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : '0.0.0.0'
  const requestedPort = Number.isInteger(options.port) ? options.port : DEFAULT_SKIN_PORT
  const maxFileBytes = Number.isInteger(options.maxFileBytes) && options.maxFileBytes > 0
    ? options.maxFileBytes
    : MAX_SKIN_FILE_BYTES
  const maxGiftBytes = Number.isInteger(options.maxGiftBytes) && options.maxGiftBytes > 0
    ? options.maxGiftBytes
    : MAX_GIFT_FILE_BYTES
  const maxPortTries = Number.isInteger(options.maxPortTries) && options.maxPortTries > 0
    ? options.maxPortTries
    : MAX_SKIN_PORT_TRIES
  const log = options.log ?? {}
  const readFileImpl = typeof options.readFile === 'function' ? options.readFile : readFile
  const statImpl = typeof options.stat === 'function' ? options.stat : stat
  const createReadStreamImpl = typeof options.createReadStream === 'function'
    ? options.createReadStream
    : createReadStream
  const createServerImpl = typeof options.createServer === 'function' ? options.createServer : createServer
  /**
   * 礼物表的唯一入口：`giftId → { path, size, hash, visitId, until }`。
   * service 把它的 `armedGifts` 表以函数形式交进来——服务器不持有表，也不认识 service。
   * 表里没有 = 404；表里有但过期 = 404；文件被改/删 = 410；超过 16 MiB = 413。
   */
  const lookupGift = typeof options.lookupGift === 'function' ? options.lookupGift : null

  const byId = new Map()
  for (const source of sources) {
    if (source === null || typeof source !== 'object') continue
    if (typeof source.id !== 'string' || !SOURCE_ID.test(source.id)) continue
    if (!source.actions || typeof source.actions !== 'object') continue
    if (!byId.has(source.id)) byId.set(source.id, source)
  }
  /** 素材源可以为空：礼物路由仍然要活着。 */
  const fallbackSource = [...byId.values()][0] ?? null

  const hashesBySource = new Map()
  const manifests = new Map()

  async function manifestOf (source) {
    if (manifests.has(source.id)) return manifests.get(source.id)
    const hashes = await hashActions(source)
    const actions = {}
    for (const id of Object.keys(source.actions).sort()) {
      if (!hashes.has(id)) continue
      actions[id] = { file: source.actions[id].file, loop: true, hash: hashes.get(id) }
    }
    if (Object.keys(actions).length === 0) return null
    const body = {
      v: 1,
      id: source.id,
      name: source.id,
      size: Number.isInteger(source.size) ? source.size : 462,
      idle: idleOf(source, actions),
      actions
    }
    const hash = 'sha256:' + createHash('sha256').update(JSON.stringify(body)).digest('hex')
    const manifest = { ...body, hash }
    manifests.set(source.id, manifest)
    return manifest
  }

  async function hashActions (source) {
    if (hashesBySource.has(source.id)) return hashesBySource.get(source.id)
    const hashes = new Map()
    for (const [id, entry] of Object.entries(source.actions)) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.dir !== 'string' || typeof entry.file !== 'string') continue
      try {
        const data = await readFileImpl(join(entry.dir, entry.file))
        hashes.set(id, 'sha256:' + createHash('sha256').update(data).digest('hex'))
      } catch {
        log.warn?.('素材源：读不到 ' + entry.file + '，manifest 里先不列它')
      }
    }
    hashesBySource.set(source.id, hashes)
    return hashes
  }

  async function handle (request, response) {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return sendText(response, 405, 'method not allowed')
      }
      let url
      try {
        url = new URL(request.url, 'http://local')
      } catch {
        return sendText(response, 400, 'bad url')
      }
      let pathname
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        return sendText(response, 400, 'bad path')
      }

      // 礼物路由只有一层（giftId），没有目录、没有 Range、没有任何用户路径。
      if (pathname.startsWith(GIFT_ROUTE + '/')) {
        const rawId = pathname.slice(GIFT_ROUTE.length + 1)
        if (rawId === '' || rawId.includes('/')) return sendText(response, 404, 'not found')
        return handleGift(request, response, rawId)
      }
      if (!pathname.startsWith(SKIN_ROUTE + '/')) return sendText(response, 404, 'not found')
      return handleSkin(request, response, pathname)
    } catch (error) {
      log.warn?.('局域网服务请求失败：' + (error instanceof Error ? error.message : String(error)))
      return sendText(response, 500, 'internal error')
    }
  }

  async function handleGift (request, response, rawId) {
    // 先过 UUID 形状，再查表：表里的键只可能是小写 UUID。
    if (!isVisitId(rawId)) return sendText(response, 404, 'not found')
    const entry = lookupGift === null ? null : lookupGift(rawId.toLowerCase())
    if (!isArmedGift(entry)) return sendText(response, 404, 'not found')
    if (!Number.isFinite(entry.until) || Date.now() > entry.until) return sendText(response, 404, 'not found')

    let info
    try {
      info = await statImpl(entry.path)
    } catch {
      // 发送之后被删了：东西已经不在了，不发字节。
      return sendText(response, 410, 'gone')
    }
    if (!info.isFile()) return sendText(response, 410, 'gone')
    // 先判 413 再判 410：用户把文件换成一个超过上限的东西时，说“太大”比“变了”更有用。
    if (info.size > maxGiftBytes) return sendText(response, 413, 'too large')
    if (info.size !== entry.size) return sendText(response, 410, 'gone')

    // 先算 hash 再发字节：hash 不对时连响应头都还没写，客户端拿到的是干净的 410。
    let actual
    try {
      actual = await hashFile(entry.path, maxGiftBytes, createReadStreamImpl)
    } catch {
      return sendText(response, 410, 'gone')
    }
    if (actual !== entry.hash) return sendText(response, 410, 'gone')

    const headers = {
      'content-type': 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store'
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, headers)
      response.end()
      return
    }
    response.writeHead(200, headers)
    // 流式返回：16 MiB 不读进内存，也不做 Range（v1 只整份取）。
    const stream = createReadStreamImpl(entry.path)
    stream.on('error', () => {
      try {
        response.destroy()
      } catch {
        // 连接已经断了
      }
    })
    stream.pipe(response)
  }

  async function handleSkin (request, response, pathname) {
    const parts = pathname.slice(SKIN_ROUTE.length + 1).split('/')

    // manifest 路由：默认源，或显式 <源 id>/manifest
    let source = fallbackSource
    let tail = parts
    if (parts.length >= 2 && parts[1] === 'manifest') {
      source = byId.get(parts[0])
      tail = ['manifest']
      if (source === undefined) return sendText(response, 404, 'unknown source')
    } else if (parts.length >= 2 && parts[1] === 'asset') {
      source = byId.get(parts[0])
      if (source === undefined) return sendText(response, 404, 'unknown source')
      tail = ['asset', ...parts.slice(2)]
    }
    // 没有素材源 / 路径没指名源：素材路由一律 404，但礼物路由照常（服务器不会因为这里返回）。
    if (source === undefined || source === null) return sendText(response, 404, 'not found')

    if (tail.length === 1 && tail[0] === 'manifest') {
      const manifest = await manifestOf(source)
      if (manifest === null) return sendText(response, 404, 'manifest unavailable')
      return sendJson(response, 200, manifest, request.method === 'HEAD')
    }

    if (tail.length === 2 && tail[0] === 'asset') {
      const entry = actionOf(source, tail[1])
      if (entry === null) return sendText(response, 404, 'unknown action')
      let data
      try {
        data = await readFileImpl(join(entry.dir, entry.file))
      } catch {
        return sendText(response, 404, 'asset missing')
      }
      if (data.length > maxFileBytes) return sendText(response, 413, 'asset too large')
      return sendAsset(response, data, request)
    }

    return sendText(response, 404, 'not found')
  }

  const bound = await bind(handle, { createServerImpl, host, port: requestedPort, maxPortTries })
  if (bound === null) return null
  return {
    port: bound.port,
    host,
    /** 有素材源才有这个 id；没有源时只广告端口（beacon 的 skinId 缺省）。 */
    skinId: fallbackSource === null ? null : fallbackSource.id,
    close: () => new Promise((resolve) => bound.server.close(() => resolve()))
  }
}

/** 礼物表项必须自带一个绝对路径与完整的 size/hash；坏项按“没 arm”处理。 */
function isArmedGift (entry) {
  if (entry === null || typeof entry !== 'object') return false
  if (typeof entry.path !== 'string' || entry.path === '') return false
  if (!Number.isInteger(entry.size) || entry.size <= 0) return false
  if (typeof entry.hash !== 'string' || !GIFT_HASH_RE.test(entry.hash)) return false
  return true
}

/** 边读边算 sha256，不把 16 MiB 搬进内存；超过上限立刻停（防止 stat 之后文件突然变大）。 */
function hashFile (path, maxBytes, createReadStreamImpl) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let bytes = 0
    let settled = false
    const stream = createReadStreamImpl(path)
    stream.on('data', (chunk) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > maxBytes) {
        settled = true
        stream.destroy()
        reject(new Error('gift too large'))
        return
      }
      hash.update(chunk)
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve('sha256:' + hash.digest('hex'))
    })
    stream.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

function actionOf (source, rawName) {
  if (typeof rawName !== 'string' || rawName === '') return null
  const name = rawName.endsWith('.webm') ? rawName.slice(0, -'.webm'.length) : rawName
  if (!Object.prototype.hasOwnProperty.call(source.actions, name)) return null
  const entry = source.actions[name]
  if (entry === null || typeof entry !== 'object') return null
  if (typeof entry.dir !== 'string' || typeof entry.file !== 'string') return null
  return entry
}

function idleOf (source, actions) {
  const declared = source.manifest?.idle
  if (typeof declared === 'string' && Object.prototype.hasOwnProperty.call(actions, declared)) return declared
  if (Object.prototype.hasOwnProperty.call(actions, '待机呼吸休闲')) return '待机呼吸休闲'
  return Object.keys(actions).sort()[0]
}

function sendJson (response, status, value, head = false) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  response.end(head ? undefined : body)
}

function sendText (response, status, text) {
  const body = String(text)
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

function sendAsset (response, data, request) {
  const range = parseRange(request.headers.range, data.length)
  if (range !== null && range.invalid === true) {
    response.writeHead(416, {
      'content-type': 'video/webm',
      'content-range': 'bytes */' + data.length
    })
    response.end()
    return
  }
  const headers = {
    'content-type': 'video/webm',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=300'
  }
  if (range === null) {
    response.writeHead(200, { ...headers, 'content-length': data.length })
    response.end(request.method === 'HEAD' ? undefined : data)
    return
  }
  const chunk = data.subarray(range.start, range.end + 1)
  response.writeHead(206, {
    ...headers,
    'content-length': chunk.length,
    'content-range': 'bytes ' + range.start + '-' + range.end + '/' + data.length
  })
  response.end(request.method === 'HEAD' ? undefined : chunk)
}

/** 只支持单区间 `bytes=start-end`；语法合法但越界返回 invalid。 */
function parseRange (header, length) {
  if (typeof header !== 'string' || header === '') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return { invalid: true }
  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''
  if (!hasStart && !hasEnd) return { invalid: true }
  let start
  let end
  if (hasStart) {
    start = Number(match[1])
    end = hasEnd ? Number(match[2]) : length - 1
  } else {
    const suffix = Number(match[2])
    if (suffix === 0) return { invalid: true }
    start = Math.max(0, length - suffix)
    end = length - 1
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= length) {
    return { invalid: true }
  }
  return { start, end: Math.min(end, length - 1) }
}

function bind (handler, { createServerImpl, host, port, maxPortTries }) {
  const candidates = port === 0 ? [0] : Array.from({ length: maxPortTries }, (_, index) => port + index)
    .filter((value) => value <= 65535)
  return (async () => {
    for (const candidate of candidates) {
      const result = await listenOnce(handler, createServerImpl, host, candidate)
      if (result.server !== undefined) {
        return { server: result.server, port: result.server.address().port }
      }
      if (result.error?.code !== 'EADDRINUSE') return null
    }
    return null
  })()
}

function listenOnce (handler, createServerImpl, host, port) {
  return new Promise((resolve) => {
    const server = createServerImpl(handler)
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    server.once('error', (error) => {
      try { server.close() } catch { /* 还没监听成功，关不掉也无妨 */ }
      done({ error })
    })
    server.listen(port, host, () => done({ server }))
  })
}

/** 环境变量覆盖素材源端口；非法值静默回落默认端口（同 LOCAL_PET_PORT 的口径）。 */
export function resolveSkinPort (env = process.env) {
  const raw = env?.LOCAL_PET_SKIN_PORT
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_SKIN_PORT
  const port = Number(String(raw).trim())
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_SKIN_PORT
}
