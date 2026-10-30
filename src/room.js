import {
  GUEST_TTL_MS,
  MAX_LABEL,
  MAX_NEIGHBORS,
  NEIGHBOR_TTL_MS,
  VISIT_TTL_MS,
  isPort,
  isSafeAnimationName,
  isVisitId,
  normalizeAnimation,
  normalizeNickname,
  sanitizeLabel
} from './protocol.js'

/**
 * 客厅的领域状态：我是谁、有哪些邻居、谁在我家、谁出门了、最近串了几次门。
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
 *              startedAt, endsAt } | null   // 本地宠物出门了
 *     },
 *     neighbors: [ { deviceId, nickname, status: 'pending'|'allowed'|'denied', lastSeen, port } ],
 *     guests:    [ { deviceId, nickname, anim, since } ],          // 30 秒心跳影子
 *     visitors:  [ { deviceId, nickname, anim, visitId, since, endsAt } ], // 60 秒串门访客
 *     visits:    [ { direction: 'out'|'in', nickname, startedAt, durationMs } ],
 *     prompt:    { deviceId, nickname } | null,   // 放行 FIFO 的队首；其余排队等待
 *     notices:   [ { text, at } ]
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
 * ticket 04（访客）的边界：
 * - 只有 mayTalkTo 为真的邻居心跳才会创建/刷新 guests；pending/denied 的心跳只被丢弃。
 * - 访客 30 秒没有心跳由 tick() 清掉；被拒绝或邻居从邻居表移除时立刻清掉。
 * - 访客表上限 MAX_GUESTS，超出时挤掉最久没有心跳的那位（新来的留下）。
 * - 心跳只带 anim；访客昵称来自邻居表或放行名单，绝不来自心跳。
 *
 * ticket 05（串门）的边界：
 * - 出门是一次显式状态（self.out），不是 30 秒心跳影子：请求中/已抵达，60 秒 TTL。
 * - 同一只本机宠物同时只能有一次出门；本机入站访客按 deviceId 去重，一个设备最多一位。
 * - 接收方自己跑 60 秒计时器：对面消失也照样到期、写记录、清人，绝不假设对面守约。
 * - 召回可以由任一方发起：本机召回会排一条 visit-recall 给 service 发；收到 recall 立即回家。
 * - 失败（未放行/离线/超时/被拒绝/已经在串门）只产生一条人话 notice，不抛异常、不写半截状态。
 *
 * ticket 06（记录）的边界：
 * - 一次串门完成（召回/到期/对方结束/被拒绝后清场）时写一条**内存**记录；
 *   落盘由 service 调用 drainVisitRecords() 后交给 src/visits.js，room 自己不碰磁盘。
 * - 记录最多保留 VISIT_RECORD_LIMIT 条，丢掉最旧的；快照只给最近 5 条。
 * - 记录损坏/不可写时，visits.json 由 store 降级；这里始终有一份内存记录可用。
 */

export const MAX_PROMPTS = 8
/** 同时出现在客厅里的访客上限；其余由客户端折进灯条的 +N。 */
export const MAX_GUESTS = 8
/**
 * 入站串门访客上限。按 deviceId 去重，一个邻居最多一位；正常场景（六个人在线）
 * 远达不到这个数，上限只用来保证内存有界。
 */
export const MAX_VISITORS = MAX_NEIGHBORS
export const MAX_NOTICES = 10
export const VISIT_RECORD_LIMIT = 200
/** 点“稍后再说”后，同一位邻居至少安静这么久再问（它消失后重新出现则立刻重问）。 */
export const PROMPT_SNOOZE_MS = 10 * 60 * 1000
/** 记录里的时长上限：文件可手改，读进来的异常值不能变成无限大。 */
export const MAX_VISIT_RECORD_MS = 24 * 60 * 60 * 1000

const BRIDGE_REASONS = new Set(['starting', 'not-installed', 'unreachable', 'no-pet', 'error'])
const IDLE_BRIDGE = Object.freeze({ ok: false, reason: 'starting' })
const FALLBACK_NICKNAME = '邻居'
const DIRECTIONS = new Set(['out', 'in'])

export function createRoom ({ dir, log, clock = () => Date.now(), visitTtlMs = VISIT_TTL_MS } = {}) {
  const ttl = Number.isFinite(visitTtlMs) && visitTtlMs > 0 ? visitTtlMs : VISIT_TTL_MS
  const state = {
    self: { deviceId: null, nickname: '我', pet: null, bridge: { ...IDLE_BRIDGE } },
    neighbors: new Map(),
    guests: new Map(),
    visitors: new Map(),
    out: null,
    visits: [],
    completedVisits: [],
    pendingRecalls: [],
    trust: { allowed: new Map(), denied: new Map() },
    prompts: [],
    promptSet: new Set(),
    snoozed: new Map(),
    notices: []
  }

  function nowMs () {
    const stamp = clock()
    return Number.isFinite(stamp) ? stamp : Date.now()
  }

  function stampOf (value) {
    return Number.isFinite(value) ? value : nowMs()
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

  function copyVisitor (visitor) {
    return {
      deviceId: visitor.deviceId,
      nickname: visitor.nickname,
      anim: visitor.anim,
      visitId: visitor.visitId,
      since: visitor.since,
      endsAt: visitor.endsAt
    }
  }

  function copyRecord (record) {
    return {
      direction: record.direction,
      nickname: record.nickname,
      startedAt: record.startedAt,
      durationMs: record.durationMs
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

  /**
   * 失败提示的唯一文案表：五种失败必须各自可读、彼此不同。
   * 这里不出现 error code、堆栈或 socket 细节；用户只看到一句能理解的话。
   */
  function failureText (reason, nickname) {
    const name = normalizeNickname(nickname) ?? FALLBACK_NICKNAME
    if (reason === 'not-admitted') {
      return `还没放行「${name}」，先接受它的放行卡片，宠物才能过去。`
    }
    if (reason === 'peer-offline') {
      return `「${name}」好像不在线，宠物这次没出门。`
    }
    if (reason === 'timeout') {
      return `「${name}」没有回应，等了一会儿，宠物先留在家里了。`
    }
    if (reason === 'denied') {
      return `「${name}」没有放行你，宠物没能进门。`
    }
    if (reason === 'already-out') {
      return `宠物已经在「${name}」家了，先召回来再说。`
    }
    if (reason === 'starting') {
      return '客厅还在准备中，稍等一下再试。'
    }
    return '这次串门没成功，宠物还在家里。'
  }

  function failWithNotice (reason, nickname, at) {
    const notice = pushNotice(failureText(reason, nickname), at)
    return {
      ok: false,
      error: reason,
      notice: notice === null ? null : notice.text
    }
  }

  function recordVisit (direction, nickname, startedAt, endedAt) {
    const start = Number.isFinite(startedAt) ? Math.max(0, startedAt) : nowMs()
    const end = Number.isFinite(endedAt) ? Math.max(start, endedAt) : nowMs()
    const record = {
      direction: DIRECTIONS.has(direction) ? direction : 'in',
      nickname: normalizeNickname(nickname) ?? FALLBACK_NICKNAME,
      startedAt: start,
      durationMs: Math.min(Math.max(0, end - start), MAX_VISIT_RECORD_MS)
    }
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
      record = recordVisit('out', out.nickname, out.startedAt, at)
      if (notifyRemote) state.pendingRecalls.push({ deviceId: out.deviceId, visitId: out.visitId })
    }
    if (notice !== null) pushNotice(notice, at)
    return { visit: copyOutbound(out), record }
  }

  /** 清掉一位入站访客并写记录；被拒绝/名单收紧时用。 */
  function dropInboundVisitor (deviceId, at) {
    const visitor = state.visitors.get(deviceId)
    if (visitor === undefined) return null
    state.visitors.delete(deviceId)
    return recordVisit('in', visitor.nickname, visitor.since, at)
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
    const code = reason === 'peer-offline' || reason === 'timeout' || reason === 'denied'
      ? reason
      : 'peer-offline'
    const notice = pushNotice(failureText(code, out.nickname), now)
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
    if (neighbor !== undefined) neighbor.status = status
    // 拒绝是即时的：不用等 30 秒 TTL，那位的心跳影子与串门访客现在就离开客厅。
    if (status === 'denied') {
      state.guests.delete(deviceId)
      dropInboundVisitor(deviceId, nowMs())
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
      return {
        version: 1,
        self: {
          deviceId: state.self.deviceId,
          nickname: state.self.nickname,
          pet: state.self.pet === null ? null : { ...state.self.pet },
          bridge: { ...state.self.bridge },
          out: copyOutbound(state.out)
        },
        neighbors: [...state.neighbors.values()].map((neighbor) => ({ ...neighbor })),
        guests: [...state.guests.values()].map((guest) => ({
          deviceId: guest.deviceId,
          nickname: guest.nickname,
          anim: guest.anim,
          since: guest.since
        })),
        visitors: [...state.visitors.values()].map(copyVisitor),
        visits: state.visits.slice(0, 5).map(copyRecord),
        prompt: currentPrompt(),
        notices: state.notices.slice(0, 3).map((notice) => ({ ...notice }))
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
     */
    setSelfPet (pet) {
      if (pet === null || typeof pet !== 'object') {
        state.self.pet = null
        return
      }
      const name = sanitizeLabel(pet.name, MAX_LABEL)
      const anim = isSafeAnimationName(pet.anim) ? pet.anim.trim() : null
      state.self.pet = name === null && anim === null ? null : { name, anim }
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
          removePrompt(deviceId)
          state.snoozed.delete(deviceId)
        } else if (neighbor.status !== 'pending') {
          // 名单被手改短了：退回待放行，下次广播重新询问。
          neighbor.status = 'pending'
          enqueuePrompt(deviceId)
        }
      }
      // 手改名单收紧后，已经不在 allowed 里的访客与串门访客立即离开客厅。
      for (const deviceId of state.guests.keys()) {
        if (!allowed.has(deviceId) || denied.has(deviceId)) state.guests.delete(deviceId)
      }
      for (const deviceId of [...state.visitors.keys()]) {
        if (!allowed.has(deviceId) || denied.has(deviceId)) dropInboundVisitor(deviceId, nowMs())
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
        // 队列满时没排上的邻居，等下一次广播再试（不重复入队）。
        if (existing.status === 'pending') enqueuePrompt(deviceId)
        return
      }
      if (state.neighbors.size >= MAX_NEIGHBORS) return

      const status = state.trust.allowed.has(deviceId)
        ? 'allowed'
        : state.trust.denied.has(deviceId) ? 'denied' : 'pending'
      state.neighbors.set(deviceId, { deviceId, nickname, status, lastSeen, port })
      if (status === 'pending') enqueuePrompt(deviceId)
    },

    /**
     * 收到一条通过协议校验的邻居心跳。心跳只带 anim；昵称从邻居表或放行名单取，
     * 所以远端无法用心跳改名字、改信任或改本地影子。
     *
     * 未放行/已拒绝/自己的心跳直接丢弃。放行的心跳创建或刷新访客，
     * 同时刷新邻居的 lastSeen（心跳也证明它还活着）。返回是否被接受。
     * 心跳还会顺手更新同名串门访客的动作，但**不会**延长串门的 60 秒 TTL。
     */
    observeHeartbeat (peer, at = clock()) {
      if (peer === null || typeof peer !== 'object') return false
      const deviceId = normalizeDeviceId(peer.deviceId)
      if (deviceId === null || !canTalkTo(deviceId)) return false

      const neighbor = state.neighbors.get(deviceId)
      const nickname = normalizeNickname(neighbor?.nickname ?? state.trust.allowed.get(deviceId))
      if (nickname === null) return false
      const anim = normalizeAnimation(peer.anim)
      const lastSeen = Number.isFinite(at) ? at : clock()

      const existing = state.guests.get(deviceId)
      if (existing !== undefined) {
        existing.nickname = nickname
        existing.anim = anim
        existing.lastSeen = lastSeen
      } else {
        if (state.guests.size >= MAX_GUESTS) evictStalestGuest()
        state.guests.set(deviceId, { deviceId, nickname, anim, since: lastSeen, lastSeen })
      }

      const visiting = state.visitors.get(deviceId)
      if (visiting !== undefined) {
        visiting.nickname = nickname
        visiting.anim = anim
      }

      // 心跳证明这位邻居还在线：邻居灯不用等下一次 5 秒广播才续命。
      refreshNeighbor(deviceId, lastSeen)
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
        endsAt: null
      }
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
     * 收到 visit-ack：请求中 → 已抵达，开始 60 秒 TTL。
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
      out.endsAt = now + ttl
      refreshNeighbor(deviceId, now)
      return { ok: true, visit: copyOutbound(out) }
    },

    /** 收到 visit-deny：请求中 → 明确失败，写一条“对方没放行你”的 notice。 */
    observeVisitDeny (peer, at = clock()) {
      const deviceId = normalizeDeviceId(peer?.deviceId)
      const visitId = normalizeVisitId(peer?.visitId)
      if (deviceId === null || visitId === null) return { ok: false, error: 'bad-packet' }
      const out = state.out
      if (out === null || out.deviceId !== deviceId || out.visitId !== visitId) {
        return { ok: false, error: 'no-visit' }
      }
      return failOutbound('denied', at)
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

      // 接收方收到“召回”：对方到点或被召回，访客立即清场并写 in 记录。
      // 同一设备只有一位访客，所以按 deviceId 认即可；迟到的 recall（携带旧
      // visitId）也能立刻清场，不必等 60 秒。不回 recall——对方已经知道了。
      const visitor = state.visitors.get(deviceId)
      if (visitor !== undefined) {
        state.visitors.delete(deviceId)
        const record = recordVisit('in', visitor.nickname, visitor.since, now)
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
     * 收到 visit-request。只有放行过的来源会得到 ack；其余回 deny（明确失败），
     * 但都不创建访客、不写记录。同一来源的重复请求（重试）按 visitId 幂等处理：
     * 原地刷新 id/动作，不重置 60 秒计时，也绝不多写一条记录。
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
      if (!canTalkTo(deviceId)) {
        // 未知/未放行/已拒绝：给发起方一句明确的 deny，不创建任何本机状态。
        return { reply: 'deny', deviceId, visitId }
      }

      const now = stampOf(at)
      const neighbor = state.neighbors.get(deviceId)
      const nickname = normalizeNickname(
        neighbor?.nickname ?? state.trust.allowed.get(deviceId) ?? peer.nickname
      ) ?? FALLBACK_NICKNAME
      const anim = normalizeAnimation(peer.anim)

      const existing = state.visitors.get(deviceId)
      if (existing !== undefined) {
        // 重试或“上一次的 ack 丢了”：保留原来的 since/endsAt，不重复计一次串门。
        existing.visitId = visitId
        existing.nickname = nickname
        existing.anim = anim
        refreshNeighbor(deviceId, now)
        return {
          reply: 'ack',
          deviceId,
          visitId,
          nickname,
          visit: copyVisitor(existing)
        }
      }
      if (state.visitors.size >= MAX_VISITORS) {
        return { reply: 'deny', deviceId, visitId }
      }

      const visitor = {
        deviceId,
        visitId,
        nickname,
        anim,
        since: now,
        endsAt: now + ttl
      }
      state.visitors.set(deviceId, visitor)
      refreshNeighbor(deviceId, now)
      return { reply: 'ack', deviceId, visitId, nickname, visit: copyVisitor(visitor) }
    },

    /**
     * 本地召回（用户点“召回”，或 service 的 60 秒 tick 调过来）。
     * 已抵达 → 写 out 记录并排一条 visit-recall；还在请求中 → 只是取消，不写记录。
     */
    recallOutbound (at = clock()) {
      const out = state.out
      if (out === null) return { ok: false, error: 'not-out' }
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
     * 本机提前结束一位入站访客（接收方也能召回）。写 in 记录并排一条
     * visit-recall 让对方也回家；对方收不到也没关系，它的 TTL 会自己到期。
     */
    endInboundVisit (rawDeviceId, at = clock()) {
      const deviceId = normalizeDeviceId(rawDeviceId)
      if (deviceId === null) return { ok: false, error: 'bad-device-id' }
      const visitor = state.visitors.get(deviceId)
      if (visitor === undefined) return { ok: false, error: 'no-visit' }

      const now = stampOf(at)
      state.visitors.delete(deviceId)
      const record = recordVisit('in', visitor.nickname, visitor.since, now)
      state.pendingRecalls.push({ deviceId: visitor.deviceId, visitId: visitor.visitId })
      return {
        ok: true,
        deviceId: visitor.deviceId,
        visitId: visitor.visitId,
        nickname: visitor.nickname,
        record
      }
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
     * 载入持久化的串门记录（src/visits.js 的 records() 形状）。
     * 只读方向/昵称/开始时间/时长；按开始时间倒序，最多保留 200 条。
     */
    setVisitRecords (records) {
      const list = []
      if (Array.isArray(records)) {
        for (const raw of records) {
          const record = normalizeRecord(raw)
          if (record !== null) list.push(record)
        }
      }
      list.sort((left, right) => right.startedAt - left.startedAt)
      state.visits = list.slice(0, VISIT_RECORD_LIMIT)
      state.completedVisits = []
    },

    /**
     * 每秒一次：邻居/心跳影子按各自 TTL 过期；串门访客按自己的 60 秒 TTL 过期，
     * 已抵达的出门到点主动结束并排 recall。接收方即使对面消失也照样走这里。
     * 返回值保持旧契约：被移除的邻居数。
     */
    tick (at = clock()) {
      const now = stampOf(at)

      if (state.out !== null && state.out.phase === 'active' && now >= state.out.endsAt) {
        finishOutbound({ at: now, notifyRemote: true })
      }

      for (const [deviceId, visitor] of state.visitors) {
        if (now >= visitor.endsAt) {
          state.visitors.delete(deviceId)
          recordVisit('in', visitor.nickname, visitor.since, now)
        }
      }

      for (const [deviceId, guest] of state.guests) {
        if (now - guest.lastSeen >= GUEST_TTL_MS) state.guests.delete(deviceId)
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

    /** 客厅自己的动作（改名等由 service 处理，因为要落盘）。 */
    async action (body) {
      return { ok: false, error: 'not-implemented', action: body?.action ?? null }
    },

    dispose () {
      state.neighbors.clear()
      state.guests.clear()
      state.visitors.clear()
      state.out = null
      state.visits.length = 0
      state.completedVisits.length = 0
      state.pendingRecalls.length = 0
      state.trust.allowed.clear()
      state.trust.denied.clear()
      state.prompts.length = 0
      state.promptSet.clear()
      state.snoozed.clear()
      state.notices.length = 0
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

function normalizeVisitId (value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return isVisitId(id) ? id.toLowerCase() : null
}

function normalizeRecord (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.direction !== 'out' && raw.direction !== 'in') return null
  const nickname = normalizeNickname(raw.nickname)
  if (nickname === null) return null
  if (!Number.isFinite(raw.startedAt) || raw.startedAt < 0) return null
  if (!Number.isFinite(raw.durationMs) || raw.durationMs < 0) return null
  return {
    direction: raw.direction,
    nickname,
    startedAt: raw.startedAt,
    durationMs: Math.min(raw.durationMs, MAX_VISIT_RECORD_MS)
  }
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
