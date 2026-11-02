# 15: 对外素材源

**What to build:** local-pet 自己起一个只读 HTTP 素材源，绑 `0.0.0.0`，端口随 beacon 的 `skinPort` 广播；只暴露 manifest 和白名单内的 WebM。

**Blocked by:** 14

**Status:** todo

- [ ] `GET /local-pet-skin/manifest` 回当前素材源的 manifest（含 hash）
- [ ] `GET /local-pet-skin/asset/<name>` 回 WebM，支持 Range；目录穿越、非白名单、非 `.webm` 一律 404
- [ ] 默认端口 `45873`，被占就 +1 重试（最多 10 个）；`LOCAL_PET_SKIN_PORT` 可覆盖
- [ ] 只读、不列目录；单文件超过 8 MB 拒绝
- [ ] 端口没起来时 beacon 不带 `skinPort`，发现/串门/桌面都不受影响

> 注意：DSH 的 webServer 只绑 `127.0.0.1`，不能复用它对外供源。这个服务是 local-pet 自己的 TCP 端口。
