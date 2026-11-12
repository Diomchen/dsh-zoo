# 58: 作物外观换成包内 SVG

**What to build:** 作物不再用 emoji 当外观，改成包里自带的矢量图；顺手把作物从 3 种加到 6 种。

**Blocked by:** 无

**Status:** done（2026-11-12）

- [x] `desktop/crops/*.svg`：六张 100×100 的扁平图（小番茄/草莓/胡萝卜/玉米/南瓜/葡萄）
- [x] `src/farm-rules.js`：`CROPS` 加草莓/玉米/葡萄，按生长时长排序；`PLOT_UNLOCK_RESERVE` 仍是 6
- [x] `desktop/farm-view.js`：`CROP_META` 加 `art`，新增 `cropEmblem()`（有图 `<img>`、没图退 emoji）
- [x] `desktop/farm.js`：地块卡、看田卡、仓库圆片、行情行、播种弹窗、驮包全部走 `cropEmblem`
- [x] `desktop/farm.html`：CSP 加 `img-src 'self'`（`file://` 下不放行就一张都加载不出来，实测）
- [x] `desktop/farm.html`：库存圆片改为换行——六颗塞不进 420px 一行（实测 370 > 325）
- [x] `desktop/shared.js`：窗口白名单与底价表扩到六种
- [x] 测试：`farm-rules` 作物表、`farm-constants-drift`（图文件必须存在且路径与 id 一致）、
      `farm-ui-css`（CSP 放行 + 尺寸契约）、`farm-window`（`cropEmblem` 两条分支）
- [x] 文档：README 作物表、`docs/protocol.md`、`desktop/README.md`
- [x] `npm run check` 全绿（837）；`DSH_ZOO_SMOKE_ONLY=farm` 真机冒烟 49 项通过

> 不做：用户换图（当时的取舍是"只做内置图"）。运行时加作物见票 59。
