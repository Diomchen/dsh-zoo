# 15: 对外素材源

**What to build:** dsh-zoo 自己起一个只读 HTTP 素材源，绑 `0.0.0.0`，端口随 beacon 的 `skinPort` 广播；只暴露 manifest 和白名单内的 WebM。

**Blocked by:** 14

**Status:** done

- [x] `GET /dsh-zoo-skin/manifest` 回当前素材源的 manifest（含每个文件的 sha256 与 manifest 级 hash）
- [x] `GET /dsh-zoo-skin/asset/<name>` 回 WebM，支持 Range；目录穿越、非白名单、非 `.webm` 一律 404
- [x] 默认端口 `45873`，被占就 +1 重试（最多 10 个）；`DSH_ZOO_SKIN_PORT` 可覆盖
- [x] 只读、不列目录；单文件超过 8 MB 拒绝
- [x] 端口没起来时 beacon 不带 `skinPort`，发现/串门/桌面都不受影响

> 完成情况：新增 `src/skin-server.js`——只读 HTTP，路由是
> `/dsh-zoo-skin/manifest`、`/dsh-zoo-skin/asset/<动作>`，多源时多一段 `<源 id>/`；
> 动作 id 只在源登记表里查，不拼用户路径。manifest 首次请求时给每个文件算 sha256（本机 106 段约 52MB，
> 一次性、之后缓存），asset 支持单区间 Range 与 416。端口从 `45873` 起向后找，全占返回 `null`。
> `service.js` 在 discovery 之前 `await startSkinSource()`：加载注册表、起服务、把端口与源 id 记进
> `skinRef`；discovery 每拍现取 `skin() => skinRef`，起不来就不带字段。`test/skin-server.test.js`
> 8 条，`test/discovery.test.js` 新增 1 条（beacon 先不带、源起来后带）——全量 271 条全绿。
> 接线后，`guests.test.js` / `visit-e2e.test.js` 的通用 setup 显式 `skinServer: false`，避免单测抢真实端口。
