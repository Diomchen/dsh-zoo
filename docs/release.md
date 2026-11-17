# 发布与上架 dsh-market

## 发版正文从哪来

打 `v*` tag 时 CI 的 `release` job 会读 `docs/releases/<tag 去掉 v>.md`：

- 有这个文件 → 用它当 GitHub Release 正文（`--notes-file`）；
- 没有 → 退回 `--generate-notes`，用自动汇总的提交列表。

已经存在的 release 不会重建，但重新推 tag 时会重传资产并用同一个文件覆盖正文
（`gh release edit --notes-file`），所以改文案只要改 `docs/releases/<version>.md`
再移动 tag 即可。**先写好这一篇再打 tag，能省一次来回。**

## 1.7.1 版本记录

GitHub Release 正文就是 [`releases/1.7.1.md`](releases/1.7.1.md)。

修「农场窗点了开不出来、得重启插件」：helper 换代（崩溃/被重启/重载）时宿主没清
`farmWindowOpen`，新 helper 手里没有窗却也不会主动上报「关着」，于是宿主一直以为窗开着，
每次点「农场」都走关窗分支。现在宿主在拉起/退出/报错/ready 四个点清零窗口状态，
`status().farmOpen` 以 helper ready 为前提；helper 侧窗口被藏起来时会先 `show()`，
「开着」也改成按 `isVisible()` 判断并随 `show`/`hide` 回报。存档与协议不变。

## 1.7.0 版本记录

GitHub Release 正文见 [`releases/1.7.0.md`](releases/1.7.0.md)：盘口上线（15 分钟一根的
合约、K 线与下单横条、持仓与结算、黑白模式），农场窗顶部新增「盘口」入口。

## 1.6.8 版本记录

GitHub Release 正文就是 [`releases/1.6.8.md`](releases/1.6.8.md)。

修带派窗口装不下红包：窗口仍是给字条定的 380×480，红包面板把 `取消 / 放进背包`
顶到卡片外，窗口既提不了交也关不掉。现在放宽到 400×620，卡片内容可滚，底栏
sticky 钉住；存档、协议、红包规则都没动。

## 1.6.7 版本记录

GitHub Release 正文就是 [`releases/1.6.7.md`](releases/1.6.7.md)。

补上 1.6.6 漏掉的那一跳：宿主 `src/desktop.js` 的 `bringWindow` 白名单没转发
`packet`，所以窗口拿到的仍是没有红包底数的命令。现在 `packet` 原样随命令下发，
真窗口里能按自己有的作物/种子加减。

同一版还修了 `package.json` 被写出 UTF-8 BOM、导致插件加载器严格 `JSON.parse`
失败的问题，并加了 `test/package-json.test.js` 守住这一点。

## 1.6.6 版本记录

GitHub Release 正文就是 [`releases/1.6.6.md`](releases/1.6.6.md)。

修 1.6.5 红包页看不到作物/种子：宿主下发的 `packet` 底数在 helper 主进程组装
`giftState` 时被削掉了，现在原样转发；旧宿主不发时窗口仍退回「字条」页。

## 1.6.5 版本记录

GitHub Release 正文就是 [`releases/1.6.5.md`](releases/1.6.5.md)。

带派新增**红包**：寄农场里的硬币/作物/种子，收件人点「拆开」才到账，24 小时没拆自动退回。
协议多 `packet-return` / `packet-returned` 两个包类型，`farm.json` / `season.json` / `market.json`
格式都没变；旧版本收到红包会当未知礼物退回，不会丢东西。

## 1.6.4 版本记录

GitHub Release 正文就是 [`releases/1.6.4.md`](releases/1.6.4.md)。代码只动桌面 helper 的输入兜底。

**修复：Windows 上可交互态粘住，左键进不了窗口**

- 现场（2026-11-16，`DESKTOP-699DN63`）：宠物可见、右键菜单能开、拖拽完全不动，左键单击宠物
  也没反应。`helperStatus.trustedInputs` 累计为 0，而 `lastTrustedInputAgeMs` 有一次约 29ms
  —— 只收到 up、没收到 down；窗口 exstyle `0x08200008` 里没有 `WS_EX_TRANSPARENT`，
  `WindowFromPoint` 命中的也是 helper 的渲染子窗。同一天没改代码又自行恢复（`trustedInputs`
  1→2），说明是**可自行解除的粘滞态**，不是硬故障。
- 根因：`setIgnore()` 在状态没变时直接 return —— 一次没落成功的 `setIgnoreMouseEvents(false)`
  之后，主进程认为窗口可交互、OS 却仍把左键交给下层，看门狗每拍都因「状态没变」跳过，
  永不重试；只能等一次真正的 `true → false` 翻转或 helper 重启（票 30 现场靠「重载配置」恢复）。
- 修法一：可交互期间每 `INTERACTIVE_REASSERT_MS`（2s）把同一个值重放给 native 层
  （`reassertInteractive()`），落不上就自己补上；穿透态不重放。
- 修法二：渲染端发现「`pointerup` 却没有对应的 `pointerdown`」时上报 `{type:'lost-down'}`，
  主进程立刻重放一次「穿透 → 可交互」（`healLostDown()`，1s 冷却），等价于 `debug-kick-input`
  的生产版，不重启 helper。
- 观测：`status` 新增 `lostDowns` / `lastLostDownAgeMs` / `reasserts` / `windowMessages`
  （Windows 上 `hookWindowMessage` 数 `WM_LBUTTONDOWN/UP`、`WM_RBUTTONDOWN/UP`）；宿主
  `normalizeStatus` 白名单同步放行。`WM_NCHITTEST` 的返回值拿不到（钩子只读），所以不数它。
- 回归：`test/desktop-input.test.js` 补 `lost-down`、status 白名单、`shouldReassert` 的用例。

**没改什么**

- 不改 LAN 协议、不加 UDP 报文；`farm.json` / `season.json` / `contracts.json` 都不升版本。
- 不改命中几何（没有把命中矩形外扩），避免在宠物旁边多吞掉一块点击。
- 回退到 1.6.3 即可，没有数据变更。

## 1.6.3 版本记录

GitHub Release 正文就是 [`releases/1.6.3.md`](releases/1.6.3.md)。

1.6.2 的 tag 打早了：那会儿还没有合并远端的「看田窗口」修复，所以 1.6.3 = 1.6.2 全部内容 +
看田窗口修复。代码层面没有新功能，存档与协议都不变。


## 1.6.2 版本记录

GitHub Release 用的简版文案：[`releases/1.6.2.md`](releases/1.6.2.md)。

自 v1.6.0 起的改动都收在这版里（v1.6.1 那个 tag 只带了看田窗口修复）：

**自适应局域网行情指数 + 24 小时折线**

- 权重按新鲜邻居数 0/1/2/3+ → 0% / 45% / 65% / 75%，再乘作物 beta（0.8–1.4），封顶 85%。
- 指数中位数叠加邻居最近一轮涨跌的中位数（±12% 动量），卖价仍夹在 `[base×0.5, base×2]`。
- 只影响卖价；买种子固定价；`/state` 指数形状不变，窗口增加 `weight/momentum/stale`。
- 交易所每行新增 24 小时成交价折线：最近 50 笔里该作物的成交 + 当前卖价；
  每个成交点是可悬停圆点，价格用贴着点的小气泡显示，不挤动旁边文字；
  没有成交画虚线并标「24h · 暂无成交」。
- 新增 `test/market-index.test.js`、`test/market-spark.test.js` 回归。

**露水 / 铲除 / 来客**

- DSH 开着就累计，农场动作不再重置计时；午夜只重置今日额度、保留余额；
  10 分钟 +1、每天 48、余额 48。
- 春夏来客改为 09:00–19:00 随机，秋冬仍在 15:00，均持续 3 小时。
- 新增「铲除」：生长中/冻住地块免费清空，`farm-clear` + `clear` 日志。
- 临时守卫按空闲宠物数量限制，新增 `no-guard-pet`；来客处理完只留一句结论，
  不再显示下拉框和按钮。

## 1.6.1 版本记录

GitHub Release 用的简版文案：[`releases/1.6.1.md`](releases/1.6.1.md)。下面是实现细节。

**修复：看田窗口被自动刷新踢回自己农场**

- 现场：点邻居「看看农场」，几秒到半分钟就自己跳回自己农场，没点任何东西。
- 宿主只记得访客视图、不记得“正在看谁家”：`refreshFarmWindow()` 只发 `{open:false}`，
  模式按 `self.out` 重算成 `owner`、`look` 整块消失。触发它的是行情摘要（每 30 秒一轮）、
  邻居来偷/帮忙、作物目录热加载、窗口倒计时到点。
- 窗口那半份也在推波助澜：`tickPlots()` 在看田模式下取的还是自家 `farm.plots`，
  于是自家作物一熟就发 `farm-refresh`——而 `farm-refresh` 同时被当成“切回我的农场”。
- 修法：宿主记 `farmWindowLook`，看田期间不发主人视图；`farm-refresh` 保持当前视图
  （看田时重拉邻居的公开视图，失败静默 60 秒）；新增 `farm-own` 作为切回自己农场的唯一出口；
  窗口倒计时改走 `look.plots`；串门状态推不再覆盖只读视图。
- 回归：`test/farm-look-refresh.test.js`（回环两只真宠物 + 录窗口命令）与
  `test/farm-look-renderer.test.js`（真 `desktop/farm.js` 跑替身 DOM），两条都验证过修之前是红的。

**没改什么**

- 不改 LAN 协议、不加 UDP 报文；`farm.json` / `season.json` / `contracts.json` 都不升版本。
- 回退到 1.6.0 即可，没有数据变更。

## 1.6.0 版本记录

GitHub Release 用的简版文案：[`releases/1.6.0.md`](releases/1.6.0.md)。

**四季来客 + 冻住/解冻**

- 春蛙雨、夏野火、秋熊獾、冬巨鹿全部上线；每位来客随机出现 3 小时，窗口外不显示。
- 破坏力提高：蛙雨/野火枯萎 2 块，熊獾失败 5 个作物，巨鹿失败冻 3 块；忽略按表减半。
- 冬季冻住地块可花 2 露水 + 5 硬币解冻；换季未解冻转枯萎。
- 新增 `farm-thaw` 动作、`frozen` 阶段、`freeze/thaw` 日志、ADR-0023；README/CONTEXT 更新。

## 1.5.1 版本记录

GitHub Release 用的简版文案：[`releases/1.5.1.md`](releases/1.5.1.md)。

**平衡：四季作物底价**

- 豌豆 4→6、西瓜 10→24、稻米 4→10、白萝卜 4→8。
- 四季作物只在当季能种，原底价下日收益低于草莓；调整后按底价、甚至地板价卖，
  日收益也不低于草莓。生长时间、产量、种子价、当季 1.1× 生长和六种常驻作物都不变。
- 新增 `test/season-balance.test.js` 回归。

## 1.5.0 版本记录

GitHub Release 用的简版文案：[`releases/1.5.0.md`](releases/1.5.0.md)。下面是实现细节。

**新增：四季与季候来客**

- 1 个本地自然日 = 1 个季节，春→夏→秋→冬四天一轮，本地 00:00 换季；锚点
  `2026-10-26` = 春。季节由时间算出，不写进 `farm.json`。
- 四种四季作物：豌豆（春）、西瓜（夏）、稻米（秋）、白萝卜（冬）；错季不能买/种，
  当季生长快 10%。
- 换季枯萎（方案 B）：未熟的四季作物变 `withered`，已熟的仍可收，六种常驻作物永不枯萎；
  枯萎地可直接重种。
- 每日节日：春播种节、夏夜市、秋丰收祭、冬围炉节，完成领硬币 + 露水；换季作废。
- 秋·熊獾：每四天一轮来一次，守夜（按守卫掷骰）或投喂（3 个仓库作物），
  失败/忽略只损失仓库作物，不打架、不毁地块。
- 新 sidecar `season.json`（节日进度/领取、来客状态）；可删，删了重建。
- 窗口新增四季日历、节日卡、秋天来客卡、枯萎地块卡；日志新增
  `season/event/wither/omen`；新动作 `farm-event-claim`、`farm-omen-resolve`。

**没改什么**

- 六种常驻作物的生长、产量、价格和旧农场经济不变；`farm.json` 不升版本，老存档直接打开。
- 不改 LAN 协议、不加 UDP 报文；邻居看不到你的季节、节日进度和来客。
- 不做天气、实时 Boss、春蛙雨/夏野火/冬巨鹿、节日小游戏。

**怎么回退**

- 直接装回 1.4.1 即可；`season.json` 会被旧版本忽略，`farm.json` 里的 `withered`
  是旧版本不认识的布尔字段，旧窗口会把它当普通地块显示，不会崩。要彻底清掉季节痕迹，
  停 DSH 后删 `<dataDir>/season.json`，并把 `farm.json` 里带 `"withered": true` 的地块
  改回 `false` 或删掉该字段。

## 发一个版本

版本号只有一个真相：`package.json` 的 `version`。CI 要求 tag 与它完全一致，例如
`"version": "1.0.0"` 对应 tag `v1.0.0`。

```sh
# 1. 改 package.json 的 version 并提交
git add package.json
git commit -m "chore(release): 1.0.0"

# 2. 打 tag 并推送 main 和 tag
git tag -a v1.0.0 -m "dsh-zoo v1.0.0"
git push origin main
git push origin v1.0.0
```

推送 tag 会触发 `.github/workflows/ci.yml`：

1. 先跑 `npm run check`（语法检查 + 全部测试）；
2. 检查 tag 与 `package.json` 版本是否一致；
3. `npm pack` 生成 `dsh-zoo-1.0.0.tgz`，并复制一份**不带版本号**的 `dsh-zoo.tgz`；
4. 创建 GitHub Release，两个文件都作为附件。

稳定的下载地址是：

```text
https://github.com/Diomchen/dsh-zoo/releases/latest/download/dsh-zoo.tgz
```

文件名不带版本号，所以 dsh-market 的条目不会在下次发版后 404。发布记录在
[Releases](https://github.com/Diomchen/dsh-zoo/releases) 页面，CI 运行记录在
[Actions](https://github.com/Diomchen/dsh-zoo/actions) 页面。

## 上架 dsh-market

dsh-market **不是**把插件提交到它自己的仓库。市场的插件目录来自精选列表
[`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
在那里提交一个 YAML 条目，合并后市场和网站会自动收录，通常一天内生效。

### 先满足四个前置条件

- 仓库里有 `package.json` 的 `dsh.bundle` 和根目录的 `cordis.patch.yml`（本项目已经有）。
- 仓库里有真实可用的代码，不是占位仓库。
- 仓库创建满 **1 天**。可以用 `gh api repos/Diomchen/dsh-zoo --jq .created_at` 查创建时间。
- 仓库有 `dsh-plugin` topic。

```sh
gh repo edit Diomchen/dsh-zoo \
  --add-topic dsh-plugin,deepseek-harness,desktop-pet,lan
```

### 提交条目

先发一次 v1.0.0（或任意正式版本），让 GitHub Release 里存在 `dsh-zoo.tgz`。

```sh
# fork 并克隆精选列表
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
git checkout -b add-dsh-zoo

mkdir -p data/plugins
cat > data/plugins/Diomchen__dsh-zoo.yml <<'YAML'
url: https://github.com/Diomchen/dsh-zoo
name: Diomchen/dsh-zoo
category: fun
description:
  en: "LAN pets for DeepSeek Harness. Neighbors' pets visit your desktop, and yours can visit theirs with a note or file along."
  zh: 让同一局域网里的 DSH 宠物互相看见、互相串门，还能捎一张字条或一个文件。
tarball: https://github.com/Diomchen/dsh-zoo/releases/latest/download/dsh-zoo.tgz
YAML

git add data/plugins/Diomchen__dsh-zoo.yml
git commit -m "Add Diomchen/dsh-zoo"
git push -u origin add-dsh-zoo
```

然后在 GitHub 上向 `awesome-dsh-plugin/awesome-dsh-plugin` 开 PR，或者：

```sh
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --head Diomchen:add-dsh-zoo \
  --title "Add Diomchen/dsh-zoo" \
  --body "Adds dsh-zoo: LAN pets for DeepSeek Harness, with desktop visits and file/note gifts."
```

只需要新增这一个文件，**不要手改 README**：列表的 README 由 `data/plugins/*.yml` 自动生成。

### 评审与生效

- CI 会检查条目的形状、`dsh.bundle`、仓库年龄和 README 能否重新生成；通过只是前置条件，
  之后还要维护者读代码。
- 如果 PR 被打上 `held: author`，把修改推到同一个分支，再留一条评论说明改了什么即可。
- 合并后网站和 dsh-market 会自动收录，通常一天内生效。之后用户可以直接在市场的
  **Plugins → Plugin Market** 里搜 `dsh-zoo` 安装。

### 后续发版

- dsh-market 的条目指向 `latest/download/dsh-zoo.tgz`，所以以后只要推新 tag，条目自动拿到新版本。
- 如果改成钉死某个 tag 的 tarball，就要同步更新精选列表里的 `tarball:`，否则用户会停在旧版本。
- 仓库或插件行为变了，顺手更新条目里的 `description`（只改自己那一条）。

### 可选：图标与截图

- 图标：在条目里加 `icon:`，必须是一张 GitHub 托管的方形位图（png/jpg/webp），
  不写则用作者头像。
- 截图：在仓库根放 `screenshots.json`，列 1–8 张仓库内图片的相对路径；市场和网站会自动展示。
  不写也没关系。

### 可选：发布到 npm

npm 不是上架 dsh-market 的必要条件；发布后市场会多显示下载量，并会优先使用 npm 预构建包。
如果要发 npm：

1. `package.json` 不能有 `"private": true`（本项目已移除）；
2. `repository` 要指回 `https://github.com/Diomchen/dsh-zoo`；
3. `npm publish --registry=https://registry.npmjs.org --access public`
   （本机默认 registry 是 npmmirror，往镜像发布会被拒）；
4. 用 granular token 时，权限要选 `Read and write (publish and stage)`，并勾上
   `Bypass two-factor authentication`；选成 `stage only` 只能把版本送进暂存区。

npm 包和精选列表是自动关联的，不需要在 YAML 里写 `npm:` 字段。

> **本项目已经发布到 npm**（首个版本 `dsh-zoo@1.3.0`）。目录里的 `npm` / `version`
> 字段来自 npm，市场也会优先用 npm 包，所以**以后每个正式 tag 都要同步发 npm**；
> 只推 tag 不发 npm 的话，市场会继续把用户留在 npm 上的旧版本。
