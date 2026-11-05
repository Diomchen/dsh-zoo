# dsh-zoo 0.4.3 · Windows 验收结果（现场跑完的复盘）

- 现场日期：2026-11-04（Asia/Shanghai）
- 机器：Windows 11，DSH host `35004`，Web `61005`
- 被测包：`dsh-zoo-0.4.3.tgz`（55 files / desktop 14 / 0.4.3）
- 原始材料：`dsh-zoo-0.4.3-final-20261104.zip`（验收 md/docx、两次冒烟日志、
  `pet-043-live-final-object.json` / `pet-043-null-state.json`、桌面截图）
- 现场包内 `scripts/win32-sendinput.ps1` 哈希：`6DEECEB9…FD2FE9`，与清单一致

## 1. 判定

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 安装 | **PASS** | 0.4.2 → 0.4.3，2.693s，exit 0；55 files、desktop 14、`cordis.patch.yml` 在；无 `ERR_PNPM_*` |
| 票 30 真实左键 | **PASS** | helper 冒烟连跑两次，均 95 项断言；`trustedInputs 0→1`、`busy=true`、松手释放；上一轮「交还穿透」抖动未复现 |
| 票 31 对象态 | **PASS** | `dualLayer` 对象、`dualLayerNoted=true`、`dshPet.reachable=true`、`name=鱼姐`；15 次刷新稳定 |
| 票 31 null 态 | **部分** | `dualLayer=null`、`reachable=false`、`reason=unreachable`；`name` 仍是配置里的「鱼姐」，`dualLayerNoted=false` |
| 回归 | **部分** | 真实拖拽已验；人手甩动/落地、右键「打开软件」未验 |

结论：安装、票 30、票 31 对象态通过；null 态有一个出口字段错误，另有一处清单口径要统一。

## 2. 两个尾巴

### 2.1 `dshPet.name` 不可达时没清空（真问题，0.4.4 修）

现场：把 dsh-pet 从 profile 去掉后，`/state` 不通、`reachable=false`，但 `name` 还是「鱼姐」。
根因不在桥接：`self.pet` 在桥接失败时会按配置回落（本地宠物还要用这个名字画通用小人），
是 `/dsh-zoo/desktop` 把 `self.pet.name` 直接当成了「dsh-pet 在画谁」。

修法：出口的 `name` 与 `reachable` 用同一判据，不可达一律 `null`；`self.pet` 的降级行为不变。
`test/service.test.js` 新增一条复现现场（配置在、`/state` 404）的用例，修前红、修后绿。

### 2.2 `dualLayerNoted` 在 null 态为 `false` 是对的（清单笔误）

`dualLayerNoted` 表示「**这个进程里**提示打印过没有」。null 态从没有过可提示的对象，所以
`false`；重启后第一次真的两个都在画时才变 `true`。清单旧稿写成 `true`，已在
[`verify-0.4.3-windows.md`](verify-0.4.3-windows.md) 第 3 节改正。

## 3. 0.4.4

- 只改 `/dsh-zoo/desktop` 的 `dshPet.name` 判据（+ 一条单测、两处文档口径），
  桌面 helper、桥接、串门、礼物都不动。
- `npm test`：486 项全过。0.4.4 不重跑整轮 Windows 验收——被改的字段有单测覆盖，
  现场方便时刷新一次 `/dsh-zoo/desktop`，确认不可达时 `name` 是 `null` 即可。
- 产物：`dsh-zoo-0.4.4.tgz`（55 files / desktop 14）。
