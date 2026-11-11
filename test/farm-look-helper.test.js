/**
 * 票 54 的**第二道窄口**：helper → 宿主这一跳也不能把 `deviceId` 削掉。
 *
 * 现场（Windows 验收）：「每个邻居的农场都显示『这位邻居已经不在桌面上了』」。
 * 链路是 `desktop/main.js`（右键邻居 → farm-look，带 deviceId）→ helper 写一行 →
 * `src/desktop.js` 用 `shared.normalizeHelperEvent` 解析 → 宿主 `handleDesktopAction`。
 * 票 54 把两条农场动作加进了 **main.js** 的白名单，宿主那份 `needsDevice` 却还是四个旧动作，
 * 于是 `deviceId` 在这里被置成 null，宿主拿到 undefined → `bad-device-id` →
 * `desktopActionNotice` 回一句「这位邻居已经不在桌面上了。」——每一位邻居都一样。
 *
 * 为什么这条测试必须从**helper 那一行**开始：农场小窗里的邻居圆片走的是
 * `dsh-zoo:farm-submit` → `normalizeFarmAction`（那条路一直是对的，见 `farm-look-window.test.js`）。
 * 只测 `normalizeFarmAction` 会让这个 bug 绿着出厂。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import shared from '../desktop/shared.js'
import { startPair, until } from '../scripts/lib/pet.mjs'

const NEIGHBOR = '22222222-2222-4222-8222-222222222222'
/** 宿主回给窗口的那句人话（`src/service.js` 的 `desktopActionNotice`）。 */
const SYMPTOM = '这位邻居已经不在桌面上了。'

/** helper 真正写出的那一行（`desktop/main.js` 的 `writeEvent`）：走一遍宿主的解析。 */
function hostEvent (event) {
  const line = shared.encodeMessage(event)
  const parsed = shared.parseLine(line)
  assert.equal(parsed.ok, true, 'helper 那一行应该是合法 JSON')
  return shared.normalizeHelperEvent(parsed.value)
}

test('helper → 宿主：看田/派它去偷带着 deviceId 过河', () => {
  for (const action of ['farm-look', 'farm-raid']) {
    const normalized = hostEvent({ type: 'action', id: 1, action, deviceId: NEIGHBOR })
    assert.equal(normalized.ok, true, action + ' 应该被宿主认下')
    assert.equal(normalized.event.deviceId, NEIGHBOR, action + ' 的 deviceId 不能在宿主这一跳丢掉')
  }
})

test('helper → 宿主：没有对象的看田整条拒掉，不再变成 bad-device-id 的「不在桌面上」', () => {
  for (const action of ['farm-look', 'farm-raid']) {
    assert.deepEqual(hostEvent({ type: 'action', id: 1, action }), { ok: false, error: 'bad-device-id' })
  }
  // `visit` 仍然是「可以带对象」：不带就由宿主随机挑一位。
  assert.equal(hostEvent({ type: 'action', id: 2, action: 'visit' }).event.deviceId, null)
})

test('主进程与宿主共用同一份「必须有对象」清单', () => {
  // 两份手抄的白名单漂过一次（票 54）；现在只留 DEVICE_ACTIONS 一份。
  for (const action of ['end-visit', 'admit', 'reject', 'dismiss', 'farm-look', 'farm-raid']) {
    assert.ok(shared.DEVICE_ACTIONS.includes(action), action + ' 应该在 DEVICE_ACTIONS 里')
  }
  assert.equal(shared.DEVICE_ACTIONS.includes('visit'), false, 'visit 的对象是可选的')
})

test('右键邻居看田：宿主真的开出一扇 look 窗，而不是回一句「不在桌面上」', async (t) => {
  const results = []
  const windows = []
  let onEvent = null
  const pair = await startPair({
    a: {
      desktop: true,
      desktopFactory (options) {
        onEvent = options.onEvent
        return {
          start () { return { ok: true, pid: 4242 } },
          update () { return true },
          resync () { return true },
          status () { return { farmOpen: false } },
          farmWindow (payload) { windows.push(payload); return true },
          bringWindow () { return true },
          actionResult (id, result) { results.push({ id, result }) },
          dispose () {}
        }
      }
    }
  })
  t.after(() => pair.close())

  await until(async () => (await pair.a.state()).neighbors.some((n) => n.deviceId === pair.b.deviceId), {
    label: 'A 发现 B',
    timeoutMs: 10000
  })

  // 用户右键那一户：渲染端发 IPC，主进程写事件，宿主按自己的窄口解析。这里从第二跳开始。
  const normalized = hostEvent({ type: 'action', id: 'act-look', action: 'farm-look', deviceId: pair.b.deviceId })
  assert.equal(normalized.ok, true)
  onEvent(normalized.event)

  await until(() => results.length > 0, { label: '宿主回话', timeoutMs: 8000 })
  const reply = results.at(-1).result
  assert.notEqual(reply.notice, SYMPTOM, '不该再出现「这位邻居已经不在桌面上了」')
  assert.equal(reply.ok, true, JSON.stringify(reply))
  assert.equal(windows.length, 1, '应该开一扇窗')
  assert.equal(windows[0].mode, 'look')
  assert.equal(windows[0].look.deviceId, pair.b.deviceId)
  assert.equal(windows[0].look.plots.length, 4)
})
