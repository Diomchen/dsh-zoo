/**
 * 测试分档（票 60）。
 *
 * 默认 `npm test` **不碰网络**：一旦某个用例开了 socket（回环 UDP 发现、本机 HTTP 素材源、
 * 桥接服务器），就归到 `NETWORK_TESTS`，只在显式 `npm run test:net` 时跑。
 *
 * 为什么不是按文件名猜：这些用例的名字（`*-e2e`）不可靠——`farm-e2e.test.js` 其实
 * 只在进程内调路由处理器，反而是 `service.test.js` 会真的 `listen(0)`。所以这里有一份
 * 显式清单，并且 `test/network-classification.test.js` 会扫源码兜底：新写的用例只要
 * 出现 `dgram` / `createServer(` / `.listen(`，不在清单里就会当场报错。
 *
 * 这些用例**全部只打回环**（`127.0.0.1` + 随机端口），不会广播到局域网；
 * 真机联调按 README 的说明只对指定机器（DESKTOP-699DN63）做，不要对着整个网段跑。
 */

/** 会开 socket 的用例：回环 UDP（发现/串门/偷菜/雇工/礼物）与本机 HTTP（素材源/桥接/菜单）。 */
export const NETWORK_TESTS = new Set([
  'bring-e2e.test.js',
  'discovery.test.js',
  'farm-action-e2e.test.js',
  'farm-retry-e2e.test.js',
  'farm-visit-e2e.test.js',
  'gift-e2e.test.js',
  'gift-fetch.test.js',
  'gift-file-e2e.test.js',
  'guests.test.js',
  'lan-server.test.js',
  'market-digest-e2e.test.js',
  'menu-actions.test.js',
  'open-site-auth.test.js',
  'pet-bridge.test.js',
  'raid-inbound.test.js',
  'receipt-e2e.test.js',
  'service.test.js',
  'skin-fetch.test.js',
  'visit-e2e.test.js',
  'work-action-e2e.test.js',
  'work-lossy-e2e.test.js'
])

/** 出现这些写法就认为这个用例会开 socket（与清单一起兜底）。 */
export const SOCKET_PATTERN = /\b(?:node:)?(?:dgram|net)\b\s*['"]|createServer\s*\(|\.listen\s*\(|createSocket\s*\(/

/** 只在注释/字符串里提到这些词、并不真的开 socket 的用例：写明原因，别默默豁免。 */
export const SOCKET_ALLOWLIST = new Set()
