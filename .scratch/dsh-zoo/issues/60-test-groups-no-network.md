# 60: 测试分档——默认不碰网络

**What to build:** `npm test` 只跑不碰网络的用例；开了 socket 的用例单独一档，显式
`npm run test:net` 才跑。理由是大家机器上都常开着 DSH，网络用例开 socket、绑回环端口、
跑真实计时器，既慢又容易互相干扰（用户原话：「但凡网络相关测试去除这个，现在大家都在用
很影响体验」）。

**Blocked by:** 无

**Status:** done（2026-11-12）

- [x] `scripts/test-groups.mjs`：显式 `NETWORK_TESTS` 清单（21 个）+ 开 socket 的源码特征
- [x] `scripts/run-tests.mjs`：`--network` / `--all` / `--list`，默认核心档；
      输出跑几个、跳过几个，子进程继承 stdio
- [x] `package.json`：`test` 走 runner、新增 `test:net` / `test:all`；`check` 仍 = 语法检查 + `test`
- [x] `test/network-classification.test.js`：扫源码兜底——新用例只要出现
      `dgram` / `createServer(` / `.listen(` / `createSocket(` 而没进清单，默认档就红；
      清单里已经不开 socket 的也会红（清单不许腐化）
- [x] README「开发」：两档命令、为什么这么分、跨机验证只对 `DESKTOP-699DN63` 单播做
- [x] 核心档 705 个用例全绿、约 7 秒（分档前全量 855 个约 17 秒）
- [x] 网络档的 21 个用例确认**只打回环**（`127.0.0.1` + 随机端口，没有 `255.255.255.255` 广播）

> 不做：删掉网络用例（它们仍有价值，只是不该默认跑）；不在 CI/默认流程里连真机。
