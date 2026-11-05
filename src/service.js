import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

import shared from '../desktop/shared.js'
import { createBackpackStore } from './backpack.js'
import { dualLayerAdvisory } from './desktop-advisory.js'
import { createDesktop } from './desktop.js'
import { discoverPetPacks } from './dsh-pet-pets.js'
import { controlsFromSnapshot, droppedVisitors, petsFromSnapshot } from './desktop-pets.js'
import { createDiscovery } from './discovery.js'
import { backpackErrorText, giftPrepareFailedText } from './gift-text.js'
import { createGiftFetcher } from './gift-fetch.js'
import {
  GIFT_RATE_PER_DAY,
  GIFT_RATE_PER_HOUR,
  createGiftRateLimiter
} from './gift-limits.js'
import {
  MAX_GIFT_COUNT,
  MAX_GIFT_TOTAL_BYTES,
  createGiftStore
} from './gifts.js'
import { createIdentity, defaultNickname } from './identity.js'
import { dshHome, dshPetConfigPath, legacyDataDir, prepareDataDir } from './paths.js'
import { resolveDshPetAssetDirs } from './pet-assets.js'
import { createPeerStore } from './peers.js'
import { createPetBridge, readPetConfig } from './pet-bridge.js'
import { buildMenu, readAnimationsConfig } from './menu.js'
import { writePetName } from './pet-name-write.js'
import { createSettingsStore } from './settings.js'
import { resolveSkinPort, startLanServer } from './lan-server.js'
import { appendSkinSources, idlePoolOf, loadSkinSources, readSkinEntries } from './skin-sources.js'
import { createSkinFetcher } from './skin-fetch.js'
import {
  HEARTBEAT_INTERVAL_MS,
  MAX_GIFT_BYTES,
  normalizeSkinId,
  PEER_LOST_MS,
  VISIT_MAX_MS,
  encodeGiftReceived,
  encodeHeartbeat,
  encodeVisitAck,
  encodeVisitDeny,
  encodeVisitRecall,
  encodeVisitRecallAck,
  encodeVisitRequestDetailed,
  isDeviceId,
  isPort,
  isVisitId,
  normalizeNickname,
  resolvePort
} from './protocol.js'
import { createRoom } from './room.js'
import { visitReasonText } from './visit-copy.js'
import { createVisitStore } from './visits.js'

export const ROUTE_PREFIX = '/dsh-zoo'
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
/**
 * 礼物回执（ticket 26）：接收方写进 `gifts/` 之后发三次、间隔约 400ms。
 * 回执**没有** ack——重复到达在发起方是幂等的（不是自己登记过的那一件就什么也不做），
 * 所以重发只需要有界，不需要回执的确认。
 */
export const RECEIPT_ATTEMPTS = 3
export const RECEIPT_RETRY_MS = 400
export const RECEIPT_TIMEOUT_MS = 1200
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
 * 礼物源（ticket 25）的 armed 窗口：发出这次串门请求后 5 分钟内可读，
 * 且这次串门一结束（回家/送客/超时/失联）立刻 unarm。
 */
export const ARMED_GIFT_MS = 5 * 60 * 1000
/** `/dsh-zoo/state` 只列最近 20 件收到的礼物（SPEC v4「记录与状态出口」）。 */
export const STATE_GIFT_LIMIT = 20

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
  const log = makeLogger(ctx)
  // 测试可以显式给 dataDir；生产走一次「旧目录改名」，失败就继续用旧目录。
  const prepared = options.dataDir === undefined || options.dataDir === null
    ? prepareDataDir(env)
    : { dir: options.dataDir, migrated: false, fallback: false }
  const dir = prepared.dir
  if (prepared.migrated) {
    log.info('数据目录已迁移：' + legacyDataDir(env) + ' → ' + dir)
  } else if (prepared.fallback) {
    const reason = prepared.error instanceof Error ? prepared.error.message : String(prepared.error)
    log.warn('旧数据目录改名失败（' + reason + '），继续使用 ' + dir)
  }
  const configPath = options.petConfigPath ?? dshPetConfigPath(env)
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
  const receiptRetryMs = positiveOption(options.receiptRetryMs, RECEIPT_RETRY_MS, 10)
  const receiptAttempts = integerOption(options.receiptAttempts, RECEIPT_ATTEMPTS, 1, 8)
  const receiptTimeoutMs = positiveOption(options.receiptTimeoutMs, RECEIPT_TIMEOUT_MS, receiptRetryMs)
  const desktopSyncMs = positiveOption(options.desktopSyncMs, DESKTOP_SYNC_MS, 20)
  const autoVisitIntervalMs = positiveOption(options.autoVisitIntervalMs, AUTO_VISIT_INTERVAL_MS, 10)
  /** 测试可以缩短 armed 窗口；生产固定 5 分钟。 */
  const armedGiftMs = positiveOption(options.armedGiftMs, ARMED_GIFT_MS, 10)

  let identity = null
  let discovery = null
  let peers = null
  let visits = null
  // 入站礼物的落盘（ticket 23）；起不来只意味着“这次运行收不到字条”，串门照常。
  let gifts = null
  // 发送端的背包（ticket 24）；起不来 = 这次运行不带东西，串门照常。
  let backpack = null
  let settings = null
  let bridge = null
  let desktop = null
  let desktopWorkArea = null
  let desktopHelperPid = null
  let desktopSceneSignature = null
  let desktopSyncTimer = null
  // 「两个桌面层同时在画」只提示一次（ticket 31）：每轮轮询都刷一行日志没人看。
  let dualLayerNoted = false
  // 对外素材源（ticket 15）：端口与源 id 随 beacon/心跳广告；起不来就是 null。
  let skinServer = null
  let skinRef = null
  // 访客素材（ticket 17）：deviceId → { action, semantic, src?, fallback, at }。
  // 拉取是异步的，syncDesktop 只读这一份结果，绝不在同步路径上等网络。
  let skinFetcher = null
  const visitorSkins = new Map()
  /**
   * 礼物源（ticket 25）：giftId → { path, size, hash, visitId, until }。
   * 这是串门模块与只读 HTTP 服务之间**唯一**的耦合：路由只查这张表，绝不拼报文里的路径。
   * 只在“这次串门还没结束、且请求发出不到 5 分钟”时可读；结束/超时/失联立刻 unarm。
   */
  const armedGifts = new Map()
  /** 正在拉取的文件礼物：同一 giftId 的迟到重试不重复下载。 */
  const receivingGifts = new Set()
  /**
   * 入站礼物的频率限额（ticket 27）：同一邻居 ≤10 件/小时、≤50 件/天。
   * 只活在本次运行的内存里；字条与文件两条接收路径共用它。
   * 单测可以注入更小的额度（生产不传，就是 SPEC 的 10 / 50）。
   */
  const giftRate = createGiftRateLimiter({
    perHour: integerOption(options.giftRatePerHour, GIFT_RATE_PER_HOUR, 1, 10000),
    perDay: integerOption(options.giftRatePerDay, GIFT_RATE_PER_DAY, 1, 10000)
  })
  /** 磁盘限额的值同样只给单测缩小（生产 500 MiB / 200 件）。 */
  const giftMaxTotalBytes = positiveOption(options.giftMaxTotalBytes, MAX_GIFT_TOTAL_BYTES, 1)
  const giftMaxCount = integerOption(options.giftMaxCount, MAX_GIFT_COUNT, 1, 10000)
  // 文件礼物的拉取客户端（ticket 25）；没有网络时是 null。
  let giftFetcher = null
  // 本机宠物的待机池：dsh-pet 那一整套动作名；桌面只拿它轮播，不猜、不点播。
  // 测试可以注入 options.skinPool；生产由 loadSkin() 从注册表填。
  let skinPool = Array.isArray(options.skinPool) ? options.skinPool.slice() : []
  // 注册表与当前那张皮（ticket 32）：idlePool、对外 skinId、菜单里的「外观」都从这里来。
  // 皮只决定外观和动作，不动 identity / peers / visits / backpack / 礼物（ADR-0013）。
  let skinSources = []
  let activeSkin = null
  /** dsh-pet 的老素材目录：没有皮时用它兜底（懒解析一次）。 */
  let fallbackAssetRoots = null
  // 右键菜单（ticket 22）：工具项 + 动作分类，随场景一起下发；dsh-pet 的配置读不到就退平铺。
  let desktopMenu = { tools: [], groups: [] }
  let tickTimer = null
  let heartbeatTimer = null
  let visitTimer = null
  let autoVisitTimer = null
  // 当前出门请求的重试状态；只活在 service，room 只记“在请求中/已抵达”。
  let request = null
  // 已发出、等回执的 visit-recall：visitId → { deviceId, attempts, nextAt, deadline }。
  const recalls = new Map()
  // 已发出、等对方确认的回执（接收方，ticket 26）：
  // giftId → { deviceId, visitId, attempts, nextAt, deadline }。
  const receipts = new Map()
  // 已经捎出去、等回执的礼物（发起方，ticket 26）：
  // giftId → { deviceId, visitId, nickname }。收到回执就删件，串门一结束就退包；
  // 先把条目从表里摘掉再动背包，所以同一条回执/同一次结束只会生效一次。
  const outboundGifts = new Map()
  // 活动信号的可观测性：第一次见到某个来源、以及同一条策略结论的日志节流。
  const loggedActivitySources = new Set()
  let lastPolicyLog = { reason: null, at: 0 }
  let disposed = false

  disposers.push(register(ctx, {
    kind: 'exact',
    path: ROUTE_PREFIX + '/state',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      sendJson(res, 200, stateView())
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
      const self = room.snapshot().self
      const dshPetReachable = self.bridge?.ok === true
      sendJson(res, 200, {
        running: true,
        status,
        helperStatus,
        // ticket 31：dsh-pet 也在画的时候给一条提示；不在画就是 null。
        dualLayer: dualLayerAdvisory({ desktopRunning: true, bridge: self.bridge, pet: self.pet }),
        // 提示只在启动时打印一行，而宿主 stdout 不落盘（0.4.2 现场就卡在这里）：
        // 把「提示过没有」也放进出口，才能核对「只出现一次」而不必去翻日志。
        dualLayerNoted,
        // 「外观」菜单的实际内容（票 36）：菜单只有开着才在 helper 那边上报，
        // 验收时没法远程确认，所以这里给一份宿主侧的事实。
        menuSkins: Array.isArray(desktopMenu.skins) ? desktopMenu.skins.map((skin) => skin.id) : [],
        menuActiveSkin: typeof desktopMenu.activeSkin === 'string' ? desktopMenu.activeSkin : null,
        // dualLayer 的判据同样放出来。单机复现不了「关掉 helper」那一态（宿主会立刻拉起），
        // 所以让人一眼看出此刻是哪一层在画、为什么提示是 null。
        dshPet: {
          reachable: dshPetReachable,
          reason: typeof self.bridge?.reason === 'string' ? self.bridge.reason : null,
          // 不可达时 self.pet 会按配置回落成 dsh-pet 那只的名字（桥接的降级行为），
          // 但那不是「它在画谁」：名字跟着 reachable 一起清空，出口才和 dualLayer 同一套判据。
          name: dshPetReachable && typeof self.pet?.name === 'string' ? self.pet.name : null
        }
      })
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
      syncSessionSignal()
      return { ok: true, action: 'auto-visits', autoVisits, persisted }
    }

    // 手动「串门」：可以指定 deviceId，也可以不带——后者是 ticket 11 的按钮路径，
    // 由宿主随机挑一位在线且互相放行的邻居。手动永远不受总开关/活动窗口限制。
    // 礼物只从背包来（票 24）：按「先放的先带走」取 `at` 最小的一件。
    // 手动与自发走同一条 `startOutboundVisit`。
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

    // 礼物卡上的四个动作（ticket 23）：只认本地页面/桌面控件；UDP 永远走不到这里。
    // giftId 是协议里的 UUID，路径由宿主从礼物 store 取，渲染端/请求体都拿不到路径。
    if (action === 'gift-open' || action === 'gift-reveal' ||
      action === 'gift-copy' || action === 'gift-discard') {
      return handleGiftAction(action, body?.giftId)
    }

    // 背包（ticket 24）：
    //   - 不带物品的 bring 来自右键「带派」→ 打开小窗（内容由宿主算好交下去）；
    //   - 带 `{gift}` / `{kind,text|path}` 的 bring 来自小窗或脚本 → 真正放进背包；
    //   - unbring 只删 idle 件（out 中的东西可能已经在对方磁盘上了）。
    if (action === 'bring') return handleBringAction(body)
    if (action === 'unbring') return handleUnbringAction(body)

    // 本地召回：已抵达会写 out 记录并让接收方立刻清场；还在请求中则只是取消。
    if (action === 'recall') {
      const result = room.recallOutbound()
      if (!result.ok) return result
      request = null
      // 本地召回 = 这次串门结束：礼物立刻不可读（26 会在这里同时退包）。
      unarmGift(result.visit?.visitId)
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

    // 右键菜单的「动作」（ticket 22 / ADR-0009）：点播本体，让 /state 把这一句回灌给影子。
    // 失败必须是明确的失败：渲染端拿到 ok:false 会降级成本机播一次，并冒一句人话。
    if (action === 'play-anim') {
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (name === '') return { ok: false, error: 'bad-name' }
      if (bridge === null) return { ok: false, error: 'anim-unreachable' }
      const played = await bridge.playAnim(name)
      if (played.ok === true) return { ok: true, action: 'play-anim', name }
      if (played.reason === 'no-pet') return { ok: false, error: 'anim-no-pet' }
      if (played.reason === 'rejected') {
        return {
          ok: false,
          error: 'anim-rejected',
          ...(typeof played.message === 'string' && played.message !== '' ? { detail: played.message } : {})
        }
      }
      return { ok: false, error: 'anim-unreachable' }
    }

    // 「重载配置」（ticket 22）：重读 settings.json + skin.json，重建菜单与场景，再让 helper 重建。
    // 手动重载不占崩溃退避次数（桌面层那边另有一面旗），所以手快连点也不会把宠物重启到放弃。
    if (action === 'reload') {
      if (settings === null) return { ok: false, error: 'starting' }
      try {
        await settings.load()
        room.setAcceptVisits(settings.acceptVisits)
        room.setAutoVisits(settings.autoVisits)
        syncSessionSignal()
      } catch (error) {
        warn(ctx, '重载设置失败：' + message(error))
        return { ok: false, error: 'reload-failed' }
      }
      // 重载配置也重读素材注册表（ticket 34）：改 skin.json 不用退出 DSH。
      await loadSkin()
      await refreshDesktopMenu()
      desktopSceneSignature = null
      syncDesktop({ reset: true })
      if (desktop !== null && typeof desktop.reload === 'function') desktop.reload()
      // 皮可能换了（旧的那条源被删掉 → 回落第一条）：邻居那边也要知道新的 skinId。
      sendHeartbeats()
      return { ok: true, action: 'reload' }
    }

    // 换皮（ticket 32 / ADR-0013）：只换外观和动作，名字、身份、串门记录、礼物一个字不动。
    // 落盘只写 settings.json 的 activeSource；写不进去也照样换，只是回报 persisted:false。
    if (action === 'use-skin') {
      if (settings === null) return { ok: false, error: 'starting' }
      // HTTP 与桌面控件两条路都带 `skinId`：和 deviceId / giftId 同一个命名习惯，
      // 别再让一条路叫 id、另一条叫 skinId（那正是最早那个 bug）。
      const id = normalizeSkinId(body?.skinId)
      if (id === null) return { ok: false, error: 'bad-skin-id' }
      if (!skinSources.some((source) => source.id === id)) return { ok: false, error: 'unknown-skin' }
      const persisted = await settings.setActiveSource(id)
      applySkin(skinSources, id)
      await refreshDesktopMenu()
      // 场景签名里带着 idlePool 与菜单：清掉它，否则同一张皮换了动作池不会下发。
      desktopSceneSignature = null
      syncDesktop()
      // 立刻补发心跳：邻居下一次取素材就用新 id，不用等 2 秒节拍。
      sendHeartbeats()
      return { ok: true, action: 'use-skin', skin: id, persisted }
    }

    // 「扫描外观」（ticket 37）：扫 dsh-pet 的宠物包目录，把没见过的素材追加进 skin.json。
    // 只在你按的时候发生——插件加载路径上没有任何自动扫描。
    if (action === 'scan-skins') {
      if (settings === null) return { ok: false, error: 'starting' }
      let found
      try {
        found = await discoverPetPacks({
          petDir: join(dshHome(env), 'dsh-pet', 'pet'),
          warn: (code, detail) => log.warn('素材包扫描：' + code + (detail === undefined ? '' : '（' + detail + '）'))
        })
      } catch (error) {
        warn(ctx, '扫描素材包失败：' + message(error))
        return { ok: false, error: 'scan-failed' }
      }
      // 判重必须对着**磁盘上的** skin.json，不能拿进程里的缓存：用户可能刚删掉一条、
      // 还没按「重载配置」（Windows 现场）。先读文件，坏文件在这里就要报 409。
      let existing
      try {
        existing = await readSkinEntries(dir)
      } catch (error) {
        warn(ctx, '读 skin.json 失败：' + message(error))
        return { ok: false, error: 'skin-file-broken' }
      }
      // 文件不存在时才需要"当前生效的源"（拿来一起写进新文件）；这一步会重读注册表，
      // 所以放在校验之后——坏文件不该先把当前皮悄悄换掉再失败。
      if (!existing.exists) await loadSkin()

      // skin.json 不存在时，注册表就是自动源（dsh-pet 的素材）。新建这个文件会把自动源
      // 顶掉，所以要把当前生效的那些条目一起写进去——否则在干净机器上"扫一下"会把鱼弄丢、
      // 还会顺手把宠物换成猫。
      const base = existing.exists ? existing.entries : skinSources.map(skinEntryOf)
      const knownIds = new Set()
      for (const entry of base) {
        if (typeof entry?.id === 'string') knownIds.add(entry.id)
      }
      // 不只按 id 去重：同一个素材目录可能已经被手写成一个别的 id（现场就有
      // `maodie-pet` 和扫出来的 `maodie` 指同一个目录），再按 id 判会多出一条重复外观。
      const knownDirs = new Set()
      for (const entry of base) {
        for (const dir of Array.isArray(entry?.dirs) ? entry.dirs : []) knownDirs.add(skinDirKey(dir))
      }
      const fresh = found.packs.filter((pack) =>
        !knownIds.has(pack.id) && !pack.dirs.some((dir) => knownDirs.has(skinDirKey(dir))))

      // 文件不存在时要连自动源一起写进去；已经存在就只追加新的。空数组 = 只校验不落盘。
      const entries = existing.exists ? fresh : [...base, ...fresh]
      let written
      try {
        written = await appendSkinSources(dir, entries)
      } catch (error) {
        warn(ctx, '写 skin.json 失败：' + message(error))
        return { ok: false, error: 'skin-file-broken' }
      }
      if (fresh.length === 0) {
        return {
          ok: true,
          action: 'scan-skins',
          added: [],
          found: found.packs.length,
          notice: found.packs.length === 0 ? '没找到任何宠物包。' : '没有发现新的素材包。'
        }
      }
      await loadSkin()
      await refreshDesktopMenu()
      desktopSceneSignature = null
      syncDesktop()
      const ids = fresh.map((pack) => pack.id)
      return {
        ok: true,
        action: 'scan-skins',
        added: ids,
        found: found.packs.length,
        persisted: ids.length > 0,
        notice: ids.length === 0
          ? '没有发现新的素材包。'
          : '加入 ' + ids.length + ' 张外观：' + ids.join('、') + '。右键「外观」可以切换。'
      }
    }

    // 「打开软件」：地址由宿主给（渲染端不传 URL），只交给主进程的默认浏览器。
    if (action === 'open-site') {
      const url = dshOrigin(ctx)
      if (url === null) return { ok: false, error: 'no-origin' }
      if (desktop === null) return { ok: false, error: 'desktop-off' }
      const opened = typeof desktop.openUrl === 'function' ? desktop.openUrl(url) : false
      return opened ? { ok: true, action: 'open-site' } : { ok: false, error: 'open-failed' }
    }

    return { ok: false, error: 'not-implemented', action }
  }

  /**
   * `/dsh-zoo/state` 的唯一形状（ticket 27）：room 的纯快照 + 两份磁盘视图。
   *
   * 磁盘只在这里读，room 永远不碰 fs。两个字段在任何时候都是数组：
   * store 还没起来/初始化为 null 时就是空数组，绝不出现 `undefined`。
   */
  function stateView () {
    return {
      ...room.snapshot(),
      // 当前那张皮（ticket 32）：换皮只看这一项，别的状态都不该动。
      skin: activeSkin === null
        ? null
        : { id: activeSkin.id, size: activeSkin.size, idle: activeSkin.idle },
      backpack: backpack?.items() ?? [],
      gifts: recentGifts()
    }
  }

  /** 最近 20 件已落盘的礼物，最新在前；形状按 SPEC v4「记录与状态出口」。 */
  function recentGifts () {
    const list = gifts?.list() ?? []
    return list.slice(0, STATE_GIFT_LIMIT).map((record) => {
      const view = {
        id: record.id,
        from: { ...record.from },
        kind: record.kind,
        at: record.receivedAt,
        // 能进 store 的都已经真的写进了 gifts/。
        status: 'received',
        path: record.kind === 'file' ? record.filePath : record.notePath
      }
      if (record.kind === 'file') {
        view.name = record.name
        view.size = record.size
      }
      return view
    })
  }

  /**
   * 礼物卡的系统动作（ticket 23）。只认本地来路：桌面控件的 action 与
   * `POST /dsh-zoo/action` 都会到这里，UDP 报文没有入口。
   *
   * 路径从不来自请求体：`giftId` → 礼物 store 里的记录 → `notePath`/`dirPath`。
   * 错误码只用 SPEC 的那几个：bad-gift / gift-not-found / open-failed。
   *
   * 「扔掉」是唯一不需要磁盘记录的例外：卡片还在 pending / receiving / failed / refused
   * 时本来就没有 `meta.json`，但用户仍然要能把它扔掉。
   */
  async function handleGiftAction (action, rawGiftId) {
    const giftId = typeof rawGiftId === 'string' ? rawGiftId.trim() : ''
    if (!isVisitId(giftId)) return { ok: false, error: 'bad-gift' }
    // 没初始化 = 本次运行没有可用的礼物目录；对调用方而言与“这件东西不在了”没有区别。
    const record = gifts?.lookup(giftId) ?? null

    if (action === 'gift-discard') {
      // 卡片先消失、黑名单先记住（这一件重发也不会再出现）。
      room.discardGift(record?.from.deviceId ?? null, giftId)
      // 没有磁盘记录（还没落盘 / 落盘失败 / 本次运行没有 store）：认这次「扔掉」，
      // 只拉黑并摘掉卡片，不删任何文件；返回 ok 让渲染端不必等一个不存在的目录。
      if (record === null) return { ok: true, action, giftId }
      // 删除以宿主为准：它拿得到绝对路径、也不依赖 helper 是否活着（HTTP 路径同样要能扔）。
      // helper 那条 gift-discard 仍然发一条：同一台桌面上的文件操作就走同一条出口，
      // 命令是幂等的（rm -rf），宿主已经删掉时它什么也不做。
      const removed = await gifts.discard(giftId)
      if (!removed.ok) {
        warn(ctx, '礼物目录没删掉（' + removed.error + '）：' + record.dirPath)
        return { ok: false, error: 'open-failed', notice: '这件东西删不掉，文件可能正被别的程序占用。' }
      }
      if (desktop !== null && typeof desktop.giftDiscard === 'function') {
        try {
          desktop.giftDiscard(record.dirPath)
        } catch {
          // helper 不在/管道断了都无所谓：目录已经在上面删掉了。
        }
      }
      return { ok: true, action, giftId }
    }

    // 打开/显示/复制都需要磁盘记录：路径与正文从 store 来，没有记录就是“这件东西不在了”。
    if (record === null) return { ok: false, error: 'gift-not-found' }

    // 打开/显示/复制都需要 Electron 主进程：宿主进程自己没有 shell 与剪贴板。
    if (desktop === null) return { ok: false, error: 'open-failed' }

    // 字条看 note.txt；文件礼物打开的就是本体（名字来自 store 清洗过的 name）。
    const targetPath = record.kind === 'file' ? record.filePath : record.notePath

    if (action === 'gift-open') {
      if (typeof desktop.giftOpen !== 'function' || desktop.giftOpen(targetPath) !== true) {
        return { ok: false, error: 'open-failed' }
      }
      // opened 只用于 ticket 26 的“送客时提醒一次”；写不进去不影响东西已经被打开。
      await gifts.markOpened(giftId)
      return { ok: true, action, giftId }
    }

    if (action === 'gift-reveal') {
      if (typeof desktop.giftReveal !== 'function' || desktop.giftReveal(targetPath) !== true) {
        return { ok: false, error: 'open-failed' }
      }
      return { ok: true, action, giftId }
    }

    if (action === 'gift-copy') {
      // 只有字条有正文可复制；文件礼物的卡片不显示「复制」，这里仍然明确拒绝。
      if (record.kind !== 'text') return { ok: false, error: 'not-implemented' }
      // 规格要求「宿主读文件 → copy 命令」：用户手改过 note.txt 之后，复制到的是当前内容。
      // 读失败（文件被删/权限/目录）才回退到内存里那份，至少还能复制到收到时的正文。
      let text = record.text
      try {
        text = await readFile(record.notePath, 'utf8')
      } catch {
        // 磁盘读不到：保留内存值。
      }
      if (typeof desktop.giftCopy !== 'function' || desktop.giftCopy(text) !== true) {
        return { ok: false, error: 'open-failed' }
      }
      // 复制没有可见状态变化：明确回一句，渲染端才会冒泡，不然用户不知道点没点上。
      return { ok: true, action, giftId, notice: '字条已经复制到剪贴板。' }
    }

    return { ok: false, error: 'not-implemented', action }
  }

  /**
   * 背包动作（ticket 24）。
   *
   * 入参从三条路来，形状刻意收在同一个白名单里：
   *   - HTTP：`{action:'bring', kind:'text', text}` / `{kind:'file', path}`（SPEC 的 action 表）；
   *   - 小窗：`{action:'bring', gift:{kind,text|path}}`（helper 转交）；
   *   - 右键菜单：`{action:'bring'}`，没有物品 → 打开小窗。
   *
   * 只有本地页面/桌面控件/HTTP 能到这里，UDP 报文永远碰不到它。
   */
  async function handleBringAction (body) {
    if (backpack === null) {
      return { ok: false, error: 'starting', notice: backpackErrorText('starting') }
    }
    const input = bringInputFromBody(body)
    if (input === null) {
      // 没带物品 = 右键「带派」那一下：打开小窗，背包内容与限额由宿主交给 helper。
      if (desktop === null || typeof desktop.bringWindow !== 'function') {
        return { ok: false, error: 'desktop-off', notice: backpackErrorText('desktop-off') }
      }
      if (desktop.bringWindow(bringWindowPayload({ open: true })) !== true) {
        return { ok: false, error: 'desktop-off', notice: backpackErrorText('desktop-off') }
      }
      return { ok: true, action: 'bring', window: 'opened', count: backpack.count() }
    }

    const added = await backpack.add(input)
    if (!added.ok) {
      return { ok: false, error: added.error, notice: backpackErrorText(added.error) }
    }
    // 小窗正开着（HTTP/脚本放进来的情况）就刷新列表；关着时这条命令只是更新 helper 内存。
    refreshBringWindow()
    return { ok: true, action: 'bring', giftId: added.item.id, count: added.count }
  }

  /** 从背包撤掉一件。只有 idle 能撤；`out` 中的东西可能已经在对方磁盘上了。 */
  async function handleUnbringAction (body) {
    if (backpack === null) {
      return { ok: false, error: 'starting', notice: backpackErrorText('starting') }
    }
    const removed = await backpack.remove(body?.giftId)
    if (!removed.ok) {
      return { ok: false, error: removed.error, notice: backpackErrorText(removed.error) }
    }
    refreshBringWindow()
    return { ok: true, action: 'unbring', giftId: removed.item.id, count: removed.count }
  }

  /**
   * 从 action body 里挖出「要放进背包的东西」。
   * 不含任何 kind 时返回 null（那是打开小窗的菜单动作），而不是当成坏礼物——
   * 这两种请求都叫 bring，区别就在有没有东西。
   */
  function bringInputFromBody (body) {
    if (body === null || typeof body !== 'object') return null
    const nested = body.gift !== null && typeof body.gift === 'object' && !Array.isArray(body.gift)
    const raw = nested ? body.gift : body
    if (typeof raw.kind !== 'string') return null
    return raw
  }

  /**
   * 交给 helper 的背包快照：只带 id/kind/显示文案/state，**绝不带文件路径**。
   * 路径只活在宿主；小窗删一件只发 giftId。
   */
  function bringWindowPayload ({ open = false } = {}) {
    const items = backpack?.items() ?? []
    return {
      open: open === true,
      items: items.map((item) => item.kind === 'file'
        ? { id: item.id, kind: 'file', name: item.name, state: item.state }
        : { id: item.id, kind: 'text', text: item.text, state: item.state })
    }
  }

  /** 已开着的窗跟着背包变；没有桌面层/没有窗时它是 no-op。 */
  function refreshBringWindow () {
    if (desktop === null || typeof desktop.bringWindow !== 'function') return false
    try {
      return desktop.bringWindow(bringWindowPayload({ open: false })) === true
    } catch {
      return false
    }
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

      // 设置读完后才知道自动串门开没开：只有开着才订阅 session/event。
      syncSessionSignal()

      // 串门记录是“锦上添花”：读写失败只降级成空记录，绝不让桌面起不来。
      try {
        visits = await createVisitStore(dir, { log })
      } catch (error) {
        visits = null
        warn(ctx, '串门记录初始化失败，本次只在内存里保留记录：' + message(error))
      }
      if (disposed) return
      room.setVisitRecords(visits?.records() ?? [])

      // 礼物也只降级、不挡启动：gifts 目录读不出来时，收到字条会变成一张 failed 卡。
      try {
        gifts = await createGiftStore(dir, {
          log,
          maxTotalBytes: giftMaxTotalBytes,
          maxCount: giftMaxCount
        })
      } catch (error) {
        gifts = null
        warn(ctx, '礼物目录初始化失败，本次收到的字条不会落盘：' + message(error))
      }
      if (disposed) return

      // 背包（ticket 24）同样是锦上添花：读不出来 = 这次运行空手出门，串门照常。
      try {
        backpack = await createBackpackStore(dir, { log })
      } catch (error) {
        backpack = null
        warn(ctx, '背包初始化失败，本次出门不会带东西：' + message(error))
      }
      if (disposed) return

      const petConfig = await readPetConfig(configPath)
      if (disposed) return
      const fallback = defaultNickname({ petName: petConfig.name, hostname: hostname() })
      identity = await createIdentity(dir, { defaultNickname: fallback, log })
      if (disposed) return
      room.setIdentity(identity)

      // 皮是本地资源，跟联不联网无关：先读注册表，桌面层才知道该画谁的素材（ticket 33）。
      await loadSkin()
      // 桌面层（ticket 07）：一个全屏透明 helper + 一个占位方块。
      // 它坏了/起不来都只是「没有宠物」，这里不 await、不抛，网络与信任逻辑完全不受影响。
      startDesktopLayer()
      if (disposed) return

      // 菜单的内容依赖素材源（降级清单）与 DSH 地址，所以在素材源之后建。
      await refreshDesktopMenu()
      if (disposed) return

      if (options.network !== false) {
        skinFetcher = createSkinFetcher({ dir, log })
        // 礼物拉取（ticket 25）：连接 5s / 总计 20s、流式落盘、失败冷却 60s。
        // 测试可以注入更短的超时；生产默认值不能改（SPEC v4「接收端流程」）。
        giftFetcher = createGiftFetcher({
          log,
          connectTimeoutMs: options.giftConnectTimeoutMs,
          totalTimeoutMs: options.giftTimeoutMs,
          cooldownMs: options.giftCooldownMs
        })
        // 先起素材源，再起发现：beacon 的第一拍就能带上 skinPort。
        await serveSkin()
        if (disposed) return
        // 素材源读完才知道降级清单（skinPool）；菜单要在这之后再建一次。
        await refreshDesktopMenu()
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
              if (result.ok) {
                clearRequest(packet.visitId)
                // 对方没放行 = 这次串门结束：礼物不再可读（26 会在这里同时退包）。
                unarmGift(packet.visitId)
              }
            } else if (packet.type === 'visit-recall') {
              const result = room.observeVisitRecall(packet)
              if (result.ok) {
                clearRequest(packet.visitId)
                // 我是发起方：对方送客/召回，串门结束 → 立刻 unarm（请求中被取消也一样）。
                if (result.side === 'out') unarmGift(result.visit?.visitId ?? packet.visitId)
                // 回执：对方可能正拿着一条“没发出去”的 recall 在重试。
                sendVisitRecallAck(packet.deviceId, packet.visitId)
              }
            } else if (packet.type === 'visit-recall-ack') {
              // 对方确认收到了这次召回：不用再重发。
              clearRecall(packet)
            } else if (packet.type === 'gift-received') {
              // 礼物的送达回执（ticket 26）。**必须有这个分支**：落到下面的 else 会被
              // 当成 beacon 静默吞掉——不报错，只是礼物永远删不掉。
              handleGiftReceived(packet)
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
            noteDualLayer()
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
   * 重建右键菜单（ticket 22）：dsh-pet 的 animations 优先，读不到退到本机素材源平铺。
   * 任何失败都只让菜单变短，不影响桌面/串门。
   */
  async function refreshDesktopMenu () {
    let animations = null
    try {
      const found = await readAnimationsConfig(resolveDshPetAssetDirs({ env }))
      animations = found?.animations ?? null
    } catch {
      animations = null
    }
    // 两条素材路共用同一份「外观」信息：读不到 dsh-pet 的 animations 时只少掉动作分类。
    const common = {
      pool: skinPool,
      hasOrigin: dshOrigin(ctx) !== null,
      skins: skinChoices(),
      activeSkin: activeSkin === null ? null : activeSkin.id
    }
    try {
      desktopMenu = buildMenu({ ...common, animations })
    } catch {
      desktopMenu = buildMenu(common)
    }
    return desktopMenu
  }

  /**
   * 当前这张皮的素材目录（ticket 33）：没有皮时退回 dsh-pet 的那套，行为与 0.4 相同。
   * helper 只认绝对路径；渲染端的 `dshzoo://asset/<动作>.webm` 就在这些目录里找。
   */
  function assetRootsFor (skin) {
    if (fallbackAssetRoots === null) {
      fallbackAssetRoots = Array.isArray(options.dshPetAssets)
        ? options.dshPetAssets.slice()
        : resolveDshPetAssetDirs({ env })
    }
    if (skin !== null && Array.isArray(skin.dirs) && skin.dirs.length > 0) return skin.dirs.slice()
    return fallbackAssetRoots
  }

  /**
   * 菜单「外观」里的候选：只有 id。
   * 不另起一个显示名——「橘猫」是我们替它编的，换只动物就没词可用了；
   * 皮的身份证是它的源 id（也就是插件名），邻居看到的 skinId 也是它。
   */
  function skinChoices () {
    return skinSources.map((source) => ({ id: source.id }))
  }

  /** 把当前生效的源写成 `skin.json` 里的一行（新建文件时用）。 */
  function skinEntryOf (source) {
    const entry = { id: source.id, dirs: Array.isArray(source.dirs) ? source.dirs.slice() : [] }
    if (Number.isInteger(source.size)) entry.size = source.size
    if (typeof source.idle === 'string' && source.idle !== '') entry.idle = source.idle
    if (Array.isArray(source.once) && source.once.length > 0) entry.once = source.once.slice()
    return entry
  }

  /** 目录去重用的键：同一台机器上大小写不敏感（Windows 的盘符与路径大小写可以随手写）。 */
  function skinDirKey (dir) {
    const resolved = resolve(dir)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  /**
   * 换掉当前那张皮（ticket 32 / ADR-0013）：只改「用哪个源」。
   * 身份、邻居、串门记录、背包、礼物一律不碰；唯一写盘的地方是 settings.json。
   * `preferredId` 指向不存在的源时回落第一条并告警——坏配置只让选择失效，不让宠物消失。
   */
  function applySkin (sources, preferredId) {
    skinSources = Array.isArray(sources) ? sources : []
    const wanted = typeof preferredId === 'string' ? preferredId : null
    const chosen = wanted === null
      ? null
      : skinSources.find((source) => source.id === wanted) ?? null
    if (wanted !== null && chosen === null) {
      log.warn('素材源：activeSource 指向不存在的源（' + wanted + '），先用第一条')
    }
    activeSkin = chosen ?? skinSources[0] ?? null
    skinPool = activeSkin === null ? [] : idlePoolOf(activeSkin)
    // 端口不变，换的只是对外广告的那个 id：邻居按新 id 重新取清单和素材。
    if (skinRef !== null) {
      skinRef = activeSkin === null ? { port: skinRef.port } : { port: skinRef.port, id: activeSkin.id }
    }
    return activeSkin
  }

  /**
   * 读本机素材注册表并应用「当前那张皮」（ticket 32）。
   *
   * 这件事**不依赖网络**：待机池、对外广告的 skinId、右键菜单的降级清单都从这里来，
   * 所以 `network:false` 的进程（测试、离线）也该有皮。起端口是下一步 `serveSkin()`。
   */
  async function loadSkin () {
    try {
      const loaded = await loadSkinSources({ dataDir: dir, env })
      for (const warning of loaded.warnings) {
        log.warn('素材源：' + warning.code + (warning.detail === undefined ? '' : '（' + warning.detail + '）'))
      }
      // 待机池与「对外供源」是两件事：就算关掉对外服务，本机宠物也该有丰富动作。
      const wanted = settings === null ? null : settings.activeSource
      applySkin(loaded.sources, wanted)
      // 配置指着一条已经不存在的源：回落之后把设置改写成真正在用的那张（票 36）。
      // 不改的话 settings 说 maodie、state 说 dsh-pet，就是两处真相。
      if (wanted !== null && activeSkin !== null && activeSkin.id !== wanted) {
        await settings.setActiveSource(activeSkin.id)
      }
      // 注册表换了：对外供源跟着换表，邻居下次取到的就是新清单（ticket 34）。
      // 端口还没起（启动早期 / skinServer:false）时是 null，跳过。
      skinServer?.setSources(skinSources)
    } catch (error) {
      log.warn('素材源没起来（不影响串门）：' + message(error))
    }
  }

  /**
   * 对外只读端口（ticket 15 的素材源 + ticket 25 的礼物源）：同一个端口、同一套只读约束。
   * 起不来只影响「访客能不能拿我的素材 / 文件礼物」，不影响发现/串门/桌面。
   *
   * **服务器无条件起**：没有素材源的用户也要有礼物端口（ADR-0011 唯一的新入站面），
   * 空源只是让 skin 路由一律 404。`options.skinServer === false` 是测试用的逃生开关
   * （不起端口，beacon 也不带 skinPort）。
   */
  async function serveSkin () {
    if (options.skinServer === false) return
    try {
      const requested = Number.isInteger(options.skinPort) ? options.skinPort : resolveSkinPort(env)
      skinServer = await startLanServer({
        sources: skinSources,
        port: requested,
        host: '0.0.0.0',
        log,
        // 串门模块与服务器之间只通过这张表耦合：路由拿不到任何报文里的路径。
        lookupGift: lookupArmedGift
      })
      if (skinServer === null) {
        log.warn('素材源端口没起来：访客先用本机素材，没有就画通用小人；礼物也发不出去')
        return
      }
      // 端口总有；源 id 可能没有（没装素材源时 beacon/心跳/串门请求只带 skinPort）。
      skinRef = {
        port: skinServer.port,
        ...(activeSkin === null ? {} : { id: activeSkin.id })
      }
      log.info(activeSkin !== null
        ? '素材源已对外：' + skinRef.id + ' @ ' + skinRef.port
        : '礼物端口已对外：' + skinRef.port + '（没有素材源）')
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

  // ---------------------------------------------------------------------------
  // 礼物源（ticket 25）：armed 表 + 缩略图地址
  //
  // 文件礼物走「拉取，不推送」：发送方把「这次要送的那一个绝对路径」记进 armedGifts，
  // 接收方在访客抵达时按 giftId 来取。路由只查这张表，报文里没有任何路径可拼。
  // 只在「请求发出后 5 分钟内、且这次串门还没结束」时可读；五个结束点都会 unarm。
  // ---------------------------------------------------------------------------

  /** 路由的唯一读取入口；service 之外拿不到表本身。 */
  function lookupArmedGift (giftId) {
    if (typeof giftId !== 'string' || !isVisitId(giftId)) return null
    return armedGifts.get(giftId.toLowerCase()) ?? null
  }

  /**
   * arm 一件真的上路了的文件礼物。只记背包里那个**绝对路径**，不复制文件：
   * 用户在这期间改/删了它，路由会按 size/sha256 报 410（东西已经不在了）。
   */
  function armFileGift (gift, path, visitId) {
    if (gift === null || typeof gift !== 'object') return false
    if (gift.kind !== 'file') return false
    if (typeof path !== 'string' || path === '') return false
    if (!isVisitId(visitId)) return false
    if (!Number.isInteger(gift.size) || gift.size <= 0 || gift.size > MAX_GIFT_BYTES) return false
    const now = Date.now()
    armedGifts.set(gift.id.toLowerCase(), {
      path,
      size: gift.size,
      hash: gift.sha256,
      visitId: visitId.toLowerCase(),
      until: now + armedGiftMs
    })
    return true
  }

  /** 一次串门结束时调用：只清这次 visitId 的那一件（一次最多带一件）。 */
  function unarmGift (visitId) {
    if (typeof visitId !== 'string' || visitId === '') return 0
    const id = visitId.toLowerCase()
    let removed = 0
    for (const [giftId, entry] of armedGifts) {
      if (entry.visitId !== id) continue
      armedGifts.delete(giftId)
      removed += 1
    }
    return removed
  }

  /**
   * 兜底清扫：tick 可能让一次已抵达的串门到期/失联（room 直接 finishOutbound），
   * 这里按「当前出门的 visitId」对账，任何不再属于这次串门的条目立刻丢掉。
   * 显式的五个结束点仍然各自 unarm；这一层只防止漏掉某条路径。
   */
  function unarmEndedGifts () {
    if (armedGifts.size === 0) return
    const out = room.outboundVisit()
    const visitId = out === null ? null : out.visitId
    for (const [giftId, entry] of armedGifts) {
      if (visitId === null || entry.visitId !== visitId) armedGifts.delete(giftId)
    }
  }

  /**
   * 缩略图地址：只在**本机真的收下**这件文件礼物之后才有记录可查。
   * 目录名与文件名都来自礼物 store（校验过的目录名 + 清洗过的文件名），
   * 渲染端只拿到这个 URL，拿不到任何本机路径。扩展名是否可作缩略图由 desktop-pets 判。
   */
  function giftThumb (giftId) {
    const record = gifts?.lookup(giftId) ?? null
    if (record === null || record.kind !== 'file') return null
    if (typeof record.dirName !== 'string' || typeof record.name !== 'string') return null
    return 'dshzoo://gifts/' + record.dirName + '/' + encodeURIComponent(record.name)
  }

  /**
   * 「dsh-pet 也在画」只提示一次（ticket 31）：桥接每轮都可能回调，日志不能每轮一条；
   * 提示本身由 src/desktop-advisory.js 决定（纯函数，单测在那边）。
   */
  function noteDualLayer () {
    if (dualLayerNoted) return
    const self = room.snapshot().self
    const advisory = dualLayerAdvisory({
      desktopRunning: desktop !== null,
      bridge: self.bridge,
      pet: self.pet
    })
    if (advisory === null) return
    dualLayerNoted = true
    log.warn(advisory.note)
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
      log.info('桌面层被 DSH_ZOO_DESKTOP 关闭：宠物不显示，网络与串门仍然工作')
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
      const assetRoots = assetRootsFor(activeSkin)
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
        // 缩略图只读这个根；helper 不认任何别的路径（ticket 25）。
        giftsRoot: join(dir, 'gifts'),
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
      noteDualLayer()
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
      // 本机宠物：把当前这张皮的动作名交给渲染端轮播，并带上它的尺寸（票 32 / 35）。
      if (pet.role === 'self') {
        const sized = activeSkin === null || !Number.isInteger(activeSkin.size)
          ? pet
          : { ...pet, size: activeSkin.size }
        return skinPool.length === 0 ? sized : { ...sized, idlePool: skinPool }
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
    // 缩略图地址由宿主算好（目录名 + 清洗过的文件名），渲染端只拿到 dshzoo:// URL。
    const controls = controlsFromSnapshot(dropped > 0 ? room.snapshot() : snapshot, { thumbOf: giftThumb })
    // 签名必须包含控件状态：串门按钮的可用性/放行卡/失败提示都可能在没有宠物增删时变化。
    const assetRoots = assetRootsFor(activeSkin)
    // 目录也进签名：两张皮的素材同名但不同目录时，换皮必须让渲染端跟着换根（ticket 33）。
    const signature = JSON.stringify({ pets, controls, menu: desktopMenu, assetRoots })
    if (!reset && signature === desktopSceneSignature) return false
    desktopSceneSignature = signature
    const scene = shared.petScene(pets, desktopWorkArea, { reset, controls, menu: desktopMenu, assetRoots })
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
        // 动作点播要带名字；其余动作这里是 undefined，与 HTTP 那条路同形。
        name: event.name ?? undefined,
        // 只有改名带正文；其余动作这里是 undefined，与 HTTP 那条路同形。
        nickname: event.nickname ?? undefined,
        // 换皮带素材源 id（ticket 32）；注册表在宿主，渲染端只传一个短标识符。
        skinId: event.skinId ?? undefined,
        // 礼物四动作只带 giftId（UUID）；路径由宿主查 store，渲染端从来不知道。
        giftId: event.giftId ?? undefined,
        // 「带派」小窗的提交（ticket 24）带一件待放物品；其余动作这里是 undefined。
        gift: event.gift ?? undefined
      })
    } catch (error) {
      warn(ctx, '桌面控件动作失败（' + event.action + '）：' + message(error))
      result = { ok: false, error: 'action-failed' }
    }
    if (disposed) return
    // 成功也允许带一句话（「扫描外观」加了几张要说得出来）；失败优先用宿主给的 notice。
    const explicit = typeof result?.notice === 'string' && result.notice.trim() !== '' ? result.notice : null
    const notice = result?.ok === true ? explicit : (explicit ?? desktopActionNotice(result?.error))
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
    // 换皮（ticket 32）：注册表里没有这个 id，多半是 skin.json 改了还没重载。
    if (error === 'unknown-skin') return '这张皮已经不在了，先「重载配置」再看。'
    if (error === 'bad-skin-id') return '这个外观 id 不合法。'
    if (error === 'skin-file-broken') return 'skin.json 改坏了，先修好它再扫描。'
    if (error === 'scan-failed') return '扫描素材包失败了，稍后再试。'
    if (error === 'dsh-pet-unreachable') return 'dsh-pet 没有响应，名字没有改（它还开着吗？）。'
    if (error === 'dsh-pet-write-failed') return 'dsh-pet 没有接受这次改名，名字没有变。'
    if (error === 'anim-no-pet') return 'dsh-pet 里还没有宠物，这个动作只在本机播了一次。'
    if (error === 'anim-unreachable') return 'dsh-pet 没有响应，这个动作只在本机播了一次。'
    if (error === 'anim-rejected') return 'dsh-pet 没有接受这个动作，只在本机播了一次。'
    if (error === 'bad-name') return '这个动作没有名字，播不了。'
    if (error === 'reload-failed') return '配置没读出来，还是用之前那份。'
    if (error === 'no-origin') return '拿不到 DSH 的地址，开不了软件。'
    if (error === 'desktop-off') return '桌面层没有在运行，开不了软件。'
    if (error === 'open-failed') return '系统没有接受这个打开请求。'
    if (error === 'gift-not-found') return '这件东西已经不在了。'
    if (error === 'bad-gift') return '这张礼物卡已经不在了。'
    // 背包（ticket 24）：小窗/HTTP 的失败一律说人话，五个错误码各有各的下一步。
    if (error === 'backpack-full' || error === 'too-large' || error === 'no-such-file' ||
      error === 'gift-out') {
      return backpackErrorText(error)
    }
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
      // tick 可能让一次串门到期/失联：记录交给 visits.json，recall 交给 socket；
      // 礼物表按“当前出门的 visitId”对账，任何已结束的条目立刻失效。
      unarmEndedGifts()
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
      // 背包里可能是文件：sendVisitRequest 之前要 await stat/hash，所以这里接了 Promise。
      // 任何异常都只影响这一拍，不能冒成 unhandledRejection 把进程带走。
      maybeSpontaneousVisit().catch((error) => {
        warn(ctx, '自动串门没有完成：' + message(error))
      })
    }, autoVisitIntervalMs)
    autoVisitTimer.unref?.()
  }

  /**
   * 每 30 秒问一次纯策略：开关、活动、冷却、在线邻居四道门都过了才出门。
   * 每次判定都写进 room 快照（lastDecision），并按 reason 节流打一行日志，
   * 这样“为什么它没出门”在日志里能直接读到，不用猜。
   */
  async function maybeSpontaneousVisit () {
    if (disposed) return null
    const plan = room.spontaneousVisitPlan()
    room.notePolicyDecision(plan)
    if (!plan.go || plan.candidate === null) {
      logPolicyPlan(plan)
      return plan
    }

    // 自发与手动走同一条路：背包里最旧的一件也会被带上（ticket 24）。
    const result = await startOutboundVisit(plan.candidate.deviceId)
    if (disposed) return { ...plan, result }
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

  // 活动信号只在自动串门开着时订阅；关掉就退订。
  // 默认配置下自动串门是关的，所以默认连这条事件流都不读。
  let sessionSignal = null

  /**
   * session/event 是 ticket 09 的主活动信号：DSH 里只要有人在用（发消息、跑 turn），
   * 宠物就知道“本机最近有活动”。**只在自动串门开启期间订阅**——关掉时这个信号没有任何
   * 用途，多读一条就是多余的隐私面。拿不到这个能力（web/老宿主/ctx 没有 on）时不报错，
   * 自动退回桌面指针；两者都没有时策略的 activity 门永远关着。
   */
  function subscribeSessionEvents () {
    if (disposed || sessionSignal !== null) return true
    if (typeof ctx?.on !== 'function') {
      log.info('活动信号：宿主没有 session/event，自动串门只靠桌面指针活动')
      return false
    }
    try {
      const off = ctx.on('session/event', () => {
        if (disposed) return
        // 只记“有活动”的时间戳；事件内容不读、不存、不发。
        noteActivity('session')
      }, { global: true })
      sessionSignal = typeof off === 'function' ? off : () => {}
      log.info('活动信号：已订阅 session/event（自动串门开启期间）')
      return true
    } catch (error) {
      warn(ctx, '订阅 session/event 失败，自动串门退回桌面指针：' + message(error))
      return false
    }
  }

  function unsubscribeSessionEvents () {
    if (sessionSignal === null) return
    try {
      sessionSignal()
    } catch {
      // 退订失败不影响卸载
    }
    sessionSignal = null
  }

  /** 自动串门开关变化时调用：开就订阅，关就退订。 */
  function syncSessionSignal () {
    if (disposed) return
    if (room.snapshot().autoVisit.enabled) subscribeSessionEvents()
    else unsubscribeSessionEvents()
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
        // 已经抵达（active）只是不再重发，arm 还要留着；串门没了/换了一次就立刻 unarm。
        if (out === null || out.visitId !== request.visitId) unarmGift(request.visitId)
        request = null
      } else {
        const now = Date.now()
        if (now >= request.deadline) {
          room.failOutboundVisit('timeout', now)
          // 请求超时 = 这次串门结束：对方再也取不到这件东西。
          unarmGift(request.visitId)
          request = null
        } else {
          while (request.attempts < visitAttempts && now >= request.nextAt) {
            // 重发必须带同一件字条；丢了就整条串门都没了意义（ticket 24 的退包也靠这条）。
            sendVisitRequest(request.visitId, request.gift ?? null)
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
   *
   * 礼物只从背包来（票 24）：按「先放的先带走」取 `at` 最小的一件；背包空就空手出门。
   * 编码层判定带不带得上，重发必须带同一个 gift 对象。
   */
  async function startOutboundVisit (deviceId) {
    const visitId = randomUUID()
    let gift = null
    // 背包里被选中的那一件；只有真的发出去才留在 out，发不出去立刻放回 idle。
    let carried = null
    let skipped = null

    // 按「先放的先带走」从背包取最旧的一件。
    // 文件件的 size/sha256 在这里（发送那一刻）才读；读不出来就空手出门，东西留在背包。
    if (backpack !== null) {
      const picked = backpack.oldestIdle()
      if (picked !== null) {
        const prepared = await backpack.prepareGift(picked)
        if (disposed) return { ok: false, error: 'disposed' }
        if (prepared.ok) {
          gift = prepared.gift
          carried = picked
        } else {
          skipped = room.noteGiftMissed(giftPrepareFailedText(prepared.error, picked.name))
        }
      }
    }

    const begun = room.beginVisit(deviceId, { visitId })
    if (!begun.ok) return begun

    if (carried !== null && backpack !== null) {
      const marked = await backpack.markOut(carried.id, visitId)
      if (!marked.ok) {
        // 准备文件的那一会儿用户把它撤掉了（或已经被另一次串门带走）：这次就空手。
        carried = null
        gift = null
      }
    }

    const sent = sendVisitRequest(visitId, gift)
    // 记录里只写**真正带上路**的那一件（编码层可能因为整包超 4 KiB 把它丢了）。
    if (sent.ok) room.markOutboundGift(visitId, sent.gift ?? null)
    if (!sent.ok) {
      request = null
      if (carried !== null && backpack !== null) await backpack.releaseOut(carried.id, visitId)
      const failed = room.failOutboundVisit('peer-offline')
      return {
        ok: false,
        error: 'peer-offline',
        deviceId,
        notice: failed.ok ? failed.notice : null,
        ...(skipped === null ? {} : { missed: skipped.text })
      }
    }
    const now = Date.now()
    request = {
      deviceId,
      visitId,
      attempts: 1,
      nextAt: now + visitRetryMs,
      deadline: now + visitTimeoutMs,
      // 只留真的带上的那一件：整包超限被丢掉之后再重试也不该反复撞同一面墙。
      // 重发**原样**用它，文件件不在重试里重新算 hash（对方看到的是同一件东西）。
      gift: sent.gift
    }
    if (sent.gift !== null && sent.gift !== undefined) {
      // 从这一刻起这件礼物在等回执（ticket 26）：收到就删件，串门结束还没收到就退包。
      // 键一律小写：回执里的 giftId 由协议层归一，这里不能因为调用方传了大写而漏认。
      const giftId = typeof sent.gift.id === 'string' ? sent.gift.id.toLowerCase() : ''
      if (giftId !== '') {
        outboundGifts.set(giftId, {
          deviceId,
          visitId,
          nickname: begun.visit.nickname
        })
      }
    }

    // 文件礼物真的上路了才 arm：对方会在这次串门期间按 giftId 来取。
    // arm 必须晚于 markOut（背包里那件已经标成 out），也只认背包登记过的绝对路径。
    if (carried !== null && sent.gift !== null && sent.gift !== undefined) {
      armFileGift(sent.gift, carried.path, visitId)
    }

    if (sent.giftDropped && carried !== null) {
      // 编码层把礼物丢掉了：它根本没上路，退回 idle，不占着“正在捎出”。
      if (backpack !== null) await backpack.releaseOut(carried.id, visitId)
      carried = null
    }
    // 字条没带上（太长/坏形状/整包超 4 KiB）或背包那件文件读不出来：串门照常，
    // 但必须在本机说一句，不能让人以为东西已经送出去了。
    const notice = sent.giftDropped ? room.noteGiftDropped() : skipped
    return {
      ok: true,
      action: 'visit',
      deviceId,
      visitId,
      phase: 'requesting',
      nickname: begun.visit.nickname,
      giftDropped: sent.giftDropped,
      ...(carried === null ? {} : { giftId: carried.id }),
      ...(notice === null ? {} : { notice: notice.text })
    }
  }

  /**
   * 发一次 visit-request。只走 discovery.sendTo()：先过 mayTalkTo，
   * 再按 deviceId 查地址；没地址（刚离线）返回 false，由调用方明确报 peer-offline。
   */
  function sendVisitRequest (visitId, gift = null) {
    if (disposed || discovery === null || identity === null) {
      return { ok: false, gift: null, giftDropped: false }
    }
    const out = room.outboundVisit()
    if (out === null || out.visitId !== visitId) {
      return { ok: false, gift: null, giftDropped: false }
    }
    const pet = room.snapshot().self.pet
    let built
    try {
      built = encodeVisitRequestDetailed({
        deviceId: identity.deviceId,
        visitId,
        nickname: identity.nickname,
        anim: pet?.anim ?? null,
        action: pet?.action ?? null,
        semantic: pet?.semantic ?? null,
        say: pet?.say ?? null,
        skinPort: skinRef?.port,
        skinId: skinRef?.id,
        gift
      })
    } catch {
      return { ok: false, gift: null, giftDropped: false }
    }
    let sent = false
    try {
      sent = discovery.sendTo(out.deviceId, built.data)
    } catch {
      sent = false
    }
    return {
      ok: sent,
      // 带上了就原样留给重试；被编码层丢掉（太长/坏形状/超 4 KiB）就不再重带。
      gift: sent && !built.giftDropped ? gift : null,
      giftDropped: built.giftDropped
    }
  }

  /** 收到请求：放行且开关开 → ack；否则 deny（带理由，走 sendReply 例外）。 */
  function handleVisitRequest (packet) {
    const result = room.observeVisitRequest(packet)
    if (result.reply !== 'ack') {
      if (result.reply === 'deny') sendVisitDeny(result.deviceId, result.visitId, result.reason)
      return
    }
    // ack 先发：串门本身不等待磁盘。字条在后台落盘，写成功才把卡片从 pending 推到 received。
    sendVisitAck(result.deviceId, result.visitId)
    if (packet.gift !== undefined && packet.gift !== null) {
      // 已经「扔掉」的那一件：对方没收到 ack 又重发时，绝不再写回磁盘、也绝不再长卡片。
      if (!room.isGiftDiscarded(packet.gift.id)) void receiveGift(packet)
    }
  }

  /**
   * 入站礼物：字条同步落盘；文件让接收方按对方广告的 skinPort 主动来取（拉取，不推送）。
   * 失败只让这一张卡 `failed` / `refused`，不影响已经 ack 的串门。
   */
  async function receiveGift (packet) {
    const gift = packet.gift
    if (gift === undefined || gift === null || !isVisitId(gift.id)) return
    // 单件 16 MiB 先判：超大的东西不该消耗这个邻居的频率额度。
    if (gift.kind === 'file' &&
      (!Number.isInteger(gift.size) || gift.size <= 0 || gift.size > MAX_GIFT_BYTES)) {
      setGiftStatus(packet, 'refused', 'too-large')
      return
    }
    // 频率限额是字条与文件**共用**的门卫（ticket 27）：超了不落盘、不回执。
    // 同一 giftId 的重试不重复计数；已经在 store 里的那一件也只会走幂等分支。
    if (!giftRate.allow(packet.deviceId, gift.id)) {
      setGiftStatus(packet, 'refused', 'rate')
      return
    }
    if (gift.kind === 'text') return receiveTextGift(packet)
    if (gift.kind === 'file') return receiveFileGift(packet)
  }

  /** 卡片状态只在这里改：状态变一次就让桌面场景跟上（签名里含 controls.gifts）。 */
  function setGiftStatus (packet, status, reason = null) {
    const changed = room.markGiftStatus(packet.deviceId, packet.gift.id, status, reason)
    if (changed) flushRoomEffects()
    return changed
  }

  /**
   * 字条落盘（ticket 23）。失败只让这一张卡 `failed`，不影响已经 ack 的串门。
   * 重试报文会再写一次同一个目录：store 对同一 gift.id 是幂等的。
   */
  async function receiveTextGift (packet) {
    const gift = packet.gift
    const saved = gifts === null
      ? { ok: false, error: 'starting' }
      : await gifts.receiveText({
        id: gift.id,
        from: { deviceId: packet.deviceId, nickname: packet.nickname },
        text: gift.text,
        receivedAt: Date.now()
      })
    if (disposed) return
    setGiftStatus(packet, saved.ok ? 'received' : 'failed', saved.ok ? null : 'write')
    if (!saved.ok) {
      warn(ctx, '字条没写进 gifts（' + saved.error + '）：卡片会显示“没取到”')
    } else {
      // **真的写进 gifts/ 之后**才回执（SPEC v4）。重试报文会再写一次、再发一次，
      // receipts 表按 giftId 去重，不会重启一轮重发。
      sendGiftReceipt(packet.deviceId, packet.visitId, gift.id)
    }
  }

  /**
   * 文件礼物（ticket 25）：先做上限判定 → receiving → 拉取（连接 5s / 总计 20s、≤16 MiB、
   * 边下边算 sha256、先写 `.part` 再 rename）→ received；任何失败都只记固定词表里的原因。
   *
   * 同一个 giftId 的迟到重试不重复下载；一个坏礼物只影响这一张卡。
   */
  async function receiveFileGift (packet) {
    const gift = packet.gift
    const giftId = gift.id.toLowerCase()
    if (receivingGifts.has(giftId)) return
    if (gifts === null) {
      setGiftStatus(packet, 'failed', 'write')
      return
    }
    // 重发/上一次已经收过：幂等，不再下载。
    if (gifts.lookup(giftId) !== null) {
      setGiftStatus(packet, 'received')
      return
    }
    // 单件 ≤16 MiB：wire 层已经挡过一次，这里是本机落盘前的最后一道（防御）。
    if (!Number.isInteger(gift.size) || gift.size <= 0 || gift.size > MAX_GIFT_BYTES) {
      setGiftStatus(packet, 'refused', 'too-large')
      return
    }
    if (!isPort(packet.skinPort)) {
      // 对方没开素材端口（或版本太旧不广告）：东西取不回来，但串门本身照常。
      setGiftStatus(packet, 'failed', 'no-port')
      return
    }
    const endpoint = discovery === null ? null : discovery.addressOf(packet.deviceId)
    if (endpoint === null || typeof endpoint.address !== 'string') {
      setGiftStatus(packet, 'failed', 'timeout')
      return
    }

    receivingGifts.add(giftId)
    setGiftStatus(packet, 'receiving')
    try {
      const slot = await gifts.beginFile({
        id: giftId,
        from: { deviceId: packet.deviceId, nickname: packet.nickname },
        name: gift.name,
        size: gift.size,
        sha256: gift.sha256,
        receivedAt: Date.now()
      })
      if (disposed) return
      if (!slot.ok) {
        setGiftStatus(packet, 'failed', slot.error === 'bad-gift' ? 'refused' : 'write')
        return
      }
      const fetched = giftFetcher === null
        ? { ok: false, error: 'write' }
        : await giftFetcher.fetchTo({
          address: endpoint.address,
          port: packet.skinPort,
          giftId,
          targetPath: slot.filePath,
          size: gift.size,
          sha256: gift.sha256
        })
      if (disposed) return
      if (!fetched.ok) {
        await gifts.abortFile(giftId)
        setGiftStatus(packet, 'failed', fetched.error)
        warn(ctx, '文件礼物没取到（' + fetched.error + '）：卡片会显示“没取到”')
        return
      }
      const saved = await gifts.finishFile({
        id: giftId,
        from: { deviceId: packet.deviceId, nickname: packet.nickname },
        name: gift.name,
        size: gift.size,
        sha256: gift.sha256,
        receivedAt: Date.now()
      })
      if (disposed) return
      if (!saved.ok) {
        await gifts.abortFile(giftId)
        setGiftStatus(packet, 'failed', 'write')
        warn(ctx, '文件礼物写不进 gifts（' + saved.error + '）：卡片会显示“没取到”')
        return
      }
      setGiftStatus(packet, 'received')
      // **真的写进 gifts/ 之后**才回执（SPEC v4，ticket 26）：文件路径的接缝在这里。
      sendGiftReceipt(packet.deviceId, packet.visitId, gift.id)
    } catch (error) {
      await gifts.abortFile(giftId).catch(() => {})
      if (disposed) return
      setGiftStatus(packet, 'failed', 'write')
      warn(ctx, '文件礼物接收失败：' + message(error))
    } finally {
      receivingGifts.delete(giftId)
    }
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
    // ticket 26：回执的重发（接收方）与串门结束后的退包（发起方）。
    // 两件事都按 gift/visit 幂等，放在这个统一出口，onPeer / tick / action 都覆盖到。
    runReceiptRetries()
    reconcileOutboundGifts()
    noteEndedInboundGifts()
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

  // -------------------------------------------------------------------------
  // ticket 26：送达回执与退包
  // -------------------------------------------------------------------------

  /**
   * 回执的通用出口：接收方**真的把东西写进 `gifts/` 之后**调用。
   *
   * 字条现在就走这里；ticket 25 的文件拉取在「临时文件 rename 成功」之后调
   * 同一个函数（`sendGiftReceipt(deviceId, visitId, giftId)`）即可，
   * 不要在文件分支另写一套重发。
   *
   * 发三次、间隔约 400ms（与 recall 同一套路）。回执没有 ack：重复到达在发起方
   * 是幂等的，所以这里只要「发出去过就登记」——同一件礼物重复写盘不会重启一轮重发。
   */
  function sendGiftReceipt (deviceId, visitId, giftId) {
    if (disposed || discovery === null || identity === null) return false
    if (typeof deviceId !== 'string' || !isVisitId(visitId) || !isVisitId(giftId)) return false
    const id = giftId.toLowerCase()
    if (receipts.has(id)) return true
    const receipt = {
      deviceId,
      visitId: visitId.toLowerCase(),
      attempts: 1,
      nextAt: 0,
      deadline: 0
    }
    if (!sendGiftReceiptPacket(receipt, id)) return false
    const now = Date.now()
    receipt.nextAt = now + receiptRetryMs
    receipt.deadline = now + receiptTimeoutMs
    receipts.set(id, receipt)
    return true
  }

  function sendGiftReceiptPacket (receipt, giftId) {
    if (disposed || discovery === null || identity === null) return false
    try {
      return discovery.sendTo(receipt.deviceId, encodeGiftReceived({
        deviceId: identity.deviceId,
        visitId: receipt.visitId,
        giftId
      }))
    } catch {
      return false
    }
  }

  /** 回执的重发计时器（由 visitTimer 每 200ms 驱动一次）；有界、幂等。 */
  function runReceiptRetries () {
    if (receipts.size === 0) return
    const now = Date.now()
    for (const [giftId, receipt] of receipts) {
      if (receipt.attempts >= receiptAttempts || now >= receipt.deadline) {
        receipts.delete(giftId)
        continue
      }
      if (now < receipt.nextAt) continue
      if (!sendGiftReceiptPacket(receipt, giftId)) {
        // 对方离线/不再放行：再发也不会到，收手。
        receipts.delete(giftId)
        continue
      }
      receipt.attempts += 1
      receipt.nextAt += receiptRetryMs
    }
  }

  /**
   * 收到回执（ticket 26）：只认自己登记过的那一件，而且 deviceId / visitId 都要对得上。
   *
   * 幂等靠这张表：第一次就把条目摘掉，重复回执到这里就是 no-op（不重复删、不重复提示）。
   * 摘掉之后再 await 背包，所以 `reconcileOutboundGifts` 不会把同一件当“没送到”退回去。
   */
  function handleGiftReceived (packet) {
    const giftId = typeof packet?.giftId === 'string' ? packet.giftId.trim().toLowerCase() : ''
    const pending = outboundGifts.get(giftId)
    if (pending === undefined) return false
    if (pending.deviceId !== packet.deviceId || pending.visitId !== packet.visitId) return false
    outboundGifts.delete(giftId)
    void confirmOutboundGift(giftId, pending)
    return true
  }

  async function confirmOutboundGift (giftId, pending) {
    if (backpack !== null) await backpack.confirmOut(giftId, pending.visitId)
    if (disposed) return
    // 对方确认收到了：东西从背包删掉，并在本机说一句「收下了」。
    room.noteGiftReceived(pending.nickname)
    refreshBringWindow()
    flushRoomEffects()
  }

  /**
   * 发起方的退包（ticket 26）：只要 room 里那次出门已经不在了，还没等到回执的礼物
   * 就退回背包。
   *
   * 这是**唯一**的退包入口，所以不用在 finishOutbound / failOutbound / tick /
   * observeVisitRecall 里各挂一次：这些结束点（回家 / 送客 / 到期 / 失联 / 请求中
   * 被对方 recall / 本地召回）的终点都是 `state.out` 变成 null，而每个终点后面都会走
   * `flushRoomEffects`（tick、action、onPeer 都一样）。`dispose` 另算，见
   * `releaseOutboundGiftsOnDispose`。
   */
  function reconcileOutboundGifts () {
    if (outboundGifts.size === 0) return 0
    const out = room.outboundVisit()
    let released = 0
    for (const [giftId, pending] of outboundGifts) {
      if (out !== null && out.visitId === pending.visitId) continue
      // 先摘表再 await：连续两次 flush 不会把同一件退两遍、说两句。
      outboundGifts.delete(giftId)
      void releaseOutboundGift(pending)
      released += 1
    }
    return released
  }

  async function releaseOutboundGift (pending) {
    if (backpack === null) return
    const released = await backpack.releaseOutByVisit(pending.visitId)
    if (disposed || !released.ok || released.released.length === 0) return
    // 真的从 out 退回了一件才说；没退到东西时不该凭空说“退回背包”。
    room.noteGiftNotReceived()
    refreshBringWindow()
    flushRoomEffects()
  }

  /**
   * 送客提醒（ticket 26）：入站串门结束（送客 / 对方召回 / 失联 / 名单收紧）时，
   * 若这件礼物真的收下过（有 meta）且一次都没打开过（`meta.opened === false`），
   * 说一句「…捎来的东西还在 gifts 里。」
   *
   * `opened` 只存在磁盘上，所以这一步必须留在 service；room 只把“谁带着哪件走了”
   * 交出来（`drainEndedInboundGifts`）。
   */
  function noteEndedInboundGifts () {
    for (const ended of room.drainEndedInboundGifts()) {
      const record = gifts?.lookup(ended.giftId) ?? null
      if (record === null || record.opened !== false) continue
      room.noteGiftLeftBehind(ended.nickname)
    }
  }

  /**
   * 卸载也算一次串门结束（ticket 26）：还没回执的礼物写回 idle。
   * 下一次启动的 `load()` 本来也会把遗留 `out` 归一成 idle；这里先写回去，
   * 是为了进程退出后立刻打开 backpack.json 看到的状态就是对的。
   */
  function releaseOutboundGiftsOnDispose () {
    if (backpack === null || outboundGifts.size === 0) return
    const visitIds = new Set([...outboundGifts.values()].map((pending) => pending.visitId))
    outboundGifts.clear()
    for (const visitId of visitIds) {
      try {
        const pending = backpack.releaseOutByVisit(visitId)
        if (pending !== null && typeof pending?.catch === 'function') pending.catch(() => {})
      } catch {
        // 卸载路径不能因为磁盘失败抛出去；下一次启动的归一化会兜住。
      }
    }
  }

  // 活动信号由 syncSessionSignal 在设置加载后按“自动串门是否开启”决定，默认不订阅。
  const ready = start()

  return {
    room,
    ready,
    snapshot: () => stateView(),
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
      unsubscribeSessionEvents()
      try { skinServer?.close() } catch { /* 关不掉也不能挡住卸载 */ }
      skinServer = null
      skinRef = null
      skinFetcher = null
      visitorSkins.clear()
      skinPool = []
      // 礼物端口随服务器一起关了：内存里的 armed 表与在途标记不再有意义。
      armedGifts.clear()
      receivingGifts.clear()
      giftFetcher = null
      giftRate.clear()
      // 回执不再发了；还没回执的礼物先写回 idle，再放开背包引用。
      receipts.clear()
      releaseOutboundGiftsOnDispose()
      outboundGifts.clear()
      gifts = null
      backpack = null
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
 * DSH 自己的 GUI 地址（菜单里的「打开软件」要打开它）。
 * 只认 http(s)；取不到就返回 null，这一项就不出现在菜单里。
 *
 * 地址还要过一次 `connection.authenticatedUrl`：DSH 的 Web 层只认 `GET /?token=…`
 * 那条登录地址（换一次 Cookie 再 303 到干净的 `./`），裸 origin 一律 401——
 * 浏览器上就是「dsh web authentication required; reopen the URL printed by dsh web.」。
 * 拿不到 connection（老宿主 / 没有 Web 载体）才退回裸 origin，那种宿主本来就没这层认证。
 */
function dshOrigin (ctx) {
  const origin = dshListenerOrigin(ctx)
  return origin === null ? null : authenticatedUrl(ctx, origin)
}

/** webServer 的裸 origin：文档化的 `getOrigin()`，未绑定时退回 `.port`。 */
function dshListenerOrigin (ctx) {
  const server = ctx?.webServer
  try {
    if (typeof server?.getOrigin === 'function') {
      const origin = server.getOrigin()
      if (typeof origin === 'string' && origin !== '') {
        const parsed = new URL(origin)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString()
      }
    }
  } catch {
    // listen 还没绑定
  }
  const port = server?.port
  return Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null
}

/**
 * 把一条干净的浏览器地址换成 DSH 的登录地址（本进程 launch token 进 `?token=`）。
 * 用 `ctx.get('connection')` 现取：插件只 inject 了 webServer，不该为了一个菜单项
 * 把整只插件的启动绑在 connection 上。任何一步不成，退回原地址。
 */
function authenticatedUrl (ctx, baseUrl) {
  try {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : ctx?.connection
    const mint = connection?.authenticatedUrl
    if (typeof mint !== 'function') return baseUrl
    const value = mint.call(connection, baseUrl)
    if (typeof value !== 'string' || value === '') return baseUrl
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : baseUrl
  } catch {
    return baseUrl
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
  const full = '[dsh-zoo] ' + line
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
 * `DSH_ZOO_DESKTOP=0|false|off` 直接关掉桌面层。
 * 置顶全屏窗如果出了意想不到的问题，这是唯一不需要改配置、也不需要卸载插件的出口。
 */
function isDesktopDisabled (env) {
  const value = String(env?.DSH_ZOO_DESKTOP ?? '').trim().toLowerCase()
  return value === '0' || value === 'false' || value === 'off' || value === 'no'
}
