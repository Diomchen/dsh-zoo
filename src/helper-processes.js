/**
 * 「现在有哪些进程是 dsh-zoo 的桌面 helper」——升级前停旧 helper 用的那一小块。
 *
 * 为什么需要它：Windows 上删不掉任何进程的当前工作目录。0.4.1 起 helper 的 cwd 挪到了
 * `os.tmpdir()`（ADR-0012），但**已经在跑的旧 helper** 改不了自己——它的 cwd 还落在包里，
 * 于是 `pnpm add` 替换这个包时仍会 `ERR_PNPM_EPERM`，最坏把包删残。
 * 首次从 ≤0.4.0 升级只能先把它停掉。
 *
 * 判据用宿主拉 helper 时加的 `--dsh-zoo-host-pid`（src/desktop-launch.js），不用路径：
 * 路径随安装位置变（profile、链接安装、tgz 解出来的临时目录），这个开关只属于本插件。
 * 改名前的 helper 用的是 `--local-pet-host-pid`；升级时它可能还活着，所以也认。
 */

/**
 * helper argv 里的归属标记；必须整词匹配，`--dsh-zoo-host-pid-typo` 不算。
 * 第二个是改名前的版本（≤0.5.7）用的开关：只用于升级时把旧 helper 一起停掉。
 */
const HELPER_FLAGS = [
  /(?:^|\s)--dsh-zoo-host-pid(?:\s|=|$)/,
  /(?:^|\s)--local-pet-host-pid(?:\s|=|$)/
]

/**
 * `Win32_Process` 的 JSON（PowerShell `ConvertTo-Json`）→ `{ pid, command }[]`。
 * 只有一个进程时 PowerShell 给的是对象而不是数组；空输出、坏 JSON 都按「没找到」处理。
 */
export function parseWindowsProcesses (json) {
  if (typeof json !== 'string' || json.trim() === '') return []
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const out = []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const pid = Number(entry.ProcessId)
    if (!Number.isInteger(pid) || pid <= 0) continue
    out.push({ pid, command: typeof entry.CommandLine === 'string' ? entry.CommandLine : '' })
  }
  return out
}

/** `ps -axo pid=,args=` 的文本 → `{ pid, command }[]`。命令行里的空格原样留在 command 里。 */
export function parsePsOutput (text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    if (!Number.isInteger(pid) || pid <= 0) continue
    out.push({ pid, command: match[2] })
  }
  return out
}

/** 从进程列表里挑出 helper；同一个 pid 只留一条。 */
export function pickHelperProcesses (list) {
  const seen = new Set()
  const out = []
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry === null || typeof entry !== 'object') continue
    const pid = Number(entry.pid)
    const command = typeof entry.command === 'string' ? entry.command : ''
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!HELPER_FLAGS.some((flag) => flag.test(command))) continue
    if (seen.has(pid)) continue
    seen.add(pid)
    out.push({ pid, command })
  }
  return out
}
