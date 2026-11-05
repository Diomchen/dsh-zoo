import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { parseJsonText } from './json-text.js'
import { join } from 'node:path'

import {
  MAX_GIFT_BYTES,
  isVisitId,
  sanitizeGiftName,
  sanitizeNote
} from './protocol.js'

/**
 * 发送端的背包：`<dataDir>/backpack.json`（可手改、可删；删了就是空背包）。
 *
 * 形状（SPEC v4「背包（发送端）」）：
 *   {
 *     "version": 1,
 *     "items": [
 *       { "id": "…uuid…", "kind": "text", "text": "给你留了张便条", "at": 1700000000000, "state": "idle" },
 *       { "id": "…uuid…", "kind": "file", "path": "/Users/me/报价单.pdf", "name": "报价单.pdf",
 *         "at": 1700000000001, "state": "out", "visitId": "…" }
 *     ]
 *   }
 *
 * 三条产品规则决定这里的形状：
 *   - **最多两件**；满了拒绝放进（`backpack-full`），绝不静默丢旧的；
 *   - **先放的先带走**：出门永远取 `at` 最小的那一件（手动与自发同一条规则）；
 *   - **文件件只存路径**，不复制；`size` / `sha256` 在**发送那一刻**才算（用户可能改过文件）。
 *
 * 容错与 `src/visits.js` 同一套路，但写盘补了 tmp + rename：
 *   - 文件不存在：空背包开始，不告警；损坏/形状不对：空背包 + 只告警一次；
 *   - 单件坏掉只跳过那件；超过两件按 `at` 留最旧的两件（并告警一次）；
 *   - 写盘失败只告警一次：本次运行内存里照常有背包，重启后可能丢。
 *
 * `out` 是「正在捎出，等回执」（ticket 26）：这类件**不可撤**——东西可能已经在
 * 对方磁盘上了。收到回执才 `confirmOut` 删掉；串门结束还没回执就 `releaseOutByVisit`
 * 退回 `idle`。启动时把遗留的 `out` 归一成 `idle`：那次串门不可能还活着。
 */

export const BACKPACK_FILE = 'backpack.json'
export const BACKPACK_VERSION = 1
export const MAX_BACKPACK_ITEMS = 2
/** 路径只在本机存在；上限只为让一条 IPC/一行 JSON 有界。 */
export const MAX_BACKPACK_PATH = 4096
const FALLBACK_FILE_NAME = 'file'

/** 文件件只接受本机绝对路径（POSIX 或 Windows 盘符）；相对路径没有意义。 */
export function normalizeBackpackPath (value) {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (path === '' || path.length > MAX_BACKPACK_PATH) return null
  if (path.includes('\u0000')) return null
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : null
}

/** 从路径取一个给人看的名字；清洗后为空就退成 `file`（名字不该让整件礼物作废）。 */
export function giftNameFromPath (filePath) {
  if (typeof filePath !== 'string') return FALLBACK_FILE_NAME
  const base = filePath.split(/[\\/]/).pop() ?? ''
  return sanitizeGiftName(base) ?? FALLBACK_FILE_NAME
}

/**
 * 读回来的单件白名单。形状不对返回 null（跳过这一件），绝不把坏字段带进内存。
 * `at` 是 FIFO 的唯一依据，所以必须是正数；缺失/非法就丢掉这一件。
 */
export function normalizeBackpackItem (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (!isVisitId(value.id)) return null
  const at = Number(value.at)
  if (!Number.isFinite(at) || at <= 0) return null
  const id = value.id.toLowerCase()
  // 只有 out 需要 visitId；形状不完整时按 idle 处理（启动归一化本来也会把它们放回去）。
  const out = value.state === 'out'
  const visitId = out && isVisitId(value.visitId) ? value.visitId.toLowerCase() : null
  const state = visitId === null ? 'idle' : 'out'

  if (value.kind === 'text') {
    const text = sanitizeNote(value.text)
    if (text === null) return null
    return { id, kind: 'text', text, at: Math.floor(at), state }
  }
  if (value.kind === 'file') {
    const path = normalizeBackpackPath(value.path)
    if (path === null) return null
    const name = sanitizeGiftName(value.name) ?? giftNameFromPath(path)
    return { id, kind: 'file', path, name, at: Math.floor(at), state }
  }
  return null
}

/**
 * 读整份背包。返回 `{ items, dropped, corrupt }`：
 *   - `corrupt` = 文件不是对象/数组或版本不认识，调用方按空背包处理并告警一次；
 *   - 坏单件只让 `dropped` 加一；
 *   - 超过两件时按 `at` 留最旧的两件（先放的先带走）。
 */
export function normalizeBackpackFile (value) {
  if (value === null || typeof value !== 'object') {
    return { items: [], dropped: 0, corrupt: true }
  }
  if (!Array.isArray(value) && value.version !== undefined && value.version !== BACKPACK_VERSION) {
    return { items: [], dropped: 0, corrupt: true }
  }
  // 正常写 { version, items }；手改成裸数组也认，容错优先（与 visits.json 同一条约定）。
  const list = Array.isArray(value) ? value : value.items
  if (!Array.isArray(list)) return { items: [], dropped: 0, corrupt: true }

  const items = []
  const seen = new Set()
  let dropped = 0
  for (const candidate of list) {
    const item = normalizeBackpackItem(candidate)
    if (item === null || seen.has(item.id)) {
      dropped += 1
      continue
    }
    seen.add(item.id)
    items.push(item)
  }
  items.sort(compareItems)
  if (items.length > MAX_BACKPACK_ITEMS) {
    dropped += items.length - MAX_BACKPACK_ITEMS
    items.length = MAX_BACKPACK_ITEMS
  }
  return { items, dropped, corrupt: false }
}

/**
 * 放进背包的入参白名单（纯函数）：`{kind:'text',text}` 或 `{kind:'file',path}`。
 * 这里只做形状与文本校验；文件存不存在、是不是目录、多大，要由 store 去 `stat`。
 *
 * 错误码按 SPEC：bad-gift（形状/文本非法）、no-such-file、too-large、backpack-full。
 */
export function normalizeBringInput (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'bad-gift' }
  }
  if (value.kind === 'text') {
    const text = sanitizeNote(value.text)
    if (text === null) return { ok: false, error: 'bad-gift' }
    return { ok: true, item: { kind: 'text', text } }
  }
  if (value.kind === 'file') {
    const path = normalizeBackpackPath(value.path)
    if (path === null) return { ok: false, error: 'bad-gift' }
    return { ok: true, item: { kind: 'file', path } }
  }
  return { ok: false, error: 'bad-gift' }
}

/** 下一件的 `at`：同一毫秒里连放两件也要能排出先后（FIFO 不能靠运气）。 */
export function nextItemAt (items, now = Date.now()) {
  let latest = 0
  for (const item of Array.isArray(items) ? items : []) {
    if (Number.isFinite(item?.at) && item.at > latest) latest = item.at
  }
  return Math.max(now, latest + 1)
}

/** 背包里下一件要带走的：`at` 最小的 **idle** 件；没有就 null。 */
export function oldestIdleItem (items) {
  let oldest = null
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object' || item.state !== 'idle') continue
    if (oldest === null || compareItems(item, oldest) < 0) oldest = item
  }
  return oldest === null ? null : copyItem(oldest)
}

function compareItems (left, right) {
  if (left.at !== right.at) return left.at - right.at
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function copyItem (item) {
  return item.kind === 'file'
    ? { id: item.id, kind: 'file', path: item.path, name: item.name, at: item.at, state: item.state }
    : { id: item.id, kind: 'text', text: item.text, at: item.at, state: item.state }
}

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}

/** 读盘 + 归一化；任何失败都降级成空背包，不影响串门/桌面启动。 */
export async function createBackpackStore (dir, { log } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('backpack: missing data directory')
  const store = new BackpackStore({ dir, log })
  await store.load()
  return store
}

class BackpackStore {
  #dir
  #log
  /** 内存里按 `at` 升序（先放的在前）。 */
  #items = []
  #warned = new Set()
  /** 串行化写盘：同一毫秒里两次 bring 不能互相写掉对方的条目。 */
  #chain = Promise.resolve()

  constructor ({ dir, log }) {
    this.#dir = dir
    this.#log = log
  }

  async load () {
    let text
    try {
      text = await readFile(join(this.#dir, BACKPACK_FILE), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warnOnce('read', '背包读不出来，先按空背包运行（' + errorName(error) + '）')
      }
      return
    }

    let raw
    try {
      raw = parseJsonText(text)
    } catch {
      this.#warnOnce('parse', '背包不是合法 JSON，先按空背包运行')
      return
    }
    const normalized = normalizeBackpackFile(raw)
    if (normalized.corrupt) {
      this.#warnOnce('shape', '背包形状不对，先按空背包运行')
      return
    }
    if (normalized.dropped > 0) {
      this.#warnOnce('entries', '背包里有 ' + normalized.dropped + ' 件格式不对或超出两件的条目，已跳过')
    }

    // 启动归一化：上次进程退出时还标着 out 的，那次串门不可能还在等回执。
    let released = 0
    this.#items = normalized.items.map((item) => {
      if (item.state !== 'out') return item
      released += 1
      return { ...item, state: 'idle' }
    })
    if (released > 0) {
      // 写失败只告警一次（#persist 内部做），内存状态仍然是 idle。
      await this.#persist()
    }
  }

  /** 只读副本（按 at 升序）。窗口/action 都只拿这一份，不拿内部引用。 */
  items () {
    return this.#items.map(copyItem)
  }

  count () {
    return this.#items.length
  }

  /** 下一件要走的（idle，at 最小）；只读，不改状态。 */
  oldestIdle () {
    return oldestIdleItem(this.#items)
  }

  /**
   * 放进背包。`input` 走 `normalizeBringInput` 白名单；文件件在这里才 stat（不读内容）。
   * 满了直接拒绝，绝不挤掉旧的那件。
   */
  add (input) {
    return this.#enqueue(() => this.#add(input))
  }

  async #add (input) {
    const clean = normalizeBringInput(input)
    if (!clean.ok) return { ...clean, persisted: false }
    if (this.#items.length >= MAX_BACKPACK_ITEMS) {
      return { ok: false, error: 'backpack-full', persisted: false }
    }

    const at = nextItemAt(this.#items)
    let item
    if (clean.item.kind === 'text') {
      item = {
        id: randomUUID(),
        kind: 'text',
        text: clean.item.text,
        at,
        state: 'idle'
      }
    } else {
      const path = clean.item.path
      let info
      try {
        info = await stat(path)
      } catch {
        return { ok: false, error: 'no-such-file', persisted: false }
      }
      if (!info.isFile()) return { ok: false, error: 'no-such-file', persisted: false }
      if (info.size > MAX_GIFT_BYTES) return { ok: false, error: 'too-large', persisted: false }
      // 0 字节文件没有内容可送，接收端的 sha256 也没有意义；按坏礼物拒绝。
      if (info.size <= 0) return { ok: false, error: 'bad-gift', persisted: false }
      item = {
        id: randomUUID(),
        kind: 'file',
        path,
        name: giftNameFromPath(path),
        at,
        state: 'idle'
      }
    }

    this.#items.push(item)
    this.#items.sort(compareItems)
    const persisted = await this.#persist()
    return { ok: true, item: copyItem(item), count: this.#items.length, persisted }
  }

  /** 撤掉一件：只有 idle 能撤；out 中的东西可能已经在对方磁盘上了。 */
  remove (giftId) {
    return this.#enqueue(() => this.#remove(giftId))
  }

  async #remove (giftId) {
    if (!isVisitId(giftId)) return { ok: false, error: 'bad-gift', persisted: false }
    const id = giftId.toLowerCase()
    const index = this.#items.findIndex((item) => item.id === id)
    if (index < 0) return { ok: false, error: 'gift-not-found', persisted: false }
    if (this.#items[index].state === 'out') return { ok: false, error: 'gift-out', persisted: false }
    const [removed] = this.#items.splice(index, 1)
    const persisted = await this.#persist()
    return { ok: true, item: copyItem(removed), count: this.#items.length, persisted }
  }

  /** 出门带走：把这一件标成 out（带 visitId）。只有 idle 能出门。 */
  markOut (giftId, visitId) {
    return this.#enqueue(() => this.#markOut(giftId, visitId))
  }

  async #markOut (giftId, visitId) {
    if (!isVisitId(giftId) || !isVisitId(visitId)) return { ok: false, error: 'bad-gift', persisted: false }
    const item = this.#items.find((candidate) => candidate.id === giftId.toLowerCase())
    if (item === undefined) return { ok: false, error: 'gift-not-found', persisted: false }
    if (item.state === 'out') return { ok: false, error: 'gift-out', persisted: false }
    item.state = 'out'
    item.visitId = visitId.toLowerCase()
    const persisted = await this.#persist()
    return { ok: true, item: copyItem(item), persisted }
  }

  /**
   * 没发出去/整包超限被编码层丢掉：这一件还在本机，退回 idle。
   * 真正「到了对方家但没回执」的退包走 `releaseOutByVisit`（ticket 26）。
   */
  releaseOut (giftId, visitId = null) {
    return this.#enqueue(() => this.#releaseOut(giftId, visitId))
  }

  async #releaseOut (giftId, visitId) {
    if (!isVisitId(giftId)) return { ok: false, error: 'bad-gift', persisted: false }
    const item = this.#items.find((candidate) => candidate.id === giftId.toLowerCase())
    if (item === undefined) return { ok: false, error: 'gift-not-found', persisted: false }
    if (item.state !== 'out') return { ok: false, error: 'not-out', persisted: false }
    if (visitId !== null && item.visitId !== visitId.toLowerCase()) {
      return { ok: false, error: 'not-out', persisted: false }
    }
    item.state = 'idle'
    delete item.visitId
    const persisted = await this.#persist()
    return { ok: true, item: copyItem(item), persisted }
  }

  /**
   * 收到回执（ticket 26）：**删掉**这一件（不是退回 idle）。
   * 只有 `out` 能这样删——idle 件走 `remove`，免得一条伪造的回执把还没出门的东西吃掉；
   * `visitId` 可选，给了就要求对得上（同一件礼物只可能属于一次串门）。
   */
  confirmOut (giftId, visitId = null) {
    return this.#enqueue(() => this.#confirmOut(giftId, visitId))
  }

  async #confirmOut (giftId, visitId) {
    if (!isVisitId(giftId)) return { ok: false, error: 'bad-gift', persisted: false }
    if (visitId !== null && !isVisitId(visitId)) return { ok: false, error: 'bad-visit-id', persisted: false }
    const id = giftId.toLowerCase()
    const index = this.#items.findIndex((item) => item.id === id)
    if (index < 0) return { ok: false, error: 'gift-not-found', persisted: false }
    const item = this.#items[index]
    if (item.state !== 'out') return { ok: false, error: 'not-out', persisted: false }
    if (visitId !== null && item.visitId !== visitId.toLowerCase()) {
      return { ok: false, error: 'not-out', persisted: false }
    }
    this.#items.splice(index, 1)
    const persisted = await this.#persist()
    return { ok: true, item: copyItem({ ...item, state: 'idle' }), count: this.#items.length, persisted }
  }

  /**
   * 串门结束还没收到回执（ticket 26）：把这次带出去的 `out` 件全部退回 `idle`。
   *
   * 按 `visitId` 而不是 giftId 回退，是因为结束点只知道串门 id（回家 / 送客 / 到期 /
   * 失联 / 被对方 recall 都可能发生在收到回执之前）。返回 `{ ok, released: [...] }`；
   * 一件都没有（比如回执已经先到了）就是 `ok:false, released: []`——调用方据此不重复提示。
   */
  releaseOutByVisit (visitId) {
    return this.#enqueue(() => this.#releaseOutByVisit(visitId))
  }

  async #releaseOutByVisit (visitId) {
    if (!isVisitId(visitId)) return { ok: false, error: 'bad-visit-id', released: [], persisted: false }
    const id = visitId.toLowerCase()
    const released = []
    for (const item of this.#items) {
      if (item.state !== 'out' || item.visitId !== id) continue
      item.state = 'idle'
      delete item.visitId
      released.push(copyItem(item))
    }
    if (released.length === 0) {
      return { ok: false, error: 'not-out', released: [], persisted: false }
    }
    const persisted = await this.#persist()
    return { ok: true, released, count: this.#items.length, persisted }
  }

  /**
   * 发送那一刻的礼物元数据。文件件此刻才 stat + sha256：
   * 用户可能在放进背包之后改过/删过它，背包里只有路径这一份事实。
   *
   * 返回 `{ ok, gift }` 或 `{ ok:false, error: no-such-file|too-large|bad-gift|unreadable }`。
   * 失败**不**改背包状态——调用方让这次串门空手出门，东西留在背包里。
   */
  async prepareGift (item) {
    if (item === null || typeof item !== 'object') return { ok: false, error: 'bad-gift' }
    if (item.kind === 'text') {
      const text = sanitizeNote(item.text)
      if (text === null) return { ok: false, error: 'bad-gift' }
      return {
        ok: true,
        gift: { id: item.id, kind: 'text', text }
      }
    }
    if (item.kind !== 'file' || typeof item.path !== 'string') {
      return { ok: false, error: 'bad-gift' }
    }

    let info
    try {
      info = await stat(item.path)
    } catch {
      return { ok: false, error: 'no-such-file' }
    }
    if (!info.isFile()) return { ok: false, error: 'no-such-file' }
    if (info.size > MAX_GIFT_BYTES) return { ok: false, error: 'too-large' }
    if (info.size <= 0) return { ok: false, error: 'bad-gift' }

    let hashed
    try {
      hashed = await hashFile(item.path)
    } catch {
      return { ok: false, error: 'unreadable' }
    }
    if (hashed.error !== undefined) return { ok: false, error: hashed.error }
    if (hashed.bytes <= 0) return { ok: false, error: 'bad-gift' }
    return {
      ok: true,
      gift: {
        id: item.id,
        kind: 'file',
        name: item.name,
        // 用实际读到的字节数：文件在 stat 与读之间被改过时，size 与 sha256 仍然自洽。
        size: hashed.bytes,
        sha256: 'sha256:' + hashed.hash
      }
    }
  }

  #enqueue (task) {
    const run = this.#chain.then(task, task)
    this.#chain = run.then(() => {}, () => {})
    return run
  }

  /**
   * 先改内存再落盘；返回 false 只表示“重启后可能丢”，不影响本次运行。
   *
   * 写盘不再另外起一条链：所有改内存的入口都已经过 `#enqueue` 串起来，
   * 在这里再串一次会等自己（当前任务就是链尾）。`load()` 里的归一化写发生在
   * 任何调用方拿到 store 之前，所以也不与它并发。
   */
  #persist () {
    return this.#write()
  }

  async #write () {
    const target = join(this.#dir, BACKPACK_FILE)
    const tmp = target + '.tmp-' + randomUUID()
    try {
      await mkdir(this.#dir, { recursive: true, mode: 0o700 })
      const body = JSON.stringify({
        version: BACKPACK_VERSION,
        items: this.#items.map((item) => item.kind === 'file'
          ? { id: item.id, kind: 'file', path: item.path, name: item.name, at: item.at, state: item.state, ...(item.state === 'out' ? { visitId: item.visitId } : {}) }
          : { id: item.id, kind: 'text', text: item.text, at: item.at, state: item.state, ...(item.state === 'out' ? { visitId: item.visitId } : {}) })
      }, null, 2) + '\n'
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
      // 同目录 rename 是原子的：不会留下半个背包文件，也不会读到写了一半的 JSON。
      await rename(tmp, target)
      return true
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      this.#warnOnce('write', '背包写不进去：本次运行仍然能用，但重启后可能丢（' + errorName(error) + '）')
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

/**
 * 文件内容的 sha256。边读边算，不把 16 MiB 整个搬进内存；
 * 超过上限立刻停（防止 stat 之后文件突然变成几个 GB）。
 */
function hashFile (path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let bytes = 0
    const stream = createReadStream(path)
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      if (result.error !== undefined) {
        stream.destroy()
        resolve(result)
        return
      }
      resolve(result)
    }
    stream.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_GIFT_BYTES) {
        finish({ error: 'too-large' })
        return
      }
      hash.update(chunk)
    })
    stream.on('end', () => finish({ bytes, hash: hash.digest('hex') }))
    stream.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}
