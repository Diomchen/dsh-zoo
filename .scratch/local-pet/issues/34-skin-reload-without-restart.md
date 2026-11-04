# 34: 改 skin.json 不用重启 DSH

**What to build:** 右键「重载配置」之后，`skin.json` 里新加的皮、改过的目录、删掉的源都立刻生效：
注册表重读、对外供源换表、菜单和场景跟着重建。不用退出 DSH。

**Blocked by:** 32（换皮本身）、33（素材根目录随皮走）

**Status:** open

来由：2026-11-04 现场。为了换一张皮，这一轮重启了三次 DSH——因为素材源清单只在
`startService` 里读一次（`loadSkin()`），而「重载配置」只重读 `settings.json`。
使用者加一条源、改一个目录、删掉一条，都要重启整个应用。

`lan-server` 是第二个卡点：它在启动时把 `sources` 收进 `byId`/`fallbackSource`，
manifest 与 sha256 也按源 id 缓存（`manifests` / `hashesBySource`）。只重读注册表不换表，
邻居拿到的还是旧清单。

- [ ] `lan-server` 的源索引用 `let` 持有，新增 `setSources(next)`：重建 `byId` 与
      `fallbackSource`，不动端口、不重启服务器
- [ ] manifest 与 sha256 缓存改成按**源对象**（`WeakMap`）而不是按 id：换了目录的源
      自然重算，没换的照旧命中
- [ ] `service.loadSkin()` 在 `applySkin()` 之后调 `skinServer.setSources(skinSources)`
      （`serveSkin()` 还没跑时是 `null`，跳过）
- [ ] 「重载配置」在 `refreshDesktopMenu()` 之前补一次 `await loadSkin()`
- [ ] 重载后当前皮不存在了：`applySkin()` 已有的回落 + 告警照常生效，并且要补发心跳
      （`skinRef.id` 变了）
- [ ] 场景签名已经含 `idlePool` / `assetRoots` / 菜单（票 32/33），重载后自动重发，不另加
- [ ] 单测：`lan-server` 换表后新源可取、删掉的源 404；`service` 写一个新的 `skin.json`
      再发 `reload`，`state.skin` 与菜单跟着变
- [ ] 全量测试全绿

> 不做：监听 `skin.json` 的文件变化（那要再加一个 fs watcher，和「重载配置」这条显式路径
> 重复）；主动把新素材推给访客（他们按 `skinId` 缓存，下次取自然更新）。

> 验收：开着 DSH，在 `skin.json` 里加第三条源 → 右键「重载配置」→「外观」里多出它，
> 点一下就能切，全程不退出应用。
