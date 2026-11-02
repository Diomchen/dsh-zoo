# 16: 协议带上 skin / action / semantic / say

**What to build:** 在 v1 报文里加可选字段：beacon 带 `skinPort` / `skinId`，heartbeat 和 visit-request 带 `action` / `semantic` / `say`；`anim` 继续发，旧端只读它。

**Blocked by:** 14

**Status:** todo

- [ ] `beacon` / `beacon-ack` 带可选 `skinPort`、`skinId`
- [ ] `heartbeat` / `visit-request` 带可选 `action`、`semantic`、`say`；`anim` 仍然必发
- [ ] 解析：缺字段回退（`action` → `anim`），非法字段丢弃该字段或整包（与现有口径一致），未知字段忽略
- [ ] `say` 的 text 清洗并截断到 80 字；`until` 上限 `now + 30s`
- [ ] 单测覆盖新旧两端互发：旧包给新端、新包给旧端
- [ ] `docs/protocol.md` 补上这些字段和兼容口径

> 不升协议版本：全是可选字段，旧端 `parsePacket` 本来就会丢弃未知字段。
