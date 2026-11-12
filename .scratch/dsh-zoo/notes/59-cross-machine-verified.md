# 票 59 跨机验收记录（2026-11-13 00:56）

对象：本机（爸爸，macOS）↔ `DESKTOP-699DN63`（鱼姐，Windows，10.10.10.110）。
只对这台机器单播，没有广播或扫网段。

## 1. 两边都跑 1.4.0

```
PEER {"nickname":"爸爸","caps":["raid","look","crops"],
      "crops":{"v":1,"hash":"5aeb15d0c5e2d292","count":6}}     ← 本机自探
PEER {"nickname":"鱼姐","caps":["raid","look","crops"],
      "crops":{"v":1,"hash":"5aeb15d0c5e2d292","count":6}}     ← 对面
```

两边都是内置六种，指纹一致（`5aeb15d0c5e2d292`），说明 1.4.0 都已生效。

## 2. 本机加一种作物（不重启）

`~/.dsh/dsh-zoo/crops.json` + `crops/blueberry.svg` 写入后 4 秒：

```
本地 crops = {'hash': 'b1c1ccd45a3037e9', 'count': 7}
```

热加载生效：6 → 7，指纹变，**没有重启 DSH**。

## 3. 对面自动收敛

```
node scripts/verify-catalog-sync.mjs desktop-699dn63.local --local http://127.0.0.1:53485
· 对面 鱼姐 caps=["raid","look","crops"] 指纹=b1c1ccd45a3037e9（7 种）
✓ 两边目录指纹一致：b1c1ccd45a3037e9
```

（前几次探测因对面 UDP 偶尔丢包没有响应，最后一次读到收敛后的指纹。）

## 4. 图也过去了

本地 `crop-art/7c2e42ebebf1b79b.svg`（sha256 `7c2e42eb…cd614`，312 B）与
`GET http://10.10.10.110:45873/dsh-zoo-crops/7c2e42ebebf1b79b.svg` 取回的字节**完全一致**
（HTTP 200 / 312 B / 同一 sha256）——对面按内容哈希缓存成功。

## 结论

beacon 指纹 → `crop-catalog-request` → `crop-catalog` 分片 → 合并去重 → 落盘 →
按哈希取图，整条链路在真实的两台机器、两个系统之间跑通。
