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
    at: Number.isFinite(now) ? Math.floor(now) : 0
  }
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
