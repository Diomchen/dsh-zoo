# 12: 名字只有一个——镜像与写路径

**What to build:** 主人和邻居看到的是同一个名字。`identity.nickname` 不再自己说了算，它跟着 dsh-pet 的 `pets[0].name` 走；改名这件事从 dsh-zoo 发起时，走 dsh-pet 的官方配置接口写回去（ADR-0007）。这一票只做链路，不做界面——改名的触发走现有的 `POST /dsh-zoo/action`。

**Blocked by:** 无

**Status:** done

- [x] 镜像：配置轮询（`CONFIG_TTL_MS`）里发现 `pets[0].name` 变了，就更新 `identity.nickname`、落盘 `identity.json`、立刻补发一次 beacon；约 30 秒内（30s 配置 TTL + 1s 轮询）邻居看到新名字
- [x] dsh-pet 缺席或配置读不出：保留最后一次镜像值（从没同步过时仍走主机名 → 「我」）；`name` 为空按 ADR-0007 回落成宠物 `id`——这是与 dsh-pet 自己的规则一致，不是"保留旧值"
- [x] `{"action":"rename","nickname":"…"}`：装了 dsh-pet 就 GET `/config` → 只改**正在桥接的那只**的 `name` → `PUT /config`；成功后才写镜像并广播
- [x] 没装 dsh-pet 的机器上，同一条 action 只写 `identity.json`（今天的语义保留）
- [x] 写入失败（不可达 / 非 2xx / 超时）→ 409，本地一个字段都不改，不留下"本地叫 A、dsh-pet 叫 B"的分叉状态
- [x] 名字按 32 码点校验（入口就截断或拒绝）；空名不让提交，语义上等同于 dsh-pet 回落成宠物 `id`
- [x] `docs/protocol.md` 里 `rename` 那段（"清洗并写回 `identity.json`"）与实现同步
- [x] 测试：`test/identity.test.js`、`test/service.test.js`、`test/pet-bridge.test.js` 的现有用例跟着改；新增"镜像跟随"与"写失败一个字段都不动"两组

> 完成情况：新模块 `src/pet-name-write.js` 负责 GET → 只改一只的 `name` → PUT（body 是用户层的扁平
> `{ pets }`，其余顶层字段由 dsh-pet 从磁盘透传保留）；`Identity#mirror` 是"内存立刻生效、落盘尽力而为"，
> 与 `rename` 的"先落盘再改内存"分工明确。桥接多了 `refresh()`（作废 30 秒配置 TTL），改名成功后立刻重读，
> 桌面标签不用等下一拍。`readPetConfig`/`room.setSelfPet` 的上限统一成 `MAX_NICKNAME`（32），空名回落成宠物 `id`。
> 测试 241 条全绿（新增 6 条 service、6 条 pet-name-write、2 条 pet-bridge、1 条 identity）。
> 另用真跑着的 dsh-pet 做过一次只读 dry-run：`GET /config` 的 `main.pets[0]` 形状与 PUT body 完全对得上。
> **尚未真机验证**：宿主半边是新代码，要重启 DSH 才生效。

> 两轴评审后：`pickUserEntry` 收严成"只认 `main` 这一层"（原本桥接 id 不在 `main` 里时会退到别的
> 条目，等于把 pet pack 的 `pets` 当用户层写回去）；改名路径改成 `await identity.rename()` 之后再回
> `ok`，磁盘写不进去才退到 `mirror()`；`identity` 的日志句柄接上（镜像落盘失败原本是静默的）。
