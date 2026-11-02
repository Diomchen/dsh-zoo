# 14: 本机素材源注册表

**What to build:** 把 `src/pet-assets.js` 从「找 dsh-pet 的素材目录」深化成「本机素材源注册表」：可以有多个源，每个源有 id、目录、基准尺寸和动作清单；dsh-pet 自动成为其中一个源。

**Blocked by:** 无

**Status:** todo

- [ ] `<dataDir>/skin.json` 可以列多个源；文件不存在时自动把 dsh-pet 的素材目录注册成 `dsh-pet` 源
- [ ] 每个源生成 manifest：动作 id = 文件名去掉 `.webm`；`idle` 优先取 `待机呼吸休闲`，没有就用第一段
- [ ] manifest 校验：至少一个动作、只允许安全文件名、`size` 在合理范围
- [ ] 目录不存在 / manifest 解析失败只告警一次，不影响现有发现与串门
- [ ] 现有 `resolveDshPetAssetDirs` 的行为作为 `dsh-pet` 源的实现保留，现有测试全绿

> 提示：这一张只做「读」，不做 HTTP、不改协议。源是数据，不是常量；profile 名和安装路径都不能硬编码。
