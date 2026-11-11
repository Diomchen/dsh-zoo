/**
 * 局域网只读服务的路由表。
 *
 * 改名（dsh-local-pet → dsh-zoo）不换端口、不换 UDP 报文，但路径确实变了。
 * 已经装在邻居机器上的旧版本（≤0.5.7）只认旧路径；为了让它们照常换肤、照常拉文件礼物，
 * 服务端同时接受两组路径，客户端也先试新路径、404 再回落旧路径。
 * 旧路径只读、只在 GET/HEAD 上存在，不参与广播——新版本不会再把旧名字发出去。
 */

/** 新路径：本版本的规范写法。 */
export const SKIN_ROUTE = '/dsh-zoo-skin'
export const GIFT_ROUTE = '/dsh-zoo-gift'
/** 农场快照（ticket 43）：只有新路径；改名前的邻居没有农场，不需要旧名字。 */
export const FARM_ROUTE = '/dsh-zoo-farm'
/** 公开只读视图（票 52）：`/dsh-zoo-farm/open/<viewerDeviceId>`，不需要串门。 */
export const FARM_OPEN_SEGMENT = 'open'

/** 旧路径：改名前的邻居还在用；纯兼容，不新增功能。 */
export const LEGACY_SKIN_ROUTE = '/local-pet-skin'
export const LEGACY_GIFT_ROUTE = '/local-pet-gift'

/** 按优先级排列：客户端按这个顺序试，服务端按同一张表匹配。 */
export const SKIN_ROUTES = Object.freeze([SKIN_ROUTE, LEGACY_SKIN_ROUTE])
export const GIFT_ROUTES = Object.freeze([GIFT_ROUTE, LEGACY_GIFT_ROUTE])
export const FARM_ROUTES = Object.freeze([FARM_ROUTE])

/**
 * pathname 命中哪条路由。
 * 返回 `{ route, rest }`，`rest` 是不含前导 `/` 的剩余部分；都不命中返回 null。
 * 只做前缀匹配，真正的形状校验留给调用方（礼物只有一段、素材有 manifest/asset 两种）。
 */
export function matchRoute (pathname, routes) {
  for (const route of routes) {
    if (pathname === route) return { route, rest: '' }
    if (pathname.startsWith(route + '/')) {
      return { route, rest: pathname.slice(route.length + 1) }
    }
  }
  return null
}
