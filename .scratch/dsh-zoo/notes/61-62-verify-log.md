# 票 61 / 62 验收记录

日期：2026-11-12
目标机器：**DESKTOP-699DN63**（唯一验收机）

## 本地（macOS）

| 检查 | 结果 |
| --- | --- |
| `npm run check`（语法 + 全部用例） | 708 / 708 通过，约 9–11 秒 |
| `node --test test/contract-countdown.test.js` | 4 / 4 通过 |
| `node .scratch/dsh-zoo/debug-contract-clock/run.mjs`（真 Electron） | 4 / 4 PASS |
| 跨机时钟用例（`--test-name-pattern="时钟快 30 分钟"`） | 1 / 1 通过 |

真窗口回路读数（修好之后）：

```
t0                 还剩 1 分 30 秒
after-3s           还剩 1 分 28 秒     （正常走）
after-block-5s     还剩 1 分 22 秒     （阻塞 5 秒补上 5–6 秒）
after-tab-away-3s  还剩 1 分 18 秒     （切页回来不倒流）
```

## 远端（DESKTOP-699DN63）

投给它的东西：

- 工作树快照 `dsh-zoo-verify-61-62.tar.gz`（12.7 MB，含 `test/`），
  落到 `.cross-agent/inbox/<本机名>/`；
- 真窗口回路的 Windows 补丁 `dsh-zoo-harness-win-fix.tar.gz`（Electron 在 Windows
  上 stdout 常传不回管道，改成同时写 `.trace.json`）；
- 专用会话 `session-0bdf47c8-da7e-4cde-90bb-36f2f06534da`（`C:\temp`，workspace-write）。

要它跑的：`node scripts/run-tests.mjs`（708）、`contract-countdown`（4）、
`work-e2e` 的时钟用例（1）、真窗口回路（4 PASS）。

状态（2026-11-12 19:2x）：**卡在远端 agent 没响应**。投递与建会话都成功
（`session-0bdf47c8…`，`C:\temp`，workspace-write；文件 12.7 MB + 补丁 4.6 KB 都已送达），
但三条消息都还排在队列里：`peer_ask` 反复回「对方还没跑完」。判断是那台机器上的 DSH
应用没开/没有活动会话，投递服务在、agent 不在。

远端环境一醒就能一条命令跑完：[`verify-windows.ps1`](../debug-contract-clock/verify-windows.ps1)：

```powershell
powershell -ExecutionPolicy Bypass -File verify-windows.ps1 `
  -Package "C:\...\dsh-zoo-verify-61-62.tar.gz" `
  -Patch   "C:\...\dsh-zoo-harness-win-fix.tar.gz"
```

未完成的只有「在 Windows 上复跑」这一步；代码与本地证据都在下面。
