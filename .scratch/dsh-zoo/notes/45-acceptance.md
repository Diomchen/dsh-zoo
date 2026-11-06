# 45 验收记录（状态、限额、文档）

- 日期：2026-11-06
- 环境：macOS（本机 DSH Desktop），Node v22.22.3，Electron
  `/Users/gensean/.dsh/electron/Electron.app/Contents/MacOS/Electron`
- 分支 / 提交：`farm-t45`

## 自动化结果

| 命令 | 结果 |
| --- | --- |
| `npm test` | 737 / 737 通过，0 fail，16.5s |
| `npm run check` | 737 / 737 通过，0 fail，16.5s（含全部 `node --check`） |
| `DSH_ZOO_SMOKE_ONLY=farm DSH_ZOO_SMOKE_NOTES=1 npm run smoke:desktop` | 37 项断言通过（只跑农场段），退出码 0 |
| `npm run smoke:desktop`（全量） | **失败**：`改名小窗拿到焦点（要能直接打字）`，在 controls 段；农场段未跑到。改动前的基线也同样失败在同一断言，属于既有环境/焦点时序问题，不是农场新段引入 |

农场段覆盖：桌面 4 块地 + 成熟角标 + 命中矩形、点地块发 `farm-open`、
`role:'worker'` + `work` 角标、摘要里的雇工昵称、开窗/失焦不关、`farm-plant`、
`hire-listing` 窄口、失败留在窗里、交易所页、雇工页、访客偷/帮视图。

## 截图（`.scratch/dsh-zoo/notes/`）

- `45-farm-window-composited.png`：农场页（地块/种子/作物/日志）
- `45-farm-market-composited.png`：交易所页（bid / 局域网指数 / 成交历史）
- `45-farm-hire-composited.png`：雇工页（自己的挂牌 / 合同 / 邻居挂牌）
- `45-farm-steal-composited.png`：访客视图（偷 / 帮 / 守卫 80% / 上限）
- `45-farm-strip.png`：桌面地块条
- `45-farm-worker-strip.png`：带雇工摘要的地块条
- `45-farm-worker.png`：雇工宠物特写（「打工」角标）

## 未执行 / 限制

- **两台真机手工验收未执行**：本环境只有一台机器。`scripts/fake-peer.mjs` 目前只实现
  发现 / 串门 / 礼物，没有农场仓库与合同状态机；偷/帮/雇/结算由
  `test/farm-*-e2e.test.js`、`test/work-*-e2e.test.js` 的两个 service + fake peer 覆盖。
  两台真机的步骤写在 README「农场 · 验收：两台机器或假邻居」。
- 全量 smoke 的改名焦点断言为既有失败；farm-only 冒烟通过，截图已落盘。
- 农场小窗「记录」页签仍未开放（ticket 40 的 UI 范围），最近 8 条日志在农场页底部；
  本票只把它写进 README/desktop 文档，不新增 UI 行为。
