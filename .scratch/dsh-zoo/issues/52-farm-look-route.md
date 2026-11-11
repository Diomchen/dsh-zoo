# 52: 在家看田——`/dsh-zoo-farm/open/<viewerId>`

**What to build:** 一条只读路由，让任何邻居（不需要放行）在家读到对方农场的公开视图：
地块、守卫、以及**请求者自己**的次数。脱敏是硬约束。加上 `farm-look` 动作把这份视图拉下来。

**Blocked by:** 51（`caps` 要先有）

**Status:** done

决策依据：[ADR-0018](../../../docs/adr/0018-farm-open-to-lan.md) 决定 1/5、
[SPEC v7](../SPEC-v7.md)「只读视图」。

- [x] `src/lan-routes.js`：新 `FARM_OPEN_ROUTE = '/dsh-zoo-farm/open'`；`matchRoute` 前缀不吃掉
      `/dsh-zoo-farm/<visitId>`（两条路由按长到短排）
- [x] `src/lan-server.js`：`lookupOpenFarm` 选项（`viewerDeviceId → view | null`），
      GET/HEAD、`no-store`、`isDeviceId` 校验、404 不区分"没这户"和"形状不对"
- [x] `src/service.js`：`openFarmView(viewerDeviceId)`——**只**给 `plots`（`id`/`crop`/`stage`/
      `mature`/`remainingMs`/`stolenByMe`/`helpedByMe`）、`guard`、`guardParts`、
      `quotas:{perTrip,perTripLeft,perFarmLeft,perDayLeft}`、`caps`、`at`；
      **不给** `coins`/`crops`/`seeds`/`hire`/`market`/别人的 deviceId/任何路径
- [x] `src/farm-fetch.js`：`open({address, port, deviceId})`，同一套 2s / 64 KiB / 私网 / 60s 冷却；
      `normalizeOpenView` 白名单重建（照 `normalizeVisitView` 的写法，坏地块只丢那一块）
- [x] `farm-look` 动作：`{ deviceId }` → 拉视图 → 返回 `{ ok, view }`；错误码
      `no-port` / `no-caps` / `refused` / `timeout` / `bad-shape`
- [x] 测试 `test/lan-server.test.js`：GET/HEAD/404/`no-store`/两条路由不打架；
      **脱敏断言**：响应序列化后不含别人的 deviceId、不含 `coins`、`crops`、`seeds`、不含 `/`;
      `test/farm-fetch.test.js` 补 `open()` 的冷却与形状；`test/state.test.js` 不受影响
- [x] `npm test` + `npm run check` 全绿

> 不做：查看窗界面（54）、把视图塞进 `market-digest`（不塞：4 KiB 装不下 50 块）。

---

> 完成情况：视图构造抽成纯函数 `src/farm-open.js`（`openFarmView`），`/dsh-zoo-farm/open/<viewerId>`
> 走同一台 LAN 服务器；`farm-fetch.open()` + `normalizeOpenView` 是收的方向；`farm-look` 动作
> 只要求"认得到这台机器"（有地址 + 记过 LAN 端口），**不看放行**。790/790。
>
> 三个发现：
> 1. **`/open/` 被路由表挡在门外**：`lan-server` 的农场分支只允许一层（`rest.includes('/')` 就 404），
>    `open/<id>` 是两层。改成"`open/` 前缀单独放行，其余仍只许一层"。
> 2. **看田不该吃 60 秒冷却**：那是给后台轮询防坏邻居的；用户点的"看看农场"失败一次就该能马上再点。
>    `open()` 因此既不查也不记冷却，`get()` 保持不变。
> 3. **harness 的真 bug**：两只宠物都申请默认的 45873，先后起来互相抢口；加上一次收尾没赶上，
>    请求会打到**上一只已经 dispose 的服务器**上——那边 `farm` 是 null，回 404，表现在界面上是
>    "看田失败：gone"，而且重试 8 秒也没用。改成 `skinPort: 0`（内核给临时端口）后 4/4 稳定。
>
> 偏离：SPEC 的 `quotas` 写了 `perTrip/perTripLeft/perFarmLeft/perDayLeft` 四项，实际只发前两项——
> 后两项是主人侧的整农场/整天计数，窗口现在还画不到它们，等票 54 真要用时再加。
