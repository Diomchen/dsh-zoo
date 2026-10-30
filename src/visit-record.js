import { normalizeNickname } from './protocol.js'

/**
 * 一条串门记录的唯一规范器，room 与 visits.json 共用。
 *
 * 记录只从两处来：本机完成一次串门（可信但时间戳可能带小数），
 * 以及用户可手改的 `<dataDir>/visits.json`（不可信）。两边必须用同一套规则，
 * 否则“内存里能看”和“落盘后能读回来”会悄悄漂移。
 *
 * 规则：
 *   - 方向只能是 out / in，昵称必须清洗后可读；
 *   - startedAt / durationMs 必须是有限的非负数，向下取整（存储是毫秒整数）；
 *   - durationMs 上限 24 小时，防止手改文件写出无限大的“停留时间”。
 */
export const MAX_VISIT_RECORD_MS = 24 * 60 * 60 * 1000
export const VISIT_RECORD_LIMIT = 200

export function normalizeVisitRecord (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.direction !== 'out' && raw.direction !== 'in') return null
  const nickname = normalizeNickname(raw.nickname)
  if (nickname === null) return null
  if (!Number.isFinite(raw.startedAt) || raw.startedAt < 0) return null
  if (!Number.isFinite(raw.durationMs) || raw.durationMs < 0) return null
  return {
    direction: raw.direction,
    nickname,
    startedAt: Math.floor(raw.startedAt),
    durationMs: Math.min(Math.floor(raw.durationMs), MAX_VISIT_RECORD_MS)
  }
}
