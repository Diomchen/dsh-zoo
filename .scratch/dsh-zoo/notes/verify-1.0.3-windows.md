# dsh-zoo 1.0.3 · Windows 多屏验证清单

验证日期：2026-11-06
验证包：`dsh-zoo-1.0.3.tgz`（322,325 B，58 files）
SHA-256：`323e2fc4e7cb33cca5c774531f272c5942253aca9c139f78a1cdb163a330f147`
代码基线：`v1.0.2`（`9177499`）+ 未提交的「多屏跨屏拖动」修复

> 这是预发布包：测试通过后再提交 / 打 `v1.0.3` tag / 重新 `npm pack`。
> 包内文件清单与 1.0.2 相同（只有 `index.js`、`src/`、`desktop/`、`scripts/`、
> `cordis.patch.yml`、`README.md`），没有测试和 `.scratch`。

---

## 0. 先确认（这一节不过，后面的结果没有意义）

- [ ] 包能装进 `desktop` profile，`package.json` 里 `dsh-zoo` 的版本是 **1.0.3**
- [ ] **DSH 已整体重启**，不是只重开窗口：这次宿主侧 `src/service.js` 也改了，
      只换 helper 进程只能验证“窗口能跨屏”，验证不了“宠物生在主屏 / 每屏地面”
- [ ] helper 是新代码：`/dsh-zoo/desktop` 里 `status.helperPath` 指向
      `...\node_modules\dsh-zoo\desktop\main.js`，命令行参数是 `--dsh-zoo-*`
- [ ] `/dsh-zoo/state` 返回 200
- [ ] 单屏下老功能逐项正常（拖动 / 悬停弹层 / 右键菜单 / 改名 / 带派）——回归底线

安装（沿用 1.0.2 的做法）：

```powershell
# 0) 退出 DSH（宿主侧代码也要换，必须整体重启）
# 1) 若旧 helper 还活着（任务管理器里带 --dsh-zoo-host-pid 的 Electron），结束它；
#    也可以跑旧包里的 node ...\node_modules\dsh-zoo\scripts\stop-helper.mjs
#    （1.0.2 → 1.0.3 通常不会 EPERM，但宿主没退时被杀掉的 helper 会被立刻拉起）
# 2) profile 的 package.json：
#    dependencies 里 "dsh-zoo": "file:C:\\path\\to\\dsh-zoo-1.0.3.tgz"
# 3) 在 profile 目录执行
cd $env:USERPROFILE\.dsh\profiles\desktop
pnpm install
# 4) 重新打开 DSH
```

---

## 1. 两块屏并排、高度相同（最常见）

- [ ] 启动后宠物在**主屏**中央，不在两块屏的接缝上
- [ ] 按住宠物拖过接缝到第二块屏，松开：宠物留在第二块屏，站在那一块屏的底边
- [ ] 在第二块屏悬停宠物：弹层出现、按钮可点；右键菜单能打开
- [ ] 在第二块屏点「改名」：小窗出现在第二块屏的宠物旁边，不跑到主屏
- [ ] 把宠物从第二块屏拖回主屏：全程不中断，松手后仍可点
- [ ] `/dsh-zoo/desktop` 的 `helperStatus.bounds` 等于两块屏工作区的并集；
      `ignoring` 在光标不压宠物时为 `true`

记录屏幕分辨率、Windows 显示缩放（例如 150%）、两块屏的排列（左/右）。

## 2. 高度不一致（笔记本 + 外接屏）

- [ ] 主屏矮、外接屏高：宠物拖到外接屏后站在**外接屏**底边；拖回主屏站在**主屏**底边，
      两边都不会掉出屏幕
- [ ] 主屏高、外接屏矮：反过来同样成立（这是最容易复现旧问题的一种摆法）
- [ ] 从矮屏走到高屏：允许“掉下一级”；从高屏走向矮屏走不上去（预期，用拖的可以）
- [ ] 把宠物丢进两块屏之间的空洞 / 矮屏下方再松手：它出现在最近那块屏的底边

## 3. 第二块屏在主屏左侧（负坐标）

- [ ] 往左拖过接缝：宠物可见、可点、能开菜单
- [ ] 改名小窗出现在左屏宠物旁边，不在主屏或屏幕外

## 4. 热插拔

- [ ] 宠物在第二块屏时拔掉那块屏：窗口收回到剩下的屏，宠物仍可见、可拖；
      没有整屏卡住点击
- [ ] 重新插上：窗口扩出去，能再拖过去
- [ ] 插拔后 `helperStatus.bounds` 跟着变
- [ ] 兜底：杀掉 helper，点击立刻恢复（`setIgnoreMouseEvents` 的 fail-closed 没被破坏）

## 5. 单屏回归 + Windows 特有观察

- [ ] 单屏：与 1.0.2 行为一致（贴工作区底边、不挡任务栏点击）
- [ ] 多屏时留意：宠物是否会走到主屏任务栏那一条上。并集取的是各屏 `workArea`，
      “没有任务栏的那块屏”会把并集的底边拉低；这是已知取舍，记录发生条件即可
- [ ] 第二块屏上的弹层 / 礼物卡不被裁掉

## 6. 出问题要带回来的

- [ ] `/dsh-zoo/desktop` 全文（重点：`helperStatus.bounds`、`pointer`、`ignoring`、`status.stderr`）
- [ ] helper 进程命令行：
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*desktop\main.js*' }`
- [ ] 截图 / 录屏：光标位置、宠物位置、失败发生在哪块屏
- [ ] 屏幕布局（显示设置截图）与 Windows 缩放比

已知取舍（不算 bug）：混合 DPI 下非主屏一侧可能略糊；从高屏走向矮屏上不去；
屏间空洞里宠物会暂时待着。详见 `docs/adr/0015-virtual-desktop-spans-all-displays.md`。
