import {
  GUEST_TTL_MS,
  MAX_LABEL,
  MAX_NEIGHBORS,
  NEIGHBOR_TTL_MS,
  PEER_LOST_MS,
  VISIT_MAX_MS,
  isPort,
  isSafeAnimationName,
  isVisitId,
  normalizeAnimation,
  normalizeGift,
  normalizeNickname,
  normalizeSay,
  normalizeSemantic,
  sanitizeLabel
} from './protocol.js'
import {
  MAX_VISIT_RECORD_MS,
  VISIT_RECORD_LIMIT,
  normalizeVisitGift,
  normalizeVisitRecord
} from './visit-record.js'
import {
  giftDroppedText,
  giftLeftBehindText,
  giftNotReceivedText,
  giftReceivedText,
  isGiftReason,
  isGiftStatus
} from './gift-text.js'
import { MAX_CONTRACT_MS } from './contracts-rules.js'
import { visitReasonText } from './visit-copy.js'
import { STALE_KEEP_MS, streetFrom } from './street.js'
import {
  eligibleVisitTargets,
  isVisitPolicyReason,
  pickVisitTarget as pickPolicyTarget,
  planSpontaneousVisit as planVisitPolicy
} from './visit-policy.js'

export { MAX_VISIT_RECORD_MS, VISIT_RECORD_LIMIT } from './visit-record.js'

/**
 * 串门的领域状态：我是谁、有哪些邻居、谁在我家、谁出门了、最近串了几次门。
 *
 * 这一层是本项目的主测试缝——它是纯的：喂事件、看快照，不碰 socket、不碰 DOM、不碰磁盘。
 * 网络和磁盘在 src/discovery.js、src/identity.js、src/peers.js、src/visits.js 与
 * src/pet-bridge.js 里，它们只把外部世界翻译成这里的方法调用。
 *
 * 快照形状是客户端唯一的输入契约，改它等于改 UI 契约（只加字段，不改名、不删除）：
 *   {
 *     version: 1,
 *     self: {
 *       deviceId, nickname,
 *       pet: { name, anim } | null,
 *       bridge: { ok, reason },       // reason: starting|not-installed|unreachable|no-pet|error|null
 *       out: { deviceId, nickname, visitId, phase: 'requesting'|'active',
 *              startedAt, endsAt } | null   // 本地宠物出门了；active 的 endsAt = 30 分钟上限
 *       work: { contractId, employerDeviceId, employerNickname,
 *               startedAt, endsAt, guard, lastSeen } | null
 *                                            // 我的宠物在外打工（ticket 44）；与 out 互斥
 *     },
 *     neighbors: [ { deviceId, nickname, status: 'pending'|'allowed'|'denied', lastSeen, port,
 *                    heartbeatAt } ],
 *                // heartbeatAt > 0 = 收到过对方心跳 = 对方也放行了我（心跳只发给放行名单）
 *     guests:    [ { deviceId, nickname, anim, since, expiresAt } ], // 30 秒心跳影子，v2 不渲染
 *     visitors:  [ { deviceId, nickname, anim, visitId, since, lastSeen, endsAt: null } ],
 *                 // 入站串门访客：没有时间上限，只靠心跳存活与「送客」结束
 *     worker:    { contractId, workerDeviceId, workerNickname,
 *                  startedAt, endsAt, guard, anim, lastSeen } | null,
 *                 // 别人家的宠物在我家打工（ticket 44）；与 visitors 正交
 *                 // （雇工不是访客：不能送客，只能结束合同并结算）
 *     visits:    [ { direction: 'out'|'in', nickname, startedAt, durationMs,
 *                    gift?: { kind: 'text'|'file', name? } } ],
 *     prompt:    { deviceId, nickname } | null,   // 放行 FIFO 的队首；其余排队等待
 *     notices:   [ { text, at } ],
 *     acceptVisits: true,                         // 本机桌面是否接受入站串门
 *     autoVisit: {                                // ticket 09：自发出门的策略状态
 *       enabled,                                  // 总开关，默认 false
 *       activitySource: 'session'|'pointer'|'none',
 *       lastActivityAt, lastDepartureAt,
 *       lastDecision: { at, reason, gate, candidate, activitySource, ... } | null
 *     },
 *     visitTargets: [ { deviceId, nickname } ],   // 手动「串门」可用的邻居（在线且互相放行）
 *     visitBlockedReason: 'no-admitted'|'no-online'|null
 *                                                // 没有目标时的原因；按钮与 notice 共用
 *   }
 *
 * 已知限制（ticket 01）：`dsh-pet` 不上报随机待机动画，所以 `self.pet.anim`
 * 只能反映**被点播过**的动作；anim 为空时由客户端轮播内置待机片段。
 *
 * ticket 03（放行）的边界：
 * - 第一次见到某个 deviceId 时入队一条 prompt；上限 MAX_PROMPTS，队首才进快照。
 * - admit()/reject() 只改内存并返回一条决定；落盘由 service 交给 src/peers.js。
 * - dismissPrompt() 只让队列前进，并让该邻居安静 PROMPT_SNOOZE_MS，不改变信任。
 * - mayTalkTo(deviceId) 是心跳与串门请求的**唯一**门控：只有 allowed 为真。
 * - 邻居的 IP 地址不在这里，也不在快照里；见 discovery.addressOf()。
 *
 * ticket 04（心跳影子）的边界：
 * - 只有 mayTalkTo 为真的邻居心跳才会创建/刷新 guests；pending/denied 的心跳只被丢弃。
 * - 心跳影子 30 秒没有心跳由 tick() 清掉；它只用来表示“这位邻居在线”，不是串门访客。
 * - 访客昵称来自邻居表或放行名单，绝不来自心跳。
 *
 * ticket 05 / 09（出门）的边界：
 * - 出门是一次显式状态（self.out），不是 30 秒心跳影子：请求中/已抵达。
 * - 同一只本机宠物同时只能有一次出门；active 后 30 分钟到点自己回家并写记录。
 * - 对方的送客（visit-recall）、本机召回、30 分钟上限、对方失联（2 分钟无心跳）
 *   是四种结束方式；每种都只写一条记录，durationMs 是真实停留时长。
 * - 总开关、活动窗口与冷却只影响**自发**出门；手动「串门」永远可用。
 *
 * ticket 10（访客常驻）的边界：
 * - 入站访客没有 TTL，也不设同屏上限；只有主人「送客」或对方失联（2 分钟无心跳）
 *   才会离开。每次离开都写一条 in 记录。
 * - 接收方自己检测失联，不假设对方会发 recall；发送方也自己检测，不假设对方守约。
 *
 * ticket 06（记录）的边界：
 * - 一次串门完成时写一条**内存**记录；落盘由 service 调用 drainVisitRecords()
 *   后交给 src/visits.js，room 自己不碰磁盘。
 * - 记录最多保留 VISIT_RECORD_LIMIT 条，丢掉最旧的；快照只给最近 5 条。
 * - 记录损坏/不可写时，visits.json 由 store 降级；这里始终有一份内存记录可用。
 * - 每条记录还可带一个可选的礼物摘要（ticket 27）：只记 kind 与文件名，不记字条正文。
 *
 * 桌面开关（ticket 02 用户故事 22）：
 * - acceptVisits 只挡**入站串门请求**：关掉时回一条带 visits-off 理由的 deny，
 *   不创建访客；发现、心跳和本机出门都不受影响。
 * - autoVisit 只影响**自发出门**：关掉时手动「串门」照常可用。
 * - 两个开关都是本机动作，落盘由 service 交给 src/settings.js；UDP 报文永远改不了它们。
 *
 * ticket 23（带派·字条）的边界：
 * - 礼物挂在**这一次访客**上（`visitor.gift`），不是独立列表：访客回家/被送客/失联时
 *   卡片跟着消失，不需要第二套生命周期。
 * - 协议层已经清过一次；这里再过一遍 `normalizeGift` 是防御（room 也会被单测直接喂），
 *   非法就当成“这次没有礼物”，绝不因此不建访客。
 * - 只有 service 能改礼物状态（写盘成功 → received、失败 → failed）；room 不碰磁盘。
 * - 「扔掉」之后本次运行内**永不再出现**：discardedGifts 记住 giftId，重试报文也带不回来。
 */

export const MAX_PROMPTS = 8
/** 同时出现在桌面上的心跳影子上限；它只是“谁在线”，不是串门访客。 */
export const MAX_GUESTS = 8
export const MAX_NOTICES = 10
/**
 * 「扔掉过」的 giftId 记忆上限。一次运行里丢掉两百件之后，最旧的那条被忘掉——
 * 它对应的访客早就走了，重发的报文也不会再带同一个 UUID。
 */
export const MAX_DISCARDED_GIFTS = 200
/**
 * 「刚结束的入站串门身上那件礼物」的传递队列上限（ticket 26）。service 每次
 * flush 都会取走；给个上限只是为了让 room 的内存永远有界。
 */
const MAX_ENDED_INBOUND_GIFTS = 32
/** 点“稍后再说”后，同一位邻居至少安静这么久再问（它消失后重新出现则立刻重问）。 */
export const PROMPT_SNOOZE_MS = 10 * 60 * 1000

const BRIDGE_REASONS = new Set(['starting', 'not-installed', 'unreachable', 'no-pet', 'error'])
const IDLE_BRIDGE = Object.freeze({ ok: false, reason: 'starting' })
const FALLBACK_NICKNAME = '邻居'
const DIRECTIONS = new Set(['out', 'in'])
const ACTIVITY_SOURCES = new Set(['session', 'pointer'])

export function createRoom ({
  dir,
  log,
  clock = () => Date.now(),
  visitMaxMs,
  peerLostMs = PEER_LOST_MS
} = {}) {
  const maxVisitMs = positiveMs(visitMaxMs, VISIT_MAX_MS)
  const lostMs = positiveMs(peerLostMs, PEER_LOST_MS)
  const state = {
    self: { deviceId: null, nickname: '我', pet: null, bridge: { ...IDLE_BRIDGE } },
    // 本机插件通过 POST /dsh-zoo/self-state 推来的状态；30 秒内不被 dsh-pet 轮询覆盖。
    selfState: { action: null, semantic: null, say: null, at: 0 },
    neighbors: new Map(),
    guests: new Map(),
    // 「十分钟内最后见过谁」：邻居表 30 秒就清人，掉线灰态靠这张表记住（ticket 20）。
    recentSeen: new Map(),
    visitors: new Map(),
    out: null,
    // ticket 44：两个镜像。真相在 contracts.json，room 只回答「谁在哪、还有多久、守卫多少」。
    work: null,
    worker: null,
    visits: [],
    completedVisits: [],
    // ticket 44：房间自己结束掉的合同（到期/失联/被拒绝/信任收紧），service 在
    // flushRoomEffects 里 drain 后落 store + 结算；room 仍然不碰磁盘。
    completedContracts: [],
    pendingRecalls: [],
    // ticket 26：结束的入站串门身上那件礼物（送客 / 对方召回 / 失联）。
    // 只有 service 知道磁盘上的 meta.opened，所以这里只负责“交给它”。
    endedInboundGifts: [],
    trust: { allowed: new Map(), denied: new Map() },
    prompts: [],
    promptSet: new Set(),
    snoozed: new Map(),
    notices: [],
    acceptVisits: true,
    autoVisits: false,
    lastDepartureAt: null,
    activity: { session: null, pointer: null },
    lastPolicyDecision: null,
    // 「一次场景画不下所有访客」的提示只提醒一次；拥挤解除后才能再提醒。
    overflowNotified: false,
    // ticket 23：被主人「扔掉」的 giftId。重试/重放同一份报文也不会再长出卡片。
    discardedGifts: new Set()
  }

  function nowMs () {
    const stamp = clock()
    return Number.isFinite(stamp) ? stamp : Date.now()
  }

  /** 30 秒内的 self-state 覆盖 dsh-pet 轮询来的 anim/动作；过期就回到轮询结果。 */
  const SELF_STATE_TTL_MS = 30000

  function selfPetView () {
    if (state.self.pet === null) return null
    const pet = { ...state.self.pet }
    const pushed = state.selfState
    if (pushed.at > 0 && nowMs() - pushed.at <= SELF_STATE_TTL_MS) {
      if (pushed.action !== null) pet.action = pushed.action
      if (pushed.semantic !== null) pet.semantic = pushed.semantic
      if (pushed.say !== null) pet.say = pushed.say
    }
    return pet
  }

  function stampOf (value) {
    return Number.isFinite(value) ? value : nowMs()
  }

  /**
   * 记一次「最后见到」。邻居表 30 秒就清人，但街上要灰着留十分钟（ticket 20），
   * 所以这里另记一份：昵称、最后时刻、以及最后一次知道的信任状态。
   */
  function rememberSeen ({ deviceId, nickname, lastSeen, status } = {}) {
    if (typeof deviceId !== 'string' || deviceId === '') return
    if (!Number.isFinite(lastSeen)) return
    if (!state.recentSeen.has(deviceId) && state.recentSeen.size >= MAX_NEIGHBORS) {
      // 满了就丢最旧的一条。上限与邻居表同一个数：街上的十六个名额是渲染端的边界。
      let oldestId = null
      let oldest = Infinity
      for (const [id, seen] of state.recentSeen) {
        if (seen.lastSeen < oldest) {
          oldest = seen.lastSeen
          oldestId = id
        }
      }
      if (oldestId !== null) state.recentSeen.delete(oldestId)
    }
    state.recentSeen.set(deviceId, { deviceId, nickname, lastSeen, status })
  }

  /** 信任变了：只纠正记忆里的状态，不伪造一次见面。 */
  function retrustSeen (deviceId, status) {
    const seen = state.recentSeen.get(deviceId)
    if (seen === undefined) return
    seen.status = status
  }

  /** 本机活动的两个来源各自保存“最近一次”；快照里取更近的那个。 */
  function activityInfo () {
    const session = state.activity.session
    const pointer = state.activity.pointer
    if (session === null && pointer === null) return { at: null, source: 'none' }
    if (session !== null && (pointer === null || session >= pointer)) {
      return { at: session, source: 'session' }
    }
    return { at: pointer, source: 'pointer' }
  }

  function currentVisitTargets () {
    return eligibleVisitTargets([...state.neighbors.values()], { now: nowMs() })
  }

  /**
   * 没有可串门目标时的原因：放行名单是空的 → no-admitted；
   * 有人被我放行、但此刻都不在线/没证明放行我 → no-online。
   * 快照字段与失败提示共用这一个判定。
   */
  function visitBlockedReason () {
    if (currentVisitTargets().length > 0) return null
    const admitted = [...state.trust.allowed.keys()].some((deviceId) => canTalkTo(deviceId))
    return admitted ? 'no-online' : 'no-admitted'
  }

  function copyCandidate (candidate) {
    if (candidate === null || typeof candidate !== 'object') return null
    return {
      deviceId: typeof candidate.deviceId === 'string' ? candidate.deviceId : '',
      nickname: normalizeNickname(candidate.nickname) ?? FALLBACK_NICKNAME
    }
  }

  function copyDecision (decision) {
    if (decision === null || typeof decision !== 'object') return null
    return {
      at: Number.isFinite(decision.at) ? decision.at : nowMs(),
      reason: isVisitPolicyReason(decision.reason) ? decision.reason : 'no-activity',
      gate: typeof decision.gate === 'string' ? decision.gate : null,
      candidate: copyCandidate(decision.candidate),
      candidates: Number.isInteger(decision.candidates) && decision.candidates >= 0
        ? decision.candidates
        : 0,
      activitySource: ACTIVITY_SOURCES.has(decision.activitySource) ? decision.activitySource : 'none',
      activityAgeMs: Number.isFinite(decision.activityAgeMs) ? Math.max(0, decision.activityAgeMs) : null,
      sinceDepartureMs: Number.isFinite(decision.sinceDepartureMs)
        ? Math.max(0, decision.sinceDepartureMs)
        : null
    }
  }

  function enqueuePrompt (deviceId) {
    if (state.promptSet.has(deviceId)) return false
    const until = state.snoozed.get(deviceId)
    if (until !== undefined) {
      if (nowMs() < until) return false
      state.snoozed.delete(deviceId)
    }
    if (state.prompts.length >= MAX_PROMPTS) return false
    state.prompts.push(deviceId)
    state.promptSet.add(deviceId)
    return true
  }

  function removePrompt (deviceId) {
    if (!state.promptSet.delete(deviceId)) return false
    const index = state.prompts.indexOf(deviceId)
    if (index >= 0) state.prompts.splice(index, 1)
    return true
  }

  /** 丢掉已经不该问的 prompt（邻居消失或已有决定）。 */
  function purgePrompts () {
    for (let index = state.prompts.length - 1; index >= 0; index -= 1) {
      const deviceId = state.prompts[index]
      const neighbor = state.neighbors.get(deviceId)
      if (neighbor === undefined || neighbor.status !== 'pending') {
        state.prompts.splice(index, 1)
        state.promptSet.delete(deviceId)
      }
    }
  }

  function currentPrompt () {
    for (const deviceId of state.prompts) {
      const neighbor = state.neighbors.get(deviceId)
      if (neighbor !== undefined && neighbor.status === 'pending') {
        return { deviceId, nickname: neighbor.nickname }
      }
    }
    return null
  }

  /** 唯一的出站/入站门控：本机放行、未被拒绝、且不是自己。 */
  function canTalkTo (rawDeviceId) {
    const deviceId = normalizeDeviceId(rawDeviceId)
    if (deviceId === null) return false
    if (state.self.deviceId !== null && deviceId === state.self.deviceId) return false
    return state.trust.allowed.has(deviceId) && !state.trust.denied.has(deviceId)
  }

  /** 访客表满了：挤掉最久没有心跳的那位；新来的留在表里。 */
  function evictStalestGuest () {
    let oldestId
    let oldestAt = Infinity
    for (const [deviceId, guest] of state.guests) {
      if (guest.lastSeen < oldestAt) {
        oldestAt = guest.lastSeen
        oldestId = deviceId
      }
    }
    if (oldestId !== undefined) state.guests.delete(oldestId)
  }

  function refreshNeighbor (deviceId, at) {
    const neighbor = state.neighbors.get(deviceId)
    if (neighbor !== undefined && at > neighbor.lastSeen) neighbor.lastSeen = at
  }

  /**
   * 记录“收到过对方心跳”。心跳只发给自己的放行名单，所以这条记录同时证明
   * **对方也放行了我**——这正是自发出门/手动串门需要的条件（不是我喜欢它就行）。
   * 邻居表里没有它时补一条 allowed 邻居（昵称来自我的放行名单，不来自心跳）。
   */
  function markPeerHeartbeat (deviceId, nickname, at) {
    const neighbor = state.neighbors.get(deviceId)
    if (neighbor !== undefined) {
      neighbor.heartbeatAt = Number.isFinite(neighbor.heartbeatAt)
        ? Math.max(neighbor.heartbeatAt, at)
        : at
      refreshNeighbor(deviceId, at)
      return
    }
    if (state.neighbors.size >= MAX_NEIGHBORS) return
    state.neighbors.set(deviceId, {
      deviceId,
      nickname: nickname ?? FALLBACK_NICKNAME,
      status: 'allowed',
      lastSeen: at,
      port: null,
      heartbeatAt: at
    })
  }

  function copyOutbound (out) {
    if (out === null) return null
    return {
      deviceId: out.deviceId,
      nickname: out.nickname,
      visitId: out.visitId,
      phase: out.phase,
      startedAt: out.startedAt,
      endsAt: out.endsAt
    }
  }

  /** ticket 44：`self.work` 的只读拷贝。钱不在 room，只有身份/时间/守卫。 */
  function copyWork (work) {
    if (work === null) return null
    return {
      contractId: work.contractId,
      employerDeviceId: work.employerDeviceId,
      employerNickname: work.employerNickname,
      startedAt: work.startedAt,
      endsAt: work.endsAt,
      guard: work.guard,
      lastSeen: work.lastSeen
    }
  }

  /** ticket 44：顶层 `worker` 的只读拷贝（别人在我家打工的那只）。 */
  function copyWorker (worker) {
    if (worker === null) return null
    return {
      contractId: worker.contractId,
      workerDeviceId: worker.workerDeviceId,
      workerNickname: worker.workerNickname,
      startedAt: worker.startedAt,
      endsAt: worker.endsAt,
      guard: worker.guard,
      anim: worker.anim,
      lastSeen: worker.lastSeen
    }
  }

  /** 合同时间/守卫的形状校验；坏合同不能进入镜像（否则守卫会永远算错）。 */
  function normalizeContractTiming (startedAt, endsAt, guard, at) {
    const start = Number.isFinite(startedAt) ? startedAt : at
    const end = Number.isFinite(endsAt) ? endsAt : null
    if (end === null || end <= start) return null
    if (end - start > MAX_CONTRACT_MS) return null
    const value = Number(guard)
    const safeGuard = Number.isFinite(value) ? Math.min(0.8, Math.max(0, value)) : 0
    return { startedAt: start, endsAt: end, guard: safeGuard }
  }

  function copyVisitor (visitor) {
    return {
      deviceId: visitor.deviceId,
      nickname: visitor.nickname,
      anim: visitor.anim,
      visitId: visitor.visitId,
      since: visitor.since,
      // 入站访客没有时间上限：endsAt 固定为 null，客户端不要画倒计时。
      lastSeen: visitor.lastSeen,
      endsAt: null,
      // 只加字段、不改名：没有礼物的访客，快照形状与 ticket 10 完全一致。
      ...(visitor.gift === undefined ? {} : { gift: { ...visitor.gift } })
    }
  }

  /**
   * 按 visitId 找当前入站访客（ticket 43）。返回拷贝，调用方改不到内部状态。
   *
   * `visitors` 按 deviceId 索引，visitId 只是值里的字段；这里直接遍历值（访客通常 0–2 位）。
   * 五个结束点（送客/对方召回/失联/信任收紧/dispose）都会删条目，所以路由的 404
   * 不需要第二张 armed 表——查询不到就是“这次串门结束了”。
   */
  function findVisitorByVisitId (rawVisitId) {
    const visitId = normalizeVisitId(rawVisitId)
    if (visitId === null) return null
    for (const visitor of state.visitors.values()) {
      if (visitor.visitId === visitId) return copyVisitor(visitor)
    }
    return null
  }

  /**
   * 入站礼物：协议层已经清洗过一遍，这里再过一遍白名单（room 也会被单测直接喂）。
   * 返回的状态永远是 pending——真正收下要等 service 把 note.txt/文件写成功。
   * 文件礼物只带 name/size（渲染端要画文件名与大小）；sha256 与路径都不进快照。
   */
  function visitorGift (value) {
    const gift = normalizeGift(value)
    if (gift === null) return null
    // 扔掉过的东西不再长回来，哪怕对方重发同一条报文。
    if (state.discardedGifts.has(gift.id)) return null
    if (gift.kind === 'file') {
      return { id: gift.id, kind: 'file', name: gift.name, size: gift.size, status: 'pending' }
    }
    return { id: gift.id, kind: 'text', text: gift.text, status: 'pending' }
  }

  function rememberDiscardedGift (giftId) {
    if (!isVisitId(giftId)) return
    state.discardedGifts.delete(giftId)
    state.discardedGifts.add(giftId)
    while (state.discardedGifts.size > MAX_DISCARDED_GIFTS) {
      const oldest = state.discardedGifts.values().next().value
      if (oldest === undefined) break
      state.discardedGifts.delete(oldest)
    }
  }

  /**
   * 入站串门结束了（送客 / 对方召回 / 失联 / 名单收紧）：如果访客身上还有一件礼物，
   * 记下“谁捎来的、哪一件”，交给 service 去查 `meta.opened`。
   *
   * room 不碰磁盘，所以这里刻意不判断“要不要提醒”——只传递事实。
   * 每取走一次就清空（见 `drainEndedInboundGifts`），不会在快照里重复。
   */
  function rememberEndedInboundGift (visitor) {
    if (visitor?.gift === undefined) return
    state.endedInboundGifts.push({
      deviceId: visitor.deviceId,
      nickname: visitor.nickname,
      giftId: visitor.gift.id
    })
    while (state.endedInboundGifts.length > MAX_ENDED_INBOUND_GIFTS) {
      state.endedInboundGifts.shift()
    }
  }

  function copyRecord (record) {
    return {
      direction: record.direction,
      nickname: record.nickname,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      // 可选字段只加不改：没有礼物的记录与 ticket 06 的形状完全一致。
      ...(record.gift === undefined ? {} : { gift: { ...record.gift } })
    }
  }

  function pushNotice (text, at = nowMs()) {
    const clean = sanitizeLabel(text, MAX_LABEL * 4)
    if (clean === null) return null
    const notice = { text: clean, at: Number.isFinite(at) ? at : nowMs() }
    state.notices.unshift(notice)
    if (state.notices.length > MAX_NOTICES) state.notices.length = MAX_NOTICES
    return notice
  }

  function failWithNotice (reason, nickname, at) {
    const notice = pushNotice(visitReasonText(reason, nickname), at)
    return {
      ok: false,
      error: reason,
      notice: notice === null ? null : notice.text
    }
  }

  /**
   * 写一条完成的串门记录（in / out 都走这里）。
   * `gift` 是可选的第 5 个参数：来访者身上那件礼物，或这次出门带在路上的那一件。
   * 只留 kind 与文件名；非法/没有就只是少一个字段，记录本身照写。
   */
  function recordVisit (direction, nickname, startedAt, endedAt, gift = null) {
    const start = Number.isFinite(startedAt) ? Math.max(0, startedAt) : nowMs()
    const end = Number.isFinite(endedAt) ? Math.max(start, endedAt) : nowMs()
    const record = {
      direction: DIRECTIONS.has(direction) ? direction : 'in',
      nickname: normalizeNickname(nickname) ?? FALLBACK_NICKNAME,
      startedAt: start,
      durationMs: Math.min(Math.max(0, end - start), MAX_VISIT_RECORD_MS)
    }
    const cleanGift = normalizeVisitGift(gift)
    if (cleanGift !== null) record.gift = cleanGift
    state.visits.unshift(record)
    if (state.visits.length > VISIT_RECORD_LIMIT) state.visits.length = VISIT_RECORD_LIMIT
    // room 不落盘：完成的记录排队，service 在 tick/action 之后交给 visits.json。
    state.completedVisits.push({ ...record })
    return record
  }

  /**
   * 结束一次出门。只有已经抵达（active）的串门才写记录：
   * 还在请求中就失败/取消的，什么也没发生，不该留下“去过”的假记录。
   * notifyRemote 为真时排一条 visit-recall，由 service 发出去。
   */
  function finishOutbound ({ at = nowMs(), notifyRemote = false, notice = null } = {}) {
    const out = state.out
    if (out === null) return null
    const wasActive = out.phase === 'active'
    state.out = null
    let record = null
    if (wasActive) {
      record = recordVisit('out', out.nickname, out.startedAt, at, out.gift)
      if (notifyRemote) state.pendingRecalls.push({ deviceId: out.deviceId, visitId: out.visitId })
    }
    if (notice !== null) pushNotice(notice, at)
    return { visit: copyOutbound(out), record }
  }

  /**
   * 结束「我在外打工」的镜像（ticket 44）。只清匹配的那一份；重复调用返回 false。
   * 结束事件排队给 service（role:'worker' 指我的宠物是雇工）。
   */
  function finishWorking (contractId, { at = nowMs(), reason = 'recall', notice = null } = {}) {
    const work = state.work
    if (work === null || work.contractId !== contractId) return false
    state.work = null
    state.completedContracts.push({
      role: 'worker',
      contractId: work.contractId,
      endedAt: Number.isFinite(at) ? at : nowMs(),
      reason
    })
    while (state.completedContracts.length > 40) state.completedContracts.shift()
    if (notice !== null) pushNotice(notice, at)
    return true
  }

  /** 结束「别人在我家打工」的镜像（ticket 44）。role:'employer'。 */
  function finishWorker (contractId, { at = nowMs(), reason = 'recall', notice = null } = {}) {
    const worker = state.worker
    if (worker === null || worker.contractId !== contractId) return false
    state.worker = null
    state.completedContracts.push({
      role: 'employer',
      contractId: worker.contractId,
      endedAt: Number.isFinite(at) ? at : nowMs(),
      reason
    })
    while (state.completedContracts.length > 40) state.completedContracts.shift()
    if (notice !== null) pushNotice(notice, at)
    return true
  }

  /** 清掉一位入站访客并写记录；被拒绝/名单收紧时用。 */
  function dropInboundVisitor (deviceId, at) {
    const visitor = state.visitors.get(deviceId)
    if (visitor === undefined) return null
    state.visitors.delete(deviceId)
    rememberEndedInboundGift(visitor)
    return recordVisit('in', visitor.nickname, visitor.since, at, visitor.gift)
  }

  /**
   * 本机出门失败（service 发现没地址、重试三次没 ack、收到 deny 等）。
   * 只清掉还在请求中的状态；已经抵达的串门必须走 recallOutbound / tick。
   */
  function failOutbound (reason, at) {
    const out = state.out
    if (out === null) return { ok: false, error: 'not-out' }
    if (out.phase !== 'requesting') return { ok: false, error: 'already-there' }
    const now = stampOf(at)
    state.out = null
    const code = reason === 'peer-offline' || reason === 'timeout' || reason === 'denied' || reason === 'visits-off'
      ? reason
      : 'peer-offline'
    const notice = pushNotice(visitReasonText(code, out.nickname), now)
    return {
      ok: true,
      error: code,
      deviceId: out.deviceId,
      nickname: out.nickname,
      visitId: out.visitId,
      notice: notice === null ? null : notice.text
    }
  }

  /** 本地决定：只改内存，返回给 service 落盘的东西。 */
  function decide (rawDeviceId, status) {
    const deviceId = normalizeDeviceId(rawDeviceId)
    if (deviceId === null) return { ok: false, error: 'bad-device-id' }
    const neighbor = state.neighbors.get(deviceId)
    const nickname = neighbor?.nickname ??
      state.trust.allowed.get(deviceId) ??
      state.trust.denied.get(deviceId)
    if (nickname === undefined) return { ok: false, error: 'unknown-neighbor' }

    if (status === 'allowed') {
      state.trust.allowed.set(deviceId, nickname)
      state.trust.denied.delete(deviceId)
    } else {
      state.trust.denied.set(deviceId, nickname)
      state.trust.allowed.delete(deviceId)
    }
    removePrompt(deviceId)
    state.snoozed.delete(deviceId)
    if (neighbor !== undefined) {
      neighbor.status = status
      // 信任一变，旧的“对方放行了我”就不再可信：等下一次心跳重新证明。
      neighbor.heartbeatAt = 0
    }
    // 街上那一户的灰态理由要跟着信任走：刚放行的人不该继续写着“还没放行你”。
    // 但只改状态，不动 lastSeen——放行不是一次“见到他”，编一个时间出来会让他
    // 在街上多赖十分钟。
    retrustSeen(deviceId, status)
    // 拒绝是即时的：不用等 30 秒 TTL，那位的心跳影子与串门访客现在就离开桌面。
    if (status === 'denied') {
      state.guests.delete(deviceId)
      dropInboundVisitor(deviceId, nowMs())
      // ticket 44 / D7：信任收紧时合同立即结束（钱等重新放行后结算），
      // 绝不让一个已经不被放行的雇工继续提供 0.5 守卫。
      const now = nowMs()
      if (state.worker !== null && state.worker.workerDeviceId === deviceId) {
        finishWorker(state.worker.contractId, {
          at: now,
          reason: 'denied',
          notice: `「${state.worker.workerNickname}」不再被放行，雇工已经离开。`
        })
      }
      if (state.work !== null && state.work.employerDeviceId === deviceId) {
        finishWorking(state.work.contractId, {
          at: now,
          reason: 'denied',
          notice: `「${state.work.employerNickname}」不再被放行，宠物回来了。`
        })
      }
    }

    return {
      ok: true,
      deviceId,
      nickname,
      status,
      at: nowMs()
    }
  }

  return {
    snapshot () {
      const activity = activityInfo()
      const targets = currentVisitTargets()
      return {
        version: 1,
        self: {
          deviceId: state.self.deviceId,
          nickname: state.self.nickname,
          pet: selfPetView(),
          bridge: { ...state.self.bridge },
          out: copyOutbound(state.out),
          // ticket 44：在外打工时 out 一定是 null，两者互斥。
          work: copyWork(state.work)
        },
        neighbors: [...state.neighbors.values()].map((neighbor) => ({ ...neighbor })),
        guests: [...state.guests.values()].map((guest) => ({
          deviceId: guest.deviceId,
          nickname: guest.nickname,
          anim: guest.anim,
          since: guest.since,
          // 心跳影子的到期时刻（最后一次心跳 + 30 秒）。v2 不画 guests，只在 TTL 到点时移除。
          expiresAt: guest.lastSeen + GUEST_TTL_MS
        })),
        visitors: [...state.visitors.values()].map(copyVisitor),
        // ticket 44：雇工画在访客之前（场景顺序 = DOM 顺序，访客在上层）。
        worker: copyWorker(state.worker),
        visits: state.visits.slice(0, 5).map(copyRecord),
        prompt: currentPrompt(),
        notices: state.notices.slice(0, 3).map((notice) => ({ ...notice })),
        acceptVisits: state.acceptVisits,
        autoVisit: {
          enabled: state.autoVisits,
          activitySource: activity.source,
          lastActivityAt: activity.at,
          lastDepartureAt: state.lastDepartureAt,
          lastDecision: copyDecision(state.lastPolicyDecision)
        },
        visitTargets: targets,
        // 街上每一户：能去的在前，去不了的各有理由（ticket 20）。只读视图，远端写不进来。
        street: streetFrom({
          now: nowMs(),
          targets,
          neighbors: [...state.neighbors.values()],
          guests: [...state.guests.values()],
          recentSeen: [...state.recentSeen.values()]
        }),
        // 「串门」为什么没有目标：no-admitted / no-online / null（有目标）。
        // 和 noVisitTarget() 的 notice 用同一个判定，按钮的置灰理由因此不会和气泡打架。
        visitBlockedReason: visitBlockedReason()
      }
    },

    /** 本机身份（来自 src/identity.js）；deviceId 永不由网络输入写入。 */
    setIdentity ({ deviceId, nickname } = {}) {
      if (typeof deviceId === 'string') {
        const id = deviceId.trim()
        if (id !== '' && id.length <= 64) state.self.deviceId = id
      }
      const label = normalizeNickname(nickname)
      if (label !== null) state.self.nickname = label
    },

    setSelfNickname (nickname) {
      const label = normalizeNickname(nickname)
      if (label !== null) state.self.nickname = label
    },

    /**
     * 本地影子的动作。`{ name, anim }` 里的 anim 只可能来自 dsh-pet 的
     * `/state`（本地回环，不是网络）；这里仍然按不可信形状校验一遍。
     *
     * 名字和昵称是同一个东西，共用一个上限（`normalizeNickname`，32 码点）——
     * 显示得比广播长，就等于又造出两个名字。
     */
    setSelfPet (pet) {
      if (pet === null || typeof pet !== 'object') {
        state.self.pet = null
        return
      }
      const name = normalizeNickname(pet.name)
      const anim = isSafeAnimationName(pet.anim) ? pet.anim.trim() : null
      state.self.pet = name === null && anim === null ? null : { name, anim }
    },

    /**
     * 本机宠物插件推来的「我现在在干嘛」。只接受安全动作名、固定语义枚举、
     * ≤80 字且 30 秒内过期的气泡；全非法就不写，返回 false。
     */
    setSelfState ({ action, semantic, say } = {}) {
      const safeAction = isSafeAnimationName(action) ? action.trim() : null
      const safeSemantic = normalizeSemantic(semantic)
      const safeSay = normalizeSay(say, nowMs())
      if (safeAction === null && safeSemantic === null && safeSay === null) return false
      state.selfState = { action: safeAction, semantic: safeSemantic, say: safeSay, at: nowMs() }
      return true
    },

    /** dsh-pet 桥的可用性；只用于 UI 那一行降级说明。 */
    setBridge ({ ok, reason } = {}) {
      if (ok === true) {
        state.self.bridge = { ok: true, reason: null }
        return
      }
      const safeReason = BRIDGE_REASONS.has(reason) ? reason : 'unreachable'
      state.self.bridge = { ok: false, reason: safeReason }
    },

    /**
     * 本机“允许串门”开关（来自 src/settings.js，默认开）。
     * 只影响入站 visit-request；发现、心跳与本机出门都不变。
     */
    setAcceptVisits (enabled) {
      if (typeof enabled === 'boolean') state.acceptVisits = enabled
      return state.acceptVisits
    },

    /**
     * 自发出门的总开关（ticket 09，来自 src/settings.js，默认关）。
     * 关掉时绝不自动出门；手动「串门」不受影响。
     */
    setAutoVisits (enabled) {
      if (typeof enabled === 'boolean') state.autoVisits = enabled
      return state.autoVisits
    },

    /**
     * 记录一次本机活动。来源只有两种：session（宿主 session/event，主信号）
     * 与 pointer（桌面 helper 的指针活动，兜底）。同一来源只前进不后退，
     * 这样时钟回拨/乱序回调不会把“刚刚活动过”抹掉。
     *
     * 返回 `{ at, source }`：source 是当前**更近**的那个信号；两个都没有时 at=null。
     */
    noteActivity (source, at = clock()) {
      if (!ACTIVITY_SOURCES.has(source)) return null
      const stamp = stampOf(at)
      const current = state.activity[source]
      if (current === null || stamp > current) state.activity[source] = stamp
      return activityInfo()
    },

    /**
     * 跑一次自发出门策略。纯函数在 src/visit-policy.js；这里只负责把 room 的
     * 邻居表、活动、上次出门与开关喂进去，并给结果补上活动来源。
     */
    spontaneousVisitPlan (random = Math.random) {
      const activity = activityInfo()
      const plan = planVisitPolicy({
        now: nowMs(),
        enabled: state.autoVisits,
        lastActivityAt: activity.at,
        lastDepartureAt: state.lastDepartureAt,
        neighbors: [...state.neighbors.values()],
        // ticket 44：在外打工和出门串门一样，都不能再自发/手动出门。
        alreadyOut: state.out !== null || state.work !== null,
        random
      })
      return { ...plan, activitySource: activity.source }
    },

    /** 把最近一次策略判定留在快照里，回答“为什么没出门”。 */
    notePolicyDecision (plan, at = clock()) {
      const now = stampOf(at)
      if (plan === null || typeof plan !== 'object') {
        state.lastPolicyDecision = null
        return null
      }
      state.lastPolicyDecision = copyDecision({
        ...plan,
        at: Number.isFinite(plan.at) ? plan.at : now
      })
      return state.lastPolicyDecision
    },

    /** 手动「串门」可用的邻居：在线且互相放行。顺序稳定（邻居表插入序）。 */
    visitTargets () {
      return currentVisitTargets()
    },

    /** 手动「串门」：从 visitTargets 里随机挑一位；没有返回 null。 */
    pickVisitTarget (random = Math.random) {
      return pickPolicyTarget([...state.neighbors.values()], { now: nowMs(), random })
    },

    /** 手动「串门」但没有目标：区分“没人放行”与“放行了但都不在线”。 */
    noVisitTarget (at = clock()) {
      const reason = visitBlockedReason()
      return failWithNotice(reason ?? 'no-admitted', null, at)
    },

    /**
     * 宿主发现一次场景放不下所有访客时调用（ticket 10 的“不设同屏上限”遇到渲染端的
     * 单包上限）。写一条人话提示，让人知道桌面上少画了几位，而不是以为它们凭空消失。
     *
     * 同一次拥挤只提醒一次；`dropped` 回到 0 表示拥挤解除，下一次再提醒。
     * 返回这次是否真的写了一条 notice。
     */
    noteSceneOverflow (dropped, at = clock()) {
      const count = Number(dropped)
      if (!Number.isInteger(count) || count <= 0) {
        state.overflowNotified = false
        return null
      }
      if (state.overflowNotified) return null
      state.overflowNotified = true
      return pushNotice(`桌面上放不下这么多访客，还有 ${count} 位没有画出来。`, at)
    },

    /**
     * 载入持久化的放行/拒绝名单（src/peers.js 的 trust() 形状）。
     * 名单只按 deviceId 认；这里的昵称仅用于拒绝记录/后续提示。
     * 已有的邻居会被重新对齐，所以启动顺序无关紧要。
     */
    setTrust (trust = {}) {
      const allowed = readTrust(trust?.allowed)
      const denied = readTrust(trust?.denied)
      for (const deviceId of denied.keys()) allowed.delete(deviceId)
      state.trust.allowed = allowed
      state.trust.denied = denied

      for (const [deviceId, neighbor] of state.neighbors) {
        if (allowed.has(deviceId)) {
          neighbor.status = 'allowed'
          removePrompt(deviceId)
          state.snoozed.delete(deviceId)
        } else if (denied.has(deviceId)) {
          neighbor.status = 'denied'
          neighbor.heartbeatAt = 0
          removePrompt(deviceId)
          state.snoozed.delete(deviceId)
        } else if (neighbor.status !== 'pending') {
          // 名单被手改短了：退回待放行，下次广播重新询问。
          neighbor.status = 'pending'
          neighbor.heartbeatAt = 0
          enqueuePrompt(deviceId)
        }
      }
      // 手改名单收紧后，已经不在 allowed 里的心跳影子与串门访客立即离开桌面。
      for (const deviceId of state.guests.keys()) {
        if (!allowed.has(deviceId) || denied.has(deviceId)) state.guests.delete(deviceId)
      }
      for (const deviceId of [...state.visitors.keys()]) {
        if (!allowed.has(deviceId) || denied.has(deviceId)) dropInboundVisitor(deviceId, nowMs())
      }
      // ticket 44：手改名单收紧同样立即结束合同（D7）。
      if (state.worker !== null && !allowed.has(state.worker.workerDeviceId)) {
        finishWorker(state.worker.contractId, { at: nowMs(), reason: 'denied' })
      }
      if (state.work !== null && !allowed.has(state.work.employerDeviceId)) {
        finishWorking(state.work.contractId, { at: nowMs(), reason: 'denied' })
      }
      purgePrompts()
    },

    /**
     * 收到一条通过协议校验的邻居报文。只更新内存里的邻居表：
     * 远端字段在这里的唯一效果是“渲染”和“邻居灯”，不触发任何 I/O。
     * 第一次见到的 deviceId 会进放行队列；已放行/已拒绝的不会再问。
     */
    observeBeacon (peer, at = clock()) {
      if (peer === null || typeof peer !== 'object') return
      const deviceId = typeof peer.deviceId === 'string' ? peer.deviceId.trim() : ''
      if (deviceId === '' || deviceId.length > 64) return
      if (state.self.deviceId !== null && deviceId === state.self.deviceId) return

      const nickname = normalizeNickname(peer.nickname)
      if (nickname === null) return
      const lastSeen = Number.isFinite(at) ? at : clock()
      const port = isPort(peer.port) ? peer.port : null

      const existing = state.neighbors.get(deviceId)
      if (existing !== undefined) {
        existing.nickname = nickname
        existing.lastSeen = lastSeen
        if (port !== null) existing.port = port
        // 广播只证明“它在线”，不证明“它放行了我”；heartbeatAt 只能由心跳刷新。
        if (!Number.isFinite(existing.heartbeatAt)) existing.heartbeatAt = 0
        // 队列满时没排上的邻居，等下一次广播再试（不重复入队）。
        if (existing.status === 'pending') enqueuePrompt(deviceId)
        rememberSeen({ deviceId, nickname, lastSeen, status: existing.status })
        return
      }
      if (state.neighbors.size >= MAX_NEIGHBORS) return

      const status = state.trust.allowed.has(deviceId)
        ? 'allowed'
        : state.trust.denied.has(deviceId) ? 'denied' : 'pending'
      state.neighbors.set(deviceId, { deviceId, nickname, status, lastSeen, port, heartbeatAt: 0 })
      if (status === 'pending') enqueuePrompt(deviceId)
      rememberSeen({ deviceId, nickname, lastSeen, status })
    },

    /**
     * 收到一条通过协议校验的邻居心跳。心跳只带 anim；昵称从邻居表或放行名单取，
     * 所以远端无法用心跳改名字、改信任或改本地影子。
     *
     * 未放行/已拒绝/自己的心跳直接丢弃。放行的心跳创建或刷新心跳影子，
     * 同时刷新邻居的 lastSeen（心跳也证明它还活着）。返回是否被接受。
     * 心跳还会顺手更新同名串门访客的动作与 lastSeen，但不延长任何时间上限
     * （入站访客根本没有上限，出门的上限固定在 30 分钟）。
     */
    observeHeartbeat (peer, at = clock()) {
      if (peer === null || typeof peer !== 'object') return false
      const deviceId = normalizeDeviceId(peer.deviceId)
      if (deviceId === null || !canTalkTo(deviceId)) return false

      const neighbor = state.neighbors.get(deviceId)
      const nickname = normalizeNickname(neighbor?.nickname ?? state.trust.allowed.get(deviceId))
      if (nickname === null) return false
      const anim = normalizeAnimation(peer.anim)
      // 心跳带来的不止动作片段：动作名和一句话都留着，街上的那一户要念出来（ticket 20）。
      const action = normalizeAnimation(peer.action)
      const say = normalizeSay(peer.say, nowMs())
      const lastSeen = Number.isFinite(at) ? at : clock()

      const existing = state.guests.get(deviceId)
      if (existing !== undefined) {
        existing.nickname = nickname
        existing.anim = anim
        existing.action = action
        existing.say = say
        existing.lastSeen = lastSeen
      } else {
        if (state.guests.size >= MAX_GUESTS) evictStalestGuest()
        state.guests.set(deviceId, {
          deviceId, nickname, anim, action, say, since: lastSeen, lastSeen
        })
      }
      rememberSeen({ deviceId, nickname, lastSeen, status: 'allowed' })

      const visiting = state.visitors.get(deviceId)
      if (visiting !== undefined) {
        visiting.nickname = nickname
        visiting.anim = anim
        // ticket 10 的唯一自动清理依据：2 分钟没有心跳 = 对方失联。
        // 心跳不延长任何 TTL（入站访客没有 TTL），只证明“它还在”。
        visiting.lastSeen = lastSeen
      }

      // 我在对方家时，对方的心跳是“它还在”的唯一证据；ticket 09 的失联回家靠这一行。
      if (state.out !== null && state.out.deviceId === deviceId) {
        state.out.lastSeen = lastSeen
      }

      // ticket 44：合同期内的心跳同样只证明「它还在」——雇主/雇工失联按最后心跳结算。
      if (state.work !== null && state.work.employerDeviceId === deviceId) {
        state.work.lastSeen = lastSeen
      }
      if (state.worker !== null && state.worker.workerDeviceId === deviceId) {
        state.worker.lastSeen = lastSeen
        state.worker.anim = anim
        state.worker.nickname = nickname
      }

      // 心跳证明这位邻居还在线，也证明它放行了我：邻居灯不用等下一次 5 秒广播，
      // 串门目标表也不用猜“对方到底放没放行我”。
      markPeerHeartbeat(deviceId, nickname, lastSeen)
      return true
    },

    /**
     * 本地接受/拒绝。只改内存并返回一条决定；service 拿它去写 peers.json。
     * 只按 deviceId 认，不看 IP；拒绝会覆盖之前的放行，反之亦然。
     */
    admit (deviceId) {
      return decide(deviceId, 'allowed')
    },

    reject (deviceId) {
      return decide(deviceId, 'denied')
    },

    /** 用户点了“稍后再说”：本次队列前进，这位邻居安静十分钟再问。 */
    dismissPrompt (deviceId) {
      const id = normalizeDeviceId(deviceId)
      if (id === null) return { ok: false, error: 'bad-device-id' }
      if (state.prompts[0] !== id) return { ok: false, error: 'not-prompt' }
      removePrompt(id)
      state.snoozed.set(id, nowMs() + PROMPT_SNOOZE_MS)
      return { ok: true, deviceId: id, prompt: currentPrompt() }
    },

    /**
     * 唯一的出站门控：只有本机放行过的邻居才允许收心跳/串门请求。
     * ticket 04 的心跳发送必须调用它；本文件不实现心跳。
     */
    mayTalkTo (deviceId) {
      return canTalkTo(deviceId)
    },

    /**
     * 心跳收件人：放行名单里的所有 deviceId。地址不在这一层，
     * discovery.sendTo() 会再查一次地址并把没有地址的（还没发现/已离线）静默丢掉。
     */
    heartbeatTargets () {
      return [...state.trust.allowed.keys()].filter((deviceId) => canTalkTo(deviceId))
    },

    /**
     * 开始一次出门（ticket 05）。visitId 由 service 用 randomUUID 生成；
     * 这一层只校验形状，不生成随机数，也不查地址（地址检查在 service）。
     *
     * 同一只宠物只能有一次出门。失败时返回 { ok:false, error } 并写一条人话 notice：
     * not-admitted / peer-offline / already-out / starting。
     */
    beginVisit (rawDeviceId, { at = clock(), visitId } = {}) {
      const now = stampOf(at)
      if (state.self.deviceId === null) return failWithNotice('starting', null, now)
      if (state.out !== null) {
        // 错误码统一是 already-out；提示文案按“在路上/已经到了”细分，用户看到的不是 code。
        const name = state.out.nickname
        const text = state.out.phase === 'requesting'
          ? `宠物正在去「${name}」家的路上，等一等。`
          : `宠物已经在「${name}」家了，先召回来再说。`
        const notice = pushNotice(text, now)
        return { ok: false, error: 'already-out', notice: notice === null ? null : notice.text }
      }

      if (state.work !== null) {
        // ticket 44：合同期内不能串门（与 beginWorking 的 already-out 对称）。
        const notice = pushNotice('宠物在外打工，合同结束前不能去串门。', now)
        return { ok: false, error: 'already-working', notice: notice === null ? null : notice.text }
      }

      const deviceId = normalizeDeviceId(rawDeviceId)
      if (deviceId === null) return { ok: false, error: 'bad-device-id' }
      if (!isVisitId(visitId)) return { ok: false, error: 'bad-visit-id' }

      const neighbor = state.neighbors.get(deviceId)
      if (!canTalkTo(deviceId)) {
        if (neighbor === undefined) return failWithNotice('peer-offline', null, now)
        return failWithNotice('not-admitted', neighbor.nickname, now)
      }

      const nickname = normalizeNickname(
        neighbor?.nickname ?? state.trust.allowed.get(deviceId)
      ) ?? FALLBACK_NICKNAME

      state.out = {
        deviceId,
        nickname,
        visitId: visitId.toLowerCase(),
        phase: 'requesting',
        startedAt: now,
        endsAt: null,
        lastSeen: now,
        // 这次出门捎的东西（ticket 27）。只进记录、不进快照；sendVisitRequest 成功后才由
        // service 用 markOutboundGift 填上（编码层丢掉 gift 时就不会误记成“带上了”）。
        gift: null
      }
      // 冷却从“开始出门”算，而不是从 ack 算：即使这次请求最终失败，
      // 宠物也已经试过一次，不该在 30 秒后的下一轮策略里再试一次。
      state.lastDepartureAt = now
      return { ok: true, visit: copyOutbound(state.out) }
    },

    /**
     * 本机出门失败（service 发现没地址、重试三次没 ack 等）。
     * 只清掉还在请求中的状态；已经抵达的串门必须走 recallOutbound / tick。
     */
    failOutboundVisit (reason, at = clock()) {
      return failOutbound(reason, at)
    },

    /**
     * 收到 visit-ack：请求中 → 已抵达，开始 30 分钟上限。
     * 只接受来自当前出门目标的、同 visitId 的 ack；其余静默。
     */
    observeVisitAck (peer, at = clock()) {
      const deviceId = normalizeDeviceId(peer?.deviceId)
      const visitId = normalizeVisitId(peer?.visitId)
      if (deviceId === null || visitId === null) return { ok: false, error: 'bad-packet' }
      const out = state.out
      if (out === null || out.phase !== 'requesting') return { ok: false, error: 'no-visit' }
      if (out.deviceId !== deviceId || out.visitId !== visitId) {
        return { ok: false, error: 'no-visit' }
      }

      const now = stampOf(at)
      out.phase = 'active'
      out.startedAt = now
      out.endsAt = now + maxVisitMs
      out.lastSeen = now
      refreshNeighbor(deviceId, now)
      return { ok: true, visit: copyOutbound(out) }
    },

    /** 收到 visit-deny：请求中 → 明确失败；理由决定提示文案（没放行 / 关掉了串门）。 */
    observeVisitDeny (peer, at = clock()) {
      const deviceId = normalizeDeviceId(peer?.deviceId)
      const visitId = normalizeVisitId(peer?.visitId)
      if (deviceId === null || visitId === null) return { ok: false, error: 'bad-packet' }
      const out = state.out
      if (out === null || out.deviceId !== deviceId || out.visitId !== visitId) {
        return { ok: false, error: 'no-visit' }
      }
      const reason = peer?.reason === 'visits-off' ? 'visits-off' : 'denied'
      return failOutbound(reason, at)
    },

    /**
     * 收到 visit-recall，两个方向都处理：
     * - 我是发起方：对方让我回家，已抵达写 out 记录；请求中直接取消，不写记录。
     * - 我是接收方：对方到点/被召回，入站访客立即清场并写 in 记录。
     * 任何一侧都不再回一条 recall——对方已经知道这次串门结束了。
     */
    observeVisitRecall (peer, at = clock()) {
      const deviceId = normalizeDeviceId(peer?.deviceId)
      const visitId = normalizeVisitId(peer?.visitId)
      if (deviceId === null || visitId === null) return { ok: false, error: 'bad-packet' }
      const now = stampOf(at)
      const out = state.out

      // 发起方收到“回家”：结束出门，写 out 记录，不再回 recall。
      if (out !== null && out.deviceId === deviceId && out.visitId === visitId) {
        if (out.phase === 'requesting') {
          state.out = null
          return {
            ok: true,
            side: 'out',
            cancelled: true,
            visit: copyOutbound(out),
            record: null
          }
        }
        const finished = finishOutbound({
          at: now,
          notifyRemote: false,
          notice: `「${out.nickname}」结束了这次串门，宠物回来了。`
        })
        return {
          ok: true,
          side: 'out',
          cancelled: false,
          visit: finished.visit,
          record: finished.record
        }
      }

      // 接收方收到“召回”：对方到点/被召回/送客，访客立即清场并写 in 记录。
      // 同一设备只有一位访客，所以按 deviceId 认即可；迟到的 recall（携带旧
      // visitId）也能立刻清场，不必等 2 分钟失联检测。不回 recall——对方已经知道了。
      const visitor = state.visitors.get(deviceId)
      if (visitor !== undefined) {
        state.visitors.delete(deviceId)
        rememberEndedInboundGift(visitor)
        const record = recordVisit('in', visitor.nickname, visitor.since, now, visitor.gift)
        return {
          ok: true,
          side: 'in',
          cancelled: false,
          visit: copyVisitor(visitor),
          record
        }
      }
      return { ok: false, error: 'no-visit' }
    },

    /**
     * 收到 visit-request。本机“允许串门”关着时一律回 visits-off；只有放行过的
     * 来源会得到 ack，其余回 not-admitted（明确失败）。deny 都不创建访客、不写记录。
     * 同一来源的重复请求（重试）按 visitId 幂等处理：原地刷新 id/动作/lastSeen，
     * 不重置 since，也绝不多写一条记录。
     *
     * 礼物（ticket 23）只是访客身上的一个可选字段：坏 gift 在协议层已经被丢掉，
     * 这里再丢一次也**不影响 ack**——访客该进门还是进门。
     */
    observeVisitRequest (peer, at = clock()) {
      if (peer === null || typeof peer !== 'object') {
        return { reply: 'ignore', error: 'bad-packet' }
      }
      const deviceId = normalizeDeviceId(peer.deviceId)
      const visitId = normalizeVisitId(peer.visitId)
      if (deviceId === null || visitId === null) {
        return { reply: 'ignore', error: 'bad-visit' }
      }
      // 开关先于信任判断：关掉时连已放行的邻居也进不来，理由对发起方是明确的。
      if (!state.acceptVisits) {
        return { reply: 'deny', deviceId, visitId, reason: 'visits-off' }
      }
      if (!canTalkTo(deviceId)) {
        // 未知/未放行/已拒绝：给发起方一句明确的 deny，不创建任何本机状态。
        return { reply: 'deny', deviceId, visitId, reason: 'not-admitted' }
      }

      const now = stampOf(at)
      const neighbor = state.neighbors.get(deviceId)
      const nickname = normalizeNickname(
        neighbor?.nickname ?? state.trust.allowed.get(deviceId) ?? peer.nickname
      ) ?? FALLBACK_NICKNAME
      const anim = normalizeAnimation(peer.anim)
      const gift = visitorGift(peer.gift)

      const existing = state.visitors.get(deviceId)
      if (existing !== undefined) {
        // 重试或“上一次的 ack 丢了”：保留原来的 since，不重复计一次串门；
        // 请求本身证明对方还活着，所以 lastSeen 跟着刷新。
        existing.visitId = visitId
        existing.nickname = nickname
        existing.anim = anim
        existing.lastSeen = now
        // 重发的是同一件礼物：状态（可能已经 received）原样保留，绝不退回 pending，
        // 否则每丢一包 ack，桌面上的卡片就会闪一下“正在收下”。
        // 换了一件新的：换卡；没带礼物：这次访客身上原来那件留着（东西已经在磁盘上了）。
        if (gift !== null && existing.gift?.id !== gift.id) existing.gift = gift
        refreshNeighbor(deviceId, now)
        return {
          reply: 'ack',
          deviceId,
          visitId,
          nickname,
          visit: copyVisitor(existing)
        }
      }

      // ticket 10：入站访客没有 TTL、没有同屏上限，来多少留多少，直到主人「送客」
      // 或对方 2 分钟没有心跳。内存仍有界：只有放行名单里的 deviceId 能走到这里。
      const visitor = {
        deviceId,
        visitId,
        nickname,
        anim,
        since: now,
        lastSeen: now,
        ...(gift === null ? {} : { gift })
      }
      state.visitors.set(deviceId, visitor)
      refreshNeighbor(deviceId, now)
      return { reply: 'ack', deviceId, visitId, nickname, visit: copyVisitor(visitor) }
    },

    /**
     * 本地召回（用户点“召回”，或 service 的 30 分钟 tick 调过来）。
     * 已抵达 → 写 out 记录并排一条 visit-recall；还在请求中 → 只是取消，不写记录。
     */
    recallOutbound (at = clock()) {
      const out = state.out
      if (out === null) return failWithNotice('not-out', null, at)
      const now = stampOf(at)
      const wasRequesting = out.phase === 'requesting'
      const finished = finishOutbound({ at: now, notifyRemote: !wasRequesting })
      return {
        ok: true,
        cancelled: wasRequesting,
        visit: finished.visit,
        record: finished.record
      }
    },

    /**
     * 只读查询（ticket 43）：visitId → 当前入站访客（拷贝）。
     * 非法/没找到都返回 null；路由与 farm-action 授权据此 404 / 静默丢弃。
     */
    visitorByVisitId (rawVisitId) {
      return findVisitorByVisitId(rawVisitId)
    },

    /** 这次 farm-action 是否来自当前访客本人（deviceId + visitId 双证）。 */
    isVisitorVisit (rawDeviceId, rawVisitId) {
      const deviceId = normalizeDeviceId(rawDeviceId)
      if (deviceId === null) return false
      const visitor = findVisitorByVisitId(rawVisitId)
      if (visitor === null) return false
      // 协议层已把 deviceId 归一成小写；这里再兜一次大小写，避免直接调用方传大写时误拒。
      return visitor.deviceId.toLowerCase() === deviceId.toLowerCase()
    },

    /**
     * 主人点「送客」：立刻结束一位入站访客（ticket 10）。
     * 写 in 记录并排一条 visit-recall 让对方也回家；对方收不到也没关系，
     * 它会靠自己的 2 分钟失联检测或 30 分钟出门上限回来。
     */
    endInboundVisit (rawDeviceId, at = clock()) {
      const deviceId = normalizeDeviceId(rawDeviceId)
      if (deviceId === null) return { ok: false, error: 'bad-device-id' }
      const visitor = state.visitors.get(deviceId)
      if (visitor === undefined) return failWithNotice('no-visitor', null, at)

      const now = stampOf(at)
      state.visitors.delete(deviceId)
      rememberEndedInboundGift(visitor)
      const record = recordVisit('in', visitor.nickname, visitor.since, now, visitor.gift)
      state.pendingRecalls.push({ deviceId: visitor.deviceId, visitId: visitor.visitId })
      return {
        ok: true,
        deviceId: visitor.deviceId,
        visitId: visitor.visitId,
        nickname: visitor.nickname,
        record
      }
    },

    /**
     * service 把字条/文件写进磁盘之后回报状态（ticket 23 / 25）。只认这位访客身上的那一件：
     * 访客已经走了 / 礼物已经被换掉 / giftId 对不上，都返回 false 而不是顺手造一张卡。
     *
     * status 由 gift-text 的固定词表校验；presentation 的文案表同时是这里的状态词表，
     * 免得两处各有一份、迟早对不上。`reason`（ticket 25）只用于 failed/refused 的状态行，
     * 取值同样来自固定词表，绝不把任意字符串带进快照。
     */
    markGiftStatus (rawDeviceId, rawGiftId, status, reason = null) {
      if (!isGiftStatus(status)) return false
      const deviceId = normalizeDeviceId(rawDeviceId)
      if (deviceId === null) return false
      const giftId = typeof rawGiftId === 'string' ? rawGiftId.trim().toLowerCase() : ''
      if (!isVisitId(giftId)) return false
      const visitor = state.visitors.get(deviceId)
      if (visitor === undefined || visitor.gift === undefined) return false
      if (visitor.gift.id !== giftId) return false
      visitor.gift.status = status
      if (typeof reason === 'string' && isGiftReason(reason) && (status === 'failed' || status === 'refused')) {
        visitor.gift.reason = reason
      } else {
        delete visitor.gift.reason
      }
      return true
    },

    /**
     * 主人点了「扔掉」：卡片立刻消失，并记住这个 giftId（本次运行内不再出现）。
     * 磁盘删除由 service 负责；这里只改内存，磁盘不归它管。
     *
     * `deviceId` 可以为空：礼物还没落盘（pending / receiving / failed / refused）时，
     * service 查不到 `from.deviceId`，这时按 giftId 找到那张卡——卡片必须能扔掉。
     */
    discardGift (rawDeviceId, rawGiftId) {
      const giftId = typeof rawGiftId === 'string' ? rawGiftId.trim().toLowerCase() : ''
      if (!isVisitId(giftId)) return false
      rememberDiscardedGift(giftId)
      const deviceId = normalizeDeviceId(rawDeviceId)
      let visitor = null
      if (deviceId !== null) {
        visitor = state.visitors.get(deviceId) ?? null
      } else {
        for (const candidate of state.visitors.values()) {
          if (candidate.gift?.id === giftId) {
            visitor = candidate
            break
          }
        }
      }
      if (visitor === null || visitor.gift === undefined) return false
      if (visitor.gift.id !== giftId) return false
      delete visitor.gift
      return true
    },

    /** 这件礼物是不是已经被「扔掉」了：service 据此不再把重试报文重新写回磁盘。 */
    isGiftDiscarded (rawGiftId) {
      const giftId = typeof rawGiftId === 'string' ? rawGiftId.trim().toLowerCase() : ''
      return isVisitId(giftId) && state.discardedGifts.has(giftId)
    },

    /** 本机这次的礼物没带上（太长/整包超 4 KiB）：留一句人话，串门照常。 */
    noteGiftDropped (at = clock()) {
      return pushNotice(giftDroppedText(), at)
    },

    /**
     * 背包里那件东西这次带不上（文件被删/读不了）：留一句人话，串门照常。
     * 文案由 service 从 `gift-text.js` 取，room 只负责排进快照。
     */
    noteGiftMissed (text, at = clock()) {
      if (typeof text !== 'string' || text.trim() === '') return null
      return pushNotice(text.trim(), at)
    },

    /**
     * 农场事件（ticket 43）：偷/帮/被抓都由 service 拼好一句人话，room 只负责排进快照。
     * 和 `noteGiftMissed` 同一条出口：文案清洗与长度上限都在 `pushNotice` 里。
     */
    noteFarmEvent (text, at = clock()) {
      if (typeof text !== 'string' || text.trim() === '') return null
      return pushNotice(text.trim(), at)
    },

    /** 对方回执到了（ticket 26）：发起方把「收下了」说一句。 */
    noteGiftReceived (nickname, at = clock()) {
      return pushNotice(giftReceivedText(nickname), at)
    },

    /** 串门结束还没等到回执（ticket 26）：东西已经退回背包，这一句必须说清楚。 */
    noteGiftNotReceived (at = clock()) {
      return pushNotice(giftNotReceivedText(), at)
    },

    /**
     * 送客提醒（ticket 26）：这件礼物一次都没打开过，东西还留在 gifts 里。
     * “到底打没打开”在磁盘的 meta.json 上，所以判断留给 service，这里只说一句。
     */
    noteGiftLeftBehind (nickname, at = clock()) {
      return pushNotice(giftLeftBehindText(nickname), at)
    },

    /**
     * 记下这次出门真正带上路的那件礼物（ticket 27）。由 service 在 visit-request
     * 编码成功之后调用：编码层丢掉 gift 时传 null，记录里就不会出现一件没带上的东西。
     * 只认当前这次 visitId，迟到/旧的调用什么也不改。
     */
    markOutboundGift (rawVisitId, gift) {
      const visitId = normalizeVisitId(rawVisitId)
      if (visitId === null || state.out === null || state.out.visitId !== visitId) return false
      const clean = normalizeVisitGift(gift)
      state.out.gift = clean
      return true
    },

    // -------------------------------------------------------------------------
    // 雇佣合同（ticket 44）：两个纯镜像。钱的真相在 contracts.json；这一层只回答
    // 「谁在哪、还有多久、守卫多少」，结束事件排队给 service。
    // -------------------------------------------------------------------------

    /** 我的宠物开始在外打工。与出门串门互斥（already-out / already-working）。 */
    beginWorking (contract = {}, at = clock()) {
      const now = stampOf(at)
      if (state.self.deviceId === null) return { ok: false, error: 'starting' }
      if (state.out !== null) {
        const notice = pushNotice('宠物正在串门，等它回来再接这份工作。', now)
        return { ok: false, error: 'already-out', notice: notice === null ? null : notice.text }
      }
      if (state.work !== null) return { ok: false, error: 'already-working' }
      const contractId = normalizeVisitId(contract.contractId)
      const employerDeviceId = normalizeDeviceId(contract.employerDeviceId)
      if (contractId === null || employerDeviceId === null) return { ok: false, error: 'bad-contract' }
      const timing = normalizeContractTiming(
        Number(contract.startedAt),
        Number(contract.endsAt),
        contract.guard,
        now
      )
      if (timing === null) return { ok: false, error: 'bad-contract' }
      state.work = {
        contractId,
        employerDeviceId,
        employerNickname: normalizeNickname(contract.employerNickname) ?? FALLBACK_NICKNAME,
        startedAt: timing.startedAt,
        endsAt: timing.endsAt,
        guard: timing.guard,
        lastSeen: Number.isFinite(contract.lastSeen) ? contract.lastSeen : now
      }
      return { ok: true, work: copyWork(state.work) }
    },

    /** 本地结束「在外打工」：主人召回、收到 work-end/到期/失联。 */
    endWorking (rawContractId, options = {}) {
      // 兼容 `endWorking(id, at)` 与 `endWorking(id, { at, reason })` 两种调用。
      const { at = clock(), reason = 'recall' } = typeof options === 'number' ? { at: options } : options
      const contractId = normalizeVisitId(rawContractId)
      if (contractId === null) return false
      return finishWorking(contractId, { at: stampOf(at), reason })
    },

    /** 别人家的宠物进我家打工（雇主侧镜像）。一个农场只允许一位雇工。 */
    beginWorker (contract = {}, at = clock()) {
      const now = stampOf(at)
      if (state.self.deviceId === null) return { ok: false, error: 'starting' }
      if (state.worker !== null) return { ok: false, error: 'already-hired' }
      const contractId = normalizeVisitId(contract.contractId)
      const workerDeviceId = normalizeDeviceId(contract.workerDeviceId)
      if (contractId === null || workerDeviceId === null) return { ok: false, error: 'bad-contract' }
      if (state.self.deviceId !== null && workerDeviceId === state.self.deviceId) {
        return { ok: false, error: 'own-pet' }
      }
      const timing = normalizeContractTiming(
        Number(contract.startedAt),
        Number(contract.endsAt),
        contract.guard,
        now
      )
      if (timing === null) return { ok: false, error: 'bad-contract' }
      state.worker = {
        contractId,
        workerDeviceId,
        workerNickname: normalizeNickname(contract.workerNickname) ?? FALLBACK_NICKNAME,
        startedAt: timing.startedAt,
        endsAt: timing.endsAt,
        guard: timing.guard,
        anim: normalizeAnimation(contract.anim),
        lastSeen: Number.isFinite(contract.lastSeen) ? contract.lastSeen : now
      }
      return { ok: true, worker: copyWorker(state.worker) }
    },

    /** 本地结束「雇工在我家」：雇主提前结束、收到 work-recall/到期/失联。 */
    endWorker (rawContractId, options = {}) {
      const { at = clock(), reason = 'employer-end' } = typeof options === 'number' ? { at: options } : options
      const contractId = normalizeVisitId(rawContractId)
      if (contractId === null) return false
      return finishWorker(contractId, { at: stampOf(at), reason })
    },

    /** 当前「我在外打工」的镜像（拷贝）。 */
    outboundWork () {
      return copyWork(state.work)
    },

    /** `outboundWork` 的短别名（两种命名都有人用，保留一个实现）。 */
    working () {
      return copyWork(state.work)
    },

    /** 当前「别人在我家打工」的镜像（拷贝）。 */
    inboundWorker () {
      return copyWorker(state.worker)
    },

    /** `inboundWorker` 的短别名。 */
    worker () {
      return copyWorker(state.worker)
    },

    /** 房间已经清掉的合同事件；service 每次 flush 取走落盘 + 结算。 */
    drainEndedContracts () {
      const ended = state.completedContracts
      state.completedContracts = []
      return ended
    },

    /** 邻居表 → 放行名单 → null：合同记录/日志里的「谁」用。 */
    peerNickname (rawDeviceId) {
      const deviceId = normalizeDeviceId(rawDeviceId)
      if (deviceId === null) return null
      const neighbor = state.neighbors.get(deviceId)
      if (neighbor !== undefined) return neighbor.nickname
      return state.trust.allowed.get(deviceId) ?? null
    },

    /** 当前出门状态（拷贝），service 的重试计时器用它判断是否还该重发。 */
    outboundVisit () {
      return copyOutbound(state.out)
    },

    /** 完成但还没落盘的记录；service 每次 tick/action 后取走写 visits.json。 */
    drainVisitRecords () {
      const records = state.completedVisits
      state.completedVisits = []
      return records
    },

    /** 待发送的 visit-recall（本地召回/到期/接收方提前结束）。 */
    drainVisitRecalls () {
      const recalls = state.pendingRecalls
      state.pendingRecalls = []
      return recalls
    },

    /**
     * 刚结束的入站串门身上那件礼物（ticket 26）。service 取走后查 meta.opened，
     * 决定要不要留一句「捎来的东西还在 gifts 里」。
     */
    drainEndedInboundGifts () {
      const ended = state.endedInboundGifts
      state.endedInboundGifts = []
      return ended
    },

    /**
     * 载入持久化的串门记录（src/visits.js 的 records() 形状）。
     * 只读方向/昵称/开始时间/时长；按开始时间倒序，最多保留 200 条。
     */
    setVisitRecords (records) {
      const list = []
      if (Array.isArray(records)) {
        for (const raw of records) {
          const record = normalizeVisitRecord(raw)
          if (record !== null) list.push(record)
        }
      }
      list.sort((left, right) => right.startedAt - left.startedAt)
      state.visits = list.slice(0, VISIT_RECORD_LIMIT)
      state.completedVisits = []
    },

    /**
     * 每秒一次。四件互不依赖的清理：
     * - 已抵达的出门：30 分钟上限到点，或对方 2 分钟没有心跳（失联）；
     * - 入站访客：对方 2 分钟没有心跳（失联）才离开；没有时间上限；
     * - 心跳影子：30 秒没有心跳消失；
     * - 邻居：30 秒没有广播消失。
     * 返回值保持旧契约：被移除的邻居数。
     */
    tick (at = clock()) {
      const now = stampOf(at)

      if (state.out !== null && state.out.phase === 'active') {
        if (now >= state.out.endsAt) {
          // 30 分钟上限：正常到点回家，不是失败，不写提示。
          finishOutbound({ at: now, notifyRemote: true })
        } else if (now - state.out.lastSeen >= lostMs) {
          const nickname = state.out.nickname
          finishOutbound({
            at: now,
            notifyRemote: true,
            notice: `「${nickname}」失联了，宠物回来了。`
          })
        }
      }

      // ticket 10：入站访客没有 TTL，唯一的自动清场是“对方 2 分钟没有心跳”。
      for (const [deviceId, visitor] of state.visitors) {
        if (now - visitor.lastSeen >= lostMs) {
          state.visitors.delete(deviceId)
          rememberEndedInboundGift(visitor)
          recordVisit('in', visitor.nickname, visitor.since, now, visitor.gift)
          pushNotice(`「${visitor.nickname}」失联了，访客已经离开。`, now)
        }
      }

      // ticket 44：合同镜像的两条结束线——到期，或对方 2 分钟没有心跳。
      // 与访客不同：雇工不是访客，没有「送客」，只能结束合同并结算。
      if (state.worker !== null) {
        if (now >= state.worker.endsAt) {
          finishWorker(state.worker.contractId, { at: state.worker.endsAt, reason: 'expired' })
        } else if (now - state.worker.lastSeen >= lostMs) {
          const nickname = state.worker.workerNickname
          finishWorker(state.worker.contractId, {
            at: Math.min(state.worker.lastSeen, state.worker.endsAt),
            reason: 'offline',
            notice: `「${nickname}」失联了，雇工已经离开。`
          })
        }
      }
      if (state.work !== null) {
        if (now >= state.work.endsAt) {
          finishWorking(state.work.contractId, { at: state.work.endsAt, reason: 'expired' })
        } else if (now - state.work.lastSeen >= lostMs) {
          const nickname = state.work.employerNickname
          finishWorking(state.work.contractId, {
            at: Math.min(state.work.lastSeen, state.work.endsAt),
            reason: 'offline',
            notice: `「${nickname}」失联了，宠物回来了。`
          })
        }
      }

      for (const [deviceId, guest] of state.guests) {
        if (now - guest.lastSeen >= GUEST_TTL_MS) state.guests.delete(deviceId)
      }
      for (const [deviceId, seen] of state.recentSeen) {
        if (!Number.isFinite(seen.lastSeen) || now - seen.lastSeen > STALE_KEEP_MS) {
          state.recentSeen.delete(deviceId)
        }
      }
      let removed = 0
      for (const [deviceId, neighbor] of state.neighbors) {
        if (now - neighbor.lastSeen >= NEIGHBOR_TTL_MS) {
          state.neighbors.delete(deviceId)
          state.guests.delete(deviceId)
          // 这位邻居已经离开：下次再出现时重新询问，不受“稍后再说”影响。
          state.snoozed.delete(deviceId)
          removed += 1
        }
      }
      purgePrompts()
      return removed
    },

    dispose () {
      state.neighbors.clear()
      state.guests.clear()
      state.recentSeen.clear()
      state.visitors.clear()
      state.out = null
      state.work = null
      state.worker = null
      state.completedContracts.length = 0
      state.visits.length = 0
      state.completedVisits.length = 0
      state.pendingRecalls.length = 0
      state.endedInboundGifts.length = 0
      state.trust.allowed.clear()
      state.trust.denied.clear()
      state.prompts.length = 0
      state.promptSet.clear()
      state.snoozed.clear()
      state.notices.length = 0
      state.acceptVisits = true
      state.autoVisits = false
      state.lastDepartureAt = null
      state.activity.session = null
      state.activity.pointer = null
      state.lastPolicyDecision = null
      state.overflowNotified = false
      state.discardedGifts.clear()
      state.self.pet = null
      state.self.bridge = { ...IDLE_BRIDGE }
    }
  }
}

function normalizeDeviceId (value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (id === '' || id.length > 64) return null
  return id
}

/** 时长参数：非正/非数字时回落到默认值，坏配置不能把计时器拖死。 */
function positiveMs (value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizeVisitId (value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return isVisitId(id) ? id.toLowerCase() : null
}

/** 只读 deviceId → 昵称；忽略非法键，昵称非法时退到“邻居”。 */
function readTrust (value) {
  const trust = new Map()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return trust
  for (const [rawId, record] of Object.entries(value)) {
    const deviceId = normalizeDeviceId(rawId)
    if (deviceId === null) continue
    trust.set(deviceId, normalizeNickname(record?.nickname) ?? FALLBACK_NICKNAME)
  }
  return trust
}
