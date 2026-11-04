import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { normalizeSkinId } from './protocol.js'

/**
 * 本机桌面开关：<dataDir>/settings.json。
 *
 * 两个开关：
 *   - `acceptVisits`（默认开）：允不允许邻居把宠物派到我家。
 *   - `autoVisits`（默认关）：允不允许我的宠物**自己**偶尔出门串门（ticket 09）。
 *   - `desktop`（默认开）：桌面层总闸。置顶全屏窗在你这台机器上行为不对时，把它写成 false
 *     再重启，宠物不显示、其它一切照常——不需要环境变量，也不需要卸载插件。
 *   - `activeSource`（默认空 = 第一条）：当前那张皮的素材源 id（ticket 32 / ADR-0013）。
 *     它只决定"用哪张皮"，名字、身份、串门记录、礼物都不随它变。
 *       {
 *         "version": 1,
 *         "acceptVisits": true,
 *         "autoVisits": false,
 *         "activeSource": "maodie"
 *       }
 *
 * `acceptVisits` 关掉时只拒绝**入站串门请求**：邻居灯、发现广播、心跳和本机出门照旧。
 * `autoVisits` 关掉时只停**自发出门**：手动「串门」照常可用。
 *
 * 容错规则与 peers.json 一致：
 *   - 文件不存在：按默认值运行，不告警。
 *   - 文件损坏/形状不对：按默认值运行，只告警一次。
 *   - 单个开关字段缺失：该字段用默认值（老版本文件没有 autoVisits 是正常的）。
 *   - 文件写不进去：内存里照常生效，只告警一次；重启后回到文件里的旧值。
 *
 * 只有本机 HTTP action 能写这个文件；UDP 报文碰不到它。
 */
export const SETTINGS_FILE = 'settings.json'
export const SETTINGS_VERSION = 1
export const DEFAULT_ACCEPT_VISITS = true
/** 自发出门默认关：一只不受控的宠物随机出现在同事屏幕上，比可爱更接近骚扰。 */
export const DEFAULT_AUTO_VISITS = false

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
  #autoVisits = DEFAULT_AUTO_VISITS
  #desktop = true
  #activeSource = null
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
        this.#warnOnce('read', '桌面开关读不出来，先按默认值运行（' + errorName(error) + '）')
      }
      return
    }

    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      this.#warnOnce('parse', '桌面开关不是合法 JSON，先按默认值运行')
      return
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      this.#warnOnce('shape', '桌面开关形状不对，先按默认值运行')
      return
    }
    // 两个字段各自校验：老文件没有 autoVisits 是正常的，不该因此丢掉 acceptVisits。
    if (raw.acceptVisits !== undefined) {
      if (typeof raw.acceptVisits === 'boolean') this.#acceptVisits = raw.acceptVisits
      else this.#warnOnce('shape', '桌面开关形状不对，acceptVisits 先按默认值运行')
    }
    if (raw.autoVisits !== undefined) {
      if (typeof raw.autoVisits === 'boolean') this.#autoVisits = raw.autoVisits
      else this.#warnOnce('shape', '桌面开关形状不对，autoVisits 先按默认值运行')
    }
    if (raw.desktop !== undefined) {
      if (typeof raw.desktop === 'boolean') this.#desktop = raw.desktop
      else this.#warnOnce('shape', '桌面开关形状不对，desktop 先按默认值运行')
    }
    // 当前皮：只认素材源 id 那个形状。指向一个不存在的源不是这里的事——
    // 注册表才知道有哪些源，由 service 回落到第一条并告警（ticket 32）。
    if (raw.activeSource !== undefined && raw.activeSource !== null) {
      const id = normalizeSkinId(raw.activeSource)
      if (id === null) this.#warnOnce('shape', '桌面开关形状不对，activeSource 先按默认值运行')
      else this.#activeSource = id
    }
  }

  get acceptVisits () {
    return this.#acceptVisits
  }

  get autoVisits () {
    return this.#autoVisits
  }

  get desktop () {
    return this.#desktop
  }

  /** 当前那张皮的源 id；null = 还没选过，取注册表第一条。 */
  get activeSource () {
    return this.#activeSource
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

  async setAutoVisits (enabled) {
    if (typeof enabled !== 'boolean') return false
    this.#autoVisits = enabled
    return this.#persist()
  }

  /** 换皮（ticket 32）：只写这一项，别的字段一个都不碰。 */
  async setActiveSource (id) {
    if (typeof id !== 'string') return false
    const normalized = normalizeSkinId(id)
    if (normalized === null) return false
    this.#activeSource = normalized
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
        desktop: this.#desktop,
        version: SETTINGS_VERSION,
        acceptVisits: this.#acceptVisits,
        autoVisits: this.#autoVisits,
        // 没选过就不写这一行：老文件与旧版本看起来一模一样。
        ...(this.#activeSource === null ? {} : { activeSource: this.#activeSource })
      }, null, 2) + '\n'
      await writeFile(join(this.#dir, SETTINGS_FILE), body, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch (error) {
      this.#warnOnce('write', '桌面开关写不进去：本次运行仍然生效，但重启后会回到旧值（' + errorName(error) + '）')
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
