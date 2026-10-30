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
 * 网络和磁盘在 src/discovery.js、src/identity.js 与 src/pet-bridge.js 里，
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
 *     prompt:    { deviceId, nickname } | null,   // 待放行的那一位
 *     notices:   [ { text, at } ]
 *   }
 *
 * 已知限制（ticket 01）：`dsh-pet` 不上报随机待机动画，所以 `self.pet.anim`
 * 只能反映**被点播过**的动作；anim 为空时由客户端轮播内置待机片段。
 *
 * ticket 02 的接缝：邻居的 `status` 现在一律是 `'pending'`。ticket 03 在这里加
 * 放行/拒绝与心跳门控；本文件不应该出现任何 socket 或 identity 持久化。
 */

const BRIDGE_REASONS = new Set(['starting', 'not-installed', 'unreachable', 'no-pet', 'error'])
const IDLE_BRIDGE = Object.freeze({ ok: false, reason: 'starting' })

export function createRoom ({ dir, log, clock = () => Date.now() } = {}) {
  const state = {
    self: { deviceId: null, nickname: '我', pet: null, bridge: { ...IDLE_BRIDGE } },
    neighbors: new Map(),
    guests: new Map(),
    visits: [],
    prompt: null,
    notices: []
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
        prompt: state.prompt,
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
     * 收到一条通过协议校验的邻居报文。只更新内存里的邻居表：
     * 远端字段在这里的唯一效果是“渲染”和“邻居灯”，不触发任何 I/O。
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
        return
      }
      if (state.neighbors.size >= MAX_NEIGHBORS) return
      state.neighbors.set(deviceId, {
        deviceId,
        nickname,
        status: 'pending',
        lastSeen,
        port
      })
    },

    /**
     * 30 秒没有新报文的邻居直接消失（灯和名字一起）。
     * 由 host 每秒喂一次；ticket 03 的访客淡出也会复用这条时间线。
     */
    tick (at = clock()) {
      const now = Number.isFinite(at) ? at : clock()
      let removed = 0
      for (const [deviceId, neighbor] of state.neighbors) {
        if (now - neighbor.lastSeen >= NEIGHBOR_TTL_MS) {
          state.neighbors.delete(deviceId)
          removed += 1
        }
      }
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
      state.notices.length = 0
      state.prompt = null
      state.self.pet = null
      state.self.bridge = { ...IDLE_BRIDGE }
    }
  }
}
