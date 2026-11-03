# 24: 背包与「带派」小窗

**What to build:** 发送端能准备礼物——背包（`backpack.json`，最多两件，先放的先带走）+
右键「带派」小窗（写字条 / 选文件 / 看背包 / 撤掉）+ `POST /local-pet/action {"action":"bring"}`。
出门时自动带最旧的一件，自发出门也带。

**Blocked by:** 23

**Status:** todo

决策依据：[ADR-0011](../../../docs/adr/0011-bring-gift-on-visit.md)、[SPEC v4](../SPEC-v4.md)。

- [ ] `src/backpack.js`：读写 `<dataDir>/backpack.json`，形状 `{ version, items: [...] }`；
      最多 2 件（满了返回 `backpack-full`，不静默丢旧的）；损坏 → 空背包 + 只告警一次；
      写入串行化 + tmp/rename（与 `src/visits.js` 同一套路）
- [ ] 文件件只存绝对路径 + `name`；`size` / `sha256` 在**发送那一刻**才算；
      源文件不存在或读不了 → 这次不带、留在背包、一句人话
- [ ] `src/menu.js`：一级工具项多 `bring`（文案「带派」）；只挂自己的宠物
- [ ] 独立小窗 `desktop/gift.html` + `gift.js` + `gift-preload.js`（仿 `rename.*`）：
      `focusable:true`、无边框透明、失焦关闭；文字框（≤500，实时字数）、选文件按钮
      （主进程 `dialog.showOpenDialog`，选完在渲染端显示文件名与大小）、背包列表（每条可撤）
- [ ] 小窗桥：只暴露 `ready / submit / cancel / remove / onInit / onResult`，不放 Node 能力
- [ ] `POST /local-pet/action`：`bring`（`{kind:'text',text}` 或 `{kind:'file',path}`）、
      `unbring`（`{giftId}`，仅 `idle`）；错误码 `bad-gift` / `too-large` / `backpack-full` /
      `no-such-file` / `gift-out`
- [ ] 出门（手动与自发）时取背包里 `at` 最小的一件，编码进 `visit-request`；
      手动出门若无背包件则不捎（不阻挡串门）
- [ ] 单测：背包读写（损坏 / 满 / 撤回 / 源文件消失）、小窗入参校验、`bring`/`unbring` 的错误码
- [ ] 真机冒烟：右键出「带派」、写一条放进背包、背包里看得到、撤掉；截图
