# dsh-zoo 1.0.2 · Windows 验证清单

验证日期：2026-11-06
验证包：`dsh-zoo-1.0.2.tgz`（309 KB，58 files）
SHA-256：`6e5405ec9cca333cd80ba90c846707c4d709bc4f33f768da615affce90eb3326`
代码基线：`v1.0.1`（`6325f72`）+ 未提交的输入法修复
说明：这是**验证清单**；结果见 [verify-1.0.2-windows-result.md](verify-1.0.2-windows-result.md)。

---

## 0. 先确认（这一节不过，后面的结果没有意义）

- [ ] 包能装进 `desktop` profile，DSH 能正常启动
- [ ] `package.json` 里 `dsh-zoo` 的版本是 `1.0.2`
- [ ] `/dsh-zoo/state` 返回 200；`/local-pet/state` 返回 404（改名后的路由）
- [ ] helper 是新代码：路径以 `node_modules\dsh-zoo\desktop\main.js` 结尾，参数是 `--dsh-zoo-*`
- [ ] 数据目录是 `%USERPROFILE%\.dsh\dsh-zoo`；身份/邻居/记录/皮肤与升级前一致

### 安装记录

```powershell
# 1) 备份
Copy-Item "$env:USERPROFILE\.dsh\local-pet" "$env:USERPROFILE\.dsh\local-pet.bak-20261106" -Recurse

# 2) profile 的 package.json：
#    dependencies 里加 "dsh-zoo": "file:C:\\path\\to\\dsh-zoo-1.0.2.tgz"
#    去掉 "dsh-local-pet"
#    dsh.profile.bundles 里去掉 dsh-local-pet，加上 dsh-zoo
# 3) 在 profile 目录执行
pnpm install
# 4) 重启 DSH
```

确认：

```powershell
$port = <DSH端口>
(Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-zoo\package.json" | ConvertFrom-Json).version
curl.exe -s "http://127.0.0.1:$port/dsh-zoo/state" | Select-Object -First 1
curl.exe -s "http://127.0.0.1:$port/dsh-zoo/desktop"
```

`/dsh-zoo/desktop` 里重点看：`status.helperPath`、`menuSkins`、`menuActiveSkin`、`helperStatus.media.failed`、`status.stderr`。

> 如果 `%USERPROFILE%\.dsh\dsh-zoo` 已经存在，ADR-0014 的自动迁移**不会执行**；先决定是迁 `local-pet` 过来还是保留两份。

---

## 1. 输入法（本次修复的重点）

### 1.1 改名小窗打中文

- [ ] 右键宠物 →「改名」，输入框自动获得焦点
- [ ] 切换中文输入法（候选窗出现），打一段中文
- [ ] **小窗不消失**；候选窗可见、可上下选字
- [ ] 回车保存成功；名字在桌面标签、`/dsh-zoo/state`、dsh-pet 配置三处一致
- [ ] 再次改名，按 Esc → 小窗关闭，不改名

记录：如果失败，写清楚是“只有英文/拼音、没有候选窗”还是“小窗消失”，并附 `status.stderr`。

### 1.2 带派字条打中文

- [ ] 右键 →「带派」→ 字条，输入中文（≤500 字）
- [ ] 能选字、能提交；提交后进入背包
- [ ] 选文件时系统对话框弹出/关闭，小窗不会被误关

### 1.3 点小窗外面

- [ ] 改名/带派小窗打开时，点桌面其它地方，小窗**不再自动关闭**（新行为）
- [ ] 用 Esc 或「取消」可以关掉

> 这是为了修输入法做的取舍：macOS/Windows 上输入法候选窗也会触发 `blur`，没法可靠区分“用户点了别处”和“候选窗抢焦点”。如果你认为必须保留点外面关闭，我们再设计一个更保守的判据。

---

## 2. 右键「动作」跟着皮肤走

准备一份 `skin.json`：

```json
{
  "sources": [
    { "id": "dsh-pet", "dirs": ["C:\\Users\\<你>\\.dsh\\profiles\\desktop\\node_modules\\dsh-pet\\assets\\webm"], "size": 462 },
    { "id": "maodie", "dirs": ["C:\\Users\\<你>\\.dsh\\dsh-pet\\pet\\maodie-animation"], "size": 400, "idle": "待机" }
  ]
}
```

- [ ] 右键「外观」切到 `maodie`
- [ ] 右键「动作」：显示**一层「动作」→ 32 个猫动作名**（东张西望、伸爪拍屏幕、喷火、待机…）
- [ ] 点「喷火」：播放猫的喷火，不冒“失败/没生效”提示
- [ ] 切回 `dsh-pet`：恢复 13 个分类（待机/转向/拖拽/点击回应/移动/…/工作状态）
- [ ] 点一个 dsh-pet 动作：走它的 `/anim`，正常播放

`/dsh-zoo/desktop` 应能看到 `menuActiveSkin` 随切换变化；场景菜单里 `actionsLocal` 只在非 `dsh-pet` 皮时为真。

---

## 3. 访客自带皮肤（两台机器）

- [ ] A 切到 `maodie`，去 B 家串门
- [ ] B 桌面上看到的是**猫**，不是 B 本机的鱼
- [ ] A 在串门中途切回 `dsh-pet`，B 的访客在几次心跳内跟着变
- [ ] B 的 `/dsh-zoo/desktop` 里 `helperStatus.media.failed` 没有因为换皮多出旧动作名
- [ ] 访客离开再回来，外观仍正确

如果手边有 0.5.7 的旧邻居：旧端只认 `/local-pet-skin/*`，新服务端仍兼容；新端去旧邻居会先试新路径、404 回落旧路径。这条只在有旧端时验。

---

## 4. dsh-pet 没挂载时的改名（可选）

前提：`%USERPROFILE%\.dsh\dsh-pet\main-config.jsonc` 存在，但 profile 的 `dsh.profile.bundles` 里**没有** `dsh-pet`。

- [ ] `/dsh-pet-7340/config` 返回 404
- [ ] 改名仍然成功：直接改写 `main-config.jsonc`，只动目标那只的 `name`
- [ ] 其它顶层字段/宠物字段不变；JSONC 注释会丢（已知代价）
- [ ] 如果文件被别的程序锁住：返回 `dsh-pet-write-failed`，文件**不能**被写半截，同目录不能留 `.tmp`
- [ ] 5xx/超时/连不上时**不**直写文件（仍报 `dsh-pet-unreachable`）

Windows 重点：`writePetNameFile` 用“临时文件 + rename”。如果 `rename` 覆盖已有文件时报 `EPERM`（杀毒/编辑器占用），要记录日志和是否有 `.tmp` 残留；仓库里有一份相关记录：`.scratch/dsh-zoo/notes/upstream-rename-overwrite-eperm.md`。

---

## 5. Windows 特有的兼容性

- [ ] `skin.json` / `dirs` 用 Windows 绝对路径（`C:\...`）时能扫描到动作
- [ ] 素材路径含中文/空格时，`manifest` 和 `asset` 都能取
- [ ] 换皮后同名动作（鱼和猫都有「东张西望」）播的是**当前皮**的文件（本机素材协议已改 `no-store`）
- [ ] 视频能正常播放/循环；`media.failed` 为空
- [ ] 数据目录迁移：`local-pet` → `dsh-zoo` 成功；如果被占用而 rename 失败，应继续用旧目录并打一行警告，不能丢身份
- [ ] `app.focus({ steal: true })` 是 macOS-only，Windows 不执行；确认 Windows 输入法不依赖它
- [ ] 旧 helper/旧 profile 不会被同时加载（`dsh-local-pet` 已从依赖和 bundles 移除）

---

## 6. 已知取舍（不是 bug，别当失败）

1. 点小窗外面不再自动关闭；用 Esc / 取消。
2. 右键点皮里的动作**只在本机播**；邻居看不到你手点的这一下。
3. `skin.json` 的 `once` 动作目前最多播 8 秒再回待机，“播完立刻回待机”还没做。
4. 如果改的是**同一个 skin id 的目录内容**（不是换 id），viewer 的 manifest 缓存最长 10 分钟才更新；换 id 不受影响。
5. 验证包不含 `test/`（`files` 白名单），`npm test` 要在仓库 checkout 里跑，不能在解压后的包里跑。
6. 这是 1.0.2 的预发布包；`package.json` 已改 1.0.2，但还没提交/tag。

---

## 7. 结果记录

| # | 项目 | 结果（通过/失败） | 证据/备注 |
|---|---|---|---|
| 0 | 安装、版本、路由、helper |  |  |
| 1.1 | 改名中文输入 |  |  |
| 1.2 | 带派中文便条 |  |  |
| 1.3 | 点外面不关窗 |  |  |
| 2 | 右键动作跟皮肤 |  |  |
| 3 | 访客自带皮肤 |  |  |
| 4 | 未挂载 dsh-pet 的改名 |  |  |
| 5 | Windows 路径/缓存/迁移 |  |  |

失败时请附：

- Windows 版本、DSH 版本、Electron 版本
- `/dsh-zoo/desktop` 的 `status.stderr`、`helperStatus.media.failed`
- 改名失败时的 `main-config.jsonc` 备份（去掉敏感字段）和同目录 `*.tmp` 列表
- 如果是输入法：说明“只有英文/有拼音没候选/小窗消失”，以及是否点过小窗外面

验证通过后：提交当前工作区、打 `v1.0.2` tag，重新 `npm pack` 生成正式包（内容应与这个验证包一致）。
