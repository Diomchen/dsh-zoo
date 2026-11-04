# 31: 双桌面层共存要有提示

**What to build:** `dsh-pet` 与 `dsh-local-pet` 同时画桌面宠物时，两个透明置顶层可能重叠：
看到的是下面那只，拖到的是上面那只。宿主已经知道 dsh-pet 是否可达（pet-bridge），
据此给一条提示，不做按像素的命中区（另议）。

**Blocked by:** —

**Status:** done

来由：2026-11-04 Windows 现场同时跑着两个 helper（`dsh-pet` 约 524×465 @ 489,350；
`dsh-local-pet` 全屏 1280×672 @ 0,0，z-order 更前），报告里的命中点 (640,600) 正好落在
dsh-pet 的窗口矩形里。

`dsh-local-pet` 不是整屏抢输入：只有光标落在宠物/弹层命中矩形里才 `setIgnoreMouseEvents(false)`
（`desktop/main.js` 的唯一出口 + `shared.shouldBeInteractive` 的裁定）。真正的风险是两层的宠物
矩形重叠，用户以为在拖下面那只。

- [x] `src/desktop-advisory.js`：纯函数，输入「桌面层是否在跑 / bridge 状态 / 本机宠物」，
      输出 `null` 或 `{ code, note }`
- [x] 只在三种条件同时成立时提示：桌面层 running + dsh-pet 可达（`bridge.ok`）+ 它确实有宠物
      （没宠物就什么都没画，提示只会添乱）
- [x] `/local-pet/desktop` 响应带 `dualLayer` 字段；桌面层起来时 `log.warn` 一行
- [x] 单测：桌面层没跑 / dsh-pet 不可达 / dsh-pet 没宠物，三种都不提示
- [x] README「已知限制」写清：只留一个桌面层；两个都装时先关掉一个

> 不做：按实际绘制像素收窄命中区（要拿 alpha 通道，helper 侧改动大，另开票再议）。

> 完成情况：`src/desktop-advisory.js` 的 `dualLayerAdvisory` 是纯函数（5 条单测），
> 接线在 `src/service.js`：`/local-pet/desktop` 响应带 `dualLayer`（不需要时是 `null`），
> 桌面层起来 / 桥接回调时用 `noteDualLayer()` 打**一次**警告（`dualLayerNoted` 防刷屏）。
> 两条集成测试：dsh-pet 可达且有宠物 → `dualLayer.code === 'dual-desktop-layer'` 且日志有；
> 够不着 → `dualLayer === null`。
> 没做：按实际绘制像素收窄命中区（要 alpha 通道，另开票）。
