# 12 — 双通道统一架构:14 步完整流程对齐三种模式

**状态**:设计中(2026-06-16 讨论 v2)
**前置**:本文是对 [09-phase2-roadmap.md](./09-phase2-roadmap.md) 的补充,聚焦两个之前被忽略的问题:
1. 对标业界工作流(14 步完整流程),MoJing 缺哪些环节
2. **DirectVideoModal(独立生成视频)通道如何复用同一套完整流程**

---

## 1. 基准:业界完整工作流(14 步)

对方视频 Agent 的流程分三段共 14 步:

```
┌─ 剧本处理 ──────────────────────────────────────┐
│ 1. 原始内容    输入(小说/prompt/音频转写)         │
│ 2. AI 改写     LLM 把原文改写成视频脚本            │
│ 3. 提取        提取角色/场景/道具/情绪结构化数据    │
│ 4. 音色        为每个角色分配音色(voiceRef)        │
│ 5. 分镜        切成镜头,每镜画面/旁白/时长/在场角色│
└─────────────────────────────────────────────────┘
           ↓
┌─ 制作流程 ──────────────────────────────────────┐
│ 6. 角色立绘    每个角色 1 张锚定图                 │
│ 7. 场景图片    每个场景 1 张背景图                 │
│ 8. 配音生成    TTS 把 narration 转成音频           │
│ 9. 镜头图片    每镜 1 张关键帧(引用角色立绘+场景)  │
│ 10. 视频生成   I2V,以关键帧为首帧                 │
│ 11. 视频合成   每镜的视觉 + 音频合并(对口型/混音)  │
└─────────────────────────────────────────────────┘
           ↓
┌─ 导出 ──────────────────────────────────────────┐
│ 12. 拼接       FFmpeg 串接所有镜头                │
│ 13. 字幕       硬编码/软字幕(可选)                │
│ 14. 导出       最终 mp4 + 元数据                  │
└─────────────────────────────────────────────────┘
```

---

## 2. MoJing 现状 vs 14 步对照

| # | 步骤 | MoJing 现状 | 差距 |
|---|------|------------|------|
| 1 | 原始内容 | ✅ Novel:章节 / Direct:prompt | 无 |
| 2 | AI 改写 | ✅ `storyboard-prompt.ts` 已实现 | 无 |
| 3 | 提取 | ⚠️ 部分。角色靠 chapter-slicer 启发式检测,无场景/道具提取 | **缺** |
| 4 | 音色 | ❌ 无 | **缺** |
| 5 | 分镜 | ✅ `chapter-slicer` + `storyboard-prompt` | 无 |
| 6 | 角色立绘 | ❌ Phase 1 占位 | **缺** |
| 7 | 场景图片 | ❌ 无 | **缺** |
| 8 | 配音 TTS | ❌ Phase 1 占位 | **缺** |
| 9 | 镜头图片 | ❌ 无(只有 imagePrompt 字段) | **缺** |
| 10 | 视频生成 | ⚠️ 纯 T2V,无 I2V | **缺 I2V** |
| 11 | 视频合成(音视合并) | ❌ 无 | **缺** |
| 12 | 拼接 | ✅ `ffmpeg-bridge.composeClips` | 无 |
| 13 | 字幕 | ✅ `hardcodeSubtitles` 参数已支持 | 无 |
| 14 | 导出 | ✅ final.mp4 写入 store | 无 |

**结论**:14 步里 MoJing 缺 6 步(3、4、6、7、8、9、11),其中 4、8、11 是音频链路,3、6、7、9 是视觉一致性链路。

---

## 3. 三种模式如何适配 14 步

三种模式共享**同一套 14 步流水线**,差异只在:
- **剧本处理段(步 1-5)**的输入来源和强度
- **可选步骤**是否启用(用户勾选)

### 3.1 三种模式的输入特征

| 模式 | 输入示例 | 剧本处理复杂度 | 适用场景 |
|------|---------|----------------|----------|
| **Mode A:纯 T2V**(现状) | "夜晚的街道,女孩跑过..." | 跳过 2/3/4 | 单镜头快出,验证想法 |
| **Mode B:提取角色 + I2V** | "林墨推开木门。她 20 岁,黑色短发..." | 跑 2/3,跳 4 | 单镜头但要求角色一致 |
| **Mode C:多镜头脚本** | "镜 1:林墨进咖啡馆。镜 2:她坐下点单。镜 3:窗外下雨。" | 跑 2/3/4/5 完整 | 短片成片 |

### 3.2 14 步 × 3 模式矩阵

| # | 步骤 | Mode A 纯T2V | Mode B 提取角色 | Mode C 多镜头 |
|---|------|:---:|:---:|:---:|
| 1 | 原始内容 | 用户 prompt | 用户 prompt(含角色描述) | 用户多镜头脚本 |
| 2 | AI 改写 | 跳过(直出) | LLM 标准化画面描述 | LLM 切分 + 标准化 |
| 3 | 提取 | 跳过 | 提取角色 | 提取角色 + 场景 + 道具 |
| 4 | 音色 | 跳过 | 跳过(单镜无配音) | 分配角色音色 |
| 5 | 分镜 | 单镜头 | 单镜头 | 多镜头切分 |
| 6 | 角色立绘 | 跳过 | ✅ 勾选角色生成锚定图 | ✅ 全部角色生成 |
| 7 | 场景图片 | 跳过 | 跳过(单镜可复用) | ✅ 每场景 1 张 |
| 8 | 配音 TTS | 跳过 | 跳过(用户可选) | ✅ 每镜 narration |
| 9 | 镜头图片 | 跳过 | ✅ 单镜头关键帧 | ✅ 每镜关键帧 |
| 10 | 视频生成 | T2V | **I2V**(关键帧为首帧) | **I2V** |
| 11 | 视频合成(音视) | 跳过 | 跳过 | ✅ 视轨 + 音轨合并 |
| 12 | 拼接 | 跳过(单镜) | 跳过(单镜) | ✅ FFmpeg 串接 |
| 13 | 字幕 | 跳过 | 可选 | ✅ 默认开 |
| 14 | 导出 | 单 clip | 单 clip(带 keyframe) | final.mp4 |

**Mode A 是 14 步里的最小子集(只跑 1/10/14),Mode B 跑视觉一致性链路(2/3/5/6/9/10/14),Mode C 跑完整 14 步。**

---

## 4. 核心抽象:SceneSpec

不管哪种模式,进入流水线后都归一化为同一份结构。下游 `pipeline-runner` 只认 SceneSpec + 用户选择的可选开关,不关心来源。

```typescript
// src/services/video/core/types.ts (新)

export interface SceneSpec {
  /** 步 3 产物:角色(可选) */
  characters?: CharacterAnchor[];
  /** 步 3 产物:场景(可选) */
  scenes?: SceneAnchor[];
  /** 步 3 产物:道具(可选) */
  props?: PropSpec[];
  /** 步 5 产物:镜头(必填) */
  shots: ShotSpec[];
  /** 元信息 */
  meta: {
    title?: string;
    style?: string;
    aspectRatio: AspectRatio;
    defaultShotDuration: 5 | 10;
    sourceMode: 'pure' | 'extract' | 'multishot';
  };
}

export interface CharacterAnchor {
  id: string;                    // 'char_xxx'
  name: string;                  // '林墨'
  appearance: string;            // 完整外貌
  costumeVariants?: CostumeVariant[];  // 步 3:换装标记
  voiceRef?: string;             // 步 4:音色 ID
  portraitImage?: string;        // 步 6 产物:立绘 base64
  firstAppearShotIndex: number;
}

export interface CostumeVariant {
  id: string;                    // 'default' | 'rain' | ...
  description: string;
  portraitImage?: string;        // 每个 variant 一张立绘
}

export interface SceneAnchor {
  id: string;                    // 'scene_xxx'
  name: string;                  // '咖啡馆'
  description: string;
  backgroundImage?: string;      // 步 7 产物:场景图 base64
  firstAppearShotIndex: number;
}

export interface ShotSpec {
  id: string;
  videoPrompt: string;           // 步 2 产物:画面描述
  narration?: string;            // 步 5 产物:旁白
  characterIds: string[];        // 引用 CharacterAnchor.id
  costumeVariantRefs?: Record<string, string>;  // charId → variantId
  sceneId?: string;              // 引用 SceneAnchor.id
  location?: string;
  mood?: string;
  durationSeconds: 5 | 10;
  keyframeImage?: string;        // 步 9 产物
  audioTrack?: string;           // 步 8 产物:TTS 音频路径
  finalClip?: string;            // 步 11 产物:音视合并后的 clip 路径
}

/** 用户在 UI 里勾选的可选步骤开关 */
export interface PipelineOptions {
  enableCharacterAnchor: boolean;   // 步 6
  enableSceneImage: boolean;        // 步 7
  enableTTS: boolean;               // 步 8
  enableKeyframe: boolean;          // 步 9
  enableI2V: boolean;               // 步 10 用 I2V
  enableAudioMerge: boolean;        // 步 11
  enableSubtitles: boolean;         // 步 13
  /** Mode C 时用户勾选要生成立绘的角色上限 */
  characterAnchorLimit: number;     // 默认 5
}
```

---

## 5. 模块拆分

```
src/services/video/
├── core/                              ⭐ 新 — 跨通道共享,实现 14 步
│   ├── types.ts                       # SceneSpec 及相关
│   ├── step-rewrite.ts                # 步 2:AI 改写(prompt → 标准化)
│   ├── step-extract.ts                # 步 3:提取角色/场景/道具
│   ├── step-voice.ts                  # 步 4:分配音色
│   ├── step-storyboard.ts             # 步 5:切分镜头(多镜头模式)
│   ├── step-character-anchor.ts       # 步 6:角色立绘
│   ├── step-scene-image.ts            # 步 7:场景图
│   ├── step-tts.ts                    # 步 8:TTS
│   ├── step-keyframe.ts               # 步 9:镜头关键帧
│   ├── step-video-gen.ts              # 步 10:T2V / I2V
│   ├── step-audio-merge.ts            # 步 11:音视合并
│   ├── step-compose.ts                # 步 12-13:拼接 + 字幕
│   └── pipeline-runner.ts             # 编排器:按 PipelineOptions 跑子集
│
├── chapter-slicer.ts                  # 仅 novel:章节 → RawShot[](替代步 1+5 一部分)
├── storyboard-prompt.ts               # 仅 novel:RawShot[] → ShotSpec[](步 2+3+5 旧实现,逐步迁移到 core)
├── direct-scene-builder.ts            # 仅 direct:prompt → SceneSpec(根据模式调 core 不同步骤)
│
├── pipeline.ts                        # 现有,瘦身为 novelToSceneSpec + 调 runner
└── ffmpeg-bridge.ts                   # 共用:步 12-13 底层
```

### 5.1 pipeline-runner 编排逻辑

```typescript
// src/services/video/core/pipeline-runner.ts

export async function runPipeline(
  spec: SceneSpec,
  options: PipelineOptions,
  callbacks: PipelineCallbacks,
): Promise<VideoProjectState> {

  // 步 6:角色立绘
  if (options.enableCharacterAnchor && spec.characters?.length) {
    const limited = spec.characters.slice(0, options.characterAnchorLimit);
    await runCharacterAnchor(limited, callbacks);
  }

  // 步 7:场景图
  if (options.enableSceneImage && spec.scenes?.length) {
    await runSceneImage(spec.scenes, callbacks);
  }

  // 步 8:TTS
  if (options.enableTTS) {
    await runTTS(spec.shots, spec.characters, callbacks);
  }

  // 步 9:镜头关键帧
  if (options.enableKeyframe) {
    await runKeyframe(spec.shots, spec.characters, spec.scenes, callbacks);
  }

  // 步 10:视频生成(T2V or I2V)
  await runVideoGen(spec.shots, options.enableI2V, callbacks);

  // 步 11:音视合并
  if (options.enableAudioMerge && spec.shots.some(s => s.audioTrack)) {
    await runAudioMerge(spec.shots, callbacks);
  }

  // 步 12-13:拼接 + 字幕(单镜头跳过)
  if (spec.shots.length > 1) {
    await runCompose(spec.shots, options.enableSubtitles, callbacks);
  }

  return ...;
}
```

每个 `run*` 函数根据 `SceneSpec` 里相应字段是否已填充决定执行/跳过,失败时降级不阻塞。

---

## 6. Direct modal 三种模式的 UI 落地

### 6.1 UI 草图

```
┌──────────────────────────────────────────────────────┐
│ 直接生成视频                                          │
├──────────────────────────────────────────────────────┤
│ 视频 Prompt                                           │
│ [____________________________________________]        │
│                                                       │
│ 模式:                                                │
│   (•) A 纯 T2V(快,无角色一致性)                    │
│   ( ) B 提取角色 + I2V(单镜头,角色一致)            │
│   ( ) C 多镜头脚本(完整 14 步,出短片)             │
│                                                       │
│ ┌── 高级选项(模式 B/C 显示)──────────────────────┐│
│ │ ☑ 角色立绘(步 6)        ☑ 关键帧(步 9)         ││
│ │ ☐ 场景图(步 7)          ☐ TTS 配音(步 8)       ││
│ │ ☐ 音视合并(步 11)       ☑ 字幕(步 13)          ││
│ │ 角色上限: [5 ▼]                                   ││
│ └─────────────────────────────────────────────────┘│
│                                                       │
│ ┌── 角色预览(模式 B/C 提取后显示)────────────────┐│
│ │ ☑ 林墨  [立绘] default / [立绘] rain    [重抽]   ││
│ │ ☑ 老人  [立绘]                          [重抽]   ││
│ │ ☐ 路人  (未勾选)                                  ││
│ │ ☑ 场景:咖啡馆 [图]  ☑ 场景:街道 [图]            ││
│ └─────────────────────────────────────────────────┘│
│                                                       │
│ Provider [▼]  模型 [▼]  宽高比 [▼]  时长 [▼]         │
│ [AI优化] [提取角色]              [关闭] [生成视频]   │
└──────────────────────────────────────────────────────┘
```

### 6.2 模式选择 → 步骤子集映射

UI 上选模式后,代码自动设置 `PipelineOptions`:

```typescript
const PRESETS: Record<'pure' | 'extract' | 'multishot', PipelineOptions> = {
  pure: {
    enableCharacterAnchor: false,
    enableSceneImage: false,
    enableTTS: false,
    enableKeyframe: false,
    enableI2V: false,           // 纯 T2V
    enableAudioMerge: false,
    enableSubtitles: false,
    characterAnchorLimit: 0,
  },
  extract: {
    enableCharacterAnchor: true,
    enableSceneImage: false,    // 单镜头不需要
    enableTTS: false,           // 默认关,用户可开
    enableKeyframe: true,
    enableI2V: true,
    enableAudioMerge: false,
    enableSubtitles: false,
    characterAnchorLimit: 5,
  },
  multishot: {
    enableCharacterAnchor: true,
    enableSceneImage: true,
    enableTTS: true,
    enableKeyframe: true,
    enableI2V: true,
    enableAudioMerge: true,
    enableSubtitles: true,
    characterAnchorLimit: 5,
  },
};
```

用户可在"高级选项"里覆盖默认(比如 multishot 但关 TTS)。

### 6.3 Direct 三种模式的 SceneSpec 构造

```typescript
// direct-scene-builder.ts
export async function buildSceneFromPrompt(
  prompt: string,
  mode: 'pure' | 'extract' | 'multishot',
  ctx: { aspectRatio, defaultShotDuration, style },
): Promise<SceneSpec> {

  if (mode === 'pure') {
    // 步 1 → 跳过 2/3/4/5 → 单镜头 ShotSpec
    return {
      shots: [{
        id: genId(),
        videoPrompt: prompt,
        characterIds: [],
        durationSeconds: ctx.defaultShotDuration,
      }],
      meta: { ...ctx, sourceMode: 'pure' },
    };
  }

  // extract / multishot:跑步 2 + 步 3
  const rewritten = await stepRewrite(prompt);              // 步 2
  const extracted = await stepExtract(rewritten, mode);     // 步 3

  if (mode === 'extract') {
    // 单镜头,但带角色
    return {
      characters: extracted.characters,
      shots: [{
        id: genId(),
        videoPrompt: rewritten,
        characterIds: extracted.characters.map(c => c.id),
        durationSeconds: ctx.defaultShotDuration,
      }],
      meta: { ...ctx, sourceMode: 'extract' },
    };
  }

  // multishot:跑步 4 + 步 5
  const withVoice = await stepVoice(extracted.characters);  // 步 4
  const shots = await stepStoryboard(rewritten, withVoice, extracted.scenes); // 步 5

  return {
    characters: withVoice,
    scenes: extracted.scenes,
    shots,
    meta: { ...ctx, sourceMode: 'multishot' },
  };
}
```

---

## 7. Novel 通道对齐

Novel pipeline 改造后同样跑 14 步,只是步 1-5 的输入不同:

```typescript
// pipeline.ts 改造后
async run() {
  // 步 1:原始内容(章节)
  // 步 2/3/5:现有 chapter-slicer + storyboard-prompt 产出 ShotSpec[] + 角色
  //           → 新增 step-extract 补全场景/道具
  // 步 4:step-voice 分配音色
  const sceneSpec = await buildNovelSceneSpec(this.input);  // 内部调 core 的步 2/3/4/5

  // 步 6-14:统一 runner
  const options: PipelineOptions = {
    enableCharacterAnchor: this.input.spec.enableCharacterAnchor ?? true,
    enableSceneImage: this.input.spec.enableSceneImage ?? true,
    enableTTS: this.input.spec.enableTTS ?? true,
    enableKeyframe: true,
    enableI2V: true,
    enableAudioMerge: true,
    enableSubtitles: this.input.spec.hardcodeSubtitles,
    characterAnchorLimit: 5,
  };

  return await runPipeline(sceneSpec, options, this.cb);
}
```

---

## 8. 设计决策(已敲定)

### 8.1 决策 1:角色去重 → 同名唯一 + 显式换装标记

LLM 在步 3 提取时输出 `costumeVariants[]`,默认每角色 1 张立绘(default),换装时额外生成。

### 8.2 决策 2:角色立绘上限 → 用户 UI 勾选,默认 top 5

Direct modal 角色预览面板默认勾选前 5 个,Novel pipeline 从 NovelBible 按出场频率排序默认前 5。

### 8.3 决策 3:关键帧失败降级 → 该镜头回退 T2V

UI 标黄提示。整批失败弹窗询问继续 T2V / 中止。

### 8.4 决策 4:Direct 提取角色触发 → 显式按钮

默认 Mode A(纯 T2V,和现状一致)。用户点"提取角色"或切到 Mode B/C 才触发 LLM。

### 8.5 决策 5:多镜头自动拼接 → ✅

Mode C 默认走完整 12-14 步,FFmpeg 拼接 + 字幕。历史同时保留单 clip 和 finalVideo。

### 8.6 决策 6(新):音色分配策略

Mode C 启用 TTS 时,步 4 的音色分配规则:
- 优先匹配 NovelBible 里的角色 voiceRef(若 Novel 通道)
- Direct 通道:LLM 根据角色 gender/age 推荐默认音色(男声/女声/老/幼)
- 用户可在角色预览面板手动改音色

### 8.7 决策 7(新):场景图复用

Mode C 里同一 sceneId 的多个镜头共享一张场景图,不重复生成。立绘同理(角色立绘跨镜复用)。

---

## 9. 类型扩展清单

### 9.1 新增 `src/types/video.ts`

```typescript
export interface SceneSpec { /* §4 */ }
export interface CharacterAnchor { /* §4 */ }
export interface CostumeVariant { /* §4 */ }
export interface SceneAnchor { /* §4 */ }
export interface ShotSpec { /* §4 */ }
export interface PipelineOptions { /* §4 */ }
```

### 9.2 扩展 `GeneratedClip`

```typescript
export interface GeneratedClip {
  // ... 现有 ...
  keyframeImage?: string;
  audioTrack?: string;          // 步 8/11 产物
  sceneSource?: 'novel' | 'direct';
  sourceMode?: 'pure' | 'extract' | 'multishot';
}
```

### 9.3 扩展 `VideoStage`

```typescript
export type VideoStage =
  | 'script_slicing'         // 步 1
  | 'storyboard_prompt'      // 步 2 + 5
  | 'extraction'             // 步 3(新)
  | 'voice_assignment'       // 步 4(新)
  | 'character_anchor'       // 步 6(新)
  | 'scene_image'            // 步 7(新)
  | 'tts'                    // 步 8(新)
  | 'keyframe_image'         // 步 9(新)
  | 'video_generation'       // 步 10
  | 'audio_merge'            // 步 11(新)
  | 'composing';             // 步 12-14
```

### 9.4 扩展 `VideoSpec`(用户级配置)

```typescript
export interface VideoSpec {
  // ... 现有 ...
  enableCharacterAnchor?: boolean;
  enableSceneImage?: boolean;
  enableTTS?: boolean;
  characterAnchorLimit?: number;
}
```

---

## 10. 降级矩阵

| 失败场景 | 降级 |
|---------|------|
| 没配 image provider | 步 6/7/9 全跳过,步 10 走 T2V |
| image provider 单次失败 | 该角色/场景/镜头标记失败,继续,UI 标黄 |
| image provider 整批失败 | 弹窗询问继续 T2V / 中止 |
| 没配 TTS provider | 步 8 跳过,步 11 也跳过(无音轨) |
| TTS 单镜失败 | 该镜静音,继续 |
| 没配 LLM provider | Mode A 仍可用(不调 LLM),Mode B/C 弹错 |
| LLM 步 2/3/5 失败 | Direct 退化为 Mode A;Novel 用 fallback 启发式 |
| 用户没勾任何角色 | 视为 Mode A,跳步 6 |
| FFmpeg 不可用 | 步 12 跳过,单镜输出;Mode C 提示"无法拼接,请单独下载各镜" |

---

## 11. 工时估算(按 14 步模块化)

| 模块 | 对应步 | 工时 |
|------|:------:|------|
| `core/types.ts` + SceneSpec 抽象 | 全 | 0.5 天 |
| `core/step-rewrite.ts`(LLM 改写) | 2 | 0.5 天(从 storyboard-prompt 迁移) |
| `core/step-extract.ts`(提取角色/场景/道具) | 3 | 1 天 |
| `core/step-voice.ts`(音色分配) | 4 | 0.5 天 |
| `core/step-storyboard.ts`(多镜头切分) | 5 | 0.5 天 |
| `core/step-character-anchor.ts`(角色立绘) | 6 | 1 天 |
| `core/step-scene-image.ts`(场景图) | 7 | 0.5 天 |
| `core/step-tts.ts`(TTS 集成) | 8 | 1.5 天(需选 TTS provider + adapter) |
| `core/step-keyframe.ts`(镜头关键帧) | 9 | 1 天 |
| `core/step-video-gen.ts`(T2V/I2V 切换) | 10 | 0.5 天(改造现有) |
| `core/step-audio-merge.ts`(音视合并) | 11 | 1 天(FFmpeg 混音) |
| `core/step-compose.ts`(拼接+字幕) | 12-13 | 0.3 天(已有基础) |
| `core/pipeline-runner.ts`(编排) | 全 | 1 天 |
| 重构 `pipeline.ts` 接入 core | - | 0.5 天 |
| `direct-scene-builder.ts` | - | 0.5 天 |
| DirectVideoModal UI(模式切换+角色预览+高级选项) | - | 1.2 天 |
| VideoGeneratorModal UI(角色锚定+场景面板) | - | 1 天 |
| TTS provider adapter(如字节 TTS / Edge TTS) | 8 | 1 天 |
| i18n | - | 0.5 天 |
| 联调 + 测试 | - | 2 天 |
| **合计** | | **~15 天** |

> 注:比前一版 7.6 天翻倍,因为补全了步 3/4/7/8/11。可以分期。

---

## 12. 分期实施

### 期 1:视觉一致性链路(~5 天,高 ROI)

补全步 3 / 6 / 7 / 9 / 10(I2V)。**不开 TTS**。

- 改动:`step-extract` / `step-character-anchor` / `step-scene-image` / `step-keyframe` / `step-video-gen` + core 抽象 + Direct Mode B
- 价值:角色一致性 + 画面稳定性,解决 80% 用户痛点

### 期 2:Direct Mode C 多镜头(~2 天)

- 改动:`direct-scene-builder` multishot + DirectVideoModal 模式 C UI + 步 5
- 价值:Direct 通道支持短片

### 期 3:音频链路(~5 天)

补全步 4 / 8 / 11。

- 改动:`step-voice` / `step-tts` / `step-audio-merge` + TTS provider adapter
- 价值:成片有配音,Mode C 完整 14 步可用

### 期 4:打磨(~3 天)

- 角色立绘跨章节缓存(Novel 优化)
- 关键帧审核 checkpoint UI
- 时间轴预览(Mode C)

---

## 13. 与现有文档的关系

| 文档 | 关系 |
|------|------|
| [09-phase2-roadmap.md](./09-phase2-roadmap.md) | 本文是其完整化:09 只规划 Novel 通道的角色锚点+I2V,本文把 14 步流程显式映射到 Direct 的三种模式,并补全音频链路 |
| [06-character-consistency.md](./06-character-consistency.md) | 本文复用其 FLUX.2 多参考图技术方案(步 6/9),不重复 |
| [02-architecture.md](./02-architecture.md) | 本文新增的 `core/step-*.ts` 是对其模块边界的细化 |
| [08-phase1-implementation.md](./08-phase1-implementation.md) | Phase 1 已完成的 `pipeline.ts` 会在期 1 被重构为薄包装,行为保持兼容 |

---

## 14. 待办与开放问题

- [ ] TTS provider 选型:字节豆包 TTS / Edge TTS / 本地 GPT-SoVITS?(期 3 决定)
- [ ] 音视合并(步 11)的对口型方案:原生支持 vs 后期 Wav2Lip(期 4)
- [ ] FLUX.2 adapter 对 `referenceImages` 的实际验证(期 1 联调)
- [ ] `costumeVariant` 在跨镜头时的引用规则(期 1 实现时定)
- [ ] Direct multishot 是否需要时间轴预览(期 4)

---

**最后更新**:2026-06-16(v2,补全 14 步 + 三模式矩阵)
**下一步**:用户决定从哪一期开始实施。
