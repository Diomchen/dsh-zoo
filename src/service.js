import { hostname } from 'node:os'

import { createDiscovery } from './discovery.js'
import { createIdentity, defaultNickname } from './identity.js'
import { dataDir, dshPetConfigPath } from './paths.js'
import { createPeerStore } from './peers.js'
import { createPetBridge, readPetConfig } from './pet-bridge.js'
import {
  HEARTBEAT_INTERVAL_MS,
  encodeHeartbeat,
  isDeviceId,
  normalizeNickname,
  resolvePort
} from './protocol.js'
import { createRoom } from './room.js'

export const ROUTE_PREFIX = '/local-pet'
export const NEIGHBOR_TICK_MS = 1000

/**
 * 把客厅接到 DSH 的同一个源上：本地浏览器照旧带着自己的 cookie 来读，
 * 不需要跨域、不需要第二个口令。局域网上的串门流量**不走**这里（见 ADR-0002），
 * 这里的路由只服务已经打开的 DSH 页面。
 *
 * I/O 都在这个薄壳里：
 * - identity 落盘（src/identity.js）
 * - 放行/拒绝名单落盘（src/peers.js）
 * - dsh-pet 轮询（src/pet-bridge.js）
 * - UDP 发现（src/discovery.js）
 * 它们只把结果翻译成 room 的方法调用；room 保持纯。
 */
export function createService (ctx, options = {}) {
  const env = options.env ?? process.env
  const dir = options.dataDir ?? dataDir(env)
  const configPath = options.petConfigPath ?? dshPetConfigPath(env)
  const log = makeLogger(ctx)
  const room = createRoom({ dir, log })
  const disposers = []

  let identity = null
  let discovery = null
  let peers = null
  let bridge = null
  let tickTimer = null
  let heartbeatTimer = null
  let disposed = false

  disposers.push(register(ctx, {
    kind: 'exact',
    path: ROUTE_PREFIX + '/state',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      sendJson(res, 200, room.snapshot())
    }
  }))

  disposers.push(register(ctx, {
    kind: 'exact',
    path: ROUTE_PREFIX + '/action',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      let body
      try {
        body = await readJson(req, 8 * 1024)
      } catch (error) {
        return sendJson(res, 400, { error: 'bad-body', detail: message(error) })
      }
      const result = await handleAction(body)
      sendJson(res, result.ok ? 200 : 409, result)
    }
  }))

  async function handleAction (body) {
    if (disposed) return { ok: false, error: 'disposed' }
    const action = typeof body?.action === 'string' ? body.action : null

    // 放行/拒绝只接受本地页面发来的 UUID；远端 UDP 永远走不到这个分支。
    // room 只改内存并返回决定，落盘交给 src/peers.js（唯一允许的额外写入）。
    if (action === 'admit' || action === 'reject') {
      if (peers === null) return { ok: false, error: 'starting' }
      const deviceId = actionDeviceId(body?.deviceId)
      if (deviceId === null) return { ok: false, error: 'bad-device-id' }
      const decision = action === 'admit' ? room.admit(deviceId) : room.reject(deviceId)
      if (!decision.ok) return decision
      const persisted = action === 'admit'
        ? await peers.admit({ deviceId, nickname: decision.nickname, at: decision.at })
        : await peers.reject({ deviceId, nickname: decision.nickname, at: decision.at })
      // 放行后立刻补一发心跳：对方不用等满 2 秒才第一次看见我。
      if (action === 'admit') sendHeartbeats()
      return {
        ok: true,
        action,
        deviceId,
        nickname: decision.nickname,
        status: decision.status,
        persisted
      }
    }

    // “稍后再说”：只让队列前进，不改变任何信任状态，也不落盘。
    if (action === 'dismiss') {
      const deviceId = actionDeviceId(body?.deviceId)
      if (deviceId === null) return { ok: false, error: 'bad-device-id' }
      const result = room.dismissPrompt(deviceId)
      if (!result.ok) return result
      return { ok: true, action: 'dismiss', deviceId, prompt: result.prompt }
    }

    // 昵称是 ticket 02 的身份字段：只接受本地页面发来的改名，远端永远碰不到。
    if (action === 'rename') {
      if (identity === null) return { ok: false, error: 'starting' }
      const nickname = normalizeNickname(body?.nickname)
      if (nickname === null) return { ok: false, error: 'bad-nickname' }
      const saved = await identity.rename(nickname)
      if (saved === null) return { ok: false, error: 'identity-not-writable' }
      room.setSelfNickname(saved)
      // 下一次广播会带上新昵称；立即补一发，让邻居不用等满 5 秒。
      discovery?.sendBeacon()
      return { ok: true, action: 'rename', nickname: saved }
    }

    return room.action(body)
  }

  async function start () {
    try {
      // 先把放行/拒绝名单读进内存，再开始发现：重启后第一次广播就不会再问。
      peers = await createPeerStore(dir, { log })
      if (disposed) return
      room.setTrust(peers.trust())

      const petConfig = await readPetConfig(configPath)
      if (disposed) return
      const fallback = defaultNickname({ petName: petConfig.name, hostname: hostname() })
      identity = await createIdentity(dir, { defaultNickname: fallback, log })
      if (disposed) return
      room.setIdentity(identity)

      if (options.network !== false) {
        const port = options.port ?? resolvePort(env)
        discovery = createDiscovery({
          identity,
          port,
          // 下面几项只为测试注入：回环上跑两个实例，不依赖真实广播域。
          targetPort: options.targetPort,
          bindAddress: options.bindAddress,
          broadcastAddress: options.broadcastAddress,
          beaconIntervalMs: options.beaconIntervalMs,
          // 出站单播（心跳/串门）在发现层里也只走这一个门控。
          mayTalkTo: (deviceId) => room.mayTalkTo(deviceId),
          onPeer (packet) {
            if (disposed) return
            // 远端字段到这里只剩两种效果：更新邻居/访客表，让客户端画出来。
            if (packet.type === 'heartbeat') room.observeHeartbeat(packet)
            else room.observeBeacon(packet)
          },
          log
        })
        try {
          await discovery.start()
        } catch (error) {
          if (disposed) return
          warn(ctx, '发现服务没起来，邻居灯不会亮（本地影子仍然可用）：' + message(error))
          discovery?.dispose()
          discovery = null
        }
      }
      if (disposed) return
      startHeartbeat()

      if (options.petBridge !== false) {
        bridge = createPetBridge({
          getOrigin: () => dshPetOrigin(ctx),
          configPath,
          log,
          onChange (result) {
            if (disposed) return
            room.setSelfPet(result.pet)
            room.setBridge(result.bridge)
            // 动作变了就立刻补发心跳，不等下一次 2 秒节拍：
            // 对方客厅里的访客因此能尽快跟着换动作。
            sendHeartbeats()
          }
        })
        // 首轮失败不会 reject；它只是把 room 降级成一行说明。
        await bridge.start()
      }

      if (!disposed && options.network !== false) {
        startNeighborTick()
      }
    } catch (error) {
      if (disposed) return
      warn(ctx, '启动失败，客厅会降级：' + message(error))
      room.setBridge({ ok: false, reason: 'error' })
      // 发现可能已经起来了；即使桥接坏掉，邻居灯也必须能按时过期。
      if (options.network !== false) startNeighborTick()
    }
  }

  /**
   * 心跳只承载本机宠物的当前动作名。编码器按类型只写
   * `{ v, type, deviceId, anim }`，昵称、端口、坐标都没有入口。
   */
  function heartbeatData () {
    if (identity === null) return null
    const anim = room.snapshot().self.pet?.anim ?? null
    try {
      return encodeHeartbeat({ deviceId: identity.deviceId, anim })
    } catch {
      // 本机身份坏了只停心跳，不影响邻居灯和本地影子。
      return null
    }
  }

  /**
   * 向所有已放行的邻居发一次心跳。返回实际交给 socket 的条数。
   * discovery.sendTo 会再过一遍 mayTalkTo 和地址表，所以未放行/没地址的
   * 邻居在这一层不会被发到。
   */
  function sendHeartbeats () {
    if (disposed || discovery === null) return 0
    const data = heartbeatData()
    if (data === null) return 0
    let sent = 0
    for (const deviceId of room.heartbeatTargets()) {
      try {
        if (discovery.sendTo(deviceId, data)) sent += 1
      } catch {
        // 一个坏地址不能挡住其他邻居的心跳
      }
    }
    return sent
  }

  function startHeartbeat () {
    if (heartbeatTimer !== null || disposed || discovery === null) return
    const configured = options.heartbeatIntervalMs
    const interval = Number.isFinite(configured) && configured >= 100
      ? configured
      : HEARTBEAT_INTERVAL_MS
    // 启动时先发一轮；此时通常还没有 allowed 邻居，不产生任何包。
    sendHeartbeats()
    heartbeatTimer = setInterval(sendHeartbeats, interval)
    heartbeatTimer.unref?.()
  }

  function startNeighborTick () {
    if (tickTimer !== null || disposed) return
    tickTimer = setInterval(() => room.tick(), NEIGHBOR_TICK_MS)
    tickTimer.unref?.()
  }

  const ready = start()

  return {
    room,
    ready,
    snapshot: () => room.snapshot(),
    /** ticket 04 的心跳/串门发送必须走这一个门控。 */
    mayTalkTo: (deviceId) => room.mayTalkTo(deviceId),
    /** ticket 04 的窄口：地址只从这里出，单播只从这里发（内部先过 mayTalkTo）。 */
    addressOf: (deviceId) => discovery?.addressOf(deviceId) ?? null,
    sendTo: (deviceId, data) => discovery?.sendTo(deviceId, data) ?? false,
    /** 手动补发一轮心跳（测试与 ticket 05 的“立刻让对方看见我”可复用）。 */
    sendHeartbeats,
    dispose () {
      if (disposed) return
      disposed = true
      if (tickTimer !== null) {
        clearInterval(tickTimer)
        tickTimer = null
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      discovery?.dispose()
      discovery = null
      bridge?.dispose()
      bridge = null
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // 关不掉也不能挡住卸载
        }
      }
      room.dispose()
    }
  }
}

/**
 * DSH 的 webServer 有两个可读入口：文档化的 `getOrigin()`，和 dsh-pet
 * 实际在用的 `.port`。插件 apply 可能早于 listen，所以这里每次现取；
 * 取不到就返回 null，下一轮轮询再试。
 */
function dshPetOrigin (ctx) {
  const server = ctx?.webServer
  let port = null
  try {
    if (typeof server?.getOrigin === 'function') {
      const origin = server.getOrigin()
      if (typeof origin === 'string' && origin !== '') {
        const parsed = new URL(origin)
        if (parsed.port !== '') port = Number(parsed.port)
        else if (parsed.protocol === 'http:') port = 80
        else if (parsed.protocol === 'https:') port = 443
      }
    }
  } catch {
    // listen 还没绑定，退回 .port
  }
  if (!Number.isInteger(port) || port <= 0) {
    const direct = server?.port
    if (Number.isInteger(direct) && direct > 0) port = direct
  }
  return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null
}

function register (ctx, options) {
  const dispose = ctx.webServer.register(options)
  return typeof dispose === 'function' ? dispose : () => {}
}

/** 本机页面发来的 deviceId：必须是协议里的 UUID 形状，统一小写。 */
function actionDeviceId (value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return isDeviceId(id) ? id.toLowerCase() : null
}

function makeLogger (ctx) {
  return {
    info: (line) => write(ctx, 'info', line),
    warn: (line) => write(ctx, 'warn', line)
  }
}

function write (ctx, level, line) {
  const full = '[dsh-local-pet] ' + line
  try {
    const fn = ctx?.logger?.[level]
    if (typeof fn === 'function') fn.call(ctx.logger, full)
    else console[level === 'warn' ? 'warn' : 'log'](full)
  } catch {
    // 日志不能反过来把插件搞崩
  }
}

function warn (ctx, line) {
  write(ctx, 'warn', line)
}

function sendJson (res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readJson (req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function message (error) {
  return error instanceof Error ? error.message : String(error)
}
