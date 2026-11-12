#!/usr/bin/env node
/**
 * 跨机作物目录同步的验收脚本（票 59）。**只对一台指定机器单播**，不广播、不扫网段。
 *
 *   node scripts/verify-catalog-sync.mjs desktop-699dn63.local
 *   node scripts/verify-catalog-sync.mjs 10.10.10.110 --local http://127.0.0.1:61934 --wait 120
 *
 * 它做的事：
 *   1. 从本机 `/dsh-zoo/state` 读 `crops.hash`（本机目录指纹）；
 *   2. 每隔几秒给对面发**一条** beacon，收它的 beacon-ack，读它广告的 `crops.hash`；
 *   3. 两个指纹一致 → 两边目录已经收敛（请求 → 分片 → 合并整条链路通了），退出 0。
 *
 * 判读：
 *   - 对面 `caps` 里没有 `crops` → 它还是旧版本，先装新构建；
 *   - 一直不相等但它在动 → 两边各有自己的作物（哈希是整份目录的，不会相等）；
 *   - 完全收不到 ack → 机器离线/防火墙/端口不对。
 */

import dgram from 'node:dgram'
import { randomUUID } from 'node:crypto'

import { encodePacket, parsePacket } from '../src/protocol.js'

const args = process.argv.slice(2)

function valueOf (flag, fallback) {
  const index = args.indexOf(flag)
  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : fallback
}

const VALUE_FLAGS = new Set(['--local', '--wait', '--interval', '--port'])
let host
for (let index = 0; index < args.length; index += 1) {
  if (VALUE_FLAGS.has(args[index])) {
    index += 1
    continue
  }
  if (args[index].startsWith('--')) continue
  host = args[index]
  break
}

const localBase = valueOf('--local', 'http://127.0.0.1:' + (process.env.DSH_ZOO_PORT ?? '61934'))
const waitMs = Number(valueOf('--wait', '120')) * 1000
const intervalMs = Math.max(1000, Number(valueOf('--interval', '8')) * 1000)
const port = Number(valueOf('--port', '45871'))

if (host === undefined) {
  process.stderr.write('用法：node scripts/verify-catalog-sync.mjs <host|ip> [--local http://127.0.0.1:61934] [--wait 120]\n')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function localHash () {
  const response = await fetch(localBase.replace(/\/+$/, '') + '/dsh-zoo/state')
  if (!response.ok) throw new Error('本机 /dsh-zoo/state 返回 ' + response.status)
  const body = await response.json()
  const hash = body?.crops?.hash
  if (typeof hash !== 'string' || hash === '') throw new Error('本机 state 里没有 crops.hash')
  return { hash, count: body?.crops?.count ?? 0 }
}

/** 发一条 beacon，等 beacon-ack；返回对面的 `{ caps, crops, nickname }` 或 null。 */
function probe (timeoutMs = 3000) {
  return new Promise((resolve) => {
    const deviceId = randomUUID()
    const socket = dgram.createSocket('udp4')
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try {
        socket.close()
      } catch {
        // 已经关了
      }
      resolve(value)
    }
    socket.on('message', (buffer) => {
      const parsed = parsePacket(buffer)
      if (!parsed.ok) return
      if (parsed.packet.type !== 'beacon-ack' && parsed.packet.type !== 'beacon') return
      finish(parsed.packet)
    })
    socket.on('error', () => finish(null))
    socket.bind(0, () => {
      const beacon = encodePacket({
        type: 'beacon',
        deviceId,
        nickname: 'verify',
        port: 45899,
        caps: ['raid', 'look', 'crops']
      })
      socket.send(beacon, port, host)
    })
    setTimeout(() => finish(null), timeoutMs)
  })
}

const mine = await localHash()
process.stdout.write('本机目录指纹 ' + mine.hash + '（' + mine.count + ' 种）\n')

const deadline = Date.now() + waitMs
let last = null
while (Date.now() < deadline) {
  const peer = await probe()
  if (peer === null) {
    process.stdout.write('· 没收到 ' + host + ' 的响应（离线/防火墙/端口）\n')
    await sleep(intervalMs)
    continue
  }
  const caps = Array.isArray(peer.caps) ? peer.caps : []
  const hash = peer.crops?.hash ?? null
  const count = peer.crops?.count ?? null
  if (last !== hash) {
    process.stdout.write('· 对面 ' + peer.nickname + ' caps=' + JSON.stringify(caps) +
      ' 指纹=' + (hash ?? '无') + (count === null ? '' : '（' + count + ' 种）') + '\n')
    last = hash
  }
  if (!caps.includes('crops')) {
    process.stderr.write('对面是旧版本（caps 里没有 crops），先装新构建再验。\n')
    process.exit(1)
  }
  if (hash !== null && hash === mine.hash) {
    process.stdout.write('✓ 两边目录指纹一致：' + hash + '\n')
    process.exit(0)
  }
  await sleep(intervalMs)
}

process.stderr.write('✗ ' + Math.round(waitMs / 1000) + ' 秒内没收敛。\n')
process.exit(1)
