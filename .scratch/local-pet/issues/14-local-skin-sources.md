# 14: 本机素材源注册表

**What to build:** 把 `src/pet-assets.js` 从「找 dsh-pet 的素材目录」深化成「本机素材源注册表」：可以有多个源，每个源有 id、目录、基准尺寸和动作清单；dsh-pet 自动成为其中一个源。

**Blocked by:** 无

**Status:** done

- [x] `<dataDir>/skin.json` 可以列多个源；文件不存在时自动把 dsh-pet 的素材目录注册成 `dsh-pet` 源
- [x] 每个源生成 manifest：动作 id = 文件名去掉 `.webm`；`idle` 优先取 `待机呼吸休闲`，没有就用第一段
- [x] manifest 校验：至少一个动作、只允许安全文件名、`size` 在合理范围
- [x] 目录不存在 / manifest 解析失败只告警一次，不影响现有发现与串门
- [x] 现有 `resolveDshPetAssetDirs` 的行为作为 `dsh-pet` 源的实现保留，现有测试全绿

> 完成情况：新增 `src/skin-sources.js`（`loadSkinSources` / `parseSkinFile`），不碰 HTTP、不改协议。
> 一个源 = 一组覆盖目录（高优先级目录的同名动作先到先得）+ 基准尺寸 + `actions`（动作 id → `{file, dir}`）。
> `skin.json` 支持 `{sources: [...]}` 或裸数组、`//` 注释、`~` 展开；缺文件/坏文件回落到自动 `dsh-pet` 源，
> 显式空数组表示「不要任何源」。告警按 `code+detail` 去重，坏一个源不影响别的源。
> manifest 里新增 `idle` 字段（动作 id），因为 dsh-pet 的待机动作叫 `待机呼吸休闲`，没有叫 `idle` 的文件；
> `name` 是外观包名，宠物自己的名字仍走 `nickname`。`test/skin-sources.test.js` 11 条；
> 全量 254 条全绿。接线（桌面层改用这个注册表、对外供源）留给 ticket 15。
