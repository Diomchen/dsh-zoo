# 47: 农场小窗 UI 改版——治愈系卡片农场

**What to build:** 按参考图把农场小窗改成「治愈系卡片农场」：奶白/奶油底、祖母绿/琥珀点缀、
圆角卡片、软阴影；顶部农场标题/硬币/露水/已种计数/关闭 ×；分段页签（农场/交易所/雇工/记录）；
地块卡片（空地/生长/成熟）；底部种子背包 + 收获仓库；点空地开播种弹窗；一键播种/一键收割。
**先只画 v1 的 4 块地**，但布局必须能不改代码扩到 20 块：网格按 `farm.plots.length` 自适应，
标题/计数/标签都不写死 4；未来宿主多发几块地，窗口直接多出卡片。

**Blocked by:** None（40/46 的 UI 后续）

**Status:** done

决策依据：[SPEC v5](../SPEC-v5.md)、[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)。
视觉参考：`.scratch/dsh-zoo/prototype/farm-ui-reference.html`（用户提供的 24 格原型，仅作设计源；
**不要**引它的 Tailwind/Lucide/Google Fonts CDN，也不要照抄它的假计时/加币逻辑）。

拍板：先 4 块地；未来扩到 20 块不用改布局；窗口保持 420×560；四个页签、所有动作、
访客偷/帮模式都不变；不引远程资源；不加假的 LV/等级、不加假的第 5–20 块可种地。

- [x] 外壳：header（「我的农场」、`X/Y 已种植`、🪙/💧 胶囊、× 关闭）、分段页签、
      一键播种/一键收割按钮行、可滚动地块区、常驻 footer（种子背包/收获仓库）、
      播种底部弹窗、toast；保留访客 banner
- [x] 视觉：奶油 `#FAF8F5` / 祖母绿 / 琥珀 / 天空蓝；16–24px 圆角、软阴影、胶囊、
      进度条、成熟轻微弹跳、细滚动条；系统字体；emoji + 内联 SVG；**不加载任何远程资源**
- [x] 地块卡：空地（＋ 种植）、生长中（倒计时 + 进度 + 浇水/施肥）、成熟（弹跳 + 收获/施肥）；
      点空地开播种弹窗；动作继续走 `farm-plant` / `farm-harvest` / `farm-water` /
      `farm-fertilize`，`plotId`/`cropId` 不变
- [x] 播种弹窗：三种种子的库存、生长时长/产量；库存 0 禁用；「去交易所买种」切到交易所页；
      **不做**参考图里的「随机买种」新机制
- [x] 一键播种：第一个空地 + 第一个有库存的种子，顺序发现有 `farm-plant`；
      一键收割：所有成熟地块顺序发 `farm-harvest`；busy 守卫、逐条 toast、
      不新增宿主动作/不改经济
- [x] 未来 20 块：网格 `repeat(auto-fill, minmax(...))`；`plotName` 从 `plot.id`/序号推，
      不写死 `PLOT_LABEL` 1–4；header 计数用 `farm.plots.length`；新增一个
      `farm-window` 传 20 块地的测试，断言渲染 20 张卡、标题显示 20
- [x] 交易所/雇工/记录：沿用新外壳/配色，功能与动作 id 不变；访客模式保留 banner、
      偷/帮卡与次数/守卫提示，隐藏一键播种/收割
- [x] 测试：更新 `test/farm-window.test.js` / desktopDouble 的新 DOM/类名断言；
      加播种弹窗、批量动作、20 块地未来测试；`npm test` + `npm run check` 全绿
- [x] 冒烟：`DSH_ZOO_SMOKE_ONLY=farm` 绿；截图 `47-*.png`（农场/播种弹窗/一键收割/
      交易所/雇工/记录/访客）；更新 `scripts/desktop-smoke.mjs` 的选择器
- [x] 文档：README / SPEC v5「桌面与小窗」/ `desktop/README.md` 描述新 UI；
      参考文件保留在 `.scratch/dsh-zoo/prototype/`；45/46 的截图说明不写「桌面地块条」
- [x] 不做：改宿主/protocol/存储/限额/交易所/雇佣逻辑；真扩到 20 块；新玩法；
      CDN/远程字体/图标库；假等级/假扩建
