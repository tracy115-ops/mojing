// ============================================================================
// Video Generation Types — 完整 14 步流水线
// ============================================================================
// 14 步:
//   剧本处理: 1.原始内容 2.AI改写 3.提取(角色/场景/道具) 4.音色 5.分镜
//   制作流程: 6.角色立绘 7.场景图 8.TTS 9.镜头关键帧 10.视频生成 11.音视合并
//   导出:     12.拼接 13.字幕 14.导出
//
// 三种模式(见 docs/video-generation/12-dual-channel-unification.md §3):
//   - pure:    跑步 1/10/14(纯 T2V,最小子集)
//   - extract: 跑步 2/3/5/6/9/10/14(视觉一致性链路)
//   - multishot: 跑完整 14 步

import type { VideoProviderId, ImageProviderId } from './providers';

// --- Aspect Ratio ---

export type AspectRatio = '16:9' | '9:16' | '1:1';

// --- Source Mode ---

/** Direct modal 的三种模式 */
export type DirectSourceMode = 'pure' | 'extract' | 'multishot';

// --- Pipeline Stages ---

export type VideoStage =
  | 'idle'
  | 'script_slicing'        // 步 1:章节切片
  | 'storyboard_prompt'     // 步 2+5:LLM 改写 + 分镜
  | 'extraction'            // 步 3:提取角色/场景/道具(新)
  | 'voice_assignment'      // 步 4:分配音色(新)
  | 'character_anchor'      // 步 6:角色立绘
  | 'scene_image'           // 步 7:场景图(新)
  | 'tts'                   // 步 8:TTS 配音(新)
  | 'keyframe_image'        // 步 9:镜头关键帧(新)
  | 'video_generation'      // 步 10:T2V / I2V
  | 'audio_merge'           // 步 11:音视合并(新)
  | 'composing'             // 步 12-14:FFmpeg 拼接 + 字幕 + 导出
  | 'complete'
  | 'error';

export type VideoStageStatus =
  | 'pending'
  | 'running'
  | 'awaiting_review'  // 人工 checkpoint
  | 'completed'
  | 'skipped'
  | 'error';

export interface VideoStageState {
  stage: VideoStage;
  status: VideoStageStatus;
  progress: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  /** 该步骤所有 provider 调用(LLM/image/video/tts)的逐条记录。
   *  由 router 自动上报、videoStore 归档。账本 = UI 三段式中第三段。 */
  invocations?: StageInvocation[];
  /** 该步骤总账本(router 在每次 append 后自动汇总)。 */
  totals?: StageTotals;
  /** 该步骤输入摘要(章节字数 / 上一步产物数 / spec 字段),UI 第一段展示。 */
  inputSummary?: StageInputSummary;
  /** 用户可编辑的输入参数(单步重跑时用)。 */
  input?: StageInput;
}

/** 单次 provider 调用的明细记录。 */
export interface StageInvocation {
  /** 调用类别,决定 UI 怎么展示账本。 */
  category: 'llm' | 'image' | 'video' | 'tts';
  provider: string;
  model: string;
  endpointId?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  retries: number;
  /** LLM:输入 token */
  inputTokens?: number;
  /** LLM:输出 token */
  outputTokens?: number;
  /** image:生成图片张数(目前总是 1,留扩展) */
  imageCount?: number;
  /** tts:合成音频时长(秒) */
  audioSeconds?: number;
  /** video:生成视频时长(秒) */
  videoSeconds?: number;
  /** 估算成本 USD(可选,目前先不填,留字段) */
  cost?: number;
  /** 实际发给 provider 的 prompt 全文(可折叠展开) */
  promptPreview?: string;
  /** 触发本次调用的源 label(如 "shot 3 character[林墨]") */
  sourceLabel?: string;
  error?: string;
}

/** 步骤汇总账本。 */
export interface StageTotals {
  calls: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  imageCount?: number;
  audioSeconds?: number;
  videoSeconds?: number;
  cost?: number;
}

/** 步骤输入摘要(纯展示用)。 */
export interface StageInputSummary {
  /** 一句话描述输入,如 "3 个章节 / 共 12,345 字" */
  headline?: string;
  /** 详细列表项(可折叠),如章节标题 + 字数 */
  details?: string[];
  /** 上一步产物引用,如 "5 个分镜" */
  upstreamArtifacts?: string;
}

// --- Core: SceneSpec (跨通道共享的剧本表示) ---

/**
 * 角色立绘的换装变体。同角色在不同场景可能有不同服装,
 * 每个 variant 对应一张独立立绘,用于精准锚定。
 */
export interface CostumeVariant {
  id: string;                    // 'default' | 'rain' | ...
  description: string;
  portraitImage?: string;        // 步 6 产物:base64
}

/** 步 3 提取的角色 */
export interface CharacterAnchor {
  id: string;                    // 'char_xxx'
  name: string;                  // '林墨'
  appearance: string;            // 完整外貌(gender/age/face/hair/...)
  gender?: 'male' | 'female' | 'unknown';
  ageGroup?: 'child' | 'teen' | 'young' | 'middle' | 'elder' | 'unknown';
  costumeVariants?: CostumeVariant[];
  voiceRef?: string;             // 步 4 产物:音色 ID
  portraitImage?: string;        // 步 6 产物:default 立绘(单图正面) base64
  firstAppearShotIndex: number;
  /** 步 6 额外产物:三视图(正/侧/背并排,横向尺寸)。
   *  仅当用户选了三视图模式时才会生成,**不会**覆盖 portraitImage。
   *  keyframe 步优先用 turnaroundImage(裁中间 1/3 正视图)做 reference,
   *  没有则回退到 portraitImage。 */
  turnaroundImage?: string;
}

/** 步 3 提取的场景 */
export interface SceneAnchor {
  id: string;                    // 'scene_xxx'
  name: string;                  // '咖啡馆'
  description: string;
  backgroundImage?: string;      // 步 7 产物:base64
  firstAppearShotIndex: number;
}

/** 步 3 提取的关键道具(暂不生成图,只做 prompt 增强) */
export interface PropSpec {
  id: string;
  name: string;
  description: string;
}

/** 步 5 产出的镜头(ShotSpec 与 StoryboardShot 字段对齐) */
export interface ShotSpec {
  id: string;
  index: number;
  /** 镜头来源(Novel 通道有,Novel 通道走 chapter-slicer) */
  sourceChapterId?: string;
  sourceText?: string;
  /** 步 2 产物:画面描述(T2V/I2V 都用) */
  videoPrompt: string;
  /** 步 9 产物:关键帧 base64,作为 I2V 首帧 */
  keyframeImage?: string;
  /** 步 5 产物:旁白 */
  narration?: string;
  dialogue?: {
    speaker: string;
    text: string;
    emotion?: string;
  }[];
  /** 引用 CharacterAnchor.id */
  characterIds: string[];
  /** charId → costumeVariantId,决定该镜用哪套服装立绘 */
  costumeVariantRefs?: Record<string, string>;
  /** 引用 SceneAnchor.id */
  sceneId?: string;
  location?: string;
  mood?: string;
  cameraMovement?: string;
  durationSeconds: 3 | 5 | 10 | 18;
  /** 步 8 产物:TTS 音频路径/URL */
  audioTrack?: string;
}

/**
 * 跨通道共享的剧本表示。不管来源是小说章节还是手写 prompt,
 * 进入 pipeline-runner 后都是这层结构。
 */
export interface SceneSpec {
  characters?: CharacterAnchor[];
  scenes?: SceneAnchor[];
  props?: PropSpec[];
  shots: ShotSpec[];
  meta: {
    title?: string;
    style?: string;
    genre?: string;
    aspectRatio: AspectRatio;
    defaultShotDuration: 3 | 5 | 10 | 18;
    /** 来源模式(Novel 通道填 'multishot' 语义;Direct 按用户选择) */
    sourceMode: DirectSourceMode;
    /** 'novel' | 'direct' */
    channel: 'novel' | 'direct';
  };
}

// --- Pipeline Options (用户在 UI 里勾选的可选步骤) ---

export interface PipelineOptions {
  /** 步 6:角色立绘 */
  enableCharacterAnchor: boolean;
  /** 步 7:场景图 */
  enableSceneImage: boolean;
  /** 步 8:TTS */
  enableTTS: boolean;
  /** 步 9:镜头关键帧 */
  enableKeyframe: boolean;
  /** 步 10 用 I2V(否则 T2V) */
  enableI2V: boolean;
  /** 步 11:音视合并 */
  enableAudioMerge: boolean;
  /** 步 13:字幕 */
  enableSubtitles: boolean;
  /** 角色立绘上限(超出未选的角色其描述拼到 prompt 里) */
  characterAnchorLimit: number;
}

/** Direct modal 三种模式的预设开关 */
export const DIRECT_MODE_PRESETS: Record<DirectSourceMode, PipelineOptions> = {
  pure: {
    enableCharacterAnchor: false,
    enableSceneImage: false,
    enableTTS: false,
    enableKeyframe: false,
    enableI2V: false,
    enableAudioMerge: false,
    enableSubtitles: false,
    characterAnchorLimit: 0,
  },
  extract: {
    enableCharacterAnchor: true,
    enableSceneImage: false,
    enableTTS: false,
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

// --- Storyboard (兼容旧字段,Novel 通道仍用) ---

export interface StoryboardShot {
  id: string;
  index: number;
  sourceChapterId?: string;
  sourceText: string;
  videoPrompt: string;
  imagePrompt?: string;
  durationSeconds: number;
  narration?: string;
  dialogue?: {
    speaker: string;
    text: string;
    emotion?: string;
  }[];
  characters: string[];
  location?: string;
  mood?: string;
  cameraMovement?: string;
}

// --- Generated Assets ---

export interface GeneratedClip {
  shotId: string;
  videoUrl: string;
  thumbnailUrl?: string;
  durationSeconds: number;
  provider: VideoProviderId;
  model: string;
  hasAudio: boolean;
  generatedAt: string;
  /** 步 9 产物:关键帧 base64(若有) */
  keyframeImage?: string;
  /** 步 8/11 产物:音轨路径/URL */
  audioTrack?: string;
  /** 来源:'novel' | 'direct' */
  sceneSource?: 'novel' | 'direct';
  /** Direct 模式标记 */
  sourceMode?: DirectSourceMode;
  /**
   * Direct 任务的项目 ID(`direct_<timestamp>`)。
   * 用于在 directClips 列表里按任务分组,以及从产物跳回执行过程。
   * Novel 通道的 clip 不写这个字段(Novel 用 novelProjectId 关联)。
   */
  directProjectId?: string;
}

export interface GeneratedAudio {
  shotId: string;
  audioUrl: string;
  durationSeconds: number;
  voiceProvider: string;
  voiceId: string;
  generatedAt: string;
}

export interface AnchorImage {
  characterId: string;
  imageUrl: string;
  seed?: number;
  promptUsed: string;
  generatedAt: string;
}

// --- Video Project (运行时状态) ---

export interface VideoProjectState {
  novelProjectId: string;
  /** 可读标题(Direct 模式取 prompt 前 N 字;Novel 模式可留空,header 用 novel project title) */
  title?: string;
  selectedChapterIds: string[];
  spec: VideoSpec;
  /** 用户选择的步骤开关 */
  options?: PipelineOptions;
  stages: Record<VideoStage, VideoStageState>;
  currentStage: VideoStage;
  shots: StoryboardShot[];
  /** SceneSpec(步 3 产物,跨步复用) */
  sceneSpec?: SceneSpec;
  anchorImages: AnchorImage[];
  clips: GeneratedClip[];
  audios: GeneratedAudio[];
  finalVideoUrl?: string;
  /** Final video metadata (filled by compose step). */
  finalDurationSeconds?: number;
  finalSizeBytes?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VideoSpec {
  aspectRatio: AspectRatio;
  resolution: string;
  fps: number;
  shotDurationSeconds: 5 | 10;
  videoTier: ModelTier;
  imageTier: ModelTier;
  ttsTier: ModelTier;
  hardcodeSubtitles: boolean;
  bgmStyle?: string;
  /** Phase 2:是否启用角色立绘(默认 true) */
  enableCharacterAnchor?: boolean;
  /** Phase 2:是否启用场景图 */
  enableSceneImage?: boolean;
  /** Phase 2:是否启用 TTS */
  enableTTS?: boolean;
}

export type ModelTier = 'free' | 'value' | 'quality' | 'premium';

// --- Status helpers ---

export const VIDEO_PIPELINE_STAGES: VideoStage[] = [
  'script_slicing',
  'storyboard_prompt',
  'extraction',
  'voice_assignment',
  'character_anchor',
  'scene_image',
  'tts',
  'keyframe_image',
  'video_generation',
  'audio_merge',
  'composing',
];

/** 步骤默认跳过集合(无对应 provider 时) */
export const DEFAULT_SKIPPED_STAGES: ReadonlySet<VideoStage> = new Set<VideoStage>([]);

// --- 单步重跑:可编辑输入参数 ---

/** 某个 stage 用户可编辑的输入参数(通用集合,各 stage 用到的字段不同)。 */
export interface StageInput {
  /** 文本类 prompt(storyboard/keyframe/video_generation 的提示词) */
  prompt?: string;
  /** 随机种子(image/video 生成时复现或换图用) */
  seed?: number;
  /** 负面提示词 */
  negativePrompt?: string;
  /** video_generation:分辨率 "1920x1080" */
  resolution?: string;
  /** video_generation:帧率 */
  fps?: number;
  /** video_generation:单镜头时长(秒) */
  durationSeconds?: number;
  /** tts:音色 ID */
  voiceId?: string;
  /** tts:语速 */
  speed?: number;
  /** character_anchor / scene_image:风格 */
  style?: string;
  /** character_anchor:立绘模式 — 'single'(单图正面) | 'turnaround'(三视图正/侧/背) */
  anchorMode?: 'single' | 'turnaround';
}

/** 输入字段定义 — 驱动 UI 表单渲染。 */
export interface StageInputFieldDef {
  key: keyof StageInput;
  label: string;       // i18n key,如 'video.pipeline.field.prompt'
  type: 'text' | 'textarea' | 'number' | 'radio';
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  /** 只读展示(改了不会应用到重跑,仅作为「step 实际使用的参数」参考)。
   *  用于 prompt 这种 step 内部 build 出来的字段。 */
  readOnly?: boolean;
  /** type='radio' 时的可选项 */
  options?: { value: string; labelKey: string }[];
}

/** 各 stage 可编辑的字段配置。空数组 = 该 stage 暂不支持改输入(只能纯重跑)。
 *  字段 label 走 i18n,key 格式 'video.pipeline.field.<key>'。 */
export const STAGE_INPUT_FIELDS: Partial<Record<VideoStage, StageInputFieldDef[]>> = {
  storyboard_prompt: [
    { key: 'prompt', label: 'video.pipeline.field.prompt', type: 'textarea' },
  ],
  character_anchor: [
    {
      key: 'anchorMode', label: 'video.pipeline.field.anchorMode', type: 'radio',
      options: [
        { value: 'single', labelKey: 'video.pipeline.field.anchorModeSingle' },
        { value: 'turnaround', labelKey: 'video.pipeline.field.anchorModeTurnaround' },
      ],
    },
    { key: 'prompt', label: 'video.pipeline.field.prompt', type: 'textarea' },
    { key: 'style', label: 'video.pipeline.field.style', type: 'text' },
    { key: 'seed', label: 'video.pipeline.field.seed', type: 'number', min: 0 },
  ],
  scene_image: [
    { key: 'prompt', label: 'video.pipeline.field.prompt', type: 'textarea', readOnly: true },
    { key: 'style', label: 'video.pipeline.field.style', type: 'text' },
    { key: 'seed', label: 'video.pipeline.field.seed', type: 'number', min: 0 },
  ],
  keyframe_image: [
    { key: 'prompt', label: 'video.pipeline.field.prompt', type: 'textarea' },
    { key: 'seed', label: 'video.pipeline.field.seed', type: 'number', min: 0 },
  ],
  video_generation: [
    { key: 'prompt', label: 'video.pipeline.field.prompt', type: 'textarea' },
    { key: 'seed', label: 'video.pipeline.field.seed', type: 'number', min: 0 },
    { key: 'resolution', label: 'video.pipeline.field.resolution', type: 'text' },
    { key: 'fps', label: 'video.pipeline.field.fps', type: 'number', min: 1, max: 60, step: 1 },
    { key: 'durationSeconds', label: 'video.pipeline.field.duration', type: 'number', min: 1, max: 60, step: 1 },
  ],
};
