# 发布与上架 dsh-market

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
