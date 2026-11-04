import assert from 'node:assert/strict'
import test from 'node:test'

import { listProcesses, main, shortenCommand } from '../scripts/stop-helper.mjs'

/**
 * CLI 的平台分支：Windows 用 CIM（Git Bash 的 ps 给的是另一套 pid，不可靠），其余用 POSIX ps。
 * 真正要停谁由 src/helper-processes.js 决定，这里是「读进程列表」的那一段。
 */

test('Windows：走 powershell 的 CIM，不碰 ps', async () => {
  const calls = []
  const stdout = JSON.stringify({
    ProcessId: 40644,
    CommandLine: '"C:\\electron.exe" "C:\\pkg\\desktop\\main.js" --local-pet-host-pid 1'
  })
  const exec = async (command, args) => {
    calls.push({ command, args })
    return { stdout }
  }

  const list = await listProcesses({ platform: 'win32', exec })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.match(calls[0].args.join(' '), /Get-CimInstance Win32_Process/)
  assert.deepEqual(list.map((entry) => entry.pid), [40644])
})

test('macOS/Linux：走 ps -axo pid=,args=', async () => {
  const calls = []
  const stdout = '  777 /usr/bin/node scripts/smoke.mjs\n  888 /electron main.js --local-pet-host-pid 1\n'
  const exec = async (command, args) => {
    calls.push({ command, args })
    return { stdout }
  }

  const list = await listProcesses({ platform: 'darwin', exec })

  assert.equal(calls[0].command, 'ps')
  assert.deepEqual(calls[0].args, ['-axo', 'pid=,args='])
  assert.deepEqual(list.map((entry) => entry.pid), [777, 888])
})

test('main：--dry-run 只列不杀', async () => {
  const kills = []
  const exec = async () => ({ stdout: '  40644 /e main.js --local-pet-host-pid 1\n' })

  const code = await main(['--dry-run'], {
    platform: 'darwin',
    exec,
    kill: (pid, signal) => kills.push(signal)
  })

  assert.equal(code, 0)
  assert.deepEqual(kills, [], 'dry-run 一个都不许杀')
})

test('main：先 SIGTERM；宽限期内不退再 SIGKILL；退了就算成功', async () => {
  const kills = []
  let running = true
  const exec = async () => ({ stdout: '  40644 /e main.js --local-pet-host-pid 1\n' })

  const code = await main([], {
    platform: 'darwin',
    exec,
    graceMs: 100,
    kill: (pid, signal) => {
      kills.push(signal)
      // 模拟「SIGTERM 不理，SIGKILL 才死」的 helper
      if (signal === 'SIGKILL') running = false
    },
    alive: () => running
  })

  assert.equal(code, 0)
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL'])
})

test('main：SIGKILL 也停不掉就非零退出（靠调用方看见）', async () => {
  const exec = async () => ({ stdout: '  40644 /e main.js --local-pet-host-pid 1\n' })

  const code = await main([], {
    platform: 'darwin',
    exec,
    graceMs: 80,
    kill: () => {},
    alive: () => true
  })

  assert.equal(code, 1)
})

test('命令行太长只留头尾，打印不刷屏', () => {
  const short = shortenCommand('x'.repeat(400))
  assert.ok(short.length < 200)
  assert.match(short, /…/)
  assert.equal(shortenCommand('  /electron main.js  '), '/electron main.js')
})
