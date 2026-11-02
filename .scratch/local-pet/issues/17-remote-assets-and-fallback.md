# 17: 远端素材拉取、缓存与通用小人

**What to build:** 接收端按 `skin` 引用拉 manifest 和当前动作，校验后缓存；场景把本地缓存路径给 helper；拿不到就画通用小人。

**Blocked by:** 15, 16

**Status:** todo

- [ ] 解析顺序：本机素材源 → 缓存 → 远端拉 → fallback
- [ ] 只连私网地址；单请求 2s 超时；单文件 ≤8 MB；校验 EBML 魔数；有 hash 必须对
- [ ] 缓存 `<dataDir>/skin-cache/<source>/<sha256>.webm`；总量 ≤200 MB，LRU 清理
- [ ] 场景里每只宠物给 `skin` 或 `fallback` 二选一；helper 支持 `localpet://cache/<sha256>.webm`
- [ ] 通用小人：名字 + 颜色 + 中性待机 + 语义表情（working / eating / sleeping / idle / other）
- [ ] 一个源坏了只影响它自己的访客；串门、记录、其他访客照常

> helper 不联网。拉取全在宿主侧完成，helper 只读本地文件。
