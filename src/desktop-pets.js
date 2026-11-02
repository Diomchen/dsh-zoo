/**
 * 把 room 的快照翻译成「桌面上应该有谁」。
 *
 * 这是宿主对宠物身份/动作的唯一权威：渲染端只按这个列表增删宠物、切换素材。
 * 坐标不在这里（ADR-0003 不变）；桌面位置由 helper 的渲染端本地模拟。
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

function guestDescriptor (raw, role) {
  if (raw === null || typeof raw !== 'object') return null
  const deviceId = deviceIdOf(raw.deviceId)
  if (deviceId === null) return null
  // 客人用自己的色板格；避开与 self 相同的蓝色，免得七八只全一个颜色。
  const palette = shared.PET_COLORS.slice(1)
  const color = palette[shared.hashString(deviceId) % palette.length]
  return {
    id: role + ':' + deviceId,
    role,
    label: shared.normalizeLabel(raw.nickname, '邻居'),
    anim: shared.normalizeAnim(raw.anim),
    color
  }
}

/**
 * @param {object} snapshot room.snapshot()
 * @returns {Array<{id:string,role:'self'|'guest'|'visitor',label:string,anim:string|null,color:string}>}
 */
export function petsFromSnapshot (snapshot) {
  const pets = []
  if (snapshot === null || typeof snapshot !== 'object') return pets

  const self = selfDescriptor(snapshot.self)
  if (self !== null) pets.push(self)

  const guests = Array.isArray(snapshot.guests) ? snapshot.guests : []
  const visitors = Array.isArray(snapshot.visitors) ? snapshot.visitors : []

  // 同一位邻居既可能有 30 秒心跳影子、又真的在串门：串门记录优先，只画一只。
  const visitorIds = new Set()
  for (const visitor of visitors) {
    const deviceId = visitor !== null && typeof visitor === 'object' ? deviceIdOf(visitor.deviceId) : null
    if (deviceId !== null) visitorIds.add(deviceId)
  }

  const seen = new Set()
  for (const guest of guests) {
    if (pets.length >= shared.MAX_SCENE_ITEMS) return pets
    const deviceId = guest !== null && typeof guest === 'object' ? deviceIdOf(guest.deviceId) : null
    if (deviceId === null || visitorIds.has(deviceId)) continue
    const pet = guestDescriptor(guest, 'guest')
    if (pet === null || seen.has(pet.id)) continue
    seen.add(pet.id)
    pets.push(pet)
  }
  // 串门访客后画（场景顺序 = DOM 顺序 = 画在最上层）。
  for (const visitor of visitors) {
    if (pets.length >= shared.MAX_SCENE_ITEMS) return pets
    const pet = guestDescriptor(visitor, 'visitor')
    if (pet === null || seen.has(pet.id)) continue
    seen.add(pet.id)
    pets.push(pet)
  }
  return pets
}
