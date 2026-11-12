# 作物表搬到运行时：本地目录 + 局域网同步

## Status

accepted（2026-11-12）。票 59 已实现：本地目录、自定义图、热加载、目录报文与 beacon 指纹、
合并收敛、收到过的目录落盘、局域网取图。跨机验收按用户要求只对 `DESKTOP-699DN63` 手动做。

前情：[ADR-0016](0016-farm-economy-federated.md)（农场经济联邦）、
[ADR-0018](0018-farm-open-to-lan.md)（农场公开）。
本轮已把作物外观从 emoji 换成包内 SVG（票 58），但**作物定义仍然编译在代码里**。

## 背景

用户想"不更新包，实时添加植物"，并且**局域网里所有机器都要同步到**。

现状是三份硬编码的表：宿主 `src/farm-rules.js` 的 `CROPS`、窗口白名单
`desktop/shared.js` 的 `CROP_IDS`、显示表 `desktop/farm-view.js` 的 `CROP_META`。
加一种作物要改三处、重新打包、每台机器都装一遍。作物 id 还会上网（地块、行情、偷菜
回执），所以任何一台机器不认识这个 id，看到的就是空地
（`src/farm.js` 的 `normalizePlot` 把未知作物归一成空地）。

约束是不能把协议搞崩：这是明文 UDP、4 KiB/包、无身份验证的家用局域网协议
（见 `docs/protocol.md`）。农场经济虽然"联邦"，但每台机器的底价是**自己的**表算的；
一旦表来自网络，就等于开了一条"邻居能改我经济数值"的通道。

## 决定

**作物表变成运行时目录，随局域网同步"定义 + 图"，但每个 id 钉死在一个内容哈希上。**

1. **本地来源**：`<dataDir>/crops.json` + `<dataDir>/crops/<file>.svg|png`（都可选）。
   内置六种打底 → 用户条目覆盖同名 id → 逐条 clamp → 坏条目丢掉、只告警一条。
   启动时加载；文件变了重载并重推已开着的窗口。
2. **指纹而不是内容**：整份目录（数值 + 名字 + 图哈希）算 canonical JSON 的 sha256，
   截 16 位当 `catalogHash`。beacon 只带 `crops: { v, hash, count }` 三个字段。
3. **按需拉取**：邻居指纹和自己不一样 → 发 `crop-catalog-request`；对方回
   `crop-catalog`（分片，每片仍 ≤4 KiB，带 `chunk`/`total`）。每邻居 30 秒最多请求一次。
4. **合并规则**：本地 `crops.json` 里手写的条目**永远优先**；网络上收到的同 id 不同定义，
   按**定义哈希字典序小者胜**——确定性收敛，与到达顺序无关。合并结果落
   `<dataDir>/crop-catalog.json`（记 `seenFrom` / `seenAt`），发布者掉线也不丢。
   上限 64 种；**不做删除同步**（定义一旦被看见就钉住，否则别人地里会长出一块空地）。
5. **图不走 UDP**：目录条目只带 `art: { hash, ext, bytes }`。邻居用现有的局域网 HTTP
   端口取 `GET /dsh-zoo-crops/<hash>.<ext>`——服务端只认自己目录里登记过的哈希，不接受
   任意路径；客户端落到 `<dataDir>/crop-art/<hash>.<ext>`；窗口由 helper 的
   `dshzoo://crop-art/<hash>.<ext>` 读（`main.js` 已经有一套 scheme + host 白名单）。
   `farm.html` 的 CSP 从 `img-src 'self'` 扩到 `img-src 'self' dshzoo:`。
   单图 ≤256 KB、只认 `svg`/`png`、正文里出现 `<script` 直接拒。
6. **窗口只认 payload**：`farm-window` 带 `crops: [{ id, name, art, growMs, yield,
   seedPrice, base }]`；`shared.js` 按它校验、`farm-view.js` 按它渲染，两份硬编码删掉。
   老宿主没这一项时退回内置六种（前向兼容）。
7. **能力位**：`CAPS` 加 `'crops'`；邻居没有这一位 = 不做目录交换，也不显示它的自定义作物
   ——效果与今天一致（看到空地、行情里没有）。老版本收到 `crop-catalog-request` 会因为
   未知类型直接丢掉，不会崩。

## 考虑过的选项

- **只在本地（不联网）**：最省事，但用户明确要"局域网内都能同步更新到"。
- **图 base64 塞进目录报文**：beacon 4 KiB 装不下几张图；单独报文传图又要自己切包、重传、
  断点续传——这些 HTTP 已经在做了，而且局域网 HTTP 端口本来就开着一半（皮肤/礼物/农场）。
- **id 加命名空间（`<deviceId>:blueberry`）**：彻底避免冲突，但 id 会进 `farm.json`、
  `market.json`、行情指数、日志和 UI；为了一个低概率冲突把标识符搞丑不划算。
- **接收端完全信任发布者的数值**：一枚 `seedPrice: 1`、`yield: 999`、`growMs: 1000` 的作物
  能直接刷穿本地经济。所以接收端照样 clamp，而且本地市场只在 `[base×0.5, base×2]` 内认价。
- **只同步"有没有这种作物"，数值各机器自己定**：那就等于回到"每台机器各写一份表"，
  用户改一次还得挨台同步。

## 后果

- **这是第一条"局域网数据能改本机经济"的通道**。防线是：数值 clamp、本地条目优先、
  只接受已发现邻居、限频、目录/图都有上限。写进 README 的"信任模型"一节。
- **同 id 不同定义会静默收敛到哈希小者**。地里已种的 `growMs` 是种下时快照
  （`src/farm.js` 早就是这么做的），生长时长不会中途变；但 `yield` 和 `base` 会变，
  价格会在下一次归一化时被重新夹到新区间。日志里记一行来源，不做弹窗。
- **目录只增不减**：发布者的机器没了、文件删了，条目仍在本地，否则别人地里的作物会凭空消失。
- **老版本邻居照旧看不到新作物**，与今天一致；不做降级模拟。
- 存档里出现"本地没有定义"的作物时，仍是现状：归一成空地。所以同步要在读盘之后、
  结算之前完成（service 启动顺序里加一步）。

## 实现顺序（票 59）

1. `src/crop-catalog.js`：合并、clamp、`defHash`/`catalogHash`、读写 `<dataDir>/crop-catalog.json`（纯函数 + 注入 I/O）。
2. `farm-rules` 的 `CROPS`/`CROP_IDS` 改成可填充（去 freeze、原地改），
   `PLOT_UNLOCK_RESERVE` 改成按当前表算；20 处调用点不动。
3. 窗口：payload 带目录，`shared.js` / `farm-view.js` 按目录走；CSP 扩 `dshzoo:`。
4. 协议：`CAPS` 加 `crops`，beacon 带指纹，两个报文 + 解析/限频/测试。
5. HTTP：`/dsh-zoo-crops/<hash>.<ext>` 只读路由 + 客户端拉取 + 落盘缓存。
6. helper：`dshzoo://crop-art/<hash>.<ext>` host。
7. 文档：README（怎么加 / 信任模型）、`docs/protocol.md`（两个报文）、本 ADR 转 accepted。
