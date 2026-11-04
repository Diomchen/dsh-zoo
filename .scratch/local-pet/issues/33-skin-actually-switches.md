# 33: 换皮要真的换画面

**What to build:** 切到另一张皮之后，桌面上真的换成那套素材；「外观」菜单列的是**源 id**
（也就是插件名），不再给皮肤另起显示名。

**Blocked by:** 32

**Status:** done

来由：2026-11-04 现场。票 32 上线后切到 `maodie`，宿主这边 `state.skin` 已经是猫了，
桌面还是鱼：helper 的 `localpet://asset/<动作>.webm` 根目录在**启动时**钉死在 dsh-pet 的包目录
（`resolveDshPetAssetDirs`），猫的 32 个动作里 16 个 404，唯一能播的「东张西望」是因为
鱼那套里也有同名文件。`media.failed` 里躺着一整排猫的动作名，肉眼看着像"没反应"。

第二条：菜单原来显示 `skin.json` 的 `name`（「小蓝毛」「橘猫」）——那是我们了解素材之后
替它编的。换一只没见过的动物，这个名字就没词可用了；而皮真正的身份证是它的源 id，
邻居看到的 `skinId`、缓存键、路由路径用的也都是它。

- [x] 场景带 `assetRoots`（当前那张皮的 `dirs`，绝对路径、≤8），helper 收到就换根
- [x] 旧宿主不带这个字段时 `assetRoots` 是 `null`，helper 沿用启动参数（不能把根清空）
- [x] 宿主在换皮后重发场景：`assetRoots` 进签名，同名动作不同目录也会重发
- [x] `loadSkin()` 挪到桌面层之前：helper 启动时就知道该画谁的素材
- [x] `skin.json` 不再有 `name` 字段；清单里的 `name` 照抄 `id`
- [x] 菜单与 `/local-pet/state` 的 `skin` 都只带 `id`（不再有显示名）
- [x] `settings.json` 里的 `activeSource` 跟着改名（`maodie` → `maodie-pet`）
- [x] 单测 + 全量测试全绿

> 不做：给源起别名（`name` 这个字段整个删掉，要显示名就改 id 本身）；按皮的尺寸缩放（票 32 的遗留）。

> 验收：切到 `maodie-pet` 后 `media.failed` 是空的，桌面上 32 段猫动作都能播；
> 菜单里写的是 `dsh-pet` / `maodie-pet`。
