# 04. 跨分镜角色一致性方案

## 问题

漫画本质是**多个分镜**讲一个故事,同一角色要在不同分镜里长相一致(发型、服装、五官)。直接每镜独立出图,角色会"换脸"。

## 三种业界方案对比

| 方案 | 一致性 | 实现难度 | 周期 | 适合场景 |
|---|---|---|---|---|
| **Reference image** | ⭐⭐⭐ | 低 | 立即 | MVP,角色 ≤ 5 个 |
| **LoRA fine-tune** | ⭐⭐⭐⭐⭐ | 高 | 每角色 30-60 分钟训练 | 商业长篇连载 |
| **IP-Adapter** | ⭐⭐⭐⭐ | 中 | 即时 | 中等质量需求 |

## 推荐方案:Reference image(对齐视频工坊)

完全复用 `step-character-anchor.ts`,流程:

```
character_anchor stage
   ↓
每个 character 调 image provider 生成 1 张立绘
   ↓
character.referenceImage = webview URL
   ↓
panel_image stage
   ↓
每镜出图时,把 panel.characterIds 对应的 referenceImage
作为 referenceImages[] 喂给 image provider
```

## Provider 能力矩阵

| Provider | referenceImages 支持 | 备注 |
|---|---|---|
| Seedream 4.0 (Doubao) | ✅ 多图 | 推荐,质量+速度平衡 |
| FLUX (多 reference 扩展) | ✅ 多图 | 高质量但慢 |
| Agnes Image | ✅ 多图 | 免费档限额 |
| SDXL (基础) | ⚠️ 单图 | 不推荐 |

`providerRouter` 已统一了 `referenceImages: string[]` 接口,provider 内部按需转 base64 / URL。

## 单图 vs 三视图

`anchorMode` 选项(已在 video 实现):

- `'single'`:只生成 1 张正面立绘(快、省 token)
- `'turnaround'`:生成 1 张正面 + 三视图(左/右/后),reference 更丰富,质量更好

**漫画推荐 `'turnaround'`**:多角度 reference 让侧脸/背影分镜更准。

## Prompt 模板(对齐 video)

```typescript
function buildPortraitPrompt(c: ComicCharacter, style: string): string {
  return [
    `character reference portrait of ${c.name}`,
    c.appearance,
    'neutral pose, plain background, soft studio lighting',
    'full body visible from head to knee',
    `${style} style`,
    '8k detail, photorealistic',
    'no text, no watermark, no signature',
  ].join(', ');
}
```

直接复用 video 的 `buildSamplePortraitPrompt`。

## Panel 阶段如何用 reference

```typescript
async function generatePanel(panel: PanelSpec, ctx: StageContext) {
  const referenceImages: string[] = [];

  // 主角(出场角色)的立绘都要带上
  for (const cid of panel.characterIds) {
    const char = ctx.workingSpec.characters?.find(c => c.id === cid);
    if (char?.referenceImage) {
      // provider 内部决定是否要 base64 化(Agnes 要,其他不要)
      referenceImages.push(await readAsDataUri(char.referenceImage));
    }
  }

  const response = await providerRouter.generateImage({
    prompt: buildPanelPrompt(panel, ctx.workingSpec.meta.style),
    referenceImages,
    aspectRatio: ctx.workingSpec.meta.aspectRatio,
    style: ctx.workingSpec.meta.style,
    imageTier: 'standard',  // 漫画用 standard 平衡质量和成本
  });

  return { ...panel, imageUrl: await saveAsset(ctx.pid, 'panel', response.imageData, ...) };
}
```

## 多角色同框的处理

一个分镜里 2+ 角色时,referenceImages 数组多张图。Provider 顺序绑定(第 1 张 = 第 1 个角色,第 2 张 = 第 2 个):

```
panel.characterIds = ['alice', 'bob']
referenceImages = [aliceRef, bobRef]

prompt: "Alice and Bob standing in café, Alice smiling holding coffee cup..."
```

**注意:** Provider 对 2+ reference 的支持度不同:
- Seedream 4.0:✅ 良好,角色身份保留度高
- FLUX:✅ 良好但慢
- SDXL:❌ 容易混淆

providerRouter 内部会按 tier 路由,用户在设置里改 endpoint 即可切换。

## 角色未生成 anchor 的 fallback

如果 `character_anchor` stage 被跳过(用户禁用)或某角色 anchor 失败:
- panel_image 时 **不带 referenceImages**
- 出图完全靠 prompt 文字描述
- 一致性差,但不阻塞流程

UI 在 stage 详情里高亮提示:"角色 X 缺少 anchor,分镜一致性可能下降"。

## Phase 3 增强:跨页一致性

长篇漫画(20+ 页)同一角色可能因为 referenceImage 重复使用导致 provider "审美漂移"。Phase 3 方案:

1. 每 5-10 页重新生成一次 anchor(用第 1 页的成图作为新 reference)
2. 把用户最满意的某镜成图手动"提升为 anchor"(右键菜单)
3. 同一场景的成图也作为下一镜的 reference(场景一致性)

详细 Phase 3 再展开。

## 与视频工坊的差异

| 维度 | 视频 | 漫画 |
|---|---|---|
| 用 anchor 的 stage | keyframe_image + video_generation | panel_image |
| anchor 形态 | 单图或三视图 | 推荐三视图(更多角度) |
| reference 数量 | 通常 1(主角) | 可能 2-3(多角色同框) |
| 一致性容忍度 | 中(动起来看不清细节) | 高(静态画面细节明显) |

## 结论

Phase 1 直接复用 video 工坊的 `step-character-anchor`,**零代码改动**。
Phase 2/3 根据实际效果决定是否加 LoRA / IP-Adapter。
