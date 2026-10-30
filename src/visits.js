import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { normalizeNickname } from './protocol.js'

/**
 * 串门记录：<dataDir>/visits.json。
 *
 * 形状（可手改、可删；删掉整个文件 = 忘掉历史，串门本身照常工作）：
 *   {
 *     "version": 1,
 *     "visits": [
 *       { "direction": "out", "nickname": "隔壁同事", "startedAt": 1700000000000, "durationMs": 60000 }
 *     ]
 *   }
 *
 * 每完成一次串门追加一条；最多 200 条，超出丢最旧的。文件按“最新在前”写，
 * 卡片只读最近 5 条。记录只含四个字段：方向、对方昵称、开始时间、停留时长。
 *
 * 容错规则与 peers.json 一致，而且更严格地保证“记录坏掉不影响客厅”：
 *   - 文件不存在：空记录开始，不告警。
 *   - 文件损坏/形状不对：空记录开始，只告警一次。
 *   - 单条记录字段非法：跳过该条；整批都坏时只告警一次。
 *   - 文件写不进去：内存里照常有记录（这次运行卡片能看），只告警一次。
 *
 * UDP 报文永远不能直接写这个文件：只有 room 完成一次串门后，service 才会
 * 把 drainVisitRecords() 交给 append()，写入量有界（≤200 条，单次整文件）。
 */
export const VISITS_FILE = 'visits.json'
export const MAX_VISIT_RECORDS = 200
export const VISITS_FILE_VERSION = 1
const MAX_DURATION_MS = 24 * 60 * 60 * 1000

export async function createVisitStore (dir, {
  log,
  maxRecords = MAX_VISIT_RECORDS
} = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('visits: missing data directory')
  const store = new VisitStore({ dir, log, maxRecords })
  await store.load()
  return store
}

class VisitStore {
  #dir
  #log
  #maxRecords
  #records = []
  #warned = new Set()
  #writeChain = Promise.resolve()

  constructor ({ dir, log, maxRecords }) {
    this.#dir = dir
    this.#log = log
    this.#maxRecords = Number.isInteger(maxRecords) && maxRecords > 0 ? maxRecords : MAX_VISIT_RECORDS
  }

  async load () {
    let text
    try {
      text = await readFile(join(this.#dir, VISITS_FILE), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warnOnce('read', '串门记录读不出来，先按空记录运行（' + errorName(error) + '）')
      }
      return
    }

    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      this.#warnOnce('parse', '串门记录不是合法 JSON，先按空记录运行')
      return
    }
    if (raw === null || typeof raw !== 'object') {
      this.#warnOnce('shape', '串门记录形状不对，先按空记录运行')
      return
    }
    // 正常写 { version, visits: [] }；手改成裸数组也认，容错优先。
    const list = Array.isArray(raw) ? raw : raw.visits
    if (!Array.isArray(list)) {
      this.#warnOnce('shape', '串门记录形状不对，先按空记录运行')
      return
    }

    const records = []
    let dropped = 0
    for (const item of list) {
      const record = normalizeRecord(item)
      if (record === null) {
        dropped += 1
        continue
      }
      records.push(record)
    }
    if (dropped > 0) {
      this.#warnOnce('entries', '串门记录里有 ' + dropped + ' 条格式不对，已跳过')
    }
    records.sort((left, right) => right.startedAt - left.startedAt)
    this.#records = records.slice(0, this.#maxRecords)
  }

  /** 给 room 的只读副本，最新在前；调用方改它不影响 store。 */
  records () {
    return this.#records.map((record) => ({ ...record }))
  }

  count () {
    return this.#records.length
  }

  /**
   * 追加一条完成记录。先改内存再落盘：磁盘坏掉时本次运行仍然能看到记录。
   * 返回是否写进了文件（false 表示只在内存里，重启后丢）。
   */
  async append (record) {
    const clean = normalizeRecord(record)
    if (clean === null) return false
    this.#records.unshift(clean)
    if (this.#records.length > this.#maxRecords) this.#records.length = this.#maxRecords
    return this.#persist()
  }

  #persist () {
    // 串行化写入：一次 tick 里同时完成多条记录时，不会互相读到写了一半的文件。
    const task = this.#writeChain.then(() => this.#write(), () => this.#write())
    this.#writeChain = task.catch(() => false)
    return task
  }

  async #write () {
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      const body = JSON.stringify({
        version: VISITS_FILE_VERSION,
        visits: this.#records
      }, null, 2) + '\n'
      await writeFile(join(this.#dir, VISITS_FILE), body, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch (error) {
      this.#warnOnce('write', '串门记录写不进去：本次运行仍能看记录，但重启后会丢（' + errorName(error) + '）')
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

function normalizeRecord (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.direction !== 'out' && raw.direction !== 'in') return null
  const nickname = normalizeNickname(raw.nickname)
  if (nickname === null) return null
  if (!Number.isFinite(raw.startedAt) || raw.startedAt < 0) return null
  if (!Number.isFinite(raw.durationMs) || raw.durationMs < 0) return null
  return {
    direction: raw.direction,
    nickname,
    startedAt: Math.floor(raw.startedAt),
    durationMs: Math.min(Math.floor(raw.durationMs), MAX_DURATION_MS)
  }
}

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}
