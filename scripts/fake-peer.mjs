#!/usr/bin/env node
// 假邻居：在这台机器上假装是"第二台机器"，用真协议跟你的插件说话。
//
// 它不做任何取巧的事——就是一颗 UDP socket，发真的 beacon、真的心跳、真的串门请求。
// 所以它能验的链路和真机一样：发现 → 放行 → 访客 → 串门 → 召回 → 记录。
//
// 用法：
//   node scripts/fake-peer.mjs                       # 默认 45872，对端 45871
//   node scripts/fake-peer.mjs --name 隔壁的小鲸鱼
//
// 然后在本地放行它（ticket 11 之前桌面还没有放行卡片，用 /local-pet/action 的 admit），
// 它的宠物就会出现在你的桌面上。
// 键盘：v = 让它来串门（你的桌面上出现"来访"）  a <动画名> = 换动作  n <新名字> = 改名  q = 退出
//
// 为什么要换个端口（45872）：你的插件已经占了 45871，同一台机器上再绑同一个 UDP 端口
// 在 macOS 上会打架。假邻居用一个自己的端口，靠报文里的 port 字段告诉对方"回我发这里"。

import dgram from 'node:dgram'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

import {
  BEACON_INTERVAL_MS,
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL_MS,
  MAX_PACKET_BYTES,
  encodeHeartbeat,
  encodePacket,
  encodeVisitAck,
  encodeVisitRequest,
  parsePacket
} from '../src/protocol.js'

const args = parseArgs(process.argv.slice(2))
const port = Number(args.port ?? DEFAULT_PORT + 1)
const targetPort = Number(args.target ?? DEFAULT_PORT)
// --bind：本机哪张网卡；--to：往哪儿发（默认发给本机回环）。
// 想让另一台机器上的插件看见你：--bind <本机 LAN IP> --to <本机 LAN 广播地址>
const bindAddress = args.bind ?? '127.0.0.1'
const destHost = args.to ?? bindAddress

let nickname = clean(args.name ?? '隔壁的小鲸鱼', 32)
let anim = args.anim ? clean(args.anim, 64) : null
const deviceId = randomUUID()
const autoVisit = args['auto-visit'] === undefined ? null : Number(args['auto-visit'])

const state = {
  endpoint: null, // { address, port } —— 从 beacon-ack 学来的对端地址
  admitted: false,
  theirAnim: null,
  visit: null // { id, nickname, timer }
}

const socket = dgram.createSocket('udp4')
const timers = []

socket.on('message', (data, rinfo) => {
  // 和真插件一样：4 KiB 上限，解析失败就当没收到。
  if (data.length > MAX_PACKET_BYTES) return
  const parsed = parsePacket(data)
  if (!parsed.ok) return
  handle(parsed.packet, rinfo)
})

socket.on('error', (error) => {
  console.error('[假邻居] socket 出错：' + error.message)
  shutdown(1)
})

socket.bind(port, bindAddress, () => {
  console.log(`[假邻居] 我是「${nickname}」，在 ${bindAddress}:${port} 上听着，去找 ${destHost}:${targetPort} 的插件。`)
  console.log(`[假邻居] 现在去 /local-pet/state 看 neighbors，用 /local-pet/action 的 admit 放行我；然后按 v 让${nickname}来串门。`)
  console.log('[假邻居] 键盘：v=让它来串门  a <动画名>=换动作  n <新名字>=改名  q=退出')
  // 发往广播地址必须先开 SO_BROADCAST，否则 macOS 直接 EACCES，而且错误会被静默吞掉。
  try {
    socket.setBroadcast(true)
  } catch (error) {
    console.error('[假邻居] 打不开发广播开关：' + error.message)
  }
  sendBeacon()
  timers.push(setInterval(sendBeacon, BEACON_INTERVAL_MS))
  timers.push(setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS))
  startInput()
})

function handle (packet, rinfo) {
  if (packet.deviceId === deviceId) return // 自己发的不理

  if (packet.type === 'beacon-ack') {
    // 对端告诉我们它自己的服务端口；以后心跳和串门都发这里。
    const next = { address: rinfo.address, port: packet.port }
    if (state.endpoint === null || state.endpoint.port !== next.port) {
      state.endpoint = next
      console.log(`[假邻居] 看见你的插件了（${next.address}:${next.port}）。等你在本地放行我。`)
    }
    return
  }

  if (packet.type === 'heartbeat') {
    state.theirAnim = packet.anim
    if (!state.admitted) {
      state.admitted = true
      console.log('[假邻居] 你放行了 🎉 按 v 让它来串门；来了会一直待到你送客。')
      // 脚本化演示：放行之后自动发一次串门，省得再敲键盘。
      if (autoVisit !== null && Number.isFinite(autoVisit)) {
        setTimeout(outboundVisit, Math.max(0, autoVisit) * 1000)
      }
    }
    return
  }

  if (packet.type === 'visit-request') {
    state.visit = { id: packet.visitId, nickname: packet.nickname }
    send(encodeVisitAck({ deviceId, visitId: packet.visitId }), rinfo.address, rinfo.port)
    console.log(`[假邻居] 🐾「${packet.nickname}」来串门了（动画：${packet.anim ?? '待机'}），会一直待到你送客。`)
    return
  }

  if (packet.type === 'visit-recall') {
    if (state.visit?.id === packet.visitId) {
      console.log(`[假邻居] 「${state.visit.nickname}」被召回家了。`)
      state.visit = null
    }
    return
  }

  if (packet.type === 'visit-deny') {
    console.log(`[假邻居] 串门被拒了：${reasonText(packet.reason)}`)
    return
  }
}

function sendBeacon () {
  try {
    const data = encodePacket({ type: 'beacon', deviceId, nickname, port })
    send(data, destHost, targetPort)
  } catch (error) {
    console.error('[假邻居] 广播编码失败：' + error.message)
  }
}

function sendHeartbeat () {
  if (state.endpoint === null) return
  try {
    send(encodeHeartbeat({ deviceId, anim }), state.endpoint.address, state.endpoint.port)
  } catch {
    // 假的，不必较真
  }
}

function send (data, address, destination) {
  socket.send(data, destination, address, () => {})
}

function startInput () {
  if (!process.stdin.isTTY) return
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const [command, ...rest] = line.trim().split(/\s+/)
    if (command === 'q') return shutdown(0)
    if (command === 'v') return outboundVisit()
    if (command === 'a') {
      const next = rest.join(' ').trim()
      if (next === '') return console.log('[假邻居] 用法：a 东张西望')
      anim = clean(next, 64)
      console.log('[假邻居] 动作换成「' + anim + '」，下一拍心跳就发出去。')
      return
    }
    if (command === 'n') {
      const next = rest.join(' ').trim()
      if (next === '') return console.log('[假邻居] 用法：n 新名字')
      nickname = clean(next, 32)
      console.log('[假邻居] 改名「' + nickname + '」，下一次广播生效。')
      sendBeacon()
      return
    }
    if (command === '?') {
      return console.log('[假邻居] v=让它来串门  a <动画名>=换动作  n <新名字>=改名  q=退出')
    }
    console.log('[假邻居] 不认识的命令，按 ? 看帮助。')
  })
}

function outboundVisit () {
  if (state.endpoint === null) {
    return console.log('[假邻居] 还没看见你的插件——确认 DSH 正在跑、UDP 45871 没被别的进程占。')
  }
  if (!state.admitted) {
    return console.log('[假邻居] 你还没放行我。先用 /local-pet/action 的 admit 放行，再让我串门。')
  }
  const visitId = randomUUID()
  send(
    encodeVisitRequest({ deviceId, visitId, nickname, anim }),
    state.endpoint.address,
    state.endpoint.port
  )
  console.log('[假邻居] 发出串门请求：等你的桌面上出现一位"来访"的客人。')
}

function reasonText (reason) {
  if (reason === 'visits-off') return '你关掉了串门开关（accept-visits=false），先打开它。'
  if (reason === 'not-admitted') return '你还没放行这个邻居。'
  return reason ?? '未知原因'
}

function clean (value, max) {
  const trimmed = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return Array.from(trimmed).slice(0, max).join('') || '邻居'
}

function shutdown (code) {
  for (const timer of timers) clearInterval(timer)
  try {
    socket.close()
  } catch {
    // 已经关了
  }
  console.log('[假邻居] 走了（下次见面还是一只新的：deviceId 每次随机）。')
  process.exit(code)
}

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}
