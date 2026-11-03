import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { resolveDshPetAssetDirs } from './pet-assets.js'
import { dataDir as defaultDataDir } from './paths.js'
import { MAX_LABEL, isSafeAnimationName } from './protocol.js'

/**
 * 本机素材源注册表。
 *
 * 一个「源」= 一组覆盖目录 + 一个基准尺寸 + 一份动作清单。dsh-pet 只是其中一个源
 * （自动注册）；别的宠物插件只要把自己的素材目录写进 `<dataDir>/skin.json`，就也是源。
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

    const idle = Object.prototype.hasOwnProperty.call(actions, IDLE_ACTION) ? IDLE_ACTION : ids[0]
    const manifest = {
      v: 1,
      id: normalized.id,
      name: normalized.name,
      size: normalized.size,
      idle,
      actions: Object.fromEntries(ids.map((id) => [id, { file: actions[id].file, loop: true }]))
    }

    usedIds.add(normalized.id)
    sources.push({
      id: normalized.id,
      name: normalized.name,
      size: normalized.size,
      dirs: normalized.dirs,
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
    parsed = JSON.parse(text)
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
  const name = typeof raw.name === 'string' && raw.name.trim() !== ''
    ? Array.from(raw.name.trim()).slice(0, MAX_LABEL).join('')
    : id
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
  return { id, name, size, dirs }
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
  const pool = []
  for (const name of Object.keys(actions)) {
    if (IDLE_EXCLUDE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    if (IDLE_EXCLUDE_EXACT.has(name)) continue
    pool.push(name)
  }
  return pool.sort()
}
