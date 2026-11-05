# 21: 那条小街

**What to build:** 桌面上点「串门」时向上弹出邻居面板：两列小房子，一格一户人家，屋顶颜色由 `deviceId` 哈希定，脸色用访客同一套色板。点谁去哪家；去不了的那几户折叠在下面一行。自己出门期间整条街压暗，只剩「召回」。

**Blocked by:** 20

**Status:** done

- [x] 面板贴在自机宠物右上，宽 272，两列；一屏最多 6 户，多了滚动
- [x] 每户：屋顶（`shared.PET_COLORS` 哈希）、墙、从窗户里探出来的脸（两只眼睛）；名字在房子下面，超过 5 字截断，`title` 给全名
- [x] 第二行文字：有 `action` 就写它（「在改那个 bug」），没有就写状态（「在附近」/「刚掉线」/「还没放行你」）
- [x] 悬停一户：那颗脑袋从窗户里探出来晃两下（`peek` 动画，只动那一个）
- [x] 某户的 `action` 变了：那一户自己探一次头，不必悬停；面板因此是活的
- [x] 点能去的一户：`action=visit` 带上 `deviceId`（`/dsh-zoo/action` 早就收，`src/service.js:288`）；点完那户亮起「敲门中…」，直到快照变化或 notice 落下
- [x] 去不了的折叠成一行「附近还有 N 位，现在去不了 ›」，点开才露出灰房子；再点收起
- [x] 自己出门时：顶部换成「宠物正在老王家」+「召回」，整条街压暗且不可点
- [x] 面板与每一行都要上报点击矩形（`desktop/renderer.js:215` 那套），否则鼠标点不到
- [x] 冒烟：`scripts/desktop-smoke.mjs` 点第二户，断言 `action=visit` 且 `deviceId` 是那一户的
- [x] 键盘不做：桌面窗 `focusable:false`（ADR-0005），面板纯鼠标

> 文案口径沿用 `src/visit-copy.js`：面板里的失败理由和气泡里那句必须是同一句，不许各说各的。

> 完成情况：宿主侧 `controlsFromSnapshot()` 输出 `street`（`src/desktop-pets.js`），
> 渲染端 `shared.normalizeControls()` 去重/封顶 16/坏理由降级；桌面上是 `desktop/renderer.js`
> 的 `openStreet/closeStreet/renderStreet`，样式在 `desktop/index.html` 的 `.lp-street`。
> 「串门」按钮改成先开面板（action 换成 `open-street`），点某一户才发 `action=visit` +
> `deviceId`；`desktop/main.js` 与 `shared.normalizeHelperEvent` 里两条「visit 不带 deviceId」
> 的旧规则一并放开（不带仍由宿主随机挑，HTTP 口行为不变）。
> 设计原型留在 `.scratch/dsh-zoo/prototype/neighbor-panel.html`（三个变体，选中的是 C）。
> 验收：`npm test` 301 条全绿；`npm run smoke:desktop` 263 项断言全过（含面板截图与
> 「点某一户 → deviceId 对得上」）。
