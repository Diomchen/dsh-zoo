# 22: 桌面右键菜单（搬回 dsh-pet 那一份）

**What to build:** 右键自己的宠物弹一份菜单：三件工具（打开软件 / 回到初始位置 / 重载配置）+
「动作」三级树（照 dsh-pet 的 animations 分类）。只挂自己，访客和空白桌面不出。菜单矩形进
`overlay-rects`，整窗其余部分照旧穿透；菜单打开时宠物停住。

**Blocked by:** 11（控件与穿透）、14/19（素材源与动作池）

**Status:** done

决策依据：[ADR-0009](../../../docs/adr/0009-anim-playback-write-port.md)、
[ADR-0010](../../../docs/adr/0010-desktop-context-menu.md)。

- [x] 右键自己的宠物出菜单；右键访客、空白桌面不出（且都不吞鼠标）
- [x] 一级 = 打开软件 / 回到初始位置 / 重载配置 / 动作；「动作」下是分类，分类下是动画名
- [x] 有 dsh-pet：动作树来自它的 `animations` 配置（分类名一字不差）；没有：退到本机素材源
      的平铺清单（名字即文件名），不留空分类
- [x] 点动画名 → 宿主 `POST dsh-pet /anim?pet=<id>`；不可达或 `ok:false` → 本机播一次，
      播完前不被 `/state` 覆盖，并冒一句人话
- [x] 「回到初始位置」只动这一只：回到它在宿主场景里的出生点，不牵连访客，不用全场景 `reset`
- [x] 「重载配置」= 宿主重读 `settings.json` + `skin.json` → 重建场景 → 重启 helper；
      **不占崩溃退避次数**，失败也有人话
- [x] 「打开软件」由主进程 `shell.openExternal` 打开宿主给的 DSH origin；渲染端不传 URL，
      只认 `http:`/`https:`
- [x] 菜单矩形进 `overlay-rects`；菜单打开时整窗其余部分仍然穿透（点桌面别处不被吃掉）
- [x] 菜单打开期间宠物停住（不飞、不漫游、不轮播切段）；关闭后恢复
- [x] 收起三条路：点中某项 / 光标离开菜单与宠物 `UI_LEAVE_GRACE_MS` / `UI_MAX_OPEN_MS` 超时；
      点菜单外**不关**（那一击落到桌面）
- [x] 级联：右/下贴边自动翻转，每级面板独立滚动，悬停切链不闪断
- [x] 场景形状升到 v3（`menu` 字段）；旧场景（没有 `menu`）解析后菜单为空、不报错
- [x] `desktop/shared.js` 的树/clamp/命中是纯函数，有单测；`npm test` 全绿
- [x] 真机冒烟：截图里能看到菜单，点一项后菜单收起、宠物有反应

> 决策备注（来自 grilling）：只挂自己；不复刻余额/碎碎念/对话/显示位置/更多；菜单不拿输入租约，
> 靠 overlay 矩形 + 桥接矩形接管鼠标（与 ticket 11 弹层同一套）。

> 完成情况：宿主侧新增 `src/menu.js`（dsh-pet 的 animations → 菜单分类，读不到退本机素材池；
> 工具项 `open-site`/`home`/`reload`），场景升到 v3（`menu` 字段，旧场景解析成空菜单）。
> `src/pet-bridge.js` 加了唯一的写口 `playAnim()`（`POST /anim?pet=<id>`，ADR-0009），
> `handleAction` 新增 `play-anim` / `reload` / `open-site`，失败分别是
> `anim-unreachable` / `anim-no-pet` / `anim-rejected` / `reload-failed` / `no-origin` / `open-failed`。
> 渲染端 `desktop/renderer.js` 新增自绘菜单：三级平级面板、`shared.placeMenu` 贴边翻转、
> 指针驱的悬停切链、面板 + 桥接矩形进 `overlay-rects`、菜单开着时冻住那只宠物、
> 收起三条路（点项 / 移开 / 12s）；点播失败时 `playLocalAnim()` 在本机播一次并压住 `/state` 8 秒。
> `desktop/main.js` 加了 `open-url`（`shell.openExternal`，只认 http/https），
> `desktop.js` 加了 `reload()`（手动重载不占崩溃退避）与 `openUrl()`。
> 测试：`test/desktop-menu.test.js`（菜单树/placeMenu/场景）、`test/menu.test.js`（分类与配置读取）、
> `test/menu-actions.test.js`（点播/重载/打开软件）、`test/pet-bridge.test.js`（点播写口）、
> `test/desktop.test.js`（reload/openUrl）；全量 325 条全绿。
> 真机冒烟新增 `menu` 段（`LOCAL_PET_SMOKE_ONLY=menu`，39 项断言）：右键只挂自己、三级级联、
> 点一项就写 `play-anim`、菜单开着时宠物停住且不弹左键弹层、拖走后「回到初始位置」回到出生点、
> 访客不弹；全量冒烟 310 项通过。
> 截图 `.scratch/local-pet/notes/22-menu.png`。
>
> 线上探针（对着这台机器正在跑的 dsh-pet 0.3.8）：`/anim` 必须带 `?surface=`，缺了是
> `bad-request`；带 `surface=any` + `{name:"东张西望"}` 回 `{ok:true,playbackId}`，
> 下一秒 `/state` 的 `pets.main.anim` 就是同一个名字——ADR-0009 的"一条真相"成立。
> 名字不在它的动画集合里回 `{ok:false,reason:"unknown-animation",message:"没有这个动画：…"}`，
> 对应 `anim-rejected` + 本机播一次。

> 修复（用户报「右键菜单一瞬间就消失，点不到想要的项」）：
> 回路 = `LOCAL_PET_SMOKE_ONLY=menu` 里那句"光标移到菜单上停 800ms，菜单仍然开着"，
> 先红后绿。探针显示 `rootContains=false / panelsContain=true / leaveTimer=true`：
> `updateMenuHover` 量的是 `.lp-menu` 根节点，而面板全是 `position:absolute`，根节点 0×0，
> 于是"在菜单里"永远判 false——光标一离开宠物，500ms 宽限一到就自己关了。
> 修法：新增 `menuContainsPoint()`，按**每一级面板**的矩形判，不再量根节点。
> 这一条只有 DOM 层能锁住，纯函数层没有正确的 seam，回归断言就留在冒烟里。

> 修复二（用户报「面板点击无效、点击直接穿透到底层 app」）：
> 回路 = 冒烟里"光标停在菜单项上 2s，窗口仍然接鼠标"，先红后绿。
> 探针：`ignoring=true / overlayRectsAgeMs=3711 / rendererRectsAgeMs=60 / hoverInside=true`
> ——宠物矩形是新的，菜单矩形 3.7 秒没人续报；主进程对 overlay 只认 900ms，过期即丢，
> 窗口翻回穿透，点击落到后面那个 app 上。
> 根因：overlay 矩形只在"变化时"上报（开/关/场景同步），静止的菜单再没人碰它。
> 修法：`frame()` 里只要有浮层（弹层/放行卡/胶囊/提示/**菜单**/街道）就调
> `reportOverlayRects(false)`（自带 300ms 节流），保证 age 远小于 900ms。
> 同一个坑也影响"打开超过 900ms 的弹层按钮"，一并修好。
> 这条同样只有真窗口能锁住（跨进程 + 主进程时钟），回归断言留在冒烟里。

> 修复三（用户报「右键 → 打开软件 → 浏览器停在 401 页」）：
> 现场原文 `dsh web authentication required; reopen the URL printed by dsh web.`。
> 回路 = `test/open-site-auth.test.js`：起一个按 DSH `browser-auth` 契约回话的服务器
> （`GET /?token=…` → 303 + Cookie，其余 → 401 原文），走真 `POST /local-pet/action`
> 拿 `desktop.openUrl` 收到的那条地址再发一次 HTTP，先红后绿。
> 探针（对正在跑的 DSH）：`curl http://127.0.0.1:57783/` → 401 + 上面那句；
> 而 DSH 自己的 `dsh web` 打印/打开的是 `?token=<launch token>` 的登录地址。
> 根因：`dshOrigin()` 只交 `webServer.getOrigin()` 的裸 origin，认证在 `authorizeIndex`
> 就被挡下；dsh-pet 用的是 `ctx.connection.authenticatedUrl(origin)`，local-pet 漏了。
> 修法：`dshOrigin()` 过一层 `authenticatedUrl`（`ctx.get('connection')` 现取；拿不到或抛错
> 才退回裸 origin），helper 的白名单原样保留 query，地址只交给 `shell.openExternal`。
> 顺带确认：`normalizeHostCommand({type:'open-url'})` 不会吃掉 `?token=`，所以问题不在 helper。
