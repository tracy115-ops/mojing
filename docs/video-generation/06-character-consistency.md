# 06 — 角色一致性方案

## 核心问题

AI 视频最致命的问题：**同一角色在不同镜头里长得完全不一样**。

小说里有"林晚"，第 1 镜头是短发白 T 恤，第 2 镜头变长发红裙子，第 3 镜头变大叔。视频看起来像精神分裂。

## 三种主流解决方案

### 方案 A：FLUX.2 多参考图（推荐 Phase 2）

**原理**：FLUX.2（Black Forest Labs）支持 `referenceImages[]` 参数，把"角色锚定图"传入，模型在生成新图时强制保持角色外貌一致。

**流程**：
1. 小说开始时，先用 FLUX.2 给每个主要角色生成一张"锚定图"（baseline portrait）
2. 之后每个分镜图生成时，传入该镜头在场角色的锚定图
3. 分镜图作为 I2V 的首帧，保证视频里角色一致

**API 草案**（Phase 2 待实现）：

```ts
// 1. 生成角色锚定图
const anchor = await providerRouter.generateImage({
  taskType: 'character_anchor',
  prompt: `cinematic portrait of ${character.name}, ${character.appearance}, ${character.clothing}, 
           neutral background, soft studio lighting, 8k detail`,
  model: 'flux-2',
  referenceImages: [],  // 首次无参考
  aspectRatio: '1:1',
});

// 存到 videoStore
videoStore.addAnchorImage(novelId, {
  characterId: character.id,
  imageUrl: anchor.imageUrl,
  seed: anchor.seed,
  promptUsed: prompt,
  generatedAt: now(),
});

// 2. 生成带角色一致性的分镜图
const storyboard = await providerRouter.generateImage({
  taskType: 'storyboard',
  prompt: shot.imagePrompt,
  model: 'flux-2',
  referenceImages: shot.characters.map(cid =>
    videoStore.getAnchorImage(novelId, cid).imageUrl
  ),  // ← 多参考图，FLUX.2 会强制保持一致
  aspectRatio: '16:9',
});
```

**优点**：质量高，业界主流做法
**缺点**：每镜头多一次 T2I 调用，成本翻倍

### 方案 B：Seed/Midjourney cref

**原理**：用同一 seed 保证可复现性，或用 Midjourney 的 `--cref` 参数。

**适用**：纯 T2V（不生成中间分镜图）的简化流程。

**局限**：跨模型跨平台不通用，FLUX/Kling 不一定支持。

### 方案 C：LoRA 训练（重量级）

**原理**：用角色锚定图 fine-tune 一个 LoRA，之后所有生成都用这个 LoRA。

**优点**：一致性最强
**缺点**：训练成本高（每角色 ~10 分钟 + 算力），用户操作复杂。**Phase 4+ 才考虑**。

## Phase 2 推荐路径：方案 A

### 实现步骤

#### Step 1：识别在场角色

`chapter-slicer.ts` 已经做了基础识别（基于对话标记）。Phase 2 增强：

```ts
// 从 NovelBible（小说家神殿）读完整角色卡
function getCharactersForShot(shot: StoryboardShot, bible: NovelBible): Character[] {
  return shot.characters
    .map(name => bible.characters.find(c => c.name === name))
    .filter(Boolean);
}
```

#### Step 2：为每个主要角色生成锚定图

新 stage：`character_anchor`

```ts
// pipeline.ts 新增
private async runCharacterAnchor(): Promise<void> {
  const store = useVideoStore.getState();
  const project = store.getProject(this.input.novelProjectId);
  const bible = loadNovelBible(this.input.novelProjectId);

  // 找出本章涉及的所有主要角色
  const allCharacters = new Set<string>();
  project.shots.forEach(s => s.characters.forEach(c => allCharacters.add(c)));

  for (const charId of allCharacters) {
    const character = bible.characters.find(c => c.id === charId);
    if (!character) continue;

    // 已存在锚定图则跳过
    if (project.anchorImages.some(a => a.characterId === charId)) continue;

    const prompt = buildAnchorPrompt(character);  // 见下
    const result = await providerRouter.generateImage({
      taskType: 'character_anchor',
      prompt,
      model: 'flux-2',
      referenceImages: [],
      aspectRatio: '1:1',
    });

    store.addAnchorImage(this.input.novelProjectId, {
      characterId: charId,
      imageUrl: result.imageUrl,
      seed: result.seed,
      promptUsed: prompt,
      generatedAt: new Date().toISOString(),
    });
  }
}

function buildAnchorPrompt(c: Character): string {
  return [
    'Cinematic character portrait, full body',
    `Name: ${c.name}`,
    `Age: ${c.age}`,
    `Appearance: ${c.appearance}`,
    `Clothing: ${c.clothing}`,
    `Personality expression: ${c.personality}`,
    'Neutral studio background, soft lighting, 8k detail, photorealistic',
  ].join(', ');
}
```

#### Step 3：生成带一致性的分镜图

新 stage：`storyboard_image`

```ts
private async runStoryboardImage(): Promise<void> {
  const project = store.getProject(this.input.novelProjectId);

  for (const shot of project.shots) {
    const refs = shot.characters
      .map(cid => project.anchorImages.find(a => a.characterId === cid)?.imageUrl)
      .filter(Boolean) as string[];

    const result = await providerRouter.generateImage({
      taskType: 'storyboard',
      prompt: shot.imagePrompt || shot.videoPrompt,
      model: 'flux-2',
      referenceImages: refs,  // ← 多参考图
      aspectRatio: project.spec.aspectRatio,
    });

    store.updateShot(this.input.novelProjectId, shot.id, {
      storyboardImageUrl: result.imageUrl,  // 新增字段
    });
  }
}
```

#### Step 4：I2V 替代 T2V

`generateOneClip()` 改造：

```ts
const response = await providerRouter.generateVideo({
  taskType: 'clip',
  prompt: shot.videoPrompt,
  model: tierToDefaultModel(spec.videoTier),
  referenceImages: shot.storyboardImageUrl ? [shot.storyboardImageUrl] : [],
  // ...其他参数
});
```

Kling / Runway / Seedance 都支持 I2V（referenceImages[0] 作为首帧）。

### 人工审核 checkpoint

在 `storyboard_image` 完成后插入：

```ts
store.setStageStatus(novelId, 'storyboard_image', 'awaiting_review');
// UI 弹出"分镜图审核"对话框
// 用户确认或修改单个分镜图后 → status 改回 'completed'
// pipeline 才继续 video_generation
```

## 性能与成本

| 步骤 | 调用次数 | 单价 | 一章成本（5 角色 + 12 镜头） |
|------|---------|------|---------------------------|
| 角色锚定图 | 5 × T2I | ~$0.05/张 | $0.25 |
| 分镜图 | 12 × T2I（多参考） | ~$0.10/张 | $1.20 |
| I2V | 12 × I2V | ~$0.5/段 | $6.00 |
| **合计** | | | **~$7.45**（约 50 元） |

vs Phase 1 纯 T2V ~6 元，**成本上升 8 倍**，但画面质量天差地别。

## 失败回退

如果 FLUX.2 不可用或成本超预算，可降级到方案 B：

```ts
async function generateWithConsistencyFallback(shot, spec) {
  try {
    // 优先 I2V
    return await generateI2V(shot);
  } catch {
    // 降级 T2V + 强 prompt 描述角色
    return await generateT2VWithStrongCharacterDesc(shot);
  }
}
```

## 角色锚定图的复用

**重要优化**：同一小说的角色锚定图只需生成一次。

```ts
// videoStore.ts
addAnchorImage: (novelProjectId, anchor) => {
  // characterId 已存在则覆盖（用户可能重新生成）
  // 持久化策略：可选 localStorage 缓存，按 novelId 隔离
}
```

跨章节生成视频时复用同一组锚定图，整个小说只需生成一次角色形象。
