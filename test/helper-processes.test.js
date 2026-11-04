import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePsOutput, parseWindowsProcesses, pickHelperProcesses } from '../src/helper-processes.js'

/**
 * 首次从 0.4.0 升到 0.4.1 时，旧 helper 的 cwd 还落在包里，pnpm 替换包会 EPERM。
 * 现场只能先停掉它。这条缝就是「哪些进程是 local-pet 的 helper」，
 * 判据是宿主拉它时加的 `--local-pet-host-pid`（见 src/desktop-launch.js）。
 */

test('Windows：从 Win32_Process 的 JSON 里认出 helper，忽略别的 electron 与空命令行', () => {
  const json = JSON.stringify([
    {
      ProcessId: 40644,
      CommandLine: '"C:\\Users\\sean\\.dsh\\electron\\electron.exe" ' +
        '"C:\\Users\\sean\\.dsh\\profiles\\desktop\\node_modules\\dsh-local-pet\\desktop\\main.js" ' +
        '--local-pet-host-pid 35484'
    },
    {
      ProcessId: 777,
      CommandLine: '"C:\\Users\\sean\\.dsh\\electron\\electron.exe" "C:\\elsewhere\\desktop\\main.js"'
    },
    { ProcessId: 888, CommandLine: null }
  ])

  const picked = pickHelperProcesses(parseWindowsProcesses(json))

  assert.deepEqual(picked.map((entry) => entry.pid), [40644])
  assert.match(picked[0].command, /dsh-local-pet/, '停之前要能让人看清是哪一份包里的 helper')
})

test('Windows：只有一个进程时 ConvertTo-Json 给的是对象不是数组', () => {
  const json = JSON.stringify({
    ProcessId: 40644,
    CommandLine: '"C:\\electron.exe" "C:\\pkg\\desktop\\main.js" --local-pet-host-pid 35484'
  })

  assert.deepEqual(pickHelperProcesses(parseWindowsProcesses(json)).map((entry) => entry.pid), [40644])
})

test('Windows：空输出、坏 JSON 都只是「没找到」，不抛', () => {
  assert.deepEqual(parseWindowsProcesses(''), [])
  assert.deepEqual(parseWindowsProcesses('  \n'), [])
  assert.deepEqual(parseWindowsProcesses('not json'), [])
})

test('macOS/Linux：从 ps -axo pid=,args= 的文本里认出 helper', () => {
  const ps = [
    '40644 /Users/sean/.dsh/electron/Electron.app/Contents/MacOS/Electron /Users/sean/pkg/desktop/main.js --local-pet-host-pid 35484',
    '  777 /Applications/Some.app/Contents/MacOS/Some --local-pet-host-pid-typo 1',
    '  888 /usr/bin/node scripts/smoke.mjs',
    ''
  ].join('\n')

  const picked = pickHelperProcesses(parsePsOutput(ps))

  assert.deepEqual(picked.map((entry) => entry.pid), [40644])
})

test('同一 pid 出现两次只算一次（两条记录可能命中同一个进程）', () => {
  const list = [
    { pid: 40644, command: 'electron main.js --local-pet-host-pid 1' },
    { pid: 40644, command: 'electron main.js --local-pet-host-pid 1' }
  ]

  assert.deepEqual(pickHelperProcesses(list).map((entry) => entry.pid), [40644])
})
