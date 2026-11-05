import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MAX_GIFT_BYTES,
  isDeviceId,
  isVisitId,
  normalizeNickname,
  sanitizeGiftName,
  sanitizeNote
} from './protocol.js'

/**
 * 入站礼物的落盘：`<dataDir>/gifts/<dir>/note.txt` + `meta.json`。
 *
 * 目录名的选择（SPEC v4 的两处说法在票 23 里这样统一）：
 *   - **wire 上的 `gift.id` 是 UUID**（复用 `isVisitId`），也是 action 里唯一的键；
 *   - 磁盘目录用人能读的时间前缀：`20261103-153245-ab12cd12`（`receivedAt` 的本地时间 +
 *     id 前 8 位），`meta.json` 里同时记 `id` 与 `dir`。这样在 Finder 里翻 `gifts/`
 *     能看出“什么时候收到的”，而所有查找仍然只按 UUID。
 *
 * 安全与容错：
 *   - 拼路径只用**校验过的目录名**（`^\\d{8}-\\d{6}-[0-9a-f]{8}(-\\d+)?$`），
 *     报文里的任何字符串都不会进 `join()`；
 *   - 两个文件都先写同目录的 `.tmp-<uuid>` 再 rename，不留半个文件；
 *   - 文件坏了 / 读不出来只跳过那一条，告警一次；礼物坏了最多让一张卡变 `failed`，
 *     绝不把串门拖下水（ADR-0011）。
 *
 * 目录已存在时：同一 `gift.id` 的重试**原地覆盖**（幂等）；不同 id 撞名就加后缀，
 * 绝不覆盖别人已经收到的礼物。
 *
 * ticket 27 的磁盘限额：`gifts/` 总量 ≤500 MiB 且 ≤200 个目录；每次**新礼物写成功之后**
 * 剪一次，超了按 `receivedAt` 删最旧的整个目录。先写后剪的顺序是刻意的——限额再紧也不能
 * 让刚到的这一件写不进去。清理只删有合法 meta 的目录（以及能读出 meta 的目录），
 * 正在下载的目录一律跳过。
 *
 * 载入时另清一类：**没有有效 meta.json 且 mtime 超过 1 小时**的目录。拉取中断会留下
 * 只有 `.part` 的目录，`#pruneDisk` 按“不删陌生目录”的规矩永远不碰它们；载入这一刻
 * 还没有任何下载在进行，正好按年龄清掉。刚写了一半的新目录 mtime 很新，不会被误删。
 */

export const GIFTS_DIR = 'gifts'
export const NOTE_FILE = 'note.txt'
export const META_FILE = 'meta.json'
export const GIFT_META_VERSION = 1
/** 内存索引上限（/state 与 action 都只服务最近的礼物）；与磁盘目录数上限同一个数。 */
export const MAX_GIFT_INDEX = 200
/** `gifts/` 目录总量上限（SPEC v4「存储与限额」）：500 MiB。 */
export const MAX_GIFT_TOTAL_BYTES = 500 * 1024 * 1024
/** `gifts/` 目录数上限（SPEC v4「存储与限额」）：200 件。 */
export const MAX_GIFT_COUNT = MAX_GIFT_INDEX
/** 载入时清理“中断的下载目录”的年龄门槛：mtime 超过 1 小时才算孤儿。 */
export const ORPHAN_DIR_TTL_MS = 60 * 60 * 1000

/** 目录名：`20261103-153245-ab12cd12`，可读的时间前缀 + gift id 前 8 位。 */
const GIFT_DIR_RE = /^\d{8}-\d{6}-[0-9a-f]{8}(-\d+)?$/
const GIFT_HASH_RE = /^sha256:[0-9a-f]{64}$/
const FALLBACK_NICKNAME = '邻居'
const FALLBACK_FILE_NAME = 'file'

function pad (value, width = 2) {
  return String(value).padStart(width, '0')
}

/**
 * 由 `receivedAt` 的**本地时间**与 gift id 推出目录名。
 * 本地时间不是逻辑必需，但把人真正翻文件夹的那一刻变得可读；真正的键始终是 meta 里的 id。
 */
export function giftDirName (giftId, receivedAt) {
  if (!isVisitId(giftId)) return null
  const at = Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : Date.now()
  const date = new Date(at)
  const stamp = String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) + '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  return stamp + '-' + giftId.toLowerCase().slice(0, 8)
}

/** 合法的磁盘目录名（也是 load 与 discard 的唯一路径来源）。 */
export function isGiftDirName (value) {
  return typeof value === 'string' && GIFT_DIR_RE.test(value)
}

/** 目录名 → 绝对路径；非法名字返回 null，调用方据此拒绝，而不是拼一个奇怪的路径。 */
export function giftDirPath (dataDir, dirName) {
  if (typeof dataDir !== 'string' || dataDir === '') return null
  if (!isGiftDirName(dirName)) return null
  return join(dataDir, GIFTS_DIR, dirName)
}

/**
 * 读回来的 `meta.json` 白名单。形状不对返回 null，由 store 跳过并告警一次。
 * `version` 缺省容忍（手改过的老文件），但明确写了别的版本就不认。
 *
 * ticket 25 起认两种 kind：`text`（正文 + note.txt）与 `file`（name/size/sha256，
 * 本体是目录里的同名文件）。不认识的 kind（未来版本的新礼物）整条跳过。
 */
export function normalizeGiftMeta (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.version !== undefined && value.version !== GIFT_META_VERSION) return null
  if (!isVisitId(value.id)) return null
  if (!isGiftDirName(value.dir)) return null
  const from = value.from
  if (from === null || typeof from !== 'object' || Array.isArray(from)) return null
  if (!isDeviceId(from.deviceId)) return null
  const receivedAt = Number(value.receivedAt)
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) return null
  const sender = {
    deviceId: from.deviceId.toLowerCase(),
    nickname: normalizeNickname(from.nickname) ?? FALLBACK_NICKNAME
  }

  if (value.kind === 'text') {
    const text = sanitizeNote(value.text)
    if (text === null) return null
    return {
      id: value.id.toLowerCase(),
      dir: value.dir,
      from: sender,
      kind: 'text',
      text,
      receivedAt: Math.floor(receivedAt),
      opened: value.opened === true
    }
  }

  if (value.kind === 'file') {
    // meta 里必须有可显示的名字：空名/带路径分隔符的名字说明这份 meta 不是本店写的，跳过。
    const name = sanitizeGiftName(value.name)
    if (name === null) return null
    const size = Number(value.size)
    if (!Number.isInteger(size) || size <= 0 || size > MAX_GIFT_BYTES) return null
    if (typeof value.sha256 !== 'string' || !GIFT_HASH_RE.test(value.sha256)) return null
    return {
      id: value.id.toLowerCase(),
      dir: value.dir,
      from: sender,
      kind: 'file',
      name,
      size,
      sha256: value.sha256,
      receivedAt: Math.floor(receivedAt),
      opened: value.opened === true
    }
  }

  return null
}

/**
 * `maxTotalBytes` / `maxCount` 只给单测把 500 MiB / 200 件缩小到能跑的量；
 * 生产调用方（service）不传，就是 SPEC 的默认值。
 */
export async function createGiftStore (dir, {
  log,
  maxTotalBytes = MAX_GIFT_TOTAL_BYTES,
  maxCount = MAX_GIFT_COUNT
} = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('gifts: missing data directory')
  const store = new GiftStore({ dir, log, maxTotalBytes, maxCount })
  await store.load()
  return store
}

class GiftStore {
  #dir
  #log
  #maxTotalBytes
  #maxCount
  /** giftId（小写 UUID）→ 记录；记录里的 dir/路径只由校验过的目录名拼出来。 */
  #index = new Map()
  /**
   * 正在下载的文件礼物：giftId → { dirName, dirPath, filePath, created }。
   * 目录先分配、下载在锁外进行；同一件礼物的重试复用同一个落点，不另开目录。
   */
  #pendingFiles = new Map()
  #warned = new Set()
  /**
   * 串行化所有写操作。同一个 gift.id 的重试报文可能先后脚到达：两条异步链都先看到
   * “目录还不存在”，就会各建一个目录（第二条加后缀）。串起来之后第二条看到的是
   * 第一条写好的索引，原地覆盖——幂等这件事必须在**异步并发**下也成立。
   */
  #chain = Promise.resolve()

  constructor ({ dir, log, maxTotalBytes, maxCount }) {
    this.#dir = dir
    this.#log = log
    this.#maxTotalBytes = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0
      ? maxTotalBytes
      : MAX_GIFT_TOTAL_BYTES
    this.#maxCount = Number.isInteger(maxCount) && maxCount > 0 ? maxCount : MAX_GIFT_COUNT
  }

  #enqueue (task) {
    const run = this.#chain.then(task, task)
    this.#chain = run.then(() => {}, () => {})
    return run
  }

  /** 启动时把已经收到的礼物读回索引；坏一条只跳过那一条。 */
  async load () {
    const giftsDir = join(this.#dir, GIFTS_DIR)
    let entries
    try {
      entries = await readdir(giftsDir, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#warnOnce('read', '礼物目录读不出来，本次按“没有礼物”运行（' + errorName(error) + '）')
      }
      return
    }

    let dropped = 0
    let pruned = 0
    const now = Date.now()
    for (const entry of entries) {
      if (!entry.isDirectory() || !isGiftDirName(entry.name)) continue
      const dirPath = join(giftsDir, entry.name)
      let raw = null
      try {
        raw = JSON.parse(await readFile(join(dirPath, META_FILE), 'utf8'))
      } catch {
        // 缺 meta / 坏 JSON：先当成“没有有效 meta”，下面再按年龄决定清不清。
      }
      const meta = raw === null ? null : normalizeGiftMeta(raw)
      // meta 里的 dir 必须就是所在的目录：防一份复制来的 meta 指向别处。
      if (meta === null || meta.dir !== entry.name) {
        // 拉取中断留下的 .part 目录：没有有效 meta，mtime 又超过 1 小时 = 没人还在写。
        // 新开/刚写了一半的目录 mtime 很新，这里绝不动它们。
        if (await isStaleGiftOrphan(dirPath, now)) {
          try {
            await rm(dirPath, { recursive: true, force: true })
            pruned += 1
            continue
          } catch {
            // 删不掉就按普通坏目录跳过；下次载入再试。
          }
        }
        dropped += 1
        continue
      }
      this.#index.set(meta.id, this.#record(meta.id, meta))
    }
    if (pruned > 0) {
      this.#warnOnce(
        'orphan',
        '清掉了 ' + pruned + ' 个中断的下载目录（没有有效 meta.json 且超过 1 小时）'
      )
    }
    if (dropped > 0) {
      this.#warnOnce('meta', '礼物目录里有 ' + dropped + ' 份 meta.json 读不出来，已跳过（东西还在磁盘上）')
    }
    this.#pruneIndex()
  }

  /** 只读副本；找不到返回 null。 */
  lookup (giftId) {
    if (!isVisitId(giftId)) return null
    const record = this.#index.get(giftId.toLowerCase())
    return record === undefined ? null : copyRecord(record)
  }

  /** 最近的礼物，最新在前（/dsh-zoo/state 用，ticket 27 接）。 */
  list () {
    return [...this.#index.values()]
      .map(copyRecord)
      .sort((left, right) => right.receivedAt - left.receivedAt)
  }

  /**
   * 收下一张字条：写 `note.txt` + `meta.json`。
   * 任何失败都只回 `{ ok:false }`，由调用方把卡片标成 failed；异常绝不冒到串门流程里。
   */
  receiveText (input = {}) {
    return this.#enqueue(() => this.#receiveText(input))
  }

  async #receiveText ({ id, from, text, receivedAt } = {}) {
    if (!isVisitId(id)) return { ok: false, error: 'bad-gift' }
    const giftId = id.toLowerCase()
    const note = sanitizeNote(text)
    const deviceId = isDeviceId(from?.deviceId) ? from.deviceId.toLowerCase() : null
    if (note === null || deviceId === null) return { ok: false, error: 'bad-gift' }
    const nickname = normalizeNickname(from?.nickname) ?? FALLBACK_NICKNAME
    const at = Number.isFinite(receivedAt) && receivedAt > 0 ? Math.floor(receivedAt) : Date.now()

    const existing = this.#index.get(giftId)
    let allocated = null
    try {
      if (existing !== undefined) {
        allocated = { dirPath: existing.dirPath, dirName: existing.dirName, created: false }
      } else {
        await mkdir(join(this.#dir, GIFTS_DIR), { recursive: true, mode: 0o700 })
        allocated = await allocateDir(join(this.#dir, GIFTS_DIR), giftDirName(giftId, at), giftId)
      }
      const meta = {
        version: GIFT_META_VERSION,
        id: giftId,
        dir: allocated.dirName,
        from: { deviceId, nickname },
        kind: 'text',
        text: note,
        receivedAt: at,
        // 同一件礼物被重发/重试时保留“已经打开过”，不该又变回没看过。
        opened: existing?.opened === true
      }
      await writeFileAtomic(join(allocated.dirPath, NOTE_FILE), note + '\n')
      await writeFileAtomic(join(allocated.dirPath, META_FILE), JSON.stringify(meta, null, 2) + '\n')

      const record = this.#record(giftId, {
        id: giftId,
        dir: allocated.dirName,
        from: meta.from,
        kind: 'text',
        text: note,
        receivedAt: at,
        opened: meta.opened
      })
      this.#index.set(giftId, record)
      await this.#pruneDisk(allocated.dirName)
      this.#pruneIndex()
      return { ok: true, gift: copyRecord(record) }
    } catch (error) {
      // 只清掉这次新开的目录；已有礼物（重试写失败）留原样，别把上次那份也删了。
      if (allocated?.created === true) {
        await rm(allocated.dirPath, { recursive: true, force: true }).catch(() => {})
      }
      this.#warnOnce('write', '礼物写不进去，这张卡片会显示“没取到”（' + errorName(error) + '）')
      return { ok: false, error: 'write' }
    }
  }

  /**
   * 收下一件文件礼物的**第一步**：分配目录，返回最终文件名（`<dir>/<name>`）。
   * 这里不写 meta、不进索引；下载成功后再 `finishFile`，失败就 `abortFile` 清场。
   * 同一 giftId 的重试复用同一个落点，绝不另开一个目录。
   */
  beginFile (input = {}) {
    return this.#enqueue(() => this.#beginFile(input))
  }

  async #beginFile (input) {
    const clean = normalizeFileGift(input)
    if (!clean.ok) return clean
    const pending = this.#pendingFiles.get(clean.giftId)
    if (pending !== undefined) return { ok: true, ...pending }
    const existing = this.#index.get(clean.giftId)
    if (existing !== undefined) {
      return {
        ok: true,
        dirName: existing.dirName,
        dirPath: existing.dirPath,
        filePath: existing.filePath,
        created: false,
        existing: true
      }
    }
    try {
      await mkdir(join(this.#dir, GIFTS_DIR), { recursive: true, mode: 0o700 })
      const allocated = await allocateDir(
        join(this.#dir, GIFTS_DIR),
        giftDirName(clean.giftId, clean.receivedAt),
        clean.giftId
      )
      const slot = {
        dirName: allocated.dirName,
        dirPath: allocated.dirPath,
        filePath: join(allocated.dirPath, clean.name),
        created: allocated.created
      }
      this.#pendingFiles.set(clean.giftId, slot)
      return { ok: true, ...slot }
    } catch (error) {
      this.#warnOnce('write', '礼物目录建不出来，这张卡片会显示“没取到”（' + errorName(error) + '）')
      return { ok: false, error: 'write' }
    }
  }

  /**
   * 收下一件文件礼物的**第二步**：文件已经 rename 到位，写 meta.json 并进索引。
   * meta 写失败只回 `{ ok:false, error:'write' }`，由调用方把卡片标成 failed。
   */
  finishFile (input = {}) {
    return this.#enqueue(() => this.#finishFile(input))
  }

  async #finishFile (input) {
    const clean = normalizeFileGift(input)
    if (!clean.ok) return clean
    let slot = this.#pendingFiles.get(clean.giftId)
    if (slot === undefined) {
      const existing = this.#index.get(clean.giftId)
      if (existing !== undefined) return { ok: true, gift: copyRecord(existing) }
      const allocated = await this.#beginFile(input)
      if (!allocated.ok) return allocated
      slot = { dirName: allocated.dirName, dirPath: allocated.dirPath, filePath: allocated.filePath, created: allocated.created }
    }
    const existing = this.#index.get(clean.giftId)
    const meta = {
      version: GIFT_META_VERSION,
      id: clean.giftId,
      dir: slot.dirName,
      from: clean.from,
      kind: 'file',
      name: clean.name,
      size: clean.size,
      sha256: clean.sha256,
      receivedAt: clean.receivedAt,
      // 重试不该把“已经打开过”抹掉。
      opened: existing?.opened === true
    }
    try {
      await writeFileAtomic(join(slot.dirPath, META_FILE), JSON.stringify(meta, null, 2) + '\n')
      const record = this.#record(clean.giftId, meta)
      this.#index.set(clean.giftId, record)
      this.#pendingFiles.delete(clean.giftId)
      await this.#pruneDisk(slot.dirName)
      this.#pruneIndex()
      return { ok: true, gift: copyRecord(record) }
    } catch (error) {
      this.#warnOnce('write', '礼物写不进去，这张卡片会显示“没取到”（' + errorName(error) + '）')
      return { ok: false, error: 'write' }
    }
  }

  /** 下载失败：把这次新开的目录整目录删掉（已有礼物/别的目录一概不动）。 */
  abortFile (giftId) {
    return this.#enqueue(() => this.#abortFile(giftId))
  }

  async #abortFile (giftId) {
    if (!isVisitId(giftId)) return false
    const id = giftId.toLowerCase()
    const slot = this.#pendingFiles.get(id)
    if (slot === undefined) return false
    this.#pendingFiles.delete(id)
    if (slot.created === true && !this.#index.has(id)) {
      await rm(slot.dirPath, { recursive: true, force: true }).catch(() => {})
    }
    return true
  }

  /** 「打开」成功后记一笔；写不进 meta 不影响东西已经被系统打开。 */
  markOpened (giftId) {
    return this.#enqueue(() => this.#markOpened(giftId))
  }

  async #markOpened (giftId) {
    if (!isVisitId(giftId)) return false
    const record = this.#index.get(giftId.toLowerCase())
    if (record === undefined) return false
    if (record.opened) return true
    const meta = record.kind === 'file'
      ? {
          version: GIFT_META_VERSION,
          id: record.id,
          dir: record.dirName,
          from: { ...record.from },
          kind: 'file',
          name: record.name,
          size: record.size,
          sha256: record.sha256,
          receivedAt: record.receivedAt,
          opened: true
        }
      : {
          version: GIFT_META_VERSION,
          id: record.id,
          dir: record.dirName,
          from: { ...record.from },
          kind: 'text',
          text: record.text,
          receivedAt: record.receivedAt,
          opened: true
        }
    try {
      await writeFileAtomic(record.metaPath, JSON.stringify(meta, null, 2) + '\n')
      record.opened = true
      return true
    } catch (error) {
      this.#warnOnce('opened', '礼物的 opened 标记没写进去（东西本身还在）' + '（' + errorName(error) + '）')
      return false
    }
  }

  /** 扔掉 = 立即整目录删除；磁盘删掉了才从索引里拿掉，失败时卡片仍在、还能重试。 */
  discard (giftId) {
    return this.#enqueue(() => this.#discard(giftId))
  }

  async #discard (giftId) {
    if (!isVisitId(giftId)) return { ok: false, error: 'bad-gift' }
    const id = giftId.toLowerCase()
    const record = this.#index.get(id)
    if (record === undefined) return { ok: false, error: 'gift-not-found' }
    try {
      await rm(record.dirPath, { recursive: true, force: true })
    } catch (error) {
      this.#warnOnce('discard', '礼物删不掉（' + errorName(error) + '）')
      return { ok: false, error: 'write' }
    }
    this.#index.delete(id)
    return { ok: true }
  }

  /**
   * 只从索引里忘掉（helper 已经代为删除目录时用）。
   * 卡片立刻消失，但不假装磁盘已经干净——那条事实由 helper 的删除负责。
   */
  forget (giftId) {
    if (!isVisitId(giftId)) return false
    return this.#index.delete(giftId.toLowerCase())
  }

  #record (giftId, meta) {
    const dirPath = giftDirPath(this.#dir, meta.dir)
    const base = {
      id: giftId,
      dirName: meta.dir,
      dirPath,
      notePath: join(dirPath, NOTE_FILE),
      metaPath: join(dirPath, META_FILE),
      from: { ...meta.from },
      receivedAt: meta.receivedAt,
      opened: meta.opened === true
    }
    if (meta.kind === 'file') {
      return {
        ...base,
        kind: 'file',
        name: meta.name,
        size: meta.size,
        sha256: meta.sha256,
        // 本体就是目录里的同名文件；名字已经过 sanitizeGiftName，绝不含路径分隔符。
        filePath: join(dirPath, meta.name)
      }
    }
    return { ...base, kind: 'text', text: meta.text, filePath: null }
  }

  /**
   * 磁盘限额：扫描 `gifts/`，超了按 `receivedAt` 从旧到新整目录删。
   *
   * 三个“绝不”：
   *   - 绝不删刚写进来的这一件（`keepDirName`）——先写后剪就是为了它一定能落盘；
   *   - 绝不删正在下载的目录（`#pendingFiles` 里还有它的落点）；
   *   - 绝不删没有合法 meta 的陌生目录（读不出 `receivedAt` 就不知道谁更旧）；
   *     载入时的孤儿清理是唯一的例外，见 `load()`。
   * 清理失败只告警一次，不影响这次收礼物。
   */
  async #pruneDisk (keepDirName = null) {
    // 清理只是“锦上添花”：任何意外都不能把刚写成功的这一件反判成 failed。
    try {
      await this.#pruneDiskOnce(keepDirName)
    } catch (error) {
      this.#warnOnce('prune', '礼物目录清理失败，gifts/ 可能继续变大（' + errorName(error) + '）')
    }
  }

  async #pruneDiskOnce (keepDirName) {
    const giftsDir = join(this.#dir, GIFTS_DIR)
    let entries
    try {
      entries = await readdir(giftsDir, { withFileTypes: true })
    } catch {
      return
    }

    const pendingDirs = new Set([...this.#pendingFiles.values()].map((slot) => slot.dirName))
    const byDir = new Map()
    for (const record of this.#index.values()) byDir.set(record.dirName, record)

    const items = []
    let totalBytes = 0
    let count = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !isGiftDirName(entry.name)) continue
      const kept = entry.name === keepDirName
      const pending = pendingDirs.has(entry.name)
      const dirPath = join(giftsDir, entry.name)
      let record = byDir.get(entry.name) ?? null
      if (record === null) {
        // 内存索引只留最近 200 条；更旧的目录仍然在磁盘上，读 meta 才能按 receivedAt 排队。
        try {
          const meta = normalizeGiftMeta(JSON.parse(await readFile(join(dirPath, META_FILE), 'utf8')))
          if (meta !== null && meta.dir === entry.name) record = { ...meta, dirName: meta.dir, dirPath }
        } catch {
          // 陌生目录 / 坏 meta：不参与删除，也不影响其他目录。
        }
      }
      // 陌生目录（没有合法 meta、也不在下载中）不是本店写的：不计入限额，也绝不删。
      if (record === null && !kept && !pending) continue
      const bytes = await dirBytes(dirPath)
      totalBytes += bytes
      count += 1
      items.push({
        record,
        dirPath,
        bytes,
        receivedAt: record?.receivedAt ?? 0,
        deletable: !kept && !pending && record !== null
      })
    }

    items.sort((left, right) => left.receivedAt - right.receivedAt)
    let removed = 0
    for (const item of items) {
      if (totalBytes <= this.#maxTotalBytes && count <= this.#maxCount) break
      if (!item.deletable) continue
      try {
        await rm(item.dirPath, { recursive: true, force: true })
      } catch (error) {
        this.#warnOnce('prune', '旧礼物删不掉，gifts/ 可能继续变大（' + errorName(error) + '）')
        continue
      }
      this.#index.delete(item.record.id)
      totalBytes -= item.bytes
      count -= 1
      removed += 1
    }
    if (removed > 0) {
      this.#warnOnce('prune', '礼物目录超过限额，已按 receivedAt 删掉最旧的 ' + removed + ' 件')
    }
  }

  #pruneIndex () {
    if (this.#index.size <= MAX_GIFT_INDEX) return
    const overflow = [...this.#index.values()]
      .sort((left, right) => left.receivedAt - right.receivedAt)
      .slice(0, this.#index.size - MAX_GIFT_INDEX)
    for (const record of overflow) this.#index.delete(record.id)
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

/** 同一 giftId 重试原地复用；不同 id 撞名加后缀，绝不覆盖已有的礼物。 */
async function allocateDir (giftsDir, baseName, giftId) {
  const base = isGiftDirName(baseName) ? baseName : giftDirName(giftId, Date.now())
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const name = attempt === 0 ? base : base + '-' + String(attempt + 1)
    const dirPath = join(giftsDir, name)
    try {
      await mkdir(dirPath, { recursive: false, mode: 0o700 })
      return { dirPath, dirName: name, created: true }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const raw = JSON.parse(await readFile(join(dirPath, META_FILE), 'utf8'))
        if (raw?.id === giftId) return { dirPath, dirName: name, created: false }
      } catch {
        // 空目录或坏 meta：换后缀，别把别人的东西盖掉
      }
    }
  }
  throw new Error('gifts: directory name conflict')
}

/** tmp + rename：同目录内 rename 是原子的，不会留下半个 note.txt / meta.json。 */
async function writeFileAtomic (path, text) {
  const tmp = path + '.tmp-' + randomUUID()
  try {
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** 一个礼物目录里所有普通文件的总字节数；读不出来按 0 算，绝不因此中止清理。 */
async function dirBytes (dirPath) {
  let bytes = 0
  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      bytes += (await stat(join(dirPath, entry.name))).size
    } catch {
      // 文件刚被删/读不到：按 0 算，下一次写入还会重扫。
    }
  }
  return bytes
}

function copyRecord (record) {
  return {
    id: record.id,
    dirName: record.dirName,
    dirPath: record.dirPath,
    notePath: record.notePath,
    metaPath: record.metaPath,
    from: { ...record.from },
    kind: record.kind,
    text: record.text,
    name: record.name,
    size: record.size,
    sha256: record.sha256,
    filePath: record.filePath,
    receivedAt: record.receivedAt,
    opened: record.opened
  }
}

/**
 * 文件礼物入参白名单（store 与 service 共用同一套边界）：
 * id 是 UUID、from 是合法 deviceId、name 清洗过、size 在 1…16 MiB、sha256 形状正确。
 * 坏输入只回 `{ ok:false, error:'bad-gift' }`，绝不建目录。
 */
function normalizeFileGift (input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'bad-gift' }
  }
  if (!isVisitId(input.id)) return { ok: false, error: 'bad-gift' }
  const deviceId = isDeviceId(input.from?.deviceId) ? input.from.deviceId.toLowerCase() : null
  if (deviceId === null) return { ok: false, error: 'bad-gift' }
  const size = Number(input.size)
  if (!Number.isInteger(size) || size <= 0 || size > MAX_GIFT_BYTES) {
    return { ok: false, error: 'bad-gift' }
  }
  if (typeof input.sha256 !== 'string' || !GIFT_HASH_RE.test(input.sha256)) {
    return { ok: false, error: 'bad-gift' }
  }
  const receivedAt = Number(input.receivedAt)
  return {
    ok: true,
    giftId: input.id.toLowerCase(),
    from: {
      deviceId,
      nickname: normalizeNickname(input.from?.nickname) ?? FALLBACK_NICKNAME
    },
    name: sanitizeGiftName(input.name) ?? FALLBACK_FILE_NAME,
    size,
    sha256: input.sha256,
    receivedAt: Number.isFinite(receivedAt) && receivedAt > 0 ? Math.floor(receivedAt) : Date.now()
  }
}

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}

/**
 * 载入时的孤儿目录判定：没有有效 meta.json，且**目录本身的 mtime** 超过 1 小时。
 * 只用于 load（此时不可能有下载在进行）；运行中的 `#pruneDisk` 仍然不删陌生目录。
 */
async function isStaleGiftOrphan (dirPath, now = Date.now()) {
  try {
    return now - (await stat(dirPath)).mtimeMs > ORPHAN_DIR_TTL_MS
  } catch {
    return false
  }
}
