/**
 * 礼物卡片的「状态 → 人话」唯一文案表（SPEC v4「桌面卡片」）。
 *
 * 卡片内容由宿主算好再下发（渲染端只画、不猜），所以标题和状态文案都住在这里：
 *   - 标题：「昵称」捎来一张字条；
 *   - 状态：pending / receiving / received / failed / refused 五种。
 *
 * 两条文案纪律：
 *   1. **不猜原因**。这张票还没有失败路径（字条只有收到/丢掉），但 failed / refused
 *      的位置先留着，措辞是“可能……也可能……”，绝不写死“对方版本太旧”——
 *      网络、端口、防火墙、限额都能造成同一个可见结果，猜错比不说更糟。
 *   2. received 不给状态文案：东西已经到手，卡片上该是字条本身，不是一句解释。
 */

import { normalizeNickname } from './protocol.js'

const FALLBACK_NICKNAME = '邻居'

/** SPEC 定义的五种入站礼物状态；未知状态由调用方丢弃这张卡。 */
export const GIFT_STATUSES = Object.freeze([
  'pending',
  'receiving',
  'received',
  'failed',
  'refused'
])

const STATUS_SET = new Set(GIFT_STATUSES)

export function isGiftStatus (value) {
  return typeof value === 'string' && STATUS_SET.has(value)
}

/**
 * 卡片标题。kind 目前只有 'text'；文件礼物是 ticket 25 的事，
 * 这里先按词表给出一个不丢信息的说法，免得 25 再补一遍标题。
 */
export function giftTitleText (nickname, kind = 'text') {
  const name = normalizeNickname(nickname) ?? FALLBACK_NICKNAME
  if (kind === 'file') return `「${name}」捎来一个文件`
  return `「${name}」捎来一张字条`
}

/**
 * 状态行。received 返回 null（卡片正文就是内容本身）。
 * failed / refused 的措辞刻意模糊：这一票没有失败原因可依据。
 */
export function giftStatusText (status) {
  if (status === 'pending') return '刚到，正在收下…'
  if (status === 'receiving') return '正在取回…'
  if (status === 'failed') return '这件东西没取到。可能是对方没开端口，也可能只是网络或版本对不上。'
  if (status === 'refused') return '这件东西没收下。'
  return null
}
