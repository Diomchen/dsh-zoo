# 16: 协议带上 skin / action / semantic / say

**What to build:** 在 v1 报文里加可选字段：beacon 带 `skinPort` / `skinId`，heartbeat 和 visit-request 带 `action` / `semantic` / `say`；`anim` 继续发，旧端只读它。

**Blocked by:** 14

**Status:** done

- [x] `beacon` / `beacon-ack` 带可选 `skinPort`、`skinId`
- [x] `heartbeat` / `visit-request` 带可选 `action`、`semantic`、`say`；`anim` 仍然必发
- [x] 解析：缺字段回退（`action` → `anim`），非法字段丢弃该字段、不整包失败，未知字段忽略
- [x] `say` 的 text 清洗并截断到 80 字；`until` 上限 `now + 30s`，过期整条丢弃
- [x] 单测覆盖新旧两端互发：旧包给新端、新包给旧端（未知字段丢弃）
- [x] `docs/protocol.md` 补上这些字段和兼容口径

> 完成情况：`src/protocol.js` 增加 `MAX_SAY` / `SAY_MAX_AGE_MS` / `SEMANTIC_TAGS` 与
> `normalizeSemantic` / `normalizeSay` / `normalizeSkinId`；`encodePacket` 的 heartbeat /
> visit-request / beacon 分支按需带新字段，`parsePacket(input, { now })` 逐字段解析、非法单字段丢弃。
> 服务端心跳/串门请求已经带 `skinPort` / `skinId`；`action` 只在宿主有**独立于 `anim`** 的动作名时才发
>（避免重复占字节），`semantic` / `say` 的数据源在 ticket 18 接 `self-state`。测试
> `test/protocol-skin.test.js` 9 条；全量 271 条全绿。
