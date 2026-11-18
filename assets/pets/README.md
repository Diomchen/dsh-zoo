# 示意图里的宠物帧

README 里的示意图是 SVG，里面的宠物不是画的，是从 `dsh-pet` 的真实动画（透明 WebM）里截的一帧，
裁掉透明边、缩到展示尺寸后用 data URI 嵌进 `assets/screens/*.svg`。

| 文件 | 用途 | 来源 |
| --- | --- | --- |
| `maid-idle.png` | `desktop.svg` / `menu.svg` / `pets.svg` | `dsh-pet` 的「待机呼吸休闲」 |
| `maid-code.png` | `pets.svg` | `dsh-pet` 的「写代码」 |
| `maid-sleep.png` | `pets.svg` | `dsh-pet` 的「睡觉-循环」 |
| `maid-gift.png` | `gift.svg` | `dsh-pet` 的「拆礼物」 |
| `cat-idle.png` | `desktop.svg` / `gift.svg` / `pets.svg` | `maodie-pet` 的「待机」 |

重新截帧的办法：用 Electron 开一扇透明窗口，`<video>` 播 `~/.dsh/profiles/<profile>/node_modules/dsh-pet/assets/webm/<动作>.webm`，
等到想要的时刻 `capturePage()` 存 PNG，再按 alpha 边界裁剪、缩放到目标高度（2× 显示尺寸）即可。
这台机器上用的是 `~/.dsh/electron/Electron.app`。

## 版权

宠物素材来自 [`PC2005-cloud/dsh-pet`](https://github.com/PC2005-cloud/dsh-pet) 与
[`Edwardpch/maodie-pet`](https://github.com/Edwardpch/maodie-pet)，版权归原作者。素材**禁止商用**，
二创在公开渠道须署名。它们**不在**本仓库的 MIT 许可证范围内，只用于 README 展示。
