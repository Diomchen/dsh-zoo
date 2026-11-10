/**
 * 串门失败的「原因 → 人话」唯一文案表。
 *
 * 三个地方共用同一份文案：
 *   - `src/room.js`：失败时写进 `snapshot.notices` 的那句话；
 *   - `src/desktop-pets.js`：桌面上「串门」按钮置灰时的理由（按钮和气泡必须说同一句话）；
 *   - `src/service.js`：桌面控件申请失败、room 没给 notice 时的兜底。
 *
 * 这里不出现 error code、堆栈或 socket 细节：用户只看到一句能理解的话。
 * `nickname` 是**对方**的昵称，允许为空（此时说「邻居」）。
 */

import { normalizeNickname } from './protocol.js'

const FALLBACK_NICKNAME = '邻居'

/** 这一层认识的失败原因。未知原因由调用方决定怎么兜底。 */
export const VISIT_REASON_CODES = Object.freeze([
  'not-admitted',
  'peer-offline',
  'timeout',
  'denied',
  'visits-off',
  'already-out',
  // ticket 44：在外打工和出门一字之差，但下一步完全不同（等合同/召回）。
  'already-working',
  'no-admitted',
  'no-online',
  'no-visitor',
  'not-out',
  'starting'
])

const REASON_SET = new Set(VISIT_REASON_CODES)

export function isVisitReason (value) {
  return typeof value === 'string' && REASON_SET.has(value)
}

export function visitReasonText (reason, nickname) {
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
  if (reason === 'visits-off') {
    return `「${name}」关掉了串门，宠物这次没能进去。`
  }
  if (reason === 'already-out') {
    return `宠物已经在「${name}」家了，先召回来再说。`
  }
  if (reason === 'already-working') {
    return '宠物在外打工，合同结束前不能去串门。'
  }
  if (reason === 'no-admitted') {
    return '还没有人放行你，宠物出不了门。'
  }
  if (reason === 'no-online') {
    return '还没有邻居放行你，或者他们现在都不在线，宠物这次没出门。'
  }
  if (reason === 'no-visitor') {
    return '这位访客已经不在桌面上了。'
  }
  if (reason === 'not-out') {
    return '宠物现在在家，不用召回。'
  }
  if (reason === 'starting') {
    return '桌面还在准备中，稍等一下再试。'
  }
  return '这次串门没成功，宠物还在家里。'
}
