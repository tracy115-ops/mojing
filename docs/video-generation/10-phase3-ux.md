# 10 — Phase 3 路线图：UX 打磨

**目标**：用户能微调成自己满意的样子
**预计周期**：2 周

## 核心改造

### 1. 分镜编辑台 ⭐⭐⭐

让用户在生成前/后都能改 prompt。

**UI 设计**：

```
┌─ 分镜编辑台 ─────────────────────────────────────┐
│ [镜头 1/12]  [上一镜] [下一镜] [新建] [删除]    │
├─────────────────────────────────────────────────┤
│ 原文（只读）：                                    │
│ "林晚推开门，看到雨夜的街道..."                    │
│                                                  │
│ 视频 Prompt（可编辑）：                          │
│ ┌─────────────────────────────────────────────┐│
│ │ A young woman in white T-shirt pushes open  ││
│ │ a wooden door, revealing a rainy night      ││
│ │ street, neon lights reflecting in puddles,  ││
│ │ close-up on her surprised expression        ││
│ └─────────────────────────────────────────────┘│
│ 字符数: 187  [AI 优化] [翻译原文]               │
│                                                  │
│ 旁白：林晚推开门，雨夜的街道空无一人...           │
│ 镜头语言: [dolly_in ▼]   时长: [5s ▼]            │
│                                                  │
│ [预览此镜头] [重新生成]                          │
└─────────────────────────────────────────────────┘
```

**实现**：

```ts
// src/components/Video/StoryboardEditor.tsx

interface Props {
  shot: StoryboardShot;
  onUpdate: (updates: Partial<StoryboardShot>) => void;
  onRegenerate: () => void;
}

// AI 优化按钮：调 LLM 改写 videoPrompt
async function optimizePrompt(shot) {
  const response = await providerRouter.generate({
    taskType: 'translation',
    systemPrompt: '你是 AI 视频提示词工程师，优化以下 prompt...',
    userPrompt: shot.videoPrompt,
  });
  // 直接填充回编辑框
}
```

### 2. 配音（TTS）⭐⭐⭐

Phase 1 跳过的 `voice_subtitle` 阶段，Phase 3 真正实现。

**实现步骤**：

1. 新增 TTS adapter
   ```ts
   // src/services/providers/tts-adapters.ts

   export class EdgeTTSProvider {
     readonly providerId = 'edge-tts';
     async synthesize(text: string, voice: string): Promise<ArrayBuffer> {
       // Microsoft Edge Read Aloud API（免费）
     }
   }

   export class MiniMaxTTSProvider {
     readonly providerId = 'minimax';
     async synthesize(text, voice, emotion?) {
       // speech-02-hd，付费高质量
     }
   }
   ```

2. `pipeline.ts` 新增 `runVoiceSubtitle()`
   ```ts
   private async runVoiceSubtitle(): Promise<void> {
     const project = store.getProject(novelId);
     for (const shot of project.shots) {
       if (skipShotsWithNativeAudio(shot, project)) continue;

       const audio = await providerRouter.synthesize({
         text: shot.narration,
         voice: selectVoiceForMood(shot.mood),
         emotion: mapMoodToEmotion(shot.mood),
       });

       store.addAudio(novelId, {
         shotId: shot.id,
         audioUrl: audio.url,
         durationSeconds: audio.duration,
         voiceProvider: 'edge-tts',
         voiceId: 'zh-CN-XiaoxiaoNeural',
         generatedAt: now(),
       });
     }
   }
   ```

3. FFmpeg 合成扩展：把 audio 轨混入视频
   ```rust
   // Phase 3 ffmpeg_compose_clips 扩展
   // 用 -i audio.mp3 + amix filter
   ```

**配音策略**：

- 默认 Edge TTS（免费 + 优秀）
- 同一小说的同一角色用同一音色（从 NovelBible 读 voicePreference）
- mood 决定音色（intense → 低沉男声，warm → 温柔女声）

### 3. 字幕样式 ⭐⭐

Phase 1 只有 drawtext 默认样式。Phase 3 加多种预设：

```ts
// src/types/video.ts 扩展
export interface VideoSpec {
  // ... 原有
  subtitleStyle?: 'minimal' | 'cinematic' | 'karaoke' | 'bold';
}

// 每种样式对应不同 FFmpeg drawtext 参数
const SUBTITLE_STYLES = {
  minimal: { fontcolor: 'white', fontsize: 36, borderw: 2 },
  cinematic: { fontcolor: 'yellow', fontsize: 32, box: 1, boxcolor: 'black@0.5' },
  karaoke: { /* 渐变效果 */ },
  bold: { fontcolor: 'white', fontsize: 48, borderw: 4, fontfile: 'bold.ttf' },
};
```

### 4. 单 shot 重试与回滚 ⭐⭐

```ts
// videoStore.ts 新增
clearClip: (novelId, shotId) => {
  // 移除该 shot 的 clip，UI 自动显示"待生成"
}

regenerateShot: async (novelId, shotId) => {
  // 重新对该 shot 跑 video_generation
}
```

UI：分镜列表的每个 shot 加 `[重试]` 按钮。

### 5. 失败诊断 ⭐

错误信息更友好：

```ts
// 不只是 "Kling API error 401"
// 而是
{
  type: 'auth_error',
  userMessage: 'Kling API key 无效，请在 Settings → Providers 检查',
  docsUrl: 'https://...'
}
```

## Phase 3 验收标准

- [ ] 用户能在 UI 改任意 shot 的 prompt 后单独重生成
- [ ] 配音自动生成且音色与角色 mood 匹配
- [ ] 字幕至少 3 种样式可选
- [ ] 单个 shot 失败不影响其他，可单独重试
- [ ] 错误信息有可操作的修复建议
