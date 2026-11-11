# dsh-zoo · IP 吉祥物出图 prompt（ip-as-logo）

六张：`A1 A2 B1 B2 C1 C2`，三个方向各两张。
用法：每次调用生成**一张**，`1:1`、目标 `1536 × 1536`（服务上限 `1254 × 1254` 也可直接收）。
不要把六张塞进一次调用，也不要让模型拼接触表/九宫格。

- 模型：GPT Image 2 优先；Seedance 5.0 Pro / Nano Banana Pro / Nano Banana 2 亦可
- 约束投递：现代指令型模型用 prompt 内的 `Constraints:` 行，**不要**另发 negative prompt
- 全部从**左下角**探入，占画布 85–95%，直立，不居中

| 编号 | 方向 | IP 两色 | 背景 |
| --- | --- | --- | --- |
| A1 / A2 | 圆耳朵柯基幼犬 | 奶茶白 `#F6EDE0` + 焦糖棕 `#C68B54` | 鼠尾草绿 `#8FA58C` |
| B1 / B2 | 蹲坐的橘猫 | 橘 `#E98A45` + 奶油 `#F7E9D2` | 灰蓝 `#7C8FA6` |
| C1 / C2 | 宽围巾小水獭 | 深可可 `#6B4A3A` + 芥末黄 `#D9A43F` | 雾霾青 `#6E9491` |

---

## A1 · 圆耳朵柯基幼犬（标准裁切，带一只搭边圆爪）

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted sage green (#8FA58C). Keep muted sage green visible in every open area and in the corners not occupied by the character; the lower-left corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby corgi puppy on the background, reduced to one soft rounded continuous silhouette and one defining feature: two broad round-tipped ears. The puppy has a wide, large head, soft cheeks, two small simple eyes, one tiny mouth, and one blunt rounded paw resting over the lower-left edge of the frame, looking calmly out of the frame.
Complexity: use only 4 to 7 large basic shapes and at most two broad internal color regions. Remove every nonessential line, outline, anatomical detail, whisker, fur tuft, texture, and decoration. Keep the character readable at 32 x 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. Use milk white (#F6EDE0) for the head, body and paw, and caramel brown (#C68B54) as one continuous region covering both ears and the muzzle patch; reuse caramel brown for the two eyes and the tiny mouth. Lower the background saturation slightly so the sage green feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the character, its marks, and the background clearly separated.
Composition: keep the character upright and emerging from the lower-left corner, filling about 85 to 95 percent of the square so it remains visually dominant. Cropping at the bottom and left side is welcome when it strengthens the corner emergence. Preserve both ears fully visible inside the frame, and never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

## A2 · 圆耳朵柯基幼犬（更近的裁切，无嘴，最简化）

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted sage green (#8FA58C). Keep muted sage green visible in every open area and in the corners not occupied by the character; the lower-left corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby corgi puppy on the background, reduced to one soft rounded continuous silhouette and one defining feature: two broad round-tipped ears reaching into the upper third of the frame. Use a noticeably closer crop: the wide round head fills most of the square, both ears are fully visible, and only a hint of the chest shows at the bottom edge. The face has two small simple eyes and no mouth.
Complexity: use only 4 to 7 large basic shapes and at most two broad internal color regions. Remove every nonessential line, outline, anatomical detail, whisker, fur tuft, texture, and decoration. Keep the character readable at 32 x 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. Use milk white (#F6EDE0) for the head and chest, and caramel brown (#C68B54) as one continuous region covering both ears and a small muzzle patch; reuse caramel brown for the two eyes. Lower the background saturation slightly so the sage green feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the character, its marks, and the background clearly separated.
Composition: keep the character upright and emerging from the lower-left corner, filling about 85 to 95 percent of the square so it remains visually dominant. Cropping at the bottom and left side is welcome when it strengthens the corner emergence. Preserve both ears fully visible inside the frame, and never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

---

## B1 · 蹲坐的橘猫（尾巴绕到右侧，胸前奶油色）

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted slate blue (#7C8FA6). Keep muted slate blue visible in every open area and in the corners not occupied by the character; the lower-left corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing sitting orange tabby cat on the background, reduced to one soft rounded continuous silhouette and one defining feature: one thick rounded tail with a blunt tip curling up on the right side. The cat sits upright with a large round head, two broad round-tipped ears, a cream muzzle patch, a cream chest, two small simple eyes, and one tiny mouth, looking calmly at the viewer.
Complexity: use only 4 to 7 large basic shapes and at most two broad internal color regions. Remove every nonessential line, outline, stripe, whisker, fur tuft, anatomical detail, texture, and decoration. Keep the character readable at 32 x 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. Use warm orange (#E98A45) for the head, body, ears and tail, and cream (#F7E9D2) as one continuous region covering the muzzle and the chest; reuse orange for the two eyes and the tiny mouth. Lower the background saturation slightly so the slate blue feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the character, its marks, and the background clearly separated.
Composition: keep the character upright and emerging from the lower-left corner, filling about 85 to 95 percent of the square so it remains visually dominant. Cropping at the bottom and left side is welcome when it strengthens the corner emergence. Preserve both ears and the rounded tail tip inside the frame, and never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

## B2 · 蹲坐的橘猫（脸部近景，无尾巴、无嘴）

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted slate blue (#7C8FA6). Keep muted slate blue visible in every open area and in the corners not occupied by the character; the lower-left corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing sitting orange tabby cat on the background, reduced to one soft rounded continuous silhouette and one defining feature: two broad round-tipped ears. Use a close face crop: the large round head fills most of the square, the cream muzzle sits low on the face, and only the top of a cream chest shows at the bottom edge. The face has two small simple eyes and no mouth.
Complexity: use only 4 to 7 large basic shapes and at most two broad internal color regions. Remove every nonessential line, outline, stripe, whisker, fur tuft, anatomical detail, texture, and decoration. Keep the character readable at 32 x 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. Use warm orange (#E98A45) for the head, body and ears, and cream (#F7E9D2) as one continuous region covering the muzzle and the chest; reuse orange for the two eyes. Lower the background saturation slightly so the slate blue feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the character, its marks, and the background clearly separated.
Composition: keep the character upright and emerging from the lower-left corner, filling about 85 to 95 percent of the square so it remains visually dominant. Cropping at the bottom and left side is welcome when it strengthens the corner emergence. Preserve both ears fully visible inside the frame, and never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

---

## C1 · 宽围巾小水獭（围巾横过胸口，垂下一段）

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted dusty teal (#6E9491). Keep muted dusty teal visible in every open area and in the corners not occupied by the character; the lower-left corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby otter on the background, reduced to one soft rounded continuous silhouette and one defining feature: one broad mustard scarf band across the chest with a short blunt hanging end. The otter has a wide, low, round head, two small round ears, a large mustard muzzle patch, two small simple eyes, and one tiny mouth, looking up calmly.
Complexity: use only 4 to 7 large basic shapes and at most two broad internal color regions. Remove every nonessential line, outline, whisker, fur detail, anatomical detail, texture, and decoration. Keep the character readable at 32 x 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. Use deep cocoa brown (#6B4A3A) for the head, body and ears, and mustard yellow (#D9A43F) as one continuous region on the muzzle, reused for the scarf band across the chest; reuse cocoa brown for the two eyes and the tiny mouth. Lower the background saturation slightly so the dusty teal feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the character, its marks, the scarf, and the background clearly separated.
Composition: keep the character upright and emerging from the lower-left corner, filling about 85 to 95 percent of the square so it remains visually dominant. Cropping at the bottom and left side is welcome when it strengthens the corner emergence. Preserve both ears and the scarf end inside the frame, and never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```

## C2 · 宽围巾小水獭（围巾更低、脸更大，带嘴）

```text
Create one complete full-bleed 1:1 square image.
Background: fill the entire square with solid muted dusty teal (#6E9491). Keep muted dusty teal visible in every open area and in the corners not occupied by the character; the lower-left corner must be occupied by the character.
Subject: place one extremely simplified, cute, endearing baby otter on the background, reduced to one soft rounded continuous silhouette and one defining feature: one broad mustard scarf band sitting lower across the chest with a short blunt hanging end. Use a closer crop: the wide low head is larger, two small round ears sit high, the mustard muzzle patch is wide, and the scarf band cuts across the lower third. The otter has two small simple eyes and one tiny mouth.
Complexity: use only 4 to 7 large basic shapes and at most two broad internal color regions. Remove every nonessential line, outline, whisker, fur detail, anatomical detail, texture, and decoration. Keep the character readable at 32 x 32.
Color behavior: use exactly three semantic colors in the complete image: exactly two IP base colors plus the background color. Use deep cocoa brown (#6B4A3A) for the head, body and ears, and mustard yellow (#D9A43F) as one continuous region on the muzzle, reused for the scarf band across the chest; reuse cocoa brown for the two eyes and the tiny mouth. Lower the background saturation slightly so the dusty teal feels gently muted and restrained while remaining clearly chromatic, clean, and intentional rather than gray or muddy. Keep the character, its marks, the scarf, and the background clearly separated.
Composition: keep the character upright and emerging from the lower-left corner, filling about 85 to 95 percent of the square so it remains visually dominant. Cropping at the bottom and left side is welcome when it strengthens the corner emergence. Preserve both ears and the scarf end inside the frame, and never center or bottom-center the character.
Style: make simplification, cuteness, and lovable baby-like appeal the strongest qualities. Use large soft forms, compact proportions, thick rounded contours, and an ultra-clean graphic treatment. Prefer one clear shape over several explanatory details. Add an extremely, extremely subtle, almost imperceptible sense of depth through a barely-there neo-skeuomorphic treatment.
Finish: show only the character on the full-canvas background, with clean surfaces and normal square outer corners.
Constraints: Use no text or watermark. Add no borders, frames, cards, or presentation masks. Include one character only, with no extra subjects or scenery. Use no fragile lines, sharp tips, unnecessary outlines, tiny details, or decorative marks. Add no photorealistic material, dramatic bevel, glossy hotspot, deep occlusion, extrusion, strong three-dimensional rendering, or external cast shadow. Keep the background solid and uniform, with no texture, vignette, or lighting variation.
```
