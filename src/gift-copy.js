/**
 * 礼物与背包的「状态/错误 → 人话」唯一文案表（SPEC v4「桌面卡片」「背包（发送端）」）。
 *
 * 卡片与背包小窗的内容都由宿主算好再下发（渲染端只画、不猜），所以标题、状态、
 * 串门没带上时的那一句、以及 `POST /local-pet/action` 的错误码文案都住在这里：
 *   - 卡片标题：「昵称」捎来一张字条；
 *   - 卡片状态：pending / receiving / received / failed / refused 五种；
 *   - 背包：bring / unbring 的错误码，以及出门前文件找不到时的那一句。
 *
 * 两条文案纪律：
 *   1. **不猜原因**。failed / refused 的措辞是“可能……也可能……”，绝不写死“对方版本太旧”——
 *      网络、端口、防火墙、限额都能造成同一个可见结果，猜错比不说更糟。
 *   2. received 不给状态文案：东西已经到手，卡片上该是字条本身，不是一句解释。
 */

import { normalizeNickname, sanitizeGiftName } from './protocol.js'

const FALLBACK_NICKNAME = '邻居'
const FALLBACK_FILE_NAME = '这个文件'

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
 * 文件礼物失败原因的固定词表（ticket 25）。reason 只决定状态行的一句话，
 * 不进 wire、不进 /state、也绝不来自远端字符串。（限额的 `rate` 留给 ticket 27。）
 */
export const GIFT_REASONS = Object.freeze([
  'timeout',
  'no-port',
  'checksum',
  'too-large',
  'refused',
  'write'
])

const REASON_SET = new Set(GIFT_REASONS)

export function isGiftReason (value) {
  return typeof value === 'string' && REASON_SET.has(value)
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
 * failed / refused 在知道原因时给一句具体的；不知道原因时仍然刻意模糊——
 * 网络、端口、防火墙、限额都能造成同一个可见结果，猜错比不说更糟。
 */
export function giftStatusText (status, reason = null) {
  if (status === 'pending') return '刚到，正在收下…'
  if (status === 'receiving') return '正在取回…'
  if (status === 'failed') {
    if (reason === 'no-port') return '对方没开素材端口，东西取不回来。'
    if (reason === 'timeout') return '对方一直没回应，这次没取到。'
    if (reason === 'checksum') return '取回来的东西和对方说的对不上，没敢收下。'
    if (reason === 'too-large') return '这件东西超过 16 MB，没收下。'
    if (reason === 'write') return '东西没能写进本地。'
    return '这件东西没取到。可能是对方没开端口，也可能只是网络或版本对不上。'
  }
  if (status === 'refused') {
    if (reason === 'too-large') return '这件东西超过 16 MB，没收下。'
    return '这件东西没收下。'
  }
  return null
}

/** 纯文本礼物没带上（编码层超 4 KiB / 校验不过）时的那一句；串门照常。 */
export function giftDroppedText () {
  return '字条太长了，这次没带上。'
}

/**
 * 文件件在**发送那一刻**读不出来时的那一句。名字可能来自用户手改的背包文件，
 * 所以先过一遍同一个 `sanitizeGiftName`，再把名字放进引号。
 */
export function giftPrepareFailedText (error, name) {
  const label = sanitizeGiftName(name) ?? FALLBACK_FILE_NAME
  if (error === 'no-such-file') return `「${label}」这个文件找不到了，这次没带上。`
  if (error === 'unreadable') return `「${label}」读不出来，这次没带上。`
  if (error === 'too-large') return `「${label}」超过 16 MB，这次没带上。`
  return '这件东西没带上，还留在背包里。'
}

/**
 * 背包动作的错误码 → 人话。小窗与 HTTP 共用同一张表：
 * 小窗把这句话显示在按钮旁边，HTTP 客户端拿到 `notice` 也能直接展示。
 */
export function backpackErrorText (error) {
  if (error === 'backpack-full') return '背包已经有两件了，先撤掉一件再放。'
  if (error === 'too-large') return '这个文件超过 16 MB，带不上。'
  if (error === 'no-such-file') return '这个文件不在了，换一个吧。'
  if (error === 'bad-gift') return '这件东西装不进背包：字条不能是空的或超过 500 字，文件要给绝对路径。'
  if (error === 'gift-out') return '这件东西还在路上，等它回来再撤。'
  if (error === 'gift-not-found') return '背包里没有这件东西。'
  if (error === 'starting') return '背包还没准备好，稍后再试。'
  if (error === 'desktop-off') return '桌面层没有在运行，打不开「带派」。'
  return '这次没有放进背包。'
}
