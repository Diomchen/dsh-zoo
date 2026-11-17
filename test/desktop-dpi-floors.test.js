import assert from 'node:assert/strict'
import test from 'node:test'

import shared from '../desktop/shared.js'

/**
 * 票 94：宠物会走到「小屏的外面」（顶部和左侧）抓不回来。
 *
 * 现场：主屏 1920×1200 @125%、副屏 3840×2160 @150%，桌面层是一扇铺满并集的透明窗（按 150% 渲染）。
 * 宿主原来按显示器的 **DIP** 差值算每块屏在窗口里的矩形：主屏那块算出来是 (0,482,1536,912)，
 * 而它在窗口 CSS 坐标里的真实位置是 (256,641,1280,760)——整块地偏到屏幕左上方，宠物走上去就出了显示器。
 *
 * 修法：用物理坐标做减法（窗口物理矩形 + 每屏真实物理工作区）再除以窗口缩放。
 * 下面这组数就是这台机器上实测到的（Win32 EnumDisplayMonitors + Electron dipToScreenRect）。
 */

const AREA = { x: 0, y: 0, width: 4096, height: 1395 }

function assertRect (actual, expected, epsilon = 0.02) {
  assert.ok(actual !== null && typeof actual === 'object', '矩形不该是空的')
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) <= epsilon,
      `${key}: 期望 ${expected[key]}，实际 ${actual[key]}`
    )
  }
}

test('混合 DPI：按物理几何换算每块屏的 CSS 工作区（实测数据）', () => {
  const measured = shared.floorsFromPhysical({
    windowPhysical: { x: -384, y: -962, width: 6144, height: 2091 },
    windowScale: 1.5,
    displays: [
      { primary: true, physicalWorkArea: { x: 0, y: 0, width: 1920, height: 1140 } },
      { primary: false, physicalWorkArea: { x: 1920, y: -962, width: 3840, height: 2088 } }
    ],
    area: AREA
  })

  assert.equal(measured.floors.length, 2, '两块屏都要有地板')
  // 主屏：物理 (0,0) 减窗口物理原点再除以 1.5；底边超出窗口 6px，按窗口裁剪。
  assertRect(measured.floors[0], { x: 256, y: 641.333, width: 1280, height: 753.667 })
  // 副屏：和窗口同一缩放，正好铺满窗口右半边。
  assertRect(measured.floors[1], { x: 1536, y: 0, width: 2560, height: 1392 })
  assertRect(measured.homeArea, measured.floors[0], 1e-9)
})

test('缩放一致：物理换算和「显示器 − 窗口」等价，行为不变', () => {
  const measured = shared.floorsFromPhysical({
    windowPhysical: { x: 0, y: 0, width: 3072, height: 1920 },
    windowScale: 2,
    displays: [
      { primary: true, physicalWorkArea: { x: 0, y: 0, width: 3072, height: 1860 } }
    ],
    area: { x: 0, y: 0, width: 1536, height: 960 }
  })

  assert.equal(measured.floors.length, 1)
  assertRect(measured.floors[0], { x: 0, y: 0, width: 1536, height: 930 })
  assertRect(measured.homeArea, measured.floors[0], 1e-9)
})

test('拿不到窗口物理矩形：返回空，调用方回退旧算法', () => {
  const measured = shared.floorsFromPhysical({
    windowPhysical: null,
    windowScale: 1.5,
    displays: [{ primary: true, physicalWorkArea: { x: 0, y: 0, width: 1920, height: 1140 } }],
    area: AREA
  })

  assert.deepEqual(measured, { floors: [], homeArea: null })
})

test('某块屏探不到物理工作区：只丢它自己，别的屏照常', () => {
  const measured = shared.floorsFromPhysical({
    windowPhysical: { x: 0, y: 0, width: 3840, height: 2160 },
    windowScale: 1.5,
    displays: [
      { primary: false, physicalWorkArea: null },
      { primary: true, physicalWorkArea: { x: 0, y: 0, width: 3840, height: 2088 } }
    ],
    area: AREA
  })

  assert.equal(measured.floors.length, 1)
  assertRect(measured.floors[0], { x: 0, y: 0, width: 2560, height: 1392 })
  assertRect(measured.homeArea, measured.floors[0], 1e-9)
})

test('完全落在窗口外的屏被裁掉，不会留下一块点不到的死地板', () => {
  const measured = shared.floorsFromPhysical({
    windowPhysical: { x: 0, y: 0, width: 1536, height: 960 },
    windowScale: 1,
    displays: [
      { primary: true, physicalWorkArea: { x: 0, y: 0, width: 1536, height: 960 } },
      { primary: false, physicalWorkArea: { x: 5000, y: 0, width: 1920, height: 1080 } }
    ],
    area: { x: 0, y: 0, width: 1536, height: 960 }
  })

  assert.equal(measured.floors.length, 1)
  assertRect(measured.homeArea, measured.floors[0], 1e-9)
})

test('没有主屏标记：homeArea 为空，宿主退回自己的出生点算法', () => {
  const measured = shared.floorsFromPhysical({
    windowPhysical: { x: 0, y: 0, width: 1536, height: 960 },
    windowScale: 1,
    displays: [{ primary: false, physicalWorkArea: { x: 0, y: 0, width: 1536, height: 960 } }],
    area: { x: 0, y: 0, width: 1536, height: 960 }
  })

  assert.equal(measured.floors.length, 1)
  assert.equal(measured.homeArea, null)
})
