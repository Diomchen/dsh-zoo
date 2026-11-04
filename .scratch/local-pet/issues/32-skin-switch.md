# 32: 换皮——按 id 选当前那张皮

**What to build:** 本机宠物可以换成 `skin.json` 里的任意一条素材源：动作清单、对外的
`skinId` 一起换，身份与历史一个字不动（[ADR-0013](../../../docs/adr/0013-skin-switch-keeps-identity.md)）。
切换立即生效，不用重启 DSH。

**Blocked by:** —

**Status:** done

来由：2026-11-04 —— 盘上同时躺着 dsh-pet 的 109 段和 maodie-pet 的 32 段素材，但 `service.js`
两处 `sources[0]` 决定了"用哪张皮"，换一次要手改 `skin.json` 顺序再重启。决定：换外观/动作可以，
名字、串门记录、礼物、背包、放行关系不动。

- [x] `skin.json` 每条源支持 `idle`（待机动作，缺省仍认「待机呼吸休闲」）和 `once`
      （一次性动作：不进闲时轮播、清单里 `loop:false`）
- [x] `settings.json` 加 `activeSource`（字符串）；缺省 = 第一条源；未知 id 回落第一条并告警一次
- [x] `service.js` 两处 `sources[0]` 换成"当前皮"：`idlePool` 与对外 `skinRef.id`
- [x] 动作：`POST /local-pet/action` 接受 `{ action: 'use-skin', skinId }`；落盘 → 重建菜单与场景 → 立刻补发心跳
- [x] 菜单：右键加「外观」二级菜单，列出现有源，当前项打勾（只在有两张以上皮时出现）
- [x] 切皮不写 dsh-pet 配置：单测断言 `main-config` 内容逐字节不变（ADR-0013 §决定 4）
- [x] 切皮不碰本机数据：`identity.json` / `visits.json` / `peers.json` 内容不变
- [x] 错误语义：未知 id → `{ ok:false, error:'unknown-skin' }`（路由按既有约定回 409，不是 400）
- [x] 单测 + 全量测试全绿（496 项）

> 不做：per-source 名字或身份（与 ADR-0007 打架）、动作别名映射、换皮时主动通知访客。

> 尺寸这条没做：皮里的 `size` 仍只随 manifest 出去。桌面层现在所有宠物共用一个尺寸
> （`shared.petScene` 按工作区算、上限 176），per-skin 尺寸要连带改布局、出生点和命中区，
> 另开票。

> `once` 目前只做到"不进轮播 + 清单标 `loop:false`"：本机没有播一次性动作的入口
> （右键「动作」点播走的是 dsh-pet 的 `/anim`），所以"播完回待机"要先有本地点播画面才会遇到。
> 访客的动作仍由对方的 `/state` 决定，这条不在本票范围。

> `skin.json` 的改动仍然要重启 DSH 才进注册表：`重载配置` 只重读 settings（老行为），
> 而素材源清单在启动时读一次。要把这条也变热，得让 `lan-server` 支持换源重建清单。

> 修过一条：桌面菜单那条路最初发的是 `skinId`、宿主却读 `id`，右键换皮永远 `bad-skin-id`；
> 现在两条路都叫 `skinId`（与 `deviceId` / `giftId` 同一习惯），HTTP 侧也有测试。
>
> 完成情况：`/local-pet/state` 多一个 `skin` 字段（`{ id, name, size, idle }`，没有源时是 null），
> 换没换皮看这一项就知道。`applySkin()` 成为唯一入口（启动、`use-skin`、回落都走它），
> `loadSkin()`（读注册表，跟联不联网无关）与 `serveSkin()`（只起端口）从原来的
> `startSkinSource()` 拆开——顺带修掉「`network:false` 时宠物没有皮」这个隐含假设。
> 测试：`test/skin-sources.test.js` 5 条（idle/once/坏声明），`test/service.test.js` 3 条
> （切皮只写 settings、未知 id、activeSource 悬空回落），`test/menu.test.js` 2 条、
> `test/desktop-menu.test.js` 2 条（外观候选与 `use-skin` 白名单）。
