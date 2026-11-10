/**
 * 把 room 的快照翻译成「桌面上应该有谁」。
 *
 * 这是宿主对宠物身份/动作的唯一权威：渲染端只按这个列表增删宠物、切换素材。
 * 坐标不在这里（ADR-0003 不变）；桌面位置由 helper 的渲染端本地模拟。
 *
 * ticket 09/10 的边界：
 * - 自己的宠物出门（self.out 非 null）时从本机桌面消失；
 * - 桌面上只画**串门访客**（snapshot.visitors），不画 30 秒心跳影子（snapshot.guests）——
 *   心跳只说明“这位邻居在线、并且放行了我”，不代表它在我家。把心跳影子画出来会让
 *   “串门”变成“所有邻居一直待在桌面上”，也会让「送客」无从谈起。
 *
 * 纯函数：只读快照对象，不碰时钟/磁盘/网络，便于单测。
 */

import shared from '../desktop/shared.js'
import { isGiftStatus, giftStatusText, giftTitleText } from './gift-text.js'
import { isDeviceId, isVisitId, sanitizeGiftName } from './protocol.js'
import { MAX_STREET, isBlockedReason } from './street.js'
import { isVisitReason, visitReasonText } from './visit-copy.js'

/** 快照里的 deviceId 是身份层生成的 UUID；复用协议层的形状校验，不另写一份。 */
function deviceIdOf (value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return isDeviceId(id) ? id : null
}

function selfDescriptor (self) {
  if (self === null || typeof self !== 'object') return null
  // 出门串门（请求中/已抵达）或在外打工：本机桌面不再显示自己。ticket 09/44。
  // 必须判 `typeof === 'object'`：老快照没有 work，`undefined !== null` 会把自己误藏。
  if (self.out !== null && typeof self.out === 'object') return null
  if (self.work !== null && typeof self.work === 'object') return null
  const pet = self.pet !== null && typeof self.pet === 'object' ? self.pet : null
  const label = shared.normalizeLabel(pet?.name, '') || shared.normalizeLabel(self.nickname, '')
  return {
    id: 'self',
    role: 'self',
    label: label === '' ? '我' : label,
    anim: shared.normalizeAnim(pet?.anim),
    color: shared.PET_COLORS[0]
  }
}

function visitorDescriptor (raw) {
  if (raw === null || typeof raw !== 'object') return null
  const deviceId = deviceIdOf(raw.deviceId)
  if (deviceId === null) return null
  // 访客用自己的色板格；避开与 self 相同的蓝色，免得七八只全一个颜色。
  const palette = shared.PET_COLORS.slice(1)
  const color = palette[shared.hashString(deviceId) % palette.length]
  return {
    id: 'visitor:' + deviceId,
    role: 'visitor',
    label: shared.normalizeLabel(raw.nickname, '邻居'),
    anim: shared.normalizeAnim(raw.anim),
    color
  }
}

/**
 * 别人家的宠物在我家打工（ticket 44）。它不是访客：不能送客，只有合同能结束它；
 * 角标是固定枚举 `work`，皮肤复用访客素材（`worker:` 前缀）。
 */
function workerDescriptor (raw) {
  if (raw === null || typeof raw !== 'object') return null
  const deviceId = deviceIdOf(raw.workerDeviceId)
  if (deviceId === null) return null
  const palette = shared.PET_COLORS.slice(1)
  const color = palette[shared.hashString(deviceId) % palette.length]
  return {
    id: 'worker:' + deviceId,
    role: 'worker',
    label: shared.normalizeLabel(raw.workerNickname, '邻居'),
    anim: shared.normalizeAnim(raw.anim),
    color,
    badge: 'work'
  }
}

/**
 * @param {object} snapshot room.snapshot()
 * @returns {Array<{id:string,role:'self'|'visitor'|'worker',label:string,anim:string|null,color:string,badge?:string}>}
 */
export function petsFromSnapshot (snapshot) {
  const pets = []
  if (snapshot === null || typeof snapshot !== 'object') return pets

  const self = selfDescriptor(snapshot.self)
  if (self !== null) pets.push(self)

  // ticket 44：雇工画在访客之前（场景顺序 = DOM 顺序，访客在上层）。
  const worker = workerDescriptor(snapshot.worker)
  if (worker !== null) pets.push(worker)

  // 只有 visitors 是“此刻在我家串门的宠物”。guests 是心跳影子，刻意不画。
  const visitors = Array.isArray(snapshot.visitors) ? snapshot.visitors : []
  const seen = new Set()
  for (const visitor of visitors) {
    if (pets.length >= shared.MAX_SCENE_ITEMS) break
    const pet = visitorDescriptor(visitor)
    if (pet === null || seen.has(pet.id)) continue
    seen.add(pet.id)
    pets.push(pet)
  }
  return pets
}

/**
 * 因为一次场景放不下（`shared.MAX_SCENE_ITEMS`）而没能画出来的访客数。
 *
 * “不设同屏上限”是产品决定，渲染端单包仍有上限；宿主必须知道少画了几位，
 * 才能给一句人话提示，而不是让宠物静默消失。计数规则和 petsFromSnapshot 一致：
 * 先按场景顺序校验/去重，再数超出上限的部分。
 *
 * @param {object} snapshot room.snapshot()
 * @returns {number}
 */
export function droppedVisitors (snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return 0
  const visitors = Array.isArray(snapshot.visitors) ? snapshot.visitors : []
  const seen = new Set()
  let valid = 0
  for (const visitor of visitors) {
    if (visitor === null || typeof visitor !== 'object') continue
    const deviceId = deviceIdOf(visitor.deviceId)
    if (deviceId === null || seen.has(deviceId)) continue
    seen.add(deviceId)
    valid += 1
  }
  const drawn = petsFromSnapshot(snapshot).filter((pet) => pet.role === 'visitor').length
  return Math.max(0, valid - drawn)
}

/**
 * 快照的 `street` → 渲染端能画的一排房子（ticket 20/21）。
 *
 * 只做搬运和清洗：昵称、动作名、能不能去、为什么不能去。顺序就是宿主给的顺序
 * （能去的在前），渲染端不再排——两处各排一次，迟早排得不一样。
 */
function streetFromSnapshot (snapshot) {
  const rows = []
  if (!Array.isArray(snapshot.street)) return rows
  const seen = new Set()
  for (const raw of snapshot.street) {
    if (rows.length >= MAX_STREET) break
    if (raw === null || typeof raw !== 'object') continue
    const deviceId = deviceIdOf(raw.deviceId)
    if (deviceId === null || seen.has(deviceId)) continue
    seen.add(deviceId)
    rows.push({
      deviceId,
      label: shared.normalizeLabel(raw.nickname, '邻居'),
      action: shared.normalizeLabel(raw.action, null),
      canVisit: raw.canVisit === true,
      // 认不出来的理由一律当成“现在去不了”，不猜；词表只有 street.js 那一份。
      blockedReason: isBlockedReason(raw.blockedReason) ? raw.blockedReason : null
    })
  }
  return rows
}

/**
 * 访客身上的礼物 → 桌面卡片（ticket 23 / 25）。
 *
 * 卡片**跟着访客**：这里按 `snapshot.visitors` 走，访客一走这张卡自然就不输出了，
 * 渲染端不需要另一套“什么时候收起卡片”的规则。标题与状态文案在宿主算好，
 * 渲染端只画（`gift-text.js` 是唯一文案表）。
 *
 * 文件礼物额外带 name/size；`thumb` 只在**真的收下**且扩展名是 jpg/png/gif/webp 时给，
 * 地址由 service 注入的 `thumbOf(giftId)` 算（目录名+文件名都来自礼物 store）。
 */
function giftsFromSnapshot (snapshot, { thumbOf = null } = {}) {
  const gifts = []
  const visitors = Array.isArray(snapshot.visitors) ? snapshot.visitors : []
  for (const visitor of visitors) {
    if (gifts.length >= shared.MAX_GIFT_ITEMS) break
    if (visitor === null || typeof visitor !== 'object') continue
    const deviceId = deviceIdOf(visitor.deviceId)
    if (deviceId === null) continue
    const gift = visitor.gift
    if (gift === null || typeof gift !== 'object') continue
    if (!isVisitId(gift.id)) continue
    if (!isGiftStatus(gift.status)) continue
    const label = shared.normalizeLabel(visitor.nickname, '邻居')
    const giftId = gift.id.toLowerCase()
    const statusText = giftStatusText(gift.status, gift.reason ?? null)
    if (gift.kind === 'file') {
      // 文件名与大小缺一个就画不出文件卡，整张丢掉（room 永远给全，这里防的是手改/旧快照）。
      const name = sanitizeGiftName(gift.name)
      const size = Number.isInteger(gift.size) && gift.size > 0 ? gift.size : null
      if (name === null || size === null) continue
      const thumb = gift.status === 'received' && isThumbName(name) && typeof thumbOf === 'function'
        ? thumbOf(giftId)
        : null
      gifts.push({
        deviceId,
        giftId,
        kind: 'file',
        status: gift.status,
        title: giftTitleText(label, 'file'),
        name,
        size,
        // 缩略图只给真的能画的图片；其余一律给文件图标（渲染端只按有没有 thumb 画）。
        ...(typeof thumb === 'string' && thumb !== '' ? { thumb } : {}),
        ...(statusText === null ? {} : { statusText })
      })
      continue
    }
    if (gift.kind !== 'text') continue
    gifts.push({
      deviceId,
      giftId,
      kind: 'text',
      status: gift.status,
      title: giftTitleText(label, 'text'),
      // 正文只在本机真的收下之后才给：pending 时 note.txt 还没写完，给一半会骗人。
      ...(gift.status === 'received' ? { text: gift.text } : {}),
      ...(statusText === null ? {} : { statusText })
    })
  }
  return gifts
}

/** 只有这四种扩展名能在卡片上画缩略图（与 desktop/main.js 的协议白名单同一个口径）。 */
function isThumbName (name) {
  return /\.(?:jpe?g|png|gif|webp)$/i.test(name)
}

/**
 * 快照 → 桌面控件状态（ticket 11）。宿主仍然是权威：这里只把 room 的
 * “能不能串门/召回了/谁可以送客/有没有待放行”翻译成渲染端可画的布尔与文案。
 *
 * 农场不在桌面控件里（ticket 46）：地块条已删，完整农场只走 `farm-window` 命令；
 * 桌面只保留 `role:'worker'` 的雇工宠物（它是宠物，不是农场）。
 *
 * 文案必须是人话——渲染端只负责显示，不猜 error code；失败/置灰都不允许静默。
 * 渲染端只会把这些按钮点击翻译成 action 申请，状态变化仍然等下一次快照。
 *
 * @param {object} snapshot room.snapshot()
 * @returns {object} 与 shared.emptyControls() 同形状的归一化控件状态
 */
export function controlsFromSnapshot (snapshot, options = {}) {
  const controls = shared.emptyControls()
  if (snapshot === null || typeof snapshot !== 'object') return controls

  const self = snapshot.self !== null && typeof snapshot.self === 'object' ? snapshot.self : null
  const out = self !== null && self.out !== null && typeof self.out === 'object' ? self.out : null
  const work = self !== null && self.work !== null && typeof self.work === 'object' ? self.work : null
  const away = out !== null
  const working = work !== null
  const awayNickname = away ? shared.normalizeLabel(out.nickname, '邻居') : null

  const targets = Array.isArray(snapshot.visitTargets) ? snapshot.visitTargets : []
  const canVisit = !away && !working && targets.length > 0
  controls.visit.enabled = canVisit
  if (canVisit) {
    controls.visit.reason = null
  } else if (working) {
    // ticket 44：在外打工与出门串门是两种「不在家」，下一步不同。
    controls.visit.reason = visitReasonText('already-working', null)
  } else if (away) {
    // 和 room 的 already-out notice 是同一句话：按钮和气泡不许各说各的。
    controls.visit.reason = visitReasonText('already-out', awayNickname)
  } else {
    // 没有目标时不能一律说“还没有人放行你”：有人放行但都离线是另一句话。
    // room 在快照里给出原因（no-admitted / no-online），这里只负责翻译。
    const blocked = isVisitReason(snapshot.visitBlockedReason)
      ? snapshot.visitBlockedReason
      : 'no-admitted'
    controls.visit.reason = visitReasonText(blocked, null)
  }
  // 召回只服务串门；雇工合同在农场窗里召回（recall-worker）。
  controls.recall.enabled = away
  controls.recall.nickname = awayNickname

  const visitors = Array.isArray(snapshot.visitors) ? snapshot.visitors : []
  for (const visitor of visitors) {
    if (controls.visitors.length >= shared.MAX_SCENE_ITEMS) break
    if (visitor === null || typeof visitor !== 'object') continue
    const deviceId = deviceIdOf(visitor.deviceId)
    if (deviceId === null) continue
    if (controls.visitors.some((candidate) => candidate.deviceId === deviceId)) continue
    controls.visitors.push({ deviceId, label: shared.normalizeLabel(visitor.nickname, '邻居') })
  }

  controls.street = streetFromSnapshot(snapshot)
  controls.gifts = giftsFromSnapshot(snapshot, options)

  const prompt = snapshot.prompt !== null && typeof snapshot.prompt === 'object' ? snapshot.prompt : null
  if (prompt !== null) {
    const deviceId = deviceIdOf(prompt.deviceId)
    if (deviceId !== null) {
      controls.prompt = { deviceId, nickname: shared.normalizeLabel(prompt.nickname, '邻居') }
    }
  }

  // 异步失败（对方失联、超时、被送客）不会走 action 的返回值，靠最新 notice 冒泡。
  const notice = Array.isArray(snapshot.notices) && snapshot.notices.length > 0
    ? snapshot.notices[0]
    : null
  if (notice !== null && typeof notice === 'object' &&
    typeof notice.text === 'string' && notice.text.trim() !== '' &&
    Number.isFinite(notice.at) && notice.at >= 0) {
    controls.notice = {
      text: notice.text.trim().slice(0, shared.MAX_NOTICE_LENGTH),
      at: notice.at
    }
  }

  return controls
}
