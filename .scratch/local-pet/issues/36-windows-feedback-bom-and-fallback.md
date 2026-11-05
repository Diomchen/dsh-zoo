# 36: Windows 反馈的两条：BOM 与回落后的 activeSource

**What to build:** 本机那几个可手改的 JSON 文件，带 UTF-8 BOM 也要读得出来；当前那张皮被删掉
回落之后，`settings.json` 的 `activeSource` 跟着改写，不留两处真相。

**Blocked by:** 32、34

**Status:** done

来由：2026-11-05 的 0.5.4 Windows 验收（原始材料见
[`verify-0.5.4-windows.md`](../notes/verify-0.5.4-windows.md)，回执在
[`verify-0.5.4-windows-result.md`](../notes/verify-0.5.4-windows-result.md)）。

1. **BOM**：用 `PowerShell Set-Content -Encoding utf8` 写 `skin.json`，文件带 UTF-8 BOM，
   `JSON.parse` 直接失败 → 被当成坏文件 → 静默回落自动源。用户看到的是"第二张皮没了"，
   `maodie-pet/manifest` 404，日志里只有一条 `bad-skin-file`。同一类问题在
   `identity.json` 上更严重：解析失败会当场生成新 `deviceId`，邻居把你当新机器。
2. **回落不同步**：删掉正在用的那条源再 `reload`，`state.skin` 回落成 `dsh-pet`，但
   `settings.json.activeSource` 还写着被删掉的那个 id。

- [x] 新增 `src/json-text.js`：`stripBom` / `parseJsonText`
- [x] 七处本机 JSON 读入口都改成先剥 BOM：`skin.json`、`settings.json`、`identity.json`、
      `peers.json`、`visits.json`、`backpack.json`、`dsh-pet` 的两个 `.jsonc`
- [x] 回落后把 `activeSource` 改写成本机真正在用的那张（`loadSkin()` 里，仅当配置指着的
      源不存在时）
- [x] `/local-pet/desktop` 增加 `menuSkins` / `menuActiveSkin` 两个诊断字段：菜单只有开着
      才在 helper 那边上报，验收时没法远程核对（Windows 那轮就卡在这里）
- [x] 单测：`skin.json` BOM、`identity.json` BOM（deviceId 不能被换掉）、`settings.json` BOM、
      回落改写、菜单诊断
- [x] 全量测试全绿（512 项）

> 不做：把 BOM 写回去（我们自己写文件永远不带 BOM，只负责读得懂别人的）；
> 给 `gifts/` 里机器自己写的 `meta.json` 也加（那些不经过人手）。

> 验收：用带 BOM 的 `skin.json` 重启，两张皮都在；删掉正在用的源再重载，
> `settings.json.activeSource` 变成剩下那张的 id。
