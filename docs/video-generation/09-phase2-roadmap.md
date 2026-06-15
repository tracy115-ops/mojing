# 09 — Phase 2 路线图：真实感提升

**目标**：第一镜头就能让人想看下去
**预计周期**：2-3 周

## 核心改造

### 1. 启用 character_anchor 阶段 ⭐⭐⭐

详细方案见 [06-character-consistency.md](./06-character-consistency.md)。

**实现步骤**：

1. 新增 `FluxProvider` adapter（`src/services/providers/image-adapters.ts`）
   ```ts
   export class FluxProvider extends BaseImageProvider {
     readonly providerId = 'flux';
     async generate(req: ImageGenerateRequest): Promise<ImageGenerateResponse> {
       // POST /v1/flux-2/generate
       // body: { prompt, reference_images, aspect_ratio, seed }
     }
   }
   ```

2. 在 `pipeline.ts` 新增 `runCharacterAnchor()`
   - 从 NovelBible 读完整角色卡
   - 给每个主要角色生成锚定图（首次）
   - 写入 `videoStore.anchorImages`

3. UI：在 VideoGeneratorModal 新增"角色锚定"面板
   - 显示已生成的锚定图缩略图
   - 允许重新生成单个角色
   - 允许用户上传自定义锚定图（重要：用户已有角色立绘时）

### 2. 启用 storyboard_image 阶段 + 人工 checkpoint ⭐⭐⭐

**实现步骤**：

1. 在 `pipeline.ts` 新增 `runStoryboardImage()`
   - 调 FluxProvider，传入在场角色锚定图作为 referenceImages
   - 写入 `shot.storyboardImageUrl`

2. 新增 `StoryboardReviewModal.tsx`
   - 展示所有分镜图网格
   - 每张图支持：确认 / 重新生成 / 编辑 prompt / 上传替换
   - 全部确认后 pipeline 继续 video_generation

3. 修改状态机
   ```ts
   // storyboard_image 完成后
   store.setStageStatus(novelId, 'storyboard_image', 'awaiting_review');
   // 等用户在 UI 点"全部确认"
   // → 'completed'
   // → pipeline 继续
   ```

### 3. I2V 替代 T2V ⭐⭐

`generateOneClip()` 改造：

```ts
private async generateOneClip(shot, spec): Promise<GeneratedClip> {
  const referenceImages: string[] = [];
  if (shot.storyboardImageUrl) {
    referenceImages.push(shot.storyboardImageUrl);
  }

  const response = await providerRouter.generateVideo({
    taskType: 'clip',
    prompt: shot.videoPrompt,
    model: tierToDefaultModel(spec.videoTier),
    referenceImages,  // ← 关键：I2V
    width, height,
    durationSeconds: shot.durationSeconds,
    fps: spec.fps,
  });
  // ...
}
```

Kling / Runway / Seedance 都支持 I2V（referenceImages[0] 作为首帧）。

### 4. 多 Provider 路由 ⭐⭐

新增 Seedance adapter（`src/services/providers/video-adapters.ts`）：

```ts
export class SeedanceProvider extends BaseVideoProvider {
  readonly providerId = 'seedance';

  async generate(req: VideoGenerateRequest): Promise<VideoGenerateResponse> {
    // 字节豆包视频 API
    // POST https://ark.cn-beijing.volces.com/api/v3/content/generation
    // 支持 native audio（req.audioPrompt）
  }
}
```

更新 `tierToDefaultModel()`：

```ts
case 'quality':  return 'seedance-2-pro';  // 原生音频
case 'premium':  return 'veo-3.1';         // 顶级画面 + 音频
```

### 5. 原生音频检测 ⭐

部分模型（Seedance 2.0 / Veo 3.1 / Sora 2）支持原生音频。

```ts
// 在 generateOneClip 里
const response = await providerRouter.generateVideo({
  // ...
  audioPrompt: shot.dialogue?.map(d => d.text).join(' '),  // 让模型生成对话音频
});

return {
  // ...
  hasAudio: response.audioData !== undefined,  // 新字段
};
```

`hasAudio=true` 的 clip 跳过 TTS 阶段。

## 数据结构变更

### VideoProjectState 新增字段

```ts
// src/types/video.ts

export interface StoryboardShot {
  // ... 原有字段
  storyboardImageUrl?: string;  // Phase 2: 分镜关键帧图
}

// CharacterAnchor 已在 Phase 1 定义，Phase 2 启用
```

### VideoGenerateResponse 扩展

```ts
// src/types/providers.ts

interface VideoGenerateResponse {
  // ... 原有字段
  audioData?: string;  // Phase 2: 原生音频 URL
}
```

## UI 变更

### VideoGeneratorModal 增强

新增"角色锚定"折叠面板：

```
[+] 角色锚定（5 个角色）
    [缩略图][缩略图][缩略图][缩略图][缩略图]
    [重新生成] [上传自定义]

[+] 分镜审核（12 个分镜图）
    网格视图：每张支持 确认/重生成/编辑/替换
    [全部确认] → 继续
```

## 性能预估

| 步骤 | Phase 1 | Phase 2 |
|------|---------|---------|
| 切片 | <1s | <1s |
| 分镜 prompt | 10s | 10s |
| **角色锚定** | - | 30s（5 角色） |
| **分镜图** | - | 60s（12 图） |
| 视频生成 | 5min | 6min（I2V 略慢于 T2V） |
| 合成 | 5s | 5s |
| **合计** | ~6min | **~8min** |

成本从 ~6 元/章 → ~50 元/章（角色锚定 + 分镜图 + I2V）。

## 风险与缓解

### 风险 1：FLUX.2 API 不稳定

**缓解**：实现 fallback 到 Seedream 4.0 Pro（国产、稳定）

### 风险 2：分镜图审核打断流程

**缓解**：默认跳过审核（用户配置 `autoApproveStoryboard: true`），有问题的分镜靠单镜头重生成修复

### 风险 3：I2V 不如 T2V 自然

部分场景下 I2V 会让动作僵硬。
**缓解**：在 `videoTier: 'premium'` 时混合使用——静态镜头用 I2V（一致性优先），动作戏用 T2V（动态优先）

## 优先级排序

按 ROI 排：

1. **角色锚定 + I2V**（最大价值，~1 周）
2. **多 Provider 路由**（解锁 Seedance 原生音频，~3 天）
3. **分镜图审核 UI**（提升用户控制感，~4 天）
4. **原生音频检测**（小优化，~1 天）

## Phase 2 验收标准

- [ ] 同一角色在 10+ 镜头中外貌一致（用户盲测 ≥80% 识别为同一人）
- [ ] 单个分镜图可重新生成不影响其他
- [ ] 角色锚定图复用（同小说跨章节不重生成）
- [ ] Seedance 至少一个 tier 可用
- [ ] 总耗时 <10 分钟/章
