/**
 * 出远门窗口的三份动作清单必须对得上（票 118 的漏网之鱼）。
 *
 * 由来：`expedition-lantern` 在渲染端、`desktop/shared.js` 的白名单、`src/service.js`
 * 的分发里都加了，唯独漏了 `desktop/expedition-preload.js` 的 `FIELDS`。
 * 结果点「买提灯」时 preload 直接返回 false，窗口只弹一句「这个动作发不出去」，
 * 看着像「功能没做」，其实是动作过不了桥。
 *
 * 三处各管一段，谁也看不见谁，所以用一条对账测试把它们钉在一起：
 *   1. 渲染端 `send({ action: '…' })` 用到的每个动作，preload 必须放行；
 *   2. preload 放行的每个动作，宿主白名单里必须有；
 *   3. 宿主白名单里的每个动作，preload 也必须放行。
 *
 * 2026-11-20 又漏了第四处：`src/service.js` 的 `handleDesktopAction` 手抄字段拼入参，
 * 没抄 `routeId` 与陈列架四字段，窗口点「出发」只会收到「没有这条路线。」——
 * 所以再加一条：preload 放行的字段，服务端这一跳必须原样带到 `handleAction`。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const DESKTOP = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop')

async function read (name) {
  return readFile(join(DESKTOP, name), 'utf8')
}

/** 渲染端写的 `send({ action: 'x' })`。 */
function rendererActions (source) {
  const found = new Set()
  for (const match of source.matchAll(/action:\s*'([a-z-]+)'/g)) found.add(match[1])
  return found
}

/** preload 的 `FIELDS` 键。 */
function preloadActions (source) {
  const block = source.slice(source.indexOf('const FIELDS'))
  const found = new Set()
  for (const match of block.matchAll(/^\s*'([a-z-]+)':/gm)) found.add(match[1])
  return found
}

/** 宿主白名单数组 `EXPEDITION_SUBMIT_ACTIONS`。 */
function hostActions (source) {
  const start = source.indexOf('const EXPEDITION_SUBMIT_ACTIONS')
  const block = source.slice(start, source.indexOf(']', start))
  const found = new Set()
  for (const match of block.matchAll(/'([a-z-]+)'/g)) found.add(match[1])
  return found
}

test('出远门窗口的动作用到的都能过桥', async () => {
  const used = rendererActions(await read('expedition.js'))
  const bridged = preloadActions(await read('expedition-preload.js'))
  assert.ok(used.size >= 5, '渲染端至少该有五个动作，正则可能失效了')

  const blocked = [...used].filter((action) => !bridged.has(action)).sort()
  assert.deepEqual(blocked, [], '这些动作在 preload 里没放行，点了只会弹「这个动作发不出去」')
})

/** preload 的 `动作 → 允许字段`。 */
function preloadFieldMap (source) {
  const map = new Map()
  for (const match of source.matchAll(/^\s*'([a-z-]+)':\s*\[([^\]]*)\]/gm)) {
    map.set(match[1], [...match[2].matchAll(/'([A-Za-z]+)'/g)].map((item) => item[1]))
  }
  return map
}

/** `src/service.js` 的 `handleDesktopAction` 手抄给 `handleAction` 的字段表。 */
function desktopFieldSet (source) {
  const start = source.indexOf('async function handleDesktopAction')
  assert.ok(start >= 0, '找不到 handleDesktopAction，正则可能失效了')
  const open = source.indexOf('await handleAction({', start)
  assert.ok(open >= 0, 'handleDesktopAction 里找不到 handleAction({ ')
  const close = source.indexOf('\n      })', open)
  assert.ok(close > open, 'handleAction({ … }) 的字面量没闭合')
  const found = new Set()
  for (const match of source.slice(open, close).matchAll(/^\s{8}([A-Za-z]+):\s/gm)) found.add(match[1])
  return found
}

/** 农场窗 `submit()` 显式转发给主进程的字段。 */
function farmForwardedFields (source) {
  const open = source.indexOf("ipcRenderer.send('dsh-zoo:farm-submit', {")
  assert.ok(open >= 0, '农场 preload 里找不到 farm-submit 的转发对象')
  const close = source.indexOf('\n    })', open)
  assert.ok(close > open, 'farm-submit 的对象没闭合')
  const found = new Set()
  for (const match of source.slice(open, close).matchAll(/^\s{6}([A-Za-z]+):/gm)) found.add(match[1])
  return found
}

test('窗口能发的字段，服务端这一跳也得原样带上', async () => {
  const declared = preloadFieldMap(await read('expedition-preload.js'))
  const carried = desktopFieldSet(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'service.js'), 'utf8'))
  assert.ok(declared.size >= 5, 'preload 字段表解析失败')
  assert.ok(carried.size >= 20, '服务端字段表解析失败')

  const dropped = []
  for (const [action, fields] of declared) {
    for (const field of fields) {
      if (!carried.has(field)) dropped.push(`${action} → ${field}`)
    }
  }
  assert.deepEqual(dropped, [], '这些字段在 handleDesktopAction 里被丢掉，窗口点下去只会收到莫名其妙的错误')
})

test('农场窗转发的字段同样不能在宿主这一跳不见', async () => {
  const forwarded = farmForwardedFields(await read('farm-preload.js'))
  const carried = desktopFieldSet(await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'service.js'), 'utf8'))
  assert.ok(forwarded.size >= 8, '农场 preload 字段解析失败')

  // `action` 是动作名本身；其余每个字段宿主都得接住。
  const dropped = [...forwarded].filter((field) => field !== 'action' && !carried.has(field)).sort()
  assert.deepEqual(dropped, [], '这些字段在 handleDesktopAction 里被丢掉，窗口点了只会没反应或落错页')
})

test('preload 与宿主白名单一一对应', async () => {
  const bridged = [...preloadActions(await read('expedition-preload.js'))].sort()
  const host = [...hostActions(await read('shared.js'))].sort()
  assert.ok(host.length >= 5, '宿主白名单解析失败')
  assert.deepEqual(bridged, host, 'preload 与 shared.js 的动作清单必须一致，否则不是发不出去就是白名单虚设')
})
