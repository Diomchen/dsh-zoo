# dsh-zoo 0.4.2 · Windows 验收结果（现场跑完的复盘）

- 现场日期：2026-11-04（Asia/Shanghai）
- 机器：Windows 11，DSH host `44880`，Web `49217`
- 被测包：`dsh-zoo-0.4.2.tgz`（55 files / desktop 14 / 0.4.2）
- 原始材料：`dsh-zoo-0.4.2-final-20261104.zip`（验收 md/docx、修复报告、补丁、`pet-042-live-final.json`、桌面截图）
- 存活证据：[`0.4.2-live-endpoint.json`](0.4.2-live-endpoint.json)（当时 `/dsh-zoo/desktop` 的原样返回）、
  [`0.4.2-pet-desktop-windows.png`](0.4.2-pet-desktop-windows.png)（桌面截图：宠物画出来、动作在播）

## 1. 判定

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 安装 | **PASS** | 0.4.1 → 0.4.2，2.7s，exit 0，无 `ERR_PNPM_*`；55 files、`cordis.patch.yml` 在 |
| 票 28 素材诊断 | **PASS** | 连续采样 `source=video`、`readyState=4`、`visibility=visible`；`mediaHistory` 20 条都带这两个字段 |
| 票 30 真实左键 | **PASS** | `trustedInputs 0→1`；拖拽期间 `busy=true` 约 1.1s，松手释放；helper 冒烟 93 项全过 |
| 票 29 stop-helper | **PASS（dry-run）** | 认出 helper 38476；完整首次升级没做（只有一台机器） |
| 票 31 双桌面层 | **部分** | 「两个都在画」确认；`null` 态与「日志只打一次」没采集到 |
| 回归清单 | **未完成** | 现场没人工过第 7 节 |

结论：票 28 / 30 可以关；票 29 只剩一次真机升级；票 31 欠两个可观测点。

## 2. 现场最值钱的一条：票 30 失败在我们自己的测试脚本里

0.4.2 的 Windows 冒烟报 `断言失败：真实左键按下进入拖拽（busy=true）`，一开始像产品缺陷
（「窗口说可交互、真实左键没进来」）。现场排查后是 `scripts/win32-sendinput.ps1` 自己的三处问题：

1. **名字写 SendInput，实际调 `mouse_event`**。这个老垫片在 Electron 透明置顶窗上没有稳定
   进入真实输入队列。
2. **没有 DPI 感知**。调用方按 `DIP × scaleFactor` 传物理像素，PowerShell 默认不是
   per-monitor DPI aware，`SetCursorPos` 的语义与传入值不一致。
3. **按下之前没有刷新 hover 心跳**。`move` 和 `drag` 是两次独立进程调用，drag 进程启动 +
   编译 C# 的时间足以让 hover 过期，窗口在 down 之前就回到点击穿透。修复前用
   `WindowFromPoint` 探测，命中的是底层 Qt 白板窗口——down 根本没落到被测 helper 上。

修好后：目标坐标命中 `Chrome_RenderWidgetHostHWND`，`busy=true` 断言通过，93 项全过。

> 教训：一个只能在一台机器上跑的测试，**它自己**也要有守卫。现在
> [`test/win32-sendinput.test.js`](../../../test/win32-sendinput.test.js) 在 `npm test` 里钉住
> 「真 SendInput / 有 DPI 声明 / 按下前挪过三次光标 / 参数与两个模式没变」，回退会当场变红。

## 3. 第二条：`等待超时：拖拽结束交还穿透` 是断言竞态，不是产品缺陷

打完补丁的第一次全量 helper 冒烟在更早的合成拖拽段失败一次，重跑即通过。根因在断言写法：

- `desktop/main.js` 的 `emitHit()` 只在 `ignoring` **真的翻转**时发一条（`setIgnore()` 看到
  状态没变就直接 `return`）；
- 冒烟却在 `client.mark()` 之后**等一条新的 `hit` 事件**。pointerup 之后主进程可能已经因为
  「光标下没有活矩形」翻成穿透了，此时再挪光标不会有新事件 → 假超时。

修法：`scripts/desktop-smoke.mjs` 的 `expectIgnoring()` 事件优先、状态兜底（状态才是那个事实，
事件只是证据）。同一处理由 `leavePointer()` 早就写在注释里了，只有这一处漏了。

## 4. 票 31 为什么卡住，以及怎么不再卡

- 现场只关掉 dsh-pet 的 helper，`dsh-pet` 宿主 300ms 就把它拉起来（PID 9040 → 35404），
  `dualLayer` 一直是对象，**永远看不到 null**。要得到 null，必须让 `/dsh-pet-7340/state`
  真的 404 / 不可达（停插件、或让路由消失），而不是停 helper。
- 「日志只打一次」采集不到，是因为 DSH host 的 stdout 没有落盘到可读日志；代码里
  `dualLayerNoted` 这个一次性 guard 没有外部可观测的出口。

0.4.3 把这两件事变成出口上的字段，不必再去翻日志：`/dsh-zoo/desktop` 现在带
`dualLayerNoted`（是否提示过）和 `dshPet { reachable, reason, name }`（`dualLayer` 的判据）。
步骤见 [`verify-0.4.3-windows.md`](verify-0.4.3-windows.md) 第 5 节。

## 5. 回归清单：哪些其实已经由冒烟覆盖

现场第 7 节那五条，四条在 `scripts/desktop-smoke.mjs` 里已有断言，只有一条要人眼确认：

| 清单项 | 现在的覆盖 |
| --- | --- |
| 宠物在桌面上、能改名 | 冒烟「改名」段（`ui:btn:rename`、改名小窗 `focusable=false`）+ 票 12/13 单测 |
| 右键菜单四项 | 冒烟菜单段：`打开软件 / 回到初始位置 / 重载配置 / 带派` 逐个断言 |
| 「打开软件」是登录 DSH | [`test/open-site-auth.test.js`](../../../test/open-site-auth.test.js) 用假 DSH 认证走真 HTTP（`?token=` → 303 + 会话，裸 origin → 401） |
| 带派：字条 + 文件各一次 | 冒烟礼物段：字条卡、图片卡、文件卡三张截图 + 打开/扔掉/复制动作 |
| 串门 / 送客双方记录 | 冒烟串门段 + `test/visit-e2e.test.js`、`test/receipt-e2e.test.js` |

剩下必须人眼的只有两条：真机感受（拖动跟手、甩出去落地）和「打开软件」在**真浏览器**里
是否停在登录态（脚本只能证明交出去的地址是对的）。
