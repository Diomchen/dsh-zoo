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

/** 自己的 deviceId 是身份层生成的 UUID；这里只做形状校验，不信任任何外部输入。 */
const DEVICE_ID = /^[A-Za-z0-9_-]{1,56}$/

function deviceIdOf (value) {
  if (typeof value !== 'string') return null
  const id = value.trim()
  return DEVICE_ID.test(id) ? id : null
}

function selfDescriptor (self) {
  if (self === null || typeof self !== 'object') return null
  // 出门了（请求中/已抵达）：本机桌面不再显示自己。ticket 09 直接依赖这一条。
  if (self.out !== null && typeof self.out === 'object') return null
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
  // 客人用自己的色板格；避开与 self 相同的蓝色，免得七八只全一个颜色。
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
 * @param {object} snapshot room.snapshot()
 * @returns {Array<{id:string,role:'self'|'visitor',label:string,anim:string|null,color:string}>}
 */
export function petsFromSnapshot (snapshot) {
  const pets = []
  if (snapshot === null || typeof snapshot !== 'object') return pets

  const self = selfDescriptor(snapshot.self)
  if (self !== null) pets.push(self)

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
 * 快照 → 桌面控件状态（ticket 11）。宿主仍然是权威：这里只把 room 的
 * “能不能串门/召回了/谁可以送客/有没有待放行”翻译成渲染端可画的布尔与文案。
 *
 * 文案必须是人话——渲染端只负责显示，不猜 error code；失败/置灰都不允许静默。
 * 渲染端只会把这些按钮点击翻译成 action 申请，状态变化仍然等下一次快照。
 *
 * @param {object} snapshot room.snapshot()
 * @returns {object} 与 shared.emptyControls() 同形状的归一化控件状态
 */
export function controlsFromSnapshot (snapshot) {
  const controls = shared.emptyControls()
  if (snapshot === null || typeof snapshot !== 'object') return controls

  const self = snapshot.self !== null && typeof snapshot.self === 'object' ? snapshot.self : null
  const out = self !== null && self.out !== null && typeof self.out === 'object' ? self.out : null
  const away = out !== null
  const awayNickname = away ? shared.normalizeLabel(out.nickname, '邻居') : null

  const targets = Array.isArray(snapshot.visitTargets) ? snapshot.visitTargets : []
  const canVisit = !away && targets.length > 0
  controls.visit.enabled = canVisit
  if (canVisit) {
    controls.visit.reason = null
  } else if (away) {
    controls.visit.reason = `宠物在「${awayNickname}」家，先召回再串门。`
  } else {
    controls.visit.reason = '还没有人放行你，宠物出不了门。'
  }
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
