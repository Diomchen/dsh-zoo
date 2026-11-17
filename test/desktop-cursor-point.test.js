import assert from 'node:assert/strict'
import test from 'node:test'

import shared from '../desktop/shared.js'

/**
 * 票 93：混合 DPI 下点击穿透打不开。
 *
 * 现场：主屏 1920×1200 @125%、副屏 3840×2160 @150%，桌面层是一扇铺满并集的透明窗（按 150% 渲染）。
 * 渲染端报告 `hoverInside=true`（光标确实压在宠物上），主进程却算出 `insideForMs=null`——
 * 它用 `screen.getCursorScreenPoint() − win.getBounds()` 反推本地坐标，而 OS 光标按 125% 折算，
 * 两边差了 20% 左右，命中矩形永远对不上，窗口一直停在穿透。
 *
 * 修法：混合 DPI 时以渲染端上报的 CSS 指针为准（它和命中矩形同一套坐标）；其余情况保持原行为。
 */

const AREA = { x: 0, y: 0, width: 4096, height: 1395 }
const NOW = 1_000_000

test('单一缩放：仍然用 OS 光标（原行为不变）', () => {
  const picked = shared.chooseLocalPoint({
    osPoint: { x: 608, y: 1269 },
    rendererPoint: { x: 763, y: 1297 },
    rendererAt: NOW - 20,
    now: NOW,
    preferRenderer: false,
    area: AREA
  })

  assert.deepEqual(picked, { point: { x: 608, y: 1269 }, source: 'os' })
})

test('混合 DPI：渲染端指针新鲜时以它为准（票 93 回归）', () => {
  const picked = shared.chooseLocalPoint({
    osPoint: { x: 608, y: 1269 },
    rendererPoint: { x: 763, y: 1297 },
    rendererAt: NOW - 20,
    now: NOW,
    preferRenderer: true,
    area: AREA
  })

  assert.deepEqual(picked, { point: { x: 763, y: 1297 }, source: 'renderer' })
})

test('渲染端指针过期：退回 OS 光标，不让旧位置一直占用桌面', () => {
  const picked = shared.chooseLocalPoint({
    osPoint: { x: 608, y: 1269 },
    rendererPoint: { x: 763, y: 1297 },
    rendererAt: NOW - shared.HOVER_POINT_MAX_AGE_MS - 1,
    now: NOW,
    preferRenderer: true,
    area: AREA
  })

  assert.deepEqual(picked, { point: { x: 608, y: 1269 }, source: 'os' })
})

test('渲染端指针越界：当没报（坏消息不能把整块屏幕变成可交互区）', () => {
  const picked = shared.chooseLocalPoint({
    osPoint: { x: 100, y: 100 },
    rendererPoint: { x: 9000, y: -50 },
    rendererAt: NOW - 10,
    now: NOW,
    preferRenderer: true,
    area: AREA
  })

  assert.deepEqual(picked, { point: { x: 100, y: 100 }, source: 'os' })
})

test('渲染端指针形状不对 / 时间戳缺失：当没报', () => {
  for (const rendererPoint of [null, 'x', { x: 'a', y: 1 }, { x: Number.NaN, y: 1 }]) {
    const picked = shared.chooseLocalPoint({
      osPoint: { x: 10, y: 20 },
      rendererPoint,
      rendererAt: NOW - 10,
      now: NOW,
      preferRenderer: true,
      area: AREA
    })
    assert.equal(picked.source, 'os')
  }

  const noStamp = shared.chooseLocalPoint({
    osPoint: { x: 10, y: 20 },
    rendererPoint: { x: 30, y: 40 },
    rendererAt: 0,
    now: NOW,
    preferRenderer: true,
    area: AREA
  })
  assert.deepEqual(noStamp, { point: { x: 10, y: 20 }, source: 'os' })
})

test('OS 光标拿不到时，渲染端的指针就是唯一来源', () => {
  const picked = shared.chooseLocalPoint({
    osPoint: null,
    rendererPoint: { x: 763, y: 1297 },
    rendererAt: NOW - 10,
    now: NOW,
    preferRenderer: false,
    area: AREA
  })

  assert.deepEqual(picked, { point: { x: 763, y: 1297 }, source: 'renderer' })
})

test('两边都没有：返回空点，调用方按 fail-closed 处理', () => {
  const picked = shared.chooseLocalPoint({ now: NOW })
  assert.deepEqual(picked, { point: null, source: null })
})

test('混合 DPI 但渲染端还没报指针：照样用 OS 光标', () => {
  const picked = shared.chooseLocalPoint({
    osPoint: { x: 608, y: 1269 },
    rendererPoint: null,
    rendererAt: 0,
    now: NOW,
    preferRenderer: true,
    area: AREA
  })

  assert.deepEqual(picked, { point: { x: 608, y: 1269 }, source: 'os' })
})

test('status 事件：命中坐标来源与渲染端指针穿过宿主白名单', () => {
  const parsed = shared.normalizeHelperEvent({
    type: 'status',
    id: 1,
    pointer: { x: 608, y: 787 },
    pointerSource: 'renderer',
    hoverPoint: { x: 763, y: 1297 }
  })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.event.status.pointerSource, 'renderer')
  assert.deepEqual(parsed.event.status.hoverPoint, { x: 763, y: 1297 })
})

test('status 事件：未知来源当没有（不把脏字符串透给宿主）', () => {
  const parsed = shared.normalizeHelperEvent({
    type: 'status',
    id: 1,
    pointerSource: 'magic'
  })

  assert.equal(parsed.ok, true)
  assert.equal(parsed.event.status.pointerSource, null)
})
