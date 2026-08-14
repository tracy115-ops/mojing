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

// --- Visual Style & Quality Presets ---

export interface StylePreset {
  id: string;
  name: string;
  description: string;
  promptPrefix: string;
  promptSuffix: string;
  negativePrompt: string;
}

export const VISUAL_STYLE_PRESETS: StylePreset[] = [
  {
    id: 'cinematic',
    name: '电影大片 (Cinematic)',
    description: '真实质感，电影级景深，专业构图与光影',
    promptPrefix: 'Cinematic film shot, 8k resolution, photorealistic, highly detailed, masterwork, ',
    promptSuffix: ', dynamic lighting, shallow depth of field, 35mm lens, volumetric light, shot on ARRI Alexa',
    negativePrompt: 'blurry, noisy, low quality, distorted, cartoon, anime, rendered, 3d, extra limbs, bad anatomy',
  },
  {
    id: 'anime',
    name: '日漫风 (Anime Shinkai Style)',
    description: '新海诚唯美日漫，明亮天空，色彩鲜艳，情感细腻',
    promptPrefix: 'Makoto Shinkai style anime, vibrant colors, beautiful detailed background, high quality anime art, ',
    promptSuffix: ', emotional atmosphere, lens flare, clouds in blue sky, studio ghibli inspired',
    negativePrompt: 'photorealistic, 3d render, live action, realistic skin, ugly, deformed, blurry',
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克 (Cyberpunk Neon)',
    description: '霓虹灯影，高科技低生活，雨夜街景，金属质感',
    promptPrefix: 'Cyberpunk style, neon glow, futuristic city, rainy night, wet reflection, ',
    promptSuffix: ', cyan and magenta color palette, highly detailed, octane render, unreal engine 5',
    negativePrompt: 'daylight, rural, countryside, historical, traditional, lowres, poorly drawn',
  },
  {
    id: 'ink_wash',
    name: '国风水墨 (Chinese Ink Wash)',
    description: '东方韵味，水墨留白，意境悠远，仙侠古风',
    promptPrefix: 'Traditional Chinese ink wash painting, elegant brush strokes, ethereal atmosphere, ',
    promptSuffix: ', artistic composition, mist and mountains, oriental aesthetics, masterpiece',
    negativePrompt: 'western, modern, neon, saturated digital art, photorealistic, 3d render',
  },
  {
    id: 'vintage',
    name: '胶片复古 (Vintage 80s Film)',
    description: '80年代复古胶片感，暖色调，复古颗粒，怀旧氛围',
    promptPrefix: '1980s vintage film grain, retro aesthetics, warm color grading, nostalgic, ',
    promptSuffix: ', kodak portra 400, muted colors, soft focus, film photography',
    negativePrompt: 'digital, ultra crisp, modern, neon, futuristic, overly saturated',
  },
];

// --- AI 漫剧 SOP 6 步标准流程定义 ---

export interface SOPStep {
  step: number;
  key: string;
  name: string;
  subTitle: string;
  description: string;
  icon: string;
}

export const MANGA_SOP_6STEPS: SOPStep[] = [
  {
    step: 1,
    key: 'script',
    name: '1. 剧本创作',
    subTitle: '角色 · 目标 · 冲突 · 行动 · 结局',
    description: '厘清故事主线，确定核心角色、欲望目标、剧情冲突、关键行动与最终结局。',
    icon: '📝',
  },
  {
    step: 2,
    key: 'storyboard',
    name: '2. 分镜设计',
    subTitle: '景别 · 角度 · 构图 · 画面描述',
    description: '精细划定景别(特写/全景)、镜头角度(俯仰视角)与黄金构图法。',
    icon: '📐',
  },
  {
    step: 3,
    key: 'anchor',
    name: '3. 角色一致',
    subTitle: '固定人设 · 参考图 · Seed · 隔离提示词',
    description: '生成独立角色立绘与三视图，锁定 Seed 与参考图，防止多角色碰撞干扰。',
    icon: '👤',
  },
  {
    step: 4,
    key: 'video_gen',
    name: '4. 图生视频',
    subTitle: '可灵 · Runway · MiniMax · 运镜微动',
    description: '赋予静态分镜眨眼、呼吸、推拉摇移运镜及高帧率流畅物理微动作。',
    icon: '🎬',
  },
  {
    step: 5,
    key: 'audio_post',
    name: '5. 后期配音',
    subTitle: 'TTS 配音 · BGM 氛围 · 音效 · 剪辑节奏',
    description: '合成角色情感台词，叠加背景音乐与环境音效，自适应对齐音画时长。',
    icon: '🎙️',
  },
  {
    step: 6,
    key: 'toolkit',
    name: '6. 工具箱 SOP',
    subTitle: '常用提示词 · SOP 预设 · 批量导出',
    description: '沉淀高质感 Prompt SOP 资产包，AI 是副驾驶，流程越清楚，结果越稳定。',
    icon: '🛠️',
  },
];


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
  | 'composing'             // 步 12:FFmpeg 拼接 + 字幕 + 导出
  | 'video_review'          // 步 13:AI 质检与画质评测
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
  /** 剧本中允许使用的别名，用于绑定到同一套项目级角色资产。 */
  aliases?: string[];
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
  aliases?: string[];
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
  durationSeconds: 3 | 5 | 10 | 15 | 18;
  /** 步 8 产物:TTS 音频路径/URL */
  audioTrack?: string;
}

export type CameraMovementOption =
  | 'static'
  | 'zoom_in'
  | 'zoom_out'
  | 'pan_left'
  | 'pan_right'
  | 'orbit'
  | 'crane_up'
  | 'tracking';

export const CAMERA_MOVEMENTS: { value: CameraMovementOption; label: string; prompt: string }[] = [
  { value: 'static', label: '📷 静止镜头 (Static Shot)', prompt: 'static camera, locked-off shot' },
  { value: 'zoom_in', label: '🔍 缓慢推进 (Dolly/Zoom In)', prompt: 'slow camera zoom in, pushing in close' },
  { value: 'zoom_out', label: '🔍 缓慢拉远 (Zoom Out)', prompt: 'camera zooming out, revealing environment' },
  { value: 'pan_left', label: '⬅️ 左摇镜头 (Pan Left)', prompt: 'smooth camera panning left' },
  { value: 'pan_right', label: '➡️ 右摇镜头 (Pan Right)', prompt: 'smooth camera panning right' },
  { value: 'orbit', label: '🔄 360° 环绕 (Orbit Shot)', prompt: 'cinematic 360 degree orbit shot around character' },
  { value: 'crane_up', label: '⬆️ 摇臂升起 (Crane Up)', prompt: 'crane shot rising up slowly, high angle view' },
  { value: 'tracking', label: '🏃 跟随镜头 (Tracking Shot)', prompt: 'dynamic tracking shot following the motion' },
];

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
    defaultShotDuration: 3 | 5 | 10 | 15 | 18;
    /** 来源模式(Novel 通道填 'multishot' 语义;Direct 按用户选择) */
    sourceMode: DirectSourceMode;
    /** 'novel' | 'direct' */
    channel: 'novel' | 'direct';
    /** 系列剧集上一集的收束关键帧，仅供本集第一镜作为附加参考。 */
    openingReferenceImage?: string;
    /** 系列资产匹配结果统计 */
    matchedCharacterNames?: string[];
    unmatchedCharacterNames?: string[];
    matchedSceneNames?: string[];
    unmatchedSceneNames?: string[];
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
  characterIds?: string[];
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
  customBgmUrl?: string;
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
  /** tts/video/image:特定模型名(如 cosyvoice-v1, FunAudioLLM/CosyVoice-300M 等) */
  model?: string;
  /** tts:音色 ID */
  voiceId?: string;
  /** tts:语速 */
  speed?: number;
  /** character_anchor / scene_image:风格 */
  style?: string;
  /** character_anchor:立绘模式 — 'single'(单图正面) | 'turnaround'(三视图正/侧/背) */
  anchorMode?: 'single' | 'turnaround';
  /** audio_merge:背景音乐氛围风格 */
  bgmStyle?: string;
  /** audio_merge:自定义背景音乐文件路径/DataURI */
  customBgmUrl?: string;
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
  audio_merge: [
    {
      key: 'bgmStyle',
      label: 'video.pipeline.field.bgmStyle',
      type: 'radio',
      options: [
        { value: 'epic_action', labelKey: '🔥 热血打斗/宏大爆发 (Action)' },
        { value: 'suspense_thriller', labelKey: '👁️ 悬疑惊悚/阴谋潜行 (Suspense)' },
        { value: 'warm_emotional', labelKey: '🌸 治愈温馨/日常相伴 (Warm)' },
        { value: 'cyberpunk', labelKey: '⚡ 赛博朋克/科幻电音 (Cyberpunk)' },
      ],
    },
  ],
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
  tts: [
    { key: 'model', label: 'video.pipeline.field.model', type: 'text' },
    { key: 'voiceId', label: 'video.pipeline.field.voiceId', type: 'text' },
    { key: 'speed', label: 'video.pipeline.field.speed', type: 'number', min: 0.25, max: 4, step: 0.1 },
  ],
};
