# 桌面右键菜单只挂自己，点外面不关

## Status

accepted

## 背景

dsh-pet 的桌面右键菜单是 per-pet 的，一级是工具项（打开软件 / 查看余额 / 碎碎念 / 对话 /
回到初始位置 / 显示位置 / 重载配置），随后是「动作」三级树（分类 → 动画名），最后是第三方
注册的「更多」。local-pet 当初把「桌面右键菜单」显式写进了 SPEC v2 的 Out of Scope
（[SPEC-v2](../../.scratch/local-pet/SPEC-v2.md)），现在把它搬回来。

有三件事**不能照抄**：

1. local-pet 的窗口是「整窗穿透、只有命中区接鼠标」（ticket 11 的硬线：点桌面别处不允许被吃掉）。
2. 访客已经有左键弹层做「送客」，再加右键等于两个入口做一件事。
3. local-pet 没有余额、没有模型（碎碎念/对话）、没有第三方菜单注册表，也没有「显示位置」
   这个对称概念。

## 决定

- **只挂自己（self）**。右键落在自己的宠物上出菜单；访客、空白桌面都不出。
- **工具项三个**：
  - 「打开软件」——主进程 `shell.openExternal`，地址由宿主给，渲染端不传 URL。
    宿主交出去的是**带 launch token 的登录地址**
    （`ctx.connection.authenticatedUrl(ctx.webServer.getOrigin())`）：DSH 的 Web 层只认
    `GET /?token=…`，裸 origin 会停在 401（见文末修订）；
  - 「回到初始位置」——渲染端本地把这一只的 body 放回它自己的出生点（宿主场景里的 `x/y`），
    不动场景、不牵连访客，也不用那个全场景 `reset`；
  - 「重载配置」——宿主重读 `settings.json` + `skin.json`（素材源）、重建场景、重启 helper。
    **手动重载不占崩溃退避的次数**。
- **动作树由宿主下发**（`scene.menu`），照 dsh-pet 的 animations 分类建三级；没有 dsh-pet 时
  退到本机素材源的平铺清单（名字即文件名）。
- **菜单矩形进 `overlay-rects`**，与弹层同一套：菜单和宠物接鼠标，别处继续穿透。
- **菜单打开时宠物停住**（不飞、不漫游），关掉后恢复物理与轮播。
- **收起只有三条路**：点中某项 / 光标离开菜单与宠物一小段宽限 / 12 秒超时。
  **点菜单外不关**——那一击要落到桌面上。
- 视觉与交互照 dsh-pet 的平级面板级联：右/下贴边自动翻转、悬停切链、每级独立滚动。

## 考虑过的选项

- **Electron 原生菜单**：样式不可控，和宠物、左键弹层是两种观感；而且只有自绘，菜单矩形才能
  报进 `overlay-rects`，跟穿透机制对齐。
- **菜单打开时整窗可交互**（dsh-pet 的做法）：点外能关，但用户在桌面上的那一击会被吃掉一次，
  破 ticket 11 的硬线。
- **访客也挂右键**：与左键弹层重复，且访客只有「送客」一个动作，不值得一层菜单。
- **照抄「显示位置 / 更多」**：local-pet 没有对应语义和注册表；空的「更多」比没有更糟。

## 后果

- 菜单不能靠"点外面"关。窗口 `focusable:false`，Esc 也收不到。行为要靠"移开 + 超时"，
  这条必须写进桌面 README，免得以后有人以为是 bug。
- 菜单是 DOM，级联定位要自己算：翻转、夹取、面板间缝隙都在 `desktop/shared.js` 里做成纯函数
  单测，渲染端只负责贴坐标。
- 动作集合依赖 dsh-pet 的 configurations 文件格式（它自己的内部文件）。它改格式，菜单就得跟着改；
  读不到时降级成平铺，不阻塞其他功能。
- 「重载配置」让手改 `settings.json` / `skin.json` 后不用重启整个 DSH，但也意味着"配置随时可能
  在两次读之间变"，所有读配置的地方仍按"可能读到旧的"处理。

## 修订（用户报「打开软件停在 401 页」，2026-11-04）

**症状**：右键宠物 →「打开软件」→ 浏览器地址栏是 `127.0.0.1:<port>`，页面原文
`dsh web authentication required; reopen the URL printed by dsh web.`

**根因**：DSH 的 Web 认证要的是 `/` 上带本次进程 launch token 的登录地址；`webServer.getOrigin()`
给的是裸 origin，请求在 `authorizeIndex` 就被 401 挡下。dsh-pet 自己用的是
`ctx.connection.authenticatedUrl(origin)`，本插件漏了这一步。

**决定**：`dshOrigin()` 取到 origin 后先过 `ctx.connection.authenticatedUrl()`；拿不到
`connection`（老宿主 / 没有 Web 载体）或它抛错，才退回裸 origin——那种宿主本来也没有这层认证。
回归断言在 `test/open-site-auth.test.js`：把 `desktop.openUrl` 收到的那条地址真发一次 HTTP，
必须是 303（带 token）而不是 401。
