# dsh-zoo 0.5.4 · Windows 测试需求

这一轮是「换皮」四张票（32–35）的首次 Windows 验收，外加一个**只在 Windows 才会露头**
的修复（0.5.4）。上一轮的结论见 [`verify-0.4.3-windows-result.md`](verify-0.4.3-windows-result.md)，
0.4.x 那几项已经通过的不必重做，第 7 节只留回归清单。

要做的事很简单：**装一个包、造两张皮、换一次、看一眼**。每节末尾的「判定」就是回填表
（第 10 节）里的一行，照抄结论即可。

## 0. 这轮改了什么

| 票 | 改动 | 坏了会看到什么 |
| --- | --- | --- |
| 32 | 换皮：`POST /dsh-zoo/action {action:"use-skin", skinId}` + 右键「外观」 | 菜单里没有「外观」，或点了没反应 |
| 33 | 素材目录随皮走；菜单显示**源 id**（插件名），不再显示自己编的名字 | 宿主切了、画面还是原来那只 |
| 34 | 「重载配置」重读 `skin.json`，不用退出 DSH | 加了一条源，重载后菜单里没有它 |
| 35 | 皮自带尺寸：`size / 462` 为比例，缺省 1.0 | 换了尺寸不同的皮，宠物还是一样大 |
| 0.5.4 | 场景里的素材根目录认 Windows 绝对路径（`C:\…`） | **只在 Windows**：换皮后猫的动作全部加载失败，只有两边同名的动作能播 |

0.5.4 那条务必留意：它是 33 的 Windows 版漏洞——`C:\pets\…` 被当成"不是绝对路径"丢掉，
于是宿主发下去的新目录 helper 一个都不认，症状与"根本没切"一模一样。

产物：

```text
dsh-zoo-0.5.4.tgz
size   311,453 bytes
files  55（desktop 14）
sha256 7036b2a41769c80404df9f43923e0eec4182f3a658bf79015912f10aadc72e07
```

## 1. 安装

沿用 0.4.2 那套：

```powershell
$PD = "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm --dir $PD add .\dsh-zoo-0.5.4.tgz --save-exact
```

期望：无 `ERR_PNPM_*`、55 个文件、`desktop/` 14 个、`cordis.patch.yml` 在，然后重启 DSH。

装完先确认版本，再确认新出口在：

```powershell
(Get-Content "$PD\node_modules\dsh-zoo\package.json" | ConvertFrom-Json).version
# 期望 0.5.4

$P = 60108   # 换成你这次 DSH 的端口：浏览器地址栏 127.0.0.1 后面那个
curl.exe -s "http://127.0.0.1:$P/dsh-zoo/state" | Select-String "skin"
```

**判定**：`state` 里有 `"skin"` 字段（0.4.x 没有）。没有这个字段 = 装的还是旧包。

## 2. 造两张皮

Windows 的 `skin.json` 在 `%USERPROFILE%\.dsh\dsh-zoo\skin.json`。**JSON 里的反斜杠要写两个**，
这是本节唯一容易错的地方。

先确认素材在：

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-pet\assets\webm"
Test-Path "$env:USERPROFILE\.dsh\dsh-pet\pet\maodie-animation"
```

两条都应是 `True`（第二条需要装过 `maodie-pet`）。然后原样存这份：

```json
{
  "sources": [
    {
      "id": "dsh-pet",
      "dirs": ["C:\\Users\\<你>\\.dsh\\profiles\\desktop\\node_modules\\dsh-pet\\assets\\webm"],
      "size": 462
    },
    {
      "id": "maodie-pet",
      "dirs": ["C:\\Users\\<你>\\.dsh\\dsh-pet\\pet\\maodie-animation"],
      "size": 693,
      "idle": "待机"
    }
  ]
}
```

把 `<你>` 换成实际用户名。**这一轮第一次要重启 DSH**（注册表在启动时读；之后改它才用
「重载配置」）。

**判定**：重启后 `state` 里 `"skin":{"id":"dsh-pet",…}`；再确认第二张皮已经对外：

```powershell
$DSHPID = (Get-Process 'DeepSeek Harness' | Select-Object -First 1).Id
# 素材端口绑 0.0.0.0（DSH 自己的网页端口只绑 127.0.0.1），通常是 45873；
# 被占用会往后挪，所以这里现查。
$SKINPORT = (Get-NetTCPConnection -State Listen |
  Where-Object { $_.OwningProcess -eq $DSHPID -and $_.LocalAddress -eq '0.0.0.0' }).LocalPort
curl.exe -s -o NUL -w "%{http_code}`n" "http://127.0.0.1:$SKINPORT/dsh-zoo-skin/maodie-pet/manifest"
# 期望 200
```

## 3. 换皮（票 32 + 33，本轮核心）

1. 右键自己的宠物 → 菜单最下面应有 **「外观」**（在「动作」下面）。
2. 展开应是 **`dsh-pet` / `maodie-pet`**——是插件名，不是「小蓝毛 / 橘猫」。当前那张带 `✓`。
3. 点 `maodie-pet`，1–2 秒内画面应变成猫。

**判定（三条都要看）**：

```powershell
curl.exe -s "http://127.0.0.1:$P/dsh-zoo/state"       # skin.id 应为 maodie-pet
curl.exe -s "http://127.0.0.1:$P/dsh-zoo/desktop"     # media.failed 应为 []
```

第三条是**看 clip 名字**：必须是猫独有的动作才算真的换了。

- 猫独有：`哈气` / `踩奶` / `钻进纸箱` / `蹭头撒娇`
- 鱼独有：`中秋赏月吃月饼` / `吃白饭` / `玩水枪`
- **`东张西望` 两边都有，不能当证据**（0.5.1 那个 bug 就是靠同名文件骗过去的）

再点回 `dsh-pet`，clip 应变成鱼独有的名字，`media.failed` 仍为空。

**如果 `media.failed` 里出现一串猫的动作名** → 就是 0.5.4 那个问题没修好，直接把整个
`/dsh-zoo/desktop` 的 JSON 带回来。

## 4. 尺寸（票 35）

`size` 是比例，`462` = 1.0，允许 0.5–2 倍。上面已经给猫配了 `693`（1.5×）。

1. 切到猫：应明显比鱼大一圈（约 1.5 倍），**位置不跳**、名字标签不被裁。
2. 把 `693` 改成 `231`（0.5×）→ 右键「重载配置」→ 切到猫：应明显变小。
3. 改回 `693` → 重载 → 再切一次，大小回到 1.5×。

**判定**：三次大小变化肉眼可辨。注意两种动作的性质不同：

- 从「外观」**换皮**：位置不动，就地换大小（这是票 35 的要求）。
- 按「重载配置」：会重启 helper（0.4 起的老行为），宠物回到出生点——这不算失败。

## 5. 热重载（票 34）

1. 复制一份猫目录，加第三条源，**保存**：

   ```powershell
   Copy-Item "$env:USERPROFILE\.dsh\dsh-pet\pet\maodie-animation" "$env:TEMP\demo-skin" -Recurse
   ```

   然后在 `skin.json` 里追加一条（`id` 叫 `demo-skin`，`dirs` 指向上面的 `%TEMP%\demo-skin`，
   `size` 462，`idle` 待机）。
2. 先确认它还不存在：`…/dsh-zoo-skin/demo-skin/manifest` → 404。
3. 右键「重载配置」。再查 → **200**，且「外观」里多出 `demo-skin`，能切过去。
4. 把第三条从 `skin.json` 删掉 → 重载 → 404、「外观」里也没了。
5. 如果删的正好是**当前正在用**的那张：重载后应自动回落到第一条（`dsh-pet`），桌面上仍有宠物，
   不会白屏或空桌面。

**判定**：全程不退出 DSH（任务管理器里 DSH 的 PID 不变）；第 5 步回落且不空桌面。

## 6. 身份与历史不动（ADR-0013 的硬约束）

换皮**只**该改 `settings.json` 的 `activeSource` 一行。

1. 切到猫之前，记下这几个文件的大小与修改时间：
   `identity.json`、`visits.json`、`backpack.json`、`peers.json`、
   `%USERPROFILE%\.dsh\dsh-pet\main-config.jsonc`。
2. 切到猫、再切回鱼。
3. 再看一遍：五个文件的**大小与时间都不该变**。`settings.json` 会变（多了 `activeSource`）。

**判定**：五个文件一个字节都没动；名字还是原来那个；串门记录条数不变。

## 7. 回归（只留人眼能看的两件）

- [ ] 拖得动、松手能甩出去、落地不穿出屏幕底部
- [ ] 右键「打开软件」在真浏览器里停在已登录的 DSH

## 8. 已知限制，**不要**当 bug 报

- **访客那边要等一拍**：换皮不主动推给正在串门的那位，他按 `skinId` 缓存，下次取素材才更新。
- **没有文件监听**：改 `skin.json` 必须按「重载配置」，不会自己生效。
- **第一次仍要重启**：建立注册表那一次是启动时读的。
- **尺寸不是真实宽高比**：只按 `size/462` 缩放，素材构图不同不会自动适配。

## 9. 失败时带回什么

```powershell
$P = 60108   # 你的端口
curl.exe -s "http://127.0.0.1:$P/dsh-zoo/state"
curl.exe -s "http://127.0.0.1:$P/dsh-zoo/desktop"
Get-Content "$env:USERPROFILE\.dsh\dsh-zoo\skin.json" -Raw
Get-Content "$env:USERPROFILE\.dsh\dsh-zoo\settings.json" -Raw
```

外加：DSH 启动终端里所有 `[dsh-zoo]` 开头的行、失败那一步的截图、
`package.json` 里 `dsh-zoo` 的版本。

## 10. 回填表

| # | 检查项 | 结果 | 现象 / 证据 |
| --- | --- | --- | --- |
| 1 | 装的是 0.5.4，`state` 有 `skin` | ☐ 通过 ☐ 失败 | |
| 2 | `skin.json` 两条源都解析（无告警）、`maodie-pet/manifest` 200 | ☐ 通过 ☐ 失败 | |
| 3 | 右键有「外观」，列的是 `dsh-pet` / `maodie-pet` | ☐ 通过 ☐ 失败 | |
| 4 | 切到猫：`skin.id` 变、`media.failed` 为空、clip 是猫独有动作 | ☐ 通过 ☐ 失败 | |
| 5 | 切回鱼：同样成立 | ☐ 通过 ☐ 失败 | |
| 6 | 尺寸 693 / 231 / 693 三次肉眼可辨，位置不跳 | ☐ 通过 ☐ 失败 | |
| 7 | 加第三条源 → 重载 → 出现；删掉 → 重载 → 消失并回落 | ☐ 通过 ☐ 失败 | |
| 8 | 换皮不动 identity / visits / backpack / peers / dsh-pet 配置 | ☐ 通过 ☐ 失败 | |
| 9 | 回归：拖拽投掷、右键「打开软件」 | ☐ 通过 ☐ 失败 | |
