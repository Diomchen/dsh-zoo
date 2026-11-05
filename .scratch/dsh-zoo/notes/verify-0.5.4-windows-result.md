# dsh-zoo 0.5.4 · Windows 验收结果

回执日期 2026-11-05（Asia/Shanghai）。测试需求见 [`verify-0.5.4-windows.md`](verify-0.5.4-windows.md)，
原始材料是一份 zip（验收报告 + 两套 JSON 快照 + 截图 + BOM 补丁），结论抄在这里。

测试机：DSH host PID `33500`，网页端口 `58272`；0.4.3 → 0.5.4 安装 **2.591s**，无 `ERR_PNPM_*`，
55 files / desktop 14 / `cordis.patch.yml` 在。素材是用官方仓库的 `maodie-animation`
平铺到 `~/.dsh/dsh-pet/pet/maodie-animation`（32 段），没有另装 `maodie-pet` 插件。

## 判定汇总

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 装的是 0.5.4，`state` 有 `skin` | **通过** | `skin: {id:"dsh-pet",size:462}` |
| 2 | 两条源、`maodie-pet/manifest` 200 | **通过（去掉 BOM 后）** | 初始 404，剥 BOM 后 200 |
| 3 | 右键「外观」列两个 id | **当时无法远程验证** | 已加 `menuSkins` / `menuActiveSkin`（票 36） |
| 4 | 切猫：`skin.id`、`media.failed=[]`、猫独有 clip | **通过** | `skin=maodie-pet`、`clip=蹭头撒娇`、`failed=[]` |
| 5 | 切回鱼 | **通过** | `skin=dsh-pet`、`clip=大口吃零食`、`failed=[]` |
| 6 | 693 / 231 / 693 尺寸 | **部分通过** | 命中矩形 81→122（1.506×），0.5× 只验了配置层 |
| 7 | 加第三条源 → 重载 → 出现/消失/回落 | **通过** | 404→200→404，回落 `dsh-pet`，host PID 未变 |
| 8 | 换皮不动 identity / visits / peers / 配置 | **通过** | 五个文件 size 与 mtime 全未变 |
| 9 | 回归：拖拽投掷 / 打开软件 | **部分** | 真实左键拖拽通过；「打开软件」未在真浏览器验证 |

0.5.4 的 Windows 绝对路径修复**没有复现问题**：切到猫之后 `media.failed` 是空的，
猫独有动作（`蹭头撒娇`）能播——这正是 0.5.4 要证的那条。

## 发现 1：`skin.json` 带 BOM 会被静默丢弃（已修，票 36）

`PowerShell Set-Content -Encoding utf8`（PS 5.1）写出来带 UTF-8 BOM，`JSON.parse` 不认，
`parseSkinFile()` 返回 null → 回落自动源。症状：`state.skin` 只有 `dsh-pet`、
`maodie-pet/manifest` 404、日志一条 `bad-skin-file`。

对方给了 15 行补丁（在 `parseSkinFile` 里 `text.charCodeAt(0) === 0xFEFF` 就 `slice(1)`），
方向对，但只修了一个文件。同样的写法在 `identity.json` 上后果更重——解析失败会当场生成
新 `deviceId`。所以 0.5.5 把它做成一个模块（`src/json-text.js`），七个本机 JSON 读入口
统一先剥 BOM；机器自己写的 `gifts/*/meta.json` 不在此列。

## 发现 2：回落之后 `settings.json` 没跟着改（已修，票 36）

删掉正在用的那条源再 `reload`：`state.skin` 回落成 `dsh-pet`，但 `settings.json.activeSource`
还停在被删掉的 id。两处真相，下次启动还会先告警再回落一遍。

0.5.5 起回落时把 `activeSource` 改写成真正在用的那张。代价是"把源加回来不会自动切回去"——
要换回来得自己点一次，这是"设置即真相"的必然代价。

## 还没验的

- **右键「外观」的肉眼外观**：当时只有数据层证据。0.5.5 起 `/dsh-zoo/desktop` 会带
  `menuSkins` / `menuActiveSkin`，但菜单本身的排版仍要人眼一下。
- **0.5× 的肉眼大小**：命中矩形在 693 时是 122×149，462 时 81×99；231 只验到
  `state.skin.size=231`，没量渲染尺寸。
- **右键「打开软件」**：要在真浏览器里确认停在已登录的 DSH。
