/**
 * dsh-pet 素材目录解析。
 *
 * 桌面 helper 是 `file://` 页面，`/dsh-pet-7340/thumb/...` 这种同源 HTTP 路由在它里面
 * 根本不存在；helper 主进程要注册自己的 `localpet://` 协议，就必须知道素材目录在哪。
 *
 * 这里在**宿主侧**解析，绝不硬编码 `~/.dsh/profiles/desktop`：
 *   1. `LOCAL_PET_DSH_PET_ASSETS`（显式覆盖，`:` 分隔多个目录；测试/特殊安装用）；
 *   2. `$DSH_HOME/dsh-pet/main-animation/webm`（dsh-pet 的用户自定义素材，优先覆盖包内素材）；
 *   3. 从本模块位置 `require.resolve('dsh-pet/package.json')` —— 插件和 dsh-pet 通常装在
 *      同一个 profile 的 node_modules 里，这是最可靠的一条；
 *   4. 扫描 `$DSH_HOME/profiles/<名字>/node_modules/dsh-pet/assets/webm`（profile 名是数据，不是常量）。
 *
 * dsh-pet 没装/目录不存在都只是返回空数组：宠物退成内置色块，串门不受影响。
 */

import { readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

import { dshHome } from './paths.js'

export const DSH_PET_ASSET_ENV = 'LOCAL_PET_DSH_PET_ASSETS'

const requireFromHere = createRequire(import.meta.url)

function defaultResolvePackage (id) {
  return requireFromHere.resolve(id)
}

function isDirectory (candidate) {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function normalizeDir (value) {
  if (typeof value !== 'string') return null
  const dir = value.trim()
  if (dir === '' || dir.includes('\u0000')) return null
  if (!isAbsolute(dir)) return null
  return dir.length > 1 ? dir.replace(/[\\/]+$/, '') : dir
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.home] 覆盖 $DSH_HOME（测试用）
 * @param {(id:string)=>string} [options.resolvePackage] 包解析注入（测试用）
 * @param {(dir:string)=>string[]} [options.readdir] 目录枚举注入（测试用）
 * @param {(dir:string)=>boolean} [options.isDirectory] 目录存在性注入（测试用）
 * @returns {string[]} 已存在的素材目录，按优先级从高到低
 */
export function resolveDshPetAssetDirs (options = {}) {
  const env = options.env ?? process.env
  const home = typeof options.home === 'string' && options.home !== '' ? options.home : dshHome(env)
  const resolvePackage = typeof options.resolvePackage === 'function'
    ? options.resolvePackage
    : defaultResolvePackage
  const readdir = typeof options.readdir === 'function' ? options.readdir : readdirSync
  const exists = typeof options.isDirectory === 'function' ? options.isDirectory : isDirectory
  const dirs = []

  function add (candidate) {
    const dir = normalizeDir(candidate)
    if (dir === null || dirs.includes(dir)) return
    if (!exists(dir)) return
    dirs.push(dir)
  }

  const override = typeof env[DSH_PET_ASSET_ENV] === 'string' ? env[DSH_PET_ASSET_ENV].trim() : ''
  if (override !== '') {
    for (const part of override.split(delimiter)) add(part)
  }

  // dsh-pet 的素材链：用户目录优先于包内目录（与它自己的 /thumb 路由一致）。
  add(join(home, 'dsh-pet', 'main-animation', 'webm'))

  try {
    const packageJson = resolvePackage('dsh-pet/package.json')
    if (typeof packageJson === 'string' && packageJson !== '') {
      add(join(dirname(packageJson), 'assets', 'webm'))
    }
  } catch {
    // 插件没和 dsh-pet 装在同一个 node_modules：继续扫描 profiles
  }

  let profiles = []
  try {
    profiles = readdir(join(home, 'profiles'))
  } catch {
    profiles = []
  }
  if (Array.isArray(profiles)) {
    for (const name of [...profiles].sort()) {
      if (typeof name !== 'string' || name === '') continue
      add(join(home, 'profiles', name, 'node_modules', 'dsh-pet', 'assets', 'webm'))
    }
  }

  add(join(home, 'node_modules', 'dsh-pet', 'assets', 'webm'))
  return dirs
}
