# 23: 带派——一条字条端到端

**What to build:** 串门请求可以捎一条字条：协议认字段、接收方落盘成 `note.txt`、桌面上贴着访客
出一张礼物卡（打开 / 在文件夹里显示 / 复制 / 扔掉）。这一票只做字条，不做文件、不做背包。

**Blocked by:** 无

**Status:** todo

决策依据：[ADR-0011](../../../docs/adr/0011-bring-gift-on-visit.md)、[SPEC v4](../SPEC-v4.md)。

- [ ] `src/protocol.js`：`visit-request` 多一个可选 `gift`（`id` / `kind:'text'` / `text`），
      校验、清洗（**保留换行**，去控制字符与双向覆盖符）、≤500 码点；非法 `gift` 整条丢弃、
      **串门照常**（与 `anim` 非法整包丢相反，写进注释说明为什么）
- [ ] 编码后整包超 4 KiB：丢掉 `gift` 重编一次，本机留一句 notice；返回给调用方的结果里能看出「这次没带上」
- [ ] `src/room.js`：入站礼物状态挂在这次访客上（`{ id, kind:'text', text, status:'received' }`），
      快照里给 `controls.gifts`
- [ ] `src/service.js`：收到带 `gift` 的 `visit-request` 时写 `<dataDir>/gifts/<giftId>/note.txt` +
      `meta.json`（`from` / `receivedAt` / `opened`）；目录名不可穿越，写失败只让这张卡变 `failed`
- [ ] `src/desktop-pets.js`：`controls.gifts` 归一化（只认本地形状，远端写不进来）
- [ ] `desktop/renderer.js`：自绘礼物卡（标题「「昵称」捎来一张字条」+ 最多 8 行正文 +
      打开 / 复制 / 在文件夹里显示 / 扔掉），矩形进 `overlay-rects`，其余部分照旧穿透
- [ ] `desktop/main.js` + `src/desktop.js`：`gift-open`（`shell.openPath`）/ `gift-reveal`
      （`shell.showItemInFolder`）/ `gift-copy`（剪贴板）/ `gift-discard`（删目录）；只认本地来路
- [ ] 访客回家 / 送客 / 失联 → 卡片收起；`gift-discard` 之后永不再出现
- [ ] `scripts/fake-peer.mjs` 加 `--gift "…"`，能发字条
- [ ] 单测：`gift` 编解码与边界、note 清洗、超 4 KiB 丢 gift 不丢串门；集成：两个 service + fake peer
- [ ] 冒烟：截图里能看到字条卡片，点「扔掉」后消失；`npm test` 全绿

> 备注：这一票结束时，人还不能在自己桌面上填字条——那是 24 的事。验收靠 fake-peer 与集成测。
