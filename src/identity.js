import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isDeviceId, normalizeNickname } from './protocol.js'

/**
 * 本机身份：一个**持久化**的随机 UUID + 一个可读昵称。
 *
 * 文件是 <dataDir>/identity.json，用户可手改、可删；删掉等于换一台“新机器”。
 * deviceId 只在这里生成，永远不从网络输入里取（否则别人可以冒充邻居）。
 * 昵称变更也只接受本机 HTTP action，不来自 UDP。
 */
export const IDENTITY_FILE = 'identity.json'

export function defaultNickname ({ petName, hostname } = {}) {
  return normalizeNickname(petName) ?? normalizeNickname(hostname) ?? '我'
}

/**
 * 读取身份；文件不存在/损坏/字段非法时生成新身份并尽量写回。
 * 写不进去时仍然返回可用的内存身份：插件不能因为磁盘问题整个挂掉。
 */
export async function createIdentity (dir, { defaultNickname: fallback, log } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('identity: missing data directory')
  const file = join(dir, IDENTITY_FILE)
  let saved = null
  let dirty = true

  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      saved = parsed
      dirty = false
    } else {
      warn(log, '身份文件形状不对，重新生成 deviceId')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(log, '身份文件读不出来，重新生成 deviceId')
  }

  const deviceId = isDeviceId(saved?.deviceId) ? saved.deviceId.toLowerCase() : randomUUID()
  if (saved?.deviceId !== deviceId) dirty = true

  let nickname = normalizeNickname(saved?.nickname)
  if (nickname === null) {
    nickname = normalizeNickname(fallback) ?? '我'
    dirty = true
  } else if (saved?.nickname !== nickname) {
    dirty = true
  }

  const identity = new Identity({ dir, deviceId, nickname, log })

  if (dirty) {
    try {
      await identity.persist()
      identity.persisted = true
    } catch (error) {
      warn(log, '身份文件写不进去：本次运行仍可发现邻居，但重启后会换身份（' + errorName(error) + '）')
    }
  } else {
    identity.persisted = true
  }

  return identity
}

class Identity {
  #dir
  #deviceId
  #nickname
  #log

  constructor ({ dir, deviceId, nickname, log = null }) {
    this.#dir = dir
    this.#deviceId = deviceId
    this.#nickname = nickname
    this.#log = log
    this.persisted = false
  }

  get deviceId () {
    return this.#deviceId
  }

  get nickname () {
    return this.#nickname
  }

  /** 改昵称：先落盘，成功后才改内存；失败返回 null，由调用方给用户明确失败。 */
  async rename (nickname) {
    const clean = normalizeNickname(nickname)
    if (clean === null) return null
    const previous = this.#nickname
    this.#nickname = clean
    try {
      await this.persist()
      this.persisted = true
      return clean
    } catch {
      this.#nickname = previous
      return null
    }
  }

  /**
   * 镜像：名字的真相在 dsh-pet（ADR-0007），这里只是跟着走。
   *
   * 和 `rename` 的差别是**失败语义**：镜像的内存值立刻生效（这一次广播就要带上新名字），
   * 落盘是尽力而为——写不进去只把 `persisted` 记成 false，下次配置变化还会再对一次。
   * 为了这一刻的磁盘问题，让邻居一直看到旧名字是不划算的。
   */
  mirror (nickname) {
    const clean = normalizeNickname(nickname)
    if (clean === null) return null
    if (clean === this.#nickname && this.persisted) return clean
    this.#nickname = clean
    this.persisted = false
    this.persist()
      .then(() => { this.persisted = true })
      .catch(() => {
        warn(this.#log, '身份文件写不进去：名字已经跟着 dsh-pet 改了，但重启后会从配置里重新对一遍')
      })
    return clean
  }

  async persist () {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 })
    const body = JSON.stringify({ deviceId: this.#deviceId, nickname: this.#nickname }, null, 2) + '\n'
    await writeFile(join(this.#dir, IDENTITY_FILE), body, { encoding: 'utf8', mode: 0o600 })
  }

  toJSON () {
    return { deviceId: this.#deviceId, nickname: this.#nickname }
  }
}

function warn (log, message) {
  try {
    log?.warn?.(message)
  } catch {
    // 日志不能反过来把插件搞崩
  }
}

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}
