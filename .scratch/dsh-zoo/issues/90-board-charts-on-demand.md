# 90: 盘口图表按需拉取 + 发不出去时报「发不出去」而不是「桌面层没在运行」

**Status:** ready-for-agent

## 现场（2026-11-17 01:20）

作物目录长到 **15 种**后，`trading-open` 返回 `{"error":"desktop-off","notice":"桌面层没有在运行，开不了盘口窗。"}`，
但 `/dsh-zoo/desktop` 显示 `running:true, ready:true`——桌面层其实是好的。

## 根因（已复现）

- `/state.trading` 原始 176 KB；过 `normalizeBoardView()` 后 **308 KiB**（紧凑 bar 展开成对象 + `charts` 又复制了一份 15 分图）。
- `desktop/shared.js` 的 `MAX_LINE_LENGTH = 256 KiB`；`encodeMessage()` 返回 `null` → `desktop.boardWindow()` 返回 false。
- `handleTradingOpen()` 把「发送失败」一律翻译成 `desktop-off`，于是误报「桌面层没在运行」。
- 票 88 的 200 KiB 上限只测到 11 作物；15 作物时归一化后的体积才是真实卡点。

## 要做的

1. **按需拉取**：打开盘口时 payload 只带**当前作物**的 4 个周期图（`timeframes[tf][selectedCrop]`），
   不再一次发全部作物。
2. 新动作 `trading-charts { cropId }`：返回该作物的 `timeframes` 与 `hint`；窗口切换作物时若本地没有，
   先显示「加载中」再请求，收到后合并进本地 state 并重绘；缓存最近 3–4 个作物。
3. **去掉重复**：`normalizeBoardView` 不再把 `timeframes['15m']` 复制成 `charts`（视图对老包仍回退 `charts`）。
4. **错误语义**：桌面层健康但指令发不出去时返回 `error:'board-send-failed'` +
   `盘口窗指令发不出去（盘口数据可能太大），这次没打开。`；`desktop-off` 只留给真的没有桌面层。
   发送失败要 `warnOnce` 一条带尺寸/原因的诊断。
5. **护栏测试**：用 40 种合成作物 → `tradingWindowView()` 归一化后 `encodeMessage()` **非 null** 且 < 128 KiB；
   15 作物真实目录同断言；`trading-charts` 只返回请求的作物。
6. 更新 ADR-0031 的 consequences（超过上限时按需拉取）。

## 验收

- [ ] 15 作物（真实目录）下 `board-window` 指令可编码、可打开窗口。
- [ ] 切作物按需拉取、缓存命中不再请求；加载中有明确状态。
- [ ] 指令发不出去时提示「发不出去」而非「桌面层没在运行」，并留一条带尺寸的诊断。
- [ ] `encoding` 护栏测试覆盖 40 作物；`npm run check` 全绿（1027+）。
