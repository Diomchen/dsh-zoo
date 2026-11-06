# 39: 农场数据与纯规则

**What to build:** 一只宠物有农场：4 块地、3 种作物、30 硬币、2 颗小番茄种子。HTTP 能种/收/浇/施肥，重启不丢；坏文件不崩。这一票不做 UI，40 接。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)、[SPEC v5](../SPEC-v5.md)。

- [ ] `src/farm-rules.js`：作物表（`tomato` 30min/种 6/产 3/底 5、`carrot` 2h/14/5/6、
      `pumpkin` 8h/36/3/30）、生长计算、成熟判定、收获产量（+施肥 − 被偷，最低 0）；
      纯函数，不碰时钟/磁盘/网络，随机源可注入
- [ ] `src/farm.js`：`farm.json` v1（`coins` / `seeds` / `crops` / `dew` / `dewAt` /
      `dewDay` / `lastTickAt` / `plots` / `hire` / `log`）；缺文件 → 初始农场（4 空地、
      30 硬币、2 番茄种子）；损坏 → 默认 + 每个原因只告警一次；写入串行 + tmp/rename；
      硬币/种子/作物/日志上限
- [ ] 离线生长：加载时补 `min(now − lastTickAt, 12h)`；运行中按真实时间；成熟即停；
      **不枯萎**；`tick()` 每 60 秒推进，保存节流
- [ ] 露水：待机 10 分钟 +1，每天上限 48，本地午夜重置；浇水 1、施肥 5；
      任何农场动作重置待机计时
- [ ] 动作：`plant` / `harvest` / `water` / `fertilize`；错误码 `bad-plot` /
      `plot-occupied` / `bad-crop` / `no-seed` / `not-mature` / `no-dew`；
      `GET /dsh-zoo/state` 多 `farm`
- [ ] 单测：生长/成熟/收获扣减/离线 12h 上限/露水跨日；store 的损坏、缺失、上限、
      tmp+rename、只告警一次
- [ ] HTTP 集成（`network:false`）：种→等→收→再种；硬币/种子/作物对得上；`npm test` 全绿
