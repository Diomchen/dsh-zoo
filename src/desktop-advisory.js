/**
 * 桌面层的「共存提示」。现在只有一条：dsh-pet 与 dsh-zoo 同时在画（ticket 31）。
 *
 * 为什么值得提示：两个 helper 都是全屏透明、默认点穿的置顶层，命中区只覆盖各自的宠物。
 * 两只宠物位置重叠时，用户看到的是下面那只、拖到的却是上面那层——症状像「宠物拖不动」，
 * 其实是在拖另一只。宿主已经知道 dsh-pet 可不可达（pet-bridge），所以能提前说一句。
 *
 * 纯函数：不读全局、不发日志，方便单测；接线在 src/service.js。
 */

export const DUAL_LAYER_NOTE =
  'dsh-pet 也在画桌面宠物：两个透明层重叠时，看到的那只和拖到的那只可能不是同一只。' +
  '只留一个桌面层——关掉 dsh-pet 的桌面窗，或设 DSH_ZOO_DESKTOP=0 关掉这一层。'

/**
 * @param {{desktopRunning?: boolean, bridge?: {ok?: boolean}|null, pet?: object|null}} [input]
 * @returns {{code: string, note: string}|null} 不需要提示时返回 null
 */
export function dualLayerAdvisory ({ desktopRunning = false, bridge = null, pet = null } = {}) {
  if (desktopRunning !== true) return null
  // dsh-pet 不可达 = 没装 / 没响应 / 还在启动：它不会画，提示只会添乱。
  if (bridge === null || typeof bridge !== 'object' || bridge.ok !== true) return null
  // 可达但没有宠物：dsh-pet 那边什么都没画。
  if (pet === null || typeof pet !== 'object' || Array.isArray(pet)) return null
  return { code: 'dual-desktop-layer', note: DUAL_LAYER_NOTE }
}
