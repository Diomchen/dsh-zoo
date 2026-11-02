import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'

import shared from '../desktop/shared.js'
import { createDesktop } from './desktop.js'
import { controlsFromSnapshot, droppedVisitors, petsFromSnapshot } from './desktop-pets.js'
import { createDiscovery } from './discovery.js'
import { createIdentity, defaultNickname } from './identity.js'
import { dataDir, dshPetConfigPath } from './paths.js'
import { resolveDshPetAssetDirs } from './pet-assets.js'
import { createPeerStore } from './peers.js'
import { createPetBridge, readPetConfig } from './pet-bridge.js'
import { writePetName } from './pet-name-write.js'
import { createSettingsStore } from './settings.js'
import { resolveSkinPort, startSkinServer } from './skin-server.js'
import { loadSkinSources } from './skin-sources.js'
import { createSkinFetcher } from './skin-fetch.js'
import {
  HEARTBEAT_INTERVAL_MS,
  PEER_LOST_MS,
  VISIT_MAX_MS,
  encodeHeartbeat,
  encodeVisitAck,
  encodeVisitDeny,
  encodeVisitRecall,
  encodeVisitRecallAck,
  encodeVisitRequest,
  isDeviceId,
  normalizeNickname,
  resolvePort
} from './protocol.js'
import { createRoom } from './room.js'
import { visitReasonText } from './visit-copy.js'
import { createVisitStore } from './visits.js'

export const ROUTE_PREFIX = '/local-pet'
export const NEIGHBOR_TICK_MS = 1000
/** 串门请求发三次（首次 + 两次重试），间隔约 600ms；拿不到 ack 就明确超时。 */
export const VISIT_REQUEST_ATTEMPTS = 3
export const VISIT_REQUEST_RETRY_MS = 600
export const VISIT_REQUEST_TIMEOUT_MS = 1800
/**
 * `visit-recall` 也用同样的重试：UDP 丢一包，对方就会把出门状态挂到 30 分钟上限，
 * 记录里也变成 30 分钟。首次 + 两次重试、间隔约 500ms；收到对方的
 * `visit-recall-ack`（或对方已经不可达）就提前收手。重发是幂等的：接收方按
 * deviceId 清一位访客、只写一条记录，重复 recall 不会重复记账。
 */
export const RECALL_ATTEMPTS = 3
export const RECALL_RETRY_MS = 500
export const RECALL_TIMEOUT_MS = 1500
/** 重试/超时计时器的检查粒度；测试可以调更快。 */
export const VISIT_TIMER_TICK_MS = 200
/** 桌面场景的巡检节拍：guest 出现/消失、对方动作变化最迟这么久后反映到桌面上。 */
export const DESKTOP_SYNC_MS = 500
/**
 * 自发串门策略的评估节拍：不追求秒级，30 秒足够让“最近有活动 + 冷却结束”的宠物
 * 在合理时间内出门，也不会让日志和定时器太吵。
 */
export const AUTO_VISIT_INTERVAL_MS = 30 * 1000
/** 同一条“为什么没出门”的日志最多每 5 分钟重复一次，避免刷屏。 */
export const AUTO_VISIT_LOG_INTERVAL_MS = 5 * 60 * 1000

/**
 * 把桌面接到 DSH 的同一个源上：本地浏览器照旧带着自己的 cookie 来读，
 * 不需要跨域、不需要第二个口令。局域网上的串门流量**不走**这里（见 ADR-0002），
 * 这里的路由只服务已经打开的 DSH 页面。
 *
 * I/O 都在这个薄壳里：
 * - identity 落盘（src/identity.js）
 * - 放行/拒绝名单落盘（src/peers.js）
 * - 桌面开关（入站串门 / 自发出门）落盘（src/settings.js）
 * - 串门记录落盘（src/visits.js）
 * - dsh-pet 轮询（src/pet-bridge.js）
 * - UDP 发现（src/discovery.js）
 * 它们只把结果翻译成 room 的方法调用；room 保持纯。
 */
export function createService (ctx, options = {}) {
  const env = options.env ?? process.env
  const dir = options.dataDir ?? dataDir(env)
  const configPath = options.petConfigPath ?? dshPetConfigPath(env)
  const log = makeLogger(ctx)
  const room = createRoom({
    dir,
    log,
    visitMaxMs: positiveOption(options.visitMaxMs, VISIT_MAX_MS, 100),
    // 测试注入：2 分钟失联窗口可以缩短，但生产默认不动。
    peerLostMs: positiveOption(options.peerLostMs, PEER_LOST_MS, 100)
  })
  const disposers = []
  const visitRetryMs = positiveOption(options.visitRetryMs, VISIT_REQUEST_RETRY_MS, 10)
  const visitTimeoutMs = positiveOption(
    options.visitTimeoutMs,
    VISIT_REQUEST_TIMEOUT_MS,
    visitRetryMs * 2
  )
  const visitAttempts = integerOption(options.visitAttempts, VISIT_REQUEST_ATTEMPTS, 1, 8)
  const visitTickMs = positiveOption(options.visitTickMs, VISIT_TIMER_TICK_MS, 10)
  const recallRetryMs = positiveOption(options.recallRetryMs, RECALL_RETRY_MS, 10)
  const recallAttempts = integerOption(options.recallAttempts, RECALL_ATTEMPTS, 1, 8)
  const recallTimeoutMs = positiveOption(options.recallTimeoutMs, RECALL_TIMEOUT_MS, recallRetryMs)
  const desktopSyncMs = positiveOption(options.desktopSyncMs, DESKTOP_SYNC_MS, 20)
  const autoVisitIntervalMs = positiveOption(options.autoVisitIntervalMs, AUTO_VISIT_INTERVAL_MS, 10)

  let identity = null
  let discovery = null
  let peers = null
  let visits = null
  let settings = null
  let bridge = null
  let desktop = null
  let desktopWorkArea = null
  let desktopHelperPid = null
  let desktopSceneSignature = null
  let desktopSyncTimer = null
  // 对外素材源（ticket 15）：端口与源 id 随 beacon/心跳广告；起不来就是 null。
  let skinServer = null
  let skinRef = null
  // 访客素材（ticket 17）：deviceId → { action, semantic, src?, fallback, at }。
  // 拉取是异步的，syncDesktop 只读这一份结果，绝不在同步路径上等网络。
  let skinFetcher = null
  const visitorSkins = new Map()
  // 本机宠物的待机池：dsh-pet 那一整套动作名；桌面只拿它轮播，不猜、不点播。
  // 测试可以注入 options.skinPool；生产由 startSkinSource 从注册表填。
  let skinPool = Array.isArray(options.skinPool) ? options.skinPool.slice() : []
  let tickTimer = null
  let heartbeatTimer = null
  let visitTimer = null
  let autoVisitTimer = null
  // 当前出门请求的重试状态；只活在 service，room 只记“在请求中/已抵达”。
  let request = null
  // 已发出、等回执的 visit-recall：visitId → { deviceId, attempts, nextAt, deadline }。
  const recalls = new Map()
  // 活动信号的可观测性：第一次见到某个来源、以及同一条策略结论的日志节流。
  const loggedActivitySources = new Set()
  let lastPolicyLog = { reason: null, at: 0 }
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

  // 本机宠物插件的状态入口（ticket 18）：只在本机回环上，不经过 UDP。
  // 没装 dsh-pet 的插件也可以推；推来的动作/气泡 30 秒内优先于桥接轮询。
  disposers.push(register(ctx, {
    kind: 'exact',
    path: ROUTE_PREFIX + '/self-state',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      let body
      try {
        body = await readJson(req, 4 * 1024)
      } catch (error) {
        return sendJson(res, 400, { error: 'bad-body', detail: message(error) })
      }
      const sayInput = body?.say
      // 字符串 = 一句短话，默认活 8 秒；对象形态由调用方自己带 until（仍受 30 秒封顶）。
      const say = typeof sayInput === 'string'
        ? { text: sayInput, until: Date.now() + 8000 }
        : sayInput
      const applied = room.setSelfState({
        action: typeof body?.action === 'string' ? body.action : null,
        semantic: typeof body?.semantic === 'string' ? body.semantic : null,
        say
      })
      if (!applied) return sendJson(res, 400, { ok: false, error: 'bad-state' })
      // 动作/气泡变了就立刻补发心跳，对方桌面不用等 2 秒节拍。
      sendHeartbeats()
      syncDesktop()
      sendJson(res, 200, { ok: true })
    }
  }))

  // 桌面 helper 的诊断出口：当前在播哪一段、失败集合、场景项数。
  // 只读、只在本机回环上；没有桌面层时返回 running:false。
  disposers.push(register(ctx, {
    kind: 'exact',
    path: ROUTE_PREFIX + '/desktop',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      if (desktop === null) return sendJson(res, 200, { running: false })
      let status = null
      let helperStatus = null
      try {
        status = typeof desktop.status === 'function' ? desktop.status() : null
        // 只读缓存永远看不到渲染端的 clip：这里主动问一次 helper（它回 status 事件）。
        if (typeof desktop.requestStatus === 'function') {
          const reply = await desktop.requestStatus()
          helperStatus = reply !== null && typeof reply === 'object' ? reply.status ?? null : null
        }
      } catch {
        helperStatus = null
      }
      sendJson(res, 200, { running: true, status, helperStatus })
    }
  }))

  async function handleAction (body) {
    try {
      return await handleActionInner(body)
    } finally {
      // 任何 action 都可能间接触发一次串门完成（拒绝清场、召回、到期）：
      // 统一在出口把内存记录交给 visits.json，并补发需要发的 visit-recall。
      flushRoomEffects()
    }
  }

  async function handleActionInner (body) {
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

    // 桌面开关（用户故事 22 + ticket 09）：分别管入站串门和自发出门，落盘在 settings.json。
    // 显式传 enabled，客户端按当前快照取反；非布尔值明确失败，不做隐式 toggle。
    if (action === 'accept-visits') {
      if (settings === null) return { ok: false, error: 'starting' }
      if (typeof body?.enabled !== 'boolean') return { ok: false, error: 'bad-enabled' }
      const persisted = await settings.setAcceptVisits(body.enabled)
      const acceptVisits = room.setAcceptVisits(body.enabled)
      return { ok: true, action: 'accept-visits', acceptVisits, persisted }
    }

    // ticket 09 的总开关：默认关，打开后宠物才可能自己出门。
    // 关掉不影响手动「串门」；这是本机 action，UDP 报文永远碰不到。
    if (action === 'auto-visits') {
      if (settings === null) return { ok: false, error: 'starting' }
      if (typeof body?.enabled !== 'boolean') return { ok: false, error: 'bad-enabled' }
      const persisted = await settings.setAutoVisits(body.enabled)
      const autoVisits = room.setAutoVisits(body.enabled)
      return { ok: true, action: 'auto-visits', autoVisits, persisted }
    }

    // 手动「串门」：可以指定 deviceId，也可以不带——后者是 ticket 11 的按钮路径，
    // 由宿主随机挑一位在线且互相放行的邻居。手动永远不受总开关/活动窗口限制。
    if (action === 'visit') {
      let deviceId
      if (body?.deviceId === undefined || body?.deviceId === null) {
        const target = room.pickVisitTarget()
        if (target === null) return room.noVisitTarget()
        deviceId = target.deviceId
      } else {
        deviceId = actionDeviceId(body.deviceId)
        if (deviceId === null) return { ok: false, error: 'bad-device-id' }
      }
      return startOutboundVisit(deviceId)
    }

    // 本地召回：已抵达会写 out 记录并让接收方立刻清场；还在请求中则只是取消。
    if (action === 'recall') {
      const result = room.recallOutbound()
      if (!result.ok) return result
      request = null
      return {
        ok: true,
        action: 'recall',
        cancelled: result.cancelled === true,
        visit: result.visit,
        record: result.record
      }
    }

    // 接收方提前结束一次入站串门：写 in 记录，并尽力通知对方回家。
    if (action === 'end-visit') {
      const deviceId = actionDeviceId(body?.deviceId)
      if (deviceId === null) return { ok: false, error: 'bad-device-id' }
      const result = room.endInboundVisit(deviceId)
      if (!result.ok) return result
      return {
        ok: true,
        action: 'end-visit',
        deviceId,
        record: result.record
      }
    }

    // 名字（ADR-0007）：装了 dsh-pet 时，名字的真相在它的 pets[].name 里——
    // 光改本地 identity.json 只会让“我看到的”和“邻居看到的”裂开，所以必须写进去才算数；
    // 没装 dsh-pet 时本地就是唯一去处，语义与 ticket 02 相同。
    if (action === 'rename') {
      if (identity === null) return { ok: false, error: 'starting' }
      const nickname = normalizeNickname(body?.nickname)
      if (nickname === null) return { ok: false, error: 'bad-nickname' }

      const petConfig = await readPetConfig(configPath)
      if (petConfig.exists) {
        const written = await writePetName({
          origin: dshPetOrigin(ctx),
          petId: petConfig.id,
          name: nickname
        })
        // 原子：写不进去就什么都不改，绝不留下“本地叫 A、dsh-pet 叫 B”的分叉。
        if (!written.ok) {
          return { ok: false, error: written.error, ...(written.status ? { status: written.status } : {}) }
        }
        // dsh-pet 已经写好了：本机镜像跟上。这里走 identity.rename 是为了**落盘之后**才回 ok；
        // 磁盘写不进去也不回退——配置才是真相，重启会再对一遍（那种情况才用 mirror 兜底）。
        const saved = await identity.rename(nickname)
        const applied = saved ?? identity.mirror(nickname)
        if (applied === null) return { ok: false, error: 'bad-nickname' }
        applyNickname(applied)
        // dsh-pet 的配置变了：作废 30 秒缓存重读一次，桌面标签不用等下一拍。
        await bridge?.refresh?.()
        return { ok: true, action: 'rename', nickname: applied }
      }

      const saved = await identity.rename(nickname)
      if (saved === null) return { ok: false, error: 'identity-not-writable' }
      applyNickname(saved)
      return { ok: true, action: 'rename', nickname: saved }
    }

    return { ok: false, error: 'not-implemented', action }
  }

  async function start () {
    try {
      // 先把放行/拒绝名单读进内存，再开始发现：重启后第一次广播就不会再问。
      peers = await createPeerStore(dir, { log })
      if (disposed) return
      room.setTrust(peers.trust())

      // 桌面开关也是本机状态：读不出来就按默认值（入站开、自发关），桌面照常可用。
      try {
        settings = await createSettingsStore(dir, { log })
        room.setAcceptVisits(settings.acceptVisits)
        room.setAutoVisits(settings.autoVisits)
      } catch (error) {
        settings = null
        warn(ctx, '桌面开关初始化失败，本次按“允许入站串门、不自动出门”运行：' + message(error))
      }
      if (disposed) return

      // 串门记录是“锦上添花”：读写失败只降级成空记录，绝不让桌面起不来。
      try {
        visits = await createVisitStore(dir, { log })
      } catch (error) {
        visits = null
        warn(ctx, '串门记录初始化失败，本次只在内存里保留记录：' + message(error))
      }
      if (disposed) return
      room.setVisitRecords(visits?.records() ?? [])

      const petConfig = await readPetConfig(configPath)
      if (disposed) return
      const fallback = defaultNickname({ petName: petConfig.name, hostname: hostname() })
      identity = await createIdentity(dir, { defaultNickname: fallback, log })
      if (disposed) return
      room.setIdentity(identity)

      // 桌面层（ticket 07）：一个全屏透明 helper + 一个占位方块。
      // 它坏了/起不来都只是「没有宠物」，这里不 await、不抛，网络与信任逻辑完全不受影响。
      startDesktopLayer()
      if (disposed) return

      if (options.network !== false) {
        skinFetcher = createSkinFetcher({ dir, log })
        // 先起素材源，再起发现：beacon 的第一拍就能带上 skinPort。
        await startSkinSource()
        if (disposed) return
        const port = options.port ?? resolvePort(env)
        discovery = createDiscovery({
          identity,
          port,
          // 下面几项只为测试注入：回环上跑两个实例，不依赖真实广播域。
          targetPort: options.targetPort,
          // 广告一个与 bind 不同的端口（回环上用一个会丢包的中继模拟 UDP 丢包）。
          servicePort: options.servicePort,
          bindAddress: options.bindAddress,
          broadcastAddress: options.broadcastAddress,
          beaconIntervalMs: options.beaconIntervalMs,
          // 素材源端口可能晚起/没起：每次现取，取不到就不带。
          skin: () => skinRef,
          // 出站单播（心跳/串门）在发现层里也只走这一个门控。
          mayTalkTo: (deviceId) => room.mayTalkTo(deviceId),
          onPeer (packet) {
            if (disposed) return
            // 远端字段到这里只剩三种效果：更新邻居/访客/串门表，让客户端画出来，
            // 以及一次串门完成时写一条有界记录。这里不读本机文件、不回传本机状态。
            if (packet.type === 'heartbeat') {
              room.observeHeartbeat(packet)
              noteVisitorSkin(packet)
            } else if (packet.type === 'visit-request') {
              handleVisitRequest(packet)
              noteVisitorSkin(packet)
            } else if (packet.type === 'visit-ack') {
              const result = room.observeVisitAck(packet)
              if (result.ok) clearRequest(packet.visitId)
            } else if (packet.type === 'visit-deny') {
              const result = room.observeVisitDeny(packet)
              if (result.ok) clearRequest(packet.visitId)
            } else if (packet.type === 'visit-recall') {
              const result = room.observeVisitRecall(packet)
              if (result.ok) {
                clearRequest(packet.visitId)
                // 回执：对方可能正拿着一条“没发出去”的 recall 在重试。
                sendVisitRecallAck(packet.deviceId, packet.visitId)
              }
            } else if (packet.type === 'visit-recall-ack') {
              // 对方确认收到了这次召回：不用再重发。
              clearRecall(packet)
            } else {
              room.observeBeacon(packet)
            }
            flushRoomEffects()
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
          // 只在测试里缩短：改名后的镜像跟随要能在几百毫秒内被观察到。
          configTtlMs: options.bridgeConfigTtlMs,
          pollIntervalMs: options.bridgePollMs,
          log,
          onChange (result) {
            if (disposed) return
            room.setSelfPet(result.pet)
            room.setBridge(result.bridge)
            // 名字的真相在 dsh-pet：配置里那只换了名字，本机跟着换（ADR-0007）。
            mirrorPetName(result.pet?.name)
            // 动作变了就立刻补发心跳，不等下一次 2 秒节拍：
            // 对方桌面上的访客因此能尽快跟着换动作。
            sendHeartbeats()
            syncDesktop()
          }
        })
        // 首轮失败不会 reject；它只是把 room 降级成一行说明。
        await bridge.start()
      }

      if (!disposed && options.network !== false) {
        startNeighborTick()
        startVisitTimer()
        startAutoVisitTimer()
      }
    } catch (error) {
      if (disposed) return
      warn(ctx, '启动失败，桌面会降级：' + message(error))
      room.setBridge({ ok: false, reason: 'error' })
      // 发现可能已经起来了；即使桥接坏掉，邻居灯也必须能按时过期。
      if (options.network !== false) {
        startNeighborTick()
        startVisitTimer()
        startAutoVisitTimer()
      }
    }
  }

  /**
   * 对外素材源（ticket 15）：把本机注册表里的源挂到一个只读 HTTP 端口上。
   * 起不来只影响「访客能不能拿我的素材」，不影响发现/串门/桌面。
   */
  async function startSkinSource () {
    try {
      const loaded = await loadSkinSources({ dataDir: dir, env })
      for (const warning of loaded.warnings) {
        log.warn('素材源：' + warning.code + (warning.detail === undefined ? '' : '（' + warning.detail + '）'))
      }
      // 待机池与「对外供源」是两件事：就算关掉对外服务，本机宠物也该有丰富动作。
      skinPool = loaded.sources.length > 0 ? Object.keys(loaded.sources[0].actions).sort() : []
      if (loaded.sources.length === 0) {
        log.info('没有可对外的素材源：访客先用本机素材，没有就画通用小人')
        return
      }
      if (options.skinServer === false) return
      const requested = Number.isInteger(options.skinPort) ? options.skinPort : resolveSkinPort(env)
      skinServer = await startSkinServer({
        sources: loaded.sources,
        port: requested,
        host: '0.0.0.0',
        log
      })
      if (skinServer === null) {
        log.warn('素材源端口没起来：访客先用本机素材，没有就画通用小人')
        return
      }
      skinRef = { port: skinServer.port, id: loaded.sources[0].id }
      log.info('素材源已对外：' + skinRef.id + ' @ ' + skinRef.port)
    } catch (error) {
      log.warn('素材源没起来（不影响串门）：' + message(error))
    }
  }

  /**
   * 访客素材（ticket 17）：按对方广告的 skinPort/skinId 异步拉当前动作。
   * 失败只影响这一只访客的“皮”，它仍然以通用小人出现；不阻塞心跳/串门。
   * 同一只访客同一个动作 60 秒内不重复拉（失败也有冷却，见 skin-fetch）。
   */
  function noteVisitorSkin (packet) {
    if (skinFetcher === null || discovery === null) return
    if (packet.skinPort === undefined || packet.skinId === undefined) return
    const endpoint = discovery.addressOf(packet.deviceId)
    if (endpoint === null || typeof endpoint.address !== 'string') return
    const action = packet.action ?? packet.anim ?? null
    const semantic = packet.semantic ?? 'other'
    const at = Date.now()
    const previous = visitorSkins.get(packet.deviceId)
    if (previous !== undefined && previous.action === action && previous.semantic === semantic &&
      at - previous.at < 60000) return

    skinFetcher.resolve({
      address: endpoint.address,
      port: packet.skinPort,
      skinId: packet.skinId,
      action
    }).then((result) => {
      if (disposed) return
      const next = { action, semantic, fallback: semantic, at: Date.now() }
      if (result !== null) next.src = result.url
      visitorSkins.set(packet.deviceId, next)
      syncDesktop()
    }).catch(() => {
      // 拉取失败已经由 skin-fetch 冷却；这里不让异常冒到心跳循环
    })
  }

  /**
   * 桌面层是**尽力而为**的一层：宿主不是桌面版、不是 macOS、没有 Electron、helper 崩了，
   * 都只让宠物不显示。这里绝不把异常抛回 start()，也不 await 它的启动（窗口就绪是异步的）。
   * 测试用 options.desktopFactory 注入假实现，options.desktop === false 直接跳过。
   */
  function startDesktopLayer () {
    if (options.desktop === false) return
    // 逃生开关：桌面窗是置顶全屏的，万一它在某台机器上行为不对，用户要能不改一行代码就关掉它。
    if (isDesktopDisabled(options.env ?? process.env)) {
      log.info('桌面层被 LOCAL_PET_DESKTOP 关闭：宠物不显示，网络与串门仍然工作')
      return
    }
    if (settings !== null && settings.desktop === false) {
      log.info('桌面层在 settings.json 里被关掉（desktop:false）：宠物不显示，网络与串门仍然工作')
      return
    }
    try {
      const factory = typeof options.desktopFactory === 'function' ? options.desktopFactory : createDesktop
      // 素材目录在宿主侧解析（不硬编码 profile 路径）；helper 只收到绝对路径。
      // 解析失败/没装 dsh-pet → 空数组 → 渲染端退内置色块，串门不受影响。
      const assetRoots = Array.isArray(options.dshPetAssets)
        ? options.dshPetAssets.slice()
        : resolveDshPetAssetDirs({ env })
      if (assetRoots.length === 0) {
        log.info('没找到 dsh-pet 素材目录，桌面宠物先用内置色块（串门不受影响）')
      }
      const manager = factory({
        log,
        env,
        platform: options.platform,
        versions: options.versions,
        desktopHost: options.desktopHost,
        helperPath: options.desktopHelperPath,
        debug: options.desktopDebug === true,
        maxRestarts: options.desktopMaxRestarts,
        assetRoots,
        cacheRoot: join(dir, 'skin-cache'),
        onEvent (event) {
          if (disposed || desktop === null) return
          if (event?.type === 'ready') {
            // helper 每次 ready（首次 / 崩溃重启 / 显示器变化）都会报工作区。
            // pid 变了 = 换了新 helper（渲染端是空的）→ reset 让它重新出生；
            // 同一个 pid = 只是显示器变化 → 保留现场位置，渲染端按新尺寸夹取。
            desktopWorkArea = event.workArea
            const pid = Number.isInteger(event.pid) && event.pid > 0 ? event.pid : null
            const restarted = pid === null || pid !== desktopHelperPid
            desktopHelperPid = pid
            desktopSceneSignature = null
            syncDesktop({ reset: restarted })
          } else if (event?.type === 'hit' && event.inside === true && event.point !== null) {
            // ticket 09 的**兜底**活动信号：session/event 没有活动时，光标真的碰到了宠物
            // 也算“有人在用这台机器”。helper 只在穿透翻转时发 hit，所以这是粗粒度信号；
            // 它够用来防止“人明明在电脑前，宠物却因为没敲 DSH 而不出门”。
            noteActivity('pointer')
          } else if (event?.type === 'action') {
            // ticket 11：桌面按钮只能**申请**动作。走和 HTTP /action 完全相同的 handleAction，
            // 结果（含人话 notice）再原样回给 helper，由渲染端冒泡/更新。
            void handleDesktopAction(event, manager)
          }
        }
      })
      // 先挂上引用：即使 start() 同步触发 ready（假实现可能这样），onEvent 也能拿到 manager。
      desktop = manager
      startDesktopSync()
      const started = manager.start()
      if (started !== null && typeof started?.then === 'function') {
        // 未来若 start 变成异步：失败也要安静地收掉，不能留下半个 manager。
        started.then((result) => {
          if (disposed || desktop !== manager) return
          if (result?.ok === false) {
            manager.dispose()
            desktop = null
            stopDesktopSync()
            return
          }
          log.info('桌面宠物窗口已启动')
        }).catch(() => {
          manager.dispose()
          if (desktop === manager) desktop = null
          stopDesktopSync()
        })
        return
      }
      if (started?.ok === false) {
        manager.dispose()
        if (desktop === manager) desktop = null
        stopDesktopSync()
        return
      }
      log.info('桌面宠物窗口已启动')
    } catch (error) {
      // 桌面层永远只能是「锦上添花」：初始化失败 = 这一行日志 + 没有宠物。
      try {
        desktop?.dispose()
      } catch {
        // 半初始化的 manager 也不能把 dispose 的异常抛出去
      }
      desktop = null
      stopDesktopSync()
      warn(ctx, '桌面层初始化失败，本次不显示宠物：' + message(error))
    }
  }

  /**
   * 宿主对「桌面上有谁」的权威同步。
   *
   * 场景只在宠物集合/动作/昵称真的变了时下发（签名比较），不是逐帧：位置和物理在渲染端。
   * 500ms 的巡检兜底所有状态变化路径（心跳、tick、桥接轮询、action），避免漏发某一条。
   */
  function syncDesktop ({ reset = false } = {}) {
    if (disposed || desktop === null || desktopWorkArea === null) return false
    const snapshot = room.snapshot()
    const pets = petsFromSnapshot(snapshot).map((pet) => {
      // 本机宠物：把 dsh-pet 的一整套动作名交给渲染端轮播，不再只轮 3 段待机。
      if (pet.role === 'self') {
        return skinPool.length === 0 ? pet : { ...pet, idlePool: skinPool }
      }
      if (pet.role !== 'visitor') return pet
      const key = pet.id.startsWith('visitor:') ? pet.id.slice('visitor:'.length) : null
      const skin = key === null ? undefined : visitorSkins.get(key)
      if (skin === undefined) return pet
      return {
        ...pet,
        ...(skin.src === undefined ? {} : { src: skin.src }),
        fallback: skin.fallback
      }
    })
    // 访客多到一次场景放不下：让 room 写一条人话提示（只提醒一次），
    // 这次同步就把 notice 带进场景；宠物不会静默消失。
    const dropped = droppedVisitors(snapshot)
    if (dropped > 0) room.noteSceneOverflow(dropped)
    const controls = controlsFromSnapshot(dropped > 0 ? room.snapshot() : snapshot)
    // 签名必须包含控件状态：串门按钮的可用性/放行卡/失败提示都可能在没有宠物增删时变化。
    const signature = JSON.stringify({ pets, controls })
    if (!reset && signature === desktopSceneSignature) return false
    desktopSceneSignature = signature
    const scene = shared.petScene(pets, desktopWorkArea, { reset, controls })
    try {
      if (reset && typeof desktop.resync === 'function') return desktop.resync(scene)
      return desktop.update(scene)
    } catch (error) {
      // 桌面层写管道失败只影响这一帧；下一次巡检会再试。
      return false
    }
  }

  /**
   * 桌面控件动作的唯一入口。白名单之外一律拒绝；动作本身走 handleAction，
   * 所以串门/召回/送客/放行和 HTTP 路径共享同一套 room 状态与错误文案。
   *
   * 无论成功失败都回一条 action-result——渲染端靠它把失败冒泡，不允许静默。
   */
  async function handleDesktopAction (event, manager) {
    if (disposed) return
    let result
    try {
      result = await handleAction({
        action: event.action,
        deviceId: event.deviceId ?? undefined,
        // 只有改名带正文；其余动作这里是 undefined，与 HTTP 那条路同形。
        nickname: event.nickname ?? undefined
      })
    } catch (error) {
      warn(ctx, '桌面控件动作失败（' + event.action + '）：' + message(error))
      result = { ok: false, error: 'action-failed' }
    }
    if (disposed) return
    const notice = result?.ok === true
      ? null
      : (typeof result?.notice === 'string' && result.notice.trim() !== ''
          ? result.notice
          : desktopActionNotice(result?.error))
    try {
      const target = desktop ?? manager
      if (target !== null && typeof target.actionResult === 'function') {
        target.actionResult(event.id, {
          ok: result?.ok === true,
          notice,
          error: typeof result?.error === 'string' ? result.error : null
        })
      }
    } catch {
      // 回话失败只影响这一次气泡；渲染端自己的超时会兜底
    }
    // 动作可能改变访客/出门状态；flushRoomEffects 已经同步一次，这里再补一次确保及时。
    syncDesktop()
  }

  /** 失败动作的兜底人话：room 通常已经给了 notice，这里只处理协议层的坏请求。 */
  function desktopActionNotice (error) {
    // starting / no-visitor / not-out 这类不需要昵称的原因，和 room 共用同一句文案。
    if (error === 'starting' || error === 'no-visitor' || error === 'not-out') {
      return visitReasonText(error)
    }
    if (error === 'bad-device-id' || error === 'unknown-neighbor') return '这位邻居已经不在桌面上了。'
    if (error === 'disposed') return '桌面正在关闭，这次操作没有完成。'
    if (error === 'not-implemented') return '这个操作暂不支持。'
    // 改名（ADR-0007）：两种失败都要能说清“为什么没生效”，而不是一句“稍后再试”。
    if (error === 'bad-nickname') return '这个名字不行：要么是空的，要么太长。'
    if (error === 'dsh-pet-unreachable') return 'dsh-pet 没有响应，名字没有改（它还开着吗？）。'
    if (error === 'dsh-pet-write-failed') return 'dsh-pet 没有接受这次改名，名字没有变。'
    if (error === 'dsh-pet-no-pet') return 'dsh-pet 里还没有宠物，没地方存这个名字。'
    return '这次操作没有完成，稍后再试。'
  }

  function startDesktopSync () {
    if (desktopSyncTimer !== null || disposed) return
    // 第一次 ready 之前 syncDesktop 是 no-op；ready 的 onEvent 会立刻同步一次。
    desktopSyncTimer = setInterval(() => {
      syncDesktop()
    }, desktopSyncMs)
    desktopSyncTimer.unref?.()
  }

  function stopDesktopSync () {
    if (desktopSyncTimer === null) return
    clearInterval(desktopSyncTimer)
    desktopSyncTimer = null
  }

  /**
   * 心跳只承载本机宠物的当前动作名。编码器按类型只写
   * `{ v, type, deviceId, anim }`，昵称、端口、坐标都没有入口。
   */
  function heartbeatData () {
    if (identity === null) return null
    const pet = room.snapshot().self.pet
    const anim = pet?.anim ?? null
    try {
      return encodeHeartbeat({
        deviceId: identity.deviceId,
        anim,
        // 只有宿主真的知道一个独立动作名时才发 action；等于 anim 时不必重复占字节。
        action: pet?.action ?? null,
        semantic: pet?.semantic ?? null,
        say: pet?.say ?? null,
        skinPort: skinRef?.port,
        skinId: skinRef?.id
      })
    } catch {
      // 本机身份坏了只停心跳，不影响邻居灯和本地影子。
      return null
    }
  }

  /**
   * 名字的真相在 dsh-pet（ADR-0007）：配置里那只叫什么，本机就叫什么。
   * 每轮配置轮询都会经过这里；名字没变就什么都不做。
   */
  function mirrorPetName (name) {
    if (disposed || identity === null) return
    const clean = normalizeNickname(name)
    if (clean === null || clean === identity.nickname) return
    const applied = identity.mirror(clean)
    if (applied === null) return
    applyNickname(applied)
  }

  /** 名字变了之后必须做的两件事：快照跟着变 + 立刻补发广播（邻居不用等 5 秒节拍）。 */
  function applyNickname (nickname) {
    room.setSelfNickname(nickname)
    discovery?.sendBeacon()
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
    const interval = positiveOption(options.tickIntervalMs, NEIGHBOR_TICK_MS, 10)
    tickTimer = setInterval(() => {
      room.tick()
      // tick 可能让一次串门到期：记录交给 visits.json，recall 交给 socket。
      flushRoomEffects()
    }, interval)
    tickTimer.unref?.()
  }

  function startVisitTimer () {
    if (visitTimer !== null || disposed || discovery === null) return
    visitTimer = setInterval(runVisitTimers, visitTickMs)
    visitTimer.unref?.()
  }

  function startAutoVisitTimer () {
    if (autoVisitTimer !== null || disposed || discovery === null) return
    autoVisitTimer = setInterval(() => {
      maybeSpontaneousVisit()
    }, autoVisitIntervalMs)
    autoVisitTimer.unref?.()
  }

  /**
   * 每 30 秒问一次纯策略：开关、活动、冷却、在线邻居四道门都过了才出门。
   * 每次判定都写进 room 快照（lastDecision），并按 reason 节流打一行日志，
   * 这样“为什么它没出门”在日志里能直接读到，不用猜。
   */
  function maybeSpontaneousVisit () {
    if (disposed) return null
    const plan = room.spontaneousVisitPlan()
    room.notePolicyDecision(plan)
    if (!plan.go || plan.candidate === null) {
      logPolicyPlan(plan)
      return plan
    }

    const result = startOutboundVisit(plan.candidate.deviceId)
    // 自动路径没有 action 的 finally：手动同步一次桌面，让本机立刻收起自己。
    flushRoomEffects()
    if (!result.ok) {
      // startOutboundVisit 已经在 room 里写了人话 notice；这里只补一行可检索的日志。
      log.info('自动串门没能出发（' + plan.candidate.nickname + '）：' + (result.error ?? 'unknown'))
      return { ...plan, result }
    }
    log.info('自动串门：出发去「' + plan.candidate.nickname + '」' + activitySuffix(plan))
    return { ...plan, result }
  }

  function logPolicyPlan (plan) {
    const now = Date.now()
    const same = lastPolicyLog.reason === plan.reason
    if (same && now - lastPolicyLog.at < AUTO_VISIT_LOG_INTERVAL_MS) return
    lastPolicyLog = { reason: plan.reason, at: now }
    log.info('自动串门：' + policyText(plan) + activitySuffix(plan))
  }

  function activitySuffix (plan) {
    const source = plan.activitySource === 'session'
      ? 'session/event'
      : plan.activitySource === 'pointer' ? '桌面指针' : '无活动信号'
    const age = Number.isFinite(plan.activityAgeMs)
      ? '，最近活动 ' + Math.round(plan.activityAgeMs / 1000) + ' 秒前'
      : ''
    const candidates = Number.isInteger(plan.candidates) ? '，可串门邻居 ' + plan.candidates + ' 位' : ''
    return '（活动信号：' + source + age + candidates + '）'
  }

  function policyText (plan) {
    if (plan.reason === 'disabled') return '总开关关着，不自动出门'
    if (plan.reason === 'already-out') return '宠物已经在外面，等它回家'
    if (plan.reason === 'no-activity') return '最近 10 分钟没有本机活动，不自动出门'
    if (plan.reason === 'cooldown') return '距上次出门不到 15 分钟，暂不自动出门'
    if (plan.reason === 'no-neighbor') return '没有在线且互相放行的邻居，不自动出门'
    if (plan.reason === 'ready') return '四道门都过了'
    return '策略跳过（' + String(plan.reason) + '）'
  }

  /** 记一次本机活动，并在第一次见到某个信号时打一行日志说明用了哪一路。 */
  function noteActivity (source, at = Date.now()) {
    const result = room.noteActivity(source, at)
    if (result === null) return null
    if (!loggedActivitySources.has(source)) {
      loggedActivitySources.add(source)
      log.info('活动信号：' + (source === 'session' ? 'session/event（主信号）' : '桌面指针（兜底）') + ' 已接入')
    }
    return result
  }

  /**
   * session/event 是 ticket 09 的主活动信号：DSH 里只要有人在用（发消息、跑 turn），
   * 宠物就知道“本机最近有活动”。拿不到这个能力（web/老宿主/ctx 没有 on）时不报错，
   * 自动退回桌面指针；两者都没有时策略的 activity 门永远关着。
   */
  function subscribeSessionEvents () {
    if (disposed) return false
    if (typeof ctx?.on !== 'function') {
      log.info('活动信号：宿主没有 session/event，自动串门只靠桌面指针活动')
      return false
    }
    try {
      const dispose = ctx.on('session/event', (session, event) => {
        if (disposed) return
        // 任何 session 事件都代表这台机器上有人在用 DSH；事件类型不是安全边界。
        noteActivity('session')
      }, { global: true })
      if (typeof dispose === 'function') disposers.push(dispose)
      log.info('活动信号：已订阅 session/event')
      return true
    } catch (error) {
      warn(ctx, '订阅 session/event 失败，自动串门退回桌面指针：' + message(error))
      return false
    }
  }

  /**
   * 串门请求的重试与超时。只在“请求中”阶段工作：
   * 首次发送后约 600ms / 1200ms 各补发一次；约 1800ms 还没 ack 就明确超时。
   * ack/deny/recall/本地召回都会把 request 清掉，不会在已经抵达后继续重发。
   */
  function runVisitTimers () {
    if (disposed) return
    if (request !== null) {
      const out = room.outboundVisit()
      if (out === null || out.visitId !== request.visitId || out.phase !== 'requesting') {
        request = null
      } else {
        const now = Date.now()
        if (now >= request.deadline) {
          room.failOutboundVisit('timeout', now)
          request = null
        } else {
          while (request.attempts < visitAttempts && now >= request.nextAt) {
            sendVisitRequest(request.visitId)
            request.attempts += 1
            request.nextAt += visitRetryMs
          }
        }
      }
    }
    flushRoomEffects()
  }

  function clearRequest (visitId) {
    if (request !== null && request.visitId === visitId) request = null
  }

  /** 收到 recall 回执：只认这次串门的发起方，别人的 ack 不能替它收手。 */
  function clearRecall (packet) {
    const recall = recalls.get(packet.visitId)
    if (recall === undefined || recall.deviceId !== packet.deviceId) return false
    recalls.delete(packet.visitId)
    return true
  }

  /**
   * 开始一次出门的唯一入口：手动按钮与自发策略共用同一条路径。
   * 生成 visitId、写 room 状态、发第一包、登记重试计时器；失败时由 room 给一句人话。
   */
  function startOutboundVisit (deviceId) {
    const visitId = randomUUID()
    const begun = room.beginVisit(deviceId, { visitId })
    if (!begun.ok) return begun
    if (!sendVisitRequest(visitId)) {
      request = null
      const failed = room.failOutboundVisit('peer-offline')
      return {
        ok: false,
        error: 'peer-offline',
        deviceId,
        notice: failed.ok ? failed.notice : null
      }
    }
    const now = Date.now()
    request = {
      deviceId,
      visitId,
      attempts: 1,
      nextAt: now + visitRetryMs,
      deadline: now + visitTimeoutMs
    }
    return {
      ok: true,
      action: 'visit',
      deviceId,
      visitId,
      phase: 'requesting',
      nickname: begun.visit.nickname
    }
  }

  /**
   * 发一次 visit-request。只走 discovery.sendTo()：先过 mayTalkTo，
   * 再按 deviceId 查地址；没地址（刚离线）返回 false，由调用方明确报 peer-offline。
   */
  function sendVisitRequest (visitId) {
    if (disposed || discovery === null || identity === null) return false
    const out = room.outboundVisit()
    if (out === null || out.visitId !== visitId) return false
    const pet = room.snapshot().self.pet
    let data
    try {
      data = encodeVisitRequest({
        deviceId: identity.deviceId,
        visitId,
        nickname: identity.nickname,
        anim: pet?.anim ?? null,
        action: pet?.action ?? null,
        semantic: pet?.semantic ?? null,
        say: pet?.say ?? null,
        skinPort: skinRef?.port,
        skinId: skinRef?.id
      })
    } catch {
      return false
    }
    try {
      return discovery.sendTo(out.deviceId, data)
    } catch {
      return false
    }
  }

  /** 收到请求：放行且开关开 → ack；否则 deny（带理由，走 sendReply 例外）。 */
  function handleVisitRequest (packet) {
    const result = room.observeVisitRequest(packet)
    if (result.reply === 'ack') sendVisitAck(result.deviceId, result.visitId)
    else if (result.reply === 'deny') sendVisitDeny(result.deviceId, result.visitId, result.reason)
  }

  function sendVisitAck (deviceId, visitId) {
    if (disposed || discovery === null || identity === null) return false
    try {
      return discovery.sendTo(deviceId, encodeVisitAck({ deviceId: identity.deviceId, visitId }))
    } catch {
      return false
    }
  }

  function sendVisitDeny (deviceId, visitId, reason) {
    if (disposed || discovery === null || identity === null) return false
    try {
      return discovery.sendReply(deviceId, encodeVisitDeny({ deviceId: identity.deviceId, visitId, reason }))
    } catch {
      return false
    }
  }

  function sendVisitRecall (deviceId, visitId) {
    if (disposed || discovery === null || identity === null) return false
    try {
      return discovery.sendTo(deviceId, encodeVisitRecall({ deviceId: identity.deviceId, visitId }))
    } catch {
      return false
    }
  }

  /**
   * 回一条 recall 回执。和 recall 一样走 sendTo（必须互相放行、必须有地址）；
   * 发不出去也没关系：对方会按自己的重试计划收手，不会无限重发。
   */
  function sendVisitRecallAck (deviceId, visitId) {
    if (disposed || discovery === null || identity === null) return false
    try {
      return discovery.sendTo(deviceId, encodeVisitRecallAck({ deviceId: identity.deviceId, visitId }))
    } catch {
      return false
    }
  }

  /**
   * 把 room 里完成但未落盘的串门记录交给 visits.json，并补发待发的 recall。
   * 记录失败只影响历史，不回滚桌面状态；这是 ticket 06 的“记录不能拖垮串门”。
   */
  function flushRoomEffects () {
    const records = room.drainVisitRecords()
    if (visits !== null) {
      for (const record of records) {
        try {
          const pending = visits.append(record)
          if (pending !== null && typeof pending?.catch === 'function') pending.catch(() => {})
        } catch {
          // 磁盘坏掉只丢这一条历史，不抛到 socket/tick 循环里
        }
      }
    }
    for (const recall of room.drainVisitRecalls()) queueRecall(recall)
    runRecallRetries()
    // 谁在/谁走/动作变了都可能从这里经过：让桌面场景跟上（没变就不发）。
    syncDesktop()
    return records.length
  }

  /**
   * 登记一次要发的 recall 并立刻发第一包。对方已经不可达（没地址/不再放行）时
   * 不排队：重试也不会成功，白占计时器。
   */
  function queueRecall ({ deviceId, visitId }) {
    if (disposed || typeof deviceId !== 'string' || typeof visitId !== 'string') return false
    if (recalls.has(visitId)) return false
    if (!sendVisitRecall(deviceId, visitId)) return false
    const now = Date.now()
    recalls.set(visitId, {
      deviceId,
      attempts: 1,
      nextAt: now + recallRetryMs,
      deadline: now + recallTimeoutMs
    })
    return true
  }

  /**
   * recall 的重试计时器（由 visitTimer 每 200ms 驱动一次）。只补发到次数/时限为止；
   * 收到 visit-recall-ack、或对方已经不可达时提前删掉。整条路径有界且幂等。
   */
  function runRecallRetries () {
    if (recalls.size === 0) return
    const now = Date.now()
    for (const [visitId, recall] of recalls) {
      if (recall.attempts >= recallAttempts || now >= recall.deadline) {
        recalls.delete(visitId)
        continue
      }
      if (now < recall.nextAt) continue
      if (!sendVisitRecall(recall.deviceId, visitId)) {
        // 对方离线/不再放行：再发也不会到，收手。
        recalls.delete(visitId)
        continue
      }
      recall.attempts += 1
      recall.nextAt += recallRetryMs
    }
  }

  // 先挂上 session 活动信号，再启动：DSH 可能在 start() 的 await 期间就有事件。
  subscribeSessionEvents()
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
    /** 应用层唯一例外（发现层的 beacon 回执另算）：只给 visit-deny 用，内部限速。 */
    replyTo: (deviceId, data) => discovery?.sendReply(deviceId, data) ?? false,
    /** 手动补发一轮心跳（测试与 ticket 05 的“立刻让对方看见我”可复用）。 */
    sendHeartbeats,
    dispose () {
      if (disposed) return
      // 卸载前把已经完成的记录尽量落盘；recall 发不出去也无妨，对方会自己到期。
      flushRoomEffects()
      disposed = true
      if (tickTimer !== null) {
        clearInterval(tickTimer)
        tickTimer = null
      }
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      if (visitTimer !== null) {
        clearInterval(visitTimer)
        visitTimer = null
      }
      if (autoVisitTimer !== null) {
        clearInterval(autoVisitTimer)
        autoVisitTimer = null
      }
      stopDesktopSync()
      try { skinServer?.close() } catch { /* 关不掉也不能挡住卸载 */ }
      skinServer = null
      skinRef = null
      skinFetcher = null
      visitorSkins.clear()
      skinPool = []
      request = null
      recalls.clear()
      discovery?.dispose()
      discovery = null
      bridge?.dispose()
      bridge = null
      desktop?.dispose()
      desktop = null
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

/** 测试注入用：非数字/小于下限时静默回落到默认值，坏配置不能把计时器拖死。 */
function positiveOption (value, fallback, min = 1) {
  const num = Number(value)
  return Number.isFinite(num) && num >= min ? num : fallback
}

function integerOption (value, fallback, min, max) {
  const num = Number(value)
  return Number.isInteger(num) && num >= min && num <= max ? num : fallback
}

/**
 * `LOCAL_PET_DESKTOP=0|false|off` 直接关掉桌面层。
 * 置顶全屏窗如果出了意想不到的问题，这是唯一不需要改配置、也不需要卸载插件的出口。
 */
function isDesktopDisabled (env) {
  const value = String(env?.LOCAL_PET_DESKTOP ?? '').trim().toLowerCase()
  return value === '0' || value === 'false' || value === 'off' || value === 'no'
}
