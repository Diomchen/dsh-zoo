import {
  MAX_LABEL,
  MAX_NEIGHBORS,
  NEIGHBOR_TTL_MS,
  isPort,
  isSafeAnimationName,
  normalizeNickname,
  sanitizeLabel
} from './protocol.js'

/**
 * 客厅的领域状态：我是谁、有哪些邻居、谁在我家、最近串了几次门。
 *
 * 这一层是本项目的主测试缝——它是纯的：喂事件、看快照，不碰 socket、不碰 DOM、不碰磁盘。
 * 网络和磁盘在 src/discovery.js、src/identity.js、src/peers.js 与 src/pet-bridge.js 里，
 * 它们只把外部世界翻译成这里的方法调用。
 *
 * 快照形状是客户端唯一的输入契约，改它等于改 UI 契约（只加字段，不改名、不删除）：
 *   {
 *     version: 1,
 *     self: {
 *       deviceId, nickname,
 *       pet: { name, anim } | null,
 *       bridge: { ok, reason }        // reason: starting|not-installed|unreachable|no-pet|error|null
 *     },
 *     neighbors: [ { deviceId, nickname, status: 'pending'|'allowed'|'denied', lastSeen, port } ],
 *     guests:    [ { deviceId, nickname, anim, since } ],
 *     visits:    [ { direction, nickname, startedAt, durationMs } ],
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
 */

export const MAX_PROMPTS = 8
/** 点“稍后再说”后，同一位邻居至少安静这么久再问（它消失后重新出现则立刻重问）。 */
export const PROMPT_SNOOZE_MS = 10 * 60 * 1000

const BRIDGE_REASONS = new Set(['starting', 'not-installed', 'unreachable', 'no-pet', 'error'])
const IDLE_BRIDGE = Object.freeze({ ok: false, reason: 'starting' })
const FALLBACK_NICKNAME = '邻居'

export function createRoom ({ dir, log, clock = () => Date.now() } = {}) {
  const state = {
    self: { deviceId: null, nickname: '我', pet: null, bridge: { ...IDLE_BRIDGE } },
    neighbors: new Map(),
    guests: new Map(),
    visits: [],
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
          bridge: { ...state.self.bridge }
        },
        neighbors: [...state.neighbors.values()].map((neighbor) => ({ ...neighbor })),
        guests: [...state.guests.values()].map((guest) => ({ ...guest })),
        visits: state.visits.slice(0, 5),
        prompt: currentPrompt(),
        notices: state.notices.slice(0, 3)
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
      const id = normalizeDeviceId(deviceId)
      if (id === null) return false
      if (state.self.deviceId !== null && id === state.self.deviceId) return false
      return state.trust.allowed.has(id) && !state.trust.denied.has(id)
    },

    /**
     * 30 秒没有新报文的邻居直接消失（灯和名字一起）。
     * 由 host 每秒喂一次；ticket 04 的访客淡出也会复用这条时间线。
     */
    tick (at = clock()) {
      const now = Number.isFinite(at) ? at : clock()
      let removed = 0
      for (const [deviceId, neighbor] of state.neighbors) {
        if (now - neighbor.lastSeen >= NEIGHBOR_TTL_MS) {
          state.neighbors.delete(deviceId)
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
      state.visits.length = 0
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
