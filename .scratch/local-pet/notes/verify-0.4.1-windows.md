# 0.4.1 · Windows 验证清单

产物：`dsh-local-pet-0.4.1.tgz`（286 KB，51 个文件）
sha256：`d1982fd507fa708127427be82b870ffe6f4d2f0358107cc3fa3c43f7d2d56abd`

这个包相对你现场跑的 0.4.0 **只差一处**：`src/desktop.js` 里 helper 的 cwd 从 `<包>/desktop`
换成 `os.tmpdir()`。所以下面任何一条行为差异，都只能归到这一处。

## 0. 装之前

留一份 tgz 在你手边、**并且**留一份现装的 `node_modules\dsh-local-pet` 副本（第 3 步会故意降级，
万一撞上旧缺陷，包会被删残，有副本才好恢复）：

```powershell
$PD = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item -Recurse "$PD\node_modules\dsh-local-pet" "$env:TEMP\dsh-local-pet-backup" -Force
(Get-ChildItem -Recurse -File "$PD\node_modules\dsh-local-pet" | Measure-Object).Count
# 期望 51
```

## 1. 装上 0.4.1

用 DSH 自带的 pnpm（先找到它）：

```powershell
$PNPM = Get-ChildItem -Path "$env:LOCALAPPDATA\Programs","$env:ProgramFiles" -Recurse `
  -Filter pnpm.mjs -ErrorAction SilentlyContinue |
  Where-Object FullName -like '*primary-runtime\dependencies\pnpm\bin\pnpm.mjs' |
  Select-Object -First 1 -ExpandProperty FullName
$PNPM

node $PNPM --dir $PD add C:\path\to\dsh-local-pet-0.4.1.tgz --save-exact
```

**验 1**：无 `ERR_PNPM_EPERM`；`(Get-ChildItem -Recurse -File "$PD\node_modules\dsh-local-pet" | Measure-Object).Count` = 51。

重启 DSH，宠物回到桌面。**验 2**：helper 起得来（日志里有「桌面 helper 已拉起」），桌面上有宠物、
能改名、能与邻居串门——cwd 换到临时目录不该影响任何资源解析（`__dirname` 走的是包内绝对路径）。

## 2. 主验证：helper 活着时替换这个包

这才是现场失败的路径。0.4.0 与 0.4.1 是同一个包 id、内容不同，互相 `add` 就是一次 re-import。

helper 在跑（宠物在桌面上）时，**降级再升回来**：

```powershell
Measure-Command { node $PNPM --dir $PD add C:\path\to\dsh-local-pet-0.4.0.tgz --save-exact }
Measure-Command { node $PNPM --dir $PD add C:\path\to\dsh-local-pet-0.4.1.tgz --save-exact }
```

**验 3**（决定性）：

- 两次都在**秒级**结束。0.4.0 现场是 `real 2m3s` / 126 s。
- 两次都**没有** `ERR_PNPM_EPERM`。
- 每一步之后包都是完整的 51 个文件；特别看 `cordis.patch.yml` 和 `desktop\` 下 14 个文件还在不在：

```powershell
Test-Path "$PD\node_modules\dsh-local-pet\cordis.patch.yml"                      # True
(Get-ChildItem -Recurse -File "$PD\node_modules\dsh-local-pet\desktop").Count    # 14
```

> 若第 3 步失败：说明 cwd 不是唯一的占用源（还有别的东西开着包里的文件），
> 这时请把包副本恢复回去，并把 `Get-Process` 全量清单发我——那就该走"pnpm 侧保 staging"那条了。

## 3. 机制直验（可选，但能一眼分辨新旧版）

Windows 删/改不掉任何进程的当前目录。helper 活着时，**整个包目录**能不能改名，就是这个问题的是非题：

```powershell
Rename-Item "$PD\node_modules\dsh-local-pet" "dsh-local-pet.probe"
Rename-Item "$PD\node_modules\dsh-local-pet.probe" "dsh-local-pet"
```

- **0.4.1**：两条都成功。
- **0.4.0**：第一条报「另一个程序正在使用此文件 / Access denied」，目录名不会变。

改完立刻改名回来，中间那段窗口别超过几秒。若第一条失败但目录已经变成 `dsh-local-pet.probe`，
手动改回来即可。

## 4. 次要观察（不阻塞，但值得记）

- `%TEMP%` 下现在会多出 helper 的工作目录产物（Electron 的日志/缓存兜底）。这是预期，不是泄漏。
- `%TEMP%` 被清理工具清空时，helper 已启动的不受影响；只有 **helper 重启**时才重新取 cwd。
  如果 `%TEMP%` 被指向一个不存在/不可写的路径，`spawn` 会 `ENOENT`——这条我按"一定会存在"赌的，
  真机上如果 `echo $env:TEMP` 指向网络盘或已被删的目录，请告诉我。
- 装第二个插件（`dsh-ops`）再触发一次全树 reconcile：**验 4** 全程无 `ERR_PNPM_EPERM`，
  且 `dsh-local-pet` 文件数仍是 51。

## 5. 回给我的东西

1. 第 2 步两条 `Measure-Command` 的耗时（`TotalSeconds`）。
2. 第 2 步之后 `Test-Path` 与 `desktop` 文件数两条输出。
3. 若出现任何 `ERR_PNPM_*`：`$PD\.plugin-manager\logs\` 下最新那次 `operation-*\pnpm.log` 全文。
4. 第 3 步两条 `Rename-Item` 的成功/报错原文（有就贴，没有就说"都成功"）。
5. 桌面截图一张（宠物在、名字对）。

## 这个包不修什么

别的进程（别的插件、编辑器、杀软）占着包时，pnpm 仍然可能删残——那要上游改
`rename-overwrite`，或者 DSH 安装器在失败时保住 staging 目录。0.4.1 只消掉了**我们自己**
这条触发链；`ERR_PNPM_EPERM` 这类错误本身仍会出现。
