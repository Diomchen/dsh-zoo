import { VISIT_MAX_MS, normalizeNickname, sanitizeGiftName } from './protocol.js'

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
 *   - durationMs 上限 30 分钟：出门本身到点就回家，入站访客虽然可以待更久，
 *     记录里的“停留时长”也封顶 30 分钟，避免手改文件写出无限大的值；
 *   - gift 是可选的（ticket 27）：只留 kind 与文件名，**绝不记字条正文**；
 *     字段非法只丢这个字段，整条记录照常保留。旧文件没有这个字段也照常读。
 */
export const MAX_VISIT_RECORD_MS = VISIT_MAX_MS
export const VISIT_RECORD_LIMIT = 200

/**
 * 一条记录里的礼物摘要（ticket 27）：`{ kind: 'text' }` 或
 * `{ kind: 'file'[, name] }`。**不记字条正文**，也不记 id/路径/大小——历史文件会被翻看。
 *
 * 宽容规则与整条记录一致：不是对象、kind 不认识 → 返回 null，调用方只丢 gift 字段；
 * 文件名清洗失败 → 只丢 name，保留 kind（文件名只是给人看的，不该让整条记录作废）。
 */
export function normalizeVisitGift (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.kind === 'text') return { kind: 'text' }
  if (raw.kind !== 'file') return null
  const name = sanitizeGiftName(raw.name)
  return name === null ? { kind: 'file' } : { kind: 'file', name }
}

export function normalizeVisitRecord (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.direction !== 'out' && raw.direction !== 'in') return null
  const nickname = normalizeNickname(raw.nickname)
  if (nickname === null) return null
  if (!Number.isFinite(raw.startedAt) || raw.startedAt < 0) return null
  if (!Number.isFinite(raw.durationMs) || raw.durationMs < 0) return null
  const record = {
    direction: raw.direction,
    nickname,
    startedAt: Math.floor(raw.startedAt),
    durationMs: Math.min(Math.floor(raw.durationMs), MAX_VISIT_RECORD_MS)
  }
  // 可选字段：非法只丢它自己，绝不因此丢掉整条记录。
  const gift = normalizeVisitGift(raw.gift)
  if (gift !== null) record.gift = gift
  // 票 53：来偷的那一趟标成 `raid`（其余记录没有这个字段，形状与旧版本一致）。
  if (raw.kind === 'raid') record.kind = 'raid'
  return record
}
