# 25: 送文件——礼物源与拉取

**What to build:** 文件礼物走「拉取，不推送」：对方在既有素材端口上开一条礼物路由，接收方在
访客抵达时主动来取，校验大小与 sha256 后落进 `gifts/`。图片额外在卡片上给缩略图。

**Blocked by:** 24

**Status:** done

决策依据：[ADR-0011](../../../docs/adr/0011-bring-gift-on-visit.md)、[SPEC v4](../SPEC-v4.md)、
[ADR-0008](../../../docs/adr/0008-pet-brings-its-own-look-and-state.md)。

- [x] `src/skin-server.js` 泛化成 `src/lan-server.js`：同一个端口、同一套只读约束，挂两套路由
      （素材 `/dsh-zoo-skin/*` 与礼物 `/dsh-zoo-gift/*`）；**没有素材源时也要能起来**
      （今天 `startSkinSource` 在没有源时直接 return——这里必须拆开），端口仍可被
      `DSH_ZOO_SKIN_PORT` 覆盖，被占就 +1 重试
- [x] `GET /dsh-zoo-gift/<giftId>`：只在 **armed** 期间可读——发起方发出这次串门请求后 5 分钟内、
      且该次串门未结束；其他时间 `404`。只读背包登记的那一个绝对路径（报文里没有任何路径），
      不列目录；`Content-Type: application/octet-stream` + `Content-Length`，v1 不做 Range
- [x] 410：文件被改动或删掉（大小/sha256 与发送时不符）；413：超过 16 MiB
- [x] `src/service.js`：`armedGifts` 表（giftId → `{ path, size, hash, visitId, until }`），
      出门时 arm、回家/送客/超时/失联 unarm；串门模块与素材服务之间只通过这张表耦合
- [x] 接收端拉取：`isPrivateAddress` 校验、连接 5s / 总计 20s、≤16 MiB、
      先写 `gifts/<id>/.part` 再 rename、sha256 必须对；失败原因只记
      `timeout` / `no-port` / `checksum` / `too-large` / `refused` / `write`；同来源失败后冷却 60s
- [x] `src/desktop.js` + `desktop/main.js`：`dshzoo://gifts/<giftId>/<name>` 白名单根
      （只读、路径夹取、只认 gifts 目录下的两层）；`thumb` 只给 jpg/png/gif/webp 且成功取回的文件
- [x] 卡片状态机 `pending / receiving / received / failed / refused` 落到 `controls.gifts`；
      渲染端只在 `received` 时显示缩略图，其余给文件图标
- [x] 集成：正常拉取（含中文文件名）、sha256 不符、410、413、超时、对方没广告 `skinPort`、
      对方中途回家（unarm → 404）；一个坏礼物不影响串门与其他访客
- [x] **两处 return 都要拆**：`src/service.js:608-611` 无素材源直接 return、`src/skin-server.js:47` 空源返回 null——不拆，没装素材源的用户就没有礼物端口
- [x] **不要复用 `src/skin-fetch.js` 的 `fetchBytes`**：它是「一个 AbortController 管总时长 + 响应体全量进内存」；礼物要 5s 连接 / 20s 总计 / `.part` 再 rename，另写 client，只借 `isPrivateAddress` 与失败冷却（`:76`）
- [x] helper 新 argv 根（`src/desktop-launch.js:107` + `desktop/main.js:1586`），`dshzoo://gifts/...` 只认两层目录 + 扩展名白名单，夹取用 `resolve` / `startsWith(base + sep)`（模板 `main.js:416`）
- [x] **`desktop/index.html:11` 的 CSP `img-src` 加 `dshzoo:`**，否则缩略图被静默挡掉
- [x] 冒烟：文件卡片与图片缩略图各一张截图；`npm test` 全绿

> 完成情况：文件礼物走「拉取，不推送」已经端到端打通。
>
> - `src/skin-server.js` → `src/lan-server.js`（`startLanServer`）：`sources` 为空也照常起，
>   同一个端口挂 `/dsh-zoo-skin/*` 与 `/dsh-zoo-gift/<giftId>`；端口仍由
>   `DSH_ZOO_SKIN_PORT` 覆盖、被占 +1 重试。`skinRef` 拆成「端口总有、源 id 可能没有」。
> - `service.js` 新增 `armedGifts`（giftId → {path,size,hash,visitId,until}）：arm 在
>   `startOutboundVisit` 的 `backpack.markOut` + 首次发送成功之后；unarm 挂在本地召回、
>   对方 deny、对方 recall（发起方一侧）、请求超时、tick（到期/失联对账）与 dispose。
>   路由只查这张表：404（未 arm/过期）/ 410（改动或删除）/ 413（>16 MiB）/ 405（非 GET/HEAD），
>   `Content-Type: application/octet-stream` + `Content-Length` 流式返回，v1 不做 Range。
> - 接收端 `receiveFileGift`：≤16 MiB → `receiving` → `gift-fetch.js`（连接 5s / 总计 20s、
>   流式 `.part` + rename、sha256 与大小双校验、失败冷却 60s）→ `received`；
>   失败原因只用 `timeout / no-port / checksum / too-large / refused / write`。
> - `gifts.js` 的 meta 扩 `kind:'file'`（name/size/sha256/opened），新增
>   `beginFile / finishFile / abortFile`；`desktop-pets.js` 的 `controls.gifts` 给
>   `kind/name/size/thumb`，`thumb` 只在 received 且 jpg/png/gif/webp 时出现。
> - helper 新 argv 根 `--dsh-zoo-gifts`（`desktop-launch.js` + `desktop/main.js`）；
>   `dshzoo://gifts/<目录>/<文件名>` 只认两层、图片扩展名白名单、`resolve` + `startsWith` 夹取；
>   `desktop/index.html` 的 CSP `img-src` 加了 `dshzoo:`；渲染端画缩略图 / 文件图标+名字+大小。
> - 测试：`npm test` 418 通过（起点 391；新增 lan-server 路由、gift-fetch、gift-path、
>   文件 meta/store、文件卡片、room 形状与两个 service 的端到端）。冒烟只跑
>   `DSH_ZOO_SMOKE_ONLY=gift`（72 项断言）：字条卡、图片缩略图（`thumb.loaded=true`，
>   证明 CSP + dshzoo://gifts 都通）、非图片文件卡各一张截图，落在
>   `.scratch/dsh-zoo/notes/25-gift-{card,image,file}.png`。
> - 给 26 留的接缝：`armedGifts` / `unarmGift(visitId)` / `unarmEndedGifts()` 都只在
>   service 内；26 的退包只要和上面五个结束点并排加一行即可。`giftStatusText(status, reason)`
>   只加了本票用到的几条失败文案，`gift-received` 完全没动。
