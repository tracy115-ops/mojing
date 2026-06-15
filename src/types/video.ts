// ============================================================================
// Video Generation Types — Phase 1 MVP
// ============================================================================
// 8 步流水线：
//   章节切片 → 分镜 prompt → (角色锚定图) → 分镜图 → I2V 生成 → TTS+字幕 → BGM → 合成
// Phase 1 跳过角色锚定图与分镜图，直接走 T2V 简化路径。

import type { VideoProviderId, ImageProviderId } from './providers';

// --- Aspect Ratio ---

export type AspectRatio = '16:9' | '9:16' | '1:1';

// --- Pipeline Stages ---

export type VideoStage =
  | 'idle'
  | 'script_slicing'        // 章节切片为镜头
  | 'storyboard_prompt'     // 生成分镜 prompt
  | 'character_anchor'      // (Phase 2) 角色锚定图
  | 'storyboard_image'      // (Phase 2) 分镜图
  | 'video_generation'      // T2V 或 I2V 生成
  | 'voice_subtitle'        // TTS 配音 + 字幕
  | 'composing'             // FFmpeg 合成
  | 'complete'
  | 'error';

export type VideoStageStatus =
  | 'pending'
  | 'running'
  | 'awaiting_review'  // 人工 checkpoint（如分镜图审核）
  | 'completed'
  | 'skipped'          // Phase 1 跳过的阶段
  | 'error';

export interface VideoStageState {
  stage: VideoStage;
  status: VideoStageStatus;
  progress: number;       // 0-1，对当前 stage 内部进度
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

// --- Storyboard (分镜) ---

/**
 * 一个分镜 = 一段最终视频镜头（典型 5s）
 */
export interface StoryboardShot {
  id: string;
  index: number;
  /** 镜头来源（章节号 + 段落索引） */
  sourceChapterId?: string;
  sourceText: string;            // 原文片段
  /** 给视频模型的 prompt（已优化，含画面、动作、镜头语言） */
  videoPrompt: string;
  /** 给图像模型的 prompt（Phase 2 用） */
  imagePrompt?: string;
  /** 镜头时长（秒） */
  durationSeconds: number;
  /** 旁白/对话文本（用于 TTS + 字幕） */
  narration?: string;
  dialogue?: {
    speaker: string;
    text: string;
    emotion?: string;
  }[];
  /** 在场角色 ID 列表（用于一致性约束） */
  characters: string[];
  /** 拍摄位置/场景 */
  location?: string;
  /** 情绪/氛围 */
  mood?: string;
  /** 镜头语言：close-up / wide / aerial / dolly 等 */
  cameraMovement?: string;
}

// --- Generated Assets ---

export interface GeneratedClip {
  shotId: string;
  videoUrl: string;          // 本地路径或远程 URL
  thumbnailUrl?: string;
  durationSeconds: number;
  provider: VideoProviderId;
  model: string;
  /** 是否含原声（部分模型支持原生音频） */
  hasAudio: boolean;
  generatedAt: string;
}

export interface GeneratedAudio {
  shotId: string;
  audioUrl: string;          // 本地路径
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

// --- Video Project (运行时状态，不入库) ---

export interface VideoProjectState {
  /** 关联的小说项目 ID（视频源） */
  novelProjectId: string;
  /** 用户选定的章节 ID 列表（按顺序） */
  selectedChapterIds: string[];
  /** 视频规格 */
  spec: VideoSpec;
  /** 流水线状态机 */
  stages: Record<VideoStage, VideoStageState>;
  /** 当前所在阶段 */
  currentStage: VideoStage;
  /** 分镜结果 */
  shots: StoryboardShot[];
  /** 角色锚定图（Phase 2） */
  anchorImages: AnchorImage[];
  /** 生成的视频片段 */
  clips: GeneratedClip[];
  /** 生成的配音 */
  audios: GeneratedAudio[];
  /** 最终合成视频路径 */
  finalVideoUrl?: string;
  /** 整体错误信息 */
  error?: string;
  /** 创建与更新时间 */
  createdAt: string;
  updatedAt: string;
}

export interface VideoSpec {
  aspectRatio: AspectRatio;
  resolution: string;          // '1920x1080'
  fps: number;                 // 24 / 30
  /** 单镜头时长（秒） */
  shotDurationSeconds: 5 | 10;
  /** 偏好的视频模型 tier */
  videoTier: ModelTier;
  /** 偏好的图像模型 tier（Phase 2） */
  imageTier: ModelTier;
  /** 偏好的 TTS 模型 tier */
  ttsTier: ModelTier;
  /** 是否硬编码字幕 */
  hardcodeSubtitles: boolean;
  /** BGM 风格 */
  bgmStyle?: string;
}

export type ModelTier = 'free' | 'value' | 'quality' | 'premium';

// --- Status helpers ---

export const VIDEO_PIPELINE_STAGES: VideoStage[] = [
  'script_slicing',
  'storyboard_prompt',
  'character_anchor',
  'storyboard_image',
  'video_generation',
  'voice_subtitle',
  'composing',
];

/** Phase 1 跳过的阶段 */
export const PHASE1_SKIPPED_STAGES: ReadonlySet<VideoStage> = new Set([
  'character_anchor',
  'storyboard_image',
]);
