# dsh-zoo 0.4.3 · Windows 测试需求

接着 0.4.2 那一轮（结果见 [`verify-0.4.2-windows-result.md`](verify-0.4.2-windows-result.md)）。
0.4.2 的票 28 / 30 已经通过，这轮**只收两个尾巴 + 复跑一次不再抖的冒烟**，不用重做全量。
票 29（首次升级不再 EPERM）不在这轮范围内——它需要一台还能装 0.4.0 的机器，代码侧没有新改动。

## 0. 这轮改了什么

| 改动 | 为什么 | 对应上一轮的哪条 |
| --- | --- | --- |
| `scripts/win32-sendinput.ps1` 换成真 `SendInput` + DPI 感知 + 按下前刷新 hover | 0.4.2 现场证明这个脚本自己在骗人（名字写 SendInput，调的是 `mouse_event`） | 票 30 的假失败 |
| 冒烟的「拖拽结束交还穿透」改成事件优先、状态兜底 | `emitHit()` 只在穿透翻转时发事件，等事件会假超时 | 那次「重跑即通过」 |
| `/dsh-zoo/desktop` 新增 `dualLayerNoted`、`dshPet { reachable, reason, name }` | 宿主 stdout 不落盘，「日志只打一次」和「null 态」都没有可观测出口 | 票 31 欠的两点 |
| `test/win32-sendinput.test.js` | 只在 Windows 上跑的脚本需要守卫，回退到 `mouse_event` 要当场变红 | 同上 |

**不要再手动打 0.4.2 那个补丁**：修复已经进包。装完可以核对脚本哈希：

```powershell
(Get-FileHash "$PD\node_modules\dsh-zoo\scripts\win32-sendinput.ps1" -Algorithm SHA256).Hash
# 期望 6DEECEB9090E10881A9846A75E23009AE41AC9FF8D2026AC1FE58DF1615D2FE9
```

产物：

```text
dsh-zoo-0.4.3.tgz
size   304,904 bytes
files  55（desktop 14）
sha256 fe8166c7c5198983a947befb0534411484b437c7f754c3879dbd70fc4a07658f
```

## 1. 安装

沿用 0.4.2 那套（`--dir $PD add <tgz> --save-exact`），期望：无 `ERR_PNPM_*`、
55 个文件、`desktop/` 14 个、`cordis.patch.yml` 在、`package.json` 是 `0.4.3`，然后重启 DSH。

**判定**：宠物回到桌面；`/dsh-zoo/desktop` 的返回里能看见 `dshPet` 字段（老包没有）。

## 2. 票 30：复跑真实左键（重点是「不再抖」）

```powershell
$env:DSH_ZOO_SMOKE_ONLY = "helper"
node scripts/desktop-smoke.mjs
```

跑 SendInput 那两秒别碰键鼠（会真的移动光标、按下、拖 90px、松开）。

这轮多了两条断言，失败时会直接说清是哪一半坏了：

```text
ok  真实光标移动脚本正常退出（{"code":0,"timedOut":false}）
ok  真实拖拽脚本正常退出（{"code":0,"timedOut":false}）
```

- `code:2` = `SendInput` 被系统吞了（锁屏 / UAC 安全桌面 / 被拦），不是产品问题；
- `timedOut:true` = 脚本卡住，`scripts/win32-sendinput.ps1` 自身没能退出。

**判定**：`通过（N 项断言）`，且 **连跑两次都通过**。上一轮「拖拽结束交还穿透」那种
一次过、一次超时的情况，这轮不该再出现；如果还出现，把两次的完整日志一起带回来。

## 3. 票 31-a：让 `dualLayer` 真的变成 `null`（单机可做）

上一轮停 dsh-pet 的 helper 没用——它的宿主 300ms 就拉起来。要造 null 态，得让
`/dsh-pet-7340/state` 真的够不着：

1. 停用 `dsh-pet` 插件（DSH 的插件配置里把它去掉/注释掉，不是关它的窗口），重启 DSH。
2. 刷新 `/dsh-zoo/desktop`，期望：

   ```json
   "dualLayer": null,
   "dualLayerNoted": false,
   "dshPet": { "reachable": false, "reason": "unreachable", "name": null }
   ```

   `reason` 会告诉你差在哪：`not-installed`（连配置都没了）、`unreachable`（配置在、路由不通）、
   `starting`（还没拿到 DSH 的 origin）、`no-pet`（路由通了但 dsh-pet 里没有宠物）。
   `dualLayerNoted` 是「**这个进程里**提示打印过没有」：null 态没有可提示的对象，所以是
   `false`；重启后第一次真的两个都在画时才会变 `true`（第 4 节）。旧稿这里写成 `true`
   是清单笔误——`name` 同理，够不着时不能拿配置里的残留名字冒充「它在画谁」。
3. 把 `dsh-pet` 插件装回去、重启，`dualLayer` 应立刻回到对象态，`dshPet.reachable` 变 `true`、
   `name` 是 dsh-pet 那边那只的名字。

**判定**：三层状态（两个都在画 / 只有一个在画 / 都不画）与 `dualLayer` 一致，且每次都能从
`dshPet` 看出原因。

## 4. 票 31-b：「只提示一次」不用再翻日志

`dualLayerNoted` 就是那个一次性 guard 的出口：

1. 两个都在画时刷新 `/dsh-zoo/desktop`，`dualLayerNoted` 应为 `true`；
2. 连刷十几次它不变，日志里那行 `dsh-pet 也在画桌面宠物…` 也**只有一行**；
3. 重启 DSH 后它先回到 `false`，等到第一次提示再变 `true`。

**判定**：`dualLayerNoted` 与「日志里那行出现几次」一致（一次）。

## 5. 回归清单：这轮只需要人眼两件事

上一轮第 7 节那五条，四条已经有脚本覆盖（对照表在
[`verify-0.4.2-windows-result.md`](verify-0.4.2-windows-result.md) 第 5 节），所以这轮只留：

- [ ] 真机手感：拖得动、松手能甩出去、落地不穿出屏幕底部（冒烟只用合成事件验过物理）
- [ ] 右键「打开软件」在**真浏览器**里停在已登录的 DSH（脚本只能证明交出去的地址带 token）

## 6. 失败时带回什么

1. `/dsh-zoo/desktop` 的完整 JSON（含 `dualLayer` / `dualLayerNoted` / `dshPet`）。
2. 冒烟从 `失败：` 起 30 行 + 末尾的辅助日志目录。
3. 若是真实左键失败：先在宠物命中区手动拖一次，记下 `trustedInputs` / `busy` / `ignoring`
   三个数（见 README「宠物看得见但拖不动」）。
4. `scripts/win32-sendinput.ps1` 的文件哈希（判断是不是包里的那一版）。

## 7. 判定汇总

| 项 | 通过标准 |
| --- | --- |
| 安装 | 55 文件、0.4.3、`dshPet` 字段在、无 EPERM |
| 票 30 | 冒烟含两条「脚本正常退出」全过，**连跑两次都过** |
| 票 31 | `dualLayer` 三层状态都对；`dualLayerNoted` 与日志行数一致 |
| 回归 | 上面两件人眼过 |
