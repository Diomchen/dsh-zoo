import { statSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { stripBom } from './json-text.js'
import { stripJsonComments } from './pet-bridge.js'
import { isSafeAnimationName, normalizeSkinId } from './protocol.js'

/**
 * 扫描 dsh-pet 的「宠物包」目录（ticket 37）。
 *
 * **这是第三层对 dsh-pet 的耦合**，但刻意做成品德最轻的一层：
 *   - 只在用户按「扫描外观」时被调用，不在插件加载路径上；
 *   - 只读，绝不写 dsh-pet 的任何文件；
 *   - 扫不到就返回空，坏配置只跳过那一个包。
 *
 * 读的是它的内部布局（README 里没写，从代码里读出来的）：
 *   `$DSH_HOME/dsh-pet/pet/<前缀>-config.json(c)`  →  `pets[0]`、`animations.idle`
 *   `$DSH_HOME/dsh-pet/pet/<前缀>-animation/`      →  每个动作一段 webm
 *
 * 它哪天改了这套布局，坏的是这个扫描（一次点击），不是已经加进 `skin.json` 的皮。
 */

export const PET_DIR_NAME = 'pet'
export const ANIMATION_SUFFIX = '-animation'
const CONFIG_FILE = /^(.+)-config\.(json|jsonc)$/

/**
 * @param {object} [options]
 * @param {string} options.petDir `$DSH_HOME/dsh-pet/pet`
 * @param {(dir:string, options?:object)=>Promise<Array>} [options.readdir]
 * @param {(path:string, encoding:string)=>Promise<string>} [options.readFile]
 * @param {(path:string)=>boolean} [options.isDirectory]
 * @param {(code:string, detail?:string)=>void} [options.warn]
 * @param {number} [options.max] 最多认多少个包
 * @returns {Promise<{packs: Array<{id:string, dirs:string[], size?:number, idle?:string, prefix:string}>, warnings: Array<{code:string, detail?:string}>}>}
 */
export async function discoverPetPacks (options = {}) {
  const petDir = typeof options.petDir === 'string' ? options.petDir : ''
  if (petDir === '') throw new Error('discoverPetPacks: missing petDir')
  const readdirImpl = typeof options.readdir === 'function' ? options.readdir : readdir
  const readFileImpl = typeof options.readFile === 'function' ? options.readFile : readFile
  const isDirectory = typeof options.isDirectory === 'function' ? options.isDirectory : defaultIsDirectory
  const max = Number.isInteger(options.max) && options.max > 0 ? options.max : 16
  const warnings = []
  const warn = (code, detail) => {
    warnings.push(detail === undefined ? { code } : { code, detail })
    options.warn?.(code, detail)
  }

  let entries
  try {
    entries = await readdirImpl(petDir, { withFileTypes: true })
  } catch (error) {
    // 没有这个目录 = 没装过任何宠物包，不是错误。
    if (error?.code !== 'ENOENT') warn('read-failed', petDir)
    return { packs: [], warnings }
  }
  if (!Array.isArray(entries)) return { packs: [], warnings }

  const configs = []
  for (const entry of entries) {
    const name = typeof entry === 'string'
      ? entry
      : (typeof entry?.name === 'string' ? entry.name : '')
    if (name === '') continue
    if (typeof entry?.isFile === 'function' && !entry.isFile()) continue
    const match = CONFIG_FILE.exec(name)
    if (match === null) continue
    configs.push({ prefix: match[1], file: name })
  }
  configs.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0))

  const packs = []
  for (const config of configs) {
    if (packs.length >= max) {
      warn('too-many-packs')
      break
    }
    let text
    try {
      text = await readFileImpl(join(petDir, config.file), 'utf8')
    } catch {
      warn('read-failed', config.file)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(stripJsonComments(stripBom(text)))
    } catch {
      warn('bad-config', config.file)
      continue
    }
    const pet = Array.isArray(parsed?.pets) ? parsed.pets[0] : null
    if (pet === null || typeof pet !== 'object') {
      warn('no-pet', config.file)
      continue
    }
    // 被主人关掉的宠物不该被拽回「外观」。
    if (pet.display === 'none') continue

    const id = normalizeSkinId(pet.id) ?? normalizeSkinId(config.prefix)
    if (id === null) {
      warn('bad-id', config.file)
      continue
    }
    const animDir = join(petDir, config.prefix + ANIMATION_SUFFIX)
    if (!isDirectory(animDir)) {
      warn('no-animation', config.file)
      continue
    }
    if (!(await hasClips(animDir, readdirImpl))) {
      warn('empty-animation', config.file)
      continue
    }

    const size = Number.isInteger(pet.size) && pet.size > 0 ? pet.size : undefined
    const idle = firstIdle(parsed?.animations)
    packs.push({
      id,
      prefix: config.prefix,
      dirs: [animDir],
      ...(size === undefined ? {} : { size }),
      ...(idle === null ? {} : { idle })
    })
  }

  return { packs, warnings }
}

/** 目录里至少有一段 webm（只看文件名，不读内容）。 */
async function hasClips (dir, readdirImpl) {
  let entries
  try {
    entries = await readdirImpl(dir)
  } catch {
    return false
  }
  if (!Array.isArray(entries)) return false
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : (typeof entry?.name === 'string' ? entry.name : '')
    if (name.endsWith('.webm') && !name.startsWith('.')) return true
  }
  return false
}

/** dsh-pet 的待机清单：第一个安全的名字就是这张皮的待机动作。 */
function firstIdle (animations) {
  const pool = Array.isArray(animations?.idle) ? animations.idle : []
  for (const name of pool) {
    if (typeof name === 'string' && isSafeAnimationName(name)) return name.trim()
  }
  return null
}

function defaultIsDirectory (path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
