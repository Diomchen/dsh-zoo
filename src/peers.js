import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isDeviceId, normalizeNickname } from './protocol.js'

/**
 * 放行名单与拒绝名单：<dataDir>/peers.json。
 *
 * 形状（可手改、可删；删掉一个 `deviceId` = 下次见面重新询问）：
 *   {
 *     "allowed": { "<uuid>": { "nickname": "隔壁同事", "allowedAt": 1700000000000 } },
 *     "denied":  { "<uuid>": { "nickname": "发广告的", "deniedAt":  1700000000000 } }
 *   }
 *
 * 写入只由本机 HTTP action 触发；UDP 报文永远碰不到这个文件。
 *   - 文件不存在：空名单开始，不告警。
 *   - 文件损坏/形状不对：空名单开始，只告警一次，绝不把插件拖崩。
 *   - 文件写不进去：内存里照常生效（本次运行不再问），只告警一次。
 *
 * 两个名单都按 `deviceId` 认，不按 IP；都有条数上限，保证文件大小有界。
 * `denied` 优先于 `allowed`（手改文件时两边同时出现，以拒绝为准）。
 */
export const PEERS_FILE = 'peers.json'
export const MAX_PEERS = 256

const FALLBACK_NICKNAME = '邻居'

export async function createPeerStore (dir, {
  log,
  now = () => Date.now(),
  maxPeers = MAX_PEERS
} = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('peers: missing data directory')
  const store = new PeerStore({ dir, log, now, maxPeers })
  await store.load()
  return store
}

class PeerStore {
  #dir
  #log
  #now
  #maxPeers
  #allowed = new Map()
  #denied = new Map()
  #warned = new Set()
  #writeChain = Promise.resolve()

  constructor ({ dir, log, now, maxPeers }) {
    this.#dir = dir
    this.#log = log
    this.#now = typeof now === 'function' ? now : () => Date.now()
    this.#maxPeers = Number.isInteger(maxPeers) && maxPeers > 0 ? maxPeers : MAX_PEERS
  }

  async load () {
    let text
    try {
      text = await readFile(join(this.#dir, PEERS_FILE), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warnOnce('read', '放行名单读不出来，先按空名单运行（' + errorName(error) + '）')
      }
      return
    }

    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      this.#warnOnce('parse', '放行名单不是合法 JSON，先按空名单运行')
      return
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      this.#warnOnce('shape', '放行名单形状不对，先按空名单运行')
      return
    }

    this.#allowed = readList(raw.allowed, 'allowedAt', this.#maxPeers)
    this.#denied = readList(raw.denied, 'deniedAt', this.#maxPeers)
    // 两边同时出现时拒绝优先：不让一次手滑把人放进来。
    for (const deviceId of this.#denied.keys()) this.#allowed.delete(deviceId)
  }

  /** 给 room 的只读副本；形状与文件一致，调用方改它不影响 store。 */
  trust () {
    return {
      allowed: serializeList(this.#allowed, 'allowedAt'),
      denied: serializeList(this.#denied, 'deniedAt')
    }
  }

  isAllowed (deviceId) {
    const id = normalizeDeviceId(deviceId)
    return id !== null && this.#allowed.has(id)
  }

  isDenied (deviceId) {
    const id = normalizeDeviceId(deviceId)
    return id !== null && this.#denied.has(id)
  }

  counts () {
    return { allowed: this.#allowed.size, denied: this.#denied.size }
  }

  /**
   * 记录一次放行。先改内存再落盘：磁盘坏掉时本次运行仍然放行。
   * 返回是否写进了文件（false 表示只在内存里，重启会重新询问）。
   */
  async admit ({ deviceId, nickname, at } = {}) {
    const id = normalizeDeviceId(deviceId)
    if (id === null) return false
    this.#allowed.delete(id)
    this.#allowed.set(id, recordFor(nickname, at, this.#now))
    this.#denied.delete(id)
    trim(this.#allowed, this.#maxPeers)
    return this.#persist()
  }

  /** 记录一次拒绝；与放行互斥。返回是否写进了文件。 */
  async reject ({ deviceId, nickname, at } = {}) {
    const id = normalizeDeviceId(deviceId)
    if (id === null) return false
    this.#denied.delete(id)
    this.#denied.set(id, recordFor(nickname, at, this.#now))
    this.#allowed.delete(id)
    trim(this.#denied, this.#maxPeers)
    return this.#persist()
  }

  #persist () {
    // 串行化写入：同一秒里连点接受/拒绝时，后一次不会读到前一次写了一半的文件。
    const task = this.#writeChain.then(() => this.#write(), () => this.#write())
    this.#writeChain = task.catch(() => false)
    return task
  }

  async #write () {
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      const body = JSON.stringify({
        allowed: serializeList(this.#allowed, 'allowedAt'),
        denied: serializeList(this.#denied, 'deniedAt')
      }, null, 2) + '\n'
      await writeFile(join(this.#dir, PEERS_FILE), body, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch (error) {
      this.#warnOnce('write', '放行名单写不进去：本次运行仍会记住放行，但重启后会重新询问（' + errorName(error) + '）')
      return false
    }
  }

  #warnOnce (key, message) {
    if (this.#warned.has(key)) return
    this.#warned.add(key)
    try {
      this.#log?.warn?.(message)
    } catch {
      // 日志不能反过来把插件搞崩
    }
  }
}

function readList (value, stampKey, maxPeers) {
  const list = new Map()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return list
  for (const [rawId, record] of Object.entries(value)) {
    const deviceId = normalizeDeviceId(rawId)
    if (deviceId === null) continue
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    const nickname = normalizeNickname(record.nickname) ?? FALLBACK_NICKNAME
    const rawStamp = record[stampKey]
    const at = Number.isFinite(rawStamp) && rawStamp >= 0 ? rawStamp : 0
    list.set(deviceId, { nickname, at })
  }
  trim(list, maxPeers)
  return list
}

function serializeList (list, stampKey) {
  const ordered = [...list.entries()].sort((left, right) => left[1].at - right[1].at)
  const out = {}
  for (const [deviceId, record] of ordered) {
    out[deviceId] = { nickname: record.nickname, [stampKey]: record.at }
  }
  return out
}

function recordFor (nickname, at, now) {
  const stamp = Number.isFinite(at) && at >= 0 ? at : now()
  return {
    nickname: normalizeNickname(nickname) ?? FALLBACK_NICKNAME,
    at: Number.isFinite(stamp) && stamp >= 0 ? stamp : 0
  }
}

/** 超过上限时丢最旧的（时间戳最小；缺失时间戳视为 0，先被丢）。 */
function trim (list, maxPeers) {
  const cap = Number.isInteger(maxPeers) && maxPeers > 0 ? maxPeers : MAX_PEERS
  while (list.size > cap) {
    let oldestKey
    let oldestAt = Infinity
    for (const [deviceId, record] of list) {
      if (record.at < oldestAt) {
        oldestAt = record.at
        oldestKey = deviceId
      }
    }
    if (oldestKey === undefined) break
    list.delete(oldestKey)
  }
}

function normalizeDeviceId (value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return isDeviceId(id) ? id.toLowerCase() : null
}

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}
