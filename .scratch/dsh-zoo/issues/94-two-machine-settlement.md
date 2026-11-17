# 94: 双机开户与净额结算——协议最小闭环

**What to build:** 第二台机器连上来能看到同一个市场、能用自己农场的钱在房主那里成交，两个人的余额与持仓在两个屏幕上一致；拔网线 30 秒再插回去，落后的那一方自己能补齐，不会停在旧余额上。

**Blocked by:** 93 (期货窗)

**Status:** done

- [x] 新报文 `futures-hello` / `futures-order` / `futures-settle` / `futures-sync` 上线；`futures-cancel` 一并占位并解析（96 才用到语义）。
- [x] 房主在 `hello` 时把 `deviceId` 绑到源地址，之后只认该地址发来的订单；别的地址冒用同一 `deviceId` 被拒。
- [x] `settle` 带 `(epoch, seq, balance, marginUsed, delta)`；接收端按 `(epoch, seq)` 幂等，`seq` 回退直接丢弃，重复包不重复入账。
- [x] 丢包自愈：peer 每 30 秒发 `sync {epoch, lastSeq}`，房主补发缺的 delta；差距过大时回一份账户快照。
- [x] 一台机器吃单后，房主账本与对端展示的余额/持仓在 30 秒内一致（测试里用假时钟推到下一根）。
- [x] 旧版本对端：收到未知 kind 静默丢包，本机窗口显示「对端未升级，期货不可用」，农场与盘口完全不受影响。
- [x] 协议快照与 `docs/protocol.md` 同步更新；单包不超 4 KiB 由测试守住。
- [x] `npm run check` 全绿（现有 1044 个用例不回归）。

**证据（2026-11-17）：** 
ode scripts/run-tests.mjs → 1108 用例 / 1107 通过 / 0 失败 / 1 跳过；
ode --test test/futures-net.test.js 6 条真 UDP 用例全绿（utures-net.test.js）；协议快照在 	est/protocol.test.js，docs/protocol.md 已补五种报文与跨机账户一节；旧邻居降级由 utures-net.test.js 的「无 cap 邻居」用例覆盖，窗口文案在 desktop/futures-view.js 的 statusOf()。
pm run check 绿。
