/**
 * 跑调试台：把 Electron 拉起来、收 main.cjs 的 @@DATA@@、解析「还剩 …」并断言。
 * 用法：node .scratch/dsh-zoo/debug-contract-clock/run.mjs
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveElectronBinary } from '../../../src/desktop-launch.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

function remainingSeconds (text) {
  if (typeof text !== 'string') return null
  const hours = /(\d+)\s*小时/.exec(text)
  const minutes = /(\d+)\s*分/.exec(text)
  const seconds = /(\d+)\s*秒/.exec(text)
  if (hours === null && minutes === null && seconds === null) return null
  return (hours === null ? 0 : Number(hours[1]) * 3600) +
    (minutes === null ? 0 : Number(minutes[1]) * 60) +
    (seconds === null ? 0 : Number(seconds[1]))
}

const electron = resolveElectronBinary()
const electronPath = typeof electron === "string" ? electron : electron?.path
if (typeof electronPath !== "string") {
  console.error('找不到 Electron：' + JSON.stringify(electron))
  process.exit(2)
}

// DSH 自己跑在 ELECTRON_RUN_AS_NODE 里；子进程必须是真 GUI 的 Electron，
// 否则 require('electron') 拿不到 app/BrowserWindow。
// Windows 上 Electron 主进程的 stdout 常传不回管道：让它同时写一份 JSON，读文件兜底。
const TRACE_OUT = join(HERE, '.trace.json')
const childEnv = {
  ...process.env,
  DSH_ZOO_ROOT: ROOT,
  DSH_ZOO_TRACE_OUT: TRACE_OUT,
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
}
delete childEnv.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, [join(HERE, 'main.cjs')], {
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe']
})

let out = ''
let err = ''
child.stdout.on('data', (chunk) => { out += chunk })
child.stderr.on('data', (chunk) => { err += chunk })

const code = await new Promise((resolve) => child.on('exit', resolve))
const line = out.split('\n').find((entry) => entry.startsWith('@@DATA@@'))
let data = null
if (line !== undefined) {
  data = JSON.parse(line.slice('@@DATA@@'.length))
} else {
  // Windows 的 GUI 子系统进程拿不到 stdout：退回它写的那份文件。
  try {
    data = JSON.parse(readFileSync(TRACE_OUT, 'utf8'))
    console.log('（stdout 是空的，从 .trace.json 读的结果）')
  } catch {
    data = null
  }
}
if (data === null) {
  console.error('没有拿到 @@DATA@@（exit ' + code + '）')
  console.error('stdout:\n' + out)
  console.error('stderr:\n' + err)
  process.exit(2)
}
if (data.error !== undefined) {
  console.error('harness 报错:\n' + data.error)
  process.exit(2)
}

const t = Object.fromEntries(data.trace.map((entry) => [entry.label, entry]))
let failures = 0
const check = (ok, message) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + message)
  if (!ok) failures += 1
}

const sec = (label) => remainingSeconds(t[label]?.text)
console.log('—— 观察到的「还剩 …」——')
for (const entry of data.trace) {
  console.log('  ' + entry.label.padEnd(20) + ' ' + String(entry.text) + '   (≈' + remainingSeconds(entry.text) + 's)')
}
console.log('—— 断言 ——')

// A：正常 3 秒应该走 3 秒左右（健康基线）
const d1 = sec('t0') - sec('after-3s')
check(d1 >= 2 && d1 <= 5, '空闲 3 秒，倒计时走了 ' + d1 + 's（应 ≈3s）')

// B：阻塞 5 秒后必须按真实时间补上（旧实现只走 1 个 tick）
const d2 = sec('after-3s') - sec('after-block-5s')
check(d2 >= 4, '阻塞 5 秒，倒计时走了 ' + d2 + 's（应 ≥4s；只走 1s 就是 setInterval 逐拍递减）')

// C：切页 3 秒回来，时间必须继续往下走（旧实现会退回快照值 = 倒流）
const d3 = sec('after-block-5s') - sec('after-tab-away-3s')
check(d3 >= 3, '切走 3 秒再回来，倒计时走了 ' + d3 + 's（应 ≥3s；负数=倒流，0=时间停住）')

// D：总账：整段真实经过时间 ≈ 12 秒，剩余时间应相应减少
const elapsed = Math.round((t['after-tab-away-3s'].at - t.t0.at) / 1000)
const dropped = sec('t0') - sec('after-tab-away-3s')
check(Math.abs(dropped - elapsed) <= 2, '整段 ' + elapsed + 's，倒计时一共走了 ' + dropped + 's（应 ≈' + elapsed + 's）')

// E：没有向宿主乱发动作（调试台不接动作，但要知道是否发了 farm-refresh）
console.log('提交的动作：' + JSON.stringify(data.submits))

process.exit(failures === 0 ? 0 : 1)
