# 19: 本机宠物的动作池

**What to build:** 宿主把本机素材源的动作清单作为 `idlePool` 下发给渲染端；本机宠物待机时从池子里轮播，不再只轮 3 段。访客逻辑不变。

**Blocked by:** 14

**Status:** done

- [x] 宿主从本机素材注册表取第一个源的动作名，作为 `idlePool` 挂在 self 场景项上
- [x] 渲染端用 `idlePool` 顺序轮播，跳过加载失败的片段；池子变化时重新选起点
- [x] 每段尽量放完再换：4–12 秒，按视频时长自适应（没有时长信息时 8 秒）
- [x] 没有素材源 / 池子为空时退回内置 3 段；访客仍走 `src` / `fallback`
- [x] 场景校验：只收安全动画名、去重、最多 128 个；非法数组直接丢掉
- [x] 单测 + 全量 284 条全绿

> 完成情况：`service.startSkinSource` 在起对外服务之前先读注册表，填 `skinPool`；
> `syncDesktop` 只给 `self` 挂 `idlePool`（访客不挂，避免乱播本机动作）。即使
> `options.skinServer === false`（关掉对外供源）也会加载池子。渲染端 `updateMedia` 优先用
> `item.idlePool`，`media.poolKey` 变化时重置轮播位置；`loadeddata` 记录视频时长，
> `idleDelay` 夹在 4–12 秒。`shared.normalizeIdlePool` 去重、过滤非法名、上限 128。
> 测试：`desktop-pets.test.js` 新增池子校验一条；全量 284 条全绿。
> 真机效果要重启 DSH 才能看到（宿主半边是新代码）。
