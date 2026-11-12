# 59: 运行时作物目录 + 局域网同步

**What to build:** 作物表从代码里搬出来，放进 `<dataDir>/crops.json` + 图目录；加一种作物
不用重打包、不用重启，局域网里的机器会自动拿到定义和图。

**Blocked by:** 58

**Status:** done（代码完成 2026-11-12）；跨机手动验收按用户要求只对 `DESKTOP-699DN63` 做，没有进默认测试

决策依据：[ADR-0019](../../../docs/adr/0019-runtime-crops-over-lan.md)。

## 地基（不碰协议）

- [x] `src/crop-catalog.js`：纯函数 —— 内置六种打底 → 叠加本地文件 → 逐条 clamp
      （`growMs` 1 分钟–30 天、`seedPrice` 1–1e6、`yield` 1–99、`base` 1–1e6、名字 ≤16 字）
      → `defHash`（canonical JSON 的 sha256 前 16 位）→ `catalogHash`；
      读写 `<dataDir>/crop-catalog.json`（收到过的目录，只增不减，上限 64）
- [x] `src/farm-rules.js`：`CROPS` / `CROP_IDS` 去 freeze、改成可原地填充；
      `PLOT_UNLOCK_RESERVE` 改成按当前表算的函数（现在 6，别写死）
- [x] `src/service.js`：启动顺序里"读盘之前"加载目录（重载/重推还没做）
- [x] 窗口：`farm-window` 带 `crops` 目录；`shared.js` 按它校验、`farm-view.js` 按它渲染，
      两份硬编码删掉；老宿主没这一项时退回内置六种（自定义作物暂时退 🌱）

## 图

- [x] `<dataDir>/crops/*.svg|png`：≤256 KB、只认两种扩展名、正文出现 `<script` 直接拒
- [x] helper：`dshzoo://crops/<hash>.<ext>` host（`desktop/crop-path.js` 白名单 + argv
      `--dsh-zoo-crops`，实测 CSP 放行后 `naturalWidth` 正常）
- [x] `farm.html` CSP：`img-src 'self' dshzoo:`
- [x] 本地图落进 `<dataDir>/crop-art/<hash>.<ext>`，窗口只认哈希不认原路径

## 局域网

- [x] `CAPS` 加 `'crops'`；beacon 带 `crops: { v, hash, count }`（编解码 + 坏指纹只丢自己）
- [x] 报文 `crop-catalog-request`（带本机指纹）与 `crop-catalog`（分片 `chunk`/`total`，
      每片 ≤8 条、整包仍 ≤4 KiB）；解析夹取、坏条目只丢自己
- [x] 合并规则：本地手写永远优先；同 id 不同定义按 `defHash` 字典序小者胜（`buildCatalog`）
- [x] 收到过的目录落 `<dataDir>/crop-catalog.json`（带 `seenFrom`，只增不减）
- [x] service 侧收发：beacon 指纹比对 → 请求/应答（每邻居 30 秒 1 次，`sendDirect` 免放行）
      → 分片拼装（60 秒 TTL）→ 合并去重（哈希小者胜）→ 落盘 → 重推窗口
- [x] HTTP：`GET /dsh-zoo-crops/<hash>.<ext>` 只服务 crop-art 目录里的文件；客户端 5 秒超时、
      ≤256 KB、字节数必须和对方声明一致
- [ ] `two-pets` 命令（不做：跨机验收走手动步骤，见下）

## 验收（票 60 之后：默认测试不碰网络）

局域网的验收**不写进默认测试**，也不跑网段级用例：
1. 两台机器装同一个包、同一网段；
2. 在 A 放 `crops.json` + 图，B 的日志里应出现「作物目录已更新」；
3. B 的农场窗口里能看到新作物、同一张图，能种能收能卖。

只对指定机器（`DESKTOP-699DN63`）单播验证，不广播扫网段。

## 验收

- [ ] A 机加一张图 + 一条 `crops.json`，不重启：A 的窗口几秒内出现新作物
- [ ] B 机（同 LAN、都放行）在 30 秒内看到同一作物、同一张图，能种能收能卖
- [ ] 把 A 关掉重启 B：目录还在，地里的新作物照常长
- [ ] 老版本 C 机：照常串门送礼，新作物在它那边是空地，不崩
- [ ] 恶意/手滑条目（`yield: 999`、`growMs: 1`、1 MB 图、带 `<script` 的 SVG）被丢或夹住，
      只留一条告警
- [ ] `npm run check` 全绿；`smoke:desktop` 仍通过

> 不做：删除/改名同步、跨网段、公网、作物专属动画。
