# dsh-local-pet 0.5.6 · Windows 回验（只验一个按钮）

0.5.5 那一轮已经全过了（见 [`verify-0.5.5-windows-result.md`](verify-0.5.5-windows-result.md)），
这轮只加了一个入口：右键「扫描外观」（票 37）。**不用重做换皮/热重载/身份那几条**，
只回验这一个按钮 + 一条 Windows 特有的路径大小写。

产物：

```text
dsh-local-pet-0.5.6.tgz
size   316,734 bytes
files  57（desktop 14；比 0.5.5 多 src/dsh-pet-pets.js）
sha256 074fe825b158cb6b0d8d41c6092caa0de8cf021e957c5c731e23c705ad43956c
```

## 0. 这个按钮是什么

扫 `%USERPROFILE%\.dsh\dsh-pet\pet\` 下的 `<前缀>-config.json` 与 `<前缀>-animation/`，
把 `skin.json` 里还没有的素材**追加**进去。只在你按的时候发生；不点，界面不会自己长东西。

## 1. 安装

沿用 `pnpm --dir $PD add <tgz> --save-exact`，然后**重启 DSH**（宿主半边是新代码）。

**判定**：`node_modules\dsh-local-pet\package.json` 里版本是 `0.5.6`，文件数 57。

## 2. 菜单里有没有这一项

右键自己的宠物，一级菜单从上到下应是：

```text
打开软件（拿得到 DSH 地址时才有）
带派
回到初始位置
重载配置
扫描外观      ← 新的，在「重载配置」下面
动作 › / 外观 ›
```

**判定**：能看到「扫描外观」。看不到 = 宿主还是旧代码（重启了吗）或渲染端没收到新菜单。

## 3. 扫出来能加

先让机器回到"只有一张皮"的状态，任选一种：

- 删掉 `%USERPROFILE%\.dsh\local-pet\skin.json`（自动源只剩 dsh-pet 的鱼）；或
- 把里面 `maodie-pet` 那条删掉。

然后点「扫描外观」。期望冒一句：

```text
加入 1 张外观：maodie。右键「外观」可以切换。
```

`skin.json` 里应多出一条：

```json
{ "id": "maodie", "dirs": ["C:\\Users\\<你>\\.dsh\\dsh-pet\\pet\\maodie-animation"],
  "size": 400, "idle": "待机" }
```

`size` 是 **400**（素材自己 `pets[0].size` 声明的），不是我上一轮手写的 693。

**判定**：`notice` 有「加入 1 张」，`skin.json` 里 id 是 `maodie`，`size` 400。
切过去之后 `media.failed` 仍应是 `[]`。

## 4. 幂等：再点一次

期望：

```json
{ "ok": true, "added": [], "found": 1, "notice": "没有发现新的素材包。" }
```

点五次也该是这个结果，`skin.json` 不许多出东西。

**判定**：`added` 为空，文件里还是那几条。

## 5. Windows 特有的一条：同一个目录换个 id

这条在 macOS 上验过，Windows 的路径大小写规则不同，值得单独确认：

1. 把 `skin.json` 里 `maodie` 那条的 `id` 改成 `maodie-pet`（目录**不动**）；
2. 点「扫描外观」。

期望：`added: []`，**不能**多出一条指向同一目录的 `maodie`。

**判定**：没有重复项。如果多了一条，说明目录去重在 Windows 上没生效（大小写/盘符），
把 `skin.json` 与 `/local-pet/desktop` 一起带回来。

## 6. 坏文件不覆盖

1. 把 `skin.json` 改成 `{ 这不是 json`；
2. 点「扫描外观」。

期望：`409`、`error: "skin-file-broken"`、冒一句「skin.json 改坏了，先修好它再扫描。」，
**文件内容一个字不改**。

**判定**：文件没被覆盖（改坏了就是改坏了，工具不替你做决定）。

## 7. 失败时带回什么

```powershell
$P = 60756   # 你的端口
curl.exe -s "http://127.0.0.1:$P/local-pet/desktop"
curl.exe -s "http://127.0.0.1:$P/local-pet/state"
Get-Content "$env:USERPROFILE\.dsh\local-pet\skin.json" -Raw
```

外加：DSH 启动终端里 `[dsh-local-pet]` 与 `素材包扫描：` 开头的行。

## 8. 回填表

| # | 检查项 | 结果 | 现象 |
| --- | --- | --- | --- |
| 1 | 装的是 0.5.6（57 files） | ☐ 通过 ☐ 失败 | |
| 2 | 右键菜单有「扫描外观」 | ☐ 通过 ☐ 失败 | |
| 3 | 扫描加入 `maodie`（size 400） | ☐ 通过 ☐ 失败 | |
| 4 | 再点一次不重复添加 | ☐ 通过 ☐ 失败 | |
| 5 | 同目录换 id 不产生重复项 | ☐ 通过 ☐ 失败 | |
| 6 | 坏 `skin.json` 不被覆盖 | ☐ 通过 ☐ 失败 | |
