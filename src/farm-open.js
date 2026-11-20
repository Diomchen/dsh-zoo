/**
 * 票 52：公开只读视图（ADR-0018）。
 *
 * 这是**白名单重建**，不是裁剪：调用方给原始农场状态，这里只造出允许外发的那几个字段。
 * 和 `normalizeVisitView`（`src/farm-fetch.js`）是同一套口径的两个方向——那边收，这边发；
 * 两边都不能让别人的 deviceId、仓库、硬币、路径漏出去。
 *
 * 纯函数：不读盘、不碰 room、不拿时钟。宿主每次现查再交进来。
 */
import { PLOT_ID_RE } from './protocol.js'
import {
  MAX_PLOTS,
  isCropId,
  isMature,
  plotRemainingMs,
  plotStage,
  visitLimitsFor
} from './farm-rules.js'
import { SHELF_BASE_SLOTS, SOUVENIRS, SOUVENIR_IDS, TRIP_LOG_BODY_MAX, TRIP_LOG_TITLE_MAX } from './expedition.js'

export const FARM_OPEN_VERSION = 1

/**
 * @param {object} input
 * @param {string} input.viewerDeviceId 谁在看（只用来算"我自己偷过没有"与剩余次数，不参与授权）
 * @param {{deviceId: string, nickname: string}} input.host
 * @param {Array<object>} input.plots 主人的地块（原始形状）
 * @param {number} input.unlocked 已解锁数（决定每趟额度）
 * @param {number} input.guard 守卫比例 0–1
 * @param {{ownerHome: boolean, worker: boolean}} input.guardParts
 * @param {number} input.usedByViewer 这位今天在这个农场已经偷过几次
 * @param {string[]} input.caps 主人的能力声明
 * @param {object|null} input.expedition 主人的出远门状态（`expedition-store` 的 snapshot 形状）
 * @param {boolean} input.expeditionLogBodies 串门视图才给 true：日志多带正文
 * @param {number} input.now
 */
export function openFarmView ({
  viewerDeviceId,
  host,
  plots,
  unlocked,
  guard,
  guardParts,
  usedByViewer,
  caps,
  expedition = null,
  expeditionLogBodies = false,
  now = Date.now()
} = {}) {
  const viewer = typeof viewerDeviceId === 'string' ? viewerDeviceId.toLowerCase() : null
  const seen = new Set()
  const out = []
  for (const candidate of Array.isArray(plots) ? plots : []) {
    if (out.length >= MAX_PLOTS) break
    const plot = openPlot(candidate, viewer)
    if (plot === null || seen.has(plot.id)) continue
    seen.add(plot.id)
    out.push(plot)
  }
  out.sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)))

  const limits = visitLimitsFor(Number.isInteger(unlocked) && unlocked > 0 ? unlocked : MAX_PLOTS)
  const perTrip = limits.steal.perVisitorFarm
  const used = Number.isFinite(Number(usedByViewer)) ? Math.max(0, Math.floor(Number(usedByViewer))) : 0

  return {
    v: FARM_OPEN_VERSION,
    deviceId: host?.deviceId ?? null,
    host: { nickname: host?.nickname ?? '邻居' },
    guard: clamp01(guard),
    guardParts: {
      ownerHome: guardParts?.ownerHome === true,
      worker: guardParts?.worker === true
    },
    plots: out,
    quotas: {
      perTrip,
      perTripLeft: Math.max(0, perTrip - used)
    },
    caps: Array.isArray(caps) ? caps.filter((entry) => typeof entry === 'string') : [],
    expedition: publicExpeditionBlock(expedition, { withLogBodies: expeditionLogBodies === true }),
    at: Number.isFinite(now) ? Math.floor(now) : 0
  }
}

/**
 * 票 120：出远门的公开块，**白名单重建只有这一份**（收和发共用，别的文件不许再拼一遍）。
 *
 * 两个方向喂进来的形状不同，出的形状只有一个：
 * - 发（`openFarmView`）：输入是 `expedition-store` 的快照，`shelf` 是 `{slots, items}`（items 是 id 字符串），
 *   `codex` 是 `id → 首次获得时间`；
 * - 收（`farm-fetch.normalizeExpeditionBlock`）：输入是线上那份公开块，`shelf` 已经是 8 个格子的数组
 *   （每格 `{id,name,emoji}`），`codex` 只剩 `{owned,total}`。
 *
 * 只答三件事——图鉴到哪、陈列架前 8 格摆了谁、最近三篇日志的标题。
 * 名字与表情一律用本地图鉴（`SOUVENIRS`）按 id 反查，远端塞进来的 name/emoji 不采信；
 * 日志正文只有串门视图才有，公开视图一个字都不给；未开的格用 null 占位，不暴露格后内容。
 */
export function publicExpeditionBlock (raw, { withLogBodies = false } = {}) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    codex: { owned: codexOwnedOf(source), total: SOUVENIR_IDS.length },
    shelf: publicShelfOf(source),
    logs: publicLogsOf(source, withLogBodies === true)
  }
}

/** 图鉴件数：优先采信已经算好的 `codex.owned`（线上块），否则数快照里认识的 id。 */
function codexOwnedOf (source) {
  const codex = source.codex
  if (codex === null || typeof codex !== 'object' || Array.isArray(codex)) return 0
  const declared = Number(codex.owned)
  if (Number.isInteger(declared) && declared >= 0) return Math.min(declared, SOUVENIR_IDS.length)
  return SOUVENIR_IDS.filter((id) => Object.hasOwn(codex, id)).length
}

/** 前 8 格：快照的 `{slots, items}` 与线上块的数组两种输入都认，输出统一是 8 个格子。 */
function publicShelfOf (source) {
  const shelf = new Array(SHELF_BASE_SLOTS).fill(null)
  const slots = Array.isArray(source.shelf)
    ? source.shelf
    : (Array.isArray(source.shelf?.items) ? source.shelf.items : [])
  const unlocked = Array.isArray(source.shelf)
    ? shelf.length
    : (Number.isInteger(source.shelf?.slots) ? source.shelf.slots : 0)
  const seen = new Set()
  for (let index = 0; index < Math.min(shelf.length, unlocked, slots.length); index += 1) {
    const entry = slots[index]
    const id = typeof entry === 'string' ? entry : (typeof entry?.id === 'string' ? entry.id : null)
    if (id === null || seen.has(id)) continue
    const souvenir = SOUVENIRS[id]
    if (souvenir === undefined) continue
    seen.add(id)
    shelf[index] = { id: souvenir.id, name: souvenir.name, emoji: souvenir.emoji }
  }
  return shelf
}

/** 最近三篇：标题截到 `TRIP_LOG_TITLE_MAX`，正文只在串门给且截到 `TRIP_LOG_BODY_MAX`。 */
function publicLogsOf (source, withLogBodies) {
  const logs = []
  for (const entry of Array.isArray(source.logs) ? source.logs : []) {
    if (logs.length >= 3) break
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    const at = Number(entry.at)
    if (title.length === 0 || !Number.isFinite(at) || at <= 0) continue
    const log = { title: title.slice(0, TRIP_LOG_TITLE_MAX), at: Math.floor(at) }
    if (withLogBodies && typeof entry.body === 'string') log.body = entry.body.slice(0, TRIP_LOG_BODY_MAX)
    logs.push(log)
  }
  return logs
}

/** 一块地只外发这五个字段；作物不合法就丢这块（空地是合法的 crop: null）。 */
function openPlot (raw, viewer) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
  if (!PLOT_ID_RE.test(id)) return null
  const crop = raw.crop === null || raw.crop === undefined ? null : raw.crop
  if (crop !== null && !isCropId(crop)) return null
  return {
    id,
    crop,
    stage: plotStage(raw),
    mature: isMature(raw),
    remainingMs: plotRemainingMs(raw),
    // 只回答"我自己"，绝不回传 stolenBy/helpedBy 原数组。
    stolenByMe: viewer !== null && Array.isArray(raw.stolenBy) && raw.stolenBy.includes(viewer),
    helpedByMe: viewer !== null && Array.isArray(raw.helpedBy) && raw.helpedBy.includes(viewer)
  }
}

function clamp01 (value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.min(1, Math.max(0, num))
}
