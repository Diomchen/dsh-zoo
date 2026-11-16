/**
 * 真人周榜与 LAN 情绪（票 82）：本机 + 收到 `trading-digest` 的邻居 → 一张榜。
 *
 * 这一层是**纯函数**：不读盘、不碰网络、不取时钟（`now` 从参数进来）。
 * 为什么单独一层：排序、新鲜度、情绪计数都是产品口径（SPEC v10「真人榜与协议」、
 * ADR-0028 决定 7），必须能用固定输入在 Node 里直接断言；service 只负责收发、
 * 限流与「谁还活着」（照 `market-digest` 的先例）。
 *
 * 榜上的分数是「本周交易盈亏」（金币），收益率只展示、不改排序。分数与持仓都是
 * 邻居**自报**的：伪造 digest 只能骗到榜上的数字，改不了本机硬币/持仓/`trading.json`
 * （SPEC「不做强防作弊」）。邻居的行只活在 service 的内存里，进程退出就没了。
 */
import { TRADING_DIGEST_FRESH_MS, normalizeTradingPositions } from './protocol.js'

/** 昵称和报文里的口径一致：32 个 UTF-16 码元，多余的截掉。 */
const NICKNAME_MAX = 32
/** 本机那一行的兜底名字：身份还没起来时也要画得出「我」。 */
const SELF_NAME = '我'
/** 邻居那一行的兜底名字：昵称来自本机邻居表，拿不到就写「邻居」。 */
const PEER_NAME = '邻居'

function nicknameOf (value, fallback) {
  if (typeof value !== 'string') return fallback
  const name = value.trim()
  if (name === '') return fallback
  return name.length > NICKNAME_MAX ? name.slice(0, NICKNAME_MAX) : name
}

function finiteOrNull (value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 本机那一行。收益率由**本机**算，不信任何远端数字：
 *   1. 优先用调用方给的 `weekPnlPct`——service 从**未取整**的 `week.total / week.base`
 *      算，和窗口抬头那句收益率同一个分子，免得榜上多一次取整差；
 *   2. 没给就退回 `weekPnl / weekBase`（`weekPnl` 是取整后的金币）；
 * 3. `weekBase` 是 0（新账本/坏文件）时就是 null，窗口画「—」——除零没有意义。
 */
function selfRow (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.deviceId !== 'string' || raw.deviceId === '') return null
  const weekPnl = finiteOrNull(raw.weekPnl)
  if (weekPnl === null) return null
  const positions = normalizeTradingPositions(raw.positions)
  if (positions === null) return null
  const base = Number(raw.weekBase)
  const fallbackPct = Number.isFinite(base) && base > 0 ? weekPnl / base : null
  return {
    deviceId: raw.deviceId,
    nickname: nicknameOf(raw.nickname, SELF_NAME),
    weekPnl,
    weekPnlPct: finiteOrNull(raw.weekPnlPct) ?? fallbackPct,
    positions,
    me: true
  }
}

/**
 * 邻居那一行。任何一项坏都整行丢掉（不是把某个字段归零）：
 * 半截的榜比没有更糟——它会让人以为邻居满仓空仓，而那只是解析失败。
 * 新鲜度以本机收到的时间（`seenAt`）为准，不用报文里的 `at`：邻居的表不准
 * 不该让这一行忽隐忽现（与 `src/market.js` 的同名判据一个道理）。
 */
function peerRow (raw, now) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.deviceId !== 'string' || raw.deviceId === '') return null
  const weekPnl = finiteOrNull(raw.weekPnl)
  if (weekPnl === null) return null
  const positions = normalizeTradingPositions(raw.positions)
  if (positions === null) return null
  const seenAt = Number(raw.seenAt)
  if (!Number.isFinite(seenAt)) return null
  if (now - seenAt > TRADING_DIGEST_FRESH_MS) return null
  return {
    deviceId: raw.deviceId,
    nickname: nicknameOf(raw.nickname, PEER_NAME),
    weekPnl,
    weekPnlPct: finiteOrNull(raw.weekPnlPct),
    positions,
    me: false
  }
}

/**
 * 排序：本周盈亏降序；并列时先昵称再 deviceId。
 * 不用 `localeCompare`——它随系统语言变，同一份数据在不同机器上会排出不同顺序。
 */
function compareRows (a, b) {
  if (a.weekPnl !== b.weekPnl) return b.weekPnl - a.weekPnl
  if (a.nickname !== b.nickname) return a.nickname < b.nickname ? -1 : 1
  if (a.deviceId === b.deviceId) return 0
  return a.deviceId < b.deviceId ? -1 : 1
}

/**
 * LAN 情绪（SPEC v10）：本机 + 邻居**当前仓位**的多空计数。
 * `flat` 数的是「没有任何仓位的人」，不是仓位——所以全场观望时是
 * `{ long: 0, short: 0, flat: n }`，窗口据此写「观望」而不是「多 0 · 空 0」。
 */
function sentimentOf (rows) {
  let long = 0
  let short = 0
  let flat = 0
  for (const row of rows) {
    if (row.positions.length === 0) {
      flat += 1
      continue
    }
    for (const position of row.positions) {
      if (position.side === 'long') long += 1
      else short += 1
    }
  }
  return { long, short, flat }
}

/**
 * 旧版本邻居的可见状态（评审 P1 / SPEC v10「旧邻居」）：
 *   - `online` = 已放行且此刻有心跳的邻居数（room 的邻居表已经按 TTL 清人）；
 *   - `reported` = 其中在本机收到的新鲜窗口内发过周报的数量。
 * `online > 0 && reported === 0` 才是「他们在，但不会发周报」——窗口据此说
 * 「邻居是旧版本，还没有周报」，而不是误导成「还没有邻居上线」。
 *
 * 纯函数：邻居表与 digest 表都由 service 从内存取出来喂进来，这一层不碰 room/网络。
 */
export function watcherCounts ({ neighbors = [], digests = [], now = Date.now() } = {}) {
  const stamp = Number(now)
  const at = Number.isFinite(stamp) ? stamp : Date.now()
  const online = new Set()
  for (const neighbor of Array.isArray(neighbors) ? neighbors : []) {
    if (neighbor === null || typeof neighbor !== 'object') continue
    if (neighbor.status !== 'allowed') continue
    if (!(Number(neighbor.heartbeatAt) > 0)) continue
    if (typeof neighbor.deviceId !== 'string' || neighbor.deviceId === '') continue
    online.add(neighbor.deviceId)
  }
  let reported = 0
  for (const digest of Array.isArray(digests) ? digests : []) {
    if (digest === null || typeof digest !== 'object') continue
    if (!online.has(digest.deviceId)) continue
    const seenAt = Number(digest.seenAt)
    if (!Number.isFinite(seenAt) || at - seenAt > TRADING_DIGEST_FRESH_MS) continue
    reported += 1
  }
  return { online: online.size, reported }
}

/** 旧版本状态只认两个非负整数；坏输入按 0，窗口不会拿 NaN 去比较。 */
function watchersOf (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { online: 0, reported: 0 }
  }
  const count = (value) => {
    const num = Number(value)
    return Number.isInteger(num) && num >= 0 ? num : 0
  }
  const online = count(raw.online)
  return { online, reported: Math.min(online, count(raw.reported)) }
}

/**
 * 合并成榜：`self` 是本机（`{ deviceId, nickname, weekPnl, weekPnlPct?, weekBase,
 * positions }`），`peers` 是 service 从内存 Map 取出来的邻居周报
 * （`{ deviceId, nickname, weekPnl, weekPnlPct, positions, seenAt }`），`now` 是本机时钟，
 * `watchers` 是 service 用 `watcherCounts()` 算好的旧版本可见状态。
 *
 * 返回 `{ rows, sentiment, self, watchers }`：`rows` 已排序（含 `me: true` 的本机行），
 * `sentiment` 是上面那三格计数，`self` 是窗口抬头用的本机分数
 * （和本机发出去的那条 digest 同源，免得榜上和自报对不上）。
 * 唯一不发 `trading-digest` 的邻居不会出现——旧版本静默降级（SPEC「旧邻居」）。
 */
export function buildLeague ({ self = null, peers = [], now = Date.now(), watchers = null } = {}) {
  const stamp = Number(now)
  const at = Number.isFinite(stamp) ? stamp : Date.now()
  const rows = []
  const own = selfRow(self)
  if (own !== null) rows.push(own)
  for (const peer of Array.isArray(peers) ? peers : []) {
    const row = peerRow(peer, at)
    if (row === null) continue
    // 同一台机器只占一行：service 的 Map 本来就不会重复，直接喂数组时也不制造重影。
    if (rows.some((entry) => entry.deviceId === row.deviceId)) continue
    rows.push(row)
  }
  rows.sort(compareRows)
  return {
    rows,
    sentiment: sentimentOf(rows),
    self: own === null
      ? { weekPnl: 0, weekPnlPct: null }
      : { weekPnl: own.weekPnl, weekPnlPct: own.weekPnlPct },
    watchers: watchersOf(watchers)
  }
}
