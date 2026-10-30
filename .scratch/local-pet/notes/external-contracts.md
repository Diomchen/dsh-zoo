# 外部契约备忘（实现者用）

两个外部系统要对接：DSH 的插件系统，和已安装的 `dsh-pet`。这里只记"必须遵守的形状"，细节去看源码。

## DSH 插件契约

- 一个 npm 包，两个半边。宿主入口 = `package.json` 的 `exports["."]`；浏览器入口 = `exports["./client"]`，被服务成 `/plugins/<包名>/client.js`。
- 宿主半边导出 `{ name, inject, apply }`。`apply(ctx)` 里做注册，返回的清理函数可选；持久工作要用 `ctx.effect(() => cleanup)`。
- 浏览器半边是**普通脚本**，不是模块：不能 `import`，只能 `window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 里的 `require` 只认平台白名单（`react`、`react/jsx-runtime`、`react-dom/client`）。没有打包器，所以浏览器半边必须是**一个文件**。
- 画到界面上只有一个入口：`ctx.slots.inject('shell.overlay', function* () { yield ctx.slots.register({ name: 'shell.overlay', id, order }, Component) })`。这一层是点穿的，只有显式 `pointer-events: auto` 的元素能收到指针事件。
- 宿主路由：`ctx.webServer.register({ kind: 'exact'|'prefix', path, handler })`，返回清理函数。
- 没有权限表、没有沙箱：装插件 = 完全信任，插件代码就是用户进程。所以不可信输入的处理必须在协议层自己做。
- 参考实现在 `~/.dsh/profiles/desktop/node_modules/dsh-pet`：宿主 `lib/index.js`（`apply` 在 3724 行附近），浏览器 `lib/client.js`（`makeFactory` 在 5673 行）。

## dsh-pet 的对外接口（未承诺，可坏）

前缀 `/dsh-pet-7340`，挂在 DSH 同一个源上，浏览器侧带 cookie 直接 `fetch`。

- `GET /state` → `{ counter, sections: { <name>: { counter, data } }, pets: { <id>: { say: {counter,data}, anim: {counter,data} } } }`。**叶子只在被写过时存在**；`anim` 叶子的 `data` 形如 `{ name, playbackId, ... }`。
- `POST /anim?pet=<id>&surface=web` body `{ name }` → 点播一段动画（会写 `pets.<id>.anim`）。
- `GET /thumb/<素材根>/<动画名>.webm` → 素材本体。主宠物的素材根是 `main`，即 `/dsh-pet-7340/thumb/main/东张西望.webm`。
- 素材目录：`~/.dsh/profiles/desktop/node_modules/dsh-pet/assets/webm/`，106 段 VP9-alpha WebM，文件名就是动画名（中文）。
- 配置：`~/.dsh/dsh-pet/main-config.jsonc`（JSONC，允许注释），`pets[]` 里有 `id/name/display/position`。
- **限制**：随机待机动画不上报 `/state`。所以"跟着对方动作走"只能跟到**被点播过**的动作；其余时间只能自己放待机。

## 本仓库的约定

- 纯 ESM，零依赖，零构建。`npm test` 就是 `node --test`。
- 宿主逻辑按"纯状态机 + 薄外壳"分层：`src/room.js` 是纯的（喂事件、出快照），网络和磁盘在外面。
- 快照形状是客户端唯一契约，写在 `src/room.js` 顶部注释里，改它等于改 UI 契约。
