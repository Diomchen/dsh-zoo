# 37: 一个按钮，把 dsh-pet 的宠物包加进「外观」

**What to build:** 右键菜单多一项「扫描外观」。点一下，扫 dsh-pet 的宠物包目录，把 `skin.json`
里还没有的素材追加进去，冒一句「加入 N 张：…」。不点就什么都不发生。

**Blocked by:** 32（换皮）、34（重载注册表）

**Status:** done

来由：2026-11-05。装了 `maodie-pet` 之后，`~/.dsh/dsh-pet/pet/maodie-animation` 里躺着 32 段
猫动作，但 dsh-zoo 只认 `skin.json`，得手写一条 `dirs` + `size` + `idle`。用户的原话是
"我不想手动输入命令这些东西"。

选按钮而不是自动扫描，因为自动扫描加进去的东西**删不掉**（要补 `hiddenSkins` 才闭环）、会和
dsh-pet 的 `display: none` 打架、还会把优先级从两方变三方。按钮版把这些全部绕开：
**它写的是 `skin.json`，删一行就没了。**

## 扫描规则（照 dsh-pet 的内部布局，只读）

`$DSH_HOME/dsh-pet/pet/<前缀>-config.json(c)` 与 `<前缀>-animation/`：

| 字段 | 来源 | 缺省 |
|---|---|---|
| `id` | `pets[0].id`，不合法退回目录前缀 | 跳过 |
| `size` | `pets[0].size` | 不写（按 462） |
| `idle` | `animations.idle[0]` | 不写（回落待机呼吸休闲） |
| `dirs` | `<前缀>-animation/`，至少要有一段 webm | 跳过 |

`pets[0].display === 'none'` 的包直接跳过——主人关掉的宠物不该被拽回来。

- [x] `src/dsh-pet-pets.js`：纯函数 `discoverPetPacks`，fs 全注入，坏配置只跳过自己
- [x] 去重按 **id 和目录** 两个维度：同一个素材目录被手写成别的 id（现场就有 `maodie-pet`
      和扫出来的 `maodie` 指同一目录），再按 id 判会多出一条重复外观
- [x] `src/skin-sources.js`：`appendSkinSources` 只做加法（同 id 跳过），保留文件原有形状
      （裸数组还是 `{ sources }`），坏 JSON 抛出去不覆盖
- [x] `service`：`scan-skins` 动作；扫完立刻 `loadSkin()` + 重建菜单与场景，不用再按重载
- [x] 菜单：一级工具项「扫描外观」（**不能**放「外观」子菜单——只有两张皮以上才出现，
      而装完素材包那一刻正好只有一张）
- [x] 成功也要能说话：`handleDesktopAction` 现在把成功结果里的 `notice` 一并回给渲染端
- [x] 错误语义：`skin-file-broken`（`skin.json` 坏了）/ `scan-failed`
- [x] 单测：扫描器 6 条（含 BOM、jsonc、display:none、坏目录）、服务 3 条（写入 + 幂等、
      坏文件不覆盖、同目录不同 id 不加）
- [x] 全量测试全绿（521 项）

> 不做：自动扫描（见上）；扫描「移除」（减法仍是删 `skin.json` 一行）；扫 `main-animation/webm`
> （那是自动主皮，已经认）。

> 验收：装一个带 `pet/<x>-animation` 的素材包 → 右键「扫描外观」→「外观」里多出它 →
> 点一下就能切；再点一次扫描只回「没有发现新的素材包」。
