# dsh-zoo 0.5.5 · Windows 验收结果

回执日期 2026-11-05（Asia/Shanghai）。测试机 DSH host `30856`、网页端口 `60756`；
0.5.4 → 0.5.5 安装 **2.516s**，无 `ERR_PNPM_*`，**56 files** / desktop 14。

文件数从 55 变 56 是因为新增了 `src/json-text.js`，不是缺文件——这一条在回执里特意点了，
值得记下来：以后包内文件数变化先看 `git diff --stat`，别直接当异常。

## 判定汇总

| 项 | 结果 | 说明 |
|---|---|---|
| 安装 | **通过** | 56 files、0.5.5、desktop 14、无 EPERM |
| BOM 兼容（票 36） | **通过** | 带 BOM 的 `skin.json` 加 BOM 后 reload，`maodie-pet/manifest` 仍 200 |
| `activeSource` 回落（票 36） | **通过** | 删掉 demo-skin 后 `settings.activeSource` 改写成 `dsh-pet` |
| 菜单诊断字段 | **通过（数据层）** | `menuSkins` / `menuActiveSkin` 跟随切换 |
| 0.5.4 回归 | **通过** | 猫/鱼切换、`failed=[]`、五项身份文件 size 与 mtime 未变、真实拖拽通过 |

结论：**两条修复都通过，本轮没有再发现需要补丁的代码问题。**

## 仍未验（都是人眼项，不是缺陷）

1. 右键「外观」的实际排版与点击手感（数据层已由 `menuSkins` 证明）。
2. `size: 231`（0.5×）的肉眼大小——命中矩形只在 693/462 上量过（122×149 / 81×99，1.506×）。
3. 右键「打开软件」是否停在已登录的 DSH。

这三条不影响功能正确性，留到下次有人坐在那台 Windows 前时顺手看。
