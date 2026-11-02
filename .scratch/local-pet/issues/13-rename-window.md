# 13: 在宠物身上改名

**What to build:** 悬停自己那只宠物，弹层里在「串门 / 召回」旁边多一项「改名」；点开一扇贴着宠物的小窗，输入新名字、回车提交。走的是 12 已经建好的那条链路，这一票只负责入口和输入。

**Blocked by:** 12

**Status:** done

- [x] 弹层加「改名」（复用同一套 `makeButton` + 弹层渲染，不新开一套控件）。**没有** `controls.rename`：
  宿主没有需要 gate 它的条件，成败由小窗自己说
- [x] 点它开一扇独立小窗：无边框、置顶、贴着自己那只宠物、预填当前名字、输入上限 32
- [x] 回车提交、Esc 或失焦关闭；成功自动收起，失败留在窗里报一句人话（不静默、不制造分叉）
- [x] 主窗仍然是 `focusable:false`：新窗口是唯一可聚焦的东西，关掉/崩掉之后主窗的点穿与命中矩形行为不变
- [x] 宠物出门在外时桌面上没有自己那只，因此没有入口——这是预期行为，不另做常驻胶囊
- [ ] 验收：悬停 → 改名 → 回车，dsh-pet 的桌面标签、local-pet 的标签、邻居看到的，三处同一个字符串

> 完成情况：新增 `desktop/rename.html` / `rename.js` / `rename-preload.js` 三个文件，`main.js` 里加
> `openRenameWindow` / `closeRenameWindow`（360×168、无边框、置顶、可聚焦，贴宠物上方，放不下落下方，
> 再不行夹进工作区；只在**拿到过焦点之后**才按失焦关闭，避免刚建窗就被一次 blur 关掉）。
> `CONTROL_ACTIONS` 增加 `rename`，事件新增 `nickname`（helper 只截 64，清洗与 32 码点截断在宿主）；
> `handleDesktopAction` 把 `nickname` 透传给同一个 `handleAction`，宿主侧没有第二套改名逻辑。
> 失败话术补了 `bad-nickname` / `dsh-pet-unreachable` / `dsh-pet-write-failed` / `dsh-pet-no-pet` 四种。
> 冒烟：`scripts/desktop-smoke.mjs` 新增「弹层出现改名项 → 小窗打开（主窗仍 focusable:false）→ 关闭」，
> **241 项断言全过**。这一条冒烟当场抓到一个真 bug：`selfPetRect()` 把 `normalizeRects` 的扁平矩形
> 当成 `{id, rect}` 解包，点改名直接让 helper 抛未捕获异常——已修。
> 唯一没验的是最后一条（真机点一遍改名、看三处是否一致）：宿主半边要重启 DSH 才会加载新代码。

> 两轴评审后：三条改名 IPC 的重复守卫抽成 `isRenameSender(event)`；`openRenameWindow()` 开不了窗时
> 回一条 `local-pet:rename-unavailable`，渲染端冒一句人话（原本弹层已经关了，静默什么都不发生）；
> `desktop/shared.js` 里 `MAX_NAME_LENGTH` 与 `src/protocol.js` 的 `MAX_NICKNAME` 加了相等性测试。
