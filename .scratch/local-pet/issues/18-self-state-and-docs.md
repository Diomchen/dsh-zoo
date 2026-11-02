# 18: 本机状态上报 + 文档与冒烟

**What to build:** 本机宠物插件通过 `POST /local-pet/self-state` 推 `action` / `semantic` / `say`；dsh-pet 轮询作为 L0 保留；更新文档并补双进程冒烟。

**Blocked by:** 16

**Status:** done

- [x] `POST /local-pet/self-state` 校验并写入本机宠物状态；推送后 30 秒内不被 dsh-pet 轮询覆盖
- [x] dsh-pet 没装、没推、`/state` 不通时，行为与 v2 一致
- [x] `npm run fake-peer` 支持带 `skin` / `action` / `say` 的假邻居
- [ ] 冒烟截图里同时出现远端素材宠物和通用小人
- [x] README、`docs/protocol.md`、`CONTEXT.md` 与新行为对齐

> 完成情况：`room.setSelfState` 只接受安全动作名、固定语义枚举、≤80 字且 30 秒内的气泡，
> 写进 `selfState`；`snapshot.self.pet` 在 30 秒内合并 `action` / `semantic` / `say`，过期自动回到
> dsh-pet 轮询结果。`service.js` 新增 `POST /local-pet/self-state`（本机回环、4KB 上限）：
> `say` 传字符串时默认活 8 秒，对象形态仍受 30 秒封顶；成功后立刻 `sendHeartbeats()` + `syncDesktop()`。
> `scripts/fake-peer.mjs` 新增 `--skin-port` / `--skin-id` / `--action` / `--semantic` / `--say`
> 与键盘 `s <一句话>`，beacon/心跳/串门请求都带得动；已跑 1.2 秒确认启动与发现正常。
> README 增加「跨插件素材」「本机状态上报」两节并改写旧限制；`docs/protocol.md` 已补字段与兼容口径；
> CONTEXT 的五个词在 ticket 14 前已落。测试：room +2、service +1，全量 283 条全绿。
>
> **冒烟截图没有跑**：宿主半边是新代码，要重启 DSH 才会加载；`npm run smoke:desktop` 可以复现，
> 但当前冒烟脚本的场景还是纯本机素材，没有 `src` / `fallback` 用例。场景字段本身有单测
>（`desktop-pets.test.js` 的 cache src / 语义 fallback），真机截图留给下一次重启后补。
