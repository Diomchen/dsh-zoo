# 93: 混合 DPI 下点击穿透打不开（按渲染端 CSS 指针裁定命中）

**Status:** done

**来由：** 2026-11-17 现场（主屏 1920×1200 @125% + 副屏 3840×2160 @150%）。光标压在宠物身上、
悬停也会亮，但左键永远穿透到下层窗口；`/dsh-zoo/desktop` 里渲染端 `hoverInside=true`，
主进程却 `insideForMs=null`、`ignoring` 永远为 true。

**根因：** 桌面层是一扇铺满虚拟桌面的透明窗，只按**一块**屏的 `deviceScaleFactor` 渲染；
`screen.getCursorScreenPoint()` 却按**光标所在那块屏**的缩放折算。两块屏缩放不同时，
「光标 − `win.getBounds()`」反推的窗口本地坐标和渲染端真实 CSS 坐标差一截（现场实测约 (155, 28)），
命中矩形永远对不上，`shouldBeInteractive()` 恒返回 outside。

**修法：** 渲染端在 `dsh-zoo:hover` 里带上自己的 CSS 指针（`desktop/renderer.js` / `preload.js`）；
混合缩放时命中判定采信这一份（`shared.chooseLocalPoint`），其余情况（单屏/同缩放）保持原行为，
主进程继续按 OS 光标独立复核。渲染端指针过期（`HOVER_POINT_MAX_AGE_MS` = 1500ms）、越界、
形状不对一律不用，失败方向仍然是穿透。`status` 新增 `pointerSource`（`renderer` / `os`）与
`hoverPoint`，混合 DPI 现场先看这两项。

## 验收

- [x] `test/desktop-cursor-point.test.js`：纯函数 10 条（采信顺序、过期、越界、坏形状、status 白名单） ✅ 2026-11-17
- [x] `test/desktop-multi-display.test.js`：fake-electron 增加 `rendererCursor`，覆盖混合缩放命中回归 ✅ 2026-11-17
- [x] 合并进 main（`a3cafba`，PR #9），合并后本地全量测试通过（1070 条） ✅ 2026-11-17
- [ ] 实机复核：作者自述 1920×1200@125% + 3840×2160@150% 下 `pointerSource=renderer`、
      `insideForMs=557`、`ignoring=false`、`trustedInputs=6`，点击/拖拽恢复；维护者尚未在同一硬件组合上复跑

## 遗留

- **反向问题（票 94）**：渲染端报 `inside=false` 时，主进程仍会拿错位的 OS 坐标做
  `main-fallback` 判定，300ms 后可能把光标并不在宠物身上的区域变成可交互（吞点击）。
  这是票 93 之前就存在的毛病，本票只修了「悬停确认」这一路。
- `desktop/README.md` 的 status 字段表与「主进程独立复核」约定已随本票更新；
  文件位置与状态字段的完整清单仍以代码为准。
