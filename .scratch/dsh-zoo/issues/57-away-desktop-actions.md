# 57: 宠物不在家时，桌面上仍然要有操作

**What to build:** 宠物出门串门、被派去偷、或者在外打工时，桌面上必须留一个入口：
点开能开农场窗、能看邻居、能带派、能改名、能召回（打工时是「叫它回家」），右键还能开完整菜单。

**Blocked by:** 44, 53

**Status:** done

## 问题（用户报的）

「我的宠物被雇佣去打工，我界面上所有操作就默认消失了。」

桌面的所有入口都挂在 `role:'self'` 的那只宠物身上：悬停弹层、右键菜单（农场 / 带派 / 外观 /
动作 / 回到初始位置）、以及从菜单打开的农场小窗。ticket 09/44 规定自己出门或在外打工时
`self` 从桌面消失——于是**能点的东西一起消失了**：

- 在外打工（2–8 小时）：`self.work` 而不是 `self.out`，连 ticket 11 的「召回」胶囊都不出现
  （它只认 `out`），整张桌面空空如也；农场窗打不开，合同也召不回来。
- 去偷（≤60 秒）：`self.out` 在，胶囊出现了，但只有「召回」。想开农场窗、带派、看邻居都不行。
- 串门（30 分钟）：同上；而且反过来，即使打开了农场窗，去偷的那趟也会被当成「访客」，
  对着要偷的那家画成访客页（帮忙/偷按钮），自家农场反而看不到。

## 决策

- **胶囊升级成「不在家」入口**，三种不在家都算（`visiting` / `raiding` / `working`）。
  它不再是一个「召回」按钮，而是我那只宠物在桌面上的代理：
  点开 = 面板（农场 / 邻居 / 带派 / 改名 / 召回或叫它回家 / 更多），右键 = 完整菜单。
  召回仍然是两步（先点胶囊、再点召回）——换的是一致性：三处不在家只有一种打开方式。
- **文案由宿主算**（`src/away-text.js`）：`在「阿蟹」家` / `去「阿蟹」家偷菜了` /
  `在「柯基」家打工`，胶囊、面板标题、邻居小街抬头共用同一句；渲染端不按 mode 拼句子。
- **主按钮跟 mode 走**：打工发 `recall-worker` + 宿主下发的 `contractId`；
  串门/偷菜发 `recall`。渲染端不猜、也不在缺合同号时假装能点（置灰 + 一句人话）。
- **农场窗的模式只由真串门决定**：去偷也是 `self.out`，但偷不是串门（ADR-0018），
  开窗仍是我家农场（owner）。否则宠物在外偷菜时，自家的种/收/雇工全被访客页顶掉。
- **菜单没有 self 时的「回到初始位置」直接不画**：留着就是点了什么也不会发生的假入口。
- 不做：托盘图标、桌面上的幽灵宠物（自己出门时仍然不在桌面上）、面板里的合同倒计时。

## 验收

- [x] `controls.recall` → `{ enabled, mode, text, title, contractId }`；三种 mode 都出现，
      `working` 带合同号；`shared.normalizeControls` 对 mode 走白名单、contractId 走 UUID。
- [x] 渲染端：胶囊 + 面板 + 面板动作（`farm-open` / `street-open` / `bring` / `rename` /
      `recall` / `recall-worker` / `away-more`）；面板与胶囊之间有桥接矩形；
      右键胶囊 / 「更多」都能开菜单（`petId:null`），菜单里没有「回到初始位置」。
- [x] `desktop/preload.js` + `requestAction` 透传 `contractId`（`recall-worker` 的窄口）；
      `desktop/main.js` 的 `FARM_HIRE_ACTIONS` 分支已经在收。
- [x] 农场窗：`outboundVisitForWindow()`——`purpose:'steal'` 不算串门；开窗与刷新都用它；
      `loadVisitFarm` 加一道兜底。
- [x] `test/away-desktop.test.js`：文案表 + mode 白名单同源 + 农场窗三种状态；
      `desktop-pets` / `desktop-work` / `desktop` 的控件断言跟着改；
      `npm test` 833 条全绿。
- [x] `npm run smoke:desktop`：胶囊 → 面板 → 农场/召回；打工胶囊 → 「叫它回家」带合同号；
      「更多」开菜单且没有「回到初始位置」；两张面板截图（`away-panel*.png`）。497 条全过。
- [x] 文档：`README.md`「桌面上的操作」、`desktop/README.md` 的 controls 与菜单两节。

## 现场反馈（第二回）

「下面这个胶囊按钮无法拖动，很遮挡视线。」

胶囊默认锚在宠物最后出现的位置（ticket 11 就是这样），打工 2–8 小时期间它会一直钉在那里，
挡在窗口中间时用户唯一想做的就是挪开它——但之前 pointerdown 只是 `stopPropagation`，
按住拖动什么都不会发生。

- **根因**：`pointerdown` 只做了 `stopPropagation`，没有任何拖动状态；而且 `layoutUi` 每 100ms
  按 `promptAnchor()` 重新定位胶囊——只加一个 pointermove 改 `style.left/top` 也会被下一帧
  拉回去。所以位置必须变成渲染端的一份**用户位置**（`ui.awayChipPos`），布局时优先用它。
- **拖动**：按住胶囊 → 跟着指针走 → 松手停在原地；位置是渲染端自己的（ADR-0003 不变），
  夹在工作区内，本次运行一直记住（宿主/helper 重启后回到宠物最后出现的位置）。
- **拖动 ≠ 点击**：位移超过 `CLICK_MAX_MOVE`（5px）才算拖动，不弹面板；没动/抖动仍是点击。
- **拖到一半不能掉**：拖动期间持输入租约 + 上报 `ui:chip-drag`（胶囊 ∪ 光标附近 80px），
  和宠物拖拽同一条 fail-closed 约定；pointerup/取消/blur/隐藏/2.5s 无移动都会收手。
- 光标改成 `grab` / `grabbing`，tooltip 写明「拖走可以挪开」。
- 冒烟：`down → move → up` 后断言胶囊整体平移 (+120, −160)、没有弹面板、之后仍能点开。

> 完成情况：宿主文案表（`src/away-text.js`）、`controls.recall` 四字段、
> 渲染端的「不在家」胶囊/面板/菜单三入口、`contractId` 的窄口透传、农场窗模式修正、
> 833 条单测 + 497 条真 Electron 冒烟。ticket 13 里「出门在外不做常驻胶囊」那条就此作废：
> 改名仍然不是常驻入口，但胶囊现在负责把「不在家时能做什么」全部收进来。
