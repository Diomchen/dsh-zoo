# dsh-zoo 0.5.7 · Windows 回验（4 条）

0.5.6 那轮六项全过（[回执](verify-0.5.6-windows-result.md)），这轮只修扫描入口的三个漏洞
（票 38），所以只回验**行为变化的那几处**，不用重跑整套。

```text
dsh-zoo-0.5.7.tgz
size   317,615 bytes
files  57（与 0.5.6 同，只改了 src/service.js 与 src/skin-sources.js）
sha256 77a3081c39f0dfc208280782048402d7878c130a2e6da6c7af75eedb33974641
```

## 1. 手动删一条，不重载，直接扫

1. `skin.json` 里有 `dsh-pet` + `maodie`；
2. 手动把 `maodie` 那条删掉，**不要**按「重载配置」；
3. 点「扫描外观」。

期望：`added: ["maodie"]`，猫回来了。

> 旧版这里会回「没有发现新的素材包」——因为它拿进程启动时的缓存判重。

## 2. 写坏文件，再扫

1. 把 `skin.json` 改成 `{ 这不是 json`；
2. 点「扫描外观」。

期望：`409`、`error: "skin-file-broken"`、文件 **SHA-256 不变**、内容仍是那段坏 JSON。

> 旧版：如果缓存里素材包都"已知"，会回 200「没有发现新的素材包」，把坏文件伪装成成功。

## 3. 干净机器：别把鱼弄丢（这轮新修）

最好在一台**没有 `skin.json`** 的机器上做（或者先把它删掉、重启 DSH）：

1. 确认只有自动源：`/dsh-zoo/state` 的 `skin.id` 是 `dsh-pet`；
2. 点「扫描外观」。

期望：

- `added: ["maodie"]`；
- `skin.json` 里是 **两条**：`dsh-pet` + `maodie`；
- `state.skin.id` 仍然是 **`dsh-pet`**——扫描只加，不换当前皮。

> 旧版：文件里只会写 `maodie` 一条，鱼从「外观」里消失，而且当前皮变成猫。

## 4. 幂等仍然成立

连点五次，每次都应是：

```json
{"ok":true,"added":[],"found":1,"notice":"没有发现新的素材包。"}
```

`skin.json` 的 SHA-256 前后一致。

## 失败时带回

```powershell
$P = 61849
curl.exe -s "http://127.0.0.1:$P/dsh-zoo/state"
Get-Content "$env:USERPROFILE\.dsh\dsh-zoo\skin.json" -Raw
```

外加终端里 `素材包扫描：` 与 `[dsh-zoo]` 开头的行。

## 回填

| # | 检查项 | 结果 |
| --- | --- | --- |
| 1 | 手删未重载，扫描能补回 | ☐ 通过 ☐ 失败 |
| 2 | 坏文件 409 且不被覆盖 | ☐ 通过 ☐ 失败 |
| 3 | 干净机器保住自动源、不换当前皮 | ☐ 通过 ☐ 失败 |
| 4 | 连点五次幂等 | ☐ 通过 ☐ 失败 |
