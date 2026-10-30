import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 本机客厅开关：<dataDir>/settings.json。
 *
 * 目前只有一个开关：`acceptVisits`——允不允许邻居把宠物派到我家。
 *   {
 *     "version": 1,
 *     "acceptVisits": true
 *   }
 *
 * 默认是开；文件不存在 = 默认开。用户点一下客厅里的小开关就会落盘，重启后仍然有效。
 * 这个开关只拒绝**入站串门请求**：邻居灯、发现广播和心跳照旧（见 docs/protocol.md）。
 *
 * 容错规则与 peers.json 一致：
 *   - 文件损坏/形状不对：按默认值运行，只告警一次。
 *   - 文件写不进去：内存里照常生效，只告警一次；重启后回到文件里的旧值。
 *
 * 只有本机 HTTP action 能写这个文件；UDP 报文碰不到它。
 */
export const SETTINGS_FILE = 'settings.json'
export const SETTINGS_VERSION = 1
export const DEFAULT_ACCEPT_VISITS = true

export async function createSettingsStore (dir, { log } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('settings: missing data directory')
  const store = new SettingsStore({ dir, log })
  await store.load()
  return store
}

class SettingsStore {
  #dir
  #log
  #acceptVisits = DEFAULT_ACCEPT_VISITS
  #warned = new Set()
  #writeChain = Promise.resolve()

  constructor ({ dir, log }) {
    this.#dir = dir
    this.#log = log
  }

  async load () {
    let text
    try {
      text = await readFile(join(this.#dir, SETTINGS_FILE), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warnOnce('read', '客厅开关读不出来，先按“允许串门”运行（' + errorName(error) + '）')
      }
      return
    }

    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      this.#warnOnce('parse', '客厅开关不是合法 JSON，先按“允许串门”运行')
      return
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      this.#warnOnce('shape', '客厅开关形状不对，先按“允许串门”运行')
      return
    }
    if (typeof raw.acceptVisits !== 'boolean') {
      this.#warnOnce('shape', '客厅开关形状不对，先按“允许串门”运行')
      return
    }
    this.#acceptVisits = raw.acceptVisits
  }

  get acceptVisits () {
    return this.#acceptVisits
  }

  /**
   * 改开关。先改内存再落盘：磁盘坏掉时本次运行仍然生效。
   * 返回是否写进了文件（false 表示只在内存里，重启后会回到旧值）。
   */
  async setAcceptVisits (enabled) {
    if (typeof enabled !== 'boolean') return false
    this.#acceptVisits = enabled
    return this.#persist()
  }

  #persist () {
    // 串行化写入：连点开关时，后一次不会读到前一次写了一半的文件。
    const task = this.#writeChain.then(() => this.#write(), () => this.#write())
    this.#writeChain = task.catch(() => false)
    return task
  }

  async #write () {
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      const body = JSON.stringify({
        version: SETTINGS_VERSION,
        acceptVisits: this.#acceptVisits
      }, null, 2) + '\n'
      await writeFile(join(this.#dir, SETTINGS_FILE), body, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch (error) {
      this.#warnOnce('write', '客厅开关写不进去：本次运行仍然生效，但重启后会回到旧值（' + errorName(error) + '）')
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

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}
