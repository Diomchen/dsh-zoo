# helper 的工作目录放在包外

## Status

accepted

## 背景

2026-11-04 Windows 11 现场：装第二个插件触发全树 reconcile，pnpm 判定 `dsh-local-pet` 需要重新导入，
最终 `ERR_PNPM_EPERM`（126 秒），包被删残——51 个文件剩 36 个，`cordis.patch.yml` 和 `desktop/` 下
14 个文件消失，`package.json` 还是旧版本号。`cordis.patch.yml` 是挂载声明，所以下次启动宠物直接
不存在，界面上没有任何错误。

这件事由两个独立缺陷叠成：

1. **pnpm 侧（上游）**：vendored 的 `rename-overwrite@7.0.1` 在 `EPERM` 分支先 `rimraf(目标)` 再忙等重试；
   重试仍失败时旧版本已被删、新版本又被 `commitStagedDir` 的 `cleanStageDir(stage)` 清掉，
   结果新旧都没有。已另写上游报告（`.scratch/local-pet/notes/upstream-rename-overwrite-eperm.md`）。
2. **本仓侧**：helper 以 `cwd: <pkg>/desktop` 启动。Windows 上**删不掉任何进程的当前工作目录**，
   所以这个包装上去就再也换不掉——pnpm 会先删掉包里的文件，再在删 `desktop/` 时失败。
   `rimraf` 走到一半正好对上现场：文件没了，目录还在。

第 2 条是这一条的**前提**。没有进程占着包，pnpm 在那个分支上一次就成功，缺陷 1 不会被走到。

## 决定

helper 的 cwd 固定为 `os.tmpdir()`（`HELPER_CWD`），不落在包内任何位置。helper 的资源一律经 `__dirname`
解析，与 cwd 无关，所以挪出来没有行为变化。

## 考虑过的选项

- **DSH profile 的 cache 目录**：与既有布局一致，但 `cacheRoot` 可能是 `null`，还要写一条回退分支；
  为了"临时文件落在哪"付这个复杂度不值。
- **`homedir()`**：一定存在且稳定，但把 helper 的临时写入倒进用户主目录，脏。
- **不动代码，只等 pnpm 修**：本机不受益；即便上游改成 swap，被占着的包每次升级仍然会走到快失败的那条路，
  只是从"删残"降级成"失败但不破坏"。前提还是在自己手里。

## 后果

- **0.4.1 起新起的** helper 运行期间，包始终可整体替换，这类 EPERM 不再由本插件触发。
  （2026-11-04 现场：helper 存活时 0.4.1 → 0.4.0 → 0.4.1 两次替换各 2.5s 左右，无 EPERM。）
- 已经在跑的旧 helper 不在其列：进程的 cwd 是生下来那一刻定死的，改不了。**首次从 ≤0.4.0 升到
  0.4.1 要先停一次 helper**（`scripts/stop-helper.mjs`，README「升级」）——否则 pnpm 替换包时
  仍会 EPERM，最坏删残。这是这条决定唯一的一次性代价。
- helper 的临时写入落到系统临时目录，不再落在包内——顺带也不会污染包内容。
- 这条约束是行为约束，由 `test/desktop.test.js` 的「helper 的 cwd 在包外」看住：断言 cwd 不在包根之下、
  且真实存在（cwd 不存在时 `spawn` 直接 ENOENT）。
- **不修**缺陷 1：别的进程（别的插件、编辑器、杀软）占着包时，pnpm 依然能把包删残。那需要上游修，
  或者 DSH 安装器在失败时保留 staging 目录——都不在本仓。
