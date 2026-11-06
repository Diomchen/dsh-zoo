import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

import shared from '../desktop/shared.js'
import { createBackpackStore } from './backpack.js'
import { createContractStore } from './contracts.js'
import {
  MAX_CONTRACTS_PER_SIDE,
  contractMsOf,
  earnedFor,
  feeFor,
  hireAvailability,
  MAX_CONTRACT_HOURS,
  MAX_CONTRACT_WAGE,
  MIN_CONTRACT_HOURS,
  MIN_CONTRACT_WAGE,
  normalizeHours,
  refundFor,
  servedMsOf,
  WORK_FEE_RATE
} from './contracts-rules.js'
import { dualLayerAdvisory } from './desktop-advisory.js'
import { createDesktop } from './desktop.js'
import { discoverPetPacks } from './dsh-pet-pets.js'
import { controlsFromSnapshot, droppedVisitors, petsFromSnapshot } from './desktop-pets.js'
import { createDiscovery } from './discovery.js'
import {
  FARM_LOG_VIEW_LIMIT,
  HELP_PER_VISITOR_PER_DAY,
  MAX_FARM_LOG,
  PLOT_IDS,
  STEAL_PER_VISITOR_PER_DAY,
  createFarmStore,
  initialFarmView
} from './farm.js'
import {
  CROPS,
  CROP_IDS,
  WORKER_GUARD,
  guardValue,
  isMature,
  localDayKey,
  plotRemainingMs,
  plotStage,
  stealSucceeds
} from './farm-rules.js'
import { createFarmFetcher, normalizeVisitView } from './farm-fetch.js'
import { farmActionResultText, farmErrorText } from './farm-text.js'
import {
  MARKET_VIEW_HISTORY,
  createMarketStore,
  initialMarketView,
  isFreshMarketSample,
  marketView
} from './market.js'
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
import { DEFAULT_SKIN_ID, appendSkinSources, idlePoolOf, loadSkinSources, readSkinEntries } from './skin-sources.js'
import { createSkinFetcher } from './skin-fetch.js'
import {
  HEARTBEAT_INTERVAL_MS,
  MARKET_DIGEST_INTERVAL_MS,
  MAX_GIFT_BYTES,
  createRateLimiter,
  encodeFarmAction,
  encodeFarmActionResult,
  encodeMarketDigest,
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
  encodeWorkAck,
  encodeWorkEnd,
  encodeWorkEndAck,
  encodeWorkRecall,
  encodeWorkRecallAck,
  encodeWorkRequest,
  encodeWorkSettle,
  encodeWorkSettleAck,
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
/** 农场 tick（SPEC v5「存储」）：每 60 秒推进生长/露水，保存由 store 节流。 */
export const FARM_TICK_MS = 60 * 1000
/**
 * 访客动作（ticket 43）：首次 + 两次重发（间隔约 500ms），1.8 秒没结果就明确超时。
 * 重发**复用同一个 requestId 和同一串字节**；主人侧按 requestId 回放缓存，不重复落账。
 */
export const FARM_ACTION_ATTEMPTS = 3
export const FARM_ACTION_RETRY_MS = 500
export const FARM_ACTION_TIMEOUT_MS = 1800
/** 邻居广告的 LAN 端口只信 30 秒（与邻居 TTL 同口径）。 */
export const PEER_LAN_PORT_TTL_MS = 30 * 1000
/** 主人侧结果幂等缓存：最近 200 条 + 10 分钟。 */
export const MAX_FARM_RESULTS = 200
export const FARM_RESULT_TTL_MS = 10 * 60 * 1000
/** 合同 ack 重放缓存（work-ack / work-settle-ack）：同样 200 条 + 10 分钟。 */
export const MAX_WORK_RESULTS = 200

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
 * - 农场落盘（src/farm.js；规则在 src/farm-rules.js）
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
  // 2 分钟失联窗口：room 的镜像与合同的离线结算共用同一个值。
  const peerLostMs = positiveOption(options.peerLostMs, PEER_LOST_MS, 100)
  const room = createRoom({
    dir,
    log,
    visitMaxMs: positiveOption(options.visitMaxMs, VISIT_MAX_MS, 100),
    peerLostMs
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
  // 农场（ticket 39）：tick 节拍与测试时钟都可注入；生产默认 60 秒 / Date.now。
  const farmTickMs = positiveOption(options.farmTickMs, FARM_TICK_MS, 10)
  const farmNow = typeof options.farmNow === 'function' ? options.farmNow : undefined
  // 偷菜守卫的随机源（ticket 43）：只给测试注入「必被抓」；生产是 Math.random。
  const farmRandom = typeof options.farmRandom === 'function' ? options.farmRandom : Math.random
  // 访客动作的重试/超时（ticket 43）：测试可以调快，生产固定 3×500ms / 1.8s。
  const farmActionAttempts = integerOption(options.farmActionAttempts, FARM_ACTION_ATTEMPTS, 1, 8)
  const farmActionRetryMs = positiveOption(options.farmActionRetryMs, FARM_ACTION_RETRY_MS, 10)
  const farmActionTimeoutMs = positiveOption(
    options.farmActionTimeoutMs,
    FARM_ACTION_TIMEOUT_MS,
    farmActionRetryMs
  )
  // 雇佣合同（ticket 44）：时钟默认跟随农场测试时钟；生产就是 Date.now。
  const contractNow = typeof options.contractNow === 'function'
    ? options.contractNow
    : (farmNow ?? (() => Date.now()))
  const contractClock = () => {
    const value = contractNow()
    const stamp = Number(value)
    return Number.isFinite(stamp) ? stamp : Date.now()
  }
  // 雇佣请求：首次 + 两次重发；1.8 秒没有 ack 就明确超时并退款。
  const workAttempts = integerOption(options.workAttempts, 3, 1, 8)
  const workRetryMs = positiveOption(options.workRetryMs, 500, 10)
  const workTimeoutMs = positiveOption(options.workTimeoutMs, 1800, workRetryMs)
  /** 合同巡检（到期/失联/重发 settle/召回）节拍；生产 1 秒。 */
  const contractTickMs = positiveOption(options.contractTickMs, 1000, 10)
  /** 启动宽限：雇工刚重启时先等第一拍心跳，避免把「刚回来」误判成离线。 */
  const contractStartupGraceMs = positiveOption(options.contractStartupGraceMs, 5000, 1)
  /** 结算/召回重发：1s 起步指数退避，封顶 30s。 */
  const contractRetryMs = positiveOption(options.contractRetryMs, 1000, 20)
  const contractRetryMaxMs = positiveOption(options.contractRetryMaxMs, 30 * 1000, 50)
  // 交易所也可以单独注入时钟；不传就与农场共用同一个测试时钟。
  const marketNow = typeof options.marketNow === 'function' ? options.marketNow : farmNow
  // 行情 gossip（ticket 42）：发送节拍与接收端「1 peer / 窗口最多 1 条」共用同一个值。
  const marketDigestMs = positiveOption(options.marketDigestMs, MARKET_DIGEST_INTERVAL_MS, 10)
  const marketClock = () => {
    const value = marketNow === undefined ? Date.now() : marketNow()
    const stamp = Number(value)
    return Number.isFinite(stamp) ? stamp : Date.now()
  }

  let identity = null
  let discovery = null
  let peers = null
  let visits = null
  // 入站礼物的落盘（ticket 23）；起不来只意味着“这次运行收不到字条”，串门照常。
  let gifts = null
  // 发送端的背包（ticket 24）；起不来 = 这次运行不带东西，串门照常。
  let backpack = null
  // 农场（ticket 39）：读不出来 = 本次运行按初始农场玩，串门照常。
  let farm = null
  // 本机交易所（ticket 41）：读不出来 = 本次运行按初始价交易，串门照常。
  let market = null
  // 雇佣合同账本（ticket 44）：读不出来 = 本次运行不能雇/被雇，串门与农场照常。
  let contracts = null
  let contractsReadyAt = 0
  /** 在飞雇佣：requestId → { deviceId, data, attempts, deadline, resolve, timer, done }。 */
  const workRequests = new Map()
  /** 幂等 ack 缓存：`deviceId:requestId` → { data, at }；命中原样重发同一串字节。 */
  const workResults = new Map()
  /** 同一 requestId 的并发重发只落账一次。 */
  const workInFlight = new Set()
  /** 一次只允许一笔在飞雇佣（UI 的「正在联系…」）。 */
  let pendingHire = null
  /** 合同重试的下一次时间：id → at（只活在内存；重启后立刻试一次）。 */
  const contractRetryAt = new Map()
  /** 同一份合同的重试次数（指数退避，1s→2s→…→30s）。 */
  const contractAttempts = new Map()
  /** 结算/退款各自只允许一笔在飞；重复报文看到标记就等下一拍。 */
  const settleInFlight = new Set()
  const refundInFlight = new Set()
  const settleSending = new Set()
  /**
   * 放行邻居最近一条行情（ticket 42，供 44 的雇工板直接读）：
   * deviceId → { prices, hire, at, nickname }。store 只留价格算指数；
   * 挂牌与昵称留在这里，44 不再逐个问邻居。过期判断用 `at`。
   */
  const peerDigests = new Map()
  let settings = null
  let bridge = null
  let desktop = null
  let desktopWorkArea = null
  /**
   * 主屏在桌面窗口里的矩形（窗口局部 DIP）。多屏时整张桌面是各屏工作区的并集，
   * 宠物要生在主屏上（并集的正中是两块屏的接缝），尺寸也只能按主屏算。
   */
  let desktopHomeArea = null
  /**
   * 每块屏在桌面窗口里的矩形（窗口局部 DIP，宿主侧的 `ready.displays` 换算）。
   * 随场景下发，渲染端用它把宠物钉在所在那块屏的底边上。
   */
  let desktopFloors = []
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
   * 邻居广告的 LAN 服务端口（ticket 43）：deviceId → { port, at }。
   * 只在 `onPeer` 里从 heartbeat/visit-request/beacon 的 `skinPort` 缓存 30 秒；
   * 只给访客拉农场快照用，绝不进快照、也不进任何报文。
   */
  const peerLanPorts = new Map()
  /**
   * 主人侧 farm-action 幂等缓存（ticket 43）：`${deviceId}:${requestId}` → { result, at }。
   * **应用之后才写**（失败也写：重试要回同一句，不能第二次重新 roll 守卫）。
   */
  const farmResults = new Map()
  /** 同一 visitor/day 的「被抓住」桌面提示只发一次（ticket 43/45：不能刷屏）。 */
  const caughtToastDays = new Map()
  /**
   * 访客的驮包（ticket 43/44，只显示）：偷到的作物记到这次串门结束；
   * 工资从活跃合同派生。**不参与记账**：作物已经进仓库、硬币已经扣/入账。
   */
  const carriedCrops = { visitId: null, items: [] }
  /** 重复的 tick/结算告警只记一次（ticket 45）；key 是操作名，不是整句文案。 */
  const warnedOnce = new Set()
  /**
   * 访客侧在飞动作：requestId → { deviceId, visitId, data, attempts, nextAt, deadline, resolve }。
   * 一次用户点击只有一个 requestId；重发复用同一串字节，结果只 settle 一次。
   */
  const farmRequests = new Map()
  /** 同一 requestId 的并发重发只落账一次：key → Promise<outcome>。 */
  const farmInflight = new Map()
  let farmFetcher = null
  /** 当前农场窗的访客视图（有则串门结束时要推 `ended`，别让窗停在旧快照）。 */
  let farmWindowVisitId = null
  /** 农场窗是否被打开过：没开过就不必为合同/digest 变化推 `open:false`。 */
  let farmWindowOpened = false
  let farmWindowVisitView = null
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
  /** 上一次成功发出 digest 的时间与签名（价格 + 挂牌）；变化时不等 30 秒。 */
  let marketDigestAt = Number.NEGATIVE_INFINITY
  let marketDigestSignature = null
  const digestLimiter = createRateLimiter({
    windowMs: marketDigestMs,
    max: 1,
    maxSources: 128,
    now: marketClock
  })
  let visitTimer = null
  let autoVisitTimer = null
  let farmTimer = null
  let contractTimer = null
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
      // 拒绝/移除一位邻居：它的行情也不该继续影响本机指数。
      if (action === 'reject') forgetPeerDigest(deviceId)
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

    // 访客在邻居农场里偷/帮（ticket 43）：不是本地动作，走 UDP farm-action。
    // 这里会 await 结果（最长 1.8s），所以 handleDesktopAction 只回一次 action-result。
    if (action === 'farm-steal' || action === 'farm-help') {
      return handleVisitFarmAction(action, body?.plotId, body?.visitId)
    }

    // 农场（ticket 39）：四个本地动作。规则在 src/farm-rules.js（纯），
    // 落盘/串行化在 src/farm.js；UDP 报文没有入口，访客的偷/帮走 ticket 43。
    if (action === 'plant' || action === 'harvest' || action === 'water' || action === 'fertilize' ||
      action === 'farm-plant' || action === 'farm-harvest' || action === 'farm-water' || action === 'farm-fertilize') {
      if (farm === null) return { ok: false, error: 'starting' }
      // 桌面小窗发的是 farm-* 前缀（和菜单/客户端动作族一致）；HTTP 仍是 SPEC 里的四种。
      const kind = action.startsWith('farm-') ? action.slice('farm-'.length) : action
      const result = kind === 'plant'
        ? await farm.plant(body?.plotId, body?.cropId)
        : await farm[kind](body?.plotId)
      // 开着的窗口不能停在旧地块：种/收/浇/施肥成功后都推一份新的完整视图。
      if (result?.ok === true) refreshFarmWindow()
      return result
    }

    // 交易所（ticket 41）：HTTP 用 SPEC 的 `buy-seed` / `sell-crop`，小窗用带前缀的同名动作。
    // 数量与价格由宿主算；窗口只发 cropId + qty，永远不传单价。
    if (action === 'buy-seed' || action === 'sell-crop' ||
      action === 'farm-buy-seed' || action === 'farm-sell-crop') {
      if (farm === null || market === null) return { ok: false, error: 'starting' }
      const result = action === 'buy-seed' || action === 'farm-buy-seed'
        ? await farm.buySeed(body?.cropId, body?.qty)
        : await farm.sellCrop(body?.cropId, body?.qty)
      // 成交后价目/硬币/仓库都变了：开着的交易所页要立刻看到新一份；
      // 价格也是邻居的指数样本，不等下一拍 tick 就补发一轮 digest。
      if (result?.ok === true) {
        refreshFarmWindow()
        sendMarketDigest()
      }
      return result
    }

    // 雇佣（ticket 44）：窗口只能「申请」，钱/时长/总价全由宿主算。
    // 四个动作共用一套错误码（contracts-rules 的 WORK_ERRORS）。
    if (action === 'hire') return hireNeighbor(body?.deviceId, body?.hours)
    if (action === 'recall-worker') return recallWorker(body?.contractId)
    if (action === 'end-contract') return endContract(body?.contractId)
    if (action === 'hire-listing') return setHireListing(body)

    // 农场小窗（ticket 40）：菜单「农场」或桌面地块把一次开窗申请交给宿主。
    // 数据由宿主算好（窗口是 file:// 页面，读不到 /state），失败必须回人话。
    if (action === 'farm-open') return handleFarmOpen(body?.plotId)

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
          name: nickname,
          // 接口缺席（404）时直写这份配置：dsh-pet 的配置文件还在，名字的真相就还在它那儿。
          configPath
        })
        // 原子：写不进去就什么都不改，绝不留下“本地叫 A、dsh-pet 叫 B”的分叉。
        if (!written.ok) {
          return { ok: false, error: written.error, ...(written.status ? { status: written.status } : {}) }
        }
        if (written.via === 'file') {
          // 正常路径不会走到这里；真走了要能在日志里解释“为什么名字变了、接口却没被调用”。
          warn(ctx, 'dsh-pet 的 /config 路由不在（404），这次改名直接写它的配置文件')
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
   * `/dsh-zoo/state` 的唯一形状（ticket 27 / 39）：room 的纯快照 + 磁盘视图。
   *
   * 磁盘只在这里读，room 永远不碰 fs。数组/对象在任何时候都有完整形状：
   * store 还没起来/初始化为 null 时就是空数组或初始农场，绝不出现 `undefined`。
   */
  function stateView () {
    return {
      ...desktopSnapshot(),
      // 当前那张皮（ticket 32）：换皮只看这一项，别的状态都不该动。
      skin: activeSkin === null
        ? null
        : { id: activeSkin.id, size: activeSkin.size, idle: activeSkin.idle },
      backpack: backpack?.items() ?? [],
      gifts: recentGifts(),
      // 本机交易所（ticket 41）：prices/index/history；history 最近 50 笔。
      market: marketStateView(),
      // 雇佣合同（ticket 44）：store 没起来也给完整空形状，绝不 undefined。
      contracts: contractsView()
    }
  }

  /**
   * 桌面层拿到的快照（ticket 40）：room 的纯快照 + 39 的农场全量视图。
   *
   * **room 一行不改**：农场和 backpack/gifts 一样是「room 快照 + 磁盘视图」，由这里合成。
   * `controlsFromSnapshot` 只把它裁成地块条要的摘要；窗口那份完整视图走 `farm-window`。
   */
  function desktopSnapshot () {
    return {
      ...room.snapshot(),
      farm: farmStateView()
    }
  }

  /** 有界回放缓存：同一个 key 只留最新一条，超过上限丢最旧（work/farm 两张表共用）。 */
  function rememberBounded (map, key, value, limit) {
    map.delete(key)
    map.set(key, value)
    while (map.size > limit) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  /** 重复的 tick/重试告警只记一次；key 用操作名（`farm-tick` / `settle`…）。 */
  function warnOnce (key, line) {
    if (warnedOnce.has(key)) return
    warnedOnce.add(key)
    warn(ctx, line)
  }

  /**
   * 访客的驮包（只显示，ticket 43/44）：偷来的作物「在驮包里」直到这次串门结束；
   * 工资从合同派生（active 用 provisionalEarned，ended 未结算用 earned）。
   * **不改任何账**：作物已经进仓库、硬币已经按合同扣/入账，这里只是把「还在路上」
   * 这一层如实画出来。串门结束 / 合同结算后条目自然消失。
   */
  function carriedView () {
    const out = room.outboundVisit()
    const items = []
    if (out === null || carriedCrops.visitId !== out.visitId) {
      if (carriedCrops.items.length > 0 || carriedCrops.visitId !== null) {
        carriedCrops.visitId = null
        carriedCrops.items = []
      }
    } else {
      const until = Number.isFinite(Number(out.endsAt)) ? Math.floor(Number(out.endsAt)) : null
      for (const entry of carriedCrops.items) {
        items.push({ ...entry, until })
      }
    }
    let incoming = []
    try {
      incoming = contractsView().incoming
    } catch {
      incoming = []
    }
    for (const record of incoming) {
      if (record.status === 'active') {
        items.push({
          kind: 'wage',
          amount: Math.max(0, Math.floor(Number(record.provisionalEarned) || 0)),
          contractId: record.id,
          who: record.employerNickname ?? null,
          at: Number.isFinite(Number(record.startedAt)) ? Math.floor(Number(record.startedAt)) : null,
          until: Number.isFinite(Number(record.endsAt)) ? Math.floor(Number(record.endsAt)) : null
        })
      } else if (record.status === 'ended' && record.settled !== true) {
        items.push({
          kind: 'wage',
          amount: Math.max(0, Math.floor(Number(record.earned) || 0)),
          contractId: record.id,
          who: record.employerNickname ?? null,
          at: Number.isFinite(Number(record.startedAt)) ? Math.floor(Number(record.startedAt)) : null,
          until: Number.isFinite(Number(record.endedAt)) ? Math.floor(Number(record.endedAt)) : null
        })
      }
    }
    return items
  }

  /** 「被抓住」的桌面提示每位访客每天只发一次；日志仍然每次尝试一条（有界 50）。 */
  function shouldToastCaught (deviceId) {
    const day = localDayKey(contractClock()) ?? 'unknown'
    const key = day + ':' + String(deviceId)
    if (caughtToastDays.has(key)) return false
    caughtToastDays.set(key, true)
    while (caughtToastDays.size > 128) {
      const oldest = caughtToastDays.keys().next().value
      if (oldest === undefined) break
      caughtToastDays.delete(oldest)
    }
    return true
  }

  /** 偷到 1 个：只加驮包条目（作物已经由 farm.addCrop 记账）。 */
  function noteCarriedCrop (out, crop, qty, at) {
    if (out === null || typeof crop !== 'string' || !Number.isFinite(Number(qty)) || qty <= 0) return
    if (carriedCrops.visitId !== out.visitId) {
      carriedCrops.visitId = out.visitId
      carriedCrops.items = []
    }
    const existing = carriedCrops.items.find((entry) => entry.crop === crop)
    if (existing !== undefined) {
      existing.qty = Math.min(999, existing.qty + Math.floor(Number(qty)))
      return
    }
    carriedCrops.items.unshift({
      kind: 'crop',
      crop,
      qty: Math.min(999, Math.floor(Number(qty))),
      at: Number.isFinite(Number(at)) ? Math.floor(Number(at)) : null
    })
    if (carriedCrops.items.length > 8) carriedCrops.items.length = 8
  }

  /**
   * `/state` 的农场出口（SPEC v5「状态出口与动作」）：
   * `{ plots, coins, seeds, crops, dew, dewEarned, guard, worker, hire, log }`，log 最近 20 条。
   * `dewEarned` 是今天已经挣到的露水（花掉余额不会回退），UI 用它显示当天剩余额度。
   *
   * `guard` / `worker` 是 43/44 的口子：偷菜和雇工还没实现，先给固定空值，
   * 形状先按 SPEC 固定下来，后面只填值、不再改结构。
   */
  function farmStateView () {
    const view = farm?.snapshot() ?? initialFarmView()
    return {
      plots: view.plots,
      coins: view.coins,
      seeds: view.seeds,
      crops: view.crops,
      dew: view.dew,
      dewEarned: view.dewEarned,
      // ticket 43：守卫和访客视图共用同一个 farmGuard()；不再写死 0。
      guard: farmGuard().guard,
      worker: workerOf(),
      hire: view.hire,
      log: view.log.slice(0, FARM_LOG_VIEW_LIMIT)
    }
  }

  /**
   * 守卫的唯一计算点（ticket 43/44）：主人在家 = 既没有出门串门，也没有在外打工。
   * 雇工镜像存在 = 有人在我家打工。`/state.farm.guard`、访客快照的 `guardParts`、
   * 桌面摘要全部从这里出，绝不三个地方各写一遍 0.3。
   */
  function farmGuard () {
    const out = room.outboundVisit()
    const work = room.outboundWork()
    const worker = room.inboundWorker()
    const ownerHome = out === null && work === null
    const hasWorker = worker !== null
    return {
      guard: guardValue({ ownerHome, worker: hasWorker }),
      ownerHome,
      worker: hasWorker,
      working: work !== null
    }
  }

  /**
   * `/state.farm.worker`：只给昵称/合同号/结束时间/守卫，**不给 deviceId**（少一个泄露面）。
   * 雇工离线时 room.tick 会清镜像，这里自然回到 null。
   */
  function workerOf () {
    const worker = room.inboundWorker()
    if (worker === null) return null
    return {
      nickname: worker.workerNickname,
      contractId: worker.contractId,
      endsAt: worker.endsAt,
      guard: WORKER_GUARD
    }
  }

  /** `/state.contracts` 与窗口共用的公开视图；store 没起来时是完整空形状。 */
  function contractsView () {
    const now = contractClock()
    if (contracts === null) return { outgoing: [], incoming: [] }
    try {
      return contracts.windowView(now)
    } catch {
      return { outgoing: [], incoming: [] }
    }
  }

  /**
   * 雇工页（ticket 44）的数据全部由宿主 push：自己的合同 + 邻居挂牌 + 在飞状态。
   * 窗口是 file:// 页面，读不到 `/state`，所以这些必须随 `farm-window` 一起下发。
   */
  function contractWindowView () {
    const now = contractClock()
    const view = contractsView()
    const listings = []
    for (const [deviceId, digest] of peerDigests) {
      const hire = digest?.hire
      if (hire === null || typeof hire !== 'object') continue
      const at = Number(digest.at)
      const fresh = Number.isFinite(at) && now - at <= 120 * 1000
      const active = digest.nickname !== null && digest.nickname !== undefined
        ? digest.nickname
        : neighborNickname(deviceId)
      listings.push({
        deviceId,
        nickname: active ?? '邻居',
        enabled: hire.enabled === true,
        available: hire.available === true && fresh,
        reason: hire.reason ?? null,
        wagePerHour: hire.wagePerHour,
        minHours: hire.minHours,
        maxHours: hire.maxHours,
        guard: hire.guard,
        feeRate: WORK_FEE_RATE,
        stale: !fresh,
        at: Number.isFinite(at) ? at : 0
      })
    }
    return {
      outgoing: view.outgoing,
      incoming: view.incoming,
      listings,
      pendingHire: pendingHire !== null,
      now,
      feeRate: WORK_FEE_RATE
    }
  }

  /**
   * `/state` 的交易所出口（SPEC v5「状态出口与动作」）：
   * `{ prices, index, history }`，history 最近 50 笔、最新在前。
   * `prices` 保持 market.json 的形状；`bid` 只给小窗，不混进状态出口。
   */
  function marketStateView () {
    if (market === null) return marketView(initialMarketView(), { historyLimit: MARKET_VIEW_HISTORY })
    return market.snapshot({ historyLimit: MARKET_VIEW_HISTORY })
  }

  /**
   * 交易所页的视图：多一个算好的 `bid`（已混入新鲜局域网指数），
   * index 条目多一个 `stale`，窗口据此把过期行情画灰。
   */
  function marketWindowView () {
    if (market === null) {
      return marketView(initialMarketView(), {
        historyLimit: MARKET_VIEW_HISTORY,
        withBid: true,
        now: marketClock()
      })
    }
    return market.snapshot({ historyLimit: MARKET_VIEW_HISTORY, withBid: true })
  }

  /**
   * 农场小窗的完整视图（ticket 40）。
   *
   * 和 `/state.farm` 是两个形状，别混：
   *   - 这里每块地多 `stage / mature / remainingMs / waterings / fertilized`，
   *     阶段与倒计时用 39 的纯规则（`plotStage` / `plotRemainingMs`）在**下发那一刻**算；
   *   - `seeds/crops` 补全三种作物（0 也要有键），窗口不用猜缺键；
   *   - `log` 只给最近 20 条：窗口记录页在 41 之后才接，先给能显示的一份。
   *
   * 交易所（41）是 `farm-window` 命令里与 `farm` 并列的另一份视图（见 `handleFarmOpen`），
   * 不塞进农场视图，更不塞进场景。
   *
   * 窗口是 file:// 页面，没有 Node、没有网络、读不到 `/state`，所以这份必须随
   * `farm-window` 命令一起下发；**绝不**把它塞进场景（controls 每帧比较，日志/仓库会污染签名）。
   */
  function farmWindowView () {
    const view = farm?.snapshot() ?? initialFarmView()
    const stacks = (source) => Object.fromEntries(
      Object.keys(CROPS).map((cropId) => [cropId, source[cropId] ?? 0])
    )
    return {
      plots: view.plots.map((plot) => ({
        id: plot.id,
        crop: plot.crop,
        stage: plotStage(plot),
        mature: isMature(plot),
        remainingMs: plotRemainingMs(plot),
        waterings: Number(plot.waterings) >= 1 ? 1 : 0,
        fertilized: plot.fertilized === true
      })),
      seeds: stacks(view.seeds),
      crops: stacks(view.crops),
      coins: view.coins,
      dew: view.dew,
      // ticket 44：雇工与挂牌都是真实值；contractCount 只用于窗口画「有几份合同」。
      worker: workerOf(),
      contractCount: contracts === null
        ? 0
        : Math.min(MAX_CONTRACTS_PER_SIDE, contracts.outgoing().length + contracts.incoming().length),
      hire: { ...view.hire },
      guard: farmGuard().guard,
      // 记录页要完整的一份（≤50）；`/state.farm.log` 仍按 SPEC 只给 20。
      log: view.log.slice(0, MAX_FARM_LOG),
      // 驮包只显示「在路上的东西」，不参与仓库/硬币记账（SPEC v5 :107,:142）。
      carried: carriedView()
    }
  }

  /**
   * 菜单「农场」/ 桌面地块的申请：打开或聚焦小窗。没有桌面层就回 `desktop-off`。
   *
   * ticket 43：正在串门时同一扇窗进入**访客模式**——先立刻推 owner 数据 + `visit.loading`，
   * 再去拉主人的快照（不阻塞开窗）；拉回来推 `ready`，404 推 `ended`。
   */
  function handleFarmOpen (rawPlotId) {
    if (desktop === null || typeof desktop.farmWindow !== 'function') {
      return { ok: false, error: 'desktop-off', notice: farmErrorText('desktop-off') }
    }
    const plotId = typeof rawPlotId === 'string' ? rawPlotId : null
    const out = room.outboundVisit()
    const visit = out === null ? null : loadingVisitView(out)
    if (out === null) {
      farmWindowVisitId = null
      farmWindowVisitView = null
    } else {
      farmWindowVisitId = out.visitId
      farmWindowVisitView = visit
    }
    const opened = desktop.farmWindow(farmWindowPayload({
      open: true,
      plotId,
      mode: out === null ? 'owner' : 'visitor',
      visit
    }))
    if (opened !== true) {
      return { ok: false, error: 'desktop-off', notice: farmErrorText('desktop-off') }
    }
    farmWindowOpened = true
    if (out !== null) void loadVisitFarm(out)
    return { ok: true, action: 'farm-open', window: 'opened', mode: out === null ? 'owner' : 'visitor' }
  }

  /** `farm-window` 命令的公共载荷：owner 数据 + 交易所 + 可选访客块。 */
  function farmWindowPayload ({ open, plotId = null, mode = null, visit = null } = {}) {
    const out = room.outboundVisit()
    const effectiveMode = mode ?? (out === null ? 'owner' : 'visitor')
    const effectiveVisit = visit ?? (out !== null && farmWindowVisitId === out.visitId
      ? farmWindowVisitView
      : null)
    return {
      open: open === true,
      mode: effectiveMode,
      farm: farmWindowView(),
      // 交易所与农场并列：`/state` 里也是两个兄弟字段，别把 market 塞进 controls.farm。
      market: marketWindowView(),
      // ticket 44：雇工页的数据也由宿主 push（窗口读不到 /state）。
      contracts: contractWindowView(),
      ...(effectiveVisit === null ? {} : { visit: effectiveVisit }),
      ...(plotId === null ? {} : { plotId })
    }
  }

  /**
   * 成交/动作后刷新已经开着的窗口（`open:false` 不会新开窗）。
   * 正在串门时保留访客块，别把窗口打回主人模式。
   */
  function refreshFarmWindow () {
    if (farmWindowOpened !== true) return
    if (desktop === null || typeof desktop.farmWindow !== 'function') return
    try {
      desktop.farmWindow(farmWindowPayload({ open: false }))
    } catch {
      // 刷新失败只影响这一帧；下一次开窗/动作会再推一份。
    }
  }


  // -------------------------------------------------------------------------
  // 雇佣合同（ticket 44）：挂牌 → 雇佣 → 打工 → 结束 → 结算
  // -------------------------------------------------------------------------

  /** 合同相关的错误：统一形状，桌面气泡经 farmErrorText 变人话。 */
  function workFailure (error) {
    return { ok: false, error }
  }

  function contractFound (id) {
    if (contracts === null) return null
    try {
      return contracts.byId(id)
    } catch {
      return null
    }
  }

  function contractByRequest (requestId) {
    if (contracts === null) return null
    try {
      return contracts.byRequestId(requestId)
    } catch {
      return null
    }
  }

  /** 把 `endReason` 映射成协议里允许的结算 reason。 */
  function settleReasonOf (endReason) {
    if (endReason === 'recall') return 'recall'
    if (endReason === 'employer-end') return 'employer-end'
    if (endReason === 'offline') return 'offline'
    if (endReason === 'expired') return 'expired'
    return 'completed'
  }

  /**
   * 结算数学（§8.3）：合同时长只取 ack 里的差值；服务时长只取**雇主本地**
   * ackedAt → endedAt。到期按整段算（时钟差在这里没有意义）。
   */
  function settleNumbers (record) {
    const contractMs = contractMsOf(record.startedAt, record.endsAt)
    if (contractMs <= 0) return { contractMs: 0, servedMs: 0, earned: 0, reason: 'completed' }
    const full = record.endReason === 'expired' || record.endReason === 'completed'
    const anchor = record.ackedAt ?? record.startedAt
    const endedAt = record.endedAt ?? contractClock()
    const servedMs = full ? contractMs : servedMsOf(anchor, endedAt, contractMs)
    return {
      contractMs,
      servedMs,
      earned: earnedFor(record.wage, servedMs, contractMs),
      reason: settleReasonOf(record.endReason)
    }
  }

  function contractRetryDelay (id) {
    const attempts = contractAttempts.get(id) ?? 0
    contractAttempts.set(id, attempts + 1)
    return Math.min(contractRetryMaxMs, contractRetryMs * 2 ** attempts)
  }

  function sendWorkEndPacket (deviceId, { contractId, requestId, reason }) {
    if (discovery === null || identity === null) return false
    try {
      const data = encodeWorkEnd({
        deviceId: identity.deviceId,
        contractId: contractId ?? undefined,
        requestId: contractId === undefined || contractId === null ? requestId : undefined,
        reason
      })
      return discovery.sendTo(deviceId, data)
    } catch {
      return false
    }
  }

  function sendWorkEndAckPacket (deviceId, { contractId, requestId, ok, error }) {
    if (discovery === null || identity === null) return false
    try {
      const data = encodeWorkEndAck({
        deviceId: identity.deviceId,
        contractId,
        requestId,
        ok,
        error
      })
      return discovery.sendTo(deviceId, data)
    } catch {
      return false
    }
  }

  /** 缓存一条 ack 字节（请求/结算都按 deviceId+requestId 原样重放）。 */
  function cacheWorkResult (deviceId, requestId, data) {
    rememberBounded(workResults, deviceId + ':' + requestId,
      { data, at: contractClock() }, MAX_WORK_RESULTS)
    // 10 分钟前的 ack 不再重放：合同最多 8 小时，但重试风暴只会发生在几分钟内。
    const cutoff = contractClock() - 10 * 60 * 1000
    for (const [candidate, entry] of workResults) {
      if (entry.at < cutoff) workResults.delete(candidate)
    }
  }

  function replayedWorkResult (deviceId, requestId) {
    const entry = workResults.get(deviceId + ':' + requestId)
    if (entry === undefined) return null
    if (contractClock() - entry.at > 10 * 60 * 1000) {
      workResults.delete(deviceId + ':' + requestId)
      return null
    }
    return entry.data
  }

  function sendWorkAckPacket (deviceId, requestId, payload) {
    if (discovery === null || identity === null) return false
    let data
    try {
      data = encodeWorkAck({
        deviceId: identity.deviceId,
        requestId,
        ok: payload.ok,
        contractId: payload.contractId,
        startedAt: payload.startedAt,
        endsAt: payload.endsAt,
        guard: payload.guard,
        error: payload.error
      })
    } catch (error) {
      warn(ctx, '雇佣回执编码失败：' + message(error))
      return false
    }
    cacheWorkResult(deviceId, requestId, data)
    return discovery.sendTo(deviceId, data)
  }

  function sendWorkSettleAckPacket (deviceId, { contractId, requestId, ok, earned, error }) {
    if (discovery === null || identity === null) return false
    try {
      const data = encodeWorkSettleAck({
        deviceId: identity.deviceId,
        contractId,
        requestId,
        ok,
        earned,
        error
      })
      cacheWorkResult(deviceId, requestId, data)
      return discovery.sendTo(deviceId, data)
    } catch {
      return false
    }
  }

  /** 把合同镜像/窗口/挂牌一起刷新：合同状态变化会影响 available/reason。 */
  function refreshContractViews () {
    refreshFarmWindow()
    syncDesktop()
  }

  /** 一条心跳/合同报文同时是「对方还在」的证据（离线结算按它算最后心跳）。 */
  function noteContractSeen (deviceId, at = contractClock()) {
    if (contracts === null) return
    for (const record of contracts.activeOutgoing()) {
      if (record.workerDeviceId === deviceId) {
        contracts.noteSeen(record.id, at).catch(() => {})
      }
    }
    for (const record of contracts.activeIncoming()) {
      if (record.employerDeviceId === deviceId) {
        contracts.noteSeen(record.id, at).catch(() => {})
      }
    }
  }

  // -------------------------------------------------------------------------
  // 主动作：hire / recall-worker / end-contract / hire-listing
  // -------------------------------------------------------------------------

  /** 邻居挂牌（ticket 44 D1）：只读 digest，不逐个问邻居。 */
  function neighborListing (deviceId, hours) {
    const digest = peerDigests.get(deviceId)
    if (digest === undefined) return null
    const hire = digest.hire
    if (hire === null || typeof hire !== 'object') return null
    const now = contractClock()
    const at = Number(digest.at)
    if (!Number.isFinite(at) || now - at > 2 * 60 * 1000) return null
    if (hire.enabled !== true || hire.available !== true) return null
    if (!Number.isInteger(hours) || hours < hire.minHours || hours > hire.maxHours) return null
    return hire
  }

  /**
   * 点「雇佣」：先落 pending 合同、再扣 `wage + fee`，然后发 work-request。
   * 任何一步失败都回滚；`work-ack` 成功才算 active（钱已经在本地扣掉了）。
   */
  async function hireNeighbor (rawDeviceId, rawHours) {
    if (disposed) return workFailure('disposed')
    if (contracts === null || farm === null) return workFailure('starting')
    const deviceId = actionDeviceId(rawDeviceId)
    if (deviceId === null) return workFailure('bad-device-id')
    const hours = normalizeHours(rawHours)
    if (hours === null) return workFailure('bad-hours')
    const selfId = identity?.deviceId ?? null
    if (selfId !== null && deviceId === selfId) return workFailure('own-pet')
    if (!room.mayTalkTo(deviceId)) return workFailure('worker-unavailable')
    const neighbor = room.snapshot().neighbors.find((candidate) => candidate.deviceId === deviceId)
    if (neighbor === undefined || !(neighbor.heartbeatAt > 0)) return workFailure('worker-unavailable')
    if (contractClock() - neighbor.heartbeatAt > peerLostMs) return workFailure('worker-unavailable')
    if (room.inboundWorker() !== null) return workFailure('already-hired')
    if (contracts.activeOutgoing().length > 0) return workFailure('already-hired')
    if (pendingHire !== null) return workFailure('busy')
    const listing = neighborListing(deviceId, hours)
    if (listing === null) return workFailure('worker-unavailable')

    const wage = listing.wagePerHour * hours
    const fee = feeFor(wage)
    const total = wage + fee
    if ((farm.snapshot().coins ?? 0) < total) return workFailure('no-coin')

    const requestId = randomUUID()
    const created = await contracts.beginOutgoing({
      requestId,
      workerDeviceId: deviceId,
      workerNickname: neighbor.nickname,
      hours,
      wagePerHour: listing.wagePerHour
    })
    if (created === null) return workFailure('busy')

    const spent = await farm.spendCoins(total)
    if (spent.ok !== true) {
      await contracts.cancelOutgoing(requestId, 'cancelled')
      return workFailure(spent.error === 'no-coin' ? 'no-coin' : 'busy')
    }
    await contracts.markCharged(requestId)
    // 雇佣也是一次农场动作：重置待机计时（SPEC v5「待机、露水与离线生长」）。
    await farm.touch()

    pendingHire = requestId
    refreshContractViews()
    const encoded = (() => {
      try {
        return encodeWorkRequest({
          deviceId: identity.deviceId,
          requestId,
          hours,
          wagePerHour: listing.wagePerHour,
          fee
        })
      } catch (error) {
        warn(ctx, '雇佣请求编码失败：' + message(error))
        return null
      }
    })()
    if (encoded === null) {
      await failWorkRequest(requestId, 'busy')
      return workFailure('busy')
    }

    const outcome = await startWorkRequest({ requestId, deviceId, data: encoded })
    refreshContractViews()
    sendMarketDigest()
    return outcome
  }

  /** 发一次请求、按间隔重发；ack 由 handleWorkAck 兑现，超时就退款取消。 */
  function startWorkRequest ({ requestId, deviceId, data }) {
    return new Promise((resolve) => {
      const entry = {
        requestId,
        deviceId,
        data,
        attempts: 0,
        deadline: contractClock() + workTimeoutMs,
        timer: null,
        done: false,
        resolve
      }
      const send = () => {
        if (entry.done) return
        entry.attempts += 1
        try {
          discovery?.sendTo(deviceId, data)
        } catch {
          // 一包发不出去就等下一拍；最后统一超时退款。
        }
        if (contractClock() >= entry.deadline || entry.attempts >= workAttempts) {
          void failWorkRequest(requestId, 'timeout')
          return
        }
        // 不 unref：一笔雇佣最多等 1.8 秒，但等待期间的计时器必须把事件循环留住，
        // 否则 Node 会在 ack 到达前退出（测试里表现为 Promise still pending）。
        entry.timer = setTimeout(send, workRetryMs)
      }
      workRequests.set(requestId, entry)
      send()
    })
  }

  /**
   * 一笔在飞雇佣失败：退款一次、取消 pending、告诉对端别等了，然后回结果。
   * 所有入口（ack 失败/超时/房间拒绝）都走这里，保证钱只退一次。
   */
  async function failWorkRequest (requestId, error) {
    const entry = workRequests.get(requestId)
    if (entry === undefined) return
    workRequests.delete(requestId)
    if (entry.timer !== null) clearTimeout(entry.timer)
    if (!entry.done) {
      entry.done = true
      const found = contractByRequest(requestId)
      if (found !== null && found.side === 'outgoing') {
        const record = found.record
        if (record.charged && !record.refunded) {
          // 还没 ack 的雇佣等于没发生：工资和手续费一起退（手续费只在成交后烧）。
          await refundOutgoingOnce(record, record.wage + record.fee)
        }
        await contracts.cancelOutgoing(requestId, 'cancelled')
        sendWorkEndPacket(record.workerDeviceId, { requestId, reason: 'cancelled' })
      }
      if (pendingHire === requestId) pendingHire = null
      entry.resolve(workFailure(error))
      refreshContractViews()
      sendMarketDigest()
    }
  }

  /** 退款一次（WAL：先写 refunding，再入账，再写 refunded；重复调用返回 0）。 */
  async function refundOutgoingOnce (record, amount) {
    if (contracts === null || farm === null) return 0
    if (refundInFlight.has(record.id)) return 0
    refundInFlight.add(record.id)
    try {
      const fresh = contractFound(record.id)
      if (fresh === null || fresh.side !== 'outgoing') return 0
      if (fresh.record.refunded) return 0
      if (fresh.record.refundStartedAt !== null) {
        // 上一次已经写过 refunding 就崩了：钱可能已经到账，fail-closed 不再退。
        await contracts.markRefunded(fresh.record.id, {
          amount: fresh.record.refundAmount,
          at: contractClock()
        })
        return 0
      }
      const cap = fresh.record.wage + fresh.record.fee
      const value = Math.min(cap, Math.max(0, Math.floor(Number(amount) || 0)))
      await contracts.markRefundStarted(fresh.record.id, value)
      const added = await farm.addCoins(value)
      if (added.ok !== true) {
        warnOnce('refund:' + record.id,
          '合同退款没入账（' + (added.error ?? 'unknown') + '），等下一次重试')
        return 0
      }
      await contracts.markRefunded(fresh.record.id, { amount: value, at: contractClock() })
      if (value > 0) room.noteFarmEvent('合同结束，退回 ' + value + ' 硬币。')
      return value
    } finally {
      refundInFlight.delete(record.id)
    }
  }

  /** 改挂牌：显式校验，不静默夹取；保存后立刻广播一轮 digest。 */
  async function setHireListing (body) {
    if (farm === null) return workFailure('starting')
    if (typeof body?.enabled !== 'boolean') return workFailure('bad-enabled')
    // 范围只有一份真相（contracts-rules）；但挂牌仍显式拒绝小数/越界，不静默夹取。
    const wagePerHour = Number(body?.wagePerHour)
    if (!Number.isInteger(wagePerHour) ||
      wagePerHour < MIN_CONTRACT_WAGE || wagePerHour > MAX_CONTRACT_WAGE) {
      return workFailure('bad-wage')
    }
    const minHours = Number(body?.minHours)
    const maxHours = Number(body?.maxHours)
    if (!Number.isInteger(minHours) || !Number.isInteger(maxHours) ||
      minHours < MIN_CONTRACT_HOURS || maxHours > MAX_CONTRACT_HOURS || minHours > maxHours) {
      return workFailure('bad-hours')
    }
    const result = await farm.setHire({ enabled: body.enabled, wagePerHour, minHours, maxHours })
    if (result?.ok !== true) return workFailure(result?.error === 'bad-wage' ? 'bad-wage' : 'bad-hours')
    refreshFarmWindow()
    sendMarketDigest({ force: true })
    return { ok: true, action: 'hire-listing', hire: result.hire }
  }

  /** 主人召回自己的雇工（我是雇工侧）。 */
  async function recallWorker (rawContractId) {
    if (contracts === null) return workFailure('starting')
    const contractId = actionDeviceId(rawContractId)
    if (contractId === null) return workFailure('bad-device-id')
    const found = contractFound(contractId)
    if (found === null || found.side !== 'incoming') return workFailure('contract-not-found')
    const record = found.record
    if (record.status === 'ended') {
      refreshContractViews()
      return { ok: true, action: 'recall-worker', contractId, alreadyEnded: true }
    }
    if (record.status !== 'active') return workFailure('contract-ended')
    await contracts.setRecallRequested(record.id, contractClock())
    if (farm !== null) await farm.touch()
    sendRecall(record)
    room.noteFarmEvent('已经通知雇主召回，等对方确认。')
    refreshContractViews()
    return { ok: true, action: 'recall-worker', contractId }
  }

  function sendRecall (record) {
    if (discovery === null || identity === null) return false
    try {
      const data = encodeWorkRecall({ deviceId: identity.deviceId, contractId: record.id })
      return discovery.sendTo(record.employerDeviceId, data)
    } catch {
      return false
    }
  }

  /** 雇主提前结束（我是雇主侧）：立即结束并启动结算。 */
  async function endContract (rawContractId) {
    if (contracts === null) return workFailure('starting')
    const contractId = actionDeviceId(rawContractId)
    if (contractId === null) return workFailure('bad-device-id')
    const found = contractFound(contractId)
    if (found === null || found.side !== 'outgoing') return workFailure('contract-not-found')
    const record = found.record
    if (record.status === 'active') {
      await endOutgoingContract(record, 'employer-end', contractClock())
      sendWorkEndPacket(record.workerDeviceId, { contractId: record.id, reason: 'employer-end' })
    } else if (record.status === 'pending') {
      await failWorkRequest(record.requestId, 'contract-ended')
      return { ok: true, action: 'end-contract', contractId, cancelled: true }
    }
    if (farm !== null) await farm.touch()
    refreshContractViews()
    return { ok: true, action: 'end-contract', contractId }
  }

  // -------------------------------------------------------------------------
  // 对方发来的八个 work-* 分支
  // -------------------------------------------------------------------------

  /** 收到 work-request（我是被雇的一方）。先幂等、后校验、落盘之后才 ack。 */
  async function handleWorkRequest (packet) {
    if (disposed || contracts === null || farm === null) return
    if (identity === null || packet.deviceId === identity.deviceId) return
    if (!room.mayTalkTo(packet.deviceId)) return
    noteContractSeen(packet.deviceId)
    const requestId = packet.requestId
    const replayed = replayedWorkResult(packet.deviceId, requestId)
    if (replayed !== null) {
      try {
        discovery?.sendTo(packet.deviceId, replayed)
      } catch {
        // 重放失败也没关系：对方会再重试。
      }
      return
    }
    const key = packet.deviceId + ':' + requestId
    if (workInFlight.has(key)) return
    workInFlight.add(key)
    try {
      const rejection = validateIncomingWork(packet)
      if (rejection !== null) {
        sendWorkAckPacket(packet.deviceId, requestId, { ok: false, error: rejection })
        return
      }
      const now = contractClock()
      const hours = packet.hours
      const wage = packet.wagePerHour * hours
      const contractId = randomUUID()
      const startedAt = now
      const endsAt = now + hours * 60 * 60 * 1000
      const employerNickname = room.peerNickname(packet.deviceId) ?? '邻居'
      const record = await contracts.beginIncoming({
        contractId,
        requestId,
        employerDeviceId: packet.deviceId,
        employerNickname,
        hours,
        wagePerHour: packet.wagePerHour,
        startedAt,
        endsAt,
        guard: WORKER_GUARD
      })
      if (record === null) {
        sendWorkAckPacket(packet.deviceId, requestId, { ok: false, error: 'worker-unavailable' })
        return
      }
      const begun = room.beginWorking({
        contractId,
        employerDeviceId: packet.deviceId,
        employerNickname,
        startedAt,
        endsAt,
        guard: WORKER_GUARD,
        lastSeen: now
      })
      if (begun.ok !== true) {
        await contracts.end(contractId, { endedAt: now, reason: 'cancelled' })
        sendWorkAckPacket(packet.deviceId, requestId, { ok: false, error: begun.error ?? 'already-working' })
        return
      }
      sendWorkAckPacket(packet.deviceId, requestId, {
        ok: true,
        contractId,
        startedAt,
        endsAt,
        guard: WORKER_GUARD
      })
      if (farm !== null) {
        await farm.noteHire({ who: employerNickname, hours, wage })
      }
      room.noteFarmEvent('「' + employerNickname + '」雇了你 ' + hours + ' 小时，去打工啦。')
      refreshContractViews()
      sendMarketDigest({ force: true })
    } finally {
      workInFlight.delete(key)
    }
  }

  /**
   * work-request 的业务校验（协议层已经验过形状/范围）。返回错误码或 null。
   * 顺序有讲究：先看「我在不在家/在不在打工」，再看挂牌，最后核钱。
   */
  function validateIncomingWork (packet) {
    if (room.outboundVisit() !== null) return 'worker-unavailable'
    if (room.outboundWork() !== null) return 'already-working'
    if (contracts.activeIncoming().length > 0) return 'already-working'
    const view = farm?.snapshot() ?? initialFarmView()
    const hire = view.hire
    if (hire.enabled !== true) return 'worker-unavailable'
    if (packet.hours < hire.minHours || packet.hours > hire.maxHours) return 'bad-hours'
    if (packet.wagePerHour < hire.wagePerHour) return 'bad-wage'
    const wage = packet.wagePerHour * packet.hours
    if (feeFor(wage) !== packet.fee) return 'bad-wage'
    return null
  }

  /** 收到 work-ack（我是雇主）：确认合同 + 雇工进镜像，或者退款取消。 */
  async function handleWorkAck (packet) {
    const entry = workRequests.get(packet.requestId)
    if (entry === undefined) {
      // 迟到/重复的 ack：合同还活着就什么都不做；完全找不到才补一条 work-end 收尾。
      const existing = contractByRequest(packet.requestId)
      if (existing === null && packet.ok === true) {
        sendWorkEndPacket(packet.deviceId, { contractId: packet.contractId, reason: 'cancelled' })
      }
      return
    }
    if (entry.deviceId !== packet.deviceId) return
    if (packet.ok !== true) {
      await failWorkRequest(packet.requestId, packet.error)
      return
    }
    workRequests.delete(packet.requestId)
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.done = true
    const now = contractClock()
    const confirmed = await contracts.confirmOutgoing(packet.requestId, {
      contractId: packet.contractId,
      startedAt: packet.startedAt,
      endsAt: packet.endsAt,
      guard: packet.guard,
      ackedAt: now
    })
    if (confirmed !== true) {
      // 超时已经退款取消：这条 ack 来晚了，让对端立刻结束那份合同。
      sendWorkEndPacket(packet.deviceId, { contractId: packet.contractId, reason: 'cancelled' })
      entry.resolve(workFailure('timeout'))
      return
    }
    const workerNickname = room.peerNickname(packet.deviceId) ?? '邻居'
    const begun = room.beginWorker({
      contractId: packet.contractId,
      workerDeviceId: packet.deviceId,
      workerNickname,
      startedAt: packet.startedAt,
      endsAt: packet.endsAt,
      guard: packet.guard,
      lastSeen: now
    })
    if (begun.ok !== true) {
      // 本地已经有雇工（例如两笔并发 ack）：结束这份新合同并全额退款。
      const fresh = contractFound(packet.contractId)
      if (fresh !== null && fresh.side === 'outgoing') {
        await endOutgoingContract(fresh.record, 'cancelled', now)
        await refundOutgoingOnce(fresh.record, fresh.record.wage + fresh.record.fee)
      }
      sendWorkEndPacket(packet.deviceId, { contractId: packet.contractId, reason: 'cancelled' })
      entry.resolve(workFailure(begun.error ?? 'already-hired'))
      return
    }
    if (pendingHire === packet.requestId) pendingHire = null
    entry.resolve({ ok: true, action: 'hire', contractId: packet.contractId })
    if (farm !== null) {
      const hired = contractFound(packet.contractId)?.record ?? null
      await farm.noteHire({
        who: workerNickname,
        hours: hired?.hours,
        wage: hired?.wage
      })
    }
    room.noteFarmEvent('「' + workerNickname + '」来打工了。')
    refreshContractViews()
    sendMarketDigest({ force: true })
  }

  /** 收到 work-recall（我是雇主）：结束合同、启动结算、回一条 recall-ack。 */
  async function handleWorkRecall (packet) {
    if (contracts === null) return
    const found = contractFound(packet.contractId)
    if (found === null || found.side !== 'outgoing') {
      sendRecallAck(packet.deviceId, packet.contractId, false, 'contract-not-found')
      return
    }
    const record = found.record
    if (record.status === 'active') {
      await endOutgoingContract(record, 'recall', contractClock())
    }
    await contracts.markRecallAcked(record.id)
    sendRecallAck(packet.deviceId, record.id, true, null)
    refreshContractViews()
  }

  function sendRecallAck (deviceId, contractId, ok, error) {
    if (discovery === null || identity === null) return false
    try {
      const data = encodeWorkRecallAck({
        deviceId: identity.deviceId,
        contractId,
        ok,
        error: ok === true ? undefined : error
      })
      return discovery.sendTo(deviceId, data)
    } catch {
      return false
    }
  }

  /** 收到 work-recall-ack（我是雇工侧）：对方已结束，本地镜像也该回家。 */
  async function handleWorkRecallAck (packet) {
    if (contracts === null) return
    const found = contractFound(packet.contractId)
    if (found === null || found.side !== 'incoming') return
    const record = found.record
    await contracts.markRecallAcked(record.id)
    contractRetryAt.delete('recall:' + record.id)
    if (packet.ok === true && record.status === 'active') {
      await endIncomingContract(record, 'recall', contractClock())
    }
    refreshContractViews()
  }

  /** 收到 work-end（我是雇工侧）：幂等结束；找不到也回 ok，避免重试风暴。 */
  async function handleWorkEnd (packet) {
    if (contracts === null) return
    const found = packet.contractId !== undefined
      ? contractFound(packet.contractId)
      : contractByRequest(packet.requestId)
    if (found === null) {
      sendWorkEndAckPacket(packet.deviceId, {
        contractId: packet.contractId,
        requestId: packet.requestId,
        ok: true
      })
      return
    }
    const record = found.record
    if (found.side === 'incoming' && record.status === 'active') {
      await endIncomingContract(record, packet.reason === 'cancelled' ? 'cancelled' : packet.reason, contractClock())
    }
    if (found.side === 'outgoing' && record.status === 'active') {
      await endOutgoingContract(record, packet.reason, contractClock())
    }
    sendWorkEndAckPacket(packet.deviceId, {
      contractId: record.id,
      requestId: record.requestId,
      ok: true
    })
    refreshContractViews()
  }

  /** 收到 work-end-ack（我是发起方）：只清重试标记。 */
  function handleWorkEndAck (packet) {
    if (packet.contractId !== undefined) contractRetryAt.delete('end:' + packet.contractId)
    else if (packet.requestId !== undefined) contractRetryAt.delete('end:' + packet.requestId)
  }

  /**
   * 收到 work-settle（我是雇工侧）：用**自己算的** earned 入账一次，回 ack。
   * 已结算/崩溃窗口（settleStartedAt 存在）都按「已经入过账」处理（fail-closed）。
   */
  async function handleWorkSettle (packet) {
    if (contracts === null || farm === null) return
    const found = contractFound(packet.contractId)
    if (found === null || found.side !== 'incoming') {
      sendWorkSettleAckPacket(packet.deviceId, {
        contractId: packet.contractId,
        requestId: packet.requestId,
        ok: false,
        error: 'contract-not-found'
      })
      return
    }
    const record = found.record
    noteContractSeen(record.employerDeviceId)
    if (record.settledAt !== null) {
      sendWorkSettleAckPacket(packet.deviceId, {
        contractId: record.id,
        requestId: packet.requestId,
        ok: true,
        earned: record.earned
      })
      return
    }
    const key = record.id
    if (settleInFlight.has(key)) return
    settleInFlight.add(key)
    try {
      const contractMs = contractMsOf(record.startedAt, record.endsAt)
      if (contractMs <= 0) {
        sendWorkSettleAckPacket(packet.deviceId, {
          contractId: record.id,
          requestId: packet.requestId,
          ok: false,
          error: 'contract-ended'
        })
        return
      }
      const servedMs = servedMsOf(0, Math.min(contractMs, Math.max(0, packet.servedMs)), contractMs)
      const earned = earnedFor(record.wage, servedMs, contractMs)
      if (record.settleStartedAt !== null) {
        // 上次写完 settling 意图就崩了：按已入账处理，绝不重复铸币。
        await contracts.finishSettle(record.id, {
          earned: record.earned,
          servedMs: record.settleServedMs,
          settledAt: contractClock(),
          reason: settleReasonOf(record.endReason)
        })
      } else {
        await contracts.beginSettle(record.id, {
          requestId: packet.requestId,
          servedMs,
          earned,
          reason: settleReasonOf(record.endReason)
        })
        const credited = await farm.addCoins(earned)
        if (credited.ok !== true) {
          warnOnce('settle:' + record.id,
            '结算入账失败（' + (credited.error ?? 'unknown') + '），保持 settling 等重试')
          sendWorkSettleAckPacket(packet.deviceId, {
            contractId: record.id,
            requestId: packet.requestId,
            ok: false,
            error: 'contract-busy'
          })
          return
        }
        await contracts.finishSettle(record.id, {
          earned,
          servedMs,
          settledAt: contractClock(),
          reason: settleReasonOf(record.endReason)
        })
      }
      const settled = contractFound(record.id)?.record ?? record
      if (room.outboundWork() !== null && room.outboundWork().contractId === record.id) {
        room.endWorking(record.id, { at: contractClock(), reason: 'completed' })
      }
      if (farm !== null) {
        await farm.noteSettle({
          who: record.employerNickname,
          wage: record.wage,
          earned: settled.earned
        })
      }
      room.noteFarmEvent('结算完成：拿到 ' + settled.earned + ' 硬币。')
      sendWorkSettleAckPacket(packet.deviceId, {
        contractId: record.id,
        requestId: packet.requestId,
        ok: true,
        earned: settled.earned
      })
      refreshContractViews()
      sendMarketDigest({ force: true })
    } finally {
      settleInFlight.delete(key)
    }
  }

  /** 收到 work-settle-ack（我是雇主）：按雇工主人算出的 earned 退款一次。 */
  async function handleWorkSettleAck (packet) {
    if (contracts === null || farm === null) return
    const found = contractFound(packet.contractId)
    if (found === null || found.side !== 'outgoing') return
    const record = found.record
    if (record.settleRequestId !== null && record.settleRequestId !== packet.requestId) return
    if (packet.ok !== true) {
      contractRetryAt.delete(record.id)
      return
    }
    if (record.settledAt !== null) {
      contractRetryAt.delete(record.id)
      return
    }
    const earned = Math.min(record.wage, Math.max(0, Math.floor(Number(packet.earned) || 0)))
    if (record.refunded) {
      // 退款已经写进 WAL（崩溃在写 settledAt 之前）：只补 settled 标记，不再退款。
      await contracts.finishSettle(record.id, {
        earned,
        servedMs: record.settleServedMs,
        settledAt: contractClock(),
        reason: settleReasonOf(record.endReason)
      })
      contractRetryAt.delete(record.id)
      refreshContractViews()
      return
    }
    await refundOutgoingOnce(record, refundFor(record.wage, earned))
    await contracts.finishSettle(record.id, {
      earned,
      servedMs: record.settleServedMs,
      settledAt: contractClock(),
      reason: settleReasonOf(record.endReason)
    })
    if (farm !== null) {
      await farm.noteSettle({ who: record.workerNickname, wage: record.wage, earned })
    }
    contractRetryAt.delete(record.id)
    refreshContractViews()
    sendMarketDigest({ force: true })
  }

  // -------------------------------------------------------------------------
  // 合同的结束/结算/巡检/重启对账
  // -------------------------------------------------------------------------

  async function endOutgoingContract (record, reason, endedAt) {
    if (contracts === null) return
    const id = record.id
    const ended = await contracts.end(id, { endedAt, reason })
    if (ended) {
      room.endWorker(id, { at: endedAt, reason })
      contractRetryAt.delete(id)
      refreshContractViews()
      // 挂牌的 available/reason 变了：不等 30 秒节拍，立刻广播一轮。
      sendMarketDigest({ force: true })
    }
  }

  async function endIncomingContract (record, reason, endedAt) {
    if (contracts === null) return
    const id = record.id
    const ended = await contracts.end(id, { endedAt, reason })
    if (ended) {
      room.endWorking(id, { at: endedAt, reason })
      contractRetryAt.delete(id)
      contractRetryAt.delete('recall:' + id)
      refreshContractViews()
      sendMarketDigest({ force: true })
    }
  }

  /** 把 room 在 tick 里清掉的合同落到 store（幂等：只有 active 会动）。 */
  async function applyEndedContract (event) {
    if (contracts === null) return
    const found = contractFound(event.contractId)
    if (found === null) return
    if (found.record.status !== 'active') return
    await contracts.end(event.contractId, { endedAt: event.endedAt, reason: event.reason })
    refreshContractViews()
  }

  /** 发一次 work-settle（同一个 settleRequestId 重发；重连后立刻补发）。 */
  async function sendSettle (id) {
    if (contracts === null || discovery === null || identity === null) return false
    if (settleSending.has(id)) return false
    const found = contractFound(id)
    if (found === null || found.side !== 'outgoing') return false
    const record = found.record
    if (record.status !== 'ended' || record.settledAt !== null) return false
    settleSending.add(id)
    try {
      const numbers = settleNumbers(record)
      let settleRequestId = record.settleRequestId
      if (settleRequestId === null) {
        settleRequestId = randomUUID()
        await contracts.beginSettle(id, {
          requestId: settleRequestId,
          servedMs: numbers.servedMs,
          earned: numbers.earned,
          reason: numbers.reason
        })
      }
      try {
        const data = encodeWorkSettle({
          deviceId: identity.deviceId,
          contractId: id,
          requestId: settleRequestId,
          servedMs: numbers.servedMs,
          earned: numbers.earned,
          reason: numbers.reason
        })
        discovery.sendTo(record.workerDeviceId, data)
      } catch (error) {
        warnOnce('settle-encode:' + id, '结算报文编码失败：' + message(error))
      }
      contractRetryAt.set(id, contractClock() + contractRetryDelay(id))
      return true
    } finally {
      settleSending.delete(id)
    }
  }

  /**
   * 每秒（或注入的 contractTickMs）跑一次：
   *   1. pending 超时（只在本地有在飞请求时；重启对账另有入口）；
   *   2. active 到期 / 失联；
   *   3. ended 未结算 → 退避重发 settle；
   *   4. 召回未确认 → 退避重发 recall。
   */
  function runContractTimers () {
    if (disposed || contracts === null) return
    const now = contractClock()
    const grace = now - contractsReadyAt >= contractStartupGraceMs
    for (const record of contracts.pendingOutgoing()) {
      if (workRequests.has(record.requestId) && now - record.startedAt >= workTimeoutMs) {
        void failWorkRequest(record.requestId, 'timeout')
      }
    }
    for (const record of contracts.activeOutgoing()) {
      if (now >= record.endsAt) {
        void endOutgoingContract(record, 'expired', record.endsAt)
      } else if (grace && now - record.lastSeenAt >= peerLostMs) {
        void endOutgoingContract(record, 'offline', record.lastSeenAt)
        const nickname = record.workerNickname
        room.noteFarmEvent('「' + nickname + '」失联了，合同已结束。')
      }
    }
    for (const record of contracts.activeIncoming()) {
      if (now >= record.endsAt) {
        void endIncomingContract(record, 'expired', record.endsAt)
      } else if (grace && now - record.lastSeenAt >= peerLostMs) {
        void endIncomingContract(record, 'offline', record.lastSeenAt)
        room.noteFarmEvent('雇主失联了，合同已结束，宠物回来了。')
      }
      if (record.recallRequested && !record.recallAcked &&
        (contractRetryAt.get('recall:' + record.id) ?? 0) <= now) {
        const sent = sendRecall(record)
        contractRetryAt.set('recall:' + record.id, now + contractRetryDelay('recall:' + record.id))
        if (!sent) contractAttempts.set('recall:' + record.id, 0)
      }
    }
    for (const record of contracts.unsettledOutgoing()) {
      if ((contractRetryAt.get(record.id) ?? 0) <= now) void sendSettle(record.id)
    }
  }

  /**
   * 启动对账（§8.2/8.4）：pending 退款取消；active rehydrate 房间镜像；
   * settling/refunding 的崩溃窗口按「已经动过」处理（fail-closed）。
   */
  async function reconcileContractsOnStart () {
    if (contracts === null) return
    const now = contractClock()
    contractsReadyAt = now
    for (const record of contracts.pendingOutgoing()) {
      if (record.charged && !record.refunded) {
        await refundOutgoingOnce(record, record.wage + record.fee)
      } else if (!record.charged) {
        warn(ctx, '有一笔雇佣在扣钱前崩溃：按 fail-closed 不退款，合同已取消')
      }
      await contracts.cancelOutgoing(record.requestId, 'restart')
    }
    for (const record of contracts.outgoing()) {
      if (record.refundStartedAt !== null && record.refunded !== true) {
        // 写了 refunding 就崩：钱可能已经到账，绝不再退一次；结算标记也补齐，
        // 否则 ended 合同会被巡检当成「还没结算」重发到天荒地老。
        await contracts.markRefunded(record.id, { amount: record.refundAmount, at: now })
        if (record.status === 'ended' && record.settledAt === null) {
          await contracts.finishSettle(record.id, {
            earned: record.earned,
            servedMs: record.settleServedMs,
            settledAt: now,
            reason: settleReasonOf(record.endReason)
          })
        }
      }
    }
    for (const record of contracts.activeOutgoing()) {
      if (now >= record.endsAt) {
        await endOutgoingContract(record, 'expired', record.endsAt)
        continue
      }
      const begun = room.beginWorker({
        contractId: record.id,
        workerDeviceId: record.workerDeviceId,
        workerNickname: record.workerNickname,
        startedAt: record.startedAt,
        endsAt: record.endsAt,
        guard: record.guard,
        lastSeen: record.lastSeenAt
      })
      if (begun.ok !== true) {
        warn(ctx, '重启后恢复雇工失败（' + begun.error + '），合同按离线结束')
        await endOutgoingContract(record, 'offline', record.lastSeenAt)
      }
    }
    for (const record of contracts.activeIncoming()) {
      if (now >= record.endsAt) {
        await endIncomingContract(record, 'expired', record.endsAt)
        continue
      }
      const begun = room.beginWorking({
        contractId: record.id,
        employerDeviceId: record.employerDeviceId,
        employerNickname: record.employerNickname,
        startedAt: record.startedAt,
        endsAt: record.endsAt,
        guard: record.guard,
        lastSeen: record.lastSeenAt
      })
      if (begun.ok !== true) {
        warn(ctx, '重启后恢复打工状态失败（' + begun.error + '），合同按离线结束')
        await endIncomingContract(record, 'offline', record.lastSeenAt)
      }
    }
    for (const record of contracts.incoming()) {
      if (record.settleStartedAt !== null && record.settledAt === null && record.status === 'ended') {
        // 崩溃在「写完 settling 意图、还没入账/没写 settledAt」之间：按已入账处理。
        await contracts.finishSettle(record.id, {
          earned: record.earned,
          servedMs: record.settleServedMs,
          settledAt: now,
          reason: settleReasonOf(record.endReason)
        })
      }
    }
  }

  function startContractTimer () {
    if (contractTimer !== null || disposed) return
    contractTimer = setInterval(runContractTimers, contractTickMs)
    contractTimer.unref?.()
  }

  // -------------------------------------------------------------------------
  // 访客视图（ticket 43）
  // -------------------------------------------------------------------------

  /**
   * 访客拉到的快照只在这里读：授权从 room 的 visitors 派生。
   * 三个条件缺一不可：visitId 能映射到当前访客、访客仍被放行、农场 store 在。
   * 任何一条不满足都 404（不区分“没来过”和“刚走”，也不泄露那次串门存在过）。
   */
  function lookupFarmView (rawVisitId) {
    if (typeof rawVisitId !== 'string' || !isVisitId(rawVisitId)) return null
    let visitor
    try {
      visitor = room.visitorByVisitId(rawVisitId)
    } catch {
      return null
    }
    if (visitor === null) return null
    if (!room.mayTalkTo(visitor.deviceId)) return null
    if (farm === null) return null
    return farmVisitView(visitor)
  }

  /**
   * 访客视角的快照。硬约束（每条都有测试）：
   *   - 4 块地固定 p1..p4；阶段/成熟/remainingMs 由纯规则算；
   *   - **只给 stolenByMe / helpedByMe 两个布尔**，绝不回传 stolenBy/helpedBy 原数组；
   *   - 不含任何 path/dir、不含别人的 deviceId；
   *   - limits 只给这位访客自己的计数 + 本农场总数（不泄露全农场别的访客）。
   */
  function farmVisitView (visitor) {
    const view = farm?.snapshot() ?? initialFarmView()
    const guard = farmGuard()
    const byId = new Map(view.plots.map((plot) => [plot.id, plot]))
    return {
      v: 1,
      visitId: visitor.visitId,
      host: { nickname: room.snapshot().self.nickname ?? identity?.nickname ?? '邻居' },
      guard: guard.guard,
      guardParts: { ownerHome: guard.ownerHome, worker: guard.worker },
      plots: PLOT_IDS.map((id) => {
        const plot = byId.get(id) ?? { id, crop: null, grownMs: 0, growMs: 0, stolenBy: [], helpedBy: [] }
        return {
          id,
          crop: plot.crop,
          stage: plotStage(plot),
          mature: isMature(plot),
          remainingMs: plotRemainingMs(plot),
          stolenByMe: Array.isArray(plot.stolenBy) && plot.stolenBy.includes(visitor.deviceId),
          helpedByMe: Array.isArray(plot.helpedBy) && plot.helpedBy.includes(visitor.deviceId)
        }
      }),
      limits: farm?.visitLimits(visitor.deviceId) ?? null,
      hire: {
        enabled: view.hire.enabled === true,
        wagePerHour: view.hire.wagePerHour,
        minHours: view.hire.minHours,
        maxHours: view.hire.maxHours
      },
      // 行情摘要（ticket 41/42）：只给窗口画价目与局域网指数，不转发历史。
      market: marketVisitView(),
      at: Date.now()
    }
  }

  /** 行情摘要：与交易所页同源（含 bid / 新鲜指数），但不带历史。 */
  function marketVisitView () {
    if (market === null) return null
    try {
      return market.snapshot({ historyLimit: 0, withBid: true })
    } catch {
      return null
    }
  }

  function loadingVisitView (out) {
    return {
      nickname: out.nickname,
      state: 'loading',
      guard: 0,
      guardParts: { ownerHome: false, worker: false },
      plots: [],
      limits: null,
      hire: null,
      market: null,
      error: null,
      at: Date.now()
    }
  }

  /** 把访客窗口切到一个新状态（ready/error/ended），并原样推给 helper。 */
  function pushVisitState (out, patch) {
    if (desktop === null || typeof desktop.farmWindow !== 'function') return false
    const previous = farmWindowVisitView
    const visit = {
      nickname: out.nickname,
      state: 'error',
      guard: 0,
      guardParts: { ownerHome: false, worker: false },
      plots: previous?.plots ?? [],
      limits: previous?.limits ?? null,
      hire: previous?.hire ?? null,
      market: previous?.market ?? null,
      error: null,
      at: Date.now(),
      ...patch
    }
    farmWindowVisitView = visit
    farmWindowVisitId = out.visitId
    try {
      return desktop.farmWindow(farmWindowPayload({
        open: false,
        mode: 'visitor',
        visit
      })) === true
    } catch {
      return false
    }
  }

  /** 串门结束：窗口停在 ended（保留最后一次快照只读，不自动关窗）。 */
  function pushVisitEnded () {
    const previous = farmWindowVisitView
    farmWindowVisitId = null
    farmWindowVisitView = null
    if (desktop === null || typeof desktop.farmWindow !== 'function') return false
    const visit = {
      nickname: previous?.nickname ?? null,
      state: 'ended',
      guard: 0,
      guardParts: { ownerHome: false, worker: false },
      plots: previous?.plots ?? [],
      limits: previous?.limits ?? null,
      hire: previous?.hire ?? null,
      market: previous?.market ?? null,
      error: null,
      at: Date.now()
    }
    try {
      return desktop.farmWindow(farmWindowPayload({
        open: false,
        mode: 'visitor',
        visit
      })) === true
    } catch {
      return false
    }
  }

  /**
   * 拉主人的快照并推给窗口。路由 404 = 串门结束；没有端口/超时 = error。
   * 只在开窗/动作成功之后调用，不做 500ms 轮询（快照是网络，场景巡检不该打它）。
   */
  async function loadVisitFarm (out) {
    if (disposed) return null
    const current = room.outboundVisit()
    if (current === null || current.visitId !== out.visitId) {
      pushVisitEnded()
      return null
    }
    if (farmFetcher === null || discovery === null) {
      pushVisitState(out, { state: 'error', error: 'no-port' })
      return null
    }
    const port = freshPeerLanPort(out.deviceId)
    const endpoint = discovery.addressOf(out.deviceId)
    if (port === null || endpoint === null) {
      pushVisitState(out, { state: 'error', error: 'no-port' })
      return null
    }
    const fetched = await farmFetcher.get({
      address: endpoint.address,
      port,
      visitId: out.visitId
    })
    if (disposed) return null
    const after = room.outboundVisit()
    if (after === null || after.visitId !== out.visitId) {
      pushVisitEnded()
      return null
    }
    if (fetched.ok !== true) {
      if (fetched.error === 'gone') {
        pushVisitEnded()
        return null
      }
      pushVisitState(out, { state: 'error', error: fetched.error })
      return null
    }
    const view = normalizeVisitView(fetched.view)
    if (view === null || view.visitId !== out.visitId) {
      pushVisitState(out, { state: 'error', error: 'bad-shape' })
      return null
    }
    // 跨农场的日上限只有访客本机算得清：把本机计数补进 limits。
    if (view.limits !== null && typeof view.limits === 'object' && farm !== null) {
      for (const kind of ['steal', 'help']) {
        const entry = view.limits[kind]
        if (entry === null || typeof entry !== 'object') continue
        entry.perDay = kind === 'steal' ? STEAL_PER_VISITOR_PER_DAY : HELP_PER_VISITOR_PER_DAY
        entry.usedToday = farm.visitActionUsed(kind)
      }
    }
    const visit = { ...view, state: 'ready', error: null }
    farmWindowVisitId = out.visitId
    farmWindowVisitView = visit
    if (desktop === null || typeof desktop.farmWindow !== 'function') return visit
    try {
      desktop.farmWindow(farmWindowPayload({ open: false, mode: 'visitor', visit }))
    } catch {
      // 窗口刚关：下一次开窗会再拉一份。
    }
    return visit
  }

  /** 每拍巡检：串门结束（召回/送客/失联/30 分钟）时把窗口切到 ended。 */
  function noteFarmWindowVisitEnded () {
    if (farmWindowVisitId === null) return false
    const out = room.outboundVisit()
    if (out !== null && out.visitId === farmWindowVisitId) return false
    return pushVisitEnded()
  }

  /** 邻居的 LAN 端口只从报文里记 30 秒；只给农场快照用，不进快照/报文。 */
  function notePeerLanPort (packet) {
    if (!isPort(packet?.skinPort) || !isDeviceId(packet?.deviceId)) return false
    const now = Date.now()
    peerLanPorts.set(packet.deviceId, { port: packet.skinPort, at: now })
    // 内存有界：邻居表本身有上限，这里只防被大量伪造 deviceId 灌满。
    if (peerLanPorts.size > 256) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [deviceId, entry] of peerLanPorts) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at
          oldestKey = deviceId
        }
      }
      if (oldestKey !== null) peerLanPorts.delete(oldestKey)
    }
    return true
  }

  /** 端口必须新鲜（30 秒）；过期就当没有，窗口降级为“偷不了”。 */
  function freshPeerLanPort (deviceId) {
    const entry = peerLanPorts.get(deviceId)
    if (entry === undefined) return null
    if (Date.now() - entry.at > PEER_LAN_PORT_TTL_MS) {
      peerLanPorts.delete(deviceId)
      return null
    }
    return entry.port
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

      // 交易所（ticket 41）先于农场读：农场 store 需要它在同一个串行段里完成买卖。
      // 坏文件只降级成初始价格，不挡启动；`marketNow`/`farmNow` 只给测试注入。
      try {
        market = await createMarketStore(
          dir,
          marketNow === undefined ? { log } : { log, now: marketNow }
        )
      } catch (error) {
        market = null
        warn(ctx, '交易所初始化失败，本次按初始行情运行：' + message(error))
      }
      if (disposed) return

      // 农场（ticket 39）：坏文件只降级成初始农场，不挡启动；`farmNow` 只给测试注入。
      try {
        farm = await createFarmStore(
          dir,
          farmNow === undefined ? { log, market } : { log, now: farmNow, market }
        )
      } catch (error) {
        farm = null
        warn(ctx, '农场初始化失败，本次按初始农场运行：' + message(error))
      }
      if (disposed) return

      // 雇佣合同（ticket 44）：坏文件只降级成空账本，不挡启动；`contractNow` 只给测试注入。
      try {
        contracts = await createContractStore(dir, {
          log,
          ...(typeof options.contractNow === 'function' ? { now: options.contractNow } : {})
        })
      } catch (error) {
        contracts = null
        warn(ctx, '合同账本初始化失败，本次不能雇/被雇：' + message(error))
      }
      if (disposed) return

      const petConfig = await readPetConfig(configPath)
      if (disposed) return
      const fallback = defaultNickname({ petName: petConfig.name, hostname: hostname() })
      identity = await createIdentity(dir, { defaultNickname: fallback, log })
      if (disposed) return
      room.setIdentity(identity)
      // ticket 44：第一拍桌面之前必须把 active 合同恢复成镜像；pending 在这里退款取消。
      await reconcileContractsOnStart()
      if (disposed) return

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
        // 农场快照（ticket 43）：≤64 KiB 的小 JSON、2 秒超时、只私网、失败冷却 60 秒。
        farmFetcher = createFarmFetcher({
          log,
          ...(typeof options.farmFetchImpl === 'function' ? { fetchImpl: options.farmFetchImpl } : {}),
          ...(options.farmFetchTimeoutMs === undefined ? {} : { timeoutMs: options.farmFetchTimeoutMs }),
          ...(options.farmFetchCooldownMs === undefined ? {} : { cooldownMs: options.farmFetchCooldownMs })
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
            // ticket 43：任何一条带 skinPort 的报文都顺手记下邻居的 LAN 端口。
            // 不能只靠 noteVisitorSkin：那一条要求 skinId，没装素材源的邻居端口会被漏掉。
            notePeerLanPort(packet)
            // 任意 work-* 报文都证明「对方还在」：离线结算用最后心跳/最后报文。
            if (typeof packet.type === 'string' && packet.type.startsWith('work-')) {
              noteContractSeen(packet.deviceId)
            }
            // 远端字段到这里只剩三种效果：更新邻居/访客/串门表，让客户端画出来，
            // 以及一次串门完成时写一条有界记录。这里不读本机文件、不回传本机状态。
            if (packet.type === 'heartbeat') {
              room.observeHeartbeat(packet)
              noteVisitorSkin(packet)
              // ticket 44：心跳也是合同「对方还在」的证据（离线结算按最后心跳算）。
              noteContractSeen(packet.deviceId)
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
            } else if (packet.type === 'market-digest') {
              // 行情 gossip（ticket 42）。**不能落到 else**：那会当成 beacon 刷新邻居灯，
              // 看起来没坏，但价格永远进不了 index。
              handleMarketDigest(packet)
            } else if (packet.type === 'farm-action') {
              // ticket 43：主人侧的落账要等磁盘/随机/日志，不能冒到 socket 循环。
              void handleFarmActionPacket(packet)
            } else if (packet.type === 'farm-action-result') {
              handleFarmActionResult(packet)
            } else if (packet.type === 'work-request') {
              // ticket 44：要落盘 + 回 ack，不能冒到 socket 循环。
              void handleWorkRequest(packet)
            } else if (packet.type === 'work-ack') {
              void handleWorkAck(packet)
            } else if (packet.type === 'work-recall') {
              void handleWorkRecall(packet)
            } else if (packet.type === 'work-recall-ack') {
              void handleWorkRecallAck(packet)
            } else if (packet.type === 'work-end') {
              void handleWorkEnd(packet)
            } else if (packet.type === 'work-end-ack') {
              handleWorkEndAck(packet)
            } else if (packet.type === 'work-settle') {
              void handleWorkSettle(packet)
            } else if (packet.type === 'work-settle-ack') {
              void handleWorkSettleAck(packet)
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

      // 农场是本机玩法，跟联不联网无关：没有桌面层、没有网络也照样长。
      if (!disposed) startFarmTick()
      // 合同的到期/失联/重试也不依赖网络；没有 discovery 时 sendTo 自然是 no-op。
      if (!disposed) startContractTimer()

      if (!disposed && options.network !== false) {
        startNeighborTick()
        startVisitTimer()
        startAutoVisitTimer()
      }
    } catch (error) {
      if (disposed) return
      warn(ctx, '启动失败，桌面会降级：' + message(error))
      room.setBridge({ ok: false, reason: 'error' })
      // 农场已经读出来的话，tick 不陪网络一起降级。
      if (!disposed) startFarmTick()
      // 发现可能已经起来了；即使桥接坏掉，邻居灯也必须能按时过期。
      if (options.network !== false) {
        startNeighborTick()
        startVisitTimer()
        startAutoVisitTimer()
      }
    }
  }

  /**
   * 重建右键菜单（ticket 22）：dsh-pet 那张皮用它的 animations，别人的皮用皮自己的动作；
   * 前者读不到时退到本机待机池。任何失败都只让菜单变短，不影响桌面/串门。
   *
   * 换皮之后「动作」必须跟着皮走（现场反馈）：dsh-pet 那张皮仍用它的分类和 `/anim`；
   * 别的皮列自己目录里的动作，点击在本机播——`/anim` 只认 dsh-pet 自己的名字，
   * 把别人的动作名送过去只会被拒，再冒一句没必要的失败提示。
   */
  async function refreshDesktopMenu () {
    const actionsLocal = activeSkin !== null && activeSkin.id !== DEFAULT_SKIN_ID
    let animations = null
    if (!actionsLocal) {
      try {
        const found = await readAnimationsConfig(assetRootsFor(activeSkin))
        animations = found?.animations ?? null
      } catch {
        animations = null
      }
    }
    const actions = activeSkin === null || activeSkin.actions === null ||
      typeof activeSkin.actions !== 'object' || Array.isArray(activeSkin.actions)
      ? []
      : Object.keys(activeSkin.actions).sort()
    // 两条素材路共用同一份「外观」信息：读不到 dsh-pet 的 animations 时只少掉动作分类。
    const common = {
      pool: skinPool,
      actions,
      actionsLocal,
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
        lookupGift: lookupArmedGift,
        // 农场快照（ticket 43）：每次现查 room 的活跃访客 + 本地农场，没有第二张 armed 表。
        lookupFarm: lookupFarmView
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
   * 同一只访客、同一张皮、同一个动作 60 秒内不重复拉（失败也有冷却，见 skin-fetch）。
   *
   * `skinId` / `skinPort` 必须进节流键：换皮之后心跳里的动作名常常一个字都没变
   * （本机宠物大多在待机），只看动作就会把旧皮的缓存地址一直用下去——
   * 现场反馈的「我改了皮肤再串门，别人那里不变」就是这一条。
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
    const sameSkin = previous !== undefined &&
      previous.skinId === packet.skinId && previous.port === packet.skinPort
    if (sameSkin && previous.action === action && previous.semantic === semantic &&
      at - previous.at < 60000) return

    skinFetcher.resolve({
      address: endpoint.address,
      port: packet.skinPort,
      skinId: packet.skinId,
      action
    }).then((result) => {
      if (disposed) return
      const next = {
        skinId: packet.skinId,
        port: packet.skinPort,
        action,
        semantic,
        fallback: semantic,
        at: Date.now()
      }
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
            desktopHomeArea = primaryHomeArea(event)
            desktopFloors = displayFloors(event)
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
    // 40：农场和背包/礼物一样是「room 快照 + 磁盘视图」；room 自己不碰农场。
    const snapshot = desktopSnapshot()
    const pets = petsFromSnapshot(snapshot).map((pet) => {
      // 本机宠物：把当前这张皮的动作名交给渲染端轮播，并带上它的尺寸（票 32 / 35）。
      if (pet.role === 'self') {
        const sized = activeSkin === null || !Number.isInteger(activeSkin.size)
          ? pet
          : { ...pet, size: activeSkin.size }
        return skinPool.length === 0 ? sized : { ...sized, idlePool: skinPool }
      }
      if (pet.role !== 'visitor' && pet.role !== 'worker') return pet
      // 雇工复用访客素材缓存，但用 `worker:` 前缀，避免与同名 deviceId 的访客串皮。
      const prefix = pet.role === 'worker' ? 'worker:' : 'visitor:'
      const key = pet.id.startsWith(prefix) ? pet.id.slice(prefix.length) : null
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
    // 40：这里也必须用 desktopSnapshot —— 用 room.snapshot 会把农场从控件里漏掉。
    const controls = controlsFromSnapshot(dropped > 0 ? desktopSnapshot() : snapshot, { thumbOf: giftThumb })
    // 签名必须包含控件状态：串门按钮的可用性/放行卡/失败提示都可能在没有宠物增删时变化。
    const assetRoots = assetRootsFor(activeSkin)
    // 目录也进签名：两张皮的素材同名但不同目录时，换皮必须让渲染端跟着换根（ticket 33）。
    const signature = JSON.stringify({ pets, controls, menu: desktopMenu, assetRoots })
    if (!reset && signature === desktopSceneSignature) return false
    desktopSceneSignature = signature
    const scene = shared.petScene(pets, desktopWorkArea, {
      reset,
      controls,
      menu: desktopMenu,
      assetRoots,
      homeArea: desktopHomeArea,
      floors: desktopFloors
    })
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
        // 农场（ticket 40）：开窗可带 plotId，四个地块动作必须带；种地再带 cropId。
        // 访客动作（ticket 43）可带 visitId，但宿主只拿它做校验（以 self.out 为准）。
        // 少拷一处，到 39 的 store 就只剩 bad-plot，而错误信息不会告诉你是哪一跳丢的。
        plotId: event.plotId ?? undefined,
        cropId: event.cropId ?? undefined,
        visitId: event.visitId ?? undefined,
        // 交易所（ticket 41）：窗口只报数量，单价、总价和余额全由宿主算。
        qty: event.qty ?? undefined,
        // 雇佣（ticket 44）：只接这些窄字段；硬币/总价/服务时长窗口一概不传。
        hours: event.hours ?? undefined,
        contractId: event.contractId ?? undefined,
        wagePerHour: event.wagePerHour ?? undefined,
        minHours: event.minHours ?? undefined,
        maxHours: event.maxHours ?? undefined,
        enabled: event.enabled ?? undefined,
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

  // -------------------------------------------------------------------------
  // 访客动作（ticket 43）：访客宿主 → UDP farm-action → 主人落账 → 结果回放
  // -------------------------------------------------------------------------

  /**
   * 访客点「偷」/「帮」的唯一入口。**在调用栈里等 UDP 结果**（最多 1.8 秒），
   * 这样 handleDesktopAction 只回一次 action-result（单次回执契约）。
   *
   * 三条本地纪律：
   *   - 一次点击只生成一个 requestId；重发复用同一串字节；
   *   - 帮忙的 1 露水在**发出前**扣，失败/超时退回，且只退一次（settle 只发生一次）；
   *   - 跨农场的日上限（偷 10 / 帮 5）只有本机知道，在发出前按本机账本检查。
   */
  async function handleVisitFarmAction (rawAction, rawPlotId, rawVisitId) {
    const kind = rawAction === 'farm-help' ? 'help' : 'steal'
    if (farm === null) return { ok: false, error: 'starting', notice: farmErrorText('starting') }
    const out = room.outboundVisit()
    if (out === null || out.phase !== 'active') return visitFarmError(kind, 'no-visit')
    if (rawVisitId !== undefined && rawVisitId !== null) {
      const expected = typeof rawVisitId === 'string' ? rawVisitId.trim().toLowerCase() : ''
      if (expected !== out.visitId) return visitFarmError(kind, 'no-visit')
    }
    const plotId = typeof rawPlotId === 'string' && PLOT_IDS.includes(rawPlotId) ? rawPlotId : null
    if (plotId === null) return visitFarmError(kind, 'bad-plot')
    if (identity === null || discovery === null) return visitFarmError(kind, 'no-port')

    const limit = kind === 'steal' ? STEAL_PER_VISITOR_PER_DAY : HELP_PER_VISITOR_PER_DAY
    if (farm.visitActionUsed(kind) >= limit) return visitFarmError(kind, 'cap')

    // 帮忙先扣露水：否则并发两次 help 都能过“露水够不够”的检查。
    if (kind === 'help') {
      if ((farm.snapshot().dew ?? 0) < 1) return visitFarmError(kind, 'no-dew')
      const spent = await farm.spendDew(1)
      if (spent.ok !== true) return visitFarmError(kind, 'no-dew')
    }

    const requestId = randomUUID()
    let data
    try {
      data = encodeFarmAction({
        deviceId: identity.deviceId,
        visitId: out.visitId,
        requestId,
        action: kind,
        plotId
      })
    } catch {
      if (kind === 'help') await farm.refundDew(1)
      return visitFarmError(kind, 'starting')
    }

    const settled = await sendFarmActionAndWait(out.deviceId, {
      visitId: out.visitId,
      requestId,
      data
    })
    if (disposed) return { ok: false, error: 'disposed' }

    if (settled.ok === true) {
      await farm.noteVisitAction(kind)
      if (kind === 'steal') {
        const qty = Number.isInteger(settled.qty) && settled.qty > 0 ? settled.qty : 1
        await farm.addCrop(settled.crop, qty)
        // 驮包只显示：作物已经进仓库；串门结束前 UI 说「在驮包里」（SPEC v5 :107）。
        noteCarriedCrop(out, settled.crop, qty, contractClock())
      } else {
        await farm.addCoins(1)
      }
      // 成功：拉一份新快照推给窗口（不 await，结果先回给 helper）。
      void loadVisitFarm(out)
    } else if (kind === 'steal' && settled.caught === true) {
      // 被抓住也是一次尝试：本机跨农场日账本 +1。否则换新 requestId 就能重试到成功。
      await farm.noteVisitAction(kind)
    } else if (kind === 'help') {
      // 失败/超时/上限：露水退回。settle 只发生一次，所以最多退一次。
      await farm.refundDew(1)
    }
    if (settled.error === 'no-visit') pushVisitEnded()

    const result = {
      ok: settled.ok === true,
      action: rawAction,
      plotId,
      ...settled,
      notice: farmActionResultText({
        action: kind,
        ok: settled.ok === true,
        error: settled.error ?? null,
        crop: settled.crop ?? null
      })
    }
    return result
  }

  function visitFarmError (kind, error) {
    return {
      ok: false,
      error,
      notice: farmActionResultText({ action: kind, ok: false, error, crop: null })
    }
  }

  /**
   * 发出一次 farm-action 并等结果。首次发送失败（没地址/不再放行）立即 `no-port`；
   * 之后由 `runFarmRetries` 重发同一串字节，到 deadline settle `timeout` 并删条目。
   * 结果只 settle 一次：条目先从表里摘掉，迟到/重复的 result 找不到条目就丢弃。
   */
  function sendFarmActionAndWait (deviceId, { visitId, requestId, data }) {
    if (disposed || discovery === null) return Promise.resolve({ ok: false, error: 'no-port' })
    return new Promise((resolve) => {
      const now = Date.now()
      const entry = {
        deviceId,
        visitId,
        data,
        attempts: 1,
        nextAt: now + farmActionRetryMs,
        deadline: now + farmActionTimeoutMs,
        resolve,
        timer: null
      }
      farmRequests.set(requestId, entry)
      if (!sendFarmActionPacket(deviceId, data)) {
        settleFarmRequest(requestId, { ok: false, error: 'no-port' })
        return
      }
      // 兜底：即使 visitTimer 没跑（极少见），到点也要把等待方放出来。
      entry.timer = setTimeout(() => {
        settleFarmRequest(requestId, { ok: false, error: 'timeout' })
      }, farmActionTimeoutMs + 50)
      entry.timer.unref?.()
    })
  }

  function settleFarmRequest (requestId, result) {
    const entry = farmRequests.get(requestId)
    if (entry === undefined) return false
    farmRequests.delete(requestId)
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.resolve(result)
    return true
  }

  function sendFarmActionPacket (deviceId, data) {
    if (disposed || discovery === null) return false
    try {
      return discovery.sendTo(deviceId, data)
    } catch {
      return false
    }
  }

  /**
   * 访客侧的重试/超时（由 visitTimer 每 200ms 驱动）：重发同一串字节，
   * 到 deadline 还没结果就明确 timeout。
   */
  function runFarmRetries () {
    if (farmRequests.size === 0) return
    const now = Date.now()
    for (const [requestId, entry] of farmRequests) {
      if (now >= entry.deadline) {
        settleFarmRequest(requestId, { ok: false, error: 'timeout' })
        continue
      }
      if (entry.attempts >= farmActionAttempts || now < entry.nextAt) continue
      // 重发失败（对方离线/不再放行）也留着等 deadline：结果可能已经在路上。
      sendFarmActionPacket(entry.deviceId, entry.data)
      entry.attempts += 1
      entry.nextAt += farmActionRetryMs
    }
  }

  /** 收到结果：按 requestId 找到唯一等待方并 settle；未知/迟到/重复一律丢弃。 */
  function handleFarmActionResult (packet) {
    const entry = farmRequests.get(packet.requestId)
    if (entry === undefined) return false
    if (entry.deviceId !== packet.deviceId) return false
    const out = room.outboundVisit()
    if (out === null || out.visitId !== entry.visitId) {
      settleFarmRequest(packet.requestId, { ok: false, error: 'no-visit' })
      return false
    }
    settleFarmRequest(packet.requestId, {
      ok: packet.ok === true,
      ...(packet.ok === true
        ? { crop: packet.crop, qty: packet.qty }
        : { error: packet.error }),
      ...(packet.caught === true ? { caught: true } : {})
    })
    return true
  }

  // -------------------------------------------------------------------------
  // 主人侧：授权、幂等、落账、回结果
  // -------------------------------------------------------------------------

  function farmResultKey (deviceId, requestId) {
    return deviceId + ':' + requestId
  }

  /** 已落账的结果只能按 requestId 回放；过期条目先清掉。 */
  function cachedFarmResult (deviceId, requestId) {
    const key = farmResultKey(deviceId, requestId)
    const entry = farmResults.get(key)
    if (entry === undefined) return null
    if (Date.now() - entry.at > FARM_RESULT_TTL_MS) {
      farmResults.delete(key)
      return null
    }
    return entry.result
  }

  function cacheFarmResult (deviceId, requestId, result) {
    rememberBounded(farmResults, farmResultKey(deviceId, requestId),
      { result, at: Date.now() }, MAX_FARM_RESULTS)
  }

  function sendFarmActionResult (deviceId, payload) {
    if (disposed || discovery === null || identity === null) return false
    try {
      return discovery.sendTo(deviceId, encodeFarmActionResult({
        deviceId: identity.deviceId,
        ...payload
      }))
    } catch {
      return false
    }
  }

  /**
   * 主人收到 farm-action（ticket 43）。四道门按顺序：
   *   1. visitId 必须对应**当前**入站访客，且 packet.deviceId 与访客本人一致；
   *   2. 同一 `${deviceId}:${requestId}` 命中缓存 → 原样回放（不重新 roll 守卫）；
   *   3. 校验/落账在 farm store 里（成熟/生长中、每块地一次、日限额）；
   *   4. 应用之后（失败也算）才写缓存，然后回结果。
   *
   * 未授权的包**静默丢弃**：不回错误，避免把“这个 visitId 存在过”变成 oracle。
   */
  async function handleFarmActionPacket (packet) {
    if (disposed || farm === null || identity === null) return false
    const visitor = room.visitorByVisitId(packet.visitId)
    if (visitor === null || visitor.deviceId !== packet.deviceId) return false
    if (!room.mayTalkTo(visitor.deviceId)) return false

    const key = farmResultKey(packet.deviceId, packet.requestId)
    const cached = cachedFarmResult(packet.deviceId, packet.requestId)
    if (cached !== null) {
      sendFarmActionResult(packet.deviceId, { requestId: packet.requestId, ...cached })
      return true
    }
    // 两包重发间只隔几十 ms 时，第一次的磁盘写可能还没完成：等同一个 Promise，
    // 绝不让第二次再进 store 重新 roll 守卫（那会得到两份不同的结果）。
    const inflight = farmInflight.get(key)
    if (inflight !== undefined) {
      const shared = await inflight.catch(() => null)
      if (shared !== null && !disposed) {
        sendFarmActionResult(packet.deviceId, { requestId: packet.requestId, ...shared })
      }
      return true
    }
    const task = applyFarmAction(packet, visitor)
    farmInflight.set(key, task)
    let outcome
    try {
      outcome = await task
    } finally {
      farmInflight.delete(key)
    }
    if (disposed || outcome === null) return false
    cacheFarmResult(packet.deviceId, packet.requestId, outcome)
    sendFarmActionResult(packet.deviceId, { requestId: packet.requestId, ...outcome })

    // 主人侧的日志/通知：成功偷/帮与被抓各一句；其它失败（上限/没熟）不刷屏。
    if (outcome.ok === true && packet.action === 'steal') {
      room.noteFarmEvent('「' + visitor.nickname + '」偷了 1 个' + cropName(outcome.crop) + '。')
    } else if (outcome.ok === true && packet.action === 'help') {
      room.noteFarmEvent('「' + visitor.nickname + '」来帮忙浇水了。')
    } else if (outcome.caught === true && shouldToastCaught(visitor.deviceId)) {
      room.noteFarmEvent('「' + visitor.nickname + '」被抓住了。')
    }
    // onPeer 的 flush 在 await 之前就跑了：这次必须自己同步桌面/窗口。
    refreshFarmWindow()
    flushRoomEffects()
    return true
  }

  /** 真正改农场的那一段（被 in-flight 去重包住）；返回要回放的 wire 结果。 */
  async function applyFarmAction (packet, visitor) {
    let result
    try {
      if (packet.action === 'steal') {
        const guard = farmGuard()
        const caught = !stealSucceeds(guard.guard, farmRandom)
        result = await farm.markStolen(packet.plotId, visitor.deviceId, {
          who: visitor.nickname,
          caught
        })
      } else if (packet.action === 'help') {
        result = await farm.markHelped(packet.plotId, visitor.deviceId, { who: visitor.nickname })
      } else {
        return null
      }
    } catch (error) {
      warn(ctx, '农场动作落账失败：' + message(error))
      result = { ok: false, error: 'starting', persisted: false }
    }
    return result.ok === true
      ? {
          ok: true,
          crop: result.crop,
          qty: Number.isInteger(result.qty) ? result.qty : 1,
          ...(result.caught === true ? { caught: true } : {})
        }
      : {
          ok: false,
          error: typeof result.error === 'string' ? result.error : 'starting',
          ...(result.caught === true ? { caught: true } : {})
        }
  }

  function cropName (cropId) {
    return CROPS[cropId]?.name ?? '作物'
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
    // 农场（ticket 40）：39 的错误码各有下一步，文案在 src/farm-text.js（HTTP/桌面/小窗同源）。
    const farmNotice = farmErrorText(error)
    if (farmNotice !== null) return farmNotice
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

  /**
   * 挂牌随行情广播（ticket 44 D1）：`available`/`reason` 必须是**真实可用性**，
   * 不是「开了挂牌就等于能雇」——正在串门/去串门/在外打工的宠物，雇主点了也只会
   * 拿到 `worker-unavailable`。原因枚举由 `hireAvailability` 统一给（off/visiting/
   * working/ready）。
   *
   * `guard` 是**雇工贡献的 0.5**（SPEC v5「雇佣与看家」），不是 `farmGuard()` 的合成值
   * 0.3/0.5/0.8：接收方把它当成「多一位雇工能加多少守卫」，自己再和主人在家状态相加。
   */
  function hireDigestView () {
    const view = farm?.snapshot() ?? initialFarmView()
    const hire = view.hire
    const availability = hireAvailability({
      enabled: hire.enabled === true,
      visiting: room.outboundVisit() !== null,
      working: room.outboundWork() !== null
    })
    return {
      enabled: hire.enabled === true,
      wagePerHour: hire.wagePerHour,
      minHours: hire.minHours,
      maxHours: hire.maxHours,
      guard: WORKER_GUARD,
      available: availability.available,
      reason: availability.reason
    }
  }

  /** 发出去的那一份行情：本机三种作物的 price + 挂牌 + 本机时钟。 */
  function marketDigestView (now) {
    if (identity === null || market === null) return null
    const view = market.snapshot()
    const prices = {}
    for (const cropId of CROP_IDS) {
      const price = Number(view.prices?.[cropId]?.price)
      if (Number.isFinite(price)) prices[cropId] = price
    }
    return { at: now, prices, hire: hireDigestView() }
  }

  /**
   * 向所有已放行邻居发一轮行情。触发条件（ticket 42）：
   *   - 距离上次成功发送满 30 秒；
   *   - 或本机价格/挂牌签名变了（成交、均值回归、改挂牌）。
   * 走 `discovery.sendTo`：内部再查 mayTalkTo 与地址表；**失败不重试**，下一拍自然补。
   * 没有任何放行邻居时不算「发过」，邻居一出现就能收到第一条。
   */
  function sendMarketDigest ({ force = false } = {}) {
    if (disposed || discovery === null || identity === null || market === null) return 0
    const now = marketClock()
    const digest = marketDigestView(now)
    if (digest === null) return 0
    let data
    try {
      data = encodeMarketDigest({
        deviceId: identity.deviceId,
        at: digest.at,
        prices: digest.prices,
        hire: digest.hire
      })
    } catch {
      // 本机行情坏了只停这一轮广播，不影响交易所本身。
      return 0
    }
    const signature = JSON.stringify({ prices: digest.prices, hire: digest.hire })
    const due = now - marketDigestAt >= marketDigestMs
    const changed = marketDigestSignature !== null && signature !== marketDigestSignature
    if (!force && !due && !changed) return 0

    const targets = room.heartbeatTargets()
    // 一个放行邻居都没有：这不算「发过」，邻居一出现就能收到第一条。
    if (targets.length === 0) return 0
    let sent = 0
    for (const deviceId of targets) {
      try {
        if (discovery.sendTo(deviceId, data)) sent += 1
      } catch {
        // 一个坏地址不能挡住其他邻居的行情
      }
    }
    // **失败不重试**：这一轮已经尝试过，下一轮（30 秒后）自然带最新价补上。
    marketDigestAt = now
    marketDigestSignature = signature
    return sent
  }

  /**
   * 收到一条行情（ticket 42）。四道门：
   *   1. 只认已放行邻居（未放行的来源连价格都不该影响本机）；
   *   2. `at` 必须在本机时钟 2 分钟内；
   *   3. 同一 peer 一个窗口最多 1 条；
   *   4. 协议层已把未知作物/越界价格/坏挂牌丢掉或整包拒绝。
   * 通过后交给交易所 store：按 deviceId 留最近一条，重算中位数并落盘。
   */
  function handleMarketDigest (packet) {
    if (disposed || market === null) return
    if (!room.mayTalkTo(packet.deviceId)) return
    const now = marketClock()
    if (!isFreshMarketSample(packet.at, now)) return
    if (!digestLimiter.allow(packet.deviceId, now)) return
    try {
      const result = market.observeDigest(packet.deviceId, {
        prices: packet.prices,
        at: packet.at
      })
      result?.persisted?.catch?.((error) => {
        warnOnce('market-write', '行情写盘失败：' + message(error))
      })
      if (result?.ok === true) {
        peerDigests.set(packet.deviceId, {
          prices: { ...packet.prices },
          hire: { ...packet.hire },
          at: packet.at,
          nickname: neighborNickname(packet.deviceId)
        })
        // 雇工板直接读 digest（D1）：新挂牌/可用性变化要推给开着的农场窗，
        // 否则窗口会停在「没有邻居挂牌」直到用户手动重开。
        refreshFarmWindow()
      }
    } catch (error) {
      // 一条坏行情不能把邻居循环/交易所拖垮；下一包照常走。
      warnOnce('market-digest', '行情处理失败，已丢弃：' + message(error))
    }
  }

  /** 只给 44 的雇工板：昵称来自本机邻居表，不来自报文（digest 里没有昵称）。 */
  function neighborNickname (deviceId) {
    for (const neighbor of room.snapshot().neighbors) {
      if (neighbor.deviceId === deviceId) return neighbor.nickname
    }
    return null
  }

  /** 邻居被拒绝/移除：摘掉行情并重算指数（store 没有这条记录时是 no-op）。 */
  function forgetPeerDigest (deviceId) {
    peerDigests.delete(deviceId)
    if (market === null) return
    try {
      const result = market.removeDigest(deviceId)
      result?.persisted?.catch?.((error) => {
        warnOnce('market-write', '行情写盘失败：' + message(error))
      })
    } catch (error) {
      warnOnce('market-cleanup', '行情清理失败：' + message(error))
    }
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
      // 行情每 30 秒一轮；价格/挂牌变了则下一拍立刻发（不等节拍）。
      sendMarketDigest()
    }, interval)
    tickTimer.unref?.()
  }

  function startVisitTimer () {
    if (visitTimer !== null || disposed || discovery === null) return
    visitTimer = setInterval(runVisitTimers, visitTickMs)
    visitTimer.unref?.()
  }

  /**
   * 农场 tick（ticket 39）：每 60 秒推进生长、露水与 lastTickAt；
   * 交易所 tick（ticket 41）也搭这班车：到 10 分钟就把价格往 base 拉一次。
   * 落盘节流在 store 里（农场有变化且距上次写 ≥30 秒）。失败只影响这一拍。
   */
  function startFarmTick () {
    if (farmTimer !== null || disposed || farm === null) return
    farmTimer = setInterval(() => {
      const ticks = []
      try {
        ticks.push(['农场', farm?.tick()])
        if (market !== null) ticks.push(['交易所', market.tick()])
      } catch (error) {
        warnOnce('farm-tick', '农场 tick 失败：' + message(error))
        return
      }
      for (const [label, ticking] of ticks) {
        if (ticking !== undefined && typeof ticking?.catch === 'function') {
          ticking.catch((error) => {
            warnOnce('tick:' + label, label + ' tick 失败：' + message(error))
          })
        }
      }
    }, farmTickMs)
    farmTimer.unref?.()
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
    runFarmRetries()
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
    // ticket 43：串门结束（召回/送客/失联/30 分钟）时，打开的访客农场窗切到 ended。
    noteFarmWindowVisitEnded()
    // ticket 44：room 在 tick 里清掉的合同镜像落进 store（幂等），并跑一次合同巡检。
    for (const ended of room.drainEndedContracts()) {
      applyEndedContract(ended).catch((error) => {
        warnOnce('contract-end', '合同落账失败：' + message(error))
      })
    }
    runContractTimers()
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
    /** 手动补发一轮行情（测试用；正常由 1 秒巡检按 30 秒/变化触发）。 */
    sendMarketDigest,
    /** ticket 44 的测试/诊断缝：雇工页数据与唯一守卫计算点。 */
    contractWindow: () => contractWindowView(),
    farmGuard: () => farmGuard(),
    /** ticket 43/44 的测试/诊断缝：只读驮包（偷来的作物 + 在途工资）。 */
    carried: () => carriedView(),
    /** 本机 UDP 实际绑定端口（`port:0` 的测试用它拿到临时端口）。 */
    localPort: () => discovery?.address()?.port ?? null,
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
      if (farmTimer !== null) {
        clearInterval(farmTimer)
        farmTimer = null
      }
      if (contractTimer !== null) {
        clearInterval(contractTimer)
        contractTimer = null
      }
      // ticket 44：先把 active 合同落成 ended（尽力而为；写盘失败也只告警一次），
      // 再放开 store。钱的标记保持不变，下一次启动按对账规则收尾。
      if (contracts !== null) {
        contracts.endAllActive(contractClock(), 'shutdown').catch((error) => {
          warn(ctx, '卸载时结束合同失败：' + message(error))
        })
      }
      for (const requestId of [...workRequests.keys()]) {
        const entry = workRequests.get(requestId)
        if (entry !== undefined && entry.timer !== null) clearTimeout(entry.timer)
        workRequests.delete(requestId)
      }
      workResults.clear()
      workInFlight.clear()
      settleInFlight.clear()
      refundInFlight.clear()
      settleSending.clear()
      pendingHire = null
      contractRetryAt.clear()
      contractAttempts.clear()
      contracts = null
      farm = null
      market = null
      digestLimiter.clear()
      peerDigests.clear()
      marketDigestAt = Number.NEGATIVE_INFINITY
      marketDigestSignature = null
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
      // 农场访客（ticket 43）：端口缓存、主人幂等缓存、访客在飞请求全部作废。
      peerLanPorts.clear()
      farmResults.clear()
      farmInflight.clear()
      for (const requestId of [...farmRequests.keys()]) {
        settleFarmRequest(requestId, { ok: false, error: 'disposed' })
      }
      farmRequests.clear()
      farmFetcher = null
      farmWindowVisitId = null
      farmWindowVisitView = null
      farmWindowOpened = false
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

/**
 * 主屏在工作区坐标系里的矩形。
 *
 * helper 上报的 `workArea` 是整张虚拟桌面（所有屏工作区的并集，见 shared.desktopArea）。
 * `displays` 里带 `primary` 标记，所以这里能把主屏换算成窗口局部坐标：
 *   x = primary.workArea.x - workArea.x
 * 场景里的出生点因此落在主屏中央，而不是并集的正中（两块屏并排时正好是接缝）。
 * 拿不到主屏标记（老 helper / 单屏没带 displays）时返回 null，petScene 退回旧行为。
 */
function primaryHomeArea (event) {
  const workArea = event?.workArea
  if (workArea === null || typeof workArea !== 'object') return null
  const displays = Array.isArray(event.displays) ? event.displays : []
  const primary = displays.find((display) => display !== null && typeof display === 'object' && display.primary === true)
  if (primary === undefined || primary === null || primary.workArea === null || typeof primary.workArea !== 'object') {
    return null
  }
  const local = {
    x: primary.workArea.x - workArea.x,
    y: primary.workArea.y - workArea.y,
    width: primary.workArea.width,
    height: primary.workArea.height
  }
  // 必须落在这块桌面里；显示布局在 ready 之后又变了的竞态下也不越界。
  // 注意用**窗口局部**的桌面矩形裁剪：workArea 自己带的是屏幕坐标（x/y 可能非 0），
  // 拿它裁一个局部矩形会把整块区域按屏幕原点整体挪位。
  return shared.clipRectToArea(local, localSurface(workArea))
}

/**
 * 每块屏在窗口局部坐标里的矩形（渲染端的 `floorBottom` 来源）。
 * 场景里空数组 = 老宿主/单屏，物理退回整张桌面。
 */
function displayFloors (event) {
  const workArea = event?.workArea
  if (workArea === null || typeof workArea !== 'object') return []
  const surface = localSurface(workArea)
  const displays = Array.isArray(event.displays) ? event.displays : []
  const floors = []
  for (const display of displays) {
    const area = display !== null && typeof display === 'object' ? display.workArea : null
    if (area === null || typeof area !== 'object') continue
    const floor = shared.clipRectToArea({
      x: area.x - workArea.x,
      y: area.y - workArea.y,
      width: area.width,
      height: area.height
    }, surface)
    if (floor !== null) floors.push(floor)
  }
  return floors
}

/** 桌面窗口自己的矩形，局部坐标（0,0 起）。 */
function localSurface (workArea) {
  return { x: 0, y: 0, width: workArea.width, height: workArea.height }
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
