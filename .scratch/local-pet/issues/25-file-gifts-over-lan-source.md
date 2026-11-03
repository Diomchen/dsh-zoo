# 25: 送文件——礼物源与拉取

**What to build:** 文件礼物走「拉取，不推送」：对方在既有素材端口上开一条礼物路由，接收方在
访客抵达时主动来取，校验大小与 sha256 后落进 `gifts/`。图片额外在卡片上给缩略图。

**Blocked by:** 24

**Status:** todo

决策依据：[ADR-0011](../../../docs/adr/0011-bring-gift-on-visit.md)、[SPEC v4](../SPEC-v4.md)、
[ADR-0008](../../../docs/adr/0008-pet-brings-its-own-look-and-state.md)。

- [ ] `src/skin-server.js` 泛化成 `src/lan-server.js`：同一个端口、同一套只读约束，挂两套路由
      （素材 `/local-pet-skin/*` 与礼物 `/local-pet-gift/*`）；**没有素材源时也要能起来**
      （今天 `startSkinSource` 在没有源时直接 return——这里必须拆开），端口仍可被
      `LOCAL_PET_SKIN_PORT` 覆盖，被占就 +1 重试
- [ ] `GET /local-pet-gift/<giftId>`：只在 **armed** 期间可读——发起方发出这次串门请求后 5 分钟内、
      且该次串门未结束；其他时间 `404`。只读背包登记的那一个绝对路径（报文里没有任何路径），
      不列目录；`Content-Type: application/octet-stream` + `Content-Length`，v1 不做 Range
- [ ] 410：文件被改动或删掉（大小/sha256 与发送时不符）；413：超过 16 MiB
- [ ] `src/service.js`：`armedGifts` 表（giftId → `{ path, size, hash, visitId, until }`），
      出门时 arm、回家/送客/超时/失联 unarm；串门模块与素材服务之间只通过这张表耦合
- [ ] 接收端拉取：`isPrivateAddress` 校验、连接 5s / 总计 20s、≤16 MiB、
      先写 `gifts/<id>/.part` 再 rename、sha256 必须对；失败原因只记
      `timeout` / `no-port` / `checksum` / `too-large` / `refused` / `write`；同来源失败后冷却 60s
- [ ] `src/desktop.js` + `desktop/main.js`：`localpet://gifts/<giftId>/<name>` 白名单根
      （只读、路径夹取、只认 gifts 目录下的两层）；`thumb` 只给 jpg/png/gif/webp 且成功取回的文件
- [ ] 卡片状态机 `pending / receiving / received / failed / refused` 落到 `controls.gifts`；
      渲染端只在 `received` 时显示缩略图，其余给文件图标
- [ ] 集成：正常拉取（含中文文件名）、sha256 不符、410、413、超时、对方没广告 `skinPort`、
      对方中途回家（unarm → 404）；一个坏礼物不影响串门与其他访客
- [ ] **两处 return 都要拆**：`src/service.js:608-611` 无素材源直接 return、`src/skin-server.js:47` 空源返回 null——不拆，没装素材源的用户就没有礼物端口
- [ ] **不要复用 `src/skin-fetch.js` 的 `fetchBytes`**：它是「一个 AbortController 管总时长 + 响应体全量进内存」；礼物要 5s 连接 / 20s 总计 / `.part` 再 rename，另写 client，只借 `isPrivateAddress` 与失败冷却（`:76`）
- [ ] helper 新 argv 根（`src/desktop-launch.js:107` + `desktop/main.js:1586`），`localpet://gifts/...` 只认两层目录 + 扩展名白名单，夹取用 `resolve` / `startsWith(base + sep)`（模板 `main.js:416`）
- [ ] **`desktop/index.html:11` 的 CSP `img-src` 加 `localpet:`**，否则缩略图被静默挡掉
- [ ] 冒烟：文件卡片与图片缩略图各一张截图；`npm test` 全绿
