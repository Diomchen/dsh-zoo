# 18: 本机状态上报 + 文档与冒烟

**What to build:** 本机宠物插件通过 `POST /local-pet/self-state` 推 `action` / `semantic` / `say`；dsh-pet 轮询作为 L0 保留；更新文档并补双进程冒烟。

**Blocked by:** 16

**Status:** todo

- [ ] `POST /local-pet/self-state` 校验并写入本机宠物状态；推送后 30 秒内不被 dsh-pet 轮询覆盖
- [ ] dsh-pet 没装、没推、`/state` 不通时，行为与 v2 一致
- [ ] `npm run fake-peer` 支持带 `skin` / `action` / `say` 的假邻居
- [ ] 冒烟截图里同时出现远端素材宠物和通用小人
- [ ] README、`docs/protocol.md`、`CONTEXT.md` 与新行为对齐

> 这一张是收口：前面四张各自可测，这一张负责让「别人家的插件」真的能接进来。
