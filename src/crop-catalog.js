/**
 * 票 59：运行时的作物目录（ADR-0019）。
 *
 * 作物表以前是编译进 `farm-rules.js` 的常量。这一层把它变成**数据**：
 *
 *   内置六种         ← 包里的 `CROPS`，永远存在，是兜底
 *   本机 crops.json  ← `<dataDir>/crops.json` + `<dataDir>/crops/*.svg|png`，手写的，优先级最高
 *   网络收到的目录   ← 别的机器广播过来的定义（这一层先留好口子，见 ADR-0019）
 *
 * 这一层只做「校验、夹取、算哈希、合并」这些纯计算，加上两个薄的读写函数；
 * 不碰时钟、不碰网络、不直接改 `farm-rules`（应用目录是 service 的事）。
 *
 * 为什么要哈希：作物 id 会上网（地块、行情、偷菜回执）。两台机器给同一个 id 写了两套
 * 数值时，必须有一个人能不为到达顺序影响的赢法——按定义内容的哈希字典序小的胜。
 * 同一份内容在每台机器上算出同一个哈希，所以所有机器最终收敛到同一个定义。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat as statFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BUILTIN_CROPS } from './farm-rules.js'
import { parseJsonText } from './json-text.js'

export const CROPS_FILE = 'crops.json'
export const CROPS_DIR = 'crops'
export const CROP_CATALOG_FILE = 'crop-catalog.json'
export const CROP_ART_DIR = 'crop-art'
export const CROP_CATALOG_VERSION = 1

/** 目录最多认这么多种作物：再多就是配置写坏了，不是玩法。 */
export const MAX_CROPS = 64
export const MAX_CROP_NAME = 16
/** 一分钟以下算不出来「等它长」的乐趣；三十天以上等于永远长不完。 */
export const MIN_GROW_MS = 60 * 1000
export const MAX_GROW_MS = 30 * 24 * 60 * 60 * 1000
export const MIN_SEED_PRICE = 1
export const MAX_SEED_PRICE = 1_000_000
export const MIN_YIELD = 1
export const MAX_YIELD = 99
export const MIN_BASE = 1
export const MAX_BASE = 1_000_000
/** 单张图的上限：SVG 正常几 KB，256 KB 已经离谱；PNG 也够用。 */
export const MAX_ART_BYTES = 256 * 1024
export const ART_EXTENSIONS = Object.freeze(['svg', 'png'])

/** id 会进 `farm.json` 的键、行情表、协议字段：只认小写字母开头的短串。 */
export const CROP_ID_RE = /^[a-z][a-z0-9_-]{1,23}$/
const HEX16_RE = /^[0-9a-f]{16}$/

function clampInt (value, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const int = Math.floor(num)
  if (int < min || int > max) return null
  return int
}

/** 名字：去掉控制字符与首尾空白，太长直接判坏（不截断，免得两台机器算出不同哈希）。 */
function normalizeName (value) {
  if (typeof value !== 'string') return null
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
  if (name === '' || name.length > MAX_CROP_NAME) return null
  return name
}

/**
 * 一条作物定义。任何一个字段不合格就整条丢掉——**不做部分修补**：
 * 修补出来的数值两台机器可能修得不一样，哈希就对不上了。
 *
 * @returns {{id:string,name:string,growMs:number,seedPrice:number,yield:number,base:number}|null}
 */
export function normalizeCropDef (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!CROP_ID_RE.test(id)) return null
  const name = normalizeName(value.name)
  if (name === null) return null
  const growMs = clampInt(value.growMs, MIN_GROW_MS, MAX_GROW_MS)
  const seedPrice = clampInt(value.seedPrice, MIN_SEED_PRICE, MAX_SEED_PRICE)
  const yieldCount = clampInt(value.yield, MIN_YIELD, MAX_YIELD)
  const base = clampInt(value.base, MIN_BASE, MAX_BASE)
  if (growMs === null || seedPrice === null || yieldCount === null || base === null) return null
  return { id, name, growMs, seedPrice, yield: yieldCount, base }
}

/** 定义的内容哈希：字段固定顺序、只取会进结算的四个数 + 名字。 */
export function cropDefHash (def) {
  const normalized = normalizeCropDef(def)
  if (normalized === null) return null
  const canonical = JSON.stringify([
    normalized.id,
    normalized.name,
    normalized.growMs,
    normalized.seedPrice,
    normalized.yield,
    normalized.base
  ])
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 整份目录的指纹：beacon 里只带它，用来判断「要不要互相拉一次」。
 * 图也算进来（有图才有 art 哈希）：换了图、改了数值都会让指纹变，邻居才会重拉。
 */
export function catalogHash (defs) {
  const entries = (Array.isArray(defs) ? defs : [])
    .map((def) => {
      const hash = cropDefHash(def)
      if (hash === null) return null
      const artHash = normalizeArtRef(def?.art)?.hash ?? '-'
      return def.id + ':' + hash + ':' + artHash
    })
    .filter((line) => line !== null)
    .sort()
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 合并三层目录：内置 → 网络 → 本机。
 *
 * - 本机手写的永远赢（用户改的数值不该被邻居覆盖）；
 * - 网络与他人冲突时按 `defHash` 字典序小的赢（与到达顺序无关，所有机器收敛到同一份）；
 * - 内置条目可以被覆盖，但 id 不会消失（删掉定义会让地里的作物变空地）。
 *
 * @returns {{defs: Map<string, object>, sources: Map<string, string>, conflicts: string[]}}
 */
export function buildCatalog ({ builtin = BUILTIN_CROPS, remote = [], local = [] } = {}) {
  const defs = new Map()
  const sources = new Map()
  const conflicts = []

  for (const id of Object.keys(builtin)) {
    const def = normalizeCropDef(builtin[id])
    if (def === null) continue
    defs.set(def.id, def)
    sources.set(def.id, 'builtin')
  }

  for (const candidate of Array.isArray(remote) ? remote : []) {
    const def = normalizeCropDef(candidate)
    if (def === null) continue
    const current = defs.get(def.id)
    if (current === undefined) {
      if (defs.size >= MAX_CROPS) continue
      defs.set(def.id, def)
      sources.set(def.id, 'remote')
      continue
    }
    if (sources.get(def.id) === 'local') continue
    const nextHash = cropDefHash(def)
    const currentHash = cropDefHash(current)
    if (nextHash < currentHash) {
      defs.set(def.id, def)
      sources.set(def.id, 'remote')
      conflicts.push(def.id)
    } else if (nextHash !== currentHash) {
      conflicts.push(def.id)
    }
  }

  for (const candidate of Array.isArray(local) ? local : []) {
    const def = normalizeCropDef(candidate)
    if (def === null) continue
    if (!defs.has(def.id) && defs.size >= MAX_CROPS) continue
    defs.set(def.id, def)
    sources.set(def.id, 'local')
  }

  return { defs, sources, conflicts }
}

/** 目录按生长时长排（窗口的种子列表/行情页就是这个顺序），同长按 id。 */
export function catalogEntries (defs) {
  const list = []
  for (const def of (defs instanceof Map ? defs.values() : Object.values(defs ?? {}))) {
    if (def !== null && typeof def === 'object') list.push(def)
  }
  list.sort((left, right) => {
    if (left.growMs !== right.growMs) return left.growMs - right.growMs
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  return list
}

/**
 * 读本机手写的目录：`<dir>/crops.json` 加同名图目录。
 *
 * 文件的形状：
 *   { "version": 1, "crops": [ { "id": "blueberry", "name": "蓝莓", "growMs": 5400000,
 *     "seedPrice": 30, "yield": 4, "base": 18, "art": "blueberry.svg" } ] }
 *
 * 坏文件、坏条目都只丢自己：返回 warnings，由调用方记一条日志。图缺失不算错——
 * 窗口那边还有 emoji 兜底。
 *
 * @returns {Promise<{entries: object[], art: Map<string, {bytes: Buffer, ext: string}>, warnings: string[]}>}
 */
export async function readLocalCrops ({
  dir,
  readText = (path) => readFile(path, 'utf8'),
  readBytes = (path) => readFile(path)
} = {}) {
  const warnings = []
  const entries = []
  const art = new Map()
  if (typeof dir !== 'string' || dir === '') return { entries, art, warnings }

  let list = null
  try {
    const parsed = parseJsonText(await readText(join(dir, CROPS_FILE)))
    list = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' ? parsed.crops : null
  } catch (error) {
    // 没有这个文件是最常见的情况，不是错误；坏 JSON 才记一条。
    if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
      warnings.push(CROPS_FILE + ' 读不出来（不是合法 JSON？），忽略本机作物目录')
    }
    return { entries, art, warnings }
  }
  if (!Array.isArray(list)) {
    warnings.push(CROPS_FILE + ' 缺 crops 数组，忽略本机作物目录')
    return { entries, art, warnings }
  }

  const pairs = []
  const seen = new Set()
  for (const candidate of list.slice(0, MAX_CROPS + 1)) {
    const def = normalizeCropDef(candidate)
    if (def === null) {
      warnings.push('crops.json 里有一条作物不合格（id/名字/生长/价格/产量/底价），已跳过')
      continue
    }
    if (seen.has(def.id)) {
      warnings.push('crops.json 里 ' + def.id + ' 重复，只认第一条')
      continue
    }
    seen.add(def.id)
    pairs.push({ def, art: typeof candidate?.art === 'string' ? candidate.art.trim() : '' })
  }
  if (list.length > MAX_CROPS) warnings.push('crops.json 超过 ' + MAX_CROPS + ' 种作物，多余的忽略')

  const artDir = join(dir, CROPS_DIR)
  for (const pair of pairs) {
    entries.push(pair.def)
    const candidates = pair.art === '' ? [] : [pair.art]
    for (const ext of ART_EXTENSIONS) candidates.push(pair.def.id + '.' + ext)
    for (const name of candidates) {
      if (name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
        if (name !== '') warnings.push('作物图只认本目录下的文件名：' + name)
        continue
      }
      const dot = name.lastIndexOf('.')
      const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
      if (!ART_EXTENSIONS.includes(ext)) continue
      let bytes = null
      try {
        bytes = await readBytes(join(artDir, name))
      } catch {
        continue
      }
      if (bytes === null || bytes.length === 0) continue
      if (bytes.length > MAX_ART_BYTES) {
        warnings.push('作物图太大（>' + Math.round(MAX_ART_BYTES / 1024) + ' KB）：' + name + '，已忽略')
        continue
      }
      if (ext === 'svg' && /<script[\s>]/i.test(bytes.toString('utf8', 0, Math.min(bytes.length, 64 * 1024)))) {
        warnings.push('作物图里有 <script：' + name + '，已忽略')
        continue
      }
      art.set(pair.def.id, { bytes, ext })
      break
    }
  }
  return { entries, art, warnings }
}

/** 图的寻址名：按内容哈希，不按作物 id——同一张图换 id 不用重传，改一像素也不会撞名。 */
export function artFileName (bytes, ext) {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  return { hash, name: hash + '.' + ext }
}

export function isArtFileName (value) {
  if (typeof value !== 'string') return false
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = value.slice(dot + 1).toLowerCase()
  if (!ART_EXTENSIONS.includes(ext)) return false
  return HEX16_RE.test(value.slice(0, dot))
}

/**
 * 把作物图落到 `<dir>/crop-art/<hash>.<ext>`，helper 再用 `dshzoo://crops/<hash>.<ext>` 读。
 * 已经存在的同名文件不再写（内容寻址，同名即同内容）。
 *
 * @returns {Promise<Map<string, {url: string}>>}
 */
export async function writeCropArt ({
  dir,
  art,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile
} = {}) {
  const urls = new Map()
  if (typeof dir !== 'string' || dir === '' || !(art instanceof Map)) return urls
  const root = join(dir, CROP_ART_DIR)
  let ready = false
  for (const [cropId, entry] of art) {
    if (entry === null || typeof entry !== 'object' || !Buffer.isBuffer(entry.bytes)) continue
    if (entry.bytes.length === 0 || entry.bytes.length > MAX_ART_BYTES) continue
    const ext = ART_EXTENSIONS.includes(entry.ext) ? entry.ext : 'svg'
    const file = artFileName(entry.bytes, ext)
    if (!ready) {
      try {
        await mkdirImpl(root, { recursive: true })
      } catch {
        return urls
      }
      ready = true
    }
    try {
      await writeFileImpl(join(root, file.name), entry.bytes)
      urls.set(cropId, { url: 'dshzoo://crops/' + file.name, hash: file.hash, ext })
    } catch {
      // 写不进去只影响外观：窗口会退回 emoji，不挡玩法。
    }
  }
  return urls
}

/**
 * 本机作物文件的"指纹"（票 59 的热加载用它判断要不要重读）。
 *
 * 只看 `crops.json` 和 `crops/` 里图片的 mtime+大小：内容没变就不重读、不重推窗口。
 * 目录不存在也算一种状态（`-`），所以"新建文件"和"删掉文件"都会让指纹变。
 *
 * @returns {Promise<string>}
 */
export async function cropSignature ({
  dir,
  stat = (path) => statFile(path),
  listDir = (path) => readdir(path)
} = {}) {
  if (typeof dir !== 'string' || dir === '') return ''
  const parts = []
  try {
    const info = await stat(join(dir, CROPS_FILE))
    parts.push(CROPS_FILE + ':' + info.mtimeMs + ':' + info.size)
  } catch {
    parts.push(CROPS_FILE + ':-')
  }
  try {
    const names = (await listDir(join(dir, CROPS_DIR)))
      .filter((name) => ART_EXTENSIONS.includes(String(name).slice(String(name).lastIndexOf('.') + 1).toLowerCase()))
      .sort()
    for (const name of names) {
      try {
        const info = await stat(join(dir, CROPS_DIR, name))
        parts.push(name + ':' + info.mtimeMs + ':' + info.size)
      } catch {
        parts.push(name + ':-')
      }
    }
  } catch {
    parts.push(CROPS_DIR + ':-')
  }
  return parts.join('|')
}

/**
 * 读「局域网收到过的目录」（票 59）。
 *
 * 单独一个文件、和手写的 `crops.json` 分开：手写的是用户的，收到的是邻居的——
 * 合并规则（本地永远优先）要在 `buildCatalog` 里看得见，不能被一个文件搅在一起。
 * 只增不减：发布者掉线、关机、删了文件，条目还在，不然别人地里的作物会凭空变空地。
 *
 * @returns {Promise<{entries: object[], seenFrom: Map<string, string>, warnings: string[]}>}
 */
export async function readRemoteCatalog ({
  dir,
  readText = (path) => readFile(path, 'utf8')
} = {}) {
  const warnings = []
  const entries = []
  const seenFrom = new Map()
  if (typeof dir !== 'string' || dir === '') return { entries, seenFrom, warnings }
  let parsed = null
  try {
    parsed = parseJsonText(await readText(join(dir, CROP_CATALOG_FILE)))
  } catch (error) {
    if (error === null || typeof error !== 'object' || error.code !== 'ENOENT') {
      warnings.push(CROP_CATALOG_FILE + ' 读不出来，先当没有收到过目录')
    }
    return { entries, seenFrom, warnings }
  }
  const list = parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.entries)
    ? parsed.entries
    : null
  if (list === null) {
    warnings.push(CROP_CATALOG_FILE + ' 缺 entries 数组，先当没有收到过目录')
    return { entries, seenFrom, warnings }
  }
  for (const candidate of list.slice(0, MAX_CROPS)) {
    const def = normalizeCropDef(candidate)
    if (def === null) continue
    const art = normalizeArtRef(candidate?.art)
    entries.push({ ...def, ...(art === null ? {} : { art }) })
    if (typeof candidate?.seenFrom === 'string' && candidate.seenFrom !== '') {
      seenFrom.set(def.id, candidate.seenFrom)
    }
  }
  return { entries, seenFrom, warnings }
}

/** 图引用：只认 `{ hash, ext, bytes }`，和 wire 上那一份同一个形状。 */
export function normalizeArtRef (value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const hash = typeof value.hash === 'string' ? value.hash.trim().toLowerCase() : ''
  const ext = typeof value.ext === 'string' ? value.ext.trim().toLowerCase() : ''
  const bytes = Number(value.bytes)
  if (!HEX16_RE.test(hash)) return null
  if (!ART_EXTENSIONS.includes(ext)) return null
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_ART_BYTES) return null
  return { hash, ext, bytes }
}

/** 把收到过的目录写回 `<dir>/crop-catalog.json`；写失败只返回 false，不挡结算。 */
export async function writeRemoteCatalog ({
  dir,
  entries,
  seenFrom = new Map(),
  mkdirImpl = mkdir,
  writeText = (path, text) => writeFile(path, text, 'utf8')
} = {}) {
  if (typeof dir !== 'string' || dir === '') return false
  const list = (Array.isArray(entries) ? entries : [])
    .slice(0, MAX_CROPS)
    .map((candidate) => {
      const def = normalizeCropDef(candidate)
      if (def === null) return null
      const art = normalizeArtRef(candidate?.art)
      const from = seenFrom instanceof Map ? seenFrom.get(def.id) : undefined
      return {
        ...def,
        ...(art === null ? {} : { art }),
        ...(typeof from === 'string' && from !== '' ? { seenFrom: from } : {})
      }
    })
    .filter((entry) => entry !== null)
  try {
    await mkdirImpl(dir, { recursive: true })
    await writeText(join(dir, CROP_CATALOG_FILE), JSON.stringify({ version: CROP_CATALOG_VERSION, entries: list }))
    return true
  } catch {
    return false
  }
}

/**
 * 把目录切成 wire 上的一片片（票 59）。`size` 默认 8——和 `MAX_CATALOG_ENTRIES_PER_PACKET`
 * 同源，但这一层不 import protocol（会绕圈），由调用方传进来。
 * 空目录返回空数组（没什么可发的），不要返回 `[[]]`。
 */
export function chunkCatalog (entries, size = 8) {
  const list = Array.isArray(entries) ? entries : []
  const width = Number.isInteger(size) && size > 0 ? size : 8
  const chunks = []
  for (let index = 0; index < list.length; index += width) {
    chunks.push(list.slice(index, index + width))
  }
  return chunks
}

/** 目录里每种作物的顺序与名字，供日志/调试用。 */
export function describeCatalog (defs) {
  return catalogEntries(defs).map((def) => def.id + '(' + def.name + ')').join(', ')
}
