# 24: 背包与「带派」小窗

**What to build:** 发送端能准备礼物——背包（`backpack.json`，最多两件，先放的先带走）+
右键「带派」小窗（写字条 / 选文件 / 看背包 / 撤掉）+ `POST /dsh-zoo/action {"action":"bring"}`。
出门时自动带最旧的一件，自发出门也带。

**Blocked by:** 23

**Status:** done

决策依据：[ADR-0011](../../../docs/adr/0011-bring-gift-on-visit.md)、[SPEC v4](../SPEC-v4.md)。

- [x] `src/backpack.js`：读写 `<dataDir>/backpack.json`，形状 `{ version, items: [...] }`；
      最多 2 件（满了返回 `backpack-full`，不静默丢旧的）；损坏 → 空背包 + 只告警一次；
      写入串行化 + tmp/rename（与 `src/visits.js` 同一套路）
- [x] 文件件只存绝对路径 + `name`；`size` / `sha256` 在**发送那一刻**才算；
      源文件不存在或读不了 → 这次不带、留在背包、一句人话
- [x] `src/menu.js`：一级工具项多 `bring`（文案「带派」）；只挂自己的宠物
- [x] 独立小窗 `desktop/gift.html` + `gift.js` + `gift-preload.js`（仿 `rename.*`）：
      `focusable:true`、无边框透明、失焦关闭；文字框（≤500，实时字数）、选文件按钮
      （主进程 `dialog.showOpenDialog`，选完在渲染端显示文件名与大小）、背包列表（每条可撤）
- [x] 小窗桥：只暴露 `ready / submit / cancel / remove / onInit / onResult`，不放 Node 能力
- [x] `POST /dsh-zoo/action`：`bring`（`{kind:'text',text}` 或 `{kind:'file',path}`）、
      `unbring`（`{giftId}`，仅 `idle`）；错误码 `bad-gift` / `too-large` / `backpack-full` /
      `no-such-file` / `gift-out`
- [x] 出门（手动与自发）时取背包里 `at` 最小的一件，编码进 `visit-request`；
      手动出门若无背包件则不捎（不阻挡串门）
- [x] 单测：背包读写（损坏 / 满 / 撤回 / 源文件消失）、小窗入参校验、`bring`/`unbring` 的错误码
- [x] 菜单工具项**三处同改**：`src/menu.js` 的 `MENU_TOOL_LABELS` + `menuTools`，以及 `desktop/shared.js` 的 `MENU_TOOL_IDS`——少一处 `normalizeMenu` 就把它当未知项丢掉
- [x] 小窗照抄 `desktop/main.js:905 openRenameWindow`：单独 preload、`hadFocus` 后才按失焦关闭、10s 超时、只认自己那扇窗（`isRenameSender:791` 那种校验）；文件选择要新加 `dialog.showOpenDialog`（现在没有）
- [x] `src/visits.js` 不是 tmp+rename（`:138` 直接 writeFile）：「同一套路」只对「串行化 + 告警一次」成立，原子写自己补
- [x] 重发的 `visit-request` 必须带**同一件**礼物（`sendVisitRequest` 会发三次）
- [x] 真机冒烟：右键出「带派」、写一条放进背包、背包里看得到、撤掉；截图

> 完成情况：发送端的背包与「带派」小窗已经打通，串门出口也接上了。
> **背包**（新 `src/backpack.js`）：`<dataDir>/backpack.json` 形状 `{version:1, items:[...]}`，
> 最多两件、满了 `backpack-full`（不挤旧件）；`at` 严格递增，出门取 `at` 最小的 idle 件
> （手动与自发同一条规则）；`unbring` 只删 idle，`out` 返回 `gift-out`；启动时把遗留 `out`
> 归一成 idle 并写回。文件件只存绝对路径 + `name`；`size`/`sha256` 在**发送那一刻**才
> stat + 边读边算，文件没了/读不了/突然变大 → 这次空手出门、东西留在背包、本机一句人话。
> 写盘走串行队列 + tmp/rename；坏文件只告警一次（与 `src/visits.js` 同一套路，原子写自己补）。
> **协议**：`normalizeGift` 现在同时认 `kind:'text'` 与 `kind:'file'`（`name` ≤120、
> `size` 1…16 MiB、`sha256:…` 64 hex），文件礼物报文里**没有路径**；`visit-request` 重试
> 三次始终用 `request.gift` 里同一个对象，不会在重试里重算 hash。
> **宿主**：`POST /dsh-zoo/action` 新增 `bring`（不带物品 = 打开小窗；带 `{kind,text|path}`
> 或小窗的 `gift` = 放进背包）与 `unbring`；错误码 `bad-gift` / `too-large` / `backpack-full` /
> `no-such-file` / `gift-out` / `gift-not-found`，文案统一在 `src/gift-text.js`。
> `startOutboundVisit` 变 async（文件要 stat/hash），自动串门也 await 同一条路径。
> **小窗**：`desktop/gift.html|gift.js|gift-preload.js`，独立 preload、focusable、无边框透明、
> `hadFocus` 后才按失焦关、提交后 10s 超时；桥只有
> `ready/submit/cancel/remove/onInit/onResult` 六个原语。文件选择只在主进程用
> `dialog.showOpenDialog` 打开，渲染端只拿到名字/大小，提交时主进程再核对「就是这个路径」。
> 宿主 → helper 新命令 `bring-window`（`open:true` 开窗 / `open:false` 只刷新），
> 窗口里只发 `bring`/`unbring`，结果复用 `action-result` 回同一扇窗；只有这扇窗自己的
> `event.sender` 能提交（`isGiftSender`）。菜单三处（`src/menu.js` 的标签与 `menuTools`、
> `desktop/shared.js` 的 `MENU_TOOL_IDS`）都加上了「带派」，点一级工具项只发一个空 `bring`。
> **测试**：新增 `test/backpack.test.js`（14）、`test/bring-e2e.test.js`（4：背包动作/错误码/
> 小窗提交回路、出门带最旧一件且三次重发同一对象、文件元数据在发送时才算、源文件消失不挡串门），
> 另在 `test/desktop.test.js`（5）、`test/gift-text.test.js`（1）、`test/protocol-gift.test.js`（1）
> 补了白名单/编码/文案；`npm test` 全绿 **391** 条（原 366 + 新 25）。
> **冒烟**：`npm run smoke:desktop` 全量通过 360 项断言（本机 Chromium sandbox 起不来，
> 需同时带 `DSH_ZOO_SMOKE_NO_SANDBOX=1 DSH_ZOO_HELPER_NO_SANDBOX=1`）。
> 新增 `bring` 段（12 项）：真窗口打开、背包列表可见、截图、点「撤掉」报出带 giftId 的
> `unbring` 申请、窗口里填字条并提交 → helper 报出带字条的 `bring` 申请 → 宿主
> `action-result` 成功后关窗；
> `menu` 段新增「带派」工具项与点击断言（43 项）。
> 截图：`.scratch/dsh-zoo/notes/12-bring-window-composited.png`
> （棋盘格合成；真窗口 760×960 Retina 像素，是这次 `shot window=bring` 抓的）。
>
> 留给 25 / 26 / 27 的接口：
> - 25：`startOutboundVisit` 现在把背包件的 `gift` 存进 `request.gift`；文件礼物已经会上线
>   `{id,kind:'file',name,size,sha256}`（路径不进报文）。25 的 `armedGifts` 直接从这里取
>   `{giftId → {path,size,hash,visitId,until}}`（`path` 只有 `backpack.oldestIdle()`/store 知道，
>   `gift` 本身没有路径）；接收端 `handleVisitRequest` 目前对 `gift.kind !== 'text'` 直接返回
>   （卡片停在 pending），25 要在那里接文件拉取。
> - 26：`gift-received` 应挂在 `src/service.js` 的 `onPeer` if/else 链里（别落到
>   `observeBeacon` 兜底）；收到后需要 `backpack` 的「回执删件」方法（本票只有 `markOut` /
>   `releaseOut`，退包还未接回 `finishOutbound`/`failOutbound`/tick）。`request.giftId` 还没存。
> - 27：`/dsh-zoo/state` 的 `backpack` 直接接 `backpack.items()`（已按 FIFO 排序）；
>   `gifts` 用 `gifts.list()`；`visits.json` 的 `gift` 字段仍未加。
