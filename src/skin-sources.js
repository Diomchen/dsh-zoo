import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { resolveDshPetAssetDirs } from './pet-assets.js'
import { dataDir as defaultDataDir } from './paths.js'
import { parseJsonText } from './json-text.js'
import { stripBom } from './json-text.js'
import { isSafeAnimationName } from './protocol.js'

/**
 * 本机素材源注册表。
 *
 * 一个「源」= 一组覆盖目录 + 一个基准尺寸 + 一份动作清单。dsh-pet 只是其中一个源
 * （自动注册）；别的宠物插件只要把自己的素材目录写进 `<dataDir>/skin.json`，就也是源。
 *
 * ticket 32 起每条源还可以声明两个可选项：`idle`（这张皮的待机动作名）和
 * `once`（一次性动作名；不进闲时轮播）。两条都是"声明了才生效"，缺省行为一个字不变。
 *
 * 这一层只读本机文件，不起 HTTP、不碰协议——对外供源是下一步（ticket 15）。
 * 任何坏配置都只跳过那一个源并记一条告警，绝不让发现/串门/桌面跟着坏。
 */

export const SKIN_FILE = 'skin.json'
export const DEFAULT_SKIN_ID = 'dsh-pet'
export const DEFAULT_SIZE = 462
export const MIN_SIZE = 32
export const MAX_SIZE = 2048
export const MAX_SKIN_SOURCES = 16
export const MAX_SKIN_DIRS = 8
/** 一张皮最多认这么多「一次性动作」：skin.json 是本地文件，但也别让它无限长。 */
export const MAX_SKIN_ONCE = 64
/** dsh-pet 的待机动作；没有它时退到排序后的第一个动作。 */
export const IDLE_ACTION = '待机呼吸休闲'

const SOURCE_ID = /^[A-Za-z0-9_-]{1,32}$/

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home] 覆盖用户 home（只用于 `~` 展开；dsh-pet 目录仍按 $DSH_HOME 解析）
 * @param {string} [options.dataDir] 覆盖 `<DSH_HOME>/local-pet`
 * @param {(dir:string)=>Promise<Array<string|{name:string,isFile?:Function,isSymbolicLink?:Function}>>} [options.readdir]
 * @param {(path:string, encoding:string)=>Promise<string>} [options.readFile]
 * @param {(options:{env?:object})=>string[]} [options.resolveDshPetDirs]
 * @returns {Promise<{sources: Array<object>, warnings: Array<{code:string,detail?:string}>}>}
 */
export async function loadSkinSources (options = {}) {
  const env = options.env ?? process.env
  const home = typeof options.home === 'string' && options.home !== ''
    ? options.home
    : (typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : homedir())
  const dir = typeof options.dataDir === 'string' && options.dataDir !== ''
    ? options.dataDir
    : defaultDataDir(env)
  const readFileImpl = typeof options.readFile === 'function' ? options.readFile : readFile
  const readdirImpl = typeof options.readdir === 'function' ? options.readdir : readdir
  const resolveDshPetDirs = typeof options.resolveDshPetDirs === 'function'
    ? options.resolveDshPetDirs
    // 注意：这里的 `home` 是用户 home（`~` 展开用）；dsh-pet 的目录链要的是 $DSH_HOME，
    // 由 pet-assets 自己从 env 算，不能把用户 home 混进去。
    : () => resolveDshPetAssetDirs({ env })

  const warnings = []
  const seenWarnings = new Set()
  function warn (code, detail) {
    const key = code + '\u0000' + (detail ?? '')
    if (seenWarnings.has(key)) return
    seenWarnings.add(key)
    warnings.push(detail === undefined ? { code } : { code, detail })
  }

  let entries = null
  let badConfigDetail = null

  try {
    const text = await readFileImpl(join(dir, SKIN_FILE), 'utf8')
    const parsed = parseSkinFile(text)
    if (parsed === null) badConfigDetail = 'invalid JSON'
    else entries = parsed
  } catch (error) {
    // 不存在 = 没配置，正常；其它读失败（权限/是目录）= 坏配置，回落自动源
    if (error?.code !== 'ENOENT') badConfigDetail = message(error)
  }

  if (badConfigDetail !== null) warn('bad-skin-file', badConfigDetail)

  if (entries === null) {
    let dirs = []
    try {
      dirs = resolveDshPetDirs({ env }) ?? []
    } catch {
      dirs = []
    }
    const safeDirs = []
    for (const value of Array.isArray(dirs) ? dirs : []) {
      const expanded = expandDir(value, home)
      if (expanded !== null && !safeDirs.includes(expanded)) safeDirs.push(expanded)
      if (safeDirs.length >= MAX_SKIN_DIRS) break
    }
    if (safeDirs.length === 0) {
      warn('no-dsh-pet')
      return { sources: [], warnings }
    }
    entries = [{ id: DEFAULT_SKIN_ID, name: DEFAULT_SKIN_ID, dirs: safeDirs, size: DEFAULT_SIZE }]
  }

  const sources = []
  const usedIds = new Set()

  for (const raw of entries) {
    if (sources.length >= MAX_SKIN_SOURCES) {
      warn('too-many-sources')
      break
    }
    const normalized = normalizeEntry(raw, home, warn)
    if (normalized === null) continue
    if (usedIds.has(normalized.id)) {
      warn('duplicate-id', normalized.id)
      continue
    }

    const scanned = await scanActions(normalized.dirs, readdirImpl, warn, normalized.id)
    const ids = Object.keys(scanned.actions).sort()
    if (ids.length === 0) {
      // 目录全缺（missing-dir）时不再补一条 empty-source：同一件事说两遍是噪音。
      if (scanned.readable) warn('empty-source', normalized.id)
      continue
    }
    const actions = scanned.actions

    // 待机动作：皮自己声明的优先（别的素材包不叫「待机呼吸休闲」），坏声明只告警不失败。
    const idle = resolveIdle(normalized, actions, ids, warn)
    // 一次性动作（ticket 32）：不进闲时轮播，清单里也不再标 loop。
    const once = []
    for (const name of normalized.once) {
      if (Object.prototype.hasOwnProperty.call(actions, name)) once.push(name)
    }
    if (once.length !== normalized.once.length) warn('bad-once', normalized.id)
    const onceSet = new Set(once)

    const manifest = {
      v: 1,
      id: normalized.id,
      // 清单里的名字就是 id：皮的身份只有一份，别在别处再编一个（ADR-0007 的同一条道理）。
      name: normalized.id,
      size: normalized.size,
      idle,
      actions: Object.fromEntries(ids.map((id) => [id, { file: actions[id].file, loop: !onceSet.has(id) }]))
    }

    usedIds.add(normalized.id)
    sources.push({
      id: normalized.id,
      size: normalized.size,
      dirs: normalized.dirs,
      idle,
      once,
      actions,
      manifest
    })
  }

  return { sources, warnings }
}

/** 解析 skin.json：`{ sources: [...] }` 或裸数组；坏形状返回 null（调用方回落自动源）。 */
export function parseSkinFile (text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  let parsed
  try {
    parsed = parseJsonText(text)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.sources)) return parsed.sources
  return null
}

function normalizeEntry (raw, home, warn) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warn('bad-source')
    return null
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!SOURCE_ID.test(id)) {
    warn('bad-id', id === '' ? '(empty)' : id)
    return null
  }
  const size = raw.size === undefined ? DEFAULT_SIZE : Number(raw.size)
  if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE) {
    warn('bad-size', id)
    return null
  }

  const rawDirs = Array.isArray(raw.dirs) ? raw.dirs : [raw.dir]
  const dirs = []
  for (const value of rawDirs) {
    const expanded = expandDir(value, home)
    if (expanded === null) continue
    if (!dirs.includes(expanded)) dirs.push(expanded)
    if (dirs.length >= MAX_SKIN_DIRS) break
  }
  if (dirs.length === 0) {
    warn('bad-dir', id)
    return null
  }

  // 待机动作：给不叫「待机呼吸休闲」的素材包一个明说的位置；是不是真存在，扫完目录才知道。
  const idle = typeof raw.idle === 'string' && raw.idle.trim() !== '' && isSafeAnimationName(raw.idle)
    ? raw.idle.trim()
    : null
  // 一次性动作：数组或单个字符串都收，名字过安全校验，去重；不存在的名字扫完再报。
  const once = []
  const onceSeen = new Set()
  const rawOnce = Array.isArray(raw.once) ? raw.once : [raw.once]
  for (const value of rawOnce) {
    if (once.length >= MAX_SKIN_ONCE) break
    if (typeof value !== 'string') continue
    if (!isSafeAnimationName(value)) continue
    const name = value.trim()
    if (name === '' || onceSeen.has(name)) continue
    onceSeen.add(name)
    once.push(name)
  }

  return { id, size, dirs, idle, once }
}

/** 待机动作：声明的 → dsh-pet 的老名字 → 字母序第一段。声明坏了只告警一次。 */
function resolveIdle (entry, actions, ids, warn) {
  if (entry.idle !== null) {
    if (Object.prototype.hasOwnProperty.call(actions, entry.idle)) return entry.idle
    warn('bad-idle', entry.id)
  }
  if (Object.prototype.hasOwnProperty.call(actions, IDLE_ACTION)) return IDLE_ACTION
  return ids[0]
}

function expandDir (value, home) {
  if (typeof value !== 'string') return null
  let dir = value.trim()
  if (dir === '' || dir.includes('\u0000')) return null
  if (dir === '~') dir = home
  else if (dir.startsWith('~/') || dir.startsWith('~\\')) dir = join(home, dir.slice(2))
  if (!isAbsolute(dir)) return null
  return dir.length > 1 ? dir.replace(/[\\/]+$/, '') : dir
}

async function scanActions (dirs, readdirImpl, warn, sourceId) {
  const actions = {}
  let readable = false
  for (const dir of dirs) {
    let entries
    try {
      entries = await readdirImpl(dir, { withFileTypes: true })
    } catch (error) {
      warn(error?.code === 'ENOENT' ? 'missing-dir' : 'read-failed', sourceId)
      continue
    }
    readable = true
    if (!Array.isArray(entries)) continue
    const names = []
    for (const entry of entries) {
      if (typeof entry === 'string') { names.push(entry); continue }
      if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string') continue
      if (typeof entry.isFile === 'function' && !entry.isFile() &&
        !(typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink())) continue
      names.push(entry.name)
    }
    names.sort()
    for (const name of names) {
      if (!name.endsWith('.webm')) continue
      const id = name.slice(0, -'.webm'.length)
      // 隐藏文件不算动作；路径分隔符/控制字符由 isSafeAnimationName 挡掉。
      if (id.startsWith('.') || !isSafeAnimationName(id)) continue
      if (Object.prototype.hasOwnProperty.call(actions, id)) continue
      actions[id] = { file: name, dir }
    }
  }
  return { actions, readable }
}

function message (error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 本机待机的动作池：从源的动作里剔掉「点击回应 / 拖拽 / 余额 / 碎碎念 / 工作状态 / 文字类」。
 * 这些事件动画应该由各自的触发条件播放，不该在待机时随机出现；剩下的才是 dsh-pet
 * 随机链真正会抽的日常动作（idle / 转向 / 移动 / 随机小动作）。
 */
const IDLE_EXCLUDE_PREFIXES = ['点击回应-', '被鼠标拖拽', '余额-', '碎碎念-', '工作状态-']
const IDLE_EXCLUDE_EXACT = new Set(['是啊，吃什么', '深度思考碎碎念'])

export function idlePoolOf (source) {
  if (source === null || typeof source !== 'object') return []
  const actions = source.actions
  if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) return []
  const once = new Set(Array.isArray(source.once) ? source.once : [])
  const pool = []
  for (const name of Object.keys(actions)) {
    if (once.has(name)) continue
    if (IDLE_EXCLUDE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    if (IDLE_EXCLUDE_EXACT.has(name)) continue
    pool.push(name)
  }
  return pool.sort()
}


/**
 * 把扫到的素材包**追加**进 `skin.json`（ticket 37）。
 *
 * 只做加法：已存在的 id 一律跳过，所以连点十次和点一次结果一样；文件本身的形状
 * （裸数组还是 `{ sources }`）原样保留。文件坏了就抛——这是一次显式的用户动作，
 * 宁可报错也不能把人家写坏的配置覆盖掉。
 */
export async function appendSkinSources (dir, entries, options = {}) {
  const readFileImpl = typeof options.readFile === 'function' ? options.readFile : readFile
  const writeFileImpl = typeof options.writeFile === 'function' ? options.writeFile : writeFile
  const mkdirImpl = typeof options.mkdir === 'function' ? options.mkdir : mkdir
  const file = join(dir, SKIN_FILE)

  let raw = null
  try {
    raw = await readFileImpl(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  let doc = null
  if (raw !== null) doc = JSON.parse(stripBom(raw))
  const isArray = Array.isArray(doc)
  const list = isArray ? doc.slice() : (Array.isArray(doc?.sources) ? doc.sources.slice() : [])
  const seen = new Set()
  for (const item of list) {
    if (typeof item?.id === 'string') seen.add(item.id)
  }

  const added = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.id !== 'string' || seen.has(entry.id)) continue
    const next = { id: entry.id, dirs: entry.dirs }
    if (Number.isInteger(entry.size)) next.size = entry.size
    if (typeof entry.idle === 'string' && entry.idle !== '') next.idle = entry.idle
    seen.add(entry.id)
    added.push(next)
    list.push(next)
  }
  if (added.length === 0) return { added, file }

  await mkdirImpl(dir, { recursive: true, mode: 0o700 })
  const body = isArray ? list : { sources: list }
  await writeFileImpl(file, JSON.stringify(body, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  return { added, file }
}
