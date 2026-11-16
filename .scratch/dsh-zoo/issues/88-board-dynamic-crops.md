# 88: 盘口作物跟随目录（任意新作物）

**Blocked by:** 79–87（已合并）

**Status:** ready-for-agent

## 问题

`BOARD_CROPS` 写死 `tomato/carrot/pumpkin`；农场目录已有 10 种，新增作物（含跨机同步来的）
在盘口根本不出现，下单/协议也会拒掉。

## 要做的

- `src/trading-rules.js`：加 `boardCrops()`（目录里有有效底价的全部作物，顺序同目录），
  `BOARD_CROPS` 改为它的初始快照或删除；`isBoardCrop` 走动态清单。
- `src/service.js`：图/时间周期/风向/`limits.crops` 全部按 `boardCrops()` 生成。
- `src/protocol.js`：`trading-digest` 的 `positions[].crop` 白名单走 `isBoardCrop`。
- `desktop/shared.js`：`BOARD_MAX_CHARTS` 提到 32（或按作物数动态），别把第 9 种作物削掉。
- 测试：注入一个目录里原本没有的新作物 → 盘口出现/可下单/可出图/协议接受；坏底价作物被忽略；
  10 种作物时 payload 体积实测（< 200 KiB）并写进报告。
- 更新 README 的盘口作物说明；ADR-0031 已写好。

## 验收

- [ ] 目录 10 种作物全部出现在 `limits.crops` 与图表 payload，顺序同目录。
- [ ] 运行时新增作物（重载目录后）无需改代码即可出现在盘口并可下单。
- [ ] 协议接受目录内任意作物、拒绝坏底价/未知作物；旧邻居坏包整包丢。
- [ ] 白名单不再截断到 8 种；10 种作物 payload 实测 < 200 KiB。
- [ ] `npm run check` 全绿。
