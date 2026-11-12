#!/usr/bin/env node
/**
 * 测试入口（票 60 → 票 62）。
 *
 * 只有一档：`test/` 下所有 `*.test.js`，跑完就结束。
 *
 * 原来分成「核心档 / 网络档」，网络档是 21 个会开 socket 的回环用例（发现/串门/礼物/
 * 雇工/本机 HTTP）。票 62 按用户要求整档删掉：这些用例开 socket、绑端口、跑真实计时器，
 * 既慢又容易和正在跑的 DSH 互相干扰，而真正的跨机验证放到目标机器（`DESKTOP-699DN63`）
 * 上一次做完。文件在 git 历史里还能找回来（删于票 62 那次提交）。
 *
 * 用法：
 *   node scripts/run-tests.mjs           # 跑全部（npm test）
 *   node scripts/run-tests.mjs --list    # 只打印会跑哪些文件，一个都不执行
 */

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TEST_DIR = join(ROOT, 'test')

const listOnly = process.argv.slice(2).includes('--list')

const selected = (await readdir(TEST_DIR))
  .filter((name) => name.endsWith('.test.js'))
  .sort()

process.stdout.write('[dsh-zoo] 用例文件：' + selected.length + ' 个\n')

if (listOnly) {
  for (const name of selected) process.stdout.write('  ' + name + '\n')
  process.exit(0)
}
if (selected.length === 0) process.exit(0)

const args = [
  '--test',
  '--test-concurrency=4',
  '--test-force-exit',
  ...selected.map((name) => join(TEST_DIR, name))
]
const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
child.on('error', (error) => {
  process.stderr.write('[dsh-zoo] 启动测试进程失败：' + error.message + '\n')
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal !== null) {
    process.stderr.write('[dsh-zoo] 测试进程被 ' + signal + ' 结束\n')
    process.exit(1)
  }
  process.exit(code ?? 1)
})
