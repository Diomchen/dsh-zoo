# dsh-zoo 1.0.2 · Windows 验证结果

回执日期：2026-11-06（Asia/Shanghai）
验证包：`dsh-zoo-1.0.2.tgz`，316,087 B，58 files
SHA-256：`6e5405ec9cca333cd80ba90c846707c4d709bc4f33f768da615affce90eb3326`
验证清单：[verify-1.0.2-windows.md](verify-1.0.2-windows.md)

## 判定

**通过，可以发 1.0.2。** 自动采集的 §0/§5 全过；改名/带派中文输入、点外面不关窗、
右键动作跟皮肤、dsh-pet 未挂载时的改名，用户于 2026-11-06 09:20 确认人为操作均正常。

## 环境

| 项 | 值 |
|---|---|
| Windows | Windows 11 专业版，10.0.26200 |
| DSH | 0.2.1-rc.5 |
| Electron（helper） | 43.3.0 |
| Node（DSH 自带） | 24.21.0 |
| pnpm（DSH 自带） | 11.28.5 |
| profile | `C:\Users\sean\.dsh\profiles\desktop` |

## 安装与迁移

- `pnpm add dsh-zoo-1.0.2.tgz` + `pnpm remove dsh-local-pet`，再改 `dsh.profile.bundles`；
- 宿主 PID 未变，插件热重载换上；旧 helper 退出，新 helper 参数全部是 `--dsh-zoo-*`；
- `local-pet` 数据目录整体 rename 成 `dsh-zoo`；`identity.json`、`peers.json`、
  `skin.json`、`visits.json`、`backpack.json`、`settings.json` 与备份逐字节一致（21/21）；
- `prepareDataDir()` 的四个分支（只有旧目录 / 两个都有 / rename EPERM 回退 / 全新）
  在临时目录验过。

## 硬指标

| 检查 | 结果 |
|---|---|
| `GET /dsh-zoo/state` | 200；`self.nickname=鱼姐`；邻居 2、访客 2 |
| `GET /local-pet/state` | 404 |
| `/dsh-zoo/desktop` | 200；ready、restarts=0、lastError=null、stderr=[] |
| helper | `node_modules\dsh-zoo\desktop\main.js`，`--dsh-zoo-*` |
| 数据目录 | `%USERPROFILE%\.dsh\dsh-zoo`，与备份同哈希 |
| `menuSkins` / `menuActiveSkin` | `["dsh-pet","maodie"]` / `"dsh-pet"` |
| `helperStatus.media.failed` | `[]` |
| 旧路径 | `/local-pet-skin/manifest` 与 `/dsh-zoo-skin/manifest` 同内容；asset 200、Range 206 |
| Windows 路径 | 两个源的 `C:\...` 绝对路径都能扫到；中文素材名可读 |
| 动作清单 | 猫 32 个、鱼 109 个 |
| 视频 | `readyState=4`，`loading → video` 最近 10 次无失败 |
| `app.focus({ steal: true })` | `process.platform !== 'darwin'` 早退，Windows 不执行 |
| 旧包残留 | dependencies / bundles / node_modules 三处都已移除 |

## 人工确认（2026-11-06 09:20）

- 改名小窗：能切中文、候选窗可见、小窗不消失；
- 带派字条：中文输入、选字、提交正常；
- 点小窗外面不再自动关窗，Esc / 取消可关；
- 右键「动作」跟随当前皮肤（`maodie` 32 个猫动作，`dsh-pet` 原分类树）；
- dsh-pet 未挂载（本机 patch 里 `disabled: true`）时改名仍可用。

## 仍未验 / 风险

1. **冷启动**：这次是热重载验证，没有关掉 DSH 再开；发版前建议补一次（启动顺序、迁移日志、
   旧 helper 退出）。
2. **Windows 双机访客自带皮肤**：本机单实例，§3 未在 Windows 双机上跑；该行为由
   `test/visit-e2e.test.js` 的两实例用例和 macOS 现场覆盖。
3. 点外面不关窗、手点动作只在本机播、`once` 最多 8 秒回待机、同 skin id 改内容有
   10 分钟 manifest 缓存——这些是已记录的取舍，不是本次回归。

## 回滚

```powershell
& $node $pnpm --dir $pd remove dsh-zoo
& $node $pnpm --dir $pd add '<dsh-local-pet-0.5.7.tgz 的路径>' --save-exact
# bundles 改回 dsh-local-pet；数据目录把 dsh-zoo 改名回 local-pet（或两套都留）
```
