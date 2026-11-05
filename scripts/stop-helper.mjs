#!/usr/bin/env node
/**
 * 停掉正在跑的 dsh-zoo 桌面 helper。
 *
 * 什么时候要用它：**首次**从 ≤0.4.0 升到 0.4.1。0.4.1 起 helper 的 cwd 在包外
 * （`os.tmpdir()`，ADR-0012），但已经在跑的那个旧 helper 改不了自己的 cwd——它还站在
 * 包里的 `desktop/` 上。Windows 删不掉任何进程的当前工作目录，于是 `pnpm add` 替换
 * 这个包时仍会 `ERR_PNPM_EPERM`，最坏把包删残（见 .scratch/dsh-zoo/notes/
 * upstream-rename-overwrite-eperm.md）。新 helper 起来之后就不需要它了。
 *
 * 用法：
 *   node scripts/stop-helper.mjs --dry-run   # 先看它会停谁
 *   node scripts/stop-helper.mjs             # 停掉（SIGTERM，2s 不退再 SIGKILL）
 *
 * 顺序：退出 DSH（宿主）→ 跑这个 → `pnpm add` 新包 → 开 DSH。
 * 宿主还开着的话，helper 被杀掉后会被立刻重新拉起，包还是被占着。
 */

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { parsePsOutput, parseWindowsProcesses, pickHelperProcesses } from '../src/helper-processes.js'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 8 * 1024 * 1024
/** SIGTERM 之后等多久再 SIGKILL。helper 没有要收尾的落盘，这个时间足够。 */
const TERM_GRACE_MS = 2000

/**
 * 列出本机进程（`{ pid, command }[]`）。
 * Windows 走 CIM（`ps` 在 Git Bash 里看到的是另一套 pid，不可靠）；其余走 POSIX `ps`。
 * `exec` 可注入，测试用。
 */
export async function listProcesses ({ platform = process.platform, exec = execFileAsync } = {}) {
  if (platform === 'win32') {
    const { stdout } = await exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
    ], { maxBuffer: MAX_BUFFER })
    return parseWindowsProcesses(stdout)
  }
  const { stdout } = await exec('ps', ['-axo', 'pid=,args='], { maxBuffer: MAX_BUFFER })
  return parsePsOutput(stdout)
}

/** 打印用：命令行太长时只留头尾，别让一行刷屏。 */
export function shortenCommand (command, limit = 160) {
  const text = typeof command === 'string' ? command.trim() : ''
  if (text.length <= limit) return text
  return text.slice(0, limit - 24) + ' … ' + text.slice(-20)
}

export async function main (argv = process.argv.slice(2), {
  platform = process.platform,
  exec = execFileAsync,
  kill = (pid, signal) => process.kill(pid, signal),
  alive = isAlive,
  graceMs = TERM_GRACE_MS
} = {}) {
  const dryRun = argv.includes('--dry-run')
  let helpers
  try {
    helpers = pickHelperProcesses(await listProcesses({ platform, exec }))
  } catch (error) {
    console.error('[stop-helper] 读不到进程列表：' + messageOf(error))
    return 1
  }

  if (helpers.length === 0) {
    console.log('[stop-helper] 没有在跑的 dsh-zoo helper，什么都不用做。')
    return 0
  }

  for (const helper of helpers) {
    console.log('[stop-helper] pid ' + helper.pid + '  ' + shortenCommand(helper.command))
  }
  if (dryRun) {
    console.log('[stop-helper] dry-run：以上 ' + helpers.length + ' 个会被停掉（去掉 --dry-run 才真停）。')
    return 0
  }

  for (const helper of helpers) {
    try {
      kill(helper.pid, 'SIGTERM')
    } catch (error) {
      // ESRCH = 它自己已经退了，不算失败
      if (error?.code !== 'ESRCH') console.warn('[stop-helper] 停不掉 ' + helper.pid + '：' + messageOf(error))
    }
  }

  const survivors = await waitGone(helpers.map((helper) => helper.pid), graceMs, alive)
  for (const pid of survivors) {
    try {
      kill(pid, 'SIGKILL')
      console.warn('[stop-helper] pid ' + pid + ' 没响应 SIGTERM，已 SIGKILL。')
    } catch (error) {
      if (error?.code !== 'ESRCH') console.warn('[stop-helper] SIGKILL 也失败 ' + pid + '：' + messageOf(error))
    }
  }

  const left = survivors.length === 0 ? [] : await waitGone(survivors, 1000, alive)
  if (left.length > 0) {
    console.error('[stop-helper] 还有进程没退：' + left.join(', ') + '（可能需要管理员权限）')
    return 1
  }
  console.log('[stop-helper] 已停掉 ' + helpers.length + ' 个 helper。现在可以替换包了。')
  console.log('[stop-helper] 宿主还开着的话它们会被重新拉起——顺序是「退 DSH → 这里 → 换包 → 开 DSH」。')
  return 0
}

/** 等这些 pid 消失；返回还活着的。 */
async function waitGone (pids, timeoutMs, alive = isAlive) {
  const deadline = Date.now() + timeoutMs
  let remaining = pids.slice()
  while (remaining.length > 0 && Date.now() < deadline) {
    remaining = remaining.filter(alive)
    if (remaining.length === 0) return []
    await sleep(80)
  }
  return remaining.filter(alive)
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf (error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 是不是直接跑的这个文件。**两边都解 realpath**：profile 里装的是指向本仓的符号链接，
 * `import.meta.url` 已经被 Node 解析成真实路径，直接比字符串会把「从链接跑」判成 import，
 * 于是命令行静默什么都不做。
 */
function invokedDirectly () {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error('[stop-helper] 失败：' + messageOf(error))
    process.exitCode = 1
  })
}
