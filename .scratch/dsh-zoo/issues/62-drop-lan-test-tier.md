# 62: 删掉局域网测试档——只剩一档，跨机验收只认 DESKTOP-699DN63

**What to build:** 把票 60 分出来的「网络档」整档删掉：21 个开 socket 的回环用例、
`scripts/test-groups.mjs` 的分档清单、`test:net` / `test:all` 两个入口。`npm test` 回到
一档（`test/` 下全部 `*.test.js`）。跨机验证不再靠这些用例，而是在**唯一的目标机器
`DESKTOP-699DN63`** 上由 cross-agent 下发、回读结果。

**Blocked by:** 无（票 60 的分档是这一步的前身）

**Status:** done（2026-11-12）

用户原话：「同时去掉测试中局域网测试环节，要缩小到我的目标windows：DESKTOP-699DN63」。
票 60 当时选了「留文件、只分档」，这一票按用户要求改成删除。

## 删了什么

21 个用例（全部只打回环，但会开 socket / 绑端口 / 跑真实计时器）：

```
bring-e2e · discovery · farm-action-e2e · farm-retry-e2e · farm-visit-e2e
gift-e2e · gift-fetch · gift-file-e2e · guests · lan-server · market-digest-e2e
menu-actions · open-site-auth · pet-bridge · raid-inbound · receipt-e2e
service · skin-fetch · visit-e2e · work-action-e2e · work-lossy-e2e
```

配套：`scripts/test-groups.mjs`（`NETWORK_TESTS` 清单 + socket 源码特征）、
`test/network-classification.test.js`（清单腐化兜底）、`package.json` 的
`test:net` / `test:all`、`scripts/run-tests.mjs` 的 `--network` / `--all` 分支。

## 代价（要知道，别装作没有）

- 覆盖缺口：UDP 发现/串门/召回、礼物收发与退回、偷菜入站、行情 gossip、技能往返、
  本机 HTTP 素材源/菜单/桥接，全部只剩手工验证。
- `service.test.js`（66 KB）是这些里最大的一份：宿主 `createService` 的接线、路由、
  限额、崩溃恢复的集成用例都在里面。
- 文件在 git 历史里（删于本次提交的前一个版本），要恢复：
  `git checkout <删之前的提交> -- test/service.test.js` 等。

## 现在怎么验

- [x] `npm test`：一档，708 个用例，约 9 秒全绿。
- [x] `npm run check`：语法检查 + `npm test`。
- [x] `node scripts/run-tests.mjs --list`：列文件、不执行。
- [x] 跨机：只对 `DESKTOP-699DN63` 做（README「开发」已写死这一条），用 cross-agent
      下发 `npm test` + 真窗口倒计时回路，结果回读。

## 不做

- 不再对其他机器/整个网段做验收。
- 不把删掉的用例改写成不碰 socket 的版本（那是另一件事，票 60 的「不做」里也提过）。
- 不动 `scripts/two-pets.mjs` / `peer-probe.mjs` / `verify-catalog-sync.mjs`：
  它们是手工单播工具，不是测试套件的一部分。
