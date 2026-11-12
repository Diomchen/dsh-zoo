import dgram from 'node:dgram'

import {
  BEACON_INTERVAL_MS,
  DEFAULT_PORT,
  MAX_NEIGHBORS,
  MAX_PACKET_BYTES,
  createRateLimiter,
  encodePacket,
  isDeviceId,
  isPort,
  parsePacket
} from './protocol.js'

/**
 * 局域网发现：UDP 广播 + 单播回执。这里只做传输，不碰客厅状态。
 *
 * 收到一个合法 beacon 时：
 *   1. 按 deviceId 记住来源地址/服务端口（每次报文都刷新）；
 *   2. 把**白名单后的**报文交给 onPeer（service 再喂给 room）；
 *   3. 对来源地址单播一条 beacon-ack（每来源限速，避免回执风暴）。
 *
 * 地址只留在这一层，通过 addressOf(deviceId) 单独取；**绝不进快照**。
 * 出站单播只走 sendTo()：先过 mayTalkTo（ticket 04 的心跳、ticket 05 的
 * request/ack/recall 必须走这里），再按 deviceId 查地址。sendReply() 是 sendTo
 * 之外唯一能发给未放行来源的应用层出口，只给 visit-deny 用（发现层对 beacon
 * 的自动回执是既有例外，与本条无关）。
 * 这一层没有心跳本身。
 * 广播地址与端口都可注入，测试因此可以用回环上的真实 socket 对，不依赖外网。
 */
const INBOUND_WINDOW_MS = 10000
const INBOUND_MAX = 20
const ACK_WINDOW_MS = 4500
const ACK_MAX = 1
// visit-deny 是应用层唯一允许发给“还没放行”的来源的报文：它是对方请求的直接回应，
// 否则未放行的发起方只能等到超时，分不清“被拒绝”和“没人理”。每来源（UDP 源地址，
// 不是可轮换的 deviceId）2 次 / 5 秒，不给反射放大留空间；其余应用层出站仍然必须
// 过 mayTalkTo（sendTo）。
const REPLY_WINDOW_MS = 5000
const REPLY_MAX = 2

export function createDiscovery ({
  identity,
  port = DEFAULT_PORT,
  targetPort,
  servicePort,
  bindAddress = '0.0.0.0',
  broadcastAddress = '255.255.255.255',
  beaconIntervalMs = BEACON_INTERVAL_MS,
  mayTalkTo = () => false,
  skin = null,
  // 票 59：作物目录指纹（`{v,hash,count}` 或 null）。每拍现取，目录变了下一拍就是新的。
  crops = null,
  caps = null,
  onPeer,
  log,
  now = () => Date.now()
} = {}) {
  let socket = null
  let timer = null
  let boundPort = 0
  let started = false
  let disposed = false
  let versionWarned = false
  const warned = new Set()
  // deviceId -> { address, port, seenAt }。只服务后续的单播心跳/串门，
  // 调用方通过 addressOf() 读一份拷贝；绝不从这里往 room/snapshot 写地址。
  const endpoints = new Map()
  const inbound = createRateLimiter({
    windowMs: INBOUND_WINDOW_MS,
    max: INBOUND_MAX,
    maxSources: 128,
    now
  })
  const ackLimiter = createRateLimiter({
    windowMs: ACK_WINDOW_MS,
    max: ACK_MAX,
    maxSources: 128,
    now
  })
  const directLimiter = createRateLimiter({ windowMs: 5000, max: 4 })
  const replyLimiter = createRateLimiter({
    windowMs: REPLY_WINDOW_MS,
    max: REPLY_MAX,
    maxSources: 128,
    now
  })

  function advertisedPort () {
    if (Number.isInteger(servicePort) && servicePort > 0 && servicePort <= 65535) return servicePort
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
    return boundPort
  }

  function beaconTargetPort () {
    if (Number.isInteger(targetPort) && targetPort > 0 && targetPort <= 65535) return targetPort
    return advertisedPort()
  }

  function packetFor (type) {
    // 素材源端口可能比 discovery 晚起来（或压根起不来）：每拍现取，取不到就不带。
    const current = typeof skin === 'function' ? skin() : skin
    const announce = typeof crops === 'function' ? crops() : crops
    return encodePacket({
      type,
      deviceId: identity?.deviceId,
      nickname: identity?.nickname,
      port: advertisedPort(),
      skinPort: current?.port,
      skinId: current?.id,
      ...(caps === null ? {} : { caps }),
      ...(announce === null || announce === undefined ? {} : { crops: announce })
    })
  }

  function warnOnce (key, message) {
    if (warned.has(key)) return
    warned.add(key)
    warn(message)
  }

  function warn (message) {
    try {
      log?.warn?.(message)
    } catch {
      // 日志不能反过来把发现服务搞崩
    }
  }

  function sendPacket (data, destinationPort, destinationAddress) {
    if (socket === null || !started) return
    socket.send(data, destinationPort, destinationAddress, (error) => {
      if (error) warnOnce('send', '发现报文发不出去（网络可能不可用），邻居灯会暂时不亮')
    })
  }

  function sendBeacon () {
    if (socket === null || !started || disposed) return false
    let data
    try {
      data = packetFor('beacon')
    } catch (error) {
      warnOnce('encode', '本机身份不完整，发现广播暂停：' + errorName(error))
      return false
    }
    sendPacket(data, beaconTargetPort(), broadcastAddress)
    return true
  }

  function replyAck (rinfo) {
    if (socket === null || !started || disposed) return
    let data
    try {
      data = packetFor('beacon-ack')
    } catch (error) {
      warnOnce('encode', '本机身份不完整，发现广播暂停：' + errorName(error))
      return
    }
    sendPacket(data, rinfo.port, rinfo.address)
  }

  /**
   * 每次合法报文都刷新一条地址记录；以插入顺序当作最近活跃顺序，
   * 超过邻居上限就丢最久没刷新的，保证内存有界。
   *
   * beacon / beacon-ack 带 `port`（对方广告的服务端口）；heartbeat 没有 `port`，
   * 所以保留已知端口，不能把记录覆盖成 undefined——否则心跳一到，回程就断了。
   * 万一心跳先于任何 beacon 到达，退回 UDP 源端口（同一颗 socket）。
   */
  function rememberEndpoint (packet, address, sourcePort) {
    const existing = endpoints.get(packet.deviceId)
    const port = isPort(packet.port)
      ? packet.port
      : existing?.port ?? sourcePort
    if (!isPort(port)) return
    endpoints.delete(packet.deviceId)
    endpoints.set(packet.deviceId, {
      address,
      port,
      seenAt: now()
    })
    while (endpoints.size > MAX_NEIGHBORS) {
      const oldest = endpoints.keys().next().value
      if (oldest === undefined) break
      endpoints.delete(oldest)
    }
  }

  /** 给 ticket 04 的窄查询：只要地址和服务端口，不暴露内部表。 */
  function addressOf (deviceId) {
    if (typeof deviceId !== 'string') return null
    const endpoint = endpoints.get(deviceId)
    if (endpoint === undefined) return null
    return { address: endpoint.address, port: endpoint.port }
  }

  /**
   * 唯一允许往邻居发的单播出口。两道闸：
   *   1. mayTalkTo(deviceId) 放行（ticket 04 的心跳必须走这里）；
   *   2. 发现层记得这个 deviceId 的地址。
   * 只接受已编码的 Uint8Array，且不超过协议的 4 KiB 上限；返回是否已交给 socket。
   */
  function sendTo (deviceId, data) {
    if (disposed || !started || socket === null) return false
    if (typeof deviceId !== 'string' || deviceId === '') return false
    if (!(data instanceof Uint8Array) || data.length === 0 || data.length > MAX_PACKET_BYTES) return false
    let allowed = false
    try {
      allowed = mayTalkTo(deviceId) === true
    } catch {
      allowed = false
    }
    if (!allowed) return false
    const endpoint = endpoints.get(deviceId)
    if (endpoint === undefined) return false
    sendPacket(data, endpoint.port, endpoint.address)
    return true
  }

  /**
   * 除发现层对合法 beacon 的自动回执外，唯一一个绕过 mayTalkTo 的应用层单播出口，
   * 只给 `visit-deny` 用：对方发来串门请求但本机没放行它时，它必须收到一句明确的
   * “不行”，而不是等到超时。仍然是同一条 socket、同一个地址表、同样的 4 KiB 上限，
   * 并且按 UDP 源地址每 2 次 / 5 秒限速（不按可轮换的 deviceId）。
   * 它永远不用于心跳、ack、recall 或任何主动报文。
   */
  function sendReply (deviceId, data) {
    if (disposed || !started || socket === null) return false
    if (typeof deviceId !== 'string' || deviceId === '') return false
    if (!(data instanceof Uint8Array) || data.length === 0 || data.length > MAX_PACKET_BYTES) return false
    const endpoint = endpoints.get(deviceId)
    if (endpoint === undefined) return false
    // 按 UDP 源地址限速，而不是按报文里的 deviceId：deviceId 可以每次换一个，
    // 地址换不了，否则“每来源 2 次 / 5 秒”就形同虚设。
    if (!replyLimiter.allow(endpoint.address, now())) return false
    sendPacket(data, endpoint.port, endpoint.address)
    return true
  }

  /**
   * 票 53：给"来偷"这条链的免放行单播出口（ADR-0018：偷不需要放行）。
   * 只用于 `visit-request(purpose:'steal')` 与那一趟的 recall；每来源 4 次 / 5 秒，
   * 够"请求 + 两次重试 + 回执"用，又不给反射放大留空间。其余应用层出站仍必须过 `sendTo`。
   */
  function sendDirect (deviceId, data) {
    if (disposed || !started || socket === null) return false
    if (typeof deviceId !== 'string' || deviceId === '') return false
    if (!(data instanceof Uint8Array) || data.length === 0 || data.length > MAX_PACKET_BYTES) return false
    const endpoint = endpoints.get(deviceId)
    if (endpoint === undefined) return false
    if (!directLimiter.allow(endpoint.address, now())) return false
    sendPacket(data, endpoint.port, endpoint.address)
    return true
  }

  function onMessage (buffer, rinfo) {
    if (disposed || !started) return
    const source = rinfo?.address
    const sourcePort = rinfo?.port
    if (typeof source !== 'string' || source === '') return
    if (!Number.isInteger(sourcePort) || sourcePort <= 0 || sourcePort > 65535) return

    // 每来源限速：非法包也算，先限速再解析，避免被畸形流量拖垮。
    if (!inbound.allow(source, now())) return

    const parsed = parsePacket(buffer)
    if (!parsed.ok) {
      if (parsed.reason === 'version' && !versionWarned) {
        versionWarned = true
        warn('收到不同协议版本的发现报文，已忽略（协议版本不一致时不尝试兼容）')
      }
      return
    }

    const packet = parsed.packet
    if (identity?.deviceId !== undefined && packet.deviceId === identity.deviceId) return

    // 先记地址：即便 onPeer 把包丢掉（例如邻居表满），后续单播仍然找得到它。
    rememberEndpoint(packet, source, sourcePort)

    try {
      onPeer?.(packet)
    } catch {
      // 回调坏掉不能把 socket 弄崩；下一包还会继续走这里
      warnOnce('on-peer', '邻居报文处理失败，已丢弃')
    }

    if (packet.type === 'beacon' && ackLimiter.allow(source, now())) {
      replyAck({ address: source, port: sourcePort })
    }
  }

  function onSocketError () {
    warnOnce('socket', '发现服务的 socket 出错，邻居灯可能不亮（本地客厅不受影响）')
  }

  async function start () {
    if (disposed) throw new Error('discovery: disposed')
    if (started) return address()
    if (!isDeviceId(identity?.deviceId)) throw new Error('discovery: invalid identity')

    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket = sock
    sock.on('message', onMessage)
    sock.on('error', onSocketError)

    try {
      await new Promise((resolve, reject) => {
        const onListening = () => {
          cleanup()
          resolve()
        }
        const onBindError = (error) => {
          cleanup()
          reject(error)
        }
        const cleanup = () => {
          sock.off('listening', onListening)
          sock.off('error', onBindError)
        }
        sock.once('listening', onListening)
        sock.once('error', onBindError)
        try {
          sock.bind(port, bindAddress)
        } catch (error) {
          cleanup()
          reject(error)
        }
      })
    } catch (error) {
      dispose()
      throw error
    }

    if (disposed) {
      dispose()
      throw new Error('discovery: disposed during start')
    }

    boundPort = sock.address().port
    try {
      sock.setBroadcast(true)
    } catch {
      warnOnce('broadcast', '系统不允许 UDP 广播，邻居灯可能不亮')
    }
    sock.unref?.()
    started = true

    // 立刻广播一次，让两边在 5 秒内互相看见；之后每 5 秒一次。
    sendBeacon()
    const interval = Number.isFinite(beaconIntervalMs) && beaconIntervalMs >= 1000
      ? beaconIntervalMs
      : BEACON_INTERVAL_MS
    timer = setInterval(sendBeacon, interval)
    timer.unref?.()
    return address()
  }

  function address () {
    return { address: bindAddress, family: 'IPv4', port: boundPort }
  }

  function dispose () {
    disposed = true
    started = false
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    inbound.clear()
    ackLimiter.clear()
    replyLimiter.clear()
    directLimiter.clear()
    endpoints.clear()
    if (socket !== null) {
      try {
        socket.off('message', onMessage)
        socket.off('error', onSocketError)
        socket.close()
      } catch {
        // 已经关闭 / 还没绑定
      }
      socket = null
    }
  }

  return {
    start,
    sendBeacon,
    address,
    addressOf,
    sendTo,
    sendReply,
    sendDirect,
    dispose
  }
}

function errorName (error) {
  return error?.code || (error instanceof Error ? error.name : 'unknown')
}
