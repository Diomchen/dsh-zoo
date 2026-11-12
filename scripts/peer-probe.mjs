#!/usr/bin/env node
/**
 * 只对**一台指定机器**做局域网探测（票 59 的跨机验收用）。
 *
 * 为什么需要它：测试只有一档、且不再包含任何开 socket 的网络用例（票 62 删掉了那一档），
 * 而"局域网里能不能同步作物目录"
 * 这件事又必须真机验。这个脚本只发**一条单播** beacon 给指定主机，收它的
 * beacon-ack，把昵称/能力位/作物目录指纹打出来——**不广播、不扫网段**。
 *
 *   node scripts/peer-probe.mjs desktop-699dn63.local
 *   node scripts/peer-probe.mjs 10.10.10.110 --port 45871 --wait 3000
 *
 * 判读：
 *   - 有 `caps` 且含 `crops` → 对面跑的是带运行时作物目录的版本；
 *   - 只有 `raid`/`look` → 旧版本，先装新构建再验；
 *   - `crops.hash` 和本机一致 → 目录已经同步过，没东西要拉。
 */

import dgram from 'node:dgram'
import { randomUUID } from 'node:crypto'

import { encodePacket, parsePacket } from '../src/protocol.js'

const args = process.argv.slice(2)
function valueOf (flag, fallback) {
  const index = args.indexOf(flag)
  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : fallback
}

// 第一个不是 flag、也不是某个 flag 的值的东西，就是主机名。
const VALUE_FLAGS = new Set(['--port', '--wait', '--hash'])
let host
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (VALUE_FLAGS.has(arg)) {
    index += 1
    continue
  }
  if (arg.startsWith('--')) continue
  host = arg
  break
}
const port = Number(valueOf('--port', '45871'))
const waitMs = Number(valueOf('--wait', '3000'))
const ownHash = valueOf('--hash', null)

if (host === undefined) {
  process.stderr.write('用法：node scripts/peer-probe.mjs <host|ip> [--port 45871] [--wait 3000] [--hash <本机指纹>]\n')
  process.exit(2)
}
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write('端口不合法：' + valueOf('--port', '') + '\n')
  process.exit(2)
}

const deviceId = randomUUID()
const socket = dgram.createSocket('udp4')
let sawAck = false

socket.on('message', (buffer, rinfo) => {
  const parsed = parsePacket(buffer)
  if (!parsed.ok) return
  const packet = parsed.packet
  if (packet.type !== 'beacon-ack' && packet.type !== 'beacon') return
  sawAck = true
  const caps = Array.isArray(packet.caps) ? packet.caps : []
  const line = {
    from: rinfo.address + ':' + rinfo.port,
    nickname: packet.nickname,
    port: packet.port,
    caps,
    crops: packet.crops ?? null,
    runtimeCrops: caps.includes('crops')
  }
  process.stdout.write('PEER ' + JSON.stringify(line) + '\n')
  if (line.runtimeCrops === false) {
    process.stdout.write('判读：对面是旧版本（没有 crops 能力位），先把新构建装上去再验。\n')
  } else if (ownHash !== null && packet.crops?.hash === ownHash) {
    process.stdout.write('判读：目录指纹和本机一致，已经同步过了。\n')
  } else if (packet.crops !== null) {
    process.stdout.write('判读：对面支持运行时作物目录，可用它做跨机验证。\n')
  }
})

socket.on('error', (error) => {
  process.stderr.write('socket 出错：' + (error?.message ?? String(error)) + '\n')
  process.exit(1)
})

socket.bind(0, () => {
  const beacon = encodePacket({
    type: 'beacon',
    deviceId,
    nickname: 'probe',
    port: 45899,
    caps: ['raid', 'look', 'crops'],
    crops: ownHash === null ? null : { v: 1, hash: ownHash, count: 1 }
  })
  socket.send(beacon, port, host)
  process.stdout.write('SENT ' + beacon.length + 'B → ' + host + ':' + port + '（单播，只这一台）\n')
})

setTimeout(() => {
  if (!sawAck) process.stdout.write('TIMEOUT：' + waitMs + 'ms 内没收到 beacon-ack（机器离线/防火墙/端口不对）\n')
  socket.close()
  process.exit(sawAck ? 0 : 1)
}, Math.max(500, Number.isFinite(waitMs) ? waitMs : 3000))
