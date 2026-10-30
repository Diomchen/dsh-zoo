/**
 * 客厅的领域状态：我是谁、有哪些邻居、谁在我家、最近串了几次门。
 *
 * 这一层是本项目的主测试缝——它是纯的：喂事件、看快照，不碰 socket、不碰 DOM。
 * 网络和磁盘在 src/net.js 与 src/store.js 里，把外部世界翻译成这里的事件。
 *
 * 快照形状是客户端唯一的输入契约，改它等于改 UI 契约：
 *   {
 *     version: 1,
 *     self:     { deviceId, nickname, pet: { name, anim } | null },
 *     neighbors:[ { deviceId, nickname, status: 'pending'|'allowed'|'denied', lastSeen } ],
 *     guests:   [ { deviceId, nickname, anim, since } ],
 *     visits:   [ { direction, nickname, startedAt, durationMs } ],
 *     prompt:   { deviceId, nickname } | null,   // 待放行的那一位
 *     notices:  [ { text, at } ]
 *   }
 */
export function createRoom ({ dir, log } = {}) {
  const state = {
    self: { deviceId: null, nickname: '我', pet: null },
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
        self: { ...state.self },
        neighbors: [...state.neighbors.values()],
        guests: [...state.guests.values()],
        visits: state.visits.slice(0, 5),
        prompt: state.prompt,
        notices: state.notices.slice(0, 3)
      }
    },
    async action (body) {
      return { ok: false, error: 'not-implemented', action: body?.action ?? null }
    },
    dispose () {}
  }
}
