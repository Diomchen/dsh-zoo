# dsh-local-pet 0.4.2 · Windows 测试需求

给现场的验收清单。照着从上往下做，每节末尾有「判定」，最后按第 7 节把材料带回来。

## 0. 这次要验什么

0.4.1 的现场报告里有四条要跟：`media.source` 永远 `loading`、真实左键拖不动、两个桌面层
共存、首次升级仍 EPERM。0.4.2 对应改了四张票：

| 票 | 改了什么 | 对应哪条现场问题 |
| --- | --- | --- |
| 28 | `status.media` 跟着真实状态走，带 `readyState` / `visibility` | live scene「一直 loading」 |
| 29 | `scripts/stop-helper.mjs` + README「升级」 | 首次 0.4.0 → 0.4.1 仍 EPERM |
| 30 | `status.trustedInputs`（真实左键计数）+ Windows 真实 `SendInput` 冒烟 | 宠物可见但拖不动 |
| 31 | `/local-pet/desktop` 的 `dualLayer` 提示 | dsh-pet 与 local-pet 双桌面层 |

产物：

```text
dsh-local-pet-0.4.2.tgz
size   302,027 bytes
files  55
sha256 cb15ac91846647e0a9da08aac3df60e2aaa5753608f353ec97dc98be715a237f
```

包内新增：`src/helper-processes.js`、`src/desktop-advisory.js`、`scripts/stop-helper.mjs`、
`scripts/win32-sendinput.ps1`；`test/` 不进包。

## 1. 装之前

```powershell
$PD = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item -Recurse "$PD\node_modules\dsh-local-pet" "$env:TEMP\dsh-local-pet-backup-041" -Force
(Get-ChildItem -Recurse -File "$env:TEMP\dsh-local-pet-backup-041" | Measure-Object).Count   # 期望 51
```

**如果你这台机器还在跑 ≤0.4.0 的 helper**（`helper cwd` 在包里），先按第 5 节停一次再换包；
从 0.4.1 起可以直接替换。

## 2. 安装与包完整性

```powershell
$PNPM = Get-ChildItem -Path "$env:LOCALAPPDATA\Programs","$env:ProgramFiles" -Recurse `
  -Filter pnpm.mjs -ErrorAction SilentlyContinue |
  Where-Object FullName -like '*primary-runtime\dependencies\pnpm\bin\pnpm.mjs' |
  Select-Object -First 1 -ExpandProperty FullName

node $PNPM --dir $PD add C:\path\to\dsh-local-pet-0.4.2.tgz --save-exact
(Get-ChildItem -Recurse -File "$PD\node_modules\dsh-local-pet" | Measure-Object).Count   # 期望 55
Get-Content "$PD\node_modules\dsh-local-pet\package.json" | Select-String '"version"'    # 0.4.2
Test-Path "$PD\node_modules\dsh-local-pet\cordis.patch.yml"                              # True
(Get-ChildItem -File "$PD\node_modules\dsh-local-pet\desktop" | Measure-Object).Count    # 14
```

**判定**：无 `ERR_PNPM_*`；55 个文件；`desktop/` 仍有 14 个；`cordis.patch.yml` 在。
然后重启 DSH，确认宠物回到桌面。

## 3. 票 28：素材诊断跟得上真实状态

重启后打开（端口换成你 DSH 的实际端口）：

```text
http://127.0.0.1:<DSH 端口>/local-pet/desktop
```

看 `helperStatus.media`：

```json
{
  "clip": "东张西望",
  "source": "video",
  "readyState": 4,
  "visibility": "visible",
  "failed": [],
  "at": 1793764498237
}
```

**判定**：

- `source` 在一两秒内变成 `video` 并稳定住——**不再长期停在 `loading`**（0.4.1 的现场症状）。
- `readyState >= 2`；`visibility` 是 `visible`（桌面没被锁屏/全屏遮挡时）。
- `mediaHistory` 每换一段就多一条，每条都带 `readyState` / `visibility`。
- **如果 `source` 仍是 `loading` 且 `failed` 在涨**：这才是真的素材失败，把 `mediaHistory` 整段带回来。
- **如果 `visibility` 是 `hidden` 但宠物明明可见**：也带回来，那是另一条线索。

## 4. 票 30：真实左键（这条是重点）

### 4.1 自动冒烟（Windows-only 部分必须真跑）

把 tgz 解到一个空目录（`tar` 在 Win10+ 自带）：

```powershell
mkdir C:\temp\lp042
tar -xzf C:\path\to\dsh-local-pet-0.4.2.tgz -C C:\temp\lp042
cd C:\temp\lp042\package

$env:LOCAL_PET_SMOKE_ONLY = "helper"
node scripts/desktop-smoke.mjs
```

**跑 SendInput 那一段时不要碰键盘鼠标**（约 2 秒，它会把光标移到宠物上、按下、拖 90px、
松开）。开始前把锁屏、远程桌面缩放、录屏都关掉。

必须看到这几行（不再有「跳过」）：

```text
ok  合成 pointerdown 不计入可信输入
ok  走真实输入管线的左键计入 trustedInputs（0 → 1）
ok  kick 之后窗口仍然可交互（穿透状态被正确重放）
ok  kick 之后命中矩形还在
ok  Windows：有 self 可以按
ok  真实左键按下进入拖拽（busy=true）
ok  松手后输入租约释放
ok  真实拖拽让宠物真的动了（812 → 902）
```

**判定**：末尾「通过（N 项断言）」且没有失败。N 会比 macOS 上多 4（那几条只在 Windows 跑）。
若失败，把从 `冒烟失败：` 开始到结尾的 30 行连同临时日志目录路径一起带回。

### 4.2 手动复核（真机感受）

1. 正常拖宠物：松手能甩出去、落回地面。
2. 拖到屏幕边缘、拖到别的窗口上方，都应跟手。
3. 拖的同时刷新 `/local-pet/desktop`，`busy` 应为 `true`，松手后 `false`。
4. 每次真实按下，`trustedInputs` 应该 +1（一边点一边刷新看）。

**判定**：全程能拖、能甩；`trustedInputs` 随点击增长。

### 4.3 万一又出现「拖不动」（这就是要抓的现场）

按顺序记四个数（都在 `/local-pet/desktop` 里）：

| 字段 | 含义 | 怎么读 |
| --- | --- | --- |
| `ignoring` | 窗口是否可交互（`false` = 已摘掉穿透） | 应该是 `false` |
| `trustedInputs` | 真实左键到过渲染端几次 | **点一下刷新，不涨 = 点击根本没进来** |
| `lastTrustedInputAgeMs` | 最后一次可信左键多久之前 | 不涨时会一直变大 |
| `busy` | 输入租约（拖着的时候为 `true`） | `trustedInputs` 涨了它不涨 = 渲染端问题 |

然后右键宠物 →「重载配置」重启 helper，再试一次：能恢复就说明还是输入态卡住，
把四个数 + 恢复前后的对比带回来。

## 5. 票 29：首次升级路径

```powershell
cd "$PD\node_modules\dsh-local-pet"     # 或解包目录
node scripts/stop-helper.mjs --dry-run
```

期望：列出正在跑的 helper（`pid` + 命令行），并说明「dry-run：以上 N 个会被停掉」。
认的是 `--local-pet-host-pid`，不会误伤别的 Electron。

**判定**：dry-run 能认出 helper；若列表为空但任务管理器里明明有 `electron.exe` 在跑，
把那几个进程的命令行带回来（说明匹配判据要放宽）。

**只有一台测试机时不要跑真停**（helper 会被宿主立刻拉起）；如果方便，在一台还能装 0.4.0 的
机器上走一遍完整顺序：退出 DSH → `node scripts/stop-helper.mjs` → `pnpm add` 0.4.2 → 开 DSH，
确认**首次升级不再 EPERM**。

## 6. 票 31：双桌面层提示

前提：`dsh-pet` 也在画（你现场就是两个 helper 同时在跑）。

1. 重启 DSH 后看日志，应有一行：
   `dsh-pet 也在画桌面宠物：两个透明层重叠时，看到的那只和拖到的那只可能不是同一只。`
2. `/local-pet/desktop` 应带：

   ```json
   "dualLayer": { "code": "dual-desktop-layer", "note": "…" }
   ```

3. 关掉 dsh-pet 的桌面窗（或让 dsh-pet 不可达）后等几秒再刷新：`dualLayer` 应为 `null`。
4. 日志里那行**只出现一次**（不是每轮轮询一条）。

**判定**：三层状态（两个都在画 / 只有一个在画 / 都不画）与 `dualLayer` 一致，日志不刷屏。

## 7. 回归清单（快速过一遍，别花太久）

- [ ] 宠物在桌面上、能改名（右键 → 改名）
- [ ] 右键菜单：打开软件 / 回到初始位置 / 重载配置 / 动作树
- [ ] 「打开软件」打开的是**已登录**的 DSH（不再停在 401 页）
- [ ] 带派：字条 + 文件各送一次，对方收到礼物卡
- [ ] 串门：手动送出门、送客，双方记录都有

## 8. 失败时带回什么

1. `/local-pet/desktop` 的完整 JSON（把 URL 里的 token/端口打码）。
2. 冒烟失败：`冒烟失败：…` 起 30 行 + 末尾的「辅助日志目录」路径。
3. DSH 日志里与 `local-pet` 相关的行（尤其 `dualLayer` 警告、helper 重启）。
4. 截图：桌面（宠物位置）、`/local-pet/desktop` 页面。
5. 若是「拖不动」：第 4.3 节那四个数，以及「重载配置前后」的对比。

## 9. 判定汇总

| 项 | 通过标准 |
| --- | --- |
| 安装 | 55 文件、0.4.2、无 EPERM、宠物回来 |
| 票 28 | `media.source` 稳定为 `video`，带 `readyState` / `visibility` |
| 票 30 | 冒烟含 SendInput 全通过；手动能拖能甩；`trustedInputs` 随点击增长 |
| 票 29 | `stop-helper --dry-run` 能认出 helper；有机会时验完整首次升级 |
| 票 31 | `dualLayer` 与实际层数一致；日志一行 |
| 回归 | 第 7 节全勾 |

任何一项不通过，按第 8 节带材料回来即可，不用自己定位。
