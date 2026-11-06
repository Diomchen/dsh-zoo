# 45: 状态出口、限额、文档与验收

**What to build:** 把农场接进 `state`/`action` 文档和限额，补齐 README、验收与全量测试；旧邻居的降级写得清楚。这一票不加新玩法，只把前六票收口。

**Blocked by:** 41, 42, 43, 44

**Status:** done

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)、[SPEC v5](../SPEC-v5.md)。

- [x] `GET /dsh-zoo/state` 的 `farm` / `market` / `contracts` 三类字段与文档一致；
      `POST /dsh-zoo/action` 的 `plant` / `harvest` / `water` / `fertilize` /
      `buy-seed` / `sell-crop` / `hire` / `recall-worker` / `end-contract` 全部有
      body、返回值和错误码说明
- [x] 限额表落地：硬币/种子/作物/露水/日志/历史/合同上限；偷菜 3/5/10 与每地 1 次；
      帮忙 3/5/1；行情 1 条/30 秒/peer；买卖 10 次/分钟；价格夹取；`requestId` /
      `contractId` 幂等缓存 200；所有 id 只从校验过的字段拼，不碰路径
- [x] README 加「农场」一节：怎么种/收/偷/帮/雇/买卖；数据目录多 `farm.json` /
      `market.json` / `contracts.json`；旧版本邻居看不到农场；没有桌面层也能用 HTTP
- [x] `CONTEXT.md` 与 ADR-0016 的链接、SPEC v5 的链接互相对得上；发布说明写一句
      「农场是 v1.1 的新层，旧邻居串门/礼物照常」
- [x] 全量 `npm test` 全绿；`npm run smoke:desktop` 增加农场段：地块条、开窗、种/收、
      交易所页、雇工角标；截图写进 `.scratch/dsh-zoo/notes/`
- [ ] 两台机器（或 fake peer + 本机）走一遍：串门→偷/帮→挂牌→雇→守卫→结算；
      旧版本邻居只串门不崩
- [x] 版本号与 `README` 的发布说明同步；不改既有串门/礼物/换皮行为

> 完成情况：`docs/protocol.md` 补齐 `/state` 的 `farm`/`market`/`contracts` 形状、本机
> 农场/交易所/雇佣动作与错误码、`GET /dsh-zoo-farm/<visitId>`、`market-digest`、
> `farm-action(-result)`、8 种 `work-*`、4 KiB/旧邻居降级；README 加「农场」一节（种/收/
> 偷/帮/雇/买卖、三个数据文件、限额、旧邻居/无桌面降级、两机验收步骤）；CONTEXT/ADR-0016
> 与 SPEC v5 链接互相对齐，发布说明写「农场是 v1.1 的新层，旧邻居串门/礼物照常」；
> `package.json` 1.1.0。限额与代码对齐：farm-action 缓存 200、work-ack 缓存由 100 提到 200、
> 其余按代码实际写入（露水 48/天、日志 50/20、历史 200/50、合同 20/侧、偷 3/5/10、
> 帮 3/5/1、行情 1/30s/peer、买卖 10/分、价格夹取）。
> `npm test` 737/737、`npm run check` 737/737；farm-only 冒烟 37/37，截图在
> `.scratch/dsh-zoo/notes/45-*.png`；全量冒烟仍卡在既有的改名窗焦点断言（改动前基线同样失败）。
> 偏离 / 未执行：两台真机手工验收未做（本环境只有一台机器，fake peer 未实现农场状态机）；
> 农场小窗「记录」页签仍未开放（本票只写进文档，不加新 UI）；新增的 smoke 调试命令
> `debug-farm-tab` 仅 debug 模式可用。提交见 `git log -1`。
