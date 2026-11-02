# 11: 桌面上的三个控件

**What to build:** 桌面上只需要三样操作：串门、召回、送客；外加第一次见到新邻居时的一张放行卡。全部画在宠物身边，不回到 GUI。

**Blocked by:** 09, 10

**Status:** done

- [x] 悬停或点击自己的宠物出现「串门」/「召回」，状态不对时置灰
- [x] 点击客人出现「送客」
- [x] 第一次见到某个邻居时，宠物旁边弹一张放行卡（接受/拒绝），不遮挡宠物本体
- [x] 所有控件只在命中区内接管鼠标，其余地方继续穿透到桌面
- [x] 串门失败（没放行/不在线/已出门/对方满员）都有一句可读的提示，不静默

> 完成情况：场景 v2 增加 `controls`（visit/recall/visitors/prompt/notice），宿主仍是唯一权威；
> 渲染端悬停/点击只把 `action` 写回宿主，宿主走与 HTTP `/action` 同一个 `handleAction` 再回
> `action-result`。弹层打开时持有输入租约（`BUSY_HEARTBEAT_MS=300`/`BUSY_LEASE_MS=1200`），
> 关闭/移开/失焦/12s 超时/场景 reset 立刻释放；主进程另有 `BUSY_MAX_MS=30s` 硬上限和
> `overlay-rects` 命中区兜底（渲染端卡死最多 ~1.3s 恢复穿透）。放行卡/召回胶囊是常驻控件，
> 不持有租约，靠 overlay 矩形按需接管鼠标。自己出门时桌面没有 self，用常驻「召回」胶囊
> 代替（锚在它最后出现的位置）。失败：同步错误走 `action-result.notice`，异步失败（超时/
> 失联/被送客）走 `controls.notice`；都在宠物旁边冒泡 4.2s。SPEC v2 不设同屏上限，所以没有
> “对方满员”这一种失败；其余失败文案都在 `src/room.js` 的 `failureText` 里。真机冒烟新增
> 控件用例和 `.scratch/local-pet/notes/11-*.png`（弹层按钮 + 放行卡 + 失败气泡）。
