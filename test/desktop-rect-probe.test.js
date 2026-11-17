// 票 92：长时间运行后「点不开农场」的自愈链。
//
// 现场结论（2026-11-17）：这只 focusable:false 的分层窗在 Windows 上收不到
// WM_LBUTTONDOWN，只有 WM_LBUTTONUP；菜单/面板靠 click 才生效，于是整块 UI 点不动。
// 又因为弹层矩形 900ms 就过期、rAF 在窗口失焦时会被系统降频，主进程把菜单判成
// 「窗外」，窗口翻回穿透，菜单画着却点不着。下面这些断言守住三处修复：
//
//   1. 弹层矩形有独立的、更宽的过期时间（OVERLAY_RECT_MAX_AGE_MS）
//   2. 渲染端有「丢 down 用 up 兜底点击」和弹层矩形心跳/探针回应
//   3. 主进程有矩形看门狗：探针叫不醒就重载渲染端，不用重启插件
//
// 这些是源码契约：真正的行为验证在 `scripts/desktop-smoke.mjs` 和真机热测里。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
function read (name) {
  return readFileSync(new URL(name, `file:///${root.replaceAll('\\', '/')}/`), 'utf8')
}

const shared = read('desktop/shared.js')
const main = read('desktop/main.js')
const renderer = read('desktop/renderer.js')
const preload = read('desktop/preload.js')

test('弹层矩形有独立的过期时间，主进程不再拿宠物的 900ms 判菜单过期', () => {
  assert.match(shared, /const OVERLAY_RECT_MAX_AGE_MS = \d+/)
  assert.match(shared, /\bOVERLAY_RECT_MAX_AGE_MS,/)
  // overlay 用宽的那个，宠物仍然用 RENDERER_RECT_MAX_AGE_MS（fail-closed）
  assert.match(main, /overlayRectsAt > 0 && now - overlayRectsAt <= shared\.OVERLAY_RECT_MAX_AGE_MS/)
  assert.match(main, /rendererRectsAt > 0 && now - rendererRectsAt <= shared\.RENDERER_RECT_MAX_AGE_MS/)
})

test('渲染端：弹层矩形有定时心跳，不靠 rAF 续命', () => {
  assert.match(renderer, /setInterval\(\(\) => \{\s*\n\s*if \(uiRects\(\)\.length > 0\) reportOverlayRects\(false\)/)
})

test('渲染端：收到探针就全量重报宠物矩形与弹层矩形', () => {
  assert.match(renderer, /typeof api\.onProbe === 'function'/)
  assert.match(renderer, /api\.onProbe\(\(\) => \{[\s\S]{0,160}reportRects\(true\)[\s\S]{0,80}reportOverlayRects\(true\)/)
  assert.match(preload, /onProbe \(handler\) \{/)
  assert.match(preload, /ipcRenderer\.on\('dsh-zoo:probe', listener\)/)
})

test('渲染端：只收到 up 时用兜底 click 把这一击补回来', () => {
  assert.match(renderer, /let lostUpAt = 0/)
  assert.match(renderer, /if \(lost\) lostUpAt = performance\.now\(\)/)
  assert.match(renderer, /performance\.now\(\) - lostUpAt > 120/)
  assert.match(renderer, /document\.elementFromPoint\(/)
  assert.match(renderer, /closest\('button, \[data-lp-action\], \.lp-pet'\)/)
  assert.match(renderer, /dispatchEvent\(new MouseEvent\('click'/)
})

test('主进程：矩形看门狗会探针，连续叫不醒就重载渲染端', () => {
  assert.match(main, /const RECT_PROBE_INTERVAL_MS = \d+/)
  assert.match(main, /const RECT_PROBE_STALE_MS = \d+/)
  assert.match(main, /const RECT_PROBE_MAX_STRIKES = \d+/)
  assert.match(main, /const RENDERER_RELOAD_COOLDOWN_MS = /)
  assert.match(main, /function probeRendererRects \(now\) \{/)
  assert.match(main, /win\.webContents\.send\('dsh-zoo:probe'\)/)
  assert.match(main, /if \(rectProbeStrikes < RECT_PROBE_MAX_STRIKES\) return/)
  assert.match(main, /win\.webContents\.reload\(\)/)
  assert.match(main, /startRectProbe\(\)/)
  assert.match(main, /clearInterval\(rectProbeTimer\)/)
})
