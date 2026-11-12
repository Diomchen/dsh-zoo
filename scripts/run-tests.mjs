#!/usr/bin/env node
/**
 * 测试入口（票 60）：默认只跑**不碰网络**的用例。
 *
 *   node scripts/run-tests.mjs             # 核心用例（npm test / npm run check 用的就是这条）
 *   node scripts/run-tests.mjs --network   # 只跑回环网络用例（npm run test:net）
 *   node scripts/run-tests.mjs --all       # 两档都跑（npm run test:all，发布前用）
 *   node scripts/run-tests.mjs --list      # 只打印会跑哪些文件，一个都不执行
 *
 * 为什么要有这个脚本：`npm test` 是所有人日常会敲的命令，而网络用例会开 socket、
 * 绑回环端口、跑真实计时器——机器上同时开着 DSH 的时候又慢又容易互相干扰。
 * 分档以后默认那条又快又安静；需要验网络时显式跑，真机联调只对 DESKTOP-699DN63 做。
 */

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NETWORK_TESTS } from './test-groups.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TEST_DIR = join(ROOT, 'test')

const argv = process.argv.slice(2)
const mode = argv.includes('--network') ? 'network' : argv.includes('--all') ? 'all' : 'core'
const listOnly = argv.includes('--list')

const all = (await readdir(TEST_DIR))
  .filter((name) => name.endsWith('.test.js'))
  .sort()

const isNetwork = (name) => NETWORK_TESTS.has(name)
const selected = mode === 'all'
  ? all
  : all.filter((name) => isNetwork(name) === (mode === 'network'))

const skipped = all.length - selected.length
const label = mode === 'network' ? '网络（回环）' : mode === 'all' ? '全部' : '核心（不碰网络）'
process.stdout.write(
  '[dsh-zoo] ' + label + '：' + selected.length + ' 个用例文件' +
  (skipped > 0 ? '，跳过 ' + skipped + ' 个' : '') +
  (mode === 'core' && skipped > 0 ? '（要跑网络用例：npm run test:net）' : '') + '\n'
)

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
  process.stderr.write('[dsh-zoo] 起不了测试子进程：' + (error?.message ?? String(error)) + '\n')
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
