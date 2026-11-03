# 23: 带派——一条字条端到端

**What to build:** 串门请求可以捎一条字条：协议认字段、接收方落盘成 `note.txt`、桌面上贴着访客
出一张礼物卡（打开 / 在文件夹里显示 / 复制 / 扔掉）。这一票只做字条，不做文件、不做背包。

**Blocked by:** 无

**Status:** done

决策依据：[ADR-0011](../../../docs/adr/0011-bring-gift-on-visit.md)、[SPEC v4](../SPEC-v4.md)。

- [x] `src/protocol.js`：`visit-request` 多一个可选 `gift`（`id` / `kind:'text'` / `text`），
      校验、清洗（**保留换行**，去控制字符与双向覆盖符）、≤500 码点；非法 `gift` 整条丢弃、
      **串门照常**（与 `anim` 非法整包丢相反，写进注释说明为什么）
- [x] 编码后整包超 4 KiB：丢掉 `gift` 重编一次，本机留一句 notice；返回给调用方的结果里能看出「这次没带上」
- [x] `src/room.js`：入站礼物状态挂在这次访客上（`{ id, kind:'text', text, status:'received' }`），
      快照里给 `controls.gifts`
- [x] `src/service.js`：收到带 `gift` 的 `visit-request` 时写 `<dataDir>/gifts/<giftId>/note.txt` +
      `meta.json`（`from` / `receivedAt` / `opened`）；目录名不可穿越，写失败只让这张卡变 `failed`
- [x] `src/desktop-pets.js`：`controls.gifts` 归一化（只认本地形状，远端写不进来）
- [x] `desktop/renderer.js`：自绘礼物卡（标题「「昵称」捎来一张字条」+ 最多 8 行正文 +
      打开 / 复制 / 在文件夹里显示 / 扔掉），矩形进 `overlay-rects`，其余部分照旧穿透
- [x] `desktop/main.js` + `src/desktop.js`：`gift-open`（`shell.openPath`）/ `gift-reveal`
      （`shell.showItemInFolder`）/ `gift-copy`（剪贴板）/ `gift-discard`（删目录）；只认本地来路
- [x] 访客回家 / 送客 / 失联 → 卡片收起；`gift-discard` 之后永不再出现
- [x] `scripts/fake-peer.mjs` 加 `--gift "…"`，能发字条
- [x] 单测：`gift` 编解码与边界、note 清洗、超 4 KiB 丢 gift 不丢串门；集成：两个 service + fake peer
- [x] 冒烟：截图里能看到字条卡片，点「扔掉」后消失；`npm test` 全绿

> 备注：这一票结束时，人还不能在自己桌面上填字条——那是 24 的事。验收靠 fake-peer 与集成测。

> 完成情况：字条端到端已经打通。
> **协议**（`src/protocol.js`）：`visit-request` 可带 `gift{id,kind:'text',text}`；`sanitizeNote`
> 保留换行、去控制字符与双向覆盖符、≤500 码点，超限**丢 gift 不丢串门**（与 `anim` 整包丢相反，
> 注释写明为什么）。编码层的 `encodeVisitRequestDetailed` 在整包超 4 KiB 时摘掉 gift 重编一次，
> 返回 `giftDropped`；`service` 据此写一句「字条太长了，这次没带上」并把它放进 action 结果里。
> **宿主**：`src/room.js` 把礼物挂到 `visitor.gift`（pending → service 写盘成功回报 received/failed），
> `discardGift` 用一个 200 条上限的本次运行黑名单保证「扔掉后重发也不复活」；
> 新模块 `src/gifts.js` 负责落盘 `<dataDir>/gifts/<yyyyMMdd>-<HHmmss>-<id前8位>/note.txt`
> （目录名由 `receivedAt` 的本地时间 + id 前 8 位推出，meta 记录 `id`/`dir`），两个文件都
> tmp + rename，meta 坏了只跳过并告警一次，路径只由校验过的目录名拼出来。
> `src/gift-copy.js` 是标题/状态文案唯一表（failed/refused 预留、措辞不猜原因）。
> `controls.gifts` 在 `src/desktop-pets.js` 由 visitor 推出（访客走了卡片自然没有），
> `desktop/shared.js` 的 `emptyControls`/`normalizeControls`/helper 事件/命令白名单四处都放行
> 礼物字段与 giftId。
> **桌面**：`renderer.js` 自绘礼物卡（「昵称」捎来一张字条 + 最多 8 行 pre-wrap 正文 +
> 打开/复制/在文件夹里显示/扔掉），卡片贴在那位访客旁边，卡、四个按钮、桥接矩形都进
> `overlay-rects`（按钮矩形带 giftId，两张卡不撞名），其余区域照旧穿透；卡片跟着访客
> 出现/消失，pending 时只禁用需要文件的三个按钮、扔掉始终可用。
> `desktop/preload.js` → `main.js` → 宿主的 action 链路补齐了 `giftId`；`desktop/main.js` 新增
> `gift-open`（`shell.openPath`）/`gift-reveal`（`shell.showItemInFolder`）/`gift-copy`
> （`clipboard.writeText`）/`gift-discard`（删目录，额外确认目标就是 `gifts/` 下的一级目录），
> `src/desktop.js` 对应 `giftOpen`/`giftReveal`/`giftCopy`/`giftDiscard`；`service.handleAction`
> 新增四个动作，路径只从礼物 store 取，错误码 `bad-gift` / `gift-not-found` / `open-failed`。
> 没有桌面层时打开/显示/复制明确失败（HTTP 路径也能用）；扔掉以宿主删除为准（HTTP/无 helper 都成立），
> 同一台桌面上再顺带发一条 helper 的 gift-discard（rm -rf 幂等）。
> `scripts/fake-peer.mjs` 加 `--gift "…"`（每次串门一件新礼物）。
> **测试**：新增 `test/protocol-gift.test.js`（11）、`test/gifts.test.js`（10，含并发重试只建一个目录）、
> `test/gift-copy.test.js`（2）、`test/room.test.js` 的礼物段（6）、
> `test/desktop-pets.test.js` 的卡片映射（2）、`test/desktop.test.js` 的四道白名单（3）、
> `test/gift-e2e.test.js`（5：fake peer 落盘/卡片/扔掉/重发、旧报文、两个 service 实例、
> 超 500 码点丢 gift、只走 helper 的四个动作）。`npm test` 全绿 **366** 条（原 325 + 新 41）。
> **冒烟**：新增 `gift` 段（`LOCAL_PET_SMOKE_ONLY=gift LOCAL_PET_SMOKE_NO_SANDBOX=1`，
> 34 项断言）：卡片可见、正文保留三行、卡/按钮/桥接矩形齐全、点「复制」带 giftId 且成功气泡
> 冒泡、点「扔掉」后卡片与矩形一起消失、光标移开恢复穿透；截图
> `.scratch/local-pet/notes/23-gift-card.png` 与特写 `23-gift-card-crop.png`
> （本机 Chromium sandbox 起不来，冒烟带 `LOCAL_PET_SMOKE_NO_SANDBOX=1` 才跑得动，这是环境限制）。
> 全量 `npm run smoke:desktop` 在本机跑到 manager 段时 Chromium sandbox 起不来
> （`Failed to initialize sandbox`，与礼物无关；helper 客户端都带了 `--no-sandbox`，manager 段走
> `createDesktop` 没有这个开关），留给父 agent 在有图形权限的环境统一跑；礼物段已独立通过。
>
> 留给后面票的坑：
> - `gift.kind` 现在只认 `'text'`；文件礼物（25）要同时扩 `normalizeGift`、`gifts.js` 的 meta、
>   `room.visitorGift`、`shared.normalizeControls` 与渲染端的 kind 分支，**四处都改才不会静默丢**。
> - `visit` action 现在接受一个内部/脚本用的 `gift` 参数（本票用它验完整条线）；24 做背包时
>   把它换成「背包里 at 最小的那件」，重发仍要带同一件（`request.gift` 已经这么存）。
> - `meta.opened` 已经在 gift-open 成功时落盘，26 的「送客时提醒一次」可以直接用。
> - `gifts` 磁盘限额/按 receivedAt 删最旧、`/local-pet/state` 的 `backpack`/`gifts` 列表、
>   `visits.json` 的 `gift` 字段都还没做（27）；store 已有 `list()` 与 200 条内存索引。
> - `gift-discard` 的 helper 命令是「发出去就不等结果」（与 `open-url` 同一条单向命令）；
>   删除本身已经由宿主的礼物 store 做完，所以 helper 失败不会留下文件。
> - 礼物卡的表情/文件图标/缩略图是 25 的事；本票只画字条。
