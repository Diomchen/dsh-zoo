/**
 * 票 52 回归：看田窗口不能被"刷新"踢回自己农场。
 *
 * 现场：点「看看农场」之后窗口停在 `mode:'look'`，过几秒（行情摘要/自家作物到点/
 * 邻居来偷）就被打回 `mode:'owner'`——宿主每次 `refreshFarmWindow()` 都按
 * `self.out` 重算模式，只记得访客视图、不记得"正在看谁家"。
 *
 * 这条用例把宿主真正下发到 helper 的 `farm-window` 命令序列录下来：
 *   1. 看田之后，行情摘要照常到达（B 每 1 秒一轮），但不能出现任何非 look 的窗口命令；
 *   2. `farm-refresh`（窗口倒计时到点）在看田期间必须还回看田视图，而不是自己农场；
 *   3. 「我的农场」那颗圆片发的 `farm-own` 才是回自己农场的唯一出口。
 *
 * 用回环上的两只真宠物（同 `test/two-pets-harness.test.js`），不写假邻居：
 * 行情摘要走的是真实的 UDP 链路，这条 bug 只在"链路真的活着"时出现。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { startPair, until } from '../scripts/lib/pet.mjs'

/** 只记录窗口命令的桌面替身；不 spawn Electron。 */
function desktopDouble () {
  const windows = []
  let onEvent = null
  let farmOpen = false
  return {
    windows,
    factory () {
      return {
        start () { return { ok: true, pid: 4242 } },
        update () { return true },
        resync () { return true },
        status () { return { farmOpen } },
        farmWindow (payload) {
          windows.push(payload)
          if (payload.close === true) farmOpen = false
          else if (payload.open === true) farmOpen = true
          return true
        },
        bringWindow () { return true },
        actionResult () {},
        dispose () {}
      }
    },
    ready () {
      const area = { x: 0, y: 30, width: 1000, height: 700 }
      onEvent?.({
        type: 'ready',
        pid: 4242,
        workArea: area,
        displays: [{ id: 1, bounds: area, workArea: area, scaleFactor: 1, primary: true }]
      })
    }
  }
}

function makeDesk () {
  return desktopDouble()
}

/** 起一对宠物：A 有桌面替身，B 每 1 秒广播一轮行情。 */
async function startPairWithWindow (t) {
  const desk = makeDesk()
  const pair = await startPair({
    // 行情摘要是这条 bug 的触发器：两边都把周期压到 1 秒，别为一次回归等 30 秒。
    a: { desktop: true, desktopFactory: desk.factory, env: {}, desktopSyncMs: 50, marketDigestMs: 1000 },
    b: { marketDigestMs: 1000 }
  })
  t.after(() => pair.close())
  return { pair, desk }
}

/** 互相发现 + 互相放行：行情摘要只发给放行邻居。 */
async function knowEachOther (pair) {
  await until(async () => (await pair.a.state()).neighbors.some((n) => n.deviceId === pair.b.deviceId), {
    label: 'A 的邻居表里出现 B'
  })
  await until(async () => (await pair.b.state()).neighbors.some((n) => n.deviceId === pair.a.deviceId), {
    label: 'B 的邻居表里出现 A'
  })
  const out = await pair.a.action('admit', { deviceId: pair.b.deviceId })
  assert.equal(out.body.ok, true, JSON.stringify(out.body))
  const back = await pair.b.action('admit', { deviceId: pair.a.deviceId })
  assert.equal(back.body.ok, true, JSON.stringify(back.body))
}

/** 点「看看农场」：对方 LAN 端口是异步起来的，`no-port` / `refused` 当"还没好"重试。 */
async function look (pair, desk) {
  const result = await until(async () => {
    const response = await pair.a.action('farm-look', { deviceId: pair.b.deviceId })
    if (response.body.ok === true) return response
    if (response.body.error === 'no-port' || response.body.error === 'refused') return false
    assert.fail('看田失败：' + JSON.stringify(response.body))
  }, { label: 'A 看到 B 的农场', timeoutMs: 10000 })
  assert.equal(result.body.window, 'opened')
  const payload = desk.windows.at(-1)
  assert.equal(payload.mode, 'look')
  assert.equal(payload.look.deviceId, pair.b.deviceId)
  return payload
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('看田：行情摘要刷新不会把窗口踢回自己农场', async (t) => {
  const { pair, desk } = await startPairWithWindow(t)
  await knowEachOther(pair)
  desk.ready()
  await look(pair, desk)
  const seen = desk.windows.length

  // B 每 1 秒一轮行情摘要；A 收到就要推一次窗口刷新。3.5 秒足够跨过好几轮。
  await delay(3500)

  const pushed = desk.windows.slice(seen)
  const kicked = pushed.filter((payload) => payload.mode !== 'look')
  assert.deepEqual(
    kicked,
    [],
    '看田期间被推了 ' + kicked.length + ' 次非 look 的窗口命令（最近一次 mode=' + kicked.at(-1)?.mode + '）'
  )
})

test('看田：farm-refresh 留在看田视图，farm-own 才回自己农场', async (t) => {
  const { pair, desk } = await startPairWithWindow(t)
  await knowEachOther(pair)
  desk.ready()
  await look(pair, desk)

  // 窗口倒计时到点 → 请宿主重推：必须是邻居家的新一份，不是自己农场。
  const before = desk.windows.length
  const refreshed = await pair.a.action('farm-refresh')
  assert.equal(refreshed.body.ok, true, JSON.stringify(refreshed.body))
  await until(() => desk.windows.length > before, { label: 'farm-refresh 推了一份新视图' })
  const next = desk.windows.at(-1)
  assert.equal(next.mode, 'look', 'farm-refresh 不该改模式')
  assert.equal(next.look.deviceId, pair.b.deviceId)

  // 「我的农场」那颗圆片：显式切回主人视图。
  const own = await pair.a.action('farm-own')
  assert.equal(own.body.ok, true, JSON.stringify(own.body))
  await until(() => desk.windows.at(-1).mode === 'owner', { label: '切回自己农场' })
  assert.equal(desk.windows.at(-1).look ?? null, null, '不能把上一次的邻居视图带回来')
})
