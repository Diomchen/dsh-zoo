# dsh-local-pet 0.5.7 · Windows 回验结果

回执日期 2026-11-05（Asia/Shanghai）。测试机 DSH host `8108`、网页端口 `63107`；
0.5.6 → 0.5.7 安装 **2.596s**，无 `ERR_PNPM_*`，**57 files** / desktop 14。

## 判定汇总（4/4）

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 手删 `maodie`、不重载，扫描补回 | **通过** | `added:["maodie"]`，`size=400` |
| 2 | 坏 `skin.json` | **通过** | `409 skin-file-broken`，SHA-256 不变 |
| 3 | 干净机器保住自动源、不换当前皮 | **通过** | 删文件 + 重启后扫描，写入 `dsh-pet + maodie`，`state.skin.id` 仍是 `dsh-pet` |
| 4 | 连点五次幂等 | **通过** | 五次 `added:[]`，文件 SHA-256 前后一致 |

第 3 条是这轮唯一**由代码审查之外**发现的漏洞（空白机器会把鱼顶掉），对方用
"删文件 + 重启"真实复现了干净机器，结果与预期一致：写两条、当前皮不动。

## 收尾状态

- `skin.json`：`dsh-pet`（462）+ `maodie`（400）
- `settings.activeSource`：`dsh-pet`
- `menuSkins`：`["dsh-pet","maodie"]`；`menuActiveSkin`：`dsh-pet`
- helper：ready，`media.source=video`、`readyState=4`、`visibility=visible`

## 仍未验（人眼项，不影响功能）

1. 右键「外观」与「扫描外观」的实际排版与点击手感。
2. `size: 231`（0.5×）的肉眼大小——命中矩形在 693/462 上量过（122×149 / 81×99）。
3. 右键「打开软件」是否停在已登录的 DSH。

这三条从 0.5.4 起就一直挂着，都是"要有人坐在那台机器前看一眼"才能关的。
