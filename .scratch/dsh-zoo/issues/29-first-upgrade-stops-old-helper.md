# 29: 首次升级 0.4.1 之前停掉旧 helper

**What to build:** 从 ≤0.4.0 首次升到 0.4.1 时，已经在跑的旧 helper 的 cwd 还落在包里的 `desktop/`，
`pnpm add` 替换这个包仍会 `ERR_PNPM_EPERM`（最坏删残）。给一条能照着做的路：停 helper 的脚本 +
README「升级」小节 + ADR 措辞收紧。

**Blocked by:** —

**Status:** done

来由：2026-11-04 现场。0.4.1 的 cwd 修复（ADR-0012）只对**新起的** helper 成立——进程的 cwd 是
生下来那一刻定死的。现场第一次升级时旧 helper 还在跑，直接 `pnpm add` 复现了历史 EPERM，最后是
先暂停宿主、结束旧 helper 才在 2.687s 内装上。

- [x] `src/helper-processes.js`：从 `Win32_Process` 的 JSON 与 `ps -axo pid=,args=` 的文本里认出 helper
      （判据是宿主拉它时加的 `--dsh-zoo-host-pid`，整词匹配，不误伤 `--dsh-zoo-host-pid-typo`）
- [x] `scripts/stop-helper.mjs`：`--dry-run` 先看停谁；SIGTERM → 2s → SIGKILL；还有活的就非零退出；
      停完提示「宿主还开着会被重新拉起」
- [x] `npm run stop-helper`
- [x] `isMain` 两边都解 realpath：profile 里是符号链接，直接比字符串会让「从链接跑」静默什么都不做
- [x] 单测：Windows 单对象 / 空输出 / 坏 JSON、ps 文本、同一 pid 去重、平台分支（powershell vs ps）、
      `main()` 的 dry-run 不杀、SIGTERM→SIGKILL、停不掉时非零退出
- [x] README「升级」：退出 DSH → 停 helper → 换包 → 开 DSH，并说明「宿主还开着会被立刻重新拉起」
- [x] ADR-0012 后果收紧成「0.4.1 起新起的 helper」，并写明首次升级的一次性代价
- [ ] 现场复验：Windows 上从 0.4.0 直接升级前跑一次，`pnpm add` 不再 EPERM（需要那台机器）

> 完成情况：脚本在本机 macOS 上 dry-run 认出了正在跑的 helper（pid + 命令行）。
> 真停那一步没有在本机对生产 helper 执行——它会由宿主立刻拉起，验不出意义。
