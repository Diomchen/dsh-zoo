# 20: 邻居的动作留在快照里

**What to build:** 让「他现在在干什么」这件事从心跳一路活到快照里，供桌面上的邻居面板读取。心跳早就带着 `action` / `semantic` / `say`（ticket 16），但 `room.observeHeartbeat` 只留下 `anim`，其余扔掉了。同时补一张 `street` 视图：每户邻居此刻能不能去、为什么不能去、最后什么时候见过。

**Blocked by:** —

**Status:** done

- [x] 心跳影子（`state.guests`）保留 `action` / `say`；非法或缺失时回退到 `null`，不整包失败
- [x] `state.recentSeen`：每次 beacon / 心跳记一次 `lastSeen`，10 分钟没动静才忘掉（掉线的邻居要在名单里灰着留 10 分钟，而邻居表本身 30 秒就清）
- [x] `snapshot.street`：`[ { deviceId, nickname, action, say, anim, canVisit, blockedReason, lastSeen } ]`，`blockedReason` 为 `null | 'peer-offline' | 'not-admitted' | 'not-mutual'`
- [x] 排序稳定：能去的按 `lastSeen` 倒序在前，去不了的在后，同样按 `lastSeen` 倒序；上限 16 户
- [x] `canVisit` 与 `visitTargets` 是同一个判定，不允许出现两套「能不能去」（`visit-policy.js:54`）
- [x] 纯函数 `streetFrom(snapshot 原料)` 可单测：四类 `blockedReason` 各一条，掉线 9:59 在、10:01 不在
- [x] `docs/protocol.md` 补一句：`/state` 的 `street` 是本地派生视图，不上线、不可被远端写入

> 边界：`street` 只读。远端无论发什么包都改不了它——名字取自邻居表或放行名单（ticket 03），动作名只来自通过校验的心跳。

---

# 21: 那条小街

**What to build:** 桌面上点「串门」时向上弹出邻居面板：两列小房子，一格一户人家，屋顶颜色由 `deviceId` 哈希定，脸色用访客同一套色板。点谁去哪家；去不了的那几户折叠在下面一行。自己出门期间整条街压暗，只剩「召回」。

**Blocked by:** 20

**Status:** done

- [x] 面板贴在自机宠物右上，宽 272，两列；一屏最多 6 户，多了滚动
- [x] 每户：屋顶（`shared.PET_COLORS` 哈希）、墙、从窗户里探出来的脸（两只眼睛）；名字在房子下面，超过 5 字截断，`title` 给全名
- [x] 第二行文字：有 `action` 就写它（「在改那个 bug」），没有就写状态（「在附近」/「刚掉线」/「还没放行你」）
- [x] 悬停一户：那颗脑袋从窗户里探出来晃两下（`peek` 动画，只动那一个）
- [x] 某户的 `action` 变了：那一户自己探一次头，不必悬停；面板因此是活的
- [x] 点能去的一户：`action=visit` 带上 `deviceId`（`/local-pet/action` 早就收，`src/service.js:288`）；点完那户亮起「敲门中…」，直到快照变化或 notice 落下
- [x] 去不了的折叠成一行「附近还有 N 位，现在去不了 ›」，点开才露出灰房子；再点收起
- [x] 自己出门时：顶部换成「宠物正在老王家」+「召回」，整条街压暗且不可点
- [x] 面板与每一行都要上报点击矩形（`desktop/renderer.js:215` 那套），否则鼠标点不到
- [x] 冒烟：`scripts/desktop-smoke.mjs` 点第二户，断言 `action=visit` 且 `deviceId` 是那一户的
- [x] 键盘不做：桌面窗 `focusable:false`（ADR-0005），面板纯鼠标

> 文案口径沿用 `src/visit-copy.js`：面板里的失败理由和气泡里那句必须是同一句，不许各说各的。

> 完成情况：纯函数在 `src/street.js`（`streetFrom` / `MAX_STREET` / `STALE_KEEP_MS`）；
> `canVisit` 直接来自传进来的 `visitTargets`，没有第二套判定。room 侧新增
> `state.recentSeen` 与 `rememberSeen()`，心跳影子多存 `action` / `semantic` / `say`，
> `tick()` 清理超时、`decide()` 跟着信任改灰态理由。快照多了 `street`，`/state` 一并可见。
> 测试 `test/street.test.js` 4 条（顺序 / 三种理由 / 十分钟窗口 / 上限 16）+
> `test/street-room.test.js` 3 条（动作名活到街上、灰态留十分钟、脏动作名只丢字段）；全量 301 条全绿。

> 审查后改动（code-review 两轴）：`blockedReason` 的 `offline` 改回仓库已有的 `peer-offline`，
> 词表补 `isBlockedReason()` 守卫并被 `desktop-pets.js` 复用；`decide()` 不再用 `nowMs()`
> 伪造一次 `lastSeen`（改成只纠正记忆里的 status）；心跳影子里没人读的 `semantic` 删掉。
