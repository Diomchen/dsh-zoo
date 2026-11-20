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

test('preload 与宿主白名单一一对应', async () => {
  const bridged = [...preloadActions(await read('expedition-preload.js'))].sort()
  const host = [...hostActions(await read('shared.js'))].sort()
  assert.ok(host.length >= 5, '宿主白名单解析失败')
  assert.deepEqual(bridged, host, 'preload 与 shared.js 的动作清单必须一致，否则不是发不出去就是白名单虚设')
})
