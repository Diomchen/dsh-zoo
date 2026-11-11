# 50: 单机双宠物——偷菜/雇工终于能被触发

**What to build:** 一条命令在**一台机器**上起两只真宠物（回环），两只互相发现、放行、串门，
于是偷菜、帮忙、挂牌、雇佣、结算全都能在实际产品上手动走一遍，不用第二台机器、不用改协议、
不用改农场规则。给的是**数据层**的触发与验证能力；窗口仍由 `desktop-smoke.mjs` 覆盖。

**Blocked by:** 43, 44（已 done）

**Status:** done

决策依据：[ADR-0016](../../../docs/adr/0016-farm-economy-federated.md)（农场是联邦的：偷/帮是访客动作、
雇工要一个真雇主）。回归依据：[SPEC v5](../SPEC-v5.md)。

## 开工前已拍板

- **D1：不写假邻居的农场状态机。** `scripts/fake-peer.mjs` 只守住「发现 / 串门 / 礼物」
  （[README](../../../README.md) 已明说它没有农场仓库和合同）。扩它等于把成熟度、守卫、
  偷/帮上限、工资结算在第二处重写一遍——协议一改就开始漂，且「偷成功」只证明宿主对，
  不证明规则对。
- **D2：harness 用两个真 `createService`（回环），零 mock。** 深度来自「把引导藏起来」，
  不是「把行为伪造出来」。`src/service.js` 已经把测试所需的窄口开好了：`options.dataDir` /
  `port` / `targetPort` / `bindAddress` / `broadcastAddress` / `marketDigestMs` / `tickIntervalMs`。
- **D3：接口是产品自己的接口。** 把 service 注册的路由挂到真 HTTP 上，`action()` 就是
  `POST /dsh-zoo/action`、`state()` 就是 `GET /dsh-zoo/state`——和用户 `curl` 的是同一条路。
  harness 不新增任何协议面、不新增 action 名。
- **D4：端口对由 harness 分配。** `A.targetPort = B.port` 且 `B.targetPort = A.port`，
  两个端口必须**先都定下来**才能启动任一只。这个先后约束不该让每个调用方自己推。
- **D5：不动那 23 个测试文件的引导代码。** `fakeCtx` 在 `test/` 里被手抄了 24 份
  （`grep -rl "function fakeCtx" test/*.js | wc -l`）——所以接缝是真的，不是假设；
  但迁测试是另一票，不混进来。

## 接口

```js
// scripts/lib/pet.mjs
export async function startPair (options = {}) → { a, b, close () }
// options: { marketDigestMs?, tickIntervalMs?, a?: {...}, b?: {...} }
// a / b:  { deviceId, baseUrl, action (name, body) → { status, body }, state () → snapshot }
```

一次调用买到：两个临时数据目录、两条回环 UDP、互相指对的 `targetPort`、两条真 HTTP
（action + state 两个路由）、一串 `close()`。调用方不需要知道端口、目录、`fakeCtx`、路由表。

删除测试：删掉这个模块，`scripts/two-pets.mjs` 要自己写 ~80 行引导，下一个「我想在本机看两只宠物」
的人再抄一遍。复杂度会回来——它挣得自己的位置。

## 清单

- [x] `scripts/lib/pet.mjs`：`startPair` —— 临时 dataDir、两个 free UDP 端口、回环
      （`bindAddress`/`broadcastAddress` 都 `127.0.0.1`）、互相 `targetPort`、`desktop: false`、
      `petBridge: false`、把注册到的路由挂到 `node:http`、`close()` 关 HTTP + `dispose()` + 删临时目录
      - 路由形状已经是现成的（`src/service.js:434-500`）：`{ kind: 'exact', path, handler }`，
        一共 4 条 —— `/dsh-zoo/state`、`/action`、`/self-state`、`/desktop`。
        挂载就是一个 exact 匹配的分发器，不用引框架，也不用抄 `fakeCtx` 里那种假 req/res
        （`test/farm-action-e2e.test.js:109` 的 20 行手搓流）——真 HTTP 比它更短也更真
- [x] `action(name, body)`：真 `POST /dsh-zoo/action`，返回 `{ status, body }`（4xx 不抛）；
      `state()`：真 `GET /dsh-zoo/state`
- [x] `scripts/two-pets.mjs`：REPL —— `admit` / `visit` / `steal <pN>` / `help <pN>` /
      `listing <时薪> <min> <max>` / `hire <小时>` / `contracts` / `state` / `quit`，
      启动时打印两条 `baseUrl`（可以直接 `curl`）
- [ ] `package.json`：`"two-pets": "node scripts/two-pets.mjs"`
- [x] `test/two-pets-harness.test.js`（红→绿，就是这张票的验收）：
      A 放行 B、B 放行 A → A 串门到 B → `a.action('farm-steal', { plotId: 'p2' })` 成功、
      B 的 `state().farm.log` 有记录 → B `listing` 后 A `hire` 成功、A 的 `contracts.outgoing`
      有一条 active → A `end-contract` 后两边 `settled` 一致
- [x] README「验收」节 + `.scratch/dsh-zoo/notes/1.2.0-windows-test-plan.md` 各加一段单机路径
- [x] `npm test` + `npm run check` 全绿

## 风险

- 回环上 20 包/10 秒的限速（ticket 43 已踩过）：心跳别快于 2 秒、广播别快于 60 秒，
  两只宠物的动作串行发。
- 挂牌后的行情摘要靠「签名变了就发」触发（`src/service.js:4187` 一带），首次广播要等
  `marketDigestAt` 归零那一拍；harness 默认给 `marketDigestMs` 一个短值，免得测试等 30 秒。
- `farm-steal` 会 await UDP 结果（最长 ~1.8 秒），REPL 里会看到明显停顿——这是产品行为，不是卡死。

## 不做

仿真/驱动 Electron 农场窗（仍归 `desktop-smoke.mjs`）、迁 23 个测试文件的引导代码、
假邻居的农场合规、单机自动串门策略、在 harness 里加任何新的 action 名。

## 完成情况

一条命令起两只真宠物，偷菜和雇工在单机上都能真的触发。落地时改变的三个判断：

- **`marketDigestMs` 没调短。** 挂牌会 `force` 一次行情摘要（`src/service.js:1752`），
  A 立刻拿得到；调短只会往回环的 20 包/10 秒限速里多灌包。前提是**先互相放行**——
  `hireNeighbor` 的 `mayTalkTo` 要它，这也是测试第一版报 `worker-unavailable` 的原因。
- **不做运行中拨时钟。** 行情的 `at` 走农场钟（`src/service.js:265` 的 `marketNow = farmNow`），
  而雇工的心跳/摘要新鲜度用真实钟；拨一边会让「挂牌」变成过期样本，`hire` 永远
  `worker-unavailable`。改成**开局就熟**：`startPair({ b: { mature: { p1: 'tomato' } } })`
  把一份合法 `farm.json` 写进临时目录（`initialFarmState()` 起手，不另外编常量）。
- **`fetch` 换成 `node:http` + `agent: false`。** 全局 fetch 的连接池会在测试跑完之后
  把进程多挂 4 秒；每条请求一条连接，收尾干净。

`two-pets --lucky` 把守卫那一掷固定成没被抓：只为人看 demo，不碰规则。
