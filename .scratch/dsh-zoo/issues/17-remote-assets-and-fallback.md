# 17: 远端素材拉取、缓存与通用小人

**What to build:** 接收端按 `skin` 引用拉 manifest 和当前动作，校验后缓存；场景把本地缓存路径给 helper；拿不到就画通用小人。

**Blocked by:** 15, 16

**Status:** done

- [x] 解析顺序：本机素材源 → 缓存 → 远端拉 → fallback
- [x] 只连私网地址；单请求 2s 超时；单文件 ≤8 MB；校验 EBML 魔数；有 hash 必须对
- [x] 缓存 `<dataDir>/skin-cache/<sha256>.webm`；总量 ≤200 MB，LRU 清理
- [x] 场景里每只宠物给 `skin` 或 `fallback` 二选一；helper 支持 `dshzoo://cache/<sha256>.webm`
- [x] 通用小人：名字 + 颜色 + 中性待机 + 语义表情（working / eating / sleeping / idle / other）
- [x] 一个源坏了只影响它自己的访客；串门、记录、其他访客照常

> 完成情况：新增 `src/skin-fetch.js`——只连私网/回环，manifest 256KB / 素材 8MB 上限、2s 超时，
> 只收 WebM 魔数且必须与 manifest 的 sha256 对上；缓存扁平落在 `<dataDir>/skin-cache/<hash>.webm`
>（内容寻址、跨来源共享），超过 200MB 时按 mtime 删最旧；同一来源失败后冷却 60 秒。
> `service.js` 在收到访客心跳/串门请求时异步解析，结果只写 `visitorSkins`，
> `syncDesktop` 同步读它给访客加上 `src` / `fallback`；拉取失败只让这一只变通用小人。
> helper 新增 `dshzoo://cache/<64hex>.webm` 协议根（`--dsh-zoo-cache`，只读、路径夹取），
> renderer 改为「远端 src 优先 → 本机同名 anim → 待机轮播 → SVG」；SVG 通用小人头顶按语义画
> `...` / `yum` / `z` / `?`。测试：`test/skin-fetch.test.js` 6 条，场景 `src`/`fallback`
> 与 argv 各 1 条；真实素材冒烟拉到 `东张西望`（427,005 字节，hash 对得上）；全量 280 条全绿。
