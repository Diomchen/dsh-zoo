/**
 * 桌面层的「要不要起 helper / 崩了怎么退避」策略。
 *
 * 这一层是纯的（注入 platform/env/exists/now 就能测），src/desktop.js 只负责接线：
 *   - 宿主必须真的是桌面版（Electron 二进制里的 Node，process.versions.electron 存在）；
 *   - 必须在 macOS 上（v1 只保证主屏工作区，其它平台直接降级为「没有桌面层」）；
 *   - Electron 必须是磁盘上已有的那份（~/.dsh/electron），绝不下载、不新增 npm 依赖；
 *   - 崩了最多重启 N 次，指数退避；稳定运行一段时间后计数清零。
 */

import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { dshHome } from './paths.js'

export const DESKTOP_MAX_RESTARTS = 5
export const DESKTOP_RESTART_BASE_MS = 300
export const DESKTOP_RESTART_MAX_MS = 8000
/** 运行满这么久没崩，就把「连续崩溃」计数清零（下一次崩溃重新从 300ms 退避）。 */
export const DESKTOP_STABLE_MS = 60000
/** 宿主给 helper 的保活节拍；helper 侧 30s 收不到任何一行就自行退出。 */
export const DESKTOP_PING_MS = 5000
export const DESKTOP_SHOT_TIMEOUT_MS = 8000
export const DESKTOP_STATUS_TIMEOUT_MS = 3000

/**
 * 宿主是不是桌面版 DSH：它跑在 Electron 二进制里（ELECTRON_RUN_AS_NODE=1），
 * process.versions.electron 存在；web profile 的普通 node 进程里没有这个字段。
 * 与 dsh-pet 的 isDesktopHost 同一条判据，不依赖 profile 名或自定义环境变量。
 */
export function isDesktopHost (versions = process.versions) {
  return Boolean(versions) && typeof versions.electron === 'string' && versions.electron !== ''
}

/**
 * 候选 Electron 路径，按优先级：
 *   1. LOCAL_PET_ELECTRON（显式覆盖，测试/特殊安装用）；
 *   2. $DSH_HOME/electron/Electron.app/Contents/MacOS/Electron（这台机器上已有的那份）。
 * 只做候选枚举，不判断存在性。
 */
export function candidateElectronPaths ({ env = process.env, platform = process.platform } = {}) {
  const candidates = []
  const override = typeof env.LOCAL_PET_ELECTRON === 'string' ? env.LOCAL_PET_ELECTRON.trim() : ''
  if (override !== '') candidates.push(override)
  if (platform === 'darwin') {
    candidates.push(join(dshHome(env), 'electron', 'Electron.app', 'Contents', 'MacOS', 'Electron'))
  }
  return candidates
}

function fileExists (candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * @returns {{ok:true,path:string,candidates:string[]} | {ok:false,reason:'unsupported-platform'|'electron-missing',platform?:string,candidates:string[]}}
 */
export function resolveElectronBinary ({ env = process.env, platform = process.platform, exists = fileExists } = {}) {
  const candidates = candidateElectronPaths({ env, platform })
  if (platform !== 'darwin') {
    return { ok: false, reason: 'unsupported-platform', platform, candidates }
  }
  for (const candidate of candidates) {
    if (exists(candidate)) return { ok: true, path: candidate, candidates }
  }
  return { ok: false, reason: 'electron-missing', candidates }
}

/**
 * helper 的 argv。**全部用 --local-pet- 前缀**：Electron/Chromium 会自己消费 --debug 之类的
 * 已知开关（实测 `--debug` 直接让 Electron 以 exit 9 退出），前缀确保它们原样落到 process.argv。
 *
 * `assetRoots` 是宿主解析好的 dsh-pet 素材目录（绝对路径，按优先级排列）。helper 的页面是
 * file://，拿不到 DSH 的 HTTP 路由，所以它要注册 localpet:// 协议，根目录只能从 argv 拿。
 */
export function buildHelperArgs ({ helperPath, hostPid, debug = false, assetRoots = [] } = {}) {
  const args = [String(helperPath)]
  if (Number.isInteger(hostPid) && hostPid > 0) {
    args.push('--local-pet-host-pid', String(hostPid))
  }
  if (debug) args.push('--local-pet-debug')
  const seen = new Set()
  if (Array.isArray(assetRoots)) {
    for (const root of assetRoots) {
      if (typeof root !== 'string') continue
      const dir = root.trim()
      if (dir === '' || dir.includes('\u0000') || !isAbsolute(dir)) continue
      if (seen.has(dir)) continue
      seen.add(dir)
      args.push('--local-pet-assets', dir)
      if (seen.size >= 8) break
    }
  }
  return args
}

/**
 * spawn helper 的环境变量。
 *
 * **必须删除 ELECTRON_RUN_AS_NODE**：宿主自己就是 ELECTRON_RUN_AS_NODE=1 的 Electron，
 * 原样透传会让 helper 以纯 Node 模式启动——require('electron') 拿不到 app，窗口不可能出现。
 * 设成空串会让 Electron 直接 abort，设成 '0' 仍是纯 Node 模式，所以只有「删除」这一种正确做法。
 */
export function helperEnv (baseEnv = process.env, hostPid = process.pid) {
  const env = { ...baseEnv }
  delete env.ELECTRON_RUN_AS_NODE
  if (Number.isInteger(hostPid) && hostPid > 0) env.LOCAL_PET_HOST_PID = String(hostPid)
  return env
}

function positiveInt (value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * 纯重启策略。调用顺序：spawn 前 onStart()，进程退出时 onExit()。
 * @returns {{
 *   onStart(nowMs?:number):void,
 *   onExit(nowMs?:number):{action:'restart',delayMs:number,restarts:number}|{action:'give-up',restarts:number},
 *   reset():void,
 *   readonly restarts:number
 * }}
 */
export function createRestartPolicy (options = {}) {
  const maxRestarts = positiveInt(options.maxRestarts, DESKTOP_MAX_RESTARTS)
  const baseDelayMs = positiveInt(options.baseDelayMs, DESKTOP_RESTART_BASE_MS)
  const maxDelayMs = positiveInt(options.maxDelayMs, DESKTOP_RESTART_MAX_MS)
  const stableMs = positiveInt(options.stableMs, DESKTOP_STABLE_MS)
  const now = typeof options.now === 'function' ? options.now : Date.now

  let restarts = 0
  let lastStartAt = 0
  let started = false

  return {
    onStart (nowMs = now()) {
      lastStartAt = Number.isFinite(nowMs) ? nowMs : Date.now()
      started = true
    },
    onExit (nowMs = now()) {
      if (!started) {
        // 还没成功启动过（spawn 同步失败）：也算一次，但仍按退避处理
        return { action: 'give-up', restarts }
      }
      const at = Number.isFinite(nowMs) ? nowMs : Date.now()
      if (at - lastStartAt >= stableMs) restarts = 0
      restarts += 1
      if (restarts > maxRestarts) return { action: 'give-up', restarts }
      const delayMs = Math.min(baseDelayMs * 2 ** (restarts - 1), maxDelayMs)
      return { action: 'restart', delayMs, restarts }
    },
    reset () {
      restarts = 0
      lastStartAt = 0
      started = false
    },
    get restarts () {
      return restarts
    }
  }
}

/** 人话版降级原因；宿主侧只打这一行，然后假装桌面层不存在。 */
export function describeUnavailable (result, { helperPath = '' } = {}) {
  if (result.ok) return '桌面层可用'
  if (result.reason === 'not-desktop-host') {
    return '桌面层跳过：当前宿主不是桌面版（web profile 没有 Electron 运行时），宠物不显示'
  }
  if (result.reason === 'unsupported-platform') {
    return '桌面层跳过：当前只支持 macOS（' + String(result.platform) + '），宠物不显示'
  }
  const first = Array.isArray(result.candidates) && result.candidates.length > 0
    ? result.candidates[0]
    : helperPath
  return '桌面层跳过：找不到可用的 Electron（' + (first || '未配置') + '），宠物不显示'
}
