# 28: 素材诊断跟得上真实状态（media 探针不再永远 loading）

**What to build:** 让 `/local-pet/desktop` 的 `helperStatus.media` 跟着真实素材状态走：开始加载报
`loading`、`loadeddata` 报 `video`、降级报 `pending` / `svg`；并带上 `readyState` 与
`document.visibilityState`，好让现场判断「为什么没画出来」。

**Blocked by:** —

**Status:** done

来由：2026-11-04 Windows 现场反馈说 live scene 的 `media.source` 长期 `loading`、`media.failed=[]`，
怀疑素材没画出来。实际上渲染端三只宠物都是 `video`（截图有像素）——坏的是探针，不是播放：
`reportMedia` 只有两个调用点（`playUrl` 报 `loading`、`showSvg` 报 `svg`），`loadeddata` 把
`pet.media.source` 改成 `video` 之后**从不上报**。

- [x] 渲染端在每次状态变化时上报：`loading` / `video`（loadeddata）/ `pending`（error 与 4s 超时）/ `svg`
- [x] `reportMedia` 带 `readyState`（视频 ReadyState）与 `visibility`（document.visibilityState）
- [x] 形状只在 `shared.normalizeMediaReport` 收一次：preload 原样转交、主进程收 ipc 时调、
      宿主读 status 时也调（现场就是最后这一道把字段削成三件套的；三处各抄一份白名单，
      加字段时必然漏一处）
- [x] 不可信输入按仓库既有的 fail-closed 规矩收：clip/source 走 `normalizeToken`（空、超长、
      控制字符整条判无效，不截断），readyState 0–4，visibility 只认 visible/hidden/prerender，
      failed 只留最近 16 条
- [x] `at` 只有一个含义：主进程传收到 ipc 的时刻，宿主用上报里带的；缺了就是 `null`
- [x] 单测：坏类型/空串/超长判无效、failed 取最近 16、非对象返回 null、`at` 两种来源、
      status 事件穿过宿主的事件白名单
- [x] 冒烟 helper 段：等 `status.media.source` 落到 `video`（`waitStatus`，不和三只宠物的轮播赛跑）、
      `readyState >= 2`、`visibility === 'visible'`（失败时把窗口自己的 `visible` 一起打出来）
- [x] 修前红：`{"clip":"螃蟹走路","source":"loading","failed":[]}`（macOS 上同样复现，与现场一致）

> 完成情况：渲染端按状态变化上报，主进程与宿主共用一个 `normalizeMediaReport`。
> 冒烟 helper 段 84 项（+2；`source` 那条改成等待，不单独占一条）。诊断字段现在是 `{clip, source, readyState, visibility, failed, at}`。
> 评审（Standards 轴）抓到一处真回归：最初用 `slice()` 截断，把宿主侧 `normalizeToken` 的
> fail-closed 语义换掉了（空串与超长会被洗成合法名字）；已改回 `normalizeToken`，并补了
> 「空串/超长/坏类型」与 `at` 语义两条单测。
> 注意：`media` 是**整只 helper 最近一次**上报（不是每只宠物一份）；每只宠物的实时状态仍在
> `pets[].source` 里（`debug-renderer` / 截图边车）。
