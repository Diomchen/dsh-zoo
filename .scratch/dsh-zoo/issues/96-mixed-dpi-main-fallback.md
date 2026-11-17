# 96: 混合 DPI 下 main-fallback 用错位坐标误接管鼠标

**Status:** done（代码 + 单测 + 全量测试 2026-11-17；混合缩放实机复验待做）

> 编号说明：合并时 PR 标题/提交信息写的是「票 94」；94 已被混合 DPI 每屏地板（PR #10）占用，
> 本档案改编号为 96。代码注释与 README 已同步。

**来由：** 票 93 只修了「渲染端确认悬停」这一路。渲染端报 `inside=false`（光标确实不在宠物上）时，
主进程仍会退回按**光标所在那块屏**折算的 OS 坐标；`MAIN_FALLBACK_DWELL_MS`（300ms）过后，
只要这份错位坐标落进命中矩形，窗口就会被判成可交互，宠物旁边的点击被 helper 吞掉。

复现（fake-electron，125% + 150% 混合缩放布局）：光标真实位置在空处（渲染端 `hoverInside=false`），
错位约 20% 的 OS 本地坐标落在宠物矩形里 → `insideForMs≈604ms`、`ignoring=false`。
票 93 之前就存在，不是那次合并引入的。

**修法：**

- `desktop/main.js` 新增 `hitPointFor()`：混合缩放时只认渲染端上报的 CSS 指针
  （`pointerSource=renderer`）；拿不到（过期/未上报/坏形状）就返回 `point=null`，fail-closed 回穿透。
- `applyDecision()` 用这份坐标判定 `inside`，并在混合缩放时关闭 `allowMainFallback`。
- `emitHit()` 用同一份坐标，`hit.inside` 不再被错位坐标带偏。
- 单屏/同缩放行为完全不变；调试用的固定光标（`pointerOverride`）不参与这条收紧。

## 验收

- [x] 新增回归：`test/desktop-multi-display.test.js`「渲染端说不在宠物上时，OS 错位坐标不能把窗口变成可交互」
      修复前 `ignoring=false`、修复后 `ignoring=true`（`pointerSource=os`） ✅ 2026-11-17
- [x] 票 93 的混合缩放命中用例、单屏 `main-fallback` 纯函数用例、`npm run check` 全量 1071 条通过 ✅ 2026-11-17
- [ ] 实机复核：混合缩放现场把光标放在宠物旁边的空处，点击不再被吞、`status.ignoring` 保持 true；
      `pointerSource=os` 时窗口必须穿透
